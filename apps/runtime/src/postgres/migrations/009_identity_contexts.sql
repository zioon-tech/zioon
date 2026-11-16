-- Private plugin projections must not enter the shared workbench KV namespace.
CREATE TABLE runtime_identity_contexts (
  scope_key TEXT NOT NULL,
  revision TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  PRIMARY KEY (scope_key, revision)
);
CREATE TABLE runtime_identity_context_bindings (
  scope_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision TEXT,
  refresh_epoch BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_key, session_id),
  FOREIGN KEY (scope_key, revision)
    REFERENCES runtime_identity_contexts(scope_key, revision)
);
CREATE INDEX runtime_identity_context_bindings_revision
  ON runtime_identity_context_bindings(scope_key, revision);
