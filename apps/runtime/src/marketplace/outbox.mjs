import { randomUUID } from "node:crypto";
import { CancellationController } from "../../../../packages/runtime/dist/index.js";
import { contentHash } from "../../../../packages/plugin-sdk/src/runtime-workflow.mjs";

export class ExtensionOutbox {
  constructor({ pool, spaceId, runs, execute, leaseMs = 30000, pollMs = 1000, onError = () => {} }) {
    Object.assign(this, { pool, spaceId, runs, execute, leaseMs, pollMs, onError });
    this.owner = `consumer:${randomUUID()}`;
    this.closed = false;
    this.active = new Map();
  }
  async enqueue(runId, attemptId, entries) {
    if (!entries.length) return;
    if (entries.length > 100) throw new Error("extension_outbox_budget");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const entry of entries) {
        if (Buffer.byteLength(JSON.stringify(entry.payload)) > 150000) throw new Error("extension_event_budget");
        const prior = (await client.query(`INSERT INTO runtime_run_outbox
          (space_id,id,run_id,attempt_id,kind,payload_json,available_at,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$7) ON CONFLICT (space_id,id) DO NOTHING RETURNING id`,
        [this.spaceId, entry.id, runId, attemptId, entry.kind, entry.payload, Date.now()])).rows[0];
        if (!prior) {
          const row = (await client.query(`SELECT run_id,attempt_id,payload_json FROM runtime_run_outbox
            WHERE space_id=$1 AND id=$2`, [this.spaceId, entry.id])).rows[0];
          if (row.run_id !== runId || row.attempt_id !== attemptId
            || contentHash(row.payload_json) !== contentHash(entry.payload)) throw new Error("extension_event_conflict");
        }
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async claim() {
    return (await this.pool.query(`WITH candidate AS (
      SELECT id FROM runtime_run_outbox WHERE space_id=$1 AND kind='extension.handler'
        AND ((status='queued' AND available_at<=$3) OR (status='running' AND lease_until<$3))
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE runtime_run_outbox target SET status='running', owner=$2,
        generation=target.generation+1, attempts=target.attempts+1,
        lease_until=$3+$4, updated_at=$3
      FROM candidate WHERE target.space_id=$1 AND target.id=candidate.id RETURNING target.*`,
    [this.spaceId, this.owner, Date.now(), this.leaseMs])).rows[0] || null;
  }
  async renew(job) {
    const result = await this.pool.query(`UPDATE runtime_run_outbox SET lease_until=$5+$6,updated_at=$5
      WHERE space_id=$1 AND id=$2 AND owner=$3 AND generation=$4
        AND status='running' AND lease_until>=$5`,
    [this.spaceId, job.id, this.owner, job.generation, Date.now(), this.leaseMs]);
    return result.rowCount === 1;
  }
  async settle(job, status, result, failureCode, retryMs = 0) {
    return (await this.pool.query(`UPDATE runtime_run_outbox SET status=$5,result_json=$6,
      failure_code=$7,owner=NULL,lease_until=0,available_at=$8+$9,updated_at=$8
      WHERE space_id=$1 AND id=$2 AND owner=$3 AND generation=$4 AND status='running' AND lease_until>=$8`,
    [this.spaceId, job.id, this.owner, job.generation, status, result === undefined ? null : result,
      failureCode || null, Date.now(), retryMs])).rowCount === 1;
  }
  async process(job) {
    const cancellation = new CancellationController();
    this.active.set(job.id, cancellation);
    let renewing;
    const timer = setInterval(() => {
      if (!renewing) renewing = this.renew(job).then((owned) => {
        if (!owned) cancellation.cancel("extension-job-lease-lost");
      }).catch(() => cancellation.cancel("extension-job-lease-unknown")).finally(() => { renewing = undefined; });
    }, Math.max(20, Math.floor(this.leaseMs / 3)));
    timer.unref();
    try {
      const result = await this.execute(job, this.runs, cancellation.signal);
      cancellation.signal.throwIfCancelled();
      await this.settle(job, "completed", result);
    } catch (error) {
      const code = String(error.failureCode || error.code || "extension_job_error");
      // Retry only dispatch failures that occurred before acceptance. Accepted
      // unknown outcomes remain explicit until a user reconciles them.
      const retry = /^(?:node_offline|extension_host_busy|extension_host_capacity)$/.test(code) && job.attempts < 5;
      await this.settle(job, retry ? "queued" : code === "execution_outcome_unknown" ? "unknown" : "failed",
        undefined, code, retry ? Math.min(60000, 1000 * 2 ** job.attempts) : 0);
      this.onError(error, { jobId: job.id, runId: job.run_id });
    } finally {
      clearInterval(timer);
      await renewing;
      this.active.delete(job.id);
    }
  }
  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = (async () => {
      const job = await this.claim();
      if (job) await this.process(job);
    })().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  start() {
    this.timer = setInterval(() => { void this.tick().catch(this.onError); }, this.pollMs);
    this.timer.unref();
    void this.tick().catch(this.onError);
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    for (const cancellation of this.active.values()) cancellation.cancel("runtime-shutdown");
    await this.ticking;
  }
  async list(accountId, limit = 50) {
    return (await this.pool.query(`SELECT id,run_id,status,attempts,failure_code,created_at,updated_at
      FROM runtime_run_outbox WHERE space_id=$1 AND payload_json->>'accountId'=$2
      ORDER BY created_at DESC LIMIT $3`, [this.spaceId, accountId, Math.min(100, Math.max(1, limit))])).rows;
  }
}
