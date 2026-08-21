import { resolve } from "node:path";

import {
  createAgent,
  createBuiltInTools,
  openAICompatibleProviderFromEnv
} from "../../packages/harness/src/index.js";

const workspace = resolve("apps/research-agent");
const environment = {
  ...process.env,
  NEXORA_MODEL_NAME: "qwen3.7-flash",
  NEXORA_MODEL_DECISION_OUTPUT_TOKENS: "4096"
};
const provider = openAICompatibleProviderFromEnv(environment);
const readTool = createBuiltInTools().filter((tool) => tool.contract.identity.name === "filesystem.read");
if (readTool.length !== 1) throw new Error("The Qwen Multi-Agent canary requires filesystem.read.");

const runtime = createAgent({
  workspace,
  provider,
  tools: readTool,
  delegationPolicy: {
    mode: "required",
    maxConcurrentWorkers: 2,
    allowedProfiles: ["researcher"],
    workerToolPolicies: { researcher: ["filesystem.read"] }
  },
  hostPolicy: {
    schemaVersion: 1,
    id: "supervisor-real-qwen-multi-agent",
    version: "1",
    taskMode: "research",
    promptCache: "allow",
    instructions: [
      "Use exactly one exclusive nexora_delegate_workers call containing exactly two assignments.",
      "Set finalDeliverable to the requested evidence-based integration risk summary.",
      "Each assignment must set profileRef to researcher, state its specific contribution, and may use only filesystem.read.",
      "Do not list or search the workspace and do not modify files."
    ]
  }
});

try {
  const startedAt = Date.now();
  const result = await runtime.start({
    input: [
      "Use exactly two read-only Workers.",
      "Worker A: Read only src/scheduler.ts. Report three lifecycle/recovery observations with file references.",
      "Worker B: Read only src/tavily-source.ts. Report three request/retry/result-mapping observations with file references.",
      "After both Workers complete, compare their integration risks and produce one concise evidence-based summary that stands alone, covers both files, and distinguishes facts from inference.",
      "Do not modify files. Do not list or search the repository."
    ].join(" "),
    completion: { evidence: "optional", requiredToolNames: [] },
    budgets: {
      maxIterations: 12,
      maxModelCalls: 12,
      maxToolCalls: 4,
      maxRetries: 2,
      maxDurationMs: 8 * 60_000
    }
  });
  const parent = await runtime.inspect(result.runId);
  const branches = runtime.listBranches(result.runId);
  const children = await Promise.all(branches.map((branch) => runtime.inspect(branch.childRunId)));
  const accepted = parent.events.filter((event) => (
    event.type === "runtime.event" && event.payload.name === "workers.delegation.accepted"
  ));
  const delegated = parent.events.filter((event) => (
    event.type === "runtime.event" && event.payload.name === "workers.delegated"
  ));
  const rejectedDelegations = parent.events.filter((event) => (
    event.type === "response.rejected"
    && JSON.stringify(event.payload).includes("DELEGATION")
  ));
  const observations = runtime.listWorkerObservations(result.runId);
  const childTerminalAt = Math.max(...children.map((child) => Date.parse(child.snapshot.updatedAt)));
  const parentResumedAfterJoin = parent.modelCalls.some((call) => (
    Date.parse(call.startedAt) >= childTerminalAt
  ));
  const report = {
    provider: provider.modelProfile?.provider ?? "unknown",
    model: provider.modelProfile?.model ?? "unknown",
    runId: result.runId,
    status: result.status,
    stopReason: result.stopReason,
    summary: result.summary,
    latencyMs: Date.now() - startedAt,
    parentModelCalls: parent.modelCalls.length,
    parentToolCalls: parent.toolInvocations.length,
    tokens: parent.modelCalls.reduce((total, call) => total + (call.actualTotalTokens ?? 0), 0),
    cost: null,
    acceptedDelegations: accepted.length,
    completedDelegations: delegated.length,
    rejectedDelegations: rejectedDelegations.length,
    branchCount: branches.length,
    childCount: children.length,
    branchIds: branches.map((branch) => branch.branchId),
    childRunIds: branches.map((branch) => branch.childRunId),
    childStatuses: children.map((child) => child.snapshot.status),
    childToolNames: children.map((child) => child.toolInvocations.map((tool) => tool.toolName)),
    workerObservationCount: observations.length,
    workerSummaries: observations.map((observation) => observation.summary),
    quality: {
      finalSummaryLength: result.summary?.length ?? 0,
      mentionsScheduler: /scheduler/i.test(result.summary ?? ""),
      mentionsTavilySource: /tavily/i.test(result.summary ?? ""),
      comparesRisk: /risk|integration|difference/i.test(result.summary ?? ""),
      workersProducedFindings: observations.every((observation) => (observation.summary?.length ?? 0) > 40)
    },
    parentResumedAfterJoin,
    recoveryCount: parent.events.filter((event) => event.type === "run.reopened").length,
    finalDelivery: result.delivery
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const passed = report.model === "qwen3.7-flash"
    && result.status === "succeeded"
    && accepted.length === 1
    && delegated.length === 1
    && branches.length === 2
    && new Set(report.branchIds).size === 2
    && new Set(report.childRunIds).size === 2
    && children.every((child) => child.snapshot.status === "succeeded")
    && children.every((child) => child.toolInvocations.every((tool) => tool.toolName === "filesystem.read"))
    && observations.length === 2
    && parentResumedAfterJoin
    && report.quality.mentionsScheduler
    && report.quality.mentionsTavilySource
    && report.quality.comparesRisk
    && report.quality.workersProducedFindings;
  process.exitCode = passed ? 0 : 1;
} finally {
  await runtime.close();
}
