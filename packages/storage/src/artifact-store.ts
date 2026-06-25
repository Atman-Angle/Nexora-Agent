import { ArtifactSchema, type Artifact } from "../../contracts/src/index.js";
import type { DatabaseClient } from "./database.js";

export class ArtifactStore {
  public constructor(private readonly database: DatabaseClient) {}

  public insertArtifact(artifact: Artifact): void {
    const parsedArtifact = ArtifactSchema.parse(artifact);
    this.database.connection
      .prepare(
        `INSERT INTO artifacts (id, run_id, schema_version, type, mime_type, content, hash, created_at, file_path, size_bytes)
         VALUES (@id, @runId, @schemaVersion, @type, @mimeType, @content, @hash, @createdAt, @filePath, @sizeBytes)`
      )
      .run({
        id: parsedArtifact.artifactId,
        runId: parsedArtifact.runId,
        schemaVersion: parsedArtifact.schemaVersion,
        type: parsedArtifact.type,
        mimeType: parsedArtifact.mimeType,
        content: parsedArtifact.content,
        hash: parsedArtifact.hash,
        createdAt: parsedArtifact.createdAt,
        filePath: parsedArtifact.filePath ?? null,
        sizeBytes: parsedArtifact.sizeBytes ?? null
      });
  }

  public getArtifactsByRun(runId: string): Artifact[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, run_id, schema_version, type, mime_type, content, hash, created_at, file_path, size_bytes
         FROM artifacts
         WHERE run_id = ?
         ORDER BY created_at ASC`
      )
      .all(runId) as Array<{
      id: string;
      run_id: string;
      schema_version: string;
      type: "text" | "file";
      mime_type: string;
      content: string;
      hash: string;
      created_at: string;
      file_path: string | null;
      size_bytes: number | null;
    }>;

    return rows.map((row) =>
      ArtifactSchema.parse({
        schemaVersion: row.schema_version,
        artifactId: row.id,
        runId: row.run_id,
        type: row.type,
        mimeType: row.mime_type,
        content: row.content,
        hash: row.hash,
        createdAt: row.created_at,
        filePath: row.file_path ?? undefined,
        sizeBytes: row.size_bytes ?? undefined
      })
    );
  }
}
