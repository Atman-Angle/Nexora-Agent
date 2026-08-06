import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../packages/runtime/src/index.js";
import { createOpenAICompatibleProvider } from "../../packages/runtime/src/providers/openai-compatible.js";
import type { SemanticValidationContext } from "../../packages/runtime/src/providers/model-client.js";
import { ScriptedRuntimeProvider, finishFromEvidence, setPlan, successfulReadTool } from "./runtime-testkit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E060 semantic validation boundary", () => {
  it("validates only raw inputs, proposed summary, and plain cited Tool facts", async () => {
    const workspace = fixture();
    const provider = new BoundaryProvider([
      setPlan(workspace),
      { type: "call_tool", stepId: "inspect", checkIds: ["read-target"], toolName: "filesystem.read", input: { path: "README.md" } },
      finishFromEvidence("README contains verified content.")
    ]);
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    const result = await runtime.start({ input: "Read README.md and report its content." });

    expect(result.status).toBe("succeeded");
    expect(provider.semanticContext).toEqual({
      inputs: ["Read README.md and report its content."],
      proposedSummary: "README contains verified content.",
      facts: [{
        toolName: "filesystem.read",
        subjectRef: "README.md",
        input: { path: "README.md" },
        facts: { content: "export const value = 1;" }
      }]
    });
    expect(JSON.stringify(provider.semanticContext)).not.toMatch(/digest|taskContract|planVersion|stepId|checkId|invocationId|idempotency|fencing/i);
    runtime.close();
  });

  it("gives the decision model generic minimum-sequence, dedicated-Tool and Runtime-Approval guidance", async () => {
    const workspace = fixture();
    let systemPrompt = "";
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.invalid/v1",
      apiKey: "test-key",
      model: "test-model",
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
        systemPrompt = body.messages.find((message) => message.role === "system")?.content ?? "";
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: "request_input", question: "Which target?", reason: "Target is unknown" }) } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });
    const runtime = createRuntime({ workspace, dataDir: join(workspace, ".nexora"), provider, tools: [successfulReadTool()] });

    await runtime.start({ input: "Inspect a target." });

    expect(systemPrompt).toContain("single Capability");
    expect(systemPrompt).toContain("Use discovery only");
    expect(systemPrompt).toContain("unnecessary");
    expect(systemPrompt).toContain("never for Tool permission or approval");
    expect(systemPrompt).toContain("let Runtime request Approval");
    expect(systemPrompt).toContain("Never use shell.execute to emulate a registered Tool");
    expect(systemPrompt).toContain("Set only taskContract.workspace to context.workspace exactly");
    expect(systemPrompt).toContain("without substituting context.workspace for relative values");
    expect(systemPrompt).not.toMatch(/README|filesystem\.read|filesystem\.search/);
    runtime.close();
  });
});

class BoundaryProvider extends ScriptedRuntimeProvider {
  semanticContext: SemanticValidationContext | null = null;

  override async validate(context: SemanticValidationContext): Promise<unknown> {
    this.semanticContext = structuredClone(context);
    return { passed: true, issues: [] };
  }
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e060-boundary-"));
  roots.push(root);
  return root;
}
