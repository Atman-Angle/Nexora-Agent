// Schema v7: versioned Run journal envelopes, Model Call context manifests,
// and physical Provider Attempts.
export const v7DurableRunJournalMigrationSql = `
ALTER TABLE run_events ADD COLUMN schema_version INTEGER;
ALTER TABLE run_events ADD COLUMN actor_type TEXT;
ALTER TABLE run_events ADD COLUMN causation_ref TEXT;
ALTER TABLE run_events ADD COLUMN correlation_ref TEXT;
ALTER TABLE run_events ADD COLUMN payload_digest TEXT;
ALTER TABLE run_events ADD COLUMN payload_artifact_ref TEXT;
ALTER TABLE run_events ADD COLUMN previous_record_digest TEXT;
ALTER TABLE run_events ADD COLUMN record_digest TEXT;
ALTER TABLE run_events ADD COLUMN completeness TEXT NOT NULL DEFAULT 'legacy_partial';

CREATE INDEX IF NOT EXISTS run_events_run_completeness
ON run_events (run_id, completeness);

CREATE TABLE model_call_audits (
  call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  capture_policy TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  request_artifact_ref TEXT,
  output_digest TEXT,
  output_artifact_ref TEXT,
  error_digest TEXT,
  error_artifact_ref TEXT,
  capture_status TEXT NOT NULL,
  FOREIGN KEY (call_id) REFERENCES model_calls(call_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE TABLE provider_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT,
  response_digest TEXT,
  response_artifact_ref TEXT,
  actual_input_tokens INTEGER,
  actual_output_tokens INTEGER,
  actual_total_tokens INTEGER,
  UNIQUE (call_id, attempt_number),
  FOREIGN KEY (call_id) REFERENCES model_calls(call_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE INDEX provider_attempts_run_call
ON provider_attempts (run_id, call_id, attempt_number);
`;
