CREATE TABLE IF NOT EXISTS runtime_assets (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  state TEXT NOT NULL,
  media_kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_length BIGINT NOT NULL CHECK (byte_length > 0),
  sha256 TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  original_name TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id),
  CHECK (state IN (
    'stored', 'scanning', 'processing', 'ready',
    'failed', 'quarantined', 'deleted'
  )),
  CHECK (media_kind IN ('image', 'audio', 'video', 'document', 'binary')),
  CHECK (sha256 ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS runtime_assets_digest
  ON runtime_assets(space_id, sha256);

CREATE INDEX IF NOT EXISTS runtime_assets_created
  ON runtime_assets(space_id, created_at DESC);
