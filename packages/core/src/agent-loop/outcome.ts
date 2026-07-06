import type {
  ApprovalRequest,
  Artifact,
  ProgressLedger,
  Run,
  UserInputRequest,
  ValidationResult
} from "../../../contracts/src/index.js";

export type AgentLoopCompletedResult = {
  kind: "completed";
  run: Run;
  artifact: Artifact;
  validation: ValidationResult;
  ledger: ProgressLedger;
};

export type AgentLoopWaitingForApprovalResult = {
  kind: "waiting_for_approval";
  run: Run;
  ledger: ProgressLedger;
  approval: ApprovalRequest;
};

export type AgentLoopWaitingForUserResult = {
  kind: "waiting_for_user";
  run: Run;
  ledger: ProgressLedger;
  request: UserInputRequest;
};

export type AgentLoopResult =
  | AgentLoopCompletedResult
  | AgentLoopWaitingForApprovalResult
  | AgentLoopWaitingForUserResult;

/**
 * HandlerOutcome — the contract between an action Handler and the dispatch
 * loop. Handlers mutate shared loop state by reference (during F025-C
 * convergence) and return one of:
 *   - "continue": loop should continue to the next iteration;
 *   - "return": terminal — the dispatch loop returns the carried result;
 *   - "fail": business failure — the dispatch loop calls failRun uniformly,
 *     ensuring run.failed Event shape is consistent.
 *
 * Handlers must NOT catch unexpected exceptions (§18.2) — those propagate to
 * the global safety net (Phase A).
 */
export type HandlerOutcome =
  | { kind: "continue" }
  | { kind: "return"; result: AgentLoopResult }
  | { kind: "fail"; code: string; message: string; retryable: boolean };
