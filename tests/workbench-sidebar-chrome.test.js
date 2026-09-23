import { describe, expect, it } from "vitest";
import { initWorkbench } from "../src/ui/workbench/workbench";
import { bindWorkbenchCore, sideBarRuntime } from "../src/ui/workbench/runtime";
import { setAccountSession } from "../packages/account-ui/src/client";

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
  it("opens the account Settings page from the Activity Bar and reacts to logout", () => {
    const host = document.createElement("div");
    host.id = "app";
    host.style.height = "600px";
    document.body.appendChild(host);
    const opened = [];
    const previousZion = window.zion;
    window.zion = {
      ...(previousZion || {}),
      settings: {
        ...(previousZion?.settings || {}),
        open: (pageId) => opened.push(pageId)
      }
    };
    setAccountSession({
      authenticated: true,
      mode: "accounts-v1",
      user: { id: "user:alice", name: "Alice", email: "alice@example.test" },
      space: { id: "space:team", name: "Zion Team", kind: "team" },
      membership: { role: "member", status: "active" },
      scopes: ["runtime.read", "runtime.write"],
      sessionId: "login:alice",
      expiresAt: Date.now() + 60_000
    });
    bindWorkbenchCore({
      state: createState(),
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      }
    });

    const wb = initWorkbench(host);
    const account = host.querySelector('[aria-label="账号：Alice"]');
    const title = account?.getAttribute("title");
    const icon = account?.querySelector('[data-zion-icon="account"]');
    account?.click();
    const page = opened[0];
    setAccountSession({
      authenticated: true,
      mode: "accounts-v1",
      user: { id: "user:alice", name: "Alice", email: "alice@example.test" },
      space: { id: "space:personal", name: "My Local Space", kind: "personal" },
      membership: { role: "owner", status: "active" },
      scopes: ["runtime.read", "runtime.write"],
      sessionId: "login:alice",
      expiresAt: Date.now() + 60_000
    });
    const personalTitle = host.querySelector('[aria-label="账号：Alice"]')?.getAttribute("title");
    setAccountSession(null);
    const removedAfterLogout = !host.querySelector(".zion-activitybar-account");

    wb.dispose();
    host.remove();
    window.zion = previousZion;

    expect(title).toBe("Alice · Zion Team");
    expect(icon).toBeTruthy();
    expect(page).toBe("general.account");
    expect(personalTitle).toBe("Alice · alice@example.test");
    expect(removedAfterLogout).toBe(true);
  });

  it("mounts a newly activated view once across synchronous change events", async () => {
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

    const wb = initWorkbench(host);
    let renderCount = 0;
    const view = sideBarRuntime.registerView({
      id: "sessions.single-mount",
      pluginId: "dev.session-manager",
      title: "Sessions",
      component: {
        render: (container) => {
          renderCount += 1;
          const marker = document.createElement("div");
          marker.className = "single-mount-marker";
          container.appendChild(marker);
          return { dispose: () => marker.remove() };
        }
      }
    });

    sideBarRuntime.show();
    sideBarRuntime.activateView("sessions.single-mount");
    sideBarRuntime.setWidth(440);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(renderCount).toBe(1);
    expect(host.querySelectorAll(".single-mount-marker")).toHaveLength(1);

    view.dispose();
    wb.dispose();
    host.remove();
  });

  it("reflects active Sidebar header actions before and after click", async () => {
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

    let active = false;
    const wb = initWorkbench(host);
    const view = sideBarRuntime.registerView({
      id: "sessions.active-action",
      pluginId: "dev.session-manager",
      title: "Sessions",
      headerActions: [{
        id: "sessions.mode",
        title: "Toggle mode",
        icon: "$(layout-grid)",
        active: () => active,
        onClick: () => {
          active = !active;
        }
      }],
      component: { render: () => {} }
    });
    sideBarRuntime.show();
    sideBarRuntime.activateView("sessions.active-action");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const action = document.querySelector('[aria-label="Toggle mode"]');
    expect(action.classList.contains("is-active")).toBe(false);
    expect(action.getAttribute("aria-pressed")).toBe("false");

    action.click();
    expect(action.classList.contains("is-active")).toBe(true);
    expect(action.getAttribute("aria-pressed")).toBe("true");

    view.dispose();
    wb.dispose();
    host.remove();
  });

  it("uses the columns icon for the shared hide action", async () => {
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
      id: "plugins.hide-action",
      pluginId: "dev.plugins",
      title: "Plugins",
      component: { render: () => {} }
    });
    sideBarRuntime.show();
    sideBarRuntime.activateView("plugins.hide-action");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const hide = document.querySelector('[aria-label="Hide Side Bar"]');
    const usesColumnsIcon = !!hide?.querySelector('[data-zion-icon="columns-2"]');
    hide.click();
    const hiddenAfterClick = !sideBarRuntime.isVisible();

    view.dispose();
    wb.dispose();
    host.remove();

    expect(usesColumnsIcon).toBe(true);
    expect(hiddenAfterClick).toBe(true);
  });

  it("allows a Sidebar view to omit the shared hide action", async () => {
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
      id: "sessions.no-hide-action",
      pluginId: "dev.session-manager",
      title: "Sessions",
      showHideAction: false,
      component: { render: () => {} }
    });
    sideBarRuntime.show();
    sideBarRuntime.activateView("sessions.no-hide-action");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const hasHideAction = !!document.querySelector('[aria-label="Hide Side Bar"]');

    view.dispose();
    wb.dispose();
    host.remove();

    expect(hasHideAction).toBe(false);
  });

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

  it("disposes the leading header when the active view changes while hidden", async () => {
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
    const sessions = sideBarRuntime.registerView({
      id: "sessions.hidden-lifecycle",
      pluginId: "dev.session-manager",
      title: "Sessions",
      headerLeading: {
        render: (container, context) => {
          leadingContext = context;
          const label = document.createElement("span");
          label.textContent = "All Tags";
          container.appendChild(label);
          return { dispose: () => { leadingDisposeCount += 1; } };
        }
      },
      component: { render: () => {} }
    });
    const plugins = sideBarRuntime.registerView({
      id: "plugins.hidden-lifecycle",
      pluginId: "dev.plugins",
      title: "Plugins",
      component: { render: () => {} }
    });

    sideBarRuntime.show();
    sideBarRuntime.activateView("sessions.hidden-lifecycle");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const header = document.querySelector(".zion-sidebar-header");
    const leading = header.querySelector(".zion-sidebar-header-leading");
    leadingContext.setWidth(180);
    leadingContext.setVisible(true);
    expect(header.classList.contains("has-leading")).toBe(true);
    expect(leading.textContent).toBe("All Tags");
    expect(leading.childElementCount).toBe(1);

    sideBarRuntime.hide();
    sideBarRuntime.activateView("plugins.hidden-lifecycle");

    expect(leadingDisposeCount).toBe(1);
    expect(leading.childElementCount).toBe(0);
    expect(leading.textContent).toBe("");
    expect(header.classList.contains("has-leading")).toBe(false);

    sessions.dispose();
    plugins.dispose();
    wb.dispose();
    host.remove();
  });

  it("isolates leading header state between mounts of the same view", async () => {
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
    const leadingContexts = [];
    const sessions = sideBarRuntime.registerView({
      id: "sessions.remount",
      pluginId: "dev.session-manager",
      title: "Sessions",
      headerLeading: {
        render: (container, context) => {
          leadingContexts.push(context);
          container.textContent = "All Tags";
          return { dispose() {} };
        }
      },
      component: { render: () => {} }
    });
    const plugins = sideBarRuntime.registerView({
      id: "plugins.remount",
      pluginId: "dev.plugins",
      title: "Plugins",
      component: { render: () => {} }
    });

    sideBarRuntime.show();
    sideBarRuntime.activateView("sessions.remount");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const staleContext = leadingContexts[0];

    sideBarRuntime.activateView("plugins.remount");
    sideBarRuntime.activateView("sessions.remount");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const currentContext = leadingContexts[1];
    const header = document.querySelector(".zion-sidebar-header");
    currentContext.setWidth(220);
    currentContext.setVisible(true);
    staleContext.setWidth(120);
    staleContext.setVisible(false);

    const actualWidth = header.style.getPropertyValue("--zion-sidebar-leading-width");
    const actualVisible = header.classList.contains("has-leading");

    sessions.dispose();
    plugins.dispose();
    wb.dispose();
    host.remove();

    expect(actualWidth).toBe("220px");
    expect(actualVisible).toBe(true);
  });

  it("disposes a leading renderer superseded before it returns", async () => {
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
    const disposeCounts = [0, 0];
    let renderCount = 0;
    const plugins = sideBarRuntime.registerView({
      id: "plugins.reentrant",
      pluginId: "dev.plugins",
      title: "Plugins",
      component: { render: () => {} }
    });
    const sessions = sideBarRuntime.registerView({
      id: "sessions.reentrant",
      pluginId: "dev.session-manager",
      title: "Sessions",
      headerLeading: {
        render: (container) => {
          const renderIndex = renderCount++;
          container.textContent = `All Tags ${renderIndex}`;
          if (renderIndex === 0) {
            sideBarRuntime.activateView("plugins.reentrant");
            sideBarRuntime.activateView("sessions.reentrant");
          }
          return {
            dispose: () => {
              disposeCounts[renderIndex] += 1;
            }
          };
        }
      },
      component: { render: () => {} }
    });

    sideBarRuntime.show();
    sideBarRuntime.activateView("sessions.reentrant");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const disposeCountsAfterMount = [...disposeCounts];
    const leadingText = document.querySelector(".zion-sidebar-header-leading").textContent;
    sideBarRuntime.activateView("plugins.reentrant");
    const disposeCountsAfterSwitch = [...disposeCounts];

    sessions.dispose();
    plugins.dispose();
    wb.dispose();
    host.remove();

    expect(renderCount).toBe(2);
    expect(disposeCountsAfterMount).toEqual([1, 0]);
    expect(leadingText).toBe("All Tags 1");
    expect(disposeCountsAfterSwitch).toEqual([1, 1]);
  });

  it("shows a leading header only with a valid width and retains that width", async () => {
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
    const sessions = sideBarRuntime.registerView({
      id: "sessions.width",
      pluginId: "dev.session-manager",
      title: "Sessions",
      headerLeading: {
        render: (container, context) => {
          leadingContext = context;
          container.textContent = "All Tags";
        }
      },
      component: { render: () => {} }
    });

    sideBarRuntime.show();
    sideBarRuntime.activateView("sessions.width");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const header = document.querySelector(".zion-sidebar-header");
    leadingContext.setVisible(true);
    const invalidBeforeValid = [];
    for (const width of [NaN, Infinity, 0, -1]) {
      leadingContext.setWidth(width);
      invalidBeforeValid.push({
        visible: header.classList.contains("has-leading"),
        width: header.style.getPropertyValue("--zion-sidebar-leading-width")
      });
    }

    leadingContext.setWidth(180);
    const validState = {
      visible: header.classList.contains("has-leading"),
      width: header.style.getPropertyValue("--zion-sidebar-leading-width")
    };

    const invalidAfterValid = [];
    for (const width of [NaN, Infinity, 0, -1]) {
      leadingContext.setWidth(width);
      invalidAfterValid.push({
        visible: header.classList.contains("has-leading"),
        width: header.style.getPropertyValue("--zion-sidebar-leading-width")
      });
    }

    sessions.dispose();
    wb.dispose();
    host.remove();

    expect(invalidBeforeValid).toEqual([
      { visible: false, width: "" },
      { visible: false, width: "" },
      { visible: false, width: "" },
      { visible: false, width: "" }
    ]);
    expect(validState).toEqual({ visible: true, width: "180px" });
    expect(invalidAfterValid).toEqual([
      { visible: true, width: "180px" },
      { visible: true, width: "180px" },
      { visible: true, width: "180px" },
      { visible: true, width: "180px" }
    ]);
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
