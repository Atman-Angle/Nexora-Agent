import { z } from "zod";

export const ContextEnvelopePoolSchema = z.enum([
  "invariants",
  "request",
  "execution",
  "workspace",
  "capabilities",
  "conversation",
  "memory",
  "profile"
]);

export const ContextEnvelopeBudgetSchema = z.object({
  contextWindowTokens: z.number().int().positive(),
  reservedOutputTokens: z.number().int().nonnegative(),
  protocolReserveTokens: z.number().int().nonnegative(),
  safetyMarginTokens: z.number().int().nonnegative(),
  poolTokenCaps: z.object({
    invariants: z.number().int().nonnegative().optional(),
    request: z.number().int().nonnegative().optional(),
    execution: z.number().int().nonnegative().optional(),
    workspace: z.number().int().nonnegative().optional(),
    capabilities: z.number().int().nonnegative().optional(),
    conversation: z.number().int().nonnegative().optional(),
    memory: z.number().int().nonnegative().optional(),
    profile: z.number().int().nonnegative().optional()
  })
});

export const ContextSegmentSchema = z.object({
  id: z.string().min(1),
  pool: ContextEnvelopePoolSchema,
  required: z.boolean(),
  priority: z.number().int().nonnegative(),
  sourceVersion: z.string().min(1),
  estimatedTokens: z.number().int().nonnegative(),
  content: z.string(),
  artifactRefs: z.array(z.string().min(1))
});

export const ContextDropSchema = z.object({
  id: z.string().min(1),
  pool: ContextEnvelopePoolSchema,
  reason: z.enum(["budget", "pool_cap"]),
  estimatedTokens: z.number().int().nonnegative()
});

export const ContextEnvelopeManifestSchema = z.object({
  runId: z.string().min(1),
  budget: ContextEnvelopeBudgetSchema,
  effectiveInputTokens: z.number().int().nonnegative(),
  selectedTokens: z.number().int().nonnegative(),
  selectedSegmentIds: z.array(z.string().min(1)),
  drops: z.array(ContextDropSchema),
  createdAt: z.string().datetime()
});

export const ContextEnvelopeSchema = z.object({
  runId: z.string().min(1),
  segments: z.array(ContextSegmentSchema),
  manifest: ContextEnvelopeManifestSchema,
  createdAt: z.string().datetime()
});

export type ContextEnvelopePool = z.infer<typeof ContextEnvelopePoolSchema>;
export type ContextEnvelopeBudget = z.infer<typeof ContextEnvelopeBudgetSchema>;
export type ContextSegment = z.infer<typeof ContextSegmentSchema>;
export type ContextDrop = z.infer<typeof ContextDropSchema>;
export type ContextEnvelopeManifest = z.infer<typeof ContextEnvelopeManifestSchema>;
export type ContextEnvelope = z.infer<typeof ContextEnvelopeSchema>;

/** Shadow default only. A future provider capability must replace it with the model's declared window. */
export const DEFAULT_CONTEXT_ENVELOPE_BUDGET: ContextEnvelopeBudget = {
  contextWindowTokens: 16_384,
  reservedOutputTokens: 2_048,
  protocolReserveTokens: 1_024,
  safetyMarginTokens: 512,
  poolTokenCaps: {
    workspace: 4_096,
    profile: 2_048,
    capabilities: 2_048,
    conversation: 4_096,
    memory: 1_024
  }
};
