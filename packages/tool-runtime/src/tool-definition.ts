import type { ZodType, ZodTypeDef } from "zod";

import type { Artifact, ToolResult } from "../../contracts/src/index.js";
import type { RiskLevel } from "./permissions.js";

export type ToolExecutionContext = {
  runId: string;
  executionId: string;
  workspaceRoot: string;
  artifactRoot: string;
  artifactId: string;
  now: string;
  signal?: AbortSignal;
};

export type ToolExecutionResult = {
  toolResult: ToolResult;
  artifacts?: Artifact[];
  /** Ephemeral numeric execution measurements; never part of a ToolResult. */
  telemetry?: ToolExecutionTelemetry;
};

export type ToolExecutionTelemetry = {
  localDurationMs?: number;
  toolRuntimeDurationMs?: number;
  scannedFiles?: number;
  readBytes?: number;
  documentSegments?: number;
  workerDurationMs?: number;
  workerOutputBytes?: number;
  astDurationMs?: number;
  astMatches?: number;
  astOutputBytes?: number;
};

export type ParsedToolCall<I> = {
  toolCallId: string;
  toolName: string;
  input: I;
  timeoutMs: number;
};

export type ModelVisibleFieldType =
  | "string"
  | "number"
  | "boolean"
  | "string[]"
  | "record"
  | "enum";

export type ModelVisibleField = {
  name: string;
  type: ModelVisibleFieldType;
  required: boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  description?: string;
};

export type ToolDefinition<I = unknown> = {
  readonly name: string;
  readonly inputSchema: ZodType<I, ZodTypeDef, unknown>;
  readonly resultSchema?: ZodType<unknown, ZodTypeDef, unknown>;
  readonly execute: (context: ToolExecutionContext, toolCall: ParsedToolCall<I>) => Promise<ToolExecutionResult>;
  readonly riskLevel: RiskLevel;
  readonly requiresApproval: boolean;
  readonly description: string;
  readonly inputFields: readonly ModelVisibleField[];
  readonly minimalExample: Record<string, unknown>;
  readonly idempotencyKeyExtractor?: (input: I) => string | undefined;
  readonly targetPathExtractor?: (input: I) => string | undefined;
  readonly idempotentSemantics?: (a: ParsedToolCall<I>, b: ParsedToolCall<I>) => boolean;
};
