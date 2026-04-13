import type { PanelRecord, SplitNode } from "./types";

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
  host.innerHTML = "";
  if (!root) return;
  host.appendChild(renderNode(root, resolvePanel, onSplitRatioChange));
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
  first.appendChild(renderNode(node.first, resolvePanel, onSplitRatioChange));

  const handle = el("div", "zion-split-handle");
  handle.dataset.direction = node.direction;

  const second = el("div", "zion-split-child");
  applySplitRatio(second, 1 - node.ratio);
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
