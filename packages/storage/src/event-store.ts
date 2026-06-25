import { EventSchema, type Event } from "../../contracts/src/index.js";
import type { DatabaseClient } from "./database.js";

export class EventStore {
  public constructor(private readonly database: DatabaseClient) {}

  public appendEvent(event: Event): void {
    const parsedEvent = EventSchema.parse(event);
    this.database.connection
      .prepare(
        `INSERT INTO events (id, run_id, event_version, sequence, type, payload_json, timestamp)
         VALUES (@id, @runId, @eventVersion, @sequence, @type, @payloadJson, @timestamp)`
      )
      .run({
        id: parsedEvent.eventId,
        runId: parsedEvent.runId,
        eventVersion: parsedEvent.eventVersion,
        sequence: parsedEvent.sequence,
        type: parsedEvent.type,
        payloadJson: JSON.stringify(parsedEvent.payload),
        timestamp: parsedEvent.timestamp
      });
  }

  public listEventsByRun(runId: string): Event[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, run_id, event_version, sequence, type, payload_json, timestamp
         FROM events
         WHERE run_id = ?
         ORDER BY sequence ASC`
      )
      .all(runId) as Array<{
      id: string;
      run_id: string;
      event_version: string;
      sequence: number;
      type: Event["type"];
      payload_json: string;
      timestamp: string;
    }>;

    return rows.map((row) =>
      EventSchema.parse({
        eventVersion: row.event_version,
        eventId: row.id,
        runId: row.run_id,
        sequence: row.sequence,
        type: row.type,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        timestamp: row.timestamp
      })
    );
  }
}
