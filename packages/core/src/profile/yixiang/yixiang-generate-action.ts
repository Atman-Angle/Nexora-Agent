import { AgentActionSchema } from "../../../../contracts/src/index.js";
import { ensureBudget } from "../../agent-loop/budget.js";
import type { HandlerDeps } from "../../agent-loop/outcome.js";
import type { AgentLoopState } from "../../agent-loop/state.js";
import type { GenerateActionOutcome } from "../types.js";
import { readYixiangState } from "./yixiang-profile-state.js";
import { buildAgentActionPrompt } from "../shared/action-prompt.js";
import { buildLoopContextSnapshot } from "../../agent-loop/context-snapshot.js";
import { buildContextEnvelope } from "../../../../context/src/index.js";
import { buildAgentActionSchemaText } from "../../../../model-gateway/src/model-tool-definition.js";

/**
 * buildYixiangPromptContext — a prompt-friendly subset of YixiangProfileState
 * passed to the model via the F031 opaque `profileContext` slot. Excludes
 * `artifactRefs` (opaque IDs) and `projectId` (not prompt-useful). The
 * model-gateway renders this as one JSON line; it never imports the type.
 */
export function buildYixiangPromptContext(state: AgentLoopState): unknown {
  const s = readYixiangState(state);
  return {
    currentStage: s.currentStage,
    productFacts: s.productFacts,
    confirmedFacts: s.confirmedFacts,
    targetPlatforms: s.targetPlatforms,
    generatedContents: s.generatedContents,
    complianceResult: s.complianceResult
  };
}

/**
 * generateYixiangAction — Yixiang's action-generation path. A minimal
 * counterpart to the coding profile's handleGenerateAction: budget check,
 * iteration.started, model call (no coding strategy/builder/prompt context —
 * those are F031), model.action.generated. Real Yixiang prompt construction
 * is F031; F030 uses a deterministic test provider that ignores context fields.
 */
export async function generateYixiangAction(
  state: AgentLoopState,
  deps: HandlerDeps
): Promise<GenerateActionOutcome> {
  await ensureBudget({
    appendEvent: deps.appendEvent,
    now: deps.input.now(),
    phase: "model",
    budget: deps.input.task.input.agentRequest!.budget,
    usage: state.usage,
    reserveVerification: false
  });

  const iterationStartedAt = deps.input.now();
  await deps.appendEvent("iteration.started", { index: state.latestIterationIndex }, iterationStartedAt);
  state.usage.loopCount += 1;
  state.usage.modelCalls += 1;
  const profileContext = buildYixiangPromptContext(state);
  const contextEnvelope = buildContextEnvelope({
    snapshot: buildLoopContextSnapshot({
      runId: state.activeRun.runId, anchor: deps.anchor, ledger: state.ledger,
      workingSet: state.currentWorkingSet, recentToolResult: state.recentToolResult,
      recentValidationResult: state.recentValidationResult, approvalStore: deps.input.approvalStore,
      userInputStore: deps.input.userInputStore, regroundedAt: state.regroundedAt, now: iterationStartedAt
    }),
    now: iterationStartedAt, profileContext, capabilitySchema: buildAgentActionSchemaText(deps.availableTools)
  });

  const action = AgentActionSchema.parse(
    await deps.input.modelProvider.nextAction({
      runId: state.activeRun.runId,
      goal: deps.anchor.goal,
      constraints: deps.anchor.constraints,
      successCriteria: deps.anchor.successCriteria,
      ledger: state.ledger,
      workingSet: state.currentWorkingSet,
      recentToolResult: state.recentToolResult,
      recentValidationResult: state.recentValidationResult,
      budget: deps.input.task.input.agentRequest!.budget,
      usage: state.usage,
      availableTools: deps.availableTools,
      regroundRequested: state.regroundRequested,
      replanRequested: state.replanRequested,
      contextEnvelope,
      profileContext,
      prompt: buildAgentActionPrompt({
        runId: state.activeRun.runId, goal: deps.anchor.goal, constraints: deps.anchor.constraints,
        successCriteria: deps.anchor.successCriteria, ledger: state.ledger, workingSet: state.currentWorkingSet,
        recentToolResult: state.recentToolResult, recentValidationResult: state.recentValidationResult,
        budget: deps.input.task.input.agentRequest!.budget, usage: state.usage, availableTools: deps.availableTools,
        regroundRequested: state.regroundRequested, replanRequested: state.replanRequested,
        profileContext, contextEnvelope
      })
    })
  );

  await deps.appendEvent(
    "model.action.generated",
    {
      type: action.type,
      ...(action.type === "tool_call" || action.type === "request_approval"
        ? { toolCallId: action.toolCall.toolCallId, toolName: action.toolCall.toolName }
        : {})
    },
    deps.input.now()
  );
  return { kind: "action", action };
}
