import {
  RunStatusSchema,
  type RunSnapshot,
  type RunDelivery,
  type RunStatus
} from "./contracts.js";

const allowedTransitions: Record<RunStatus, readonly RunStatus[]> = {
  running: ["waiting", "blocked", "cancelled", "failed", "succeeded"],
  waiting: ["running", "cancelled"],
  blocked: ["running", "cancelled", "failed"],
  cancelled: [],
  failed: [],
  succeeded: []
};

export type RunStatusTransitionOptions = {
  readonly now: string;
  readonly stopReason?: string;
  readonly pendingRequest?: RunSnapshot["pendingRequest"];
  readonly result?: NonNullable<RunSnapshot["result"]>;
  readonly delivery?: RunDelivery;
};

export function assertRunStatusTransition(from: RunStatus, to: RunStatus): void {
  RunStatusSchema.parse(from);
  RunStatusSchema.parse(to);
  if (!allowedTransitions[from].includes(to)) {
    throw new Error(`Invalid Run status transition: ${from} -> ${to}`);
  }
}

export function transitionRunStatus(
  run: RunSnapshot,
  nextStatus: RunStatus,
  options: RunStatusTransitionOptions
): RunSnapshot {
  assertRunStatusTransition(run.status, nextStatus);

  if (nextStatus === "waiting" && options.pendingRequest === undefined) {
    throw new Error("A waiting Run requires a pending request.");
  }
  if (nextStatus === "succeeded") {
    if (options.result === undefined) {
      throw new Error("A Run cannot succeed without a persisted result.");
    }
  }
  if (
    (nextStatus === "blocked" || nextStatus === "cancelled" || nextStatus === "failed" || nextStatus === "succeeded")
    && options.delivery === undefined
  ) {
    throw new Error(`${nextStatus} requires a persisted Delivery.`);
  }
  if (
    (
      nextStatus === "blocked"
      || nextStatus === "cancelled"
      || nextStatus === "failed"
      || nextStatus === "succeeded"
    )
    && !options.stopReason?.trim()
  ) {
    throw new Error(`${nextStatus} requires a stop reason.`);
  }

  return {
    ...run,
    status: nextStatus,
    stopReason: nextStatus === "running" ? null : options.stopReason?.trim() ?? null,
    pendingRequest: nextStatus === "waiting" ? options.pendingRequest ?? null : null,
    result: nextStatus === "succeeded" ? options.result ?? null : run.result,
    delivery: nextStatus === "running" || nextStatus === "waiting"
      ? null
      : options.delivery ?? run.delivery,
    updatedAt: options.now
  };
}
