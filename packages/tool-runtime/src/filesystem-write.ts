import { open, link, readFile, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  ToolResultSchema,
  WriteModeSchema,
  computeArtifactHash,
  type FilesystemWriteInput,
  type ToolResult
} from "../../contracts/src/index.js";
import { ToolRuntimeError } from "./errors.js";
import { resolveWorkspaceWritePath } from "./workspace-boundary.js";

export type FilesystemWriteToolCall = {
  toolCallId: string;
  toolName: string;
  input: FilesystemWriteInput;
  timeoutMs: number;
};

export async function executeFilesystemWrite(input: {
  executionId: string;
  toolCall: FilesystemWriteToolCall;
  workspaceRoot: string;
  signal?: AbortSignal;
}): Promise<{
  toolResult: ToolResult;
}> {
  const mode = WriteModeSchema.parse(input.toolCall.input.mode);
  const resolved = await resolveWorkspaceWritePath(input.workspaceRoot, input.toolCall.input.path);
  const desiredHash = computeArtifactHash(input.toolCall.input.content);
  const tempPath = buildTempPath(resolved.parentPath, input.toolCall.input.path, input.executionId, input.toolCall.toolCallId);
  let previousHash: string | undefined;

  if (mode === "create") {
    if (resolved.targetExists) {
      throw new ToolRuntimeError("FILE_ALREADY_EXISTS", "Create mode refuses to overwrite an existing file.", false);
    }
  } else if (mode === "overwrite") {
    const expectedHash = input.toolCall.input.expectedHash?.trim();
    if (expectedHash === undefined || expectedHash.length === 0) {
      throw new ToolRuntimeError("EXPECTED_HASH_MISSING", "Overwrite mode requires expectedHash.", false);
    }
    if (!resolved.targetExists) {
      throw new ToolRuntimeError("FILE_NOT_FOUND", "Overwrite target file was not found.", false);
    }

    const originalText = await readTextFile(resolved.targetPath, input.signal);
    previousHash = computeArtifactHash(originalText);
    if (previousHash !== expectedHash) {
      throw new ToolRuntimeError("STALE_FILE_HASH", "Target file hash does not match expectedHash.", false);
    }
  } else {
    throw new ToolRuntimeError("INVALID_WRITE_MODE", "Unsupported filesystem.write mode.", false);
  }

  try {
    await writeTempFile(tempPath, input.toolCall.input.content, input.signal);
    const tempHash = computeArtifactHash(await readTextFile(tempPath, input.signal));
    if (tempHash !== desiredHash) {
      throw new ToolRuntimeError("WRITE_VERIFICATION_FAILED", "Temporary file hash verification failed.", true);
    }

    if (mode === "create") {
      await commitCreate(tempPath, resolved.targetPath);
    } else {
      const currentHash = computeArtifactHash(await readTextFile(resolved.targetPath, input.signal));
      if (currentHash !== previousHash) {
        throw new ToolRuntimeError("STALE_FILE_HASH", "Target file changed before overwrite commit.", false);
      }
      await commitOverwrite(tempPath, resolved.targetPath);
    }

    const writtenText = await readTextFile(resolved.targetPath, input.signal);
    const writtenHash = computeArtifactHash(writtenText);
    if (writtenHash !== desiredHash) {
      throw new ToolRuntimeError("WRITE_VERIFICATION_FAILED", "Written file hash verification failed.", true);
    }

    return {
      toolResult: ToolResultSchema.parse({
        toolCallId: input.toolCall.toolCallId,
        toolName: "filesystem.write",
        status: "success",
        output: {
          kind: "write_result",
          result: {
            path: input.toolCall.input.path,
            mode,
            bytesWritten: Buffer.byteLength(input.toolCall.input.content, "utf8"),
            hash: writtenHash,
            created: mode === "create",
            ...(previousHash === undefined ? {} : { previousHash }),
            executionRecordId: input.executionId
          }
        }
      })
    };
  } catch (error) {
    await cleanupTempFile(tempPath);
    if (error instanceof ToolRuntimeError) {
      throw error;
    }
    if (isAbortError(error)) {
      throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
    }
    throw new ToolRuntimeError("WRITE_FAILED", "Filesystem write failed.", true);
  } finally {
    await cleanupTempFile(tempPath);
  }
}

async function writeTempFile(path: string, content: string, signal?: AbortSignal): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(content, { encoding: "utf8", signal });
    await handle.sync();
  } catch (error) {
    if (isAbortError(error)) {
      throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
    }
    throw new ToolRuntimeError("WRITE_FAILED", "Failed to write the temporary file.", true);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function commitCreate(tempPath: string, targetPath: string): Promise<void> {
  try {
    await link(tempPath, targetPath);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new ToolRuntimeError("FILE_ALREADY_EXISTS", "Create mode refuses to overwrite an existing file.", false);
    }
    throw new ToolRuntimeError("WRITE_FAILED", "Failed to atomically create the target file.", true);
  }
}

async function commitOverwrite(tempPath: string, targetPath: string): Promise<void> {
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    if (isAbortError(error)) {
      throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
    }
    throw new ToolRuntimeError("WRITE_FAILED", "Failed to atomically replace the target file.", true);
  }
}

async function readTextFile(path: string, signal?: AbortSignal): Promise<string> {
  try {
    return (await readFile(path, { encoding: "utf8", signal })).toString();
  } catch (error) {
    if (isAbortError(error)) {
      throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
    }
    throw new ToolRuntimeError("WRITE_FAILED", "Failed to read a text file during filesystem.write.", true);
  }
}

async function cleanupTempFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    throw new ToolRuntimeError("TEMP_FILE_CLEANUP_FAILED", "Failed to clean up the temporary file.", true);
  }
}

function buildTempPath(parentPath: string, requestedPath: string, executionId: string, toolCallId: string): string {
  return join(
    parentPath,
    `.${basename(requestedPath)}.nexora-${executionId}-${toolCallId}-${randomUUID()}.tmp`
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
