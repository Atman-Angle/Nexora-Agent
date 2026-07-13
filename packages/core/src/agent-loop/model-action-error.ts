import type { ToolCall } from "../../../contracts/src/index.js";
import type { ModelActionRejection, ModelActionRejectionCategory } from "../../../model-gateway/src/index.js";
import {
  ModelConfigError,
  ModelHttpError,
  ModelJsonParseError,
  ModelTimeoutError
} from "../../../model-gateway/src/index.js";

export type ModelActionFailure = {
  code: string;
  message: string;
  retryable: boolean;
  raw: unknown;
  category: ModelActionRejectionCategory | null;
  issues: Array<{ path: string; message: string }> | null;
};

export function summarizeZodIssues(issues: Array<{ path: PropertyKey[]; message: string }>): {
  summary: string;
  plain: Array<{ path: string; message: string }>;
} {
  const plain = issues.slice(0, 5).map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message
  }));
  const summary = plain.map((i) => `${i.path}: ${i.message}`).join("; ");
  const suffix = issues.length > 5 ? `; (+${String(issues.length - 5)} more)` : "";
  return { summary: `${summary}${suffix}`, plain };
}

export function describeModelActionError(error: unknown): ModelActionFailure {
  if (error instanceof ModelConfigError) {
    return { code: "MODEL_CONFIG_ERROR", message: error.message, retryable: false, raw: null, category: null, issues: null };
  }
  if (error instanceof ModelTimeoutError) {
    return { code: error.code, message: error.message, retryable: error.retryable, raw: null, category: null, issues: null };
  }
  if (error instanceof ModelHttpError) {
    return { code: error.code, message: error.message, retryable: error.retryable, raw: null, category: null, issues: null };
  }
  if (error instanceof ModelJsonParseError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      raw: null,
      category: "json_parse",
      issues: null
    };
  }
  if (error instanceof Error && Array.isArray((error as { issues?: unknown[] }).issues)) {
    const issues = (error as unknown as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
    const { summary, plain } = summarizeZodIssues(issues);
    return {
      code: "MODEL_ACTION_INVALID",
      message: `Agent model produced an action that failed schema validation. ${summary}`,
      retryable: false,
      raw: { issues: plain },
      category: "schema_validation",
      issues: plain
    };
  }
  if (error instanceof Error) {
    return {
      code: "MODEL_ACTION_INVALID",
      message: `Agent model produced an invalid action: ${error.message}`,
      retryable: false,
      raw: null,
      category: null,
      issues: null
    };
  }
  return {
    code: "MODEL_ACTION_INVALID",
    message: "Agent model produced an invalid action.",
    retryable: false,
    raw: null,
    category: null,
    issues: null
  };
}

export function isActionRepairable(error: unknown): boolean {
  if (error instanceof ModelConfigError) {
    return false;
  }
  if (error instanceof ModelJsonParseError) {
    return true;
  }
  if (error instanceof ModelTimeoutError || error instanceof ModelHttpError) {
    return false;
  }
  if (error instanceof Error && Array.isArray((error as { issues?: unknown[] }).issues)) {
    return true;
  }
  return false;
}

export function buildToolFailureRejection(input: {
  toolCall: ToolCall;
  code: string;
  message: string;
  /** The caller has classified this as a schema failure on a read-only tool. */
  repairableReadInput?: boolean;
  /** Registry-owned, model-visible example for the tool input contract. */
  minimalExample?: Record<string, unknown>;
}): ModelActionRejection | null {
  if (input.code === "INVALID_TOOL_INPUT") {
    if (input.repairableReadInput !== true) {
      return null;
    }
    return {
      category: "tool_failure_recovery",
      attempt: 1,
      message: [
        `Read-only tool ${input.toolCall.toolName} rejected its input: ${input.message}`,
        "Do not repeat this tool call unchanged. Submit one new tool_call with a fresh toolCallId and only corrected input.",
        `Minimal legal input example: ${JSON.stringify(input.minimalExample ?? {})}`,
        "This repair is limited by the existing action-repair budget and must not request approval or perform a write."
      ].join(" "),
      issues: [{ path: "toolCall.input", message: input.message }]
    };
  }
  if (!/(PATCH_|IDEMPOTENCY_CONFLICT)/i.test(input.code)) {
    return null;
  }
  if (input.toolCall.toolName === "shell.execute") {
    const toolInput = input.toolCall.input as { idempotencyKey?: string; purpose?: string };
    const idempotencyKey = toolInput.idempotencyKey ?? input.toolCall.toolCallId;
    return {
      category: "tool_failure_recovery",
      attempt: 1,
      message: [
        `Tool shell.execute failed with ${input.code}: ${input.message}`,
        `Do not repeat the same toolCallId or idempotencyKey (${idempotencyKey}).`,
        "If this was a validation, test, or build rerun, submit the same validation command again with a fresh toolCallId and fresh idempotencyKey.",
        "Do not mutate source through shell.execute; use it only for validation, tests, or builds after Builder-controlled mutations."
      ].join(" ")
    };
  }
  if (input.toolCall.toolName !== "filesystem.patch" && input.toolCall.toolName !== "filesystem.write") {
    return null;
  }
  const toolInput = input.toolCall.input as { path?: string; idempotencyKey?: string };
  const path = toolInput.path ?? "the Builder-bound target file";
  const idempotencyKey = toolInput.idempotencyKey ?? input.toolCall.toolCallId;
  return {
    category: "tool_failure_recovery",
    attempt: 1,
    message: [
      `Tool ${input.toolCall.toolName} failed with ${input.code}: ${input.message}`,
      `Target path: ${path}.`,
      `Do not repeat the same patch, toolCallId, or idempotencyKey (${idempotencyKey}).`,
      "Use a new idempotencyKey and either submit a focused repair execution plan, use filesystem.write for the same Builder-bound target, or create a new filesystem.patch from current file content.",
      "Stay within Task.input.executionConstraints and rerun validation after the mutation."
    ].join(" ")
  };
}
