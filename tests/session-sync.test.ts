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
});
