import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ToolCallSchema, computeArtifactHash } from "../../packages/contracts/src/index.js";
import { buildModelToolSchemaText } from "../../packages/model-gateway/src/model-tool-definition.js";
import { createCliTestSession } from "../integration/cli-test-helper.js";

describe("CR-014 Safe Filesystem Write", () => {
  it("contract and model schema both expose filesystem.write with create/overwrite semantics", () => {
    expect(() =>
      ToolCallSchema.parse({
        toolCallId: "write-create",
        toolName: "filesystem.write",
        input: {
          path: "src/Hero.tsx",
          content: "export const hero = true;\n",
          encoding: "utf8",
          mode: "create",
          idempotencyKey: "write-create"
        },
        timeoutMs: 1000
      })
    ).not.toThrow();

    expect(() =>
      ToolCallSchema.parse({
        toolCallId: "write-overwrite",
        toolName: "filesystem.write",
        input: {
          path: "src/App.tsx",
          content: "export const app = true;\n",
          encoding: "utf8",
          mode: "overwrite",
          expectedHash: computeArtifactHash("before\n"),
          idempotencyKey: "write-overwrite"
        },
        timeoutMs: 1000
      })
    ).not.toThrow();

    const onlyRead = buildModelToolSchemaText(["filesystem.read"]);
    expect(onlyRead).not.toContain('toolName: "filesystem.write"');

    const readAndWrite = buildModelToolSchemaText(["filesystem.read", "filesystem.write"]);
    expect(readAndWrite).toContain('toolName: "filesystem.write"');
    expect(readAndWrite).toContain('"create" | "overwrite"');
    expect(readAndWrite).toContain("requires expectedHash");
  });

  it("agent loop uses filesystem.write with approval and reaches success after verification", async () => {
    const session = await createCliTestSession({
      workspaceFiles: [
        {
          relativePath: "verify.js",
          content: [
            "const { readFileSync } = require('node:fs');",
            "const content = readFileSync('src/Hero.tsx', 'utf8');",
            "if (!content.includes('hero = true')) process.exit(1);"
          ].join("\n")
        }
      ],
      extraEnv: {
        NEXORA_FAKE_AGENT_SCRIPT_JSON: JSON.stringify([
          {
            type: "update_plan",
            reason: "Plan the safe write regression.",
            patch: {
              currentStep: "Create src/Hero.tsx",
              appendPlannedSteps: ["Create src/Hero.tsx", "Run node verify.js"]
            }
          },
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "cr014-write",
              toolName: "filesystem.write",
              input: {
                path: "src/Hero.tsx",
                content: "export const hero = true;\n",
                encoding: "utf8",
                mode: "create",
                idempotencyKey: "cr014-write"
              },
              timeoutMs: 1000
            }
          },
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "cr014-verify",
              toolName: "shell.execute",
              input: {
                command: process.execPath,
                args: ["verify.js"],
                cwd: ".",
                environment: {},
                purpose: "verification",
                idempotencyKey: "cr014-verify"
              },
              timeoutMs: 2000
            }
          },
          {
            type: "final",
            text: "filesystem.write path completed safely."
          }
        ])
      }
    });

    const first = session.run(["agent", "Create Hero file", process.execPath, "verify.js"]);
    expect(first.exitCode).toBe(0);
    const firstPayload = JSON.parse(first.stdout) as { approvalId: string; status: string };
    expect(firstPayload.status).toBe("waiting_for_approval");

    const second = session.run(["approve", firstPayload.approvalId]);
    expect(second.exitCode).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as { approvalId: string; status: string };
    expect(secondPayload.status).toBe("waiting_for_approval");

    const final = session.run(["approve", secondPayload.approvalId]);
    expect(final.exitCode).toBe(0);
    expect(final.stdout).toContain("filesystem.write path completed safely.");

    const state = session.readDatabaseState();
    expect(state.runs[0]?.status).toBe("succeeded");
    expect(state.executionRecords.some((record) => record.toolName === "filesystem.write")).toBe(true);
    expect(state.approvals[0]?.request.requestedCapabilities).toEqual(["filesystem.write"]);
    expect(readFileSync(join(session.workspaceRoot, "src", "Hero.tsx"), "utf8")).toBe("export const hero = true;\n");
  });

  it("agent loop no longer hardcodes ALL_TOOL_NAMES for availableTools", () => {
    const source = readFileSync(join(process.cwd(), "packages", "core", "src", "agent-loop-runner.ts"), "utf8");
    expect(source).toContain("const availableTools = input.toolRuntime.getAvailableTools()");
    expect(source).not.toContain("availableTools: ALL_TOOL_NAMES");
  });
});
