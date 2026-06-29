import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ValidationResultSchema,
  computeArtifactHash,
  createEvent,
  createProgressLedger,
  createRun,
  createTask,
  createTextArtifact
} from "../../packages/contracts/src/index.js";
import { runCompletionGate } from "../../packages/core/src/validation-gate.js";
import { createCliTestSession } from "../integration/cli-test-helper.js";

describe("CR-015 Goal Completion Integrity", () => {
  it("rejects a development final without fresh post-mutation validation", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "nexora-cr015-"));
    writeWorkspaceFile(workspaceRoot, "src/App.tsx", "export const App = () => null;\n");

    const task = createTask({
      taskId: "cr015-dev",
      text: "Implement the feature",
      taskType: "feature",
      validationRequest: {
        command: process.execPath,
        args: ["verify.js"],
        cwd: ".",
        environment: {},
        timeoutMs: 5000,
        purpose: "verification",
        idempotencyKey: "verify-1",
        validationPlan: {
          planId: "plan-1",
          validators: [{ validatorId: "exit-zero", type: "command_exit_code", required: true, expectedExitCode: 0 }]
        }
      },
      acceptanceCriteria: [{ id: "changed", description: "changed files", required: true, check: { type: "changed_files_non_empty" } }],
      createdAt: "2026-06-28T00:00:00.000Z"
    });
    const run = createRun({
      runId: "cr015-run-dev",
      taskId: task.taskId,
      createdAt: "2026-06-28T00:00:00.000Z",
      mode: "tool"
    });
    const artifact = createTextArtifact({
      artifactId: "artifact-dev",
      runId: run.runId,
      content: "done",
      createdAt: "2026-06-28T00:00:01.000Z"
    });
    const ledger = createProgressLedger({
      runId: run.runId,
      anchor: { goal: "Finish", constraints: [], successCriteria: [] },
      now: "2026-06-28T00:00:00.000Z"
    });
    ledger.planSteps = [
      {
        stepId: "step-1",
        description: "Patch App",
        required: true,
        status: "completed",
        evidenceRefs: ["e1"],
        createdAt: "2026-06-28T00:00:00.000Z",
        updatedAt: "2026-06-28T00:00:00.000Z"
      }
    ];

    const result = await runCompletionGate({
      run,
      task,
      ledger,
      toolResult: {
        toolCallId: "verify-call",
        toolName: "shell.execute",
        status: "success",
        output: {
          kind: "command_result",
          result: {
            exitCode: 0,
            signal: null,
            stdoutSummary: "ok",
            stderrSummary: "",
            durationMs: 10,
            timedOut: false,
            cancelled: false,
            executionRecordId: "execution-1"
          }
        }
      },
      latestValidationResult: ValidationResultSchema.parse({
        status: "passed",
        evidence: [],
        executedValidatorIds: ["exit-zero"],
        taskType: "feature",
        validationSequence: 2,
        validationCwd: ".",
        changedFiles: ["src/App.tsx"],
        workspaceFingerprint: computeArtifactHash(`src/App.tsx:${computeArtifactHash("export const App = () => null;\n")}`),
        acceptanceResults: [],
        artifactChecks: []
      }),
      finalArtifact: artifact,
      artifacts: [artifact],
      events: [
        createEvent({ eventId: "e1", runId: run.runId, sequence: 1, type: "validation.completed", timestamp: "2026-06-28T00:00:01.000Z", payload: { status: "passed" } }),
        createEvent({ eventId: "e2", runId: run.runId, sequence: 2, type: "patch.applied", timestamp: "2026-06-28T00:00:02.000Z", payload: { path: "src/App.tsx", changed: true } }),
        createEvent({ eventId: "e3", runId: run.runId, sequence: 3, type: "model.final.proposed", timestamp: "2026-06-28T00:00:03.000Z", payload: {} })
      ],
      workspaceRoot,
      now: "2026-06-28T00:00:03.000Z",
      idGenerator: () => "evidence-dev"
    });

    expect(result.validation.status).toBe("failed");
    expect(result.validation.evidence.some((entry) => entry.code === "VALIDATION_NOT_FRESH")).toBe(true);
  });

  it("rejects validation from the parent project cwd for a nested target", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "nexora-cr015-cwd-"));
    writeWorkspaceFile(workspaceRoot, "package.json", "{\"name\":\"root\"}\n");
    writeWorkspaceFile(workspaceRoot, "apps/web/package.json", "{\"name\":\"web\"}\n");
    writeWorkspaceFile(workspaceRoot, "apps/web/src/App.tsx", "export const App = () => null;\n");

    const task = createTask({
      taskId: "cr015-cwd",
      text: "Implement nested feature",
      taskType: "feature",
      validationRequest: {
        command: process.execPath,
        args: ["verify.js"],
        cwd: ".",
        environment: {},
        timeoutMs: 5000,
        purpose: "verification",
        idempotencyKey: "verify-nested",
        validationPlan: {
          planId: "plan-nested",
          validators: [{ validatorId: "exit-zero", type: "command_exit_code", required: true, expectedExitCode: 0 }]
        }
      },
      acceptanceCriteria: [{ id: "changed", description: "changed files", required: true, check: { type: "changed_files_non_empty" } }],
      createdAt: "2026-06-28T00:00:00.000Z"
    });
    const run = createRun({
      runId: "cr015-run-cwd",
      taskId: task.taskId,
      createdAt: "2026-06-28T00:00:00.000Z",
      mode: "tool"
    });
    const artifact = createTextArtifact({
      artifactId: "artifact-cwd",
      runId: run.runId,
      content: "done",
      createdAt: "2026-06-28T00:00:01.000Z"
    });

    const result = await runCompletionGate({
      run,
      task,
      ledger: createProgressLedger({ runId: run.runId, anchor: { goal: "Finish", constraints: [], successCriteria: [] }, now: "2026-06-28T00:00:00.000Z" }),
      toolResult: {
        toolCallId: "verify-call",
        toolName: "shell.execute",
        status: "success",
        output: {
          kind: "command_result",
          result: {
            exitCode: 0,
            signal: null,
            stdoutSummary: "ok",
            stderrSummary: "",
            durationMs: 10,
            timedOut: false,
            cancelled: false,
            executionRecordId: "execution-2"
          }
        }
      },
      latestValidationResult: ValidationResultSchema.parse({
        status: "passed",
        evidence: [],
        executedValidatorIds: ["exit-zero"],
        taskType: "feature",
        validationSequence: 3,
        validationCwd: ".",
        changedFiles: ["apps/web/src/App.tsx"],
        workspaceFingerprint: computeArtifactHash(`apps/web/src/App.tsx:${computeArtifactHash("export const App = () => null;\n")}`),
        acceptanceResults: [],
        artifactChecks: []
      }),
      finalArtifact: artifact,
      artifacts: [artifact],
      events: [
        createEvent({ eventId: "e1", runId: run.runId, sequence: 1, type: "patch.applied", timestamp: "2026-06-28T00:00:01.000Z", payload: { path: "apps/web/src/App.tsx", changed: true } }),
        createEvent({ eventId: "e2", runId: run.runId, sequence: 2, type: "validation.completed", timestamp: "2026-06-28T00:00:02.000Z", payload: { status: "passed" } }),
        createEvent({ eventId: "e3", runId: run.runId, sequence: 3, type: "model.final.proposed", timestamp: "2026-06-28T00:00:03.000Z", payload: {} })
      ],
      workspaceRoot,
      now: "2026-06-28T00:00:03.000Z",
      idGenerator: () => "evidence-cwd"
    });

    expect(result.validation.status).toBe("failed");
    expect(result.validation.evidence.some((entry) => entry.code === "VALIDATION_CWD_INVALID")).toBe(true);
  });

  it("rejects premature final, continues the loop, then accepts after real write and validation", async () => {
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
          { type: "final", text: "done too early" },
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "write-hero",
              toolName: "filesystem.write",
              input: {
                path: "src/Hero.tsx",
                content: "export const hero = true;\n",
                encoding: "utf8",
                mode: "create",
                idempotencyKey: "write-hero"
              },
              timeoutMs: 1000
            }
          },
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "verify-hero",
              toolName: "shell.execute",
              input: {
                command: process.execPath,
                args: ["verify.js"],
                cwd: ".",
                environment: {},
                purpose: "verification",
                idempotencyKey: "verify-hero"
              },
              timeoutMs: 2000
            }
          },
          { type: "final", text: "done for real" }
        ])
      }
    });

    const first = session.run(["agent", "Create Hero", process.execPath, "verify.js"]);
    const firstPayload = JSON.parse(first.stdout) as { approvalId: string; status: string };
    expect(firstPayload.status).toBe("waiting_for_approval");

    const second = session.run(["approve", firstPayload.approvalId]);
    const secondPayload = JSON.parse(second.stdout) as { approvalId: string; status: string };
    expect(secondPayload.status).toBe("waiting_for_approval");

    const third = session.run(["approve", secondPayload.approvalId]);
    expect(third.exitCode).toBe(0);

    const state = session.readDatabaseState();
    expect(state.runs[0]?.status).toBe("succeeded");
    expect(state.events.map((event) => event.type)).toContain("model.final.rejected");
    expect(state.events.map((event) => event.type)).toContain("model.final.accepted");
  });

  it("allows read-only completion without forcing file mutations", async () => {
    const task = createTask({
      taskId: "cr015-read",
      text: "Summarize repository",
      taskType: "read_only",
      createdAt: "2026-06-28T00:00:00.000Z"
    });
    const run = createRun({
      runId: "cr015-run-read",
      taskId: task.taskId,
      createdAt: "2026-06-28T00:00:00.000Z",
      mode: "tool"
    });
    const artifact = createTextArtifact({
      artifactId: "artifact-read",
      runId: run.runId,
      content: "Repository summary.",
      createdAt: "2026-06-28T00:00:01.000Z"
    });

    const result = await runCompletionGate({
      run,
      task,
      toolResult: null,
      latestValidationResult: null,
      finalArtifact: artifact,
      artifacts: [artifact],
      events: [createEvent({ eventId: "e1", runId: run.runId, sequence: 1, type: "model.final.proposed", timestamp: "2026-06-28T00:00:01.000Z", payload: {} })],
      now: "2026-06-28T00:00:01.000Z",
      idGenerator: () => "evidence-read"
    });

    expect(result.validation.status).toBe("passed");
  });

  it("react-style fixture rejects directory-only work, then accepts after real file creation and build", async () => {
    const session = await createCliTestSession({
      workspaceFiles: [
        {
          relativePath: "package.json",
          content: JSON.stringify({
            name: "react-fixture",
            private: true,
            scripts: {
              build: "node build.js"
            }
          }, null, 2)
        },
        {
          relativePath: "build.js",
          content: [
            "const { readFileSync } = require('node:fs');",
            "const hero = readFileSync('src/components/Hero.tsx', 'utf8');",
            "const app = readFileSync('src/App.tsx', 'utf8');",
            "if (!hero.includes('Hero')) process.exit(1);",
            "if (!app.includes('Hero')) process.exit(1);",
            "console.log('build ok');"
          ].join("\n")
        },
        {
          relativePath: "src/App.tsx",
          content: "export default function App() {\n  return <main>Placeholder</main>;\n}\n"
        }
      ],
      extraEnv: {
        NEXORA_FAKE_AGENT_SCRIPT_JSON: JSON.stringify([
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "mkdir-components",
              toolName: "shell.execute",
              input: {
                command: process.execPath,
                args: ["-e", "require('node:fs').mkdirSync('src/components', { recursive: true })"],
                cwd: ".",
                environment: {},
                purpose: "prepare directory",
                idempotencyKey: "mkdir-components"
              },
              timeoutMs: 2000
            }
          },
          { type: "final", text: "Directory created, task complete." },
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "write-hero",
              toolName: "filesystem.write",
              input: {
                path: "src/components/Hero.tsx",
                content: "export function Hero() {\n  return <section>Hero</section>;\n}\n",
                encoding: "utf8",
                mode: "create",
                idempotencyKey: "write-hero"
              },
              timeoutMs: 1000
            }
          },
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "overwrite-app",
              toolName: "filesystem.write",
              input: {
                path: "src/App.tsx",
                content: "import { Hero } from './components/Hero';\nexport default function App() {\n  return <main><Hero /></main>;\n}\n",
                encoding: "utf8",
                mode: "overwrite",
                expectedHash: computeArtifactHash("export default function App() {\n  return <main>Placeholder</main>;\n}\n"),
                idempotencyKey: "overwrite-app"
              },
              timeoutMs: 1000
            }
          },
          {
            type: "tool_call",
            toolCall: {
              toolCallId: "build-fixture",
              toolName: "shell.execute",
              input: {
                command: process.execPath,
                args: ["build.js"],
                cwd: ".",
                environment: {},
                purpose: "build",
                idempotencyKey: "build-fixture"
              },
              timeoutMs: 2000
            }
          },
          { type: "final", text: "React fixture completed." }
        ])
      }
    });

    const first = session.run(["agent", "Build the React fixture", process.execPath, "build.js"]);
    const firstPayload = JSON.parse(first.stdout) as { approvalId: string; status: string };
    expect(firstPayload.status).toBe("waiting_for_approval");

    const second = session.run(["approve", firstPayload.approvalId]);
    const secondPayload = JSON.parse(second.stdout) as { approvalId: string; status: string };
    expect(secondPayload.status).toBe("waiting_for_approval");

    const third = session.run(["approve", secondPayload.approvalId]);
    const thirdPayload = JSON.parse(third.stdout) as { approvalId: string; status: string };
    expect(thirdPayload.status).toBe("waiting_for_approval");

    const fourth = session.run(["approve", thirdPayload.approvalId]);
    const fourthPayload = JSON.parse(fourth.stdout) as { approvalId: string; status: string };
    expect(fourthPayload.status).toBe("waiting_for_approval");

    const fifth = session.run(["approve", fourthPayload.approvalId]);
    expect(fifth.exitCode).toBe(0);

    const state = session.readDatabaseState();
    const rejected = state.events.filter((event) => event.type === "model.final.rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(state.runs[0]?.status).toBe("succeeded");
  });
});

function writeWorkspaceFile(workspaceRoot: string, relativePath: string, content: string) {
  const absolutePath = join(workspaceRoot, ...relativePath.split("/"));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}
