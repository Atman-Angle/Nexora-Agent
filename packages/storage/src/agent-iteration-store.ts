import { AgentIterationSchema, type AgentIteration } from "../../contracts/src/index.js";
import type { DatabaseClient } from "./database.js";

export class AgentIterationStore {
  public constructor(private readonly database: DatabaseClient) {}

  public insertIteration(iteration: AgentIteration): void {
    const parsedIteration = AgentIterationSchema.parse(iteration);
    this.database.connection
      .prepare(
        `INSERT INTO agent_iterations (id, run_id, schema_version, iteration_index, action_type, status, payload_json, created_at)
         VALUES (@id, @runId, @schemaVersion, @iterationIndex, @actionType, @status, @payloadJson, @createdAt)`
      )
      .run({
        id: parsedIteration.iterationId,
        runId: parsedIteration.runId,
        schemaVersion: parsedIteration.schemaVersion,
        iterationIndex: parsedIteration.index,
        actionType: parsedIteration.actionType,
        status: parsedIteration.status,
        payloadJson: JSON.stringify(parsedIteration),
        createdAt: parsedIteration.createdAt
      });
  }

  public listByRun(runId: string): AgentIteration[] {
    const rows = this.database.connection
      .prepare(
        `SELECT payload_json
         FROM agent_iterations
         WHERE run_id = ?
         ORDER BY iteration_index ASC`
      )
      .all(runId) as Array<{
      payload_json: string;
    }>;

    return rows.map((row) => AgentIterationSchema.parse(JSON.parse(row.payload_json) as AgentIteration));
  }
}
