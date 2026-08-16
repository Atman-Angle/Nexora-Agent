import { Buffer } from "node:buffer";

import { z } from "zod";

import type {
  ModelCallPhase,
  ModelDecisionContext,
  ProviderModelProfile,
  ProviderTokenMeasurement,
  ProviderTokenUsage,
  RuntimeProvider
} from "../providers/model-client.js";
import type { CompiledPrompt } from "../prompt.js";

const ProviderModelProfileSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  contextWindowTokens: z.number().int().positive(),
  reservedOutputTokens: z.object({
    decision: z.number().int().nonnegative()
  }).strict(),
  softLimitRatio: z.number().positive().max(1)
}).strict().superRefine((profile, context) => {
  for (const phase of ["decision"] as const) {
    if (profile.reservedOutputTokens[phase] >= profile.contextWindowTokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reservedOutputTokens", phase],
        message: "Reserved output tokens must be smaller than the context window."
      });
    }
  }
});

const ProviderTokenMeasurementSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  stablePrefixTokens: z.number().int().nonnegative().optional(),
  method: z.enum(["exact", "estimated"]),
  meter: z.string().trim().min(1)
}).strict();

const ProviderTokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cache: z.object({
    status: z.enum(["unsupported", "disabled", "miss", "partial_hit", "hit", "unknown"]),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    cacheWriteInputTokens: z.number().int().nonnegative().optional(),
    cacheEligibleInputTokens: z.number().int().nonnegative().optional()
  }).strict().optional()
}).strict().refine(
  (usage) => usage.totalTokens === usage.inputTokens + usage.outputTokens,
  { message: "Total token usage must equal input plus output tokens." }
);

const DEFAULT_MODEL_PROFILE: ProviderModelProfile = Object.freeze({
  provider: "custom",
  model: "unspecified",
  contextWindowTokens: 1_000_000_000,
  reservedOutputTokens: Object.freeze({
    decision: 1_024
  }),
  softLimitRatio: 0.8
});

export type ContextBudgetAssessment = {
  readonly profile: ProviderModelProfile;
  readonly measurement: ProviderTokenMeasurement;
  readonly reservedOutputTokens: number;
  readonly softInputLimitTokens: number;
  readonly hardInputLimitTokens: number;
  readonly decision: "within_budget" | "soft_limit_exceeded" | "hard_limit_exceeded";
};

export function resolveProviderModelProfile(provider: RuntimeProvider): ProviderModelProfile {
  return ProviderModelProfileSchema.parse(provider.modelProfile ?? DEFAULT_MODEL_PROFILE);
}

export async function assessContextBudget(
  provider: RuntimeProvider,
  phase: ModelCallPhase,
  context: ModelDecisionContext,
  compiledPrompt?: CompiledPrompt
): Promise<ContextBudgetAssessment> {
  const profile = resolveProviderModelProfile(provider);
  const parsedMeasurement = ProviderTokenMeasurementSchema.parse(
    provider.measureTokens === undefined
      ? estimateContextTokens(context)
      : await provider.measureTokens(phase, context, compiledPrompt)
  );
  const measurement: ProviderTokenMeasurement = {
    inputTokens: parsedMeasurement.inputTokens,
    method: parsedMeasurement.method,
    meter: parsedMeasurement.meter,
    ...(parsedMeasurement.stablePrefixTokens === undefined
      ? {}
      : { stablePrefixTokens: parsedMeasurement.stablePrefixTokens })
  };
  const reservedOutputTokens = profile.reservedOutputTokens[phase];
  const hardInputLimitTokens = profile.contextWindowTokens - reservedOutputTokens;
  const softInputLimitTokens = Math.floor(
    hardInputLimitTokens * profile.softLimitRatio
  );
  const decision = measurement.inputTokens > hardInputLimitTokens
    ? "hard_limit_exceeded" as const
    : measurement.inputTokens > softInputLimitTokens
      ? "soft_limit_exceeded" as const
      : "within_budget" as const;
  return Object.freeze({
    profile,
    measurement,
    reservedOutputTokens,
    softInputLimitTokens,
    hardInputLimitTokens,
    decision
  });
}

export function parseProviderTokenUsage(usage: ProviderTokenUsage): ProviderTokenUsage {
  const parsed = ProviderTokenUsageSchema.parse(usage);
  return {
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    totalTokens: parsed.totalTokens,
    ...(parsed.cache === undefined ? {} : {
      cache: {
        status: parsed.cache.status,
        ...(parsed.cache.cachedInputTokens === undefined ? {} : { cachedInputTokens: parsed.cache.cachedInputTokens }),
        ...(parsed.cache.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: parsed.cache.cacheWriteInputTokens }),
        ...(parsed.cache.cacheEligibleInputTokens === undefined ? {} : { cacheEligibleInputTokens: parsed.cache.cacheEligibleInputTokens })
      }
    })
  };
}

export function estimateTextTokens(text: string): ProviderTokenMeasurement {
  return {
    inputTokens: Math.ceil(Buffer.byteLength(text, "utf8") / 4),
    method: "estimated",
    meter: "nexora:utf8-bytes/4:v1"
  };
}

function estimateContextTokens(
  context: ModelDecisionContext
): ProviderTokenMeasurement {
  return estimateTextTokens(JSON.stringify(context));
}
