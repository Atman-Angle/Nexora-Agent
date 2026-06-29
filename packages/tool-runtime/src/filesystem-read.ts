import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

import { createFileArtifact, type Artifact, type ToolCall, type ToolResult } from "../../contracts/src/index.js";
import { computeArtifactHash } from "../../contracts/src/artifact.js";
import { ToolRuntimeError } from "./errors.js";
import { resolveWorkspaceFilePath } from "./workspace-boundary.js";

const INLINE_TEXT_LIMIT_BYTES = 16 * 1024;
const PREVIEW_TEXT_LIMIT = 200;

export async function executeFilesystemRead(input: {
  runId: string;
  toolCall: Extract<ToolCall, { toolName: "filesystem.read" }>;
  workspaceRoot: string;
  artifactRoot: string;
  artifactId: string;
  now: string;
  signal?: AbortSignal;
}): Promise<{
  toolResult: ToolResult;
  artifacts?: Artifact[];
}> {
  const resolvedPath = await resolveWorkspaceFilePath(input.workspaceRoot, input.toolCall.input.path);

  let fileBuffer: Buffer;
  try {
    fileBuffer = await readFile(resolvedPath, {
      signal: input.signal
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
    }

    throw new ToolRuntimeError("RUNTIME_ERROR", "Failed to read the requested file.", true);
  }

  if (looksBinary(fileBuffer)) {
    const artifact = await persistArtifactFile({
      runId: input.runId,
      artifactRoot: input.artifactRoot,
      artifactId: input.artifactId,
      sourcePath: resolvedPath,
      bytes: fileBuffer,
      mimeType: "application/octet-stream",
      description: `Binary file externalized from ${input.toolCall.input.path}`,
      createdAt: input.now
    });

    return {
      artifacts: [artifact],
      toolResult: {
        toolCallId: input.toolCall.toolCallId,
        toolName: "filesystem.read",
        status: "success",
        output: {
          kind: "artifact_ref",
          path: input.toolCall.input.path,
          artifactId: artifact.artifactId,
          byteLength: fileBuffer.byteLength,
          mimeType: artifact.mimeType,
          reason: "binary_file"
        }
      }
    };
  }

  const textContent = fileBuffer.toString("utf8");
  if (fileBuffer.byteLength > INLINE_TEXT_LIMIT_BYTES) {
    const artifact = await persistArtifactFile({
      runId: input.runId,
      artifactRoot: input.artifactRoot,
      artifactId: input.artifactId,
      sourcePath: resolvedPath,
      bytes: Buffer.from(textContent, "utf8"),
      mimeType: "text/plain",
      description: `Large text file externalized from ${input.toolCall.input.path}`,
      createdAt: input.now
    });

    return {
      artifacts: [artifact],
      toolResult: {
        toolCallId: input.toolCall.toolCallId,
        toolName: "filesystem.read",
        status: "success",
        output: {
          kind: "artifact_ref",
          path: input.toolCall.input.path,
          artifactId: artifact.artifactId,
          byteLength: fileBuffer.byteLength,
          mimeType: "text/plain",
          reason: "large_file",
          previewText: textContent.slice(0, PREVIEW_TEXT_LIMIT)
        }
      }
    };
  }

  return {
    toolResult: {
      toolCallId: input.toolCall.toolCallId,
      toolName: "filesystem.read",
      status: "success",
      output: {
        kind: "inline_text",
        path: input.toolCall.input.path,
        content: textContent,
        byteLength: fileBuffer.byteLength,
        mimeType: "text/plain"
      }
    }
  };
}

async function persistArtifactFile(input: {
  runId: string;
  artifactRoot: string;
  artifactId: string;
  sourcePath: string;
  bytes: Buffer;
  mimeType: string;
  description: string;
  createdAt: string;
}): Promise<Artifact> {
  const artifactPath = join(input.artifactRoot, `${input.artifactId}${extname(input.sourcePath)}`);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, input.bytes);

  return createFileArtifact({
    artifactId: input.artifactId,
    runId: input.runId,
    mimeType: input.mimeType,
    content: input.description,
    filePath: artifactPath,
    sizeBytes: input.bytes.byteLength,
    hash: computeArtifactHash(input.bytes.toString("base64")),
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
