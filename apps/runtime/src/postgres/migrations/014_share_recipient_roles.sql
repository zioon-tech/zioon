-- A recipient's permission is independent from the default for new invitations.
ALTER TABLE account_share_grants ALTER COLUMN invitation_id DROP NOT NULL;
ALTER TABLE account_share_grants ADD COLUMN role TEXT CHECK (role IN ('use','viewer','editor'));
UPDATE account_share_grants g SET role=s.role FROM account_shares s WHERE s.id=g.share_id;
ALTER TABLE account_share_grants ALTER COLUMN role SET NOT NULL;
ALTER TABLE account_sharing_events ADD COLUMN details_json JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS account_verified_addresses_email ON account_verified_addresses(email);
