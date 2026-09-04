import { describe, expect, it } from "vitest";

import { stateRejectionRecovery } from "../../packages/runtime/src/runtime-helpers.js";

describe("E147 completion rejection repair guidance", () => {
  it("tells the model to re-run verification when completion evidence is stale", () => {
    const recovery = stateRejectionRecovery(
      "Completion is not valid: CHECK_EVIDENCE_STALE:step-abc:check-xyz"
    );
    expect(recovery.nextAction).toContain("Run the verification Tool now");
    expect(recovery.nextAction).not.toContain("do not resend this completion unchanged.");
  });

  it("guides verification for a final step that requires a verification role", () => {
    const recovery = stateRejectionRecovery(
      "Completion is not valid: STEP_VERIFICATION_REQUIRED:step-abc"
    );
    expect(recovery.nextAction).toContain("verification Evidence");
  });

  it("keeps existing targeted recovery guidance unchanged", () => {
    const recovery = stateRejectionRecovery(
      "PROTECTED_MUTATION_BATCH_REQUIRES_ONE_AT_A_TIME: submit one protected mutation per Provider turn"
    );
    expect(recovery.nextAction).toContain("Submit exactly one protected mutation");
  });

  it("uses completion-specific guidance for other completion gate rejections", () => {
    const recovery = stateRejectionRecovery(
      "Completion is not valid: TOOL_INVOCATION_UNRESOLVED"
    );
    expect(recovery.nextAction).toContain("Correct the specific issues named in the rejection");
  });

  it("keeps the generic fallback for unrelated state rejections", () => {
    const recovery = stateRejectionRecovery("SOME_OTHER_STATE_REJECTION");
    expect(recovery.nextAction).toContain("Correct the request using the rejection details");
  });
});
