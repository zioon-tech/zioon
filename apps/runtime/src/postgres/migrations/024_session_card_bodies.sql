-- Reader deployment precedes any body-reference write. Startup creates only
-- the relation; existing metadata/Y documents are converted in bounded tasks.
CREATE TABLE IF NOT EXISTS runtime_session_card_bodies (
  space_id TEXT NOT NULL REFERENCES account_spaces(id),
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tools','thinking')),
  card_id TEXT NOT NULL CHECK (length(card_id)>0),
  ref TEXT NOT NULL CHECK (ref ~ '^[a-f0-9]{64}$'),
  run_id TEXT,
  body_json TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size=octet_length(body_json)),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id,session_id,kind,card_id,ref)
);

CREATE TABLE IF NOT EXISTS runtime_session_card_storage_mode (
  id TEXT PRIMARY KEY CHECK (id='global'),
  mode TEXT NOT NULL CHECK (mode IN ('inline','references'))
);
INSERT INTO runtime_session_card_storage_mode(id,mode) VALUES ('global','inline')
  ON CONFLICT(id) DO NOTHING;
