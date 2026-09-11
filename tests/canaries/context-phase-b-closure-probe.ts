import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  compilePrompt,
  openAICompatibleProviderFromEnv,
  resolvePromptHostConfiguration,
  type ModelDecisionContext,
  type RuntimeProvider
} from "../../packages/harness/src/index.js";
import { fixtureContext } from "./context-native-continuation-ab.js";

type Scenario = "repair" | "recovery" | "completion" | "rehydration";

export async function runClosureProbe(provider: RuntimeProvider, repetitions = 2): Promise<readonly unknown[]> {
  const results: unknown[] = [];
  const scenarios: readonly Scenario[] = ["repair", "recovery", "completion", "rehydration"];
  const readTool = tool("example.read");
  for (const scenario of scenarios) {
    for (const variant of ["off", "on"] as const) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const base = fixtureContext();
        const context = scenarioContext(base, scenario, readTool);
        let telemetry: any = null;
        let usage: any = null;
        const prompt = compilePrompt({
          context,
          host: resolvePromptHostConfiguration({}),
          transport: provider.transport ?? { kind: "native_tools", promptCache: { mode: "automatic" } },
          contextProjectionDedupe: variant
        });
        const response = await provider.decide(context, {
          signal: new AbortController().signal,
          compiledPrompt: prompt,
          reportWireTelemetry: (value) => { telemetry = value; },
          reportTokenUsage: (value) => { usage = value; }
        });
        const calls = response.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments }));
        results.push({
          scenario,
          variant,
          repetition,
          finalRequestBytes: telemetry?.finalRequest.bytes ?? null,
          actualInputTokens: usage?.inputTokens ?? null,
          cachedInputTokens: usage?.cache?.cachedInputTokens ?? null,
          cacheStatus: usage?.cache?.status ?? null,
          duplicates: telemetry?.duplicateSubstantivePayloads ?? [],
          finishReason: response.finishReason,
          calls,
          text: response.text,
          validAction: calls.every((call) => context.tools.some((item) => item.identity.name === call.name) || call.name.startsWith("nexora_")),
          repeatedMutation: scenario === "recovery" && calls.some((call) => ["example.write", "filesystem.write", "filesystem.patch"].includes(call.name)),
          preservedCausalFact: scenario !== "rehydration" || JSON.stringify(response).includes("ORCHID") || JSON.stringify(response).includes("report.md")
        });
      }
    }
  }
  return results;
}

function scenarioContext(base: ModelDecisionContext, scenario: Scenario, readTool: ModelDecisionContext["tools"][number]): ModelDecisionContext {
  if (scenario === "repair") return {
    ...base,
    run: { ...base.run, inputHistory: [{ sequence: 1, text: "Repair the invalid action and inspect report.md; do not repeat the rejected empty path." }] },
    repair: {
      kind: "invalid_response",
      code: "INVALID_MODEL_RESPONSE",
      issues: [{ kind: "validation", code: "INVALID_TOOL_ARGUMENTS", message: "example.read.path must be non-empty." }],
      failedObjective: "Inspect the report.",
      latestIntent: { toolName: "example.read", arguments: { path: "" } },
      latestFailedAttempt: null,
      recovery: { sideEffect: "none", doNotRepeat: true, nextAction: "Call example.read once with path report.md." }
    }
  };
  if (scenario === "recovery") return {
    ...base,
    run: { ...base.run, inputHistory: [{ sequence: 1, text: "Recover from the failed write without repeating the unknown side effect; inspect report.md safely." }] },
    activeInvocations: [{ invocationId: "write-1", toolName: "example.write", status: "unknown", inputDigest: "sha256:write-input", planVersion: 1, stepId: "inspect", idempotent: false }],
    repair: {
      kind: "tool_failure",
      code: "TOOL_EXECUTION_FAILED",
      issues: [{ kind: "tool", code: "TOOL_EXECUTION_FAILED", message: "The protected write outcome is unknown." }],
      failedObjective: "Inspect the report.",
      latestIntent: { toolName: "example.write", arguments: { path: "report.md", content: "unsafe" } },
      latestFailedAttempt: { invocationRef: "invocation:write-1", toolName: "example.write", inputDigest: "sha256:write-input", status: "unknown", errorCode: "UNKNOWN_SIDE_EFFECT", planVersion: 1, stepId: "inspect", attemptCount: 1 },
      recovery: { sideEffect: "unknown", doNotRepeat: true, nextAction: "Do not repeat the write; perform a read-only reconciliation first." }
    },
    tools: [readTool]
  } as ModelDecisionContext;
  if (scenario === "completion") return {
    ...base,
    run: { ...base.run, inputHistory: [{ sequence: 1, text: "The report inspection is complete. Submit the formal completion response only." }], stepProgress: [{ stepId: "inspect", status: "completed", evidenceIds: ["evidence:report"] }] },
    completionProjection: { ready: true, blockers: [] },
    finalization: { deliveryOnly: true, reason: "All required evidence is complete." }
  } as ModelDecisionContext;
  return {
    ...base,
    run: { ...base.run, inputHistory: [{ sequence: 1, text: "Use the restored ORCHID memory fact and inspect report.md without guessing." }] },
    rehydratedFacts: [{ ref: "memory:continuity-stream-orchid", kind: "memory", origin: "harness_required", digest: "sha256:orchid", content: { stream: "ORCHID", requiredPath: "report.md" }, error: null, trust: "untrusted_memory_data" }]
  } as ModelDecisionContext;
}

function tool(name: string): ModelDecisionContext["tools"][number] {
  return {
    identity: { name },
    capability: { purpose: "Reads the report.", nonGoals: ["Does not write or execute."] },
    decision: { useWhen: ["The report is needed."], avoidWhen: ["The report is already verified."] },
    execution: { effect: { kind: "read", description: "Reads a report." }, inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    evidence: { produces: ["Verified report content."] }
  };
}

async function main(): Promise<void> {
  const provider = openAICompatibleProviderFromEnv(process.env);
  const repetitions = Number(process.env.NEXORA_CLOSURE_PROBE_REPETITIONS ?? "2");
  const results = await runClosureProbe(provider, repetitions);
  const outputRoot = join(process.cwd(), "agent-evaluation", "runs", "context-phase-b-closure-probe");
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, `${new Date().toISOString().replaceAll(":", "-")}.json`), `${JSON.stringify({ schemaVersion: 1, results }, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, results }, null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]).endsWith("context-phase-b-closure-probe.ts")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
