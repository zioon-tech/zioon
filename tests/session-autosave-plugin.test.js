import { describe, expect, it, vi } from "vitest";
import { EditorCore } from "../src/editor/EditorCore";
import { createSessionAutoSavePlugin } from "../extensions/dev.session-manager/editor/autosave-plugin.js";

describe("session autosave plugin", () => {
  it("keeps pending saves isolated per panel editor", () => {
    const saved = [];
    const metas = new Map();
    const createEditor = (panelId, text) => {
      const host = document.createElement("div");
      host.dataset.panelId = panelId;
      document.body.appendChild(host);
      return new EditorCore(host, text, panelId);
    };
    const plugin = createSessionAutoSavePlugin({
      zion: { state: { get: () => null } },
      getCurrentId(view) {
        const panelId = view?.dom?.closest?.("[data-panel-id]")?.getAttribute?.("data-panel-id");
        return panelId === "panel-a" ? "session-a" : "session-b";
      },
      loadMeta(id) {
        return metas.get(id) || { id, title: id, createdAt: 1, updatedAt: 1, size: 0, hash: "" };
      },
      saveDoc(id, text) {
        saved.push({ id, text });
      },
      saveMeta(id, meta) {
        metas.set(id, meta);
      },
      hashString: (text) => `hash:${text}`,
      now: () => 2,
      getAnnotationsState: () => null,
      rebuildIndexFromTree: () => {},
      upsertIndexEntry: () => {},
      postSaved: () => {},
      onSaved: () => {}
    });
    const coreA = createEditor("panel-a", "a0");
    const coreB = createEditor("panel-b", "b0");
    coreA.addExternalExtension(plugin.extension);
    coreB.addExternalExtension(plugin.extension);

    try {
      coreA.view.dispatch({ changes: { from: 0, to: coreA.view.state.doc.length, insert: "a1" } });
      coreB.view.dispatch({ changes: { from: 0, to: coreB.view.state.doc.length, insert: "b1" } });

      expect(plugin.flush("session-a")).toBe(true);
      expect(plugin.flush("session-b")).toBe(true);
      expect(saved).toEqual([
        { id: "session-a", text: "a1" },
        { id: "session-b", text: "b1" }
      ]);
    } finally {
      coreA.view.destroy();
      coreB.view.destroy();
      document.body.innerHTML = "";
    }
  });

  it("does not save session-load setValue calls", () => {
    const saved = [];
    const host = document.createElement("div");
    host.dataset.panelId = "panel-a";
    document.body.appendChild(host);
    const plugin = createSessionAutoSavePlugin({
      zion: { state: { get: () => null } },
      getCurrentId: () => "session-a",
      loadMeta: (id) => ({ id, title: id, createdAt: 1, updatedAt: 1, size: 0, hash: "" }),
      saveDoc(id, text) {
        saved.push({ id, text });
      },
      saveMeta: () => {},
      hashString: (text) => `hash:${text}`,
      now: () => 2,
      getAnnotationsState: () => null,
      rebuildIndexFromTree: () => {},
      upsertIndexEntry: () => {},
      postSaved: () => {},
      onSaved: () => {}
    });
    const core = new EditorCore(host, "before", "panel-a");
    core.addExternalExtension(plugin.extension);

    try {
      core.setValue("loaded session text", { source: "session-load" });
      core.setValue("prefetched session text", { source: "session-seed" });

      expect(plugin.flush("session-a")).toBe(false);
      expect(saved).toEqual([]);
    } finally {
      core.view.destroy();
      document.body.innerHTML = "";
    }
  });

  it("does not save editors that own their persistence", () => {
    const saved = [];
    const host = document.createElement("div");
    host.dataset.panelId = "comments:thread-1";
    document.body.appendChild(host);
    const plugin = createSessionAutoSavePlugin({
      zion: { state: { get: () => null } },
      getCurrentId: () => "comment:thread-1",
      loadMeta: (id) => ({ id, title: id, createdAt: 1, updatedAt: 1, size: 0, hash: "" }),
      saveDoc(id, text) {
        saved.push({ id, text });
      },
      saveMeta: () => {},
      hashString: (text) => `hash:${text}`,
      now: () => 2,
      getAnnotationsState: () => null,
      rebuildIndexFromTree: () => {},
      upsertIndexEntry: () => {},
      postSaved: () => {},
      onSaved: () => {}
    });
    const core = new EditorCore(host, "before", "comments:thread-1");
    core.view.dom.dataset.zionSessionPersistence = "skip";
    core.addExternalExtension(plugin.extension);

    try {
      core.setValue("after");

      expect(plugin.flush("comment:thread-1")).toBe(false);
      expect(saved).toEqual([]);
    } finally {
      core.view.destroy();
      document.body.innerHTML = "";
    }
  });

  it("saves ordinary setValue replacements from editor features", () => {
    const saved = [];
    const host = document.createElement("div");
    host.dataset.panelId = "panel-a";
    document.body.appendChild(host);
    const plugin = createSessionAutoSavePlugin({
      zion: { state: { get: () => null } },
      getCurrentId: () => "session-a",
      loadMeta: (id) => ({ id, title: id, createdAt: 1, updatedAt: 1, size: 0, hash: "" }),
      saveDoc(id, text) {
        saved.push({ id, text });
      },
      saveMeta: () => {},
      hashString: (text) => `hash:${text}`,
      now: () => 2,
      getAnnotationsState: () => null,
      rebuildIndexFromTree: () => {},
      upsertIndexEntry: () => {},
      postSaved: () => {},
      onSaved: () => {}
    });
    const core = new EditorCore(host, "before", "panel-a");
    core.addExternalExtension(plugin.extension);

    try {
      core.setValue("compressed session text");

      expect(plugin.flush("session-a")).toBe(true);
      expect(saved).toEqual([{ id: "session-a", text: "compressed session text" }]);
    } finally {
      core.view.destroy();
      document.body.innerHTML = "";
    }
  });

  it("stores the document lead preview in metadata", () => {
    const metas = new Map();
    const host = document.createElement("div");
    host.dataset.panelId = "panel-a";
    document.body.appendChild(host);
    const plugin = createSessionAutoSavePlugin({
      zion: { state: { get: () => null } },
      getCurrentId: () => "session-a",
      loadMeta: (id) => metas.get(id) || {
        id,
        title: id,
        createdAt: 1,
        updatedAt: 1,
        size: 0,
        hash: ""
      },
      saveDoc: () => {},
      saveMeta: (id, meta) => metas.set(id, meta),
      hashString: (text) => `hash:${text}`,
      now: () => 2,
      getAnnotationsState: () => null,
      rebuildIndexFromTree: () => {},
      upsertIndexEntry: () => {},
      postSaved: () => {},
      onSaved: () => {}
    });
    const core = new EditorCore(host, "", "panel-a");
    core.addExternalExtension(plugin.extension);

    try {
      core.setValue([
        "user first question",
        "assistant first answer",
        "user latest question",
        "with more detail"
      ].join("\n"));
      expect(plugin.flush("session-a")).toBe(true);
      expect(metas.get("session-a").documentPreview).toBe("first question");
      expect(metas.get("session-a").documentPreviewVersion).toBe(1);
    } finally {
      core.view.destroy();
      document.body.innerHTML = "";
    }
  });

  it("commits within the maximum delay while edits keep arriving", () => {
    vi.useFakeTimers();
    const originalGetClientRects = globalThis.Range.prototype.getClientRects;
    Object.defineProperty(globalThis.Range.prototype, "getClientRects", {
      configurable: true,
      value: () => []
    });
    const saved = [];
    const host = document.createElement("div");
    host.dataset.panelId = "panel-a";
    document.body.appendChild(host);
    const plugin = createSessionAutoSavePlugin({
      zion: { state: { get: () => null } },
      getCurrentId: () => "session-a",
      loadMeta: (id) => ({ id, title: id, createdAt: 1, updatedAt: 1, size: 0, hash: "" }),
      saveDoc: (id, text) => saved.push({ id, text }),
      saveMeta: () => {},
      hashString: (text) => `hash:${text}`,
      now: () => 2,
      getAnnotationsState: () => null,
      rebuildIndexFromTree: () => {},
      upsertIndexEntry: () => {},
      postSaved: () => {},
      onSaved: () => {}
    });
    const core = new EditorCore(host, "start", "panel-a");
    core.addExternalExtension(plugin.extension);

    try {
      core.setValue("edit-1");
      vi.advanceTimersByTime(500);
      core.setValue("edit-2");
      vi.advanceTimersByTime(500);
      core.setValue("edit-3");
      vi.advanceTimersByTime(500);
      core.setValue("edit-4");
      vi.advanceTimersByTime(500);

      expect(saved).toEqual([{ id: "session-a", text: "edit-4" }]);
    } finally {
      core.view.destroy();
      document.body.innerHTML = "";
      if (originalGetClientRects) {
        Object.defineProperty(globalThis.Range.prototype, "getClientRects", {
          configurable: true,
          value: originalGetClientRects
        });
      } else {
        delete globalThis.Range.prototype.getClientRects;
      }
      vi.useRealTimers();
    }
  });

  it("waits for durable persistence when explicitly flushed", async () => {
    let resolveDocument;
    const documentPersisted = new Promise((resolve) => {
      resolveDocument = resolve;
    });
    const host = document.createElement("div");
    host.dataset.panelId = "panel-a";
    document.body.appendChild(host);
    const plugin = createSessionAutoSavePlugin({
      zion: { state: { get: () => null } },
      getCurrentId: () => "session-a",
      loadMeta: (id) => ({ id, title: id, createdAt: 1, updatedAt: 1, size: 0, hash: "" }),
      saveDoc: () => documentPersisted,
      saveMeta: () => Promise.resolve(true),
      hashString: (text) => `hash:${text}`,
      now: () => 2,
      getAnnotationsState: () => null,
      rebuildIndexFromTree: () => {},
      upsertIndexEntry: () => {},
      postSaved: () => {},
      onSaved: () => {}
    });
    const core = new EditorCore(host, "before", "panel-a");
    core.addExternalExtension(plugin.extension);

    try {
      core.setValue("after");
      let completed = false;
      const flushing = plugin.flushDurably("session-a").then((result) => {
        completed = true;
        return result;
      });
      await Promise.resolve();
      expect(completed).toBe(false);

      resolveDocument(true);
      await expect(flushing).resolves.toBe(true);
      expect(completed).toBe(true);
    } finally {
      core.view.destroy();
      document.body.innerHTML = "";
    }
  });
});
