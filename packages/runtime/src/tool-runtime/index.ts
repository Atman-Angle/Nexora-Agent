import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import { z } from "zod";

import { ArtifactStore } from "../artifacts.js";
import type { RuntimeTool, RuntimeToolResult } from "../runtime.js";
import { ToolFailure, workspacePath, writableWorkspacePath } from "./workspace.js";

const PathInput = z.object({ path: z.string().trim().min(1) }).strict();
const MAX_INLINE_BYTES = 16 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024;
const IGNORED = new Set([".git", ".nexora", "node_modules", "dist", "coverage"]);

export function createBuiltInTools(options: { readonly artifactDir?: string } = {}): readonly RuntimeTool[] {
  return [
    define("filesystem.read", "Read one UTF-8 file in the workspace and return content or preview, a digest, and an Artifact reference for large content.", "read", true, PathInput, { path: "README.md" }, async (input, context) => {
      const path = await workspacePath(context.workspace, input.path, "file");
      const bytes = await readFile(path);
      const content = bytes.toString("utf8");
      const subjectRef = input.path;
      if (bytes.byteLength <= MAX_INLINE_BYTES) {
        return success(subjectRef, { path: input.path, content, digest: digest(content), byteLength: bytes.byteLength });
      }
      const artifact = new ArtifactStore(options.artifactDir ?? join(context.workspace, ".nexora", "artifacts")).putText(content);
      return success(subjectRef, { path: input.path, preview: content.slice(0, 500), digest: digest(content), artifactRef: artifact.digest, byteLength: artifact.byteLength });
    }),
    define("filesystem.list", "List files recursively inside a workspace directory for discovery without reading file contents.", "read", true, z.object({ path: z.string().default(".") }).strict(), { path: "." }, async (input, context) => {
      const requestedPath = input.path ?? ".";
      const directory = await workspacePath(context.workspace, requestedPath, "directory");
      const entries = (await listFiles(directory)).map((path) => relativeFromRequested(requestedPath, directory, path));
      return success(requestedPath, { entries: entries.slice(0, 2000), truncated: entries.length > 2000 });
    }),
    define("filesystem.search", "Search UTF-8 text files in the workspace for a case-insensitive literal query and return matching paths and lines.", "read", true, z.object({ query: z.string().trim().min(1), path: z.string().default(".") }).strict(), { query: "TODO", path: "." }, async (input, context) => {
      const requestedPath = input.path ?? ".";
      const directory = await workspacePath(context.workspace, requestedPath, "directory");
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const path of await listFiles(directory)) {
        if (matches.length >= 100) break;
        const bytes = await readFile(path);
        if (bytes.byteLength > 256 * 1024 || bytes.includes(0)) continue;
        for (const [index, line] of bytes.toString("utf8").split(/\r?\n/).entries()) {
          if (line.toLowerCase().includes(input.query.toLowerCase())) {
            matches.push({ path: relativeFromRequested(requestedPath, directory, path), line: index + 1, text: line.slice(0, 500) });
            if (matches.length >= 100) break;
          }
        }
      }
      return success(`search:${input.query}`, { matches, truncated: matches.length >= 100 });
    }),
    define("filesystem.write", "Write one file atomically inside the workspace and return its digest; this requires Approval.", "write", true, z.object({ path: z.string().trim().min(1), content: z.string() }).strict(), { path: "output.txt", content: "example" }, async (input, context) => {
      const path = await writableWorkspacePath(context.workspace, input.path);
      await atomicWrite(path, input.content);
      return success(input.path, { path: input.path, digest: digest(input.content), byteLength: Buffer.byteLength(input.content) });
    }),
    define("filesystem.patch", "Patch one file atomically by replacing one exact occurrence after checking its expected digest; this requires Approval.", "write", true, z.object({
      path: z.string().trim().min(1), expectedDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), find: z.string().min(1), replace: z.string()
    }).strict(), { path: "source.txt", expectedDigest: `sha256:${"0".repeat(64)}`, find: "old", replace: "new" }, async (input, context) => {
      const path = await workspacePath(context.workspace, input.path, "file");
      const current = await readFile(path, "utf8");
      if (digest(current) !== input.expectedDigest) {
        if (!current.includes(input.find) && current.includes(input.replace)) return success(input.path, { path: input.path, digest: digest(current), replayed: true });
        throw new ToolFailure("CONTENT_CONFLICT", "File content no longer matches expectedDigest.");
      }
      const first = current.indexOf(input.find);
      if (first < 0 || current.indexOf(input.find, first + input.find.length) >= 0) {
        throw new ToolFailure("PATCH_CONFLICT", "Patch find text must occur exactly once.");
      }
      const next = `${current.slice(0, first)}${input.replace}${current.slice(first + input.find.length)}`;
      await atomicWrite(path, next);
      return success(input.path, { path: input.path, digest: digest(next), replayed: false });
    }),
    define("shell.execute", "Start an executable directly in the workspace with arguments supplied separately in args; shell command strings are not accepted and Approval is required.", "execute", false, z.object({
      command: z.string().trim().min(1), args: z.array(z.string()).default([]), cwd: z.string().default("."), timeoutMs: z.number().int().positive().max(300_000).default(60_000)
    }).strict(), { command: "node", args: ["--test", "test/example.test.js"], cwd: ".", timeoutMs: 60_000 }, async (input, context) => {
      if (["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "sh", "bash"].includes(basename(input.command).toLowerCase())) {
        throw new ToolFailure("COMMAND_REJECTED", "Interactive shell entrypoints are not allowed.");
      }
      const cwd = await workspacePath(context.workspace, input.cwd ?? ".", "directory");
      const result = await runProcess(input.command, input.args ?? [], cwd, input.timeoutMs ?? 60_000);
      if (result.timedOut) throw new ToolFailure("TOOL_TIMEOUT", "Tool execution timed out.", true);
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout).trim().slice(0, 500);
        throw new ToolFailure("COMMAND_FAILED", `Command exited with code ${result.exitCode}.${detail ? ` ${detail}` : ""}`);
      }
      return success(`command:${input.command}`, result);
    }),
    ...gitTools()
  ];
}

function gitTools(): RuntimeTool[] {
  const definitions: Array<{ name: string; description: string; schema: z.ZodTypeAny; inputExample: unknown; args: (input: any) => string[] }> = [
    { name: "git.status", description: "Read the workspace Git status in short form without modifying the repository.", schema: z.object({}).strict(), inputExample: {}, args: () => ["status", "--short"] },
    { name: "git.diff", description: "Read unstaged Git differences for the workspace or one optional path without modifying the repository.", schema: z.object({ path: z.string().trim().min(1).optional() }).strict(), inputExample: {}, args: (input) => ["diff", "--", ...(input.path ? [input.path] : [])] },
    { name: "git.show", description: "Read one Git revision, optionally limited to one path, without modifying the repository.", schema: z.object({ revision: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/), path: z.string().trim().min(1).optional() }).strict(), inputExample: { revision: "HEAD" }, args: (input) => ["show", "--format=medium", input.revision, ...(input.path ? ["--", input.path] : [])] }
  ];
  return definitions.map((definition) => define(definition.name, definition.description, "read", true, definition.schema, definition.inputExample, async (input, context) => {
    const result = await runProcess("git", definition.args(input), context.workspace, 30_000);
    if (result.timedOut) throw new ToolFailure("TOOL_TIMEOUT", "Git command timed out.", true);
    if (result.exitCode !== 0) throw new ToolFailure("GIT_COMMAND_FAILED", result.stderr || "Git command failed.");
    return success(`git:${definition.name}`, result);
  }));
}

function define<T>(name: string, description: string, risk: RuntimeTool["risk"], idempotent: boolean, schema: z.ZodType<T>, inputExample: unknown, execute: (input: T, context: Parameters<RuntimeTool["execute"]>[1]) => Promise<RuntimeToolResult>): RuntimeTool {
  return {
    name, description, risk, idempotent, inputSchema: schema, inputExample,
    async execute(input, context) {
      try { return await execute(schema.parse(input), context); }
      catch (error) {
        const failure = error instanceof ToolFailure ? error : new ToolFailure("TOOL_EXECUTION_ERROR", error instanceof Error ? error.message : String(error), true);
        return { status: "failure", subjectRef: name, error: { code: failure.code, message: failure.message, retryable: failure.retryable } };
      }
    }
  };
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const pending = [root];
  while (pending.length > 0 && output.length < 2001) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || IGNORED.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  return output.sort();
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, "utf8");
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let timedOut = false;
    const append = (current: Buffer, chunk: Buffer) => Buffer.concat([current, chunk]).subarray(0, MAX_CAPTURE_BYTES);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code ?? 1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated: stdout.length >= MAX_CAPTURE_BYTES || stderr.length >= MAX_CAPTURE_BYTES, timedOut });
    });
  });
}

function digest(content: string): string { return `sha256:${createHash("sha256").update(content).digest("hex")}`; }
function success(subjectRef: string, output: unknown): RuntimeToolResult { return { status: "success", subjectRef, output: output as never }; }
function relativeFromRequested(requested: string, root: string, path: string): string {
  const prefix = requested === "." ? "" : requested.replaceAll("\\", "/").replace(/\/$/, "");
  const child = relative(root, path).replaceAll("\\", "/");
  return prefix ? `${prefix}/${child}` : child;
}
