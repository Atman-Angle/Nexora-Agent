// Schema v4: context_checkpoints table for structured compaction.
// Applied when user_version < 4.

export const v4ContextCheckpointSchemaSql = `
CREATE TABLE IF NOT EXISTS context_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  source_digests_json TEXT NOT NULL,
  covered_invocations_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS context_checkpoints_run
ON context_checkpoints (run_id, plan_version);
`;
