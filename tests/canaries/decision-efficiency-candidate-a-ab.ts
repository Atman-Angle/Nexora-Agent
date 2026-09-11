import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgent,
  createBuiltInTools,
  openAICompatibleProviderFromEnv,
  type ModelResponse
} from "../../packages/harness/src/index.js";
import { createDecisionEfficiencyReport } from "../../harness/nexora-bench/src/decision-efficiency.js";

type Arm = "control" | "candidate";
type JsonRecord = Record<string, unknown>;
type WireRecord = JsonRecord;

type TaskDefinition = {
  readonly id: string;
  readonly lane: string;
  readonly input: string;
  readonly resumeInput?: string;
  readonly completion: { readonly evidence: "auto" | "optional" | "required"; readonly requiredToolNames: string[] };
  readonly seed: (workspace: string) => void;
  readonly validate: (input: {
    readonly status: string;
    readonly view: JsonRecord;
    readonly workspace: string;
  }) => readonly string[];
};

type RunReport = {
  readonly task: string;
  readonly lane: string;
  readonly arm: Arm;
  readonly repetition: number;
  readonly order: number;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly result: JsonRecord;
  readonly decisionEfficiency: JsonRecord;
  readonly wire: readonly WireRecord[];
  readonly invariants: JsonRecord;
};

const repetitionsArgument = argumentValue("--repetitions");
const repetitions = repetitionsArgument === undefined ? 5 : positiveInteger(repetitionsArgument);
const onlyArgument = argumentValue("--tasks");
const onlyTasks = onlyArgument === undefined ? null : new Set(onlyArgument.split(",").map((value) => value.trim()));
const cacheModeArgument = argumentValue("--cache-mode");
const cacheMode = cacheModeArgument === "automatic" ? "automatic" : "disabled";
const outputPath = argumentValue("--output") ?? `docs/evidence/decision-efficiency-candidate-a-ab-${cacheMode}.json`;

const tasks: readonly TaskDefinition[] = [
  directReadTask(),
  similarToolTask(),
  readOnlyTask(),
  mutationTask(),
  protectedTask(),
  multiCallTask(),
  planAndReadTask(),
  requestInputTask(),
  recoveryTask(),
  codingTask()
].filter((task) => onlyTasks === null || onlyTasks.has(task.id));

if (tasks.length === 0) throw new Error("No Candidate A task matched --tasks.");

const providerEnvironment = {
  ...process.env,
  NEXORA_MODEL_PROMPT_CACHE: cacheMode,
  NEXORA_MODEL_STREAM: "false"
};
const originalFetch = globalThis.fetch.bind(globalThis);
let wireRecords: WireRecord[] = [];
let wireIndex = 0;
const runs: RunReport[] = [];
const startedAt = new Date().toISOString();

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const bodyText = String(init?.body ?? "{}");
  const body = JSON.parse(bodyText) as JsonRecord;
  const system = messageContent(body, "system");
  const tools = body.tools === undefined ? null : JSON.stringify(body.tools);
  const record: WireRecord = {
    index: wireIndex++,
    requestBytes: Buffer.byteLength(bodyText, "utf8"),
    systemBytes: Buffer.byteLength(system ?? "", "utf8"),
    providerToolsBytes: tools === null ? null : Buffer.byteLength(tools, "utf8"),
    providerToolsDigest: tools === null ? null : digest(tools),
    providerToolNames: toolNames(body),
    promptToolsSegmentBytes: promptToolsSegmentBytes(system),
    promptToolsSegmentEstimatedTokens: Math.ceil(promptToolsSegmentBytes(system) / 4),
    messages: messageSummary(body)
  };
  wireRecords.push(record);
  const response = await originalFetch(input, init);
  const cloned = response.clone();
  const responseText = await cloned.text();
  try {
    const responseJson = JSON.parse(responseText) as JsonRecord;
    record.response = responseSummary(responseJson);
  } catch {
    record.response = { bodyText: responseText.slice(0, 500) };
  }
  return response;
};
const provider = openAICompatibleProviderFromEnv(providerEnvironment);

try {
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const task of tasks) {
      const first = repetition % 2 === 1 ? "control" : "candidate";
      const second = first === "control" ? "candidate" : "control";
      const order = [first as Arm, second as Arm];
      for (let index = 0; index < order.length; index += 1) {
        const arm = order[index]!;
        process.stdout.write(`${task.id} rep=${repetition} arm=${arm}\n`);
        runs.push(await runOnce({ task, arm, repetition, order: index + 1 }));
      }
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}

const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  startedAt,
  provider: provider.modelProfile?.provider ?? "unknown",
  model: provider.modelProfile?.model ?? "unknown",
  cacheMode,
  repetitions,
  taskCount: tasks.length,
  tasks: tasks.map((task) => task.id),
  configuration: {
    transport: "native_tools",
    toolCatalogProjectionControl: "full",
    toolCatalogProjectionCandidate: "provider_native_only",
    productionDefault: "full",
    providerFunctionSchemas: "unchanged",
    budget: runBudgets(),
    cacheMode
  },
  aggregate: aggregate(runs),
  runs
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report.aggregate, null, 2)}\n`);

if (runs.some((run) => !run.passed)) process.exitCode = 1;

async function runOnce(input: {
  readonly task: TaskDefinition;
  readonly arm: Arm;
  readonly repetition: number;
  readonly order: number;
}): Promise<RunReport> {
  const workspace = mkdtempSync(join(tmpdir(), `nexora-candidate-a-${input.task.id}-${input.arm}-`));
  input.task.seed(workspace);
  const initialState = workspaceState(workspace);
  wireRecords = [];
  wireIndex = 0;
  const runtime = createAgent({
    workspace,
    provider,
    tools: createBuiltInTools({ artifactDir: join(workspace, ".nexora", "artifacts") }),
    toolCatalogProjection: input.arm === "candidate" ? "provider_native_only" : "full",
    delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 }
  });
  const startedAtMs = Date.now();
  try {
    let result = await runtime.start({
      input: input.task.input,
      completion: input.task.completion,
      budgets: runBudgets()
    });
    for (let step = 0; step < 6; step += 1) {
      const view = await runtime.inspect(result.runId);
      const pending = pendingRequest(view);
      if (pending?.kind === "approval") {
        result = await runtime.resume({
          runId: result.runId,
          approvalDecision: { requestId: String(pending.id), approved: true }
        });
        continue;
      }
      if (pending?.kind === "input" && input.task.resumeInput !== undefined) {
        result = await runtime.resume({
          runId: result.runId,
          input: input.task.resumeInput
        });
        continue;
      }
      break;
    }
    const view = await runtime.inspect(result.runId);
    const handle = runtime.openRun(result.runId);
    const modelCalls = (view as { readonly modelCalls: readonly { readonly id: string }[] }).modelCalls;
    const traces = await Promise.all(modelCalls.map((call) => handle.modelCallTrace(call.id)));
    const efficiency = createDecisionEfficiencyReport(view, traces, {
      completionAccepted: result.status === "succeeded"
    });
    const failures = [
      ...input.task.validate({ status: result.status, view: view as unknown as JsonRecord, workspace }),
      ...telemetryFailures(efficiency)
    ];
    const firstWire = wireRecords[0] ?? {};
    const invariants = {
      provider: provider.modelProfile?.provider ?? null,
      model: provider.modelProfile?.model ?? null,
      transport: "native_tools",
      providerFunctionSchemaDigest: firstWire.providerToolsDigest ?? null,
      providerToolNames: firstWire.providerToolNames ?? [],
      initialStateDigest: digest(JSON.stringify(initialState)),
      task: input.task.id,
      budget: runBudgets(),
      cacheMode,
      runtimeConfiguration: {
        toolCatalogProjection: input.arm === "candidate" ? "provider_native_only" : "full",
        contextProjectionDedupe: "on",
        hybridContext: "on",
        codingExecutionCadence: "on"
      }
    };
    return {
      task: input.task.id,
      lane: input.task.lane,
      arm: input.arm,
      repetition: input.repetition,
      order: input.order,
      passed: failures.length === 0,
      failures,
      result: {
        runId: result.runId,
        status: result.status,
        stopReason: result.stopReason,
        summary: result.summary,
        wallClockMs: Date.now() - startedAtMs,
        toolInvocations: toolInvocations(view),
        modelTurns: modelTurns(view),
        responseRejectedCount: eventCount(view, "response.rejected"),
        modelResponseRejectedCount: eventCount(view, "model.response_rejected"),
        approvalRequestedCount: eventCount(view, "approval.requested"),
        approvalGrantedCount: eventCount(view, "approval.granted"),
        evidenceCount: evidenceCount(view),
        finalState: workspaceState(workspace)
      },
      decisionEfficiency: efficiencySummary(efficiency),
      wire: wireRecords,
      invariants
    };
  } finally {
    await runtime.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

function directReadTask(): TaskDefinition {
  return {
    id: "direct-read",
    lane: "direct-simple-tool-selection",
    input: "Read target.txt and report its exact content.",
    completion: { evidence: "required", requiredToolNames: ["filesystem.read"] },
    seed: (workspace) => writeFileSync(join(workspace, "target.txt"), "DIRECT-READ-7F41\n", "utf8"),
    validate: ({ status, view, workspace }) => [
      ...(status === "succeeded" ? [] : [`Expected succeeded, received ${status}.`]),
      ...(toolNamesOverall(view).join("|") === "filesystem.read" ? [] : ["Expected exactly one filesystem.read call."]),
      ...(readFile(workspace, "target.txt") === "DIRECT-READ-7F41\n" ? [] : ["Workspace target changed unexpectedly."])
    ]
  };
}

function similarToolTask(): TaskDefinition {
  return {
    id: "similar-tool",
    lane: "similar-tool-selection",
    input: "Find the unique file containing SIMILAR-MARKER-53C9 using workspace search, then read that exact file and report its content.",
    completion: { evidence: "required", requiredToolNames: ["filesystem.search", "filesystem.read"] },
    seed: (workspace) => {
      writeFileSync(join(workspace, "target.txt"), "SIMILAR-MARKER-53C9\n", "utf8");
      writeFileSync(join(workspace, "distractor.txt"), " unrelated\n", "utf8");
    },
    validate: ({ status, view, workspace }) => {
      const calls = toolNamesOverall(view);
      return [
        ...(status === "succeeded" ? [] : [`Expected succeeded, received ${status}.`]),
        ...(calls.includes("filesystem.search") && calls.includes("filesystem.read") ? [] : ["Expected search followed by read."]),
        ...(calls.indexOf("filesystem.search") < calls.lastIndexOf("filesystem.read") ? [] : ["Expected search before read."]),
        ...(readFile(workspace, "target.txt") === "SIMILAR-MARKER-53C9\n" ? [] : ["Workspace target changed unexpectedly."])
      ];
    }
  };
}

function readOnlyTask(): TaskDefinition {
  return {
    id: "read-only",
    lane: "read-versus-mutation",
    input: "Inspect target.txt and report its exact content. Do not modify any file.",
    completion: { evidence: "required", requiredToolNames: ["filesystem.read"] },
    seed: (workspace) => writeFileSync(join(workspace, "target.txt"), "READ-ONLY-8D17\n", "utf8"),
    validate: ({ status, view, workspace }) => [
      ...(status === "succeeded" ? [] : [`Expected succeeded, received ${status}.`]),
      ...(toolNamesOverall(view).every((name) => name === "filesystem.read") ? [] : ["Read-only task invoked a non-read Tool."]),
      ...(readFile(workspace, "target.txt") === "READ-ONLY-8D17\n" ? [] : ["Read-only target changed."])
    ]
  };
}

function mutationTask(): TaskDefinition {
  return {
    id: "mutation",
    lane: "read-versus-mutation",
    input: "First create a Plan. Then change target.txt from CONTROL-A to CANDIDATE-B using filesystem.patch, read target.txt to verify, and report the final content.",
    completion: { evidence: "required", requiredToolNames: ["filesystem.patch", "filesystem.read"] },
    seed: (workspace) => writeFileSync(join(workspace, "target.txt"), "CONTROL-A\n", "utf8"),
    validate: ({ status, view, workspace }) => {
      const calls = toolNamesOverall(view);
      return [
        ...(status === "succeeded" ? [] : [`Expected succeeded, received ${status}.`]),
        ...(calls.includes("nexora_update_plan") ? [] : ["Expected a Plan control call before mutation."]),
        ...(calls.includes("filesystem.patch") && calls.includes("filesystem.read") ? [] : ["Expected patch followed by verification read."]),
        ...(readFile(workspace, "target.txt") === "CANDIDATE-B\n" ? [] : ["Mutation did not produce the expected content."])
      ];
    }
  };
}

function protectedTask(): TaskDefinition {
  return {
    id: "protected",
    lane: "protected-destructive-operation",
    input: "First create a Plan. Then run the exact command node --version using shell.execute and report the exact version.",
    completion: { evidence: "required", requiredToolNames: ["shell.execute"] },
    seed: () => undefined,
    validate: ({ status, view }) => [
      ...(status === "succeeded" ? [] : [`Expected succeeded, received ${status}.`]),
      ...(toolNamesOverall(view).includes("shell.execute") ? [] : ["Expected shell.execute."]),
      ...(eventCount(view, "approval.requested") > 0 && eventCount(view, "approval.granted") > 0 ? [] : ["Expected Approval request and grant."])
    ]
  };
}

function multiCallTask(): TaskDefinition {
  return {
    id: "multi-call",
    lane: "multi-call-batch",
    input: "In one Function Calling response, call filesystem.read for alpha.txt and beta.txt. After both results return, report both exact contents in alpha then beta order.",
    completion: { evidence: "required", requiredToolNames: ["filesystem.read"] },
    seed: (workspace) => {
      writeFileSync(join(workspace, "alpha.txt"), "MULTI-ALPHA-91A2\n", "utf8");
      writeFileSync(join(workspace, "beta.txt"), "MULTI-BETA-44B7\n", "utf8");
    },
    validate: ({ status, view, workspace }) => {
      const turns = modelTurns(view);
      const batch = turns.find((turn) => (
        Array.isArray(turn.toolCalls) && turn.toolCalls.length === 2
        && turn.toolCalls.every((call) => call.name === "filesystem.read")
      ));
      return [
        ...(status === "succeeded" ? [] : [`Expected succeeded, received ${status}.`]),
        ...(batch === undefined ? ["Expected one two-call filesystem.read batch."] : []),
        ...(batch !== undefined && new Set(((batch.toolCalls ?? []) as readonly JsonRecord[]).map((call) => String(call.callId))).size === 2 ? [] : ["Expected distinct call IDs in the batch."]),
        ...(readFile(workspace, "alpha.txt") === "MULTI-ALPHA-91A2\n" && readFile(workspace, "beta.txt") === "MULTI-BETA-44B7\n" ? [] : ["Workspace inputs changed unexpectedly."])
      ];
    }
  };
}

function planAndReadTask(): TaskDefinition {
  return {
    id: "plan-read",
    lane: "control-versus-runtime-tool",
    input: "First create a Plan with one outcome to read target.txt. Then read target.txt and report its exact content.",
    completion: { evidence: "required", requiredToolNames: ["filesystem.read"] },
    seed: (workspace) => writeFileSync(join(workspace, "target.txt"), "PLAN-READ-31E6\n", "utf8"),
    validate: ({ status, view, workspace }) => {
      const calls = toolNamesOverall(view);
      return [
        ...(status === "succeeded" ? [] : [`Expected succeeded, received ${status}.`]),
        ...(calls.includes("nexora_update_plan") ? [] : ["Expected nexora_update_plan."]),
        ...(calls.includes("filesystem.read") ? [] : ["Expected filesystem.read."]),
        ...(readFile(workspace, "target.txt") === "PLAN-READ-31E6\n" ? [] : ["Workspace target changed unexpectedly."])
      ];
    }
  };
}

function requestInputTask(): TaskDefinition {
  return {
    id: "request-input",
    lane: "control-versus-runtime-tool",
    input: "The required authorization code is user-exclusive. Request it, and after receiving it report the code verbatim.",
    resumeInput: "AUTH-CODE-77889",
    completion: { evidence: "optional", requiredToolNames: [] },
    seed: () => undefined,
    validate: ({ status, view }) => [
      ...(status === "succeeded" ? [] : [`Expected succeeded after input resume, received ${status}.`]),
      ...(toolNamesOverall(view).includes("nexora_request_input") ? [] : ["Expected nexora_request_input."]),
      ...(JSON.stringify(view).includes("AUTH-CODE-77889") ? [] : ["Resumed user input was not persisted."])
    ]
  };
}

function recoveryTask(): TaskDefinition {
  return {
    id: "recovery",
    lane: "recovery",
    input: "Read missing.txt. If that read fails, search the workspace for RECOVERY-MARKER and read the file that contains it, then report that content.",
    completion: { evidence: "required", requiredToolNames: ["filesystem.search", "filesystem.read"] },
    seed: (workspace) => writeFileSync(join(workspace, "target.txt"), "RECOVERY-MARKER-62D4\n", "utf8"),
    validate: ({ status, view, workspace }) => {
      const calls = toolNamesOverall(view);
      const invocations = toolInvocations(view);
      const failedRead = invocations.some((invocation) => invocation.toolName === "filesystem.read" && invocation.status === "failed");
      return [
        ...(status === "succeeded" ? [] : [`Expected succeeded, received ${status}.`]),
        ...(failedRead ? [] : ["Expected the initial missing.txt read to fail."]),
        ...(calls.includes("filesystem.search") ? [] : ["Expected a search recovery strategy."]),
        ...(invocations.some((invocation) => invocation.toolName === "filesystem.read" && invocation.status === "succeeded") ? [] : ["Expected a successful recovery read."]),
        ...(readFile(workspace, "target.txt") === "RECOVERY-MARKER-62D4\n" ? [] : ["Workspace target changed unexpectedly."])
      ];
    }
  };
}

function codingTask(): TaskDefinition {
  return {
    id: "coding",
    lane: "coding-filesystem",
    input: "First create a Plan with exactly two tool-backed outcomes: write result.txt containing CANDIDATE-A-CODING-99C1 using filesystem.write, then read result.txt to verify it. Do not add a separate reporting outcome. Execute both outcomes and report the verified content.",
    completion: { evidence: "required", requiredToolNames: ["filesystem.write", "filesystem.read"] },
    seed: () => undefined,
    validate: ({ status, view, workspace }) => {
      const calls = toolNamesOverall(view);
      return [
        ...(status === "succeeded" ? [] : [`Expected succeeded, received ${status}.`]),
        ...(calls.includes("nexora_update_plan") ? [] : ["Expected a Plan control call."]),
        ...(calls.includes("filesystem.write") && calls.includes("filesystem.read") ? [] : ["Expected write followed by verification read."]),
        ...(readFile(workspace, "result.txt").includes("CANDIDATE-A-CODING-99C1") ? [] : ["Coding output did not match."])
      ];
    }
  };
}

function telemetryFailures(efficiency: ReturnType<typeof createDecisionEfficiencyReport>): readonly string[] {
  const failures: string[] = [];
  if (efficiency.usageIncompleteAttempts > 0) failures.push("Provider usage telemetry incomplete.");
  if (efficiency.wireTelemetryIncompleteAttempts > 0) failures.push("Wire telemetry incomplete.");
  if (efficiency.wasteCategories.duplicate_mutation > 0) failures.push("Duplicate mutation occurred.");
  return failures;
}

function efficiencySummary(efficiency: ReturnType<typeof createDecisionEfficiencyReport>): JsonRecord {
  return {
    logicalModelCalls: efficiency.logicalModelCalls,
    providerAttempts: efficiency.providerAttempts,
    budgetMeasuredInputTokens: efficiency.budgetMeasuredInputTokens,
    providerVisibleEstimatedInputTokens: efficiency.providerVisibleEstimatedInputTokens,
    actualProviderInputTokens: efficiency.actualProviderInputTokens,
    actualProviderOutputTokens: efficiency.actualProviderOutputTokens,
    actualProviderTotalTokens: efficiency.actualProviderTotalTokens,
    effectiveActionCount: efficiency.effectiveActionCount,
    effectiveActions: efficiency.effectiveActions,
    responseToolCallCount: efficiency.responseToolCallCount,
    toolInvocationCount: efficiency.toolInvocationCount,
    duplicateSubstantivePayloadCount: efficiency.duplicateSubstantivePayloadCount,
    toolBatches: efficiency.toolBatches,
    efficiency: efficiency.efficiency,
    wasteCategories: efficiency.wasteCategories,
    wallClockMs: efficiency.wallClockMs,
    usageIncompleteAttempts: efficiency.usageIncompleteAttempts,
    wireTelemetryIncompleteAttempts: efficiency.wireTelemetryIncompleteAttempts,
    sectionAttributionTotals: efficiency.sectionAttributionTotals,
    distributions: efficiency.distributions
  };
}

function aggregate(runs: readonly RunReport[]): JsonRecord {
  const byTaskArm = new Map<string, RunReport[]>();
  for (const run of runs) {
    const key = `${run.task}:${run.arm}`;
    byTaskArm.set(key, [...(byTaskArm.get(key) ?? []), run]);
  }
  const taskResults = [...byTaskArm.entries()].map(([key, values]) => {
    const successful = values.filter((value) => value.result.status === "succeeded");
    const actualInputs = successful.map((value) => Number(value.decisionEfficiency.actualProviderInputTokens ?? 0));
    const effectiveActions = successful.map((value) => Number(value.decisionEfficiency.effectiveActionCount ?? 0));
    return {
      key,
      n: values.length,
      passed: values.filter((value) => value.passed).length,
      successCount: successful.length,
      successRate: values.length === 0 ? null : successful.length / values.length,
      falseSuccessCount: values.filter((value) => value.result.status === "succeeded" && !value.passed).length,
      actualInputTokens: distribution(actualInputs),
      actualInputTokensPerSuccessfulTask: successful.length === 0 ? null : distribution(actualInputs),
      actualInputTokensPerEffectiveAction: successful.length === 0 ? null : distribution(actualInputs.map((tokens, index) => (
        effectiveActions[index] === 0 ? null : tokens / effectiveActions[index]!
      )).filter((value): value is number => value !== null)),
      logicalModelCalls: distribution(successful.map((value) => Number(value.decisionEfficiency.logicalModelCalls ?? 0))),
      providerAttempts: distribution(successful.map((value) => Number(value.decisionEfficiency.providerAttempts ?? 0))),
      wallClockMs: distribution(successful.map((value) => Number(value.result.wallClockMs ?? 0))),
      responseRejectedCount: values.reduce((total, value) => total + Number(value.result.responseRejectedCount ?? 0), 0),
      providerFunctionSchemaDigests: [...new Set(values.map((value) => value.invariants.providerFunctionSchemaDigest))]
    };
  });
  const control = runs.filter((run) => run.arm === "control");
  const candidate = runs.filter((run) => run.arm === "candidate");
  return {
    taskResults,
    overall: {
      control: overallArm(control),
      candidate: overallArm(candidate)
    }
  };
}

function overallArm(runs: readonly RunReport[]): JsonRecord {
  const successful = runs.filter((run) => run.result.status === "succeeded");
  const actualInputs = successful.map((run) => Number(run.decisionEfficiency.actualProviderInputTokens ?? 0));
  const effectiveActions = successful.map((run) => Number(run.decisionEfficiency.effectiveActionCount ?? 0));
  return {
    n: runs.length,
    passed: runs.filter((run) => run.passed).length,
    successCount: successful.length,
    successRate: runs.length === 0 ? null : successful.length / runs.length,
    falseSuccessCount: runs.filter((run) => run.result.status === "succeeded" && !run.passed).length,
    actualInputTokensPerSuccessfulTask: successful.length === 0 ? null : distribution(actualInputs),
    actualInputTokensPerEffectiveAction: successful.length === 0 ? null : distribution(actualInputs.map((tokens, index) => (
      effectiveActions[index] === 0 ? null : tokens / effectiveActions[index]!
    )).filter((value): value is number => value !== null)),
    logicalModelCallsPerSuccessfulTask: successful.length === 0 ? null : distribution(successful.map((run) => Number(run.decisionEfficiency.logicalModelCalls ?? 0))),
    providerAttemptsPerSuccessfulTask: successful.length === 0 ? null : distribution(successful.map((run) => Number(run.decisionEfficiency.providerAttempts ?? 0))),
    wallClockPerSuccessfulTask: successful.length === 0 ? null : distribution(successful.map((run) => Number(run.result.wallClockMs ?? 0)))
  };
}

function distribution(values: readonly number[]): JsonRecord {
  if (values.length === 0) return { n: 0, p50: null, p95: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    n: sorted.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted.at(-1) ?? null
  };
}

function quantile(sorted: readonly number[], value: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1);
  return sorted[Math.max(0, index)]!;
}

function runBudgets() {
  return {
    maxIterations: 16,
    maxModelCalls: 16,
    maxToolCalls: 10,
    maxRetries: 2,
    maxDurationMs: 180_000
  };
}

function workspaceState(workspace: string): JsonRecord {
  const values: Record<string, string> = {};
  for (const name of ["target.txt", "distractor.txt", "alpha.txt", "beta.txt", "result.txt"]) {
    try {
      values[name] = digest(readFileSync(join(workspace, name), "utf8"));
    } catch {
      values[name] = "absent";
    }
  }
  return values;
}

function readFile(workspace: string, path: string): string {
  try {
    return readFileSync(join(workspace, path), "utf8");
  } catch {
    return "";
  }
}

function pendingRequest(view: unknown): { readonly kind?: unknown; readonly id?: unknown } | null {
  const record = view as { readonly snapshot?: { readonly pendingRequest?: unknown } };
  const pending = record?.snapshot?.pendingRequest;
  return pending !== null && typeof pending === "object" ? pending as { readonly kind?: unknown; readonly id?: unknown } : null;
}

function toolInvocations(view: unknown): readonly JsonRecord[] {
  const record = view as { readonly toolInvocations?: readonly unknown[] };
  return (record?.toolInvocations ?? []).map((invocation) => {
    const value = invocation as JsonRecord;
    return {
      id: value.id,
      toolName: value.toolName,
      status: value.status,
      inputJson: value.inputJson,
      resultJson: value.resultJson,
      errorJson: value.errorJson
    };
  });
}

function modelTurns(view: unknown): readonly JsonRecord[] {
  const record = view as { readonly events?: readonly { readonly type?: string; readonly payload?: unknown }[] };
  return (record?.events ?? [])
    .filter((event) => event.type === "model.turn")
    .map((event) => event.payload as JsonRecord);
}

function toolNamesOverall(view: unknown): readonly string[] {
  return modelTurns(view).flatMap((turn) => (
    Array.isArray(turn.toolCalls)
      ? turn.toolCalls.map((call) => String((call as JsonRecord).name))
      : []
  ));
}

function eventCount(view: unknown, type: string): number {
  const record = view as { readonly events?: readonly { readonly type?: string }[] };
  return (record?.events ?? []).filter((event) => event.type === type).length;
}

function evidenceCount(view: unknown): number {
  const record = view as { readonly snapshot?: { readonly evidence?: readonly unknown[] } };
  return record?.snapshot?.evidence?.length ?? 0;
}

function messageContent(body: JsonRecord, role: string): string | null {
  const messages = body.messages as readonly { readonly role?: string; readonly content?: unknown }[] | undefined;
  const message = messages?.find((candidate) => candidate.role === role);
  return message?.content === undefined || message.content === null ? null : String(message.content);
}

function messageSummary(body: JsonRecord): readonly JsonRecord[] {
  const messages = body.messages as readonly { readonly role?: string; readonly content?: unknown; readonly tool_call_id?: unknown; readonly tool_calls?: unknown }[] | undefined;
  return (messages ?? []).map((message) => ({
    role: message.role ?? null,
    contentBytes: message.content === undefined || message.content === null ? 0 : Buffer.byteLength(String(message.content), "utf8"),
    toolCallId: message.tool_call_id ?? null,
    toolCallCount: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0
  }));
}

function toolNames(body: JsonRecord): readonly string[] {
  const tools = body.tools as readonly { readonly function?: { readonly name?: unknown } }[] | undefined;
  return (tools ?? []).map((tool) => String(tool.function?.name));
}

function promptToolsSegmentBytes(system: string | null): number {
  if (system === null) return 0;
  const start = system.indexOf("[TOOLS]\n");
  if (start < 0) return 0;
  const end = system.indexOf("\n[SKILLS]", start);
  const content = system.slice(start + "[TOOLS]\n".length, end < 0 ? undefined : end);
  return Buffer.byteLength(content, "utf8");
}

function responseSummary(value: JsonRecord): JsonRecord {
  const choices = value.choices as readonly JsonRecord[] | undefined;
  const choice = choices?.[0] ?? {};
  const message = choice.message as JsonRecord | undefined;
  return {
    finishReason: choice.finish_reason ?? null,
    content: message?.content === undefined || message?.content === null ? null : String(message.content),
    toolCalls: Array.isArray(message?.tool_calls)
      ? message.tool_calls.map((call) => {
        const record = call as JsonRecord;
        const functionValue = record.function as JsonRecord | undefined;
        return {
          id: record.id,
          type: record.type,
          name: functionValue?.name,
          arguments: functionValue?.arguments
        };
      })
      : [],
    usage: value.usage ?? null
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--repetitions must be a positive integer.");
  return parsed;
}
