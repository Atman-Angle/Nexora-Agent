import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join, relative } from "node:path";

import { rgPath } from "@vscode/ripgrep";
import { Lang, parse, pattern } from "@ast-grep/napi";

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
import { searchDocuments } from "./document-search.js";
import type { ToolExecutionTelemetry } from "./tool-definition.js";

export type FilesystemSearchToolCall = {
  toolCallId: string;
  toolName: string;
  input: FilesystemSearchInput;
  timeoutMs: number;
};

const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules", "dist", "coverage", "tmp"]);
const MAX_SEARCH_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_INLINE_JSON_CHARS = 3_500;
const MAX_RIPGREP_OUTPUT_BYTES = 512 * 1024;
const MAX_AST_OUTPUT_BYTES = 512 * 1024;
const RIPGREP_IGNORED_GLOBS = [...IGNORED_DIRECTORY_NAMES].map((name) => `!${name}/**`);
const DOCUMENT_SUFFIX = /\.(pdf|docx|pptx|xlsx|png|jpe?g|tiff|bmp)$/i;

export function isIgnoredSearchEntry(name: string, isDirectory: boolean, symlinkTargetIsDirectory: boolean): boolean {
  return IGNORED_DIRECTORY_NAMES.has(name) && (isDirectory || symlinkTargetIsDirectory);
}

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
  telemetry: ToolExecutionTelemetry;
}> {
  const startedAt = performance.now();
  const telemetry: ToolExecutionTelemetry = { scannedFiles: 0, readBytes: 0 };
  const queryText = input.toolCall.input.query.trim();
  if (queryText.length === 0) {
    throw new ToolRuntimeError("EMPTY_SEARCH_QUERY", "Search query must not be empty.", false);
  }

  const normalizedQuery = normalizeSearchQuery(queryText);
  const structuralQuery = isAstPattern(queryText);
  const collectedMatches = new Map<string, SearchMatch>();
  const candidatePaths = new Set<string>();
  const symlinks = await inspectWorkspaceSymlinks(input.workspaceRoot, input.signal);
  const fileListing = await listRipgrepFiles(input.workspaceRoot, input.signal);
  const paths = [...new Set([...fileListing.paths, ...symlinks.map((entry) => entry.path)])];
  telemetry.scannedFiles = paths.length;

  for (const relativePath of paths) {
    const fileName = basename(relativePath);
    const score = scorePathMatch(relativePath, fileName, normalizedQuery);
    if (score > 0) {
      candidatePaths.add(relativePath);
      addMatch(collectedMatches, createPathOnlyMatch(relativePath, fileName, score, collectPathReasons(relativePath, fileName, normalizedQuery)));
    }
  }

  const contentSearch = structuralQuery || normalizedQuery.tokens.length === 0 ? { stdout: Buffer.alloc(0), outputLimited: false } : await runRipgrep({
    cwd: input.workspaceRoot,
    args: [
      "--json", "--stats", "--hidden", "--no-ignore", "--fixed-strings", "--ignore-case", "--max-filesize", String(MAX_SEARCH_FILE_BYTES),
      ...RIPGREP_IGNORED_GLOBS.flatMap((glob) => ["--glob", glob]),
      ...normalizedQuery.tokens.flatMap((token) => ["-e", token]),
      ".",
      ...symlinks.filter((entry) => entry.isFile).map((entry) => entry.path)
    ],
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const contentTelemetry = collectRipgrepMatches({
    output: contentSearch.stdout,
    query: normalizedQuery,
    matches: collectedMatches,
    candidatePaths
  });
  telemetry.readBytes = contentTelemetry.readBytes;
  const astSearch = structuralQuery
    ? await searchAst({ workspaceRoot: input.workspaceRoot, paths, query: queryText, ...(input.signal === undefined ? {} : { signal: input.signal }) })
    : { matches: [], fallbackPaths: [], readBytes: 0, outputBytes: 0, durationMs: 0, truncated: false };
  const fallbackSearch = astSearch.fallbackPaths.length === 0 ? { stdout: Buffer.alloc(0), outputLimited: false } : await runRipgrep({
    cwd: input.workspaceRoot,
    args: [
      "--json", "--stats", "--hidden", "--no-ignore", "--fixed-strings", "--ignore-case", "--max-filesize", String(MAX_SEARCH_FILE_BYTES),
      ...RIPGREP_IGNORED_GLOBS.flatMap((glob) => ["--glob", glob]), "-e", queryText, "--", ...astSearch.fallbackPaths
    ],
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const fallbackTelemetry = collectRipgrepMatches({ output: fallbackSearch.stdout, query: normalizedQuery, matches: collectedMatches, candidatePaths });
  telemetry.readBytes += astSearch.readBytes + fallbackTelemetry.readBytes;
  telemetry.astDurationMs = astSearch.durationMs;
  telemetry.astMatches = astSearch.matches.length;
  telemetry.astOutputBytes = astSearch.outputBytes;
  for (const match of astSearch.matches) {
    candidatePaths.add(match.path);
    addMatch(collectedMatches, match);
  }
  const hasSourceMatches = [...collectedMatches.values()].some((match) => !DOCUMENT_SUFFIX.test(match.path));
  const documentSearch = structuralQuery
    ? { segments: [], readBytes: 0, truncated: false, workerDurationMs: 0, workerOutputBytes: 0 }
    : await searchDocuments({ workspaceRoot: input.workspaceRoot, paths, ...(input.signal === undefined ? {} : { signal: input.signal }) })
      .catch((error: unknown) => {
        if (
          hasSourceMatches &&
          error instanceof ToolRuntimeError &&
          error.code === "RUNTIME_ERROR" &&
          error.message === "Docling Python or preloaded model directory is not configured."
        ) {
          return { segments: [], readBytes: 0, truncated: false, workerDurationMs: 0, workerOutputBytes: 0 };
        }
        throw error;
      });
  telemetry.readBytes += documentSearch.readBytes;
  telemetry.documentSegments = documentSearch.segments.length;
  telemetry.workerDurationMs = documentSearch.workerDurationMs;
  telemetry.workerOutputBytes = documentSearch.workerOutputBytes;
  for (const segment of documentSearch.segments) {
    const normalized = segment.text.toLowerCase();
    const count = normalizedQuery.tokens.filter((token) => normalized.includes(token)).length;
    if (count === 0) continue;
    const fileName = basename(segment.path);
    const column = Math.max(0, normalized.indexOf(normalizedQuery.normalizedText)) + 1;
    candidatePaths.add(segment.path);
    addMatch(collectedMatches, { path: segment.path, fileName, line: 0, column, snippet: `[${segment.location}] ${segment.text.slice(0, WORKING_SET_BUDGET.maxSnippetChars)}`, score: scorePathMatch(segment.path, fileName, normalizedQuery) + count * 8 + (column > 0 ? 80 : 0), reasons: ["content_keyword"] });
  }

  const rankedMatches = [...collectedMatches.values()]
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
    });
  const seenPaths = new Set<string>();
  const distinctPathMatches: SearchMatch[] = [];
  for (const match of rankedMatches) {
    if (!seenPaths.has(match.path)) distinctPathMatches.push(match);
    seenPaths.add(match.path);
  }
  const sortedMatches = distinctPathMatches.slice(0, input.toolCall.input.limit);

  const searchResult = SearchResultSchema.parse({
    query: normalizedQuery,
    totalCandidates: candidatePaths.size,
    returnedMatches: sortedMatches.length,
    truncated: fileListing.outputLimited || contentSearch.outputLimited || fallbackSearch.outputLimited || astSearch.truncated || documentSearch.truncated || candidatePaths.size > sortedMatches.length,
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
      telemetry: { ...telemetry, localDurationMs: performance.now() - startedAt },
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
    }),
    telemetry: { ...telemetry, localDurationMs: performance.now() - startedAt }
  };
}

type WorkspaceSymlink = {
  path: string;
  isFile: boolean;
};

async function inspectWorkspaceSymlinks(workspaceRoot: string, signal?: AbortSignal): Promise<WorkspaceSymlink[]> {
  const root = await realpath(workspaceRoot);
  const symlinks: WorkspaceSymlink[] = [];

  async function walk(currentDirectory: string): Promise<void> {
    if (signal?.aborted) {
      throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
    }
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const fullPath = join(currentDirectory, entry.name);
      const symlinkTargetIsDirectory = IGNORED_DIRECTORY_NAMES.has(entry.name) && entry.isSymbolicLink()
        ? (await stat(fullPath)).isDirectory()
        : false;
      if (isIgnoredSearchEntry(entry.name, entry.isDirectory(), symlinkTargetIsDirectory)) continue;
      const relativePath = relative(workspaceRoot, fullPath).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isSymbolicLink()) {
        continue;
      }
      const target = await realpath(fullPath);
      if (!isWithinRoot(root, target)) {
        throw new ToolRuntimeError("SYMLINK_ESCAPE", "Symlink target escapes the workspace root.", false);
      }
      symlinks.push({ path: relativePath, isFile: (await stat(target)).isFile() });
    }
  }

  await walk(workspaceRoot);
  return symlinks;
}

async function listRipgrepFiles(workspaceRoot: string, signal?: AbortSignal): Promise<{ paths: string[]; outputLimited: boolean }> {
  const result = await runRipgrep({
    cwd: workspaceRoot,
    args: ["--files", "--hidden", "--no-ignore", ...RIPGREP_IGNORED_GLOBS.flatMap((glob) => ["--glob", glob]), "."],
    ...(signal === undefined ? {} : { signal })
  });
  return {
    paths: result.stdout.toString("utf8").split(/\r?\n/).filter(Boolean).map(normalizeRipgrepPath),
    outputLimited: result.outputLimited
  };
}

async function runRipgrep(input: { cwd: string; args: string[]; signal?: AbortSignal }): Promise<{ stdout: Buffer; outputLimited: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let outputBytes = 0;
    let outputLimited = false;
    let settled = false;
    const chunks: Buffer[] = [];
    const child = spawn(rgPath, input.args, { cwd: input.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const finish = (error?: ToolRuntimeError): void => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      if (error !== undefined) rejectPromise(error);
      else resolvePromise({ stdout: Buffer.concat(chunks), outputLimited });
    };
    const abort = (): void => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outputLimited) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_RIPGREP_OUTPUT_BYTES) {
        outputLimited = true;
        abort();
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", (error: Error & { code?: string }) => {
      finish(error.code === "ENOENT"
        ? new ToolRuntimeError("RUNTIME_ERROR", "Bundled Ripgrep executable was not found.", true)
        : new ToolRuntimeError("RUNTIME_ERROR", "Failed to launch bundled Ripgrep.", true));
    });
    child.once("close", (code) => {
      if (input.signal?.aborted) {
        finish(new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true));
      } else if (!outputLimited && code !== 0 && code !== 1) {
        finish(new ToolRuntimeError("RUNTIME_ERROR", "Bundled Ripgrep search failed.", true));
      } else {
        finish();
      }
    });
  });
}

function collectRipgrepMatches(input: {
  query: SearchQuery;
  matches: Map<string, SearchMatch>;
  candidatePaths: Set<string>;
  output: Buffer;
}): { readBytes: number } {
  let readBytes = 0;
  const seenSnippets = new Set<string>();
  for (const line of input.output.toString("utf8").split(/\r?\n/)) {
    if (line.length === 0) continue;
    let event: { type?: string; data?: Record<string, unknown> };
    try { event = JSON.parse(line) as { type?: string; data?: Record<string, unknown> }; } catch { continue; }
    if (event.type === "summary") {
      const stats = event.data?.stats as { bytes_searched?: number } | undefined;
      readBytes = stats?.bytes_searched ?? readBytes;
      continue;
    }
    if (event.type !== "match") continue;
    const data = event.data ?? {};
    const path = data.path as { text?: string } | undefined;
    const lines = data.lines as { text?: string } | undefined;
    const relativePath = path?.text === undefined ? undefined : normalizeRipgrepPath(path.text);
    const lineText = lines?.text === undefined ? undefined : lines.text.replace(/\r?\n$/, "");
    const lineNumber = typeof data.line_number === "number" ? data.line_number : 0;
    if (relativePath === undefined || lineText === undefined || lineNumber === 0) continue;
    const fileName = basename(relativePath);
    const baseScore = scorePathMatch(relativePath, fileName, input.query);
    const pathReasons = collectPathReasons(relativePath, fileName, input.query);
    const normalizedLine = lineText.toLowerCase();
    const snippet = lineText.trim().slice(0, WORKING_SET_BUDGET.maxSnippetChars);
    if (snippet.length === 0) continue;
    const exactColumn = normalizedLine.indexOf(input.query.normalizedText);
    const tokenMatchCount = input.query.tokens.filter((token) => normalizedLine.includes(token)).length;
    const score = baseScore + (exactColumn >= 0 ? 80 : 0) + tokenMatchCount * 8;
    if (score === 0) continue;
    const reasons = new Set(pathReasons);
    if (exactColumn >= 0) reasons.add("exact_text");
    if (tokenMatchCount > 0) reasons.add("content_keyword");
    const key = `${relativePath}:${snippet}`;
    if (seenSnippets.has(key)) continue;
    seenSnippets.add(key);
    input.candidatePaths.add(relativePath);
    addMatch(input.matches, {
      path: relativePath,
      fileName,
      line: lineNumber,
      column: exactColumn >= 0 ? exactColumn + 1 : 1,
      snippet,
      score,
      reasons: [...reasons].sort((left, right) => left.localeCompare(right, "en"))
    });
  }
  return { readBytes };
}

function addMatch(matches: Map<string, SearchMatch>, match: SearchMatch): void {
  const key = `${match.path}:${match.line}:${match.column}:${match.snippet}`;
  if (!matches.has(key)) matches.set(key, match);
}

function normalizeRipgrepPath(path: string): string {
  return path.replace(/^\.([\\/])/, "").replaceAll("\\", "/");
}

function isAstPattern(query: string): boolean {
  return /\${1,3}[A-Z_][A-Z0-9_]*/.test(query);
}

function languageForPath(path: string): Lang | undefined {
  const lower = path.toLowerCase();
  if (/\.(ts|mts|cts)$/.test(lower)) return Lang.TypeScript;
  if (lower.endsWith(".tsx")) return Lang.Tsx;
  if (/\.(js|mjs|cjs)$/.test(lower)) return Lang.JavaScript;
  if (lower.endsWith(".jsx")) return Lang.Tsx;
  if (lower.endsWith(".css")) return Lang.Css;
  if (/\.(html|htm)$/.test(lower)) return Lang.Html;
  return undefined;
}

async function searchAst(input: { workspaceRoot: string; paths: string[]; query: string; signal?: AbortSignal }): Promise<{ matches: SearchMatch[]; fallbackPaths: string[]; readBytes: number; outputBytes: number; durationMs: number; truncated: boolean }> {
  const startedAt = performance.now();
  const matches: SearchMatch[] = [];
  const fallbackPaths = new Set(input.paths.filter((path) => languageForPath(path) === undefined && !DOCUMENT_SUFFIX.test(path)));
  let readBytes = 0;
  let outputBytes = 0;
  let truncated = false;

  for (const relativePath of input.paths) {
    if (input.signal?.aborted) throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
    const language = languageForPath(relativePath);
    if (language === undefined) continue;
    const fullPath = join(input.workspaceRoot, relativePath);
    const size = await stat(fullPath);
    if (size.size > MAX_SEARCH_FILE_BYTES) {
      truncated = true;
      continue;
    }
    const source = await readFile(fullPath, "utf8");
    readBytes += Buffer.byteLength(source, "utf8");
    try {
      const matcher = pattern(language, input.query);
      const nodes = parse(language, source).root().findAll(matcher);
      if (nodes.length === 0) {
        fallbackPaths.add(relativePath);
        continue;
      }
      for (const node of nodes) {
        if (input.signal?.aborted) throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
        const range = node.range();
        const snippet = node.text().trim().slice(0, WORKING_SET_BUDGET.maxSnippetChars);
        const snippetBytes = Buffer.byteLength(snippet, "utf8");
        if (outputBytes + snippetBytes > MAX_AST_OUTPUT_BYTES) {
          truncated = true;
          break;
        }
        outputBytes += snippetBytes;
        matches.push({
          path: relativePath,
          fileName: basename(relativePath),
          line: range.start.line + 1,
          column: range.start.column + 1,
          snippet,
          score: scorePathMatch(relativePath, basename(relativePath), normalizeSearchQuery(input.query)) + 100,
          reasons: ["ast_pattern"]
        });
      }
    } catch (error) {
      if (error instanceof ToolRuntimeError) throw error;
      fallbackPaths.add(relativePath);
    }
  }

  return { matches, fallbackPaths: [...fallbackPaths], readBytes, outputBytes, durationMs: performance.now() - startedAt, truncated };
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
  const canonicalQuery = canonicalSymbol(query.normalizedText);
  let score = 0;

  if (isProductionSourcePath(normalizedPath)) {
    score += 40;
  }

  if (looksLikeExplicitPath(query.text) && normalizedPath.includes(query.normalizedText)) {
    score += 120;
  }

  if (normalizedFileName === query.normalizedText || (canonicalQuery.length > 0 && canonicalFileStem(fileName) === canonicalQuery)) {
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

  if (isProductionSourcePath(normalizedPath)) {
    reasons.add("production_source");
  }

  if (looksLikeExplicitPath(query.text) && normalizedPath.includes(query.normalizedText)) {
    reasons.add("explicit_path");
  }

  const canonicalQuery = canonicalSymbol(query.normalizedText);
  if (normalizedFileName === query.normalizedText || (canonicalQuery.length > 0 && canonicalFileStem(fileName) === canonicalQuery)) {
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

function canonicalFileStem(fileName: string): string {
  return canonicalSymbol(fileName.replace(/\.[^.]+$/u, ""));
}

function isProductionSourcePath(path: string): boolean {
  return /^(?:apps|packages)\//u.test(path) &&
    !/^packages\/contracts\//u.test(path) &&
    /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|c(?:pp)?|h(?:pp)?|html?|css|sql)$/u.test(path);
}

function canonicalSymbol(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
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

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  if (candidatePath === rootPath) {
    return true;
  }

  return candidatePath.startsWith(`${rootPath}\\`) || candidatePath.startsWith(`${rootPath}/`);
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
