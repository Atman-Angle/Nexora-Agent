import type { AgentAction, BuilderState, Event, Run, StrategyState, TaskAnchor } from "../../../contracts/src/index.js";
import type { HandlerDeps, HandlerOutcome } from "../agent-loop/outcome.js";
import type { AgentLoopState } from "../agent-loop/state.js";
import type { GenerateActionOutcome } from "../agent-loop/handlers/generate-action.js";
import type { NoProgressSnapshot } from "../recovery/resume-boundary.js";

/**
 * DispatchContext bundles all runtime values that any action handler might
 * need beyond (state, deps, action). Handlers that don't need these fields
 * simply ignore them. This avoids per-handler special-casing in the dispatch
 * table while keeping the uniform ActionHandler signature.
 */
export type DispatchContext = {
  bypassApproval: boolean;
  strategyBypassedForRecovery: boolean;
};

/**
 * ActionHandler is the uniform signature for all action-type handlers in the
 * dispatch table. Each handler receives the shared mutable state, the
 * immutable deps, the narrowed action, and the dispatch context.
 *
 * Handlers may mutate state directly (field assignment or Object.assign).
 * They return HandlerOutcome to signal continue/return/fail.
 */
export type ActionHandler = (
  state: AgentLoopState,
  deps: HandlerDeps,
  action: AgentAction,
  dispatchCtx: DispatchContext
) => Promise<HandlerOutcome>;

/**
 * EventDraft — an event that a policy wants emitted. The runner is responsible
 * for actually appending it via appendEvent, ensuring correct sequencing.
 */
export type EventDraft = {
  readonly type: Event["type"];
  readonly payload: Record<string, unknown>;
};

/**
 * LedgerPatch — a ledger mutation that a policy wants applied. The runner
 * calls applyLedgerPatch + persistLedger with this data.
 */
export type LedgerPatch = {
  readonly appendDecisions?: string[];
};

/**
 * ActionPolicyOutcome — the result of evaluating a single action policy.
 *
 * "accept": the action passes this policy. The runner applies any stateDelta
 *   and emits any events before proceeding to the next policy.
 *
 * "reject": the action fails this policy. The runner applies stateDelta,
 *   emits events, applies ledgerPatch, optionally checkpoints, and either
 *   continues the loop or calls failRun depending on whether failSignal
 *   is present.
 *
 * "shortCircuit": the policy handled the action completely (e.g., Path A
 *   submit_execution_plan delegation). The runner should stop evaluating
 *   further policies and follow the carried HandlerOutcome.
 */
export type ActionPolicyOutcome =
  | {
      readonly kind: "accept";
      /** Partial state fields to Object.assign onto AgentLoopState. */
      readonly stateDelta?: Partial<AgentLoopState>;
      /** Events to emit after applying stateDelta. */
      readonly events?: readonly EventDraft[];
    }
  | {
      readonly kind: "reject";
      /** Rejection category for model.action.rejected event. */
      readonly category: string;
      /** Rejection code for model.action.rejected event and potential failRun. */
      readonly code: string;
      /** Human-readable rejection message. */
      readonly message: string;
      /** Maximum correction attempts (MAX_ACTION_REPAIRS + 1). Used with current attempt to compute remainingCorrectionAttempts. */
      readonly maxAttempts: number;
      /** Current attempt number (already incremented). */
      readonly attempt: number;
      /** Rejection reason string for model.action.rejected event. */
      readonly reason: string;
      /** Partial state fields to Object.assign onto AgentLoopState. */
      readonly stateDelta?: Partial<AgentLoopState>;
      /** Events to emit BEFORE the standard model.action.rejected event (e.g., builder evaluation events). */
      readonly preRejectEvents?: readonly EventDraft[];
      /** Events to emit AFTER the standard model.action.rejected event. */
      readonly events?: readonly EventDraft[];
      /** Ledger patch to apply before checkpointing. */
      readonly ledgerPatch?: LedgerPatch;
      /** Whether to create a checkpoint after processing this rejection. */
      readonly checkpoint?: boolean;
      /** Checkpoint note (passed as options.note). */
      readonly checkpointNote?: string;
      /** If present, the runner calls failRun instead of continuing. */
      readonly failSignal?: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
      /** PreviousSnapshot to set on state (when not failing). */
      readonly previousSnapshot?: NoProgressSnapshot;
    }
  | {
      readonly kind: "shortCircuit";
      /** The HandlerOutcome from the delegated handler invocation. */
      readonly handlerOutcome: HandlerOutcome;
      /** State delta from builder evaluation (always applied before short-circuit). */
      readonly stateDelta?: Partial<AgentLoopState>;
      /** Events from builder evaluation (always emitted before short-circuit). */
      readonly events?: readonly EventDraft[];
    };

/**
 * ActionPolicyInput — everything a policy needs to evaluate an action.
 * This is a read-only snapshot; policies must NOT mutate anything directly.
 */
export type ActionPolicyInput = {
  readonly action: AgentAction;
  readonly actionSignature: string;
  readonly state: AgentLoopState;
  readonly deps: HandlerDeps;
  readonly strategyBypassedForRecovery: boolean;
  readonly usedSeededAction: boolean;
};

/**
 * ActionPolicy — a single pre-dispatch gate that evaluates whether an action
 * should proceed. Policies are evaluated in array order; first reject wins.
 *
 * Policies MUST be pure evaluators that return ActionPolicyOutcome describing
 * desired side effects. They MUST NOT call appendEvent, checkpoint,
 * persistLedger, or failRun directly.
 */
export type ActionPolicy = {
  /** Human-readable name for debugging/logging. */
  readonly name: string;

  /**
   * Evaluate the action against this policy. Returns an outcome describing
   * what side effects the runner should apply. Must be async because some
   * policies may need to read files or perform other I/O (e.g., builder
   * workspace facts).
   */
  readonly evaluate: (input: ActionPolicyInput) => Promise<ActionPolicyOutcome>;
};

/**
 * AgentProfile is the minimal seam for injecting variant action-generation
 * and action-dispatch behavior into runAgentLoop. F026 introduces only the
 * two fields that correspond to actual variation points in the current
 * runner; future Features add fields as their corresponding call sites
 * are migrated.
 *
 * F029 adds `state: ProfileStateHooks` — the sole authority over the opaque
 * `profileState` blob carried in AgentLoopState/Checkpoint/PendingActionResume.
 * The runtime treats `profileState` as opaque `unknown`; the profile owns the
 * content (init/serialize/restore/validate) and casts internally.
 */
export type ProfileStateInitInput = {
  readonly task: TaskAnchor;
  readonly run: Run;
  readonly now: string;
};

/**
 * Legacy top-level field VALUES carried by pre-F029 rows. Value-semantic names
 * (strategy/builder) — each call site maps from the correct surface's field
 * name (checkpoint uses `strategy`/`builder`; resume uses `strategyState`/
 * `builderState`). The runtime passes whichever values it finds.
 */
export type ProfileStateLegacyFields = {
  readonly strategy?: StrategyState | undefined;
  readonly builder?: BuilderState | undefined;
  readonly finalizationPlanRejectionCount?: number | undefined;
  readonly validationRepairActionRejectionCount?: number | undefined;
};

export type ProfileStateRestoreInput = {
  /** New-shape opaque profile state (F029+ data). undefined for pre-F029 data. */
  readonly profileState: unknown;
  /** Legacy top-level field VALUES (pre-F029 data). undefined for F029+ data. */
  readonly legacy: ProfileStateLegacyFields;
  /** Persisted profileName/profileVersion from the checkpoint/resume row. */
  readonly profileName?: string | undefined;
  readonly profileVersion?: string | undefined;
  readonly run: Run;
  readonly now: string;
};

export type ProfileStateHooks = {
  /** Profile state schema version (string, compared for equality on restore). */
  readonly version: string;
  /** Initialize fresh profile state for a new (non-resume) run. Must be pure. */
  readonly initState: (input: ProfileStateInitInput) => unknown;
  /** Serialize profile state to an opaque JSON-compatible value. Must be pure. */
  readonly serializeState: (state: unknown) => unknown;
  /**
   * Restore profile state. Receives either profileState (F029+ data) or legacy
   * field values (pre-F029 data). Must be pure. Must throw
   * ProfileStateInvalidError when the data is unparseable or when
   * profileVersion does not match this profile's version (after any compat lift).
   */
  readonly restoreState: (input: ProfileStateRestoreInput) => unknown;
  /** Optional semantic validation of a restored state. Must be pure. */
  readonly validateState?: (state: unknown) => void;
};

export type AgentProfile = {
  /** Human-readable profile name for logging/events. */
  readonly name: string;

  /**
   * F029: sole authority over the opaque `profileState` blob. The runtime
   * holds the slot; these hooks own the content.
   */
  readonly state: ProfileStateHooks;

  /**
   * Generate the next action when no seeded action is available.
   * Wraps handleGenerateAction for the coding profile.
   */
  readonly generateAction: (
    state: AgentLoopState,
    deps: HandlerDeps
  ) => Promise<GenerateActionOutcome>;

  /**
   * Dispatch table mapping action.type → handler function.
   * Must include entries for all AgentAction discriminants:
   *   "tool_call", "request_approval", "ask_user", "update_plan",
   *   "submit_execution_plan", "final", "fail"
   *
   * The runner falls through to a default for unknown types,
   * preserving current behavior for unrecognized actions.
   */
  readonly actionHandlers: Readonly<Record<string, ActionHandler>>;

  /**
   * Pre-dispatch action policies evaluated in array order.
   * First reject wins (subsequent policies are skipped).
   * Accept outcomes accumulate state deltas and events.
   * Short-circuit outcomes halt policy evaluation.
   *
   * For profiles that don't need pre-dispatch gating, provide an empty array.
   */
  readonly actionPolicies: readonly ActionPolicy[];
};

// Re-export for convenience
export type { GenerateActionOutcome } from "../agent-loop/handlers/generate-action.js";
