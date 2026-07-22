import { TaskSchema, type Task } from "../../contracts/src/index.js";
import type { DatabaseClient } from "./database.js";

export class TaskStore {
  public constructor(private readonly database: DatabaseClient) {}

  public insertTask(task: Task): void {
    const parsedTask = TaskSchema.parse(task);
    this.database.connection
      .prepare(
        `INSERT INTO tasks (
          id, schema_version, input_text, file_path, search_query, patch_path, expected_hash, patch_json, patch_encoding, idempotency_key, validation_request_json, agent_request_json, task_type, success_criteria_json, acceptance_criteria_json, execution_constraints_json, source, created_at
        ) VALUES (
          @id, @schemaVersion, @inputText, @filePath, @searchQuery, @patchPath, @expectedHash, @patchJson, @patchEncoding, @idempotencyKey, @validationRequestJson, @agentRequestJson, @taskType, @successCriteriaJson, @acceptanceCriteriaJson, @executionConstraintsJson, @source, @createdAt
        )`
      )
      .run({
        id: parsedTask.taskId,
        schemaVersion: parsedTask.schemaVersion,
        inputText: parsedTask.input.text,
        filePath: parsedTask.input.filePath ?? null,
        searchQuery: parsedTask.input.searchQuery ?? null,
        patchPath: parsedTask.input.patchRequest?.path ?? null,
        expectedHash: parsedTask.input.patchRequest?.expectedHash ?? null,
        patchJson: parsedTask.input.patchRequest === undefined ? null : JSON.stringify(parsedTask.input.patchRequest.patch),
        patchEncoding: parsedTask.input.patchRequest?.encoding ?? null,
        idempotencyKey: parsedTask.input.patchRequest?.idempotencyKey ?? null,
        validationRequestJson:
          parsedTask.input.validationRequest === undefined ? null : JSON.stringify(parsedTask.input.validationRequest),
        agentRequestJson: parsedTask.input.agentRequest === undefined ? null : JSON.stringify(parsedTask.input.agentRequest),
        taskType: parsedTask.input.taskType,
        successCriteriaJson: JSON.stringify(parsedTask.input.successCriteria ?? []),
        acceptanceCriteriaJson: JSON.stringify(parsedTask.input.acceptanceCriteria),
        executionConstraintsJson:
          parsedTask.input.executionConstraints === undefined ? null : JSON.stringify(parsedTask.input.executionConstraints),
        source: parsedTask.source,
        createdAt: parsedTask.createdAt
      });
  }

  public getTask(taskId: string): Task | null {
    const row = this.database.connection
      .prepare(
        `SELECT id, schema_version, input_text, file_path, search_query, patch_path, expected_hash, patch_json, patch_encoding, idempotency_key, validation_request_json, agent_request_json, task_type, success_criteria_json, acceptance_criteria_json, execution_constraints_json, source, created_at
         FROM tasks
         WHERE id = ?`
      )
      .get(taskId) as
      | {
          id: string;
          schema_version: string;
          input_text: string;
          file_path: string | null;
          search_query: string | null;
          patch_path: string | null;
          expected_hash: string | null;
          patch_json: string | null;
          patch_encoding: "utf8" | null;
          idempotency_key: string | null;
          validation_request_json: string | null;
          agent_request_json: string | null;
          task_type: string | null;
          success_criteria_json: string | null;
          acceptance_criteria_json: string | null;
          execution_constraints_json: string | null;
          source: "application" | "cli";
          created_at: string;
        }
      | undefined;

    if (row === undefined) {
      return null;
    }

    return TaskSchema.parse({
      schemaVersion: row.schema_version,
      taskId: row.id,
      input: {
        text: row.input_text,
        ...(row.file_path === null ? {} : { filePath: row.file_path }),
        ...(row.search_query === null ? {} : { searchQuery: row.search_query }),
        ...(row.patch_path === null ||
        row.expected_hash === null ||
        row.patch_json === null ||
        row.patch_encoding === null ||
        row.idempotency_key === null
          ? {}
          : {
              patchRequest: {
                path: row.patch_path,
                expectedHash: row.expected_hash,
                patch: JSON.parse(row.patch_json) as {
                  type: "replace_text";
                  find: string;
                  replace: string;
                  replaceAll?: boolean;
                },
                encoding: row.patch_encoding,
                idempotencyKey: row.idempotency_key
              }
            }),
        ...(row.validation_request_json === null
          ? {}
          : {
              validationRequest: JSON.parse(row.validation_request_json) as {
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
        ...(row.agent_request_json === null
          ? {}
          : {
              agentRequest: JSON.parse(row.agent_request_json) as {
                budget: {
                  maxLoopCount: number;
                  maxModelCalls: number;
                  maxToolCalls: number;
                  maxRetries: number;
                  maxDurationMs: number;
                };
              }
            }),
        taskType: row.task_type ?? undefined,
        successCriteria:
          row.success_criteria_json === null ? [] : (JSON.parse(row.success_criteria_json) as string[]),
        acceptanceCriteria:
          row.acceptance_criteria_json === null
            ? []
            : (JSON.parse(row.acceptance_criteria_json) as Array<{
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
        ...(row.execution_constraints_json === null
          ? {}
          : {
              executionConstraints: JSON.parse(row.execution_constraints_json) as {
                allowedEditFiles: string[];
                allowedNewFiles: string[];
                requiredEditFiles: string[];
                requiredNewFiles: string[];
                protectedFiles: string[];
              }
            })
      },
      source: row.source,
      createdAt: row.created_at
    });
  }
}
