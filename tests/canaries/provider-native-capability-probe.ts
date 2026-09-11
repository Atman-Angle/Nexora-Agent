import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgent,
  createBuiltInTools,
  openAICompatibleProviderFromEnv
} from "../../packages/harness/src/index.js";
import { createDecisionEfficiencyReport } from "../../harness/nexora-bench/src/decision-efficiency.js";

type JsonRecord = Record<string, unknown>;

type WireRecord = {
  readonly index: number;
  readonly url: string;
  readonly request: JsonRecord;
  response?: JsonRecord;
};

type ScenarioResult = {
  readonly scenario: string;
  readonly passed: boolean;
  readonly attempts: number;
  readonly failures: readonly string[];
  readonly evidence: JsonRecord;
};

const originalFetch = globalThis.fetch.bind(globalThis);
let wireRecords: WireRecord[] = [];
let wireIndex = 0;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  const request = JSON.parse(String(init?.body ?? "{}")) as JsonRecord;
  const record: WireRecord = {
    index: wireIndex++,
    url: `${url.host}${url.pathname}`,
    request: summarizeRequest(request)
  };
  wireRecords.push(record);
  const response = await originalFetch(input, init);
  const cloned = response.clone();
  const bodyText = await cloned.text();
  try {
    record.response = summarizeResponse(JSON.parse(bodyText) as JsonRecord);
  } catch {
    record.response = { bodyText: bodyText.slice(0, 500) };
  }
  return response;
};

const provider = openAICompatibleProviderFromEnv(process.env);
const reportPath = process.argv[2] ?? "docs/evidence/pure-native-function-calling-real-provider-probe.json";
const roots: string[] = [];
const results: ScenarioResult[] = [];

try {
  results.push(await runScenario({
    scenario: "single-call",
    files: [{ path: "single.txt", content: "NEXORA_NATIVE_SINGLE_7F41" }],
    expectedToolCalls: 1,
    prompt: [
      "Call filesystem.read exactly once with path single.txt.",
      "Do not answer before the Tool result is available.",
      "After the read succeeds, return only the exact file content as the final answer."
    ].join(" ")
  }));

  results.push(await runScenario({
    scenario: "multi-call",
    files: [
      { path: "alpha.txt", content: "NEXORA_NATIVE_ALPHA_53C9" },
      { path: "beta.txt", content: "NEXORA_NATIVE_BETA_8D17" }
    ],
    expectedToolCalls: 2,
    prompt: [
      "In one parallel Function Calling response, call filesystem.read twice:",
      "once with path alpha.txt and once with path beta.txt.",
      "Do not answer before both Tool results are available.",
      "After both reads succeed, return both exact file contents in alpha then beta order."
    ].join(" ")
  }));
} finally {
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  provider: provider.modelProfile?.provider ?? "unknown",
  model: provider.modelProfile?.model ?? "unknown",
  wireMode: "openai-compatible-chat-completions-native-tools",
  scenarios: results
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (results.some((result) => !result.passed)) {
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(report, null, 2));
}

async function runScenario(input: {
  readonly scenario: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly expectedToolCalls: number;
  readonly prompt: string;
}): Promise<ScenarioResult> {
  const failures: string[] = [];
  let attempts = 0;
  let evidence: JsonRecord = {};

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    attempts = attempt;
    const outcome = await attemptScenario(input);
    evidence = outcome.evidence;
    if (outcome.failures.length === 0) {
      return { scenario: input.scenario, passed: true, attempts, failures: [], evidence };
    }
    failures.splice(0, failures.length, ...outcome.failures);
  }

  return { scenario: input.scenario, passed: false, attempts, failures, evidence };
}

async function attemptScenario(input: {
  readonly scenario: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly expectedToolCalls: number;
  readonly prompt: string;
}): Promise<{ readonly failures: readonly string[]; readonly evidence: JsonRecord }> {
  const workspace = mkdtempSync(join(tmpdir(), `nexora-native-probe-${input.scenario}-`));
  roots.push(workspace);
  for (const file of input.files) writeFileSync(join(workspace, file.path), file.content, "utf8");
  wireRecords = [];
  wireIndex = 0;

  const runtime = createAgent({
    workspace,
    provider,
    tools: createBuiltInTools()
  });
  try {
    const result = await runtime.start({
      input: input.prompt,
      completion: { evidence: "required", requiredToolNames: ["filesystem.read"] },
      budgets: {
        maxIterations: 12,
        maxModelCalls: 12,
        maxToolCalls: 6,
        maxRetries: 2,
        maxDurationMs: 300_000
      }
    });
    const inspection = await runtime.inspect(result.runId);
    const runtimeEvidence = inspection.snapshot.evidence ?? [];
    const handle = runtime.openRun(result.runId);
    const modelCallTraces = await Promise.all(inspection.modelCalls.map((call) => handle.modelCallTrace(call.id)));
    const decisionEfficiency = createDecisionEfficiencyReport(inspection, modelCallTraces, {
      completionAccepted: result.status === "succeeded"
    });
    const turns = inspection.events
      .filter((event) => event.type === "model.turn")
      .map((event) => event.payload as JsonRecord);
    const toolTurn = turns.find((turn) => Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0);
    const finalTurn = [...turns].reverse().find((turn) => (
      (!Array.isArray(turn.toolCalls) || turn.toolCalls.length === 0) && turn.hasText === true
    ));
    const toolCalls = (toolTurn?.toolCalls ?? []) as JsonRecord[];
    const invocations = inspection.toolInvocations.map((invocation) => ({
      id: invocation.id,
      toolName: invocation.toolName,
      status: invocation.status,
      inputJson: invocation.inputJson,
      resultJson: invocation.resultJson
    }));
    const providerCallIds = toolCalls.map((call) => String(call.callId));
    const invocationIds = invocations.map((invocation) => invocation.id);
    const wireToolIndex = wireRecords.findIndex((record) => {
      const responseCalls = (record.response?.toolCalls ?? []) as JsonRecord[];
      return responseCalls.length === input.expectedToolCalls;
    });
    const wireToolRecord = wireToolIndex >= 0 ? wireRecords[wireToolIndex] : undefined;
    const continuationRecord = wireToolIndex >= 0 ? wireRecords[wireToolIndex + 1] : undefined;
    const responseCalls = (wireToolRecord?.response?.toolCalls ?? []) as JsonRecord[];
    const continuationMessages = (continuationRecord?.request.messages ?? []) as JsonRecord[];
    const assistantContinuation = continuationMessages.find((message) => message.role === "assistant");
    const assistantCallIds = ((assistantContinuation?.toolCalls ?? []) as JsonRecord[]).map((call) => String(call.id));
    const toolMessages = continuationMessages.filter((message) => message.role === "tool");
    const toolResultById = new Map(toolMessages.map((message) => [String(message.toolCallId), message.content]));
    const expectedPaths = input.files.map((file) => file.path);
    const actualPaths = toolCalls.map((call) => String((call.arguments as JsonRecord).path));
    const localFailures: string[] = [];

    if (result.status !== "succeeded") {
      localFailures.push(`Runtime ended ${result.status}/${String(result.stopReason)}.`);
    }
    if (toolCalls.length !== input.expectedToolCalls) {
      localFailures.push(`Expected ${input.expectedToolCalls} native calls, received ${toolCalls.length}.`);
    }
    if (new Set(providerCallIds).size !== providerCallIds.length) {
      localFailures.push("Provider call IDs are not distinct.");
    }
    if (actualPaths.join("|") !== expectedPaths.join("|")) {
      localFailures.push(`Tool order/arguments mismatch: ${actualPaths.join("|")}.`);
    }
    if (invocations.length !== input.expectedToolCalls
      || invocations.some((invocation) => invocation.toolName !== "filesystem.read" || invocation.status !== "succeeded")) {
      localFailures.push("Runtime Invocations do not match the expected successful filesystem.read batch.");
    }
    for (const file of input.files) {
      const invocation = invocations.find((candidate) => (
        candidate.toolName === "filesystem.read"
        && (candidate.inputJson as JsonRecord).path === file.path
      ));
      if (invocation === undefined || !JSON.stringify(invocation.resultJson).includes(file.content)) {
        localFailures.push(`Missing verified content for ${file.path}.`);
      }
    }
    if (finalTurn === undefined || !input.files.every((file) => String(result.summary).includes(file.content))) {
      localFailures.push("Final text did not contain every verified file content.");
    }
    if (runtimeEvidence.length < input.expectedToolCalls) {
      localFailures.push("Completion Gate did not receive enough eligible Evidence.");
    }
    if (wireToolRecord?.request.hasResponseFormat === true) {
      localFailures.push("Provider request contained response_format.");
    }
    if (wireToolRecord?.request.toolChoice !== "auto" || wireToolRecord?.request.parallelToolCalls !== true) {
      localFailures.push("Provider request did not enable native tool choice/parallel calls.");
    }
    if (responseCalls.length !== input.expectedToolCalls || responseCalls.some((call) => call.content)) {
      localFailures.push("Provider response did not contain the expected null-text native calls.");
    }
    if (assistantCallIds.join("|") !== providerCallIds.join("|")) {
      localFailures.push("Continuation assistant tool_calls did not preserve Provider call IDs and order.");
    }
    if (toolMessages.length !== input.expectedToolCalls
      || providerCallIds.some((callId) => !toolResultById.has(callId))) {
      localFailures.push("Continuation tool results were not mapped one-to-one by call ID.");
    }
    for (const file of input.files) {
      const callIndex = expectedPaths.indexOf(file.path);
      const callId = providerCallIds[callIndex];
      const resultContent = callId === undefined ? null : toolResultById.get(callId);
      if (resultContent === undefined || !String(resultContent).includes(file.content)) {
        localFailures.push(`Continuation result for ${file.path} did not contain the Tool observation.`);
      }
    }
    if (providerCallIds.some((callId) => invocationIds.includes(callId))) {
      localFailures.push("Provider call ID leaked into Runtime Invocation identity.");
    }

    return {
      failures: localFailures,
      evidence: {
        runId: result.runId,
        status: result.status,
        stopReason: result.stopReason,
        summary: result.summary,
        completionGate: {
          status: inspection.snapshot.status,
          evidenceCount: runtimeEvidence.length,
          resultEvidenceIds: inspection.snapshot.result?.evidenceIds ?? []
        },
        modelTurns: turns.map((turn) => ({
          finishReason: turn.finishReason ?? null,
          hasText: turn.hasText === true,
          compiledActionTypes: turn.compiledActionTypes ?? [],
          toolCalls: (turn.toolCalls ?? []) as JsonRecord[]
        })),
        invocations,
        providerCallIds,
        invocationIds,
        decisionEfficiency: {
          logicalModelCalls: decisionEfficiency.logicalModelCalls,
          providerAttempts: decisionEfficiency.providerAttempts,
          budgetMeasuredInputTokens: decisionEfficiency.budgetMeasuredInputTokens,
          providerVisibleEstimatedInputTokens: decisionEfficiency.providerVisibleEstimatedInputTokens,
          actualProviderInputTokens: decisionEfficiency.actualProviderInputTokens,
          actualProviderOutputTokens: decisionEfficiency.actualProviderOutputTokens,
          actualProviderTotalTokens: decisionEfficiency.actualProviderTotalTokens,
          finalRequestBytes: decisionEfficiency.distributions.finalRequestBytes,
          effectiveActionCount: decisionEfficiency.effectiveActionCount,
          effectiveActions: decisionEfficiency.effectiveActions,
          responseToolCallCount: decisionEfficiency.responseToolCallCount,
          toolInvocationCount: decisionEfficiency.toolInvocationCount,
          duplicateSubstantivePayloadCount: decisionEfficiency.duplicateSubstantivePayloadCount,
          toolBatches: decisionEfficiency.toolBatches,
          efficiency: decisionEfficiency.efficiency,
          wasteCategories: decisionEfficiency.wasteCategories,
          wallClockMs: decisionEfficiency.wallClockMs,
          usageIncompleteAttempts: decisionEfficiency.usageIncompleteAttempts,
          wireTelemetryIncompleteAttempts: decisionEfficiency.wireTelemetryIncompleteAttempts
          ,
          sectionAttributionTotals: decisionEfficiency.sectionAttributionTotals
        },
        wire: wireRecords
      }
    };
  } finally {
    await runtime.close();
  }
}

function summarizeRequest(request: JsonRecord): JsonRecord {
  const messages = (request.messages ?? []) as JsonRecord[];
  return {
    toolNames: ((request.tools ?? []) as JsonRecord[]).map((tool) => (
      String((tool as { readonly function?: JsonRecord }).function?.name)
    )),
    toolChoice: request.tool_choice ?? null,
    parallelToolCalls: request.parallel_tool_calls ?? null,
    hasResponseFormat: Object.prototype.hasOwnProperty.call(request, "response_format"),
    messages: messages.map((message) => summarizeMessage(message))
  };
}

function summarizeResponse(response: JsonRecord): JsonRecord {
  const choices = (response.choices ?? []) as JsonRecord[];
  const choice = choices[0] ?? {};
  const message = (choice.message ?? {}) as JsonRecord;
  return {
    finishReason: choice.finish_reason ?? null,
    content: message.content ?? null,
    toolCalls: ((message.tool_calls ?? []) as JsonRecord[]).map((call) => {
      const functionValue = (call.function ?? {}) as JsonRecord;
      let argumentsValue: unknown = functionValue.arguments;
      try {
        argumentsValue = JSON.parse(String(functionValue.arguments)) as unknown;
      } catch {
        // Keep malformed arguments visible in the probe report.
      }
      return {
        id: call.id,
        type: call.type,
        name: functionValue.name,
        arguments: argumentsValue
      };
    }),
    usage: response.usage ?? null
  };
}

function summarizeMessage(message: JsonRecord): JsonRecord {
  const content = message.content;
  return {
    role: message.role,
    content: message.role === "system"
      ? `<system:${String(content ?? "").length} chars>`
      : boundedText(content),
    toolCallId: message.tool_call_id ?? null,
    toolCalls: ((message.tool_calls ?? []) as JsonRecord[]).map((call) => {
      const functionValue = (call.function ?? {}) as JsonRecord;
      return {
        id: call.id,
        type: call.type,
        name: functionValue.name,
        arguments: boundedText(functionValue.arguments)
      };
    })
  };
}

function boundedText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length <= 2_000 ? text : `${text.slice(0, 2_000)}...<${text.length} chars>`;
}
