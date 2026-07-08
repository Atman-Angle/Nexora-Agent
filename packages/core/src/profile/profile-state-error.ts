/**
 * ProfileStateInvalidError — thrown by a profile's restoreState/validateState
 * (and by the runtime's profileName-mismatch gate) when persisted profile state
 * cannot be restored. The runner converts it into a failed run with
 * code "PROFILE_STATE_INVALID", retryable: false.
 */
export class ProfileStateInvalidError extends Error {
  public readonly code = "PROFILE_STATE_INVALID";
  public readonly retryable = false;
  public constructor(message: string) {
    super(message);
    this.name = "ProfileStateInvalidError";
  }
}
