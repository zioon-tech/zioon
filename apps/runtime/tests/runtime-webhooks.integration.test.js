import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresWebhookStore } from "../src/postgres-webhook-store.mjs";
import { RuntimeWebhookWorker } from "../src/webhook-worker.mjs";
import { createWebhookHttpHandler } from "../src/webhook-http-handler.mjs";
import { createExtensionHttpTransport } from "../src/extension-http-transport.mjs";
import { accountRequestScope } from "../src/accounts/account-access-control.mjs";
import { RuntimeAccessControl } from "../src/access-control.mjs";
import { DEFAULT_ACCESS_SCOPES, PostgresAccessStore } from "../src/postgres-access-store.mjs";
import { verifyRuntimeExtension } from "../../../packages/plugin-sdk/src/runtime-extension-signature.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

let database;
beforeAll(async () => { database = await createPostgresTestDatabase("webhooks"); });
afterAll(async () => { await database?.close(); });
const signingSecret = "webhook-test-secret-32-bytes-long-value";
const event = (id, sequence = 1, type = "run.completed") => ({
  schemaVersion: 1, eventId: `event-${id}-${sequence}`, runId: id, attemptId: "attempt",
  sequence, type, timestamp: Date.now(), data: { output: "secret-output", usage: { inputTokens: 10 } }
});
async function fixture(endpoint = "https://webhook.example/events", options = {}) {
  const spaceId = database.nextSpaceId();
  const store = new PostgresWebhookStore(database.pool, { spaceId, ...options });
  const runs = new PostgresRunStore(database.pool, { spaceId, webhooks: store });
  const sub = await store.create({
    endpoint, secretRef: "ZION_WEBHOOK_SECRET_TEST", eventTypes: ["run.completed", "run.interrupted"]
  }, "owner");
  const id = `run-${spaceId}`;
  await runs.create({ id, attemptId: "attempt", status: "running", updatedAt: Date.now(),
    principal: { spaceId, userId: "owner", grantId: "secret-grant" }, prompt: "secret-prompt" });
  return { store, runs, sub, id };
}
async function httpServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)) };
}

describe("transactional Webhook outbox", () => {
  it("rolls back Run events when enqueue fails and skips token deltas", async () => {
    const { store, runs, id } = await fixture();
    const original = store.enqueue.bind(store);
    store.enqueue = async (...args) => { await original(...args); throw new Error("outbox failed"); };
    await expect(runs.append(event(id), { status: "completed" })).rejects.toThrow("outbox failed");
    expect(await runs.getEvents(id)).toEqual([]);
    expect(await store.deliveries()).toEqual([]);
    expect((await runs.get(id)).status).toBe("running");
    store.enqueue = original;
    await runs.append(event(id, 1, "message.delta"));
    expect(await store.deliveries()).toEqual([]);
    await runs.append(event(id, 2));
    const [job] = await store.claim();
    expect(job.payload.eventId).toBe(event(id, 2).eventId);
    expect(JSON.stringify(job.payload)).not.toMatch(/secret-|grant|prompt|output/);
  });

  it("reclaims a crashed lease and rejects acknowledgement from the stale worker", async () => {
    let now = Date.now();
    const { store, runs, id } = await fixture(undefined, { now: () => now });
    await runs.append(event(id));
    const [first] = await store.claim({ leaseMs: 50 });
    expect(await store.claim()).toEqual([]);
    now += 51;
    const [next] = await store.claim({ leaseMs: 50 });
    expect(next.id).toBe(first.id);
    expect(next.eventId).toBe(first.eventId);
    expect(next.attempts).toBe(2);
    expect(await store.finish(first, { status: "delivered" })).toBe(false);
    expect(await store.finish(next, { status: "delivered" })).toBe(true);
  });

  it("uses SKIP LOCKED across concurrent workers without duplicate claims", async () => {
    const { store, runs, id } = await fixture();
    for (let i = 1; i <= 10; i++) await runs.append(event(id, i));
    const jobs = (await Promise.all([store.claim({ limit: 5 }), store.claim({ limit: 5 })])).flat();
    expect(jobs).toHaveLength(10);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(10);
  });

  it("signs real HTTP requests, retries 503, dead-letters 400 and audits manual replay", async () => {
    let responseStatus = 503;
    const received = [];
    const receiver = await httpServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      expect(verifyRuntimeExtension(signingSecret, {
        timestamp: request.headers["x-zion-timestamp"], id: request.headers["x-zion-delivery-id"],
        signature: request.headers["x-zion-signature"], body
      })).toBe(true);
      received.push(JSON.parse(body));
      response.writeHead(responseStatus); response.end("ok");
    });
    try {
      let now = Date.now();
      const { store, runs, id } = await fixture(`${receiver.origin}/events`, { now: () => now });
      await runs.append(event(id));
      const worker = new RuntimeWebhookWorker({
        store, now: () => now, random: () => 0.5, secret: () => signingSecret,
        transport: createExtensionHttpTransport({ trustedOrigins: [receiver.origin] })
      });
      await worker.tick();
      let [row] = await store.deliveries();
      expect(row).toMatchObject({ status: "pending", attempts: 1, lastHttpStatus: 503 });
      expect(row.availableAt).toBe(now + 1000);
      now += 1001;
      responseStatus = 400;
      await worker.tick();
      [row] = await store.deliveries();
      expect(row).toMatchObject({ status: "dead", attempts: 2 });
      await store.replay(row.id, { actorId: "owner", reason: "Receiver fixed" });
      expect(await store.audit(row.id)).toMatchObject([{ actorId: "owner", reason: "Receiver fixed", ordinal: 1 }]);
      responseStatus = 204;
      await worker.tick();
      expect((await store.deliveries())[0]).toMatchObject({ status: "delivered", attempts: 1, replayCount: 1 });
      expect(received).toHaveLength(3);
      expect(new Set(received.map((body) => body.eventId)).size).toBe(1);
    } finally { await receiver.close(); }
  });

  it("exhausts its finite transport/crash budget and preserves disabled subscriptions", async () => {
    let now = Date.now();
    const { store, runs, sub, id } = await fixture(undefined, { now: () => now });
    await runs.append(event(id));
    const worker = new RuntimeWebhookWorker({
      store, now: () => now, maxAttempts: 2, secret: () => signingSecret,
      transport: async () => { throw new Error("offline"); }
    });
    await store.setEnabled(sub.id, false);
    await worker.tick();
    expect((await store.deliveries())[0].attempts).toBe(0);
    await store.setEnabled(sub.id, true);
    await worker.tick();
    now += 2000;
    await worker.tick();
    expect((await store.deliveries())[0]).toMatchObject({ status: "dead", attempts: 2 });
  });

  it("drains queues for account Runtimes that are not running and enqueues crash recovery", async () => {
    const { store, runs } = await fixture();
    await runs.reconcileActiveRuns();
    const transport = async () => ({ status: 204, body: "" });
    const worker = new RuntimeWebhookWorker({ pool: database.pool, transport, secret: () => signingSecret });
    // Other tests may have queued jobs. Bound the drain to all available account spaces.
    for (let i = 0; i < 12 && (await store.deliveries())[0]?.status !== "delivered"; i++) await worker.tick();
    expect((await store.deliveries())[0]).toMatchObject({ status: "delivered" });
  });

  it("requires runtime.manage for reads and writes and keeps Space data isolated", async () => {
    const { store, runs, id } = await fixture();
    await runs.append(event(id));
    const other = new PostgresWebhookStore(database.pool, { spaceId: database.nextSpaceId() });
    expect(await other.list()).toEqual([]);
    expect(await other.deliveries()).toEqual([]);
    await expect(other.replay((await store.deliveries())[0].id, { actorId: "other", reason: "retry" })).rejects.toMatchObject({ statusCode: 409 });
    for (const method of ["GET", "POST", "PATCH"]) {
      expect(accountRequestScope(method, "/v1/webhooks")).toBe("runtime.manage");
    }
    const handler = createWebhookHttpHandler({ store, accessControl: {
      requireScope: async () => { throw Object.assign(new Error("Permission denied"), { statusCode: 403 }); }
    } });
    await expect(handler({ method: "GET", zionPrincipal: { kind: "account", space: { id: store.spaceId } } },
      {}, new URL("http://localhost/v1/webhooks"))).rejects.toMatchObject({ statusCode: 403 });
  });

  it("keeps unconfigured notifications inert and bounds oversized optional references", async () => {
    const spaceId = database.nextSpaceId();
    const store = new PostgresWebhookStore(database.pool, { spaceId });
    const runs = new PostgresRunStore(database.pool, { spaceId, webhooks: store });
    const id = "oversized-reference";
    await runs.create({ id, attemptId: "attempt", status: "running", updatedAt: Date.now(), projectId: "x".repeat(40000) });
    await runs.append(event(id));
    expect(await store.deliveries()).toEqual([]);
    await store.create({ endpoint: "https://example.com", secretRef: "ZION_WEBHOOK_SECRET_TEST", eventTypes: ["run.completed"] }, "owner");
    await runs.append(event(id, 2));
    const [job] = await store.claim();
    expect(job.payload.projectId).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(job.payload))).toBeLessThan(32 * 1024);
  });

  it("supports existing paired owners while denying client and resource credentials", async () => {
    const { store } = await fixture();
    const accessStore = new PostgresAccessStore(database.pool, { spaceId: store.spaceId });
    const accessControl = new RuntimeAccessControl({ store: accessStore });
    const handler = createWebhookHttpHandler({ store, accessControl });
    let responseBody;
    const response = {
      writeHead() {},
      end(body) { responseBody = JSON.parse(body); }
    };
    const url = new URL("http://localhost/v1/webhooks");
    const pairing = await accessStore.createPairing({ kind: "owner", delivery: "bearer", label: "existing-owner" });
    const exchanged = await accessStore.exchangePairing({ ...pairing, deviceId: "owner:webhooks" });
    const owner = await accessStore.authenticate(exchanged.credential);
    expect(await handler({ method: "GET", zionPrincipal: owner }, response, url)).toBe(true);
    expect(responseBody.subscriptions).toHaveLength(1);
    for (const kind of ["client", "resource"]) {
      await expect(handler({ method: "GET", zionPrincipal: { device: { kind, scopes: DEFAULT_ACCESS_SCOPES[kind] } } },
        response, url)).rejects.toMatchObject({ statusCode: 403 });
    }
    await expect(handler({ method: "GET", zionPrincipal: { device: { kind: "owner", scopes: ["runtime.write"] } } },
      response, url)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("accepts a successful receiver status regardless of response body size", async () => {
    const receiver = await httpServer((_request, response) => response.end("x".repeat(20000)));
    try {
      const { store, runs, id } = await fixture(receiver.origin);
      await runs.append(event(id));
      await new RuntimeWebhookWorker({
        store, secret: () => signingSecret,
        transport: createExtensionHttpTransport({ trustedOrigins: [receiver.origin] })
      }).tick();
      expect((await store.deliveries())[0]).toMatchObject({ status: "delivered", lastHttpStatus: 200, attempts: 1 });
    } finally { await receiver.close(); }
  });

  it("cleans expired receipts of idle accounts without requiring new queued events", async () => {
    const old = Date.now() - 31 * 86_400_000;
    const { store, runs, id } = await fixture(undefined, { now: () => old });
    await runs.append(event(id));
    const [job] = await store.claim();
    await store.finish(job, { status: "delivered" });
    await new RuntimeWebhookWorker({
      pool: database.pool, secret: () => signingSecret, transport: async () => ({ status: 204 })
    }).tick();
    expect(await store.deliveries()).toEqual([]);
  });
});
