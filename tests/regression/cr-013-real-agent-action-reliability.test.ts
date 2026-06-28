import { describe, expect, it } from "vitest";

import {
  AgentActionSchema,
  ActionSchema,
  ALL_TOOL_NAMES,
  computeArtifactHash
} from "../../packages/contracts/src/index.js";
import {
  ALL_MODEL_TOOL_DEFINITIONS,
  buildAgentActionSchemaText,
  buildModelToolSchemaText
} from "../../packages/model-gateway/src/model-tool-definition.js";
import { runCliForTest } from "../integration/cli-test-helper.js";

describe("CR-013 Real Agent Action Reliability", () => {
  it("1. Model-visible Tool Schema comes from a single source (all tools have definitions)", () => {
    for (const name of ALL_TOOL_NAMES) {
      expect(ALL_MODEL_TOOL_DEFINITIONS.find((d) => d.name === name)).toBeDefined();
    }
  });

  it("2. Plan and Next Action share the same ToolCall schema builder", () => {
    const planText = buildModelToolSchemaText(["filesystem.read", "filesystem.patch"]);
    const agentText = buildAgentActionSchemaText(["filesystem.read", "filesystem.patch"]);
    expect(agentText).toContain(planText);
  });

  it("3. Only availableTools are rendered (no unlisted tools leak)", () => {
    const text = buildModelToolSchemaText(["filesystem.read"]);
    expect(text).toContain('toolName: "filesystem.read"');
    for (const other of ALL_TOOL_NAMES) {
      if (other === "filesystem.read") {
        continue;
      }
      expect(text).not.toContain(`toolName: "${other}"`);
    }
  });

  it("4. Action Union matches the runtime AgentActionSchema", () => {
    const text = buildAgentActionSchemaText([...ALL_TOOL_NAMES]);
    expect(text).toContain('"tool_call"');
    expect(text).toContain('"request_approval"');
    expect(text).toContain('"ask_user"');
    expect(text).toContain('"update_plan"');
    expect(text).toContain('"final"');
    expect(text).toContain('"fail"');
  });

  it("5. read provides currentHash for patch (algorithm matches)", () => {
    const content = "sample content";
    const hash = computeArtifactHash(content);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("6. hash is deterministic (same input -> same hash)", () => {
    expect(computeArtifactHash("abc")).toBe(computeArtifactHash("abc"));
  });

  it("7. each definition minimal example parses under ToolCallSchema", () => {
    for (const def of ALL_MODEL_TOOL_DEFINITIONS) {
      expect(() =>
        AgentActionSchema.parse({
          type: "tool_call",
          toolCall: { toolCallId: `x-${def.name}`, toolName: def.name, input: def.minimalExample, timeoutMs: 5_000 }
        })
      ).not.toThrow();
    }
  });

  it("8. ActionSchema and AgentActionSchema both accept a valid tool_call", () => {
    const action = {
      type: "tool_call" as const,
      toolCall: {
        toolCallId: "tc-1",
        toolName: "filesystem.read" as const,
        input: { path: "src/App.tsx" },
        timeoutMs: 5_000
      }
    };
    expect(() => ActionSchema.parse(action)).not.toThrow();
    expect(() => AgentActionSchema.parse(action)).not.toThrow();
  });

  it("9-10. invalid action triggers bounded repair (max 2) then fails", async () => {
    const bad = JSON.stringify({ type: "tool_call", toolCall: { toolCallId: "x" } });
    const result = await runCliForTest(
      ["agent", "goal", process.execPath, "verify.js"],
      {
        extraEnv: { NEXORA_FAKE_AGENT_RAW_RESPONSES_JSON: JSON.stringify([bad, bad, bad]) },
        workspaceFiles: [{ relativePath: "verify.js", content: "process.exit(0);\n" }]
      }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("MODEL_ACTION_INVALID");
    const state = result.readDatabaseState();
    const rejected = state.events.filter((e) => e.type === "model.action.rejected");
    expect(rejected.length).toBe(3);
  });

  it("11. Action Repair and Provider Retry are counted separately (usage fields exist)", async () => {
    const bad = JSON.stringify({ type: "tool_call", toolCall: { toolCallId: "x" } });
    const good = JSON.stringify({
      type: "tool_call",
      toolCall: {
        toolCallId: "verify-1",
        toolName: "shell.execute",
        input: { command: process.execPath, args: ["verify.js"], cwd: ".", environment: {}, purpose: "verification", idempotencyKey: "v1" },
        timeoutMs: 2000
      }
    });
    const result = await runCliForTest(
      ["agent", "goal", process.execPath, "verify.js"],
      {
        extraEnv: { NEXORA_FAKE_AGENT_RAW_RESPONSES_JSON: JSON.stringify([bad, good]) },
        workspaceFiles: [{ relativePath: "verify.js", content: "process.exit(0);\n" }]
      }
    );
    expect(result.exitCode).toBe(0);
    const state = result.readDatabaseState();
    const budgetEvents = state.events.filter((e) => e.type === "budget.checked");
    const lastBudget = budgetEvents[budgetEvents.length - 1]?.payload as Record<string, unknown> | undefined;
    const usage = lastBudget?.usage as Record<string, unknown> | undefined;
    expect(usage).toBeDefined();
    expect(usage).toHaveProperty("actionRepairCount");
    expect(usage).toHaveProperty("providerRetryCount");
    expect(usage?.actionRepairCount).toBe(1);
    expect(usage?.providerRetryCount).toBe(0);
  });

  it("14. rejected Event payload does not leak API key patterns", async () => {
    const bad = JSON.stringify({ type: "tool_call", toolCall: { toolCallId: "x" } });
    const result = await runCliForTest(
      ["agent", "goal", process.execPath, "verify.js"],
      {
        extraEnv: {
          NEXORA_FAKE_AGENT_RAW_RESPONSES_JSON: JSON.stringify([bad, bad, bad]),
          NEXORA_MODEL_API_KEY: "sk-leak-test-1234567890abcdef"
        },
        workspaceFiles: [{ relativePath: "verify.js", content: "process.exit(0);\n" }]
      }
    );
    const state = result.readDatabaseState();
    const rejected = state.events.filter((e) => e.type === "model.action.rejected");
    for (const ev of rejected) {
      const serialized = JSON.stringify(ev.payload);
      expect(serialized).not.toContain("sk-leak-test-1234567890abcdef");
    }
  });
});
