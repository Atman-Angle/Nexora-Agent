// Schema v6: durable read batches, Tool attempts and cancellation requests.
// This migration is additive; existing Invocation and Run authority is retained.

export const v6DurableToolExecutionMigrationSql = `
ALTER TABLE tool_invocations ADD COLUMN batch_id TEXT;
ALTER TABLE tool_invocations ADD COLUMN batch_ordinal INTEGER;

CREATE TABLE IF NOT EXISTS tool_attempts (
  attempt_id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  backoff_until TEXT,
  subject_ref TEXT,
  result_json TEXT,
  error_json TEXT,
  payload_digest TEXT,
  payload_artifact_ref TEXT,
  UNIQUE (invocation_id, attempt_number),
  FOREIGN KEY (invocation_id) REFERENCES tool_invocations(invocation_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tool_attempts_run_invocation
ON tool_attempts (run_id, invocation_id, attempt_number);

CREATE TABLE IF NOT EXISTS cancellation_requests (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  reconciled_at TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
`;
