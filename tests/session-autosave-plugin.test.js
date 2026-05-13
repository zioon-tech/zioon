import { describe, expect, it } from "vitest";
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
      coreA.setValue("a1");
      coreB.setValue("b1");

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
});
