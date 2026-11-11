import { PostgresWebhookStore } from "./postgres-webhook-store.mjs";
import { signRuntimeExtension } from "../../../packages/plugin-sdk/src/runtime-extension-signature.mjs";
import { environmentWebhookSecret } from "./runtime-extension-credentials.mjs";
import { createExtensionHttpTransport } from "./extension-http-transport.mjs";

export class RuntimeWebhookWorker {
  constructor({ pool, store, transport = createExtensionHttpTransport(),
    secret = environmentWebhookSecret, intervalMs = 1000, maxAttempts = 8,
    now = Date.now, random = Math.random, onError = () => {} }) {
    Object.assign(this, { pool, store, transport, secret, intervalMs, maxAttempts, now, random, onError });
    this.active = new Set();
  }

  async deliver(job, store) {
    const abort = new AbortController();
    this.active.add(abort);
    try {
      // Includes crashed/expired leases in the finite attempt budget.
      if (job.attempts > this.maxAttempts) {
        await store.finish(job, { status: "dead", failureCode: "attempts_exhausted" });
        return;
      }
      let response;
      let failureCode = null;
      try {
        const body = JSON.stringify(job.payload);
        const timestamp = String(this.now());
        response = await this.transport({
          endpoint: job.subscription.endpoint, body, signal: abort.signal,
          timeoutMs: 10_000, responseMode: "status",
          headers: {
            "x-zion-event-id": job.eventId, "x-zion-delivery-id": job.id,
            "x-zion-timestamp": timestamp,
            "x-zion-signature": signRuntimeExtension(this.secret(job.subscription.secretRef,
              { spaceId: store.spaceId, purpose: "webhook" }),
              { timestamp, id: job.id, body })
          }
        });
        if (response.status < 200 || response.status >= 300) failureCode = "http_status";
      } catch { failureCode = "transport_or_credential_error"; }
      if (!failureCode) {
        await store.finish(job, { status: "delivered", httpStatus: response.status });
        return;
      }
      const retryable = !response || response.status >= 500 || [408, 425, 429].includes(response.status);
      const dead = !retryable || job.attempts >= this.maxAttempts;
      const delay = Math.min(3600_000, 1000 * 2 ** (job.attempts - 1)) * (0.75 + this.random() * 0.5);
      await store.finish(job, {
        status: dead ? "dead" : "pending", httpStatus: response?.status || null,
        failureCode, retryAt: this.now() + Math.floor(delay)
      });
    } finally { this.active.delete(abort); }
  }

  async tick() {
    const stores = this.store ? [this.store] : (await this.pool.query(
      `SELECT d.space_id, MIN(d.available_at) AS due FROM runtime_webhook_deliveries d
       JOIN runtime_webhook_subscriptions s ON s.space_id=d.space_id AND s.id=d.subscription_id
       WHERE s.enabled AND ((d.status='pending' AND d.available_at<=$1)
         OR (d.status='delivering' AND d.lease_until<=$1))
       GROUP BY d.space_id ORDER BY due LIMIT 4`, [this.now()]
    )).rows.map((row) => new PostgresWebhookStore(this.pool, { spaceId: row.space_id, now: this.now }));
    // A global worker also drains idle/evicted account Runtimes after restart.
    for (const store of stores) {
      if (this.stopping) break;
      const jobs = await store.claim({ limit: 4, leaseMs: 30_000 });
      await Promise.all(jobs.map((job) => this.deliver(job, store)));
      await store.prune();
    }
    if (this.pool && !this.stopping) {
      await this.pool.query(
        `DELETE FROM runtime_webhook_deliveries WHERE (space_id,id) IN (
          SELECT space_id,id FROM runtime_webhook_deliveries
          WHERE status='delivered' AND updated_at<$1 ORDER BY updated_at LIMIT 500
        )`, [this.now() - 30 * 86_400_000]
      );
    }
  }

  start() {
    if (this.running || this.timer) return;
    this.stopping = false;
    const loop = () => {
      if (this.stopping) return;
      this.running = this.tick().catch(() => this.onError("webhook_worker_error")).finally(() => {
        this.running = null;
        if (!this.stopping) {
          this.timer = setTimeout(() => { this.timer = null; loop(); }, this.intervalMs);
          this.timer.unref();
        }
      });
    };
    loop();
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.active) controller.abort();
    await this.running;
  }
}
