import type {
  AgentAction,
  Artifact,
  UserInputRequest
} from "../../../../contracts/src/index.js";
import { createTextArtifact, ValidationResultSchema } from "../../../../contracts/src/index.js";
import { applyLedgerPatch } from "../../ledger-progress/index.js";
import { transitionRun } from "../../state-machine.js";
import { createPendingAction } from "../../recovery/resume-boundary.js";
import { serializeResumeState } from "../../agent-loop/state.js";
import type { AgentLoopState } from "../../agent-loop/state.js";
import type {
  AgentLoopWaitingForUserResult,
  HandlerDeps,
  HandlerOutcome
} from "../../agent-loop/outcome.js";
import type { DispatchContext } from "../types.js";

/**
 * handleYixiangAskUser — Yixiang's own ask_user handler. F030 cannot reuse
 * handleAskUser because HandleAskUserInput hardcodes coding-typed required
 * fields (strategyState/builderState/counters — see F030 spec §1.3). This
 * handler uses only generic runtime primitives to build the pending action +
 * checkpoint + waiting state, serializing the Yixiang profileState via the
 * F029 profile-aware serializeResumeState(state, profile).
 */
export async function handleYixiangAskUser(
  state: AgentLoopState,
  deps: HandlerDeps,
  action: AgentAction,
  _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  const askAction = action as Extract<AgentAction, { type: "ask_user" }>;
  const request: UserInputRequest = {
    requestId: deps.input.idGenerator(),
    runId: state.activeRun.runId,
    question: askAction.question,
    expectedInputType: askAction.expectedInputType,
    required: askAction.required,
    createdAt: deps.input.now(),
    status: "pending"
  };
  deps.input.userInputStore.insertRequest(request);

  const waitingLedger = applyLedgerPatch({
    ledger: state.ledger,
    patch: { appendOpenQuestions: [request.question] },
    now: deps.input.now()
  });
  deps.input.ledgerStore.upsertLedger(waitingLedger);

  const waitingAt = deps.input.now();
  const waitingRun = transitionRun(state.activeRun, "waiting_for_user", waitingAt);
  deps.input.runStore.updateRun(waitingRun);
  await deps.appendEvent("user_input.requested", { requestId: request.requestId }, waitingAt);
  await deps.appendEvent("run.waiting", { status: waitingRun.status, waitingFor: "user_input" }, waitingAt);

  const pendingAction = createPendingAction({
    pendingActionId: deps.input.idGenerator(),
    runId: state.activeRun.runId,
    actionId: request.requestId,
    waitingFor: "user_input",
    requestId: request.requestId,
    action,
    resumeState: serializeResumeState(
      {
        usage: state.usage,
        nextSequence: state.nextSequence + 2,
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
    now: deps.input.now()
  });
  deps.input.pendingActionStore.insertPendingAction(pendingAction);
  await deps.checkpoint("waiting_for_user", { pendingActionId: pendingAction.pendingActionId });

  const result: AgentLoopWaitingForUserResult = {
    kind: "waiting_for_user",
    run: waitingRun,
    ledger: waitingLedger,
    request
  };
  return { kind: "return", result };
}

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
