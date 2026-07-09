import type {
  AgentAction,
  Artifact
} from "../../../../contracts/src/index.js";
import { createTextArtifact, ValidationResultSchema } from "../../../../contracts/src/index.js";
import { applyLedgerPatch } from "../../ledger-progress/index.js";
import { transitionRun } from "../../state-machine.js";
import { createPendingAction } from "../../recovery/resume-boundary.js";
import { serializeResumeState } from "../../agent-loop/state.js";
import type { AgentLoopState } from "../../agent-loop/state.js";
import { ensureBudget } from "../../agent-loop/budget.js";
import { createIteration } from "../../agent-loop/iteration.js";
import type {
  HandlerDeps,
  HandlerOutcome
} from "../../agent-loop/outcome.js";
import type { DispatchContext } from "../types.js";
import { readYixiangState, type ProductFactsInlineOutput } from "./yixiang-profile-state.js";

/**
 * adaptYixiangFinal — Yixiang's minimal final handler (lifecycle validation
 * only). Does NOT call runCompletionGate (coding-specific — F031 will open the
 * completion boundary). Creates a text artifact, transitions verifying→succeeded,
 * emits run.completed, returns a completed result with a minimal passing
 * validation. Real Yixiang completion integrity (fact-confirmation / compliance
 * gates) is F031.
 */
export async function adaptYixiangFinal(
  state: AgentLoopState,
  deps: HandlerDeps,
  action: AgentAction,
  _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  const finalAction = action as Extract<AgentAction, { type: "final" }>;
  const proposedAt = deps.input.now();
  const artifact: Artifact = createTextArtifact({
    artifactId: deps.input.idGenerator(),
    runId: state.activeRun.runId,
    content: finalAction.text,
    createdAt: proposedAt
  });
  deps.input.artifactStore.insertArtifact(artifact);
  await deps.appendEvent("artifact.created", { artifactId: artifact.artifactId }, artifact.createdAt);

  const verifyingRun = transitionRun(state.activeRun, "verifying", deps.input.now());
  deps.input.runStore.updateRun(verifyingRun);
  const succeededRun = transitionRun(verifyingRun, "succeeded", deps.input.now());
  deps.input.runStore.updateRun(succeededRun);
  await deps.appendEvent("run.completed", { status: succeededRun.status }, deps.input.now());

  return {
    kind: "return",
    result: {
      kind: "completed",
      run: succeededRun,
      artifact,
      validation: ValidationResultSchema.parse({ status: "passed", evidence: [] }),
      ledger: state.ledger
    }
  };
}

/**
 * adaptYixiangFail — mirrors the coding profile's adaptFail: returns a fail
 * HandlerOutcome that the runner passes to failRun.
 */
export async function adaptYixiangFail(
  _state: AgentLoopState,
  _deps: HandlerDeps,
  action: AgentAction,
  _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  const failAction = action as Extract<AgentAction, { type: "fail" }>;
  return {
    kind: "fail",
    code: failAction.code,
    message: failAction.message,
    retryable: failAction.retryable
  };
}

/**
 * handleYixiangToolCall — Yixiang's own tool_call handler. Mirrors the generic
 * skeleton of handleToolCall (budget, waiting_for_tool, pending action,
 * serializeResumeState, pre_tool/post_tool checkpoints, tool.started/completed,
 * toolRuntime.execute, iteration record, ledger patch) WITHOUT coding post-tool
 * logic (afterActionStrategy/applyBuilderToolEvidence/runCommandValidation).
 *
 * The ToolResult → profileState mapping is Yixiang-owned: on a successful
 * `product_facts_inline` result, the handler casts toolResult.output to its
 * typed shape (validated at execute time by def.resultSchema) and updates
 * YixiangProfileState (currentStage → "assets_analyzed", productFacts set).
 * The runtime never inspects profileState.
 */
export async function handleYixiangToolCall(
  state: AgentLoopState,
  deps: HandlerDeps,
  action: AgentAction,
  _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  const toolCallAction = action as Extract<AgentAction, { type: "tool_call" }>;
  const toolCall = toolCallAction.toolCall;

  await ensureBudget({
    appendEvent: deps.appendEvent,
    now: deps.input.now(),
    phase: "tool",
    budget: deps.input.task.input.agentRequest!.budget,
    usage: state.usage,
    reserveVerification: false
  });

  const waitingAt = deps.input.now();
  let activeRun = transitionRun(state.activeRun, "waiting_for_tool", waitingAt);
  deps.input.runStore.updateRun(activeRun);

  const pendingAction = createPendingAction({
    pendingActionId: deps.input.idGenerator(),
    runId: activeRun.runId,
    actionId: toolCall.toolCallId,
    waitingFor: "tool_execution",
    action,
    resumeState: serializeResumeState(
      {
        usage: state.usage,
        nextSequence: state.nextSequence + 1,
        currentWorkingSet: state.currentWorkingSet,
        changedFiles: state.changedFiles,
        recentToolResult: state.recentToolResult,
        recentValidationResult: state.recentValidationResult,
        latestIterationIndex: state.latestIterationIndex,
        regroundRequested: state.regroundRequested,
        replanRequested: state.replanRequested,
        noProgressCount: state.noProgressCount,
        previousSnapshot: state.previousSnapshot,
        pendingRetryIncrement: state.pendingRetryIncrement,
        recoveryState: state.recoveryState,
        profileState: state.profileState
      },
      deps.input.profile
    ),
    now: waitingAt
  });
  deps.input.pendingActionStore.insertPendingAction(pendingAction);
  await deps.checkpoint("pre_tool", { pendingActionId: pendingAction.pendingActionId });

  await deps.appendEvent("tool.started", { toolName: toolCall.toolName, risk: deps.input.toolRuntime.getRiskLevel(toolCall.toolName) }, waitingAt);

  const execution = await deps.input.toolRuntime.execute({
    runId: activeRun.runId,
    toolCall,
    workspaceRoot: deps.input.workspaceRoot,
    artifactRoot: deps.input.artifactRoot,
    now: deps.input.now,
    idGenerator: deps.input.idGenerator
  });
  state.usage.toolCalls += 1;

  deps.input.pendingActionStore.updatePendingAction({ ...pendingAction, status: "resolved", updatedAt: deps.input.now() });

  const toolResult = execution.toolResult;
  // NOTE: we deliberately do NOT set state.recentToolResult here.
  // PendingActionResumeStateSchema.recentToolResult is typed against the CLOSED
  // ToolResultSchema union (F028 deviation boundary), so a non-coding tool's
  // product_facts_inline result cannot be persisted there. Yixiang instead
  // persists the tool's effect as domain state inside profileState (below) —
  // which is the opaque, profile-owned blob the runtime never inspects.
  // (Recorded in F030b spec §1.3 / report as an F028-followup finding.)

  let ledger = state.ledger;
  let iterationStatus: "completed" | "failed" = toolResult.status === "success" ? "completed" : "failed";
  let summary = toolResult.status === "success" ? `Tool ${toolCall.toolName} succeeded.` : `Tool ${toolCall.toolName} failed.`;

  if (toolResult.status === "success") {
    const output = toolResult.output as { kind?: string } | undefined;
    if (output?.kind === "product_facts_inline") {
      const facts = (toolResult.output as unknown as ProductFactsInlineOutput).facts;
      const prev = readYixiangState(state);
      // Update profileState BEFORE post_tool checkpoint so the tool's domain
      // effect is captured (and survives a crash after post_tool). The runtime
      // never inspects profileState; this is Yixiang-owned handler logic.
      Object.assign(state, {
        profileState: {
          ...prev,
          productFacts: facts,
          currentStage: "assets_analyzed",
          artifactRefs: [...new Set([...prev.artifactRefs, execution.executionRecord.executionId])]
        }
      });
    }
    ledger = applyLedgerPatch({
      ledger,
      patch: {
        appendDecisions: [`Analyzed product assets via ${toolCall.toolName}.`],
        appendEvidenceRefs: [execution.executionRecord.executionId]
      },
      now: deps.input.now()
    });
  } else {
    ledger = applyLedgerPatch({
      ledger,
      patch: { appendDecisions: [`Tool ${toolCall.toolName} failed: ${toolResult.error.message}`] },
      now: deps.input.now()
    });
  }
  await deps.persistLedger(ledger);

  // post_tool checkpoint captures the updated profileState (the tool's effect).
  await deps.checkpoint("post_tool", { pendingActionId: pendingAction.pendingActionId });
  await deps.appendEvent("tool.completed", { toolName: toolCall.toolName }, deps.input.now());

  activeRun = transitionRun(activeRun, "running", deps.input.now());
  deps.input.runStore.updateRun(activeRun);

  const iteration = createIteration({
    iterationId: deps.input.idGenerator(),
    runId: activeRun.runId,
    index: state.latestIterationIndex,
    actionType: "tool_call",
    status: iterationStatus,
    usage: state.usage,
    summary,
    latestToolCallId: toolCall.toolCallId,
    latestExecutionRecordId: execution.executionRecord.executionId,
    evidenceRefs: toolResult.status === "success" ? [execution.executionRecord.executionId] : [],
    now: deps.input.now()
  });
  deps.input.agentIterationStore.insertIteration(iteration);
  await deps.appendEvent("iteration.completed", { index: iteration.index, actionType: iteration.actionType }, iteration.createdAt);
  state.latestIterationIndex += 1;

  return { kind: "continue" };
}
