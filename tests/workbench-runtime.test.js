import { describe, expect, it } from "vitest";
import { activityBarRuntime, bindWorkbenchCore, bottomPanelRuntime, sideBarRuntime } from "../src/ui/workbench/runtime";

function createState() {
  const map = new Map();
  const listeners = new Map();
  return {
    get: (k) => map.get(k),
    set: (k, v) => {
      const oldVal = map.get(k);
      map.set(k, v);
      const arr = listeners.get(k);
      if (arr) {
        for (const fn of Array.from(arr)) {
          try {
            fn(v, oldVal);
          } catch {}
        }
      }
    },
    update: (k, updater) => {
      const oldVal = map.get(k);
      const next = updater(oldVal);
      map.set(k, next);
      const arr = listeners.get(k);
      if (arr) {
        for (const fn of Array.from(arr)) {
          try {
            fn(next, oldVal);
          } catch {}
        }
      }
    },
    onDidChange: (k, fn) => {
      if (!listeners.has(k)) listeners.set(k, new Set());
      listeners.get(k).add(fn);
      return { dispose: () => listeners.get(k)?.delete(fn) };
    },
    __raw: map
  };
}

describe("workbench runtime", () => {
  it("activityBar.activateItem should show sidebar and activate mapped view", () => {
    const state = createState();
    bindWorkbenchCore({
      state,
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });

    const dispView = sideBarRuntime.registerView({
      id: "sessions.list",
      pluginId: "dev.session-manager",
      title: "Sessions",
      component: { render: () => {} }
    });
    const dispItem = activityBarRuntime.registerItem({
      id: "sessions.activity",
      pluginId: "dev.session-manager",
      icon: "💬",
      sideBarViewId: "sessions.list",
      order: 10
    });

    activityBarRuntime.activateItem("sessions.activity");

    expect(state.get("ui.activityBar.activeItemId")).toBe("sessions.activity");
    expect(state.get("ui.sideBar.visible")).toBe(true);
    expect(state.get("ui.sideBar.activeViewId")).toBe("sessions.list");

    dispItem.dispose();
    dispView.dispose();
  });

  it("clicking active activity item should toggle sidebar visibility", () => {
    const state = createState();
    bindWorkbenchCore({
      state,
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });

    const dispView = sideBarRuntime.registerView({
      id: "sessions.list",
      pluginId: "dev.session-manager",
      title: "Sessions",
      component: { render: () => {} }
    });
    const dispItem = activityBarRuntime.registerItem({
      id: "sessions.activity",
      pluginId: "dev.session-manager",
      icon: "💬",
      sideBarViewId: "sessions.list",
      order: 10
    });

    activityBarRuntime.activateItem("sessions.activity");
    expect(state.get("ui.sideBar.visible")).toBe(true);

    activityBarRuntime.activateItem("sessions.activity");
    expect(state.get("ui.sideBar.visible")).toBe(false);

    activityBarRuntime.activateItem("sessions.activity");
    expect(state.get("ui.sideBar.visible")).toBe(true);
    expect(state.get("ui.sideBar.activeViewId")).toBe("sessions.list");

    dispItem.dispose();
    dispView.dispose();
  });

  it("activityBar item with bottomPanelViewId should toggle bottom panel visibility", () => {
    const state = createState();
    bindWorkbenchCore({
      state,
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });

    const dispView = bottomPanelRuntime.registerView({
      id: "terminal.view",
      pluginId: "dev.terminal-enhanced",
      title: "Terminal",
      component: { render: () => {} }
    });
    const dispItem = activityBarRuntime.registerItem({
      id: "terminal.activity",
      pluginId: "dev.terminal-enhanced",
      icon: "⌨️",
      bottomPanelViewId: "terminal.view",
      order: 30
    });

    activityBarRuntime.activateItem("terminal.activity");
    expect(state.get("ui.activityBar.activeItemId")).toBe("terminal.activity");
    expect(state.get("ui.bottomPanel.visible")).toBe(true);
    expect(state.get("ui.bottomPanel.activeViewId")).toBe("terminal.view");

    activityBarRuntime.activateItem("terminal.activity");
    expect(state.get("ui.bottomPanel.visible")).toBe(false);

    activityBarRuntime.activateItem("terminal.activity");
    expect(state.get("ui.bottomPanel.visible")).toBe(true);
    expect(state.get("ui.bottomPanel.activeViewId")).toBe("terminal.view");

    dispItem.dispose();
    dispView.dispose();
  });
});
