ALTER TABLE account_audit
  DROP CONSTRAINT IF EXISTS account_audit_pkey;

DROP INDEX IF EXISTS account_audit_space_sequence;

ALTER TABLE account_audit
  ADD CONSTRAINT account_audit_pkey PRIMARY KEY (space_id, sequence);
