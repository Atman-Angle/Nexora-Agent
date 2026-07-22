import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { computeArtifactHash } from "../../packages/contracts/src/index.js";
import { createCliTestSession } from "../integration/cli-test-helper.js";

const fixturePath = "D:\\Nexora\\tests\\fixtures\\f006-multi-round";

function parseJson(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe("CR-008 Context Compaction", () => {
  it("emits context.compacted each iteration, regrounds after workspace change, and completes the run without corrupting the ledger", async () => {
    const session = await createCliTestSession({
      fixturePath,
      extraEnv: {
        NEXORA_FAKE_AGENT_SCRIPT_JSON: JSON.stringify([
          structuredPlanAction(),
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "cr008-read",
              toolName: "filesystem.read",
              input: { path: "src/math.js" },
              timeoutMs: 1000
            }
          },
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "cr008-patch",
              toolName: "filesystem.patch",
              input: {
                path: "src/math.js",
                expectedHash: computeArtifactHash("export function add() {\n  return 4;\n}\n"),
                patch: { type: "replace_text", find: "return 4;", replace: "return 5;" },
                encoding: "utf8",
                idempotencyKey: "cr008-patch"
              },
              timeoutMs: 1000
            }
          },
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "cr008-verify",
              toolName: "shell.execute",
              input: {
                command: process.execPath,
                args: ["verify.js"],
                cwd: ".",
                environment: {},
                purpose: "verification",
                idempotencyKey: "cr008-verify"
              },
              timeoutMs: 2000
            }
          },
          { type: "final", text: "Context compaction regression passed." }
        ])
      }
    });

    const result = session.run(["agent", "Fix the math test", process.execPath, "verify.js"]);
    expect(result.exitCode).toBe(0);
    const firstPayload = parseJson(result.stdout);
    expect(firstPayload.status).toBe("waiting_for_approval");

    const second = session.run(["approve", String(firstPayload.approvalId)]);
    expect(second.exitCode).toBe(0);
    const secondPayload = parseJson(second.stdout);
    expect(secondPayload.status).toBe("waiting_for_approval");

    const final = session.run(["approve", String(secondPayload.approvalId)]);
    expect(final.exitCode).toBe(0);
    expect(final.stdout).toContain("Context compaction regression passed.");

    const state = session.readDatabaseState();
    const eventTypes = state.events.map((event) => event.type);
    const compactedCount = eventTypes.filter((type) => type === "context.compacted").length;
    expect(compactedCount).toBeGreaterThanOrEqual(1);
    expect(eventTypes).toContain("context.regrounded");

    const regroundEvents = state.events.filter((event) => event.type === "context.regrounded");
    expect(regroundEvents.some((event) => (event.payload.reason as string | undefined) === "workspace_change")).toBe(true);

    expect(state.runs[0]?.status).toBe("succeeded");
    expect(state.ledgers[0]?.goal).toBe("Fix the math test");
    expect(state.ledgers[0]?.constraints.length).toBeGreaterThan(0);
    expect(state.ledgers[0]?.successCriteria.length).toBeGreaterThan(0);

    const ledgerVersion = state.ledgers[0]?.version;
    expect(ledgerVersion).toBeGreaterThan(0);
    expect(state.agentIterations.length).toBeGreaterThan(0);

    expect(state.ledgers).toHaveLength(1);
    expect(state.ledgers[0]?.runId).toBe(state.runs[0]?.runId);
  });

  it("regrounds on resume after approval and keeps the original goal intact across the wait boundary", async () => {
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
          structuredNotePlanAction(),
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "cr008-resume-patch",
              toolName: "filesystem.patch",
              input: {
                path: "note.txt",
                expectedHash: computeArtifactHash("before\n"),
                patch: { type: "replace_text", find: "before", replace: "after" },
                encoding: "utf8",
                idempotencyKey: "cr008-resume-patch"
              },
              timeoutMs: 1000
            }
          },
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "cr008-resume-verify",
              toolName: "shell.execute",
              input: {
                command: process.execPath,
                args: ["verify.js"],
                cwd: ".",
                environment: {},
                purpose: "verification",
                idempotencyKey: "cr008-resume-verify"
              },
              timeoutMs: 2000
            }
          },
          { type: "final", text: "Resume compaction regression passed." }
        ])
      }
    });

    const first = session.run(["agent", "Patch the note", process.execPath, "verify.js"]);
    const firstPayload = parseJson(first.stdout);
    expect(firstPayload.status).toBe("waiting_for_approval");

    const beforeResumeEvents = session.readDatabaseState().events.map((event) => event.type);
    expect(beforeResumeEvents).toContain("context.compacted");

    const approve = session.run(["approve", String(firstPayload.approvalId)]);
    expect(approve.exitCode).toBe(0);
    const approvePayload = parseJson(approve.stdout);
    expect(approvePayload.status).toBe("waiting_for_approval");

    const finalApprove = session.run(["approve", String(approvePayload.approvalId)]);
    expect(finalApprove.exitCode).toBe(0);
    expect(finalApprove.stdout).toContain("Resume compaction regression passed.");

    const state = session.readDatabaseState();
    const regroundEvents = state.events.filter((event) => event.type === "context.regrounded");
    expect(regroundEvents.some((event) => (event.payload.reason as string | undefined) === "resume")).toBe(true);

    expect(state.runs[0]?.status).toBe("succeeded");
    expect(state.ledgers[0]?.goal).toBe("Patch the note");
    expect(readFileSync(join(session.workspaceRoot, "note.txt"), "utf8")).toContain("after");

    const compactedAfterResume = state.events.filter((event) => event.type === "context.compacted").length;
    expect(compactedAfterResume).toBeGreaterThanOrEqual(2);
  });
});

function structuredPlanAction() {
  const now = new Date().toISOString();
  const node = process.execPath.replace(/\\/g, "/").split("/").pop() ?? process.execPath;
  return {
    type: "submit_execution_plan" as const,
    rationale: "Read, patch, and validate the math implementation.",
    plan: {
      targetFiles: ["src/math.js"],
      intendedChanges: ["Fix add() implementation."],
      validationCommands: [`${node} verify.js`]
    },
    steps: [
      planStep(now, "cr008-read", "Read src/math.js", ["filesystem.read"]),
      planStep(now, "cr008-mutate", "Patch src/math.js", ["filesystem.patch"]),
      planStep(now, "cr008-validate", "Validate src/math.js", ["shell.execute"])
    ]
  };
}

function structuredNotePlanAction() {
  const now = new Date().toISOString();
  const node = process.execPath.replace(/\\/g, "/").split("/").pop() ?? process.execPath;
  return {
    type: "submit_execution_plan" as const,
    rationale: "Patch note.txt and validate the resumed run.",
    plan: {
      targetFiles: ["note.txt"],
      intendedChanges: ["Replace before with after."],
      validationCommands: [`${node} verify.js`]
    },
    steps: [
      planStep(now, "cr008-mutate", "Patch note.txt", ["filesystem.patch"]),
      planStep(now, "cr008-validate", "Validate note.txt", ["shell.execute"])
    ]
  };
}

function planStep(now: string, stepId: string, description: string, requiredTools: string[]) {
  return {
    stepId,
    description,
    operation: "modify" as const,
    targetFiles: [description.includes("note") ? "note.txt" : "src/math.js"],
    rationale: "CR-008 structured execution step.",
    expectedEffects: ["The requested repair is applied."],
    requiredTools,
    required: true,
    status: "planned" as const,
    evidenceRefs: [],
    dependsOn: [],
    createdAt: now,
    updatedAt: now
  };
}
