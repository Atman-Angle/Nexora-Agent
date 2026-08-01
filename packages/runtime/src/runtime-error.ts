export type RuntimeErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_INPUT"
  | "RUN_NOT_FOUND"
  | "RUN_BUSY"
  | "RUN_STATE_CONFLICT"
  | "PROVIDER_UNAVAILABLE"
  | "RUNTIME_CLOSED"
  | "CANCELLED"
  | "TOOL_RESULT_UNKNOWN"
  | "INTERNAL";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly retryable: boolean;
  readonly runId?: string;

  constructor(input: {
    readonly code: RuntimeErrorCode;
    readonly message: string;
    readonly retryable?: boolean;
    readonly runId?: string;
    readonly cause?: unknown;
  }) {
    super(
      `${input.code}: ${input.message}`,
      input.cause === undefined ? undefined : { cause: input.cause }
    );
    this.name = "RuntimeError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    if (input.runId !== undefined) this.runId = input.runId;
  }
}

export function cancellationReason(
  signal: AbortSignal,
  fallback = "The Run was cancelled."
): string {
  const reason = signal.reason;
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim();
  return fallback;
}
