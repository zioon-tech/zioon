import { randomUUID } from "node:crypto";

export const WEBHOOK_EVENT_TYPES = Object.freeze([
  "run.started", "run.waiting", "run.resumed", "run.completed", "run.failed",
  "run.aborted", "run.interrupted", "run.finalized",
  "tool.requested", "tool.completed", "tool.denied",
  "hook.started", "hook.completed", "hook.failed"
]);
const factKeys = [
  "turn", "name", "callId", "ok", "status", "denialType", "failureCode",
  "controllerId", "stage", "action", "durationMs", "failurePolicy", "usage"
];
const bounded = (value, limit = 100) => Math.max(1, Math.min(limit, Math.floor(Number(value) || limit)));
const subscription = (row) => row && ({
  id: row.id, endpoint: row.endpoint, secretRef: row.secret_ref,
  eventTypes: row.event_types, enabled: row.enabled,
  createdBy: row.created_by, createdAt: Number(row.created_at)
});
const delivery = (row) => ({
  id: row.id, subscriptionId: row.subscription_id, eventId: row.event_id,
  status: row.status, attempts: row.attempts, replayCount: row.replay_count,
  availableAt: Number(row.available_at), lastHttpStatus: row.last_http_status,
  lastFailureCode: row.last_failure_code, createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at)
});

/** Webhooks expose facts and stable references, never prompts, tool input, grants or raw errors. */
export function webhookEnvelope(spaceId, event, run) {
  const data = Object.fromEntries(factKeys.filter((key) => event.data?.[key] !== undefined)
    .map((key) => [key, typeof event.data[key] === "string" ? event.data[key].slice(0, 256) : event.data[key]]));
  if (event.type === "run.waiting" && event.data?.waiting) {
    const { id, controllerId, stage, createdAt } = event.data.waiting;
    data.waiting = { id, controllerId, stage, createdAt };
  }
  return {
    schemaVersion: 1, eventId: event.eventId, type: event.type,
    spaceId, runId: event.runId, attemptId: event.attemptId,
    sequence: event.sequence, timestamp: event.timestamp,
    sessionId: typeof run?.sessionId === "string" && run.sessionId.length <= 1024 ? run.sessionId : null,
    projectId: typeof run?.projectId === "string" && run.projectId.length <= 1024 ? run.projectId : null, data
  };
}

export class PostgresWebhookStore {
  constructor(pool, { spaceId, now = Date.now }) {
    if (!pool?.connect || !spaceId) throw new Error("Webhook store requires PostgreSQL and a Space");
    this.pool = pool;
    this.spaceId = String(spaceId);
    this.now = now;
  }

  async transaction(action) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async create({ endpoint, secretRef, eventTypes }, actorId) {
    if (!Array.isArray(eventTypes) || !eventTypes.length
      || eventTypes.some((type) => !WEBHOOK_EVENT_TYPES.includes(type))) {
      throw Object.assign(new Error("Unsupported webhook event types"), { statusCode: 400 });
    }
    return this.transaction(async (client) => {
      // Serialize administrative changes only; event appends never take this lock.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`webhooks:${this.spaceId}`]);
      const count = await client.query("SELECT count(*)::int AS n FROM runtime_webhook_subscriptions WHERE space_id=$1", [this.spaceId]);
      if (count.rows[0].n >= 100) throw Object.assign(new Error("Webhook subscription limit reached"), { statusCode: 409 });
      const result = await client.query(
        `INSERT INTO runtime_webhook_subscriptions
         (space_id,id,endpoint,secret_ref,event_types,created_by,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [this.spaceId, `wh_${randomUUID()}`, endpoint, secretRef, [...new Set(eventTypes)], actorId, this.now()]
      );
      return subscription(result.rows[0]);
    });
  }

  async list() {
    const result = await this.pool.query("SELECT * FROM runtime_webhook_subscriptions WHERE space_id=$1 ORDER BY created_at,id", [this.spaceId]);
    return result.rows.map(subscription);
  }

  async get(id) {
    const result = await this.pool.query(
      "SELECT * FROM runtime_webhook_subscriptions WHERE space_id=$1 AND id=$2", [this.spaceId, id]
    );
    return subscription(result.rows[0]);
  }

  async subscriptionForDelivery(id) {
    const result = await this.pool.query(
      `SELECT s.* FROM runtime_webhook_subscriptions s JOIN runtime_webhook_deliveries d
       ON s.space_id=d.space_id AND s.id=d.subscription_id WHERE d.space_id=$1 AND d.id=$2`,
      [this.spaceId, id]
    );
    return subscription(result.rows[0]);
  }

  async setEnabled(id, enabled) {
    if (typeof enabled !== "boolean") throw Object.assign(new Error("enabled must be boolean"), { statusCode: 400 });
    const result = await this.pool.query(
      "UPDATE runtime_webhook_subscriptions SET enabled=$3 WHERE space_id=$1 AND id=$2 RETURNING *",
      [this.spaceId, id, enabled]
    );
    return subscription(result.rows[0]);
  }

  /** Called with the RunStore's client, before its transaction commits. */
  async enqueue(client, event, run) {
    // attempt.started is the durable resume fact; retain its event identity.
    if (event.type === "attempt.started") event = { ...event, type: "run.resumed" };
    if (!WEBHOOK_EVENT_TYPES.includes(event.type)) return;
    const matching = await client.query(
      "SELECT id FROM runtime_webhook_subscriptions WHERE space_id=$1 AND enabled AND $2=ANY(event_types)",
      [this.spaceId, event.type]
    );
    if (!matching.rowCount) return;
    const envelope = JSON.stringify(webhookEnvelope(this.spaceId, event, run));
    if (Buffer.byteLength(envelope) > 32 * 1024) throw new Error("Webhook facts exceed 32 KiB");
    await client.query(
      `INSERT INTO runtime_webhook_deliveries
       (space_id,id,subscription_id,event_id,payload_json,available_at,created_at,updated_at)
       SELECT space_id, 'whd_' || md5(id || ':' || $2), id, $2, $3::jsonb, $4,$4,$4
       FROM runtime_webhook_subscriptions
       WHERE space_id=$1 AND enabled AND $5=ANY(event_types)
       ON CONFLICT (space_id,subscription_id,event_id) DO NOTHING`,
      [this.spaceId, event.eventId, envelope, this.now(), event.type]
    );
  }

  async claim({ limit = 4, leaseMs = 30_000 } = {}) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `WITH due AS (
          SELECT d.id FROM runtime_webhook_deliveries d
          JOIN runtime_webhook_subscriptions s ON s.space_id=d.space_id AND s.id=d.subscription_id
          WHERE d.space_id=$1 AND s.enabled AND
            ((d.status='pending' AND d.available_at <= $2) OR
             (d.status='delivering' AND d.lease_until <= $2))
          ORDER BY d.available_at,d.created_at,d.id
          FOR UPDATE OF d SKIP LOCKED LIMIT $3
        )
        UPDATE runtime_webhook_deliveries d SET status='delivering',
          attempts=d.attempts+1,lease_token=$4,lease_until=$5,updated_at=$2
        FROM due WHERE d.space_id=$1 AND d.id=due.id
        RETURNING d.*`,
        [this.spaceId, this.now(), bounded(limit, 16), randomUUID(), this.now() + leaseMs]
      );
      const subscriptions = await client.query(
        "SELECT * FROM runtime_webhook_subscriptions WHERE space_id=$1 AND id=ANY($2::text[])",
        [this.spaceId, result.rows.map((row) => row.subscription_id)]
      );
      const endpoints = new Map(subscriptions.rows.map((row) => [row.id, subscription(row)]));
      return result.rows.map((row) => ({
        ...delivery(row), payload: row.payload_json, leaseToken: row.lease_token,
        subscription: endpoints.get(row.subscription_id)
      }));
    });
  }

  async finish(job, { status, httpStatus = null, failureCode = null, retryAt = this.now() }) {
    const result = await this.pool.query(
      `UPDATE runtime_webhook_deliveries SET status=$4,last_http_status=$5,last_failure_code=$6,
        available_at=$7,lease_token=NULL,lease_until=NULL,updated_at=$8
       WHERE space_id=$1 AND id=$2 AND lease_token=$3 AND status='delivering'`,
      [this.spaceId, job.id, job.leaseToken, status, httpStatus, failureCode, retryAt, this.now()]
    );
    return result.rowCount === 1;
  }

  async deliveries({ subscriptionId = null, before = null, limit = 100 } = {}) {
    const result = await this.pool.query(
      `SELECT * FROM runtime_webhook_deliveries WHERE space_id=$1
       AND ($2::text IS NULL OR subscription_id=$2) AND ($3::text IS NULL OR id<$3)
       ORDER BY id DESC LIMIT $4`, [this.spaceId, subscriptionId, before, bounded(limit)]
    );
    return result.rows.map(delivery);
  }

  async replay(id, { actorId, reason }) {
    if (typeof reason !== "string" || !reason.trim() || reason.length > 500) {
      throw Object.assign(new Error("Replay requires a reason of at most 500 characters"), { statusCode: 400 });
    }
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE runtime_webhook_deliveries SET status='pending',attempts=0,
         replay_count=replay_count+1,available_at=$3,updated_at=$3
         WHERE space_id=$1 AND id=$2 AND status IN ('delivered','dead') RETURNING *`,
        [this.spaceId, id, this.now()]
      );
      const row = result.rows[0];
      if (!row) throw Object.assign(new Error("Delivery not found or still in progress"), { statusCode: 409 });
      await client.query(
        `INSERT INTO runtime_webhook_replays (space_id,delivery_id,ordinal,actor_id,reason,created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [this.spaceId, id, row.replay_count, actorId, reason.trim(), this.now()]
      );
      return delivery(row);
    });
  }

  async audit(id) {
    const result = await this.pool.query(
      `SELECT ordinal,actor_id AS "actorId",reason,created_at AS "createdAt"
       FROM runtime_webhook_replays WHERE space_id=$1 AND delivery_id=$2 ORDER BY ordinal`,
      [this.spaceId, id]
    );
    return result.rows;
  }

  async prune({ retentionMs = 30 * 86_400_000 } = {}) {
    // Bounded maintenance; pending/dead rows remain available for recovery.
    await this.pool.query(
      `DELETE FROM runtime_webhook_deliveries WHERE space_id=$1 AND id IN (
        SELECT id FROM runtime_webhook_deliveries WHERE space_id=$1 AND status='delivered'
        AND updated_at<$2 ORDER BY updated_at LIMIT 500
      )`, [this.spaceId, this.now() - retentionMs]
    );
  }
}
