import { describe, expect, it } from "vitest";
import { SessionSync } from "../src/panel/SessionSync";

function createEvents() {
  const handlers = new Map<string, Set<(payload?: any) => void>>();
  return {
    emit(topic: string, payload?: any) {
      handlers.get(topic)?.forEach((fn) => fn(payload));
    },
    on(topic: string, fn: (payload?: any) => void) {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(fn);
      return { dispose: () => handlers.get(topic)?.delete(fn) };
    }
  };
}

function createEditor(text: string) {
  let value = text;
  return {
    getValue: () => value,
    setValue: (next: string) => {
      value = next;
    },
    getView: () => null
  };
}

function createViewEditor(text: string, sessionId: string) {
  let value = text;
  const view = {
    dom: {
      getAttribute: (name: string) => name === "data-session-id" ? sessionId : null
    },
    state: {
      doc: {
        toString: () => value
      }
    },
    dispatch: ({ changes }: any) => {
      value = `${value.slice(0, changes.from)}${changes.insert}${value.slice(changes.to)}`;
    }
  };
  return {
    getValue: () => value,
    setValue: (next: string) => {
      value = next;
    },
    getView: () => view
  };
}

describe("SessionSync", () => {
  it("syncs editor text only to panels that are showing the same session", () => {
    const events = createEvents();
    const editors = new Map([
      ["panel-a", createEditor("before")],
      ["panel-b", createEditor("before")],
      ["panel-c", createEditor("other")]
    ]);
    const panels = [
      { id: "panel-a", activeTabId: "session-1" },
      { id: "panel-b", activeTabId: "session-1" },
      { id: "panel-c", activeTabId: "session-2" }
    ];

    const sync = new SessionSync({
      events,
      getActivePanelId: () => "panel-a",
      listPanels: () => panels,
      getEditor: (panelId) => editors.get(panelId) as any
    });

    editors.get("panel-a")!.setValue("after");
    events.emit("editor.change", { panelId: "panel-a" });

    expect(editors.get("panel-b")!.getValue()).toBe("after");
    expect(editors.get("panel-c")!.getValue()).toBe("other");
    sync.dispose();
  });

  it("does not fall back to the active panel when the changed panel has no active session", () => {
    const events = createEvents();
    const editors = new Map([
      ["panel-a", createEditor("active")],
      ["panel-empty", createEditor("empty changed")],
      ["panel-peer", createEditor("peer")]
    ]);
    const panels = [
      { id: "panel-a", activeTabId: "session-1" },
      { id: "panel-empty", activeTabId: null },
      { id: "panel-peer", activeTabId: "session-1" }
    ];

    const sync = new SessionSync({
      events,
      getActivePanelId: () => "panel-a",
      listPanels: () => panels,
      getEditor: (panelId) => editors.get(panelId) as any
    });

    events.emit("editor.change", { panelId: "panel-empty" });

    expect(editors.get("panel-a")!.getValue()).toBe("active");
    expect(editors.get("panel-peer")!.getValue()).toBe("peer");
    sync.dispose();
  });

  it("does not mirror session-load setValue document loads", () => {
    const events = createEvents();
    const editors = new Map([
      ["panel-a", createEditor("loaded from storage")],
      ["panel-b", createEditor("existing peer text")]
    ]);
    const panels = [
      { id: "panel-a", activeTabId: "session-1" },
      { id: "panel-b", activeTabId: "session-1" }
    ];

    const sync = new SessionSync({
      events,
      getActivePanelId: () => "panel-a",
      listPanels: () => panels,
      getEditor: (panelId) => editors.get(panelId) as any
    });

    events.emit("editor.change", {
      panelId: "panel-a",
      update: {
        transactions: [{ annotation: () => "zion.sessionLoad" }]
      }
    });

    expect(editors.get("panel-b")!.getValue()).toBe("existing peer text");
    sync.dispose();
  });

  it("does not mirror card restore fallback insertions", () => {
    const events = createEvents();
    const editors = new Map([
      ["panel-a", createEditor("restored marker")],
      ["panel-b", createEditor("existing peer text")]
    ]);
    const panels = [
      { id: "panel-a", activeTabId: "session-1" },
      { id: "panel-b", activeTabId: "session-1" }
    ];

    const sync = new SessionSync({
      events,
      getActivePanelId: () => "panel-a",
      listPanels: () => panels,
      getEditor: (panelId) => editors.get(panelId) as any
    });

    events.emit("editor.change", {
      panelId: "panel-a",
      update: {
        transactions: [{ annotation: () => "zion.cardRestore" }]
      }
    });

    expect(editors.get("panel-b")!.getValue()).toBe("existing peer text");
    sync.dispose();
  });

  it("uses the changed view session instead of the panel active tab when syncing", () => {
    const events = createEvents();
    const activeEditor = createViewEditor("kehu active content", "kehu-session");
    const hiddenHuggingFaceEditor = createViewEditor("huggingface hidden content", "hf-session");
    const peerKehuEditor = createViewEditor("kehu peer content", "kehu-session");
    const peerHuggingFaceEditor = createViewEditor("hf peer content", "hf-session");
    const editors = new Map([
      ["panel-a", activeEditor],
      ["panel-kehu", peerKehuEditor],
      ["panel-hf", peerHuggingFaceEditor]
    ]);
    const panels = [
      { id: "panel-a", activeTabId: "kehu-session" },
      { id: "panel-kehu", activeTabId: "kehu-session" },
      { id: "panel-hf", activeTabId: "hf-session" }
    ];

    const sync = new SessionSync({
      events,
      getActivePanelId: () => "panel-a",
      listPanels: () => panels,
      getEditor: (panelId) => editors.get(panelId) as any
    });

    events.emit("editor.change", {
      panelId: "panel-a",
      view: hiddenHuggingFaceEditor.getView()
    });

    expect(peerKehuEditor.getValue()).toBe("kehu peer content");
    expect(peerHuggingFaceEditor.getValue()).toBe("huggingface hidden content");
    sync.dispose();
  });
});
