export class ToolRuntimeError extends Error {
  public constructor(
    public readonly code:
      | "FILE_NOT_FOUND"
      | "PATH_ESCAPE"
      | "SYMLINK_ESCAPE"
      | "BINARY_FILE"
      | "EMPTY_SEARCH_QUERY"
      | "EXPECTED_HASH_MISSING"
      | "STALE_FILE_HASH"
      | "FILE_ALREADY_EXISTS"
      | "INVALID_WRITE_MODE"
      | "WRITE_FAILED"
      | "WRITE_VERIFICATION_FAILED"
      | "TEMP_FILE_CLEANUP_FAILED"
      | "PATCH_INVALID"
      | "PATCH_APPLY_FAILED"
      | "PATCH_WRITE_FAILED"
      | "PATCH_REPLACE_FAILED"
      | "PATCH_VERIFY_FAILED"
      | "IDEMPOTENCY_CONFLICT"
      | "COMMAND_NOT_FOUND"
      | "CWD_ESCAPE"
      | "COMMAND_REJECTED"
      | "PROCESS_TERMINATION_FAILED"
      | "TOOL_TIMEOUT"
      | "TOOL_CANCELLED"
      | "PERMISSION_DENIED"
      | "INVALID_TOOL_INPUT"
      | "RUNTIME_ERROR"
      | "WORKSPACE_NOT_FOUND"
      | "WORKSPACE_NOT_DIRECTORY"
      | "DIRECTORY_BUDGET_EXCEEDED"
      | "REPOSITORY_TOO_LARGE"
      | "NOT_A_GIT_REPOSITORY"
      | "GIT_NOT_AVAILABLE"
      | "GIT_COMMAND_FAILED"
      | "INVALID_REVISION"
      | "DIFF_TOO_LARGE"
      | "CONFIG_NOT_FOUND"
      | "CONFIG_PARSE_FAILED"
      | "PROJECT_TYPE_UNKNOWN"
      | "COMMAND_DISCOVERY_FAILED"
      | "REPOSITORY_PROFILE_INVALID"
      | "WORKING_SET_INVALID"
      | "REPOSITORY_FACTS_STALE",
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
  }
}
