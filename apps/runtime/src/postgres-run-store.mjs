import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

const SESSION_MESSAGE_COMMAND_STALE_MS = 15 * 60_000;
const DEFAULT_MODEL_REQUEST_DETAIL_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MODEL_REQUEST_DETAIL_MAX_ROWS = 2_000;
const DEFAULT_MODEL_REQUEST_DETAIL_MAX_STORED_BYTES = 256 * 1024 * 1024;
const DEFAULT_MODEL_REQUEST_DETAIL_RETENTION_MS = 30 * 24 * 60 * 60_000;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function payload(row) {
  const value = row?.payload_json;
  if (value == null) return null;
  return typeof value === "string" ? JSON.parse(value) : clone(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`
    ).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  if (typeof value === "bigint") return JSON.stringify(String(value));
  return JSON.stringify(value) ?? "null";
}

function hashJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function toolName(value) {
  const tool = value && typeof value === "object" ? value : {};
  const fn = tool.function && typeof tool.function === "object"
    ? tool.function
    : {};
  return String(fn.name || tool.name || "").trim();
}

function summarizeModelRequestEvent(event, { detailAvailable = false } = {}) {
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const requestPayload = data.payload && typeof data.payload === "object"
    ? data.payload
    : null;
  if (!requestPayload) {
    return detailAvailable ? {
      ...event,
      data: {
        ...data,
        detailAvailable: true,
        rawRunId: String(event.runId || ""),
        rawEventSequence: Number(event.sequence)
      }
    } : event;
  }
  const messages = Array.isArray(requestPayload.messages) ? requestPayload.messages : [];
  const tools = Array.isArray(requestPayload.tools) ? requestPayload.tools : [];
  const configKeys = [
    "frequency_penalty", "max_completion_tokens", "max_tokens",
    "model", "presence_penalty", "reasoning_effort", "seed", "stop", "stream",
    "temperature", "thinking", "top_p"
  ];
  const { payload: _payload, ...metadata } = data;
  return {
    ...event,
    data: {
      ...metadata,
      summaryVersion: 1,
      messageCount: messages.length,
      toolCount: tools.length,
      toolNames: Array.from(new Set(tools.map(toolName).filter(Boolean))),
      payloadBytes: Buffer.byteLength(canonicalJson(requestPayload), "utf8"),
      payloadHash: hashJson(requestPayload),
      messagesHash: hashJson(messages),
      toolsHash: hashJson(tools),
      ...(detailAvailable ? {
        detailAvailable: true,
        rawRunId: String(event.runId || ""),
        rawEventSequence: Number(event.sequence)
      } : {}),
      config: Object.fromEntries(configKeys
        .filter((key) => requestPayload[key] !== undefined)
        .map((key) => [key, requestPayload[key]]))
    }
  };
}

function receiptFromRow(row) {
  return row ? {
    invocationId: String(row.invocation_id),
    runId: String(row.run_id),
    toolName: String(row.tool_name),
    requestHash: String(row.request_hash),
    result: payload({ payload_json: row.result_json }),
    completedAt: Number(row.completed_at)
  } : null;
}

export class PostgresRunStore {
  backend = "postgres";

  constructor(pool, {
    spaceId,
    modelRequestDetailMaxBytes = DEFAULT_MODEL_REQUEST_DETAIL_MAX_BYTES,
    modelRequestDetailMaxRows = DEFAULT_MODEL_REQUEST_DETAIL_MAX_ROWS,
    modelRequestDetailMaxStoredBytes =
      DEFAULT_MODEL_REQUEST_DETAIL_MAX_STORED_BYTES,
    modelRequestDetailRetentionMs = DEFAULT_MODEL_REQUEST_DETAIL_RETENTION_MS,
    now = () => Date.now()
  }) {
    if (!pool?.query || !pool?.connect) throw new Error("PostgreSQL Run Store requires a Pool");
    if (!spaceId) throw new Error("PostgreSQL Run Store requires a Space ID");
    this.pool = pool;
    this.spaceId = String(spaceId);
    this.modelRequestDetailMaxBytes = Math.max(
      0,
      Number(modelRequestDetailMaxBytes) || 0
    );
    this.modelRequestDetailMaxRows = Math.max(
      0,
      Math.floor(Number(modelRequestDetailMaxRows) || 0)
    );
    this.modelRequestDetailMaxStoredBytes = Math.max(
      0,
      Number(modelRequestDetailMaxStoredBytes) || 0
    );
    this.modelRequestDetailRetentionMs = Math.max(
      0,
      Number(modelRequestDetailRetentionMs) || 0
    );
    this.now = now;
    this.eventListeners = new Set();
  }

  async transaction(action) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async runStorageMaintenanceBatch() {
    return {
      complete: true,
      transientEvents: { complete: true, scannedRows: 0, deletedRows: 0, cursor: 0, totalDeletedRows: 0 },
      checkpoints: { complete: true, deletedRows: 0 },
      modelRequests: { complete: true, scannedRows: 0, rewrittenRows: 0, cursor: 0 }
    };
  }

  async create(record) {
    try {
      await this.pool.query(
        `INSERT INTO runtime_runs (space_id, id, payload_json, status, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [this.spaceId, record.id, JSON.stringify(record), record.status, record.updatedAt]
      );
    } catch (error) {
      if (error?.code === "23505") throw new Error(`Run already exists: ${record.id}`);
      throw error;
    }
  }

  async append(inputEvent, patch, detailEvent = null, outbox = []) {
    if (!Array.isArray(outbox) || outbox.length > 100) throw new Error("invalid_run_outbox");
    const rawDetailEvent = detailEvent || inputEvent;
    const rawEvent = rawDetailEvent?.type === "model.request"
      && rawDetailEvent?.data?.payload
      ? JSON.stringify(rawDetailEvent)
      : "";
    const rawBytes = rawEvent ? Buffer.byteLength(rawEvent, "utf8") : 0;
    const detail = rawBytes > 0
      && rawBytes <= this.modelRequestDetailMaxBytes
      && this.modelRequestDetailMaxRows > 0
      && this.modelRequestDetailMaxStoredBytes > 0
      && this.modelRequestDetailRetentionMs > 0
      ? await gzipAsync(Buffer.from(rawEvent, "utf8"), { level: 9 })
      : null;
    const retainedDetail = detail?.length <= this.modelRequestDetailMaxStoredBytes
      ? detail
      : null;
    const event = summarizeModelRequestEvent(inputEvent, {
      detailAvailable: !!retainedDetail
    });
    await this.transaction(async (client) => {
      const currentResult = await client.query(
        `SELECT payload_json FROM runtime_runs
         WHERE space_id = $1 AND id = $2 FOR UPDATE`,
        [this.spaceId, event.runId]
      );
      const current = payload(currentResult.rows[0]);
      if (!current) throw new Error(`Run not found: ${event.runId}`);
      const previous = await client.query(
        `SELECT sequence FROM runtime_run_events
         WHERE space_id = $1 AND run_id = $2
         ORDER BY sequence DESC LIMIT 1`,
        [this.spaceId, event.runId]
      );
      const minimum = previous.rows[0] ? Number(previous.rows[0].sequence) + 1 : 1;
      if (!Number.isSafeInteger(event.sequence) || event.sequence < minimum) {
        throw new Error(
          `Run event sequence conflict: expected at least ${minimum}, received ${event.sequence}`
        );
      }
      const next = {
        ...current,
        status: event.type === "run.started" ? "running" : current.status,
        updatedAt: event.timestamp,
        ...(patch || {})
      };
      await client.query(
        `INSERT INTO runtime_run_events
         (space_id, run_id, sequence, event_id, payload_json, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          this.spaceId, event.runId, event.sequence, event.eventId,
          JSON.stringify(event), event.timestamp
        ]
      );
      if (retainedDetail) {
        await client.query(
          `INSERT INTO runtime_run_event_details
           (space_id, run_id, sequence, codec, payload_blob,
            uncompressed_bytes, compressed_bytes, created_at)
           VALUES ($1, $2, $3, 'gzip-json-v1', $4, $5, $6, $7)`,
          [
            this.spaceId,
            event.runId,
            event.sequence,
            retainedDetail,
            rawBytes,
            retainedDetail.length,
            event.timestamp
          ]
        );
        await client.query(
          `DELETE FROM runtime_run_event_details
           WHERE space_id = $1 AND created_at < $2`,
          [this.spaceId, this.now() - this.modelRequestDetailRetentionMs]
        );
        await client.query(
          `WITH ranked AS (
             SELECT run_id, sequence,
               ROW_NUMBER() OVER (
                 ORDER BY created_at DESC, run_id DESC, sequence DESC
               ) AS row_number,
               SUM(compressed_bytes) OVER (
                 ORDER BY created_at DESC, run_id DESC, sequence DESC
               ) AS retained_bytes
             FROM runtime_run_event_details
             WHERE space_id = $1
           )
           DELETE FROM runtime_run_event_details target
           USING ranked
           WHERE target.space_id = $1
             AND target.run_id = ranked.run_id
             AND target.sequence = ranked.sequence
             AND (
               ranked.row_number > $2
               OR ranked.retained_bytes > $3
             )`,
          [
            this.spaceId,
            this.modelRequestDetailMaxRows,
            this.modelRequestDetailMaxStoredBytes
          ]
        );
      }
      await client.query(
        `UPDATE runtime_runs SET payload_json = $1::jsonb, status = $2, updated_at = $3
         WHERE space_id = $4 AND id = $5`,
        [JSON.stringify(next), next.status, next.updatedAt, this.spaceId, event.runId]
      );
      for (const entry of outbox) {
        if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(entry.id || "")
          || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(entry.kind || "")
          || Buffer.byteLength(JSON.stringify(entry.payload)) > 150000) throw new Error("invalid_run_outbox");
        const inserted = await client.query(`INSERT INTO runtime_run_outbox
          (space_id,id,run_id,attempt_id,kind,payload_json,available_at,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$7) ON CONFLICT (space_id,id) DO NOTHING RETURNING id`,
        [this.spaceId, entry.id, event.runId, event.attemptId, entry.kind, entry.payload, event.timestamp]);
        if (!inserted.rowCount) {
          const prior = (await client.query(`SELECT run_id,attempt_id,kind,payload_json FROM runtime_run_outbox
            WHERE space_id=$1 AND id=$2`, [this.spaceId, entry.id])).rows[0];
          if (prior.run_id !== event.runId || prior.attempt_id !== event.attemptId
            || prior.kind !== entry.kind || hashJson(prior.payload_json) !== hashJson(entry.payload)) throw new Error("outbox_conflict");
        }
      }
      if (event.type === "run.completed") {
        await client.query(
          "DELETE FROM runtime_run_checkpoints WHERE space_id = $1 AND run_id = $2",
          [this.spaceId, event.runId]
        );
      }
    });
    for (const listener of this.eventListeners) {
      try {
        Promise.resolve(listener(event)).catch(() => {});
      } catch {}
    }
  }

  subscribeEvents(listener) {
    if (typeof listener !== "function") throw new Error("Runtime event listener must be a function");
    this.eventListeners.add(listener);
    return { dispose: () => this.eventListeners.delete(listener) };
  }

  async get(runId) {
    const result = await this.pool.query(
      "SELECT payload_json FROM runtime_runs WHERE space_id = $1 AND id = $2",
      [this.spaceId, String(runId)]
    );
    return payload(result.rows[0]);
  }

  // Goal inspectors need metadata, not every Run's prompt/output payload.
  async getGoalRunSummaries(runIds, sessionId, userId) {
    const result = await this.pool.query(
      `SELECT jsonb_build_object(
         'id', id, 'status', status, 'createdAt', payload_json->'createdAt',
         'updatedAt', updated_at, 'usage', payload_json->'usage',
         'terminalReason', left(payload_json->>'terminalReason', 1000),
         'error', left(payload_json->>'error', 1000),
         'preview', left(payload_json->>'output', 240)
       ) AS payload_json FROM runtime_runs
       WHERE space_id = $1 AND id = ANY($2::text[])
         AND payload_json->>'sessionId' = $3
         AND (payload_json->'principal'->>'userId') IS NOT DISTINCT FROM $4::text`,
      [this.spaceId, runIds.slice(0, 32).map(String), String(sessionId), userId || null]
    );
    return result.rows.map(payload);
  }

  async listRuns({ since = 0, statuses, limit = 100 } = {}) {
    const normalizedStatuses = Array.isArray(statuses)
      ? [...new Set(statuses.map(String).filter(Boolean))]
      : [];
    const result = await this.pool.query(
      `SELECT payload_json FROM runtime_runs
       WHERE space_id = $1 AND updated_at >= $2
         AND ($3::text[] IS NULL OR status = ANY($3::text[]))
       ORDER BY updated_at DESC, id DESC LIMIT $4`,
      [
        this.spaceId,
        Math.max(0, Number(since) || 0),
        normalizedStatuses.length ? normalizedStatuses : null,
        Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)))
      ]
    );
    return result.rows.map(payload);
  }

  async getEvents(runId, afterSequence = 0) {
    const result = await this.pool.query(
      `SELECT payload_json FROM runtime_run_events
       WHERE space_id = $1 AND run_id = $2 AND sequence > $3
       ORDER BY sequence`,
      [this.spaceId, String(runId), Number(afterSequence) || 0]
    );
    return result.rows.map(payload);
  }

  async getRunForSpace(runId, spaceId) {
    if (String(spaceId) !== this.spaceId) return null;
    return this.get(runId);
  }

  async getEventsForSpace(runId, spaceId, {
    fromSequence = 1,
    toSequence = Number.MAX_SAFE_INTEGER
  } = {}) {
    if (String(spaceId) !== this.spaceId) return [];
    const result = await this.pool.query(
      `SELECT payload_json FROM runtime_run_events
       WHERE space_id = $1 AND run_id = $2 AND sequence BETWEEN $3 AND $4
       ORDER BY sequence`,
      [
        this.spaceId,
        String(runId),
        Math.max(1, Number(fromSequence) || 1),
        Math.max(1, Number(toSequence) || Number.MAX_SAFE_INTEGER)
      ]
    );
    return result.rows.map(payload);
  }

  async getToolCallEventsForSpace(runId, attemptId, callId, spaceId) {
    if (String(spaceId) !== this.spaceId) return [];
    const result = await this.pool.query(
      `SELECT payload_json FROM runtime_run_events
       WHERE space_id = $1 AND run_id = $2
         AND payload_json->>'attemptId' = $3
         AND payload_json->'data'->>'callId' = $4
         AND payload_json->>'type' = ANY($5::text[])
       ORDER BY sequence LIMIT 3`,
      [
        this.spaceId,
        String(runId),
        String(attemptId),
        String(callId),
        ["tool.requested", "tool.completed", "tool.denied"]
      ]
    );
    return result.rows.map(payload);
  }

  async getToolRequestIndexForSpace(runId, attemptId, turn, sequence, spaceId) {
    if (String(spaceId) !== this.spaceId) return 0;
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM runtime_run_events
       WHERE space_id = $1 AND run_id = $2 AND sequence < $3
         AND payload_json->>'attemptId' = $4
         AND payload_json->>'type' = 'tool.requested'
         AND (payload_json->'data'->>'turn')::int = $5`,
      [this.spaceId, String(runId), Number(sequence), String(attemptId), Number(turn)]
    );
    return Number(result.rows[0]?.count || 0);
  }

  async projectionAnchor(cursor) {
    const result = await this.pool.query(
      "SELECT event_id FROM runtime_run_events WHERE space_id = $1 AND cursor = $2",
      [this.spaceId, Number(cursor)]
    );
    return result.rows[0]?.event_id || null;
  }

  async projectionStart(since) {
    const result = await this.pool.query(
      `SELECT COALESCE(MIN(cursor), 1)::bigint - 1 AS position
       FROM runtime_run_events WHERE space_id = $1 AND created_at >= $2`,
      [this.spaceId, Number(since)]
    );
    return Number(result.rows[0]?.position || 0);
  }

  async projectionPage(after, limit = 500) {
    const result = await this.pool.query(
      `SELECT e.cursor, e.event_id AS anchor,
         jsonb_build_object(
           'runId', e.run_id,
           'sequence', e.sequence,
           'attemptId', e.payload_json->'attemptId',
           'timestamp', e.created_at,
           'type', e.payload_json->'type',
           'data', jsonb_build_object(
             'turn', e.payload_json->'data'->'turn',
             'name', e.payload_json->'data'->'name',
             'ok', e.payload_json->'data'->'ok',
             'denialType', e.payload_json->'data'->'denialType',
             'failureCode', e.payload_json->'data'->'failureCode',
             'usage', e.payload_json->'data'->'usage'
           )
         ) AS event_json,
         jsonb_build_object(
           'status', r.status,
           'createdAt', r.payload_json->'createdAt',
           'updatedAt', r.updated_at,
           'completedAt', r.payload_json->'completedAt',
           'sessionId', r.payload_json->'sessionId',
           'projectId', r.payload_json->'projectId',
           'userId', r.payload_json->'principal'->'userId',
           'terminalReason', r.payload_json->'terminalReason',
           'traceId', r.payload_json->'metadata'->'zionTelemetry'->'traceId',
           'traceFlags', r.payload_json->'metadata'->'zionTelemetry'->'traceFlags',
           'usage', r.payload_json->'usage'
         ) AS run_json
       FROM runtime_run_events e
       JOIN runtime_runs r ON r.space_id = e.space_id AND r.id = e.run_id
       WHERE e.space_id = $1 AND e.cursor > $2
       ORDER BY e.cursor LIMIT $3`,
      [
        this.spaceId,
        Number(after) || 0,
        Math.max(1, Math.min(1000, Number(limit) || 500))
      ]
    );
    return result.rows.map((row) => ({
      cursor: Number(row.cursor),
      anchor: row.anchor,
      event: payload({ payload_json: row.event_json }),
      run: payload({ payload_json: row.run_json })
    }));
  }

  async getEvent(runId, sequence) {
    const result = await this.pool.query(
      `SELECT event.payload_json, detail.codec, detail.payload_blob
       FROM runtime_run_events event
       LEFT JOIN runtime_run_event_details detail
         ON detail.space_id = event.space_id
        AND detail.run_id = event.run_id
        AND detail.sequence = event.sequence
       WHERE event.space_id = $1 AND event.run_id = $2 AND event.sequence = $3`,
      [this.spaceId, String(runId), Number(sequence)]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.codec === "gzip-json-v1" && row.payload_blob) {
      try {
        return JSON.parse((await gunzipAsync(row.payload_blob)).toString("utf8"));
      } catch {
        // Keep the summary readable if one diagnostic detail is corrupted.
      }
    }
    return payload(row);
  }

  async appendTranscript(entry) {
    const result = await this.pool.query(
      `INSERT INTO runtime_run_transcript
       (space_id, run_id, turn, ordinal, message_id, payload_json, created_at)
       SELECT $1, $2, $3, $4, $5, $6::jsonb, $7
       WHERE EXISTS (
         SELECT 1 FROM runtime_runs WHERE space_id = $1 AND id = $2
       )
       ON CONFLICT (space_id, run_id, turn, ordinal) DO UPDATE SET
         message_id = EXCLUDED.message_id,
         payload_json = EXCLUDED.payload_json,
         created_at = EXCLUDED.created_at
       RETURNING run_id`,
      [
        this.spaceId, entry.runId, entry.turn, entry.ordinal, entry.id,
        JSON.stringify(entry), entry.createdAt
      ]
    );
    if (!result.rowCount) throw new Error(`Run not found: ${entry.runId}`);
  }

  async getTranscript(runId) {
    const result = await this.pool.query(
      `SELECT payload_json FROM runtime_run_transcript
       WHERE space_id = $1 AND run_id = $2 ORDER BY turn, ordinal`,
      [this.spaceId, String(runId)]
    );
    return result.rows.map(payload);
  }

  async saveCheckpoint(checkpoint) {
    await this.transaction(async (client) => {
      const run = await client.query(
        `SELECT status FROM runtime_runs
         WHERE space_id = $1 AND id = $2 FOR UPDATE`,
        [this.spaceId, checkpoint.runId]
      );
      if (!run.rowCount) throw new Error(`Run not found: ${checkpoint.runId}`);
      if (run.rows[0].status === "completed") {
        throw new Error(`Cannot save a checkpoint for completed Run: ${checkpoint.runId}`);
      }
      const current = await client.query(
        `SELECT sequence FROM runtime_run_checkpoints
         WHERE space_id = $1 AND run_id = $2
         ORDER BY sequence DESC LIMIT 1`,
        [this.spaceId, checkpoint.runId]
      );
      if (current.rows[0] && checkpoint.sequence < Number(current.rows[0].sequence)) {
        throw new Error(
          `Checkpoint sequence conflict: current ${current.rows[0].sequence}, received ${checkpoint.sequence}`
        );
      }
      await client.query(
        `INSERT INTO runtime_run_checkpoints
         (space_id, run_id, sequence, attempt_id, payload_json, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (space_id, run_id, sequence) DO UPDATE SET
           attempt_id = EXCLUDED.attempt_id,
           payload_json = EXCLUDED.payload_json,
           created_at = EXCLUDED.created_at`,
        [
          this.spaceId, checkpoint.runId, checkpoint.sequence, checkpoint.attemptId,
          JSON.stringify(checkpoint), checkpoint.createdAt
        ]
      );
      await client.query(
        `DELETE FROM runtime_run_checkpoints
         WHERE space_id = $1 AND run_id = $2 AND sequence <> $3`,
        [this.spaceId, checkpoint.runId, checkpoint.sequence]
      );
    });
  }

  async getLatestCheckpoint(runId) {
    const result = await this.pool.query(
      `SELECT payload_json FROM runtime_run_checkpoints
       WHERE space_id = $1 AND run_id = $2
       ORDER BY sequence DESC LIMIT 1`,
      [this.spaceId, String(runId)]
    );
    return payload(result.rows[0]);
  }

  async createSession(record) {
    try {
      await this.pool.query(
        `INSERT INTO runtime_sessions (space_id, id, payload_json, status, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [this.spaceId, record.id, JSON.stringify(record), record.status, record.updatedAt]
      );
    } catch (error) {
      if (error?.code === "23505") throw new Error(`Session already exists: ${record.id}`);
      throw error;
    }
  }

  async getSession(sessionId) {
    const result = await this.pool.query(
      "SELECT payload_json FROM runtime_sessions WHERE space_id = $1 AND id = $2",
      [this.spaceId, String(sessionId)]
    );
    return payload(result.rows[0]);
  }

  async getActiveRunForSession(sessionId) {
    const result = await this.pool.query(
      `SELECT payload_json FROM runtime_runs
       WHERE space_id = $1 AND status = ANY($2::text[])
         AND payload_json->>'sessionId' = $3
       ORDER BY updated_at DESC LIMIT 1`,
      [this.spaceId, ["queued", "running"], String(sessionId)]
    );
    return payload(result.rows[0]);
  }

  async updateSession(sessionId, patch = {}, updatedAt = Date.now()) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `SELECT payload_json FROM runtime_sessions
         WHERE space_id = $1 AND id = $2 FOR UPDATE`,
        [this.spaceId, String(sessionId)]
      );
      const current = payload(result.rows[0]);
      if (!current) throw new Error(`Session not found: ${sessionId}`);
      const input = clone(patch);
      const session = {
        ...current,
        ...input,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: Math.max(
          Number(current.updatedAt) || 0,
          Number(updatedAt) || Date.now()
        )
      };
      await client.query(
        `UPDATE runtime_sessions
         SET payload_json = $1::jsonb, status = $2, updated_at = $3
         WHERE space_id = $4 AND id = $5`,
        [JSON.stringify(session), session.status, session.updatedAt, this.spaceId, session.id]
      );
      return session;
    });
  }

  async getSessionMessageCommand(sessionId, clientRequestId, client = this.pool) {
    const result = await client.query(
      `SELECT status, response_json, created_at, updated_at
       FROM runtime_session_message_commands
       WHERE space_id = $1 AND session_id = $2 AND client_request_id = $3`,
      [this.spaceId, String(sessionId), String(clientRequestId)]
    );
    const row = result.rows[0];
    return row ? {
      sessionId: String(sessionId),
      clientRequestId: String(clientRequestId),
      status: String(row.status),
      response: row.response_json == null
        ? null
        : payload({ payload_json: row.response_json }),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    } : null;
  }

  async reserveSessionMessageCommand(sessionId, clientRequestId, createdAt = Date.now()) {
    return this.transaction(async (client) => {
      await client.query(
        `DELETE FROM runtime_session_message_commands
         WHERE space_id = $1 AND status = 'submitting' AND updated_at < $2`,
        [this.spaceId, Number(createdAt) - SESSION_MESSAGE_COMMAND_STALE_MS]
      );
      const inserted = await client.query(
        `INSERT INTO runtime_session_message_commands
         (space_id, session_id, client_request_id, status, response_json, created_at, updated_at)
         VALUES ($1, $2, $3, 'submitting', NULL, $4, $4)
         ON CONFLICT (space_id, session_id, client_request_id) DO NOTHING
         RETURNING session_id`,
        [this.spaceId, String(sessionId), String(clientRequestId), Number(createdAt)]
      );
      return {
        reserved: inserted.rowCount === 1,
        command: await this.getSessionMessageCommand(sessionId, clientRequestId, client)
      };
    });
  }

  async completeSessionMessageCommand(
    sessionId,
    clientRequestId,
    response,
    updatedAt = Date.now()
  ) {
    await this.pool.query(
      `UPDATE runtime_session_message_commands
       SET status = 'accepted', response_json = $1::jsonb, updated_at = $2
       WHERE space_id = $3 AND session_id = $4 AND client_request_id = $5`,
      [
        JSON.stringify(response), Number(updatedAt), this.spaceId,
        String(sessionId), String(clientRequestId)
      ]
    );
    return this.getSessionMessageCommand(sessionId, clientRequestId);
  }

  async releaseSessionMessageCommand(sessionId, clientRequestId) {
    await this.pool.query(
      `DELETE FROM runtime_session_message_commands
       WHERE space_id = $1 AND session_id = $2 AND client_request_id = $3
         AND status = 'submitting'`,
      [this.spaceId, String(sessionId), String(clientRequestId)]
    );
  }

  async listSessions({ limit = 100, offset = 0 } = {}) {
    const result = await this.pool.query(
      `SELECT payload_json FROM runtime_sessions
       WHERE space_id = $1
       ORDER BY updated_at DESC, id LIMIT $2 OFFSET $3`,
      [
        this.spaceId,
        Math.min(500, Math.max(1, Number(limit) || 100)),
        Math.max(0, Number(offset) || 0)
      ]
    );
    return result.rows.map(payload);
  }

  async saveSessionSeedTranscript(sessionId, messages, createdAt = Date.now()) {
    if (!Array.isArray(messages) || !messages.length) return [];
    return this.transaction(async (client) => {
      const session = await client.query(
        `SELECT id FROM runtime_sessions
         WHERE space_id = $1 AND id = $2 FOR UPDATE`,
        [this.spaceId, String(sessionId)]
      );
      if (!session.rowCount) throw new Error(`Session not found: ${sessionId}`);
      const existing = await client.query(
        `SELECT 1 FROM runtime_session_seed_transcript
         WHERE space_id = $1 AND session_id = $2 LIMIT 1`,
        [this.spaceId, String(sessionId)]
      );
      if (!existing.rowCount) {
        for (let index = 0; index < messages.length; index += 1) {
          const message = {
            ...clone(messages[index]),
            schemaVersion: 1,
            id: `seed:${sessionId}:${index + 1}`,
            sessionId: String(sessionId),
            createdAt: Number(createdAt)
          };
          await client.query(
            `INSERT INTO runtime_session_seed_transcript
             (space_id, session_id, ordinal, payload_json, created_at)
             VALUES ($1, $2, $3, $4::jsonb, $5)`,
            [
              this.spaceId, String(sessionId), index + 1,
              JSON.stringify(message), Number(createdAt)
            ]
          );
        }
      }
      return this.getSessionSeedTranscript(sessionId, client);
    });
  }

  async getSessionSeedTranscript(sessionId, client = this.pool) {
    const result = await client.query(
      `SELECT payload_json FROM runtime_session_seed_transcript
       WHERE space_id = $1 AND session_id = $2 ORDER BY ordinal`,
      [this.spaceId, String(sessionId)]
    );
    return result.rows.map(payload);
  }

  async forkSession(sourceSessionId, {
    id,
    title,
    createdAt = Date.now(),
    createId = () => `message_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  } = {}) {
    const source = await this.getSession(sourceSessionId);
    if (!source) throw new Error(`Session not found: ${sourceSessionId}`);
    const targetId = String(id || "").trim();
    if (!targetId) throw new Error("Forked Session id is required");
    const sourceSeedTranscript = await this.getSessionSeedTranscript(sourceSessionId);
    const sourceMessages = await this.getSessionMessages(sourceSessionId);
    const sourceTranscript = await this.getSessionTranscript(sourceSessionId);
    const session = {
      ...source,
      id: targetId,
      status: "active",
      title: String(title || `${source.title || "Session"} (fork)`),
      metadata: {
        ...(source.metadata || {}),
        forkedFrom: {
          sessionId: sourceSessionId,
          transcriptSequence: sourceTranscript.at(-1)?.sequence || 0,
          forkedAt: createdAt
        }
      },
      createdAt,
      updatedAt: createdAt
    };
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO runtime_sessions (space_id, id, payload_json, status, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [this.spaceId, targetId, JSON.stringify(session), session.status, session.updatedAt]
      );
      for (let index = 0; index < sourceSeedTranscript.length; index += 1) {
        const message = {
          ...sourceSeedTranscript[index],
          id: `seed:${targetId}:${index + 1}`,
          sessionId: targetId
        };
        await client.query(
          `INSERT INTO runtime_session_seed_transcript
           (space_id, session_id, ordinal, payload_json, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [
            this.spaceId, targetId, index + 1,
            JSON.stringify(message), Number(message.createdAt || createdAt)
          ]
        );
      }
      for (const sourceMessage of sourceMessages) {
        const message = {
          ...sourceMessage,
          id: createId("message"),
          sessionId: targetId
        };
        await client.query(
          `INSERT INTO runtime_session_messages
           (space_id, session_id, sequence, message_id, run_id, role, payload_json, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
          [
            this.spaceId, targetId, message.sequence, message.id, message.runId,
            message.role, JSON.stringify(message), message.createdAt
          ]
        );
      }
    });
    return {
      session,
      copiedSeedTranscriptEntries: sourceSeedTranscript.length,
      copiedMessages: sourceMessages.length,
      copiedTranscriptEntries: sourceTranscript.length
    };
  }

  async getSessionMessages(sessionId, afterSequence = 0) {
    const result = await this.pool.query(
      `SELECT payload_json FROM runtime_session_messages
       WHERE space_id = $1 AND session_id = $2 AND sequence > $3
       ORDER BY sequence`,
      [this.spaceId, String(sessionId), Number(afterSequence) || 0]
    );
    return result.rows.map(payload);
  }

  async getSessionTranscript(sessionId, afterSequence = 0) {
    const messages = await this.getSessionMessages(sessionId);
    const canonical = [];
    let sequence = 0;
    for (const entry of await this.getSessionSeedTranscript(sessionId)) {
      canonical.push({ ...entry, schemaVersion: 1, sessionId, sequence: ++sequence });
    }
    for (const userMessage of messages.filter((message) => message.role === "user")) {
      const { canonicalContent, ...displayUserMessage } = userMessage;
      canonical.push({
        ...displayUserMessage,
        content: canonicalContent ?? userMessage.content,
        schemaVersion: 1,
        sequence: ++sequence
      });
      const assistantMessage = messages.find((message) =>
        message.runId === userMessage.runId && message.role === "assistant"
      );
      if (!assistantMessage) continue;
      const transcript = await this.getTranscript(userMessage.runId);
      if (transcript.length) {
        for (const entry of transcript) {
          canonical.push({ ...entry, sessionId, sequence: ++sequence });
        }
      } else {
        canonical.push({ ...assistantMessage, schemaVersion: 1, sequence: ++sequence });
      }
    }
    return canonical.filter((message) => message.sequence > afterSequence);
  }

  async appendSessionMessages(sessionId, messages) {
    if (!Array.isArray(messages) || !messages.length) return [];
    return this.transaction(async (client) => {
      const sessionResult = await client.query(
        `SELECT payload_json FROM runtime_sessions
         WHERE space_id = $1 AND id = $2 FOR UPDATE`,
        [this.spaceId, String(sessionId)]
      );
      const session = payload(sessionResult.rows[0]);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      const sequenceResult = await client.query(
        `SELECT COALESCE(MAX(sequence), 0)::int AS sequence
         FROM runtime_session_messages WHERE space_id = $1 AND session_id = $2`,
        [this.spaceId, String(sessionId)]
      );
      let sequence = Number(sequenceResult.rows[0].sequence || 0);
      let updatedAt = Number(session.updatedAt) || 0;
      const stored = [];
      for (const input of messages) {
        if (input.sessionId !== sessionId) {
          throw new Error(`Session message belongs to another Session: ${input.id}`);
        }
        if (!["user", "assistant"].includes(input.role)) {
          throw new Error(`Unsupported Session message role: ${input.role}`);
        }
        const existing = await client.query(
          `SELECT payload_json FROM runtime_session_messages
           WHERE space_id = $1 AND session_id = $2 AND run_id = $3 AND role = $4`,
          [this.spaceId, sessionId, input.runId, input.role]
        );
        if (existing.rowCount) {
          stored.push(payload(existing.rows[0]));
          continue;
        }
        const message = {
          ...clone(input),
          schemaVersion: 1,
          sessionId,
          sequence: ++sequence,
          content: String(input.content || "")
        };
        await client.query(
          `INSERT INTO runtime_session_messages
           (space_id, session_id, sequence, message_id, run_id, role, payload_json, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
          [
            this.spaceId, sessionId, message.sequence, message.id, message.runId,
            message.role, JSON.stringify(message), message.createdAt
          ]
        );
        stored.push(message);
        updatedAt = Math.max(updatedAt, Number(message.createdAt) || 0);
      }
      const updated = { ...session, updatedAt };
      await client.query(
        `UPDATE runtime_sessions SET payload_json = $1::jsonb, status = $2, updated_at = $3
         WHERE space_id = $4 AND id = $5`,
        [JSON.stringify(updated), updated.status, updatedAt, this.spaceId, sessionId]
      );
      return stored;
    });
  }

  async reconcileCompletedSessionMessages({
    now = () => Date.now(),
    createId = () => `message_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  } = {}) {
    const result = await this.pool.query(
      `SELECT payload_json FROM runtime_runs
       WHERE space_id = $1 AND status = 'completed' ORDER BY updated_at`,
      [this.spaceId]
    );
    const projected = [];
    for (const row of result.rows) {
      const run = payload(row);
      if (!run.sessionId || typeof run.output !== "string") continue;
      const messages = await this.getSessionMessages(run.sessionId);
      if (!messages.some((message) => message.runId === run.id && message.role === "user")) continue;
      if (messages.some((message) => message.runId === run.id && message.role === "assistant")) continue;
      const [message] = await this.appendSessionMessages(run.sessionId, [{
        schemaVersion: 1,
        id: createId("message"),
        sessionId: run.sessionId,
        role: "assistant",
        content: run.output,
        runId: run.id,
        createdAt: run.completedAt || now()
      }]);
      projected.push(message);
    }
    return projected;
  }

  async reconcileActiveRuns({
    reason = "runtime-restart",
    now = () => Date.now(),
    createId = () => `event_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  } = {}) {
    const interrupted = [];
    await this.transaction(async (client) => {
      const result = await client.query(
        `SELECT payload_json FROM runtime_runs
         WHERE space_id = $1 AND status = ANY($2::text[])
         ORDER BY updated_at FOR UPDATE`,
        [this.spaceId, ["queued", "running"]]
      );
      for (const row of result.rows) {
        const run = payload(row);
        const sequenceResult = await client.query(
          `SELECT COALESCE(MAX(sequence), 0)::int AS sequence
           FROM runtime_run_events WHERE space_id = $1 AND run_id = $2`,
          [this.spaceId, run.id]
        );
        const timestamp = now();
        const event = {
          schemaVersion: 1,
          eventId: createId("event"),
          runId: run.id,
          attemptId: run.attemptId,
          sequence: Number(sequenceResult.rows[0].sequence || 0) + 1,
          type: "run.interrupted",
          timestamp,
          data: { reason }
        };
        const next = {
          ...run,
          status: "interrupted",
          updatedAt: timestamp,
          completedAt: timestamp,
          terminalReason: reason,
          error: "Run interrupted because no live Runtime owner is available"
        };
        await client.query(
          `INSERT INTO runtime_run_events
           (space_id, run_id, sequence, event_id, payload_json, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [
            this.spaceId, run.id, event.sequence, event.eventId,
            JSON.stringify(event), timestamp
          ]
        );
        await client.query(
          `UPDATE runtime_runs SET payload_json = $1::jsonb, status = $2, updated_at = $3
           WHERE space_id = $4 AND id = $5`,
          [JSON.stringify(next), next.status, timestamp, this.spaceId, run.id]
        );
        interrupted.push(next);
      }
    });
    return interrupted;
  }

  async getToolReceipt(invocationId) {
    const result = await this.pool.query(
      `SELECT invocation_id, run_id, tool_name, request_hash, result_json, completed_at
       FROM runtime_tool_invocation_receipts
       WHERE space_id = $1 AND invocation_id = $2`,
      [this.spaceId, String(invocationId)]
    );
    return receiptFromRow(result.rows[0]);
  }

  async getToolReceiptForSpace(invocationId, runId, spaceId) {
    if (String(spaceId) !== this.spaceId) return null;
    const receipt = await this.getToolReceipt(invocationId);
    return receipt?.runId === String(runId) ? receipt : null;
  }

  async findToolReceiptByRequestHash(runId, toolName, requestHash) {
    const result = await this.pool.query(
      `SELECT invocation_id, run_id, tool_name, request_hash, result_json, completed_at
       FROM runtime_tool_invocation_receipts
       WHERE space_id = $1 AND run_id = $2 AND tool_name = $3
         AND request_hash = $4
       ORDER BY completed_at DESC
       LIMIT 1`,
      [
        this.spaceId,
        String(runId),
        String(toolName),
        String(requestHash)
      ]
    );
    return receiptFromRow(result.rows[0]);
  }

  async saveToolReceipt({
    invocationId,
    runId,
    toolName,
    requestHash,
    result,
    completedAt = Date.now()
  }) {
    const inserted = await this.pool.query(
      `INSERT INTO runtime_tool_invocation_receipts
       (space_id, invocation_id, run_id, tool_name, request_hash, result_json, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (space_id, invocation_id) DO NOTHING
       RETURNING invocation_id`,
      [
        this.spaceId, String(invocationId), String(runId), String(toolName),
        String(requestHash), JSON.stringify(result), Number(completedAt)
      ]
    );
    const receipt = await this.getToolReceipt(invocationId);
    if (!receipt) throw new Error(`Tool receipt was not persisted: ${invocationId}`);
    return { ...receipt, duplicate: inserted.rowCount === 0 };
  }

  async countToolReceipts(runId = "", toolName = "") {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM runtime_tool_invocation_receipts
       WHERE space_id = $1
         AND ($2 = '' OR run_id = $2)
         AND ($3 = '' OR tool_name = $3)`,
      [this.spaceId, String(runId), String(toolName)]
    );
    return Number(result.rows[0].count);
  }

  async saveRunArtifacts({ runId, invocationId, artifacts = [], changes = [] }) {
    await this.transaction(async (client) => {
      for (const artifact of artifacts) {
        await client.query(
          `INSERT INTO runtime_artifacts
           (space_id, artifact_id, run_id, invocation_id, payload_json, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           ON CONFLICT (space_id, artifact_id) DO UPDATE SET
             payload_json = EXCLUDED.payload_json, created_at = EXCLUDED.created_at`,
          [
            this.spaceId, String(artifact.id), String(runId), String(invocationId),
            JSON.stringify(artifact), Number(artifact.createdAt || Date.now())
          ]
        );
      }
      for (const change of changes) {
        await client.query(
          `INSERT INTO runtime_change_sets
           (space_id, change_id, artifact_id, run_id, invocation_id, payload_json, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
           ON CONFLICT (space_id, change_id) DO UPDATE SET
             payload_json = EXCLUDED.payload_json, created_at = EXCLUDED.created_at`,
          [
            this.spaceId, String(change.id), String(change.artifactId),
            String(runId), String(invocationId), JSON.stringify(change),
            Number(change.createdAt || Date.now())
          ]
        );
      }
    });
    return this.listRunArtifacts(runId);
  }

  async listRunArtifacts(runId) {
    const [artifacts, changes] = await Promise.all([
      this.pool.query(
        `SELECT payload_json FROM runtime_artifacts
         WHERE space_id = $1 AND run_id = $2 ORDER BY created_at, artifact_id`,
        [this.spaceId, String(runId)]
      ),
      this.pool.query(
        `SELECT payload_json FROM runtime_change_sets
         WHERE space_id = $1 AND run_id = $2 ORDER BY created_at, change_id`,
        [this.spaceId, String(runId)]
      )
    ]);
    return {
      runId: String(runId),
      artifacts: artifacts.rows.map(payload),
      changes: changes.rows.map(payload)
    };
  }

  async listSessionArtifacts(sessionId) {
    const result = await this.pool.query(
      `SELECT DISTINCT run_id FROM runtime_session_messages
       WHERE space_id = $1 AND session_id = $2 ORDER BY run_id`,
      [this.spaceId, String(sessionId)]
    );
    const artifacts = [];
    const changes = [];
    for (const row of result.rows) {
      const values = await this.listRunArtifacts(row.run_id);
      artifacts.push(...values.artifacts);
      changes.push(...values.changes);
    }
    return { sessionId: String(sessionId), artifacts, changes };
  }

  async saveTodoList(ownerId, todos, updatedAt = Date.now(), metadata = {}) {
    const taskId = String(metadata?.taskId || "").trim();
    const sessionId = String(metadata?.sessionId || "").trim();
    const runId = String(metadata?.runId || "").trim();
    const value = {
      ownerId: String(ownerId),
      ...(taskId ? { taskId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      todos: Array.isArray(todos) ? todos : [],
      updatedAt: Number(updatedAt)
    };
    await this.pool.query(
      `INSERT INTO runtime_todo_lists (space_id, owner_id, payload_json, updated_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (space_id, owner_id) DO UPDATE SET
         payload_json = EXCLUDED.payload_json, updated_at = EXCLUDED.updated_at`,
      [this.spaceId, value.ownerId, JSON.stringify(value), value.updatedAt]
    );
    return value;
  }

  async getTodoList(ownerId) {
    const result = await this.pool.query(
      `SELECT payload_json FROM runtime_todo_lists
       WHERE space_id = $1 AND owner_id = $2`,
      [this.spaceId, String(ownerId)]
    );
    return payload(result.rows[0]);
  }

  async listTodoLists({ limit = 100, updatedAfter = 0 } = {}) {
    const result = await this.pool.query(
      `SELECT payload_json FROM runtime_todo_lists
       WHERE space_id = $1 AND updated_at > $2
       ORDER BY updated_at DESC LIMIT $3`,
      [
        this.spaceId,
        Math.max(0, Math.floor(Number(updatedAfter) || 0)),
        Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)))
      ]
    );
    return result.rows.map(payload);
  }

  async close() {
    this.eventListeners.clear();
  }
}
