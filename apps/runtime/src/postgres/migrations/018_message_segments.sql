-- Keep the complete-array identity; share immutable message bodies between
-- rounds. Existing arrays are converted by bounded maintenance after startup.
CREATE TABLE runtime_message_segments (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  message_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, ref)
);
ALTER TABLE runtime_message_blobs ALTER COLUMN messages_json DROP NOT NULL;
ALTER TABLE runtime_message_blobs ADD COLUMN segment_refs TEXT[];
ALTER TABLE runtime_message_blobs ADD CONSTRAINT message_blob_representation CHECK (
  (messages_json IS NOT NULL AND segment_refs IS NULL)
  OR (messages_json IS NULL AND segment_refs IS NOT NULL
      AND array_position(segment_refs, NULL) IS NULL)
);
CREATE INDEX message_blobs_pending_segments ON runtime_message_blobs(space_id, created_at, ref)
  WHERE segment_refs IS NULL;
CREATE INDEX run_inputs_pending_messages ON runtime_run_inputs(space_id, run_id)
  WHERE messages_ref IS NULL AND jsonb_typeof(messages_json)='array';
CREATE INDEX conversation_inputs_pending_messages ON runtime_conversation_inputs(space_id, ordinal)
  WHERE (messages_ref IS NULL AND jsonb_typeof(payload_json->'messages')='array')
    OR (context_ref IS NULL AND jsonb_typeof(payload_json->'contextMessages')='array');

CREATE FUNCTION runtime_read_message_blob(owner_space TEXT, blob_ref TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  source runtime_message_blobs%ROWTYPE;
  restored JSONB;
  found_segments BIGINT;
BEGIN
  SELECT * INTO source FROM runtime_message_blobs
    WHERE space_id=owner_space AND ref=blob_ref;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Immutable message blob is missing' USING ERRCODE='XX001';
  END IF;
  IF source.segment_refs IS NULL THEN RETURN source.messages_json; END IF;
  SELECT COALESCE(jsonb_agg(s.message_json ORDER BY item.ordinal), '[]'::jsonb), count(s.ref)
    INTO restored, found_segments
    FROM unnest(source.segment_refs) WITH ORDINALITY AS item(ref, ordinal)
    LEFT JOIN runtime_message_segments s ON s.space_id=owner_space AND s.ref=item.ref;
  IF found_segments <> cardinality(source.segment_refs) THEN
    RAISE EXCEPTION 'Immutable message segment is missing' USING ERRCODE='XX001';
  END IF;
  RETURN restored;
END;
$$;
