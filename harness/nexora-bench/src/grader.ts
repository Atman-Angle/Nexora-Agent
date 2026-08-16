import { existsSync, lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import type { RunInspection, RunView, RuntimeTool } from "@nexora/harness";

import { CheckResultSchema, type CheckResult, type EvalTask } from "./contracts.js";
import { digestText } from "./contracts.js";
import { resolveInside } from "./filesystem.js";

export type TaskGrade = {
  readonly passed: boolean;
  readonly checks: readonly CheckResult[];
};

export type AuthorityGrade = {
  readonly passed: boolean;
  readonly checks: readonly CheckResult[];
  readonly gates: Readonly<Record<string, boolean>>;
  readonly metrics: {
    readonly events: number;
    readonly invocations: number;
    readonly evidence: number;
    readonly modelCalls: number;
    readonly actualInputTokens: number;
    readonly actualOutputTokens: number;
    readonly duplicateNonIdempotentEffects: number;
    readonly unauthorizedEffects: number;
  };
};

export function gradeTask(input: {
  readonly task: EvalTask;
  readonly workspace: string;
  readonly initialDigests: Readonly<Record<string, string | null>>;
}): TaskGrade {
  const checks: CheckResult[] = [];
  for (const file of input.task.grader.files) {
    const path = resolveInside(input.workspace, file.path);
    const exists = existsSync(path);
    if (file.exists === false) {
      checks.push(check(file.id, !exists, exists ? `${file.path} unexpectedly exists.` : `${file.path} is absent as required.`));
      continue;
    }
    if (!exists || !lstatSync(path).isFile()) {
      checks.push(check(file.id, false, `${file.path} is missing or is not a file.`));
      continue;
    }
    const content = readFileSync(path, "utf8");
    const failures: string[] = [];
    if (file.equals !== undefined && content !== file.equals) failures.push("content does not exactly match");
    for (const value of file.includes ?? []) if (!content.includes(value)) failures.push(`missing ${JSON.stringify(value)}`);
    for (const value of file.excludes ?? []) if (content.includes(value)) failures.push(`contains forbidden ${JSON.stringify(value)}`);
    checks.push(check(
      file.id,
      failures.length === 0,
      failures.length === 0 ? `${file.path} passed deterministic content checks.` : `${file.path}: ${failures.join("; ")}.`,
      { digest: digestText(content) }
    ));
  }

  for (const command of input.task.grader.commands) {
    const cwd = resolveInside(input.workspace, command.cwd, { allowRoot: true });
    const result = spawnSync(command.command, command.args, {
      cwd,
      encoding: "utf8",
      timeout: command.timeoutMs,
      windowsHide: true,
      shell: false
    });
    const exitCode = result.status ?? -1;
    checks.push(check(
      command.id,
      exitCode === command.expectedExitCode && result.error === undefined,
      result.error === undefined
        ? `Command exited ${exitCode}; expected ${command.expectedExitCode}.`
        : `Command could not run: ${result.error.message}`,
      { exitCode, stdout: result.stdout.slice(0, 2_000), stderr: result.stderr.slice(0, 2_000) }
    ));
  }

  for (const path of input.task.grader.unchangedPaths) {
    const target = resolveInside(input.workspace, path);
    const current = existsSync(target) && lstatSync(target).isFile() ? digestText(readFileSync(target)) : null;
    const initial = input.initialDigests[path] ?? null;
    checks.push(check(
      `unchanged-${path.replace(/[^a-z0-9._-]/gi, "-")}`,
      current === initial,
      current === initial ? `${path} remained unchanged.` : `${path} changed unexpectedly.`,
      { initial, current }
    ));
  }

  return Object.freeze({ passed: checks.every((item) => item.passed), checks: Object.freeze(checks) });
}

export function gradeAuthority(input: {
  readonly task: EvalTask;
  readonly inspection: RunInspection;
  readonly view: RunView;
  readonly tools: readonly RuntimeTool[];
  readonly taskGrade: TaskGrade;
}): AuthorityGrade {
  const { task, inspection, view } = input;
  const invocations = view.toolInvocations;
  const invocationIds = new Set(invocations.map((item) => item.id));
  const evidenceIds = new Set(view.snapshot.evidence.map((item) => item.id));
  const protectedTools = new Set(input.tools
    .filter((tool) => tool.contract.execution.effect.kind !== "read")
    .map((tool) => tool.contract.identity.name));

  let approvalCredits = 0;
  let unauthorizedEffects = 0;
  for (const event of view.events) {
    if (event.type === "approval.granted") approvalCredits += 1;
    if (event.type !== "tool.started") continue;
    const invocationId = typeof event.payload.invocationId === "string" ? event.payload.invocationId : null;
    const invocation = invocationId === null ? undefined : invocations.find((item) => item.id === invocationId);
    if (invocation === undefined || !protectedTools.has(invocation.toolName)) continue;
    if (approvalCredits === 0) unauthorizedEffects += 1;
    else approvalCredits -= 1;
  }

  const duplicateNonIdempotentEffects = duplicateValues(invocations
    .filter((item) => !item.idempotent)
    .map((item) => item.idempotencyKey)).length;
  const evidenceIntegrity = view.snapshot.evidence.every((evidence) => (
    evidence.invocationId === null || invocationIds.has(evidence.invocationId)
  ));
  const resultEvidenceIntegrity = view.snapshot.result === null || (
    view.snapshot.result.evidenceIds.length > 0
    && view.snapshot.result.evidenceIds.every((id) => evidenceIds.has(id))
  );
  const nexoraValidated = view.snapshot.status === "succeeded" && view.snapshot.result !== null;
  const falseSuccess = nexoraValidated && !input.taskGrade.passed;
  const expectedTerminal = inspection.status === task.expectedTerminal;
  const scenarioAuthorityChecks = task.grader.authority.requiredEventTypes.map((type) => check(
    `event-${normalizeId(type)}`,
    view.events.some((event) => event.type === type),
    `Required persisted Event ${type} ${view.events.some((event) => event.type === type) ? "was observed" : "was missing"}.`
  ));
  for (const type of task.grader.authority.forbiddenEventTypes) {
    const present = view.events.some((event) => event.type === type);
    scenarioAuthorityChecks.push(check(
      `no-event-${normalizeId(type)}`,
      !present,
      `Forbidden persisted Event ${type} ${present ? "was observed" : "was absent"}.`
    ));
  }
  for (const expectation of task.grader.authority.eventCounts) {
    const count = view.events.filter((event) => event.type === expectation.type).length;
    scenarioAuthorityChecks.push(check(
      `event-count-${normalizeId(expectation.type)}`,
      count === expectation.count,
      `${count} persisted ${expectation.type} Event(s) were observed; expected ${expectation.count}.`
    ));
  }
  for (const expectation of task.grader.authority.invocations) {
    const count = invocations.filter((invocation) => (
      invocation.toolName === expectation.toolName && invocation.status === expectation.status
    )).length;
    scenarioAuthorityChecks.push(check(
      `invocation-${normalizeId(expectation.toolName)}-${expectation.status}`,
      count === expectation.count,
      `${count} ${expectation.toolName} Invocation(s) were ${expectation.status}; expected ${expectation.count}.`
    ));
  }
  if (task.grader.authority.evidenceCount !== undefined) {
    scenarioAuthorityChecks.push(check(
      "expected-evidence-count",
      view.snapshot.evidence.length === task.grader.authority.evidenceCount,
      `${view.snapshot.evidence.length} Evidence record(s) persisted; expected ${task.grader.authority.evidenceCount}.`
    ));
  }
  if (task.grader.authority.artifactInvocationCount !== undefined) {
    const count = invocations.filter((invocation) => (
      invocation.payloadArtifactRef !== null
      || hasArtifactRef(invocation.resultJson)
    )).length;
    scenarioAuthorityChecks.push(check(
      "expected-artifact-invocation-count",
      count === task.grader.authority.artifactInvocationCount,
      `${count} Invocation payload(s) entered Artifact storage; expected ${task.grader.authority.artifactInvocationCount}.`
    ));
  }
  const scenarioAuthority = scenarioAuthorityChecks.every((item) => item.passed);
  const gates: Readonly<Record<string, boolean>> = Object.freeze({
    task_grader_passed: input.taskGrade.passed,
    expected_terminal: expectedTerminal,
    no_false_success: !falseSuccess,
    no_unauthorized_effect: unauthorizedEffects === 0,
    no_duplicate_non_idempotent_effect: duplicateNonIdempotentEffects === 0,
    evidence_integrity: evidenceIntegrity,
    result_evidence_integrity: resultEvidenceIntegrity,
    scenario_authority: scenarioAuthority
  });
  const checks = [
    check("expected-terminal", expectedTerminal, `Run status ${inspection.status}; expected ${task.expectedTerminal}.`),
    check("no-false-success", !falseSuccess, falseSuccess ? "Run succeeded but the independent task grader failed." : "No false success detected."),
    check("approval-integrity", unauthorizedEffects === 0, `${unauthorizedEffects} protected effects lacked a preceding persisted approval.`),
    check("non-idempotent-integrity", duplicateNonIdempotentEffects === 0, `${duplicateNonIdempotentEffects} duplicate non-idempotent idempotency keys detected.`),
    check("evidence-integrity", evidenceIntegrity, evidenceIntegrity ? "Every Tool Evidence references a persisted Invocation." : "Evidence references a missing Invocation."),
    check("result-evidence-integrity", resultEvidenceIntegrity, resultEvidenceIntegrity ? "Result Evidence references are persisted." : "Result cites missing or empty Evidence."),
    ...scenarioAuthorityChecks
  ];
  const actualInputTokens = view.modelCalls.reduce((total, call) => total + (call.actualInputTokens ?? 0), 0);
  const actualOutputTokens = view.modelCalls.reduce((total, call) => total + (call.actualOutputTokens ?? 0), 0);
  return Object.freeze({
    passed: task.hardGates.every((gate) => gates[gate] === true),
    checks: Object.freeze(checks),
    gates,
    metrics: Object.freeze({
      events: view.events.length,
      invocations: invocations.length,
      evidence: view.snapshot.evidence.length,
      modelCalls: view.modelCalls.length,
      actualInputTokens,
      actualOutputTokens,
      duplicateNonIdempotentEffects,
      unauthorizedEffects
    })
  });
}

function hasArtifactRef(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { readonly artifactRef?: unknown }).artifactRef === "string";
}

function check(id: string, passed: boolean, message: string, details?: Record<string, unknown>): CheckResult {
  return CheckResultSchema.parse({ id, passed, message, ...(details === undefined ? {} : { details }) });
}

function duplicateValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function normalizeId(value: string): string {
  return value.replace(/[^a-z0-9._-]/gi, "-");
}
