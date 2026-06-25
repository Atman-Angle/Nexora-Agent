import {
  UserInputRequestSchema,
  UserInputResponseSchema,
  type UserInputRequest,
  type UserInputResponse
} from "../../contracts/src/index.js";
import type { DatabaseClient } from "./database.js";

export class UserInputStore {
  public constructor(private readonly database: DatabaseClient) {}

  public insertRequest(request: UserInputRequest): void {
    const parsedRequest = UserInputRequestSchema.parse(request);
    this.database.connection
      .prepare(
        `INSERT INTO user_input_requests (
          id, run_id, status, request_json, response_json, created_at, updated_at
        ) VALUES (
          @id, @runId, @status, @requestJson, @responseJson, @createdAt, @updatedAt
        )`
      )
      .run({
        id: parsedRequest.requestId,
        runId: parsedRequest.runId,
        status: parsedRequest.status,
        requestJson: JSON.stringify(parsedRequest),
        responseJson: null,
        createdAt: parsedRequest.createdAt,
        updatedAt: parsedRequest.createdAt
      });
  }

  public updateRequest(input: {
    request: UserInputRequest;
    response?: UserInputResponse | undefined;
    updatedAt: string;
  }): void {
    const parsedRequest = UserInputRequestSchema.parse(input.request);
    const parsedResponse = input.response === undefined ? undefined : UserInputResponseSchema.parse(input.response);
    this.database.connection
      .prepare(
        `UPDATE user_input_requests
         SET status = @status,
             request_json = @requestJson,
             response_json = @responseJson,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id: parsedRequest.requestId,
        status: parsedRequest.status,
        requestJson: JSON.stringify(parsedRequest),
        responseJson: parsedResponse === undefined ? null : JSON.stringify(parsedResponse),
        updatedAt: input.updatedAt
      });
  }

  public getRequest(requestId: string): {
    request: UserInputRequest;
    response?: UserInputResponse | undefined;
  } | null {
    const row = this.database.connection
      .prepare(
        `SELECT request_json, response_json
         FROM user_input_requests
         WHERE id = ?`
      )
      .get(requestId) as
      | {
          request_json: string;
          response_json: string | null;
        }
      | undefined;

    if (row === undefined) {
      return null;
    }

    return {
      request: UserInputRequestSchema.parse(JSON.parse(row.request_json) as UserInputRequest),
      response: row.response_json === null ? undefined : UserInputResponseSchema.parse(JSON.parse(row.response_json) as UserInputResponse)
    };
  }

  public listByRun(runId: string): Array<{
    request: UserInputRequest;
    response?: UserInputResponse | undefined;
  }> {
    const rows = this.database.connection
      .prepare(
        `SELECT request_json, response_json
         FROM user_input_requests
         WHERE run_id = ?
         ORDER BY created_at ASC`
      )
      .all(runId) as Array<{
      request_json: string;
      response_json: string | null;
    }>;

    return rows.map((row) => ({
      request: UserInputRequestSchema.parse(JSON.parse(row.request_json) as UserInputRequest),
      response: row.response_json === null ? undefined : UserInputResponseSchema.parse(JSON.parse(row.response_json) as UserInputResponse)
    }));
  }

  public hasPendingByRun(runId: string): boolean {
    const row = this.database.connection
      .prepare(
        `SELECT 1
         FROM user_input_requests
         WHERE run_id = ?
           AND status = 'pending'
         LIMIT 1`
      )
      .get(runId) as { 1: number } | undefined;

    return row !== undefined;
  }
}
