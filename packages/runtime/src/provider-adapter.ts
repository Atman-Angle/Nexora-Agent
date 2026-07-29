import {
  SemanticValidationVerdictSchema,
  type ModelDecisionContext,
  type RuntimeOperationContext,
  type RuntimeProvider,
  type SemanticValidationContext,
  type SemanticValidationVerdict
} from "./model-client.js";
import { RuntimeError } from "./runtime-error.js";

export type ProviderCompletionRequest = {
  readonly phase: "decision" | "validation";
  readonly system: string;
  readonly input: string;
  readonly responseFormat: "json";
};

export type ProviderCompletionOperation = {
  readonly signal: AbortSignal;
};

export type ProviderAdapterDefinition = {
  complete(
    request: ProviderCompletionRequest,
    operation: ProviderCompletionOperation
  ): Promise<string>;
  dispose?(): void | Promise<void>;
};

export function defineProviderAdapter(
  definition: ProviderAdapterDefinition
): RuntimeProvider {
  if (
    definition === null
    || typeof definition !== "object"
    || typeof definition.complete !== "function"
  ) {
    throw new RuntimeError({
      code: "INVALID_CONFIGURATION",
      message: "Provider Adapter must define complete()."
    });
  }

  async function complete(
    phase: ProviderCompletionRequest["phase"],
    context: ModelDecisionContext | SemanticValidationContext,
    operation: RuntimeOperationContext
  ): Promise<unknown> {
    operation.signal.throwIfAborted();
    const content = await definition.complete(Object.freeze({
      phase,
      system: phase === "decision"
        ? DECISION_SYSTEM_PROMPT
        : VALIDATION_SYSTEM_PROMPT,
      input: JSON.stringify({
        mode: phase === "decision" ? "decide" : "validate",
        context
      }),
      responseFormat: "json" as const
    }), { signal: operation.signal });
    operation.signal.throwIfAborted();
    return parseCompletion(content);
  }

  return Object.freeze({
    async decide(
      context: ModelDecisionContext,
      operation: RuntimeOperationContext
    ): Promise<unknown> {
      return await complete("decision", context, operation);
    },
    async validate(
      context: SemanticValidationContext,
      operation: RuntimeOperationContext
    ): Promise<SemanticValidationVerdict> {
      const parsed = await complete("validation", context, operation);
      const verdict = SemanticValidationVerdictSchema.safeParse(parsed);
      if (verdict.success) return verdict.data;
      return {
        passed: false,
        issues: ["PROVIDER_VALIDATION_RESPONSE_INVALID"]
      };
    },
    ...(definition.dispose === undefined
      ? {}
      : {
          async dispose(): Promise<void> {
            await definition.dispose!();
          }
        })
  });
}

function parseCompletion(content: unknown): unknown {
  if (typeof content !== "string") return content;
  const stripped = stripFence(content);
  try {
    return JSON.parse(stripped);
  } catch {
    return content;
  }
}

function stripFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

export const DECISION_SYSTEM_PROMPT = `Return one JSON object matching an example in context.actionContract; no markdown or extra keys. Replace placeholders from context.run, use context.workspace exactly, use context.toolObservations as authoritative Tool facts, and use an active Tool's execution.inputExample only as a field guide. Preserve every explicit user action, constraint, ordering requirement, and acceptance condition in the Task Contract and Plan. If existing facts satisfy the requirements, finish; if only the user can provide missing information, ask; otherwise choose the single Capability that most directly produces the missing fact. Use discovery only when a direct Capability's useWhen is not met, respect avoidWhen and nonGoals, and do not add an unnecessary Step whose facts are not needed by a later action or final answer. A Tool mentioned in a prohibition is forbidden, not required. A later Plan Step may depend on earlier facts, so its concrete input need not be known when the Plan is created. When calling a Tool, follow its inputExample and keep fields separate. Never provide Runtime-owned IDs or permissions, claim success, or treat text as evidence. Runtime owns approval, execution, evidence, validation, and completion.`;

export const VALIDATION_SYSTEM_PROMPT = `Independently assess whether proposedSummary is an accurate answer that satisfies every explicit action, constraint, ordering requirement, and acceptance condition in inputs, using only facts as execution evidence. The inputs are the sole semantic authority. Judge the user's requested outcome, not the model-generated plan or execution strategy. Do not infer or compare hidden metadata, hashes, IDs, or planning state. Return only JSON: {"passed":boolean,"issues":string[]}. Never pass without relevant facts, and reject a fact that proves a forbidden action occurred.`;
