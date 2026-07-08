import {
  AgentBudgetUsageSchema,
  type AgentAction,
  type AgentBudgetUsage,
  type PendingActionResumeState,
  type ProgressLedger,
  type RecoveryCheckpointState,
  type Run,
  type TaskAnchor,
  type ToolResult,
  type ValidationResult,
  type WorkingSet
} from "../../../contracts/src/index.js";
import type { ModelActionRejection } from "../../../model-gateway/src/index.js";
import type { NoProgressSnapshot } from "../recovery/resume-boundary.js";
import type { AgentProfile } from "../profile/types.js";
import { ProfileStateInvalidError } from "../profile/profile-state-error.js";

/**
 * AgentLoopState encapsulates all mutable per-run state that the agent loop
 * threads through its iterations. F025-B introduces this type so that adding
 * a new loop variable only requires extending the type plus the two
 * conversion functions below, instead of touching every resume-serialization
 * call site.
 *
 * F029 migrates the coding-profile domain fields (strategyState, builderState,
 * strategyDecision, and the two repair counters) INTO the opaque
 * `profileState` blob, owned by the profile's state hooks. The runtime treats
 * `profileState` as opaque `unknown` — it never reads/writes fields inside it.
 *
 * Transient fields (regroundedAt, seededAction, bypassApprovalForSeedAction,
 * pendingActionRejection) are not persisted to resume state; only the durable
 * subset in {@link ResumeSerializeInput} survives resume.
 */
export type AgentLoopState = {
  // Run state
  activeRun: Run;
  nextSequence: number;
  latestIterationIndex: number;

  // Context state
  currentWorkingSet: WorkingSet | null;
  changedFiles: string[];
  recentToolResult: ToolResult | null;
  recentValidationResult: ValidationResult | null;
  regroundedAt: string | null;

  // Progress state
  ledger: ProgressLedger;
  noProgressCount: number;
  previousSnapshot: NoProgressSnapshot;

  // Subsystem state
  recoveryState: RecoveryCheckpointState | undefined;

  // F029: opaque profile-owned state. The runtime holds the slot; the profile
  // owns the content via AgentProfile.state hooks (init/serialize/restore).
  profileState: unknown;

  // Control flags
  regroundRequested: boolean;
  replanRequested: boolean;
  pendingRetryIncrement: boolean;
  seededAction: AgentAction | null;
  bypassApprovalForSeedAction: boolean;

  pendingActionRejection: ModelActionRejection | null;

  // Usage tracking
  usage: AgentBudgetUsage;
};

/**
 * The durable subset of {@link AgentLoopState} that is serialized into a
 * PendingAction resume payload and restored on resume.
 */
export type ResumeSerializeInput = Pick<
  AgentLoopState,
  | "usage"
  | "nextSequence"
  | "currentWorkingSet"
  | "changedFiles"
  | "recentToolResult"
  | "recentValidationResult"
  | "latestIterationIndex"
  | "regroundRequested"
  | "replanRequested"
  | "noProgressCount"
  | "previousSnapshot"
  | "pendingRetryIncrement"
  | "recoveryState"
  | "profileState"
>;

export type AgentLoopInput = {
  task: {
    taskId: string;
    input: {
      text: string;
      agentRequest?: unknown;
    };
  };
  run: Run;
  now: () => string;
  eventStore: {
    listEventsByRun(runId: string): unknown[];
  };
  profile: AgentProfile;
  resume?:
    | {
        ledger: ProgressLedger;
        resumeState: PendingActionResumeState;
        seedAction?: AgentAction | undefined;
        bypassApprovalForSeedAction?: boolean | undefined;
      }
    | undefined;
};

/**
 * Initialize the full AgentLoopState from the loop input and (optionally) a
 * resume payload. This is the single entry point for state initialization —
 * adding a new durable field only requires extending this function plus
 * {@link serializeResumeState}.
 *
 * F029: profileState is initialized via `profile.state.initState` for fresh
 * runs and `profile.state.restoreState` for resume (after a profileName
 * mismatch check). validateState (if defined) runs immediately after. A
 * ProfileStateInvalidError thrown by any hook or the mismatch gate propagates
 * to the runner, which converts it to failRun(PROFILE_STATE_INVALID).
 */
export function createInitialLoopState(
  input: AgentLoopInput,
  anchor: TaskAnchor,
  ledger: ProgressLedger
): AgentLoopState {
  const resume = input.resume;
  const resumeState = resume?.resumeState;
  const now = input.now();

  let profileState: unknown;
  if (resumeState === undefined) {
    profileState = input.profile.state.initState({ task: anchor, run: input.run, now });
  } else {
    if (resumeState.profileName !== undefined && resumeState.profileName !== input.profile.name) {
      throw new ProfileStateInvalidError(
        `Run was started under profile ${resumeState.profileName} but resumed under ${input.profile.name}`
      );
    }
    profileState = input.profile.state.restoreState({
      profileState: resumeState.profileState,
      legacy: {
        strategy: resumeState.strategyState,
        builder: resumeState.builderState,
        finalizationPlanRejectionCount: resumeState.finalizationPlanRejectionCount,
        validationRepairActionRejectionCount: resumeState.validationRepairActionRejectionCount
      },
      profileName: resumeState.profileName,
      profileVersion: resumeState.profileVersion,
      run: input.run,
      now
    });
  }
  if (input.profile.state.validateState !== undefined) {
    input.profile.state.validateState(profileState);
  }

  return {
    activeRun: input.run,
    nextSequence:
      resumeState === undefined
        ? Math.max(1, input.eventStore.listEventsByRun(input.run.runId).length + 1)
        : Math.max(resumeState.nextSequence, input.eventStore.listEventsByRun(input.run.runId).length + 1),
    currentWorkingSet: resumeState?.currentWorkingSet ?? null,
    changedFiles: resumeState?.changedFiles ?? [],
    recentToolResult: resumeState?.recentToolResult ?? null,
    recentValidationResult: resumeState?.recentValidationResult ?? null,
    latestIterationIndex: resumeState?.latestIterationIndex ?? 0,
    regroundRequested: resumeState?.regroundRequested ?? false,
    replanRequested: resumeState?.replanRequested ?? false,
    noProgressCount: resumeState?.noProgressCount ?? 0,
    recoveryState: resumeState?.recoveryState,
    profileState,
    regroundedAt: null,
    ledger,
    previousSnapshot:
      resumeState?.previousSnapshot ?? {
        actionSignature: null,
        errorCode: null,
        ledgerVersion: ledger.version,
        evidenceCount: ledger.evidenceRefs.length,
        validationStatus: null,
        artifactHash: null
      },
    seededAction: resume?.seedAction ?? null,
    bypassApprovalForSeedAction: resume?.bypassApprovalForSeedAction ?? false,
    pendingRetryIncrement: resumeState?.pendingRetryIncrement ?? false,
    usage:
      resumeState?.usage ??
      AgentBudgetUsageSchema.parse({
        loopCount: 0,
        modelCalls: 0,
        toolCalls: 0,
        retryCount: 0,
        startedAt: now
      }),
    pendingActionRejection: null
  };
}

/**
 * Serialize the durable subset of AgentLoopState into a PendingAction resume
 * payload. This is the single entry point for resume serialization — adding a
 * new durable field only requires extending this function plus
 * {@link createInitialLoopState}.
 *
 * F029: profileState is serialized via `profile.state.serializeState`; the
 * persisted row carries profileName/profileVersion/profileState. The migrated
 * top-level coding fields are no longer written (legacy fields remain
 * schema-optional for read-compat with pre-F029 rows).
 */
export function serializeResumeState(
  state: ResumeSerializeInput,
  profile: AgentProfile
): PendingActionResumeState {
  return {
    usage: AgentBudgetUsageSchema.parse(state.usage),
    nextSequence: state.nextSequence,
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
    ...(state.recoveryState === undefined ? {} : { recoveryState: state.recoveryState }),
    profileName: profile.name,
    profileVersion: profile.state.version,
    profileState: profile.state.serializeState(state.profileState)
  };
}
