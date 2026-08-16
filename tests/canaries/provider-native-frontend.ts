import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgent,
  createBuiltInTools,
  openAICompatibleProviderFromEnv
} from "../../packages/harness/src/index.js";

const ALLOWED_FILES = new Set(["index.html", "styles.css", "app.js", "verify.mjs"]);
const transport = process.argv.includes("--transport")
  ? process.argv[process.argv.indexOf("--transport") + 1]
  : undefined;
if (transport !== "native_tools" && transport !== "structured_output") {
  throw new Error("Use --transport native_tools|structured_output.");
}

const workspace = mkdtempSync(join(tmpdir(), `nexora-provider-frontend-${transport}-`));
const environment = {
  ...process.env,
  NEXORA_MODEL_TOOL_TRANSPORT: transport
};
const provider = openAICompatibleProviderFromEnv(environment);
const runtime = createAgent({
  workspace,
  dataDir: join(workspace, ".nexora"),
  provider,
  tools: createBuiltInTools(),
  hostPolicy: {
    schemaVersion: 1,
    id: "provider-native-frontend-canary",
    version: "1",
    taskMode: "change",
    promptCache: "allow",
    instructions: [
      "Complete the requested frontend inside the workspace using real Tools; do not return implementation code as the final answer.",
      "Create index.html, styles.css, app.js and verify.mjs, then run node verify.mjs before finishing.",
      "Do not claim completion until Tool observations prove the files exist and the verifier exits successfully."
    ]
  }
});

let approvalCount = 0;
try {
  let result = await runtime.start({
    input: [
      "Build a polished, responsive operations analytics dashboard as a real frontend.",
      "It must include a collapsible navigation rail, four KPI summaries, a filterable activity table, an accessible modal for creating an incident, a light/dark theme toggle persisted in localStorage, responsive mobile navigation, keyboard Escape handling, empty state, and visible status indicators.",
      "Use semantic HTML, substantial CSS, and vanilla JavaScript. Create index.html, styles.css, app.js and verify.mjs. The verifier must check the required files and key UI hooks, run node --check on app.js, and exit nonzero on failure. Run node verify.mjs with shell.execute before finishing."
    ].join(" "),
    budgets: {
      maxIterations: 40,
      maxModelCalls: 40,
      maxToolCalls: 30,
      maxRetries: 3,
      maxDurationMs: 10 * 60_000
    }
  });

  for (let index = 0; index < 30 && result.status === "waiting"; index += 1) {
    const view = await runtime.inspect(result.runId);
    const pending = view.snapshot.pendingRequest;
    if (pending?.kind !== "approval" || pending.action === undefined) break;
    assertAllowedApproval(pending.action.toolName, pending.action.input);
    approvalCount += 1;
    result = await runtime.resume({
      runId: result.runId,
      approvalDecision: { requestId: pending.id, approved: true }
    });
  }
  const view = await runtime.inspect(result.runId);
  const files = [...ALLOWED_FILES].map((name) => ({
    name,
    exists: existsSync(join(workspace, name)),
    bytes: existsSync(join(workspace, name)) ? readFileSync(join(workspace, name)).byteLength : 0
  }));
  const syntax = spawnSync(process.execPath, ["--check", "app.js"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 30_000
  });
  const verification = spawnSync(process.execPath, ["verify.mjs"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 30_000
  });
  const eventTypes = view.events.map((event) => event.type);
  const report = {
    transport,
    provider: provider.modelProfile?.provider ?? "unknown",
    model: provider.modelProfile?.model ?? "unknown",
    runId: result.runId,
    status: result.status,
    stopReason: result.stopReason,
    summary: result.summary,
    modelCalls: view.modelCalls.length,
    modelCallUsage: view.modelCalls.map((call) => ({
      sequence: call.sequence,
      status: call.status,
      errorCode: call.errorCode,
      inputTokens: call.actualInputTokens,
      outputTokens: call.actualOutputTokens,
      totalTokens: call.actualTotalTokens
    })),
    toolInvocations: view.toolInvocations.length,
    toolNames: view.toolInvocations.map((invocation) => invocation.toolName),
    evidenceRecords: result.evidence.length,
    responseRejections: eventTypes.filter((type) => type === "response.rejected").length,
    approvals: approvalCount,
    files,
    syntaxExitCode: syntax.status,
    verificationExitCode: verification.status,
    verificationStdout: verification.stdout.trim().slice(0, 1_000),
    falseSuccess: result.status === "succeeded" && (
      view.toolInvocations.length === 0
      || files.some((file) => !file.exists || file.bytes < 100)
      || syntax.status !== 0
      || verification.status !== 0
    )
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (
    result.status !== "succeeded"
    || report.falseSuccess
    || files.some((file) => !file.exists || file.bytes < 100)
    || syntax.status !== 0
    || verification.status !== 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await runtime.close();
  if (process.env.NEXORA_FRONTEND_CANARY_KEEP !== "1") {
    rmSync(workspace, { recursive: true, force: true });
  } else {
    process.stderr.write(`Frontend canary workspace retained at ${workspace}\n`);
  }
}

function assertAllowedApproval(toolName: string, input: unknown): void {
  if (input === null || typeof input !== "object") throw new Error("Approval input must be an object.");
  const record = input as Record<string, unknown>;
  if (toolName === "filesystem.write" || toolName === "filesystem.patch") {
    if (typeof record.path !== "string" || !ALLOWED_FILES.has(record.path)) {
      throw new Error(`Canary refused write outside its allowlist: ${String(record.path)}`);
    }
    return;
  }
  if (toolName === "shell.execute") {
    const command = record.command;
    const args = record.args;
    const cwd = record.cwd;
    const allowedCommand = command === "node" || command === process.execPath;
    const allowedArgs = Array.isArray(args) && (
      (args.length === 1 && args[0] === "verify.mjs")
      || (args.length === 2 && args[0] === "--check" && args[1] === "app.js")
    );
    if (!allowedCommand || !allowedArgs || cwd !== ".") {
      throw new Error("Canary refused a shell command outside its Node verification allowlist.");
    }
    return;
  }
  throw new Error(`Canary refused protected Tool: ${toolName}`);
}
