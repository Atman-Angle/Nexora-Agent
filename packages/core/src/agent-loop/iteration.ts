import { AgentIterationSchema, type AgentIteration, type ProgressLedger } from "../../../contracts/src/index.js";

export function appendFailedAttempt(input: {
  ledger: ProgressLedger;
  now: string;
  actionType: "tool_call" | "update_plan" | "final" | "fail";
  summary: string;
  errorCode?: string;
  retryable: boolean;
  evidenceRefs: string[];
}): ProgressLedger {
  return {
    ...input.ledger,
    failedAttempts: [
      ...input.ledger.failedAttempts,
      {
        actionType: input.actionType,
        summary: input.summary,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        retryable: input.retryable,
        evidenceRefs: [...new Set(input.evidenceRefs)],
        createdAt: input.now
      }
    ],
    version: input.ledger.version + 1,
    updatedAt: input.now
  };
}

export function createIteration(input: {
  iterationId: string;
  runId: string;
  index: number;
  actionType: AgentIteration["actionType"];
  status: AgentIteration["status"];
  usage: {
    modelCalls: number;
    toolCalls: number;
  };
  summary: string;
  latestToolCallId?: string | undefined;
  latestExecutionRecordId?: string | undefined;
  latestValidationStatus?: "passed" | "failed" | undefined;
  evidenceRefs: string[];
  now: string;
}): AgentIteration {
  return AgentIterationSchema.parse({
    schemaVersion: "1",
    iterationId: input.iterationId,
    runId: input.runId,
    index: input.index,
    actionType: input.actionType,
    status: input.status,
    modelCallCount: input.usage.modelCalls,
    toolCallCount: input.usage.toolCalls,
    summary: input.summary,
    ...(input.latestToolCallId === undefined ? {} : { latestToolCallId: input.latestToolCallId }),
    ...(input.latestExecutionRecordId === undefined ? {} : { latestExecutionRecordId: input.latestExecutionRecordId }),
    ...(input.latestValidationStatus === undefined ? {} : { latestValidationStatus: input.latestValidationStatus }),
    evidenceRefs: [...new Set(input.evidenceRefs)],
    createdAt: input.now
  });
}

export function appendChangedFile(changedFiles: string[], nextPath: string): string[] {
  return [...new Set([...changedFiles, nextPath])];
}
