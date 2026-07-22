import type { Event, Run } from "../../../contracts/src/index.js";
import type { RunStore } from "../../../storage/src/run-store.js";
import { transitionRun } from "../state-machine.js";
import { AgentLoopRunFailure } from "./errors.js";

export async function failRun(input: {
  input: {
    now: () => string;
    runStore: RunStore;
  };
  run: Run;
  appendEvent: (type: Event["type"], payload: Record<string, unknown>, timestamp: string) => Promise<void>;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}): Promise<never> {
  const failedAt = input.input.now();
  const failedRun = transitionRun(input.run, "failed", failedAt, input.code);
  input.input.runStore.updateRun(failedRun);
  await input.appendEvent("run.failed", { code: input.code, message: input.message, ...(input.details ?? {}) }, failedAt);
  throw new AgentLoopRunFailure(input.code, input.message, input.retryable, input.details);
}
