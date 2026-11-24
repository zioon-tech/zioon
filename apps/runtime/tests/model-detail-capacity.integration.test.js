import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { readFile } from "node:fs/promises";

let db;
beforeAll(async () => { db = await createPostgresTestDatabase("model_detail_capacity"); });
beforeEach(async () => { await db.pool.query("DELETE FROM runtime_run_event_details"); });
afterAll(async () => { await db?.close(); });
const create = async (options = {}) => {
  const store = new PostgresRunStore(db.pool, { spaceId: db.nextSpaceId(), ...options });
  await store.create({ id: "run", attemptId: "attempt", status: "running", updatedAt: Date.now() });
  return store;
};
const append = (store, sequence, timestamp = Date.now()) => store.append({
  type: "model.request", runId: "run", attemptId: "attempt", eventId: `${store.spaceId}:${sequence}`,
  sequence, timestamp, data: { payload: { model: "test", messages: [{ role: "user", content: "context ".repeat(500) }] } }
});
const usage = async key => (await db.pool.query(
  "SELECT stored_rows::int AS rows,stored_bytes::int AS bytes FROM runtime_model_detail_usage WHERE scope_key=$1", [key])).rows[0];

it("keeps foreground writes bounded and moves expiry and quota eviction into background batches", async () => {
  const store = await create({ modelRequestDetailMaxRows: 2 });
  const old = Date.now() - 45 * 86400000;
  const statements = [];
  const connect = store.pool.connect.bind(store.pool);
  const originalPool = store.pool;
  store.pool = { ...originalPool, connect: async () => {
    const client = await connect();
    return { query: (...args) => { statements.push(args[0]); return client.query(...args); }, release: () => client.release() };
  }, query: originalPool.query.bind(originalPool) };
  await append(store, 1, old);
  await append(store, 2);
  await append(store, 3);
  expect(statements.some(sql => /DELETE FROM runtime_run_event_details|ROW_NUMBER|SUM\(compressed_bytes\)/i.test(sql))).toBe(false);
  expect((await usage(`space:${store.spaceId}`)).rows).toBe(2);
  expect((await store.getEvent("run", 1)).data.payload).toBeDefined();
  expect((await store.getEvent("run", 3)).data.detailAvailable).toBeUndefined();
  expect((await store.getEvent("run", 3)).data.payload).toBeUndefined();
  expect((await store.runStorageMaintenanceBatch({ maxRows: 1 })).modelRequests.deletedDetails).toBe(1);
  expect((await usage(`space:${store.spaceId}`)).rows).toBe(1);
  await append(store, 4);
  expect((await store.getEvent("run", 4)).data.payload).toBeDefined();
  expect((await store.getEvents("run")).length).toBe(4);
});

it("enforces global admission across spaces and restores capacity through bounded oldest-first cleanup", async () => {
  const options = { modelRequestDetailMaxRows: 20, modelRequestDetailGlobalMaxRows: 3 };
  const a = await create(options), b = await create(options);
  await append(a, 1);
  await append(a, 2);
  await append(b, 1);
  await append(b, 2);
  expect((await usage("global")).rows).toBe(3);
  expect((await b.getEvent("run", 2)).data.detailAvailable).toBeUndefined();
  const pass = await b.runStorageMaintenanceBatch({ maxRows: 1 });
  expect(pass.modelRequests.deletedGlobalDetails).toBe(1);
  expect((await usage("global")).rows).toBe(2);
  await append(b, 3);
  expect((await usage("global")).rows).toBe(3);
  expect((await b.getEvent("run", 3)).data.payload).toBeDefined();
});

it("creates byte headroom before an almost-full space becomes permanently unable to capture another detail", async () => {
  const store = await create();
  await append(store, 1);
  const first = await usage(`space:${store.spaceId}`);
  store.modelRequestDetailMaxStoredBytes = first.bytes + 1;
  await append(store, 2);
  expect((await store.getEvent("run", 2)).data.detailAvailable).toBeUndefined();
  expect((await store.runStorageMaintenanceBatch({ maxRows: 1 })).modelRequests.deletedDetails).toBe(1);
  await append(store, 3);
  expect((await store.getEvent("run", 3)).data.payload).toBeDefined();
});

it("does not wait behind a busy global gate and leaves execution facts complete when detail capture is skipped", async () => {
  const store = await create();
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE runtime_model_detail_usage SET stored_rows=stored_rows WHERE scope_key='global'");
    const started = Date.now();
    await append(store, 1);
    expect(Date.now() - started).toBeLessThan(500);
    expect((await store.getEvents("run")).length).toBe(1);
    expect((await store.getEvent("run", 1)).data).toMatchObject({ messageCount: 1, config: { model: "test" } });
    expect((await store.getEvent("run", 1)).data.detailAvailable).toBeUndefined();
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

it("keeps counters transactional on failed writes, byte rejection and cascading event deletion", async () => {
  const store = await create();
  await append(store, 1);
  const first = await usage("global");
  await expect(append(store, 1)).rejects.toThrow("sequence conflict");
  expect(await usage("global")).toEqual(first);
  const small = await create({ modelRequestDetailGlobalMaxBytes: first.bytes });
  await append(small, 1);
  expect((await small.getEvent("run", 1)).data.detailAvailable).toBeUndefined();
  expect(await usage("global")).toEqual(first);
  await db.pool.query("DELETE FROM runtime_run_events WHERE space_id=$1 AND run_id='run'", [store.spaceId]);
  expect(await usage("global")).toEqual({ rows: 0, bytes: 0 });
  expect(await usage(`space:${store.spaceId}`)).toEqual({ rows: 0, bytes: 0 });
});

it("bounds concurrent global capture without losing events and expires inactive owners in background", async () => {
  const stores = await Promise.all(Array.from({ length: 8 }, () => create({ modelRequestDetailGlobalMaxRows: 3 })));
  await Promise.all(stores.map(store => append(store, 1, Date.now() - 45 * 86400000)));
  expect((await usage("global")).rows).toBeGreaterThan(0);
  expect((await usage("global")).rows).toBeLessThanOrEqual(3);
  for (const store of stores) expect((await store.getEvents("run")).length).toBe(1);
  const worker = await create({ modelRequestDetailGlobalMaxRows: 3 });
  for (let i = 0; i < 5; i++) {
    if ((await worker.runStorageMaintenanceBatch({ maxRows: 1 })).modelRequests.complete) break;
  }
  expect(await usage("global")).toEqual({ rows: 0, bytes: 0 });
  for (const store of stores) expect((await store.getEvents("run")).length).toBe(1);
});

it("includes an old writer that commits during migration in the initial counters", async () => {
  const isolated = await createPostgresTestDatabase("detail_counter_upgrade");
  const writer = await isolated.pool.connect(), migrator = await isolated.pool.connect();
  let migration;
  try {
    const spaceId = isolated.nextSpaceId();
    await new PostgresRunStore(isolated.pool, { spaceId }).create({ id: "r", status: "running", updatedAt: 1 });
    await isolated.pool.query(`DROP TRIGGER runtime_model_detail_usage_changed ON runtime_run_event_details;
      DROP FUNCTION runtime_capture_model_detail(text,text,integer,bytea,bigint,bigint,bigint,bigint,bigint,bigint);
      DROP FUNCTION runtime_track_model_detail_usage();
      DROP TABLE runtime_model_detail_usage; DROP INDEX runtime_model_details_global_created;`);
    await writer.query("BEGIN");
    await writer.query("INSERT INTO runtime_run_events (space_id,run_id,sequence,event_id,payload_json,created_at) VALUES ($1,'r',1,'e','{}',1)", [spaceId]);
    await writer.query("INSERT INTO runtime_run_event_details VALUES ($1,'r',1,'gzip-json-v1',$2,32,32,1)", [spaceId, Buffer.alloc(32)]);
    const migrationPid = (await migrator.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await migrator.query("BEGIN");
    const source = await readFile(new URL("../src/postgres/migrations/019_model_detail_capacity.sql", import.meta.url), "utf8");
    migration = migrator.query(source);
    let blocked = false;
    for (let i = 0; i < 50; i++) {
      blocked = (await isolated.pool.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [migrationPid])).rows[0].blocked;
      if (blocked) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    await writer.query("COMMIT");
    await migration;
    await migrator.query("COMMIT");
    expect((await isolated.pool.query("SELECT stored_rows::int AS rows,stored_bytes::int AS bytes FROM runtime_model_detail_usage WHERE scope_key='global'")).rows[0])
      .toEqual({ rows: 1, bytes: 32 });
  } finally {
    await writer.query("ROLLBACK");
    if (migration) await migration.catch(() => {});
    await migrator.query("ROLLBACK");
    writer.release(); migrator.release();
    await isolated.close();
  }
});
