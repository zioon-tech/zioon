CREATE TABLE IF NOT EXISTS account_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  PRIMARY KEY (issuer, subject)
);

CREATE TABLE IF NOT EXISTS account_spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
  created_by TEXT NOT NULL REFERENCES account_users(id),
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_memberships (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS account_one_personal_space_per_user
  ON account_spaces(created_by)
  WHERE kind = 'personal';

CREATE TABLE IF NOT EXISTS account_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  active_space_id TEXT NOT NULL REFERENCES account_spaces(id),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT
);

CREATE TABLE IF NOT EXISTS account_login_transactions (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_by TEXT NOT NULL REFERENCES account_users(id),
  expires_at BIGINT NOT NULL,
  consumed_by TEXT REFERENCES account_users(id),
  revoked_at BIGINT
);

CREATE TABLE IF NOT EXISTS account_run_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  policy_json JSONB NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('run', 'task')),
  source_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT,
  profile_id TEXT NOT NULL DEFAULT '',
  scopes_json JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS account_resource_pairings (
  pairing_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account_delegations (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES account_run_grants(id) ON DELETE CASCADE,
  binding TEXT NOT NULL,
  PRIMARY KEY (space_id, source_id)
);

CREATE TABLE IF NOT EXISTS account_audit (
  sequence BIGSERIAL PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS account_identity_user
  ON account_identities(user_id);
CREATE INDEX IF NOT EXISTS account_membership_user
  ON account_memberships(user_id, status);
CREATE INDEX IF NOT EXISTS account_session_expiry
  ON account_sessions(expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS account_session_user
  ON account_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_grant_user
  ON account_run_grants(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_grant_space
  ON account_run_grants(space_id, created_at DESC);
