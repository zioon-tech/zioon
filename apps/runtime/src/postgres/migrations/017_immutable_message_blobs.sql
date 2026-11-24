-- Immutable input arrays are shared by reference, scoped to their owning space.
-- Existing inline rows stay readable; migration does not rewrite large tables.
CREATE TABLE runtime_message_blobs (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  messages_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, ref)
);
ALTER TABLE runtime_run_inputs ADD COLUMN messages_ref TEXT;
ALTER TABLE runtime_run_inputs ADD CONSTRAINT run_inputs_message_blob
  FOREIGN KEY (space_id, messages_ref) REFERENCES runtime_message_blobs(space_id, ref);
ALTER TABLE runtime_conversation_inputs ADD COLUMN messages_ref TEXT;
ALTER TABLE runtime_conversation_inputs ADD COLUMN context_ref TEXT;
ALTER TABLE runtime_conversation_inputs ADD CONSTRAINT conversation_messages_blob
  FOREIGN KEY (space_id, messages_ref) REFERENCES runtime_message_blobs(space_id, ref);
ALTER TABLE runtime_conversation_inputs ADD CONSTRAINT conversation_context_blob
  FOREIGN KEY (space_id, context_ref) REFERENCES runtime_message_blobs(space_id, ref);
CREATE INDEX run_inputs_message_refs ON runtime_run_inputs(space_id, messages_ref);
CREATE INDEX conversation_input_message_refs ON runtime_conversation_inputs(space_id, messages_ref);
CREATE INDEX conversation_input_context_refs ON runtime_conversation_inputs(space_id, context_ref);
