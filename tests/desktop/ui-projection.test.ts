import { describe, expect, it } from "vitest";

import {
  contentViewportKey,
  isContentAtBottom,
  modelIdValidationMessage,
  projectRuntimeControls,
  shouldShowTaskExecution
} from "../../apps/desktop/src/renderer/ui-projection.js";

describe("Desktop UI projection invariants", () => {
  it("keeps scroll state separate by Workspace, Session and view", () => {
    expect(contentViewportKey("D:\\Work", "session-1", "conversation")).toBe("d:\\work::session-1::conversation");
    expect(contentViewportKey("D:\\Work", "session-1", "output")).not.toBe(contentViewportKey("D:\\Work", "session-1", "conversation"));
    expect(contentViewportKey("D:\\Work", null, "conversation")).toBe("d:\\work::new-task::conversation");
  });

  it("only follows new content while the user is already at the bottom", () => {
    expect(isContentAtBottom({ scrollTop: 1_452, scrollHeight: 2_000, clientHeight: 500 })).toBe(true);
    expect(isContentAtBottom({ scrollTop: 900, scrollHeight: 2_000, clientHeight: 500 })).toBe(false);
  });

  it("projects Tasks only for active or waiting Runs", () => {
    for (const status of ["running", "waiting_for_input", "waiting_for_approval"]) expect(shouldShowTaskExecution(status)).toBe(true);
    for (const status of ["succeeded", "failed", "cancelled", "blocked"]) expect(shouldShowTaskExecution(status)).toBe(false);
  });

  it("separates provider Model IDs from display names", () => {
    for (const value of ["qwen3.8-flash", "openai/gpt-5.4", "provider:model_v2", "model.2026-08"]) {
      expect(modelIdValidationMessage(value)).toBeNull();
    }
    expect(modelIdValidationMessage("")).toBe("请输入 Model ID。");
    expect(modelIdValidationMessage("Qwen 3.8 Flash")).toContain("不能包含空格");
    expect(modelIdValidationMessage("模型 3.8")).not.toBeNull();
  });

  it("projects waiting input and approval only from pending Runtime requests", () => {
    expect(projectRuntimeControls({ status: "waiting_for_input", pendingRequest: { kind: "input", id: "input-1", prompt: "Which branch?" }, resumePredicate: null })).toEqual({ kind: "input", requestId: "input-1" });
    expect(projectRuntimeControls({ status: "waiting_for_approval", pendingRequest: { kind: "approval", id: "approval-1", prompt: "Write", toolName: "filesystem.write", input: {} }, resumePredicate: null })).toEqual({ kind: "approval", requestId: "approval-1" });
  });

  it("projects each typed blocked predicate without inferring capability from stop reasons", () => {
    expect(projectRuntimeControls({ status: "blocked", pendingRequest: null, resumePredicate: { kind: "provider_reconnect", providerCode: "PROVIDER_UNAVAILABLE", remainingRecoverySegments: 1, verification: "bounded_provider_probe" } })).toEqual({ kind: "provider_reconnecting" });
    expect(projectRuntimeControls({ status: "blocked", pendingRequest: null, resumePredicate: { kind: "budget_extension", stopReason: "MODEL_CALL_BUDGET_EXCEEDED", allowedDimensions: ["modelCalls"], minimumPositiveExtension: true } })).toEqual({ kind: "budget_extension", allowedDimensions: ["modelCalls"] });
    expect(projectRuntimeControls({ status: "blocked", pendingRequest: null, resumePredicate: { kind: "tool_recovery_decision", invocationIds: ["inv-1"] } })).toEqual({ kind: "tool_recovery", invocationIds: ["inv-1"] });
    expect(projectRuntimeControls({ status: "blocked", pendingRequest: null, resumePredicate: { kind: "worker_recovery_decision", childRunIds: ["child-1"] } })).toEqual({ kind: "worker_recovery", childRunIds: ["child-1"] });
  });

  it("keeps legacy blocked distinct and never offers Resume for terminal failure", () => {
    expect(projectRuntimeControls({ status: "blocked", pendingRequest: null, resumePredicate: null })).toEqual({ kind: "legacy_blocked" });
    expect(projectRuntimeControls({ status: "failed", pendingRequest: null, resumePredicate: null })).toEqual({ kind: "failed" });
  });

  it("rebuilds the same control model from a persisted public snapshot", () => {
    const persisted = JSON.parse(JSON.stringify({
      status: "blocked",
      pendingRequest: null,
      resumePredicate: {
        kind: "budget_extension",
        stopReason: "TOOL_CALL_BUDGET_EXCEEDED",
        allowedDimensions: ["toolCalls", "retries"],
        minimumPositiveExtension: true
      }
    }));
    expect(projectRuntimeControls(persisted)).toEqual({
      kind: "budget_extension",
      allowedDimensions: ["toolCalls", "retries"]
    });
  });
});
