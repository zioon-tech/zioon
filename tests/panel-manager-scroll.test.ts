import { afterEach, describe, expect, it, vi } from "vitest";
import { createPanelDomShell, PanelManager } from "../src/panel/PanelManager";

function setScrollSize(el: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
}

function setRect(el: HTMLElement, left: number, width: number) {
  el.getBoundingClientRect = () => ({
    left,
    right: left + width,
    top: 0,
    bottom: 100,
    width,
    height: 100,
    x: left,
    y: 0,
    toJSON: () => ({})
  } as DOMRect);
}

async function flushReveal() {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

describe("panel manager horizontal scroll reveal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the active panel visible after creating a horizontal split", async () => {
    const host = document.createElement("div");
    setScrollSize(host, 1000, 300);
    setRect(host, 0, 300);

    const initial = { id: "panel-0", tabs: [], activeTabId: null, editor: null, ...createPanelDomShell("panel-0") };
    const manager = new PanelManager({ host, initialPanel: initial, createPanelDom: createPanelDomShell });
    const created = manager.splitPanelAt("panel-0", "right");
    expect(created?.id).toBe("panel-1");
    expect(host.classList.contains("is-horizontal-scroll")).toBe(true);

    setRect(manager.getPanel("panel-0")!.rootEl, 0, 420);
    setRect(manager.getPanel("panel-1")!.rootEl, 420, 420);
    host.scrollLeft = 0;

    await flushReveal();

    expect(host.scrollLeft).toBeGreaterThan(500);
    expect(host.scrollLeft).toBeLessThanOrEqual(700);
  });

  it("reveals the recently focused panel when the horizontal scroller is resized", async () => {
    let resizeCallback: (() => void) | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: () => void) {
        resizeCallback = cb;
      }
      observe() {}
      disconnect() {}
    });

    const host = document.createElement("div");
    setScrollSize(host, 1000, 300);
    setRect(host, 0, 300);

    const initial = { id: "panel-0", tabs: [], activeTabId: null, editor: null, ...createPanelDomShell("panel-0") };
    const manager = new PanelManager({ host, initialPanel: initial, createPanelDom: createPanelDomShell });
    manager.splitPanelAt("panel-0", "right");
    setRect(manager.getPanel("panel-0")!.rootEl, 0, 420);
    setRect(manager.getPanel("panel-1")!.rootEl, 420, 420);
    await flushReveal();

    manager.focusPanel("panel-0");
    host.scrollLeft = 520;
    setRect(manager.getPanel("panel-0")!.rootEl, -520, 420);
    setRect(manager.getPanel("panel-1")!.rootEl, -100, 420);
    resizeCallback?.();
    await flushReveal();

    expect(host.scrollLeft).toBe(0);
  });
});
