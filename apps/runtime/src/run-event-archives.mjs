import { createHash } from "node:crypto";
import { isDeepStrictEqual, promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";

export const EVENT_ARCHIVE_MAX_ROWS = 128;
export const EVENT_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const deltaTypes = new Set(["message.delta", "reasoning.delta"]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => typeof value === "string" ? JSON.parse(value) : value;
const invalid = () => Object.assign(new Error("Run event archive is missing or corrupt"), {
  code: "run_event_archive_corrupt"
});

export function eventProjectionHeader(event) {
  const header = Object.fromEntries(Object.entries(event).filter(([key]) =>
    key === "attemptId" || key === "type" || key === "data"));
  const data = event?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? { ...header, data: Object.fromEntries(Object.entries(data).filter(([key]) => key !== "delta")) }
    : header;
}

function matchesRow(event, row) {
  return event && deltaTypes.has(event.type)
    && event.runId === row.run_id && event.eventId === row.event_id
    && event.sequence === Number(row.sequence) && event.timestamp === Number(row.created_at)
    && isDeepStrictEqual(eventProjectionHeader(event), json(row.payload_json));
}

export async function decodeEventArchive(row) {
  try {
    if (row?.codec !== "gzip-json-v1" || !Buffer.isBuffer(row.payload_blob)
      || !Number.isInteger(Number(row.raw_bytes)) || Number(row.raw_bytes) < 1
      || Number(row.raw_bytes) > EVENT_ARCHIVE_MAX_BYTES
      || !Number.isInteger(Number(row.event_count)) || Number(row.event_count) < 1
      || Number(row.event_count) > EVENT_ARCHIVE_MAX_ROWS) throw invalid();
    const bytes = await gunzipAsync(row.payload_blob, { maxOutputLength: EVENT_ARCHIVE_MAX_BYTES });
    if (bytes.length !== Number(row.raw_bytes) || hash(bytes) !== row.archive_ref) throw invalid();
    const events = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(events) || events.length !== Number(row.event_count)
      || events.some(event => !event || !deltaTypes.has(event.type) || event.runId !== row.run_id)) throw invalid();
    return events;
  } catch {
    throw invalid();
  }
}

// One SQL statement gives event headers and distinct archive bodies the same
// MVCC snapshot, including when a Run is concurrently deleted. A batch's bytea
// is returned once, regardless of how many selected events reference it.
export function eventArchiveReadSql(predicate) {
  return `WITH selected AS MATERIALIZED (
    SELECT space_id,run_id,event_id,sequence,created_at,payload_json,archive_ref,archive_ordinal
    FROM runtime_run_events WHERE ${predicate}
  )
  SELECT 'event'::text AS row_kind,s.*,
    NULL::text AS codec,NULL::bytea AS payload_blob,NULL::int AS raw_bytes,NULL::int AS event_count
  FROM selected s
  UNION ALL
  SELECT 'archive',a.space_id,a.run_id,NULL,NULL,NULL,NULL,a.ref,NULL,
    a.codec,a.payload_blob,a.raw_bytes,a.event_count
  FROM runtime_run_event_archives a
  JOIN (SELECT DISTINCT space_id,run_id,archive_ref FROM selected WHERE archive_ref IS NOT NULL) refs
    ON a.space_id=refs.space_id AND a.run_id=refs.run_id AND a.ref=refs.archive_ref`;
}

export async function hydrateEventRows(rows) {
  const bodies = new Map();
  // Queries are owner/run-scoped. Include all identity fields in the cache key
  // so this helper also remains safe for a future multi-run reader.
  const key = row => JSON.stringify([row.space_id, row.run_id, row.archive_ref]);
  for (const row of rows) {
    if (row.row_kind === "archive") bodies.set(key(row), await decodeEventArchive(row));
  }
  const events = rows.filter(row => row.row_kind === "event")
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));
  return events.map(row => {
    if (row.archive_ref == null) return json(row.payload_json);
    const ordinal = Number(row.archive_ordinal);
    const batch = bodies.get(key(row));
    if (!Number.isInteger(ordinal) || ordinal < 0 || !batch || ordinal >= batch.length
      || !matchesRow(batch[ordinal], row)) throw invalid();
    return batch[ordinal];
  });
}

export async function createEventArchive(rows) {
  if (!rows.length || rows.length > EVENT_ARCHIVE_MAX_ROWS) throw invalid();
  const events = rows.map(row => json(row.payload_json));
  const bytes = Buffer.from(JSON.stringify(events));
  if (bytes.length > EVENT_ARCHIVE_MAX_BYTES) throw invalid();
  const archive = { archive_ref: hash(bytes), codec: "gzip-json-v1",
    payload_blob: await gzipAsync(bytes), raw_bytes: bytes.length,
    event_count: rows.length, run_id: rows[0].run_id };
  const restored = await decodeEventArchive(archive);
  if (!isDeepStrictEqual(restored, events) || rows.some((row, i) =>
    !matchesRow(restored[i], { ...row, payload_json: eventProjectionHeader(events[i]) }))) throw invalid();
  return archive;
}

const eligibleRuns = `SELECT r.space_id,r.id AS run_id FROM runtime_runs r
  JOIN LATERAL (SELECT 1 FROM runtime_run_events e
    WHERE e.space_id=r.space_id AND e.run_id=r.id AND e.archive_ref IS NULL AND e.archive_skip_reason IS NULL
      AND e.payload_json->>'type' IN ('message.delta','reasoning.delta')
    ORDER BY e.sequence LIMIT 1) pending ON true
  WHERE r.status='completed' AND r.updated_at<$1
    AND NOT EXISTS (SELECT 1 FROM runtime_run_completion_tasks t
      WHERE t.space_id=r.space_id AND t.run_id=r.id AND t.status<>'completed')`;

export async function archiveHistoricalEvents(client, {
  cutoff, cursor = null, maxRows = 128, onCandidate = () => {}, probeLimits = null
}) {
  const empty = { rewrittenRows: 0, rawBytes: 0, compressedBytes: 0 };
  const gate = await client.query(
    "SELECT pg_try_advisory_xact_lock(hashtextextended(current_schema(), 73198427)) AS acquired"
  );
  if (!gate.rows[0]?.acquired) return { ...empty, complete: false, busy: true, cursor };
  // Choose a candidate before attempting its row lock, so busy Runs advance
  // the fairness cursor instead of monopolizing an inactive owner's sweep.
  const select = `${eligibleRuns} AND ($2::text IS NULL OR (r.space_id,r.id)>($2,$3))
    ORDER BY r.space_id,r.id LIMIT 1`;
  let candidate = (await client.query(select, [cutoff, cursor?.spaceId || null, cursor?.runId || null])).rows[0];
  if (!candidate && cursor) candidate = (await client.query(select, [cutoff, null, null])).rows[0];
  if (!candidate) return { ...empty, complete: true, cursor: null };
  const nextCursor = { spaceId: candidate.space_id, runId: candidate.run_id };
  // Scan position is process-local scheduling state, not a durable data change.
  // Advance before a costly query so its transaction rollback still allows
  // another owner to progress. Failed candidates wrap around on later passes.
  onCandidate(nextCursor);
  const locked = await client.query(`${eligibleRuns}
    AND r.space_id=$2 AND r.id=$3 FOR UPDATE OF r SKIP LOCKED`,
  [cutoff, candidate.space_id, candidate.run_id]);
  if (!locked.rowCount) return { ...empty, complete: false, busy: true, cursor: nextCursor };
  const probeKey = JSON.stringify([candidate.space_id, candidate.run_id]);
  const limit = Math.max(1, Math.min(EVENT_ARCHIVE_MAX_ROWS,
    Math.floor(Number(maxRows) || 128), probeLimits?.get(probeKey) || EVENT_ARCHIVE_MAX_ROWS));
  // Fetch no more than a batch's body bytes from PostgreSQL, including when
  // legacy producers emitted a single enormous delta. Only identity metadata
  // is selected for oversized rows; their original payload remains inline.
  const selected = await client.query(`WITH candidates AS MATERIALIZED (
    SELECT sequence,octet_length(payload_json::text) AS bytes
    FROM runtime_run_events WHERE space_id=$1 AND run_id=$2 AND archive_ref IS NULL AND archive_skip_reason IS NULL
      AND payload_json->>'type' IN ('message.delta','reasoning.delta')
    ORDER BY sequence LIMIT $3
  ), sized AS (
    SELECT *,sum(CASE WHEN bytes>$4-2 THEN 0 ELSE bytes+1 END) OVER (ORDER BY sequence) AS total
    FROM candidates
  )
  SELECT e.space_id,e.run_id,e.event_id,e.sequence,e.created_at,
    CASE WHEN s.bytes<=$4-2 THEN e.payload_json END AS payload_json,s.bytes>$4-2 AS oversized
  FROM sized s JOIN runtime_run_events e ON e.space_id=$1 AND e.run_id=$2 AND e.sequence=s.sequence
  WHERE s.total<=$4-1 ORDER BY e.sequence FOR UPDATE OF e SKIP LOCKED`,
  [candidate.space_id, candidate.run_id, limit, EVENT_ARCHIVE_MAX_BYTES]).catch(error => {
    if (error?.code === "57014") probeLimits?.set(probeKey, Math.max(1, Math.floor(limit / 2)));
    // PostgreSQL has aborted this transaction; the caller must roll it back.
    throw error;
  });
  const oversized = selected.rows.filter(row => row.oversized);
  if (oversized.length) await client.query(`UPDATE runtime_run_events SET archive_skip_reason='oversized'
    WHERE space_id=$1 AND run_id=$2 AND sequence=ANY($3::int[]) AND archive_ref IS NULL`,
  [candidate.space_id, candidate.run_id, oversized.map(row => row.sequence)]);
  const rows = [];
  let rawBytes = 2; // JSON array brackets and comma separators.
  for (const row of selected.rows) {
    if (row.oversized) continue;
    const size = Buffer.byteLength(JSON.stringify(row.payload_json)) + (rows.length ? 1 : 0);
    if (rawBytes + size > EVENT_ARCHIVE_MAX_BYTES) break;
    rows.push(row);
    rawBytes += size;
  }
  if (!rows.length && oversized.length) return { ...empty, complete: false, oversizedRows: oversized.length, cursor: nextCursor };
  if (!rows.length) return { ...empty, complete: false, busy: true, cursor: nextCursor };
  const archive = await createEventArchive(rows);
  await client.query(`INSERT INTO runtime_run_event_archives
    (space_id,run_id,ref,codec,payload_blob,raw_bytes,event_count,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [candidate.space_id, candidate.run_id, archive.archive_ref, archive.codec, archive.payload_blob,
    archive.raw_bytes, archive.event_count, Date.now()]);
  const changed = await client.query(`UPDATE runtime_run_events e
    SET payload_json=u.header,archive_ref=$3,archive_ordinal=u.ordinal
    FROM (SELECT (value->>'sequence')::int AS sequence,value->'header' AS header,
      (ordinality-1)::int AS ordinal FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY) u
    WHERE e.space_id=$1 AND e.run_id=$2 AND e.sequence=u.sequence AND e.archive_ref IS NULL`,
  [candidate.space_id, candidate.run_id, archive.archive_ref,
    JSON.stringify(rows.map(row => ({ sequence: row.sequence, header: eventProjectionHeader(row.payload_json) })))]);
  if (changed.rowCount !== rows.length) throw new Error("Run event archive conversion changed concurrently");
  return { complete: false, rewrittenRows: rows.length, rawBytes: archive.raw_bytes,
    compressedBytes: archive.payload_blob.length, oversizedRows: oversized.length, cursor: nextCursor };
}

// Called with maintenance/writers stopped before an older runtime is activated.
// Each transaction restores at most one bounded batch, never reassigning IDs.
export async function restoreEventArchiveBatch(client) {
  const row = (await client.query(`SELECT *,ref AS archive_ref FROM runtime_run_event_archives
    ORDER BY space_id,run_id,ref LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
  if (!row) return { complete: true, restoredRows: 0 };
  const events = await decodeEventArchive(row);
  const headers = (await client.query(`SELECT *, 'event' AS row_kind FROM runtime_run_events
    WHERE space_id=$1 AND run_id=$2 AND archive_ref=$3 FOR UPDATE`,
  [row.space_id, row.run_id, row.ref])).rows;
  if (headers.length !== events.length) throw invalid();
  await hydrateEventRows([...headers, { ...row, row_kind: "archive" }]);
  const restored = await client.query(`UPDATE runtime_run_events e
    SET payload_json=v.event,archive_ref=NULL,archive_ordinal=NULL
    FROM (SELECT value AS event FROM jsonb_array_elements($4::jsonb)) v
    WHERE e.space_id=$1 AND e.run_id=$2 AND e.archive_ref=$3
      AND e.sequence=(v.event->>'sequence')::int`,
  [row.space_id, row.run_id, row.ref, JSON.stringify(events)]);
  if (restored.rowCount !== events.length) throw invalid();
  await client.query("DELETE FROM runtime_run_event_archives WHERE space_id=$1 AND run_id=$2 AND ref=$3",
    [row.space_id, row.run_id, row.ref]);
  return { complete: false, restoredRows: restored.rowCount };
}
