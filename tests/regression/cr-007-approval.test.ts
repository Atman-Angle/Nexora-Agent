import { describe, expect, it } from "vitest";

import { computeArtifactHash } from "../../packages/contracts/src/index.js";
import { createCliTestSession } from "../integration/cli-test-helper.js";

describe("CR-007 Approval", () => {
  it("keeps approval wait and resume working across the real CLI path", async () => {
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
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "cr-approval-patch",
              toolName: "filesystem.patch",
              input: {
                path: "note.txt",
                expectedHash: computeArtifactHash("before\n"),
                patch: {
                  type: "replace_text",
                  find: "before",
                  replace: "after"
                },
                encoding: "utf8",
                idempotencyKey: "cr-approval-patch"
              },
              timeoutMs: 1000
            }
          },
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "cr-approval-verify",
              toolName: "shell.execute",
              input: {
                command: process.execPath,
                args: ["verify.js"],
                cwd: ".",
                environment: {},
                purpose: "verification",
                idempotencyKey: "cr-approval-verify"
              },
              timeoutMs: 2000
            }
          },
          {
            type: "final",
            text: "Approval regression passed."
          }
        ])
      }
    });

    const first = parseJson(session.run(["agent", "Patch the note", process.execPath, "verify.js"]).stdout);
    expect(first.status).toBe("waiting_for_approval");

    const second = parseJson(session.run(["approve", String(first.approvalId)]).stdout);
    expect(second.status).toBe("waiting_for_approval");

    const result = session.run(["approve", String(second.approvalId)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Approval regression passed.");
  });
});

function parseJson(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}
