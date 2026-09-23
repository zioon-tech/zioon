---
name: run-diagnostics
description: Query sanitized Zion Runtime facts and retrieve exact audited tool-call evidence when deeper analysis needs it.
---

# Runtime Observability

Use this Skill when historical Zion Run facts are needed. The observability
layer records and exposes evidence; analysis and conclusions remain the
model's responsibility.

## Sanitized Query

Call `observabilityQuery` with one parameterized, read-only SQL statement.
Available tables:

- `obs_runs`: Run status revisions, timestamps, duration, usage, hashed
  session/project references, and trace availability.
- `obs_events`: semantic Run events, ordering, tool name, outcome, denial type,
  stable failure code, and usage.
- `obs_stages`: optional sanitized model/tool/attempt timing from traces.

Raw prompts, messages, tool arguments, tool results, arbitrary error text, and
credentials do not exist in these tables.

Public columns:

```text
obs_runs(
  record_id, space_id, run_id, attempt_id, source_cursor, event_sequence,
  timestamp, projected_at, user_id, identity, session_ref, project_ref,
  status, created_at, updated_at, completed_at, duration_ms, terminal_reason,
  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
  cache_write_tokens, trace_id, trace_state, trace_retryable, stages_truncated
)

obs_events(
  record_id, space_id, run_id, attempt_id, source_cursor, event_sequence,
  timestamp, projected_at, type, turn, tool, ok, denial_type, failure_code,
  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
  cache_write_tokens
)

obs_stages(
  record_id, space_id, run_id, attempt_id, source_cursor, event_sequence,
  timestamp, projected_at, kind, name, status, duration_ms, first_chunk_ms,
  consumer_wait_ms, active_duration_ms, credential_ms, http_status,
  failure_code, input_tokens, output_tokens, reasoning_tokens,
  cache_read_tokens, cache_write_tokens
)
```

Timestamps are Unix epoch milliseconds. PostgreSQL boolean facts use `true`,
`false`, or `NULL`. Optional evidence is represented by `NULL`, not an empty
string.

Start with a narrow time range and explicit `LIMIT`. Examples:

```sql
SELECT run_id, status, duration_ms, terminal_reason, timestamp
FROM obs_runs
WHERE timestamp >= ? AND status IN ('failed', 'aborted', 'interrupted')
ORDER BY timestamp DESC
LIMIT 20
```

```sql
SELECT run_id, event_sequence, timestamp, tool, ok, failure_code
FROM obs_events
WHERE run_id = ? AND type IN ('tool.requested', 'tool.completed', 'tool.denied')
ORDER BY event_sequence
LIMIT 200
```

```sql
SELECT tool, failure_code, COUNT(*) AS failures
FROM obs_events
WHERE timestamp >= ? AND ok = 0
GROUP BY tool, failure_code
ORDER BY failures DESC
LIMIT 20
```

`obs_runs` contains revisions. For the latest state of each Run, select the row
with the greatest `source_cursor` for that `run_id`. Event rows are unique by
`record_id`.

Every result includes projection coverage, query duration, returned rows,
bytes, truncation, and a query hash. Keep those limits when reasoning about the
population.

## Exact Raw Evidence

When sanitized facts identify a relevant tool event but omit information
needed for analysis, call `observabilityRawRead` with:

- `run_id` from the projection;
- `event_sequence` from `obs_events`;
- only the required fields from `arguments`, `result`, `error`, and `context`;
- a truthful `purpose`.

Start without neighboring context. Follow `chunk.nextCursor` only while the
missing portion remains relevant.

Raw evidence is Space-scoped, byte-bounded, credential-redacted, and audited.
The audit records the actor Run, target call, selected fields, byte ranges,
hashes, purpose, and redaction count.

## Evidence Semantics

- The Run Ledger supplies authoritative status and event ordering.
- Trace rows describe observed timing and relationships. Missing trace rows do
  not imply zero duration.
- `pending-index`, `backend-unavailable`, `unsampled`, `no-correlation`, and
  `telemetry-disabled` describe evidence availability.
- Policy or grant denial is an authorization outcome recorded as a fact.
- `failure_code = 'unknown'` means only that no stable failure category was
  recorded. It is not a conclusion about the underlying cause.
- Shared Space members with `observability.read` can query this Space's
  sanitized facts. `session_ref` and `project_ref` are hashes, not paths or
  display names.
