import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeRequest {
  result = undefined;
  error = null;
  onsuccess = null;
  onerror = null;
  onupgradeneeded = null;
  onblocked = null;
}

function installIndexedDBFixture() {
  const stores = new Map([
    ["docs", new Map([["s1", { id: "s1", text: "legacy document" }]])],
    ["metas", new Map([["s1", { id: "s1", meta: { id: "s1", title: "Legacy" } }]])],
    ["kv", new Map([
      ["tree", { key: "tree", value: { id: "root", type: "folder", children: [] } }],
      ["sessions.tagCatalog", { key: "sessions.tagCatalog", value: [{ path: "legacy" }] }],
      ["zion.comments.threadPayload.keep", {
        key: "zion.comments.threadPayload.keep",
        value: { body: "must survive session cleanup" }
      }]
    ])]
  ]);
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore: (name) => stores.set(name, new Map()),
    close() {},
    transaction(name) {
      const tx = { error: null, oncomplete: null, onabort: null, onerror: null };
      const records = stores.get(name);
      tx.objectStore = () => ({
        get(key) {
          const request = new FakeRequest();
          globalThis.queueMicrotask(() => {
            request.result = records.get(key);
            request.onsuccess?.();
          });
          return request;
        },
        getAll() {
          const request = new FakeRequest();
          globalThis.queueMicrotask(() => {
            request.result = [...records.values()];
            request.onsuccess?.();
          });
          return request;
        },
        delete(key) {
          const request = new FakeRequest();
          globalThis.queueMicrotask(() => {
            records.delete(key);
            tx.oncomplete?.();
          });
          return request;
        },
        clear() {
          const request = new FakeRequest();
          globalThis.queueMicrotask(() => {
            records.clear();
            tx.oncomplete?.();
          });
          return request;
        }
      });
      return tx;
    }
  };
  globalThis.indexedDB = {
    open() {
      const request = new FakeRequest();
      globalThis.queueMicrotask(() => {
        request.result = db;
        request.onsuccess?.({ target: request });
      });
      return request;
    }
  };
  return stores;
}

describe("session browser storage migration", () => {
  const originalIndexedDB = globalThis.indexedDB;

  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.indexedDB = originalIndexedDB;
    localStorage.clear();
    vi.resetModules();
  });

  it("extracts legacy sessions and clears only session-owned records", async () => {
    const stores = installIndexedDBFixture();
    const {
      clearMigratedBrowserSessions,
      readBrowserSessionCandidate
    } = await import("../extensions/dev.session-manager/storage/browser-migration.js");

    const candidate = await readBrowserSessionCandidate("zion.sessions.db");

    expect(candidate.candidates).toBe(1);
    expect(candidate.snapshot.docs).toEqual([{ id: "s1", text: "legacy document" }]);
    expect(candidate.snapshot.kv["sessions.tagCatalog"]).toEqual([{ path: "legacy" }]);

    await clearMigratedBrowserSessions("zion.sessions.db");

    expect(stores.get("docs").size).toBe(0);
    expect(stores.get("metas").size).toBe(0);
    expect(stores.get("kv").has("tree")).toBe(false);
    expect(stores.get("kv").has("sessions.tagCatalog")).toBe(false);
    expect(stores.get("kv").get("zion.comments.threadPayload.keep")?.value).toEqual({
      body: "must survive session cleanup"
    });
  });
});
