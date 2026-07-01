import {
  FailureEnvelopeSchema,
  type FailureEnvelope,
  type FailureSource,
  type ToolResult,
  type ValidationResult
} from "../../../contracts/src/index.js";
import { classifyFailure } from "./failure-classifier.js";

export function normalizeToolFailure(input: {
  failureId: string;
  runId: string;
  taskId: string;
  iteration: number;
  toolResult: Extract<ToolResult, { status: "error" }>;
  executionRecordId?: string | undefined;
  occurredAt: string;
}): FailureEnvelope {
  return normalizeFailure({
    failureId: input.failureId,
    runId: input.runId,
    taskId: input.taskId,
    source: "tool",
    code: input.toolResult.error.code,
    message: input.toolResult.error.message,
    retryable: input.toolResult.error.retryable,
    iteration: input.iteration,
    toolCallId: input.toolResult.toolCallId,
    executionRecordId: input.executionRecordId,
    evidenceRefs: [],
    sanitizedDetails: {
      toolName: input.toolResult.toolName
    },
    occurredAt: input.occurredAt
  });
}

export function normalizeValidationFailure(input: {
  failureId: string;
  runId: string;
  taskId: string;
  iteration: number;
  validation: ValidationResult;
  occurredAt: string;
}): FailureEnvelope {
  return normalizeFailure({
    failureId: input.failureId,
    runId: input.runId,
    taskId: input.taskId,
    source: "validation",
    code: "VALIDATION_FAILED",
    message: input.validation.testResult?.summary ?? "Validation failed.",
    retryable: true,
    iteration: input.iteration,
    evidenceRefs: input.validation.evidenceRecords.map((record) => record.evidenceId),
    sanitizedDetails: {
      status: input.validation.status,
      evidence: input.validation.evidence
    },
    occurredAt: input.occurredAt
  });
}

export function normalizeFailure(input: {
  failureId: string;
  runId: string;
  taskId: string;
  source: FailureSource;
  code?: string | undefined;
  message: string;
  retryable: boolean;
  iteration: number;
  toolCallId?: string | undefined;
  executionRecordId?: string | undefined;
  evidenceRefs: string[];
  sanitizedDetails?: Record<string, unknown> | undefined;
  occurredAt: string;
}): FailureEnvelope {
  const category = classifyFailure({
    source: input.source,
    code: input.code,
    message: input.message,
    retryable: input.retryable
  });
  return FailureEnvelopeSchema.parse({
    schemaVersion: "1",
    failureId: input.failureId,
    runId: input.runId,
    taskId: input.taskId,
    source: input.source,
    category,
    ...(input.code === undefined ? {} : { code: input.code }),
    message: input.message,
    retryable: input.retryable,
    iteration: input.iteration,
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    ...(input.executionRecordId === undefined ? {} : { executionRecordId: input.executionRecordId }),
    evidenceRefs: input.evidenceRefs,
    ...(input.sanitizedDetails === undefined ? {} : { sanitizedDetails: input.sanitizedDetails }),
    occurredAt: input.occurredAt
  });
}
