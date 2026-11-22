-- Keep the requester's identity while binding execution to an authorized document.
ALTER TABLE account_run_grants ADD COLUMN IF NOT EXISTS content_scope_json JSONB;
