import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  AgentActionSchema,
  ApprovalDecisionSchema,
  createEvent,
  createRun,
  createTask,
  type AgentAction,
  type ApprovalDecision,
  type Artifact,
  type BugFixtureManifest,
  type Event,
  type PendingAction,
  type ProgressLedger,
  type ReproductionResult,
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
import { FixtureError } from "../../contracts/src/index.js";
import type { FixtureEnvironment } from "./fixture-runner.js";

export type HarnessRunInput = {
  manifest: BugFixtureManifest;
  environment: FixtureEnvironment;
  agentScript: AgentAction[];
  now: () => string;
  idGenerator: () => string;
};

export type HarnessRunOutput = {
  run: Run;
  task: Task;
  ledger: ProgressLedger | null;
  validation: ValidationResult | null;
  reproduction: ReproductionResult;
  inspectEvents: Event[];
  changedFiles: string[];
  unexpectedChangedFiles: string[];
  userChangedFiles: string[];
  acceptancePassed: boolean;
  regressionPassed: boolean;
  attempts: number;
  toolCalls: number;
  patchCount: number;
  evidenceRefs: string[];
  failureReasons: string[];
  status: "passed" | "failed" | "blocked" | "invalid_fixture";
  reproductionArtifact: Artifact | null;
};

const MAX_REPRODUCTION_RETRIES = 2;

export async function runCodingHarness(input: HarnessRunInput): Promise<HarnessRunOutput> {
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
    eventStore.appendEvent(
      createEvent({ eventId: input.idGenerator(), runId: env.runId, sequence, type, timestamp, payload })
    );
  };

  const evidenceRefs: string[] = [];
  const failureReasons: string[] = [];

  try {
    const acceptanceCommand = manifest.acceptanceCommands[0];
    if (acceptanceCommand === undefined) {
      throw new FixtureError("FIXTURE_INVALID", "Fixture has no acceptance command.");
    }

    const task = createTask({
      taskId: input.idGenerator(),
      text: manifest.issue.objective,
      createdAt: input.now(),
      validationRequest: {
        command: acceptanceCommand.command,
        args: acceptanceCommand.args,
        cwd: acceptanceCommand.cwd,
        environment: {},
        timeoutMs: acceptanceCommand.timeoutMs,
        purpose: acceptanceCommand.purpose,
        idempotencyKey: `fixture-${manifest.id}-acceptance`,
        validationPlan: {
          planId: input.idGenerator(),
          validators: [
            { validatorId: "acceptance-exit-code", type: "command_exit_code", required: true, expectedExitCode: acceptanceCommand.expectedExitCode }
          ]
        }
      },
      agentRequest: {
        budget: {
          maxLoopCount: 16,
          maxModelCalls: 24,
          maxToolCalls: 24,
          maxRetries: 6,
          maxDurationMs: manifest.timeoutMs
        }
      }
    });
    taskStore.insertTask(task);

    const run = createRun({ runId: env.runId, taskId: task.taskId, createdAt: input.now(), mode: "tool" });
    runStore.insertRun(run);

    appendEvent("fixture.setup.completed", { fixtureId: manifest.id, workspaceRoot: env.workspaceRoot }, input.now());
    appendEvent("bugfix.issue.loaded", { fixtureId: manifest.id, objective: manifest.issue.objective }, input.now());

    const reproduction = await runReproductionPhase({ manifest, env, appendEvent, now: input.now, idGenerator: input.idGenerator, evidenceRefs });
    evidenceRefs.push(`reproduction:${reproduction.command}:${String(reproduction.exitCode)}`);

    const inspectEvents = await runInspectPhase({ manifest, env, appendEvent, now: input.now, evidenceRefs });

    const modelProvider = createModelProvider({
      fakeModelText: "ok",
      fakeModelMode: "success",
      agentActions: input.agentScript
    });
    const toolRuntime = new ToolRuntime({ registry: createDefaultToolRegistry(), executionRecordStore, artifactStore });

    let loopResult: Awaited<ReturnType<typeof runAgentLoop>>;
    let currentRun = run;
    let currentLedger: ProgressLedger | null = null;
    let autoApproveAttempts = 0;
    try {
      loopResult = await runAgentLoop({
        task,
        run: currentRun,
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
        const resumed = await autoApproveAndResume({
          loopResult,
          task,
          modelProvider,
          toolRuntime,
          runStore,
          eventStore,
          artifactStore,
          executionRecordStore,
          validationResultStore,
          ledgerStore,
          agentIterationStore,
          approvalStore,
          pendingActionStore,
          userInputStore,
          checkpointStore,
          env,
          now: input.now,
          idGenerator: input.idGenerator
        });
        currentRun = runStore.getRun(env.runId) ?? loopResult.run;
        currentLedger = resumed.ledger ?? currentLedger;
        loopResult = resumed.loopResult;
        autoApproveAttempts += 1;
        if (loopResult.kind !== "waiting_for_approval") {
          break;
        }
        if (autoApproveAttempts >= 8) {
          break;
        }
      }
    } catch (error) {
      if (error instanceof AgentLoopRunFailure) {
        const isBudget = error.code === "BUDGET_EXCEEDED";
        const isNoProgress = error.code === "NO_PROGRESS";
        const status: HarnessRunOutput["status"] = isBudget || isNoProgress ? "blocked" : "failed";
        const reason = isBudget || isNoProgress ? "REPAIR_BUDGET_EXHAUSTED" : "TARGET_VERIFICATION_FAILED";
        appendEvent("bugfix.completion-gate.failed", { reason: error.code }, input.now());
        return finalizeHarness({
          run: runStore.getRun(env.runId) ?? run,
          task,
          ledger: ledgerStore.getByRun(env.runId),
          validation: validationResultStore.getByRun(env.runId) ?? null,
          reproduction,
          inspectEvents,
          env,
          manifest,
          evidenceRefs,
          failureReasons: [...failureReasons, reason],
          acceptancePassed: false,
          regressionPassed: false,
          attempts: agentIterationStore.listByRun(env.runId).length,
          toolCalls: executionRecordStore.listByRun(env.runId).length,
          patchCount: countPatches(executionRecordStore.listByRun(env.runId)),
          reproductionArtifact: null,
          status,
          diffReview: { unexpectedChangedFiles: [], userChangedFiles: [], changedFiles: collectChangedFiles(env) }
        });
      }
      throw error;
    }

    const finalRun = loopResult.kind === "completed" ? loopResult.run : runStore.getRun(env.runId) ?? run;
    const ledger = loopResult.kind === "completed" ? loopResult.ledger : ledgerStore.getByRun(env.runId);
    const validation = loopResult.kind === "completed" ? loopResult.validation : validationResultStore.getByRun(env.runId) ?? null;
    const acceptancePassed = validation?.status === "passed" && finalRun.status === "succeeded";

    appendEvent("bugfix.completion-gate.passed", { acceptancePassed }, input.now());

    const regressionPassed = await runRegressionPhase({ manifest, env, evidenceRefs, appendEvent, now: input.now });

    const diffReview = reviewDiff({ manifest, env, evidenceRefs });
    for (const reason of diffReview.failureReasons) {
      failureReasons.push(reason);
    }
    appendEvent("bugfix.diff-review.completed", { unexpectedChangedFiles: diffReview.unexpectedChangedFiles, userChangedFiles: diffReview.userChangedFiles }, input.now());

    let status: HarnessRunOutput["status"] = acceptancePassed && regressionPassed && failureReasons.length === 0 ? "passed" : "failed";
    if (!acceptancePassed && failureReasons.includes("REPAIR_BUDGET_EXHAUSTED")) {
      status = "blocked";
    }
    if (!acceptancePassed) {
      failureReasons.push("TARGET_VERIFICATION_FAILED");
    }
    if (!regressionPassed) {
      failureReasons.push("REGRESSION_FAILED");
    }

    appendEvent("fixture.run.completed", { fixtureId: manifest.id, runId: env.runId, status }, input.now());

    return finalizeHarness({
      run: finalRun,
      task,
      ledger,
      validation,
      reproduction,
      inspectEvents,
      env,
      manifest,
      evidenceRefs,
      failureReasons,
      acceptancePassed,
      regressionPassed,
      attempts: agentIterationStore.listByRun(env.runId).length,
      toolCalls: executionRecordStore.listByRun(env.runId).length,
      patchCount: countPatches(executionRecordStore.listByRun(env.runId)),
      reproductionArtifact: null,
      status,
      diffReview: { unexpectedChangedFiles: diffReview.unexpectedChangedFiles, userChangedFiles: diffReview.userChangedFiles, changedFiles: collectChangedFiles(env) }
    });
  } finally {
    database.close();
  }
}

async function runReproductionPhase(input: {
  manifest: BugFixtureManifest;
  env: FixtureEnvironment;
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => void;
  now: () => string;
  idGenerator: () => string;
  evidenceRefs: string[];
}): Promise<ReproductionResult> {
  const command = input.manifest.reproductionCommands[0];
  if (command === undefined) {
    throw new FixtureError("FIXTURE_INVALID", "Fixture has no reproduction command.");
  }
  input.appendEvent("bugfix.reproduction.started", { command: command.command, args: command.args }, input.now());

  let lastExitCode: number | null = null;
  let lastSummary = "";
  for (let attempt = 0; attempt <= MAX_REPRODUCTION_RETRIES; attempt += 1) {
    const result = spawnSync(command.command, command.args, {
      cwd: join(input.env.workspaceRoot, command.cwd),
      encoding: "utf8",
      timeout: command.timeoutMs,
      env: { ...process.env, NEXORA_WORKSPACE_ROOT: input.env.workspaceRoot }
    });
    lastExitCode = result.status ?? null;
    lastSummary = `${(result.stdout ?? "").slice(0, 400)}\n${(result.stderr ?? "").slice(0, 400)}`.trim();
    if (lastExitCode === command.expectedExitCode) {
      break;
    }
  }

  const reproduced = lastExitCode === command.expectedExitCode;
  const reproduction: ReproductionResult = {
    reproduced,
    command: command.command,
    workingDirectory: command.cwd,
    exitCode: lastExitCode,
    ...(lastSummary.length > 0 ? { failureSummary: lastSummary } : {}),
    evidenceRefs: [`reproduction:${command.command}:${String(lastExitCode)}`],
    confidence: reproduced ? 0.9 : 0.3
  };
  input.evidenceRefs.push(...reproduction.evidenceRefs);
  input.appendEvent(
    reproduced ? "bugfix.reproduction.completed" : "bugfix.reproduction.failed",
    { exitCode: lastExitCode, reproduced },
    input.now()
  );
  if (!reproduced && !input.manifest.staticProvable) {
    input.evidenceRefs.push("reproduction:failed");
  }
  return reproduction;
}

async function runInspectPhase(input: {
  manifest: BugFixtureManifest;
  env: FixtureEnvironment;
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => void;
  now: () => string;
  evidenceRefs: string[];
}): Promise<Event[]> {
  const inspectEvents: Event[] = [];
  try {
    const inspect = await executeProjectInspect({
      runId: input.env.runId,
      toolCall: { toolCallId: `inspect-${input.manifest.id}`, toolName: "project.inspect", input: { relativePath: "." }, timeoutMs: 10000 },
      workspaceRoot: input.env.workspaceRoot,
      artifactRoot: input.env.artifactRoot,
      artifactId: `inspect-${input.manifest.id}`,
      now: input.now()
    });
    if (inspect.toolResult.status === "success") {
      input.evidenceRefs.push(`inspect:${input.manifest.id}`);
      input.appendEvent("repository.profile.created", { fixtureId: input.manifest.id }, input.now());
    }
  } catch {
    /* inspect is best-effort evidence */
  }
  try {
    const status = await executeGitStatus({
      runId: input.env.runId,
      toolCall: { toolCallId: `git-status-${input.manifest.id}`, toolName: "git.status", input: {}, timeoutMs: 5000 },
      workspaceRoot: input.env.workspaceRoot,
      artifactRoot: input.env.artifactRoot,
      artifactId: `git-status-${input.manifest.id}`,
      now: input.now()
    });
    if (status.toolResult.status === "success") {
      input.evidenceRefs.push(`git-status:${input.manifest.id}`);
    }
  } catch {
    /* git status is best-effort */
  }
  return inspectEvents;
}

async function runRegressionPhase(input: {
  manifest: BugFixtureManifest;
  env: FixtureEnvironment;
  evidenceRefs: string[];
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => void;
  now: () => string;
}): Promise<boolean> {
  if (input.manifest.regressionCommands.length === 0) {
    return true;
  }
  input.appendEvent("bugfix.verification.started", { phase: "regression" }, input.now());
  for (const command of input.manifest.regressionCommands) {
    const result = spawnSync(command.command, command.args, {
      cwd: join(input.env.workspaceRoot, command.cwd),
      encoding: "utf8",
      timeout: command.timeoutMs,
      env: { ...process.env, NEXORA_WORKSPACE_ROOT: input.env.workspaceRoot }
    });
    const exitCode = result.status ?? null;
    input.evidenceRefs.push(`regression:${command.command}:${String(exitCode)}`);
    if (exitCode !== command.expectedExitCode) {
      input.appendEvent("bugfix.verification.failed", { command: command.command, exitCode }, input.now());
      return false;
    }
  }
  input.appendEvent("bugfix.verification.completed", { phase: "regression" }, input.now());
  return true;
}

function reviewDiff(input: { manifest: BugFixtureManifest; env: FixtureEnvironment; evidenceRefs: string[] }): {
  unexpectedChangedFiles: string[];
  userChangedFiles: string[];
  failureReasons: string[];
} {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: input.env.workspaceRoot, encoding: "utf8" });
  const changedFiles: string[] = [];
  const userChangedFiles: string[] = [];
  for (const line of status.stdout.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const path = line.slice(3).trim();
    if (path.length === 0) {
      continue;
    }
    changedFiles.push(path);
    if (input.manifest.forbiddenChangedFiles.includes(path) || isUserChangeMarker(path, input.manifest)) {
      userChangedFiles.push(path);
    }
  }

  const allowed = input.manifest.allowedPaths;
  const unexpectedChangedFiles = changedFiles.filter(
    (path) => !isGeneratedArtifact(path) && allowed.length > 0 && !allowed.includes(path) && !userChangedFiles.includes(path)
  );
  const failureReasons: string[] = [];
  for (const path of changedFiles) {
    if (input.manifest.forbiddenChangedFiles.includes(path)) {
      failureReasons.push(`FORBIDDEN_FILE_CHANGED:${path}`);
    }
  }
  if (unexpectedChangedFiles.length > 0) {
    failureReasons.push("PATCH_SCOPE_VIOLATION");
    input.evidenceRefs.push(`diff-review:unexpected:${unexpectedChangedFiles.join(",")}`);
  }
  return { unexpectedChangedFiles, userChangedFiles, failureReasons };
}

function isUserChangeMarker(path: string, manifest: BugFixtureManifest): boolean {
  return path.startsWith("user-") || manifest.issue.forbiddenChanges.some((change) => change.toLowerCase().includes(path.toLowerCase()));
}

const GENERATED_ARTIFACT_SEGMENTS = ["__pycache__", ".pyc", "dist/", "build/", "node_modules/", ".next/", ".turbo/", "target/", ".cache/"];

function isGeneratedArtifact(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return GENERATED_ARTIFACT_SEGMENTS.some((segment) => normalized.includes(segment));
}

function countPatches(records: Array<{ toolName: string }>): number {
  return records.filter((record) => record.toolName === "filesystem.patch").length;
}

function finalizeHarness(input: {
  run: Run;
  task: Task;
  ledger: ProgressLedger | null;
  validation: ValidationResult | null;
  reproduction: ReproductionResult;
  inspectEvents: Event[];
  env: FixtureEnvironment;
  manifest: BugFixtureManifest;
  evidenceRefs: string[];
  failureReasons: string[];
  acceptancePassed: boolean;
  regressionPassed: boolean;
  attempts: number;
  toolCalls: number;
  patchCount: number;
  reproductionArtifact: Artifact | null;
  status: HarnessRunOutput["status"];
  diffReview: { unexpectedChangedFiles: string[]; userChangedFiles: string[]; changedFiles: string[] };
}): HarnessRunOutput {
  return {
    run: input.run,
    task: input.task,
    ledger: input.ledger,
    validation: input.validation,
    reproduction: input.reproduction,
    inspectEvents: input.inspectEvents,
    changedFiles: input.diffReview.changedFiles,
    unexpectedChangedFiles: input.diffReview.unexpectedChangedFiles,
    userChangedFiles: input.diffReview.userChangedFiles,
    acceptancePassed: input.acceptancePassed,
    regressionPassed: input.regressionPassed,
    attempts: input.attempts,
    toolCalls: input.toolCalls,
    patchCount: input.patchCount,
    evidenceRefs: input.evidenceRefs,
    failureReasons: input.failureReasons,
    status: input.status,
    reproductionArtifact: input.reproductionArtifact
  };
}

function collectChangedFiles(env: FixtureEnvironment): string[] {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: env.workspaceRoot, encoding: "utf8" });
  return status.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((path) => path.length > 0);
}

export function parseAgentScript(input: unknown[]): AgentAction[] {
  return input.map((entry) => AgentActionSchema.parse(entry));
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
  env: FixtureEnvironment;
  now: () => string;
  idGenerator: () => string;
};

function autoApproveAndResume(input: AutoApproveInput): Promise<{ loopResult: Awaited<ReturnType<typeof runAgentLoop>>; ledger: ProgressLedger | null }> {
  const approval = input.loopResult.approval;
  const now = input.now();
  const pendingAction: PendingAction | null = input.pendingActionStore.getPendingActionByApprovalId(approval.approvalId);

  const decision: ApprovalDecision = ApprovalDecisionSchema.parse({
    approvalId: approval.approvalId,
    runId: approval.runId,
    decision: "approved",
    scope: "current_run",
    decidedAt: now,
    optionalReason: "Fixture auto-approval for isolated verification"
  });
  input.approvalStore.updateApproval({ request: { ...approval, status: "approved" }, decision, updatedAt: now });

  if (pendingAction !== null) {
    input.pendingActionStore.updatePendingAction({ ...pendingAction, status: "resolved", updatedAt: now });
  }

  if (pendingAction === null) {
    return Promise.resolve({ loopResult: input.loopResult, ledger: null });
  }

  const ledger = input.ledgerStore.getByRun(approval.runId);
  if (ledger === null) {
    return Promise.resolve({ loopResult: input.loopResult, ledger: null });
  }

  return runAgentLoopSync({
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
    resume: {
      ledger,
      resumeState: pendingAction.resumeState,
      seedAction: pendingAction.action,
      bypassApprovalForSeedAction: true
    }
  }).then((loopResult) => ({ loopResult, ledger }));
}

async function runAgentLoopSync(input: Parameters<typeof runAgentLoop>[0]): Promise<Awaited<ReturnType<typeof runAgentLoop>>> {
  return runAgentLoop(input);
}
