import { createHash } from "node:crypto";
import {
  projectionRecords,
  projectionStages,
  SEMANTIC_EVENTS
} from "./projection-records.mjs";

const DAY = 86_400_000;
const TERMINAL = new Set([
  "run.completed",
  "run.failed",
  "run.aborted",
  "run.interrupted"
]);
const FORBIDDEN_SQL = new Set([
  "alter",
  "analyze",
  "begin",
  "call",
  "commit",
  "copy",
  "create",
  "delete",
  "do",
  "drop",
  "execute",
  "grant",
  "insert",
  "listen",
  "load",
  "lock",
  "notify",
  "prepare",
  "reassign",
  "refresh",
  "reindex",
  "release",
  "reset",
  "revoke",
  "rollback",
  "savepoint",
  "security",
  "set",
  "show",
  "truncate",
  "unlisten",
  "update",
  "vacuum"
]);

const bounded = (value, fallback, minimum, maximum) =>
  Math.max(minimum, Math.min(maximum, Math.floor(Number(value) || fallback)));
const contentHash = (sql) => createHash("sha256").update(sql).digest("hex");
const errorCode = (error) => String(error?.code || "projection_unavailable");

function jsonValue(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function serializedUsage(usage) {
  return [
    usage?.input ?? null,
    usage?.output ?? null,
    usage?.reasoning ?? null,
    usage?.cacheRead ?? null,
    usage?.cacheWrite ?? null
  ];
}

function sqlTokens(sql) {
  const result = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === '"') {
      index += 1;
      let value = "";
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === '"') {
          if (sql[index + 1] === '"') {
            value += '"';
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        value += sql[index++];
      }
      if (!closed) throw new Error("Unterminated quoted identifier");
      if (/^[a-z_][a-z0-9_$]*$/i.test(value)) result.push(value.toLowerCase());
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      index = sql.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      index = sql.indexOf("*/", index + 2);
      if (index < 0) throw new Error("Unterminated SQL comment");
      index += 2;
      continue;
    }
    if (character === ";") throw new Error("Only one SQL statement is allowed");
    if (/[a-z_]/i.test(character)) {
      const start = index++;
      while (index < sql.length && /[a-z0-9_$]/i.test(sql[index])) index++;
      result.push(sql.slice(start, index).toLowerCase());
      continue;
    }
    index += 1;
  }
  return result;
}

export function validatePostgresObservabilitySql(sql) {
  if (!sql || sql.length > 16 * 1024) {
    throw new Error("SQL must contain between 1 and 16384 characters");
  }
  if (sql.includes("$")) {
    throw new Error("PostgreSQL placeholders and dollar quoting are not allowed");
  }
  const words = sqlTokens(sql);
  if (!["select", "with"].includes(words[0])) {
    throw new Error("Only SELECT queries are allowed");
  }
  if (words[0] === "with" && !words.includes("select")) {
    throw new Error("WITH queries must end in SELECT");
  }
  const forbidden = words.find((word) =>
    FORBIDDEN_SQL.has(word)
    || word.startsWith("pg_")
    || word.startsWith("account_")
    || word.startsWith("runtime_")
    || word === "information_schema"
  );
  if (forbidden) throw new Error(`SQL token is not allowed: ${forbidden}`);
}

export function postgresObservabilitySql(sql) {
  let output = "";
  let index = 0;
  let parameter = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (character === "'") {
      const start = index++;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      output += sql.slice(start, index);
      continue;
    }
    if (character === '"') {
      const start = index++;
      while (index < sql.length) {
        if (sql[index] === '"') {
          if (sql[index + 1] === '"') {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      output += sql.slice(start, index);
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index + 2);
      const stop = end < 0 ? sql.length : end;
      output += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      const stop = end < 0 ? sql.length : end + 2;
      output += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (character === "?") {
      parameter += 1;
      output += `$${parameter}`;
      index += 1;
      continue;
    }
    output += character;
    index += 1;
  }
  return { sql: output, parameters: parameter };
}

export class PostgresObservabilityProjection {
  backend = "postgres";

  constructor({
    pool,
    runs,
    spaceId,
    tools = [],
    observability = null,
    retentionDays = 7,
    debounceMs = 250,
    queryTimeoutMs = 3000,
    queryMaxRows = 200,
    queryMaxBytes = 128 * 1024,
    now = () => Date.now(),
    onError = () => {}
  } = {}) {
    if (!pool?.query || !pool?.connect || !runs?.projectionPage || !spaceId) {
      throw new Error(
        "PostgreSQL observability projection requires a Pool, ledger, and Space ID"
      );
    }
    this.pool = pool;
    this.runs = runs;
    this.spaceId = String(spaceId);
    this.tools = new Set(tools);
    this.observability = observability;
    this.retentionDays = bounded(retentionDays, 7, 1, 90);
    this.debounceMs = bounded(debounceMs, 250, 25, 5000);
    this.queryTimeoutMs = bounded(queryTimeoutMs, 3000, 100, 30_000);
    this.queryMaxRows = bounded(queryMaxRows, 200, 1, 1000);
    this.queryMaxBytes = bounded(
      queryMaxBytes,
      128 * 1024,
      1024,
      1024 * 1024
    );
    this.now = now;
    this.onError = onError;
    this.timer = null;
    this.subscription = null;
    this.pending = null;
    this.dirty = false;
    this.started = false;
    this.lastFailure = null;
    this.lastPrunedAt = 0;
    this.queryRoleChecked = false;
  }

  async initialize() {
    const storedCursor = await this.transaction(
      (client) => this.meta("source_cursor", client),
      { readOnly: true, statementTimeoutMs: this.queryTimeoutMs }
    );
    const cursor = storedCursor == null
      ? await this.runs.projectionStart(this.now() - this.retentionDays * DAY)
      : Number(storedCursor);
    const anchor = storedCursor == null && cursor
      ? await this.runs.projectionAnchor(cursor) || ""
      : "";
    await this.transaction(async (client) => {
      await this.setMeta("schema_version", "1", client);
      await this.setMeta("source", "run-ledger", client);
      await this.setMeta("retention_days", this.retentionDays, client);
      if (await this.meta("source_cursor", client) == null) {
        await this.setMeta("source_cursor", cursor, client);
        await this.setMeta("source_anchor", anchor, client);
        await this.setMeta("source_resets", "0", client);
        await this.setMeta("recovery_loss", "0", client);
      }
    }, { statementTimeoutMs: this.queryTimeoutMs });
    return this;
  }

  async transaction(action, { readOnly = false, statementTimeoutMs = 0 } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
      if (statementTimeoutMs) {
        await client.query("SELECT set_config('statement_timeout', $1, true)", [
          String(statementTimeoutMs)
        ]);
      }
      await client.query(
        "SELECT set_config('zion.space_id', $1, true)",
        [this.spaceId]
      );
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

  async meta(key, client = this.pool) {
    const result = await client.query(
      `SELECT value FROM runtime_observability_meta
       WHERE space_id = $1 AND key = $2`,
      [this.spaceId, key]
    );
    return result.rows[0]?.value ?? null;
  }

  async setMeta(key, value, client = this.pool) {
    await client.query(
      `INSERT INTO runtime_observability_meta (space_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (space_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [this.spaceId, key, String(value)]
    );
  }

  async resetCursor() {
    const cursor = await this.runs.projectionStart(
      this.now() - this.retentionDays * DAY
    );
    const anchor = cursor
      ? await this.runs.projectionAnchor(cursor) || ""
      : "";
    await this.transaction(async (client) => {
      await client.query("DELETE FROM obs_runs WHERE space_id = $1", [this.spaceId]);
      await client.query("DELETE FROM obs_events WHERE space_id = $1", [this.spaceId]);
      await client.query("DELETE FROM obs_stages WHERE space_id = $1", [this.spaceId]);
      await client.query(
        "DELETE FROM runtime_observability_pending_traces WHERE space_id = $1",
        [this.spaceId]
      );
      await this.setMeta("source_cursor", cursor, client);
      await this.setMeta("source_anchor", anchor, client);
      await this.setMeta(
        "source_resets",
        Number(await this.meta("source_resets", client) || 0) + 1,
        client
      );
      await this.setMeta("recovery_loss", "1", client);
    });
  }

  async insertRun(record, client) {
    await client.query(
      `INSERT INTO obs_runs (
        space_id, record_id, run_id, attempt_id, source_cursor,
        event_sequence, timestamp, projected_at, user_id, identity,
        session_ref, project_ref, status, created_at, updated_at,
        completed_at, duration_ms, terminal_reason, input_tokens,
        output_tokens, reasoning_tokens, cache_read_tokens,
        cache_write_tokens, trace_id, trace_state, trace_retryable,
        stages_truncated
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
        $25, $26, $27
      ) ON CONFLICT (space_id, record_id) DO NOTHING`,
      [
        record.spaceId,
        record.recordId,
        record.runId,
        record.attemptId ?? null,
        record.sourceCursor,
        record.sequence ?? null,
        record.timestamp,
        record.projectedAt,
        record.userId ?? null,
        record.identity || "legacy",
        record.sessionRef ?? null,
        record.projectRef ?? null,
        record.status || "unknown",
        record.createdAt ?? null,
        record.updatedAt ?? null,
        record.completedAt ?? null,
        record.durationMs ?? null,
        record.terminalReason ?? null,
        ...serializedUsage(record.usage),
        record.trace?.traceId ?? null,
        record.trace?.state ?? null,
        record.trace?.retryable == null ? null : Number(record.trace.retryable),
        record.trace?.stagesTruncated == null
          ? null
          : Number(record.trace.stagesTruncated)
      ]
    );
  }

  async insertEvent(record, client) {
    await client.query(
      `INSERT INTO obs_events (
        space_id, record_id, run_id, attempt_id, source_cursor,
        event_sequence, timestamp, projected_at, type, turn, tool,
        ok, denial_type, failure_code, input_tokens, output_tokens,
        reasoning_tokens, cache_read_tokens, cache_write_tokens
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19
      ) ON CONFLICT (space_id, record_id) DO NOTHING`,
      [
        record.spaceId,
        record.recordId,
        record.runId,
        record.attemptId ?? null,
        record.sourceCursor,
        record.sequence ?? null,
        record.timestamp,
        record.projectedAt,
        record.type,
        record.turn ?? null,
        record.tool ?? null,
        record.ok == null ? null : Number(record.ok),
        record.denialType ?? null,
        record.failureCode ?? null,
        ...serializedUsage(record.usage)
      ]
    );
  }

  async insertStage(record, client) {
    await client.query(
      `INSERT INTO obs_stages (
        space_id, record_id, run_id, attempt_id, source_cursor,
        event_sequence, timestamp, projected_at, kind, name, status,
        duration_ms, first_chunk_ms, consumer_wait_ms, active_duration_ms,
        credential_ms, http_status, failure_code, input_tokens, output_tokens,
        reasoning_tokens, cache_read_tokens, cache_write_tokens
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
      ) ON CONFLICT (space_id, record_id) DO NOTHING`,
      [
        record.spaceId,
        record.recordId,
        record.runId,
        record.attemptId ?? null,
        record.sourceCursor,
        record.sequence ?? null,
        record.timestamp,
        record.projectedAt,
        record.kind,
        record.name ?? null,
        record.status ?? null,
        record.durationMs ?? null,
        record.firstChunkMs ?? null,
        record.consumerWaitMs ?? null,
        record.activeDurationMs ?? null,
        record.credentialMs ?? null,
        record.httpStatus ?? null,
        record.failureCode ?? null,
        ...serializedUsage(record.usage)
      ]
    );
  }

  async insert(kind, record, client) {
    if (kind === "runs") await this.insertRun(record, client);
    else if (kind === "events") await this.insertEvent(record, client);
    else if (kind === "stages") await this.insertStage(record, client);
  }

  async prune(client, force = false) {
    const now = this.now();
    if (!force && now - this.lastPrunedAt < 60_000) return;
    const cutoff = now - this.retentionDays * DAY;
    await client.query(
      "DELETE FROM obs_runs WHERE space_id = $1 AND timestamp < $2",
      [this.spaceId, cutoff]
    );
    await client.query(
      "DELETE FROM obs_events WHERE space_id = $1 AND timestamp < $2",
      [this.spaceId, cutoff]
    );
    await client.query(
      "DELETE FROM obs_stages WHERE space_id = $1 AND timestamp < $2",
      [this.spaceId, cutoff]
    );
    await client.query(
      `DELETE FROM runtime_observability_pending_traces
       WHERE space_id = $1 AND next_at < $2 AND tries >= 5`,
      [this.spaceId, cutoff]
    );
    await this.setMeta("retention_cutoff", cutoff, client);
    this.lastPrunedAt = now;
  }

  async flush() {
    if (this.pending) return this.pending;
    this.dirty = false;
    this.pending = this.flushOnce().catch(async (error) => {
      this.lastFailure = { code: errorCode(error), at: this.now() };
      try {
        this.onError(this.lastFailure);
      } catch {}
      return await this.status();
    }).finally(() => {
      this.pending = null;
      if (this.started && this.dirty) this.schedule();
    });
    return this.pending;
  }

  async flushOnce() {
    let cursor = Number(await this.meta("source_cursor") || 0);
    const anchor = await this.meta("source_anchor") || "";
    if (cursor && await this.runs.projectionAnchor(cursor) !== anchor) {
      await this.resetCursor();
      cursor = Number(await this.meta("source_cursor") || 0);
    }
    let caughtUp = false;
    for (let page = 0; page < 10; page += 1) {
      const rows = await this.runs.projectionPage(cursor, 500);
      if (!rows.length) {
        caughtUp = true;
        break;
      }
      await this.transaction(async (client) => {
        await this.prune(client);
        let filtered = 0;
        let expired = 0;
        for (const row of rows) {
          if (!SEMANTIC_EVENTS.has(row.event.type)) filtered += 1;
          else if (row.event.timestamp < this.now() - this.retentionDays * DAY) {
            expired += 1;
          } else {
            const records = projectionRecords(row, {
              spaceId: this.spaceId,
              tools: this.tools,
              now: this.now()
            });
            for (const [kind, record] of records) {
              await this.insert(kind, record, client);
              if (
                kind === "runs"
                && TERMINAL.has(row.event.type)
                && record.trace?.state === "pending-index"
              ) {
                await client.query(
                  `INSERT INTO runtime_observability_pending_traces
                   (space_id, source_cursor, record_json, tries, next_at)
                   VALUES ($1, $2, $3::jsonb, 0, $4)
                   ON CONFLICT (space_id, source_cursor) DO NOTHING`,
                  [
                    this.spaceId,
                    row.cursor,
                    JSON.stringify(record),
                    this.now() + 5000
                  ]
                );
              }
            }
          }
        }
        const last = rows.at(-1);
        cursor = last.cursor;
        await this.setMeta("source_cursor", last.cursor, client);
        await this.setMeta("source_anchor", last.anchor, client);
        await this.setMeta("source_through", last.event.timestamp, client);
        await this.setMeta(
          "filtered_events",
          Number(await this.meta("filtered_events", client) || 0) + filtered,
          client
        );
        await this.setMeta(
          "expired_events",
          Number(await this.meta("expired_events", client) || 0) + expired,
          client
        );
        await this.setMeta("projected_at", this.now(), client);
      });
      caughtUp = rows.length < 500;
      if (caughtUp) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    await this.setMeta("caught_up", caughtUp ? "1" : "0");
    if (!caughtUp) this.dirty = true;
    await this.enrichTraces();
    this.lastFailure = null;
    return await this.status();
  }

  async enrichTraces() {
    if (!this.observability?.diagnoseRun) return;
    const pending = await this.pool.query(
      `SELECT source_cursor, record_json, tries
       FROM runtime_observability_pending_traces
       WHERE space_id = $1 AND next_at <= $2
       ORDER BY next_at LIMIT 2`,
      [this.spaceId, this.now()]
    );
    for (const row of pending.rows) {
      const record = jsonValue(row.record_json, {});
      let diagnostic;
      try {
        diagnostic = await this.observability.diagnoseRun(record.runId, {
          includeLedger: false,
          includeFindings: false,
          signal: AbortSignal.timeout(5000)
        });
      } catch {
        diagnostic = { availability: "backend-unavailable" };
      }
      const state = diagnostic?.traceState?.reason
        || diagnostic?.availability
        || "telemetry-disabled";
      const stages = projectionStages(diagnostic, record, { tools: this.tools });
      const tries = Number(row.tries) + 1;
      const retry = !stages.length
        && [
          "pending-index",
          "backend-unavailable",
          "not-found",
          "trace-missing"
        ].includes(state)
        && tries < 5;
      await this.transaction(async (client) => {
        for (const stage of stages) await this.insert("stages", stage, client);
        await this.insert("runs", {
          ...record,
          recordId: `trace-state:${record.sourceCursor}:${tries}`,
          projectedAt: this.now(),
          trace: {
            traceId: record.trace?.traceId,
            state: stages.length
              ? "available"
              : [
                  "pending-index",
                  "backend-unavailable",
                  "trace-missing",
                  "unsampled",
                  "telemetry-disabled",
                  "no-correlation"
                ].includes(state) ? state : "unknown",
            retryable: retry,
            stagesTruncated: diagnostic?.truncated?.stages === true
          }
        }, client);
        if (retry) {
          await client.query(
            `UPDATE runtime_observability_pending_traces
             SET tries = $1, next_at = $2
             WHERE space_id = $3 AND source_cursor = $4`,
            [
              tries,
              this.now() + Math.min(300_000, 5000 * 2 ** tries),
              this.spaceId,
              row.source_cursor
            ]
          );
        } else {
          await client.query(
            `DELETE FROM runtime_observability_pending_traces
             WHERE space_id = $1 AND source_cursor = $2`,
            [this.spaceId, row.source_cursor]
          );
        }
      });
    }
  }

  schedule() {
    if (!this.started || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.dirty = true;
    this.subscription = this.runs.subscribeEvents?.(() => {
      this.dirty = true;
      this.schedule();
    }) || null;
    void this.flush();
  }

  async stop() {
    this.started = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.subscription?.dispose?.();
    this.subscription = null;
    await this.flush();
  }

  async status() {
    try {
      const [counts, meta] = await Promise.all([
        this.transaction(async (client) => {
          const result = await client.query(
            `SELECT
              (SELECT COUNT(*) FROM obs_runs WHERE space_id = $1) AS runs,
              (SELECT COUNT(*) FROM obs_events WHERE space_id = $1) AS events,
              (SELECT COUNT(*) FROM obs_stages WHERE space_id = $1) AS stages`,
            [this.spaceId]
          );
          return result.rows[0];
        }, { readOnly: true }),
        this.pool.query(
          `SELECT key, value FROM runtime_observability_meta
           WHERE space_id = $1`,
          [this.spaceId]
        )
      ]);
      const metadata = Object.fromEntries(
        meta.rows.map((row) => [row.key, row.value])
      );
      return {
        schemaVersion: 1,
        format: "postgresql",
        spaceId: this.spaceId,
        health: this.lastFailure
          ? { status: "degraded", ...this.lastFailure }
          : { status: "ready" },
        coverage: {
          sourceCursor: Number(metadata.source_cursor || 0),
          sourceThrough: Number(metadata.source_through || 0) || null,
          projectedAt: Number(metadata.projected_at || 0) || null,
          caughtUp: metadata.caught_up === "1",
          filteredEvents: Number(metadata.filtered_events || 0),
          expiredEvents: Number(metadata.expired_events || 0),
          sourceResets: Number(metadata.source_resets || 0),
          recoveryLoss: metadata.recovery_loss === "1"
        },
        limits: {
          retentionDays: this.retentionDays,
          queryTimeoutMs: this.queryTimeoutMs,
          queryMaxRows: this.queryMaxRows,
          queryMaxBytes: this.queryMaxBytes
        },
        counts: {
          runs: Number(counts.runs || 0),
          events: Number(counts.events || 0),
          stages: Number(counts.stages || 0)
        }
      };
    } catch (error) {
      return {
        schemaVersion: 1,
        format: "postgresql",
        spaceId: this.spaceId,
        health: {
          status: "degraded",
          code: errorCode(error),
          at: this.now()
        }
      };
    }
  }

  async assertQueryRole(client) {
    if (this.queryRoleChecked) return;
    const result = await client.query(
      `SELECT rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`
    );
    if (result.rows[0]?.rolsuper || result.rows[0]?.rolbypassrls) {
      throw new Error(
        "Observability queries require a PostgreSQL role without SUPERUSER or BYPASSRLS"
      );
    }
    this.queryRoleChecked = true;
  }

  async query({
    sql,
    params = [],
    maxRows = this.queryMaxRows,
    maxBytes = this.queryMaxBytes,
    timeoutMs = this.queryTimeoutMs
  }) {
    await this.flush();
    const sourceSql = String(sql || "").trim();
    validatePostgresObservabilitySql(sourceSql);
    if (!Array.isArray(params) || params.length > 50) {
      throw new Error("Query params must be an array with at most 50 values");
    }
    const converted = postgresObservabilitySql(sourceSql);
    if (converted.parameters !== params.length) {
      throw new Error(
        `Query parameter count mismatch: expected ${converted.parameters}, received ${params.length}`
      );
    }
    const rowLimit = bounded(maxRows, this.queryMaxRows, 1, this.queryMaxRows);
    const byteLimit = bounded(
      maxBytes,
      this.queryMaxBytes,
      1024,
      this.queryMaxBytes
    );
    const executionTimeout = bounded(
      timeoutMs,
      this.queryTimeoutMs,
      100,
      this.queryTimeoutMs
    );
    const startedAt = this.now();
    const raw = await this.transaction(async (client) => {
      await this.assertQueryRole(client);
      await client.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [String(executionTimeout)]
      );
      return await client.query(
        `SELECT * FROM (${converted.sql}) AS zion_observability_query
         LIMIT ${rowLimit + 1}`,
        params
      );
    }, { readOnly: true });
    const rows = [];
    let bytes = 0;
    let truncated = raw.rows.length > rowLimit;
    for (const row of raw.rows.slice(0, rowLimit)) {
      const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
      if (bytes + rowBytes > byteLimit) {
        truncated = true;
        break;
      }
      rows.push(row);
      bytes += rowBytes;
    }
    const projection = await this.status();
    return {
      schemaVersion: 1,
      spaceId: this.spaceId,
      queryHash: contentHash(sourceSql),
      durationMs: Math.max(0, this.now() - startedAt),
      health: projection.health,
      coverage: projection.coverage,
      columns: raw.fields.map((field) => field.name),
      rows,
      rowCount: rows.length,
      bytes,
      truncated
    };
  }
}
