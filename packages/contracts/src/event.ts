import { z } from "zod";

export const EventTypeSchema = z.enum([
  "run.created",
  "run.started",
  "run.waiting",
  "run.resumed",
  "model.action.generated",
  "model.started",
  "model.completed",
  "command.started",
  "command.completed",
  "command.failed",
  "patch.applied",
  "search.completed",
  "working-set.built",
  "ledger.initialized",
  "ledger.updated",
  "iteration.started",
  "iteration.completed",
  "iteration.failed",
  "budget.checked",
  "budget.exceeded",
  "no_progress.detected",
  "reground.requested",
  "replan.requested",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.approved",
  "approval.denied",
  "approval.expired",
  "user_input.requested",
  "user_input.received",
  "context.compacted",
  "context.regrounded",
  "context.integrity_violation",
  "checkpoint.created",
  "checkpoint.loaded",
  "recovery.decision",
  "recovery.reconciled",
  "recovery.rejected",
  "artifact.created",
  "validation.started",
  "validation.completed",
  "run.completed",
  "run.failed"
]);

export const EventSchema = z.object({
  eventVersion: z.literal("1"),
  eventId: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: EventTypeSchema,
  timestamp: z.string().datetime(),
  payload: z.record(z.string(), z.unknown())
});

export type Event = z.infer<typeof EventSchema>;
export type EventType = z.infer<typeof EventTypeSchema>;

export function createEvent(input: {
  eventId: string;
  runId: string;
  sequence: number;
  type: EventType;
  timestamp: string;
  payload: Record<string, unknown>;
}): Event {
  return EventSchema.parse({
    eventVersion: "1",
    eventId: input.eventId,
    runId: input.runId,
    sequence: input.sequence,
    type: input.type,
    timestamp: input.timestamp,
    payload: input.payload
  });
}
