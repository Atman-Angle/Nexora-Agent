import type { FailureCategory, FailureSource } from "../../../contracts/src/index.js";

export function classifyFailure(input: {
  source: FailureSource;
  code?: string | undefined;
  message: string;
  retryable: boolean;
}): FailureCategory {
  const code = input.code ?? "";
  const message = input.message.toLowerCase();

  if (["PATH_ESCAPE", "SYMLINK_ESCAPE", "COMMAND_REJECTED", "PERMISSION_DENIED"].includes(code)) {
    return "security_violation";
  }
  if (code === "STALE_FILE_HASH" || code === "REPOSITORY_FACTS_STALE") {
    return "workspace_stale";
  }
  if (code === "FILE_NOT_FOUND" || code === "CONFIG_NOT_FOUND") {
    return "file_not_found";
  }
  if (["PATCH_APPLY_FAILED", "PATCH_REPLACE_FAILED", "PATCH_VERIFY_FAILED", "PATCH_INVALID"].includes(code)) {
    return "patch_conflict";
  }
  if (code === "COMMAND_NOT_FOUND") {
    return "command_not_found";
  }
  if (code === "CWD_ESCAPE" || code === "WORKSPACE_NOT_FOUND" || code === "WORKSPACE_NOT_DIRECTORY") {
    return code === "CWD_ESCAPE" ? "security_violation" : "environment_misconfigured";
  }
  if (code === "VALIDATION_FAILED" || input.source === "validation") {
    return "validation_failed";
  }
  if (code === "MODEL_FINAL_REJECTED" || input.source === "completion_gate") {
    return "acceptance_failed";
  }
  if (code === "APPROVAL_DENIED") {
    return "approval_denied";
  }
  if (code === "BUDGET_EXCEEDED") {
    return "budget_exceeded";
  }
  if (code === "NO_PROGRESS") {
    return "no_progress";
  }
  if (code === "MODEL_ACTION_INVALID" || code === "MODEL_JSON_PARSE_ERROR") {
    return "model_output_invalid";
  }
  if (code === "MODEL_AUTH_ERROR" || code === "MODEL_CONFIG_ERROR") {
    return "provider_terminal";
  }
  if (code.startsWith("MODEL_") && input.retryable) {
    return "provider_transient";
  }
  if (code === "TOOL_NOT_AVAILABLE") {
    return "tool_not_available";
  }
  if (code === "INVALID_TOOL_INPUT" || code === "EXPECTED_HASH_MISSING" || code === "INVALID_WRITE_MODE") {
    return "tool_input_invalid";
  }
  if (message.includes("secret") || message.includes("api key") || message.includes("authorization")) {
    return "environment_misconfigured";
  }
  if (input.source === "tool") {
    return "tool_execution_failed";
  }

  return "unknown";
}

export function isTerminalFailureCategory(category: FailureCategory): boolean {
  return [
    "security_violation",
    "approval_denied",
    "budget_exceeded",
    "provider_terminal",
    "state_inconsistent"
  ].includes(category);
}
