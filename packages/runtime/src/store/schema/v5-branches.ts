// Schema v5: branches and branch fork bases for Context Branching / Fork.
// Applied when user_version < 5.

export const v5BranchSchemaSql = `
CREATE TABLE IF NOT EXISTS branches (
  branch_id TEXT PRIMARY KEY,
  parent_run_id TEXT NOT NULL,
  fork_revision INTEGER NOT NULL,
  fork_event_sequence INTEGER NOT NULL,
  child_run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  lineage_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (parent_run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (child_run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS branches_parent
ON branches (parent_run_id, created_at);

CREATE TABLE IF NOT EXISTS branch_fork_base (
  branch_id TEXT PRIMARY KEY,
  parent_run_id TEXT NOT NULL,
  fork_revision INTEGER NOT NULL,
  fork_event_sequence INTEGER NOT NULL,
  inherited_refs_json TEXT NOT NULL,
  inherited_facts_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (branch_id) REFERENCES branches(branch_id) ON DELETE CASCADE
);
`;