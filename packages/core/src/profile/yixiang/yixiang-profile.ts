import type {
  AgentProfile,
  CompletionGate,
  ProfileStateHooks,
  ProfileStateInitInput,
  ProfileStateRestoreInput
} from "../types.js";
import type { AgentAction } from "../../../../contracts/src/index.js";
import { ProfileStateInvalidError } from "../profile-state-error.js";
import {
  parseYixiangProfileState,
  type YixiangProfileState
} from "./yixiang-profile-state.js";
import { generateYixiangAction } from "./yixiang-generate-action.js";
import { adaptYixiangFail, adaptYixiangFinal, handleYixiangToolCall } from "./yixiang-handlers.js";
import { registerYixiangTools } from "./yixiang-tools.js";
import { handleAskUser } from "../../agent-loop/handlers/ask-user.js";
import type { AgentLoopState } from "../../agent-loop/state.js";
import type { HandlerDeps, HandlerOutcome } from "../../agent-loop/outcome.js";
import type { DispatchContext } from "../types.js";
import { validateArtifactForRun } from "../../validation-gate.js";

function initYixiangProfileState(input: ProfileStateInitInput): YixiangProfileState {
  return {
    projectId: input.run.runId,
    currentStage: "init",
    productFacts: [],
    confirmedFacts: [],
    targetPlatforms: [],
    generatedContents: [],
    complianceResult: { status: "pending" },
    artifactRefs: []
  };
}

function restoreYixiangProfileState(input: ProfileStateRestoreInput): YixiangProfileState {
  if (input.profileVersion !== undefined && input.profileVersion !== "1") {
    throw new ProfileStateInvalidError(`yixiang profileState version ${input.profileVersion} not supported`);
  }
  if (input.profileState !== undefined) {
    try {
      return parseYixiangProfileState(input.profileState);
    } catch (error) {
      throw new ProfileStateInvalidError(
        `yixiang profileState could not be parsed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  // No legacy Yixiang bridge: Yixiang is new (F030), so there are no pre-F030
  // Yixiang rows with top-level fields to lift. Absent profileState is a hard
  // failure (unlike the coding profile, which lifts legacy strategy/builder).
  throw new ProfileStateInvalidError("yixiang profileState absent (no legacy bridge)");
}

function validateYixiangProfileState(s: unknown): void {
  const parsed = parseYixiangProfileState(s);
  // Semantic invariant not expressible in the Zod enum: a completed stage
  // requires compliance to be settled (passed or failed), never pending.
  // This gives validateState a check distinct from restoreState's parse.
  if (parsed.currentStage === "completed" && parsed.complianceResult.status === "pending") {
    throw new ProfileStateInvalidError(
      "yixiang profileState invalid: completed stage requires settled compliance (got pending)"
    );
  }
}

const yixiangStateHooks: ProfileStateHooks = {
  version: "1",
  initState: (input) => initYixiangProfileState(input),
  serializeState: (s) => s,
  restoreState: (input) => restoreYixiangProfileState(input),
  validateState: (s) => validateYixiangProfileState(s)
};

/**
 * yixiangCompletionGate — minimal Yixiang completion integrity. Validates
 * the final artifact exists, belongs to the run, and is non-empty plain
 * text (via the shared validateArtifactForRun). Real Yixiang completion
 * (fact-confirmation, compliance enforcement) is a future business Feature.
 */
const yixiangCompletionGate: CompletionGate = async (ctx) => {
  const validation = validateArtifactForRun(ctx.run, ctx.finalArtifact);
  return { validation };
};

/**
 * adaptYixiangAskUser — thin adapter that constructs HandleAskUserInput from
 * (state, deps) and delegates to the shared handleAskUser. This is possible
 * after F032 removed the dead coding-typed fields from HandleAskUserInput,
 * making it profile-agnostic (all fields are generic runtime types).
 */
async function adaptYixiangAskUser(
  state: AgentLoopState,
  deps: HandlerDeps,
  action: AgentAction,
  _dispatchCtx: DispatchContext
): Promise<HandlerOutcome> {
  return handleAskUser(
    {
      input: {
        now: deps.input.now,
        idGenerator: deps.input.idGenerator,
        userInputStore: deps.input.userInputStore,
        ledgerStore: deps.input.ledgerStore,
        runStore: deps.input.runStore,
        pendingActionStore: deps.input.pendingActionStore
      },
      run: state.activeRun,
      ledger: state.ledger,
      appendEvent: deps.appendEvent,
      checkpoint: deps.checkpoint,
      nextSequence: state.nextSequence,
      latestIterationIndex: state.latestIterationIndex,
      currentWorkingSet: state.currentWorkingSet,
      changedFiles: state.changedFiles,
      recentToolResult: state.recentToolResult,
      recentValidationResult: state.recentValidationResult,
      regroundRequested: state.regroundRequested,
      replanRequested: state.replanRequested,
      noProgressCount: state.noProgressCount,
      usage: state.usage,
      previousSnapshot: state.previousSnapshot,
      pendingRetryIncrement: state.pendingRetryIncrement,
      recoveryState: state.recoveryState,
      profileState: state.profileState,
      profile: deps.input.profile
    },
    action as Extract<AgentAction, { type: "ask_user" }>
  );
}

/**
 * yixiangProfile — the first real, non-coding business Profile (D001-R2
 * Phase 5a). Validates F029's profileState boundary end-to-end: a foreign
 * domain state type owned by profile hooks, persisted to checkpoint + resume,
 * restored identically, failing cleanly on corruption or profile mismatch.
 *
 * F030 first phase exercises lifecycle only (init/checkpoint/resume/validate);
 * the full tool-driven business chain is F030b. Yixiang does NOT import
 * strategy/builder/validation-repair/validation-gate, does NOT touch Run
 * status / Ledger / stores internals, and does NOT reuse coding-coupled
 * handlers (handleToolCall/handleFinal).
 *
 * F031b adds a minimal completionGate (artifact validation). Real Yixiang
 * completion integrity is deferred to a future business Feature.
 *
 * F032 reuses the shared handleAskUser (dead coding fields removed).
 */
export const yixiangProfile: AgentProfile = {
  name: "yixiang",
  state: yixiangStateHooks,
  registerTools: registerYixiangTools,
  generateAction: generateYixiangAction,
  actionHandlers: {
    tool_call: handleYixiangToolCall,
    ask_user: adaptYixiangAskUser,
    final: adaptYixiangFinal,
    fail: adaptYixiangFail
  },
  actionPolicies: [],
  completionGate: yixiangCompletionGate
};
