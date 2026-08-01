import { RuntimeError } from "./runtime-error.js";

export type RunControlErrorCode = "RUN_STATE_CONFLICT" | "RUN_BUSY";

export class RunControlError extends RuntimeError {
  declare readonly code: RunControlErrorCode;
  declare readonly runId: string;
  readonly requestId?: string;

  constructor(input: {
    readonly code: RunControlErrorCode;
    readonly runId: string;
    readonly message: string;
    readonly requestId?: string;
  }) {
    super({
      code: input.code,
      message: input.message,
      retryable: true,
      runId: input.runId
    });
    this.name = "RunControlError";
    if (input.requestId !== undefined) this.requestId = input.requestId;
  }
}
