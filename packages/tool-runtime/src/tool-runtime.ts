import {
  ExecutionRecordSchema,
  ToolCallEnvelopeSchema,
  ToolResultEnvelopeSchema,
  type Artifact,
  type ExecutionRecord,
  type ToolCall,
  type ToolResult
} from "../../contracts/src/index.js";
import type { ArtifactStore } from "../../storage/src/artifact-store.js";
import type { ExecutionRecordStore } from "../../storage/src/execution-record-store.js";
import { ToolRuntimeError } from "./errors.js";
import { assertFilesystemPermission } from "./permissions.js";
import type { RiskLevel } from "./permissions.js";
import type { ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./tool-definition.js";
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
    const parsedToolCall = ToolCallEnvelopeSchema.parse(input.toolCall);
    const startedAt = input.now();
    const executionId = input.idGenerator();

    const controller = new AbortController();
    const signal = mergeSignals(controller, input.signal);
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, parsedToolCall.timeoutMs);

    let parsedInput: unknown;
    let def: ToolDefinition<unknown> | undefined;

    try {
      def = this.dependencies.registry.get(parsedToolCall.toolName);

      try {
        parsedInput = def.inputSchema.parse(parsedToolCall.input);
      } catch (error) {
        if (error instanceof ToolRuntimeError) {
          throw error;
        }
        throw new ToolRuntimeError(
          "INVALID_TOOL_INPUT",
          `Invalid input for tool ${parsedToolCall.toolName}: ${formatZodError(error)}`,
          false
        );
      }

      assertFilesystemPermission({
        operation: parsedToolCall.toolName,
        scope: "workspace"
      });

      const replayed = this.replayIdempotentExecution(parsedToolCall, def, parsedInput);
      if (replayed !== null) {
        return replayed;
      }

      const context: ToolExecutionContext = {
        runId: input.runId,
        executionId,
        workspaceRoot: input.workspaceRoot,
        artifactRoot: input.artifactRoot,
        artifactId: input.idGenerator(),
        now: startedAt,
        signal
      };

      const execution: ToolExecutionResult = await def.execute(context, {
        toolCallId: parsedToolCall.toolCallId,
        toolName: parsedToolCall.toolName,
        input: parsedInput,
        timeoutMs: parsedToolCall.timeoutMs
      });

      const parsedToolResult = ToolResultEnvelopeSchema.parse(execution.toolResult) as ToolResult;
      if (def.resultSchema !== undefined && parsedToolResult.status === "success" && parsedToolResult.output !== undefined) {
        def.resultSchema.parse(parsedToolResult.output);
      }
      if (execution.artifacts !== undefined) {
        for (const artifact of execution.artifacts) {
          this.dependencies.artifactStore.insertArtifact(artifact);
        }
      }

      const record = persistExecutionRecord({
        executionRecordStore: this.dependencies.executionRecordStore,
        executionId,
        runId: input.runId,
        toolCall: parsedToolCall,
        toolResult: parsedToolResult,
        startedAt,
        finishedAt: input.now(),
        targetPathExtractor: def.targetPathExtractor,
        idempotencyKeyExtractor: def.idempotencyKeyExtractor,
        parsedInput
      });

      return {
        toolResult: parsedToolResult,
        executionRecord: record,
        ...(execution.artifacts === undefined ? {} : { artifacts: execution.artifacts })
      };
    } catch (error) {
      const normalizedError = normalizeToolError(error, timedOut);
      const toolResult = {
        toolCallId: parsedToolCall.toolCallId,
        toolName: parsedToolCall.toolName,
        status: "error" as const,
        error: {
          code: normalizedError.code,
          message: normalizedError.message,
          retryable: normalizedError.retryable
        }
      } as ToolResult;
      const parsedToolResult = ToolResultEnvelopeSchema.parse(toolResult) as ToolResult;
      const record = persistExecutionRecord({
        executionRecordStore: this.dependencies.executionRecordStore,
        executionId,
        runId: input.runId,
        toolCall: parsedToolCall,
        toolResult: parsedToolResult,
        startedAt,
        finishedAt: input.now(),
        targetPathExtractor: def?.targetPathExtractor,
        idempotencyKeyExtractor: def?.idempotencyKeyExtractor,
        parsedInput
      });

      return {
        toolResult: parsedToolResult,
        executionRecord: record
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  public getAvailableTools(): ToolDefinition<unknown>[] {
    return this.dependencies.registry.list();
  }

  public getRiskLevel(toolName: string): RiskLevel {
    const def = this.dependencies.registry.tryGet(toolName);
    return def === undefined ? "read" : def.riskLevel;
  }

  private replayIdempotentExecution(
    toolCall: ToolCall,
    def: ToolDefinition<unknown>,
    parsedInput: unknown
  ): {
    toolResult: ToolResult;
    executionRecord: ExecutionRecord;
  } | null {
    if (def.idempotencyKeyExtractor === undefined || def.idempotentSemantics === undefined) {
      return null;
    }

    const idempotencyKey = def.idempotencyKeyExtractor(parsedInput);
    if (idempotencyKey === undefined) {
      return null;
    }
    const targetPath = def.targetPathExtractor?.(parsedInput);

    const existingRecord = this.dependencies.executionRecordStore.findByIdempotency({
      toolName: toolCall.toolName,
      targetPath: targetPath ?? "",
      idempotencyKey
    });
    if (existingRecord === null) {
      return null;
    }

    const existingToolCall = ToolCallEnvelopeSchema.parse(JSON.parse(existingRecord.inputJson) as ToolCall);
    const existingParsedInput = def.inputSchema.parse(existingToolCall.input);
    const currentParsedToolCall = {
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: parsedInput,
      timeoutMs: toolCall.timeoutMs
    };
    const existingParsedToolCall = {
      toolCallId: existingToolCall.toolCallId,
      toolName: existingToolCall.toolName,
      input: existingParsedInput,
      timeoutMs: existingToolCall.timeoutMs
    };
    if (!def.idempotentSemantics(existingParsedToolCall, currentParsedToolCall)) {
      throw new ToolRuntimeError(
        "IDEMPOTENCY_CONFLICT",
        "A different patch request already used this idempotency key for the target path.",
        false
      );
    }

    const replayedResult = ToolResultEnvelopeSchema.parse(JSON.parse(existingRecord.outputJson) as ToolResult) as ToolResult;
    return {
      toolResult: {
        ...replayedResult,
        toolCallId: toolCall.toolCallId
      } as ToolResult,
      executionRecord: existingRecord
    };
  }
}

function formatZodError(error: unknown): string {
  if (error !== null && typeof error === "object" && "issues" in error && Array.isArray((error as { issues: unknown[] }).issues)) {
    const issues = (error as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
    return issues.map((issue) => `${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : "invalid input";
}

function persistExecutionRecord(input: {
  executionRecordStore: ExecutionRecordStore;
  executionId: string;
  runId: string;
  toolCall: ToolCall;
  toolResult: ToolResult;
  startedAt: string;
  finishedAt: string;
  targetPathExtractor: ((input: unknown) => string | undefined) | undefined;
  idempotencyKeyExtractor: ((input: unknown) => string | undefined) | undefined;
  parsedInput: unknown;
}): ExecutionRecord {
  const targetPath = input.parsedInput === undefined ? undefined : input.targetPathExtractor?.(input.parsedInput);
  const idempotencyKey = input.parsedInput === undefined ? undefined : input.idempotencyKeyExtractor?.(input.parsedInput);
  const record = ExecutionRecordSchema.parse({
    schemaVersion: "1",
    executionId: input.executionId,
    runId: input.runId,
    toolCallId: input.toolCall.toolCallId,
    toolName: input.toolCall.toolName,
    status: input.toolResult.status,
    ...(targetPath === undefined ? {} : { targetPath }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
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
