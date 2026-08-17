import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import { rgPath } from "@vscode/ripgrep";
import { z } from "zod";

import { ArtifactStore } from "../../store/artifacts.js";
import type { RuntimeTool } from "../../runtime.js";
import { attachToolFailureDiagnostics } from "../tool-diagnostics.js";
import { ToolFailure, workspacePath, writableWorkspacePath } from "./workspace.js";

const ReadInput = z.object({
  path: z.string().trim().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(3_000).optional()
}).strict();
const MAX_INLINE_BYTES = 16 * 1024;
const MAX_READ_RANGE_BYTES = 2_800;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_PROCESS_DIAGNOSTIC_ARGUMENTS = 64;
const MAX_PROCESS_DIAGNOSTIC_TEXT_CHARACTERS = 2048;
const MAX_SEARCH_OUTPUT_BYTES = 512 * 1024;
const MAX_SEARCH_MATCHES = 100;
const IGNORED = new Set([".git", ".nexora", "node_modules", "dist", "coverage"]);
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ReadFactsSchema = z.union([
  z.object({ path: z.string(), content: z.string(), digest: DigestSchema, byteLength: z.number().int().nonnegative() }).strict(),
  z.object({ path: z.string(), preview: z.string(), digest: DigestSchema, artifactRef: z.string(), byteLength: z.number().int().nonnegative() }).strict(),
  z.object({
    path: z.string(),
    content: z.string(),
    digest: DigestSchema,
    byteLength: z.number().int().nonnegative(),
    characterLength: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    returnedCharacters: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    truncated: z.boolean()
  }).strict()
]);
const ListFactsSchema = z.object({ entries: z.array(z.string()), truncated: z.boolean() }).strict();
const SearchFactsSchema = z.object({
  matches: z.array(z.object({ path: z.string(), line: z.number().int().positive(), text: z.string() }).strict()),
  truncated: z.boolean()
}).strict();
const WriteFactsSchema = z.object({ path: z.string(), digest: DigestSchema, byteLength: z.number().int().nonnegative() }).strict();
const PatchFactsSchema = z.object({ path: z.string(), digest: DigestSchema, replayed: z.boolean() }).strict();
const ProcessFactsSchema = z.object({
  exitCode: z.number().int(), stdout: z.string(), stderr: z.string(), truncated: z.boolean(), timedOut: z.boolean()
}).strict();

export function createBuiltInTools(options: { readonly artifactDir?: string } = {}): readonly RuntimeTool[] {
  return [
    defineTool({
      contract: {
        identity: { name: "filesystem.read" },
        capability: { purpose: "Retrieve UTF-8 content or one bounded character range from a known workspace file.", nonGoals: ["Discover an unknown path.", "Modify file content."] },
        decision: { useWhen: ["The exact target path is known and its content is required.", "A large file preview requires continuation from nextOffset."], avoidWhen: ["The target path is unresolved.", "Existing facts already contain the required content."] },
        execution: { effect: { kind: "read", description: "Reads one workspace file without modifying external state." }, idempotent: true, inputSchema: ReadInput, inputExample: { path: "README.md", offset: 0, limit: 3000 } },
        evidence: { produces: ["The target path, bounded content or preview, full-file digest and size, plus nextOffset for ranged continuation."], factsSchema: ReadFactsSchema }
      },
      async execute(input, context) {
        throwIfAborted(context.signal);
        const path = await workspacePath(context.workspace, input.path, "file");
        const bytes = await readFile(path);
        throwIfAborted(context.signal);
        const content = bytes.toString("utf8");
        if (input.offset !== undefined || input.limit !== undefined) {
          const offset = Math.min(input.offset ?? 0, content.length);
          const requestedEnd = Math.min(content.length, offset + (input.limit ?? 3_000));
          const ranged = boundedUtf8Slice(content, offset, requestedEnd, MAX_READ_RANGE_BYTES);
          const nextOffset = ranged.end < content.length ? ranged.end : null;
          return {
            subjectRef: `${input.path}#chars=${offset}-${ranged.end}`,
            facts: {
              path: input.path,
              content: ranged.content,
              digest: digest(content),
              byteLength: bytes.byteLength,
              characterLength: content.length,
              offset,
              returnedCharacters: ranged.end - offset,
              nextOffset,
              truncated: nextOffset !== null
            }
          };
        }
        if (bytes.byteLength <= MAX_INLINE_BYTES) return { subjectRef: input.path, facts: { path: input.path, content, digest: digest(content), byteLength: bytes.byteLength } };
        const artifact = new ArtifactStore(options.artifactDir ?? join(context.workspace, ".nexora", "artifacts")).putText(content);
        return { subjectRef: input.path, facts: { path: input.path, preview: content.slice(0, 500), digest: digest(content), artifactRef: artifact.digest, byteLength: artifact.byteLength } };
      }
    }),
    defineTool({
      contract: {
        identity: { name: "filesystem.list" },
        capability: { purpose: "Discover workspace file names and paths under one known directory.", nonGoals: ["Read file contents.", "Search for text inside files."] },
        decision: { useWhen: ["A required path is unknown but its containing directory is known."], avoidWhen: ["The exact target path is already known.", "The uncertainty concerns file content rather than path."] },
        execution: { effect: { kind: "read", description: "Enumerates workspace paths without modifying external state." }, idempotent: true, inputSchema: z.object({ path: z.string().default(".") }).strict(), inputExample: { path: "." } },
        evidence: { produces: ["A bounded recursive list of file paths and whether it was truncated."], factsSchema: ListFactsSchema }
      },
      async execute(input, context) {
        const requestedPath = input.path ?? ".";
        const directory = await workspacePath(context.workspace, requestedPath, "directory");
        const entries = (await listFiles(directory, context.signal))
          .map((path) => relativeFromRequested(requestedPath, directory, path));
        return { subjectRef: requestedPath, facts: { entries: entries.slice(0, 2000), truncated: entries.length > 2000 } };
      }
    }),
    defineTool({
      contract: {
        identity: { name: "filesystem.search" },
        capability: { purpose: "Find a case-insensitive literal value inside UTF-8 file contents.", nonGoals: ["Discover a file by name.", "Interpret the query as a regular expression."] },
        decision: { useWhen: ["The required literal content is known but its file location is unresolved."], avoidWhen: ["The target path is already known.", "The uncertainty concerns a file name or path rather than content."] },
        execution: { effect: { kind: "read", description: "Reads bounded workspace text content without modifying external state." }, idempotent: true, inputSchema: z.object({ query: z.string().trim().min(1), path: z.string().default(".") }).strict(), inputExample: { query: "TODO", path: "." } },
        evidence: { produces: ["Matching file paths, line numbers, bounded line text, and truncation status."], factsSchema: SearchFactsSchema }
      },
      async execute(input, context) {
        const requestedPath = input.path ?? ".";
        const directory = await workspacePath(context.workspace, requestedPath, "directory");
        return {
          subjectRef: `search:${input.query}`,
          facts: await searchWithRipgrep(
            directory,
            requestedPath,
            input.query,
            context.signal
          )
        };
      }
    }),
    defineTool({
      contract: {
        identity: { name: "filesystem.write" },
        capability: { purpose: "Replace or create one known workspace file with complete content.", nonGoals: ["Apply a minimal change to existing content.", "Discover a target path."] },
        decision: { useWhen: ["The exact target path and complete desired content are known."], avoidWhen: ["Only a localized existing-content change is required.", "The desired content is unresolved."] },
        execution: { effect: { kind: "write", description: "Atomically creates or replaces one workspace file." }, idempotent: true, inputSchema: z.object({ path: z.string().trim().min(1), content: z.string() }).strict(), inputExample: { path: "output.txt", content: "example" } },
        evidence: { produces: ["The written path, resulting content digest, and byte length."], factsSchema: WriteFactsSchema }
      },
      async execute(input, context) {
        const path = await writableWorkspacePath(context.workspace, input.path);
        await atomicWrite(path, input.content, context.signal);
        return { subjectRef: input.path, facts: { path: input.path, digest: digest(input.content), byteLength: Buffer.byteLength(input.content) } };
      }
    }),
    defineTool({
      contract: {
        identity: { name: "filesystem.patch" },
        capability: { purpose: "Replace one exact occurrence in a known workspace file guarded by its content digest.", nonGoals: ["Rewrite an entire file.", "Apply ambiguous or multi-location edits."] },
        decision: {
          useWhen: [
            "The path, current digest, unique old text, and replacement text are known.",
            "After CONTENT_CONFLICT, the returned recovery is retry_with_current_digest and the same exact edit is still intended."
          ],
          avoidWhen: [
            "The current content or digest is unknown.",
            "The replacement target is missing or not unique.",
            "A conflict requires content inspection rather than a digest-only retry."
          ]
        },
        execution: { effect: { kind: "write", description: "Atomically changes one exact occurrence in one workspace file." }, idempotent: true, inputSchema: z.object({
          path: z.string().trim().min(1),
          expectedDigest: DigestSchema,
          find: z.string().min(1, "Patch find must be non-empty. Read the current file and provide one unique existing text, or use filesystem.write when replacing the complete file with known content."),
          replace: z.string()
        }).strict().superRefine((input, context) => {
          if (input.find === input.replace) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["replace"],
              message: "Patch replacement must differ from find text."
            });
          }
        }), inputExample: { path: "source.txt", expectedDigest: `sha256:${"0".repeat(64)}`, find: "old", replace: "new" } },
        evidence: { produces: ["The changed path, resulting digest, and whether an idempotent replay was detected."], factsSchema: PatchFactsSchema }
      },
      async execute(input, context) {
        throwIfAborted(context.signal);
        const path = await workspacePath(context.workspace, input.path, "file");
        const current = await readFile(path, "utf8");
        throwIfAborted(context.signal);
        const currentDigest = digest(current);
        if (currentDigest !== input.expectedDigest) {
          if (!current.includes(input.find) && current.includes(input.replace)) return { subjectRef: input.path, facts: { path: input.path, digest: currentDigest, replayed: true } };
          const findOccurrences = countExactOccurrences(current, input.find);
          const recovery = findOccurrences === 1
            ? "retry_with_current_digest"
            : "inspect_current_content";
          throw new ToolFailure(
            "CONTENT_CONFLICT",
            "File content no longer matches expectedDigest. Use details.currentDigest only when details.recovery permits the same exact patch; otherwise inspect current content.",
            false,
            {
              path: input.path,
              expectedDigest: input.expectedDigest,
              currentDigest,
              findOccurrences,
              recovery
            }
          );
        }
        const first = current.indexOf(input.find);
        if (first < 0 || current.indexOf(input.find, first + input.find.length) >= 0) throw new ToolFailure("PATCH_CONFLICT", "Patch find text must occur exactly once.");
        const next = `${current.slice(0, first)}${input.replace}${current.slice(first + input.find.length)}`;
        if (digest(next) === digest(current)) {
          throw new ToolFailure("PATCH_NOOP", "Patch would not change the file content. Change the replacement or revise the Plan.");
        }
        await atomicWrite(path, next, context.signal);
        return { subjectRef: input.path, facts: { path: input.path, digest: digest(next), replayed: false } };
      }
    }),
    defineTool({
      contract: {
        identity: { name: "shell.execute" },
        capability: { purpose: "Run one known non-interactive executable with explicit arguments in the workspace.", nonGoals: ["Execute shell command strings.", "Discover which command should be run."] },
        decision: { useWhen: ["The exact executable, arguments, working directory, and expected purpose are known."], avoidWhen: ["A dedicated capability can produce the required facts.", "The command or its necessity is unresolved."] },
        execution: { effect: { kind: "execute", description: "Starts a process that may read, modify, or otherwise affect the workspace or external systems." }, idempotent: false, inputSchema: z.object({ command: z.string().trim().min(1), args: z.array(z.string()).default([]), cwd: z.string().default("."), timeoutMs: z.number().int().positive().max(300_000).default(60_000) }).strict(), inputExample: { command: "node", args: ["--test", "test/example.test.js"], cwd: ".", timeoutMs: 60_000 } },
        evidence: { produces: ["The process exit code, bounded stdout/stderr, timeout status, and truncation status."], factsSchema: ProcessFactsSchema }
      },
      async execute(input, context) {
        if (["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "sh", "bash"].includes(basename(input.command).toLowerCase())) throw new ToolFailure("COMMAND_REJECTED", "Interactive shell entrypoints are not allowed.");
        const cwd = await workspacePath(context.workspace, input.cwd ?? ".", "directory");
        const result = await runProcess(
          input.command,
          input.args ?? [],
          cwd,
          input.timeoutMs ?? 60_000,
          context.signal,
          input.cwd ?? "."
        );
        const details = processFailureDetails(input.command, input.args ?? [], input.cwd ?? ".", result);
        if (result.timedOut) throw new ToolFailure("TOOL_TIMEOUT", "Process timed out and was terminated.", true, details);
        if (result.exitCode !== 0) {
          throw new ToolFailure(
            "PROCESS_EXIT_NONZERO",
            `Process started and exited with code ${result.exitCode}. Inspect error details before changing the command or workspace.`,
            false,
            details
          );
        }
        return { subjectRef: `command:${input.command}`, facts: result };
      }
    }),
    ...gitTools()
  ];
}

function boundedUtf8Slice(
  content: string,
  start: number,
  requestedEnd: number,
  maxBytes: number
): { readonly content: string; readonly end: number } {
  let low = start;
  let high = requestedEnd;
  while (low < high) {
    let middle = Math.ceil((low + high) / 2);
    if (middle < content.length && middle > start && isLowSurrogate(content.charCodeAt(middle))) {
      middle -= 1;
    }
    if (middle <= low) break;
    if (Buffer.byteLength(content.slice(start, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end === start && start < content.length) {
    end = isHighSurrogate(content.charCodeAt(start)) ? Math.min(content.length, start + 2) : start + 1;
  }
  return { content: content.slice(start, end), end };
}

function countExactOccurrences(content: string, target: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - target.length) {
    const match = content.indexOf(target, offset);
    if (match < 0) break;
    count += 1;
    offset = match + target.length;
  }
  return count;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xD800 && value <= 0xDBFF;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xDC00 && value <= 0xDFFF;
}

async function searchWithRipgrep(
  directory: string,
  requestedPath: string,
  query: string,
  signal: AbortSignal
): Promise<{
  matches: Array<{ path: string; line: number; text: string }>;
  truncated: boolean;
}> {
  const ignoredGlobs = [...IGNORED].sort().flatMap((name) => ["--glob", `!${name}/**`]);
  const result = await runRipgrep([
    "--json", "--hidden", "--no-ignore", "--fixed-strings", "--ignore-case", "--max-filesize", "256K",
    ...ignoredGlobs, "-e", query, "--", "."
  ], directory, signal);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let event: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
    try { event = JSON.parse(line) as typeof event; } catch { continue; }
    if (event.type !== "match") continue;
    const path = event.data?.path?.text;
    const text = event.data?.lines?.text?.replace(/\r?\n$/, "");
    const lineNumber = event.data?.line_number;
    if (path === undefined || text === undefined || lineNumber === undefined) continue;
    matches.push({
      path: relativeFromRequested(requestedPath, directory, join(directory, path)),
      line: lineNumber,
      text: text.slice(0, 500)
    });
  }
  matches.sort((left, right) => left.path.localeCompare(right.path, "en") || left.line - right.line || left.text.localeCompare(right.text, "en"));
  return { matches: matches.slice(0, MAX_SEARCH_MATCHES), truncated: result.outputLimited || matches.length > MAX_SEARCH_MATCHES };
}

function runRipgrep(
  args: string[],
  cwd: string,
  signal: AbortSignal
): Promise<{ stdout: string; outputLimited: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    throwIfAborted(signal);
    const child = spawn(rgPath, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let outputLimited = false;
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const abort = (): void => {
      child.kill();
      finish(new ToolFailure("CANCELLED", "Filesystem search was cancelled."));
    };
    const finish = (error?: ToolFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error === undefined) resolvePromise({ stdout: Buffer.concat(chunks).toString("utf8"), outputLimited });
      else rejectPromise(error);
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (outputLimited) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_SEARCH_OUTPUT_BYTES) {
        outputLimited = true;
        child.kill();
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, 500); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
    child.once("error", () => finish(new ToolFailure("SEARCH_ENGINE_ERROR", "Bundled Ripgrep could not be started.", true)));
    child.once("close", (code) => {
      if (timedOut) finish(new ToolFailure("TOOL_TIMEOUT", "Filesystem search timed out.", true));
      else if (!outputLimited && code !== 0 && code !== 1) finish(new ToolFailure("SEARCH_ENGINE_ERROR", `Bundled Ripgrep failed.${stderr.trim() ? ` ${stderr.trim()}` : ""}`, true));
      else finish();
    });
  });
}

function gitTools(): RuntimeTool[] {
  return [
    gitTool({
      name: "git.status",
      purpose: "Observe the current workspace change status.",
      nonGoals: ["Read file contents or diffs.", "Modify repository state."],
      useWhen: ["The current set of changed, untracked, or staged paths is required."],
      avoidWhen: ["Existing facts already establish the required workspace status."],
      produces: ["The bounded short-form repository status and process facts."],
      schema: z.object({}).strict(), inputExample: {}, args: () => ["status", "--short"]
    }),
    gitTool({
      name: "git.diff",
      purpose: "Observe unstaged repository differences for the workspace or one known path.",
      nonGoals: ["Read committed history.", "Modify repository state."],
      useWhen: ["The current unstaged changes are required as facts."],
      avoidWhen: ["The required fact is repository status or committed content rather than an unstaged diff."],
      produces: ["The bounded unstaged diff and process facts."],
      schema: z.object({ path: z.string().trim().min(1).optional() }).strict(), inputExample: {}, args: (input) => ["diff", "--", ...(input.path ? [input.path] : [])]
    }),
    gitTool({
      name: "git.show",
      purpose: "Observe content from one known repository revision, optionally limited to one path.",
      nonGoals: ["Read unstaged changes.", "Modify repository state."],
      useWhen: ["The exact revision is known and its committed content is required."],
      avoidWhen: ["The revision is unresolved or the required fact concerns the working tree."],
      produces: ["The bounded committed revision content and process facts."],
      schema: z.object({ revision: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/), path: z.string().trim().min(1).optional() }).strict(), inputExample: { revision: "HEAD" }, args: (input) => ["show", "--format=medium", input.revision, ...(input.path ? ["--", input.path] : [])]
    })
  ];
}

function gitTool<T>(definition: {
  name: string;
  purpose: string;
  nonGoals: readonly string[];
  useWhen: readonly string[];
  avoidWhen: readonly string[];
  produces: readonly string[];
  schema: z.ZodType<T>;
  inputExample: unknown;
  args(input: T): string[];
}): RuntimeTool {
  return defineTool({
    contract: {
      identity: { name: definition.name },
      capability: { purpose: definition.purpose, nonGoals: definition.nonGoals },
      decision: { useWhen: definition.useWhen, avoidWhen: definition.avoidWhen },
      execution: { effect: { kind: "read", description: "Reads repository state without modifying external state." }, idempotent: true, inputSchema: definition.schema, inputExample: definition.inputExample },
      evidence: { produces: definition.produces, factsSchema: ProcessFactsSchema }
    },
    async execute(input, context) {
      const result = await runProcess(
        "git",
        definition.args(input),
        context.workspace,
        30_000,
        context.signal
      );
      if (result.timedOut) throw new ToolFailure("TOOL_TIMEOUT", "Git command timed out.", true);
      if (result.exitCode !== 0) throw new ToolFailure("GIT_COMMAND_FAILED", result.stderr || "Git command failed.");
      return { subjectRef: `git:${definition.name}`, facts: result };
    }
  });
}

function defineTool<Input, Facts>(definition: {
  contract: {
    identity: { name: string };
    capability: { purpose: string; nonGoals: readonly string[] };
    decision: { useWhen: readonly string[]; avoidWhen: readonly string[] };
    execution: {
      effect: { kind: "read" | "write" | "execute"; description: string };
      idempotent: boolean;
      inputSchema: z.ZodType<Input>;
      inputExample: unknown;
    };
    evidence: { produces: readonly string[]; factsSchema: z.ZodType<Facts> };
  };
  execute(input: Input, context: Parameters<RuntimeTool["execute"]>[1]): Promise<{ subjectRef: string; facts: Facts }>;
}): RuntimeTool {
  const schema = definition.contract.execution.inputSchema;
  return {
    contract: definition.contract as RuntimeTool["contract"],
    async execute(input, context) {
      try {
        throwIfAborted(context.signal);
        const result = await definition.execute(schema.parse(input), context);
        throwIfAborted(context.signal);
        return { status: "success", subjectRef: result.subjectRef, facts: result.facts as never };
      }
      catch (error) {
        const failure = context.signal.aborted
          ? new ToolFailure("CANCELLED", "Tool execution was cancelled.")
          : error instanceof ToolFailure
            ? error
            : new ToolFailure("TOOL_EXECUTION_ERROR", error instanceof Error ? error.message : String(error), true);
        const result = {
          status: "failure" as const,
          subjectRef: definition.contract.identity.name,
          error: {
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable
          }
        };
        return failure.details === undefined
          ? result
          : attachToolFailureDiagnostics(result, failure.details);
      }
    }
  };
}

async function listFiles(root: string, signal: AbortSignal): Promise<string[]> {
  const output: string[] = [];
  const pending = [root];
  while (pending.length > 0 && output.length < 2001) {
    throwIfAborted(signal);
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      throwIfAborted(signal);
      if (entry.isSymbolicLink() || IGNORED.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  return output.sort();
}

async function atomicWrite(
  path: string,
  content: string,
  signal: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, "utf8");
  try {
    throwIfAborted(signal);
    await rename(temporary, path);
  }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  reportedCwd = cwd
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    throwIfAborted(signal);
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let timedOut = false; let settled = false;
    const append = (current: Buffer, chunk: Buffer) => Buffer.concat([current, chunk]).subarray(0, MAX_CAPTURE_BYTES);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const abort = (): void => {
      if (settled) return;
      settled = true;
      terminate();
      cleanup();
      rejectPromise(new ToolFailure("CANCELLED", "Process execution was cancelled."));
    };
    const terminate = (): void => {
      if (process.platform === "win32" && child.pid !== undefined) {
        const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore"
        });
        if (killed.error === undefined && killed.status === 0) return;
      } else if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall through to the direct child kill below.
        }
      }
      child.kill("SIGKILL");
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      const identity = boundedProcessIdentity(command, args, reportedCwd);
      rejectPromise(new ToolFailure(
        "PROCESS_START_FAILED",
        `Process could not be started: ${error.message}`,
        false,
        {
          ...identity,
          causeCode: "code" in error && typeof error.code === "string" ? error.code : null
        }
      ));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ exitCode: code ?? 1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated: stdout.length >= MAX_CAPTURE_BYTES || stderr.length >= MAX_CAPTURE_BYTES, timedOut });
    });
  });
}

function processFailureDetails(
  command: string,
  args: readonly string[],
  cwd: string,
  result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly truncated: boolean; readonly timedOut: boolean }
): Record<string, unknown> {
  const identity = boundedProcessIdentity(command, args, cwd);
  return {
    ...identity,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated || identity.identityTruncated,
    timedOut: result.timedOut
  };
}

function boundedProcessIdentity(
  command: string,
  args: readonly string[],
  cwd: string
): { command: string; args: string[]; cwd: string; identityTruncated: boolean } {
  const boundedArgs = args
    .slice(0, MAX_PROCESS_DIAGNOSTIC_ARGUMENTS)
    .map((arg) => arg.slice(0, MAX_PROCESS_DIAGNOSTIC_TEXT_CHARACTERS));
  return {
    command: command.slice(0, MAX_PROCESS_DIAGNOSTIC_TEXT_CHARACTERS),
    args: boundedArgs,
    cwd: cwd.slice(0, MAX_PROCESS_DIAGNOSTIC_TEXT_CHARACTERS),
    identityTruncated: command.length > MAX_PROCESS_DIAGNOSTIC_TEXT_CHARACTERS
      || cwd.length > MAX_PROCESS_DIAGNOSTIC_TEXT_CHARACTERS
      || args.length > MAX_PROCESS_DIAGNOSTIC_ARGUMENTS
      || args.some((arg) => arg.length > MAX_PROCESS_DIAGNOSTIC_TEXT_CHARACTERS)
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new ToolFailure("CANCELLED", "Tool execution was cancelled.");
}

function digest(content: string): string { return `sha256:${createHash("sha256").update(content).digest("hex")}`; }
function relativeFromRequested(requested: string, root: string, path: string): string {
  const prefix = requested === "." ? "" : requested.replaceAll("\\", "/").replace(/\/$/, "");
  const child = relative(root, path).replaceAll("\\", "/");
  return prefix ? `${prefix}/${child}` : child;
}
