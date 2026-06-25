import { RunSchema, type Run, type RunStatus } from "../../contracts/src/index.js";

const allowedTransitions: Record<RunStatus, RunStatus[]> = {
  created: ["running"],
  running: ["waiting_for_tool", "waiting_for_approval", "waiting_for_user", "verifying", "blocked", "failed"],
  waiting_for_tool: ["running", "blocked", "failed"],
  waiting_for_approval: ["running", "blocked", "failed", "cancelled"],
  waiting_for_user: ["running", "blocked", "failed", "cancelled"],
  verifying: ["succeeded", "blocked", "failed"],
  blocked: ["running", "waiting_for_user", "failed", "cancelled"],
  cancelled: [],
  succeeded: [],
  failed: []
};

export function assertValidTransition(from: RunStatus, to: RunStatus): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new Error(`Invalid run transition: ${from} -> ${to}`);
  }
}

export function transitionRun(
  run: Run,
  nextStatus: RunStatus,
  updatedAt: string,
  errorCode?: string
): Run {
  assertValidTransition(run.status, nextStatus);

  return RunSchema.parse({
    ...run,
    status: nextStatus,
    stateVersion: run.stateVersion + 1,
    updatedAt,
    errorCode
  });
}
