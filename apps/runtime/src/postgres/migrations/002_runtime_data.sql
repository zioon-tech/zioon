CREATE TABLE IF NOT EXISTS runtime_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_import_progress (
  source_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  last_rowid BIGINT NOT NULL DEFAULT 0,
  rows_imported BIGINT NOT NULL DEFAULT 0,
  source_count BIGINT NOT NULL,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (source_id, space_id, table_name)
);

CREATE TABLE IF NOT EXISTS runtime_runs (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id)
);

CREATE TABLE IF NOT EXISTS runtime_run_events (
  cursor BIGSERIAL PRIMARY KEY,
  space_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (space_id, event_id),
  UNIQUE (space_id, run_id, sequence),
  FOREIGN KEY (space_id, run_id)
    REFERENCES runtime_runs(space_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runtime_run_checkpoints (
  space_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, run_id, sequence),
  FOREIGN KEY (space_id, run_id)
    REFERENCES runtime_runs(space_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runtime_run_transcript (
  space_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, run_id, turn, ordinal),
  UNIQUE (space_id, message_id),
  FOREIGN KEY (space_id, run_id)
    REFERENCES runtime_runs(space_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runtime_sessions (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id)
);

CREATE TABLE IF NOT EXISTS runtime_session_seed_transcript (
  space_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, session_id, ordinal),
  FOREIGN KEY (space_id, session_id)
    REFERENCES runtime_sessions(space_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runtime_session_messages (
  space_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, session_id, sequence),
  UNIQUE (space_id, message_id),
  UNIQUE (space_id, session_id, run_id, role),
  FOREIGN KEY (space_id, session_id)
    REFERENCES runtime_sessions(space_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runtime_session_message_commands (
  space_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  status TEXT NOT NULL,
  response_json JSONB,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, session_id, client_request_id),
  FOREIGN KEY (space_id, session_id)
    REFERENCES runtime_sessions(space_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runtime_tool_invocation_receipts (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  invocation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json JSONB NOT NULL,
  completed_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, invocation_id)
);

CREATE TABLE IF NOT EXISTS runtime_artifacts (
  space_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, artifact_id),
  FOREIGN KEY (space_id, run_id)
    REFERENCES runtime_runs(space_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runtime_change_sets (
  space_id TEXT NOT NULL,
  change_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, change_id),
  FOREIGN KEY (space_id, artifact_id)
    REFERENCES runtime_artifacts(space_id, artifact_id) ON DELETE CASCADE,
  FOREIGN KEY (space_id, run_id)
    REFERENCES runtime_runs(space_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runtime_todo_lists (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, owner_id)
);

CREATE INDEX IF NOT EXISTS runtime_runs_status_updated
  ON runtime_runs(space_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS runtime_run_events_created
  ON runtime_run_events(space_id, run_id, created_at);
CREATE INDEX IF NOT EXISTS runtime_run_checkpoints_created
  ON runtime_run_checkpoints(space_id, run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS runtime_run_transcript_created
  ON runtime_run_transcript(space_id, run_id, created_at);
CREATE INDEX IF NOT EXISTS runtime_session_messages_created
  ON runtime_session_messages(space_id, session_id, created_at);
CREATE INDEX IF NOT EXISTS runtime_session_commands_updated
  ON runtime_session_message_commands(space_id, updated_at);
CREATE INDEX IF NOT EXISTS runtime_tool_receipts_run
  ON runtime_tool_invocation_receipts(space_id, run_id, tool_name, completed_at);
CREATE INDEX IF NOT EXISTS runtime_artifacts_run
  ON runtime_artifacts(space_id, run_id, created_at);
CREATE INDEX IF NOT EXISTS runtime_change_sets_run
  ON runtime_change_sets(space_id, run_id, created_at);

CREATE TABLE IF NOT EXISTS runtime_workbench_state (
  space_id TEXT PRIMARY KEY REFERENCES account_spaces(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  revision BIGINT NOT NULL,
  tree_json JSONB NOT NULL,
  index_json JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_workbench_documents (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id)
);

CREATE TABLE IF NOT EXISTS runtime_workbench_metadata (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  meta_json JSONB NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id)
);

CREATE TABLE IF NOT EXISTS runtime_workbench_session_heads (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id)
);

CREATE TABLE IF NOT EXISTS runtime_workbench_session_revisions (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  text TEXT NOT NULL,
  meta_json JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  operation_id TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, session_id, revision)
);

CREATE TABLE IF NOT EXISTS runtime_workbench_revision_annotations (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  annotations_json JSONB NOT NULL,
  byte_size BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, ref)
);

CREATE TABLE IF NOT EXISTS runtime_workbench_operations (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_revision BIGINT NOT NULL,
  result_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, operation_id)
);

CREATE TABLE IF NOT EXISTS runtime_workbench_tombstones (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  deleted_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id)
);

CREATE TABLE IF NOT EXISTS runtime_workbench_kv (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json JSONB NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, key)
);

CREATE TABLE IF NOT EXISTS runtime_workbench_events (
  sequence BIGSERIAL PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  session_id TEXT,
  run_id TEXT,
  revision TEXT,
  session_revision BIGINT,
  source_client_id TEXT,
  payload_json JSONB NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_collaboration_documents (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  state_blob BYTEA NOT NULL,
  state_hash TEXT NOT NULL,
  version BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, session_id)
);

CREATE TABLE IF NOT EXISTS runtime_state_migrations (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, source, fingerprint)
);

CREATE INDEX IF NOT EXISTS runtime_workbench_events_space_sequence
  ON runtime_workbench_events(space_id, sequence);
CREATE INDEX IF NOT EXISTS runtime_workbench_events_session_sequence
  ON runtime_workbench_events(space_id, session_id, sequence);
CREATE INDEX IF NOT EXISTS runtime_workbench_revisions_created
  ON runtime_workbench_session_revisions(space_id, session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_scheduler_tasks (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  enabled BOOLEAN NOT NULL,
  next_run BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id)
);

CREATE TABLE IF NOT EXISTS runtime_scheduler_runs (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_until BIGINT,
  payload_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id),
  UNIQUE (space_id, occurrence_id)
);

CREATE TABLE IF NOT EXISTS runtime_scheduler_migrations (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, source, fingerprint)
);

CREATE INDEX IF NOT EXISTS runtime_scheduler_tasks_due
  ON runtime_scheduler_tasks(space_id, enabled, next_run);
CREATE INDEX IF NOT EXISTS runtime_scheduler_runs_task
  ON runtime_scheduler_runs(space_id, task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS runtime_scheduler_runs_status
  ON runtime_scheduler_runs(space_id, status, created_at);

CREATE TABLE IF NOT EXISTS runtime_access_pairings (
  pairing_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  user_code_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  delivery TEXT NOT NULL,
  scopes_json JSONB NOT NULL,
  label TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts_remaining INTEGER NOT NULL,
  consumed_at BIGINT,
  consumed_by_device_id TEXT
);

CREATE TABLE IF NOT EXISTS runtime_access_devices (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  platform TEXT NOT NULL,
  scopes_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_seen_at BIGINT,
  revoked_at BIGINT,
  PRIMARY KEY (space_id, device_id)
);

CREATE TABLE IF NOT EXISTS runtime_access_credentials (
  credential_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at BIGINT,
  FOREIGN KEY (space_id, device_id)
    REFERENCES runtime_access_devices(space_id, device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS runtime_access_pairings_expires
  ON runtime_access_pairings(space_id, expires_at);
CREATE INDEX IF NOT EXISTS runtime_access_credentials_device
  ON runtime_access_credentials(space_id, device_id);
CREATE INDEX IF NOT EXISTS runtime_access_credentials_expires
  ON runtime_access_credentials(space_id, expires_at);

CREATE TABLE IF NOT EXISTS runtime_device_nodes (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  registration_json JSONB NOT NULL,
  last_seen_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, node_id)
);

CREATE TABLE IF NOT EXISTS runtime_project_bindings (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, project_id, node_id, resource_id),
  FOREIGN KEY (space_id, node_id)
    REFERENCES runtime_device_nodes(space_id, node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runtime_invocation_receipts (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  invocation_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  result_json JSONB NOT NULL,
  completed_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, invocation_id)
);

CREATE INDEX IF NOT EXISTS runtime_project_bindings_node
  ON runtime_project_bindings(space_id, node_id);
CREATE INDEX IF NOT EXISTS runtime_invocation_receipts_completed
  ON runtime_invocation_receipts(space_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS runtime_observability_meta (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (space_id, key)
);

CREATE TABLE IF NOT EXISTS obs_runs (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT,
  source_cursor BIGINT NOT NULL,
  event_sequence BIGINT,
  timestamp BIGINT NOT NULL,
  projected_at BIGINT NOT NULL,
  user_id TEXT,
  identity TEXT NOT NULL,
  session_ref TEXT,
  project_ref TEXT,
  status TEXT NOT NULL,
  created_at BIGINT,
  updated_at BIGINT,
  completed_at BIGINT,
  duration_ms BIGINT,
  terminal_reason TEXT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  reasoning_tokens BIGINT,
  cache_read_tokens BIGINT,
  cache_write_tokens BIGINT,
  trace_id TEXT,
  trace_state TEXT,
  trace_retryable INTEGER,
  stages_truncated INTEGER,
  PRIMARY KEY (space_id, record_id)
);

CREATE TABLE IF NOT EXISTS obs_events (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT,
  source_cursor BIGINT NOT NULL,
  event_sequence BIGINT,
  timestamp BIGINT NOT NULL,
  projected_at BIGINT NOT NULL,
  type TEXT NOT NULL,
  turn INTEGER,
  tool TEXT,
  ok INTEGER,
  denial_type TEXT,
  failure_code TEXT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  reasoning_tokens BIGINT,
  cache_read_tokens BIGINT,
  cache_write_tokens BIGINT,
  PRIMARY KEY (space_id, record_id)
);

CREATE TABLE IF NOT EXISTS obs_stages (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT,
  source_cursor BIGINT NOT NULL,
  event_sequence BIGINT,
  timestamp BIGINT NOT NULL,
  projected_at BIGINT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  status TEXT,
  duration_ms DOUBLE PRECISION,
  first_chunk_ms DOUBLE PRECISION,
  consumer_wait_ms DOUBLE PRECISION,
  active_duration_ms DOUBLE PRECISION,
  credential_ms DOUBLE PRECISION,
  http_status INTEGER,
  failure_code TEXT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  reasoning_tokens BIGINT,
  cache_read_tokens BIGINT,
  cache_write_tokens BIGINT,
  PRIMARY KEY (space_id, record_id)
);

CREATE TABLE IF NOT EXISTS runtime_observability_pending_traces (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  source_cursor BIGINT NOT NULL,
  record_json JSONB NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, source_cursor)
);

CREATE INDEX IF NOT EXISTS obs_runs_time
  ON obs_runs(space_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS obs_runs_status_time
  ON obs_runs(space_id, status, timestamp DESC);
CREATE INDEX IF NOT EXISTS obs_runs_run_cursor
  ON obs_runs(space_id, run_id, source_cursor DESC);
CREATE INDEX IF NOT EXISTS obs_events_time
  ON obs_events(space_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS obs_events_run_sequence
  ON obs_events(space_id, run_id, event_sequence);
CREATE INDEX IF NOT EXISTS obs_events_tool_failure
  ON obs_events(space_id, tool, failure_code, timestamp DESC);
CREATE INDEX IF NOT EXISTS obs_stages_time
  ON obs_stages(space_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS obs_stages_run
  ON obs_stages(space_id, run_id, timestamp);

ALTER TABLE obs_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE obs_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE obs_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE obs_events FORCE ROW LEVEL SECURITY;
ALTER TABLE obs_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE obs_stages FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS obs_runs_space_policy ON obs_runs;
CREATE POLICY obs_runs_space_policy ON obs_runs
  USING (space_id = current_setting('zion.space_id', true))
  WITH CHECK (space_id = current_setting('zion.space_id', true));
DROP POLICY IF EXISTS obs_events_space_policy ON obs_events;
CREATE POLICY obs_events_space_policy ON obs_events
  USING (space_id = current_setting('zion.space_id', true))
  WITH CHECK (space_id = current_setting('zion.space_id', true));
DROP POLICY IF EXISTS obs_stages_space_policy ON obs_stages;
CREATE POLICY obs_stages_space_policy ON obs_stages
  USING (space_id = current_setting('zion.space_id', true))
  WITH CHECK (space_id = current_setting('zion.space_id', true));
