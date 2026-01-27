import { describe, expect, it } from "vitest";
import { initWorkbench } from "../src/ui/workbench/workbench";
import { bindWorkbenchCore, sideBarRuntime } from "../src/ui/workbench/runtime";

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
    }
  };
}

describe("workbench sidebar chrome", () => {
  it("hides tabs by default", async () => {
    const host = document.createElement("div");
    host.id = "app";
    host.style.height = "600px";
    document.body.appendChild(host);

    const state = createState();
    bindWorkbenchCore({
      state,
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });

    const wb = initWorkbench(host);
    const dispView = sideBarRuntime.registerView({
      id: "sessions.list",
      pluginId: "dev.session-manager",
      title: "Sessions",
      component: { render: () => {} }
    });
    sideBarRuntime.show();
    sideBarRuntime.activateView("sessions.list");
    await new Promise((r) => setTimeout(r, 0));

    const tabs = document.querySelector(".zion-sidebar-tabs");
    expect(tabs).toBeTruthy();
    expect(tabs.style.display).toBe("none");

    dispView.dispose();
    wb.dispose();
    host.remove();
  });

  it("shows tabs when explicitly enabled", async () => {
    const host = document.createElement("div");
    host.id = "app";
    host.style.height = "600px";
    document.body.appendChild(host);

    const state = createState();
    bindWorkbenchCore({
      state,
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });

    state.set("ui.sideBar.showTabs", true);

    const wb = initWorkbench(host);
    const d1 = sideBarRuntime.registerView({
      id: "sessions.list",
      pluginId: "dev.session-manager",
      title: "Sessions",
      component: { render: () => {} }
    });
    const d2 = sideBarRuntime.registerView({
      id: "plugins.manager",
      pluginId: "dev.plugins",
      title: "Plugins",
      component: { render: () => {} }
    });

    sideBarRuntime.show();
    sideBarRuntime.activateView("sessions.list");
    await new Promise((r) => setTimeout(r, 0));

    const tabs = document.querySelector(".zion-sidebar-tabs");
    expect(tabs).toBeTruthy();
    expect(tabs.style.display).toBe("flex");

    d1.dispose();
    d2.dispose();
    wb.dispose();
    host.remove();
  });
});
