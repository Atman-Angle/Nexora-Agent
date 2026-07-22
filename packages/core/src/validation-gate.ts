import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

import {
  ArtifactSchema,
  CompletionGateResultSchema,
  EvidenceSchema,
  TestResultSchema,
  ValidationPlanSchema,
  ValidationResultSchema,
  computeArtifactHash,
  type Artifact,
  type Event,
  type ProgressLedger,
  type Run,
  type Task,
  type TaskAcceptanceCriterion,
  type TestResult,
  type ToolResult,
  type ValidationFreshness,
  type ValidationResult
} from "../../contracts/src/index.js";

export function validateArtifactForRun(run: Run, artifact: Artifact | null): ValidationResult {
  const evidence: ValidationResult["evidence"] = [];

  if (artifact === null) {
    evidence.push({
      code: "ARTIFACT_MISSING",
      message: "Artifact must exist before the run can succeed."
    });
  } else {
    const parsedArtifact = ArtifactSchema.parse(artifact);

    if (parsedArtifact.runId !== run.runId) {
      evidence.push({
        code: "ARTIFACT_RUN_MISMATCH",
        message: "Artifact must belong to the current run."
      });
    }

    if (parsedArtifact.type !== "text" || parsedArtifact.mimeType !== "text/plain") {
      evidence.push({
        code: "ARTIFACT_TYPE_INVALID",
        message: "Artifact must be plain text."
      });
    }

    if (parsedArtifact.content.trim().length === 0) {
      evidence.push({
        code: "ARTIFACT_CONTENT_EMPTY",
        message: "Artifact content must be non-empty."
      });
    }

    const recomputedHash = computeArtifactHash(parsedArtifact.content);
    if (recomputedHash !== parsedArtifact.hash) {
      evidence.push({
        code: "ARTIFACT_HASH_MISMATCH",
        message: "Artifact hash must match the persisted content."
      });
    }
  }

  return ValidationResultSchema.parse({
    status: evidence.length === 0 ? "passed" : "failed",
    evidence
  });
}

/** Shared mutation-task classification used by the Completion Gate and plan bootstrap. */
export function requiresMutationTaskType(taskType: Task["input"]["taskType"]): boolean {
  return taskType === "workspace_mutation" || taskType === "bug_fix" || taskType === "feature";
}

export async function runCompletionGate(input: {
  run: Run;
  task: Task;
  ledger?: ProgressLedger | null;
  toolResult: ToolResult | null;
  latestValidationResult?: ValidationResult | null;
  finalArtifact: Artifact | null;
  artifacts: Artifact[];
  events?: Event[];
  workspaceRoot?: string;
  now: string;
  idGenerator: () => string;
}): Promise<{
  validation: ValidationResult;
  testResult: TestResult;
  evidenceRecords: Array<ValidationResult["evidenceRecords"][number]>;
}> {
  const baseValidation = validateArtifactForRun(input.run, input.finalArtifact);
  const evidence = [...baseValidation.evidence];
  const validationRequest = input.task.input.validationRequest;
  const events = input.events ?? [];
  const executedValidatorIds: string[] = [];
  const taskType = input.task.input.taskType;
  const requiresValidation = validationRequest !== undefined || requiresMutationTaskType(taskType);
  const changedFiles = collectChangedFiles(events);
  const finalProposalAttempt = Math.max(1, events.filter((event) => event.type === "model.final.proposed").length);
  const validationCwd = input.latestValidationResult?.validationCwd ?? validationRequest?.cwd ?? null;
  const lastMutationSequence = findLastMutationSequence(events);
  const lastValidationSequence = findLastSuccessfulValidationSequence(events);

  if (requiresValidation && validationRequest === undefined) {
    evidence.push({
      code: "VALIDATION_PLAN_MISSING",
      message: "Validation request and plan must exist."
    });
  }

  if (validationRequest !== undefined) {
    const parsedPlan = ValidationPlanSchema.parse(validationRequest.validationPlan);
    if (parsedPlan.validators.length === 0) {
      evidence.push({
        code: "VALIDATION_PLAN_EMPTY",
        message: "Validation plan must include at least one validator."
      });
    }
  }

  if (
    requiresValidation &&
    (input.toolResult === null || input.toolResult.toolName !== "shell.execute" || input.toolResult.status !== "success")
  ) {
    evidence.push({
      code: "VALIDATION_TOOL_RESULT_INVALID",
      message: "Completion Gate requires a successful shell.execute result."
    });
  }

  const commandResult =
    input.toolResult?.toolName === "shell.execute" && input.toolResult.status === "success"
      ? input.toolResult.output.result
      : null;

  const artifactRefs = [commandResult?.stdoutArtifactRef, commandResult?.stderrArtifactRef].filter(
    (artifactRef): artifactRef is string => artifactRef !== undefined
  );
  for (const artifactRef of artifactRefs) {
    const artifact = input.artifacts.find((candidate) => candidate.artifactId === artifactRef);
    if (artifact === undefined) {
      evidence.push({
        code: "EVIDENCE_ARTIFACT_MISSING",
        message: `Artifact ${artifactRef} referenced by evidence was not found.`
      });
      continue;
    }

    if (artifact.runId !== input.run.runId) {
      evidence.push({
        code: "EVIDENCE_RUN_MISMATCH",
        message: `Artifact ${artifactRef} does not belong to the current run.`
      });
      continue;
    }

    if (artifact.filePath === undefined) {
      evidence.push({
        code: "EVIDENCE_ARTIFACT_INVALID",
        message: `Artifact ${artifactRef} must be file-backed for log evidence.`
      });
      continue;
    }

    const fileContent = await readFile(artifact.filePath, "utf8").catch(() => null);
    if (fileContent === null) {
      evidence.push({
        code: "EVIDENCE_ARTIFACT_FILE_MISSING",
        message: `Artifact file ${artifact.filePath} is missing.`
      });
      continue;
    }

    if (computeArtifactHash(fileContent) !== artifact.hash) {
      evidence.push({
        code: "EVIDENCE_ARTIFACT_HASH_MISMATCH",
        message: `Artifact ${artifactRef} hash does not match the persisted file content.`
      });
    }
  }

  if (requiresValidation && validationRequest !== undefined && commandResult !== null) {
    for (const validator of validationRequest.validationPlan.validators) {
      executedValidatorIds.push(validator.validatorId);
      if (validator.type === "command_exit_code" && commandResult.exitCode !== validator.expectedExitCode) {
        evidence.push({
          code: validator.required ? "VALIDATOR_REQUIRED_FAILED" : "VALIDATOR_FAILED",
          message: `Validator ${validator.validatorId} expected exit code ${validator.expectedExitCode} but received ${String(commandResult.exitCode)}.`
        });
      }
    }
  }

  if (requiresValidation && validationRequest !== undefined) {
    for (const validator of validationRequest.validationPlan.validators) {
      if (validator.required && !executedValidatorIds.includes(validator.validatorId)) {
        evidence.push({
          code: "REQUIRED_VALIDATOR_NOT_EXECUTED",
          message: `Required validator ${validator.validatorId} was not executed.`
        });
      }
    }
  }

  const artifactChecks = await evaluateArtifactChecks({
    taskType,
    changedFiles,
    workspaceRoot: input.workspaceRoot
  });
  for (const check of artifactChecks) {
    if (check.status === "failed" && check.reason !== undefined) {
      evidence.push({
        code: "ARTIFACT_CHECK_FAILED",
        message: `${check.id}: ${check.reason}`
      });
    }
  }

  const acceptanceResults = await evaluateAcceptanceCriteria({
    criteria: input.task.input.acceptanceCriteria,
    workspaceRoot: input.workspaceRoot,
    changedFiles
  });
  for (const criterion of acceptanceResults) {
    if (criterion.required && criterion.status !== "passed") {
      evidence.push({
        code: "ACCEPTANCE_CRITERION_UNVERIFIED",
        message: criterion.reason ?? `Acceptance criterion ${criterion.id} is ${criterion.status}.`
      });
    }
  }

  const incompletePlanSteps = collectIncompletePlanSteps(input.ledger);
  for (const step of incompletePlanSteps) {
    evidence.push({
      code: "PLAN_STEP_INCOMPLETE",
      message: `Required plan step incomplete: ${step}.`
    });
  }

  const freshness = await evaluateValidationFreshness({
    taskType,
    latestValidationResult: input.latestValidationResult ?? null,
    workspaceRoot: input.workspaceRoot,
    lastMutationSequence,
    lastValidationSequence
  });
  if (!freshness.valid) {
    evidence.push({
      code: "VALIDATION_NOT_FRESH",
      message: "Required validation has not run after the latest workspace mutation."
    });
  }

  const cwdCheck = await evaluateValidationCwd({
    taskType,
    workspaceRoot: input.workspaceRoot,
    validationCwd,
    changedFiles
  });
  if (!cwdCheck.valid && cwdCheck.reason !== undefined) {
    evidence.push({
      code: "VALIDATION_CWD_INVALID",
      message: cwdCheck.reason
    });
  }

  const rejectionReasons = [...new Set(evidence.map((entry) => entry.message))];
  const completionGate = CompletionGateResultSchema.parse({
    taskType,
    finalProposalAttempt,
    incompletePlanSteps,
    acceptanceResults,
    lastMutationSequence,
    lastValidationSequence,
    validationCwd,
    changedFiles,
    artifactChecks,
    rejectionReasons,
    outcome: evidence.length === 0 ? "accepted" : "rejected"
  });

  const evidenceRecords: Array<ValidationResult["evidenceRecords"][number]> = [];
  if (commandResult !== null) {
    evidenceRecords.push(
      EvidenceSchema.parse({
        evidenceId: input.idGenerator(),
        runId: input.run.runId,
        type: "command_result",
        source: "shell.execute",
        status: commandResult.exitCode === 0 && evidence.length === 0 ? "passed" : "failed",
        summary:
          commandResult.exitCode === 0 ? "Command completed successfully." : `Command exited with ${String(commandResult.exitCode)}.`,
        artifactRefs,
        createdAt: input.now
      })
    );
  }
  evidenceRecords.push(
    EvidenceSchema.parse({
      evidenceId: input.idGenerator(),
      runId: input.run.runId,
      type: "completion_gate",
      source: "completion_gate",
      status: evidence.length === 0 ? "passed" : "failed",
      summary:
        evidence.length === 0
          ? "Completion Gate accepted the final proposal."
          : `Completion Gate rejected the final proposal: ${rejectionReasons.join(" | ")}`,
      artifactRefs: [],
      createdAt: input.now
    })
  );

  const testResult = TestResultSchema.parse({
    status:
      !requiresValidation
        ? evidence.length === 0
          ? "passed"
          : "failed"
        : commandResult === null
          ? "error"
          : evidence.length === 0 && commandResult.exitCode === 0
            ? "passed"
            : "failed",
    command: validationRequest?.command ?? input.task.input.text,
    exitCode: requiresValidation ? commandResult?.exitCode ?? null : null,
    summary:
      !requiresValidation
        ? evidence.length === 0
          ? "Completion proposal accepted without explicit validation."
          : "Completion proposal failed gate checks."
        : commandResult === null
          ? "Verification command did not produce a valid result."
          : evidence.length === 0 && commandResult.exitCode === 0
            ? "Verification passed."
            : `Verification failed with exit code ${String(commandResult.exitCode)}.`,
    evidenceRefs: evidenceRecords.map((record) => record.evidenceId),
    startedAt:
      !requiresValidation || commandResult === null
        ? input.run.updatedAt
        : new Date(new Date(input.now).getTime() - commandResult.durationMs).toISOString(),
    completedAt: input.now
  });

  const validation = ValidationResultSchema.parse({
    status: evidence.length === 0 ? "passed" : "failed",
    evidence,
    executedValidatorIds,
    ...(validationRequest === undefined ? {} : { plan: validationRequest.validationPlan }),
    testResult,
    evidenceRecords,
    taskType,
    validationSequence: lastValidationSequence,
    ...(validationCwd === null ? {} : { validationCwd }),
    changedFiles,
    ...(freshness.workspaceFingerprint === undefined ? {} : { workspaceFingerprint: freshness.workspaceFingerprint }),
    acceptanceResults,
    artifactChecks,
    freshness,
    completionGate
  });

  return {
    validation,
    testResult,
    evidenceRecords
  };
}

function collectChangedFiles(events: Event[]): string[] {
  return [
    ...new Set(
      events
        .filter((event) => event.type === "patch.applied")
        .map((event) => event.payload.path)
        .filter((path): path is string => typeof path === "string" && path.length > 0)
    )
  ];
}

function findLastMutationSequence(events: Event[]): number {
  return events
    .filter((event) => event.type === "patch.applied")
    .reduce((max, event) => Math.max(max, event.sequence), 0);
}

function findLastSuccessfulValidationSequence(events: Event[]): number {
  return events
    .filter((event) => event.type === "validation.completed" && event.payload.status === "passed")
    .reduce((max, event) => Math.max(max, event.sequence), 0);
}

async function evaluateArtifactChecks(input: {
  taskType: Task["input"]["taskType"];
  changedFiles: string[];
  workspaceRoot: string | undefined;
}): Promise<ValidationResult["artifactChecks"]> {
  const checks: ValidationResult["artifactChecks"] = [];
  const requiresMutation = requiresMutationTaskType(input.taskType);

  if (requiresMutation) {
    if (input.changedFiles.length === 0) {
      checks.push({
        id: "changed_files",
        status: "failed",
        reason: "No changed source files were produced."
      });
      return checks;
    }

    checks.push({
      id: "changed_files",
      status: "passed",
      reason: `Changed files: ${input.changedFiles.join(", ")}`
    });
  }

  if (input.workspaceRoot === undefined) {
    return checks;
  }

  for (const changedFile of input.changedFiles) {
    const absolutePath = resolve(input.workspaceRoot, changedFile);
    const fileStats = await stat(absolutePath).catch(() => null);
    if (fileStats === null) {
      checks.push({
        id: `exists:${changedFile}`,
        status: "failed",
        path: changedFile,
        reason: "Changed file does not exist."
      });
      continue;
    }

    if (!fileStats.isFile()) {
      checks.push({
        id: `file:${changedFile}`,
        status: "failed",
        path: changedFile,
        reason: "Changed path is not a file."
      });
      continue;
    }

    if (fileStats.size <= 0) {
      checks.push({
        id: `non_empty:${changedFile}`,
        status: "failed",
        path: changedFile,
        reason: "Changed file is empty."
      });
      continue;
    }

    checks.push({
      id: `non_empty:${changedFile}`,
      status: "passed",
      path: changedFile
    });
  }

  return checks;
}

export async function evaluateAcceptanceCriteria(input: {
  criteria: TaskAcceptanceCriterion[];
  workspaceRoot: string | undefined;
  changedFiles: string[];
}): Promise<ValidationResult["acceptanceResults"]> {
  const results: ValidationResult["acceptanceResults"] = [];
  for (const criterion of input.criteria) {
    const base = {
      id: criterion.id,
      required: criterion.required,
      evidenceRefs: [] as string[]
    };

    if (criterion.check.type === "changed_files_non_empty") {
      results.push({
        ...base,
        status: input.changedFiles.length > 0 ? "passed" : "failed",
        evidenceRefs: input.changedFiles.length > 0 ? [`acceptance:${criterion.id}`] : [],
        ...(input.changedFiles.length > 0 ? {} : { reason: "No changed files were produced." })
      });
      continue;
    }

    if (input.workspaceRoot === undefined) {
      results.push({
        ...base,
        status: "unverified",
        reason: "Workspace root is unavailable for acceptance checks."
      });
      continue;
    }

    const absolutePath = resolve(input.workspaceRoot, criterion.check.path);
    if (criterion.check.type === "file_exists") {
      const pathStats = await stat(absolutePath).catch(() => null);
      results.push({
        ...base,
        status: pathStats?.isFile() ? "passed" : "failed",
        evidenceRefs: pathStats?.isFile() ? [`acceptance:${criterion.id}`] : [],
        ...(pathStats?.isFile() ? {} : { reason: `Required file ${criterion.check.path} does not exist.` })
      });
      continue;
    }

    if (criterion.check.type === "file_non_empty") {
      const pathStats = await stat(absolutePath).catch(() => null);
      results.push({
        ...base,
        status: pathStats?.isFile() && pathStats.size > 0 ? "passed" : "failed",
        evidenceRefs: pathStats?.isFile() && pathStats.size > 0 ? [`acceptance:${criterion.id}`] : [],
        ...(pathStats?.isFile() && pathStats.size > 0 ? {} : { reason: `Required file ${criterion.check.path} is missing or empty.` })
      });
      continue;
    }

    if (criterion.check.type === "directory_non_empty") {
      const entries = await readdir(absolutePath).catch(() => null);
      results.push({
        ...base,
        status: entries !== null && entries.length > 0 ? "passed" : "failed",
        evidenceRefs: entries !== null && entries.length > 0 ? [`acceptance:${criterion.id}`] : [],
        ...(entries !== null && entries.length > 0 ? {} : { reason: `Required directory ${criterion.check.path} is missing or empty.` })
      });
      continue;
    }

    const fileContent = await readFile(absolutePath, "utf8").catch(() => null);
    const textCheckPassed = fileContent !== null && fileContent.includes(criterion.check.text);
    results.push({
      ...base,
      status: textCheckPassed ? "passed" : "failed",
      evidenceRefs: textCheckPassed ? [`acceptance:${criterion.id}`] : [],
      ...(textCheckPassed
        ? {}
        : { reason: `Required text for ${criterion.id} was not found in ${criterion.check.path}.` })
    });
  }

  return results;
}

function collectIncompletePlanSteps(ledger: ProgressLedger | null | undefined): string[] {
  if (ledger === null || ledger === undefined) {
    return [];
  }

  if (ledger.planSteps.length > 0) {
    return ledger.planSteps
      .filter((step) => step.required && (step.status !== "completed" || step.evidenceRefs.length === 0))
      .map((step) => step.description);
  }

  return ledger.plannedSteps.filter((step) => !ledger.completedSteps.includes(step));
}

async function evaluateValidationFreshness(input: {
  taskType: Task["input"]["taskType"];
  latestValidationResult: ValidationResult | null;
  workspaceRoot: string | undefined;
  lastMutationSequence: number;
  lastValidationSequence: number;
}): Promise<ValidationFreshness> {
  const requiresFreshValidation = requiresMutationTaskType(input.taskType);
  const validationSequence = input.latestValidationResult?.validationSequence ?? input.lastValidationSequence;
  const workspaceFingerprint =
    input.workspaceRoot === undefined || input.latestValidationResult?.changedFiles === undefined
      ? undefined
      : await computeWorkspaceFingerprint(input.workspaceRoot, input.latestValidationResult.changedFiles);

  if (!requiresFreshValidation) {
    return {
      validationSequence,
      lastMutationSequence: input.lastMutationSequence,
      ...(workspaceFingerprint === undefined ? {} : { workspaceFingerprint }),
      valid: true
    };
  }

  const latestFingerprint = input.latestValidationResult?.workspaceFingerprint;
  const fingerprintMatches =
    latestFingerprint === undefined || workspaceFingerprint === undefined ? true : latestFingerprint === workspaceFingerprint;

  return {
    validationSequence,
    lastMutationSequence: input.lastMutationSequence,
    ...(workspaceFingerprint === undefined ? {} : { workspaceFingerprint }),
    valid:
      input.latestValidationResult?.status === "passed" &&
      validationSequence > input.lastMutationSequence &&
      fingerprintMatches
  };
}

async function evaluateValidationCwd(input: {
  taskType: Task["input"]["taskType"];
  workspaceRoot: string | undefined;
  validationCwd: string | null;
  changedFiles: string[];
}): Promise<{ valid: boolean; reason?: string }> {
  const requiresScopedCwd = requiresMutationTaskType(input.taskType);
  if (!requiresScopedCwd || input.workspaceRoot === undefined || input.validationCwd === null) {
    return { valid: true };
  }

  const cwdAbsolute = isAbsolute(input.validationCwd)
    ? normalize(input.validationCwd)
    : normalize(resolve(input.workspaceRoot, input.validationCwd));
  const workspaceAbsolute = normalize(resolve(input.workspaceRoot));
  if (relative(workspaceAbsolute, cwdAbsolute).startsWith("..")) {
    return { valid: false, reason: "Validation cwd escapes the workspace." };
  }

  const projectUnits = await Promise.all(
    input.changedFiles.map((filePath) => findNearestProjectUnit(input.workspaceRoot!, filePath))
  );
  const deepestUnit = projectUnits
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => right.length - left.length)[0];
  if (deepestUnit === undefined) {
    return { valid: true };
  }

  if (normalize(deepestUnit) !== cwdAbsolute) {
    return {
      valid: false,
      reason: `Validation cwd ${input.validationCwd} does not match the target project unit ${relative(workspaceAbsolute, deepestUnit) || "."}.`
    };
  }

  return { valid: true };
}

async function findNearestProjectUnit(workspaceRoot: string, changedFile: string): Promise<string> {
  let current = resolve(workspaceRoot, changedFile);
  const pathStats = await stat(current).catch(() => null);
  current = pathStats?.isDirectory() ? current : resolve(current, "..");
  const workspaceAbsolute = resolve(workspaceRoot);

  while (true) {
    for (const candidate of ["package.json", "tsconfig.json", "vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"]) {
      const exists = await stat(join(current, candidate)).then(() => true).catch(() => false);
      if (exists) {
        return current;
      }
    }

    if (normalize(current) === normalize(workspaceAbsolute)) {
      return workspaceAbsolute;
    }

    const parent = resolve(current, "..");
    if (parent === current) {
      return workspaceAbsolute;
    }
    current = parent;
  }
}

async function computeWorkspaceFingerprint(workspaceRoot: string, changedFiles: string[]): Promise<string | undefined> {
  if (changedFiles.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (const changedFile of [...new Set(changedFiles)].sort()) {
    const absolutePath = resolve(workspaceRoot, changedFile);
    const content = await readFile(absolutePath, "utf8").catch(() => null);
    parts.push(`${changedFile}:${content === null ? "missing" : computeArtifactHash(content)}`);
  }
  return computeArtifactHash(parts.join("|"));
}
