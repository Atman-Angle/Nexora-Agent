import { z } from "zod";

import type {
  CompactionContext,
  ModelDecisionContext,
  RuntimeProvider,
  RuntimeTool
} from "../../packages/runtime/src/index.js";
import type { CompactionSummary } from "../../packages/runtime/src/providers/model-client.js";

export const CONTEXT_CONTINUITY_DATASET_V1 = Object.freeze({
  schemaVersion: 1,
  scenarioId: "multi-cycle-context-continuity-v1",
  checkCount: 41,
  exercisedParentChecks: 40,
  failureCount: 20,
  minimumDecisions: 100,
  minimumCompactions: 5,
  reopenCount: 3,
  branchCount: 2,
  performance: { warmups: 2, samples: 20 }
});

export type ContinuityStep = ReturnType<typeof continuityStep>;

export function continuityStep() {
  return {
    id: "continuity-step",
    objective: "Preserve verified continuity facts across a long execution.",
    acceptanceChecks: Array.from(
      { length: CONTEXT_CONTINUITY_DATASET_V1.checkCount },
      (_, index) => ({
        id: checkId(index + 1),
        kind: "tool_result" as const,
        required: true,
        toolName: "test.continuity",
        expectedStatus: "success" as const
      })
    )
  };
}

export function setContinuityPlan(
  step: ContinuityStep,
  basedOnVersion: number | null,
  contractVersion: number
) {
  return {
    type: "set_plan" as const,
    basedOnVersion,
    taskContract: {
      goal: "Preserve long-running task continuity.",
      constraints: [`current-constraint-v${contractVersion}`],
      acceptanceCriteria: ["Every continuity check has verified Tool Evidence."]
    },
    orderedSteps: [step]
  };
}

export function callContinuityTool(step: ContinuityStep, check: number, attempt: number) {
  return {
    type: "call_tool" as const,
    stepId: step.id,
    checkIds: [checkId(check)],
    toolName: "test.continuity",
    input: { check, attempt }
  };
}

export function requestInput(label: string) {
  return {
    type: "request_input" as const,
    question: `Continue after ${label}.`,
    reason: `Restart boundary ${label}.`
  };
}

export function requestAnchorInput() {
  return { type: "request_context" as const, refs: ["input:1"] };
}

export function continuityTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "test.continuity" },
      capability: {
        purpose: "Produce deterministic large continuity facts.",
        nonGoals: ["Modify external state."]
      },
      decision: {
        useWhen: ["A continuity Check requires its deterministic fact."],
        avoidWhen: ["The Check already has successful Evidence."]
      },
      execution: {
        effect: { kind: "read", description: "Returns a deterministic success or failure." },
        idempotent: true,
        inputSchema: z.object({
          check: z.number().int().positive(),
          attempt: z.number().int().positive()
        }).strict(),
        inputExample: { check: 1, attempt: 1 }
      },
      evidence: {
        produces: ["A continuity fact bound to one Check."],
        factsSchema: z.object({
          check: z.number().int().positive(),
          value: z.string(),
          payload: z.string()
        }).strict()
      }
    },
    async execute(raw) {
      const { check, attempt } = raw as { check: number; attempt: number };
      if (check <= CONTEXT_CONTINUITY_DATASET_V1.failureCount && attempt === 1) {
        return {
          status: "failure",
          subjectRef: `continuity:${check}`,
          error: {
            code: `CONTINUITY_FAILURE_${check}`,
            message: `expected-failure-${check}:${"f".repeat(5_000)}`,
            retryable: true
          }
        };
      }
      return {
        status: "success",
        subjectRef: `continuity:${check}`,
        facts: {
          check,
          value: `verified-${check}`,
          payload: `payload-${check}:${"s".repeat(5_000)}`
        }
      };
    }
  };
}

export function rollingContinuitySummary(context: CompactionContext): CompactionSummary {
  const previous = context.previousCheckpoint?.summary;
  const currentRefs = context.toolObservations.map((observation) => {
    const evidenceRef = observation.sourceRefs.find((ref) => ref.startsWith("evidence:"));
    return evidenceRef ?? `invocation:${observation.invocationId}`;
  });
  const previousAnchor = previous?.keyDecisions.find(
    (item) => item.statement === "Verified check-01."
  )?.sourceRefs[0];
  const currentAnchorObservation = context.toolObservations.find((observation) => (
    observation.status === "succeeded" && observationCheckId(observation) === "check-01"
  ));
  const currentAnchor = currentAnchorObservation === undefined
    ? undefined
    : currentAnchorObservation.sourceRefs.find((ref) => ref.startsWith("evidence:"))
      ?? `invocation:${currentAnchorObservation.invocationId}`;
  const anchorRef = currentAnchor ?? previousAnchor;
  const pooledRefs = dedupeStrings([
    ...(previous?.keyDecisions.flatMap((item) => item.sourceRefs) ?? []),
    ...currentRefs
  ]).filter((ref) => ref !== anchorRef);
  const batchedRefs = chunks(pooledRefs, 8).slice(0, anchorRef === undefined ? 8 : 7);
  const inputVersion = context.run.taskContract?.inputVersion ?? 1;
  const constraint = context.run.taskContract?.constraints[0];

  return {
    schemaVersion: 1,
    goal: {
      statement: context.run.taskContract?.goal ?? "Preserve long-running task continuity.",
      sourceRefs: ["input:1"]
    },
    constraints: constraint === undefined
      ? []
      : [{ statement: constraint, sourceRefs: [`input:${inputVersion}`] }],
    completedWork: [],
    keyDecisions: [
      ...(anchorRef === undefined
        ? []
        : [{ statement: "Verified check-01.", sourceRefs: [anchorRef] }]),
      ...batchedRefs.map((sourceRefs, index) => ({
        statement: `Preserved continuity authority batch ${index + 1}.`,
        sourceRefs
      }))
    ],
    // This dataset retries every expected failure immediately. Omitting an
    // issue is safer than carrying a failure whose resolving Check may belong
    // to an earlier Plan version hidden from ProjectedRunContext. The Runtime
    // independently rejects any stale unresolved statement (covered by the
    // integrity test); a Summary is not required to enumerate every failure.
    unresolvedIssues: [],
    relatedArtifacts: dedupeArtifacts([
      ...(previous?.relatedArtifacts ?? []),
      ...context.toolObservations.flatMap((observation) => {
        const artifact = observation.sourceRefs.find((ref) => ref.startsWith("artifact:sha256:"));
        return artifact === undefined
          ? []
          : [{
              artifactRef: artifact.slice("artifact:".length),
              description: `Payload retained for ${observation.invocationId}.`
            }];
      })
    ]).slice(0, 8)
  };
}

export function repeatedCompactionProvider(base: RuntimeProvider): RuntimeProvider {
  const contextWindowTokens = 200;
  const reservedOutputTokens = { decision: 20, validation: 10, compaction: 20 };
  const softInputLimit = 90;
  return {
    modelProfile: {
      provider: "test-provider",
      model: "multi-cycle-context-model",
      contextWindowTokens,
      reservedOutputTokens,
      softLimitRatio: 0.5
    },
    measureTokens(phase, context) {
      if (phase === "compaction") {
        return { inputTokens: 5, method: "exact", meter: "test:e089-compaction" };
      }
      const observations = "toolObservations" in context
        ? (context as ModelDecisionContext).toolObservations
        : [];
      const criticalCount = observations.filter((item) => item.retention.critical).length;
      return {
        inputTokens: criticalCount >= 12 ? softInputLimit + 5 : 5,
        method: "exact",
        meter: "test:e089-decision"
      };
    },
    async decide(context, operation) { return await base.decide(context, operation); },
    async validate(context, operation) { return await base.validate(context, operation); },
    async compact(context, operation) { return await base.compact!(context, operation); }
  };
}

export function deterministicRuntimeSources() {
  let id = 0;
  let tick = 0;
  return {
    createId: () => `e089-id-${String(++id).padStart(6, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 11, 0, 0, 0, tick++)).toISOString()
  };
}

export function percentile(samples: readonly number[], quantile: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

function checkId(check: number): string {
  return `check-${String(check).padStart(2, "0")}`;
}

function observationCheckId(
  observation: CompactionContext["toolObservations"][number]
): string | null {
  if (
    observation.facts !== null
    && typeof observation.facts === "object"
    && !Array.isArray(observation.facts)
    && "check" in observation.facts
  ) {
    const check = observation.facts.check;
    if (typeof check === "number") return checkId(check);
  }
  if (
    observation.error !== null
    && typeof observation.error === "object"
    && !Array.isArray(observation.error)
    && "code" in observation.error
    && typeof observation.error.code === "string"
  ) {
    const value = /^CONTINUITY_FAILURE_([1-9][0-9]*)$/.exec(observation.error.code)?.[1];
    if (value !== undefined) return checkId(Number(value));
  }
  if (
    observation.payloadFragment !== null
    && typeof observation.payloadFragment === "object"
    && !Array.isArray(observation.payloadFragment)
  ) {
    const start = "start" in observation.payloadFragment
      ? observation.payloadFragment.start
      : undefined;
    if (typeof start === "string") {
      const success = /"check":([1-9][0-9]*)/.exec(start)?.[1];
      if (success !== undefined) return checkId(Number(success));
    }
    const code = "code" in observation.payloadFragment
      ? observation.payloadFragment.code
      : undefined;
    if (typeof code === "string") {
      const failure = /^CONTINUITY_FAILURE_([1-9][0-9]*)$/.exec(code)?.[1];
      if (failure !== undefined) return checkId(Number(failure));
    }
  }
  return null;
}

function dedupeArtifacts<T extends { readonly artifactRef: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.artifactRef)) return false;
    seen.add(item.artifactRef);
    return true;
  });
}

function dedupeStrings(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
