import { describe, expect, it } from "vitest";
import {
  activityBarRuntime,
  auxiliaryBarRuntime,
  bindWorkbenchCore,
  bottomPanelRuntime,
  inspectorRuntime,
  responsiveRuntime,
  sideBarRuntime
} from "../src/ui/workbench/runtime";

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
  it("keeps PDF blobs available to the inspector renderer", () => {
    const state = createState();
    bindWorkbenchCore({
      state,
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });
    const blob = new Blob(["%PDF-1.7"], { type: "application/pdf" });

    inspectorRuntime.open({
      id: "pdf-preview",
      ownerId: "test",
      title: "sample.pdf",
      path: "/tmp/sample.pdf",
      file: { kind: "pdf", blob, size: blob.size }
    });

    expect(inspectorRuntime.getActiveItem()?.file).toMatchObject({
      kind: "pdf",
      blob,
      size: blob.size
    });
    inspectorRuntime.close("pdf-preview");
  });

  it("can update inspector width without emitting a full inspector change", () => {
    const state = createState();
    bindWorkbenchCore({
      state,
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });

    let changes = 0;
    const disp = inspectorRuntime.onDidChange(() => {
      changes += 1;
    });

    inspectorRuntime.setWidth(620, { emit: false });

    expect(state.get("ui.inspector.width")).toBe(620);
    expect(state.get("ui.inspector.visible")).toBe(true);
    expect(changes).toBe(0);

    inspectorRuntime.setWidth(640);
    expect(changes).toBe(1);

    disp.dispose();
  });

  it("does not re-emit bottom panel visibility while resizing an already visible panel", () => {
    const state = createState();
    bindWorkbenchCore({
      state,
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });

    let visibleChanges = 0;
    state.onDidChange("ui.bottomPanel.visible", () => {
      visibleChanges += 1;
    });

    state.set("ui.bottomPanel.visible", true);
    bottomPanelRuntime.setHeight(360);

    expect(state.get("ui.bottomPanel.height")).toBe(360);
    expect(visibleChanges).toBe(1);
  });

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
    expect(sideBarRuntime.isVisible()).toBe(true);
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
    expect(sideBarRuntime.isVisible()).toBe(true);

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

  it("syncs the active Activity item when a Bottom Panel tab is selected", () => {
    const state = createState();
    bindWorkbenchCore({
      state,
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });

    const view = bottomPanelRuntime.registerView({
      id: "core.output",
      pluginId: "core",
      title: "日志",
      component: { render: () => {} }
    });
    const item = activityBarRuntime.registerItem({
      id: "core.run-log.activity",
      pluginId: "core",
      icon: "$(output)",
      tooltip: "日志",
      bottomPanelViewId: "core.output",
      order: 80
    });

    bottomPanelRuntime.activateView("core.output");

    expect(state.get("ui.activityBar.activeItemId")).toBe("core.run-log.activity");
    expect(state.get("ui.bottomPanel.visible")).toBe(true);

    item.dispose();
    view.dispose();
  });

  it("keeps legacy auxiliary Activity items callable but omits them from the visible list", () => {
    const state = createState();
    bindWorkbenchCore({
      state,
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });

    const dispView = auxiliaryBarRuntime.registerView({
      id: "preview.view",
      pluginId: "dev.preview",
      title: "Preview",
      component: { render: () => {} }
    });
    const dispItem = activityBarRuntime.registerItem({
      id: "preview.activity",
      pluginId: "dev.preview",
      icon: "🌐",
      auxiliaryBarViewId: "preview.view",
      order: 30
    });

    expect(activityBarRuntime.getItems().some((item) => item.id === "preview.activity")).toBe(false);

    activityBarRuntime.activateItem("preview.activity");
    expect(state.get("ui.activityBar.activeItemId")).toBe("preview.activity");
    expect(state.get("ui.auxiliaryBar.visible")).toBe(true);
    expect(state.get("ui.auxiliaryBar.activeViewId")).toBe("preview.view");

    activityBarRuntime.activateItem("preview.activity");
    expect(state.get("ui.auxiliaryBar.visible")).toBe(false);

    activityBarRuntime.activateItem("preview.activity");
    expect(state.get("ui.auxiliaryBar.visible")).toBe(true);
    expect(state.get("ui.auxiliaryBar.activeViewId")).toBe("preview.view");

    dispItem.dispose();
    dispView.dispose();
  });

  it("responsive should hide panels on mobile and restore visibility on desktop", () => {
    const state = createState();
    globalThis.innerWidth = 1200;
    globalThis.innerHeight = 800;
    bindWorkbenchCore({
      state,
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });

    bottomPanelRuntime.registerView({
      id: "output.view",
      pluginId: "core",
      title: "Output",
      component: { render: () => {} }
    });

    bottomPanelRuntime.show();
    expect(state.get("ui.bottomPanel.visible")).toBe(true);

    globalThis.innerWidth = 600;
    window.dispatchEvent(new Event("resize"));
    expect(responsiveRuntime.getCurrentDeviceType()).toBe("mobile");
    expect(state.get("ui.bottomPanel.visible")).toBe(false);

    bottomPanelRuntime.show();
    expect(state.get("ui.bottomPanel.visible")).toBe(true);
    globalThis.innerWidth = 620;
    window.dispatchEvent(new Event("resize"));
    expect(responsiveRuntime.getCurrentDeviceType()).toBe("mobile");
    expect(state.get("ui.bottomPanel.visible")).toBe(true);

    globalThis.innerWidth = 1200;
    window.dispatchEvent(new Event("resize"));
    expect(responsiveRuntime.getCurrentDeviceType()).toBe("desktop");
    expect(state.get("ui.bottomPanel.visible")).toBe(true);
  });
});
