import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorCore } from "../src/editor/EditorCore";
import { attachEditor } from "../src/ext/registry";
import { SessionSync } from "../src/panel/SessionSync";
import { createChatAnnotationsApi } from "../src/chat/annotations";
import { installToolCallCards } from "../extensions/dev.tools/tool-calls.js";
import { installThinkingCards } from "../extensions/dev.thinking/thinking-cards.js";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

type PanelHarness = {
  panels: Array<{ id: string; activeTabId: string | null }>;
  cores: Map<string, EditorCore>;
  editors: Map<string, any>;
  sync: SessionSync;
  annotations: ReturnType<typeof createChatAnnotationsApi>;
  dispose(): void;
};

function createHarness(panelSessions: Record<string, string | null>, initialText: string): PanelHarness {
  (globalThis as any).fetch = vi.fn(() => Promise.resolve({ ok: true }));
  const panels = Object.entries(panelSessions).map(([id, activeTabId]) => ({ id, activeTabId }));
  const cores = new Map<string, EditorCore>();
  const editors = new Map<string, any>();

  document.body.innerHTML = "";
  for (const panel of panels) {
    const host = document.createElement("div");
    host.dataset.panelId = panel.id;
    document.body.appendChild(host);
    const core = new EditorCore(host, initialText, panel.id);
    core.setSessionId(panel.activeTabId);
    const editor = attachEditor(core, panel.id);
    cores.set(panel.id, core);
    editors.set(panel.id, editor);
  }

  let activePanelId = panels[0]?.id || null;
  const panelManager = {
    getActivePanelId: () => activePanelId,
    getPanel: (panelId: string) => panels.find((panel) => panel.id === panelId) || null,
    getEditor: (panelId: string) => editors.get(panelId) || null,
    listPanels: () => panels
  };
  (window.zion as any).panelManager = panelManager;
  window.zion.panels = {
    getActivePanelId: () => activePanelId,
    list: () => panels,
    getEditor: (panelId: string) => editors.get(panelId) || null,
    focus: (panelId: string) => {
      activePanelId = panelId;
      return true;
    }
  } as any;

  window.zion.state.set("chat.thinkingVisible", true);
  window.zion.state.set("sessions.currentId", panels[0]?.activeTabId || null);

  const sync = new SessionSync({
    events: window.zion.events,
    getActivePanelId: () => activePanelId,
    listPanels: () => panels,
    getEditor: (panelId) => editors.get(panelId) || null
  });
  const annotations = createChatAnnotationsApi({
    state: window.zion.state,
    events: window.zion.events,
    commands: window.zion.commands,
    getActivePanelId: () => activePanelId
  });
  for (const core of cores.values()) {
    core.addExternalExtension(installToolCallCards());
    core.addExternalExtension(installThinkingCards());
  }

  return {
    panels,
    cores,
    editors,
    sync,
    annotations,
    dispose() {
      annotations.dispose();
      sync.dispose();
      for (const core of cores.values()) {
        try { core.view.destroy(); } catch {}
      }
      document.body.innerHTML = "";
    }
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("chat cards DOM lifecycle", () => {
  it("restores historical tool and thinking widgets into split panels for the same session", async () => {
    const text = ["user hi", "assistant ", "调用 read", "", "思考", ""].join("\n");
    const h = createHarness({ "panel-a": "session-1", "panel-b": "session-1" }, text);
    try {
      window.zion.commands.executeCommand("zion.chatCards.setSessionAnnotations", {
        sessionId: "session-1",
        annotations: {
          tools: [{ id: "tool-1", name: "read", args: { path: "a.txt" }, expanded: false }],
          thinking: [{ id: "thinking:run-1:1", text: "reasoning", expanded: false }]
        }
      });

      window.zion.commands.executeCommand("zion.chatCards.restoreSession", {
        sessionId: "session-1",
        panelId: "panel-a"
      });
      window.zion.commands.executeCommand("zion.chatCards.restoreSession", {
        sessionId: "session-1",
        panelId: "panel-b"
      });
      await wait(50);

      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(1);
      expect(h.cores.get("panel-b")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(1);
      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-thinking-inline").length).toBe(1);
      expect(h.cores.get("panel-b")!.view.dom.querySelectorAll(".zion-thinking-inline").length).toBe(1);
    } finally {
      h.dispose();
    }
  });

  it("mirrors live tool and thinking widgets to another panel showing the same session", async () => {
    const h = createHarness({ "panel-a": "session-1", "panel-b": "session-1" }, "user hi\nassistant \n");
    try {
      window.zion.events.emit("chat/runStarted", { sessionId: "session-1", panelId: "panel-a", runId: "run-1" });
      window.zion.events.emit("chat/toolCall", {
        sessionId: "session-1",
        panelId: "panel-a",
        runId: "run-1",
        toolCall: { id: "tool-live", name: "read", args: { path: "live.txt" } }
      });
      window.zion.events.emit("chat/reasoningStart", { sessionId: "session-1", panelId: "panel-a", runId: "run-1" });
      window.zion.events.emit("chat/reasoningToken", { sessionId: "session-1", panelId: "panel-a", runId: "run-1", token: "thinking" });
      window.zion.events.emit("chat/reasoningEnd", { sessionId: "session-1", panelId: "panel-a", runId: "run-1" });
      await wait(380);

      expect(h.editors.get("panel-b")!.getValue()).toBe(h.editors.get("panel-a")!.getValue());
      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(1);
      expect(h.cores.get("panel-b")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(1);
      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-thinking-inline").length).toBe(1);
      expect(h.cores.get("panel-b")!.view.dom.querySelectorAll(".zion-thinking-inline").length).toBe(1);
    } finally {
      h.dispose();
    }
  });

  it("restores mirrored tool widgets after session-load text sync without marking them deleted", async () => {
    const h = createHarness({ "panel-a": "session-1", "panel-b": "session-1" }, "user hi\nassistant \n");
    try {
      window.zion.events.emit("chat/toolCall", {
        sessionId: "session-1",
        panelId: "panel-a",
        toolCall: { id: "tool-sync", name: "read", args: { path: "sync.txt" } }
      });
      await wait(120);

      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(1);
      expect(h.cores.get("panel-b")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(1);

      const syncedText = h.editors.get("panel-a")!.getValue();
      h.cores.get("panel-b")!.setValue(syncedText, { source: "session-load" });
      await wait(20);

      expect(h.cores.get("panel-b")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(0);

      window.zion.events.emit("toolcards/toolsUpdated", { sessionId: "session-1" });
      await wait(80);

      const ann = window.zion.commands.executeCommand("zion.chatCards.getSessionAnnotations", "session-1");
      expect(Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds : []).not.toContain("tool-sync");
      expect(h.cores.get("panel-b")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(1);
    } finally {
      h.dispose();
    }
  });

  it("restores mirrored thinking widgets after session-load text sync without clearing annotations", async () => {
    const h = createHarness({ "panel-a": "session-1", "panel-b": "session-1" }, "user hi\nassistant \n");
    try {
      window.zion.events.emit("chat/runStarted", { sessionId: "session-1", panelId: "panel-a", runId: "run-thinking-sync" });
      window.zion.events.emit("chat/reasoningStart", { sessionId: "session-1", panelId: "panel-a", runId: "run-thinking-sync" });
      window.zion.events.emit("chat/reasoningToken", { sessionId: "session-1", panelId: "panel-a", runId: "run-thinking-sync", token: "thinking" });
      window.zion.events.emit("chat/reasoningEnd", { sessionId: "session-1", panelId: "panel-a", runId: "run-thinking-sync" });
      await wait(160);

      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-thinking-inline").length).toBe(1);
      expect(h.cores.get("panel-b")!.view.dom.querySelectorAll(".zion-thinking-inline").length).toBe(1);

      const syncedText = h.editors.get("panel-a")!.getValue();
      h.cores.get("panel-b")!.setValue(syncedText, { source: "session-load" });
      await wait(80);

      const ann = window.zion.commands.executeCommand("zion.chatCards.getSessionAnnotations", "session-1");
      expect(Array.isArray(ann.thinking) ? ann.thinking.length : 0).toBeGreaterThan(0);
      expect(h.cores.get("panel-b")!.view.dom.querySelectorAll(".zion-thinking-inline").length).toBe(1);
    } finally {
      h.dispose();
    }
  });

  it("does not sync text or annotations into panels showing a different session", async () => {
    const h = createHarness({ "panel-a": "session-1", "panel-b": "session-2" }, "user hi\nassistant \n");
    try {
      const beforeB = h.editors.get("panel-b")!.getValue();
      window.zion.events.emit("chat/toolCall", {
        sessionId: "session-1",
        panelId: "panel-a",
        toolCall: { id: "tool-session-1", name: "read", args: {} }
      });
      await wait(100);

      expect(h.editors.get("panel-b")!.getValue()).toBe(beforeB);
      expect(h.cores.get("panel-b")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(0);
      expect(window.zion.commands.executeCommand("zion.chatCards.getSessionAnnotations", "session-2").tools).toEqual([]);
    } finally {
      h.dispose();
    }
  });

  it("does not attach widgets to an editor view without a bound session id", async () => {
    const h = createHarness({ "panel-a": "session-1" }, "user hi\nassistant \n");
    try {
      h.cores.get("panel-a")!.setSessionId(null);
      window.zion.events.emit("chat/toolCall", {
        sessionId: "session-1",
        panelId: "panel-a",
        toolCall: { id: "tool-unbound", name: "read", args: {} }
      });
      window.zion.events.emit("chat/reasoningStart", { sessionId: "session-1", panelId: "panel-a", runId: "run-unbound" });
      window.zion.events.emit("chat/reasoningToken", { sessionId: "session-1", panelId: "panel-a", runId: "run-unbound", token: "thinking" });
      await wait(80);

      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(0);
      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-thinking-inline").length).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("defers widget restore on empty session-loaded views instead of inserting marker-only docs", async () => {
    const h = createHarness({ "panel-a": "session-1" }, "");
    try {
      window.zion.commands.executeCommand("zion.chatCards.setSessionAnnotations", {
        sessionId: "session-1",
        annotations: {
          tools: [{ id: "tool-empty-restore", name: "read", args: {}, expanded: false }],
          thinking: [{ id: "thinking-empty-restore", text: "reasoning", expanded: false }]
        }
      });

      window.zion.commands.executeCommand("zion.chatCards.restoreSession", {
        sessionId: "session-1",
        panelId: "panel-a"
      });
      await wait(80);

      expect(h.editors.get("panel-a")!.getValue()).toBe("");
      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(0);
      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-thinking-inline").length).toBe(0);
    } finally {
      h.dispose();
    }
  });
});
