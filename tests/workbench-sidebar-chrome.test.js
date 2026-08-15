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

  it("mounts, updates, and disposes a leading header without remounting the view", async () => {
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
    let leadingContext = null;
    let leadingDisposeCount = 0;
    let viewRenderCount = 0;

    const sessions = sideBarRuntime.registerView({
      id: "sessions.list",
      pluginId: "dev.session-manager",
      title: "Sessions",
      headerLeading: {
        render: (container, context) => {
          leadingContext = context;
          container.textContent = "All Tags";
          return { dispose: () => { leadingDisposeCount += 1; } };
        }
      },
      component: {
        render: () => {
          viewRenderCount += 1;
        }
      }
    });
    const plugins = sideBarRuntime.registerView({
      id: "plugins.manager",
      pluginId: "dev.plugins",
      title: "Plugins",
      component: { render: () => {} }
    });

    sideBarRuntime.show();
    sideBarRuntime.activateView("sessions.list");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const header = document.querySelector(".zion-sidebar-header");
    const leading = header.querySelector(".zion-sidebar-header-leading");
    const title = header.querySelector(".zion-sidebar-title");
    expect(leading.textContent).toBe("All Tags");
    expect(title.textContent).toBe("Sessions");
    expect(header.classList.contains("has-leading")).toBe(false);

    const rendersBeforeHeaderUpdate = viewRenderCount;
    leadingContext.setWidth(180);
    leadingContext.setVisible(true);
    expect(header.classList.contains("has-leading")).toBe(true);
    expect(header.style.getPropertyValue("--zion-sidebar-leading-width")).toBe("180px");
    expect(viewRenderCount).toBe(rendersBeforeHeaderUpdate);

    leadingContext.setVisible(false);
    expect(header.classList.contains("has-leading")).toBe(false);

    sideBarRuntime.activateView("plugins.manager");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(leadingDisposeCount).toBe(1);
    expect(leading.childElementCount).toBe(0);
    expect(header.classList.contains("has-leading")).toBe(false);

    sessions.dispose();
    plugins.dispose();
    wb.dispose();
    host.remove();
  });

  it("keeps the standard header when a leading renderer fails", async () => {
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
    const view = sideBarRuntime.registerView({
      id: "broken.leading",
      pluginId: "test",
      title: "Still Visible",
      headerLeading: {
        render: () => {
          throw new Error("leading failed");
        }
      },
      component: {
        render: (container) => {
          container.textContent = "content survived";
        }
      }
    });
    sideBarRuntime.show();
    sideBarRuntime.activateView("broken.leading");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const header = document.querySelector(".zion-sidebar-header");
    expect(header.classList.contains("has-leading")).toBe(false);
    expect(header.querySelector(".zion-sidebar-title").textContent).toBe("Still Visible");
    expect(document.querySelector(".zion-sidebar-content").textContent).toContain("content survived");

    view.dispose();
    wb.dispose();
    host.remove();
  });
});
