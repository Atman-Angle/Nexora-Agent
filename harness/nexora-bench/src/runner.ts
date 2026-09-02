import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createAgent,
  openAICompatibleProviderFromEnv,
  type RecoveryDecision,
  type HostAgentPolicy,
  type RunInspection,
  type RunHandle,
  type RuntimeEngine,
  type RuntimeEvent,
  type RuntimeProvider,
  type RuntimeSubscription,
  type RuntimeTool
} from "@nexora/harness";

import type { EvalSplit, EvalTask } from "./contracts.js";
import { loadDataset, selectTasks, type LoadedDataset } from "./dataset.js";
import { copyDirectoryTree, copyVerifiedFixture, resolveInside, snapshotPaths } from "./filesystem.js";
import { gradeAuthority, gradeTask } from "./grader.js";
import {
  createEvalReport,
  createOptimizationPacket,
  createTaskReport,
  type EvalReport,
  type TaskReport
} from "./report.js";
import type { EvalScenario, ScenarioFactory } from "./scenario.js";
import {
  createBenchTelemetry,
  type BenchTelemetry,
  type ModelObservation
} from "./telemetry.js";

const BENCH_HOST_POLICY: HostAgentPolicy = {
  schemaVersion: 1,
  id: "nexora-bench",
  version: "1",
  taskMode: "change",
  promptCache: "allow",
  instructions: [
    "Benchmark tasks operate on an isolated workspace. Use registered Tools for every requested workspace observation or change.",
    "Do not finish a requested workspace change until successful Tool observations prove the resulting state and any available verification has run."
  ]
};

export type RunBenchOptions = {
  readonly manifestPath: string;
  readonly outputRoot?: string;
  readonly split?: EvalSplit;
  readonly taskIds?: readonly string[];
  readonly keepWorkspaces?: boolean;
  readonly telemetry?: BenchTelemetry;
  readonly providerMode?: "deterministic" | "real";
};

export type RunBenchResult = {
  readonly reportPath: string;
  readonly failuresPath: string;
  readonly optimizationPacketPath: string;
  readonly report: EvalReport;
};

export async function runBench(options: RunBenchOptions): Promise<RunBenchResult> {
  const dataset = loadDataset(resolve(options.manifestPath));
  const selected = selectTasks(dataset, {
    ...(options.split === undefined ? {} : { split: options.split }),
    ...(options.taskIds === undefined ? {} : { taskIds: options.taskIds })
  });
  const createdAt = new Date().toISOString();
  const outputDirectory = resolve(options.outputRoot ?? join(
    dirname(options.manifestPath), "..", "..", "reports",
    createdAt.replaceAll(":", "-").replace(".", "-")
  ));
  mkdirSync(outputDirectory, { recursive: true });
  const ownTelemetry = options.telemetry === undefined;
  const telemetry = options.telemetry ?? createBenchTelemetry({
    jsonlPath: join(outputDirectory, "telemetry.jsonl")
  });
  const reports: TaskReport[] = [];
  const telemetryErrors: string[] = [];
  try {
    for (const task of selected) {
      try {
        reports.push(await runTask({
          dataset,
          task,
          outputDirectory,
          telemetry,
          keepWorkspace: options.keepWorkspaces ?? false,
          providerMode: options.providerMode ?? "deterministic"
        }));
      } catch (error) {
        reports.push(infrastructureFailure(task, error, options.providerMode ?? "deterministic"));
      }
    }
  } finally {
    if (ownTelemetry) {
      try {
        await telemetry.shutdown();
      } catch (error) {
        telemetryErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const report = createEvalReport({
    dataset: { id: dataset.manifest.id, version: dataset.manifest.version, digest: dataset.digest },
    tasks: reports,
    telemetryErrors,
    createdAt,
    providerMode: options.providerMode ?? "deterministic"
  });
  const packet = createOptimizationPacket(report);
  const reportPath = join(outputDirectory, "report.json");
  const failuresPath = join(outputDirectory, "failures.jsonl");
  const optimizationPacketPath = join(outputDirectory, "optimization-packet.json");
  writeJson(reportPath, report);
  writeFileSync(
    failuresPath,
    report.tasks.filter((task) => !task.passed).map((task) => JSON.stringify(task)).join("\n")
      + (report.tasks.some((task) => !task.passed) ? "\n" : ""),
    "utf8"
  );
  writeJson(optimizationPacketPath, packet);
  writeJson(join(outputDirectory, "codex-result.schema.json"), codexResultSchema());
  writeFileSync(join(outputDirectory, "codex-prompt.md"), codexPrompt(optimizationPacketPath), "utf8");
  return { reportPath, failuresPath, optimizationPacketPath, report };
}

async function runTask(input: {
  readonly dataset: LoadedDataset;
  readonly task: EvalTask;
  readonly outputDirectory: string;
  readonly telemetry: BenchTelemetry;
  readonly keepWorkspace: boolean;
  readonly providerMode: "deterministic" | "real";
}): Promise<TaskReport> {
  const taskRoot = mkdtempSync(join(tmpdir(), `nexora-bench-${input.task.id}-`));
  const workspace = join(taskRoot, "workspace");
  const dataDir = join(taskRoot, ".nexora");
  const started = performance.now();
  let runtime: RuntimeEngine | null = null;
  let scenario: EvalScenario | null = null;
  let taskTelemetry: ReturnType<BenchTelemetry["startTask"]> | null = null;
  let cancellationSubscription: RuntimeSubscription | null = null;
  const modelObservations: ModelObservation[] = [];
  try {
    const fixture = resolveInside(input.dataset.root, input.task.fixture.path);
    copyVerifiedFixture(fixture, input.task.fixture.digest, workspace);
    const initialDigests = snapshotPaths(workspace, input.task.grader.unchangedPaths);
    const scenarioFactory = await loadScenarioFactory(resolveInside(input.dataset.root, input.task.scenario));
    const createExecution = async (): Promise<{ readonly runtime: RuntimeEngine; readonly scenario: EvalScenario }> => {
      const nextScenario = await scenarioFactory({ task: input.task, workspace });
      const tools = allowedTools(input.task, nextScenario.tools);
      const baseProvider = input.providerMode === "real"
        ? openAICompatibleProviderFromEnv()
        : nextScenario.provider;
      const provider = observeProvider(baseProvider, modelObservations);
      const nextRuntime = createAgent({
        workspace,
        dataDir,
        provider,
        tools,
        hostPolicy: BENCH_HOST_POLICY
      });
      return { runtime: nextRuntime, scenario: nextScenario };
    };

    ({ runtime, scenario } = await createExecution());
    let handle = runtime.run(input.task.instruction, { budgets: input.task.budgets });
    taskTelemetry = input.telemetry.startTask({
      datasetId: input.dataset.manifest.id,
      datasetVersion: input.dataset.manifest.version,
      datasetDigest: input.dataset.digest,
      task: input.task,
      runId: handle.id,
      providerMode: input.providerMode
    });
    const cancellation = installCancellationDriver(handle, input.task);
    cancellationSubscription = cancellation.subscription;
    let inspection = await handle.wait();
    await cancellation.settled();
    const occurrences = { approval: 0, input: 0, recovery: 0 };
    const approvalRuleCounts = new Map<number, number>();
    let approvalGranted = 0;
    let approvalDenied = 0;

    for (let control = 0; control < 100 && !isTerminalOrExpectedStop(inspection, input.task); control += 1) {
      if (inspection.status === "waiting_for_approval") {
        occurrences.approval += 1;
        const requestId = inspection.pendingRequest?.id;
        if (requestId === undefined) throw new Error("Approval status is missing its pending request.");
        const policyDecision = approvalDecision(input.task, inspection, approvalRuleCounts);
        if (policyDecision !== null) {
          if (policyDecision.restartBeforeDecision) {
            await runtime.close();
            await scenario.dispose?.();
            ({ runtime, scenario } = await createExecution());
            handle = runtime.openRun(handle.id);
            inspection = await handle.inspect();
          }
          if (policyDecision.decision === "approve") {
            await handle.approve({ requestId });
            approvalGranted += 1;
          } else {
            await handle.deny({ requestId, ...(policyDecision.reason === undefined ? {} : { reason: policyDecision.reason }) });
            approvalDenied += 1;
          }
          inspection = await handle.wait();
          continue;
        }
        const action = input.task.driver.approvals.find((item) => item.occurrence === occurrences.approval);
        if (action === undefined) break;
        if (action.restartBeforeDecision) {
          await runtime.close();
          await scenario.dispose?.();
          ({ runtime, scenario } = await createExecution());
          handle = runtime.openRun(handle.id);
          inspection = await handle.inspect();
        }
        if (action.decision === "approve") {
          await handle.approve({ requestId });
          approvalGranted += 1;
        } else {
          await handle.deny({ requestId, ...(action.reason === undefined ? {} : { reason: action.reason }) });
          approvalDenied += 1;
        }
        inspection = await handle.wait();
        continue;
      }
      if (inspection.status === "waiting_for_input") {
        occurrences.input += 1;
        const action = input.task.driver.inputs.find((item) => item.occurrence === occurrences.input);
        if (action === undefined) break;
        if (action.restartBeforeDecision) {
          await runtime.close();
          await scenario.dispose?.();
          ({ runtime, scenario } = await createExecution());
          handle = runtime.openRun(handle.id);
          inspection = await handle.inspect();
        }
        const requestId = inspection.pendingRequest?.id;
        if (requestId === undefined) throw new Error("Input status is missing its pending request.");
        await handle.input(action.text, { requestId });
        inspection = await handle.inspect();
        continue;
      }
      if (inspection.status === "blocked" && inspection.recovery !== null) {
        occurrences.recovery += 1;
        const action = input.task.driver.recoveries.find((item) => item.occurrence === occurrences.recovery);
        if (action === undefined) break;
        if (action.restartBeforeDecision) {
          await runtime.close();
          await scenario.dispose?.();
          ({ runtime, scenario } = await createExecution());
          handle = runtime.openRun(handle.id);
          inspection = await handle.inspect();
        }
        await handle.resume({ recovery: recoveryDecision(inspection, action) });
        inspection = await handle.inspect();
        continue;
      }
      break;
    }

    const view = await runtime.inspect(handle.id);
    const modelCallTraces = await Promise.all(
      view.modelCalls.map((modelCall) => handle.modelCallTrace(modelCall.id))
    );
    for (const event of view.events) taskTelemetry.event(event);
    const taskGrade = gradeTask({ task: input.task, workspace, initialDigests });
    const tools = allowedTools(input.task, scenario.tools);
    const authorityGrade = gradeAuthority({ task: input.task, inspection, view, tools, taskGrade });
    const falseSuccess = view.snapshot.status === "succeeded" && !taskGrade.passed;
    await taskTelemetry.finish(view, {
      taskPassed: taskGrade.passed,
      evaluationPassed: authorityGrade.passed,
      falseSuccess
    }, modelObservations, modelCallTraces);
    if (input.keepWorkspace) {
      const preserved = join(input.outputDirectory, "workspaces", input.task.id);
      mkdirSync(dirname(preserved), { recursive: true });
      copyDirectory(workspace, preserved);
      copyDirectory(dataDir, join(input.outputDirectory, "run-data", input.task.id));
    }
    return createTaskReport({
      task: input.task,
      inspection,
      view,
      taskGrade,
      authorityGrade,
      modelCallTraces,
      telemetryErrors: taskTelemetry.errors,
      durationMs: performance.now() - started,
      providerMode: input.providerMode
    });
  } finally {
    await cancellationSubscription?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await scenario?.dispose?.();
    rmSync(taskRoot, { recursive: true, force: true });
  }
}

function installCancellationDriver(
  handle: RunHandle,
  task: EvalTask
): { readonly subscription: RuntimeSubscription | null; settled(): Promise<void> } {
  if (task.driver.cancellations.length === 0) {
    return { subscription: null, settled: async () => undefined };
  }
  const occurrences = new Map<string, number>();
  let control: Promise<void> = Promise.resolve();
  let controlError: unknown;
  const subscription = handle.subscribe(async (event: RuntimeEvent) => {
    const eventName = event.type === "runtime.event" ? event.name : event.type;
    if (eventName !== "tool.started" && eventName !== "tool.attempt.succeeded") return;
    const eventData = "data" in event ? event.data : {};
    const toolName = typeof eventData.toolName === "string" ? eventData.toolName : null;
    if (toolName === null) return;
    const occurrenceKey = `${eventName}:${toolName}`;
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
    occurrences.set(occurrenceKey, occurrence);
    const action = task.driver.cancellations.find((item) => (
      item.triggerEvent === eventName
      && item.toolName === toolName
      && item.occurrence === occurrence
    ));
    if (action === undefined) return;
    control = handle.cancel(action.reason).catch((error) => {
      if (action.expectUnknown && runtimeErrorCode(error) === "TOOL_RESULT_UNKNOWN") return;
      controlError = error;
    });
    await control;
  });
  return {
    subscription,
    async settled() {
      await control;
      if (controlError !== undefined) throw controlError;
    }
  };
}

function runtimeErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function observeProvider(
  provider: RuntimeProvider,
  observations: ModelObservation[]
): RuntimeProvider {
  const capture = async (
    phase: ModelObservation["phase"],
    input: unknown,
    call: () => ReturnType<RuntimeProvider["decide"]>
  ): ReturnType<RuntimeProvider["decide"]> => {
    const index = observations.push({ phase, input: structuredClone(input) }) - 1;
    try {
      const output = await call();
      observations[index] = { phase, input: observations[index]!.input, output: structuredClone(output) };
      return output;
    } catch (error) {
      observations[index] = { phase, input: observations[index]!.input, error };
      throw error;
    }
  };
  return Object.freeze({
    ...(provider.modelProfile === undefined ? {} : { modelProfile: provider.modelProfile }),
    ...(provider.transport === undefined ? {} : { transport: provider.transport }),
    ...(provider.measureTokens === undefined ? {} : { measureTokens: provider.measureTokens.bind(provider) }),
    decide: (
      context: Parameters<RuntimeProvider["decide"]>[0],
      operation: Parameters<RuntimeProvider["decide"]>[1]
    ) => capture(
      "decision",
      context,
      () => provider.decide(context, operation)
    ),
    ...(provider.dispose === undefined ? {} : { dispose: provider.dispose.bind(provider) })
  });
}

function isTerminalOrExpectedStop(inspection: RunInspection, task: EvalTask): boolean {
  if (["succeeded", "failed", "cancelled"].includes(inspection.status)) return true;
  if (inspection.status === task.expectedTerminal) {
    if (inspection.status !== "blocked" || inspection.recovery === null) return true;
    return task.driver.recoveries.length === 0;
  }
  return false;
}

type ApprovalPolicy = NonNullable<EvalTask["driver"]["approvalPolicy"]>;

function approvalDecision(
  task: EvalTask,
  inspection: RunInspection,
  ruleCounts: Map<number, number>
): ApprovalPolicy["rules"][number] & { readonly restartBeforeDecision: false } | {
  readonly decision: "deny";
  readonly reason: string;
  readonly restartBeforeDecision: false;
} | null {
  const policy = task.driver.approvalPolicy;
  if (policy === undefined) return null;
  const pending = inspection.pendingRequest;
  const action = pending?.kind === "approval" ? pending : undefined;
  const toolName = action?.toolName;
  if (typeof toolName !== "string") {
    return { decision: "deny", reason: "Approval request has no recognized Tool identity.", restartBeforeDecision: false };
  }
  if (!task.allowedCapabilities.includes(toolName)) {
    return { decision: "deny", reason: `Approval request is outside the task capability contract: ${toolName}.`, restartBeforeDecision: false };
  }
  const ruleIndex = policy.rules.findIndex((rule) => (
    rule.toolName === toolName
    && (rule.input === undefined || matchesApprovalInput(rule.input, action?.input))
  ));
  if (ruleIndex < 0) {
    return { decision: "deny", reason: `Task approval policy does not allow ${toolName}.`, restartBeforeDecision: false };
  }
  if (policy.maxApprovals !== undefined && [...ruleCounts.values()].reduce((sum, count) => sum + count, 0) >= policy.maxApprovals) {
    return { decision: "deny", reason: "Task approval policy risk budget is exhausted.", restartBeforeDecision: false };
  }
  const rule = policy.rules[ruleIndex]!;
  const used = ruleCounts.get(ruleIndex) ?? 0;
  if (rule.maxApprovals !== undefined && used >= rule.maxApprovals) {
    return { decision: "deny", reason: `Task approval policy limit for ${toolName} is exhausted.`, restartBeforeDecision: false };
  }
  ruleCounts.set(ruleIndex, used + 1);
  return { ...rule, restartBeforeDecision: false };
}

function matchesApprovalInput(expected: Record<string, unknown>, actual: unknown): boolean {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  const value = actual as Record<string, unknown>;
  return Object.entries(expected).every(([key, expectedValue]) => {
    const actualValue = value[key];
    if (expectedValue !== null && typeof expectedValue === "object" && !Array.isArray(expectedValue)) {
      return matchesApprovalInput(expectedValue as Record<string, unknown>, actualValue);
    }
    return JSON.stringify(actualValue) === JSON.stringify(expectedValue);
  });
}

async function loadScenarioFactory(path: string): Promise<ScenarioFactory> {
  const module = await import(`${pathToFileURL(path).href}?bench=${Date.now()}`) as { readonly createScenario?: unknown };
  if (typeof module.createScenario !== "function") {
    throw new Error(`Scenario module must export createScenario(): ${path}`);
  }
  return module.createScenario as ScenarioFactory;
}

function allowedTools(task: EvalTask, tools: readonly RuntimeTool[]): readonly RuntimeTool[] {
  const byName = new Map(tools.map((tool) => [tool.contract.identity.name, tool]));
  const missing = task.allowedCapabilities.filter((name) => !byName.has(name));
  if (missing.length > 0) throw new Error(`Scenario is missing allowed capabilities: ${missing.join(", ")}`);
  return Object.freeze(task.allowedCapabilities.map((name) => byName.get(name)!));
}

function recoveryDecision(
  inspection: RunInspection,
  action: EvalTask["driver"]["recoveries"][number]
): RecoveryDecision {
  const recovery = inspection.recovery;
  if (recovery === null) throw new Error("Recovery action requires an unknown Invocation.");
  if (action.outcome === "confirmed_succeeded") {
    if (action.subjectRef === undefined) throw new Error("confirmed_succeeded requires subjectRef.");
    return { invocationId: recovery.invocationId, outcome: action.outcome, subjectRef: action.subjectRef };
  }
  return {
    invocationId: recovery.invocationId,
    outcome: action.outcome,
    ...(action.reason === undefined ? {} : { reason: action.reason })
  };
}

function copyDirectory(source: string, target: string): void {
  rmSync(target, { recursive: true, force: true });
  copyDirectoryTree(source, target);
}

function infrastructureFailure(
  task: EvalTask,
  error: unknown,
  providerMode: "deterministic" | "real"
): TaskReport {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  const failedCheck = { id: "eval-infrastructure", passed: false, message } as const;
  return {
    taskId: task.id,
    category: task.category,
    horizon: task.horizon,
    split: task.split,
    providerMode,
    runId: "not-started",
    passed: false,
    taskPassed: false,
    nexoraValidated: false,
    falseSuccess: false,
    expectedTerminal: task.expectedTerminal,
    actualTerminal: "eval_error",
    hardGateFailures: ["eval_infrastructure"],
    firstBrokenBoundary: "EVAL_INFRASTRUCTURE",
    taskGrade: { passed: false, checks: [failedCheck] },
    authorityGrade: {
      passed: false,
      checks: [failedCheck],
      gates: {},
      metrics: {
        events: 0,
        invocations: 0,
        evidence: 0,
        modelCalls: 0,
        actualInputTokens: 0,
        actualOutputTokens: 0,
        duplicateNonIdempotentEffects: 0,
        unauthorizedEffects: 0
      }
    },
    authorityRefs: { invocationIds: [], evidenceIds: [], modelCallIds: [], lastEventSequence: 0 },
    diagnostics: {
      stopReason: "eval_infrastructure",
      runErrorCode: "EVAL_INFRASTRUCTURE",
      failedToolCodes: [],
      failedModelCallCodes: [],
      responseRejectedCount: 0,
      providerFailureCount: 0,
      exactFailedReplayCount: 0,
      persistedProgressCount: 0,
      effectiveToolRatio: 0,
      responseRejectionRate: 0,
      repairRecoveryCount: 0,
      firstPersistedProgressMs: null,
      progressAcrossRestartCount: 0,
      approvalRequestedCount: 0,
      approvalGrantedCount: 0,
      approvalDeniedCount: 0,
      approvalGrantToolExecutionRate: null
    },
    promptStrategy: {
      calls: [],
      strategyConsistency: {
        comparableCallCount: 0,
        consistent: null,
        driftCount: 0,
        distinctStablePrefixDigests: []
      },
      cache: {
        compilerDeclaredStablePrefixTokens: 0,
        cacheEligibleInputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        comparableAttemptCount: 0,
        cachedInputRatio: null,
        statusCounts: { unsupported: 0, disabled: 0, miss: 0, partial_hit: 0, hit: 0, unknown: 0 }
      }
    },
    telemetryErrors: [],
    durationMs: 0,
    reproductionCommand: `pnpm --filter @nexora/bench bench -- --provider ${providerMode} --task ${task.id}`
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function codexResultSchema(): unknown {
  return {
    type: "object",
    properties: {
      status: { enum: ["fixed", "not_fixed", "blocked"] },
      boundary: { type: "string" },
      rootCause: { type: "string" },
      changedFiles: { type: "array", items: { type: "string" } },
      verification: { type: "array", items: { type: "string" } },
      residualRisk: { type: "string" }
    },
    required: ["status", "boundary", "rootCause", "changedFiles", "verification", "residualRisk"],
    additionalProperties: false
  };
}

function codexPrompt(packetPath: string): string {
  return `Read ${packetPath} and work only on primaryCluster.\n\n` +
    "Follow AGENTS.md, ARCHITECTURE.md, LOOP.md and TESTS.md. Reproduce the failure first, fix the earliest broken boundary with the smallest implementation, and run every acceptance command. Do not modify datasets, fixtures, graders, expected results, or hidden-test configuration. Stop if the fix requires changing a public Contract, Authority, security boundary, destructive migration, or heavyweight dependency.\n";
}
