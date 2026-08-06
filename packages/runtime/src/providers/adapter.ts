import {
  SemanticValidationVerdictSchema,
  type CompactionContext,
  type ModelCallPhase,
  type ModelDecisionContext,
  type ProviderModelProfile,
  type ProviderTokenMeasurement,
  type ProviderTokenUsage,
  type RuntimeOperationContext,
  type RuntimeProvider,
  type SemanticValidationContext,
  type SemanticValidationVerdict
} from "./model-client.js";
import { estimateTextTokens } from "../context-budget.js";
import { RuntimeError } from "../runtime-error.js";

export type ProviderCompletionRequest = {
  readonly phase: "decision" | "validation" | "compaction";
  readonly system: string;
  readonly input: string;
  readonly responseFormat: "json";
};

export type ProviderCompletionOperation = {
  readonly signal: AbortSignal;
  readonly reportTokenUsage?: (usage: ProviderTokenUsage) => void;
};

export type ProviderRequestTokenMeter = (
  request: ProviderCompletionRequest
) => ProviderTokenMeasurement | Promise<ProviderTokenMeasurement>;

export type ProviderAdapterDefinition = {
  readonly modelProfile?: ProviderModelProfile;
  readonly projectRequest?: (
    request: ProviderCompletionRequest
  ) => ProviderCompletionRequest;
  readonly measureTokens?: ProviderRequestTokenMeter;
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
    context: ModelDecisionContext | SemanticValidationContext | CompactionContext,
    operation: RuntimeOperationContext
  ): Promise<unknown> {
    const signal = operation.signal;
    signal.throwIfAborted();
    const content = await definition.complete(
      buildRequest(phase, context),
      {
        signal,
        ...(operation.reportTokenUsage === undefined
          ? {}
          : { reportTokenUsage: operation.reportTokenUsage })
      }
    );
    signal.throwIfAborted();
    return parseCompletion(content);
  }

  return Object.freeze({
    ...(definition.modelProfile === undefined
      ? {}
      : { modelProfile: definition.modelProfile }),
    async measureTokens(
      phase: ModelCallPhase,
      context: ModelDecisionContext | SemanticValidationContext | CompactionContext
    ): Promise<ProviderTokenMeasurement> {
      const request = buildRequest(phase, context);
      return definition.measureTokens === undefined
        ? estimateTextTokens(`${request.system}\n${request.input}`)
        : await definition.measureTokens(request);
    },
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
    async compact(
      context: CompactionContext,
      operation: RuntimeOperationContext
    ): Promise<unknown> {
      return await complete("compaction", context, operation);
    },
    ...(definition.dispose === undefined
      ? {}
      : {
          async dispose(): Promise<void> {
            await definition.dispose!();
          }
        })
  });

  function buildRequest(
    phase: ProviderCompletionRequest["phase"],
    context: ModelDecisionContext | SemanticValidationContext | CompactionContext
  ): ProviderCompletionRequest {
    const request = Object.freeze({
      phase,
      system: phase === "decision"
        ? DECISION_SYSTEM_PROMPT
        : phase === "validation"
          ? VALIDATION_SYSTEM_PROMPT
          : COMPACTION_SYSTEM_PROMPT,
      input: JSON.stringify({
        mode: phase === "decision"
          ? "decide"
          : phase === "validation"
            ? "validate"
            : "compact",
        context
      }),
      responseFormat: "json" as const
    });
    return Object.freeze(definition.projectRequest?.(request) ?? request);
  }
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

export const DECISION_SYSTEM_PROMPT = `Return one JSON object matching an example in context.actionContract; no markdown or extra keys. context.run.taskContract is the authority for the first context.run.coveredInputCount user inputs; context.run.inputs contains only newer uncovered inputs, while context.run.inputCount is the total persisted input count. Use context.run.currentPlan as the current Plan. Set Task Contract inputVersion to context.run.inputCount. Set only taskContract.workspace to context.workspace exactly. context.toolCatalog lists available Capabilities; context.tools contains only Tools callable for the active Step and their inputExample. When calling a Tool, copy its exact name and follow its inputExample without substituting context.workspace for relative values. context.toolObservations is deterministically prioritized by active Check dependencies, unresolved errors, safety failures, predecessor Evidence and stable invocation order. payloadMode full carries the complete payload; fragment carries only a deterministic payloadFragment; reference intentionally omits payload content. fragment/reference both provide exact invocation/evidence/artifact sourceRefs, original byte length and digest; never invent omitted facts or treat a fragment as the complete Tool result. Preserve every explicit user action, constraint, ordering requirement, and acceptance condition in the Task Contract and Plan. A set_plan example with current Steps is the legal revision baseline: copy completed Steps exactly, and only change unfinished Steps or append necessary Steps. If existing facts satisfy the requirements, finish; if only the user can provide missing information, ask; otherwise choose the single Capability that most directly produces the missing fact. Use request_input only for information or a decision only the user can supply; never for Tool permission or approval—submit a concrete call_tool and let Runtime request Approval. Use discovery only when a direct Capability's useWhen is not met, respect avoidWhen and nonGoals, and do not add an unnecessary Step whose facts are not needed by a later action or final answer. Never use shell.execute to emulate a registered Tool; use it only when an exact command is itself required and no dedicated Capability can produce the facts. A Tool mentioned in a prohibition is forbidden, not required. A later Plan Step may depend on earlier facts, so its concrete input need not be known when the Plan is created. Keep Tool input fields separate. Never provide Runtime-owned IDs or permissions, claim success, or treat text as evidence. Runtime owns approval, execution, evidence, validation, and completion.`;

export const VALIDATION_SYSTEM_PROMPT = `Independently assess whether proposedSummary is an accurate answer that satisfies every explicit action, constraint, ordering requirement, and acceptance condition in inputs, using only facts as execution evidence. The inputs are the sole semantic authority. Judge the user's requested outcome, not the model-generated plan or execution strategy. Do not infer or compare hidden metadata, hashes, IDs, or planning state. Return only JSON: {"passed":boolean,"issues":string[]}. Never pass without relevant facts, and reject a fact that proves a forbidden action occurred.`;

export const COMPACTION_SYSTEM_PROMPT = `Produce a compact, structured summary of context.toolObservations so a later decision can proceed without the full history. Return only JSON matching this exact shape: {"schemaVersion":1,"goal":{"statement":string,"sourceRefs":string[]},"constraints":[{"statement":string,"sourceRefs":string[]}],"completedWork":[{"statement":string,"sourceRefs":string[]}],"keyDecisions":[{"statement":string,"sourceRefs":string[]}],"unresolvedIssues":[{"statement":string,"sourceRefs":string[]}],"relatedArtifacts":[{"artifactRef":"sha256:<hex>","description":string}]}. Every statement must name at least one sourceRef drawn verbatim from the observed sourceRefs (invocation:, evidence:, artifact:sha256:) or from context.run (input:<sequence>, event:<sequence>). Never invent IDs, digests, evidence, invocation results, or completion state that the sources do not support. completedWork may only reference succeeded Invocations of completed Steps; unresolvedIssues may only reference failed/unknown Invocations, denied safety events, or their Evidence. Do not claim the task is finished and do not reference other summaries or checkpoints. Keep each statement under 500 characters and each section under 8 items.`;
