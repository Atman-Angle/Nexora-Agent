import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("apps/desktop/src/renderer/app.ts", "utf8");

describe("Desktop renderer regression structure", () => {
  it("keeps Conversation turns grouped without adding a second runtime state", () => {
    expect(source).toContain('class="conversation-turn"');
    expect(source).toContain("data-turn=\"${runIndex + 1}\"");
  });

  it("projects terminal plans out of the main Conversation", () => {
    expect(source).toContain("!shouldShowTaskExecution(session.inspection.status)");
    expect(source).toContain("function statusComposer(");
  });

  it("renders one inline execution transcript without the retired feedback UI", () => {
    expect(source).toContain("function executionTranscript(run:");
    expect(source).toContain('class="execution-transcript"');
    expect(source).toContain("深度思考");
    expect(source).not.toContain("liveModelFeedback(");
    expect(source).not.toContain('class="live-model-feedback');
  });

  it("uses the common Composer toolbar for approval and recovery states", () => {
    expect(source).toContain('statusComposer(session, "approval"');
    expect(source).toContain('statusComposer(session, "recovery"');
    expect(source).toContain('statusComposer(session, "blocked"');
  });

  it("derives recovery controls from Runtime public predicates rather than local history", () => {
    expect(source).toContain("projectRuntimeControls(run)");
    expect(source).not.toContain("providerRecoveryExhausted");
    expect(source).toContain('projection.kind === "provider_reconnecting"');
    expect(source).toContain('projection.kind === "budget_extension"');
    expect(source).toContain('projection.kind === "legacy_blocked"');
  });

});
