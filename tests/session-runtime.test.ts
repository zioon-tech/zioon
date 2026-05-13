import { describe, expect, it } from "vitest";
import { SessionRuntime, type SessionPanelRecord } from "../src/session/runtime";

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
    expect(emitted.map((entry) => entry.topic)).toEqual(["session/beforeSwitch", "session/afterSwitch"]);
  });

  it("does not snapshot previous session when switching to the same session", async () => {
    const { runtime, emitted, switched } = createRuntime([
      { id: "panel-a", activeTabId: "session-a", tabs: [{ id: "session-a" }], editor: { panelId: "panel-a" } as any }
    ]);

    await expect(runtime.switchPanelSession("panel-a", "session-a")).resolves.toBe(true);

    expect(emitted.map((entry) => entry.topic)).toEqual(["session/beforeSwitch", "session/afterSwitch"]);
    expect(switched).toEqual([
      { id: "session-a", panelId: "panel-a", previousSessionId: "session-a", skipPersistPrevious: undefined }
    ]);
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
});
