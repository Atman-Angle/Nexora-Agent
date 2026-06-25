import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  ToolResultSchema,
  computeArtifactHash,
  createFileArtifact,
  type Artifact,
  type PatchOperation,
  type ToolCall,
  type ToolResult
} from "../../contracts/src/index.js";
import { ToolRuntimeError } from "./errors.js";
import { resolveWorkspacePath } from "./workspace-boundary.js";

export async function executeFilesystemPatch(input: {
  runId: string;
  executionId: string;
  toolCall: Extract<ToolCall, { toolName: "filesystem.patch" }>;
  workspaceRoot: string;
  artifactRoot: string;
  artifactId: string;
  now: string;
  signal?: AbortSignal;
}): Promise<{
  toolResult: ToolResult;
  artifacts: Artifact[];
}> {
  if (input.toolCall.input.expectedHash.trim().length === 0) {
    throw new ToolRuntimeError("EXPECTED_HASH_MISSING", "Patch expectedHash must not be empty.", false);
  }

  const resolvedPath = await resolveWorkspacePath(input.workspaceRoot, input.toolCall.input.path);
  const originalBuffer = await readTextFile(resolvedPath, input.signal);
  const originalText = originalBuffer.toString("utf8");
  const oldHash = computeArtifactHash(originalText);

  if (oldHash !== input.toolCall.input.expectedHash) {
    throw new ToolRuntimeError("STALE_FILE_HASH", "Target file hash does not match expectedHash.", false);
  }

  const patchedText = applyPatch(originalText, input.toolCall.input.patch);
  const newHash = computeArtifactHash(patchedText);
  const changed = patchedText !== originalText;
  const tempPath = `${resolvedPath}.nexora.tmp`;

  if (changed) {
    try {
      await writeFile(tempPath, patchedText, {
        encoding: "utf8",
        signal: input.signal
      });
    } catch (error) {
      await cleanupTempFile(tempPath);
      throw toWriteError(error, "PATCH_WRITE_FAILED", "Failed to write temporary patch file.");
    }

    try {
      await rename(tempPath, resolvedPath);
    } catch (error) {
      await cleanupTempFile(tempPath);
      throw toWriteError(error, "PATCH_REPLACE_FAILED", "Failed to replace target file with patched content.");
    }
  }

  const verifiedText = (await readTextFile(resolvedPath, input.signal)).toString("utf8");
  const verifiedHash = computeArtifactHash(verifiedText);
  if (verifiedHash !== newHash) {
    throw new ToolRuntimeError("PATCH_VERIFY_FAILED", "Patched file hash verification failed.", true);
  }

  const diffContent = buildDiffContent({
    path: input.toolCall.input.path,
    oldHash,
    newHash,
    originalText,
    patchedText
  });
  const artifact = await persistDiffArtifact({
    runId: input.runId,
    artifactRoot: input.artifactRoot,
    artifactId: input.artifactId,
    diffContent,
    createdAt: input.now
  });

  return {
    artifacts: [artifact],
    toolResult: ToolResultSchema.parse({
      toolCallId: input.toolCall.toolCallId,
      toolName: "filesystem.patch",
      status: "success",
      output: {
        kind: "patch_result",
        result: {
          path: input.toolCall.input.path,
          status: changed ? "applied" : "noop",
          oldHash,
          newHash,
          changed,
          diffArtifactRef: artifact.artifactId,
          bytesWritten: changed ? Buffer.byteLength(patchedText, "utf8") : 0,
          executionRecordId: input.executionId
        }
      }
    })
  };
}

function applyPatch(sourceText: string, patch: PatchOperation): string {
  if (patch.type !== "replace_text") {
    throw new ToolRuntimeError("PATCH_INVALID", "Unsupported patch operation.", false);
  }

  if (patch.find.length === 0) {
    throw new ToolRuntimeError("PATCH_INVALID", "Patch find text must not be empty.", false);
  }

  if (!sourceText.includes(patch.find)) {
    throw new ToolRuntimeError("PATCH_APPLY_FAILED", "Patch find text was not found in the target file.", false);
  }

  return patch.replaceAll === true ? sourceText.replaceAll(patch.find, patch.replace) : sourceText.replace(patch.find, patch.replace);
}

async function readTextFile(path: string, signal?: AbortSignal): Promise<Buffer> {
  try {
    const buffer = await readFile(path, { signal });
    if (looksBinary(buffer)) {
      throw new ToolRuntimeError("PATCH_INVALID", "filesystem.patch only supports text files.", false);
    }
    return buffer;
  } catch (error) {
    if (error instanceof ToolRuntimeError) {
      throw error;
    }

    if (isAbortError(error)) {
      throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
    }

    throw new ToolRuntimeError("RUNTIME_ERROR", "Failed to read the target file.", true);
  }
}

async function cleanupTempFile(path: string): Promise<void> {
  await rm(path, {
    force: true
  }).catch(() => undefined);
}

function toWriteError(
  error: unknown,
  code: "PATCH_WRITE_FAILED" | "PATCH_REPLACE_FAILED",
  message: string
): ToolRuntimeError {
  if (isAbortError(error)) {
    return new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
  }

  return new ToolRuntimeError(code, message, true);
}

function buildDiffContent(input: {
  path: string;
  oldHash: string;
  newHash: string;
  originalText: string;
  patchedText: string;
}): string {
  return [
    `path: ${input.path}`,
    `oldHash: ${input.oldHash}`,
    `newHash: ${input.newHash}`,
    "--- before",
    input.originalText,
    "+++ after",
    input.patchedText
  ].join("\n");
}

async function persistDiffArtifact(input: {
  runId: string;
  artifactRoot: string;
  artifactId: string;
  diffContent: string;
  createdAt: string;
}): Promise<Artifact> {
  const artifactPath = join(input.artifactRoot, `${input.artifactId}.diff.txt`);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, input.diffContent, "utf8");

  return createFileArtifact({
    artifactId: input.artifactId,
    runId: input.runId,
    mimeType: "text/plain",
    content: "Patch diff artifact.",
    filePath: artifactPath,
    sizeBytes: Buffer.byteLength(input.diffContent, "utf8"),
    hash: computeArtifactHash(input.diffContent),
    createdAt: input.createdAt
  });
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
