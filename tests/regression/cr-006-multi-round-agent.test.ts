import { describe, expect, it } from "vitest";

import { computeArtifactHash } from "../../packages/contracts/src/index.js";
import { createCliTestSession } from "../integration/cli-test-helper.js";

const fixturePath = "D:\\Nexora\\tests\\fixtures\\f006-multi-round";

describe("CR-006 Multi-round Agent", () => {
  it("keeps the multi-round repair chain working", async () => {
    const session = await createCliTestSession({
      fixturePath,
      extraEnv: {
        NEXORA_FAKE_AGENT_SCRIPT_JSON: JSON.stringify([
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "cr-search-1",
              toolName: "filesystem.search",
              input: {
                query: "add",
                limit: 10
              },
              timeoutMs: 1000
            }
          },
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "cr-patch-1",
              toolName: "filesystem.patch",
              input: {
                path: "src/math.js",
                expectedHash: computeArtifactHash("export function add() {\n  return 4;\n}\n"),
                patch: {
                  type: "replace_text",
                  find: "return 4;",
                  replace: "return 5;"
                },
                encoding: "utf8",
                idempotencyKey: "cr-patch-1"
              },
              timeoutMs: 1000
            }
          },
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "cr-verify-1",
              toolName: "shell.execute",
              input: {
                command: process.execPath,
                args: ["verify.js"],
                cwd: ".",
                environment: {},
                purpose: "verification",
                idempotencyKey: "cr-verify-1"
              },
              timeoutMs: 2000
            }
          },
          {
            type: "final",
            text: "Regression fixture repaired."
          }
        ])
      }
    });

    const first = session.run(["agent", "Fix add() implementation", process.execPath, "verify.js"]);
    expect(first.exitCode).toBe(0);
    const firstPayload = parseJson(first.stdout);
    expect(firstPayload.status).toBe("waiting_for_approval");

    const second = session.run(["approve", String(firstPayload.approvalId)]);
    expect(second.exitCode).toBe(0);
    const secondPayload = parseJson(second.stdout);
    expect(secondPayload.status).toBe("waiting_for_approval");

    const result = session.run(["approve", String(secondPayload.approvalId)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Regression fixture repaired.");
    expect(session.readDatabaseState().agentIterations.length).toBeGreaterThanOrEqual(3);
  });
});

function parseJson(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}
