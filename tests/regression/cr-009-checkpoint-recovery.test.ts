import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { computeArtifactHash } from "../../packages/contracts/src/index.js";
import { createCliTestSession } from "../integration/cli-test-helper.js";

describe("CR-009 Checkpoint Recovery", () => {
  it("reconciles a post-tool interruption, keeps duplicate resume idempotent, and completes the original run", async () => {
    const session = await createCliTestSession({
      workspaceFiles: [
        { relativePath: "note.txt", content: "before\n" },
        {
          relativePath: "verify.js",
          content:
            "import { readFileSync } from 'node:fs';\nif (readFileSync('./note.txt', 'utf8').trim() !== 'after') process.exit(1);\n"
        }
      ],
      extraEnv: {
        NEXORA_FAKE_AGENT_SCRIPT_JSON: JSON.stringify([
          structuredPlanAction(),
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "cr009-patch",
              toolName: "filesystem.patch",
              input: {
                path: "note.txt",
                expectedHash: computeArtifactHash("before\n"),
                patch: { type: "replace_text", find: "before", replace: "after" },
                encoding: "utf8",
                idempotencyKey: "cr009-patch"
              },
              timeoutMs: 1000
            }
          },
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "cr009-verify",
              toolName: "shell.execute",
              input: {
                command: process.execPath,
                args: ["verify.js"],
                cwd: ".",
                environment: {},
                purpose: "verification",
                idempotencyKey: "cr009-verify"
              },
              timeoutMs: 2000
            }
          },
          { type: "final", text: "Checkpoint recovery regression passed." }
        ])
      }
    });

    const first = session.run(["agent", "Patch the note", process.execPath, "verify.js"]);
    expect(first.exitCode).toBe(0);
    const firstPayload = parseJson(first.stdout);
    expect(firstPayload.status).toBe("waiting_for_approval");
    const runId = String(firstPayload.runId);

    const approve = session.run(["approve", String(firstPayload.approvalId)], {
      NEXORA_TEST_EXIT_AFTER_CHECKPOINT_PHASE: "post_tool"
    });
    expect(approve.exitCode).toBe(1);
    expect(approve.stderr).toContain("Test abort after checkpoint phase post_tool");

    const crashedState = session.readDatabaseState();
    expect(crashedState.runs[0]?.runId).toBe(runId);
    expect(crashedState.runs[0]?.status).toBe("waiting_for_tool");
    expect(crashedState.executionRecords).toHaveLength(1);

    const resumed = session.run(["run", "resume", runId], {
      NEXORA_TEST_EXIT_AFTER_CHECKPOINT_PHASE: ""
    });
    expect(resumed.exitCode).toBe(0);
    const resumedPayload = parseJson(resumed.stdout);
    expect(resumedPayload.runId).toBe(runId);
    expect(resumedPayload.status).toBe("waiting_for_approval");
    expect(resumedPayload.recoveryAction).toBe("resume");

    const afterFirstResume = session.readDatabaseState();
    const executionRecordCount = afterFirstResume.executionRecords.length;
    const pendingApprovalId = String(resumedPayload.approvalId);
    expect(afterFirstResume.runs).toHaveLength(1);
    expect(afterFirstResume.executionRecords).toHaveLength(1);
    expect(afterFirstResume.events.map((event) => event.type)).toContain("recovery.reconciled");

    const duplicateResume = session.run(["run", "resume", runId]);
    expect(duplicateResume.exitCode).toBe(0);
    const duplicateResumePayload = parseJson(duplicateResume.stdout);
    expect(duplicateResumePayload.runId).toBe(runId);
    expect(duplicateResumePayload.status).toBe("waiting_for_approval");
    expect(duplicateResumePayload.approvalId).toBe(pendingApprovalId);
    expect(duplicateResumePayload.recoveryAction).toBe("wait");

    const afterDuplicateResume = session.readDatabaseState();
    expect(afterDuplicateResume.runs).toHaveLength(1);
    expect(afterDuplicateResume.runs[0]?.runId).toBe(runId);
    expect(afterDuplicateResume.executionRecords).toHaveLength(executionRecordCount);
    expect(afterDuplicateResume.agentIterations.length).toBe(afterFirstResume.agentIterations.length);
    expect(readFileSync(join(session.workspaceRoot, "note.txt"), "utf8")).toContain("after");

    const finalApprove = session.run(["approve", pendingApprovalId]);
    expect(finalApprove.exitCode).toBe(0);
    expect(finalApprove.stdout).toContain("Checkpoint recovery regression passed.");

    const finalState = session.readDatabaseState();
    expect(finalState.runs).toHaveLength(1);
    expect(finalState.runs[0]?.runId).toBe(runId);
    expect(finalState.runs[0]?.status).toBe("succeeded");
    expect(finalState.executionRecords).toHaveLength(2);
    expect(finalState.validationResults[0]?.result.status).toBe("passed");
    expect(readFileSync(join(session.workspaceRoot, "note.txt"), "utf8")).toContain("after");
  }, 120000);
});

function structuredPlanAction() {
  const now = new Date().toISOString();
  const node = process.execPath.replace(/\\/g, "/").split("/").pop() ?? process.execPath;
  return {
    type: "submit_execution_plan" as const,
    rationale: "Patch note.txt and validate checkpoint recovery.",
    plan: {
      targetFiles: ["note.txt"],
      intendedChanges: ["Replace before with after."],
      validationCommands: [`${node} verify.js`]
    },
    steps: [
      planStep(now, "cr009-mutate", "Patch note.txt", ["filesystem.patch"]),
      planStep(now, "cr009-validate", "Validate note.txt", ["shell.execute"])
    ]
  };
}

function planStep(now: string, stepId: string, description: string, requiredTools: string[]) {
  return {
    stepId,
    description,
    operation: "modify" as const,
    targetFiles: ["note.txt"],
    rationale: "CR-009 structured execution step.",
    expectedEffects: ["Checkpoint recovery remains idempotent."],
    requiredTools,
    required: true,
    status: "planned" as const,
    evidenceRefs: [],
    dependsOn: [],
    createdAt: now,
    updatedAt: now
  };
}

function parseJson(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}
