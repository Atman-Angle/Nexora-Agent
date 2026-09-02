import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  codingReasoningLevel,
  createAgent,
  projectStrategyRouting,
  type ModelDecisionContext,
  type RuntimeProvider
} from "../../packages/harness/src/index.js";
import { decisionHasSemanticPressure } from "../../packages/harness/src/provider-policy.js";
import { REQUEST_INPUT_CONTROL } from "../../packages/harness/src/providers/model-response.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E141 Autonomous Coding Execution v0.1", () => {
  it("routes empty-workspace creation to Coding and explanation turns to General", () => {
    const workspace = fixture();

    expect(route(workspace, ["从零创建一个个人探索日志网页，支持增删改查和本地持久化。"])).toEqual({
      strategyProfile: "coding",
      reason: "user_intent_is_software_engineering",
      confidence: "high",
      codingTaskShape: "greenfield"
    });
    expect(route(workspace, ["解释这段代码的架构，不要修改文件。"])).toEqual({
      strategyProfile: "general",
      reason: "non_coding_intent",
      confidence: "high",
      codingTaskShape: null
    });

    writeFileSync(join(workspace, "app.js"), "const value = ;\n", "utf8");
    expect(route(workspace, ["为现有网页添加搜索和类别筛选功能。"])).toMatchObject({
      strategyProfile: "coding",
      codingTaskShape: "feature"
    });
    expect(route(workspace, ["修复 app.js 中导致页面无法加载的语法 bug。"])).toMatchObject({
      strategyProfile: "coding",
      codingTaskShape: "bug_fix"
    });
  });

  it("re-derives routing from the latest turn while preserving unfinished Coding continuity", () => {
    const workspace = fixture();

    expect(route(workspace, [
      "Build a small TypeScript app.",
      "Explain the current architecture without changing it."
    ])).toMatchObject({ strategyProfile: "general", codingTaskShape: null });
    expect(route(workspace, [
      "Build a small TypeScript app.",
      "Explain the current architecture.",
      "Fix the persistence bug and run the focused test."
    ])).toMatchObject({ strategyProfile: "coding", codingTaskShape: "bug_fix" });
    expect(projectStrategyRouting({
      workspace,
      userInputs: ["Continue the remaining work."],
      ongoingTaskGoal: "Build a TypeScript app with local persistence.",
      taskMode: "change",
      mode: "auto",
      observations: []
    })).toMatchObject({ strategyProfile: "coding", codingTaskShape: "greenfield" });
  });

  it("supports development overrides without changing the product auto default", () => {
    const workspace = fixture();
    expect(projectStrategyRouting({
      workspace,
      userInputs: ["Summarize the meeting."],
      taskMode: "inquiry",
      mode: "coding",
      observations: []
    })).toMatchObject({
      strategyProfile: "coding",
      reason: "explicit_coding_override",
      confidence: "high"
    });
    expect(projectStrategyRouting({
      workspace,
      userInputs: ["Build a React app."],
      taskMode: "change",
      mode: "general",
      observations: []
    })).toEqual({
      strategyProfile: "general",
      reason: "explicit_general_override",
      confidence: "high",
      codingTaskShape: null
    });
  });

  it("publishes bounded routing facts in both decision context and compiled trace input", async () => {
    const provider = new CapturingProvider();
    const runtime = createAgent({
      workspace: fixture(),
      provider,
      tools: [],
      hostPolicy: {
        schemaVersion: 1,
        id: "e141-host",
        version: "1",
        taskMode: "change",
        promptCache: "allow",
        instructions: ["Complete authorized workspace work."]
      }
    });
    let requestedPayload: Readonly<Record<string, unknown>> | undefined;
    try {
      const result = await runtime.start({ input: "Build a small CRUD web app with local persistence." });
      requestedPayload = (await runtime.inspect(result.runId)).events
        .find((event) => event.type === "model.requested")?.payload;
    } finally {
      await runtime.close();
    }

    expect(provider.contexts[0]?.strategyRouting).toEqual({
      strategyProfile: "coding",
      reason: "user_intent_is_software_engineering",
      confidence: "high",
      codingTaskShape: "greenfield"
    });
    const input = JSON.parse(provider.promptInputs[0]!) as {
      readonly strategyRouting: unknown;
      readonly codingStrategy: { readonly adaptiveReasoning: string };
    };
    expect(input.strategyRouting).toEqual(provider.contexts[0]?.strategyRouting);
    expect(input.codingStrategy.adaptiveReasoning).toBe("moderate");
    expect(requestedPayload).toMatchObject({
      strategyProfile: "coding",
      activationReason: "user_intent_is_software_engineering",
      confidence: "high",
      codingTaskShape: "greenfield"
    });
  });

  it("keeps ordinary Coding execution action-first and raises reasoning only at uncertain phases", () => {
    expect(codingReasoningLevel("INITIAL_PLANNING", null)).toBe("moderate");
    expect(codingReasoningLevel("EXECUTION", null)).toBe("low");
    expect(codingReasoningLevel("VALIDATION", null)).toBe("low");
    expect(codingReasoningLevel("COMPLETION", null)).toBe("low");
    expect(codingReasoningLevel("FAILURE_REPAIR", null)).toBe("elevated");

    expect(pressure("low")).toBe(false);
    expect(pressure("moderate")).toBe(true);
    expect(pressure("elevated")).toBe(true);
  });
});

function route(workspace: string, userInputs: readonly string[]) {
  return projectStrategyRouting({
    workspace,
    userInputs,
    taskMode: "change",
    mode: "auto",
    observations: []
  });
}

function pressure(adaptiveReasoning: "low" | "moderate" | "elevated"): boolean {
  return decisionHasSemanticPressure(JSON.stringify({
    currentRuntimeDirective: { kind: "normal" },
    codingStrategy: { adaptiveReasoning }
  }));
}

class CapturingProvider implements RuntimeProvider {
  readonly contexts: ModelDecisionContext[] = [];
  readonly promptInputs: string[] = [];

  async decide(context: ModelDecisionContext, operation?: Parameters<RuntimeProvider["decide"]>[1]) {
    this.contexts.push(structuredClone(context));
    this.promptInputs.push(operation?.compiledPrompt?.input ?? "");
    return {
      text: null,
      toolCalls: [{
        callId: `pause-${this.contexts.length}`,
        name: REQUEST_INPUT_CONTROL,
        arguments: { question: "Pause?", reason: "Context captured." }
      }],
      finishReason: "tool_calls" as const
    };
  }
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nexora-e141-"));
  roots.push(root);
  return root;
}
