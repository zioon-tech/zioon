ALTER TABLE runtime_collaboration_documents
  ADD COLUMN IF NOT EXISTS base_version BIGINT,
  ADD COLUMN IF NOT EXISTS base_hash TEXT,
  ADD COLUMN IF NOT EXISTS update_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS update_bytes BIGINT NOT NULL DEFAULT 0;

ALTER TABLE runtime_collaboration_documents
  ADD CONSTRAINT runtime_collaboration_update_bounds CHECK (
    update_count >= 0 AND update_count < 128
    AND update_bytes >= 0 AND update_bytes <= 1048576
    AND (
      (base_version IS NULL AND base_hash IS NULL AND update_count=0 AND update_bytes=0)
      OR
      (base_version IS NOT NULL AND base_hash IS NOT NULL
        AND base_version >= 1 AND base_version <= version
        AND base_hash ~ '^[a-f0-9]{64}$' AND version-base_version=update_count)
    )
  );

CREATE TABLE IF NOT EXISTS runtime_collaboration_updates (
  space_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  update_blob BYTEA NOT NULL CHECK (
    octet_length(update_blob) > 0 AND octet_length(update_blob) <= 1048576
  ),
  update_hash TEXT NOT NULL CHECK (update_hash ~ '^[a-f0-9]{64}$'),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, session_id, version),
  FOREIGN KEY (space_id, session_id)
    REFERENCES runtime_collaboration_documents(space_id, session_id) ON DELETE CASCADE
);

-- Commit the snapshot fence before scanning Space locks for a downgrade.
CREATE TABLE IF NOT EXISTS runtime_collaboration_storage_mode (
  id TEXT PRIMARY KEY CHECK (id='global'),
  mode TEXT NOT NULL CHECK (mode IN ('incremental','snapshot'))
);
INSERT INTO runtime_collaboration_storage_mode(id,mode) VALUES ('global','incremental')
  ON CONFLICT (id) DO NOTHING;
