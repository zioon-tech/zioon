import { describe, expect, it } from "vitest";
import { countHorizontalPanelColumns, renderSplitLayout } from "../src/panel/SplitLayout";
import type { PanelRecord, SplitNode } from "../src/panel/types";

function panel(id: string): PanelRecord {
  const rootEl = document.createElement("div");
  rootEl.className = "zion-panel";
  return {
    id,
    rootEl,
    tabsBarEl: document.createElement("div"),
    headerEl: document.createElement("div"),
    pathEl: document.createElement("div"),
    editorHostEl: document.createElement("div"),
    tabs: [],
    activeTabId: null,
    editor: null
  };
}

function render(root: SplitNode) {
  const host = document.createElement("div");
  const panels = new Map(["a", "b", "c"].map((id) => [id, panel(id)]));
  renderSplitLayout(host, root, (id) => panels.get(id) || null);
  return host;
}

function horizontalRoot(): SplitNode {
  return {
    type: "split",
    id: "split-1",
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "leaf", panelId: "a" },
    second: { type: "leaf", panelId: "b" }
  };
}

function setScrollSize(el: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
}

describe("split layout horizontal overflow", () => {
  it("does not enable horizontal scroll for a single panel", () => {
    const host = render({ type: "leaf", panelId: "a" });

    expect(countHorizontalPanelColumns({ type: "leaf", panelId: "a" })).toBe(1);
    expect(host.classList.contains("is-horizontal-scroll")).toBe(false);
    expect(host.style.getPropertyValue("--panel-layout-min-width")).toBe("");
  });

  it("does not enable horizontal scroll for vertical-only splits", () => {
    const root: SplitNode = {
      type: "split",
      id: "split-1",
      direction: "vertical",
      ratio: 0.5,
      first: { type: "leaf", panelId: "a" },
      second: { type: "leaf", panelId: "b" }
    };
    const host = render(root);

    expect(countHorizontalPanelColumns(root)).toBe(1);
    expect(host.classList.contains("is-horizontal-scroll")).toBe(false);
    expect(host.style.getPropertyValue("--panel-layout-min-width")).toBe("");
  });

  it("enables horizontal scroll and assigns min widths for horizontal columns", () => {
    const root: SplitNode = {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", panelId: "a" },
      second: {
        type: "split",
        id: "split-2",
        direction: "vertical",
        ratio: 0.5,
        first: { type: "leaf", panelId: "b" },
        second: { type: "leaf", panelId: "c" }
      }
    };
    const host = render(root);
    const children = host.querySelectorAll<HTMLElement>(":scope > .zion-split-container > .zion-split-child");

    expect(countHorizontalPanelColumns(root)).toBe(2);
    expect(host.classList.contains("is-horizontal-scroll")).toBe(true);
    expect(host.style.getPropertyValue("--panel-horizontal-columns")).toBe("2");
    expect(host.style.getPropertyValue("--panel-layout-min-width")).toBe("calc(var(--panel-min-width, 420px) * 2)");
    expect(children[0]?.style.minWidth).toBe("var(--panel-min-width, 420px)");
    expect(children[1]?.style.minWidth).toBe("var(--panel-min-width, 420px)");
  });

  it("routes horizontal wheel from table chrome to the outer panel scroller", () => {
    const host = render(horizontalRoot());
    setScrollSize(host, 1000, 500);
    host.scrollLeft = 0;

    const tableWrap = document.createElement("div");
    tableWrap.className = "cm-md-table-wrap";
    host.querySelector<HTMLElement>("[data-panel-id='a']")?.appendChild(tableWrap);

    const ev = new window.WheelEvent("wheel", { deltaX: 80, bubbles: true, cancelable: true });
    tableWrap.dispatchEvent(ev);

    expect(host.scrollLeft).toBe(80);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("lets an inner table scroller consume horizontal wheel while it can scroll", () => {
    const host = render(horizontalRoot());
    setScrollSize(host, 1000, 500);
    host.scrollLeft = 0;

    const tableWrap = document.createElement("div");
    tableWrap.className = "cm-md-table-wrap";
    const tableScroller = document.createElement("div");
    tableScroller.className = "cm-md-table-scroll";
    setScrollSize(tableScroller, 800, 300);
    tableScroller.scrollLeft = 0;
    tableWrap.appendChild(tableScroller);
    host.querySelector<HTMLElement>("[data-panel-id='a']")?.appendChild(tableWrap);

    const ev = new window.WheelEvent("wheel", { deltaX: 80, bubbles: true, cancelable: true });
    tableScroller.dispatchEvent(ev);

    expect(host.scrollLeft).toBe(0);
    expect(ev.defaultPrevented).toBe(false);
  });
});
