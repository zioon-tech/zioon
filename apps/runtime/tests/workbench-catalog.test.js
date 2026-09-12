import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkbenchStateStore } from "../src/sqlite-workbench-state-store.mjs";
import { createWorkbenchStateHttpHandler } from "../src/workbench-state-http-handler.mjs";

const stores = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe("Workbench startup catalog", () => {
  it("excludes history bodies and annotations without changing the snapshot contract", async () => {
    const store = new SqliteWorkbenchStateStore(":memory:");
    stores.push(store);
    for (let index = 0; index < 82; index++) {
      store.createSession({
        id: `s${index}`, text: "history ".repeat(1800),
        meta: { title: `Session ${index}`, annotations: { tools: [{ result: "x".repeat(170000) }] } }
      });
    }
    const snapshot = store.readSnapshot();
    const catalog = store.readCatalog();
    expect(catalog.catalog.sessions).toHaveLength(82);
    expect(catalog.catalog.metas).toHaveLength(82);
    expect(catalog.catalog.docs).toBeUndefined();
    expect(catalog.catalog.metas[0].meta.annotations).toBeUndefined();
    expect(snapshot.snapshot.metas[0].meta.annotations.tools[0].result.length).toBe(170000);
    expect(JSON.stringify(catalog).length).toBeLessThan(JSON.stringify(snapshot).length / 50);
    expect(catalog.event_cursor).toBe(snapshot.event_cursor);
    const handler = createWorkbenchStateHttpHandler({ store });
    let status, body;
    const response = { writeHead: (value) => { status = value; }, end: (value) => { body = JSON.parse(value); } };
    await handler({ method: "GET" }, response, new URL("http://test/v1/workbench-state/catalog"));
    expect(status).toBe(200);
    expect(body.catalog.sessions).toHaveLength(82);
    if (process.env.ZION_RELOAD_PROBE) {
      await fetch(process.env.ZION_RELOAD_PROBE, { method: "POST", body: JSON.stringify({
        sessionId: "workbench-reload", runId: "post-fix", hypothesisId: "B",
        msg: "[DEBUG] Synthetic 82-session catalog comparison",
        data: { snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)), catalogBytes: Buffer.byteLength(JSON.stringify(catalog)) }
      }) });
    }
  });
});
