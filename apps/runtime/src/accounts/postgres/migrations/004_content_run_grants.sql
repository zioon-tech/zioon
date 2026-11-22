-- Document-scoped grants are part of the account store contract, including
-- services that initialize accounts without the Runtime data schema.
ALTER TABLE account_run_grants ADD COLUMN IF NOT EXISTS content_scope_json JSONB;
