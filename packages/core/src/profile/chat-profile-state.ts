import type {
  ProfileStateHooks,
  ProfileStateRestoreInput
} from "./types.js";
import { ProfileStateInvalidError } from "./profile-state-error.js";

/**
 * Chat carries no coding strategy/builder state. Its opaque state exists only
 * so checkpoint/resume retain a profile-owned, versioned slot.
 */
export type ChatProfileState = Record<string, never>;

function restoreChatState(input: ProfileStateRestoreInput): ChatProfileState {
  if (input.profileVersion !== undefined && input.profileVersion !== "1") {
    throw new ProfileStateInvalidError(`chat profileState version ${input.profileVersion} not supported`);
  }
  if (input.profileState === undefined || input.profileState === null) {
    return {};
  }
  if (typeof input.profileState !== "object" || Array.isArray(input.profileState)) {
    throw new ProfileStateInvalidError("chat profileState must be an object");
  }
  return {};
}

export const chatStateHooks: ProfileStateHooks = {
  version: "1",
  initState: () => ({}),
  serializeState: () => ({}),
  restoreState: restoreChatState,
  validateState: (state) => {
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      throw new ProfileStateInvalidError("chat profileState must be an object");
    }
  }
};
