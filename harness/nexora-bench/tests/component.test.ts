import { describe, expect, it } from "vitest";
import { NATIVE_FUNCTION_CALLING_CAPABILITIES, modelResponses } from "@nexora/harness";

import {
  createBenchTelemetry,
  loadDataset,
  runHarborRuntimeTrial,
  selectTasks
} from "../src/index.js";
import { observeProvider } from "../src/runner.js";
import type { ModelObservation } from "../src/telemetry.js";

describe("NexoraBench component boundary", () => {
  it("exports the Nexora-specific Harbor Runtime boundary", () => {
    expect(loadDataset).toBeTypeOf("function");
    expect(selectTasks).toBeTypeOf("function");
    expect(runHarborRuntimeTrial).toBeTypeOf("function");
    expect(createBenchTelemetry).toBeTypeOf("function");
  });

  it("keeps the observed Provider Transport and cache policy intact", () => {
    const transport = { kind: "native_tools", promptCache: { mode: "automatic" } } as const;
    const observations: ModelObservation[] = [];
    const provider = observeProvider({
      nativeFunctionCalling: NATIVE_FUNCTION_CALLING_CAPABILITIES,
      transport,
      async decide() {
        return modelResponses.text("done");
      }
    }, observations);

    expect(provider.transport).toBe(transport);
  });
});
