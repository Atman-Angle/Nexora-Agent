import type { ExecutionRecord, ValidationResult } from "../../../contracts/src/index.js";

/** Explicit file-like tokens are Chat semantics, not a generic Harness workflow. */
export function extractChatSourcePaths(taskText: string): string[] {
  taskText = latestChatUserRequest(taskText);
  const matches = taskText.match(/(?:[A-Za-z0-9_@.-]+[\\/])*[A-Za-z0-9_@-]+\.[A-Za-z0-9_-]+/g) ?? [];
  return [...new Set(matches.map(normalizePath))];
}

export function evaluateChatSourceEvidence(input: {
  taskText: string;
  executionRecords: readonly ExecutionRecord[];
  base: ValidationResult;
}): ValidationResult {
  const requiredPaths = extractChatSourcePaths(input.taskText);
  if (requiredPaths.length === 0) return input.base;
  const readPaths = new Set(
    input.executionRecords
      .filter((record) => record.status === "success" && record.toolName === "filesystem.read")
      .map((record) => record.targetPath)
      .filter((path): path is string => path !== undefined)
      .map(normalizePath)
  );
  const missing = requiredPaths.filter((path) => !readPaths.has(path));
  if (missing.length === 0) return input.base;
  return {
    ...input.base,
    status: "failed",
    evidence: [
      ...input.base.evidence,
      ...missing.map((path) => ({
        code: "CHAT_EVIDENCE_MISSING",
        message: `Cannot finalize: required source ${path} has no successful filesystem.read evidence in this run.`
      }))
    ]
  };
}

/** Bounded explicit ordered read declarations; plain source lists stay unordered. */
export function extractOrderedChatReadPaths(taskText: string): string[] {
  taskText = latestChatUserRequest(taskText);
  const english = /\b(?:first|then|finally)\b\s+(?:read\s+)?((?:[A-Za-z0-9_@.-]+[\\/])*[A-Za-z0-9_@-]+\.[A-Za-z0-9_-]+)/gi;
  const chinese = /(?:首先|然后|最后)\s*(?:读取|读)\s*((?:[A-Za-z0-9_@.-]+[\\/])*[A-Za-z0-9_@-]+\.[A-Za-z0-9_-]+)/g;
  return [...orderedMatches(taskText, english), ...orderedMatches(taskText, chinese)];
}

export function evaluateChatOrderedReadCommitments(input: {
  taskText: string;
  executionRecords: readonly ExecutionRecord[];
  base: ValidationResult;
}): ValidationResult {
  const orderedPaths = extractOrderedChatReadPaths(input.taskText);
  if (orderedPaths.length < 2) return input.base;
  const reads = input.executionRecords
    .filter((record) => record.status === "success" && record.toolName === "filesystem.read" && record.targetPath !== undefined)
    .map((record) => normalizePath(record.targetPath!));
  let previousIndex = -1;
  for (const path of orderedPaths) {
    const index = reads.findIndex((candidate, candidateIndex) => candidateIndex > previousIndex && candidate === path);
    if (index < 0) {
      return {
        ...input.base,
        status: "failed",
        evidence: [
          ...input.base.evidence,
          {
            code: "CHAT_COMMITMENT_OUT_OF_ORDER",
            message: `Cannot finalize: ordered read commitment requires ${orderedPaths.join(" -> ")}.`
          }
        ]
      };
    }
    previousIndex = index;
  }
  return input.base;
}

/**
 * A large filesystem.read deliberately exposes only an artifact reference and
 * a bounded preview. Chat may describe that preview, but cannot silently turn
 * it into a full-document conclusion. This remains Chat language semantics;
 * the underlying artifact/execution facts are still owned by ToolRuntime.
 */
export function evaluateChatLargeDocumentCoverage(input: {
  taskText: string;
  finalText: string;
  executionRecords: readonly ExecutionRecord[];
  base: ValidationResult;
}): ValidationResult {
  const requestedPaths = new Set(extractChatSourcePaths(input.taskText));
  if (requestedPaths.size === 0) return input.base;
  const largePaths = input.executionRecords
    .filter((record) => record.status === "success" && record.toolName === "filesystem.read" && record.targetPath !== undefined)
    .map((record) => ({ record, path: normalizePath(record.targetPath!) }))
    .filter(({ record, path }) => requestedPaths.has(path) && isLargeFileRead(record));
  const missingDisclosure = largePaths
    .map(({ path }) => path)
    .filter((path) => !hasCoverageDisclosure(input.finalText, path));
  if (missingDisclosure.length === 0) return input.base;
  return {
    ...input.base,
    status: "failed",
    evidence: [
      ...input.base.evidence,
      ...missingDisclosure.map((path) => ({
        code: "CHAT_EVIDENCE_COVERAGE_INSUFFICIENT",
        message: `Cannot finalize: ${path} is available only as a large-file preview; name the source and disclose preview/partial coverage and unreviewed scope.`
      }))
    ]
  };
}

/** Mutation intent is Chat language semantics; effect and approval authority stay below the Profile. */
export function isChatMutationRequest(taskText: string): boolean {
  taskText = latestChatUserRequest(taskText);
  return /\b(?:change|modify|edit|update|rewrite|fix|add|remove|create|delete|rename|replace)\b|修改|更改|编辑|更新|重写|修复|新增|添加|删除|重命名|替换/i.test(taskText);
}

/**
 * A mutation request must be grounded in a completed filesystem mutation and a
 * subsequent successful validation command. Pending approvals/user input and
 * tool failures remain the responsibility of their existing shared handlers.
 */
export function evaluateChatMutationCompletion(input: {
  taskText: string;
  executionRecords: readonly ExecutionRecord[];
  base: ValidationResult;
}): ValidationResult {
  if (!isChatMutationRequest(input.taskText)) return input.base;
  const mutationIndex = input.executionRecords.reduce((latest, record, index) =>
    record.status === "success" && (record.toolName === "filesystem.patch" || record.toolName === "filesystem.write") ? index : latest,
  -1);
  if (mutationIndex < 0) {
    return failedChatMutationValidation(input.base, "CHAT_MUTATION_NOT_EXECUTED",
      "Cannot finalize: this is a modification request and no successful filesystem.patch or filesystem.write execution exists in this run.");
  }
  const hasValidationAfterMutation = input.executionRecords
    .slice(mutationIndex + 1)
    .some((record) => record.status === "success" && record.toolName === "shell.execute");
  if (hasValidationAfterMutation) return input.base;
  return failedChatMutationValidation(input.base, "CHAT_MUTATION_VALIDATION_MISSING",
    "Cannot finalize: a modification succeeded, but no successful validation command ran after that mutation.");
}

function orderedMatches(taskText: string, expression: RegExp): string[] {
  const paths: string[] = [];
  for (const match of taskText.matchAll(expression)) {
    const path = match[1];
    if (path !== undefined) paths.push(normalizePath(path));
  }
  return paths;
}

/** CLI stores the full conversation in the task goal; completion semantics apply only to its final user turn. */
function latestChatUserRequest(taskText: string): string {
  const marker = "\nUser: ";
  const start = taskText.lastIndexOf(marker);
  if (start < 0) return taskText;
  const requestStart = start + marker.length;
  const assistantMarker = "\nAssistant:";
  const end = taskText.indexOf(assistantMarker, requestStart);
  return end < 0 ? taskText.slice(requestStart) : taskText.slice(requestStart, end);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isLargeFileRead(record: ExecutionRecord): boolean {
  try {
    const result = JSON.parse(record.outputJson) as {
      output?: { kind?: unknown; reason?: unknown };
    };
    return result.output?.kind === "artifact_ref" && result.output.reason === "large_file";
  } catch {
    return false;
  }
}

function hasCoverageDisclosure(finalText: string, path: string): boolean {
  const fileName = path.split("/").at(-1) ?? path;
  const mentionsSource = finalText.toLowerCase().includes(fileName.toLowerCase());
  const describesLimitedCoverage = /\b(?:preview|partial|first\s+\d+|unreviewed|not\s+(?:fully|completely)\s+reviewed)\b|预览|部分|未审阅|未完整|全文未读/i.test(finalText);
  return mentionsSource && describesLimitedCoverage;
}

function failedChatMutationValidation(base: ValidationResult, code: string, message: string): ValidationResult {
  return {
    ...base,
    status: "failed",
    evidence: [...base.evidence, { code, message }]
  };
}
