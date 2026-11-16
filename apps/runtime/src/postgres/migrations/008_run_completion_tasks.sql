-- Recorded in the same transaction as the terminal execution event.
-- Immutable caller context stays out of the frequently updated Run payload.
CREATE TABLE runtime_run_inputs (
  space_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  messages_json JSONB NOT NULL,
  source TEXT NOT NULL DEFAULT 'submission',
  source_checkpoint_sequence BIGINT,
  PRIMARY KEY (space_id, run_id),
  FOREIGN KEY (space_id, run_id) REFERENCES runtime_runs(space_id, id) ON DELETE CASCADE
);

CREATE TABLE runtime_run_completion_tasks (
  space_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  terminal_sequence BIGINT NOT NULL,
  payload_json JSONB NOT NULL,
  completed_steps JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued',
  owner TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0,
  available_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (space_id, run_id, attempt_id, terminal_sequence),
  FOREIGN KEY (space_id, run_id) REFERENCES runtime_runs(space_id, id) ON DELETE CASCADE
);
CREATE INDEX runtime_run_completion_tasks_pending
  ON runtime_run_completion_tasks(space_id, available_at)
  WHERE status <> 'completed';
