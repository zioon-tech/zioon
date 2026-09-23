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
