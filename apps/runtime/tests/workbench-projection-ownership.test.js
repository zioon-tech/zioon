import { Readable } from "node:stream";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { createWorkbenchStateHttpHandler, WORKBENCH_STATE_PROTOCOL } from "../src/workbench-state-http-handler.mjs";

describe("Runtime-owned Workbench projections", () => {
  const key = "runtime.plugins.dev.identity.identity.snapshot";
  function fixture() {
    const store = {
      readSnapshot: vi.fn(), updateSession: vi.fn(),
      writeKV: vi.fn(() => ({ ok: true })),
      writeSnapshot: vi.fn(() => ({ ok: true })),
      migrateBrowserStorage: vi.fn(() => ({ ok: true }))
    };
    const handle = createWorkbenchStateHttpHandler({ store, readOnlyKeys: [key] });
    return {
      store,
      async request(path, body, method = "PUT") {
        const request = Readable.from([Buffer.from(JSON.stringify(body))]);
        request.method = method;
        request.headers = { "x-zion-workbench-protocol": WORKBENCH_STATE_PROTOCOL };
        let status;
        const response = { writeHead(code) { status = code; }, end() {} };
        await handle(request, response, new URL(path, "http://runtime"));
        return status;
      }
    };
  }
  it("rejects direct legacy snapshot uploads while leaving other KV writable", async () => {
    const { request, store } = fixture();
    expect(await request(`/v1/workbench-state/kv/${key}`, { value: "old" })).toBe(409);
    expect(store.writeKV).not.toHaveBeenCalled();
    expect(await request("/v1/workbench-state/kv/other", { value: "allowed" })).toBe(200);
    expect(store.writeKV).toHaveBeenCalledWith("other", "allowed", expect.any(Object));
  });
  it.each(["snapshot", "migrate-browser-storage"])("filters derived Identity KV from %s", async (operation) => {
    const { request, store } = fixture();
    const body = { source_id: "browser", snapshot: { kv: { [key]: "stale", other: "keep" }, docs: [] } };
    expect(await request(`/v1/workbench-state/${operation}`, body, operation === "snapshot" ? "PUT" : "POST")).toBe(200);
    const snapshot = operation === "snapshot"
      ? store.writeSnapshot.mock.calls[0][0] : store.migrateBrowserStorage.mock.calls[0][1];
    expect(snapshot).toEqual({ kv: { other: "keep" }, docs: [] });
    expect(body.snapshot.kv[key]).toBe("stale");
  });
});
