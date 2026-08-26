import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { finished } from "node:stream/promises";

import { rgPath } from "@vscode/ripgrep";
import { z } from "zod";

import { ArtifactStore } from "../../store/artifacts.js";
import type { RuntimeTool } from "../../runtime.js";
import { attachToolFailureDiagnostics } from "../tool-diagnostics.js";
import {
  commandRejectionReason,
  normalizePackageManagerCommandInput,
  resolveExecutableCommand
} from "./command-resolution.js";
import {
  inspectManagedProcess,
  ManagedProcessInspectFactsSchema,
  ManagedProcessLogsFactsSchema,
  ManagedProcessStartFactsSchema,
  ManagedProcessStopFactsSchema,
  ProcessHandleInputSchema,
  ProcessLogsInputSchema,
  readManagedProcessLogs,
  StartManagedProcessInputSchema,
  startManagedProcess,
  stopManagedProcess
} from "./managed-process.js";
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
const MAX_SEARCH_MATCHES = 100;
const MAX_LIST_ENTRIES = 2_000;
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
const ListFactsSchema = z.object({
  entries: z.array(z.string()),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  truncated: z.boolean()
}).strict();
const SearchFactsSchema = z.object({
  matches: z.array(z.object({ path: z.string(), line: z.number().int().positive(), text: z.string() }).strict()),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  truncated: z.boolean()
}).strict();
const WriteFactsSchema = z.object({ path: z.string(), digest: DigestSchema, byteLength: z.number().int().nonnegative() }).strict();
const PatchFactsSchema = z.object({ path: z.string(), digest: DigestSchema, replayed: z.boolean() }).strict();
const ProcessFactsSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  stdoutArtifactRef: DigestSchema.nullable(),
  stderrArtifactRef: DigestSchema.nullable(),
  artifactRefs: z.array(DigestSchema),
  truncated: z.boolean(),
  timedOut: z.boolean(),
  processDisposition: z.enum(["exited", "terminated"]),
  processStillRunning: z.literal(false)
}).strict();
const ShellExecuteInputSchema = z.preprocess(normalizePackageManagerCommandInput, z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().default("."),
  timeoutMs: z.number().int().positive().max(300_000).default(60_000)
}).strict());

export function createBuiltInTools(options: { readonly artifactDir?: string } = {}): readonly RuntimeTool[] {
  return [
    defineTool({
      contract: {
        identity: { name: "filesystem.read" },
        capability: { purpose: "Retrieve UTF-8 content or one bounded character range from a known workspace file.", nonGoals: ["Discover an unknown path.", "Modify file content."] },
        decision: { useWhen: ["The exact target path is known and its content is required.", "A large file preview requires continuation from nextOffset."], avoidWhen: ["The target path is unresolved.", "Existing facts already contain the required content."] },
        execution: { effect: { kind: "read", description: "Reads one workspace file without modifying external state." }, idempotent: true, readCache: { mode: "until_mutation" }, inputSchema: ReadInput, inputExample: { path: "README.md", offset: 0, limit: 3000 } },
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
        execution: { effect: { kind: "read", description: "Enumerates workspace paths without modifying external state." }, idempotent: true, inputSchema: z.object({ path: z.string().default("."), offset: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(MAX_LIST_ENTRIES).default(MAX_LIST_ENTRIES) }).strict(), inputExample: { path: ".", offset: 0, limit: 2000 } },
        evidence: { produces: ["One deterministic recursive path page and the exact next offset when more entries exist."], factsSchema: ListFactsSchema }
      },
      async execute(input, context) {
        const requestedPath = input.path ?? ".";
        const directory = await workspacePath(context.workspace, requestedPath, "directory");
        const offset = input.offset ?? 0;
        const page = await listFilesPage(directory, offset, input.limit ?? MAX_LIST_ENTRIES, context.signal);
        const entries = page.entries.map((path) => relativeFromRequested(requestedPath, directory, path));
        return { subjectRef: `${requestedPath}#entries=${offset}-${offset + entries.length}`, facts: { entries, offset, nextOffset: page.nextOffset, truncated: page.nextOffset !== null } };
      }
    }),
    defineTool({
      contract: {
        identity: { name: "filesystem.search" },
        capability: { purpose: "Find a case-insensitive literal value inside UTF-8 file contents.", nonGoals: ["Discover a file by name.", "Interpret the query as a regular expression."] },
        decision: { useWhen: ["The required literal content is known but its file location is unresolved."], avoidWhen: ["The target path is already known.", "The uncertainty concerns a file name or path rather than content."] },
        execution: { effect: { kind: "read", description: "Reads bounded workspace text content without modifying external state." }, idempotent: true, inputSchema: z.object({ query: z.string().trim().min(1), path: z.string().default("."), offset: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(MAX_SEARCH_MATCHES).default(MAX_SEARCH_MATCHES) }).strict(), inputExample: { query: "TODO", path: ".", offset: 0, limit: 100 } },
        evidence: { produces: ["One deterministic matching-line page with paths, line numbers, bounded text and the exact next offset."], factsSchema: SearchFactsSchema }
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
            input.offset ?? 0,
            input.limit ?? MAX_SEARCH_MATCHES,
            context.signal
          )
        };
      }
    }),
    defineTool({
      contract: {
        identity: { name: "filesystem.write" },
        capability: { purpose: "Replace or create one known workspace file with complete content.", nonGoals: ["Apply a minimal change to existing content.", "Discover a target path."] },
        decision: {
          useWhen: [
            "The exact target path and complete desired content are known.",
            "Several known changes in one already-read file can be applied safely in one complete write."
          ],
          avoidWhen: ["Only one localized existing-content change is required.", "The desired content is unresolved."]
        },
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
            "A conflict requires content inspection rather than a digest-only retry.",
            "Several known edits to the same fully-read file would require serial patches; use one complete filesystem.write instead."
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
        identity: { name: "process.start" },
        capability: { purpose: "Start one persistent non-interactive workspace process and return after a declared readiness condition passes.", nonGoals: ["Run commands that naturally exit.", "Execute shell command strings.", "Start a service without a readiness condition."] },
        decision: { useWhen: ["A development server, preview server, watcher, worker, or other persistent local service must remain available after this Tool call."], avoidWhen: ["The command is expected to exit after build, test, lint, or migration work.", "The executable or readiness condition is unresolved."] },
        execution: { effect: { kind: "execute", description: "Starts or reuses the exact generation-bound persistent process identified by serviceKey and command digest." }, idempotent: true, inputSchema: StartManagedProcessInputSchema, inputExample: { command: "npm", args: ["run", "dev"], cwd: ".", serviceKey: "dev-server", readiness: { type: "tcp", host: "127.0.0.1", port: 4173 }, startupTimeoutMs: 30_000 } },
        evidence: { produces: ["A generation-bound process handle, command digest, PID, readiness time, endpoint, and replay fact."], factsSchema: ManagedProcessStartFactsSchema }
      },
      async execute(input, context) {
        const facts = await startManagedProcess(StartManagedProcessInputSchema.parse(input), { workspace: context.workspace, invocationId: context.invocationId, signal: context.signal });
        return { subjectRef: facts.processHandle, facts };
      }
    }),
    defineTool({
      contract: {
        identity: { name: "process.inspect" },
        capability: { purpose: "Inspect the current liveness and terminal facts of one exact managed process generation.", nonGoals: ["Discover an unknown service.", "Change process state."] },
        decision: { useWhen: ["A known process handle must be checked before claiming the service is running or stopped."], avoidWhen: ["No exact process handle is available."] },
        execution: { effect: { kind: "read", description: "Reads a managed process descriptor and verifies its supervisor heartbeat." }, idempotent: true, inputSchema: ProcessHandleInputSchema, inputExample: { processHandle: "process_00000000-0000-4000-8000-000000000000" } },
        evidence: { produces: ["Current process state, verified heartbeat freshness, endpoint, PID and exit facts."], factsSchema: ManagedProcessInspectFactsSchema }
      },
      async execute(input, context) {
        const facts = await inspectManagedProcess(context.workspace, input.processHandle);
        return { subjectRef: input.processHandle, facts };
      }
    }),
    defineTool({
      contract: {
        identity: { name: "process.logs" },
        capability: { purpose: "Read a bounded redacted tail from one exact managed process log.", nonGoals: ["Stream logs indefinitely.", "Change process state."] },
        decision: { useWhen: ["A known managed process requires startup or failure diagnostics."], avoidWhen: ["The process handle is unknown.", "Current process facts already answer the question."] },
        execution: { effect: { kind: "read", description: "Reads bounded workspace-local managed process logs." }, idempotent: true, inputSchema: ProcessLogsInputSchema, inputExample: { processHandle: "process_00000000-0000-4000-8000-000000000000", stream: "combined", tailBytes: 16_384 } },
        evidence: { produces: ["A bounded redacted log tail and an Artifact reference when the complete log is large."], factsSchema: ManagedProcessLogsFactsSchema }
      },
      async execute(input, context) {
        const parsed = ProcessLogsInputSchema.parse(input);
        const facts = await readManagedProcessLogs(context.workspace, parsed.processHandle, parsed.stream, parsed.tailBytes, options.artifactDir);
        return { subjectRef: input.processHandle, facts };
      }
    }),
    defineTool({
      contract: {
        identity: { name: "process.stop" },
        capability: { purpose: "Stop one exact managed process generation and its descendants, then confirm terminal state.", nonGoals: ["Stop arbitrary operating-system PIDs.", "Discover an unknown service."] },
        decision: { useWhen: ["A known managed process is no longer required or must be restarted with different configuration."], avoidWhen: ["No exact process handle is available."] },
        execution: { effect: { kind: "execute", description: "Terminates a previously managed process tree." }, idempotent: true, inputSchema: ProcessHandleInputSchema, inputExample: { processHandle: "process_00000000-0000-4000-8000-000000000000" } },
        evidence: { produces: ["Confirmed terminal state, stop time, exit code, and whether the process was already stopped."], factsSchema: ManagedProcessStopFactsSchema }
      },
      async execute(input, context) {
        const facts = await stopManagedProcess(context.workspace, input.processHandle, context.signal);
        return { subjectRef: input.processHandle, facts };
      }
    }),
    defineTool({
      contract: {
        identity: { name: "shell.execute" },
        capability: { purpose: "Run one known non-interactive executable that is expected to exit, with explicit arguments in the workspace.", nonGoals: ["Execute shell command strings.", "Discover which command should be run.", "Start a persistent server, watcher, listener, or background service."] },
        decision: { useWhen: ["The exact executable, arguments, working directory, and expected purpose are known and the command will naturally exit."], avoidWhen: ["A dedicated capability can produce the required facts.", "The command or its necessity is unresolved.", "The requested outcome requires the process to remain running after the Tool call; use process.start."] },
        execution: { effect: { kind: "execute", description: "Starts a process that may read, modify, or otherwise affect the workspace or external systems." }, idempotent: false, inputSchema: ShellExecuteInputSchema, inputExample: { command: "node", args: ["--test", "test/example.test.js"], cwd: ".", timeoutMs: 60_000 } },
        evidence: { produces: ["The process exit code, bounded stdout/stderr, timeout status, and truncation status."], factsSchema: ProcessFactsSchema }
      },
      async execute(input, context) {
        const parsed = ShellExecuteInputSchema.parse(input);
        const rejection = commandRejectionReason(parsed.command);
        if (rejection !== null) throw new ToolFailure("COMMAND_REJECTED", rejection);
        const cwd = await workspacePath(context.workspace, parsed.cwd, "directory");
        const result = await runProcess(
          parsed.command,
          parsed.args,
          cwd,
          parsed.timeoutMs,
          context.signal,
          parsed.cwd,
          options.artifactDir ?? join(context.workspace, ".nexora", "artifacts")
        );
        const details = processFailureDetails(parsed.command, parsed.args, parsed.cwd, result);
        if (result.timedOut) throw new ToolFailure("TOOL_TIMEOUT", "Process exceeded the synchronous execution timeout and its process tree was terminated. No background process remains. Use process.start for a persistent service.", true, details);
        if (result.exitCode !== 0) {
          throw new ToolFailure(
            "PROCESS_EXIT_NONZERO",
            `Process started and exited with code ${result.exitCode}. Inspect error details before changing the command or workspace.`,
            false,
            details
          );
        }
        return { subjectRef: `command:${parsed.command}`, facts: result };
      }
    }),
    ...gitTools(options)
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
  offset: number,
  limit: number,
  signal: AbortSignal
): Promise<{
  matches: Array<{ path: string; line: number; text: string }>;
  offset: number;
  nextOffset: number | null;
  truncated: boolean;
}> {
  const ignoredGlobs = [...IGNORED].sort().flatMap((name) => ["--glob", `!${name}/**`]);
  return new Promise((resolvePromise, rejectPromise) => {
    throwIfAborted(signal);
    const child = spawn(rgPath, [
      "--json", "--sort", "path", "--hidden", "--no-ignore", "--fixed-strings", "--ignore-case", "--max-filesize", "256K",
      ...ignoredGlobs, "-e", query, "--", "."
    ], { cwd: directory, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let seen = 0;
    let buffered = "";
    let hasMore = false;
    let stderr = "";
    let timedOut = false;
    let stoppedAfterPage = false;
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
      if (error === undefined) {
        const nextOffset = hasMore ? offset + matches.length : null;
        resolvePromise({ matches, offset, nextOffset, truncated: nextOffset !== null });
      }
      else rejectPromise(error);
    };
    const acceptLine = (line: string): void => {
      if (line.length === 0 || stoppedAfterPage) return;
      let event: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
      try { event = JSON.parse(line) as typeof event; } catch { return; }
      if (event.type !== "match") return;
      const current = seen;
      seen += 1;
      if (current < offset) return;
      if (matches.length >= limit) {
        hasMore = true;
        stoppedAfterPage = true;
        child.kill();
        return;
      }
      const path = event.data?.path?.text;
      const text = event.data?.lines?.text?.replace(/\r?\n$/, "");
      const lineNumber = event.data?.line_number;
      if (path === undefined || text === undefined || lineNumber === undefined) return;
      matches.push({
        path: relativeFromRequested(requestedPath, directory, join(directory, path)),
        line: lineNumber,
        text: text.slice(0, 500)
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        acceptLine(buffered.slice(0, newline).replace(/\r$/, ""));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, 500); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
    child.once("error", () => finish(new ToolFailure("SEARCH_ENGINE_ERROR", "Bundled Ripgrep could not be started.", true)));
    child.once("close", (code) => {
      if (!stoppedAfterPage) acceptLine(buffered.replace(/\r$/, ""));
      if (timedOut) finish(new ToolFailure("TOOL_TIMEOUT", "Filesystem search timed out.", true));
      else if (!stoppedAfterPage && code !== 0 && code !== 1) finish(new ToolFailure("SEARCH_ENGINE_ERROR", `Bundled Ripgrep failed.${stderr.trim() ? ` ${stderr.trim()}` : ""}`, true));
      else finish();
    });
  });
}

function gitTools(options: { readonly artifactDir?: string }): RuntimeTool[] {
  return [
    gitTool({
      name: "git.status",
      purpose: "Observe the current workspace change status.",
      nonGoals: ["Read file contents or diffs.", "Modify repository state."],
      useWhen: ["The current set of changed, untracked, or staged paths is required."],
      avoidWhen: ["Existing facts already establish the required workspace status."],
      produces: ["The bounded short-form repository status and process facts."],
      schema: z.object({}).strict(), inputExample: {}, args: () => ["status", "--short"]
    }, options.artifactDir),
    gitTool({
      name: "git.diff",
      purpose: "Observe unstaged repository differences for the workspace or one known path.",
      nonGoals: ["Read committed history.", "Modify repository state."],
      useWhen: ["The current unstaged changes are required as facts."],
      avoidWhen: ["The required fact is repository status or committed content rather than an unstaged diff."],
      produces: ["The bounded unstaged diff and process facts."],
      schema: z.object({ path: z.string().trim().min(1).optional() }).strict(), inputExample: {}, args: (input) => ["diff", "--", ...(input.path ? [input.path] : [])]
    }, options.artifactDir),
    gitTool({
      name: "git.show",
      purpose: "Observe content from one known repository revision, optionally limited to one path.",
      nonGoals: ["Read unstaged changes.", "Modify repository state."],
      useWhen: ["The exact revision is known and its committed content is required."],
      avoidWhen: ["The revision is unresolved or the required fact concerns the working tree."],
      produces: ["The bounded committed revision content and process facts."],
      schema: z.object({ revision: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/), path: z.string().trim().min(1).optional() }).strict(), inputExample: { revision: "HEAD" }, args: (input) => ["show", "--format=medium", input.revision, ...(input.path ? ["--", input.path] : [])]
    }, options.artifactDir)
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
}, artifactDir?: string): RuntimeTool {
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
        context.signal,
        context.workspace,
        artifactDir ?? join(context.workspace, ".nexora", "artifacts")
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
      readCache?: { readonly mode: "until_mutation" };
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

async function listFilesPage(
  root: string,
  offset: number,
  limit: number,
  signal: AbortSignal
): Promise<{ readonly entries: readonly string[]; readonly nextOffset: number | null }> {
  const entries: string[] = [];
  let seen = 0;
  for await (const path of walkFiles(root, signal)) {
    if (seen < offset) {
      seen += 1;
      continue;
    }
    if (entries.length >= limit) {
      return { entries, nextOffset: offset + entries.length };
    }
    entries.push(path);
    seen += 1;
  }
  return { entries, nextOffset: null };
}

async function* walkFiles(root: string, signal: AbortSignal): AsyncGenerator<string> {
  throwIfAborted(signal);
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => !entry.isSymbolicLink() && !IGNORED.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    throwIfAborted(signal);
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path, signal);
    else if (entry.isFile()) yield path;
  }
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
  reportedCwd = cwd,
  artifactDir = join(cwd, ".nexora", "artifacts")
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutArtifactRef: string | null;
  stderrArtifactRef: string | null;
  artifactRefs: string[];
  truncated: boolean;
  timedOut: boolean;
  processDisposition: "exited" | "terminated";
  processStillRunning: false;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    throwIfAborted(signal);
    let resolved;
    try {
      resolved = resolveExecutableCommand(command, args, cwd);
    } catch (error) {
      rejectPromise(new ToolFailure("COMMAND_UNAVAILABLE", error instanceof Error ? error.message : String(error)));
      return;
    }
    const child = spawn(resolved.command, [...resolved.args], {
      cwd,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const artifactStore = new ArtifactStore(artifactDir);
    const stdoutTemporary = artifactStore.temporaryPath("stdout");
    const stderrTemporary = artifactStore.temporaryPath("stderr");
    const stdoutSpool = createWriteStream(stdoutTemporary, { flags: "wx" });
    const stderrSpool = createWriteStream(stderrTemporary, { flags: "wx" });
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let stdoutBytes = 0; let stderrBytes = 0; let timedOut = false; let settled = false;
    const append = (current: Buffer, chunk: Buffer) => Buffer.concat([current, chunk]).subarray(0, MAX_CAPTURE_BYTES);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      stdout = append(stdout, chunk);
      if (!stdoutSpool.write(chunk)) {
        child.stdout.pause();
        stdoutSpool.once("drain", () => child.stdout.resume());
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      stderr = append(stderr, chunk);
      if (!stderrSpool.write(chunk)) {
        child.stderr.pause();
        stderrSpool.once("drain", () => child.stderr.resume());
      }
    });
    const discardSpools = (): void => {
      stdoutSpool.destroy();
      stderrSpool.destroy();
      void Promise.allSettled([rm(stdoutTemporary, { force: true }), rm(stderrTemporary, { force: true })]);
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      terminate();
      cleanup();
      discardSpools();
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
    const spoolError = (error: Error): void => {
      if (settled) return;
      settled = true;
      terminate();
      cleanup();
      discardSpools();
      rejectPromise(new ToolFailure(
        "ARTIFACT_WRITE_FAILED",
        `Process output could not be archived: ${error.message}`,
        true
      ));
    };
    stdoutSpool.once("error", spoolError);
    stderrSpool.once("error", spoolError);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      discardSpools();
      const identity = boundedProcessIdentity(command, args, reportedCwd);
      const resolution = resolved.strategy === null ? {} : {
        resolvedCommand: resolved.command,
        resolution: resolved.strategy
      };
      rejectPromise(new ToolFailure(
        "PROCESS_START_FAILED",
        `Process could not be started: ${error.message}. The executable did not run; change the executable or its platform-specific form before retrying.`,
        false,
        {
          ...identity,
          ...resolution,
          causeCode: "code" in error && typeof error.code === "string" ? error.code : null
        }
      ));
    });
    child.once("close", (code) => { void (async () => {
      if (settled) return;
      settled = true;
      cleanup();
      stdoutSpool.end();
      stderrSpool.end();
      try {
        await Promise.all([finished(stdoutSpool), finished(stderrSpool)]);
        const stdoutArtifact = stdoutBytes > MAX_CAPTURE_BYTES
          ? await artifactStore.putFile(stdoutTemporary, "text/plain")
          : null;
        const stderrArtifact = stderrBytes > MAX_CAPTURE_BYTES
          ? await artifactStore.putFile(stderrTemporary, "text/plain")
          : null;
        if (stdoutArtifact === null) await rm(stdoutTemporary, { force: true });
        if (stderrArtifact === null) await rm(stderrTemporary, { force: true });
        const artifactRefs = [stdoutArtifact?.digest, stderrArtifact?.digest]
          .filter((value): value is string => value !== undefined);
        resolvePromise({
          exitCode: code ?? 1,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          stdoutBytes,
          stderrBytes,
          stdoutArtifactRef: stdoutArtifact?.digest ?? null,
          stderrArtifactRef: stderrArtifact?.digest ?? null,
          artifactRefs,
          truncated: artifactRefs.length > 0,
          timedOut,
          processDisposition: timedOut ? "terminated" : "exited",
          processStillRunning: false
        });
      } catch (error) {
        discardSpools();
        rejectPromise(new ToolFailure("ARTIFACT_WRITE_FAILED", error instanceof Error ? error.message : String(error), true));
      }
    })(); });
  });
}

function processFailureDetails(
  command: string,
  args: readonly string[],
  cwd: string,
  result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly stdoutBytes: number; readonly stderrBytes: number; readonly stdoutArtifactRef: string | null; readonly stderrArtifactRef: string | null; readonly artifactRefs: readonly string[]; readonly truncated: boolean; readonly timedOut: boolean; readonly processDisposition: "exited" | "terminated"; readonly processStillRunning: false }
): Record<string, unknown> {
  const identity = boundedProcessIdentity(command, args, cwd);
  return {
    ...identity,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutArtifactRef: result.stdoutArtifactRef,
    stderrArtifactRef: result.stderrArtifactRef,
    artifactRefs: result.artifactRefs,
    truncated: result.truncated || identity.identityTruncated,
    timedOut: result.timedOut,
    processDisposition: result.processDisposition,
    processStillRunning: result.processStillRunning
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
