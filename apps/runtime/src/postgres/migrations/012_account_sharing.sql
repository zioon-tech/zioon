-- Sharing an account resource never creates a membership in its owner's store.
CREATE TABLE IF NOT EXISTS account_shares (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES account_users(id),
  origin_space_id TEXT NOT NULL REFERENCES account_spaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('model','skill','plugin','device','document','folder')),
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_version TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('use','viewer','editor')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  monthly_calls INTEGER CHECK (monthly_calls > 0),
  revision BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  expires_at BIGINT,
  CHECK ((kind IN ('document','folder')) = (role IN ('viewer','editor')))
);
CREATE INDEX IF NOT EXISTS account_shares_owner ON account_shares(owner_id,status);
CREATE INDEX IF NOT EXISTS account_shares_content ON account_shares(origin_space_id,source_id,kind,status);

CREATE TABLE IF NOT EXISTS account_share_invitations (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES account_shares(id),
  token_hash TEXT UNIQUE NOT NULL,
  max_claims INTEGER NOT NULL CHECK (max_claims BETWEEN 1 AND 100),
  claims INTEGER NOT NULL DEFAULT 0 CHECK (claims >= 0 AND claims <= max_claims),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_share_grants (
  share_id TEXT NOT NULL REFERENCES account_shares(id),
  user_id TEXT NOT NULL REFERENCES account_users(id),
  invitation_id TEXT NOT NULL REFERENCES account_share_invitations(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  accepted_at BIGINT NOT NULL,
  revoked_at BIGINT,
  PRIMARY KEY (share_id,user_id)
);
CREATE INDEX IF NOT EXISTS account_share_grants_received ON account_share_grants(user_id,status);

-- Once shared, a document keeps a dedicated Memory namespace even after revoke.
CREATE TABLE IF NOT EXISTS account_document_privacy (
  origin_space_id TEXT NOT NULL REFERENCES account_spaces(id),
  document_id TEXT NOT NULL,
  private BOOLEAN NOT NULL DEFAULT FALSE,
  memory_scoped BOOLEAN NOT NULL DEFAULT TRUE,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (origin_space_id,document_id)
);

-- Failed dispatches retain a conservative reservation; they are never replayed.
CREATE TABLE IF NOT EXISTS account_share_model_calls (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES account_shares(id),
  requester_id TEXT NOT NULL REFERENCES account_users(id),
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  turn_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  period_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','dispatched','settled','released','pending')),
  input_tokens BIGINT,
  output_tokens BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (share_id,run_id,attempt_id,turn_key)
);
CREATE INDEX IF NOT EXISTS account_share_model_quota ON account_share_model_calls(share_id,period_key,state);
CREATE TABLE IF NOT EXISTS account_sharing_events (
  sequence BIGSERIAL PRIMARY KEY,
  share_id TEXT REFERENCES account_shares(id),
  actor_id TEXT NOT NULL REFERENCES account_users(id),
  action TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
