-- A document supplies a complete context version. Execution records remain immutable.
CREATE TABLE runtime_conversation_inputs (
  space_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  ordinal BIGSERIAL NOT NULL,
  base_sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'accepted', 'rejected')),
  reserved_until BIGINT NOT NULL,
  run_id TEXT,
  payload_json JSONB NOT NULL,
  response_json JSONB,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id),
  UNIQUE (space_id, session_id, client_request_id),
  UNIQUE (space_id, run_id),
  FOREIGN KEY (space_id, session_id)
    REFERENCES runtime_sessions(space_id, id) ON DELETE CASCADE
);
CREATE INDEX runtime_conversation_inputs_session
  ON runtime_conversation_inputs(space_id, session_id, ordinal DESC);
