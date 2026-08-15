import { describe, expect, it } from "vitest";
import { initWorkbench } from "../src/ui/workbench/workbench";
import { auxiliaryBarRuntime, bindWorkbenchCore } from "../src/ui/workbench/runtime";

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

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("workbench auxiliary transient views", () => {
  it("does not leave a transient view under a keepWhenActive view after rapid switches", async () => {
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
    let releaseContextDeactivate = () => {};
    const contextDeactivate = new Promise((resolve) => {
      releaseContextDeactivate = resolve;
    });

    const contextView = auxiliaryBarRuntime.registerView({
      id: "test.context.keep",
      pluginId: "test",
      title: "Context",
      keepWhenActive: true,
      component: {
        render: (container) => {
          const marker = document.createElement("div");
          marker.className = "context-probe";
          container.appendChild(marker);
          return { dispose: () => marker.remove() };
        }
      },
      onDeactivate: () => contextDeactivate
    });
    const schedulerView = auxiliaryBarRuntime.registerView({
      id: "test.scheduler.transient",
      pluginId: "test",
      title: "Scheduler",
      component: {
        render: (container) => {
          const marker = document.createElement("div");
          marker.className = "scheduler-probe";
          container.appendChild(marker);
          return { dispose: () => marker.remove() };
        }
      }
    });

    auxiliaryBarRuntime.show();
    auxiliaryBarRuntime.activateView("test.context.keep");
    await tick();
    expect(document.querySelectorAll(".context-probe")).toHaveLength(1);

    auxiliaryBarRuntime.activateView("test.scheduler.transient");
    auxiliaryBarRuntime.activateView("test.scheduler.transient");
    await tick();
    releaseContextDeactivate();
    await tick();
    await tick();

    expect(document.querySelectorAll(".scheduler-probe")).toHaveLength(1);

    auxiliaryBarRuntime.activateView("test.context.keep");
    await tick();
    await tick();

    expect(document.querySelectorAll(".context-probe")).toHaveLength(1);
    expect(document.querySelectorAll(".scheduler-probe")).toHaveLength(0);

    schedulerView.dispose();
    contextView.dispose();
    wb.dispose();
    host.remove();
  });
});
