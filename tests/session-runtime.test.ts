import { describe, expect, it } from "vitest";
import { SessionRuntime, type SessionPanelRecord } from "../src/session/runtime";
import { SessionDocumentRuntime } from "../src/session/document-runtime";

function createRuntime(seedPanels: SessionPanelRecord[]) {
  const panels = new Map(seedPanels.map((panel) => [panel.id, panel]));
  const emitted: Array<{ topic: string; payload: any }> = [];
  const switched: Array<{ id: string; panelId: string; previousSessionId: string | null; skipPersistPrevious?: boolean }> = [];
  let activePanelId = seedPanels[0]?.id || null;

  const runtime = new SessionRuntime({
    getActivePanelId: () => activePanelId,
    getPanel: (panelId) => panels.get(panelId) || null,
    listPanels: () => Array.from(panels.values()),
    getEditor: (panelId) => panels.get(panelId)?.editor || null,
    getActiveEditor: () => (activePanelId ? panels.get(activePanelId)?.editor || null : null),
    getGlobalSessionId: () => "global-session",
    focusPanel: (panelId) => {
      activePanelId = panelId;
    },
    activatePanelTab: (panelId, sessionId) => {
      const panel = panels.get(panelId);
      if (panel) panel.activeTabId = sessionId;
    },
    syncLegacyEditorTabsState: () => {},
    switchSessionDocument: (args) => {
      switched.push(args);
    },
    emit: (topic, payload) => {
      emitted.push({ topic, payload });
    }
  });

  return { runtime, panels, emitted, switched, get activePanelId() { return activePanelId; } };
}

describe("SessionRuntime", () => {
  it("resolves panel/session/editor context from explicit panel before global session", () => {
    const editor = { panelId: "panel-b" } as any;
    const { runtime } = createRuntime([
      { id: "panel-a", activeTabId: "session-a", tabs: [{ id: "session-a" }], editor: { panelId: "panel-a" } as any },
      { id: "panel-b", activeTabId: "session-b", tabs: [{ id: "session-b" }], editor }
    ]);

    expect(runtime.resolveContext({ panelId: "panel-b" })).toMatchObject({
      panelId: "panel-b",
      sessionId: "session-b",
      editor
    });
    expect(runtime.resolveContext({ editor })).toMatchObject({
      panelId: "panel-b",
      sessionId: "session-b",
      editor
    });
  });

  it("opens missing session tab and switches through core lifecycle hooks", async () => {
    const { runtime, panels, emitted, switched, activePanelId } = createRuntime([
      { id: "panel-a", activeTabId: "session-a", tabs: [{ id: "session-a" }], editor: { panelId: "panel-a" } as any }
    ]);

    await expect(runtime.openPanelSession("panel-a", "session-b")).resolves.toBe(true);

    expect(panels.get("panel-a")?.tabs.map((tab) => tab.id)).toEqual(["session-a", "session-b"]);
    expect(panels.get("panel-a")?.activeTabId).toBe("session-b");
    expect(activePanelId).toBe("panel-a");
    expect(switched).toEqual([
      { id: "session-b", panelId: "panel-a", previousSessionId: "session-a", skipPersistPrevious: undefined }
    ]);
    expect(emitted.map((entry) => entry.topic)).toEqual([
      "panel/tabsChanged",
      "session/beforeSwitch",
      "session/afterSwitch"
    ]);
    expect(emitted[0]?.payload).toEqual({ panelId: "panel-a", sessionId: "session-b" });
  });

  it("does not let stale rapid switches roll back the latest repeated target", async () => {
    const panels = new Map([
      ["panel-a", {
        id: "panel-a",
        activeTabId: "session-root",
        tabs: [{ id: "session-root" }],
        editor: { panelId: "panel-a" } as any
      }]
    ]);
    const pending: Array<{ id: string; resolve: (ok: boolean) => void }> = [];
    const emitted: string[] = [];
    const runtime = new SessionRuntime({
      getActivePanelId: () => "panel-a",
      getPanel: (panelId) => panels.get(panelId) || null,
      listPanels: () => Array.from(panels.values()),
      getEditor: (panelId) => panels.get(panelId)?.editor || null,
      activatePanelTab: (panelId, sessionId) => {
        const panel = panels.get(panelId);
        if (panel) panel.activeTabId = sessionId;
      },
      switchSessionDocument: ({ id }) => new Promise<boolean>((resolve) => {
        pending.push({ id, resolve });
      }),
      emit: (topic) => emitted.push(topic)
    });

    const first = runtime.openPanelSession("panel-a", "session-a");
    const second = runtime.openPanelSession("panel-a", "session-b");
    const latest = runtime.openPanelSession("panel-a", "session-a");

    expect(pending.map((item) => item.id)).toEqual(["session-a", "session-b", "session-a"]);
    expect(panels.get("panel-a")?.tabs.map((tab) => tab.id)).toEqual([
      "session-root",
      "session-a",
      "session-b"
    ]);

    pending[0].resolve(false);
    await expect(first).resolves.toBe(false);
    expect(panels.get("panel-a")?.activeTabId).toBe("session-a");

    pending[1].resolve(false);
    await expect(second).resolves.toBe(false);
    expect(panels.get("panel-a")?.activeTabId).toBe("session-a");

    pending[2].resolve(true);
    await expect(latest).resolves.toBe(true);
    expect(panels.get("panel-a")?.activeTabId).toBe("session-a");
    expect(emitted.filter((topic) => topic === "panel/tabsChanged")).toHaveLength(2);
    expect(emitted.filter((topic) => topic === "session/afterSwitch")).toHaveLength(1);
  });

  it("keeps a newly created session bound to the target panel before chat runs", async () => {
    const editor = { panelId: "panel-a" } as any;
    const { runtime, panels } = createRuntime([
      { id: "panel-a", activeTabId: "session-a", tabs: [{ id: "session-a" }], editor },
      { id: "panel-b", activeTabId: "session-b", tabs: [{ id: "session-b" }], editor: { panelId: "panel-b" } as any }
    ]);

    await expect(runtime.openPanelSession("panel-a", "new-session")).resolves.toBe(true);

    expect(runtime.resolveContext({ panelId: "panel-a" })).toMatchObject({
      panelId: "panel-a",
      sessionId: "new-session",
      editor
    });
    expect(runtime.isEditorShowingSession(editor, "new-session")).toBe(true);
    expect(panels.get("panel-b")?.activeTabId).toBe("session-b");
  });

  it("prefers editor-bound session identity over panel active tab", async () => {
    const editor = {
      panelId: "panel-a",
      sessionId: "hidden-session",
      setSessionId(id: string | null) {
        this.sessionId = id;
      }
    } as any;
    const { runtime } = createRuntime([
      { id: "panel-a", activeTabId: "visible-session", tabs: [{ id: "visible-session" }, { id: "hidden-session" }], editor }
    ]);

    expect(runtime.resolveContext({ editor })).toMatchObject({
      panelId: "panel-a",
      sessionId: "hidden-session",
      editor
    });
    expect(runtime.isEditorShowingSession(editor, "hidden-session")).toBe(true);
    expect(runtime.isEditorShowingSession(editor, "visible-session")).toBe(false);

    await expect(runtime.switchPanelSession("panel-a", "visible-session")).resolves.toBe(true);
    expect(editor.sessionId).toBe("visible-session");
  });

  it("does not reload the document when switching to the same session", async () => {
    const { runtime, emitted, switched } = createRuntime([
      { id: "panel-a", activeTabId: "session-a", tabs: [{ id: "session-a" }], editor: { panelId: "panel-a" } as any }
    ]);

    await expect(runtime.switchPanelSession("panel-a", "session-a")).resolves.toBe(true);

    expect(emitted).toEqual([]);
    expect(switched).toEqual([]);
  });

  it("can force reload when a newly created session was pre-activated by legacy state sync", async () => {
    const { runtime, emitted, switched } = createRuntime([
      { id: "panel-a", activeTabId: "session-new", tabs: [{ id: "session-new" }], editor: { panelId: "panel-a" } as any }
    ]);

    await expect(runtime.openPanelSession("panel-a", "session-new", { forceReload: true })).resolves.toBe(true);

    expect(switched).toEqual([
      { id: "session-new", panelId: "panel-a", previousSessionId: "session-new", skipPersistPrevious: undefined }
    ]);
    expect(emitted.map((entry) => entry.topic)).toEqual(["session/beforeSwitch", "session/afterSwitch"]);
  });

  it("emits afterSwitch only after document switch resolves", async () => {
    const panels = new Map([
      ["panel-a", { id: "panel-a", activeTabId: "session-a", tabs: [{ id: "session-a" }], editor: { panelId: "panel-a" } as any }]
    ]);
    const order: string[] = [];
    let resolveDocSwitch!: () => void;
    const runtime = new SessionRuntime({
      getActivePanelId: () => "panel-a",
      getPanel: (panelId) => panels.get(panelId) || null,
      listPanels: () => Array.from(panels.values()),
      getEditor: (panelId) => panels.get(panelId)?.editor || null,
      activatePanelTab: (panelId, sessionId) => {
        const panel = panels.get(panelId);
        if (panel) panel.activeTabId = sessionId;
      },
      switchSessionDocument: () => new Promise<void>((resolve) => {
        order.push("document:start");
        resolveDocSwitch = () => {
          order.push("document:done");
          resolve();
        };
      }),
      emit: (topic) => order.push(topic)
    });

    const switching = runtime.switchPanelSession("panel-a", "session-b");
    await Promise.resolve();
    expect(order).toEqual(["session/beforeSwitch", "document:start"]);
    resolveDocSwitch();
    await expect(switching).resolves.toBe(true);
    expect(order).toEqual(["session/beforeSwitch", "document:start", "document:done", "session/afterSwitch"]);
  });

  it("restores the previous tab and editor slot when the latest document switch fails", async () => {
    const panels = new Map([
      ["panel-a", { id: "panel-a", activeTabId: "session-a", tabs: [{ id: "session-a" }, { id: "session-b" }], editor: { panelId: "panel-a" } as any }]
    ]);
    const emitted: string[] = [];
    const restored: string[] = [];
    const runtime = new SessionRuntime({
      getActivePanelId: () => "panel-a",
      getPanel: (panelId) => panels.get(panelId) || null,
      listPanels: () => Array.from(panels.values()),
      getEditor: (panelId) => panels.get(panelId)?.editor || null,
      activatePanelTab: (panelId, sessionId) => {
        const panel = panels.get(panelId);
        if (panel) panel.activeTabId = sessionId;
      },
      restorePanelSession: (panelId, sessionId) => {
        restored.push(sessionId);
        const panel = panels.get(panelId);
        if (panel) panel.activeTabId = sessionId;
        return true;
      },
      syncLegacyEditorTabsState: () => {},
      switchSessionDocument: () => false,
      emit: (topic) => emitted.push(topic)
    });

    await expect(runtime.switchPanelSession("panel-a", "session-b")).resolves.toBe(false);

    expect(panels.get("panel-a")?.activeTabId).toBe("session-a");
    expect(restored).toEqual(["session-a"]);
    expect(emitted).toEqual(["session/beforeSwitch"]);
  });

  it("does not bind or clear the editor when document loading fails", async () => {
    const editor: { sessionId: string | null; value: string; setSessionId(id: string | null): void; setValue(next: string): void } = {
      sessionId: "session-a",
      value: "existing text",
      setSessionId(id: string | null) {
        this.sessionId = id;
      },
      setValue(next: string) {
        this.value = next;
      }
    };
    let globalSessionId = "session-a";
    let afterSwitch = 0;
    const runtime = new SessionDocumentRuntime({
      getGlobalSessionId: () => globalSessionId,
      getPanelSessionId: () => "session-b",
      setGlobalSessionId: (id) => {
        globalSessionId = id;
      },
      getTargetEditor: () => editor as any,
      persistPreviousSession: () => {},
      setLastActiveId: () => {},
      loadDocument: async () => {
        throw new Error("load failed");
      },
      applyAnnotations: () => {
        throw new Error("should not restore annotations");
      },
      afterSwitch: () => {
        afterSwitch += 1;
      }
    });

    await expect(runtime.switchSession({ id: "session-b", panelId: "panel-a" })).resolves.toBe(false);

    expect(editor.sessionId).toBe("session-a");
    expect(editor.value).toBe("existing text");
    expect(globalSessionId).toBe("session-a");
    expect(afterSwitch).toBe(0);
  });
});
