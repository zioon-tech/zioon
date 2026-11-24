-- Prepare this index concurrently before activating production readers.
-- Include the cursor so finding the retention boundary need not read bodies.
CREATE INDEX IF NOT EXISTS runtime_run_events_projection_start
  ON runtime_run_events(space_id, created_at) INCLUDE (cursor);
