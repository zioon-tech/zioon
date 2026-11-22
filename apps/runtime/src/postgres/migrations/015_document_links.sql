CREATE TABLE account_document_links (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES account_users(id),
  origin_space_id TEXT NOT NULL REFERENCES account_spaces(id),
  document_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('restricted','public','disabled')),
  revision BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (origin_space_id,document_id)
);
CREATE TABLE account_document_access_requests (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES account_document_links(id),
  user_id TEXT NOT NULL REFERENCES account_users(id),
  role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  share_id TEXT REFERENCES account_shares(id),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (link_id,user_id)
);
CREATE INDEX document_requests_pending ON account_document_access_requests(link_id,status);
