import type {
  AgentAction,
  AgentBudgetUsage,
  Checkpoint,
  CheckpointPhase,
  Event,
  PendingAction,
  ProgressLedger,
  RecoveryCheckpointState,
  Run,
  ToolResult,
  ValidationResult,
  WorkingSet
} from "../../../../contracts/src/index.js";
import type { LedgerStore } from "../../../../storage/src/ledger-store.js";
import type { PendingActionStore } from "../../../../storage/src/pending-action-store.js";
import type { RunStore } from "../../../../storage/src/run-store.js";
import type { UserInputStore } from "../../../../storage/src/user-input-store.js";
import type { AgentLoopWaitingForUserResult, HandlerOutcome } from "../outcome.js";
import type { NoProgressSnapshot } from "../../recovery/resume-boundary.js";
import type { AgentProfile } from "../../profile/types.js";
import { applyLedgerPatch } from "../../ledger-progress/index.js";
import { createPendingAction } from "../../recovery/resume-boundary.js";
import { serializeResumeState } from "../state.js";
import { transitionRun } from "../../state-machine.js";
import type { HandlerDeps } from "../outcome.js";
import type { AgentLoopState } from "../state.js";
import type { DispatchContext } from "../../profile/types.js";

/** Profile-neutral dispatch adapter shared by profiles that support ask_user. */
export async function adaptAskUser(
  state: AgentLoopState,
  deps: HandlerDeps,
  action: AgentAction,
  _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  return handleAskUser(
    {
      input: {
        now: deps.input.now, idGenerator: deps.input.idGenerator,
        userInputStore: deps.input.userInputStore, ledgerStore: deps.input.ledgerStore,
        runStore: deps.input.runStore, pendingActionStore: deps.input.pendingActionStore
      },
      run: state.activeRun, ledger: state.ledger, appendEvent: deps.appendEvent,
      checkpoint: deps.checkpoint, nextSequence: state.nextSequence,
      latestIterationIndex: state.latestIterationIndex, currentWorkingSet: state.currentWorkingSet,
      changedFiles: state.changedFiles, recentToolResult: state.recentToolResult,
      recentValidationResult: state.recentValidationResult, regroundRequested: state.regroundRequested,
      replanRequested: state.replanRequested, noProgressCount: state.noProgressCount,
      usage: state.usage, previousSnapshot: state.previousSnapshot,
      pendingRetryIncrement: state.pendingRetryIncrement, recoveryState: state.recoveryState,
      profileState: state.profileState, profile: deps.input.profile
    },
    action as Extract<AgentAction, { type: "ask_user" }>
  );
}

/**
 * Input bundle for handleAskUser. During F025-C convergence this collapses
 * into a single AgentLoopState reference; until then the dispatch loop
 * assembles it from its locals at the call site.
 *
 * Profile state is carried opaquely with the selected profile for resume
 * serialization. This generic handler never interprets domain state.
 */
export type HandleAskUserInput = {
  input: {
    now: () => string;
    idGenerator: () => string;
    userInputStore: UserInputStore;
    ledgerStore: LedgerStore;
    runStore: RunStore;
    pendingActionStore: PendingActionStore;
  };
  run: Run;
  ledger: ProgressLedger;
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => Promise<void>;
  checkpoint: (
    phase: CheckpointPhase,
    options?: {
      pendingActionId?: string;
      pendingActionFingerprint?: string;
      note?: string;
    }
  ) => Promise<Checkpoint>;
  nextSequence: number;
  latestIterationIndex: number;
  currentWorkingSet: WorkingSet | null;
  changedFiles: string[];
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  regroundRequested: boolean;
  replanRequested: boolean;
  noProgressCount: number;
  usage: AgentBudgetUsage;
  previousSnapshot: NoProgressSnapshot;
  pendingRetryIncrement: boolean;
  recoveryState?: RecoveryCheckpointState | undefined;
  profileState: unknown;
  profile: AgentProfile;
};

export async function handleAskUser(
  ctx: HandleAskUserInput,
  action: Extract<AgentAction, { type: "ask_user" }>
): Promise<HandlerOutcome> {
  const request = {
    requestId: ctx.input.idGenerator(),
    runId: ctx.run.runId,
    question: action.question,
    expectedInputType: action.expectedInputType,
    required: action.required,
    createdAt: ctx.input.now(),
    status: "pending" as const
  };
  ctx.input.userInputStore.insertRequest(request);

  const waitingLedger = applyLedgerPatch({
    ledger: ctx.ledger,
    patch: {
      appendOpenQuestions: [request.question]
    },
    now: ctx.input.now()
  });
  ctx.input.ledgerStore.upsertLedger(waitingLedger);

  const waitingAt = ctx.input.now();
  const waitingRun = transitionRun(ctx.run, "waiting_for_user", waitingAt);
  ctx.input.runStore.updateRun(waitingRun);
  await ctx.appendEvent("user_input.requested", { requestId: request.requestId }, waitingAt);
  await ctx.appendEvent("run.waiting", { status: waitingRun.status, waitingFor: "user_input" }, waitingAt);

  const pendingAction: PendingAction = createPendingAction({
    pendingActionId: ctx.input.idGenerator(),
    runId: ctx.run.runId,
    actionId: request.requestId,
    waitingFor: "user_input",
    requestId: request.requestId,
    action,
    resumeState: serializeResumeState({
      usage: ctx.usage,
      nextSequence: ctx.nextSequence + 2,
      currentWorkingSet: ctx.currentWorkingSet,
      changedFiles: ctx.changedFiles,
      recentToolResult: ctx.recentToolResult,
      recentValidationResult: ctx.recentValidationResult,
      latestIterationIndex: ctx.latestIterationIndex,
      regroundRequested: ctx.regroundRequested,
      replanRequested: ctx.replanRequested,
      noProgressCount: ctx.noProgressCount,
      previousSnapshot: ctx.previousSnapshot,
      pendingRetryIncrement: ctx.pendingRetryIncrement,
      recoveryState: ctx.recoveryState,
      profileState: ctx.profileState
    }, ctx.profile),
    now: ctx.input.now()
  });
  ctx.input.pendingActionStore.insertPendingAction(pendingAction);
  await ctx.checkpoint("waiting_for_user", {
    pendingActionId: pendingAction.pendingActionId
  });

  const result: AgentLoopWaitingForUserResult = {
    kind: "waiting_for_user",
    run: waitingRun,
    ledger: waitingLedger,
    request
  };
  return { kind: "return", result };
}
