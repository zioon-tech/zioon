import { describe, expect, it } from "vitest";
import { initWorkbench, keepHorizontalScrollerRightEdgeAnchored } from "../src/ui/workbench/workbench";
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

describe("workbench sidebar resize", () => {
  it("keeps horizontal panels anchored to the inspector edge while the viewport shrinks", () => {
    const scroller = document.createElement("div");
    scroller.className = "zion-panels-root is-horizontal-scroll";
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 500 });
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 1200 });
    scroller.scrollLeft = 100;

    keepHorizontalScrollerRightEdgeAnchored(scroller, 640);

    expect(scroller.scrollLeft).toBe(240);
  });

  it("does not reverse-scroll when sidebar collapse widens the panels viewport", () => {
    const scroller = document.createElement("div");
    scroller.className = "zion-panels-root is-horizontal-scroll";
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 700 });
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 1200 });
    scroller.scrollLeft = 300;

    keepHorizontalScrollerRightEdgeAnchored(scroller, 500, 30);

    expect(scroller.scrollLeft).toBe(330);
  });

  it("keeps mounted view DOM when width changes", async () => {
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
      component: {
        render: (container) => {
          const marker = document.createElement("div");
          marker.id = "__sessions_marker";
          marker.textContent = "ok";
          container.appendChild(marker);
          return { dispose: () => marker.remove() };
        }
      }
    });

    sideBarRuntime.show();
    sideBarRuntime.activateView("sessions.list");

    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById("__sessions_marker")).toBeTruthy();

    sideBarRuntime.setWidth(320);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById("__sessions_marker")).toBeTruthy();

    dispView.dispose();
    wb.dispose();
    host.remove();
  });
});
