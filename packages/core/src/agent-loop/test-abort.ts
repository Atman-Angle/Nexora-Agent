import type { CheckpointPhase, Event } from "../../../contracts/src/index.js";
import { AgentLoopRunFailure } from "./errors.js";

export function maybeAbortAfterCheckpoint(phase: CheckpointPhase, note: string | undefined): void {
  const configuredPhase = process.env.NEXORA_TEST_EXIT_AFTER_CHECKPOINT_PHASE?.trim();
  if (configuredPhase === undefined || configuredPhase.length === 0) {
    return;
  }

  if (configuredPhase !== phase) {
    return;
  }

  const configuredNote = process.env.NEXORA_TEST_EXIT_AFTER_CHECKPOINT_NOTE?.trim();
  if (configuredNote !== undefined && configuredNote.length > 0 && configuredNote !== note) {
    return;
  }

  throw new AgentLoopRunFailure("TEST_ABORT", `Test abort after checkpoint phase ${phase}`, false);
}

export function maybeAbortAfterEvent(type: Event["type"]): void {
  const configuredType = process.env.NEXORA_TEST_EXIT_AFTER_EVENT_TYPE?.trim();
  if (configuredType === undefined || configuredType.length === 0) {
    return;
  }

  if (configuredType !== type) {
    return;
  }

  throw new AgentLoopRunFailure("TEST_ABORT", `Test abort after event ${type}`, false);
}
