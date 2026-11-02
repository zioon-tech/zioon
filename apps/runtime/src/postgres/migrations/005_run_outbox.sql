CREATE TABLE IF NOT EXISTS runtime_run_outbox (
  space_id TEXT NOT NULL,
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  owner TEXT,
  generation BIGINT NOT NULL DEFAULT 0,
  lease_until BIGINT NOT NULL DEFAULT 0,
  available_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  failure_code TEXT,
  result_json JSONB,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id),
  FOREIGN KEY (space_id, run_id)
    REFERENCES runtime_runs(space_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS runtime_run_outbox_pending
  ON runtime_run_outbox(space_id, available_at, created_at)
  WHERE status IN ('queued', 'running');
