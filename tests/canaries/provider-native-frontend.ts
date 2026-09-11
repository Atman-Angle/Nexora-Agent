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
  openAICompatibleProviderFromEnv,
  type ApprovalDecision,
  type RunResult
} from "../../packages/harness/src/index.js";

const ALLOWED_FILES = new Set(["index.html", "styles.css", "app.js", "verify.mjs"]);

/**
 * Static hooks proving the workspace really contains the requested dashboard instead of a
 * completion claim. Each entry is either a literal token the prompt makes unavoidable (the
 * stat labels, the status names, the sessionStorage contract, the responsive stylesheet) or a
 * matcher for a feature the prompt describes without naming. The status filter and the detail
 * view fall in the second group: the prompt asks for status filtering and for a project detail
 * drawer or modal but never fixes their identifiers, so a correct implementation is free to
 * use a chip group or a project-drawer / detail-panel container. Across real provider runs the
 * literal project-detail appeared in one of eight completed dashboards and the literal
 * status-filter in seven of eight, while all eight shipped both features; matching the
 * convention families keeps the gate honest without rejecting correct work.
 */
const DASHBOARD_HOOKS: readonly (string | RegExp)[] = [
  "sessionStorage",
  "Total Projects",
  "Completed",
  "Blocked",
  /status[-_]?filter|filter[-_]?status|statusFilter|data-status/,
  "sort",
  /project[-_]?detail|project[-_]?(drawer|modal|overlay|panel|sheet)|detail[-_]?(drawer|modal|overlay|dialog|panel|view)/,
  "project-form",
  "empty-state",
  "@media"
];

const transport = process.argv.includes("--transport")
  ? process.argv[process.argv.indexOf("--transport") + 1]
  : undefined;
if (transport !== "native_tools") {
  throw new Error("Use --transport native_tools.");
}

const resumeWorkspace = process.env.NEXORA_FRONTEND_CANARY_RESUME_WORKSPACE;
const workspace = resumeWorkspace ?? mkdtempSync(join(tmpdir(), `nexora-provider-frontend-${transport}-`));
if (resumeWorkspace === undefined) seedExistingDashboard(workspace);
const originalDigests = seedDigests();
const environment = {
  ...process.env,
  NEXORA_MODEL_CONNECT_TIMEOUT_MS: "600000",
  NEXORA_MODEL_TIMEOUT_MS: "600000"
};
const provider = openAICompatibleProviderFromEnv(environment);
const canaryTools = createBuiltInTools().filter((tool) => new Set([
  "filesystem.read",
  "filesystem.write",
  "filesystem.patch",
  "shell.execute"
]).has(tool.contract.identity.name));
const runtime = createAgent({
  workspace,
  dataDir: join(workspace, ".nexora"),
  provider,
  tools: canaryTools,
  hostPolicy: {
    schemaVersion: 1,
    id: "provider-native-frontend-canary",
    version: "1",
    taskMode: "change",
    promptCache: "allow",
    instructions: [
      "Build the requested frontend inside the workspace using real Tools; do not return implementation code as the final answer.",
      "Inspect and update index.html, styles.css, app.js and verify.mjs. Keep the dependency-free vanilla stack already present; do not add a framework or backend.",
      "Do not claim completion until Tool observations prove the files exist and the verifier exits successfully."
    ]
  }
});

let approvalCount = 0;
let deniedApprovals = 0;
let budgetExtensions = 0;
try {
  let result = resumeWorkspace === undefined
    ? await runtime.start({
        input: [
          "Create a polished, runnable Project Dashboard for managing local projects.",
          "Include a left navigation with Dashboard, Projects, Activity and Settings; a Projects header with search and New Project; statistics for Total Projects, Active, Completed and Blocked; and at least eight varied mock projects showing name, description, status, progress, updated time and tags.",
          "Implement working search, status filtering, updated-time sorting, project detail drawer or modal, and create/edit forms. Newly created and edited projects must remain available for the current browser session using sessionStorage.",
          "Make it desktop-first and responsive at common mobile widths with clear hover, selected, disabled and empty states, consistent spacing and typography, accessible labels, focus handling and keyboard dismissal for overlays.",
          "Update all four existing files, extend verify.mjs to assert these requirements, run node --check on app.js, then run node verify.mjs with shell.execute before finishing."
        ].join(" "),
        budgets: {
          maxIterations: 60,
          maxModelCalls: 60,
          maxToolCalls: 60,
          maxRetries: 3,
          maxDurationMs: 30 * 60_000
        }
      })
    : await resumeRetainedRun();

  for (let index = 0; index < 120; index += 1) {
    if (result.status === "waiting") {
      const view = await runtime.inspect(result.runId);
      const pending = view.snapshot.pendingRequest;
      if (pending?.kind !== "approval" || pending.action === undefined) break;
      const decision = decideApproval(pending.action.toolName, pending.action.input, pending.id);
      if (decision.approved) approvalCount += 1;
      else deniedApprovals += 1;
      result = await runtime.resume({ runId: result.runId, approvalDecision: decision });
      continue;
    }
    if (result.status === "blocked" && budgetExtensions < 4) {
      const view = await runtime.inspect(result.runId);
      if (view.snapshot.resumePredicate?.kind !== "budget_extension") break;
      budgetExtensions += 1;
      result = await runtime.resume({
        runId: result.runId,
        budgetExtension: { iterations: 20, modelCalls: 20, toolCalls: 20, retries: 1 }
      });
      continue;
    }
    break;
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
    resumed: resumeWorkspace !== undefined,
    approvals: approvalCount,
    deniedApprovals,
    budgetExtensions,
    files,
    syntaxExitCode: syntax.status,
    verificationExitCode: verification.status,
    verificationStdout: verification.stdout.trim().slice(0, 1_000),
    falseSuccess: result.status === "succeeded" && (
      view.toolInvocations.length === 0
      || files.some((file) => !file.exists || file.bytes < 100 || !file.modified)
      || !projectDashboardImplemented(workspace)
      || syntax.status !== 0
      || verification.status !== 0
    )
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (
    result.status !== "succeeded"
    || report.falseSuccess
    || files.some((file) => !file.exists || file.bytes < 100 || !file.modified)
    || !projectDashboardImplemented(workspace)
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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project Dashboard</title><link rel="stylesheet" href="styles.css"></head>
<body><div id="app-shell"><aside><strong>Nexora</strong><nav aria-label="Primary"><a href="#">Dashboard</a><a class="selected" href="#">Projects</a><a href="#">Activity</a><a href="#">Settings</a></nav></aside><main><header><div><p>Workspace</p><h1>Projects</h1></div><button id="new-project">New Project</button></header><section id="project-list" aria-live="polite"></section></main></div><script src="app.js"></script></body></html>`, "utf8");
  writeFileSync(join(root, "styles.css"), `:root{font-family:Inter,system-ui,sans-serif;color:#17202a;background:#f5f7f8}*{box-sizing:border-box}body{margin:0}#app-shell{display:grid;grid-template-columns:220px 1fr;min-height:100vh}aside{padding:2rem;background:#fff;border-right:1px solid #dfe3e6}nav{display:grid;gap:.5rem;margin-top:2rem}nav a{padding:.75rem;color:inherit;text-decoration:none;border-radius:.5rem}nav a.selected{background:#e8f0ed}main{padding:2rem}header{display:flex;align-items:center;justify-content:space-between}button{font:inherit}@media(max-width:700px){#app-shell{grid-template-columns:1fr}aside{display:none}main{padding:1rem}}`, "utf8");
  writeFileSync(join(root, "app.js"), `const starterProjects=[{id:"starter",name:"Starter workspace",description:"Replace this starter with the complete dashboard.",status:"Active",progress:20,updatedAt:"2026-09-10",tags:["Starter"]}];
function renderProjects(){document.querySelector("#project-list").innerHTML=starterProjects.map(project=>\`<article><h2>\${project.name}</h2><p>\${project.description}</p></article>\`).join("");}
document.querySelector("#new-project").addEventListener("click",()=>{});renderProjects();`, "utf8");
  writeFileSync(join(root, "verify.mjs"), `import { readFileSync } from "node:fs";import { spawnSync } from "node:child_process";const html=readFileSync("index.html","utf8"),css=readFileSync("styles.css","utf8"),js=readFileSync("app.js","utf8");const required=[[html,"Project Dashboard"],[html,"new-project"],[css,"@media"],[js,"renderProjects"]];if(required.some(([text,hook])=>!text.includes(hook)))throw new Error("starter hook missing");const syntax=spawnSync(process.execPath,["--check","app.js"]);if(syntax.status!==0)process.exit(syntax.status??1);console.log("starter verifier passed");`, "utf8");
}

/**
 * Digests of the untouched seed files. They are hashed in a throwaway probe directory so
 * that the same expectation also holds when the Canary resumes an already-edited workspace.
 */
function seedDigests(): ReadonlyMap<string, string> {
  const probe = mkdtempSync(join(tmpdir(), "nexora-provider-frontend-seed-"));
  try {
    seedExistingDashboard(probe);
    return new Map([...ALLOWED_FILES].map((name) => [name, digestFile(join(probe, name))]));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
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

function projectDashboardImplemented(root: string): boolean {
  const sources = [...ALLOWED_FILES].map((name) => readFileSync(join(root, name), "utf8")).join("\n");
  return DASHBOARD_HOOKS.every((hook) => (
    typeof hook === "string" ? sources.includes(hook) : hook.test(sources)
  ));
}

async function resumeRetainedRun(): Promise<RunResult> {
  const runs = await runtime.listRuns();
  const waiting = runs.find((run) => (
    run.status === "waiting_for_approval" && run.pendingRequestKind === "approval"
  ));
  if (waiting !== undefined) {
    const view = await runtime.inspect(waiting.runId);
    const pending = view.snapshot.pendingRequest;
    if (pending?.kind !== "approval" || pending.action === undefined) {
      throw new Error("The retained Run has no pending Tool Approval.");
    }
    const decision = decideApproval(pending.action.toolName, pending.action.input, pending.id);
    if (decision.approved) approvalCount += 1;
    else deniedApprovals += 1;
    return await runtime.resume({ runId: waiting.runId, approvalDecision: decision });
  }
  const blocked = runs.find((run) => run.status === "blocked");
  if (blocked !== undefined) {
    const view = await runtime.inspect(blocked.runId);
    if (view.snapshot.resumePredicate?.kind === "budget_extension") {
      budgetExtensions += 1;
      return await runtime.resume({
        runId: blocked.runId,
        budgetExtension: { iterations: 20, modelCalls: 20, toolCalls: 20, retries: 1 }
      });
    }
  }
  throw new Error("The retained workspace has no Run waiting for Approval or a Budget Extension.");
}

/**
 * The Canary Host decides every protected Tool Approval itself. An action outside the
 * allowlist is denied through the normal Approval channel so the Run still reaches a
 * reportable terminal state instead of killing the Canary before it writes anything.
 */
function decideApproval(toolName: string, input: unknown, requestId: string): ApprovalDecision {
  const violation = approvalViolation(toolName, input);
  return violation === null
    ? { requestId, approved: true }
    : { requestId, approved: false, reason: `Canary host policy refused ${toolName}: ${violation}` };
}

function approvalViolation(toolName: string, input: unknown): string | null {
  if (input === null || typeof input !== "object") return "the Tool input is not an object.";
  const record = input as Record<string, unknown>;
  if (toolName === "filesystem.write" || toolName === "filesystem.patch") {
    return typeof record.path === "string" && ALLOWED_FILES.has(record.path)
      ? null
      : `writes are limited to ${[...ALLOWED_FILES].join(", ")}.`;
  }
  if (toolName === "shell.execute") {
    if (record.command !== "node" && record.command !== process.execPath) {
      return "only the Node executable may be run.";
    }
    if (record.cwd !== ".") return 'the command must run with cwd ".".';
    const args = record.args;
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      return "command arguments must be strings.";
    }
    const argv = args as readonly string[];
    if (argv.length === 2 && argv[0] === "--check" && ALLOWED_FILES.has(argv[1] as string)) {
      return null;
    }
    if (!ALLOWED_FILES.has(argv[0] as string)) {
      return "only a workspace file may be run as a script.";
    }
    return argv.length <= 4 && argv.every((arg) => /^[\w.-]{1,64}$/.test(arg))
      ? null
      : "workspace script arguments must be short plain tokens.";
  }
  return `protected Tool ${toolName} is outside the Canary allowlist.`;
}
