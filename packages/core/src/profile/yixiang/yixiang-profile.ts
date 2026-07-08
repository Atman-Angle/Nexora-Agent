import type {
  AgentProfile,
  ProfileStateHooks,
  ProfileStateInitInput,
  ProfileStateRestoreInput
} from "../types.js";
import { ProfileStateInvalidError } from "../profile-state-error.js";
import {
  parseYixiangProfileState,
  type YixiangProfileState
} from "./yixiang-profile-state.js";
import { generateYixiangAction } from "./yixiang-generate-action.js";
import { adaptYixiangFail, adaptYixiangFinal, handleYixiangAskUser, handleYixiangToolCall } from "./yixiang-handlers.js";

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
 * yixiangProfile — the first real, non-coding business Profile (D001-R2
 * Phase 5a). Validates F029's profileState boundary end-to-end: a foreign
 * domain state type owned by profile hooks, persisted to checkpoint + resume,
 * restored identically, failing cleanly on corruption or profile mismatch.
 *
 * F030 first phase exercises lifecycle only (init/checkpoint/resume/validate);
 * the full tool-driven business chain is F030b. Yixiang does NOT import
 * strategy/builder/validation-repair/validation-gate, does NOT touch Run
 * status / Ledger / stores internals, and does NOT reuse coding-coupled
 * handlers (handleToolCall/handleFinal/handleAskUser).
 */
export const yixiangProfile: AgentProfile = {
  name: "yixiang",
  state: yixiangStateHooks,
  generateAction: generateYixiangAction,
  actionHandlers: {
    tool_call: handleYixiangToolCall,
    ask_user: handleYixiangAskUser,
    final: adaptYixiangFinal,
    fail: adaptYixiangFail
  },
  actionPolicies: []
};
