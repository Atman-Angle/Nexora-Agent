import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, createBuiltInTools, openAICompatibleProviderFromEnv } from "../../packages/harness/src/index.js";

const workspace = mkdtempSync(join(tmpdir(), "nexora-supervisor-real-coding-"));
writeFileSync(join(workspace, "config.json"), JSON.stringify({ version: 1, legacyMode: true }, null, 2));
writeFileSync(join(workspace, "verify.mjs"), "import assert from 'node:assert/strict'; import c from './config.json' with { type: 'json' }; assert.equal(c.version, 1); assert.equal(c.legacyMode, true); assert.equal(c.featureFlag, 'supervised'); console.log('coding canary passed');\n");

const provider = openAICompatibleProviderFromEnv({ ...process.env, NEXORA_MODEL_DECISION_OUTPUT_TOKENS: "4096" });
const tools = createBuiltInTools();
const executorTools = ["filesystem.read", "filesystem.write", "filesystem.patch", "shell.execute"];
const reviewerTools = ["filesystem.read"];
const runtime = createAgent({
  workspace,
  provider,
  tools,
  delegationPolicy: {
    mode: "required",
    maxConcurrentWorkers: 2,
    allowedProfiles: ["executor", "reviewer"],
    workerToolPolicies: { executor: executorTools, reviewer: reviewerTools },
    childBudgets: { maxIterations: 10, maxModelCalls: 10, maxToolCalls: 8, maxRetries: 1, maxDurationMs: 120_000 }
  },
  hostPolicy: {
    schemaVersion: 1,
    id: "supervisor-real-isolated-coding",
    version: "2",
    taskMode: "change",
    promptCache: "allow",
    instructions: [
      "On the first turn use one exclusive nexora_delegate_workers call with exactly two assignments.",
      "The executor assignment must use profileRef executor: inspect config.json, modify only its isolated Branch so featureFlag is supervised while preserving existing fields, and run node verify.mjs there.",
      "The reviewer assignment must use profileRef reviewer: independently inspect config.json and verify.mjs and report the preservation and acceptance constraints without writing.",
      "After Worker results join, inspect the Parent config.json, adopt the exact minimal change through a Parent filesystem.write or filesystem.patch Tool call, then run node verify.mjs in the Parent workspace.",
      "Only the Parent Tool Invocation and Evidence may authorize final completion. Do not claim the isolated Worker edit changed the Parent workspace."
    ]
  }
});

try {
  let result = await runtime.start({
    input: "Use an isolated Executor Worker plus an independent Reviewer, then adopt and verify featureFlag='supervised' in the Parent workspace without removing version or legacyMode.",
    budgets: { maxIterations: 20, maxModelCalls: 20, maxToolCalls: 12, maxRetries: 2, maxDurationMs: 5 * 60_000 }
  });

  for (let attempt = 0; attempt < 20 && !["succeeded", "failed", "cancelled"].includes(result.status); attempt += 1) {
    for (const branch of runtime.listBranches(result.runId)) {
      const childHandle = runtime.openRun(branch.childRunId);
      for (let childAttempt = 0; childAttempt < 10; childAttempt += 1) {
        const child = await runtime.inspect(branch.childRunId);
        if (child.snapshot.pendingRequest?.kind === "approval") {
          await childHandle.approve({ requestId: child.snapshot.pendingRequest.id });
          continue;
        }
        if (child.snapshot.pendingRequest?.kind === "input") {
          await childHandle.input("Continue the assigned isolated objective and report exact validation evidence.", {
            requestId: child.snapshot.pendingRequest.id
          });
          continue;
        }
        if (child.snapshot.status === "blocked" && child.snapshot.lastError?.code === "PROVIDER_UNAVAILABLE") {
          await childHandle.resume();
          continue;
        }
        break;
      }
    }
    const parent = await runtime.inspect(result.runId);
    if (parent.snapshot.pendingRequest?.kind === "approval") {
      result = await runtime.resume({
        runId: result.runId,
        approvalDecision: { requestId: parent.snapshot.pendingRequest.id, approved: true }
      });
    } else if (parent.snapshot.pendingRequest?.kind === "input") {
      result = await runtime.resume({ runId: result.runId, input: "Continue from the durable Worker results and complete Parent adoption and validation." });
    } else if (parent.snapshot.status === "blocked" && parent.snapshot.lastError?.code === "PROVIDER_UNAVAILABLE") {
      result = await runtime.resume({ runId: result.runId });
    } else {
      break;
    }
  }

  const parentView = await runtime.inspect(result.runId);
  const branches = runtime.listBranches(result.runId);
  const childViews = await Promise.all(branches.map((branch) => runtime.inspect(branch.childRunId)));
  const executorIndex = branches.findIndex((branch) => branch.lineage.at(-1)?.profileRef === "executor");
  const executorInvocations = executorIndex < 0 ? [] : childViews[executorIndex]!.toolInvocations;
  const config = JSON.parse(readFileSync(join(workspace, "config.json"), "utf8")) as Record<string, unknown>;
  const parentAdopted = parentView.toolInvocations.some((item) => (
    (item.toolName === "filesystem.write" || item.toolName === "filesystem.patch") && item.status === "succeeded"
  ));
  const parentValidated = parentView.toolInvocations.some((item) => item.toolName === "shell.execute" && item.status === "succeeded");
  const executorChangedIsolatedWorkspace = executorInvocations.some((item) => (
    (item.toolName === "filesystem.write" || item.toolName === "filesystem.patch") && item.status === "succeeded"
  ));
  const executorValidated = executorInvocations.some((item) => item.toolName === "shell.execute" && item.status === "succeeded");
  const passed = result.status === "succeeded"
    && config.version === 1
    && config.legacyMode === true
    && config.featureFlag === "supervised"
    && executorChangedIsolatedWorkspace
    && executorValidated
    && parentAdopted
    && parentValidated;
  console.log(JSON.stringify({
    status: result.status,
    stopReason: result.stopReason,
    branches: branches.map((branch) => ({ status: branch.status, profileRef: branch.lineage.at(-1)?.profileRef })),
    config,
    executorChangedIsolatedWorkspace,
    executorValidated,
    parentAdopted,
    parentValidated,
    parentEvidence: result.evidence.length,
    passed
  }));
  process.exitCode = passed ? 0 : 1;
} finally {
  await runtime.close();
  rmSync(workspace, { recursive: true, force: true });
}
