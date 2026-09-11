import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  compilePrompt,
  createOpenAICompatibleProvider,
  openAICompatibleProviderFromEnv,
  resolvePromptHostConfiguration,
  type ModelDecisionContext,
  type ProviderWireTelemetry,
  type RuntimeProvider
} from "../../packages/harness/src/index.js";

export type NativeContinuationAbResult = {
  readonly variant: "off" | "on";
  readonly finalRequestBytes: number | null;
  readonly actualInputTokens: number | null;
  readonly duplicateSubstantivePayloads: ProviderWireTelemetry["duplicateSubstantivePayloads"];
  readonly observationsBytes: number | null;
  readonly continuationBytes: number | null;
  readonly response: {
    readonly textPresent: boolean;
    readonly toolCallCount: number;
    readonly finishReason: string | null;
  };
};

export async function runNativeContinuationAb(
  provider: RuntimeProvider,
  outputRoot = join(process.cwd(), "agent-evaluation", "runs", "context-native-continuation-ab")
): Promise<readonly NativeContinuationAbResult[]> {
  const results: NativeContinuationAbResult[] = [];
  for (const variant of ["off", "on"] as const) {
    let telemetry: ProviderWireTelemetry | null = null;
    let actualInputTokens: number | null = null;
    const context = fixtureContext();
    const prompt = compilePrompt({
      context,
      host: resolvePromptHostConfiguration({}),
      transport: { kind: "native_tools", promptCache: { mode: "disabled" } },
      contextProjectionDedupe: variant
    });
    const response = await provider.decide(context, {
      signal: new AbortController().signal,
      compiledPrompt: prompt,
      reportWireTelemetry: (value) => { telemetry = value; },
      reportTokenUsage: (usage) => { actualInputTokens = usage.inputTokens; }
    });
    // The callback runs inside the Provider call; keep an explicit snapshot so
    // TypeScript does not treat the outer variable as permanently null.
    const wireTelemetry = telemetry as ProviderWireTelemetry | null;
    const observations = wireTelemetry?.businessSections.observations;
    results.push({
      variant,
      finalRequestBytes: wireTelemetry?.finalRequest.bytes ?? null,
      actualInputTokens,
      duplicateSubstantivePayloads: wireTelemetry?.duplicateSubstantivePayloads ?? [],
      observationsBytes: observations?.bytes ?? null,
      continuationBytes: wireTelemetry?.providerSections.continuation?.bytes ?? null,
      response: {
        textPresent: response.text !== null && response.text.trim().length > 0,
        toolCallCount: response.toolCalls.length,
        finishReason: response.finishReason
      }
    });
  }
  mkdirSync(outputRoot, { recursive: true });
  const artifact = join(outputRoot, `${new Date().toISOString().replaceAll(":", "-")}.json`);
  writeFileSync(artifact, `${JSON.stringify({ schemaVersion: 1, results }, null, 2)}\n`, "utf8");
  return results;
}

export function fixtureContext(): ModelDecisionContext {
  return {
    providerContractVersion: 6,
    workspace: "D:\\fixture",
    run: {
      inputCount: 1,
      coveredInputCount: 0,
      inputHistory: [{ sequence: 1, text: "Use the completed report result to answer exactly." }],
      taskContract: null,
      currentPlan: {
        version: 1,
        basedOnVersion: null,
        goalDigest: "sha256:plan-1",
        orderedSteps: [{ id: "inspect", objective: "Inspect the report.", acceptanceChecks: [] }]
      },
      stepProgress: [],
      evidence: [],
      lastError: null
    },
    projection: { schemaVersion: 1, digest: "sha256:projection-1" },
    activeInvocations: [],
    toolObservations: [{
      invocationId: "call-1",
      planVersion: 1,
      stepId: "inspect",
      toolName: "example.read",
      input: { path: "report.md" },
      status: "succeeded",
      completedAt: "2026-09-05T00:00:00.000Z",
      facts: { ref: "invocation:call-1", digest: "sha256:fact-1", content: "verified report: total=42" },
      error: null,
      payloadFragment: { ref: "invocation:call-1", digest: "sha256:fact-1", content: "verified report: total=42" },
      truncated: false,
      payloadMode: "full",
      originalBytes: 25,
      sourceRefs: ["invocation:call-1"],
      retention: {
        class: "current_resource",
        critical: false,
        reasons: ["current report"],
        stepOrder: 1,
        invocationSequence: 1
      },
      digest: "sha256:fact-1"
    }],
    nativeToolContinuation: {
      calls: [{
        callId: "call-1",
        name: "example.read",
        arguments: { path: "report.md" },
        result: {
          ok: true,
          status: "succeeded",
          observation: {
            invocationId: "call-1",
            toolName: "example.read",
            payloadMode: "full",
            facts: { ref: "invocation:call-1", digest: "sha256:fact-1", content: "verified report: total=42" },
            error: null,
            payloadFragment: null,
            truncated: false,
            originalBytes: 25,
            sourceRefs: ["invocation:call-1"],
            digest: "sha256:fact-1"
          }
        }
      }]
    },
    rehydratedFacts: [],
    historyCandidates: [],
    memoryCandidates: [],
    repair: null,
    tools: [{
      identity: { name: "example.read" },
      capability: { purpose: "Read a report.", nonGoals: [] },
      decision: { useWhen: ["The report is needed."], avoidWhen: ["The report is not needed."] },
      execution: {
        effect: { kind: "read", description: "Reads a report." },
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
      },
      evidence: { produces: ["The verified report content."] }
    }]
  } as ModelDecisionContext;
}

async function main(): Promise<void> {
  const provider = openAICompatibleProviderFromEnv(process.env);
  const results = await runNativeContinuationAb(provider);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, results }, null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]).endsWith("context-native-continuation-ab.ts")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
