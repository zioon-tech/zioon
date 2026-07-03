import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A minimal fake IndexedDB that lets us script connections. Each connection can
// be told to throw a "connection is closing" InvalidStateError from
// transaction(), which is exactly what a browser-recycled idle connection does.

class FakeRequest {
  onsuccess: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onupgradeneeded: ((e: any) => void) | null = null;
  onblocked: (() => void) | null = null;
  result: any = undefined;
  error: any = null;
}

class FakeConnection {
  records = new Map<any, any>();
  closing: boolean;
  onclose: (() => void) | null = null;
  onversionchange: (() => void) | null = null;
  objectStoreNames = { contains: () => true };
  constructor(closing: boolean) {
    this.closing = closing;
  }
  transaction() {
    if (this.closing) {
      const err: any = new Error(
        "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing."
      );
      err.name = "InvalidStateError";
      throw err;
    }
    const tx: any = { error: null, oncomplete: null, onabort: null, onerror: null };
    const store = {
      put: (record: any) => {
        const req = new FakeRequest();
        queueMicrotask(() => {
          this.records.set(record.id, record);
          tx.oncomplete?.();
        });
        return req;
      },
      get: (key: any) => {
        const req = new FakeRequest();
        queueMicrotask(() => {
          req.result = this.records.get(key);
          req.onsuccess?.({ target: req });
        });
        return req;
      }
    };
    tx.objectStore = () => store;
    return tx;
  }
  close() {}
}

describe("sessions idb self-heal", () => {
  let opened: FakeConnection[];
  let scriptedClosing: boolean[];

  beforeEach(() => {
    opened = [];
    // First connection reports "closing"; the reopened one works.
    scriptedClosing = [true, false];
    (globalThis as any).indexedDB = {
      open: () => {
        const req = new FakeRequest();
        const closing = scriptedClosing.length ? scriptedClosing.shift()! : false;
        const conn = new FakeConnection(closing);
        opened.push(conn);
        queueMicrotask(() => {
          req.result = conn;
          req.onsuccess?.({ target: req });
        });
        return req;
      }
    };
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as any).indexedDB;
  });

  it("reopens a fresh connection when the cached one is closing and completes the write", async () => {
    const { idbSet } = await import(
      "../extensions/dev.session-manager/storage/idb.js"
    );

    await expect(
      idbSet("zion.sessions.db", "docs", { id: "s1", text: "hello" })
    ).resolves.toBe(true);

    // We should have opened two connections: the stale one and the healthy reopen.
    expect(opened.length).toBe(2);
    expect(opened[0].closing).toBe(true);
    expect(opened[1].closing).toBe(false);
    expect(opened[1].records.get("s1")).toEqual({ id: "s1", text: "hello" });
  });

  it("does not reopen when the connection is healthy", async () => {
    scriptedClosing = [false];
    const { idbSet } = await import(
      "../extensions/dev.session-manager/storage/idb.js"
    );

    await expect(
      idbSet("zion.sessions.db", "docs", { id: "s2", text: "world" })
    ).resolves.toBe(true);
    expect(opened.length).toBe(1);
  });
});
