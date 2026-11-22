-- Only an identity provider's explicit email_verified claim can write here.
-- Display addresses, linked identities and invitation tokens are not evidence.
CREATE TABLE IF NOT EXISTS account_verified_addresses (
  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  email TEXT NOT NULL,
  verified_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, issuer)
);
