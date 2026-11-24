import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { projectRunEvents } from "../src/run-event-projection.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { subscribeRunStream } from "../../../packages/runtime-client/src/run-stream.mjs";
import { archiveHistoricalEvents, hydrateEventRows, restoreEventArchiveBatch } from "../src/run-event-archives.mjs";

let db;
const now = 2_000_000_000_000;
beforeAll(async () => { db = await createPostgresTestDatabase("event_archives"); });
afterAll(async () => { await db?.close(); });
const makeStore = () => new PostgresRunStore(db.pool, { spaceId: db.nextSpaceId(), now: () => now });

async function seed(store, id = "r", count = 12, { status = "completed", size = 20 } = {}) {
  await store.create({ id, attemptId: "a", status: "running", updatedAt: 1 });
  for (let i = 0; i < count; i++) {
    const type = i % 17 === 0 ? "tool.requested" : i % 3 ? "message.delta" : "reasoning.delta";
    const event = { eventId: `${id}-${i}`, runId: id, attemptId: "a",
      sequence: i * 2 + 1, timestamp: i + 1, type, schemaVersion: 1,
      extra: { a: null, unicode: "🚀中文", false: false },
      data: { turn: 1, callId: `call-${i}`, name: "read", delta: i % 5 === 0 ? "" : "内容".repeat(size),
        uncommon: [null, "", { z: 1, a: 2 }], usage: { inputTokens: 4 } } };
    await store.append(event, i === count - 1 ? { status } : undefined);
  }
  return store.getEvents(id);
}

async function drain(store, maxRows = 128) {
  const progress = [];
  for (let i = 0; i < 300; i++) {
    const result = (await store.runStorageMaintenanceBatch({ maxRows })).transientEvents;
    progress.push(result);
    if (result.complete) return progress;
  }
  throw new Error("Archive sweep did not complete");
}

it("restores exact raw replay, mid-batch ranges and restart while preserving projection and tool facts", async () => {
  const store = makeStore();
  const events = await seed(store, "history", 305);
  const projection = await store.projectionPage(0, 1000);
  const start = await store.projectionStart(5);
  const toolIndex = await store.getToolRequestIndexForSpace("history", "a", 1, 300, store.spaceId);
  const tool = await store.getToolCallEventsForSpace("history", "a", "call-0", store.spaceId);
  const identity = (await db.pool.query("SELECT cursor,event_id,sequence,created_at FROM runtime_run_events WHERE space_id=$1 ORDER BY sequence",
    [store.spaceId])).rows;
  const progress = await drain(store, 61);
  expect(progress.filter(p => p.rewrittenRows).length).toBeGreaterThan(3);
  const restarted = new PostgresRunStore(db.pool, { spaceId: store.spaceId });
  expect(await restarted.getEvents("history")).toEqual(events);
  expect(await restarted.getEventsForSpace("history", store.spaceId)).toEqual(events);
  expect(await restarted.getEvents("history", 83)).toEqual(events.filter(e => e.sequence > 83));
  expect(await restarted.getEventsForSpace("history", store.spaceId, { fromSequence: 83, toSequence: 207 }))
    .toEqual(events.filter(e => e.sequence >= 83 && e.sequence <= 207));
  for (const sequence of [1, 3, 87, 301, 609]) expect(await restarted.getEvent("history", sequence))
    .toEqual(events.find(e => e.sequence === sequence));
  expect(await restarted.getEvent("history", 2)).toBeNull();
  expect(await restarted.projectionPage(0, 1000)).toEqual(projection);
  expect(await restarted.projectionStart(5)).toBe(start);
  for (const row of projection) expect(await restarted.projectionAnchor(row.cursor)).toBe(row.anchor);
  expect(await restarted.getToolRequestIndexForSpace("history", "a", 1, 300, store.spaceId)).toBe(toolIndex);
  expect(await restarted.getToolCallEventsForSpace("history", "a", "call-0", store.spaceId)).toEqual(tool);
  expect(projectRunEvents(await restarted.getEvents("history"))).toEqual(projectRunEvents(events));
  expect((await db.pool.query("SELECT cursor,event_id,sequence,created_at FROM runtime_run_events WHERE space_id=$1 ORDER BY sequence",
    [store.spaceId])).rows).toEqual(identity);
  expect(await restarted.getEventsForSpace("history", db.nextSpaceId())).toEqual([]);
  expect(await makeStore().getEvent("history", 3)).toBeNull();
  expect(store.maintenanceStats.totalArchivedEvents).toBe(287);
});

it("leaves active, interrupted, recent and incomplete projections untouched", async () => {
  const store = makeStore();
  for (const status of ["running", "waiting", "interrupted", "failed", "cancelled"]) await seed(store, status, 3, { status });
  await seed(store, "recent", 3);
  await db.pool.query("UPDATE runtime_runs SET updated_at=$2 WHERE space_id=$1 AND id='recent'", [store.spaceId, now]);
  await seed(store, "projection", 3);
  await db.pool.query(`INSERT INTO runtime_run_completion_tasks
    (space_id,run_id,attempt_id,terminal_sequence,payload_json,status,available_at)
    VALUES ($1,'projection','a',5,'{}','queued',1)`, [store.spaceId]);
  await drain(store);
  expect((await db.pool.query("SELECT count(*)::int AS n FROM runtime_run_events WHERE space_id=$1 AND archive_ref IS NOT NULL",
    [store.spaceId])).rows[0].n).toBe(0);
});

it("bounds body transfer and archive bytes, leaving oversized deltas readable and smaller deltas progressing", async () => {
  const store = makeStore();
  const events = await seed(store, "big", 25, { size: 24000 });
  const huge = { ...events[1], eventId: "huge", sequence: 52, timestamp: 50,
    data: { delta: "x".repeat(2 * 1024 * 1024 + 100) } };
  await store.append(huge, { status: "completed" });
  const small = { ...events[1], eventId: "after-huge", sequence: 53, timestamp: 51, data: { delta: "after" } };
  await store.append(small, { status: "completed" });
  const expected = await store.getEvents("big");
  const progress = await drain(store);
  expect(progress.every(p => p.rawBytes <= 2 * 1024 * 1024)).toBe(true);
  expect((await db.pool.query("SELECT count(*)::int AS n FROM runtime_run_event_archives WHERE space_id=$1", [store.spaceId])).rows[0].n)
    .toBeGreaterThan(1);
  expect((await db.pool.query("SELECT archive_skip_reason,archive_ref FROM runtime_run_events WHERE space_id=$1 AND event_id='huge'",
    [store.spaceId])).rows[0]).toEqual({ archive_skip_reason: "oversized", archive_ref: null });
  expect((await db.pool.query("SELECT archive_ref FROM runtime_run_events WHERE space_id=$1 AND event_id='after-huge'",
    [store.spaceId])).rows[0].archive_ref).toBeTruthy();
  expect(await store.getEvents("big")).toEqual(expected);
  expect(await store.getEvent("big", 52)).toEqual(huge);
});

it("rejects missing, corrupt, mismatched and expanded archives without falling back to partial headers", async () => {
  const store = makeStore();
  await seed(store);
  await drain(store);
  const original = (await db.pool.query("SELECT *,ref AS archive_ref FROM runtime_run_event_archives WHERE space_id=$1", [store.spaceId])).rows[0];
  const header = (await db.pool.query("SELECT *,'event' AS row_kind FROM runtime_run_events WHERE space_id=$1 AND archive_ref IS NOT NULL LIMIT 1",
    [store.spaceId])).rows[0];
  await expect(hydrateEventRows([header])).rejects.toMatchObject({ code: "run_event_archive_corrupt" });
  for (const assignment of ["payload_blob='broken'::bytea", "raw_bytes=raw_bytes+1", "event_count=event_count+1"]) {
    await db.pool.query(`UPDATE runtime_run_event_archives SET ${assignment} WHERE space_id=$1`, [store.spaceId]);
    await expect(store.getEvents("r")).rejects.toMatchObject({ code: "run_event_archive_corrupt" });
    await expect(store.getEvent("r", header.sequence)).rejects.toMatchObject({ code: "run_event_archive_corrupt" });
    await db.pool.query("UPDATE runtime_run_event_archives SET payload_blob=$2,raw_bytes=$3,event_count=$4 WHERE space_id=$1",
      [store.spaceId, original.payload_blob, original.raw_bytes, original.event_count]);
  }
  const archive = { ...original, row_kind: "archive" };
  await expect(hydrateEventRows([{ ...header, event_id: "wrong" }, archive])).rejects.toMatchObject({ code: "run_event_archive_corrupt" });
  await expect(hydrateEventRows([{ ...header, archive_ordinal: 127 }, archive])).rejects.toMatchObject({ code: "run_event_archive_corrupt" });
  await expect(hydrateEventRows([header, { ...archive, raw_bytes: 3 * 1024 * 1024 }])).rejects.toMatchObject({ code: "run_event_archive_corrupt" });
  expect(await store.getEvents("r")).toHaveLength(12);
});

it("rolls back conversion atomically, then materializes exact bodies for downgrade", async () => {
  const store = makeStore();
  const events = await seed(store);
  await expect(store.transaction(async client => {
    const result = await archiveHistoricalEvents(client, { cutoff: now, maxRows: 4 });
    expect(result.rewrittenRows).toBe(4);
    throw new Error("cancel");
  })).rejects.toThrow("cancel");
  expect((await db.pool.query("SELECT count(*)::int AS n FROM runtime_run_event_archives WHERE space_id=$1", [store.spaceId])).rows[0].n).toBe(0);
  expect(await store.getEvents("r")).toEqual(events);
  await drain(store, 4);
  let restored = 0;
  for (let i = 0; i < 30; i++) {
    const result = await store.transaction(restoreEventArchiveBatch);
    restored += result.restoredRows;
    if (result.complete) break;
    expect(i).toBeLessThan(29);
  }
  expect(restored).toBeGreaterThanOrEqual(11);
  expect((await db.pool.query("SELECT payload_json FROM runtime_run_events WHERE space_id=$1 ORDER BY sequence", [store.spaceId])).rows.map(r => r.payload_json))
    .toEqual(events);
  expect(await store.getEvents("r")).toEqual(events);
  await drain(store);
});

it("advances past a busy owner and archives inactive accounts through an unrelated worker", async () => {
  const [a, b] = [makeStore(), makeStore()].sort((a, b) => a.spaceId.localeCompare(b.spaceId));
  const worker = makeStore();
  await seed(a, "busy");
  const events = await seed(b, "inactive");
  const locked = await db.pool.connect();
  try {
    await locked.query("BEGIN");
    await locked.query("SELECT 1 FROM runtime_runs WHERE space_id=$1 AND id='busy' FOR UPDATE", [a.spaceId]);
    const first = (await worker.runStorageMaintenanceBatch()).transientEvents;
    expect(first.busy).toBe(true);
    const second = (await worker.runStorageMaintenanceBatch()).transientEvents;
    expect(second.rewrittenRows).toBe(11);
    expect(await b.getEvents("inactive")).toEqual(events);
  } finally {
    await locked.query("ROLLBACK");
    locked.release();
  }
  await drain(worker);
  expect((await db.pool.query("SELECT count(*)::int AS n FROM runtime_run_event_archives WHERE space_id=ANY($1::text[])",
    [[a.spaceId, b.spaceId]])).rows[0].n).toBe(2);
});

it("uses one snapshot and one body per batch even when the Run disappears before hydration", async () => {
  const store = makeStore();
  const events = await seed(store);
  await drain(store);
  let queries = 0, archives = 0;
  const pool = { connect: db.pool.connect.bind(db.pool), async query(sql, args) {
    queries += 1;
    const result = await db.pool.query(sql, args);
    archives = result.rows.filter(r => r.row_kind === "archive").length;
    await db.pool.query("DELETE FROM runtime_runs WHERE space_id=$1 AND id='r'", [store.spaceId]);
    return result;
  } };
  expect(await new PostgresRunStore(pool, { spaceId: store.spaceId }).getEvents("r")).toEqual(events);
  expect(queries).toBe(1);
  expect(archives).toBe(1);
  expect((await db.pool.query("SELECT count(*)::int AS n FROM runtime_run_event_archives WHERE space_id=$1", [store.spaceId])).rows[0].n).toBe(0);
});

it("serves exact archived HTTP/SSE replay and projected cursors through the real server", async () => {
  const store = makeStore();
  const events = await seed(store, "http", 42);
  await drain(store, 8);
  const server = createRuntimeServer({ runs: store, port: 0, pollIntervalMs: 5,
    executor: { execute() { throw new Error("Historical replay must not execute"); } } });
  const { url } = await server.start();
  try {
    const after = 17;
    const expected = events.filter(e => e.sequence > after);
    const read = async path => {
      const response = await fetch(url + path, { signal: AbortSignal.timeout(5000) });
      expect(response.status).toBe(200);
      return response;
    };
    expect((await (await read(`/v1/runs/http/events?after=${after}`)).json()).events).toEqual(expected);
    expect((await (await read("/v1/runs/http/events/19")).json()).event).toEqual(events.find(e => e.sequence === 19));
    const projection = await (await read(`/v1/runs/http/projection?after=${after}`)).json();
    expect(projection.events).toEqual(projectRunEvents(expected));
    expect(projection.sourceCursor).toBe(expected.at(-1).sequence);
    const parse = text => text.split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
    expect(parse(await (await read(`/v1/runs/http/events/stream?after=${after}`)).text())).toEqual(expected);
    const projected = parse(await (await read(`/v1/runs/http/projection/stream?after=${after}`)).text());
    expect(projected).toEqual(projectRunEvents(expected));
  } finally {
    await server.close();
  }
});

it("preserves null/array delta shapes and enforces archive identity fields at the database boundary", async () => {
  const store = makeStore();
  await store.create({ id: "shapes", attemptId: "a", status: "running", updatedAt: 1 });
  const events = [null, [], { delta: null, turn: 2 }, { turn: 2 }].map((data, i) => ({
    runId: "shapes", attemptId: "a", eventId: `shape-${i}`, sequence: i+1, timestamp: i+1,
    type: i%2 ? "reasoning.delta" : "message.delta", data, extra: { unicode: "🌙", nested: [null, false] }
  }));
  for (const event of events) await store.append(event, { status: "completed" });
  await drain(store);
  expect(await store.getEvents("shapes")).toEqual(events);
  await expect(db.pool.query("UPDATE runtime_run_events SET archive_ordinal=NULL WHERE space_id=$1", [store.spaceId]))
    .rejects.toMatchObject({ code: "23514" });
  await expect(db.pool.query("UPDATE runtime_run_events SET archive_ref='missing' WHERE space_id=$1", [store.spaceId]))
    .rejects.toMatchObject({ code: "23503" });
  const ref = (await db.pool.query("SELECT archive_ref FROM runtime_run_events WHERE space_id=$1 LIMIT 1", [store.spaceId])).rows[0].archive_ref;
  const foreign = makeStore();
  await seed(foreign, "shapes");
  await expect(db.pool.query("UPDATE runtime_run_events SET archive_ref=$2,archive_ordinal=0 WHERE space_id=$1 AND sequence=3",
    [foreign.spaceId, ref])).rejects.toMatchObject({ code: "23503" });
  await drain(store);
});

it("recovers from oversized batch timeouts and lets an inactive owner progress on the next pass", async () => {
  const [huge, small] = [makeStore(), makeStore()].sort((a,b) => a.spaceId.localeCompare(b.spaceId));
  const worker = makeStore();
  await huge.create({ id: "huge", status: "completed", updatedAt: 1 });
  await small.create({ id: "small", status: "completed", updatedAt: 1 });
  await db.pool.query(`INSERT INTO runtime_run_events (space_id,run_id,sequence,event_id,payload_json,created_at)
    SELECT $1,'huge',i,'large-'||i,jsonb_build_object('runId','huge','eventId','large-'||i,
      'sequence',i,'timestamp',i,'type','message.delta',
      'data',jsonb_build_object('delta',repeat('x',8388608))),i FROM generate_series(1,128) i`, [huge.spaceId]);
  await db.pool.query(`INSERT INTO runtime_run_events (space_id,run_id,sequence,event_id,payload_json,created_at)
    VALUES ($1,'small',1,'s','{"runId":"small","eventId":"s","sequence":1,"timestamp":1,"type":"message.delta","data":{"delta":"s"}}',1)`,
  [small.spaceId]);
  let complete = false;
  for (let i=0;i<40;i++) {
    try {
      complete = (await worker.runStorageMaintenanceBatch()).transientEvents.complete;
    } catch (error) {
      expect(error.code).toBe("57014");
      expect(worker.eventArchiveCursor).toEqual({ spaceId: huge.spaceId, runId: "huge" });
      expect(worker.eventArchiveProbeLimits.get(JSON.stringify([huge.spaceId,"huge"]))).toBeLessThan(128);
    }
    if (i === 1) expect((await db.pool.query("SELECT count(archive_ref)::int AS n FROM runtime_run_events WHERE space_id=$1",
      [small.spaceId])).rows[0].n).toBe(1);
    if (complete) break;
  }
  expect(complete).toBe(true);
  expect((await db.pool.query("SELECT count(*)::int AS n FROM runtime_run_events WHERE space_id=$1 AND archive_skip_reason='oversized'",
    [huge.spaceId])).rows[0].n).toBe(128);
}, 30000);

it("reports corrupt archive failures over both SSE modes and makes the real SDK reject the replay", async () => {
  const store = makeStore();
  await seed(store, "corrupt-http");
  await drain(store);
  const original = (await db.pool.query("SELECT ref,payload_blob FROM runtime_run_event_archives WHERE space_id=$1", [store.spaceId])).rows[0];
  await db.pool.query("UPDATE runtime_run_event_archives SET payload_blob='broken'::bytea WHERE space_id=$1", [store.spaceId]);
  const server = createRuntimeServer({ runs: store, port: 0, pollIntervalMs: 5,
    executor: { execute() { throw new Error("Historical replay must not execute"); } } });
  const { url } = await server.start();
  const collect = async mode => {
    const events = [];
    for await (const event of subscribeRunStream(url, "corrupt-http", { mode, signal: AbortSignal.timeout(5000) })) events.push(event);
    return events;
  };
  try {
    for (const suffix of ["events", "events/3", "projection"]) {
      const response = await fetch(`${url}/v1/runs/corrupt-http/${suffix}`);
      expect(response.status).toBe(500);
      expect((await response.json()).code).toBe("run_event_archive_corrupt");
    }
    for (const suffix of ["events/stream", "projection/stream"]) {
      const response = await fetch(`${url}/v1/runs/corrupt-http/${suffix}`);
      const body = await response.text();
      expect(body).toContain("event: error\n");
      expect(JSON.parse(body.split("data: ")[1].trim()).code).toBe("run_event_archive_corrupt");
    }
    await expect(collect("raw")).rejects.toThrow("Run event archive is missing or corrupt");
    await expect(collect("projection")).rejects.toThrow("Run event archive is missing or corrupt");
  } finally {
    await server.close();
    await db.pool.query("UPDATE runtime_run_event_archives SET payload_blob=$2 WHERE space_id=$1 AND ref=$3",
      [store.spaceId,original.payload_blob,original.ref]);
  }
});
