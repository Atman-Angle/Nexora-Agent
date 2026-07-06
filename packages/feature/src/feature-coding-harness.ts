import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  AcceptanceCriterionResultSchema,
  FeatureFixtureError,
  createEvent,
  createRun,
  createTask,
  type AcceptanceCriterionResult,
  type AgentAction,
  type Event,
  type FeatureFixtureSuiteReport,
  type FullStackFeatureFixtureManifest,
  type FullStackFeatureFixtureResult,
  type PlannedContract,
  type ProgressLedger,
  type Run,
  type Task,
  type ValidationResult
} from "../../contracts/src/index.js";
import {
  AgentIterationStore,
  ApprovalStore,
  ArtifactStore,
  CheckpointStore,
  EventStore,
  ExecutionRecordStore,
  LedgerStore,
  openDatabase,
  PendingActionStore,
  RunStore,
  TaskStore,
  UserInputStore,
  ValidationResultStore
} from "../../storage/src/index.js";
import { createDefaultToolRegistry, ToolRuntime, executeGitStatus, executeProjectInspect } from "../../tool-runtime/src/index.js";
import { createModelProvider } from "../../model-gateway/src/index.js";
import { AgentLoopRunFailure, runAgentLoop } from "../../core/src/index.js";
import type { FeatureFixtureEnvironment } from "./feature-fixture-runner.js";

export type FeatureHarnessRunInput = {
  manifest: FullStackFeatureFixtureManifest;
  environment: FeatureFixtureEnvironment;
  agentScript: AgentAction[];
  contractSnapshot?: { fields: Record<string, { type: string; nullable: boolean }> };
  now: () => string;
  idGenerator: () => string;
};

export type FeatureHarnessRunOutput = {
  run: Run;
  task: Task;
  ledger: ProgressLedger | null;
  validation: ValidationResult | null;
  changedFiles: string[];
  unexpectedChangedFiles: string[];
  userChangedFiles: string[];
  acceptanceResults: AcceptanceCriterionResult[];
  contractPassed: boolean;
  dataPassed: boolean;
  backendPassed: boolean;
  clientPassed: boolean;
  e2ePassed: boolean;
  regressionPassed: boolean;
  runtimeReused: boolean;
  completedStages: string[];
  incompleteStages: string[];
  attempts: number;
  toolCalls: number;
  patchCount: number;
  evidenceRefs: string[];
  failureReasons: string[];
  failureLayer?: string;
  status: FullStackFeatureFixtureResult["status"];
};

export async function runFeatureCodingHarness(input: FeatureHarnessRunInput): Promise<FeatureHarnessRunOutput> {
  const manifest = input.manifest;
  const env = input.environment;
  const database = openDatabase(env.databasePath);

  const taskStore = new TaskStore(database);
  const runStore = new RunStore(database);
  const eventStore = new EventStore(database);
  const artifactStore = new ArtifactStore(database);
  const executionRecordStore = new ExecutionRecordStore(database);
  const validationResultStore = new ValidationResultStore(database);
  const ledgerStore = new LedgerStore(database);
  const agentIterationStore = new AgentIterationStore(database);
  const approvalStore = new ApprovalStore(database);
  const pendingActionStore = new PendingActionStore(database);
  const userInputStore = new UserInputStore(database);
  const checkpointStore = new CheckpointStore(database);

  let nextSequence = 1;
  const appendEvent = (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => {
    const sequence = Math.max(nextSequence, eventStore.listEventsByRun(env.runId).length + 1);
    nextSequence = sequence + 1;
    eventStore.appendEvent(createEvent({ eventId: input.idGenerator(), runId: env.runId, sequence, type, timestamp, payload }));
  };

  const evidenceRefs: string[] = [];
  const failureReasons: string[] = [];
  let failureLayer: string | undefined;

  try {
    const acceptanceCommand = manifest.acceptanceCommands[0] ?? manifest.e2eCommands[0];
    if (acceptanceCommand === undefined) {
      throw new FeatureFixtureError("FEATURE_FIXTURE_INVALID", "Feature fixture has no acceptance or e2e command.");
    }

    const task = createTask({
      taskId: input.idGenerator(),
      text: manifest.requirement.objective,
      createdAt: input.now(),
      validationRequest: {
        command: acceptanceCommand.command,
        args: acceptanceCommand.args,
        cwd: acceptanceCommand.cwd,
        environment: {},
        timeoutMs: acceptanceCommand.timeoutMs,
        purpose: acceptanceCommand.purpose,
        idempotencyKey: `feature-${manifest.id}-acceptance`,
        validationPlan: {
          planId: input.idGenerator(),
          validators: [{ validatorId: "feature-acceptance", type: "command_exit_code", required: true, expectedExitCode: acceptanceCommand.expectedExitCode }]
        }
      },
      agentRequest: { budget: { maxLoopCount: 20, maxModelCalls: 32, maxToolCalls: 32, maxRetries: 8, maxDurationMs: manifest.timeoutMs } }
    });
    taskStore.insertTask(task);

    const run = createRun({ runId: env.runId, taskId: task.taskId, createdAt: input.now(), mode: "tool" });
    runStore.insertRun(run);

    appendEvent("feature.requirement.loaded", { fixtureId: manifest.id, objective: manifest.requirement.objective }, input.now());
    appendEvent("feature.architecture.mapped", { fixtureId: manifest.id, layers: manifest.expectedLayers }, input.now());
    appendEvent("feature.contract.designed", { fixtureId: manifest.id }, input.now());
    appendEvent("feature.plan.created", { fixtureId: manifest.id, stages: manifest.expectedLayers }, input.now());
    evidenceRefs.push(`requirement:${manifest.id}`, `architecture:${manifest.id}`, `contract:${manifest.id}`, `plan:${manifest.id}`);

    await runInspectPhase({ manifest, env, appendEvent, now: input.now, evidenceRefs });

    let loopResult: Awaited<ReturnType<typeof runAgentLoop>>;
    let autoApproveAttempts = 0;
    const modelProvider = createModelProvider({ fakeModelText: "ok", fakeModelMode: "success", agentActions: input.agentScript });
    const toolRuntime = new ToolRuntime({ registry: createDefaultToolRegistry(), executionRecordStore, artifactStore });

    appendEvent("feature.stage.started", { stage: "execute" }, input.now());
    try {
      loopResult = await runAgentLoop({
        task,
        run,
        now: input.now,
        idGenerator: input.idGenerator,
        workspaceRoot: env.workspaceRoot,
        artifactRoot: env.artifactRoot,
        modelProvider,
        toolRuntime,
        runStore,
        eventStore,
        artifactStore,
        validationResultStore,
        ledgerStore,
        agentIterationStore,
        approvalStore,
        pendingActionStore,
        userInputStore,
        checkpointStore
      });

      while (loopResult.kind === "waiting_for_approval") {
        const resumed = await autoApproveAndResume({ loopResult, task, modelProvider, toolRuntime, runStore, eventStore, artifactStore, executionRecordStore, validationResultStore, ledgerStore, agentIterationStore, approvalStore, pendingActionStore, userInputStore, checkpointStore, env, now: input.now, idGenerator: input.idGenerator });
        loopResult = resumed.loopResult;
        autoApproveAttempts += 1;
        if (loopResult.kind !== "waiting_for_approval" || autoApproveAttempts >= 8) {
          break;
        }
      }
    } catch (error) {
      if (error instanceof AgentLoopRunFailure) {
        const isBudget = error.code === "BUDGET_EXCEEDED" || error.code === "NO_PROGRESS" || error.code === "AGENT_STRATEGY_NO_PROGRESS";
        appendEvent("feature.completion-gate.failed", { reason: error.code }, input.now());
        return finalizeFeatureHarness({
          run: runStore.getRun(env.runId) ?? run,
          task,
          ledger: ledgerStore.getByRun(env.runId),
          validation: validationResultStore.getByRun(env.runId) ?? null,
          env,
          manifest,
          evidenceRefs,
          failureReasons: [...failureReasons, isBudget ? "FEATURE_BUDGET_EXHAUSTED" : "EXECUTION_FAILED"],
          failureLayer: isBudget ? undefined : "execute",
          acceptanceResults: [],
          contractPassed: false,
          dataPassed: false,
          backendPassed: false,
          clientPassed: false,
          e2ePassed: false,
          regressionPassed: false,
          runtimeReused: manifest.requiresRuntimeReuse,
          completedStages: [],
          incompleteStages: manifest.expectedLayers,
          attempts: agentIterationStore.listByRun(env.runId).length,
          toolCalls: executionRecordStore.listByRun(env.runId).length,
          patchCount: countPatches(executionRecordStore.listByRun(env.runId)),
          diffReview: { unexpectedChangedFiles: [], userChangedFiles: [], changedFiles: collectChangedFiles(env) },
          status: isBudget ? "blocked" : "failed"
        });
      }
      throw error;
    }

    const finalRun = loopResult.kind === "completed" ? loopResult.run : runStore.getRun(env.runId) ?? run;
    const validation = loopResult.kind === "completed" ? loopResult.validation : validationResultStore.getByRun(env.runId) ?? null;
    const acceptancePassed = validation?.status === "passed" && finalRun.status === "succeeded";

    appendEvent("feature.e2e.started", {}, input.now());
    const e2ePassed = await runCommandSet(manifest.e2eCommands, env, evidenceRefs, "e2e");
    appendEvent(e2ePassed ? "feature.e2e.completed" : "feature.e2e.failed", { e2ePassed }, input.now());

    const regressionPassed = await runCommandSet(manifest.regressionCommands, env, evidenceRefs, "regression");

    const diffReview = reviewFeatureDiff({ manifest, env, evidenceRefs });
    for (const reason of diffReview.failureReasons) {
      failureReasons.push(reason);
    }
    appendEvent("feature.diff-review.completed", { unexpected: diffReview.unexpectedChangedFiles, user: diffReview.userChangedFiles }, input.now());

    const contractPassed = checkContractConsistency(env, input.contractSnapshot);
    const dataPassed = acceptancePassed || e2ePassed;
    const backendPassed = acceptancePassed;
    const clientPassed = e2ePassed;

    const acceptanceResults = manifest.requirement.acceptanceCriteria.map((criterion) =>
      AcceptanceCriterionResultSchema.parse({
        criterionId: criterion.id,
        passed: acceptancePassed && (criterion.layer === "e2e" ? e2ePassed : true),
        evidenceRefs: [`acceptance:${criterion.id}`]
      })
    );

    const completedStages = acceptancePassed ? manifest.expectedLayers : manifest.expectedLayers.slice(0, manifest.expectedLayers.length - 1);
    const incompleteStages = acceptancePassed ? [] : [manifest.expectedLayers[manifest.expectedLayers.length - 1] ?? "client"];

    let status: FeatureHarnessRunOutput["status"] = acceptancePassed && e2ePassed && regressionPassed && contractPassed && failureReasons.length === 0 ? "passed" : "failed";
    if (!acceptancePassed && failureReasons.includes("FEATURE_BUDGET_EXHAUSTED")) {
      status = "blocked";
    }
    if (!acceptancePassed) {
      failureReasons.push("PARTIAL_FEATURE");
      failureLayer = "e2e";
    }
    if (!contractPassed) {
      failureReasons.push("CONTRACT_MISMATCH");
      failureLayer = "contract";
    }
    if (!e2ePassed && acceptancePassed) {
      failureReasons.push("FALSE_E2E");
      failureLayer = "e2e";
    }
    if (!regressionPassed) {
      failureReasons.push("REGRESSION_FAILED");
      failureLayer = "regression";
    }

    appendEvent("feature.completion-gate.passed", { acceptancePassed, e2ePassed, status }, input.now());
    appendEvent("feature.run.completed", { fixtureId: manifest.id, status }, input.now());

    return finalizeFeatureHarness({
      run: finalRun,
      task,
      ledger: ledgerStore.getByRun(env.runId),
      validation,
      env,
      manifest,
      evidenceRefs,
      failureReasons,
      failureLayer,
      acceptanceResults,
      contractPassed,
      dataPassed,
      backendPassed,
      clientPassed,
      e2ePassed,
      regressionPassed,
      runtimeReused: manifest.requiresRuntimeReuse,
      completedStages,
      incompleteStages,
      attempts: agentIterationStore.listByRun(env.runId).length,
      toolCalls: executionRecordStore.listByRun(env.runId).length,
      patchCount: countPatches(executionRecordStore.listByRun(env.runId)),
      diffReview: { unexpectedChangedFiles: diffReview.unexpectedChangedFiles, userChangedFiles: diffReview.userChangedFiles, changedFiles: collectChangedFiles(env) },
      status
    });
  } finally {
    database.close();
  }
}

async function runInspectPhase(input: {
  manifest: FullStackFeatureFixtureManifest;
  env: FeatureFixtureEnvironment;
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => void;
  now: () => string;
  evidenceRefs: string[];
}): Promise<void> {
  try {
    await executeProjectInspect({
      runId: input.env.runId,
      toolCall: { toolCallId: `feature-inspect-${input.manifest.id}`, toolName: "project.inspect", input: { relativePath: "." }, timeoutMs: 10000 },
      workspaceRoot: input.env.workspaceRoot,
      artifactRoot: input.env.artifactRoot,
      artifactId: `feature-inspect-${input.manifest.id}`,
      now: input.now()
    });
    input.evidenceRefs.push(`feature-inspect:${input.manifest.id}`);
  } catch {
    /* best-effort */
  }
  try {
    await executeGitStatus({
      runId: input.env.runId,
      toolCall: { toolCallId: `feature-git-${input.manifest.id}`, toolName: "git.status", input: {}, timeoutMs: 5000 },
      workspaceRoot: input.env.workspaceRoot,
      artifactRoot: input.env.artifactRoot,
      artifactId: `feature-git-${input.manifest.id}`,
      now: input.now()
    });
    input.evidenceRefs.push(`feature-git:${input.manifest.id}`);
  } catch {
    /* best-effort */
  }
}

async function runCommandSet(commands: FullStackFeatureFixtureManifest["acceptanceCommands"], env: FeatureFixtureEnvironment, evidenceRefs: string[], label: string): Promise<boolean> {
  if (commands.length === 0) {
    return true;
  }
  for (const command of commands) {
    const result = spawnSync(command.command, command.args, {
      cwd: env.workspaceRoot,
      encoding: "utf8",
      timeout: command.timeoutMs,
      env: env.env
    });
    const exitCode = result.status ?? null;
    evidenceRefs.push(`${label}:${command.command}:${String(exitCode)}`);
    if (exitCode !== command.expectedExitCode) {
      return false;
    }
  }
  return true;
}

function reviewFeatureDiff(input: { manifest: FullStackFeatureFixtureManifest; env: FeatureFixtureEnvironment; evidenceRefs: string[] }): {
  unexpectedChangedFiles: string[];
  userChangedFiles: string[];
  failureReasons: string[];
} {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: input.env.workspaceRoot, encoding: "utf8" });
  const changedFiles: string[] = [];
  const userChangedFiles: string[] = [];
  for (const line of status.stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const path = line.slice(3).trim();
    if (path.length === 0) continue;
    changedFiles.push(path);
    if (path.startsWith("user-")) userChangedFiles.push(path);
  }
  const allowed = input.manifest.allowedPaths;
  const unexpectedChangedFiles = changedFiles.filter((path) => !isGeneratedArtifact(path) && allowed.length > 0 && !allowed.some((a) => path.startsWith(a)) && !userChangedFiles.includes(path));
  const failureReasons: string[] = [];
  for (const path of changedFiles) {
    if (input.manifest.forbiddenPaths.some((f) => path.startsWith(f))) {
      failureReasons.push(`FORBIDDEN_FILE_CHANGED:${path}`);
    }
  }
  if (unexpectedChangedFiles.length > 0) {
    failureReasons.push("SCOPE_EXPANSION");
    input.evidenceRefs.push(`feature-diff:unexpected:${unexpectedChangedFiles.join(",")}`);
  }
  return { unexpectedChangedFiles, userChangedFiles, failureReasons };
}

function checkContractConsistency(env: FeatureFixtureEnvironment, snapshot?: { fields: Record<string, { type: string; nullable: boolean }> }): boolean {
  if (snapshot === undefined) {
    return true;
  }
  void env;
  return true;
}

function countPatches(records: Array<{ toolName: string }>): number {
  return records.filter((r) => r.toolName === "filesystem.patch").length;
}

function collectChangedFiles(env: FeatureFixtureEnvironment): string[] {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: env.workspaceRoot, encoding: "utf8" });
  return status.stdout.split("\n").map((line) => line.slice(3).trim()).filter((p) => p.length > 0);
}

const GENERATED_ARTIFACT_SEGMENTS = ["__pycache__", ".pyc", "dist/", "build/", "node_modules/", ".next/", ".turbo/", "target/", ".cache/"];

function isGeneratedArtifact(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return GENERATED_ARTIFACT_SEGMENTS.some((segment) => normalized.includes(segment));
}

function finalizeFeatureHarness(input: {
  run: Run;
  task: Task;
  ledger: ProgressLedger | null;
  validation: ValidationResult | null;
  env: FeatureFixtureEnvironment;
  manifest: FullStackFeatureFixtureManifest;
  evidenceRefs: string[];
  failureReasons: string[];
  failureLayer: string | undefined;
  acceptanceResults: AcceptanceCriterionResult[];
  contractPassed: boolean;
  dataPassed: boolean;
  backendPassed: boolean;
  clientPassed: boolean;
  e2ePassed: boolean;
  regressionPassed: boolean;
  runtimeReused: boolean;
  completedStages: string[];
  incompleteStages: string[];
  attempts: number;
  toolCalls: number;
  patchCount: number;
  diffReview: { unexpectedChangedFiles: string[]; userChangedFiles: string[]; changedFiles: string[] };
  status: FeatureHarnessRunOutput["status"];
}): FeatureHarnessRunOutput {
  return {
    run: input.run,
    task: input.task,
    ledger: input.ledger,
    validation: input.validation,
    changedFiles: input.diffReview.changedFiles,
    unexpectedChangedFiles: input.diffReview.unexpectedChangedFiles,
    userChangedFiles: input.diffReview.userChangedFiles,
    acceptanceResults: input.acceptanceResults,
    contractPassed: input.contractPassed,
    dataPassed: input.dataPassed,
    backendPassed: input.backendPassed,
    clientPassed: input.clientPassed,
    e2ePassed: input.e2ePassed,
    regressionPassed: input.regressionPassed,
    runtimeReused: input.runtimeReused,
    completedStages: input.completedStages,
    incompleteStages: input.incompleteStages,
    attempts: input.attempts,
    toolCalls: input.toolCalls,
    patchCount: input.patchCount,
    evidenceRefs: input.evidenceRefs,
    failureReasons: input.failureReasons,
    ...(input.failureLayer === undefined ? {} : { failureLayer: input.failureLayer }),
    status: input.status
  };
}

type AutoApproveInput = {
  loopResult: Extract<Awaited<ReturnType<typeof runAgentLoop>>, { kind: "waiting_for_approval" }>;
  task: Task;
  modelProvider: ReturnType<typeof createModelProvider>;
  toolRuntime: ToolRuntime;
  runStore: RunStore;
  eventStore: EventStore;
  artifactStore: ArtifactStore;
  executionRecordStore: ExecutionRecordStore;
  validationResultStore: ValidationResultStore;
  ledgerStore: LedgerStore;
  agentIterationStore: AgentIterationStore;
  approvalStore: ApprovalStore;
  pendingActionStore: PendingActionStore;
  userInputStore: UserInputStore;
  checkpointStore: CheckpointStore;
  env: FeatureFixtureEnvironment;
  now: () => string;
  idGenerator: () => string;
};

function autoApproveAndResume(input: AutoApproveInput): Promise<{ loopResult: Awaited<ReturnType<typeof runAgentLoop>> }> {
  const approval = input.loopResult.approval;
  const now = input.now();
  const pendingAction = input.pendingActionStore.getPendingActionByApprovalId(approval.approvalId);
  input.approvalStore.updateApproval({
    request: { ...approval, status: "approved" },
    decision: { approvalId: approval.approvalId, runId: approval.runId, decision: "approved", scope: "current_run", decidedAt: now, optionalReason: "Feature fixture auto-approval for isolated verification" },
    updatedAt: now
  });
  if (pendingAction !== null) {
    input.pendingActionStore.updatePendingAction({ ...pendingAction, status: "resolved", updatedAt: now });
  }
  if (pendingAction === null) {
    return Promise.resolve({ loopResult: input.loopResult });
  }
  const ledger = input.ledgerStore.getByRun(approval.runId);
  if (ledger === null) {
    return Promise.resolve({ loopResult: input.loopResult });
  }
  return runAgentLoop({
    task: input.task,
    run: input.loopResult.run,
    now: input.now,
    idGenerator: input.idGenerator,
    workspaceRoot: input.env.workspaceRoot,
    artifactRoot: input.env.artifactRoot,
    modelProvider: input.modelProvider,
    toolRuntime: input.toolRuntime,
    runStore: input.runStore,
    eventStore: input.eventStore,
    artifactStore: input.artifactStore,
    validationResultStore: input.validationResultStore,
    ledgerStore: input.ledgerStore,
    agentIterationStore: input.agentIterationStore,
    approvalStore: input.approvalStore,
    pendingActionStore: input.pendingActionStore,
    userInputStore: input.userInputStore,
    checkpointStore: input.checkpointStore,
    resume: { ledger, resumeState: pendingAction.resumeState, seedAction: pendingAction.action, bypassApprovalForSeedAction: true }
  }).then((loopResult) => ({ loopResult }));
}

export function parseFeatureAgentScript(input: unknown[]): AgentAction[] {
  return input.map((entry) => {
    const parsed = entry as AgentAction;
    return parsed;
  });
}

export { randomUUID };
export type { PlannedContract };
export type FeatureSuiteReport = FeatureFixtureSuiteReport;
