CREATE INDEX IF NOT EXISTS runtime_workbench_revision_annotation_ref_idx
  ON runtime_workbench_session_revisions
  (space_id, ((meta_json->'__zionRevisionAnnotations')->>'ref'));
