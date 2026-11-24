import { createHash } from "node:crypto";
import { isDeepStrictEqual, promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";

export const RECEIPT_BODY_MIN_BYTES = 512;
export const RECEIPT_BODY_MAX_BYTES = 16 * 1024 * 1024;
export const RECEIPT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const tables = new Set(["runtime_invocation_receipts", "runtime_tool_invocation_receipts"]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const copy = value => JSON.parse(JSON.stringify(value));
const invalid = () => Object.assign(new Error("Invocation receipt body is missing or corrupt"), {
  code: "receipt_body_corrupt"
});
const tableName = table => {
  if (!tables.has(table)) throw new Error("Invalid receipt table");
  return table;
};

// Normalize through JSON first, preserving the existing JSONB write contract.
// Sorting object keys makes logically identical results share one body.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function receiptResultHeader(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) =>
      ["ok", "failureCode", "retryable"].includes(key)))
    : {};
}

export async function encodeReceiptBody(result) {
  const value = copy(result);
  const bytes = Buffer.from(canonicalJson(value));
  if (bytes.length < RECEIPT_BODY_MIN_BYTES) return { value, skipReason: "small" };
  if (bytes.length > RECEIPT_BODY_MAX_BYTES) return { value, skipReason: "oversized" };
  const header = receiptResultHeader(value);
  const blob = await gzipAsync(bytes);
  if (blob.length + Buffer.byteLength(JSON.stringify(header)) + 192 > bytes.length * 0.8) {
    return { value, skipReason: "no-benefit" };
  }
  return { value, header, body: {
    ref: hash(bytes), codec: "gzip-json-v1", payload_blob: blob, raw_bytes: bytes.length
  } };
}

export async function decodeReceiptBody(row) {
  try {
    const size = Number(row?.raw_bytes);
    if (row?.codec !== "gzip-json-v1" || !Buffer.isBuffer(row.payload_blob)
      || !Number.isInteger(size) || size < RECEIPT_BODY_MIN_BYTES
      || size > RECEIPT_BODY_MAX_BYTES) throw invalid();
    const bytes = await gunzipAsync(row.payload_blob, { maxOutputLength: RECEIPT_BODY_MAX_BYTES });
    if (bytes.length !== size || hash(bytes) !== row.ref) throw invalid();
    const value = JSON.parse(bytes.toString("utf8"));
    if (canonicalJson(value) !== bytes.toString("utf8")) throw invalid();
    return value;
  } catch {
    throw invalid();
  }
}

// Selected headers and each distinct owner/body are transferred once, from
// one MVCC snapshot. JSONB scalar strings remain values, not JSON source text.
export function receiptReadSql(selection) {
  return `WITH selected AS MATERIALIZED (${selection})
    SELECT 'receipt'::text AS row_kind,to_jsonb(s) AS receipt_json,
      s.space_id,NULL::text AS ref,NULL::text AS codec,NULL::bytea AS payload_blob,NULL::int AS raw_bytes
    FROM selected s
    UNION ALL
    SELECT 'body',NULL,b.space_id,b.ref,b.codec,b.payload_blob,b.raw_bytes
    FROM runtime_receipt_bodies b
    JOIN (SELECT DISTINCT space_id,result_ref FROM selected WHERE result_ref IS NOT NULL) refs
      ON b.space_id=refs.space_id AND b.ref=refs.result_ref`;
}

export async function hydrateReceiptRows(rows) {
  const bodies = new Map();
  const key = (spaceId, ref) => JSON.stringify([spaceId, ref]);
  for (const row of rows) {
    if (row.row_kind === "body") {
      bodies.set(key(row.space_id, row.ref), await decodeReceiptBody(row));
    }
  }
  return rows.filter(row => row.row_kind === "receipt").map(({ receipt_json: row }) => {
    let value = row.result_json;
    if (row.result_ref != null) {
      const bodyKey = key(row.space_id, row.result_ref);
      if (!bodies.has(bodyKey)) throw invalid();
      value = bodies.get(bodyKey);
      if (!isDeepStrictEqual(receiptResultHeader(value), row.result_json)) throw invalid();
    }
    return { ...row, result_json: copy(value) };
  });
}

// Call only after the invocation identity INSERT has won, in that transaction.
// The losing writer never creates a body; failure rolls back both records.
export async function storeReceiptBody(client, table, spaceId, invocationId, result, prepared = null) {
  tableName(table);
  const encoded = prepared || await encodeReceiptBody(result);
  if (encoded.body) {
    const b = encoded.body;
    const inserted = await client.query(`INSERT INTO runtime_receipt_bodies
      (space_id,ref,codec,payload_blob,raw_bytes,created_at)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (space_id,ref) DO NOTHING`,
    [spaceId, b.ref, b.codec, b.payload_blob, b.raw_bytes, Date.now()]);
    if (!inserted.rowCount) {
      const existing = (await client.query(`SELECT * FROM runtime_receipt_bodies
        WHERE space_id=$1 AND ref=$2`, [spaceId, b.ref])).rows[0];
      if (!isDeepStrictEqual(await decodeReceiptBody(existing), encoded.value)) throw invalid();
    }
    await client.query(`UPDATE ${table} SET result_json=$3::jsonb,result_ref=$4,result_skip_reason=NULL
      WHERE space_id=$1 AND invocation_id=$2`,
    [spaceId, invocationId, JSON.stringify(encoded.header), b.ref]);
  } else {
    await client.query(`UPDATE ${table} SET result_skip_reason=$3
      WHERE space_id=$1 AND invocation_id=$2`,
    [spaceId, invocationId, encoded.skipReason]);
  }
  return encoded;
}

export const receiptPendingPredicate = `result_ref IS NULL AND result_skip_reason IS NULL
  AND octet_length(result_json::text)>=${RECEIPT_BODY_MIN_BYTES}`;

export class PostgresReceiptMaintenanceStore {
  constructor(pool, { storageHeadroom = null, minimumFreeBytes = 3 * 1024 ** 3 } = {}) {
    this.pool = pool;
    this.tableCursor = 0;
    this.ownerCursors = new Map();
    this.probeLimits = new Map();
    this.maintenanceName = "receipt-bodies";
    this.maintenanceStats = null;
    this.storageHeadroom = storageHeadroom;
    this.minimumFreeBytes = minimumFreeBytes;
  }

  async runStorageMaintenanceBatch({ maxRows = 32 } = {}) {
    if (this.storageHeadroom) {
      const availableBytes = await this.storageHeadroom();
      if (!Number.isFinite(availableBytes) || availableBytes < this.minimumFreeBytes) {
        this.maintenanceStats = { ...this.maintenanceStats, phase: "headroom",
          availableBytes, minimumFreeBytes: this.minimumFreeBytes, lastDeferredAt: Date.now() };
        return { complete: false, receipts: { rewrittenRows: 0, deferred: "disk-headroom" } };
      }
    }
    const table = [...tables][this.tableCursor++ % tables.size];
    const cursor = this.ownerCursors.get(table);
    const client = await this.pool.connect();
    const startedAt = Date.now();
    let phase = "gate";
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='500ms'");
      await client.query("SET LOCAL statement_timeout='2000ms'");
      const gate = await client.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended(current_schema(),73198428)) AS acquired");
      if (!gate.rows[0]?.acquired) {
        await client.query("COMMIT");
        return { complete: false, receipts: { busy: true, rewrittenRows: 0 } };
      }
      phase = "candidate";
      const select = after => `SELECT space_id FROM ${table} WHERE ${receiptPendingPredicate}
        ${after ? "AND space_id>$1" : ""} ORDER BY space_id,invocation_id LIMIT 1`;
      let candidate = (await client.query(select(!!cursor), cursor ? [cursor] : [])).rows[0];
      if (!candidate && cursor) candidate = (await client.query(select(false))).rows[0];
      if (!candidate) {
        this.ownerCursors.delete(table);
        await client.query("COMMIT");
        // Both tables must have completed an empty pass before sleeping.
        this.emptyTables ||= new Set();
        this.emptyTables.add(table);
        return { complete: this.emptyTables.size === tables.size, receipts: { rewrittenRows: 0 } };
      }
      this.emptyTables?.delete(table);
      this.ownerCursors.set(table, candidate.space_id);
      const probeKey = JSON.stringify([table, candidate.space_id]);
      const limit = Math.max(1, Math.min(32, Math.floor(Number(maxRows) || 32),
        this.probeLimits.get(probeKey) || 32));
      phase = "select";
      const selected = await client.query(`WITH candidates AS MATERIALIZED (
        SELECT invocation_id,octet_length(result_json::text) AS bytes
        FROM ${table} WHERE space_id=$1 AND ${receiptPendingPredicate}
        ORDER BY invocation_id LIMIT $2
      ), sized AS (
        SELECT *,row_number() OVER (ORDER BY invocation_id) AS ordinal,
          sum(CASE WHEN bytes>$3 THEN 0 ELSE bytes END) OVER (ORDER BY invocation_id) AS total
        FROM candidates
      )
      SELECT r.invocation_id,s.bytes,
        CASE WHEN s.bytes<=$3 THEN r.result_json END AS result_json
      FROM sized s JOIN ${table} r ON r.space_id=$1 AND r.invocation_id=s.invocation_id
      WHERE s.total<=$4 OR s.ordinal=1 ORDER BY r.invocation_id FOR UPDATE OF r SKIP LOCKED`,
      [candidate.space_id, limit, RECEIPT_BODY_MAX_BYTES, 2 * 1024 * 1024]).catch(error => {
        if (error?.code === "57014") {
          this.probeLimits.set(probeKey, Math.max(1, Math.floor(limit / 2)));
          if (this.probeLimits.size > 256) this.probeLimits.delete(this.probeLimits.keys().next().value);
        }
        throw error;
      });
      phase = "encode";
      let rewrittenRows = 0, skippedRows = 0, rawBytes = 0, compressedBytes = 0;
      for (const row of selected.rows) {
        if (Number(row.bytes) > RECEIPT_BODY_MAX_BYTES) {
          await client.query(`UPDATE ${table} SET result_skip_reason='oversized'
            WHERE space_id=$1 AND invocation_id=$2`, [candidate.space_id, row.invocation_id]);
          skippedRows++;
          continue;
        }
        const encoded = await storeReceiptBody(client, table, candidate.space_id, row.invocation_id, row.result_json);
        if (encoded.body) {
          rewrittenRows++;
          rawBytes += encoded.body.raw_bytes;
          compressedBytes += encoded.body.payload_blob.length;
        } else skippedRows++;
      }
      phase = "commit";
      await client.query("COMMIT");
      const receipts = { rewrittenRows, skippedRows, rawBytes, compressedBytes };
      this.maintenanceStats = { ...receipts, table, phase: "complete", elapsedMs: Date.now() - startedAt,
        lastCompletedAt: Date.now(), totalRewrittenRows: (this.maintenanceStats?.totalRewrittenRows || 0) + rewrittenRows,
        totalRawBytes: (this.maintenanceStats?.totalRawBytes || 0) + rawBytes,
        totalCompressedBytes: (this.maintenanceStats?.totalCompressedBytes || 0) + compressedBytes,
        failures: this.maintenanceStats?.failures || 0 };
      return { complete: false, receipts };
    } catch (error) {
      await client.query("ROLLBACK");
      this.maintenanceStats = { ...this.maintenanceStats, table, phase, elapsedMs: Date.now() - startedAt,
        lastFailedAt: Date.now(), errorCode: String(error?.code || "unknown"),
        failures: (this.maintenanceStats?.failures || 0) + 1 };
      error.maintenancePhase = phase;
      throw error;
    } finally {
      client.release();
    }
  }
}

// Writers and maintenance must be stopped before an older reader activates.
// Restore at most maxRows references per transaction. Bodies remain until both
// tables have no references; the FK protects all still-referenced results.
export async function restoreReceiptBodyBatch(client, { maxRows = 32 } = {}) {
  await client.query("SET LOCAL lock_timeout='500ms'");
  await client.query("SET LOCAL statement_timeout='5000ms'");
  for (const table of tables) {
    const selected = await client.query(receiptReadSql(`WITH candidates AS MATERIALIZED (
      SELECT r.space_id,r.invocation_id,r.result_ref,COALESCE(b.raw_bytes,0) AS bytes FROM ${table} r
      LEFT JOIN runtime_receipt_bodies b ON b.space_id=r.space_id AND b.ref=r.result_ref
      WHERE r.result_ref IS NOT NULL ORDER BY r.space_id,r.result_ref,r.invocation_id LIMIT $1
    ), sized AS (
      SELECT *,row_number() OVER (ORDER BY space_id,result_ref,invocation_id) AS ordinal,
        sum(bytes) OVER (ORDER BY space_id,result_ref,invocation_id) AS total FROM candidates
    ) SELECT r.* FROM sized s JOIN ${table} r
      ON r.space_id=s.space_id AND r.invocation_id=s.invocation_id
      WHERE s.total<=2097152 OR s.ordinal=1 ORDER BY r.space_id,r.invocation_id FOR UPDATE OF r`),
    [Math.max(1, Math.min(32, Math.floor(Number(maxRows) || 32)))]);
    const receipts = await hydrateReceiptRows(selected.rows);
    if (!receipts.length) continue;
    for (const row of receipts) await client.query(`UPDATE ${table}
      SET result_json=$3::jsonb,result_ref=NULL,result_skip_reason=NULL
      WHERE space_id=$1 AND invocation_id=$2`,
    [row.space_id, row.invocation_id, JSON.stringify(row.result_json)]);
    return { complete: false, restoredRows: receipts.length };
  }
  const removed = await client.query(`WITH selected AS (
    SELECT space_id,ref FROM runtime_receipt_bodies ORDER BY space_id,ref LIMIT 128
  ) DELETE FROM runtime_receipt_bodies b USING selected s WHERE b.space_id=s.space_id AND b.ref=s.ref`);
  return { complete: removed.rowCount === 0, restoredRows: 0, removedBodies: removed.rowCount };
}
