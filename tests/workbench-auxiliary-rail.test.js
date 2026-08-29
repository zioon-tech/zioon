import { describe, expect, it, vi } from "vitest";
import { initWorkbench } from "../src/ui/workbench/workbench";
import { activityBarRuntime, auxiliaryBarRuntime, bindWorkbenchCore } from "../src/ui/workbench/runtime";

function createState() {
  const map = new Map();
  const listeners = new Map();
  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      const previous = map.get(key);
      map.set(key, value);
      for (const listener of Array.from(listeners.get(key) || [])) {
        listener(value, previous);
      }
    },
    update: (key, updater) => {
      const previous = map.get(key);
      const value = updater(previous);
      map.set(key, value);
      for (const listener of Array.from(listeners.get(key) || [])) {
        listener(value, previous);
      }
    },
    onDidChange: (key, listener) => {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(listener);
      return { dispose: () => listeners.get(key)?.delete(listener) };
    }
  };
}

describe("workbench auxiliary rail", () => {
  it("renders Activity Bar items with their registered icon and label", () => {
    const host = document.createElement("div");
    host.id = "app";
    host.style.height = "600px";
    document.body.appendChild(host);

    bindWorkbenchCore({
      state: createState(),
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });

    const item = activityBarRuntime.registerItem({
      id: "test.activity.sessions",
      pluginId: "test",
      icon: "$(messages-square)",
      tooltip: "Sessions",
      sideBarViewId: "test.sidebar.sessions"
    });
    const wb = initWorkbench(host);

    const button = host.querySelector('.zion-activitybar-item[aria-label="Sessions"]');
    expect(button.querySelector('[data-zion-icon="messages-square"]')).toBeTruthy();
    expect(button.querySelector(".zion-activitybar-label").textContent).toBe("Sessions");
    expect(host.querySelector(".zion-activitybar-command .zion-activitybar-label").textContent).toBe("搜索");
    expect(host.querySelector(".zion-activitybar-settings .zion-activitybar-label").textContent).toBe("设置");

    item.dispose();
    wb.dispose();
    host.remove();
  });

  it("renders registered views as icon and label items on the right", () => {
    const host = document.createElement("div");
    host.id = "app";
    host.style.height = "600px";
    document.body.appendChild(host);

    bindWorkbenchCore({
      state: createState(),
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });

    const onAction = vi.fn();
    const wb = initWorkbench(host);
    const contextView = auxiliaryBarRuntime.registerView({
      id: "test.aux.context",
      pluginId: "test",
      title: "Context",
      icon: "$(layers)",
      order: 10,
      headerActions: [{
        id: "test.aux.refresh",
        title: "Refresh",
        icon: "$(refresh)",
        onClick: onAction
      }],
      component: { render: () => {} }
    });
    const filesView = auxiliaryBarRuntime.registerView({
      id: "test.aux.files",
      pluginId: "test",
      title: "Files",
      icon: "$(folder)",
      order: 20,
      component: { render: () => {} }
    });

    auxiliaryBarRuntime.activateView("test.aux.context");

    const rail = host.querySelector(".zion-auxbar-rail");
    const items = Array.from(rail.querySelectorAll(".zion-auxbar-rail-item"));
    expect(rail.getAttribute("aria-orientation")).toBe("vertical");
    expect(items.map((item) => item.dataset.viewId)).toEqual([
      "test.aux.context",
      "test.aux.files"
    ]);
    expect(items[0].textContent).toContain("Context");
    expect(items[0].querySelector('[data-zion-icon="layers"]')).toBeTruthy();
    expect(items[0].getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".zion-auxbar-tabs")).toBeNull();
    expect(host.querySelector(".zion-auxbar-title").textContent).toBe("Context");

    const action = host.querySelector(".zion-auxbar-plugin-action");
    action.click();
    expect(onAction).toHaveBeenCalledOnce();

    items[1].click();
    const active = host.querySelector('.zion-auxbar-rail-item[data-view-id="test.aux.files"]');
    expect(active.classList.contains("is-active")).toBe(true);
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".zion-auxbar-title").textContent).toBe("Files");
    expect(host.querySelector(".zion-auxbar-plugin-action")).toBeNull();

    filesView.dispose();
    contextView.dispose();
    wb.dispose();
    host.remove();
  });
});
