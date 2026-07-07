import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { buildWorkingSet, WORKING_SET_BUDGET } from "../../context/src/index.js";
import {
  SearchQuerySchema,
  SearchResultSchema,
  ToolResultSchema,
  createFileArtifact,
  type Artifact,
  type FilesystemSearchInput,
  type SearchMatch,
  type SearchQuery,
  type ToolResult
} from "../../contracts/src/index.js";
import { computeArtifactHash } from "../../contracts/src/artifact.js";
import { ToolRuntimeError } from "./errors.js";

export type FilesystemSearchToolCall = {
  toolCallId: string;
  toolName: string;
  input: FilesystemSearchInput;
  timeoutMs: number;
};

const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules", "dist", "coverage", "tmp"]);
const MAX_SEARCH_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_INLINE_JSON_CHARS = 3_500;

export async function executeFilesystemSearch(input: {
  runId: string;
  toolCall: FilesystemSearchToolCall;
  workspaceRoot: string;
  artifactRoot: string;
  artifactId: string;
  now: string;
  signal?: AbortSignal;
}): Promise<{
  toolResult: ToolResult;
  artifacts?: Artifact[];
}> {
  const queryText = input.toolCall.input.query.trim();
  if (queryText.length === 0) {
    throw new ToolRuntimeError("EMPTY_SEARCH_QUERY", "Search query must not be empty.", false);
  }

  const normalizedQuery = normalizeSearchQuery(queryText);
  const collectedMatches = new Map<string, SearchMatch>();
  const candidatePaths = new Set<string>();

  await walkWorkspace({
    workspaceRoot: input.workspaceRoot,
    currentDirectory: input.workspaceRoot,
    query: normalizedQuery,
    matches: collectedMatches,
    candidatePaths,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });

  const sortedMatches = [...collectedMatches.values()]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (left.path !== right.path) {
        return left.path.localeCompare(right.path, "en");
      }

      if (left.line !== right.line) {
        return left.line - right.line;
      }

      return left.column - right.column;
    })
    .slice(0, input.toolCall.input.limit);

  const searchResult = SearchResultSchema.parse({
    query: normalizedQuery,
    totalCandidates: candidatePaths.size,
    returnedMatches: sortedMatches.length,
    truncated: collectedMatches.size > sortedMatches.length,
    matches: sortedMatches
  });
  const { workingSet, contextManifest } = buildWorkingSet(searchResult);

  const inlinePayload = JSON.stringify({
    result: searchResult,
    workingSet,
    contextManifest
  });

  if (inlinePayload.length > MAX_TOTAL_INLINE_JSON_CHARS) {
    const artifact = await persistSearchArtifact({
      runId: input.runId,
      artifactRoot: input.artifactRoot,
      artifactId: input.artifactId,
      jsonPayload: inlinePayload,
      createdAt: input.now
    });

    return {
      artifacts: [artifact],
      toolResult: ToolResultSchema.parse({
        toolCallId: input.toolCall.toolCallId,
        toolName: "filesystem.search",
        status: "success",
        output: {
          kind: "search_artifact_ref",
          artifactId: artifact.artifactId,
          result: searchResult,
          workingSet,
          contextManifest,
          reason: "result_budget"
        }
      })
    };
  }

  return {
    toolResult: ToolResultSchema.parse({
      toolCallId: input.toolCall.toolCallId,
      toolName: "filesystem.search",
      status: "success",
      output: {
        kind: "search_inline",
        result: searchResult,
        workingSet,
        contextManifest
      }
    })
  };
}

async function walkWorkspace(input: {
  workspaceRoot: string;
  currentDirectory: string;
  query: SearchQuery;
  matches: Map<string, SearchMatch>;
  candidatePaths: Set<string>;
  signal?: AbortSignal;
}): Promise<void> {
  if (input.signal?.aborted) {
    throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
  }

  const directoryEntries = await readdir(input.currentDirectory, {
    withFileTypes: true
  });
  directoryEntries.sort((left, right) => left.name.localeCompare(right.name, "en"));

  for (const entry of directoryEntries) {
    if (input.signal?.aborted) {
      throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
    }

    const fullPath = join(input.currentDirectory, entry.name);
    const relativePath = relative(input.workspaceRoot, fullPath).replaceAll("\\", "/");

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }

      await ensureRealPathWithinWorkspace(input.workspaceRoot, fullPath);
      await walkWorkspace({
        ...input,
        currentDirectory: fullPath
      });
      continue;
    }

    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    const resolvedFilePath = await ensureRealPathWithinWorkspace(input.workspaceRoot, fullPath);
    const fileStat = await stat(resolvedFilePath);
    const fileName = basename(relativePath);
    const baseScore = scorePathMatch(relativePath, fileName, input.query);
    const reasons = collectPathReasons(relativePath, fileName, input.query);

    let textContent = "";
    let isBinary = false;
    if (fileStat.size <= MAX_SEARCH_FILE_BYTES) {
      try {
        const buffer = await readFile(resolvedFilePath, { signal: input.signal });
        isBinary = looksBinary(buffer);
        if (!isBinary) {
          textContent = buffer.toString("utf8");
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
        }
      }
    }

    if (isBinary) {
      continue;
    }

    const contentMatches = textContent.length === 0 ? [] : findContentMatches(relativePath, fileName, textContent, input.query, baseScore, reasons);
    const pathOnlyMatch = baseScore > 0 ? createPathOnlyMatch(relativePath, fileName, baseScore, reasons) : null;
    const allMatches = pathOnlyMatch === null ? contentMatches : [pathOnlyMatch, ...contentMatches];

    if (allMatches.length === 0) {
      continue;
    }

    input.candidatePaths.add(relativePath);
    for (const match of allMatches) {
      const key = `${match.path}:${match.line}:${match.column}:${match.snippet}`;
      if (!input.matches.has(key)) {
        input.matches.set(key, match);
      }
    }
  }
}

function normalizeSearchQuery(text: string): SearchQuery {
  const normalizedText = text.trim().toLowerCase();
  const tokens = [...new Set(normalizedText.split(/[\s/_\\\-.]+/).map((token) => token.trim()).filter(Boolean))];

  return SearchQuerySchema.parse({
    text,
    normalizedText,
    tokens
  });
}

function scorePathMatch(relativePath: string, fileName: string, query: SearchQuery): number {
  const normalizedPath = relativePath.toLowerCase();
  const normalizedFileName = fileName.toLowerCase();
  let score = 0;

  if (looksLikeExplicitPath(query.text) && normalizedPath.includes(query.normalizedText)) {
    score += 120;
  }

  if (normalizedFileName === query.normalizedText) {
    score += 100;
  }

  for (const token of query.tokens) {
    if (normalizedFileName.includes(token)) {
      score += 25;
    } else if (normalizedPath.includes(token)) {
      score += 12;
    }
  }

  return score;
}

function collectPathReasons(relativePath: string, fileName: string, query: SearchQuery): string[] {
  const reasons = new Set<string>();
  const normalizedPath = relativePath.toLowerCase();
  const normalizedFileName = fileName.toLowerCase();

  if (looksLikeExplicitPath(query.text) && normalizedPath.includes(query.normalizedText)) {
    reasons.add("explicit_path");
  }

  if (normalizedFileName === query.normalizedText) {
    reasons.add("exact_file_name");
  }

  for (const token of query.tokens) {
    if (normalizedFileName.includes(token)) {
      reasons.add("file_name_keyword");
    } else if (normalizedPath.includes(token)) {
      reasons.add("path_keyword");
    }
  }

  return [...reasons];
}

function findContentMatches(
  relativePath: string,
  fileName: string,
  textContent: string,
  query: SearchQuery,
  baseScore: number,
  pathReasons: string[]
): SearchMatch[] {
  const lines = textContent.split(/\r?\n/);
  const matches: SearchMatch[] = [];
  const seenSnippets = new Set<string>();
  let lineNumber = 0;

  for (const line of lines) {
    lineNumber += 1;
    const normalizedLine = line.toLowerCase();
    const snippet = line.trim().slice(0, WORKING_SET_BUDGET.maxSnippetChars);
    if (snippet.length === 0) {
      continue;
    }

    const reasons = new Set<string>(pathReasons);
    let score = baseScore;
    const exactColumn = normalizedLine.indexOf(query.normalizedText);
    if (query.normalizedText.length > 0 && exactColumn >= 0) {
      score += 80;
      reasons.add("exact_text");
    }

    let tokenMatchCount = 0;
    for (const token of query.tokens) {
      if (normalizedLine.includes(token)) {
        tokenMatchCount += 1;
      }
    }
    if (tokenMatchCount > 0) {
      score += tokenMatchCount * 8;
      reasons.add("content_keyword");
    }

    if (score === 0) {
      continue;
    }

    const key = `${relativePath}:${snippet}`;
    if (seenSnippets.has(key)) {
      continue;
    }
    seenSnippets.add(key);

    matches.push({
      path: relativePath,
      fileName,
      line: lineNumber,
      column: exactColumn >= 0 ? exactColumn + 1 : 1,
      snippet,
      score,
      reasons: [...reasons].sort((left, right) => left.localeCompare(right, "en"))
    });
  }

  return matches;
}

function createPathOnlyMatch(relativePath: string, fileName: string, score: number, reasons: string[]): SearchMatch {
  return {
    path: relativePath,
    fileName,
    line: 0,
    column: 0,
    snippet: `Path match: ${relativePath}`,
    score,
    reasons: reasons.length === 0 ? ["path_keyword"] : reasons
  };
}

function looksLikeExplicitPath(query: string): boolean {
  return query.includes("/") || query.includes("\\") || query.includes(".");
}

async function ensureRealPathWithinWorkspace(workspaceRoot: string, candidatePath: string): Promise<string> {
  const absoluteWorkspaceRoot = resolve(workspaceRoot);
  const absoluteCandidatePath = resolve(candidatePath);
  if (!isWithinRoot(absoluteWorkspaceRoot, absoluteCandidatePath)) {
    throw new ToolRuntimeError("PATH_ESCAPE", "Requested path escapes the workspace root.", false);
  }

  const realWorkspaceRoot = await realpath(absoluteWorkspaceRoot);
  const realCandidatePath = await realpath(absoluteCandidatePath);
  if (!isWithinRoot(realWorkspaceRoot, realCandidatePath)) {
    throw new ToolRuntimeError("SYMLINK_ESCAPE", "Symlink target escapes the workspace root.", false);
  }

  return realCandidatePath;
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  if (candidatePath === rootPath) {
    return true;
  }

  return candidatePath.startsWith(`${rootPath}${sep}`);
}

function looksBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 512);
  for (let index = 0; index < sampleLength; index += 1) {
    const value = buffer[index] ?? 0;
    if (value === 0) {
      return true;
    }

    if (value < 7 || (value > 14 && value < 32)) {
      return true;
    }
  }

  return false;
}

async function persistSearchArtifact(input: {
  runId: string;
  artifactRoot: string;
  artifactId: string;
  jsonPayload: string;
  createdAt: string;
}): Promise<Artifact> {
  const artifactPath = join(input.artifactRoot, `${input.artifactId}.json`);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, input.jsonPayload, "utf8");

  return createFileArtifact({
    artifactId: input.artifactId,
    runId: input.runId,
    mimeType: "application/json",
    content: "Search results externalized as JSON artifact.",
    filePath: artifactPath,
    sizeBytes: Buffer.byteLength(input.jsonPayload, "utf8"),
    hash: computeArtifactHash(input.jsonPayload),
    createdAt: input.createdAt
  });
}
