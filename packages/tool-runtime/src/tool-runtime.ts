import {
  ExecutionRecordSchema,
  ToolCallSchema,
  ToolResultSchema,
  type Artifact,
  type ExecutionRecord,
  type ToolCall,
  type ToolResult
} from "../../contracts/src/index.js";
import type { ArtifactStore } from "../../storage/src/artifact-store.js";
import type { ExecutionRecordStore } from "../../storage/src/execution-record-store.js";
import { ToolRuntimeError } from "./errors.js";
import { assertFilesystemPermission } from "./permissions.js";
import type { ToolRegistry } from "./tool-registry.js";

export class ToolRuntime {
  public constructor(
    private readonly dependencies: {
      registry: ToolRegistry;
      executionRecordStore: ExecutionRecordStore;
      artifactStore: ArtifactStore;
    }
  ) {}

  public async execute(input: {
    runId: string;
    toolCall: ToolCall;
    workspaceRoot: string;
    artifactRoot: string;
    now: () => string;
    idGenerator: () => string;
    signal?: AbortSignal;
  }): Promise<{
    toolResult: ToolResult;
    executionRecord: ExecutionRecord;
    artifacts?: Artifact[];
  }> {
    const parsedToolCall = ToolCallSchema.parse(input.toolCall);
    const startedAt = input.now();
    const executionId = input.idGenerator();

    const controller = new AbortController();
    const signal = mergeSignals(controller, input.signal);
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, parsedToolCall.timeoutMs);

    try {
      assertFilesystemPermission({
        operation: parsedToolCall.toolName,
        scope: "workspace"
      });

      const replayed = this.replayIdempotentExecution(parsedToolCall);
      if (replayed !== null) {
        return replayed;
      }

      const tool = this.dependencies.registry.get(parsedToolCall.toolName);
      const execution = await tool.execute(
        {
          runId: input.runId,
          executionId,
          workspaceRoot: input.workspaceRoot,
          artifactRoot: input.artifactRoot,
          artifactId: input.idGenerator(),
          now: startedAt,
          signal
        },
        parsedToolCall
      );

      const parsedToolResult = ToolResultSchema.parse(execution.toolResult);
      if (execution.artifacts !== undefined) {
        for (const artifact of execution.artifacts) {
          this.dependencies.artifactStore.insertArtifact(artifact);
        }
      }

      const record = persistExecutionRecord({
        executionRecordStore: this.dependencies.executionRecordStore,
        executionId,
        input,
        toolCall: parsedToolCall,
        toolResult: parsedToolResult,
        startedAt,
        finishedAt: input.now()
      });

      return {
        toolResult: parsedToolResult,
        executionRecord: record,
        ...(execution.artifacts === undefined ? {} : { artifacts: execution.artifacts })
      };
    } catch (error) {
      const normalizedError = normalizeToolError(error, timedOut);
      const toolResult: ToolResult = {
        toolCallId: parsedToolCall.toolCallId,
        toolName: parsedToolCall.toolName,
        status: "error",
        error: {
          code: normalizedError.code,
          message: normalizedError.message,
          retryable: normalizedError.retryable
        }
      };
      const parsedToolResult = ToolResultSchema.parse(toolResult);
      const record = persistExecutionRecord({
        executionRecordStore: this.dependencies.executionRecordStore,
        executionId,
        input,
        toolCall: parsedToolCall,
        toolResult: parsedToolResult,
        startedAt,
        finishedAt: input.now()
      });

      return {
        toolResult: parsedToolResult,
        executionRecord: record
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  public getAvailableTools(): ToolCall["toolName"][] {
    return this.dependencies.registry.listNames();
  }

  private replayIdempotentExecution(
    toolCall: ToolCall
  ): {
    toolResult: ToolResult;
    executionRecord: ExecutionRecord;
  } | null {
    if (toolCall.toolName !== "filesystem.patch" && toolCall.toolName !== "filesystem.write" && toolCall.toolName !== "shell.execute") {
      return null;
    }

    const existingRecord = this.dependencies.executionRecordStore.findByIdempotency({
      toolName: toolCall.toolName,
      targetPath: toolCall.toolName === "shell.execute" ? toolCall.input.cwd : toolCall.input.path,
      idempotencyKey: toolCall.input.idempotencyKey
    });
    if (existingRecord === null) {
      return null;
    }

    const existingToolCall = ToolCallSchema.parse(JSON.parse(existingRecord.inputJson) as ToolCall);
    if (!hasSameIdempotentSemantics(existingToolCall, toolCall)) {
      throw new ToolRuntimeError(
        "IDEMPOTENCY_CONFLICT",
        "A different patch request already used this idempotency key for the target path.",
        false
      );
    }

    const replayedResult = ToolResultSchema.parse(JSON.parse(existingRecord.outputJson) as ToolResult);
    return {
      toolResult: {
        ...replayedResult,
        toolCallId: toolCall.toolCallId
      },
      executionRecord: existingRecord
    };
  }
}

function hasSameIdempotentSemantics(left: ToolCall, right: ToolCall): boolean {
  if (left.toolName !== right.toolName) {
    return false;
  }

  if (left.toolName === "filesystem.patch" && right.toolName === "filesystem.patch") {
    return (
      left.timeoutMs === right.timeoutMs &&
      left.input.path === right.input.path &&
      left.input.expectedHash === right.input.expectedHash &&
      left.input.encoding === right.input.encoding &&
      left.input.idempotencyKey === right.input.idempotencyKey &&
      left.input.patch.type === right.input.patch.type &&
      left.input.patch.find === right.input.patch.find &&
      left.input.patch.replace === right.input.patch.replace &&
      (left.input.patch.replaceAll ?? false) === (right.input.patch.replaceAll ?? false)
    );
  }

  if (left.toolName === "filesystem.write" && right.toolName === "filesystem.write") {
    return (
      left.timeoutMs === right.timeoutMs &&
      left.input.path === right.input.path &&
      left.input.content === right.input.content &&
      left.input.encoding === right.input.encoding &&
      left.input.mode === right.input.mode &&
      (left.input.expectedHash ?? null) === (right.input.expectedHash ?? null) &&
      left.input.idempotencyKey === right.input.idempotencyKey
    );
  }

  if (left.toolName === "shell.execute" && right.toolName === "shell.execute") {
    return (
      left.input.command === right.input.command &&
      left.input.cwd === right.input.cwd &&
      left.input.purpose === right.input.purpose &&
      left.input.idempotencyKey === right.input.idempotencyKey &&
      JSON.stringify(left.input.args) === JSON.stringify(right.input.args) &&
      JSON.stringify(left.input.environment) === JSON.stringify(right.input.environment)
    );
  }

  return false;
}

function persistExecutionRecord(input: {
  executionRecordStore: ExecutionRecordStore;
  executionId: string;
  input: {
    runId: string;
  };
  toolCall: ToolCall;
  toolResult: ToolResult;
  startedAt: string;
  finishedAt: string;
}): ExecutionRecord {
  const record = ExecutionRecordSchema.parse({
    schemaVersion: "1",
    executionId: input.executionId,
    runId: input.input.runId,
    toolCallId: input.toolCall.toolCallId,
    toolName: input.toolCall.toolName,
    status: input.toolResult.status,
    ...(input.toolCall.toolName === "filesystem.patch" ? { targetPath: input.toolCall.input.path } : {}),
    ...(input.toolCall.toolName === "filesystem.write" ? { targetPath: input.toolCall.input.path } : {}),
    ...(input.toolCall.toolName === "shell.execute" ? { targetPath: input.toolCall.input.cwd } : {}),
    ...(input.toolCall.toolName === "filesystem.patch" ? { idempotencyKey: input.toolCall.input.idempotencyKey } : {}),
    ...(input.toolCall.toolName === "filesystem.write" ? { idempotencyKey: input.toolCall.input.idempotencyKey } : {}),
    ...(input.toolCall.toolName === "shell.execute" ? { idempotencyKey: input.toolCall.input.idempotencyKey } : {}),
    inputJson: JSON.stringify(input.toolCall),
    outputJson: JSON.stringify(input.toolResult),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt
  });
  input.executionRecordStore.insertExecutionRecord(record);
  return record;
}

function normalizeToolError(error: unknown, timedOut: boolean): ToolRuntimeError {
  if (timedOut) {
    return new ToolRuntimeError("TOOL_TIMEOUT", "Tool execution timed out.", true);
  }

  if (error instanceof ToolRuntimeError) {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new ToolRuntimeError("TOOL_CANCELLED", "Tool execution was cancelled.", true);
  }

  return new ToolRuntimeError("RUNTIME_ERROR", error instanceof Error ? error.message : "Unknown tool runtime error", true);
}

function mergeSignals(primaryController: AbortController, secondarySignal: AbortSignal | undefined): AbortSignal {
  if (secondarySignal === undefined) {
    return primaryController.signal;
  }

  if (secondarySignal.aborted) {
    primaryController.abort();
    return primaryController.signal;
  }

  secondarySignal.addEventListener("abort", () => {
    if (!primaryController.signal.aborted) {
      primaryController.abort();
    }
  });

  return primaryController.signal;
}
