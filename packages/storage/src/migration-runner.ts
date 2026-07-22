import type Database from "better-sqlite3";

export type SchemaMigration = {
  id: string;
  apply(connection: Database.Database): void;
};

export const BASELINE_SCHEMA_MIGRATION_ID = "001_baseline";

export const baselineSchemaSql = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  input_text TEXT NOT NULL,
  file_path TEXT,
  search_query TEXT,
  patch_path TEXT,
  expected_hash TEXT,
  patch_json TEXT,
  patch_encoding TEXT,
  idempotency_key TEXT,
  validation_request_json TEXT,
  agent_request_json TEXT,
  task_type TEXT,
  success_criteria_json TEXT,
  acceptance_criteria_json TEXT,
  execution_constraints_json TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  event_version TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  UNIQUE(run_id, sequence),
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  type TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  content TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  file_path TEXT,
  size_bytes INTEGER,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS execution_records (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  target_path TEXT,
  idempotency_key TEXT,
  input_json TEXT NOT NULL,
  output_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS validation_results (
  run_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS ledger_snapshots (
  run_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS agent_iterations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  iteration_index INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, iteration_index),
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  resource_scope TEXT NOT NULL,
  action_summary TEXT NOT NULL,
  action_fingerprint TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  request_json TEXT NOT NULL,
  decision_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS user_input_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  waiting_for TEXT NOT NULL,
  approval_id TEXT,
  request_id TEXT,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  run_id TEXT NOT NULL,
  run_state_version INTEGER NOT NULL,
  ledger_version INTEGER NOT NULL,
  phase TEXT NOT NULL,
  pending_action_id TEXT,
  pending_action_fingerprint TEXT,
  workspace_hash TEXT,
  note TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_run_created
  ON checkpoints(run_id, created_at);
`;

export function runSchemaMigrations(connection: Database.Database, now: () => string = () => new Date().toISOString()): void {
  ensureSchemaMigrationsTable(connection);
  const applied = new Set(listAppliedSchemaMigrations(connection).map((migration) => migration.id));

  for (const migration of schemaMigrations) {
    if (applied.has(migration.id)) {
      continue;
    }

    const transaction = connection.transaction(() => {
      migration.apply(connection);
      connection
        .prepare(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`)
        .run(migration.id, now());
    });
    transaction();
  }

  ensureColumn(connection, "tasks", "execution_constraints_json", "TEXT");
}

export function getDatabaseSchemaVersion(connection: Database.Database): string | null {
  ensureSchemaMigrationsTable(connection);
  const row = connection
    .prepare(`SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1`)
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

export function listAppliedSchemaMigrations(connection: Database.Database): Array<{ id: string; appliedAt: string }> {
  ensureSchemaMigrationsTable(connection);
  return connection
    .prepare(`SELECT id, applied_at FROM schema_migrations ORDER BY id ASC`)
    .all()
    .map((row) => ({
      id: String((row as Record<string, unknown>).id),
      appliedAt: String((row as Record<string, unknown>).applied_at)
    }));
}

const schemaMigrations: SchemaMigration[] = [
  {
    id: BASELINE_SCHEMA_MIGRATION_ID,
    apply(connection) {
      connection.exec(baselineSchemaSql);
      ensureColumn(connection, "tasks", "file_path", "TEXT");
      ensureColumn(connection, "tasks", "search_query", "TEXT");
      ensureColumn(connection, "tasks", "patch_path", "TEXT");
      ensureColumn(connection, "tasks", "expected_hash", "TEXT");
      ensureColumn(connection, "tasks", "patch_json", "TEXT");
      ensureColumn(connection, "tasks", "patch_encoding", "TEXT");
      ensureColumn(connection, "tasks", "idempotency_key", "TEXT");
      ensureColumn(connection, "tasks", "validation_request_json", "TEXT");
      ensureColumn(connection, "tasks", "agent_request_json", "TEXT");
      ensureColumn(connection, "tasks", "task_type", "TEXT");
      ensureColumn(connection, "tasks", "acceptance_criteria_json", "TEXT");
      ensureColumn(connection, "tasks", "execution_constraints_json", "TEXT");
      ensureColumn(connection, "artifacts", "file_path", "TEXT");
      ensureColumn(connection, "artifacts", "size_bytes", "INTEGER");
      ensureColumn(connection, "execution_records", "target_path", "TEXT");
      ensureColumn(connection, "execution_records", "idempotency_key", "TEXT");
    }
  }
  ,{ id: "002_session_memory", apply(connection) { connection.exec(`
CREATE TABLE IF NOT EXISTS chat_sessions (id TEXT PRIMARY KEY, profile TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(session_id, ordinal), FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS user_facts (id TEXT PRIMARY KEY, key TEXT NOT NULL, value TEXT NOT NULL, source_turn_id TEXT NOT NULL, sensitive INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_user_facts_key_status ON user_facts(key, status);
`); } }
  ,{ id: "004_session_selection_handles", apply(connection) { connection.exec(`
CREATE TABLE IF NOT EXISTS chat_selection_handles (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_turn_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(session_id, position), FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_chat_selection_handles_session ON chat_selection_handles(session_id, position);
`); } }
  ,{ id: "005_task_success_criteria", apply(connection) { ensureColumn(connection, "tasks", "success_criteria_json", "TEXT"); } }
];

function ensureSchemaMigrationsTable(connection: Database.Database): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

function ensureColumn(connection: Database.Database, tableName: string, columnName: string, columnType: string): void {
  const columns = connection.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  connection.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
}
