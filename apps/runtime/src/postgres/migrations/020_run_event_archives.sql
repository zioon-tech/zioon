CREATE TABLE IF NOT EXISTS runtime_run_event_archives (
  space_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  codec TEXT NOT NULL CHECK (codec = 'gzip-json-v1'),
  payload_blob BYTEA NOT NULL,
  raw_bytes INTEGER NOT NULL CHECK (raw_bytes BETWEEN 1 AND 2097152),
  event_count INTEGER NOT NULL CHECK (event_count BETWEEN 1 AND 128),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, run_id, ref),
  FOREIGN KEY (space_id, run_id)
    REFERENCES runtime_runs(space_id, id) ON DELETE CASCADE
);

ALTER TABLE runtime_run_events
  ADD COLUMN IF NOT EXISTS archive_ref TEXT,
  ADD COLUMN IF NOT EXISTS archive_ordinal INTEGER,
  ADD COLUMN IF NOT EXISTS archive_skip_reason TEXT;

-- NOT VALID avoids an initial scan under the ALTER TABLE lock. New writes are
-- checked immediately; production validates historical rows before activation.
ALTER TABLE runtime_run_events ADD CONSTRAINT runtime_event_archive_pair
  CHECK ((archive_ref IS NULL AND archive_ordinal IS NULL)
    OR (archive_ref IS NOT NULL AND archive_ordinal IS NOT NULL AND archive_ordinal BETWEEN 0 AND 127)) NOT VALID;
ALTER TABLE runtime_run_events ADD CONSTRAINT runtime_event_archive_fk
  FOREIGN KEY (space_id, run_id, archive_ref)
    REFERENCES runtime_run_event_archives(space_id, run_id, ref) NOT VALID;

-- Production creates this concurrently before recording migration 20. Fresh
-- installations have an empty event table and can create it in the transaction.
CREATE INDEX IF NOT EXISTS runtime_run_events_archive_pending
  ON runtime_run_events(space_id, run_id, sequence)
  WHERE archive_ref IS NULL AND archive_skip_reason IS NULL
    AND payload_json->>'type' IN ('message.delta', 'reasoning.delta');
