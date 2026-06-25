import Database from "better-sqlite3";

const migrationSql = `
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
`;

export interface DatabaseClient {
  connection: Database.Database;
  close(): void;
}

export function openDatabase(path: string): DatabaseClient {
  const connection = new Database(path);
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
  connection.exec(migrationSql);
  ensureColumn(connection, "tasks", "file_path", "TEXT");
  ensureColumn(connection, "tasks", "search_query", "TEXT");
  ensureColumn(connection, "tasks", "patch_path", "TEXT");
  ensureColumn(connection, "tasks", "expected_hash", "TEXT");
  ensureColumn(connection, "tasks", "patch_json", "TEXT");
  ensureColumn(connection, "tasks", "patch_encoding", "TEXT");
  ensureColumn(connection, "tasks", "idempotency_key", "TEXT");
  ensureColumn(connection, "tasks", "validation_request_json", "TEXT");
  ensureColumn(connection, "tasks", "agent_request_json", "TEXT");
  ensureColumn(connection, "artifacts", "file_path", "TEXT");
  ensureColumn(connection, "artifacts", "size_bytes", "INTEGER");
  ensureColumn(connection, "execution_records", "target_path", "TEXT");
  ensureColumn(connection, "execution_records", "idempotency_key", "TEXT");

  return {
    connection,
    close() {
      connection.close();
    }
  };
}

function ensureColumn(connection: Database.Database, tableName: string, columnName: string, columnType: string): void {
  const columns = connection.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  connection.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
}
