import type { DatabaseClient } from "./database.js";

export type CompilationEvidence = { definitionHash: string; compilerVersion: string; reportJson: string; contentHash: string; createdAt: string };

/** Cold-path immutable evidence. It has no Run foreign key by design. */
export class CompilationEvidenceStore {
  public constructor(private readonly database: DatabaseClient) {}
  public putIfAbsent(value: CompilationEvidence): CompilationEvidence {
    const existing = this.get(value.definitionHash, value.compilerVersion);
    if (existing !== undefined) return existing;
    this.database.connection.prepare("INSERT INTO compilation_evidence (definition_hash,compiler_version,report_json,content_hash,created_at) VALUES (@definitionHash,@compilerVersion,@reportJson,@contentHash,@createdAt)").run(value);
    return value;
  }
  public get(definitionHash: string, compilerVersion: string): CompilationEvidence | undefined {
    const row = this.database.connection.prepare("SELECT definition_hash,compiler_version,report_json,content_hash,created_at FROM compilation_evidence WHERE definition_hash=? AND compiler_version=?").get(definitionHash, compilerVersion) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : { definitionHash: String(row.definition_hash), compilerVersion: String(row.compiler_version), reportJson: String(row.report_json), contentHash: String(row.content_hash), createdAt: String(row.created_at) };
  }
}
