import {
  type AgentIteration,
  AgentIterationSchema,
  type ApprovalDecision,
  ApprovalDecisionSchema,
  type ApprovalRequest,
  ApprovalRequestSchema,
  type ValidationResult,
  ValidationResultSchema,
  type Checkpoint,
  CheckpointSchema,
  type ExecutionRecord,
  ExecutionRecordSchema,
  type Artifact,
  ArtifactSchema,
  type Event,
  EventSchema,
  type ProgressLedger,
  ProgressLedgerSchema,
  type PendingAction,
  PendingActionSchema,
  type Run,
  RunSchema,
  type Task,
  TaskSchema,
  type UserInputRequest,
  UserInputRequestSchema,
  type UserInputResponse,
  UserInputResponseSchema
} from "../../contracts/src/index.js";
import { openDatabase } from "../../storage/src/database.js";

export function readDatabaseState(path: string): {
  tasks: Task[];
  runs: Run[];
  events: Event[];
  artifacts: Artifact[];
  executionRecords: ExecutionRecord[];
  ledgers: ProgressLedger[];
  agentIterations: AgentIteration[];
  approvals: Array<{
    request: ApprovalRequest;
    decision?: ApprovalDecision | undefined;
  }>;
  pendingActions: PendingAction[];
  userInputRequests: Array<{
    request: UserInputRequest;
    response?: UserInputResponse | undefined;
  }>;
  checkpoints: Checkpoint[];
  validationResults: Array<{
    runId: string;
    result: ValidationResult;
    createdAt: string;
  }>;
} {
  const database = openDatabase(path);

  try {
    const tasks = database.connection
      .prepare(
        `SELECT id, schema_version, input_text, file_path, search_query, patch_path, expected_hash, patch_json, patch_encoding, idempotency_key, validation_request_json, agent_request_json, task_type, acceptance_criteria_json, execution_constraints_json, source, created_at
         FROM tasks
         ORDER BY created_at ASC`
      )
      .all()
      .map((row) =>
        TaskSchema.parse({
          schemaVersion: (row as Record<string, unknown>).schema_version,
          taskId: (row as Record<string, unknown>).id,
          input: {
            text: (row as Record<string, unknown>).input_text,
            ...((((row as Record<string, unknown>).file_path as string | null) ?? null) === null
              ? {}
              : { filePath: (row as Record<string, unknown>).file_path }),
            ...((((row as Record<string, unknown>).search_query as string | null) ?? null) === null
              ? {}
              : { searchQuery: (row as Record<string, unknown>).search_query }),
            ...((((row as Record<string, unknown>).patch_path as string | null) ?? null) === null ||
            (((row as Record<string, unknown>).expected_hash as string | null) ?? null) === null ||
            (((row as Record<string, unknown>).patch_json as string | null) ?? null) === null ||
            (((row as Record<string, unknown>).patch_encoding as string | null) ?? null) === null ||
            (((row as Record<string, unknown>).idempotency_key as string | null) ?? null) === null
              ? {}
              : {
                  patchRequest: {
                    path: (row as Record<string, unknown>).patch_path,
                    expectedHash: (row as Record<string, unknown>).expected_hash,
                    patch: JSON.parse(String((row as Record<string, unknown>).patch_json)) as {
                      type: "replace_text";
                      find: string;
                      replace: string;
                      replaceAll?: boolean;
                    },
                    encoding: (row as Record<string, unknown>).patch_encoding,
                    idempotencyKey: (row as Record<string, unknown>).idempotency_key
                  }
                }),
            ...((((row as Record<string, unknown>).validation_request_json as string | null) ?? null) === null
              ? {}
              : {
                  validationRequest: JSON.parse(
                    String((row as Record<string, unknown>).validation_request_json)
                  ) as {
                    command: string;
                    args: string[];
                    cwd: string;
                    environment: Record<string, string>;
                    timeoutMs: number;
                    purpose: string;
                    idempotencyKey: string;
                    validationPlan: {
                      planId: string;
                      validators: Array<{
                        validatorId: string;
                        type: "command_exit_code";
                        required: boolean;
                        expectedExitCode: number;
                      }>;
                    };
                  }
                }),
            ...((((row as Record<string, unknown>).agent_request_json as string | null) ?? null) === null
              ? {}
              : {
                  agentRequest: JSON.parse(String((row as Record<string, unknown>).agent_request_json)) as {
                    budget: {
                      maxLoopCount: number;
                      maxModelCalls: number;
                      maxToolCalls: number;
                      maxRetries: number;
                      maxDurationMs: number;
                    };
                  }
                }),
            taskType: (((row as Record<string, unknown>).task_type as string | null) ?? null) ?? undefined,
            acceptanceCriteria:
              (((row as Record<string, unknown>).acceptance_criteria_json as string | null) ?? null) === null
                ? []
                : (JSON.parse(String((row as Record<string, unknown>).acceptance_criteria_json)) as Array<{
                    id: string;
                    description: string;
                    required?: boolean;
                    check:
                      | { type: "changed_files_non_empty" }
                      | { type: "file_exists"; path: string }
                      | { type: "file_non_empty"; path: string }
                      | { type: "directory_non_empty"; path: string }
                      | { type: "file_contains"; path: string; text: string };
                  }>),
            ...((((row as Record<string, unknown>).execution_constraints_json as string | null) ?? null) === null
              ? {}
              : {
                  executionConstraints: JSON.parse(
                    String((row as Record<string, unknown>).execution_constraints_json)
                  ) as {
                    allowedEditFiles: string[];
                    allowedNewFiles: string[];
                    requiredEditFiles: string[];
                    requiredNewFiles: string[];
                    protectedFiles: string[];
                  }
                })
          },
          source: (row as Record<string, unknown>).source,
          createdAt: (row as Record<string, unknown>).created_at
        })
      );

    const runs = database.connection
      .prepare(
        `SELECT id, task_id, schema_version, mode, status, state_version, error_code, created_at, updated_at
         FROM runs
         ORDER BY created_at ASC`
      )
      .all()
      .map((row) =>
        RunSchema.parse({
          schemaVersion: (row as Record<string, unknown>).schema_version,
          runId: (row as Record<string, unknown>).id,
          taskId: (row as Record<string, unknown>).task_id,
          mode: (row as Record<string, unknown>).mode,
          status: (row as Record<string, unknown>).status,
          stateVersion: (row as Record<string, unknown>).state_version,
          createdAt: (row as Record<string, unknown>).created_at,
          updatedAt: (row as Record<string, unknown>).updated_at,
          errorCode: ((row as Record<string, unknown>).error_code as string | null) ?? undefined
        })
      );

    const events = database.connection
      .prepare(
        `SELECT id, run_id, event_version, sequence, type, payload_json, timestamp
         FROM events
         ORDER BY sequence ASC`
      )
      .all()
      .map((row) =>
        EventSchema.parse({
          eventVersion: (row as Record<string, unknown>).event_version,
          eventId: (row as Record<string, unknown>).id,
          runId: (row as Record<string, unknown>).run_id,
          sequence: (row as Record<string, unknown>).sequence,
          type: (row as Record<string, unknown>).type,
          payload: JSON.parse(String((row as Record<string, unknown>).payload_json)) as Record<string, unknown>,
          timestamp: (row as Record<string, unknown>).timestamp
        })
      );

    const artifacts = database.connection
      .prepare(
        `SELECT id, run_id, schema_version, type, mime_type, content, hash, created_at, file_path, size_bytes
         FROM artifacts
         ORDER BY created_at ASC`
      )
      .all()
      .map((row) =>
        ArtifactSchema.parse({
          schemaVersion: (row as Record<string, unknown>).schema_version,
          artifactId: (row as Record<string, unknown>).id,
          runId: (row as Record<string, unknown>).run_id,
          type: (row as Record<string, unknown>).type,
          mimeType: (row as Record<string, unknown>).mime_type,
          content: (row as Record<string, unknown>).content,
          hash: (row as Record<string, unknown>).hash,
          createdAt: (row as Record<string, unknown>).created_at,
          filePath: ((row as Record<string, unknown>).file_path as string | null) ?? undefined,
          sizeBytes: ((row as Record<string, unknown>).size_bytes as number | null) ?? undefined
        })
      );

    const executionRecords = database.connection
      .prepare(
        `SELECT id, schema_version, run_id, tool_call_id, tool_name, status, target_path, idempotency_key, input_json, output_json, started_at, finished_at
         FROM execution_records
         ORDER BY started_at ASC`
      )
      .all()
      .map((row) =>
        ExecutionRecordSchema.parse({
          schemaVersion: (row as Record<string, unknown>).schema_version,
          executionId: (row as Record<string, unknown>).id,
          runId: (row as Record<string, unknown>).run_id,
          toolCallId: (row as Record<string, unknown>).tool_call_id,
          toolName: (row as Record<string, unknown>).tool_name,
          status: (row as Record<string, unknown>).status,
          targetPath: ((row as Record<string, unknown>).target_path as string | null) ?? undefined,
          idempotencyKey: ((row as Record<string, unknown>).idempotency_key as string | null) ?? undefined,
          inputJson: (row as Record<string, unknown>).input_json,
          outputJson: (row as Record<string, unknown>).output_json,
          startedAt: (row as Record<string, unknown>).started_at,
          finishedAt: (row as Record<string, unknown>).finished_at
        })
      );

    const validationResults = database.connection
      .prepare(
        `SELECT run_id, payload_json, created_at
         FROM validation_results
         ORDER BY created_at ASC`
      )
      .all()
      .map((row) => ({
        runId: String((row as Record<string, unknown>).run_id),
        result: ValidationResultSchema.parse(
          JSON.parse(String((row as Record<string, unknown>).payload_json)) as ValidationResult
        ),
        createdAt: String((row as Record<string, unknown>).created_at)
      }));

    const ledgers = database.connection
      .prepare(
        `SELECT payload_json
         FROM ledger_snapshots
         ORDER BY updated_at ASC`
      )
      .all()
      .map((row) =>
        ProgressLedgerSchema.parse(JSON.parse(String((row as Record<string, unknown>).payload_json)) as ProgressLedger)
      );

    const agentIterations = database.connection
      .prepare(
        `SELECT payload_json
         FROM agent_iterations
         ORDER BY iteration_index ASC`
      )
      .all()
      .map((row) =>
        AgentIterationSchema.parse(JSON.parse(String((row as Record<string, unknown>).payload_json)) as AgentIteration)
      );

    const approvals = database.connection
      .prepare(
        `SELECT request_json, decision_json
         FROM approvals
         ORDER BY created_at ASC`
      )
      .all()
      .map((row) => ({
        request: ApprovalRequestSchema.parse(
          JSON.parse(String((row as Record<string, unknown>).request_json)) as ApprovalRequest
        ),
        decision:
          ((row as Record<string, unknown>).decision_json as string | null) === null
            ? undefined
            : ApprovalDecisionSchema.parse(
                JSON.parse(String((row as Record<string, unknown>).decision_json)) as ApprovalDecision
              )
      }));

    const pendingActions = database.connection
      .prepare(
        `SELECT payload_json
         FROM pending_actions
         ORDER BY created_at ASC`
      )
      .all()
      .map((row) =>
        PendingActionSchema.parse(JSON.parse(String((row as Record<string, unknown>).payload_json)) as PendingAction)
      );

    const userInputRequests = database.connection
      .prepare(
        `SELECT request_json, response_json
         FROM user_input_requests
         ORDER BY created_at ASC`
      )
      .all()
      .map((row) => ({
        request: UserInputRequestSchema.parse(
          JSON.parse(String((row as Record<string, unknown>).request_json)) as UserInputRequest
        ),
        response:
          ((row as Record<string, unknown>).response_json as string | null) === null
            ? undefined
            : UserInputResponseSchema.parse(
                JSON.parse(String((row as Record<string, unknown>).response_json)) as UserInputResponse
              )
      }));

    const checkpoints = database.connection
      .prepare(
        `SELECT payload_json
         FROM checkpoints
         ORDER BY created_at ASC, id ASC`
      )
      .all()
      .map((row) => {
        try {
          return CheckpointSchema.parse(JSON.parse(String((row as Record<string, unknown>).payload_json)) as Checkpoint);
        } catch {
          return null;
        }
      })
      .filter((value): value is Checkpoint => value !== null);

    return {
      tasks,
      runs,
      events,
      artifacts,
      executionRecords,
      ledgers,
      agentIterations,
      approvals,
      pendingActions,
      userInputRequests,
      checkpoints,
      validationResults
    };
  } finally {
    database.close();
  }
}
