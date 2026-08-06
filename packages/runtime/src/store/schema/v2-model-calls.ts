// Schema v2: Model Call Ledger.
// Applied when user_version < 2.

export const v2ModelCallSchemaSql = `
CREATE TABLE IF NOT EXISTS model_calls (
  call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  phase TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  projection_digest TEXT,
  context_window_tokens INTEGER NOT NULL,
  reserved_output_tokens INTEGER NOT NULL,
  soft_input_limit_tokens INTEGER NOT NULL,
  hard_input_limit_tokens INTEGER NOT NULL,
  measured_input_tokens INTEGER NOT NULL,
  measurement_method TEXT NOT NULL,
  meter TEXT NOT NULL,
  budget_decision TEXT NOT NULL,
  status TEXT NOT NULL,
  actual_input_tokens INTEGER,
  actual_output_tokens INTEGER,
  actual_total_tokens INTEGER,
  error_code TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (run_id, sequence),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS model_calls_run_phase
ON model_calls (run_id, phase, sequence);
`;
