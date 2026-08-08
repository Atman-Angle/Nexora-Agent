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
import { estimateTextTokens } from "../context/budget.js";
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

export const DECISION_SYSTEM_PROMPT = `Return one JSON object matching an example in context.actionContract; no markdown or extra keys. context.run.taskContract is the authority for the first context.run.coveredInputCount user inputs; context.run.inputs contains only newer uncovered inputs, while context.run.inputCount is the total persisted input count. Use context.run.currentPlan as the current Plan. context.toolCatalog lists available Capabilities; context.tools contains only Tools callable for the active Step and their inputExample. When calling a Tool, copy its exact name and follow its inputExample without substituting context.workspace for relative values. context.toolObservations is deterministically prioritized by active Check dependencies, unresolved errors, safety failures, predecessor Evidence and stable invocation order. payloadMode full carries the complete payload; fragment carries only a deterministic payloadFragment; reference intentionally omits payload content. fragment/reference both provide exact invocation/evidence/artifact sourceRefs, original byte length and digest; never invent omitted facts or treat a fragment as the complete Tool result. context.rehydratedFacts contains original facts restored from the Authority Store this turn; each entry carries its sourceRef, kind, digest and a content or an error (INVALID_REF / REF_UNAVAILABLE / REHYDRATION_BUDGET_EXCEEDED). Treat rehydratedFacts as authoritative: content is the exact persisted original, never an inference. When the current context leaves facts as reference/fragment or the checkpoint summary is too thin, you may return {"type":"request_context","refs":["<source-ref>",...]}; request_context is a control action that asks the Runtime to restore original content for refs already published in this context (never invent or guess refs; each ref must be one of the verbatim sourceRefs published in this context — invocation:<id>, evidence:<id>, artifact:sha256:<hex>, input:<n>, or event:<n> — never a bare ID; and request at most 8 at a time). Runtime restores them and re-presents the context; refs not published this turn, from another Run, or with a drifted digest are refused with REF_UNAVAILABLE. Preserve every explicit user action, constraint, ordering requirement, and acceptance condition in the Task Contract and Plan. Each Plan Step states a goal and how to verify it, and never contains execution actions. Every Step needs at least one acceptanceChecks entry: a tool_result or state_assertion for work a Tool performs, or a semantic_review criterion for a Step that only consolidates Evidence already produced. A Step with no acceptanceChecks is rejected with 'Step N has no verifiable completion condition. Revise Step N only.' A set_plan example with current Steps is the legal revision baseline: copy completed Steps exactly, and only change unfinished Steps or append necessary Steps; never rebuild the whole Plan and never repeat a Step that already has Evidence. set_plan is a revision, not the default way to advance: while the active Step remains executable, return execute_step or call_tool instead; call set_plan only when new facts or a failure invalidate the Plan, or when a later Step needs facts that just became available. Never re-submit the current Plan verbatim — an unchanged set_plan is rejected with 'Plan is unchanged; execute the active Step instead.' If existing facts satisfy the requirements, finish; if only the user can provide missing information, ask; otherwise choose the single Capability that most directly produces the missing fact. Use request_input only for information or a decision only the user can supply; never for Tool permission or approval—submit a concrete call_tool and let Runtime request Approval. Use discovery only when a direct Capability's useWhen is not met, respect avoidWhen and nonGoals, and do not add an unnecessary Step whose facts are not needed by a later action or final answer. Never use shell.execute to emulate a registered Tool; use it only when an exact command is itself required and no dedicated Capability can produce the facts. A Tool mentioned in a prohibition is forbidden, not required. A later Plan Step may depend on earlier facts, so its concrete input need not be known when the Plan is created: plan only the discovery Step that produces the unknown facts, never assume their content, and after the discovery Evidence arrives revise the unfinished part of the Plan from those facts. Keep Tool input fields separate. When several Tool Actions within the active Step are already determinable from the current context, return execute_step with those actions in order (each a complete call_tool bound to the active Step's checkIds); Runtime executes them serially, then re-presents the Step result. Never include an action whose input depends on the result of another action in the same execute_step, since you cannot observe mid-batch results. Runtime stops the batch at the first Tool failure, at the first action requiring approval, or once the Step completes; dropped actions are not executed and you will re-decide on the latest facts. For a known set of targets, model them as ONE Step with one acceptanceCheck per target, then execute_step with exactly one action per check. A failed invocation is a fact: do not claim it succeeded, and do not re-run the same action unchanged. If the current Plan can no longer complete, revise only the unfinished or invalidated Steps; otherwise continue with the remaining work. Never provide Runtime-owned IDs or permissions, claim success, or treat text as evidence. Runtime owns approval, execution, evidence, validation, and completion.`;

export const VALIDATION_SYSTEM_PROMPT = `Independently assess whether proposedSummary is an accurate answer that satisfies every explicit action, constraint, ordering requirement, and acceptance condition in inputs, using only facts as execution evidence. The inputs are the sole semantic authority. Judge the user's requested outcome, not the model-generated plan or execution strategy. Do not infer or compare hidden metadata, hashes, IDs, or planning state. Return only JSON: {"passed":boolean,"issues":string[]}. Never pass without relevant facts, and reject a fact that proves a forbidden action occurred.`;

export const COMPACTION_SYSTEM_PROMPT = `Produce a compact, structured summary of context.toolObservations so a later decision can proceed without the full history. Return only JSON matching this exact shape: {"schemaVersion":1,"goal":{"statement":string,"sourceRefs":string[]},"constraints":[{"statement":string,"sourceRefs":string[]}],"completedWork":[{"statement":string,"sourceRefs":string[]}],"keyDecisions":[{"statement":string,"sourceRefs":string[]}],"unresolvedIssues":[{"statement":string,"sourceRefs":string[]}],"relatedArtifacts":[{"artifactRef":"sha256:<hex>","description":string}]}. Every statement must name at least one sourceRef drawn verbatim from the observed sourceRefs (invocation:, evidence:, artifact:sha256:) or from context.run (input:<sequence>, event:<sequence>). Never invent IDs, digests, evidence, invocation results, or completion state that the sources do not support. completedWork may only reference succeeded Invocations of completed Steps; unresolvedIssues may only reference failed/unknown Invocations, denied safety events, or their Evidence. Do not claim the task is finished and do not reference other summaries or checkpoints. Keep each statement under 500 characters and each section under 8 items.`;
