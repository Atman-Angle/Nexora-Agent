import { describe, expect, it } from "vitest";

import {
  createBenchTelemetry,
  loadDataset,
  runBench,
  selectTasks
} from "../src/index.js";
import { observeProvider } from "../src/runner.js";
import type { ModelObservation } from "../src/telemetry.js";

describe("NexoraBench component boundary", () => {
  it("exports the existing dataset, runner and telemetry components without a second execution path", () => {
    expect(loadDataset).toBeTypeOf("function");
    expect(selectTasks).toBeTypeOf("function");
    expect(runBench).toBeTypeOf("function");
    expect(createBenchTelemetry).toBeTypeOf("function");
  });

  it("keeps the observed Provider Transport and cache policy intact", () => {
    const transport = { kind: "native_tools", promptCache: { mode: "automatic" } } as const;
    const observations: ModelObservation[] = [];
    const provider = observeProvider({
      transport,
      async decide() {
        return { action: "finish", text: "done" };
      }
    }, observations);

    expect(provider.transport).toBe(transport);
  });
});
