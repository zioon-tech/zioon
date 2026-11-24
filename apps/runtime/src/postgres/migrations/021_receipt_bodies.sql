CREATE TABLE IF NOT EXISTS runtime_receipt_bodies (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  codec TEXT NOT NULL CHECK (codec = 'gzip-json-v1'),
  payload_blob BYTEA NOT NULL,
  raw_bytes INTEGER NOT NULL CHECK (raw_bytes BETWEEN 512 AND 16777216),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, ref)
);

ALTER TABLE runtime_invocation_receipts
  ADD COLUMN IF NOT EXISTS result_ref TEXT,
  ADD COLUMN IF NOT EXISTS result_skip_reason TEXT;
ALTER TABLE runtime_tool_invocation_receipts
  ADD COLUMN IF NOT EXISTS result_ref TEXT,
  ADD COLUMN IF NOT EXISTS result_skip_reason TEXT;
ALTER TABLE runtime_invocation_receipts ADD CONSTRAINT runtime_invocation_receipt_body_fk
  FOREIGN KEY (space_id,result_ref) REFERENCES runtime_receipt_bodies(space_id,ref) NOT VALID;
ALTER TABLE runtime_tool_invocation_receipts ADD CONSTRAINT runtime_tool_receipt_body_fk
  FOREIGN KEY (space_id,result_ref) REFERENCES runtime_receipt_bodies(space_id,ref) NOT VALID;

-- Production builds these concurrently before recording this migration.
-- Tiny legacy results never enter the sweep and are never rewritten.
CREATE INDEX IF NOT EXISTS runtime_invocation_receipts_body_pending
  ON runtime_invocation_receipts(space_id,invocation_id)
  WHERE result_ref IS NULL AND result_skip_reason IS NULL AND octet_length(result_json::text)>=512;
CREATE INDEX IF NOT EXISTS runtime_tool_receipts_body_pending
  ON runtime_tool_invocation_receipts(space_id,invocation_id)
  WHERE result_ref IS NULL AND result_skip_reason IS NULL AND octet_length(result_json::text)>=512;

-- Sparse rollback selection and FK body-deletion checks must not repeatedly
-- scan an owner's inline history. One ordering supports both operations.
CREATE INDEX IF NOT EXISTS runtime_invocation_receipts_body_refs
  ON runtime_invocation_receipts(space_id,result_ref,invocation_id)
  WHERE result_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS runtime_tool_receipts_body_refs
  ON runtime_tool_invocation_receipts(space_id,result_ref,invocation_id)
  WHERE result_ref IS NOT NULL;
