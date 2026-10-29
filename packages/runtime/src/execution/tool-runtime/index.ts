import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream } from "node:fs";
import { open, opendir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  resolveExecutableCommand,
  resolveWindowsSystemExecutable
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
const MAX_READABLE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_READ_RANGE_BYTES = 2_800;
const STREAM_CHUNK_BYTES = 64 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_PROCESS_DIAGNOSTIC_ARGUMENTS = 64;
const MAX_PROCESS_DIAGNOSTIC_TEXT_CHARACTERS = 2048;
const MAX_SEARCH_MATCHES = 100;
const MAX_LIST_ENTRIES = 2_000;
const MAX_LIST_OFFSET = 50_000;
const MAX_LIST_VISITED_ENTRIES = 50_000;
const MAX_LIST_DEPTH = 64;
const IGNORED = new Set([".git", ".nexora", "node_modules", "dist", "coverage"]);
const IGNORED_FILES = new Set([".env", ".env.local", ".env.production", ".env.development", "desktop-secrets.env"]);
const GIT_SECRET_PATHSPECS = [
  ":(exclude,icase,glob).env*",
  ":(exclude,icase,glob)**/.env*",
  ":(exclude,icase,glob)desktop-secrets.env",
  ":(exclude,icase,glob)**/desktop-secrets.env"
] as const;
const GitPathSchema = z.string().trim().min(1).refine(
  (value) => !value.startsWith(":"),
  "Git pathspec magic is not allowed; pass one workspace-relative path."
);
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
const HttpRequestInputSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  timeoutMs: z.number().int().positive().max(30_000).default(10_000),
  maxResponseBytes: z.number().int().positive().max(64 * 1024).default(16 * 1024),
  expectedStatus: z.number().int().min(100).max(599).default(200),
  expectedContentType: z.string().trim().min(1).optional()
}).strict();
const HttpFactsSchema = z.object({
  url: z.string(),
  method: z.enum(["GET", "HEAD"]),
  status: z.number().int(),
  statusText: z.string(),
  contentType: z.string().nullable(),
  body: z.string(),
  byteLength: z.number().int().nonnegative(),
  truncated: z.boolean(),
  elapsedMs: z.number().int().nonnegative()
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
  command: z.string().trim().min(1).describe(
    "One native executable name or path only. Do not include arguments, shell operators, redirections, pipelines, built-ins, or shell/script-wrapper entrypoints."
  ),
  args: z.array(z.string()).default([]).describe(
    "Explicit argument tokens passed directly to the executable without shell parsing. Put every argument here as a separate array item."
  ),
  cwd: z.string().default(".").describe("Workspace-relative working directory for the process."),
  timeoutMs: z.number().int().positive().max(300_000).default(60_000).describe(
    "Maximum synchronous execution time in milliseconds."
  )
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
        if (isSecretFilePath(input.path)) {
          throw new ToolFailure("SECRET_FILE_READ_BLOCKED", "Workspace secret files are not readable by the Agent.");
        }
        const path = await workspacePath(context.workspace, input.path, "file");
        await assertReadableFileIsNotSecret(context.workspace, input.path, path);
        const fileStat = await stat(path);
        if (fileStat.size > MAX_READABLE_FILE_BYTES) {
          throw new ToolFailure(
            "FILE_TOO_LARGE",
            `File ${input.path} is ${fileStat.size} bytes; the bounded text read limit is ${MAX_READABLE_FILE_BYTES} bytes.`,
            false,
            { path: input.path, byteLength: fileStat.size, maxBytes: MAX_READABLE_FILE_BYTES }
          );
        }
        if (fileStat.size <= MAX_INLINE_BYTES) {
          const bytes = await readTrustedFile(path, fileStat);
          throwIfAborted(context.signal);
          const content = decodeUtf8Text(bytes, input.path);
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
          return { subjectRef: input.path, facts: { path: input.path, content, digest: digest(content), byteLength: bytes.byteLength } };
        }

        const artifactStore = new ArtifactStore(options.artifactDir ?? join(context.workspace, ".nexora", "artifacts"));
        if (input.offset !== undefined || input.limit !== undefined) {
          const offset = input.offset ?? 0;
          const limit = input.limit ?? 3_000;
          const streamed = await readUtf8File(path, input.path, context.signal, fileStat, { kind: "range", offset, limit });
          const rangeContent = streamed.rangeContent ?? "";
          const ranged = boundedUtf8Slice(rangeContent, 0, rangeContent.length, MAX_READ_RANGE_BYTES);
          const effectiveOffset = Math.min(offset, streamed.characterLength);
          const actualEnd = effectiveOffset + ranged.end;
          const nextOffset = actualEnd < streamed.characterLength ? actualEnd : null;
          return {
            subjectRef: `${input.path}#chars=${effectiveOffset}-${actualEnd}`,
            facts: {
              path: input.path,
              content: ranged.content,
              digest: streamed.digest,
              byteLength: streamed.byteLength,
              characterLength: streamed.characterLength,
              offset: effectiveOffset,
              returnedCharacters: ranged.end,
              nextOffset,
              truncated: nextOffset !== null
            }
          };
        }

        const temporaryPath = artifactStore.temporaryPath("read");
        try {
          const streamed = await readUtf8File(path, input.path, context.signal, fileStat, {
            kind: "preview",
            previewCharacters: 500,
            temporaryPath
          });
          throwIfAborted(context.signal);
          const artifact = await artifactStore.putFile(temporaryPath, "text/plain");
          return {
            subjectRef: input.path,
            facts: {
              path: input.path,
              preview: streamed.preview ?? "",
              digest: streamed.digest,
              artifactRef: artifact.digest,
              byteLength: streamed.byteLength
            }
          };
        } catch (error) {
          await rm(temporaryPath, { force: true });
          throw error;
        }
      }
    }),
    defineTool({
      contract: {
        identity: { name: "filesystem.list" },
        capability: { purpose: "Discover workspace file names and paths under one known directory.", nonGoals: ["Read file contents.", "Search for text inside files."] },
        decision: { useWhen: ["A required path is unknown but its containing directory is known."], avoidWhen: ["The exact target path is already known.", "The uncertainty concerns file content rather than path."] },
        execution: { effect: { kind: "read", description: "Enumerates workspace paths without modifying external state." }, idempotent: true, inputSchema: z.object({ path: z.string().default("."), offset: z.number().int().nonnegative().max(MAX_LIST_OFFSET).default(0), limit: z.number().int().positive().max(MAX_LIST_ENTRIES).default(MAX_LIST_ENTRIES) }).strict(), inputExample: { path: ".", offset: 0, limit: 2000 } },
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
        identity: { name: "http.request" },
        capability: { purpose: "Observe one bounded HTTP response from a loopback development server for verification.", nonGoals: ["Call arbitrary external hosts.", "Assume an HTTP method is side-effect free.", "Send request bodies."] },
        decision: { useWhen: ["A local development server has a known loopback URL and its status or content must be verified and the request is approved."], avoidWhen: ["The server is not bound to loopback.", "A dedicated file or process capability already answers the question."] },
        execution: { effect: { kind: "execute", description: "Performs one bounded GET or HEAD request against a loopback HTTP URL. GET is not assumed to be read-only." }, idempotent: false, inputSchema: HttpRequestInputSchema, inputExample: { url: "http://127.0.0.1:4173/health", method: "GET", expectedStatus: 200, timeoutMs: 10_000 } },
        evidence: { produces: ["The loopback URL, HTTP status, content type, bounded response body, byte length, truncation state, and elapsed time."], factsSchema: HttpFactsSchema }
      },
      async execute(input, context) {
        const parsed = HttpRequestInputSchema.parse(input);
        const url = parseLoopbackHttpUrl(parsed.url);
        const startedAt = Date.now();
        const controller = new AbortController();
        const abort = (): void => controller.abort(context.signal.reason);
        const timer = setTimeout(() => controller.abort(new Error(`HTTP request timed out after ${parsed.timeoutMs}ms.`)), parsed.timeoutMs);
        if (context.signal.aborted) abort();
        else context.signal.addEventListener("abort", abort, { once: true });
        try {
          const response = await fetch(url, { method: parsed.method, signal: controller.signal, redirect: "manual" });
          if (response.status !== parsed.expectedStatus) {
            throw new ToolFailure(
              "HTTP_STATUS_MISMATCH",
              `Expected HTTP ${parsed.expectedStatus}, received ${response.status}.`,
              false,
              { url: url.toString(), status: response.status, expectedStatus: parsed.expectedStatus }
            );
          }
          const contentType = response.headers.get("content-type");
          if (parsed.expectedContentType !== undefined && !contentType?.toLowerCase().startsWith(parsed.expectedContentType.toLowerCase())) {
            throw new ToolFailure(
              "HTTP_CONTENT_TYPE_MISMATCH",
              `Expected content type ${parsed.expectedContentType}, received ${contentType ?? "none"}.`,
              false,
              { url: url.toString(), contentType, expectedContentType: parsed.expectedContentType }
            );
          }
          const responseBody = await readBoundedResponseBody(response, parsed.maxResponseBytes);
          return {
            subjectRef: url.toString(),
            facts: {
              url: url.toString(),
              method: parsed.method,
              status: response.status,
              statusText: response.statusText,
              contentType,
              body: responseBody.body,
              byteLength: responseBody.byteLength,
              truncated: responseBody.truncated,
              elapsedMs: Date.now() - startedAt
            }
          };
        } catch (error) {
          if (context.signal.aborted) throw new ToolFailure("CANCELLED", "HTTP verification was cancelled.");
          if (error instanceof ToolFailure) throw error;
          throw new ToolFailure(
            "HTTP_REQUEST_FAILED",
            error instanceof Error ? error.message : String(error),
            true,
            { url: url.toString() }
          );
        } finally {
          clearTimeout(timer);
          context.signal.removeEventListener("abort", abort);
        }
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
          replace: z.string().min(1, "Patch replacement must be non-empty. Use filesystem.write for an intentional deletion.")
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
        const fileStat = await stat(path);
        if (fileStat.size > MAX_READABLE_FILE_BYTES) {
          throw new ToolFailure(
            "FILE_TOO_LARGE",
            `File ${input.path} is ${fileStat.size} bytes; the bounded patch limit is ${MAX_READABLE_FILE_BYTES} bytes.`,
            false,
            { path: input.path, byteLength: fileStat.size, maxBytes: MAX_READABLE_FILE_BYTES }
          );
        }
        const current = (await readTrustedFile(path, await stat(path))).toString("utf8");
        const currentDigest = digest(current);
        if (currentDigest !== input.expectedDigest) {
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
        const mutationLock = await acquireMutationLock(path, context.signal, currentDigest);
        try {
        // Re-read immediately before the exclusive commit. A stale read must not
        // be promoted to successful Evidence when another writer changed the
        // file after the initial digest check.
        const beforeWrite = mutationLock.verifiedDigest === currentDigest
          ? current
          : (await readTrustedFile(path, await stat(path))).toString("utf8");
        const beforeWriteDigest = digest(beforeWrite);
        if (beforeWriteDigest !== currentDigest) {
          throw new ToolFailure(
            "CONTENT_CONFLICT",
            "File content changed while preparing the patch. Read the current file before retrying.",
            false,
            { path: input.path, expectedDigest: input.expectedDigest, currentDigest: beforeWriteDigest, findOccurrences: countExactOccurrences(beforeWrite, input.find), recovery: "inspect_current_content" }
          );
        }
        const committed = await mutationLock.commit(next, context.signal);
        const persistedDigest = committed.digest;
        if (persistedDigest !== digest(next)) {
          throw new ToolFailure(
            "PATCH_CONCURRENT_MODIFICATION",
            "File content changed while the patch was being committed; the patch result is not authoritative.",
            false,
            { path: input.path, expectedDigest: input.expectedDigest, targetDigest: digest(next), currentDigest: persistedDigest, recovery: "inspect_current_content" }
          );
        }
        return { subjectRef: input.path, facts: { path: input.path, digest: persistedDigest, replayed: false } };
        } finally {
          await mutationLock.release();
        }
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
        capability: { purpose: `Run one known non-interactive native executable that is expected to exit on Host process platform ${process.platform}. Set command to only the executable name/path and put every argument in args; no shell parsing occurs.`, nonGoals: ["Execute shell command strings, pipelines, redirections, compound expressions, shell built-ins, or script-wrapper entrypoints.", "Discover which command should be run.", "Start a persistent server, watcher, listener, or background service."] },
        decision: { useWhen: [`The exact executable compatible with Host process platform ${process.platform}, arguments, working directory, and expected purpose are known and the command will naturally exit.`], avoidWhen: ["A dedicated capability can produce the required facts.", "The command or its necessity is unresolved.", "The requested outcome requires the process to remain running after the Tool call; use process.start."] },
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

function decodeUtf8Text(bytes: Buffer, path: string): string {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ToolFailure(
      "BINARY_FILE_NOT_TEXT",
      `Workspace file ${path} is not valid UTF-8 text. Use a format-aware read capability instead.`,
      false
    );
  }
  assertTextSample(content.slice(0, 8_192), path);
  return content;
}

function assertTextSample(sample: string, path: string): void {
  const disallowedControls = [...sample].filter((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || (code < 0x20 && ![0x09, 0x0a, 0x0c, 0x0d].includes(code));
  }).length;
  if (sample.includes("\0") || disallowedControls > Math.max(1, Math.floor(sample.length * 0.01))) {
    throw new ToolFailure(
      "BINARY_FILE_NOT_TEXT",
      `Workspace file ${path} contains binary data. Use a format-aware read capability instead.`,
      false
    );
  }
}

type Utf8ReadMode =
  | { readonly kind: "range"; readonly offset: number; readonly limit: number }
  | { readonly kind: "preview"; readonly previewCharacters: number; readonly temporaryPath: string };

async function readUtf8File(
  path: string,
  displayPath: string,
  signal: AbortSignal,
  expectedIdentity: { readonly dev: number; readonly ino: number },
  mode: Utf8ReadMode
): Promise<{
  readonly digest: string;
  readonly byteLength: number;
  readonly characterLength: number;
  readonly rangeContent?: string;
  readonly preview?: string;
}> {
  const source = await open(path, "r");
  let destination = null;
  try {
    const opened = await source.stat();
    if (opened.dev !== expectedIdentity.dev || opened.ino !== expectedIdentity.ino) throw new ToolFailure("CONCURRENT_FILE_CHANGE", "The file identity changed while it was being opened.");
    destination = mode.kind === "preview" ? await open(mode.temporaryPath, "wx") : null;
  } catch (error) {
    await source.close().catch(() => { /* already closed */ });
    throw error;
  }
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  let byteLength = 0;
  let characterLength = 0;
  let sample = "";
  let rangeContent = "";
  let preview = "";
  const consume = async (text: string): Promise<void> => {
    if (text.length === 0) return;
    const chunkStart = characterLength;
    characterLength += text.length;
    hash.update(text);
    if (sample.length < 8_192) sample += text.slice(0, 8_192 - sample.length);
    if (mode.kind === "range") {
      const requestedEnd = mode.offset + mode.limit;
      const from = Math.max(0, mode.offset - chunkStart);
      const to = Math.min(text.length, requestedEnd - chunkStart);
      if (to > from) rangeContent += text.slice(from, to);
    } else if (preview.length < mode.previewCharacters) {
      preview += text.slice(0, mode.previewCharacters - preview.length);
    }
    if (destination !== null) await destination.write(text, undefined, "utf8");
  };
  try {
    let position = 0;
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      byteLength += bytesRead;
      if (byteLength > MAX_READABLE_FILE_BYTES) {
        throw new ToolFailure(
          "FILE_TOO_LARGE",
          `File ${displayPath} grew beyond the ${MAX_READABLE_FILE_BYTES}-byte read limit.`,
          false,
          { path: displayPath, maxBytes: MAX_READABLE_FILE_BYTES }
        );
      }
      try {
        await consume(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
      } catch (error) {
        if (error instanceof ToolFailure) throw error;
        throw new ToolFailure(
          "BINARY_FILE_NOT_TEXT",
          `Workspace file ${displayPath} is not valid UTF-8 text. Use a format-aware read capability instead.`,
          false
        );
      }
    }
    try {
      await consume(decoder.decode());
    } catch (error) {
      if (error instanceof ToolFailure) throw error;
      throw new ToolFailure(
        "BINARY_FILE_NOT_TEXT",
        `Workspace file ${displayPath} is not valid UTF-8 text. Use a format-aware read capability instead.`,
        false
      );
    }
    assertTextSample(sample, displayPath);
    return {
      digest: `sha256:${hash.digest("hex")}`,
      byteLength,
      characterLength,
      ...(mode.kind === "range" ? { rangeContent } : { preview })
    };
  } catch (error) {
    if (mode.kind === "preview") await rm(mode.temporaryPath, { force: true });
    throw error;
  } finally {
    await source.close().catch(() => { /* already closed */ });
    await destination?.close().catch(() => { /* already closed */ });
  }
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
  const ignoredGlobs = [
    ...[...IGNORED].sort().flatMap((name) => ["--glob", `!${name}/**`, "--glob", `!**/${name}/**`]),
    ...["!.env*", "!**/.env*", "!desktop-secrets.env", "!**/desktop-secrets.env"]
      .flatMap((glob) => ["--glob", glob])
  ];
  return new Promise((resolvePromise, rejectPromise) => {
    throwIfAborted(signal);
    const child = spawn(rgPath, [
      "--json", "--sort", "path", "--hidden", "--no-ignore", "--glob-case-insensitive", "--fixed-strings", "--ignore-case", "--max-filesize", "256K",
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
      const path = event.data?.path?.text;
      const text = event.data?.lines?.text?.replace(/\r?\n$/, "");
      const lineNumber = event.data?.line_number;
      if (path === undefined || text === undefined || lineNumber === undefined) return;
      const exposedPath = relativeFromRequested(requestedPath, directory, join(directory, path));
      if (isSecretWorkspacePath(exposedPath)) return;
      if (matches.length >= limit) {
        hasMore = true;
        stoppedAfterPage = true;
        child.kill();
        return;
      }
      const currentExposed = seen;
      seen += 1;
      if (currentExposed < offset) return;
      matches.push({
        path: exposedPath,
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
      schema: z.object({}).strict(), inputExample: {}, args: () => ["status", "--short", "--", ...GIT_SECRET_PATHSPECS]
    }, options.artifactDir),
    gitTool({
      name: "git.diff",
      purpose: "Observe unstaged repository differences for the workspace or one known path.",
      nonGoals: ["Read committed history.", "Modify repository state."],
      useWhen: ["The current unstaged changes are required as facts."],
      avoidWhen: ["The required fact is repository status or committed content rather than an unstaged diff."],
      produces: ["The bounded unstaged diff and process facts."],
      schema: z.object({ path: GitPathSchema.optional() }).strict(), inputExample: {}, path: (input) => input.path,
      args: (input) => ["diff", "--no-ext-diff", "--no-textconv", "--", ...(input.path ? [input.path] : []), ...GIT_SECRET_PATHSPECS]
    }, options.artifactDir),
    gitTool({
      name: "git.show",
      purpose: "Observe content from one known repository revision, optionally limited to one path.",
      nonGoals: ["Read unstaged changes.", "Modify repository state."],
      useWhen: ["The exact revision is known and its committed content is required."],
      avoidWhen: ["The revision is unresolved or the required fact concerns the working tree."],
      produces: ["The bounded committed revision content and process facts."],
      schema: z.object({
        revision: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/).refine((value) => !value.startsWith("-"), "Git revision must not start with '-'."),
        path: GitPathSchema.optional()
      }).strict(), inputExample: { revision: "HEAD" }, path: (input) => input.path,
      args: (input) => ["show", "--format=medium", "--no-ext-diff", "--no-textconv", "--end-of-options", input.revision, "--", ...(input.path ? [input.path] : []), ...GIT_SECRET_PATHSPECS]
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
  path?(input: T): string | undefined;
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
      const requestedPath = definition.path?.(input);
      if (requestedPath !== undefined && isSecretWorkspacePath(requestedPath)) {
        throw new ToolFailure("SECRET_FILE_READ_BLOCKED", "Workspace secret files are not readable by the Agent.");
      }
      const result = await runProcess(
        "git",
        ["-c", "core.fsmonitor=false", "-c", "diff.external=", ...definition.args(input)],
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
  for await (const path of walkFiles(root, signal, { visited: 0 }, 0)) {
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

async function* walkFiles(
  root: string,
  signal: AbortSignal,
  state: { visited: number },
  depth: number
): AsyncGenerator<string> {
  throwIfAborted(signal);
  if (depth > MAX_LIST_DEPTH) {
    throw new ToolFailure("LIST_DEPTH_EXCEEDED", `Directory traversal exceeded depth ${MAX_LIST_DEPTH}.`);
  }
  const entries = [];
  const directory = await opendir(root);
  try {
    for await (const entry of directory) {
      throwIfAborted(signal);
      state.visited += 1;
      if (state.visited > MAX_LIST_VISITED_ENTRIES) {
        throw new ToolFailure(
          "LIST_ENTRY_BUDGET_EXCEEDED",
          `Directory traversal exceeded ${MAX_LIST_VISITED_ENTRIES} entries; narrow the requested path.`
        );
      }
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => { /* already closed */ });
  }
  const visible = entries
    .filter((entry) => (
      !entry.isSymbolicLink()
      && !IGNORED.has(entry.name)
      && !(entry.isFile() && isSecretFilePath(entry.name))
    ))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of visible) {
    throwIfAborted(signal);
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path, signal, state, depth + 1);
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

function isSecretFilePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return IGNORED_FILES.has(name) || /^\.env(?:\..+)?$/u.test(name);
}

function isSecretWorkspacePath(path: string): boolean {
  return path
    .split(/[\\/]+/u)
    .filter(Boolean)
    .some((segment) => isSecretFilePath(segment));
}

async function assertReadableFileIsNotSecret(workspace: string, requested: string, canonicalPath: string): Promise<void> {
  if (isSecretWorkspacePath(requested) || isSecretWorkspacePath(canonicalPath)) {
    throw new ToolFailure("SECRET_FILE_READ_BLOCKED", "Workspace secret files are not readable by the Agent.");
  }
  const target = await stat(canonicalPath);
  // Symlink and junction aliases are covered by the canonical path check. A
  // hardlink keeps its alias name, so compare file identity with each bounded
  // secret-name candidate in the workspace before exposing its content.
  if (target.ino === 0 || target.dev === 0) return;
  if (await hasSecretFileIdentity(dirname(canonicalPath), target.dev, target.ino, 256)) {
    throw new ToolFailure("SECRET_FILE_READ_BLOCKED", "Workspace secret files are not readable by the Agent.");
  }
}

async function hasSecretFileIdentity(workspace: string, dev: number, ino: number, maxEntries: number): Promise<boolean> {
  const pending: Array<{ readonly path: string; readonly depth: number }> = [{ path: workspace, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const directory = await opendir(current.path);
    try {
      for await (const entry of directory) {
        visited += 1;
        if (visited > maxEntries) throw new ToolFailure("SECRET_ALIAS_CHECK_LIMIT", "The workspace is too large to complete the sensitive-file alias check safely.");
        const path = join(current.path, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink() && current.depth < 64) {
          pending.push({ path, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile() || !isSecretFilePath(entry.name)) continue;
        const candidate = await stat(path).catch(() => null);
        if (candidate !== null && candidate.ino === ino && candidate.dev === dev) return true;
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
  return false;
}

async function readTrustedFile(path: string, expected: { readonly dev: number; readonly ino: number }): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const actual = await handle.stat();
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new ToolFailure("CONCURRENT_FILE_CHANGE", "The file identity changed while it was being opened.");
    }
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

type MutationLock = {
  readonly commit: (content: string, signal: AbortSignal) => Promise<{ readonly digest: string }>;
  readonly verifiedDigest?: string;
  readonly release: () => Promise<void>;
};

const WINDOWS_MUTATION_LOCK_SCRIPT = [
  "$ErrorActionPreference = 'Stop';",
  "$stream = [System.IO.FileStream]::new($env:NEXORA_LOCK_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite);",
  "$locked = $false; while (!$locked) { try { $stream.Lock(0, 1); $locked = $true } catch [System.IO.IOException] { Start-Sleep -Milliseconds 25 } }",
  "$stream.Position = 0;",
  "$initial = New-Object byte[] $stream.Length;",
  "[void]$stream.Read($initial, 0, $initial.Length);",
  "$initialDigest = 'sha256:' + ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($initial)).Replace('-', '')).ToLowerInvariant();",
  "[Console]::Out.WriteLine('NEXORA_LOCK_READY ' + $initialDigest);",
  "[Console]::Out.Flush();",
  "try {",
  "  while (($line = [Console]::ReadLine()) -ne $null) {",
  "    if ($line -eq 'NEXORA_LOCK_RELEASE') { break }",
  "    if (!$line.StartsWith('NEXORA_LOCK_WRITE ')) { throw 'Invalid mutation lock command.' }",
  "    $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(18)));",
  "    $bytes = [System.IO.File]::ReadAllBytes($source);",
  "    $stream.Position = 0;",
  "    $stream.SetLength(0);",
  "    $stream.Write($bytes, 0, $bytes.Length);",
  "    $stream.Flush($true);",
  "    $stream.Position = 0;",
  "    $check = New-Object byte[] $stream.Length;",
  "    [void]$stream.Read($check, 0, $check.Length);",
  "    $digest = 'sha256:' + ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($check)).Replace('-', '')).ToLowerInvariant();",
  "    [Console]::Out.WriteLine('NEXORA_LOCK_WRITTEN ' + $digest);",
  "    [Console]::Out.Flush();",
  "  }",
  "} finally {",
  "  try { $stream.Unlock(0, 1) } catch {}",
  "  $stream.Dispose();",
  "}"
].join(" ");

async function acquireMutationLock(path: string, signal: AbortSignal, expectedDigest: string): Promise<MutationLock> {
  if (process.platform === "win32") return await acquireWindowsMutationLock(path, signal, expectedDigest);
  const lockPath = `${path}.nexora-lock`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const handle = await open(lockPath, "wx");
      return {
        commit: async (content, commitSignal) => {
          await atomicWrite(path, content, commitSignal);
          return { digest: digest(content) };
        },
        release: async () => { await handle.close().catch(() => undefined); await rm(lockPath, { force: true }); }
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw new ToolFailure("MUTATION_BUSY", "Another writer is currently modifying this file.", true);
}

async function acquireWindowsMutationLock(path: string, signal: AbortSignal, expectedDigest: string): Promise<MutationLock> {
  const executable = resolveWindowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell");
  if (executable === null) {
    throw new ToolFailure("MUTATION_LOCK_UNAVAILABLE", "Windows filesystem locking requires the trusted system PowerShell executable.");
  }
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_MUTATION_LOCK_SCRIPT], {
    cwd: process.cwd(),
    env: { ...process.env, NEXORA_LOCK_PATH: path },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const lines = createChildLineReader(child);
  let verifiedDigest = "";
  try {
    const ready = await waitForChildMessage(lines, (line) => line.startsWith("NEXORA_LOCK_READY "), "NEXORA_LOCK_READY", 5_000, signal);
    verifiedDigest = ready.slice("NEXORA_LOCK_READY ".length);
    if (verifiedDigest !== expectedDigest) {
      child.stdin.write("NEXORA_LOCK_RELEASE\n");
      child.stdin.end();
      await waitForChildExit(child, 5_000);
      throw new ToolFailure(
        "CONTENT_CONFLICT",
        "File content changed before the exclusive patch lock was acquired. Read the current file before retrying.",
        false,
        { expectedDigest, currentDigest: verifiedDigest, recovery: "inspect_current_content" }
      );
    }
  } catch (error) {
    child.kill();
    throw error instanceof ToolFailure ? error : new ToolFailure("MUTATION_LOCK_FAILED", error instanceof Error ? error.message : String(error), true);
  }
  let released = false;
  return {
    commit: async (content, commitSignal) => {
      if (released) throw new ToolFailure("MUTATION_LOCK_FAILED", "The filesystem mutation lock was already released.");
      throwIfAborted(commitSignal);
      const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.nexora-write.tmp`);
      await writeFile(temporary, content, "utf8");
      try {
        const encodedPath = Buffer.from(temporary, "utf8").toString("base64");
        child.stdin.write(`NEXORA_LOCK_WRITE ${encodedPath}\n`);
        const written = await waitForChildMessage(lines, (line) => line.startsWith("NEXORA_LOCK_WRITTEN "), "NEXORA_LOCK_WRITTEN", 10_000, commitSignal);
        return { digest: written.slice("NEXORA_LOCK_WRITTEN ".length) };
      } finally {
        await rm(temporary, { force: true });
      }
    },
    release: async () => {
      if (released) return;
      released = true;
      child.stdin.write("NEXORA_LOCK_RELEASE\n");
      child.stdin.end();
      await waitForChildExit(child, 5_000);
    },
    verifiedDigest
  };
}

type ChildLineReader = {
  readonly next: () => Promise<string>;
};

function createChildLineReader(child: ChildProcessWithoutNullStreams): ChildLineReader {
  let buffer = "";
  let stderr = "";
  let failure: Error | null = null;
  const pending: Array<{ readonly resolve: (line: string) => void; readonly reject: (error: Error) => void }> = [];
  const queue: string[] = [];
  const drain = () => {
    while (pending.length > 0 && queue.length > 0) pending.shift()!.resolve(queue.shift()!);
    if (failure !== null) while (pending.length > 0) pending.shift()!.reject(failure);
  };
  child.stdout.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    queue.push(...lines);
    drain();
  });
  child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
  const fail = (error: Error) => { if (failure === null) failure = error; drain(); };
  child.once("error", (error) => fail(error));
  child.once("close", (code) => {
    if (code !== 0) fail(new Error(`Mutation lock helper exited with code ${code ?? "unknown"}${stderr.trim().length > 0 ? `: ${stderr.trim()}` : ""}.`));
  });
  return {
    next: () => {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      if (failure !== null) return Promise.reject(failure);
      return new Promise<string>((resolve, reject) => pending.push({ resolve, reject }));
    }
  };
}

async function waitForChildMessage(
  lines: ChildLineReader,
  predicate: (line: string) => boolean,
  expected: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<string> {
  throwIfAborted(signal);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new ToolFailure("MUTATION_LOCK_TIMEOUT", `Timed out waiting for filesystem lock stage ${expected}.`, true)), timeoutMs);
  });
  try {
    const actual = await Promise.race([lines.next(), timeoutPromise]);
    if (!predicate(actual)) throw new ToolFailure("MUTATION_LOCK_FAILED", `Unexpected filesystem lock stage: ${actual}; expected ${expected}.`);
    return actual;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) throw new ToolFailure("MUTATION_LOCK_FAILED", `Mutation lock helper exited with code ${child.exitCode}.`);
    return;
  }
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new ToolFailure("MUTATION_LOCK_TIMEOUT", "Timed out releasing the filesystem mutation lock.", true));
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new ToolFailure("MUTATION_LOCK_FAILED", `Mutation lock helper exited with code ${code ?? "unknown"}.`));
    });
  });
}

function parseLoopbackHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ToolFailure("HTTP_URL_INVALID", "HTTP verification requires an absolute URL.");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
    throw new ToolFailure("HTTP_URL_NOT_LOOPBACK", "HTTP verification is limited to loopback HTTP URLs.");
  }
  return url;
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number
): Promise<{ readonly body: string; readonly byteLength: number; readonly truncated: boolean }> {
  if (response.body === null) return { body: "", byteLength: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const chunk = Buffer.from(value);
      const remaining = maxBytes - byteLength;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        byteLength = maxBytes;
        truncated = true;
        await reader.cancel().catch(() => { /* best effort */ });
        break;
      }
      chunks.push(chunk);
      byteLength += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return {
    body: Buffer.concat(chunks).toString("utf8").replace(/\uFFFD$/u, ""),
    byteLength,
    truncated
  };
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
        const taskkill = resolveWindowsSystemExecutable("taskkill");
        if (taskkill !== null) {
          const killed = spawnSync(taskkill, ["/pid", String(child.pid), "/t", "/f"], {
            windowsHide: true,
            stdio: "ignore"
          });
          if (killed.error === undefined && killed.status === 0) return;
        }
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
        `Process could not be started: ${error.message}. No process ran. shell.execute passes command directly to the operating system without shell parsing: choose one installed native executable name or path and put every argument in args; do not use a shell built-in, compound expression, or shell/script wrapper.`,
        false,
        {
          ...identity,
          ...resolution,
          platform: process.platform,
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
