-- Admission uses constant-size counters. Retention never sorts an account's
-- diagnostics while its model event holds a Run lock.
-- Old writers do not know about these counters. Hold the DML lock from the
-- initial measurement until the tracking trigger becomes visible at commit.
LOCK TABLE runtime_run_event_details IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE runtime_model_detail_usage (
  scope_key TEXT PRIMARY KEY,
  stored_rows BIGINT NOT NULL CHECK (stored_rows >= 0),
  stored_bytes BIGINT NOT NULL CHECK (stored_bytes >= 0)
);
INSERT INTO runtime_model_detail_usage
  SELECT 'global', count(*), COALESCE(sum(compressed_bytes),0)
  FROM runtime_run_event_details;
INSERT INTO runtime_model_detail_usage
  SELECT 'space:' || space_id, count(*), COALESCE(sum(compressed_bytes),0)
  FROM runtime_run_event_details GROUP BY space_id;
CREATE INDEX runtime_model_details_global_created
  ON runtime_run_event_details(created_at,space_id,run_id,sequence);

CREATE FUNCTION runtime_track_model_detail_usage() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO runtime_model_detail_usage VALUES ('global',1,NEW.compressed_bytes)
      ON CONFLICT (scope_key) DO UPDATE SET
        stored_rows=runtime_model_detail_usage.stored_rows+1,
        stored_bytes=runtime_model_detail_usage.stored_bytes+NEW.compressed_bytes;
    INSERT INTO runtime_model_detail_usage VALUES ('space:' || NEW.space_id,1,NEW.compressed_bytes)
      ON CONFLICT (scope_key) DO UPDATE SET
        stored_rows=runtime_model_detail_usage.stored_rows+1,
        stored_bytes=runtime_model_detail_usage.stored_bytes+NEW.compressed_bytes;
  ELSE
    UPDATE runtime_model_detail_usage SET stored_rows=stored_rows-1,stored_bytes=stored_bytes-OLD.compressed_bytes
      WHERE scope_key='global';
    UPDATE runtime_model_detail_usage SET stored_rows=stored_rows-1,stored_bytes=stored_bytes-OLD.compressed_bytes
      WHERE scope_key='space:' || OLD.space_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER runtime_model_detail_usage_changed
  AFTER INSERT OR DELETE ON runtime_run_event_details
  FOR EACH ROW EXECUTE FUNCTION runtime_track_model_detail_usage();

CREATE FUNCTION runtime_capture_model_detail(
  owner_space TEXT, owner_run TEXT, event_sequence INTEGER, body BYTEA,
  raw_bytes BIGINT, event_created BIGINT, space_rows BIGINT, space_bytes BIGINT,
  global_rows BIGINT, global_bytes BIGINT
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  total runtime_model_detail_usage%ROWTYPE;
  owned runtime_model_detail_usage%ROWTYPE;
  body_bytes BIGINT := octet_length(body);
BEGIN
  -- Diagnostics are optional. A busy maintenance/capture gate must never hold
  -- up model execution, or admit data using a stale capacity measurement.
  SELECT * INTO total FROM runtime_model_detail_usage WHERE scope_key='global' FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  SELECT * INTO owned FROM runtime_model_detail_usage WHERE scope_key='space:' || owner_space;
  IF total.stored_rows+1>global_rows OR total.stored_bytes+body_bytes>global_bytes
    OR COALESCE(owned.stored_rows,0)+1>space_rows
    OR COALESCE(owned.stored_bytes,0)+body_bytes>space_bytes THEN RETURN FALSE; END IF;
  INSERT INTO runtime_run_event_details
    (space_id,run_id,sequence,codec,payload_blob,uncompressed_bytes,compressed_bytes,created_at)
    VALUES (owner_space,owner_run,event_sequence,'gzip-json-v1',body,raw_bytes,body_bytes,event_created);
  RETURN TRUE;
END;
$$;
