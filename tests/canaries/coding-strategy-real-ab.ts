import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createAgent,
  createBuiltInTools,
  openAICompatibleProviderFromEnv,
  type AgentPublicOutputEvent,
  type CodingStrategyMode,
  type RunResult,
  type RuntimeObserver,
  type RunView
} from "../../packages/harness/src/index.js";
import { scopeExpansionRate, usefulVerificationCount } from "./coding-strategy-eval.js";

const PROMPT = "请在这个空工作区中创建一个个人探索日志 Web 应用。必须支持添加、编辑、删除记录，按文本搜索，按类别筛选，刷新后通过本地持久化保留数据，并提供基本可用的界面。其他细节由你判断。";
const CORE_REQUIREMENTS = ["add", "edit", "delete", "search", "filter", "persistence"] as const;
type Scenario = {
  readonly id: "greenfield" | "existing_feature" | "bug_fix";
  readonly expectedTaskShape: "greenfield" | "feature" | "bug_fix";
  readonly prompt: string;
  seed(workspace: string): void;
};
const GREENFIELD_SCENARIO: Scenario = {
  id: "greenfield",
  expectedTaskShape: "greenfield",
  prompt: PROMPT,
  seed: () => undefined
};
const EXISTING_FEATURE_SCENARIO: Scenario = {
  id: "existing_feature",
  expectedTaskShape: "feature",
  prompt: "在现有个人探索日志 Web 应用上补全编辑、删除、文本搜索和类别筛选功能，并保留现有新增和 localStorage 持久化；运行 node --check app.js 验证。",
  seed: seedExistingFeature
};
const BUG_FIX_SCENARIO: Scenario = {
  id: "bug_fix",
  expectedTaskShape: "bug_fix",
  prompt: "修复 app.js 中导致页面无法加载的语法 bug，不改变现有新增、编辑、删除、文本搜索、类别筛选和 localStorage 行为；运行 node --check app.js 验证。",
  seed: seedBugFix
};
const RELIABILITY_SCENARIOS = [GREENFIELD_SCENARIO, EXISTING_FEATURE_SCENARIO, BUG_FIX_SCENARIO] as const;
const OPTIONAL_SCOPE_PATTERNS = new Map<string, RegExp>([
  ["multiple_views", /(?:多视图|multiple views?|grid view|timeline view|calendar view)/iu],
  ["timeline", /(?:时间线|timeline)/iu],
  ["matrix", /(?:矩阵|matrix)/iu],
  ["undo", /(?:撤销|\bundo\b)/iu],
  ["import_export", /(?:导入|导出|\bimport\s*\/?\s*export\b|data export)/iu],
  ["keyboard_shortcuts", /(?:快捷键|keyboard shortcuts?|command palette)/iu],
  ["custom_server", /(?:自建服务器|custom server|express server|dev server)/iu],
  ["browser_infrastructure", /(?:playwright|puppeteer|headless browser|browser test infrastructure)/iu]
]);
const OUTPUT_ARG = process.argv.indexOf("--output");
const FEATURE_ARG = process.argv.indexOf("--feature");
const VARIANT_ARG = process.argv.indexOf("--variant");
const SUITE_ARG = process.argv.indexOf("--suite");
const HYBRID_ARG = process.argv.indexOf("--hybrid");
const CADENCE_ARG = process.argv.indexOf("--cadence");
const requestedVariant = VARIANT_ARG < 0 ? "both" : process.argv[VARIANT_ARG + 1];
const requestedSuite = SUITE_ARG < 0 ? "ab" : process.argv[SUITE_ARG + 1];
const requestedHybrid = HYBRID_ARG < 0 ? "on" : process.argv[HYBRID_ARG + 1];
const requestedCadence = CADENCE_ARG < 0 ? "on" : process.argv[CADENCE_ARG + 1];
const requestedFeature = FEATURE_ARG < 0
  ? "autonomous-coding-execution-v0.1"
  : process.argv[FEATURE_ARG + 1];
if (FEATURE_ARG >= 0 && !requestedFeature) throw new Error("--feature requires a value.");
if (requestedVariant !== "both" && requestedVariant !== "general" && requestedVariant !== "coding") {
  throw new Error("--variant must be general, coding, or both.");
}
if (requestedSuite !== "ab" && requestedSuite !== "primary" && requestedSuite !== "reliability") {
  throw new Error("--suite must be ab, primary, or reliability.");
}
if (requestedHybrid !== "on" && requestedHybrid !== "off" && requestedHybrid !== "both") {
  throw new Error("--hybrid must be off, on, or both.");
}
if (requestedHybrid === "both" && requestedSuite !== "ab") {
  throw new Error("--hybrid both is only supported with --suite ab.");
}
if (requestedCadence !== "off" && requestedCadence !== "on" && requestedCadence !== "both") {
  throw new Error("--cadence must be off, on, or both.");
}
if (requestedCadence === "both" && requestedSuite !== "ab") {
  throw new Error("--cadence both is only supported with --suite ab.");
}
const outputPath = OUTPUT_ARG < 0
  ? resolve("docs", requestedCadence === "both"
    ? "coding-execution-cadence-v0.1-ab-results.json"
    : requestedSuite === "ab"
      ? "coding-strategy-v0.1-ab-results.json"
    : requestedSuite === "primary"
      ? "autonomous-coding-execution-v0.1-primary.json"
      : "autonomous-coding-execution-v0.1-reliability.json")
  : resolve(process.argv[OUTPUT_ARG + 1] ?? "");
if (OUTPUT_ARG >= 0 && !process.argv[OUTPUT_ARG + 1]) throw new Error("--output requires a path.");

const desktopProfile = qwenDesktopProfile();
const environment = {
  ...process.env,
  NEXORA_MODEL_NAME: desktopProfile.model,
  NEXORA_MODEL_CONTEXT_WINDOW_TOKENS: String(desktopProfile.contextWindowTokens),
  NEXORA_MODEL_DECISION_OUTPUT_TOKENS: String(desktopProfile.decisionOutputTokens),
  NEXORA_MODEL_TOOL_TRANSPORT: desktopProfile.transport
};
const profile = openAICompatibleProviderFromEnv(environment).modelProfile!;

const report = requestedSuite === "ab"
  ? await runAbSuite()
  : requestedSuite === "primary"
    ? await runPrimarySuite()
    : await runReliabilitySuite();
mkdirSync(resolve(outputPath, ".."), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.validated === false) process.exitCode = 1;

async function runAbSuite() {
  if (requestedCadence === "both") {
    const off = await runVariant("cadence-off", "auto", GREENFIELD_SCENARIO, "on", "off");
    const on = await runVariant("cadence-on", "auto", GREENFIELD_SCENARIO, "on", "on");
    const offInputTokens = off.modelCallDiagnostics.reduce((sum, call) => sum + (call.actualInputTokens ?? call.measuredInputTokens ?? 0), 0);
    const onInputTokens = on.modelCallDiagnostics.reduce((sum, call) => sum + (call.actualInputTokens ?? call.measuredInputTokens ?? 0), 0);
    const offProviderMs = off.timingDiagnostics.reduce((sum, item) => sum + item.providerWaitGenerationMs, 0);
    const onProviderMs = on.timingDiagnostics.reduce((sum, item) => sum + item.providerWaitGenerationMs, 0);
    const sameCompletion = off.status === "succeeded"
      && on.status === "succeeded"
      && off.coreCompletionRate === 1
      && on.coreCompletionRate === 1;
    const onProtectedTools = on.toolNames.filter((name) => (
      name === "filesystem.write"
      || name === "filesystem.patch"
      || name === "shell.execute"
      || name.startsWith("process.")
    )).length;
    const safetyPreserved = !on.falseSuccess
      && on.failedTools === 0
      && on.approvalsDenied === 0
      && on.approvalsGranted === onProtectedTools;
    const efficiencySignals = {
      modelCalls: on.modelCalls < off.modelCalls,
      providerDecisionTime: onProviderMs < offProviderMs,
      inputTokens: onInputTokens <= offInputTokens,
      duration: on.durationMs < off.durationMs,
      effectiveToolsPerModelDecision: on.effectiveToolsPerModelDecision > off.effectiveToolsPerModelDecision
    };
    const improvedSignalCount = Object.values(efficiencySignals).filter(Boolean).length;
    const efficiencyImproved = efficiencySignals.modelCalls && improvedSignalCount >= 3;
    const realBoundedUnitGate = on.realBoundedUnitObserved && !off.realBoundedUnitObserved;
    const validated = sameCompletion
      && safetyPreserved
      && efficiencyImproved
      && realBoundedUnitGate;
    return {
      schemaVersion: 2,
      feature: "coding-execution-cadence-v0.1",
      createdAt: new Date().toISOString(),
      model: desktopProfile.name,
      providerModelId: profile.model,
      provider: profile.provider,
      transport: environment.NEXORA_MODEL_TOOL_TRANSPORT ?? "configured-default",
      prompt: PROMPT,
      invariantInputs: {
        runtime: "Nexora Runtime through createAgent",
        tools: createBuiltInTools().map((tool) => tool.contract.identity.name),
        budgets: budgets(),
        workspace: "fresh empty temporary directory per variant",
        codingStrategy: "auto",
        hybridContext: "on",
        differingInput: "codingExecutionCadence only"
      },
      variants: { off, on },
      comparison: {
        modelCallDelta: on.modelCalls - off.modelCalls,
        providerDecisionTimeDeltaMs: onProviderMs - offProviderMs,
        inputTokenDelta: onInputTokens - offInputTokens,
        durationDeltaMs: on.durationMs - off.durationMs,
        effectiveToolsPerModelDecisionDelta: on.effectiveToolsPerModelDecision - off.effectiveToolsPerModelDecision,
        coreCompletionDelta: on.coreCompletionRate - off.coreCompletionRate,
        sameCompletion,
        safetyPreserved,
        efficiencySignals,
        improvedSignalCount,
        efficiencyImproved,
        realBoundedUnitGate
      },
      verdict: validated
        ? "CODING EXECUTION CADENCE V0.1: VALIDATED"
        : "CODING EXECUTION CADENCE V0.1: NOT VALIDATED",
      validated
    };
  }
  if (requestedHybrid === "both") {
    const off = await runVariant("hybrid-off", "auto", GREENFIELD_SCENARIO, "off");
    const on = await runVariant("hybrid-on", "auto", GREENFIELD_SCENARIO, "on");
    return {
      schemaVersion: 1,
      feature: "hybrid-decision-context-v0.1",
      createdAt: new Date().toISOString(),
      model: desktopProfile.name,
      providerModelId: profile.model,
      provider: profile.provider,
      transport: environment.NEXORA_MODEL_TOOL_TRANSPORT ?? "configured-default",
      prompt: PROMPT,
      invariantInputs: {
        runtime: "Nexora Runtime through createAgent",
        tools: createBuiltInTools().map((tool) => tool.contract.identity.name),
        budgets: budgets(),
        workspace: "fresh empty temporary directory per variant",
        codingStrategy: "auto",
        differingInput: "hybridContext only"
      },
      variants: { off, on },
      comparison: {
        durationDeltaMs: on.durationMs - off.durationMs,
        modelCallDelta: on.modelCalls - off.modelCalls,
        toolCallDelta: on.toolCalls - off.toolCalls,
        coreCompletionDelta: on.coreCompletionRate - off.coreCompletionRate
      },
      validated: false
    };
  }
  const hybrid = requestedHybrid as "on" | "off";
  const baseline = requestedVariant === "coding" ? null : await runVariant("general", "disabled", GREENFIELD_SCENARIO, hybrid);
  const coding = requestedVariant === "general" ? null : await runVariant("coding", "auto", GREENFIELD_SCENARIO, hybrid);
  const comparison = baseline === null || coding === null ? null : {
    durationDeltaMs: coding.durationMs - baseline.durationMs,
    modelCallDelta: coding.modelCalls - baseline.modelCalls,
    toolCallDelta: coding.toolCalls - baseline.toolCalls,
    scopeExpansionRateDelta: coding.scopeExpansionRate - baseline.scopeExpansionRate,
    verificationEfficiencyDelta: nullableDelta(coding.verificationEfficiency, baseline.verificationEfficiency),
    coreCompletionDelta: coding.coreCompletionRate - baseline.coreCompletionRate,
    codingValidated: isSuccessfulSample(coding)
  };
  return {
  schemaVersion: 1,
  feature: "coding-strategy-v0.1",
  createdAt: new Date().toISOString(),
  model: desktopProfile.name,
  providerModelId: profile.model,
  provider: profile.provider,
  transport: environment.NEXORA_MODEL_TOOL_TRANSPORT ?? "configured-default",
  prompt: PROMPT,
  invariantInputs: {
    runtime: "Nexora Runtime through createAgent",
    tools: createBuiltInTools().map((tool) => tool.contract.identity.name),
    budgets: budgets(),
    workspace: "fresh empty temporary directory per variant",
    differingInput: "codingStrategy only"
  },
  baselineReference: {
    status: "blocked",
    duration: "11m47s",
    filesEdited: 4,
    scopeExpansion: "large",
    noProgress: true,
    source: "docs/nexora-coding-strategy-v0.1-spec-updated.md"
  },
  variants: { general: baseline, coding },
    comparison,
    validated: comparison?.codingValidated ?? null
  };
}

async function runPrimarySuite() {
  const sample = await runVariant("primary", "auto", GREENFIELD_SCENARIO, requestedHybrid as "on" | "off");
  return reportEnvelope("primary", [sample], isSuccessfulSample(sample));
}

async function runReliabilitySuite() {
  const samples: Array<Awaited<ReturnType<typeof runVariant>>> = [];
  for (const scenario of RELIABILITY_SCENARIOS) {
    const batch = await Promise.all([1, 2, 3].map((repetition) => (
      runVariant(`${scenario.id}-${repetition}`, "auto", scenario, requestedHybrid as "on" | "off")
    )));
    samples.push(...batch);
  }
  return reportEnvelope("reliability", samples, samples.every(isSuccessfulSample));
}

function reportEnvelope(suite: "primary" | "reliability", samples: readonly Awaited<ReturnType<typeof runVariant>>[], validated: boolean) {
  return {
    schemaVersion: 2,
    feature: requestedFeature,
    suite,
    createdAt: new Date().toISOString(),
    model: desktopProfile.name,
    providerModelId: profile.model,
    provider: profile.provider,
    transport: environment.NEXORA_MODEL_TOOL_TRANSPORT ?? "configured-default",
    invariantInputs: {
      runtime: "Nexora Runtime through createAgent",
      tools: createBuiltInTools().map((tool) => tool.contract.identity.name),
      budgets: budgets(),
      codingStrategy: "auto"
    },
    samples,
    aggregate: aggregateSamples(samples),
    validated
  };
}

async function runVariant(
  label: string,
  codingStrategy: CodingStrategyMode,
  scenario: Scenario,
  hybridContext: "on" | "off" = "on",
  codingExecutionCadence: "on" | "off" = requestedCadence === "off" ? "off" : "on"
) {
  const workspace = mkdtempSync(join(tmpdir(), `nexora-coding-ab-${label}-`));
  scenario.seed(workspace);
  const provider = openAICompatibleProviderFromEnv(environment);
  const reasoningBytesByCall = new Map<string, number>();
  const runtime = createAgent({
    workspace,
    dataDir: join(workspace, ".nexora"),
    provider,
    tools: createBuiltInTools(),
    codingStrategy,
    hybridContext,
    codingExecutionCadence,
    publicOutputListener: (event: AgentPublicOutputEvent) => {
      if (event.type !== "text.delta" || event.channel !== "reasoning") return;
      reasoningBytesByCall.set(
        event.modelCallId,
        (reasoningBytesByCall.get(event.modelCallId) ?? 0) + Buffer.byteLength(event.text, "utf8")
      );
    },
    delegationPolicy: { mode: "forbidden", maxConcurrentWorkers: 2 },
    hostPolicy: {
      schemaVersion: 1,
      id: "coding-strategy-real-ab",
      version: "1",
      taskMode: "change",
      promptCache: "allow",
      instructions: [
        "Complete the requested workspace change with Runtime-owned Tools and evidence.",
        "Do not return implementation code instead of modifying the workspace.",
        "For this bounded canary, do not start a persistent server or run ad hoc scripts; use direct workspace Tools and bounded syntax/build/test commands only."
      ]
    }
  });
  const startedAt = performance.now();
  const startedWall = Date.now();
    const initialGrade = gradeWorkspace(workspace);
  let firstCoreOutcomeSatisfiedMs = initialGrade.syntaxExitCode === 0 && initialGrade.coreCompletionRate > 0 ? 0 : null;
  let allCoreOutcomesSatisfiedMs = initialGrade.syntaxExitCode === 0 && initialGrade.coreCompletionRate === 1 ? 0 : null;
  const observer: RuntimeObserver = (event) => {
    if (event.type !== "tool.succeeded") return;
    const grade = gradeWorkspace(workspace);
    const elapsed = Math.max(0, Date.parse(event.occurredAt) - startedWall);
    if (grade.syntaxExitCode === 0 && grade.coreCompletionRate > 0 && firstCoreOutcomeSatisfiedMs === null) {
      firstCoreOutcomeSatisfiedMs = elapsed;
    }
    if (grade.syntaxExitCode === 0 && grade.coreCompletionRate === 1 && allCoreOutcomesSatisfiedMs === null) {
      allCoreOutcomesSatisfiedMs = elapsed;
    }
  };
  let approvalsGranted = 0;
  let approvalsDenied = 0;
  let result: RunResult;
  let view: RunView;
  try {
    result = await runtime.start({ input: scenario.prompt, budgets: budgets() }, observer);
    for (let index = 0; index < 40 && result.status === "waiting"; index += 1) {
      view = await runtime.inspect(result.runId);
      const pending = view.snapshot.pendingRequest;
      if (pending?.kind !== "approval" || pending.action === undefined) break;
      const decision = approvalDecision(pending.action.toolName, pending.action.input);
      if (decision.approved) approvalsGranted += 1;
      else approvalsDenied += 1;
      result = await runtime.resume({
        runId: result.runId,
        approvalDecision: {
          requestId: pending.id,
          approved: decision.approved,
          ...(decision.approved ? {} : { reason: decision.reason })
        }
      }, observer);
    }
    view = await runtime.inspect(result.runId);
    const traces = await Promise.all(view.modelCalls.map((call) => runtime.openRun(result.runId).modelCallTrace(call.id)));
    const grade = gradeWorkspace(workspace);
    const planObjectives = initialPlanObjectives(view);
    const optionalOutcomes = detectOptionalOutcomes(`${planObjectives.join("\n")}\n${grade.source}`);
    const verifierCalls = view.toolInvocations.filter((invocation) => invocation.toolName === "shell.execute");
    const usefulVerifierCalls = usefulVerificationCount(verifierCalls);
    const duplicateStrategies = repeatedInvocationCount(view);
    const firstToolMs = millisecondsToFirstTool(view, startedAt, null);
    const firstEditMs = millisecondsToFirstTool(view, startedAt, new Set(["filesystem.write", "filesystem.patch"]));
    const firstVerificationMs = millisecondsToFirstTool(view, startedAt, new Set(["shell.execute"]));
    const noProgressCount = view.events.filter((event) => JSON.stringify(event).includes("NO_PROGRESS_DETECTED")).length;
    const blockedCount = view.events.filter((event) => event.type === "run.blocked").length;
    const routingTurns = view.events.filter((event) => event.type === "model.requested").map((event) => ({
      sequence: event.sequence,
      strategyProfile: stringValue(event.payload.strategyProfile),
      activationReason: stringValue(event.payload.activationReason),
      confidence: stringValue(event.payload.confidence),
      codingTaskShape: stringValue(event.payload.codingTaskShape)
    }));
    const planSetCount = view.events.filter((event) => event.type === "plan.set" && event.payload.noOp !== true).length;
    const completionAttempts = completionAttemptEvents(view);
    const terminalEvent = [...view.events].reverse().find((event) => ["run.succeeded", "run.failed", "run.blocked", "run.cancelled"].includes(event.type));
    const sameFileEdits = sameFileEditMetrics(view);
    const executionUnits = executionUnitMetrics(view);
    const responseRejections = view.events
      .filter((event) => event.type === "response.rejected")
      .map((event) => ({
        sequence: event.sequence,
        diagnostic: event.payload.diagnostic ?? null,
        detailsArtifact: typeof event.payload.detailsArtifact === "string"
          ? event.payload.detailsArtifact
          : null
      }));
    return {
      label,
      scenario: scenario.id,
      prompt: scenario.prompt,
      expectedTaskShape: scenario.expectedTaskShape,
      strategy: codingStrategy,
      hybridContext,
      codingExecutionCadence,
      ...executionUnits,
      strategyRouting: routingTurns[0] ?? null,
      strategyRoutingTurns: routingTurns,
      routingCorrect: routingTurns[0]?.strategyProfile === (codingStrategy === "auto" ? "coding" : "general")
        && (codingStrategy !== "auto" || routingTurns[0]?.codingTaskShape === scenario.expectedTaskShape),
      runId: result.runId,
      status: result.status,
      stopReason: result.stopReason,
      durationMs: Math.round(performance.now() - startedAt),
      modelCalls: view.modelCalls.length,
      modelCallDiagnostics: traces.map((trace) => ({
        sequence: trace.call.sequence,
        callId: trace.call.id,
        status: trace.call.status,
        errorCode: trace.call.errorCode,
        measuredInputTokens: trace.call.measuredInputTokens,
        actualInputTokens: trace.call.actualInputTokens,
        actualOutputTokens: trace.call.actualOutputTokens,
        reasoningTokens: {
          value: Math.ceil((reasoningBytesByCall.get(trace.call.id) ?? 0) / 4),
          measurementMethod: "estimated_utf8_bytes_over_4",
          publicReasoningBytes: reasoningBytesByCall.get(trace.call.id) ?? 0
        },
        attempts: trace.attempts.map((attempt) => ({
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          errorCode: attempt.errorCode,
          errorCategory: attempt.errorCategory,
          retryable: attempt.retryable,
          partialResponse: attempt.partialResponse
        }))
      })),
      timingDiagnostics: buildTimingDiagnostics(view, traces),
      responseRejections,
      toolCalls: view.toolInvocations.length,
      effectiveToolsPerModelDecision: view.modelCalls.length === 0
        ? 0
        : view.toolInvocations.filter((invocation) => invocation.status === "succeeded").length / view.modelCalls.length,
      failedTools: view.toolInvocations.filter((invocation) => invocation.status === "failed").length,
      effectiveToolRatio: view.toolInvocations.length === 0
        ? 0
        : Math.max(0, view.toolInvocations.length - view.toolInvocations.filter((invocation) => invocation.status === "failed").length - duplicateStrategies) / view.toolInvocations.length,
      toolNames: view.toolInvocations.map((invocation) => invocation.toolName),
      planOutcomes: planObjectives.length,
      planObjectives,
      taskScope: view.snapshot.taskContract?.scope ?? null,
      optionalOutcomes,
      scopeExpansionRate: scopeExpansionRate(CORE_REQUIREMENTS.length, optionalOutcomes.length),
      verificationCalls: verifierCalls.length,
      usefulVerificationCalls: usefulVerifierCalls,
      verificationEfficiency: verifierCalls.length === 0 ? null : usefulVerifierCalls / verifierCalls.length,
      repeatedStrategy: duplicateStrategies,
      repeatedStrategyCount: duplicateStrategies,
      planRevisionCount: Math.max(0, planSetCount - 1),
      sameFileEditCount: sameFileEdits.repeatedEditCount,
      fileEditCounts: sameFileEdits.byPath,
      noProgress: noProgressCount > 0,
      noProgressCount,
      blockedCount,
      noProgressRecoverySucceeded: noProgressCount > 0 && result.status === "succeeded",
      timeToFirstToolMs: firstToolMs,
      timeToFirstEditMs: firstEditMs,
      timeToFirstVerificationMs: firstVerificationMs,
      firstCoreOutcomeSatisfiedMs,
      allCoreOutcomesSatisfiedMs,
      completionAttempted: completionAttempts.length > 0,
      completionAttemptCount: completionAttempts.length,
      firstCompletionAttemptMs: completionAttempts[0]?.elapsedMs ?? null,
      terminalTimeMs: terminalEvent === undefined
        ? null
        : Math.max(0, Date.parse(terminalEvent.occurredAt) - Date.parse(view.snapshot.createdAt)),
      approvalsGranted,
      approvalsDenied,
      files: grade.files,
      coreRequirements: grade.coreRequirements,
      coreCompletionRate: grade.coreCompletionRate,
      syntaxExitCode: grade.syntaxExitCode,
      falseSuccess: result.status === "succeeded" && (grade.coreCompletionRate < 1 || grade.syntaxExitCode !== 0),
      lastError: view.snapshot.lastError === null ? null : {
        code: view.snapshot.lastError.code,
        message: view.snapshot.lastError.message,
        retryable: view.snapshot.lastError.retryable
      },
      summary: result.summary
    };
  } finally {
    await runtime.close();
    if (process.env.NEXORA_CODING_AB_KEEP !== "1") rmSync(workspace, { recursive: true, force: true });
    else process.stderr.write(`${label} workspace retained at ${workspace}\n`);
  }
}

function executionUnitMetrics(view: RunView) {
  const starts = view.events
    .filter((event) => event.type === "execution.unit.started")
    .map((event) => ({
      sequence: event.sequence,
      modelDecisionId: stringValue(event.payload.modelDecisionId),
      executionUnitId: stringValue(event.payload.executionUnitId),
      intendedToolCalls: typeof event.payload.intendedToolCalls === "number"
        ? event.payload.intendedToolCalls
        : 0
    }));
  const completions = view.events
    .filter((event) => event.type === "execution.unit.completed")
    .map((event) => {
      const linkedToolInvocations = Array.isArray(event.payload.linkedToolInvocations)
        ? [...new Set(event.payload.linkedToolInvocations.filter((id): id is string => typeof id === "string"))]
        : [];
      return {
        sequence: event.sequence,
        modelDecisionId: stringValue(event.payload.modelDecisionId),
        executionUnitId: stringValue(event.payload.executionUnitId),
        stopReason: stringValue(event.payload.stopReason),
        linkedToolInvocations
      };
    });
  const maxIntendedToolCalls = Math.max(0, ...starts.map((event) => event.intendedToolCalls));
  const maxLinkedToolInvocations = Math.max(0, ...completions.map((event) => event.linkedToolInvocations.length));
  return {
    executionUnitStarts: starts,
    executionUnitCompletions: completions,
    maxIntendedToolCalls,
    maxLinkedToolInvocations,
    realBoundedUnitObserved: maxIntendedToolCalls >= 2 && maxLinkedToolInvocations >= 2
  };
}

function budgets() {
  return {
    maxIterations: 32,
    maxModelCalls: 32,
    maxToolCalls: 24,
    maxRetries: 3,
    maxDurationMs: 12 * 60_000
  };
}

function approvalDecision(toolName: string, input: unknown): { approved: boolean; reason?: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { approved: false, reason: "A/B policy requires structured Tool input." };
  }
  const value = input as Record<string, unknown>;
  if (toolName === "filesystem.write" || toolName === "filesystem.patch") {
    const path = typeof value.path === "string" ? value.path.replaceAll("\\", "/") : "";
    const allowed = path.length > 0
      && !path.startsWith(".")
      && !path.startsWith("/")
      && !path.split("/").includes("..")
      && [".html", ".css", ".js", ".mjs", ".json", ".md"].includes(extname(path).toLowerCase());
    return allowed
      ? { approved: true }
      : { approved: false, reason: "A/B policy allows only ordinary web source files inside the temporary workspace." };
  }
  if (toolName === "shell.execute") {
    const command = String(value.command ?? "").toLowerCase();
    const args = Array.isArray(value.args) ? value.args.map(String) : [];
    const nodeCheck = (command === "node" || command === process.execPath.toLowerCase())
      && args.length === 2 && args[0] === "--check" && [".js", ".mjs"].includes(extname(args[1]!).toLowerCase());
    const packageCheck = /(?:^|[\\/])(?:npm|pnpm)(?:\.cmd)?$/iu.test(command)
      && (args[0] === "test" || (args[0] === "run" && ["test", "build", "typecheck"].includes(args[1] ?? "")));
    return nodeCheck || packageCheck
      ? { approved: true }
      : { approved: false, reason: "A/B policy permits only bounded syntax/build/test commands; persistent servers and ad hoc scripts are outside acceptance." };
  }
  return { approved: false, reason: `A/B policy does not authorize ${toolName}.` };
}

function gradeWorkspace(workspace: string) {
  const files = listFiles(workspace).filter((path) => !path.startsWith(".nexora/"));
  const source = files.filter((path) => [".html", ".css", ".js", ".mjs", ".json"].includes(extname(path).toLowerCase()))
    .map((path) => readText(resolve(workspace, path)))
    .join("\n");
  const lower = source.toLowerCase();
  const coreRequirements = {
    add: /(?:\badd\b|addentry|create|新增|添加)/iu.test(source) && /(?:push|unshift|concat|submit)/iu.test(source),
    edit: /(?:\bedit\b|update|编辑|修改)/iu.test(source),
    delete: /(?:\bdelete\b|deleteentry|remove|删除)/iu.test(source) && /(?:filter|splice|remove)/iu.test(source),
    search: /(?:\bsearch\b|搜索)/iu.test(source) && /(?:includes|indexof|match)/iu.test(lower),
    filter: /(?:category|类别|分类)/iu.test(source) && /\.filter\s*\(/u.test(source),
    persistence: /localstorage/u.test(lower) && /setitem/u.test(lower) && /getitem/u.test(lower)
  } satisfies Record<typeof CORE_REQUIREMENTS[number], boolean>;
  const completed = CORE_REQUIREMENTS.filter((name) => coreRequirements[name]).length;
  const script = files.find((path) => /(?:^|\/)app\.(?:js|mjs)$/iu.test(path))
    ?? files.find((path) => [".js", ".mjs"].includes(extname(path).toLowerCase()));
  const syntax = script === undefined
    ? { status: 1 }
    : spawnSync(process.execPath, ["--check", script], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
  return {
    files,
    source,
    coreRequirements,
    coreCompletionRate: completed / CORE_REQUIREMENTS.length,
    syntaxExitCode: syntax.status
  };
}

function seedExistingFeature(workspace: string): void {
  writeFileSync(resolve(workspace, "index.html"), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>个人探索日志</title></head>
<body><form id="entry-form"><input id="title"><button>添加</button></form><main id="entries"></main><script src="app.js"></script></body></html>
`, "utf8");
  writeFileSync(resolve(workspace, "app.js"), `"use strict";
const STORAGE_KEY = "exploration-log.entries.v1";
const entries = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
function saveEntries() { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); }
function addEntry(entry) { entries.push(entry); saveEntries(); }
document.querySelector("#entry-form").addEventListener("submit", (event) => {
  event.preventDefault();
  addEntry({ id: String(Date.now()), title: document.querySelector("#title").value, category: "其他", body: "" });
});
`, "utf8");
}

function seedBugFix(workspace: string): void {
  writeFileSync(resolve(workspace, "index.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>个人探索日志</title></head><body><script src="app.js"></script></body></html>\n`, "utf8");
  writeFileSync(resolve(workspace, "app.js"), `"use strict";
const STORAGE_KEY = "exploration-log.entries.v1";
let entries = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
function saveEntries() { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); }
function addEntry(entry) { entries.push(entry); saveEntries(); }
function editEntry(id, update) { entries = entries.map((entry) => entry.id === id ? { ...entry, ...update } : entry); saveEntries(); }
function deleteEntry(id) { entries = entries.filter((entry) => entry.id !== id); saveEntries(); }
function searchEntries(search) { return entries.filter((entry) => entry.title.includes(search) || entry.body.includes(search)); }
function filterByCategory(category) { return entries.filter((entry) => entry.category === category); }
const broken = ;
`, "utf8");
}

function completionAttemptEvents(view: RunView): Array<{ readonly sequence: number; readonly elapsedMs: number }> {
  return view.events.flatMap((event) => {
    if (event.type !== "model.turn" || !Array.isArray(event.payload.toolCalls)) return [];
    const attempted = event.payload.toolCalls.some((call) => (
      call !== null && typeof call === "object" && !Array.isArray(call)
      && "name" in call && (call as { readonly name?: unknown }).name === "nexora_respond"
    ));
    return attempted ? [{
      sequence: event.sequence,
      elapsedMs: Math.max(0, Date.parse(event.occurredAt) - Date.parse(view.snapshot.createdAt))
    }] : [];
  });
}

function sameFileEditMetrics(view: RunView): { readonly repeatedEditCount: number; readonly byPath: Readonly<Record<string, number>> } {
  const counts = new Map<string, number>();
  for (const invocation of view.toolInvocations) {
    if (invocation.toolName !== "filesystem.write" && invocation.toolName !== "filesystem.patch") continue;
    const path = invocation.inputJson !== null && typeof invocation.inputJson === "object" && !Array.isArray(invocation.inputJson)
      && typeof (invocation.inputJson as Record<string, unknown>).path === "string"
      ? (invocation.inputJson as Record<string, string>).path.replaceAll("\\", "/")
      : "<unknown>";
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return {
    repeatedEditCount: [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    byPath: Object.fromEntries(counts)
  };
}

function isSuccessfulSample(sample: Awaited<ReturnType<typeof runVariant>>): boolean {
  return sample.status === "succeeded"
    && sample.coreCompletionRate === 1
    && sample.syntaxExitCode === 0
    && !sample.falseSuccess
    && sample.routingCorrect
    && sample.completionAttempted
    && sample.optionalOutcomes.length < 5;
}

function aggregateSamples(samples: readonly Awaited<ReturnType<typeof runVariant>>[]) {
  return {
    sampleCount: samples.length,
    completionRate: samples.filter((sample) => sample.status === "succeeded").length / samples.length,
    validatedSampleRate: samples.filter(isSuccessfulSample).length / samples.length,
    falseSuccessCount: samples.filter((sample) => sample.falseSuccess).length,
    routingCorrectRate: samples.filter((sample) => sample.routingCorrect).length / samples.length,
    averageTimeToFirstToolMs: averageNullable(samples.map((sample) => sample.timeToFirstToolMs)),
    averagePlanRevisionCount: average(samples.map((sample) => sample.planRevisionCount)),
    averageRepeatedEditCount: average(samples.map((sample) => sample.sameFileEditCount)),
    averageEffectiveToolRatio: average(samples.map((sample) => sample.effectiveToolRatio)),
    averageScopeExpansionRate: average(samples.map((sample) => sample.scopeExpansionRate)),
    noProgressCount: samples.reduce((sum, sample) => sum + sample.noProgressCount, 0),
    noProgressRecoverySuccessCount: samples.filter((sample) => sample.noProgressRecoverySucceeded).length,
    blockedCount: samples.reduce((sum, sample) => sum + sample.blockedCount, 0)
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : average(present);
}

function initialPlanObjectives(view: RunView): string[] {
  for (const event of view.events) {
    if (event.type !== "model.turn" || !Array.isArray(event.payload.toolCalls)) continue;
    for (const call of event.payload.toolCalls) {
      if (call === null || typeof call !== "object" || !("name" in call) || !("arguments" in call)) continue;
      if ((call as { name?: unknown }).name !== "nexora_update_plan") continue;
      const args = (call as { arguments?: unknown }).arguments;
      if (args === null || typeof args !== "object" || Array.isArray(args)) continue;
      const tasks = (args as { tasks?: unknown }).tasks;
      if (!Array.isArray(tasks)) continue;
      return tasks.flatMap((task) => (
        task !== null && typeof task === "object" && !Array.isArray(task)
          && typeof (task as { objective?: unknown }).objective === "string"
          ? [(task as { objective: string }).objective]
          : []
      ));
    }
  }
  return view.snapshot.currentPlan?.orderedSteps.map((step) => step.objective) ?? [];
}

function detectOptionalOutcomes(text: string): string[] {
  return [...OPTIONAL_SCOPE_PATTERNS.entries()].flatMap(([name, pattern]) => pattern.test(text) ? [name] : []);
}

function repeatedInvocationCount(view: RunView): number {
  const counts = new Map<string, number>();
  for (const invocation of view.toolInvocations) {
    const key = `${invocation.toolName}:${invocation.inputDigest}:${invocation.status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

function millisecondsToFirstTool(view: RunView, startedAt: number, names: ReadonlySet<string> | null): number | null {
  const invocation = view.toolInvocations.find((item) => names === null || names.has(item.toolName));
  if (invocation === undefined) return null;
  const wallStart = Date.parse(view.snapshot.createdAt);
  const occurred = Date.parse(invocation.startedAt);
  return Number.isFinite(wallStart) && Number.isFinite(occurred)
    ? Math.max(0, occurred - wallStart)
    : Math.round(performance.now() - startedAt);
}

type TimingTrace = {
  readonly call: { readonly id: string; readonly sequence: number; readonly startedAt: string; readonly completedAt: string | null };
  readonly attempts: readonly { readonly startedAt: string; readonly completedAt: string | null }[];
};

function buildTimingDiagnostics(view: RunView, traces: readonly TimingTrace[]) {
  const events = [...view.events].sort((a, b) => a.sequence - b.sequence);
  const requested = events.filter((event) => event.type === "model.requested");
  const byCall = new Map(requested.map((event) => [String(event.payload.callId ?? ""), event]));
  const duration = (start: string | null | undefined, end: string | null | undefined): number | null => {
    if (typeof start !== "string" || typeof end !== "string") return null;
    const value = Date.parse(end) - Date.parse(start);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  return traces.map((trace, index) => {
    const request = byCall.get(trace.call.id);
    const nextRequest = traces[index + 1] === undefined ? null : byCall.get(traces[index + 1]!.call.id);
    const lower = request?.sequence ?? 0;
    const upper = nextRequest?.sequence ?? Number.MAX_SAFE_INTEGER;
    const between = events.filter((event) => event.sequence > lower && event.sequence < upper);
    const modelTurn = between.find((event) => event.type === "model.turn");
    const linkedToolStarts = between.filter((event) => event.type === "tool.started");
    const linkedTools = linkedToolStarts.map((start) => {
      const invocationId = String(start.payload.invocationId ?? "");
      const end = between.find((event) => (event.type === "tool.succeeded" || event.type === "tool.failed")
        && String(event.payload.invocationId ?? "") === invocationId);
      return {
        invocationId,
        toolName: String(start.payload.toolName ?? "unknown"),
        startedAt: start.occurredAt,
        endedAt: end?.occurredAt ?? null,
        durationMs: duration(start.occurredAt, end?.occurredAt)
      };
    });
    const approvalRequested = between.filter((event) => event.type === "approval.requested");
    const approvalResolved = between.filter((event) => event.type === "approval.granted" || event.type === "approval.denied");
    const requestDecisionStartedAt = typeof request?.payload.requestDecisionStartedAt === "string"
      ? request.payload.requestDecisionStartedAt : trace.call.startedAt;
    const promptCompiledAt = typeof request?.payload.promptCompiledAt === "string"
      ? request.payload.promptCompiledAt : trace.call.startedAt;
    const providerMs = trace.attempts.reduce((sum, attempt) => sum + (duration(attempt.startedAt, attempt.completedAt) ?? 0), 0);
    const toolEnd = linkedTools.at(-1)?.endedAt ?? trace.call.completedAt;
    const loopOverheadMs = nextRequest === undefined || nextRequest === null
      ? null
      : duration(toolEnd, nextRequest.payload.requestDecisionStartedAt as string | undefined);
    return {
      callId: trace.call.id,
      sequence: trace.call.sequence,
      controlState: request?.payload.controlState ?? null,
      strategyProfile: request?.payload.strategyProfile ?? null,
      planRevision: request?.payload.planRevision ?? null,
      requestDecisionStartedAt,
      promptContextBuildMs: duration(requestDecisionStartedAt, promptCompiledAt),
      providerWaitGenerationMs: providerMs,
      responseParseValidationMs: duration(trace.call.completedAt, modelTurn?.occurredAt),
      approvalWaitMs: approvalRequested.length === 0 ? 0 : approvalResolved.reduce((sum, event, i) => (
        sum + (duration(approvalRequested[i]?.occurredAt, event.occurredAt) ?? 0)
      ), 0),
      linkedTools,
      nextLoopOverheadMs: loopOverheadMs,
      modelDecisionMs: duration(trace.call.startedAt, trace.call.completedAt)
    };
  });
}

function listFiles(root: string): string[] {
  const result: string[] = [];
  const queue = [root];
  while (queue.length > 0 && result.length < 200) {
    const directory = queue.shift()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const relativePath = relative(root, path).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (relativePath !== ".nexora" && relativePath !== "node_modules") queue.push(path);
      } else if (entry.isFile()) result.push(relativePath);
    }
  }
  return result.sort((left, right) => left.localeCompare(right, "en"));
}

function readText(path: string): string {
  if (!existsSync(path)) return "";
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function nullableDelta(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left - right;
}

function qwenDesktopProfile(): {
  readonly name: string;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly decisionOutputTokens: number;
  readonly transport: "native_tools" | "structured_output";
} {
  const path = resolve(".nexora", "desktop-host.json");
  if (!existsSync(path)) throw new Error("Coding Strategy A/B requires the Desktop Host model profile at .nexora/desktop-host.json.");
  const host = JSON.parse(readFileSync(path, "utf8")) as { readonly modelProfiles?: readonly Record<string, unknown>[] };
  const selected = host.modelProfiles?.find((candidate) => (
    candidate.name === "Qwen 3.8 Flash"
    && typeof candidate.model === "string"
    && candidate.model !== "Qwen 3.8 Flash"
    && typeof candidate.contextWindowTokens === "number"
    && candidate.contextWindowTokens > 0
  ));
  if (selected === undefined) throw new Error("No valid Qwen 3.8 Flash Desktop Host profile with an explicit context window was found.");
  if (selected.transport !== "native_tools" && selected.transport !== "structured_output") {
    throw new Error("Qwen 3.8 Flash Desktop Host profile has an unsupported transport.");
  }
  if (typeof selected.decisionOutputTokens !== "number" || selected.decisionOutputTokens <= 0) {
    throw new Error("Qwen 3.8 Flash Desktop Host profile has no valid decision output budget.");
  }
  return {
    name: "Qwen 3.8 Flash",
    model: selected.model as string,
    contextWindowTokens: selected.contextWindowTokens as number,
    decisionOutputTokens: selected.decisionOutputTokens,
    transport: selected.transport
  };
}
