import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
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
seedExistingDashboard(workspace);
const originalDigests = new Map([...ALLOWED_FILES].map((name) => [
  name,
  digestFile(join(workspace, name))
]));
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
      "Modify the existing frontend inside the workspace using real Tools; do not return implementation code as the final answer.",
      "Preserve the existing legacy hooks and incrementally patch index.html, styles.css, app.js and verify.mjs; do not replace the application with a new implementation.",
      "Do not claim completion until Tool observations prove the files exist and the verifier exits successfully."
    ]
  }
});

let approvalCount = 0;
try {
  let result = await runtime.start({
    input: [
      "Substantially evolve the existing operations dashboard without rewriting it.",
      "Keep the legacy brand, activity table, renderLegacyRows function and legacy-shell CSS hook, while adding a live system-status rail, saved filter views, multi-select bulk actions, an incident timeline drawer, density controls, a keyboard command palette, richer status filters, responsive mobile behavior and accessible focus handling.",
      "Patch all four existing files in place. Extend verify.mjs to check both the preserved legacy hooks and the new features, run node --check on app.js, then run node verify.mjs with shell.execute before finishing."
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
    bytes: existsSync(join(workspace, name)) ? readFileSync(join(workspace, name)).byteLength : 0,
    modified: existsSync(join(workspace, name))
      && digestFile(join(workspace, name)) !== originalDigests.get(name)
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
  const successfulAttempts = view.events.filter((event) => event.type === "tool.attempt.succeeded");
  const successfulInvocations = view.toolInvocations.filter((invocation) => invocation.status === "succeeded");
  const reusedAttempts = successfulAttempts.filter((event) => event.payload.physicalExecution === false);
  const invocationById = new Map(view.toolInvocations.map((invocation) => [invocation.id, invocation]));
  const readInvocations = view.toolInvocations.filter((invocation) => invocation.toolName === "filesystem.read");
  const physicalReadEvents = successfulAttempts.filter((event) => {
    const invocation = invocationById.get(String(event.payload.invocationId));
    return invocation?.toolName === "filesystem.read" && event.payload.physicalExecution !== false;
  });
  const perPath = (invocations: readonly typeof view.toolInvocations[number][]) => Object.fromEntries(
    [...ALLOWED_FILES].map((name) => [name, invocations.filter((invocation) => (
      invocation.toolName === "filesystem.read"
      && inputPath(invocation.inputJson) === name
    )).length])
  );
  const physicalReadsByPath = Object.fromEntries([...ALLOWED_FILES].map((name) => [
    name,
    physicalReadEvents.filter((event) => {
      const invocation = invocationById.get(String(event.payload.invocationId));
      return invocation !== undefined && inputPath(invocation.inputJson) === name;
    }).length
  ]));
  const planEvents = view.events.filter((event) => event.type === "plan.set");
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
    successfulToolInvocations: successfulInvocations.length,
    physicalToolExecutions: successfulInvocations.length - reusedAttempts.length,
    reusedToolExecutions: reusedAttempts.length,
    readInvocations: readInvocations.length,
    physicalReads: physicalReadEvents.length,
    readInvocationsByPath: perPath(readInvocations),
    physicalReadsByPath,
    reuseSources: successfulAttempts.flatMap((event) => (
      event.payload.physicalExecution === false
        ? [{
            invocationId: event.payload.invocationId,
            reusedFromInvocationId: event.payload.reusedFromInvocationId
          }]
        : []
    )),
    planSetEvents: planEvents.length,
    planNoOps: planEvents.filter((event) => event.payload.noOp === true).length,
    planVersion: view.snapshot.currentPlan?.version ?? null,
    evidenceRecords: view.snapshot.evidence.length,
    responseRejections: eventTypes.filter((type) => type === "response.rejected").length,
    approvals: approvalCount,
    files,
    syntaxExitCode: syntax.status,
    verificationExitCode: verification.status,
    verificationStdout: verification.stdout.trim().slice(0, 1_000),
    falseSuccess: result.status === "succeeded" && (
      view.toolInvocations.length === 0
      || files.some((file) => !file.exists || file.bytes < 100 || !file.modified)
      || !legacyHooksPreserved(workspace)
      || syntax.status !== 0
      || verification.status !== 0
    )
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (
    result.status !== "succeeded"
    || report.falseSuccess
    || files.some((file) => !file.exists || file.bytes < 100 || !file.modified)
    || !legacyHooksPreserved(workspace)
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

function seedExistingDashboard(root: string): void {
  writeFileSync(join(root, "index.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nexora Operations</title><link rel="stylesheet" href="styles.css"></head>
<body><div class="legacy-shell"><header><strong id="legacy-brand">Nexora Ops</strong><button id="theme-toggle">Theme</button></header><main><h1>Operations overview</h1><section class="kpis"><article>Availability <b>99.98%</b></article><article>Open incidents <b>4</b></article><article>Latency <b>142 ms</b></article><article>Deployments <b>18</b></article></section><label>Filter <input id="activity-filter"></label><table id="legacy-activity-table"><thead><tr><th>Service</th><th>Status</th><th>Owner</th></tr></thead><tbody id="activity-body"></tbody></table><p id="empty-state" hidden>No matching activity</p></main></div><script src="app.js"></script></body></html>`, "utf8");
  writeFileSync(join(root, "styles.css"), `:root{font-family:Inter,system-ui,sans-serif;color:#17202a;background:#f4f6f7}.legacy-shell{min-height:100vh}header{display:flex;justify-content:space-between;padding:1rem 2rem;background:#fff;border-bottom:1px solid #d5d8dc}main{max-width:1100px;margin:auto;padding:2rem}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem}.kpis article{padding:1rem;background:#fff;border:1px solid #d5d8dc;border-radius:6px}.kpis b{display:block;font-size:1.4rem}table{width:100%;margin-top:1rem;border-collapse:collapse;background:#fff}th,td{text-align:left;padding:.75rem;border-bottom:1px solid #e5e7e9}@media(max-width:700px){.kpis{grid-template-columns:1fr 1fr}main{padding:1rem}}`, "utf8");
  writeFileSync(join(root, "app.js"), `const legacyRows=[{service:"API",status:"Healthy",owner:"Platform"},{service:"Billing",status:"Investigating",owner:"Payments"},{service:"Search",status:"Healthy",owner:"Discovery"}];
function renderLegacyRows(query=""){const body=document.querySelector("#activity-body");const rows=legacyRows.filter(row=>Object.values(row).some(value=>value.toLowerCase().includes(query.toLowerCase())));body.innerHTML=rows.map(row=>\`<tr><td>\${row.service}</td><td>\${row.status}</td><td>\${row.owner}</td></tr>\`).join("");document.querySelector("#empty-state").hidden=rows.length>0;}
document.querySelector("#activity-filter").addEventListener("input",event=>renderLegacyRows(event.target.value));document.querySelector("#theme-toggle").addEventListener("click",()=>document.documentElement.toggleAttribute("data-dark"));renderLegacyRows();`, "utf8");
  writeFileSync(join(root, "verify.mjs"), `import { readFileSync } from "node:fs";import { spawnSync } from "node:child_process";const html=readFileSync("index.html","utf8"),css=readFileSync("styles.css","utf8"),js=readFileSync("app.js","utf8");const required=[[html,"legacy-brand"],[html,"legacy-activity-table"],[css,"legacy-shell"],[js,"renderLegacyRows"]];if(required.some(([text,hook])=>!text.includes(hook)))throw new Error("legacy hook missing");const syntax=spawnSync(process.execPath,["--check","app.js"]);if(syntax.status!==0)process.exit(syntax.status??1);console.log("baseline verifier passed");`, "utf8");
}

function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inputPath(value: unknown): string | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { readonly path?: unknown }).path === "string"
    ? (value as { readonly path: string }).path
    : null;
}

function legacyHooksPreserved(root: string): boolean {
  const sources = [...ALLOWED_FILES].map((name) => readFileSync(join(root, name), "utf8")).join("\n");
  return ["legacy-brand", "legacy-activity-table", "renderLegacyRows", "legacy-shell"]
    .every((hook) => sources.includes(hook));
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
