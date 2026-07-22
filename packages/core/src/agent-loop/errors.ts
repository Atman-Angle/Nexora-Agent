/**
 * AgentLoopRunFailure — the known-error class thrown by the agent loop.
 *
 * Extracted to a shared module so that handler/helper files in agent-loop/
 * can import it without cycling back through agent-loop-runner.ts. The
 * runner re-exports it to preserve the public API.
 */
export class AgentLoopRunFailure extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly details: Record<string, unknown>;

  public constructor(code: string, message: string, retryable: boolean, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}
