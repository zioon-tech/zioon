import type { PanelRecord, SplitNode } from "./types";

export const PANEL_MIN_WIDTH_PX = 420;
const PANEL_MIN_WIDTH_CSS = `var(--panel-min-width, ${PANEL_MIN_WIDTH_PX}px)`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function renderSplitLayout(
  host: HTMLElement,
  root: SplitNode | null,
  resolvePanel: (panelId: string) => PanelRecord | null,
  onSplitRatioChange?: (splitId: string, ratio: number) => void
): void {
  installHorizontalWheelBridge(host);
  host.innerHTML = "";
  const horizontalColumns = root ? countHorizontalPanelColumns(root) : 0;
  const hasHorizontalSplit = horizontalColumns > 1;
  host.classList.toggle("is-horizontal-scroll", hasHorizontalSplit);
  if (hasHorizontalSplit) {
    host.style.setProperty("--panel-horizontal-columns", String(horizontalColumns));
    host.style.setProperty("--panel-layout-min-width", panelColumnsWidthCss(horizontalColumns));
  } else {
    host.style.removeProperty("--panel-horizontal-columns");
    host.style.removeProperty("--panel-layout-min-width");
  }
  if (!root) return;
  host.appendChild(renderNode(root, resolvePanel, onSplitRatioChange));
}

function installHorizontalWheelBridge(host: HTMLElement): void {
  if (host.dataset.horizontalWheelBridgeBound === "1") return;
  host.dataset.horizontalWheelBridgeBound = "1";
  host.addEventListener(
    "wheel",
    (event) => {
      if (!host.classList.contains("is-horizontal-scroll")) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const tableWrap = target.closest(".cm-md-table-wrap");
      if (!tableWrap || !host.contains(tableWrap)) return;

      const absX = Math.abs(event.deltaX || 0);
      const absY = Math.abs(event.deltaY || 0);
      const useX = event.shiftKey || absX > absY;
      if (!useX) return;
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!delta) return;

      const tableScroller = target.closest(".cm-md-table-scroll") as HTMLElement | null;
      if (tableScroller && canScrollX(tableScroller, delta)) return;

      if (canScrollX(host, delta)) {
        const max = Math.max(0, host.scrollWidth - host.clientWidth);
        host.scrollLeft = Math.max(0, Math.min(max, host.scrollLeft + delta));
      }
      // The table cannot consume this horizontal gesture. Route it once to the
      // panel strip, then stop native scroll chaining from applying it again.
      event.preventDefault();
      event.stopPropagation();
    },
    { capture: true, passive: false }
  );
}

function canScrollX(el: HTMLElement, delta: number): boolean {
  try {
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    if (max <= 1) return false;
    const left = el.scrollLeft || 0;
    return delta < 0 ? left > 0.5 : left < max - 0.5;
  } catch {
    return false;
  }
}

function renderNode(
  node: SplitNode,
  resolvePanel: (panelId: string) => PanelRecord | null,
  onSplitRatioChange?: (splitId: string, ratio: number) => void
): HTMLElement {
  if (node.type === "leaf") {
    const panel = resolvePanel(node.panelId);
    const leaf = el("div", "zion-split-leaf");
    if (!panel) return leaf;
    leaf.dataset.panelId = panel.id;
    leaf.appendChild(panel.rootEl);
    return leaf;
  }

  const split = el("div", "zion-split-container");
  split.dataset.direction = node.direction;
  split.style.setProperty("--split-ratio", String(node.ratio));

  const first = el("div", "zion-split-child");
  applySplitRatio(first, node.ratio);
  applyHorizontalMinWidth(first, node.direction, node.first);
  first.appendChild(renderNode(node.first, resolvePanel, onSplitRatioChange));

  const handle = el("div", "zion-split-handle");
  handle.dataset.direction = node.direction;

  const second = el("div", "zion-split-child");
  applySplitRatio(second, 1 - node.ratio);
  applyHorizontalMinWidth(second, node.direction, node.second);
  second.appendChild(renderNode(node.second, resolvePanel, onSplitRatioChange));

  attachHandleDrag(split, handle, first, second, node.direction, node.id, onSplitRatioChange);

  split.appendChild(first);
  split.appendChild(handle);
  split.appendChild(second);
  return split;
}

function applySplitRatio(el: HTMLElement, ratio: number): void {
  const clamped = Math.max(0.1, Math.min(0.9, ratio));
  el.style.flex = `${clamped} 1 0%`;
}

function applyHorizontalMinWidth(el: HTMLElement, direction: "horizontal" | "vertical", child: SplitNode): void {
  if (direction !== "horizontal") return;
  const columns = Math.max(1, countHorizontalPanelColumns(child));
  el.style.minWidth = panelColumnsWidthCss(columns);
}

function panelColumnsWidthCss(columns: number): string {
  const count = Math.max(1, Math.round(columns || 1));
  return count === 1 ? PANEL_MIN_WIDTH_CSS : `calc(${PANEL_MIN_WIDTH_CSS} * ${count})`;
}

export function countHorizontalPanelColumns(node: SplitNode | null): number {
  if (!node) return 0;
  if (node.type === "leaf") return 1;
  const first = countHorizontalPanelColumns(node.first);
  const second = countHorizontalPanelColumns(node.second);
  if (node.direction === "horizontal") return first + second;
  return Math.max(first, second);
}

function attachHandleDrag(
  split: HTMLElement,
  handle: HTMLElement,
  first: HTMLElement,
  second: HTMLElement,
  direction: "horizontal" | "vertical",
  splitId: string,
  onSplitRatioChange?: (splitId: string, ratio: number) => void
): void {
  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const body = document.body;
    const prevUserSelect = body.style.userSelect;
    const prevCursor = body.style.cursor;
    body.style.userSelect = "none";
    body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
    try { handle.setPointerCapture(ev.pointerId); } catch {}
    const updateFromEvent = (event: PointerEvent) => {
      const rect = split.getBoundingClientRect();
      const total = direction === "horizontal" ? rect.width : rect.height;
      if (!total) return;
      const handleSize = direction === "horizontal" ? handle.offsetWidth : handle.offsetHeight;
      const pos = direction === "horizontal" ? event.clientX - rect.left : event.clientY - rect.top;
      const rawRatio = (pos - handleSize / 2) / Math.max(1, total - handleSize);
      const ratio = Math.max(0.15, Math.min(0.85, rawRatio));
      split.style.setProperty("--split-ratio", String(ratio));
      applySplitRatio(first, ratio);
      applySplitRatio(second, 1 - ratio);
      onSplitRatioChange?.(splitId, ratio);
    };
    const cleanup = () => {
      body.style.userSelect = prevUserSelect;
      body.style.cursor = prevCursor;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
    const onMove = (event: PointerEvent) => updateFromEvent(event);
    const onUp = () => cleanup();
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
  });
}
