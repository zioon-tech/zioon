-- Object authorization is separate from Space governance. Existing IDs and
-- private account credentials stay in their original stores.
CREATE TABLE IF NOT EXISTS space_policies (
  space_id TEXT PRIMARY KEY REFERENCES account_spaces(id) ON DELETE CASCADE,
  allow_external BOOLEAN NOT NULL DEFAULT FALSE,
  allow_public BOOLEAN NOT NULL DEFAULT FALSE,
  default_binding_id TEXT,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS space_groups (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES account_users(id),
  revision BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id)
);

CREATE TABLE IF NOT EXISTS space_group_members (
  space_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, group_id, user_id),
  FOREIGN KEY (space_id, group_id) REFERENCES space_groups(space_id, id) ON DELETE CASCADE,
  FOREIGN KEY (space_id, user_id) REFERENCES account_memberships(space_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS space_documents (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES account_users(id),
  protection TEXT NOT NULL CHECK (protection IN ('restricted', 'space', 'external')),
  audience_mode TEXT NOT NULL CHECK (audience_mode IN ('specific', 'space')),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived', 'deleted')),
  acl_revision BIGINT NOT NULL DEFAULT 1 CHECK (acl_revision > 0),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id),
  CHECK (protection <> 'restricted' OR audience_mode = 'specific')
);

CREATE TABLE IF NOT EXISTS space_document_grants (
  space_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  user_id TEXT REFERENCES account_users(id) ON DELETE CASCADE,
  group_id TEXT,
  subject_type TEXT GENERATED ALWAYS AS (
    CASE WHEN user_id IS NOT NULL THEN 'user' ELSE 'group' END
  ) STORED,
  subject_id TEXT GENERATED ALWAYS AS (COALESCE(user_id, group_id)) STORED,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor', 'manager')),
  granted_by TEXT NOT NULL REFERENCES account_users(id),
  created_at BIGINT NOT NULL,
  expires_at BIGINT,
  PRIMARY KEY (space_id, document_id, subject_type, subject_id),
  FOREIGN KEY (space_id, document_id) REFERENCES space_documents(space_id, id) ON DELETE CASCADE,
  FOREIGN KEY (space_id, group_id) REFERENCES space_groups(space_id, id) ON DELETE CASCADE,
  CHECK ((user_id IS NOT NULL) <> (group_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS space_document_grants_user ON space_document_grants(user_id, space_id);
CREATE INDEX IF NOT EXISTS space_document_grants_group ON space_document_grants(space_id, group_id);

CREATE TABLE IF NOT EXISTS space_document_assets (
  space_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES account_users(id),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id,document_id,asset_id),
  FOREIGN KEY (space_id,document_id) REFERENCES space_documents(space_id,id) ON DELETE CASCADE,
  FOREIGN KEY (space_id,asset_id) REFERENCES runtime_assets(space_id,id) ON DELETE CASCADE
);

-- An invite is bound to a stable existing identity, or to an address which
-- must be independently verified at acceptance. Tokens alone are insufficient.
CREATE TABLE IF NOT EXISTS space_invitations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  recipient_id TEXT REFERENCES account_users(id),
  recipient_email TEXT,
  token_hash TEXT UNIQUE NOT NULL,
  proposed_role TEXT NOT NULL CHECK (proposed_role IN ('admin', 'member', 'viewer')),
  invited_by TEXT NOT NULL REFERENCES account_users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  accepted_by TEXT REFERENCES account_users(id),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  accepted_at BIGINT,
  CHECK ((recipient_id IS NOT NULL) <> (recipient_email IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS space_pending_identity_invite
  ON space_invitations(space_id, recipient_id) WHERE status = 'pending' AND recipient_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS space_pending_address_invite
  ON space_invitations(space_id, recipient_email) WHERE status = 'pending' AND recipient_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS space_contacts (
  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, contact_id),
  CHECK (user_id <> contact_id)
);

CREATE TABLE IF NOT EXISTS space_resource_bindings (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES account_users(id),
  origin_space_id TEXT NOT NULL REFERENCES account_spaces(id),
  origin_resource_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('model', 'skill', 'plugin', 'device')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked')),
  audience_mode TEXT NOT NULL CHECK (audience_mode IN ('space', 'specific')),
  ceiling_json JSONB NOT NULL,
  transfer_approved BOOLEAN NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  expires_at BIGINT,
  UNIQUE (space_id, id),
  CHECK (transfer_approved)
);
CREATE INDEX IF NOT EXISTS space_resource_binding_provider ON space_resource_bindings(provider_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS space_active_resource_binding
  ON space_resource_bindings(space_id, provider_id, origin_space_id, origin_resource_id, kind)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS space_binding_grants (
  space_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  user_id TEXT REFERENCES account_users(id) ON DELETE CASCADE,
  group_id TEXT,
  subject_type TEXT GENERATED ALWAYS AS (
    CASE WHEN user_id IS NOT NULL THEN 'user' ELSE 'group' END
  ) STORED,
  subject_id TEXT GENERATED ALWAYS AS (COALESCE(user_id, group_id)) STORED,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, binding_id, subject_type, subject_id),
  FOREIGN KEY (space_id, binding_id) REFERENCES space_resource_bindings(space_id, id) ON DELETE CASCADE,
  FOREIGN KEY (space_id, group_id) REFERENCES space_groups(space_id, id) ON DELETE CASCADE,
  CHECK ((user_id IS NOT NULL) <> (group_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS space_budget_periods (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  period_key TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'calls' CHECK (unit = 'calls'),
  hard_limit BIGINT CHECK (hard_limit >= 0),
  committed BIGINT NOT NULL DEFAULT 0 CHECK (committed >= 0),
  reserved BIGINT NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, scope_key, period_key, unit),
  CHECK (hard_limit IS NULL OR committed + reserved <= hard_limit)
);

CREATE TABLE IF NOT EXISTS space_usage_reservations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  binding_id TEXT,
  requester_id TEXT NOT NULL REFERENCES account_users(id),
  sponsor_id TEXT NOT NULL REFERENCES account_users(id),
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  period_key TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'calls' CHECK (unit = 'calls'),
  ceiling BIGINT NOT NULL CHECK (ceiling > 0),
  budget_keys_json JSONB NOT NULL,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatched', 'pending', 'settled', 'released')),
  actual BIGINT CHECK (actual >= 0 AND actual <= ceiling),
  receipt_id TEXT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (space_id, run_id, step_id),
  FOREIGN KEY (space_id, document_id) REFERENCES space_documents(space_id, id),
  FOREIGN KEY (space_id, binding_id) REFERENCES space_resource_bindings(space_id, id)
);
CREATE INDEX IF NOT EXISTS space_usage_pending ON space_usage_reservations(space_id, state, updated_at);

CREATE TABLE IF NOT EXISTS space_usage_ledger (
  sequence BIGSERIAL PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES space_usage_reservations(id),
  space_id TEXT NOT NULL REFERENCES account_spaces(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('reserved', 'dispatched', 'pending', 'settled', 'released', 'adjusted')),
  amount BIGINT NOT NULL,
  receipt_id TEXT,
  created_at BIGINT NOT NULL,
  UNIQUE (reservation_id, event_type, receipt_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS space_one_usage_settlement
  ON space_usage_ledger(reservation_id) WHERE event_type IN ('settled', 'released');

CREATE TABLE IF NOT EXISTS space_run_queue (
  sequence BIGSERIAL PRIMARY KEY,
  space_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  requester_id TEXT NOT NULL REFERENCES account_users(id),
  binding_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'cancelling', 'completed', 'cancelled', 'failed', 'outcome_unknown')),
  input_revision BIGINT NOT NULL,
  frozen_input_hash TEXT,
  acl_revision BIGINT NOT NULL,
  owner_instance TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (space_id, run_id),
  FOREIGN KEY (space_id, document_id) REFERENCES space_documents(space_id, id),
  FOREIGN KEY (space_id, binding_id) REFERENCES space_resource_bindings(space_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS space_one_document_writer
  ON space_run_queue(space_id, document_id)
  WHERE status IN ('running', 'cancelling', 'outcome_unknown');
CREATE INDEX IF NOT EXISTS space_document_queue_order ON space_run_queue(space_id, document_id, sequence);

CREATE TABLE IF NOT EXISTS space_knowledge_sources (
  space_id TEXT NOT NULL,
  id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  source_revision BIGINT NOT NULL,
  source_acl_revision BIGINT NOT NULL,
  title TEXT NOT NULL,
  projection_text TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  chosen_by TEXT NOT NULL REFERENCES account_users(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'review_required')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id),
  FOREIGN KEY (space_id, document_id) REFERENCES space_documents(space_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS space_publications (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  source_revision BIGINT NOT NULL,
  source_acl_revision BIGINT NOT NULL,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  published_by TEXT NOT NULL REFERENCES account_users(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT,
  FOREIGN KEY (space_id, document_id) REFERENCES space_documents(space_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS space_document_publications ON space_publications(space_id, document_id, status);

CREATE TABLE IF NOT EXISTS space_publication_assets (
  publication_id TEXT NOT NULL REFERENCES space_publications(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  content_blob BYTEA NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (publication_id, id)
);

CREATE TABLE IF NOT EXISTS space_document_comments (
  space_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES account_users(id),
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, document_id, id),
  FOREIGN KEY (space_id, document_id) REFERENCES space_documents(space_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS space_ownership_transfers (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES account_spaces(id),
  from_user_id TEXT NOT NULL REFERENCES account_users(id),
  to_user_id TEXT NOT NULL REFERENCES account_users(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  accepted_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS space_one_pending_owner_transfer
  ON space_ownership_transfers(space_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS space_authorization_outbox (
  sequence BIGSERIAL PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES account_spaces(id),
  actor_id TEXT NOT NULL REFERENCES account_users(id),
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS space_authorization_outbox_scope
  ON space_authorization_outbox(space_id, sequence);

CREATE TABLE IF NOT EXISTS space_document_transfers (
  space_id TEXT NOT NULL REFERENCES account_spaces(id),
  requester_id TEXT NOT NULL REFERENCES account_users(id),
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  document_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, requester_id, request_id),
  FOREIGN KEY (space_id, document_id) REFERENCES space_documents(space_id,id)
);

-- Legacy membership endpoints must not bypass the new object-level revocation.
CREATE OR REPLACE FUNCTION space_revoke_removed_member() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'removed' AND OLD.status <> 'removed' THEN
    DELETE FROM space_group_members WHERE space_id = NEW.space_id AND user_id = NEW.user_id;
    DELETE FROM space_document_grants WHERE space_id = NEW.space_id AND user_id = NEW.user_id;
    DELETE FROM space_binding_grants WHERE space_id = NEW.space_id AND user_id = NEW.user_id;
    UPDATE space_documents SET acl_revision = acl_revision + 1, updated_at = NEW.updated_at
      WHERE space_id = NEW.space_id;
    UPDATE space_knowledge_sources SET status = 'review_required', updated_at = NEW.updated_at
      WHERE space_id = NEW.space_id AND status = 'active';
    UPDATE space_run_queue SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancelling' END,
      updated_at = NEW.updated_at
      WHERE space_id = NEW.space_id AND requester_id = NEW.user_id AND status IN ('queued', 'running');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS space_member_revocation ON account_memberships;
CREATE TRIGGER space_member_revocation AFTER UPDATE OF status ON account_memberships
  FOR EACH ROW EXECUTE FUNCTION space_revoke_removed_member();

-- Preserve the audience of pre-existing documents while assigning an explicit
-- ACL identity. New documents enroll transactionally with their actual author.
INSERT INTO space_documents
  (space_id,id,created_by,protection,audience_mode,created_at,updated_at)
SELECT d.space_id,d.id,s.created_by,
  CASE WHEN s.kind='personal' THEN 'restricted' ELSE 'space' END,
  CASE WHEN s.kind='personal' THEN 'specific' ELSE 'space' END,
  d.updated_at,d.updated_at
FROM runtime_workbench_documents d JOIN account_spaces s ON s.id=d.space_id
ON CONFLICT DO NOTHING;
INSERT INTO space_documents
  (space_id,id,created_by,protection,audience_mode,created_at,updated_at)
SELECT d.space_id,d.id,s.created_by,
  CASE WHEN s.kind='personal' THEN 'restricted' ELSE 'space' END,
  CASE WHEN s.kind='personal' THEN 'specific' ELSE 'space' END,
  d.updated_at,d.updated_at
FROM runtime_sessions d JOIN account_spaces s ON s.id=d.space_id
ON CONFLICT DO NOTHING;
INSERT INTO space_document_grants
  (space_id,document_id,user_id,role,granted_by,created_at)
SELECT d.space_id,d.id,d.created_by,'manager',d.created_by,d.created_at
FROM space_documents d ON CONFLICT DO NOTHING;
INSERT INTO space_document_assets (space_id,document_id,asset_id,created_by,created_at)
SELECT DISTINCT d.space_id,d.id,a.id,s.created_by,d.updated_at
FROM runtime_workbench_documents d JOIN account_spaces s ON s.id=d.space_id
CROSS JOIN LATERAL regexp_matches(d.text,'zion-asset://([A-Za-z0-9_-]+)','g') AS ref
JOIN runtime_assets a ON a.space_id=d.space_id AND a.id=ref[1]
ON CONFLICT DO NOTHING;
