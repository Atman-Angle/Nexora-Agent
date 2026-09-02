import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runBench } from "./runner.ts";

const benchRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(benchRoot, "..", "..");
const manifestPath = resolve(benchRoot, "datasets", "nexora-core-v1", "dataset.json");
const corePath = resolve(benchRoot, "stress-tasks", "core-v1.json");
const fromRoot = option("--from");
const requestedRepeats = positiveInteger(option("--runs") ?? "5", "--runs");
const selected = options("--task");
const core = JSON.parse(readFileSync(corePath, "utf8"));
const taskIds = selected.length === 0 ? core.tasks : selected;
const now = new Date().toISOString();
const outputRoot = resolve(fromRoot ?? option("--output") ?? join(
  benchRoot,
  "reliability-reports",
  now.replaceAll(":", "-").replace(".", "-")
));
mkdirSync(outputRoot, { recursive: true });

const progressPath = join(outputRoot, "progress.json");
const existing = fromRoot === undefined ? null : JSON.parse(readFileSync(progressPath, "utf8"));
const createdAt = existing?.createdAt ?? now;
const source = existing?.source ?? sourceIdentity();
const repeats = existing?.repeatsCompleted ?? requestedRepeats;
const reportPaths = existing?.reportPaths ?? [];
if (fromRoot === undefined) {
  for (let index = 1; index <= repeats; index += 1) {
    if (JSON.stringify(sourceIdentity()) !== JSON.stringify(source)) {
      throw new Error(`Worktree source changed before repeat ${index}; refusing to mix configurations.`);
    }
    const runDirectory = join(outputRoot, `repeat-${String(index).padStart(2, "0")}`);
    process.stdout.write(`[reliability] repeat ${index}/${repeats}\n`);
    const result = await runBench({
      manifestPath,
      outputRoot: runDirectory,
      taskIds,
      keepWorkspaces: true,
      providerMode: "real"
    });
    reportPaths.push(result.reportPath);
    writeJson(progressPath, {
      schemaVersion: 1,
      createdAt,
      source,
      repeatsRequested: repeats,
      repeatsCompleted: index,
      taskIds,
      reportPaths
    });
  }
}

const summary = aggregate(reportPaths, source);
writeJson(join(outputRoot, "reliability-report.json"), summary);
process.stdout.write(`${JSON.stringify({
  outputRoot,
  reportPath: join(outputRoot, "reliability-report.json"),
  repeats,
  taskCount: taskIds.length,
  runCount: repeats * taskIds.length,
  strictPassRate: summary.overall.strictPassRate,
  falseSuccessRate: summary.overall.falseSuccessRate
}, null, 2)}\n`);

function aggregate(paths, expectedSource) {
  const overridesPath = join(outputRoot, "boundary-overrides.json");
  const boundaryOverrides = existsSync(overridesPath)
    ? JSON.parse(readFileSync(overridesPath, "utf8")).overrides
    : {};
  const reports = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
  const datasetKeys = new Set(reports.map((report) => JSON.stringify(report.dataset)));
  if (datasetKeys.size !== 1) throw new Error("Reliability reports do not share one Dataset identity.");
  const sourceKeys = new Set(reports.map((report) => JSON.stringify(report.source)));
  if (sourceKeys.size !== 1) throw new Error("Reliability reports do not share one Git source identity.");
  const observations = reports.flatMap((report, repeatIndex) => report.tasks.map((task) => {
    const runDirectory = dirname(paths[repeatIndex]);
    return enrich(
      task,
      join(runDirectory, "run-data", task.taskId, "runtime-v1.1.db"),
      repeatIndex + 1,
      boundaryOverrides[`${repeatIndex + 1}:${task.taskId}`]
    );
  }));
  const byTask = Object.fromEntries(taskIds.map((taskId) => {
    const taskRuns = observations.filter((item) => item.taskId === taskId);
    return [taskId, taskSummary(taskRuns)];
  }));
  return {
    schemaVersion: 1,
    benchmarkId: "nexora-stress-reliability",
    createdAt,
    dataset: reports[0].dataset,
    source: expectedSource,
    provider: providerIdentity(reports),
    repeats,
    taskIds,
    runCount: observations.length,
    overall: summarize(observations),
    boundaryDistribution: distribution(observations.filter((item) => !item.passed).map((item) => item.boundary)),
    secondaryBoundaryDistribution: distribution(observations.filter((item) => !item.passed).flatMap((item) => item.secondaryBoundaries)),
    terminalDistribution: distribution(observations.map((item) => item.terminal)),
    tasks: byTask,
    runs: observations
  };
}

function enrich(task, databasePath, repeat, boundaryOverride) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const invocations = database.prepare(`
      select rowid as ordinal, tool_name as toolName, input_json as inputJson,
        status, error_json as errorJson
      from tool_invocations order by rowid
    `).all();
    const events = database.prepare(`
      select sequence, type, payload_json as payloadJson
      from run_events order by sequence
    `).all();
    const providerAttempts = database.prepare(`select status from provider_attempts`).all();
    const failureEvents = events.filter((event) => ["tool.failed", "validation.failed", "response.rejected"].includes(event.type));
    const progressEvents = events.filter((event) => [
      "tool.succeeded", "context.evidence_recorded", "validation.passed", "run.succeeded",
      "recovery.confirmed_succeeded", "recovery.confirmed_failed", "recovery.abandoned"
    ].includes(event.type));
    const repairAttempts = failureEvents.filter((failure) => events.some((event) => (
      event.sequence > failure.sequence && event.type === "model.turn"
    ))).length;
    const repairedFailures = failureEvents.filter((failure) => progressEvents.some((event) => (
      event.sequence > failure.sequence
    ))).length;
    const switches = strategySwitches(invocations);
    const responseRejections = events.filter((event) => event.type === "response.rejected");
    const exactStrategies = invocations.map((item) => `${item.toolName}:${item.inputJson}`);
    const repeatedStrategies = exactStrategies.filter((value, index) => exactStrategies.indexOf(value) !== index).length;
    const failedTools = invocations.filter((item) => item.status === "failed" || item.status === "unknown");
    const terminal = task.actualTerminal;
    const attribution = classifyAttribution(task, events, invocations, providerAttempts);
    return {
      repeat,
      taskId: task.taskId,
      runId: task.runId,
      passed: task.passed,
      independentTaskSuccess: task.taskPassed,
      runtimeValidatedSuccess: task.nexoraValidated,
      authorityPass: task.authorityGrade.passed,
      falseSuccess: task.falseSuccess,
      terminal,
      boundary: task.passed ? null : boundaryOverride ?? attribution.firstBrokenBoundary,
      firstBrokenBoundary: task.passed ? null : boundaryOverride ?? attribution.firstBrokenBoundary,
      secondaryBoundaries: task.passed ? [] : attribution.secondaryBoundaries,
      stopReason: task.diagnostics.stopReason,
      modelCalls: task.authorityGrade.metrics.modelCalls,
      toolCalls: task.authorityGrade.metrics.invocations,
      evidenceCount: task.authorityGrade.metrics.evidence,
      approvalCount: task.diagnostics.approvalRequestedCount,
      failedToolInvocations: failedTools.length,
      repeatedToolStrategies: repeatedStrategies,
      toolBudgetExhausted: task.diagnostics.stopReason === "TOOL_CALL_BUDGET_EXCEEDED",
      failureObservations: failureEvents.length,
      repairAttempts,
      repairedFailures,
      strategySwitches: switches.count,
      successfulStrategySwitches: switches.succeeded,
      noProgressWarnings: events.filter((event) => (
        event.type === "runtime.event" && event.payloadJson.includes("execution.no_progress.warning")
      )).length,
      convergenceBlocked: terminal === "blocked" && task.diagnostics.stopReason === "NO_PROGRESS_DETECTED",
      invalidResponses: responseRejections.length,
      toolContractViolations: failedTools.filter((item) => contractViolationCode(errorCode(item.errorJson))).length,
      finalControlRejections: responseRejections.filter((event) => event.payloadJson.includes("FINAL_CONTROL_REQUIRED")).length,
      providerAttempts: providerAttempts.length,
      failedProviderAttempts: providerAttempts.filter((item) => item.status !== "succeeded").length,
      environmentFailure: task.firstBrokenBoundary === "EVAL_INFRASTRUCTURE" || task.telemetryErrors.length > 0,
      durationMs: task.durationMs
    };
  } finally {
    database.close();
  }
}

function classifyAttribution(task, events, invocations, providerAttempts) {
  const candidates = [];
  const add = (sequence, boundary) => candidates.push({ sequence: sequence ?? Number.MAX_SAFE_INTEGER, boundary });
  const payload = (event) => {
    try { return JSON.parse(event.payloadJson); } catch { return {}; }
  };
  if (task.telemetryErrors.length > 0 || task.firstBrokenBoundary === "EVAL_INFRASTRUCTURE") add(0, "ENVIRONMENT");
  if (task.actualTerminal === "waiting_for_approval" || task.firstBrokenBoundary === "APPROVAL") add(firstSequence(events, ["approval.requested", "approval.denied"]), "APPROVAL");
  if (task.authorityGrade.metrics.unauthorizedEffects > 0) add(firstSequence(events, ["approval.requested", "approval.denied"]), "APPROVAL");

  for (const event of events.filter((item) => item.type === "provider.attempt.failed")) {
    const value = payload(event);
    const category = String(value.errorCategory ?? "");
    add(event.sequence, category.includes("CONNECT") || category.includes("TIMEOUT") || category.includes("HTTP")
      ? "TRANSPORT_EXTERNAL"
      : category.includes("RESPONSE") || category.includes("PROTOCOL") ? "PROVIDER_PROTOCOL" : "UNKNOWN");
  }
  for (const event of events.filter((item) => item.type === "response.rejected")) {
    const text = event.payloadJson;
    if (text.includes("TASK_CONTRACT_REQUIRED") || text.includes("MUTATION_VERIFICATION_REQUIRED") || text.includes("PLAN_UNCHANGED")) add(event.sequence, "PLAN");
    else if (text.includes("FINAL_CONTROL_REQUIRED")) add(event.sequence, "MODEL_PROTOCOL");
    else if (text.includes("CHECK_UNSATISFIED") || text.includes("STEP_INCOMPLETE")) add(event.sequence, "COMPLETION_CONTRACT");
    else add(event.sequence, "MODEL_PROTOCOL");
  }
  for (const event of events.filter((item) => item.type === "validation.failed")) add(event.sequence, "VALIDATION");
  for (const item of invocations.filter((value) => value.status === "failed" || value.status === "unknown")) {
    const sequence = firstSequence(events, ["tool.failed", "tool.attempt.failed"], item.toolName);
    add(sequence, contractViolationCode(errorCode(item.errorJson)) ? "TOOL_CONTRACT" : "TOOL_EXECUTION");
  }
  if (task.diagnostics.stopReason === "TOOL_CALL_BUDGET_EXCEEDED") add(firstSequence(events, ["run.blocked", "run.failed"]), "TOOL_BUDGET");
  if (task.diagnostics.stopReason === "NO_PROGRESS_DETECTED") {
    const repeated = events.find((event) => event.type === "run.blocked" && event.payloadJson.includes("repeated_invalid_response"));
    const warning = events.find((event) => event.type === "runtime.event" && event.payloadJson.includes("execution.no_progress.warning"));
    if (repeated !== undefined || warning !== undefined) add((repeated ?? warning).sequence, "CONVERGENCE");
  }
  if (task.falseSuccess) add(firstSequence(events, ["run.succeeded"]), "COMPLETION_CONTRACT");
  if (task.hardGateFailures?.includes("scenario_authority")) {
    if (candidates.length === 0) add(0, "TASK_CONTRACT");
    else candidates.push({ sequence: Number.MAX_SAFE_INTEGER, boundary: "TASK_CONTRACT" });
  }
  if (candidates.length === 0) {
    const sourceMap = { CONTEXT_RECALL: "CONTEXT", PLAN_OR_INTENT: "PLAN", COMPLETION: "COMPLETION_CONTRACT", PROVIDER_EXTERNAL: "UNKNOWN", TOOL_EXECUTION: "TOOL_EXECUTION" };
    add(0, sourceMap[task.firstBrokenBoundary] ?? "UNKNOWN");
  }
  candidates.sort((left, right) => left.sequence - right.sequence);
  const first = candidates[0].boundary;
  return { firstBrokenBoundary: first, secondaryBoundaries: [...new Set(candidates.slice(1).map((item) => item.boundary).filter((item) => item !== first))] };
}

function firstSequence(events, types, toolName) {
  return events.find((event) => types.includes(event.type) && (toolName === undefined || event.payloadJson.includes(`"toolName":"${toolName}"`)))?.sequence ?? Number.MAX_SAFE_INTEGER;
}

function strategySwitches(invocations) {
  let count = 0;
  let succeeded = 0;
  for (let index = 0; index < invocations.length; index += 1) {
    const failed = invocations[index];
    if (failed.status !== "failed" && failed.status !== "unknown") continue;
    const next = invocations[index + 1];
    if (next === undefined) continue;
    if (`${failed.toolName}:${failed.inputJson}` === `${next.toolName}:${next.inputJson}`) continue;
    count += 1;
    if (next.status === "succeeded") succeeded += 1;
  }
  return { count, succeeded };
}

function taskSummary(runs) {
  const strictSuccessRate = rate(runs, (item) => item.passed);
  const falseSuccessRate = rate(runs, (item) => item.falseSuccess);
  return {
    runs: runs.length,
    stability: strictSuccessRate === 1 && falseSuccessRate === 0
      ? "Stable"
      : strictSuccessRate >= 0.8 && falseSuccessRate === 0
        ? "Mostly stable"
        : strictSuccessRate === 0
          ? "Systematically failing"
          : "Flaky",
    strictSuccessRate,
    passAt1: strictSuccessRate,
    repeatedRunVariance: strictSuccessRate * (1 - strictSuccessRate),
    independentTaskSuccessRate: rate(runs, (item) => item.independentTaskSuccess),
    runtimeValidatedSuccessRate: rate(runs, (item) => item.runtimeValidatedSuccess),
    authorityPassRate: rate(runs, (item) => item.authorityPass),
    falseSuccessRate,
    terminalDistribution: distribution(runs.map((item) => item.terminal)),
    boundaryDistribution: distribution(runs.filter((item) => !item.passed).map((item) => item.boundary)),
    modelCalls: numeric(runs.map((item) => item.modelCalls)),
    toolCalls: numeric(runs.map((item) => item.toolCalls)),
    evidenceCount: numeric(runs.map((item) => item.evidenceCount)),
    approvalCount: numeric(runs.map((item) => item.approvalCount)),
    failedToolInvocationRate: ratio(sum(runs, "failedToolInvocations"), sum(runs, "toolCalls")),
    repeatedToolStrategyRate: ratio(sum(runs, "repeatedToolStrategies"), sum(runs, "toolCalls")),
    toolBudgetExhaustionRate: rate(runs, (item) => item.toolBudgetExhausted),
    repairSuccessRate: ratio(sum(runs, "repairedFailures"), sum(runs, "repairAttempts")),
    strategySwitchSuccessRate: ratio(sum(runs, "successfulStrategySwitches"), sum(runs, "strategySwitches")),
    noProgressWarningRate: rate(runs, (item) => item.noProgressWarnings > 0),
    convergenceBlockedRate: rate(runs, (item) => item.convergenceBlocked),
    invalidResponseRate: ratio(sum(runs, "invalidResponses"), sum(runs, "modelCalls")),
    toolContractViolationRate: ratio(sum(runs, "toolContractViolations"), sum(runs, "toolCalls")),
    finalControlRejectionRate: ratio(sum(runs, "finalControlRejections"), sum(runs, "modelCalls")),
    providerExternalFailureRate: ratio(sum(runs, "failedProviderAttempts"), sum(runs, "providerAttempts")),
    environmentFailureRate: rate(runs, (item) => item.environmentFailure),
    durationMs: numeric(runs.map((item) => item.durationMs))
  };
}

function summarize(runs) {
  return {
    strictPassRate: rate(runs, (item) => item.passed),
    independentTaskSuccessRate: rate(runs, (item) => item.independentTaskSuccess),
    runtimeValidatedSuccessRate: rate(runs, (item) => item.runtimeValidatedSuccess),
    authorityPassRate: rate(runs, (item) => item.authorityPass),
    falseSuccessRate: rate(runs, (item) => item.falseSuccess),
    modelCalls: numeric(runs.map((item) => item.modelCalls)),
    toolCalls: numeric(runs.map((item) => item.toolCalls)),
    toolBudgetExhaustionRate: rate(runs, (item) => item.toolBudgetExhausted),
    failedToolInvocationRate: ratio(sum(runs, "failedToolInvocations"), sum(runs, "toolCalls")),
    repairSuccessRate: ratio(sum(runs, "repairedFailures"), sum(runs, "repairAttempts")),
    strategySwitchSuccessRate: ratio(sum(runs, "successfulStrategySwitches"), sum(runs, "strategySwitches")),
    invalidResponseRate: ratio(sum(runs, "invalidResponses"), sum(runs, "modelCalls")),
    toolContractViolationRate: ratio(sum(runs, "toolContractViolations"), sum(runs, "toolCalls")),
    finalControlRejectionRate: ratio(sum(runs, "finalControlRejections"), sum(runs, "modelCalls")),
    providerExternalFailureRate: ratio(sum(runs, "failedProviderAttempts"), sum(runs, "providerAttempts")),
    environmentFailureRate: rate(runs, (item) => item.environmentFailure)
  };
}

function providerIdentity(reports) {
  const attempts = reports.flatMap((report) => report.tasks.flatMap((task) => (
    task.promptStrategy.calls.flatMap((call) => call.attempts)
  )));
  const identities = [...new Set(attempts.map((item) => JSON.stringify({
    provider: item.provider,
    model: item.model,
    configFingerprint: item.configFingerprint
  })))];
  if (identities.length !== 1) throw new Error(`Reliability reports used ${identities.length} Provider configurations.`);
  return JSON.parse(identities[0]);
}

function sourceIdentity() {
  const commit = command("git", ["rev-parse", "HEAD"]).trim();
  const diff = command("git", ["diff", "--binary"]);
  const runner = readFileSync(new URL(import.meta.url));
  return {
    commit,
    dirty: diff.length > 0,
    worktreeDigest: `sha256:${createHash("sha256").update(diff).update(runner).digest("hex")}`
  };
}

function command(file, args) {
  return execFileSync(file, args, { cwd: repositoryRoot, encoding: "utf8" });
}

function errorCode(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed?.code === "string" ? parsed.code : null;
  } catch {
    return null;
  }
}

function contractViolationCode(code) {
  return ["PROCESS_START_FAILED", "COMMAND_REJECTED", "TOOL_INPUT_INVALID", "TOOL_CONTRACT_INVALID"].includes(code);
}

function numeric(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const mean = sorted.length === 0 ? 0 : sorted.reduce((total, value) => total + value, 0) / sorted.length;
  return {
    mean,
    median: sorted.length === 0 ? 0 : sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle],
    standardDeviation: sorted.length === 0 ? 0 : Math.sqrt(
      sorted.reduce((total, value) => total + ((value - mean) ** 2), 0) / sorted.length
    ),
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0
  };
}

function rate(values, predicate) {
  return values.length === 0 ? 0 : values.filter(predicate).length / values.length;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function sum(values, key) {
  return values.reduce((total, item) => total + item[key], 0);
}

function distribution(values) {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [
    value,
    values.filter((candidate) => candidate === value).length
  ]));
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function option(name) {
  const index = process.argv.lastIndexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function options(name) {
  const values = [];
  process.argv.forEach((value, index) => {
    if (value !== name) return;
    const next = process.argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${name} requires a value.`);
    values.push(next);
  });
  return values;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
