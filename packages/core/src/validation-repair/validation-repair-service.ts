import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ValidationPlanSchema,
  computeArtifactHash,
  type AgentAction,
  type Artifact,
  type BuilderState,
  type Run,
  type Task,
  type TestResult,
  type ToolResult,
  type ValidationResult
} from "../../../contracts/src/index.js";
import { redactForEvidence } from "../agent-loop-runner.js";

export async function runCommandValidation(input: {
  run: Run;
  task: Task;
  toolResult: Extract<ToolResult, { toolName: "shell.execute"; status: "success" }>;
  artifacts: Artifact[];
  changedFiles: string[];
  validationCwd: string;
  workspaceRoot: string;
  now: string;
  idGenerator: () => string;
}): Promise<ValidationResult> {
  const evidence: ValidationResult["evidence"] = [];
  const validationRequest = input.task.input.validationRequest;
  const executedValidatorIds: string[] = [];

  if (validationRequest === undefined) {
    evidence.push({
      code: "VALIDATION_PLAN_MISSING",
      message: "Validation request and plan must exist."
    });
  } else {
    const parsedPlan = ValidationPlanSchema.parse(validationRequest.validationPlan);
    if (parsedPlan.validators.length === 0) {
      evidence.push({
        code: "VALIDATION_PLAN_EMPTY",
        message: "Validation plan must include at least one validator."
      });
    }
  }

  const artifactRefs = [input.toolResult.output.result.stdoutArtifactRef, input.toolResult.output.result.stderrArtifactRef].filter(
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
  }

  if (validationRequest !== undefined) {
    for (const validator of validationRequest.validationPlan.validators) {
      executedValidatorIds.push(validator.validatorId);
      if (validator.type === "command_exit_code" && input.toolResult.output.result.exitCode !== validator.expectedExitCode) {
        evidence.push({
          code: validator.required ? "VALIDATOR_REQUIRED_FAILED" : "VALIDATOR_FAILED",
          message: `Validator ${validator.validatorId} expected exit code ${validator.expectedExitCode} but received ${String(input.toolResult.output.result.exitCode)}.`
        });
      }
    }
  }

  const evidenceRecords = [
    {
      evidenceId: input.idGenerator(),
      runId: input.run.runId,
      type: "command_result" as const,
      source: "shell.execute" as const,
      status:
        input.toolResult.output.result.exitCode === 0 && evidence.length === 0 ? ("passed" as const) : ("failed" as const),
      summary:
        input.toolResult.output.result.exitCode === 0
          ? "Command completed successfully."
          : `Command exited with ${String(input.toolResult.output.result.exitCode)}.`,
      artifactRefs,
      createdAt: input.now
    }
  ];
  const failureSummary =
    evidence.length === 0 && input.toolResult.output.result.exitCode === 0
      ? undefined
      : await buildValidationFailureSummary({
          command: validationRequest?.command ?? input.toolResult.toolName,
          cwd: input.validationCwd,
          toolResult: input.toolResult,
          artifacts: input.artifacts,
          workspaceRoot: input.workspaceRoot,
          changedFiles: input.changedFiles,
          evidenceRefs: evidenceRecords.map((record) => record.evidenceId)
        });

  const testResult: TestResult = {
    status:
      evidence.length === 0 && input.toolResult.output.result.exitCode === 0 ? "passed" : "failed",
    command: validationRequest?.command ?? input.task.input.text,
    exitCode: input.toolResult.output.result.exitCode,
    summary:
      evidence.length === 0 && input.toolResult.output.result.exitCode === 0
        ? "Verification passed."
        : `Verification failed with exit code ${String(input.toolResult.output.result.exitCode)}.`,
    evidenceRefs: evidenceRecords.map((record) => record.evidenceId),
    startedAt: new Date(new Date(input.now).getTime() - input.toolResult.output.result.durationMs).toISOString(),
    completedAt: input.now
  };

  return {
    status: evidence.length === 0 ? "passed" : "failed",
    evidence,
    executedValidatorIds,
    ...(validationRequest === undefined ? {} : { plan: validationRequest.validationPlan }),
    testResult,
    evidenceRecords,
    taskType: input.task.input.taskType,
    validationCwd: input.validationCwd,
    changedFiles: input.changedFiles,
    acceptanceResults: [],
    artifactChecks: [],
    ...(failureSummary === undefined ? {} : { failureSummary }),
    ...(input.changedFiles.length === 0
      ? {}
      : { workspaceFingerprint: await computeChangedFilesFingerprint(input.workspaceRoot, input.changedFiles) })
  };
}

export async function buildValidationFailureSummary(input: {
  command: string;
  cwd: string;
  toolResult: Extract<ToolResult, { toolName: "shell.execute"; status: "success" }>;
  artifacts: Artifact[];
  workspaceRoot: string;
  changedFiles: string[];
  evidenceRefs: string[];
}): Promise<NonNullable<ValidationResult["failureSummary"]>> {
  const commandResult = input.toolResult.output.result;
  const stdout = await readCommandStream({
    summary: commandResult.stdoutSummary,
    artifactRef: commandResult.stdoutArtifactRef,
    artifacts: input.artifacts
  });
  const stderr = await readCommandStream({
    summary: commandResult.stderrSummary,
    artifactRef: commandResult.stderrArtifactRef,
    artifacts: input.artifacts
  });
  const cleanStdout = stripAnsi(stdout);
  const cleanStderr = stripAnsi(stderr);
  const combined = [cleanStdout, cleanStderr].filter((part) => part.trim().length > 0).join("\n");
  const stdoutExcerpt = summarizeDiagnosticExcerpt(cleanStdout, 1000);
  const stderrExcerpt = summarizeDiagnosticExcerpt(cleanStderr, 1000);
  const detection = detectFailureLocation(combined);
  const message = summarizeFailureMessage(combined) || `Command exited with ${String(commandResult.exitCode)}.`;
  const suggestedRepair = summarizeSuggestedRepair(combined);
  const afterLatestMutation = input.changedFiles.length > 0;

  return {
    schemaVersion: "1",
    status: "failed",
    command: redactForEvidence(input.command),
    cwd: input.cwd,
    exitCode: commandResult.exitCode,
    freshness: afterLatestMutation ? "fresh" : "unknown",
    changedFiles: [...new Set(input.changedFiles)].sort(),
    failingFile: detection.failingFile ?? null,
    failingTestName: detection.failingTestName ?? null,
    message: limitText(redactForEvidence(message), 500),
    ...(suggestedRepair.length === 0 ? {} : { suggestedRepair: limitText(redactForEvidence(suggestedRepair), 500) }),
    stdoutExcerpt: limitText(redactForEvidence(stdoutExcerpt), 1000),
    stderrExcerpt: limitText(redactForEvidence(stderrExcerpt), 1000),
    evidenceRefs: input.evidenceRefs,
    attempt: 1,
    afterLatestMutation
  };
}

async function readCommandStream(input: {
  summary: string;
  artifactRef: string | undefined;
  artifacts: Artifact[];
}): Promise<string> {
  if (input.artifactRef !== undefined) {
    const artifact = input.artifacts.find((candidate) => candidate.artifactId === input.artifactRef);
    if (artifact?.filePath !== undefined) {
      const content = await readFile(artifact.filePath, "utf8").catch(() => null);
      if (content !== null) {
        return content;
      }
    }
  }
  return input.summary;
}

function detectFailureLocation(text: string): {
  failingFile?: string;
  failingTestName?: string;
} {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const failLine = line.match(/(?:FAIL|FAILED)\s+(.+?\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s+>\s+(.+))?/i);
    if (failLine !== null) {
      return {
        failingFile: normalizeFailurePath(failLine[1] ?? ""),
        ...(failLine[2] === undefined ? {} : { failingTestName: limitText(failLine[2].trim(), 200) })
      };
    }
    const vitestFileLine = line.match(/[❯>]\s+(.+?\.(?:test|spec)\.[cm]?[jt]sx?)\s+\(/i);
    if (vitestFileLine !== null) {
      const testLine = lines.slice(index + 1, index + 5).find((candidate) => /[×x]\s+.+/i.test(candidate));
      return {
        failingFile: normalizeFailurePath(vitestFileLine[1] ?? ""),
        ...(testLine === undefined ? {} : { failingTestName: limitText(testLine.replace(/^[×x]\s+/, "").trim(), 200) })
      };
    }
  }

  const fileMatch = text.match(/([A-Za-z0-9_.\-\\/]+(?:test|spec)\.[cm]?[jt]sx?)/i);
  if (fileMatch !== null) {
    return { failingFile: normalizeFailurePath(fileMatch[1] ?? "") };
  }
  const buildFileMatch = text.match(/([A-Za-z0-9_.\-\\/]+\.[cm]?[jt]sx?)\s*(?:\(\d+:\d+\)|:\d+:\d+)/i);
  if (buildFileMatch !== null) {
    return { failingFile: normalizeFailurePath(buildFileMatch[1] ?? "") };
  }
  return {};
}

function summarizeSuggestedRepair(text: string): string {
  if (/Found a label with the text of:|no form control was found associated to that label|htmlFor|aria-labelledby/i.test(text)) {
    return "Label/control association failed: ensure the label is associated with the intended form control by wrapping the control in the label or using htmlFor that exactly matches the input id; rerun validation.";
  }
  if (/[A-Za-z0-9_.\-\\/]+\.[cm]?[jt]sx?\s*(?:\(\d+:\d+\)|:\d+:\d+):\s*"[^"]+"\s+is not exported by/i.test(text)) {
    return "Import/export mismatch: an import in the failing file does not match the referenced module's actual exports; align the import form with what that module exports before rerunning validation.";
  }
  if (/Element type is invalid/i.test(text)) {
    return "Component import/export mismatch: inspect the changed file's local component imports and align every default import with a default export and every named import with a named export before rerunning validation.";
  }
  if (/toBeChecked\(\)|Received element is not checked/i.test(text)) {
    return "Checkbox assertion failed: make the target checkbox checked by default using a boolean checked/defaultChecked value or boolean state initialized to true; do not use a string checked attribute, and rerun validation.";
  }
  return "";
}

export function isFreshPassingValidation(validation: ValidationResult | null): validation is ValidationResult {
  if (validation?.status !== "passed") {
    return false;
  }
  return validation.freshness?.valid !== false;
}

export function requiresValidationRepairAction(validation: ValidationResult | null): validation is ValidationResult {
  if (validation?.status !== "failed") {
    return false;
  }
  return validation.failureSummary?.afterLatestMutation === true && validation.failureSummary.freshness === "fresh";
}

export function isValidationRepairAction(
  action: AgentAction,
  builderState: BuilderState,
  validation: ValidationResult
): boolean {
  if (action.type === "final" || action.type === "fail" || action.type === "ask_user") {
    return true;
  }
  if (action.type === "submit_execution_plan") {
    return true;
  }
  if (action.type !== "tool_call" && action.type !== "request_approval") {
    return false;
  }
  if (isChangedFileRepairReadAction(action, validation) || isBuilderTargetReadAction(action, builderState)) {
    return true;
  }
  return (
    action.toolCall.toolName === "filesystem.patch" ||
    action.toolCall.toolName === "filesystem.write" ||
    isValidationShellAction(action)
  );
}

function isChangedFileRepairReadAction(
  action: AgentAction,
  validation: ValidationResult
): boolean {
  if (action.type !== "tool_call" && action.type !== "request_approval") {
    return false;
  }
  if (action.toolCall.toolName !== "filesystem.read") {
    return false;
  }
  const path = (action.toolCall.input as { path?: unknown }).path;
  if (typeof path !== "string" || path.length === 0) {
    return false;
  }
  const summary = validation.failureSummary;
  if (summary === undefined || summary.afterLatestMutation !== true || summary.freshness !== "fresh") {
    return false;
  }
  const normalizedPath = normalizeWorkspaceRelativePath(path);
  return summary.changedFiles.map(normalizeWorkspaceRelativePath).includes(normalizedPath);
}

function isBuilderTargetReadAction(action: AgentAction, builderState: BuilderState): boolean {
  if (action.type !== "tool_call" && action.type !== "request_approval") {
    return false;
  }
  if (action.toolCall.toolName !== "filesystem.read") {
    return false;
  }
  if (builderState.currentStepId === null) {
    return false;
  }
  const path = (action.toolCall.input as { path?: unknown }).path;
  if (typeof path !== "string" || path.length === 0) {
    return false;
  }
  const currentStep = builderState.planSteps.find((step) => step.stepId === builderState.currentStepId);
  if (currentStep === undefined || currentStep.operation !== "modify") {
    return false;
  }
  const normalizedPath = normalizeWorkspaceRelativePath(path);
  return currentStep.targetFiles.map(normalizeWorkspaceRelativePath).includes(normalizedPath);
}

function isValidationShellAction(action: AgentAction): boolean {
  if (action.type !== "tool_call" && action.type !== "request_approval") {
    return false;
  }
  if (action.toolCall.toolName !== "shell.execute") {
    return false;
  }
  const input = action.toolCall.input as { purpose?: string; args?: string[] };
  const purpose = input.purpose ?? "";
  const args = input.args ?? [];
  return /(validat|verif|test|build)/i.test(purpose) && !args.includes("-e");
}

function summarizeFailureMessage(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const concrete = lines.find((line) => isConcreteDiagnosticLine(line));
  if (concrete !== undefined) {
    return concrete;
  }
  const preferred =
    lines.find((line) => /(Error|Assertion|Expected|Unable|Cannot|Received|expected)/i.test(line)) ??
    lines.find((line) => /(failed|FAIL)/i.test(line));
  return preferred ?? lines[0] ?? "";
}

function summarizeDiagnosticExcerpt(text: string, limit: number): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  const diagnostic = collectDiagnosticWindow(normalized, limit);
  if (diagnostic.length > 0) {
    return diagnostic;
  }
  const headLength = Math.floor((limit - 5) / 2);
  const tailLength = limit - 5 - headLength;
  return `${normalized.slice(0, headLength)}\n...\n${normalized.slice(normalized.length - tailLength)}`;
}

function collectDiagnosticWindow(text: string, limit: number): string {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  const selected: string[] = [];
  const concreteIndex = lines.findIndex((line) => isConcreteDiagnosticLine(line));
  const fallbackIndex = lines.findIndex((line) => isDiagnosticLine(line));
  const startIndex = concreteIndex >= 0 ? concreteIndex : fallbackIndex;
  if (startIndex < 0) {
    return "";
  }

  const contextStart = Math.max(0, startIndex - 3);
  const contextEnd = Math.min(lines.length, startIndex + 8);
  for (const line of lines.slice(contextStart, contextEnd)) {
    if (line.trim().length === 0 && selected.at(-1)?.trim().length === 0) {
      continue;
    }
    selected.push(line);
  }

  const withEarlierHeader = findNearbyDiagnosticHeader(lines, startIndex);
  if (withEarlierHeader !== undefined && !selected.includes(withEarlierHeader)) {
    selected.unshift(withEarlierHeader);
  }

  const summary = selected.join("\n").trim();
  if (summary.length <= limit) {
    return summary;
  }
  const concreteLine = lines[startIndex]?.trim() ?? "";
  if (concreteLine.length >= limit) {
    return `${concreteLine.slice(0, limit - 3)}...`;
  }
  return `${summary.slice(0, Math.max(0, limit - concreteLine.length - 8))}\n...\n${concreteLine}`;
}

function findNearbyDiagnosticHeader(lines: string[], diagnosticIndex: number): string | undefined {
  const searchStart = Math.max(0, diagnosticIndex - 20);
  for (let index = diagnosticIndex - 1; index >= searchStart; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (/error during build|build failed|test failed|failed tests|failures|\.(?:test|spec)\.[cm]?[jt]sx?/i.test(line)) {
      return line;
    }
  }
  return undefined;
}

function isConcreteDiagnosticLine(line: string): boolean {
  return (
    /[A-Za-z0-9_.\-\\/]+\.[cm]?[jt]sx?\s*(?:\(\d+:\d+\)|:\d+:\d+)/i.test(line) ||
    /(TestingLibraryElementError|AssertionError|SyntaxError|TypeError|ReferenceError|RollupError|TransformPluginContext)/i.test(line) ||
    /(Expected|Unexpected|Cannot|Could not resolve|Unable to find|Found a label|Received)/i.test(line)
  );
}

function isDiagnosticLine(line: string): boolean {
  return isConcreteDiagnosticLine(line) || /(error during build|build failed|test failed|failed|FAIL)/i.test(line);
}

function normalizeWorkspaceRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeFailurePath(path: string): string {
  return stripAnsi(path).replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function limitText(text: string, limit: number): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function stripAnsi(text: string): string {
  const ESC = String.fromCharCode(0x1b);
  const CSI = String.fromCharCode(0x9b);
  const BEL = String.fromCharCode(0x07);
  const pattern = new RegExp("[" + ESC + CSI + "][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?" + BEL + ")|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))", "g");
  return text.replace(pattern, "");
}

export async function computeChangedFilesFingerprint(workspaceRoot: string, changedFiles: string[]): Promise<string | undefined> {
  if (changedFiles.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (const changedFile of [...new Set(changedFiles)].sort()) {
    const absolutePath = join(workspaceRoot, changedFile);
    const content = await readFile(absolutePath, "utf8").catch(() => null);
    parts.push(`${changedFile}:${content === null ? "missing" : computeArtifactHash(content)}`);
  }

  return computeArtifactHash(parts.join("|"));
}
