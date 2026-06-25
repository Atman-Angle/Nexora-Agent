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
      | "RUNTIME_ERROR",
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
  }
}
