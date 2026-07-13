import {
  ContextEnvelopeSchema,
  ContextEnvelopeBudgetSchema,
  ContextEnvelopeManifestSchema,
  DEFAULT_CONTEXT_ENVELOPE_BUDGET,
  type ContextEnvelope,
  type ContextEnvelopeBudget,
  type ContextEnvelopePool,
  type ContextSegment,
  type ContextSnapshot
} from "../../contracts/src/index.js";

export class ContextEnvelopeBudgetError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ContextEnvelopeBudgetError";
  }
}

export type BuildContextEnvelopeInput = {
  snapshot: ContextSnapshot;
  now: string;
  profileContext?: unknown;
  /** Already-selected capability protocol text. The engine only budgets/adopts it. */
  capabilitySchema?: string;
  budget?: ContextEnvelopeBudget;
  /** Ephemeral, pre-selected profile sources. Never persisted by the engine. */
  additionalSegments?: Array<Omit<ContextSegment, "estimatedTokens">>;
};

/**
 * A deterministic shadow Context Engine. It projects existing authorities
 * into bounded model-input segments; it neither reads new sources nor writes
 * state. The legacy provider renderer deliberately does not consume it yet.
 */
export function buildContextEnvelope(input: BuildContextEnvelopeInput): ContextEnvelope {
  const budget = ContextEnvelopeBudgetSchema.parse(input.budget ?? DEFAULT_CONTEXT_ENVELOPE_BUDGET);
  const effectiveInputTokens =
    budget.contextWindowTokens - budget.reservedOutputTokens - budget.protocolReserveTokens - budget.safetyMarginTokens;
  if (effectiveInputTokens < 0) {
    throw new ContextEnvelopeBudgetError("Context envelope reserves exceed the declared context window.");
  }

  const snapshot = input.snapshot;
  const candidates: ContextSegment[] = [
    segment({
      id: "invariants",
      pool: "invariants",
      required: true,
      priority: 0,
      sourceVersion: snapshot.createdAt,
      content: JSON.stringify({ constraints: snapshot.anchor.constraints })
    }),
    segment({
      id: "request",
      pool: "request",
      required: true,
      priority: 1,
      sourceVersion: snapshot.createdAt,
      content: JSON.stringify({ goal: snapshot.anchor.goal, successCriteria: snapshot.anchor.successCriteria })
    }),
    segment({
      id: "execution",
      pool: "execution",
      required: true,
      priority: 2,
      sourceVersion: snapshot.createdAt,
      content: JSON.stringify({
        currentStep: snapshot.currentStep,
        completedSteps: snapshot.completedSteps,
        failedAttempts: snapshot.failedAttempts,
        evidenceRefs: snapshot.evidenceRefs,
        openQuestions: snapshot.openQuestions,
        openApprovals: snapshot.openApprovals,
        openUserInputs: snapshot.openUserInputs,
        recentValidationStatus: snapshot.recentValidationStatus
      }),
      artifactRefs: snapshot.artifactRefs
    }),
    segment({
      id: "workspace",
      pool: "workspace",
      required: false,
      priority: 10,
      sourceVersion: snapshot.regroundedAt ?? snapshot.createdAt,
      content: JSON.stringify({ workingSet: snapshot.workingSet, recentToolResult: snapshot.recentToolResult }),
      artifactRefs: snapshot.recentToolResult?.artifactRefs ?? []
    })
  ];
  if (input.profileContext !== undefined) {
    candidates.push(segment({
      id: "profile",
      pool: "profile",
      required: false,
      priority: 20,
      sourceVersion: snapshot.createdAt,
      content: JSON.stringify(input.profileContext)
    }));
  }
  if (input.capabilitySchema !== undefined) {
    candidates.push(segment({
      id: "capabilities",
      pool: "capabilities",
      required: false,
      priority: 3,
      sourceVersion: snapshot.createdAt,
      content: input.capabilitySchema
    }));
  }
  for (const additional of input.additionalSegments ?? []) {
    candidates.push(segment(additional));
  }

  const selected: ContextSegment[] = [];
  const drops: Array<{ id: string; pool: ContextEnvelopePool; reason: "budget" | "pool_cap"; estimatedTokens: number }> = [];
  let selectedTokens = 0;
  const usageByPool = new Map<ContextEnvelopePool, number>();
  for (const candidate of candidates.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))) {
    const poolCap = budget.poolTokenCaps[candidate.pool];
    const poolUsage = usageByPool.get(candidate.pool) ?? 0;
    if (poolCap !== undefined && poolUsage + candidate.estimatedTokens > poolCap && !candidate.required) {
      drops.push({ id: candidate.id, pool: candidate.pool, reason: "pool_cap", estimatedTokens: candidate.estimatedTokens });
      continue;
    }
    if (selectedTokens + candidate.estimatedTokens > effectiveInputTokens) {
      if (candidate.required) {
        throw new ContextEnvelopeBudgetError(`Required context segment ${candidate.id} exceeds the effective input budget.`);
      }
      drops.push({ id: candidate.id, pool: candidate.pool, reason: "budget", estimatedTokens: candidate.estimatedTokens });
      continue;
    }
    selected.push(candidate);
    selectedTokens += candidate.estimatedTokens;
    usageByPool.set(candidate.pool, poolUsage + candidate.estimatedTokens);
  }

  const manifest = ContextEnvelopeManifestSchema.parse({
    runId: snapshot.runId,
    budget,
    effectiveInputTokens,
    selectedTokens,
    selectedSegmentIds: selected.map((entry) => entry.id),
    drops,
    createdAt: input.now
  });
  return ContextEnvelopeSchema.parse({ runId: snapshot.runId, segments: selected, manifest, createdAt: input.now });
}

function segment(input: Omit<ContextSegment, "estimatedTokens" | "artifactRefs"> & { artifactRefs?: string[] }): ContextSegment {
  return {
    ...input,
    estimatedTokens: estimateTokens(input.content),
    artifactRefs: input.artifactRefs ?? []
  };
}

/** Conservative deterministic fallback until a provider supplies an exact tokenizer. */
export function estimateTokens(content: string): number {
  return Math.ceil([...content].length / 4);
}
