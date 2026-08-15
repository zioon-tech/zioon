import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorCore } from "../src/editor/EditorCore";
import { attachEditor } from "../src/ext/registry";
import { SessionSync } from "../src/panel/SessionSync";
import { createChatAnnotationsApi } from "../src/chat/annotations";
import { createToolCardId } from "../src/chat/tool-card-id";
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
  for (const sessionId of ["session-1", "session-2"]) {
    try {
      window.zion?.state?.set?.(`sessions.annotations.${sessionId}`, {
        tools: [],
        thinking: [],
        deletedToolIds: [],
        deletedThinkingIds: [],
        toolActions: {}
      });
      window.zion?.state?.set?.(`sessions.pendingRestore.tools.${sessionId}`, []);
      window.zion?.state?.set?.(`sessions.pendingRestore.thinking.${sessionId}`, []);
      window.zion?.state?.set?.(`sessions.widgets.tools.${sessionId}`, { ids: [], count: 0, stamp: Date.now() });
      window.zion?.state?.set?.(`sessions.widgets.thinking.${sessionId}`, { ids: [], count: 0, stamp: Date.now() });
    } catch {}
  }
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
        expect(h.editors.get("panel-a")!.getValue()).toContain("思考 <!-- zion-thinking:id=thinking:run-1:1 -->");
        expect(h.editors.get("panel-a")!.getValue()).toContain("调用 read <!-- zion-tool:id=tool-1 -->");
        expect(h.editors.get("panel-b")!.getValue()).toContain("思考 <!-- zion-thinking:id=thinking:run-1:1 -->");
        expect(h.editors.get("panel-b")!.getValue()).toContain("调用 read <!-- zion-tool:id=tool-1 -->");
    } finally {
      h.dispose();
    }
  });

  it("mirrors live tool and thinking widgets to another panel showing the same session", async () => {
    const assistantBlockId = "run-1";
    const h = createHarness(
      { "panel-a": "session-1", "panel-b": "session-1" },
      `user hi\nassistant <!-- zion-assistant:id=${assistantBlockId} --> \n`
    );
    try {
      window.zion.events.emit("chat/runStarted", { sessionId: "session-1", panelId: "panel-a", runId: "run-1", assistantBlockId });
      window.zion.events.emit("chat/toolCall", {
        sessionId: "session-1",
        panelId: "panel-a",
        runId: "run-1",
        assistantBlockId,
        toolCall: { id: "tool-live", name: "read", args: { path: "live.txt" } }
      });
      window.zion.events.emit("chat/reasoningStart", { sessionId: "session-1", panelId: "panel-a", runId: "run-1", assistantBlockId });
      window.zion.events.emit("chat/reasoningToken", { sessionId: "session-1", panelId: "panel-a", runId: "run-1", assistantBlockId, token: "thinking" });
      window.zion.events.emit("chat/reasoningEnd", { sessionId: "session-1", panelId: "panel-a", runId: "run-1", assistantBlockId });
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

  it("ignores late tool and reasoning events from an interrupted run after a new run starts", async () => {
    const initial = [
      "user old",
      "assistant <!-- zion-assistant:id=run-old --> ",
      "user new",
      "assistant <!-- zion-assistant:id=run-new --> ",
      ""
    ].join("\n");
    const h = createHarness({ "panel-a": "session-1" }, initial);
    try {
      window.zion.events.emit("chat/runStarted", {
        sessionId: "session-1",
        panelId: "panel-a",
        runId: "run-old",
        assistantBlockId: "run-old"
      });
      window.zion.events.emit("chat/aborted", {
        sessionId: "session-1",
        panelId: "panel-a",
        runId: "run-old"
      });
      window.zion.events.emit("chat/runStarted", {
        sessionId: "session-1",
        panelId: "panel-a",
        runId: "run-new",
        assistantBlockId: "run-new"
      });

      window.zion.events.emit("chat/toolCall", {
        sessionId: "session-1",
        panelId: "panel-a",
        runId: "run-old",
        assistantBlockId: "run-old",
        toolCall: { id: "late-tool", name: "read", args: { path: "old.txt" } }
      });
      window.zion.events.emit("chat/reasoningStart", {
        sessionId: "session-1",
        panelId: "panel-a",
        runId: "run-old",
        assistantBlockId: "run-old"
      });
      window.zion.events.emit("chat/reasoningToken", {
        sessionId: "session-1",
        panelId: "panel-a",
        runId: "run-old",
        assistantBlockId: "run-old",
        token: "late reasoning"
      });
      await wait(100);

      expect(h.editors.get("panel-a")!.getValue()).toBe(initial);
      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-tool-call-inline")).toHaveLength(0);
      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-thinking-inline")).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });

  it("keeps reused provider tool ids attached to their own assistant turns", async () => {
    const initial = [
      "user first",
      "assistant <!-- zion-assistant:id=run-1 --> first answer",
      "user second",
      "assistant <!-- zion-assistant:id=run-2 --> second answer"
    ].join("\n");
    const h = createHarness({ "panel-a": "session-1" }, initial);
    try {
      const emitTool = (runId: string, result: string) => {
        const toolCallId = "call-1";
        const cardId = createToolCardId(runId, toolCallId);
        window.zion.events.emit("chat/runStarted", {
          sessionId: "session-1",
          panelId: "panel-a",
          runId,
          assistantBlockId: runId
        });
        window.zion.events.emit("chat/toolCall", {
          sessionId: "session-1",
          panelId: "panel-a",
          runId,
          cardId,
          assistantBlockId: runId,
          toolCall: { id: toolCallId, cardId, name: "read", args: { path: `${runId}.txt` } }
        });
        window.zion.events.emit("chat/toolResult", {
          sessionId: "session-1",
          panelId: "panel-a",
          runId,
          cardId,
          toolCallId,
          result,
          ok: true
        });
        window.zion.events.emit("chat/runFinished", { sessionId: "session-1", panelId: "panel-a", runId });
        return cardId;
      };

      const firstCardId = emitTool("run-1", "first result");
      const secondCardId = emitTool("run-2", "second result");
      await wait(80);

      const value = h.editors.get("panel-a")!.getValue();
      const firstMarker = `调用 read <!-- zion-tool:id=${firstCardId} -->`;
      const secondMarker = `调用 read <!-- zion-tool:id=${secondCardId} -->`;
      expect(value.indexOf("run-1 --> first answer")).toBeLessThan(value.indexOf(firstMarker));
      expect(value.indexOf(firstMarker)).toBeLessThan(value.indexOf("user second"));
      expect(value.indexOf("run-2 --> second answer")).toBeLessThan(value.indexOf(secondMarker));
      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(2);

      const annotations = window.zion.commands.executeCommand("zion.chatCards.getSessionAnnotations", "session-1");
      expect(annotations.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: firstCardId, toolCallId: "call-1", result: "first result" }),
        expect.objectContaining({ id: secondCardId, toolCallId: "call-1", result: "second result" })
      ]));
    } finally {
      h.dispose();
    }
  });

  it("keeps a tool on its parent assistant after the user clicks an older answer", async () => {
    const initial = [
      "user first",
      "assistant <!-- zion-assistant:id=run-old --> old answer",
      "user second",
      "assistant <!-- zion-assistant:id=run-new --> new answer"
    ].join("\n");
    const h = createHarness({ "panel-a": "session-1" }, initial);
    try {
      const view = h.cores.get("panel-a")!.view;
      const oldAnswerPos = initial.indexOf("old answer");
      window.zion.events.emit("chat/runStarted", {
        sessionId: "session-1",
        panelId: "panel-a",
        runId: "run-new",
        assistantBlockId: "run-new"
      });
      view.dispatch({ selection: { anchor: oldAnswerPos } });
      window.zion.events.emit("chat/toolCall", {
        sessionId: "session-1",
        panelId: "panel-a",
        runId: "run-new",
        assistantBlockId: "run-new",
        toolCall: { id: "call-after-click", name: "read", args: { path: "new.txt" } }
      });
      await wait(80);

      const value = h.editors.get("panel-a")!.getValue();
      const marker = `调用 read <!-- zion-tool:id=${createToolCardId("run-new", "call-after-click")} -->`;
      expect(value.indexOf(marker)).toBeGreaterThan(value.indexOf("run-new --> new answer"));
      expect(value.indexOf(marker)).toBeGreaterThan(value.indexOf("user second"));
    } finally {
      h.dispose();
    }
  });

  it("restores mirrored tool widgets after session-load text sync without marking them deleted", async () => {
    const assistantBlockId = "run-tool-sync";
    const h = createHarness(
      { "panel-a": "session-1", "panel-b": "session-1" },
      `user hi\nassistant <!-- zion-assistant:id=${assistantBlockId} --> \n`
    );
    try {
      window.zion.events.emit("chat/toolCall", {
        sessionId: "session-1",
        panelId: "panel-a",
        runId: assistantBlockId,
        assistantBlockId,
        toolCall: { id: "tool-sync", name: "read", args: { path: "sync.txt" } }
      });
      await wait(120);

      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(1);
      expect(h.cores.get("panel-b")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(1);

      const syncedText = h.editors.get("panel-a")!.getValue();
      h.cores.get("panel-b")!.setValue(syncedText, { source: "session-load" });
      await wait(20);

      expect(h.cores.get("panel-b")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(1);

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
    const assistantBlockId = "run-thinking-sync";
    const h = createHarness(
      { "panel-a": "session-1", "panel-b": "session-1" },
      `user hi\nassistant <!-- zion-assistant:id=${assistantBlockId} --> \n`
    );
    try {
      window.zion.events.emit("chat/runStarted", { sessionId: "session-1", panelId: "panel-a", runId: assistantBlockId, assistantBlockId });
      window.zion.events.emit("chat/reasoningStart", { sessionId: "session-1", panelId: "panel-a", runId: assistantBlockId, assistantBlockId });
      window.zion.events.emit("chat/reasoningToken", { sessionId: "session-1", panelId: "panel-a", runId: assistantBlockId, assistantBlockId, token: "thinking" });
      window.zion.events.emit("chat/reasoningEnd", { sessionId: "session-1", panelId: "panel-a", runId: assistantBlockId, assistantBlockId });
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

  it("restores id-backed card anchors even when annotations are missing entries", async () => {
    const text = [
      "user hi",
      "assistant ",
      "思考 <!-- zion-thinking:id=thinking:run-missing:1 -->",
      "调用 read <!-- zion-tool:id=tool-missing-1 -->",
      "思考 <!-- zion-thinking:id=thinking:run-missing:2 -->",
      "调用 webFetch <!-- zion-tool:id=tool-missing-2 -->",
      ""
    ].join("\n");
    const h = createHarness({ "panel-a": "session-1" }, text);
    try {
      window.zion.commands.executeCommand("zion.chatCards.setSessionAnnotations", {
        sessionId: "session-1",
        annotations: {
          thinking: [{ id: "thinking:run-missing:1", text: "known", expanded: false }],
          tools: [{ id: "tool-missing-1", name: "read", args: { path: "a.txt" }, expanded: false }]
        }
      });

      window.zion.commands.executeCommand("zion.chatCards.restoreSession", {
        sessionId: "session-1",
        panelId: "panel-a"
      });
      await wait(80);

      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-thinking-inline").length).toBe(2);
      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(2);

      const ann = window.zion.commands.executeCommand("zion.chatCards.getSessionAnnotations", "session-1");
      expect((ann.thinking || []).map((it: any) => it.id).sort()).toEqual([
        "thinking:run-missing:1",
        "thinking:run-missing:2"
      ]);
      expect((ann.tools || []).map((it: any) => it.id).sort()).toEqual([
        "tool-missing-1",
        "tool-missing-2"
      ]);
      expect((ann.tools || []).find((it: any) => it.id === "tool-missing-2")?.name).toBe("webFetch");
    } finally {
      h.dispose();
    }
  });

  it("repairs duplicate thinking anchor ids before restoring widgets", async () => {
    const text = [
      "user hi",
      "assistant ",
      "思考 <!-- zion-thinking:id=thinking:dup-run:1 -->",
      "some answer",
      "思考 <!-- zion-thinking:id=thinking:dup-run:1 -->",
      ""
    ].join("\n");
    const h = createHarness({ "panel-a": "session-1" }, text);
    try {
      window.zion.commands.executeCommand("zion.chatCards.setSessionAnnotations", {
        sessionId: "session-1",
        annotations: {
          thinking: [{ id: "thinking:dup-run:1", text: "known", expanded: false }]
        }
      });

      window.zion.commands.executeCommand("zion.chatCards.restoreSession", {
        sessionId: "session-1",
        panelId: "panel-a"
      });
      await wait(80);

      const value = h.editors.get("panel-a")!.getValue();
      expect(value).toContain("思考 <!-- zion-thinking:id=thinking:dup-run:1 -->");
      expect(value).toContain("思考 <!-- zion-thinking:id=thinking:dup-run:1:dup2 -->");
      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-thinking-inline").length).toBe(2);

      const ann = window.zion.commands.executeCommand("zion.chatCards.getSessionAnnotations", "session-1");
      expect((ann.thinking || []).map((it: any) => it.id).sort()).toEqual([
        "thinking:dup-run:1",
        "thinking:dup-run:1:dup2"
      ]);
    } finally {
      h.dispose();
    }
  });

  it("does not sync text or annotations into panels showing a different session", async () => {
    const assistantBlockId = "run-session-1";
    const h = createHarness(
      { "panel-a": "session-1", "panel-b": "session-2" },
      `user hi\nassistant <!-- zion-assistant:id=${assistantBlockId} --> \n`
    );
    try {
      const beforeB = h.editors.get("panel-b")!.getValue();
      window.zion.events.emit("chat/toolCall", {
        sessionId: "session-1",
        panelId: "panel-a",
        runId: assistantBlockId,
        assistantBlockId,
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
    const assistantBlockId = "run-unbound";
    const h = createHarness(
      { "panel-a": "session-1" },
      `user hi\nassistant <!-- zion-assistant:id=${assistantBlockId} --> \n`
    );
    try {
      h.cores.get("panel-a")!.setSessionId(null);
      window.zion.events.emit("chat/toolCall", {
        sessionId: "session-1",
        panelId: "panel-a",
        runId: assistantBlockId,
        assistantBlockId,
        toolCall: { id: "tool-unbound", name: "read", args: {} }
      });
      window.zion.events.emit("chat/reasoningStart", { sessionId: "session-1", panelId: "panel-a", runId: assistantBlockId, assistantBlockId });
      window.zion.events.emit("chat/reasoningToken", { sessionId: "session-1", panelId: "panel-a", runId: assistantBlockId, assistantBlockId, token: "thinking" });
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

  it("keeps orphan card annotations pending instead of guessing a parent assistant", async () => {
    const initial = [
      "user hi",
      "assistant <!-- zion-assistant:id=run-existing --> answer"
    ].join("\n");
    const h = createHarness({ "panel-a": "session-1" }, initial);
    try {
      window.zion.commands.executeCommand("zion.chatCards.setSessionAnnotations", {
        sessionId: "session-1",
        annotations: {
          tools: [{
            id: "orphan-tool",
            name: "read",
            args: { path: "missing.txt" },
            assistantBlockId: "missing-run",
            expanded: false
          }]
        }
      });

      window.zion.commands.executeCommand("zion.chatCards.restoreSession", {
        sessionId: "session-1",
        panelId: "panel-a"
      });
      await wait(80);

      expect(h.editors.get("panel-a")!.getValue()).toBe(initial);
      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-tool-call-inline").length).toBe(0);
      const pending = window.zion.commands.executeCommand("zion.chatCards.getPendingRestore", {
        sessionId: "session-1",
        kind: "tools"
      });
      expect(pending).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "orphan-tool", assistantBlockId: "missing-run" })
      ]));
    } finally {
      h.dispose();
    }
  });

  it("keeps markers moved under a different assistant hidden and pending", async () => {
    const initial = [
      "user old",
      "assistant <!-- zion-assistant:id=run-old --> old answer",
      "user new",
      "assistant <!-- zion-assistant:id=run-new --> new answer",
      "调用 read <!-- zion-tool:id=tool-moved -->",
      "思考 <!-- zion-thinking:id=thinking:moved:1 -->",
      ""
    ].join("\n");
    const h = createHarness({ "panel-a": "session-1" }, initial);
    try {
      window.zion.commands.executeCommand("zion.chatCards.setSessionAnnotations", {
        sessionId: "session-1",
        annotations: {
          tools: [{
            id: "tool-moved",
            name: "read",
            args: {},
            assistantBlockId: "run-old"
          }],
          thinking: [{
            id: "thinking:moved:1",
            runId: "run-old",
            text: "moved",
            assistantBlockId: "run-old"
          }]
        }
      });

      window.zion.commands.executeCommand("zion.chatCards.restoreSession", {
        sessionId: "session-1",
        panelId: "panel-a"
      });
      await wait(100);

      expect(h.editors.get("panel-a")!.getValue()).toBe(initial);
      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-tool-call-inline")).toHaveLength(0);
      expect(h.cores.get("panel-a")!.view.dom.querySelectorAll(".zion-thinking-inline")).toHaveLength(0);
      expect(window.zion.commands.executeCommand("zion.chatCards.getPendingRestore", {
        sessionId: "session-1",
        kind: "tools"
      })).toEqual([expect.objectContaining({ id: "tool-moved", assistantBlockId: "run-old" })]);
      expect(window.zion.commands.executeCommand("zion.chatCards.getPendingRestore", {
        sessionId: "session-1",
        kind: "thinking"
      })).toEqual([expect.objectContaining({ id: "thinking:moved:1", assistantBlockId: "run-old" })]);
    } finally {
      h.dispose();
    }
  });
});
