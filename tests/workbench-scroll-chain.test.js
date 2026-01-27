import { describe, expect, it } from "vitest";
import { initWorkbench } from "../src/ui/workbench/workbench";
import { bindWorkbenchCore } from "../src/ui/workbench/runtime";

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

describe("workbench scroll chain", () => {
  it("wheel on sidebar header should be prevented to avoid page scroll", () => {
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

    const header = document.querySelector(".zion-sidebar-header");
    expect(header).toBeTruthy();

    const ev = new window.WheelEvent("wheel", { deltaY: 120, cancelable: true, bubbles: true });
    header.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);

    wb.dispose();
    host.remove();
  });
});
