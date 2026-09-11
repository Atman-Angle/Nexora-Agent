import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  REQUEST_INPUT_CONTROL,
  createRuntime,
  defineProviderAdapter,
  type ModelResponse,
  type ProviderCompletionRequest
} from "../../packages/harness/src/index.js";
import type { RuntimeTool } from "../../packages/runtime/src/runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E152 Decision Efficiency Candidate A Tool Catalog projection", () => {
  it("keeps Provider Function Schemas identical while omitting only Prompt Tool definitions", async () => {
    const controlRequests: ProviderCompletionRequest[] = [];
    const candidateRequests: ProviderCompletionRequest[] = [];
    const control = await runOne("full", controlRequests);
    const candidate = await runOne("provider_native_only", candidateRequests);

    expect(control.status).toBe("waiting");
    expect(candidate.status).toBe("waiting");
    expect(controlRequests).toHaveLength(1);
    expect(candidateRequests).toHaveLength(1);

    const controlRequest = controlRequests[0]!;
    const candidateRequest = candidateRequests[0]!;
    expect(JSON.stringify(candidateRequest.tools)).toBe(JSON.stringify(controlRequest.tools));
    expect(JSON.stringify(candidateRequest.toolCatalog)).toBe(JSON.stringify(controlRequest.toolCatalog));
    expect(candidateRequest.system).not.toContain('"example.read"');
    expect(candidateRequest.system).toContain("Tool definitions are supplied exclusively by Provider-native functions.");
    expect(controlRequest.system).toContain('"example.read"');
    expect(candidateRequest.system.length).toBeLessThan(controlRequest.system.length);
    expect(controlRequest.tools?.some((tool) => tool.name === "example.read")).toBe(true);
    expect(candidateRequest.tools?.some((tool) => tool.name === "example.read")).toBe(true);
  });

  it("uses the full Tool Catalog as the production default", async () => {
    const explicitRequests: ProviderCompletionRequest[] = [];
    const defaultRequests: ProviderCompletionRequest[] = [];
    await runOne("full", explicitRequests);
    await runOne(undefined, defaultRequests);

    expect(defaultRequests[0]!.system).toBe(explicitRequests[0]!.system);
    expect(JSON.stringify(defaultRequests[0]!.tools)).toBe(JSON.stringify(explicitRequests[0]!.tools));
  });
});

async function runOne(
  projection: "full" | "provider_native_only" | undefined,
  requests: ProviderCompletionRequest[]
) {
  const workspace = mkdtempSync(join(tmpdir(), "nexora-e152-tool-catalog-"));
  roots.push(workspace);
  const provider = defineProviderAdapter({
    transport: { kind: "native_tools", promptCache: { mode: "disabled" } },
    async complete(request) {
      requests.push(request);
      return inputResponse();
    }
  });
  const runtime = createRuntime({
    workspace,
    provider,
    tools: [exampleTool()],
    ...(projection === undefined ? {} : { toolCatalogProjection: projection })
  });
  try {
    return await runtime.start({ input: "Read the example target." });
  } finally {
    await runtime.close();
  }
}

function exampleTool(): RuntimeTool {
  return {
    contract: {
      identity: { name: "example.read" },
      capability: {
        purpose: "Read one known example target.",
        nonGoals: ["Modify the target."]
      },
      decision: {
        useWhen: ["The exact target is known."],
        avoidWhen: ["The target is unknown."]
      },
      execution: {
        effect: { kind: "read", description: "Reads one target." },
        idempotent: true,
        inputSchema: z.object({ path: z.string().min(1) }).strict(),
        inputExample: { path: "target.txt" }
      },
      evidence: {
        produces: ["The target content."],
        factsSchema: z.object({ content: z.string() }).strict()
      }
    },
    async execute() {
      return { status: "success", subjectRef: "target.txt", facts: { content: "value" } };
    }
  };
}

function inputResponse(): ModelResponse {
  return {
    text: null,
    toolCalls: [{
      callId: "request-input",
      name: REQUEST_INPUT_CONTROL,
      arguments: {
        question: "Which target?",
        reason: "The target is user-exclusive.",
        basis: "user_exclusive"
      }
    }],
    finishReason: "tool_calls"
  };
}
