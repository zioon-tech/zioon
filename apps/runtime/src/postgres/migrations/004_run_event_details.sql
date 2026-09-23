CREATE TABLE IF NOT EXISTS runtime_run_event_details (
  space_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  codec TEXT NOT NULL CHECK (codec IN ('gzip-json-v1')),
  payload_blob BYTEA NOT NULL,
  uncompressed_bytes BIGINT NOT NULL,
  compressed_bytes BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, run_id, sequence),
  FOREIGN KEY (space_id, run_id, sequence)
    REFERENCES runtime_run_events(space_id, run_id, sequence) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS runtime_run_event_details_created
  ON runtime_run_event_details(space_id, created_at DESC);
