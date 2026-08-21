import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";

const COMMENTS_KEY = "zion.comments.threads.v1";
const SCHEDULER_RUNS_KEY = "zion.scheduler.local.runs.v1";
const THREAD_PAYLOAD_PREFIX = "zion.comments.threadPayload.";
const THREAD_RECORD_PREFIX = "zion.comments.threadRecord.";
const THREAD_RECORD_IDS_KEY = "zion.comments.threadRecordIds.v1";

const originalZion = window.zion;
const originalIndexedDB = globalThis.indexedDB;

function createFakeIndexedDB() {
  const storesByDb = new Map();
  const ensureStore = (dbName, storeName = "kv") => {
    if (!storesByDb.has(dbName)) storesByDb.set(dbName, new Map());
    const stores = storesByDb.get(dbName);
    if (!stores.has(storeName)) stores.set(storeName, new Map());
    return stores.get(storeName);
  };

  class FakeRequest {
    constructor() {
      this.onsuccess = null;
      this.onerror = null;
      this.onupgradeneeded = null;
      this.onblocked = null;
      this.result = undefined;
      this.error = null;
    }
  }

  class FakeDB {
    constructor(name) {
      this.name = name;
      this.onclose = null;
      this.onversionchange = null;
      this.objectStoreNames = {
        contains: (storeName) => storesByDb.get(name)?.has(storeName) || false
      };
    }
    createObjectStore(storeName) {
      ensureStore(this.name, storeName);
    }
    transaction(storeName) {
      const store = ensureStore(this.name, storeName);
      const tx = { error: null, oncomplete: null, onabort: null, onerror: null };
      tx.objectStore = () => ({
        put: (record) => {
          const req = new FakeRequest();
          queueMicrotask(() => {
            store.set(record.id ?? record.key, record);
            tx.oncomplete?.();
          });
          return req;
        },
        get: (key) => {
          const req = new FakeRequest();
          queueMicrotask(() => {
            req.result = store.get(key);
            req.onsuccess?.({ target: req });
          });
          return req;
        },
        delete: (key) => {
          const req = new FakeRequest();
          queueMicrotask(() => {
            store.delete(key);
            tx.oncomplete?.();
          });
          return req;
        },
        getAll: () => {
          const req = new FakeRequest();
          queueMicrotask(() => {
            req.result = [...store.values()];
            req.onsuccess?.({ target: req });
          });
          return req;
        }
      });
      return tx;
    }
    close() {}
  }

  globalThis.indexedDB = {
    open: (dbName) => {
      const req = new FakeRequest();
      const isNew = !storesByDb.has(dbName);
      queueMicrotask(() => {
        if (isNew) storesByDb.set(dbName, new Map());
        const db = new FakeDB(dbName);
        req.result = db;
        if (isNew) req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    }
  };

  return {
    getKV(key) {
      return ensureStore("zion.sessions.db", "kv").get(key)?.value;
    },
    setKV(key, value) {
      ensureStore("zion.sessions.db", "kv").set(key, { key, value });
    }
  };
}

function setupZionHarness() {
  const commands = new Map();
  const state = new Map();
  const selectionItems = new Map();
  const notifications = [];

  window.zion = {
    commands: {
      registerCommand: (id, handler) => {
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      },
      executeCommand: (id, ...args) => commands.get(id)?.(...args)
    },
    state: {
      get: (key) => state.get(key),
      set: (key, value) => state.set(key, value),
      onDidChange: () => ({ dispose() {} })
    },
    events: {
      emit: () => {},
      on: () => ({ dispose() {} })
    },
    editor: {
      getEditorForView: (view) => view?.__editor || null,
      selectionToolbar: {
        registerItem: (item) => {
          selectionItems.set(item.id, item);
          return { dispose: () => selectionItems.delete(item.id) };
        }
      },
      registerDecorator: () => ({ dispose() {} })
    },
    menus: { register: () => ({ dispose() {} }) },
    auxiliaryBar: {
      activateView: () => {},
      registerView: () => ({ dispose() {} })
    },
    inspector: {
      registerTextEditorDecorator: () => ({ dispose() {} })
    },
    activityBar: { registerItem: () => ({ dispose() {} }) },
    window: { activeEditor: null },
    notification: {
      show: (message, options) => notifications.push({ message, options })
    }
  };

  return { commands, state, selectionItems, notifications };
}

function createEditor(source, selectedText) {
  const from = source.indexOf(selectedText);
  const state = EditorState.create({
    doc: source,
    selection: { anchor: from, head: from + selectedText.length }
  });
  const view = {
    state,
    dom: document.createElement("div"),
    dispatch: () => {},
    focus: () => {}
  };
  const editor = {
    panelId: "panel-main",
    sessionId: "session-main",
    getView: () => view
  };
  view.__editor = editor;
  return { editor, view, from, to: from + selectedText.length };
}

async function loadCommentsPlugin() {
  vi.resetModules();
  const mod = await import("../extensions/dev.comments/main.js");
  const activated = await mod.activate({ subscriptions: [] });
  return { mod, activated };
}

async function flushMicrotasks(times = 6) {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("comments storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    window.zion = originalZion;
    globalThis.indexedDB = originalIndexedDB;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("migrates legacy full threads into IndexedDB and keeps only a hot local index", async () => {
    const idb = createFakeIndexedDB();
    const legacyThreads = Array.from({ length: 130 }, (_, index) => ({
      id: `thread-${index}`,
      sessionId: "session-main",
      parentSessionId: "session-main",
      threadSessionId: `comment:thread-${index}`,
      anchorKind: "range",
      from: index,
      to: index + 6,
      startLine: index,
      endLine: index,
      anchorText: `target-${index}`,
      quote: `target-${index}`,
      sourceContextText: `context-${index}-` + "x".repeat(8000),
      body: `user note ${index}`,
      summary: `summary ${index}`,
      chatAnnotations: { tools: [{ id: `tool-${index}` }], thinking: [] },
      createdAt: index,
      updatedAt: index
    }));
    localStorage.setItem(COMMENTS_KEY, JSON.stringify(legacyThreads));
    setupZionHarness();

    const { activated } = await loadCommentsPlugin();
    await flushMicrotasks();

    const localIndex = JSON.parse(localStorage.getItem(COMMENTS_KEY) || "[]");
    expect(localIndex).toHaveLength(120);
    expect(localIndex[0]).not.toHaveProperty("body");
    expect(localIndex[0]).not.toHaveProperty("sourceContextText");
    expect(idb.getKV(THREAD_RECORD_IDS_KEY)).toHaveLength(130);
    expect(idb.getKV(`${THREAD_RECORD_PREFIX}thread-0`)).toMatchObject({
      id: "thread-0",
      sessionId: "session-main"
    });
    expect(idb.getKV(`${THREAD_PAYLOAD_PREFIX}thread-0`)).toMatchObject({
      body: "user note 0",
      summary: "summary 0"
    });
    expect(idb.getKV(`${THREAD_PAYLOAD_PREFIX}thread-0`).sourceContextText.length).toBeGreaterThan(8000);

    activated?.dispose?.();
  });

  it("loads archived thread records from IndexedDB even when the local index is empty", async () => {
    const idb = createFakeIndexedDB();
    idb.setKV(THREAD_RECORD_IDS_KEY, ["archived-1"]);
    idb.setKV(`${THREAD_RECORD_PREFIX}archived-1`, {
      id: "archived-1",
      sessionId: "session-main",
      parentSessionId: "session-main",
      threadSessionId: "comment:archived-1",
      anchorKind: "range",
      from: 6,
      to: 12,
      startLine: 0,
      endLine: 0,
      anchorText: "target",
      quote: "target",
      resolved: false,
      createdAt: 1,
      updatedAt: 1
    });
    const { commands } = setupZionHarness();

    const { activated } = await loadCommentsPlugin();
    const anchors = commands.get("comments.getSourceAnchors")({
      sessionId: "session-main",
      sourceText: "hello target world"
    });

    expect(anchors).toEqual([{
      id: "archived-1",
      from: 6,
      to: 12,
      active: false
    }]);

    activated?.dispose?.();
  });

  it("reclaims volatile run storage instead of failing comment creation", async () => {
    const idb = createFakeIndexedDB();
    localStorage.setItem(SCHEDULER_RUNS_KEY, "x".repeat(120_000));
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(key, value) {
      if (key === COMMENTS_KEY && localStorage.getItem(SCHEDULER_RUNS_KEY)) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    });
    const { selectionItems, notifications } = setupZionHarness();
    const { view, from, to } = createEditor("before target phrase after", "target phrase");

    const { activated } = await loadCommentsPlugin();
    const created = selectionItems.get("comments.create").run({
      view,
      selectionText: "target phrase",
      from,
      to
    });
    await flushMicrotasks();

    const localIndex = JSON.parse(localStorage.getItem(COMMENTS_KEY) || "[]");
    expect(created).toBeTruthy();
    expect(localStorage.getItem(SCHEDULER_RUNS_KEY)).toBeNull();
    expect(localIndex).toHaveLength(1);
    expect(localIndex[0]).not.toHaveProperty("body");
    expect(localIndex[0]).not.toHaveProperty("sourceContextText");
    expect(idb.getKV(`${THREAD_PAYLOAD_PREFIX}${localIndex[0].id}`).sourceContextText).toContain("target phrase");
    expect(notifications.find((item) => item.options?.type === "error")).toBeUndefined();

    activated?.dispose?.();
  });
});
