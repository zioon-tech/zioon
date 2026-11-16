import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { createWorkbenchStateHttpHandler } from "../src/workbench-state-http-handler.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

const stores = [];
let database;

beforeAll(async () => {
  database = await createPostgresTestDatabase("workbench_catalog");
});
afterAll(async () => {
  await database.close();
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe("Workbench startup catalog", () => {
  it("pages summaries while keeping complete tree identities and searches content within the owning space", async () => {
    const store = await new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() }).initialize();
    const other = await new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() }).initialize();
    stores.push(store, other);
    for (let index = 0; index < 4; index++) {
      await store.createSession({ id: `page-${index}`, text: `user needle 中文 ${index}`, meta: { title: `Session ${index}` } });
    }
    await other.createSession({ id: "private", text: "user needle", meta: { title: "Private" } });
    const catalog = await store.readCatalog({ metadataLimit: 2 });
    expect(catalog.catalog.metas).toHaveLength(2);
    expect(catalog.catalog.sessions).toHaveLength(4);
    expect(catalog.catalog.index).toHaveLength(4);
    const first = await store.searchSessions({ query: "needle", limit: 2 });
    const next = await store.searchSessions({ query: "needle", limit: 2, offset: first.nextOffset });
    expect(first.hasMore).toBe(true);
    expect(next.hasMore).toBe(false);
    expect(new Set([...first.sessions, ...next.sessions].map(item => item.id)).size).toBe(4);
    expect([...first.sessions, ...next.sessions].some(item => item.id === "private")).toBe(false);
    expect((await store.searchSessions({ query: "%_" })).sessions).toEqual([]);
    expect((await store.searchSessions({ query: "中文" })).sessions).toHaveLength(4);
  });
  it("normalizes legacy leading prose as a user role block for display", async () => {
    const store = await new PostgresWorkbenchStateStore(database.pool, {
      spaceId: database.nextSpaceId()
    }).initialize();
    stores.push(store);
    await store.createSession({
      id: "legacy-open",
      text: [
        "线上旧会话开头没有 role 头",
        "",
        "assistant <!-- zion-assistant:id=run-old --> ",
        "思考 <!-- zion-thinking:id=thinking:run-old:1 -->",
        "answer"
      ].join("\n"),
      meta: { title: "Legacy" }
    });

    const record = await store.readSession("legacy-open");
    expect(record.text).toContain("user 线上旧会话开头没有 role 头");
    expect(record.text).toContain("assistant <!-- zion-assistant:id=run-old --> ");
    const snapshot = await store.readSnapshot();
    expect(snapshot.snapshot.docs.find((doc) => doc.id === "legacy-open").text)
      .toContain("user 线上旧会话开头没有 role 头");
  });

  it("excludes history bodies and annotations without changing the snapshot contract", async () => {
    const store = await new PostgresWorkbenchStateStore(database.pool, {
      spaceId: database.nextSpaceId()
    }).initialize();
    stores.push(store);
    for (let index = 0; index < 12; index++) {
      await store.createSession({
        id: `s${index}`, text: "history ".repeat(1800),
        meta: {
          title: `Session ${index}`,
          titleAuto: false,
          tags: ["project/test"],
          annotations: { tools: [{ result: "x".repeat(50000) }] },
          identitySnapshot: { payload: "y".repeat(25000) },
          documentPreview: "preview".repeat(1000)
        }
      });
    }
    await store.writeKV("sessions.tagIndex", { version: 1, sessions: { s1: ["project/test"] } });
    await store.writeKV("runtime.plugins.dev.skills.skills.snapshot", {
      payload: "z".repeat(250000)
    });
    const snapshot = await store.readSnapshot();
    const catalog = await store.readCatalog();
    expect(catalog.catalog.sessions).toHaveLength(12);
    expect(catalog.catalog.metas).toHaveLength(12);
    expect(catalog.catalog.docs).toBeUndefined();
    expect(catalog.catalog.metas[0].meta.annotations).toBeUndefined();
    expect(catalog.catalog.metas[0].meta.identitySnapshot).toBeUndefined();
    expect(catalog.catalog.metas[0].meta.documentPreview).toBeUndefined();
    expect(catalog.catalog.metas[0].meta).toMatchObject({
      title: "Session 0",
      tags: ["project/test"]
    });
    expect(catalog.catalog.kv["sessions.tagIndex"]).toMatchObject({ version: 1 });
    expect(catalog.catalog.kv["runtime.plugins.dev.skills.skills.snapshot"]).toBeUndefined();
    expect(snapshot.snapshot.metas[0].meta.annotations.tools[0].result.length).toBe(50000);
    expect(JSON.stringify(catalog).length).toBeLessThan(JSON.stringify(snapshot).length / 50);
    expect(catalog.event_cursor).toBe(snapshot.event_cursor);
    const handler = createWorkbenchStateHttpHandler({ store });
    let status, body;
    const response = { writeHead: (value) => { status = value; }, end: (value) => { body = JSON.parse(value); } };
    await handler({ method: "GET" }, response, new URL("http://test/v1/workbench-state/catalog"));
    expect(status).toBe(200);
    expect(body.catalog.sessions).toHaveLength(12);
  });
});
