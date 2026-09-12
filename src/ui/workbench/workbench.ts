import { activityBarRuntime, auxiliaryBarRuntime, bottomPanelRuntime, getInspectorTextSessionId, inspectorRuntime, responsiveRuntime, sideBarRuntime } from "./runtime";
import { createZionIcon, createZionIconFromCodicon, hasZionIcon, setZionIconOnly, zionIconName } from "../icons";
import { applyInspectorMarkdownCommentRanges, createInspectorMarkdownPreviewView, createInspectorTextView, getInspectorMarkdownSelection, openInspectorSearch, renderInspectorMarkdown, setInspectorLineWrapping } from "./inspectorContent";
import { createSelectionToolbarButton, createSelectionToolbarItemsContainer } from "../../editor/extensions/selection-toolbar";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

type InspectorRecentPage = {
  url: string;
  title: string;
  visitedAt: number;
};

type InspectorBrowserChoice = {
  key: string;
  icon: string;
  title: string;
  subtitle: string;
  value: string;
};

const INSPECTOR_RECENT_PAGES_KEY = "zion.inspector.recentPages";
const INSPECTOR_RECENT_PAGES_LIMIT = 24;
const ACTIVITY_BAR_WIDTH = 60;

function normalizeInspectorBrowserInput(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw);
  const isLocal = /^localhost(?::\d+)?(?:[/?#]|$)/i.test(raw)
    || /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#]|$)/.test(raw);
  const looksLikeUrl = hasScheme
    || isLocal
    || /^[^\s/]+\.[^\s]+(?:[/?#].*)?$/.test(raw)
    || /^[^\s]+\.[^\s]+\/[^\s]*$/.test(raw);
  const candidate = hasScheme ? raw : looksLikeUrl ? `${isLocal ? "http" : "https"}://${raw}` : "";
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
    } catch {}
  }
  return `https://www.bing.com/search?${new URLSearchParams({ q: raw }).toString()}`;
}

function inspectorTitleForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || url;
  } catch {
    return url;
  }
}

function readInspectorRecentPages(): InspectorRecentPage[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(INSPECTOR_RECENT_PAGES_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const url = normalizeInspectorBrowserInput(item?.url);
        if (!url) return null;
        return {
          url,
          title: String(item?.title || inspectorTitleForUrl(url)).trim() || inspectorTitleForUrl(url),
          visitedAt: Number.isFinite(Number(item?.visitedAt)) ? Number(item.visitedAt) : 0
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => b.visitedAt - a.visitedAt)
      .slice(0, INSPECTOR_RECENT_PAGES_LIMIT) as InspectorRecentPage[];
  } catch {
    return [];
  }
}

function writeInspectorRecentPages(items: InspectorRecentPage[]): void {
  try {
    localStorage.setItem(INSPECTOR_RECENT_PAGES_KEY, JSON.stringify(items.slice(0, INSPECTOR_RECENT_PAGES_LIMIT)));
  } catch {}
}

function rememberInspectorRecentPage(url: string, title?: string): void {
  const normalized = normalizeInspectorBrowserInput(url);
  if (!normalized) return;
  const nextTitle = String(title || inspectorTitleForUrl(normalized)).trim() || inspectorTitleForUrl(normalized);
  const rest = readInspectorRecentPages().filter((item) => item.url !== normalized);
  writeInspectorRecentPages([{ url: normalized, title: nextTitle, visitedAt: Date.now() }, ...rest]);
}

function attachInlineTabsScrollbar(viewport: HTMLElement, scroller: HTMLElement) {
  const track = el("div", "zion-inline-tabs-scrollbar");
  const thumb = el("div", "zion-inline-tabs-scrollbar-thumb");
  track.appendChild(thumb);
  viewport.appendChild(track);

  const sync = () => {
    try {
      const scrollerWidth = scroller.clientWidth || 0;
      const scrollWidth = scroller.scrollWidth || 0;
      const maxScrollLeft = Math.max(0, scrollWidth - scrollerWidth);
      const canScroll = maxScrollLeft > 1;
      const scrollLeft = canScroll
        ? Math.max(0, Math.min(maxScrollLeft, scroller.scrollLeft || 0))
        : 0;
      viewport.dataset.scrollable = canScroll ? "1" : "0";
      viewport.dataset.canScrollLeft = canScroll && scrollLeft > 1 ? "1" : "0";
      viewport.dataset.canScrollRight = canScroll && scrollLeft < maxScrollLeft - 1 ? "1" : "0";
      const thumbWidth = canScroll && scrollWidth > 0 && scrollerWidth > 0
        ? Math.max(24, Math.min(scrollerWidth, (scrollerWidth / scrollWidth) * scrollerWidth))
        : 0;
      const thumbLeft = canScroll && scrollerWidth > thumbWidth
        ? (scrollLeft / maxScrollLeft) * (scrollerWidth - thumbWidth)
        : 0;
      thumb.style.width = `${Math.max(0, thumbWidth)}px`;
      thumb.style.transform = `translateX(${Math.max(0, thumbLeft)}px)`;
    } catch {}
  };

  const setScrollLeft = (next: number) => {
    try {
      const maxScrollLeft = Math.max(0, (scroller.scrollWidth || 0) - (scroller.clientWidth || 0));
      scroller.scrollLeft = Math.max(0, Math.min(maxScrollLeft, next));
      sync();
    } catch {}
  };

  const jumpToPoint = (clientX: number) => {
    try {
      const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      if (maxScrollLeft <= 1) return;
      const rect = viewport.getBoundingClientRect();
      const thumbWidth = thumb.getBoundingClientRect().width || 24;
      const maxThumbLeft = Math.max(1, rect.width - thumbWidth);
      const nextThumbLeft = Math.max(0, Math.min(maxThumbLeft, clientX - rect.left - thumbWidth / 2));
      setScrollLeft((nextThumbLeft / maxThumbLeft) * maxScrollLeft);
    } catch {}
  };

  let isDragging = false;
  let dragStartX = 0;
  let dragStartScrollLeft = 0;
  const onPointerMove = (event: PointerEvent) => {
    if (!isDragging) return;
    try {
      const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      if (maxScrollLeft <= 1) return;
      const trackWidth = viewport.getBoundingClientRect().width || 0;
      const thumbWidth = thumb.getBoundingClientRect().width || 24;
      const maxThumbLeft = Math.max(1, trackWidth - thumbWidth);
      setScrollLeft(dragStartScrollLeft + ((event.clientX - dragStartX) / maxThumbLeft) * maxScrollLeft);
    } catch {}
  };
  const endDrag = () => {
    isDragging = false;
    try { document.body.classList.remove("is-dragging-inline-tabs-scrollbar"); } catch {}
  };
  scroller.addEventListener(
    "wheel",
    (event) => {
      try {
        if (scroller.scrollWidth <= scroller.clientWidth + 1) return;
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        if (!delta) return;
        const prev = scroller.scrollLeft;
        scroller.scrollLeft = prev + delta;
        if (Math.abs(scroller.scrollLeft - prev) > 0.5) {
          sync();
          event.preventDefault();
          event.stopPropagation();
        }
      } catch {}
    },
    { passive: false }
  );
  track.addEventListener("pointerdown", (event) => {
    try {
      event.preventDefault();
      event.stopPropagation();
    } catch {}
    jumpToPoint(event.clientX);
    if (scroller.scrollWidth <= scroller.clientWidth + 1) return;
    isDragging = true;
    dragStartX = event.clientX;
    dragStartScrollLeft = scroller.scrollLeft || 0;
    try { document.body.classList.add("is-dragging-inline-tabs-scrollbar"); } catch {}
  });
  scroller.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  window.addEventListener("resize", sync);
  let resizeObserver: ResizeObserver | null = null;
  try {
    resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(viewport);
    resizeObserver.observe(scroller);
  } catch {}
  requestAnimationFrame(sync);
  return { sync, resizeObserver };
}

function safeText(text: string) {
  return String(text ?? "");
}

function tr(key: string | undefined, fallback = ""): string {
  if (!key) return fallback;
  try {
    const translated = (window as any).zion?.i18n?.t?.(key);
    if (translated && translated !== key) return translated;
  } catch {}
  return fallback || key;
}

function translatedTitle(item: { title?: string; titleKey?: string } | null | undefined, fallback = ""): string {
  return tr(item?.titleKey, safeText(item?.title || fallback));
}

function translatedTooltip(item: { tooltip?: string; tooltipKey?: string } | null | undefined, fallback = ""): string {
  return tr(item?.tooltipKey, safeText(item?.tooltip || fallback));
}

/** 在元素上设置纯 ZionIcon（无文字标签） */
function setCodiconOnly(el: HTMLElement, iconName: string) {
  setZionIconOnly(el, zionIconName(iconName));
}

function appendIconAndLabel(target: HTMLElement, icon: string, label: string) {
  const value = String(icon || "").trim();
  target.textContent = "";
  const codiconMatch = value.match(/^\$\(([^)]+)\)$/);
  if (codiconMatch) {
    target.appendChild(createZionIconFromCodicon(codiconMatch[1]));
  } else if (hasZionIcon(value)) {
    target.appendChild(createZionIcon(zionIconName(value)));
  } else if (value) {
    const span = document.createElement("span");
    span.className = "zion-workbench-text-icon";
    span.textContent = safeText(value);
    span.setAttribute("aria-hidden", "true");
    target.appendChild(span);
  }
  if (label) {
    const text = document.createElement("span");
    text.textContent = safeText(label);
    target.appendChild(text);
  }
}

function appendActivityBarContent(target: HTMLElement, icon: string, label: string) {
  const iconHost = el("span", "zion-activitybar-icon");
  appendIconAndLabel(iconHost, icon, "");
  const text = el("span", "zion-activitybar-label");
  text.textContent = safeText(label);
  target.replaceChildren(iconHost, text);
}

function clearTabDragClasses(container: HTMLElement) {
  try {
    container.querySelectorAll(".is-dragging, .is-drag-over, .is-drop-before, .is-drop-after").forEach((node) => {
      node.classList.remove("is-dragging", "is-drag-over", "is-drop-before", "is-drop-after");
    });
  } catch {}
}

function installReorderableTab(
  tab: HTMLElement,
  container: HTMLElement,
  viewId: string,
  applyOrder: (ids: string[]) => void,
  orientation: "horizontal" | "vertical" = "horizontal"
) {
  let dragged = false;
  const isAfterMidpoint = (event: DragEvent, rect: DOMRect) => orientation === "vertical"
    ? event.clientY > rect.top + rect.height / 2
    : event.clientX > rect.left + rect.width / 2;
  tab.draggable = true;
  tab.addEventListener("dragstart", (event) => {
    dragged = true;
    tab.classList.add("is-dragging");
    try {
      event.dataTransfer?.setData("text/plain", viewId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    } catch {}
  });
  tab.addEventListener("dragover", (event) => {
    event.preventDefault();
    try {
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    } catch {}
    clearTabDragClasses(container);
    tab.classList.add("is-drag-over");
    const rect = tab.getBoundingClientRect();
    tab.classList.add(isAfterMidpoint(event, rect) ? "is-drop-after" : "is-drop-before");
  });
  tab.addEventListener("dragleave", () => {
    tab.classList.remove("is-drag-over");
  });
  tab.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const fromId = event.dataTransfer?.getData("text/plain") || "";
    const toId = viewId;
    clearTabDragClasses(container);
    if (!fromId || fromId === toId) return;
    const ids = Array.from(container.querySelectorAll<HTMLElement>("[data-view-id]"))
      .map((node) => node.dataset.viewId || "")
      .filter(Boolean);
    const fromIndex = ids.indexOf(fromId);
    const toIndex = ids.indexOf(toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const rect = tab.getBoundingClientRect();
    let insertIndex = isAfterMidpoint(event, rect) ? toIndex + 1 : toIndex;
    const [moved] = ids.splice(fromIndex, 1);
    if (fromIndex < insertIndex) insertIndex -= 1;
    ids.splice(Math.max(0, Math.min(ids.length, insertIndex)), 0, moved);
    applyOrder(ids);
  });
  tab.addEventListener("dragend", () => {
    clearTabDragClasses(container);
    window.setTimeout(() => {
      dragged = false;
    }, 0);
  });
  tab.addEventListener("click", (event) => {
    if (!dragged) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

function isScrollableY(el: HTMLElement): boolean {
  try {
    const st = getComputedStyle(el);
    const oy = st.overflowY;
    if (oy !== "auto" && oy !== "scroll") return false;
    return el.scrollHeight > el.clientHeight + 1;
  } catch {
    return false;
  }
}

function isScrollableX(el: HTMLElement): boolean {
  try {
    const st = getComputedStyle(el);
    const ox = st.overflowX;
    if (ox !== "auto" && ox !== "scroll") return false;
    return el.scrollWidth > el.clientWidth + 1;
  } catch {
    return false;
  }
}

function findScrollableTarget(start: EventTarget | null, root: HTMLElement, axis: "x" | "y"): HTMLElement | null {
  let cur = start as any;
  while (cur && cur instanceof HTMLElement) {
    if (cur === root) return null;
    if (root.contains(cur) && (axis === "x" ? isScrollableX(cur) : isScrollableY(cur))) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function getElementClientWidth(el: HTMLElement | null): number {
  if (!el) return 0;
  try {
    const width = el.clientWidth || el.getBoundingClientRect().width || 0;
    return typeof width === "number" && Number.isFinite(width) ? Math.max(0, width) : 0;
  } catch {
    return 0;
  }
}

export function keepHorizontalScrollerRightEdgeAnchored(
  scroller: HTMLElement | null,
  previousClientWidth: number,
  edgeDelta?: number
): void {
  if (!scroller || !scroller.classList.contains("is-horizontal-scroll")) return;
  const beforeWidth = typeof previousClientWidth === "number" && Number.isFinite(previousClientWidth)
    ? Math.max(0, previousClientWidth)
    : 0;
  const afterWidth = getElementClientWidth(scroller);
  const delta = typeof edgeDelta === "number" && Number.isFinite(edgeDelta)
    ? edgeDelta
    : beforeWidth - afterWidth;
  if (beforeWidth <= 0 || afterWidth <= 0 || Math.abs(delta) <= 0.5) return;
  const maxScrollLeft = Math.max(0, (scroller.scrollWidth || 0) - afterWidth);
  if (maxScrollLeft <= 1) return;
  const currentLeft = scroller.scrollLeft || 0;
  const nextLeft = Math.max(0, Math.min(maxScrollLeft, currentLeft + delta));
  if (Math.abs(nextLeft - currentLeft) <= 0.5) return;
  scroller.scrollLeft = nextLeft;
}

export function initWorkbench(host: HTMLElement): {
  editorHost: HTMLElement;
  editorHeaderPathEl: HTMLElement;
  editorTabsBarEl: HTMLElement;
  dispose: () => void;
} {
  const root = el("div", "zion-workbench");
  const activityBarEl = el("div", "zion-activitybar");
  const sideBarEl = el("div", "zion-sidebar");
  const editorEl = el("div", "zion-editor");
  const auxiliaryBarEl = el("div", "zion-auxbar");
  auxiliaryBarEl.setAttribute("role", "complementary");
  auxiliaryBarEl.setAttribute("aria-label", "辅助栏");
  const inspectorEl = el("aside", "zion-inspector");
  inspectorEl.setAttribute("aria-label", "内容查看区");
  const bottomPanelEl = el("div", "zion-bottompanel");
  const overlayMaskEl = el("div", "zion-overlay-mask");
    const resizeDragShieldEl = el("div", "zion-resize-drag-shield");
  const mobileBarEl = el("div", "zion-mobilebar");
  const mobileBarListEl = el("div", "zion-mobilebar-list");
  const mobileBarActionsEl = el("div", "zion-mobilebar-actions");
  mobileBarEl.appendChild(mobileBarListEl);
  mobileBarEl.appendChild(mobileBarActionsEl);

  const editorTabsBarEl = el("div", "zion-editor-tabsbar");
  const editorHeaderEl = el("div", "zion-editor-header");
  const editorHeaderPathEl = el("div", "zion-editor-session-path");
  editorHeaderEl.appendChild(editorHeaderPathEl);
  const editorHost = el("div", "zion-editor-host");
  editorEl.appendChild(editorTabsBarEl);
  editorEl.appendChild(editorHeaderEl);
  editorEl.appendChild(editorHost);

  root.appendChild(activityBarEl);
  root.appendChild(sideBarEl);
  root.appendChild(editorEl);
  root.appendChild(inspectorEl);
  root.appendChild(auxiliaryBarEl);
  root.appendChild(bottomPanelEl);
  root.appendChild(overlayMaskEl);
    root.appendChild(resizeDragShieldEl);
  root.appendChild(mobileBarEl);

  host.appendChild(root);

    // Individual panels retain their own minimum width and scroll when needed.
    // This is only the smallest usable viewport for the entire editor region.
    const EDITOR_MIN_WIDTH = 320;
    const SIDEBAR_RESTORE_GAP = 72;
    let sidebarAutoCollapsedForWidePanels = false;
    let wideningSidePanelByDrag = false;
    let sidePanelResizeActive = false;
    let adjustingSidebarForWidePanels = false;
    const setResizeDragShield = (active: boolean, cursor = "col-resize") => {
      resizeDragShieldEl.classList.toggle("is-active", active);
      resizeDragShieldEl.style.cursor = active ? cursor : "";
    };
  const scrollTimers = new Map<HTMLElement, number>();
  let lastUserScrollIntentAt = 0;
  const markUserScrollIntent = () => {
    try { lastUserScrollIntentAt = performance.now(); } catch { lastUserScrollIntentAt = Date.now(); }
  };
  const getScrollableElementFromTarget = (target: EventTarget | null) => {
    let node = target instanceof HTMLElement ? target : null;
    while (node && node !== root) {
      try {
        const cs = getComputedStyle(node);
        const canScrollY = /(auto|scroll|overlay)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 1;
        const canScrollX = /(auto|scroll|overlay)/.test(cs.overflowX) && node.scrollWidth > node.clientWidth + 1;
        if (canScrollY || canScrollX) return node;
      } catch {}
      node = node.parentElement;
    }
    return null;
  };
  const onPointerDownCapture = (e: PointerEvent) => {
    const el0 = getScrollableElementFromTarget(e.target);
    if (!el0) return;
    try {
      const rect = el0.getBoundingClientRect();
      const gutter = 14;
      const onVerticalScrollbar = el0.scrollHeight > el0.clientHeight + 1
        && e.clientX >= rect.right - gutter
        && e.clientX <= rect.right + 1;
      const onHorizontalScrollbar = el0.scrollWidth > el0.clientWidth + 1
        && e.clientY >= rect.bottom - gutter
        && e.clientY <= rect.bottom + 1;
      if (onVerticalScrollbar || onHorizontalScrollbar) markUserScrollIntent();
    } catch {}
  };
  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if ([
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "PageUp",
      "PageDown",
      "Home",
      "End",
      " ",
    ].includes(e.key)) markUserScrollIntent();
  };
  const onScrollCapture = (e: Event) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    try {
      const now = performance.now();
      const isUserScroll = now - lastUserScrollIntentAt < 500 || t.classList.contains("zion-scroll-active");
      if (!isUserScroll) return;
      t.classList.add("zion-scroll-active");
      const prev = scrollTimers.get(t);
      if (prev) window.clearTimeout(prev);
      const tid = window.setTimeout(() => {
        try { t.classList.remove("zion-scroll-active"); } catch {}
      }, 700);
      scrollTimers.set(t, tid);
    } catch {}
  };
  root.addEventListener("wheel", markUserScrollIntent, true);
  root.addEventListener("touchmove", markUserScrollIntent, true);
  root.addEventListener("pointerdown", onPointerDownCapture, true);
  root.addEventListener("keydown", onKeyDownCapture, true);
  root.addEventListener("scroll", onScrollCapture, true);

  const updateOverlayMask = () => {
    const isMobile = responsiveRuntime.getCurrentDeviceType() === "mobile";
    const isCompactOverlay = isMobile || responsiveRuntime.getCurrentMode() === "medium";
    const hasSide = sideBarRuntime.isVisible() && sideBarRuntime.getViews().length > 0;
    const hasAux = auxiliaryBarRuntime.isVisible() && auxiliaryBarRuntime.getViews().length > 0;
    const hasInspector = inspectorRuntime.isVisible();
    const hasBottom = bottomPanelRuntime.isVisible() && bottomPanelRuntime.getViews().length > 0;
    const hasOverlay =
      (isMobile && hasSide) ||
      (isCompactOverlay && hasAux) ||
      (isCompactOverlay && hasInspector) ||
      (isCompactOverlay && hasBottom);
    overlayMaskEl.style.left = !isMobile && isCompactOverlay
      ? "calc(var(--activitybar-w, 0px) + var(--sidebar-w, 0px))"
      : "0px";
    overlayMaskEl.style.bottom = isMobile
      ? "calc(var(--mobilebar-h, 0px) + var(--safe-bottom, 0px))"
      : "0px";
    overlayMaskEl.style.display = hasOverlay ? "block" : "none";
  };

  overlayMaskEl.onmousedown = (e) => {
    if (e.target !== overlayMaskEl) return;
    try {
      sideBarRuntime.hide();
    } catch {}
    try {
      auxiliaryBarRuntime.hide();
    } catch {}
    try {
      inspectorRuntime.hide();
    } catch {}
    try {
      bottomPanelRuntime.hide();
    } catch {}
  };

  const applyRowHeights = () => {
    const isMobile = responsiveRuntime.getCurrentDeviceType() === "mobile";
    const isCompactOverlay = isMobile || responsiveRuntime.getCurrentMode() === "medium";
    const visible = bottomPanelRuntime.isVisible();
    const hasViews = bottomPanelRuntime.getViews().length > 0;
    const maximized = bottomPanelRuntime.isMaximized();
    const h = bottomPanelRuntime.getHeight();
    let out = visible && hasViews ? h : 0;
    if (visible && hasViews && maximized) {
      try {
        const rh = root.getBoundingClientRect().height;
        out = Math.max(160, Math.round(rh - 160));
      } catch {}
    }
    if (isCompactOverlay) {
      root.style.setProperty("--bottompanel-h", `0px`);
      root.style.setProperty("--bottompanel-overlay-h", `${Math.max(0, out)}px`);
      updateOverlayMask();
      return;
    }
    root.style.setProperty("--bottompanel-overlay-h", `0px`);
    root.style.setProperty("--bottompanel-h", `${Math.max(0, out)}px`);
    updateOverlayMask();
  };

  const getMediumOverlayMetrics = () => {
    const rootWidth = Math.max(0, root.getBoundingClientRect().width);
    const activityWidth = activityBarRuntime.isVisible() ? ACTIVITY_BAR_WIDTH : 0;
    const sidebarWidth = sideBarRuntime.isVisible() && sideBarRuntime.getViews().length > 0
      ? sideBarRuntime.getWidth()
      : 0;
    const editorWidth = Math.max(0, rootWidth - activityWidth - sidebarWidth);
    const requestedAuxWidth = auxiliaryBarRuntime.getWidth();
    const auxWidth = Math.max(
      200,
      Math.min(300, requestedAuxWidth, Math.round(editorWidth * 0.34))
    );
    const requestedInspectorWidth = inspectorRuntime.getWidth();
    const inspectorPreferredWidth = Math.max(
      260,
      Math.min(520, requestedInspectorWidth, Math.round(editorWidth * 0.52))
    );
    const hasAuxiliaryBar = auxiliaryBarRuntime.isVisible()
      && auxiliaryBarRuntime.getViews().length > 0;
    const inspectorMaxWidth = hasAuxiliaryBar
      ? Math.max(180, editorWidth - auxWidth)
      : Math.max(260, Math.round(editorWidth * 0.72));
    return {
      auxWidth,
      inspectorWidth: Math.min(inspectorPreferredWidth, inspectorMaxWidth)
    };
  };

  const getDesktopPanelMetrics = (xVisible: boolean, inspectorVisible: boolean) => {
    const rootWidth = Math.max(0, root.getBoundingClientRect().width);
    const activityWidth = activityBarRuntime.isVisible() ? ACTIVITY_BAR_WIDTH : 0;
    const sidebarWidth = sideBarRuntime.isVisible() && sideBarRuntime.getViews().length > 0
      ? sideBarRuntime.getWidth()
      : 0;
    const editorWidth = Math.max(0, rootWidth - activityWidth - sidebarWidth);
      const panelBudget = Math.max(0, editorWidth - EDITOR_MIN_WIDTH);
    const requestedAuxWidth = auxiliaryBarRuntime.getWidth();
    const requestedInspectorWidth = inspectorRuntime.getWidth();
      let auxWidth = xVisible ? requestedAuxWidth : 0;
      let inspectorWidth = inspectorVisible ? requestedInspectorWidth : 0;
    if (xVisible && inspectorVisible && auxWidth + inspectorWidth > panelBudget) {
      // Keep the main editor wide enough for one complete panel first. When
      // space is tight, Inspector yields before Auxiliary bar; Auxiliary bar
      // only shrinks once Inspector would become unusably narrow.
      const inspectorFloor = Math.min(280, panelBudget);
      if (panelBudget - auxWidth >= inspectorFloor) {
        inspectorWidth = Math.max(0, panelBudget - auxWidth);
      } else {
        auxWidth = Math.max(0, Math.min(auxWidth, panelBudget - inspectorFloor));
        inspectorWidth = Math.max(0, panelBudget - auxWidth);
      }
    } else if (xVisible && auxWidth > panelBudget) {
      auxWidth = Math.max(0, panelBudget);
    } else if (inspectorVisible && inspectorWidth > panelBudget) {
      inspectorWidth = Math.max(0, panelBudget);
    }
    return { auxWidth, inspectorWidth };
  };

  const applyColumnWidths = () => {
    const isMobile = responsiveRuntime.getCurrentDeviceType() === "mobile";
    const isCompactOverlay = isMobile || responsiveRuntime.getCurrentMode() === "medium";
    const aVisible = activityBarRuntime.isVisible();
    const sVisible = sideBarRuntime.isVisible() && sideBarRuntime.getViews().length > 0;
    const xVisible = auxiliaryBarRuntime.isVisible() && auxiliaryBarRuntime.getViews().length > 0;
    const inspectorVisible = inspectorRuntime.isVisible();
    const w = sideBarRuntime.getWidth();
    const xw = auxiliaryBarRuntime.getWidth();
    const inspectorWidth = inspectorRuntime.getWidth();
      const requestedSidePanelWidth = (xVisible ? xw : 0) + (inspectorVisible ? inspectorWidth : 0);
      const sidebarBudget = Math.max(
        0,
        root.getBoundingClientRect().width - (aVisible ? ACTIVITY_BAR_WIDTH : 0) - w - EDITOR_MIN_WIDTH
      );

      if (!isMobile && !isCompactOverlay && sVisible && wideningSidePanelByDrag
        && requestedSidePanelWidth > sidebarBudget) {
        sidebarAutoCollapsedForWidePanels = true;
        adjustingSidebarForWidePanels = true;
        try {
          sideBarRuntime.hide();
        } finally {
          adjustingSidebarForWidePanels = false;
        }
        return;
      }

      if (!isMobile && !isCompactOverlay && sidebarAutoCollapsedForWidePanels && !sVisible
        && !sidePanelResizeActive
        && requestedSidePanelWidth <= Math.max(0, sidebarBudget - SIDEBAR_RESTORE_GAP)) {
        sidebarAutoCollapsedForWidePanels = false;
        adjustingSidebarForWidePanels = true;
        try {
          sideBarRuntime.show();
        } finally {
          adjustingSidebarForWidePanels = false;
        }
        return;
      }

    const mediumOverlay = !isMobile && isCompactOverlay
      ? getMediumOverlayMetrics()
      : null;
    const desktopPanels = !isCompactOverlay
      ? getDesktopPanelMetrics(xVisible, inspectorVisible)
      : null;
    if (isMobile) {
      root.style.setProperty("--activitybar-w", "0px");
      root.style.setProperty("--sidebar-w", "0px");
      root.style.setProperty("--auxbar-w", "0px");
      root.style.setProperty("--inspector-w", "0px");
      root.style.setProperty("--sidebar-editor-gap", "0px");
      root.style.setProperty("--editor-auxbar-gap", "0px");
      root.style.setProperty("--editor-inspector-gap", "0px");
      root.style.setProperty("--inspector-auxbar-gap", "0px");
      root.style.setProperty("--auxbar-leading-gap", "0px");
      root.style.setProperty("--sidebar-overlay-w", `${w}px`);
      root.style.setProperty(
        "--auxbar-overlay-w",
        `${Math.min(Math.max(240, Math.round(root.getBoundingClientRect().width * 0.86)), 380)}px`
      );
      root.style.setProperty("--auxbar-overlay-offset", "0px");
      activityBarEl.style.visibility = "hidden";
      activityBarEl.style.pointerEvents = "none";
    } else {
      root.style.setProperty("--activitybar-w", aVisible ? `${ACTIVITY_BAR_WIDTH}px` : "0px");
      root.style.setProperty("--sidebar-w", sVisible ? `${w}px` : "0px");
      root.style.setProperty(
        "--auxbar-w",
        !isCompactOverlay && xVisible ? `${desktopPanels?.auxWidth ?? xw}px` : "0px"
      );
      root.style.setProperty(
        "--inspector-w",
        !isCompactOverlay && inspectorVisible
          ? `${desktopPanels?.inspectorWidth ?? inspectorWidth}px`
          : "0px"
      );
        root.style.setProperty("--sidebar-editor-gap", "0px");
      root.style.setProperty("--editor-auxbar-gap", "0px");
      root.style.setProperty(
        "--editor-inspector-gap",
        !isCompactOverlay && inspectorVisible
          ? "var(--panel-split-gap-size, 6px)"
          : "0px"
      );
      root.style.setProperty("--inspector-auxbar-gap", "0px");
      root.style.setProperty(
          "--auxbar-leading-gap",
          "0px"
      );
      root.style.setProperty("--auxbar-overlay-w", `${mediumOverlay?.auxWidth ?? xw}px`);
      root.style.setProperty(
        "--inspector-overlay-w",
        `${mediumOverlay?.inspectorWidth ?? inspectorWidth}px`
      );
      root.style.setProperty(
        "--auxbar-overlay-offset",
        isCompactOverlay && xVisible
          ? `${mediumOverlay?.auxWidth ?? xw}px`
          : "0px"
      );
      activityBarEl.style.visibility = aVisible ? "visible" : "hidden";
      activityBarEl.style.pointerEvents = aVisible ? "auto" : "none";
    }
    sideBarEl.style.visibility = sVisible ? "visible" : "hidden";
    sideBarEl.style.pointerEvents = sVisible ? "auto" : "none";
    auxiliaryBarEl.style.visibility = xVisible ? "visible" : "hidden";
    auxiliaryBarEl.style.pointerEvents = xVisible ? "auto" : "none";
    inspectorEl.style.visibility = inspectorVisible ? "visible" : "hidden";
    inspectorEl.style.pointerEvents = inspectorVisible ? "auto" : "none";
      root.classList.toggle(
        "has-inspector-adjacent-auxbar",
        !isCompactOverlay && xVisible && inspectorVisible
      );
    auxiliaryBarEl.style.borderLeft = isCompactOverlay && xVisible && !inspectorVisible
      ? "1px solid var(--surface-border-soft, var(--border-subtle))"
      : "";
    inspectorEl.style.borderRight = inspectorVisible
      ? (xVisible
        ? "1px solid color-mix(in srgb, var(--surface-border-soft, var(--border-subtle)) 62%, transparent)"
        : "1px solid var(--surface-border-soft, var(--border-subtle))")
      : "";
    updateOverlayMask();
  };

  const getOverlayReservedBottom = () => {
    try {
      const isMobile = responsiveRuntime.getCurrentDeviceType() === "mobile";
      if (!isMobile) return 0;
      const rect = mobileBarEl.getBoundingClientRect();
      return Math.max(0, Math.round(rect.height || 0));
    } catch {
      return 0;
    }
  };

  const getOverlayBottomHeightPx = () => {
    const requested = bottomPanelRuntime.getHeight();
    const maximized = bottomPanelRuntime.isMaximized();
    try {
      const rect = root.getBoundingClientRect();
      const reserved = getOverlayReservedBottom();
      const maxAllowed = Math.max(160, Math.round(rect.height - reserved - 24));
      const desired = maximized ? Math.max(160, Math.round(rect.height - reserved - 32)) : requested;
      return Math.max(120, Math.min(maxAllowed, Math.round(desired)));
    } catch {
      return Math.max(120, Math.round(requested));
    }
  };

  const getOverlayAuxWidthPx = (isMobile: boolean) => {
    const requested = auxiliaryBarRuntime.getWidth();
    try {
      if (!isMobile) return getMediumOverlayMetrics().auxWidth;
      const rect = root.getBoundingClientRect();
      const maxAllowed = Math.round(rect.width * 0.92);
      return Math.min(380, Math.max(240, Math.min(maxAllowed, Math.round(requested))));
    } catch {
      return Math.max(240, Math.round(requested));
    }
  };

  const getBottomPanelOverlayRightPx = (isMobile: boolean) => {
    if (isMobile) return 0;
    try {
      const hasAux = auxiliaryBarRuntime.isVisible() && auxiliaryBarRuntime.getViews().length > 0;
      return hasAux ? getOverlayAuxWidthPx(false) : 0;
    } catch {
      return 0;
    }
  };

  const getMediumOverlayLeftPx = () => {
    try {
      const activityW = activityBarRuntime.isVisible() ? ACTIVITY_BAR_WIDTH : 0;
      const sideW = sideBarRuntime.isVisible() && sideBarRuntime.getViews().length > 0 ? sideBarRuntime.getWidth() : 0;
      return Math.max(0, activityW + sideW);
    } catch {
      return 0;
    }
  };

  const renderMobileBar = () => {
    const isMobile = responsiveRuntime.getCurrentDeviceType() === "mobile";
    mobileBarEl.style.display = isMobile ? "flex" : "none";
    if (!isMobile) return;
    const items = activityBarRuntime.getItems();
    const activeId = activityBarRuntime.getActiveItemId();
    mobileBarListEl.innerHTML = "";
    for (const it of items) {
      const btn = el("button", "zion-mobilebar-item") as HTMLButtonElement;
      btn.type = "button";
      btn.title = safeText(it.tooltip || "");
      btn.setAttribute("aria-label", safeText(it.tooltip || it.id));
      if (activeId === it.id) btn.classList.add("is-active");
      const icon = String(it.icon || "").trim();
      btn.textContent = "";
      const codiconMatch = icon.match(/^\$\(([^)]+)\)$/);
      if (codiconMatch) {
        btn.appendChild(createZionIconFromCodicon(codiconMatch[1]));
      } else if (hasZionIcon(icon)) {
        btn.appendChild(createZionIcon(zionIconName(icon)));
      } else {
        btn.textContent = safeText(icon);
      }
      btn.onclick = () => activityBarRuntime.activateItem(it.id);
      mobileBarListEl.appendChild(btn);
    }
    mobileBarActionsEl.innerHTML = "";
    const cmdBtn = el("button", "zion-mobilebar-action") as HTMLButtonElement;
    cmdBtn.type = "button";
    cmdBtn.title = "Commands";
    cmdBtn.setAttribute("aria-label", "Commands");
    setCodiconOnly(cmdBtn, "search");
    cmdBtn.onclick = () => {
      try {
        (window as any).zion?.commands?.executeCommand?.("commandPalette.open");
      } catch {}
    };
    mobileBarActionsEl.appendChild(cmdBtn);
    const settingsBtn = el("button", "zion-mobilebar-action") as HTMLButtonElement;
    settingsBtn.type = "button";
    settingsBtn.title = "设置";
    settingsBtn.setAttribute("aria-label", "设置");
    setCodiconOnly(settingsBtn, "settings-gear");
    settingsBtn.onclick = () => {
      try {
        (window as any).zion?.settings?.open?.();
      } catch {}
    };
    mobileBarActionsEl.appendChild(settingsBtn);
  };

  const renderActivityBar = () => {
    applyColumnWidths();
    activityBarEl.innerHTML = "";
    if (!activityBarRuntime.isVisible()) return;

    const items = activityBarRuntime.getItems();
    const activeId = activityBarRuntime.getActiveItemId();

    const list = el("div", "zion-activitybar-list");
    const createCommandSearchButton = () => {
      const button = el("button", "zion-activitybar-item zion-activitybar-command") as HTMLButtonElement;
      button.type = "button";
      button.title = "搜索命令";
      button.setAttribute("aria-label", "搜索命令");
      appendActivityBarContent(button, "$(search)", "搜索");
      button.onclick = () => {
        try {
          (window as any).zion?.commands?.executeCommand?.("commandPalette.open");
        } catch {}
      };
      return button;
    };
    let commandSearchAdded = false;
    for (const it of items) {
      const btn = el("button", "zion-activitybar-item");
      btn.type = "button";
      const tooltip = translatedTooltip(it, it.id);
      btn.title = tooltip;
      btn.setAttribute("aria-label", tooltip);
      if (activeId === it.id) btn.classList.add("is-active");
      const icon = String(it.icon || "").trim();
      appendActivityBarContent(btn, icon, tooltip);
      btn.onclick = () => activityBarRuntime.activateItem(it.id);
      list.appendChild(btn);
      if (it.id === "sessions.activity") {
        list.appendChild(createCommandSearchButton());
        commandSearchAdded = true;
      }
    }
    if (!commandSearchAdded) list.prepend(createCommandSearchButton());
    activityBarEl.appendChild(list);

    // Bottom actions area
    const bottom = el("div", "zion-activitybar-bottom");

    const settingsBtn = el("button", "zion-activitybar-item zion-activitybar-settings") as HTMLButtonElement;
    settingsBtn.type = "button";
    settingsBtn.title = "设置";
    settingsBtn.setAttribute("aria-label", "设置");
    appendActivityBarContent(settingsBtn, "$(settings)", "设置");
    settingsBtn.onclick = () => {
      try {
        (window as any).zion?.settings?.open?.();
      } catch {}
    };
    bottom.appendChild(settingsBtn);

    activityBarEl.appendChild(bottom);
  };

  let mountedViewId: string | null = null;
  let mountedDisposable: { dispose?: () => void } | null = null;
  let resizeObs: ResizeObserver | null = null;
  let mountedHeaderLeadingViewId: string | null = null;
  let mountedHeaderLeadingDisposable: { dispose?: () => void } | null = null;
  let mountedHeaderLeadingGeneration: number | null = null;
  let nextHeaderLeadingGeneration = 0;

  sideBarEl.style.position = "relative";
  const header = el("div", "zion-sidebar-header");
  const headerLeading = el("div", "zion-sidebar-header-leading");
  const headerMain = el("div", "zion-sidebar-header-main");
  const headerTitle = el("div", "zion-sidebar-title");
  const headerActions = el("div", "zion-sidebar-actions");
  const hideBtn = el("button", "zion-sidebar-action");
  hideBtn.type = "button";
  hideBtn.title = "Hide Side Bar";
  hideBtn.setAttribute("aria-label", "Hide Side Bar");
  setCodiconOnly(hideBtn, "columns-2");
  hideBtn.onclick = () => sideBarRuntime.hide();
  headerActions.appendChild(hideBtn);
  headerMain.append(headerTitle, headerActions);
  header.append(headerLeading, headerMain);

  const tabs = el("div", "zion-sidebar-tabs");
  const content = el("div", "zion-sidebar-content");
  const emptyMsg = el("div", "zion-sidebar-empty");
  emptyMsg.textContent = "暂无可用视图";
  const resizer = el("div", "zion-sidebar-resizer");

  sideBarEl.appendChild(header);
  sideBarEl.appendChild(tabs);
  sideBarEl.appendChild(content);
  sideBarEl.appendChild(resizer);

  const preventScrollChain = (rootEl: HTMLElement, fallback: HTMLElement) => {
    rootEl.addEventListener(
      "wheel",
      (e) => {
        const we = e as WheelEvent;
        try {
          const absX = Math.abs(we.deltaX || 0);
          const absY = Math.abs(we.deltaY || 0);
          const useX = we.shiftKey || absX > absY;
          const axis = useX ? "x" : "y";
          const target = findScrollableTarget(we.target, rootEl, axis) || fallback;
          if (axis === "x") {
            const dx = we.deltaX || 0;
            const dy = we.deltaY || 0;
            target.scrollLeft += dx !== 0 ? dx : dy;
          } else {
            target.scrollTop += we.deltaY;
        }
        } catch {}
        we.preventDefault();
        we.stopPropagation();
      },
      { passive: false }
    );
  };

  preventScrollChain(activityBarEl, activityBarEl);
  preventScrollChain(sideBarEl, content);
  preventScrollChain(inspectorEl, inspectorEl);
  preventScrollChain(auxiliaryBarEl, auxiliaryBarEl);
  preventScrollChain(bottomPanelEl, bottomPanelEl);

  auxiliaryBarEl.style.position = "relative";
  const auxHeader = el("div", "zion-auxbar-header");
  const auxHeadLeft = el("div", "zion-auxbar-headleft");
  const auxTitle = el("div", "zion-auxbar-title");
  const auxActions = el("div", "zion-auxbar-actions");
  auxHeadLeft.appendChild(auxTitle);
  auxHeader.appendChild(auxHeadLeft);
  auxHeader.appendChild(auxActions);
  const auxContent = el("div", "zion-auxbar-content");
  const auxEmpty = el("div", "zion-auxbar-empty");
  auxEmpty.textContent = "暂无可用视图";
  const auxRail = el("nav", "zion-auxbar-rail");
  auxRail.setAttribute("role", "tablist");
  auxRail.setAttribute("aria-label", "辅助栏视图");
  auxRail.setAttribute("aria-orientation", "vertical");
  const auxResizer = el("div", "zion-auxbar-resizer");

  auxiliaryBarEl.appendChild(auxHeader);
  auxiliaryBarEl.appendChild(auxContent);
  auxiliaryBarEl.appendChild(auxRail);
  auxiliaryBarEl.appendChild(auxResizer);

  let auxMountedViewId: string | null = null;
  let auxMountGeneration = 0;
  const auxTransientRecords = new Set<{
    viewId: string;
    container: HTMLElement;
    disposable: { dispose?: () => void } | null;
    obs: ResizeObserver | null;
  }>();
  const auxKeepContainers = new Map<
    string,
    { container: HTMLElement; disposable: { dispose?: () => void } | null; obs: ResizeObserver | null }
  >();

  const removeAuxTransientRecord = (rec: {
    viewId: string;
    container: HTMLElement;
    disposable: { dispose?: () => void } | null;
    obs: ResizeObserver | null;
  }) => {
    auxTransientRecords.delete(rec);
    try {
      rec.disposable?.dispose?.();
    } catch {}
    try {
      rec.obs?.disconnect();
    } catch {}
    try {
      rec.container.remove();
    } catch {}
  };

  const removeAuxTransientRecordsForView = (viewId: string | null) => {
    if (!viewId) return;
    for (const rec of Array.from(auxTransientRecords)) {
      if (rec.viewId === viewId) removeAuxTransientRecord(rec);
    }
  };

  const removeAuxTransientRecordsExcept = (...viewIds: Array<string | null>) => {
    const keep = new Set(viewIds.filter(Boolean) as string[]);
    for (const rec of Array.from(auxTransientRecords)) {
      if (!keep.has(rec.viewId)) removeAuxTransientRecord(rec);
    }
  };

  const auxUnmountView = async (viewId: string | null, generation = auxMountGeneration) => {
    if (!viewId) return;
    const prev = auxiliaryBarRuntime.getView(viewId);
    try {
      await prev?.onDeactivate?.();
    } catch {}
    if (generation !== auxMountGeneration) return;
    const keep = !!prev?.keepWhenActive;
    if (keep) {
      const rec = auxKeepContainers.get(viewId);
      if (rec?.container) rec.container.style.display = "none";
      return;
    }
    removeAuxTransientRecordsForView(viewId);
  };

  const auxMountView = async (viewId: string | null, container: HTMLElement, generation = auxMountGeneration) => {
    if (!viewId) {
      return;
    }
    const view = auxiliaryBarRuntime.getView(viewId);
    if (!view) {
      return;
    }
    if (generation !== auxMountGeneration || auxMountedViewId !== viewId) return;
    const keep = !!view.keepWhenActive;
    if (keep) {
      const existing = auxKeepContainers.get(viewId);
      if (existing) {
        existing.container.style.display = "block";
        try {
          if (generation === auxMountGeneration && auxMountedViewId === viewId) {
            await view.onActivate?.();
          }
        } catch {}
        return;
      }
      const c = el("div", "zion-auxbar-view");
      c.style.height = "100%";
      c.style.width = "100%";
      c.style.minHeight = "0";
      c.dataset.viewId = viewId;
      c.dataset.viewKind = "keep";
      container.appendChild(c);
      let disp: any = null;
      try {
        disp = view.component.render(c) as any;
      } catch {
        c.innerHTML = "";
      }
      let obs: ResizeObserver | null = null;
      try {
        obs = new ResizeObserver(() => {
          try {
            const r = c.getBoundingClientRect();
            view.onResize?.({ width: r.width, height: r.height });
          } catch {}
        });
        obs.observe(c);
      } catch {}
      auxKeepContainers.set(viewId, { container: c, disposable: disp, obs });
      try {
        if (generation === auxMountGeneration && auxMountedViewId === viewId) {
          await view.onActivate?.();
        }
      } catch {}
      return;
    }

    removeAuxTransientRecordsForView(viewId);
    const c = el("div", "zion-auxbar-view");
    c.style.height = "100%";
    c.style.width = "100%";
    c.style.minHeight = "0";
    c.dataset.viewId = viewId;
    c.dataset.viewKind = "transient";
    container.appendChild(c);
    const rec = { viewId, container: c, disposable: null as { dispose?: () => void } | null, obs: null as ResizeObserver | null };
    auxTransientRecords.add(rec);
    try {
      const ret = view.component.render(c);
      rec.disposable = (ret as any) || null;
    } catch {
      c.innerHTML = "";
    }
    if (generation !== auxMountGeneration || auxMountedViewId !== viewId) {
      removeAuxTransientRecord(rec);
      return;
    }
    try {
      if (generation === auxMountGeneration && auxMountedViewId === viewId) {
        await view.onActivate?.();
      }
    } catch {}
    if (generation !== auxMountGeneration || auxMountedViewId !== viewId) {
      removeAuxTransientRecord(rec);
      return;
    }
    try {
      rec.obs = new ResizeObserver(() => {
        try {
          const r = c.getBoundingClientRect();
          view.onResize?.({ width: r.width, height: r.height });
        } catch {}
      });
      rec.obs.observe(c);
    } catch {}
  };

  const renderAuxiliaryBar = () => {
    applyRowHeights();
    applyColumnWidths();
    const isMobile = responsiveRuntime.getCurrentDeviceType() === "mobile";
    const isCompactOverlay = isMobile || responsiveRuntime.getCurrentMode() === "medium";
    const views = auxiliaryBarRuntime.getViews();
    try {
      const alive = new Set(views.map(v => v.id));
      for (const [id, rec] of Array.from(auxKeepContainers.entries())) {
        if (alive.has(id)) continue;
        try {
          rec.obs?.disconnect();
        } catch {}
        try {
          rec.disposable?.dispose?.();
        } catch {}
        try {
          rec.container.remove();
        } catch {}
        auxKeepContainers.delete(id);
      }
      for (const rec of Array.from(auxTransientRecords)) {
        if (!alive.has(rec.viewId)) removeAuxTransientRecord(rec);
      }
    } catch {}
    const visible = auxiliaryBarRuntime.isVisible() && views.length > 0;
    if (isCompactOverlay) {
      auxiliaryBarEl.style.position = "absolute";
      auxiliaryBarEl.style.left = "";
      auxiliaryBarEl.style.right = "0";
      auxiliaryBarEl.style.top = "0";
      auxiliaryBarEl.style.bottom = `${getOverlayReservedBottom()}px`;
      auxiliaryBarEl.style.width = `${getOverlayAuxWidthPx(isMobile)}px`;
      auxiliaryBarEl.style.maxWidth = "";
      auxiliaryBarEl.style.zIndex = "70";
      auxiliaryBarEl.style.boxShadow = "0 12px 40px rgba(0, 0, 0, 0.35)";
    } else {
      auxiliaryBarEl.style.position = "relative";
      auxiliaryBarEl.style.left = "";
      auxiliaryBarEl.style.right = "";
      auxiliaryBarEl.style.top = "";
      auxiliaryBarEl.style.bottom = "";
      auxiliaryBarEl.style.width = "";
      auxiliaryBarEl.style.maxWidth = "";
      auxiliaryBarEl.style.zIndex = "";
      auxiliaryBarEl.style.boxShadow = "";
    }
    if (!visible) {
      const previousId = auxMountedViewId;
      const generation = ++auxMountGeneration;
      auxMountedViewId = null;
      auxRail.innerHTML = "";
      try {
        for (const rec of auxKeepContainers.values()) rec.container.style.display = "none";
      } catch {}
      void (async () => {
        await auxUnmountView(previousId, generation);
        if (generation === auxMountGeneration) removeAuxTransientRecordsExcept(null);
      })();
      return;
    }

    const activeViewId = auxiliaryBarRuntime.getActiveViewId();

    const nextId = activeViewId && auxiliaryBarRuntime.getView(activeViewId) ? activeViewId : views[0]?.id ?? null;
    if (nextId !== activeViewId && nextId) {
      auxiliaryBarRuntime.activateView(nextId);
    }
    const activeView = nextId ? auxiliaryBarRuntime.getView(nextId) : null;
    auxTitle.textContent = translatedTitle(activeView, "Auxiliary Bar");

    auxActions.querySelectorAll(".zion-auxbar-plugin-action").forEach((node) => node.remove());
    const pluginActions = document.createDocumentFragment();
    for (const action of activeView?.headerActions || []) {
      const btn = el("button", "zion-auxbar-action zion-auxbar-plugin-action") as HTMLButtonElement;
      btn.type = "button";
      const title = translatedTitle(action as any);
      btn.title = title;
      btn.setAttribute("aria-label", tr((action as any).ariaLabelKey, safeText(action.ariaLabel || title)));
      const actionAny = action as any;
      const syncActive = () => {
        let active = false;
        try {
          active = typeof actionAny.active === "function" ? !!actionAny.active() : !!actionAny.active;
        } catch {}
        btn.classList.toggle("is-active", active);
        if (actionAny.active === undefined) btn.removeAttribute("aria-pressed");
        else btn.setAttribute("aria-pressed", String(active));
      };
      appendIconAndLabel(btn, String(action.icon || ""), "");
      if (!btn.childElementCount) btn.textContent = safeText(title);
      syncActive();
      btn.onclick = () => {
        let result: void | Promise<void> = undefined;
        try {
          result = action.onClick() as void | Promise<void>;
        } catch {}
        syncActive();
        void Promise.resolve(result).then(syncActive, syncActive);
      };
      pluginActions.appendChild(btn);
    }
    auxActions.insertBefore(pluginActions, auxActions.firstChild);

    auxRail.innerHTML = "";
    for (const view of views) {
      const item = el("button", "zion-auxbar-rail-item") as HTMLButtonElement;
      item.type = "button";
      item.setAttribute("role", "tab");
      const title = translatedTitle(view);
      item.title = title;
      item.setAttribute("aria-label", title);
      item.setAttribute("aria-selected", String(view.id === nextId));
      item.dataset.viewId = view.id;
      const icon = el("span", "zion-auxbar-rail-icon");
      appendIconAndLabel(icon, String(view.icon || "$(layout-sidebar-right)"), "");
      const label = el("span", "zion-auxbar-rail-label");
      label.textContent = title;
      item.append(icon, label);
      if (view.id === nextId) item.classList.add("is-active");
      item.onclick = () => auxiliaryBarRuntime.activateView(view.id);
      installReorderableTab(
        item,
        auxRail,
        view.id,
        (ids) => auxiliaryBarRuntime.setViewOrder(ids),
        "vertical"
      );
      auxRail.appendChild(item);
    }
    const activeRailItem = nextId
      ? Array.from(auxRail.querySelectorAll<HTMLElement>(".zion-auxbar-rail-item"))
          .find(item => item.dataset.viewId === nextId) || null
      : null;
    if (activeRailItem) {
      requestAnimationFrame(() => {
        try { activeRailItem.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch {}
      });
    }

    if (views.length === 0) {
      if (!auxContent.contains(auxEmpty)) {
        auxContent.appendChild(auxEmpty);
      }
    } else {
      if (auxContent.contains(auxEmpty)) {
        auxContent.removeChild(auxEmpty);
      }
    }

    if (auxMountedViewId !== nextId) {
      const previousId = auxMountedViewId;
      const generation = ++auxMountGeneration;
      auxMountedViewId = nextId;
      removeAuxTransientRecordsExcept(previousId, nextId);
      void (async () => {
        await auxUnmountView(previousId, generation);
        if (generation !== auxMountGeneration || auxMountedViewId !== nextId) return;
        removeAuxTransientRecordsExcept(nextId);
        for (const [id, rec] of auxKeepContainers.entries()) {
          if (id !== nextId) rec.container.style.display = "none";
        }
        await auxMountView(nextId, auxContent, generation);
      })();
    }

    let dragging = false;
    let startX = 0;
    let startW = auxiliaryBarRuntime.getWidth();

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = startX - e.clientX;
      const nextWidth = startW + dx;
      wideningSidePanelByDrag = nextWidth > startW + 1;
      auxiliaryBarRuntime.setWidth(nextWidth);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      sidePanelResizeActive = false;
      wideningSidePanelByDrag = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
        setResizeDragShield(false);
      auxResizer.classList.remove("is-dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem("zion.ui.auxBarWidth", String(auxiliaryBarRuntime.getWidth()));
      } catch {}
      applyColumnWidths();
    };

    auxResizer.onmousedown = (e) => {
      e.preventDefault();
      dragging = true;
      sidePanelResizeActive = true;
      startX = e.clientX;
      startW = auxiliaryBarRuntime.getWidth();
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      setResizeDragShield(true);
      auxResizer.classList.add("is-dragging");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  };

  const inspectorIdentity = el("div", "zion-inspector-identity");
  const inspectorFileIcon = el("span", "zion-inspector-file-icon");
  const inspectorTitleGroup = el("div", "zion-inspector-title-group");
  const inspectorTitle = el("div", "zion-inspector-title");
  inspectorTitle.textContent = "查看";
  const inspectorMeta = el("div", "zion-inspector-meta");
  inspectorTitleGroup.appendChild(inspectorTitle);
  inspectorTitleGroup.appendChild(inspectorMeta);
  inspectorIdentity.appendChild(inspectorFileIcon);
  inspectorIdentity.appendChild(inspectorTitleGroup);
  const inspectorTabsViewport = el("div", "zion-inline-tabs-scrollbar-viewport zion-inspector-tabs-viewport");
  const inspectorTabs = el("div", "zion-inspector-tabs");
  inspectorTabs.setAttribute("role", "tablist");
  inspectorTabs.setAttribute("aria-label", "查看中的内容");
  inspectorTabsViewport.appendChild(inspectorTabs);
  const inspectorNewTabButton = el("button", "zion-inspector-tabbar-action") as HTMLButtonElement;
  inspectorNewTabButton.type = "button";
  inspectorNewTabButton.title = "新建标签页";
  inspectorNewTabButton.setAttribute("aria-label", "新建标签页");
  setCodiconOnly(inspectorNewTabButton, "plus");
  inspectorTabsViewport.appendChild(inspectorNewTabButton);
  const inspectorTabsScrollbar = attachInlineTabsScrollbar(inspectorTabsViewport, inspectorTabs);
  const inspectorToolbar = el("div", "zion-inspector-toolbar");
  const inspectorHistoryButton = el("button", "zion-inspector-toolbar-action zion-inspector-history-button") as HTMLButtonElement;
  inspectorHistoryButton.type = "button";
  inspectorHistoryButton.title = "历史记录";
  inspectorHistoryButton.setAttribute("aria-label", "历史记录");
  inspectorHistoryButton.setAttribute("aria-haspopup", "menu");
  inspectorHistoryButton.setAttribute("aria-expanded", "false");
  setCodiconOnly(inspectorHistoryButton, "history");
  const inspectorToolbarPath = el("div", "zion-inspector-toolbar-path");
  const inspectorToolbarActions = el("div", "zion-inspector-toolbar-actions");
  const inspectorToolbarMenuButton = el("button", "zion-inspector-toolbar-action zion-inspector-toolbar-menu-button") as HTMLButtonElement;
  inspectorToolbarMenuButton.type = "button";
  inspectorToolbarMenuButton.title = "更多操作";
  inspectorToolbarMenuButton.setAttribute("aria-label", "更多操作");
  inspectorToolbarMenuButton.setAttribute("aria-haspopup", "menu");
  inspectorToolbarMenuButton.setAttribute("aria-expanded", "false");
  setCodiconOnly(inspectorToolbarMenuButton, "settings");
  const inspectorHistoryMenu = el("div", "zion-inspector-history-menu");
  inspectorHistoryMenu.setAttribute("role", "menu");
  const inspectorBrowserSuggestions = el("div", "zion-inspector-browser-suggestions");
  inspectorBrowserSuggestions.setAttribute("role", "listbox");
  const inspectorToolbarMenu = el("div", "zion-inspector-toolbar-menu");
  inspectorToolbarMenu.setAttribute("role", "menu");
  inspectorToolbar.appendChild(inspectorHistoryButton);
  inspectorToolbar.appendChild(inspectorToolbarPath);
  inspectorToolbar.appendChild(inspectorToolbarActions);
  inspectorToolbar.appendChild(inspectorToolbarMenuButton);
  inspectorToolbar.appendChild(inspectorHistoryMenu);
  inspectorToolbar.appendChild(inspectorBrowserSuggestions);
  inspectorToolbar.appendChild(inspectorToolbarMenu);
  const inspectorContent = el("div", "zion-inspector-content");
  const inspectorStatusBar = el("div", "zion-inspector-statusbar");
  inspectorStatusBar.appendChild(inspectorIdentity);
  const inspectorResizer = el("div", "zion-inspector-resizer");
  inspectorEl.appendChild(inspectorResizer);
  inspectorEl.appendChild(inspectorTabsViewport);
  inspectorEl.appendChild(inspectorToolbar);
  inspectorEl.appendChild(inspectorContent);
  inspectorEl.appendChild(inspectorStatusBar);

  let inspectorObjectUrl = "";
  let inspectorSaveTimer = 0;
  let inspectorPendingSave: (() => Promise<void>) | null = null;
  let inspectorTextView: ReturnType<typeof createInspectorTextView> | null = null;
  let inspectorTextViewItemId = "";
  let inspectorTextEditorDisposable: { dispose(): void } | null = null;
  let inspectorMarkdownSelectionDisposable: { dispose(): void } | null = null;
  let inspectorCustomDispose: (() => void) | null = null;
  const inspectorMarkdownPreview = new Set<string>();
  const inspectorHtmlPreview = new Set<string>();
  const inspectorScrollTop = new Map<string, number>();
  const inspectorImageScale = new Map<string, number>();
  const inspectorLineWrapping = new Map<string, boolean>();
  const inspectorBrowserHistory = new Map<string, { entries: string[]; index: number }>();
  const inspectorBrowserStages = new Map<string, { url: string; stage: HTMLElement; iframe: HTMLIFrameElement }>();
  let inspectorNewTabSeq = 0;
  let inspectorBrowserSuggestionChoices: InspectorBrowserChoice[] = [];
  let inspectorBrowserSuggestionIndex = -1;
  let lastInspectorItem: ReturnType<typeof inspectorRuntime.getActiveItem> = null;
  let lastInspectorRenderer: ReturnType<typeof inspectorRuntime.getRenderer> = null;
  let lastInspectorItemsSignature = "";
  let lastInspectorTextDecoratorVersion = -1;
  const disposeInspectorContent = () => {
    if (inspectorSaveTimer) {
      window.clearTimeout(inspectorSaveTimer);
      inspectorSaveTimer = 0;
      void inspectorPendingSave?.();
    }
    inspectorPendingSave = null;
    try { inspectorTextEditorDisposable?.dispose?.(); } catch {}
    inspectorTextEditorDisposable = null;
    try { inspectorMarkdownSelectionDisposable?.dispose?.(); } catch {}
    inspectorMarkdownSelectionDisposable = null;
    inspectorContent.onscroll = null;
    if (inspectorTextView) {
      inspectorScrollTop.set(inspectorTextViewItemId, inspectorTextView.scrollDOM.scrollTop);
      inspectorTextView.destroy();
      inspectorTextView = null;
      inspectorTextViewItemId = "";
    }
    try { inspectorCustomDispose?.(); } catch {}
    inspectorCustomDispose = null;
    if (inspectorObjectUrl) {
      try { URL.revokeObjectURL(inspectorObjectUrl); } catch {}
      inspectorObjectUrl = "";
    }
  };
  const getInspectorFileIcon = (item: any) => {
    if (item?.browserStartPage) return "browser";
    if (item?.url) return "globe";
    if (item?.file?.kind === "image") return "image";
    if (item?.file?.kind === "pdf") return "file-pdf";
    if (item?.editable) return "pencil";
    if (item?.language === "markdown" || /\.md(?:own)?$|\.markdown$/i.test(item?.path || item?.title || "")) return "note";
    if (item?.language && item.language !== "text") return "file-code";
    return "file-text";
  };
  const createInspectorAction = (icon: string, title: string, onClick: () => void, active = false) => {
    const button = el("button", `zion-inspector-toolbar-action${active ? " is-active" : ""}`) as HTMLButtonElement;
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    setCodiconOnly(button, icon);
    button.onclick = onClick;
    return button;
  };
  const createInspectorMenuAction = (icon: string, title: string, onClick: () => void, active = false) => {
    const button = el("button", `zion-inspector-toolbar-menu-item${active ? " is-active" : ""}`) as HTMLButtonElement;
    button.type = "button";
    button.setAttribute("role", "menuitem");
    const glyph = el("span", "zion-inspector-toolbar-menu-icon");
    setCodiconOnly(glyph, icon);
    const label = el("span", "zion-inspector-toolbar-menu-label");
    label.textContent = title;
    button.appendChild(glyph);
    button.appendChild(label);
    button.onclick = () => {
      inspectorToolbar.classList.remove("is-menu-open");
      inspectorToolbarMenuButton.setAttribute("aria-expanded", "false");
      onClick();
    };
    return button;
  };
  const isInspectorBrowserItem = (candidate: any) => !!candidate?.browserStartPage || !!candidate?.url || candidate?.ownerId === "core.inspector.browser";
  const getActiveInspectorBrowserItem = () => {
    const active = inspectorRuntime.getActiveItem();
    return active && isInspectorBrowserItem(active) ? active : null;
  };
  const openInspectorNewTab = () => {
    inspectorNewTabSeq += 1;
    const id = `browser:new:${Date.now()}:${inspectorNewTabSeq}`;
    inspectorRuntime.open({
      id,
      ownerId: "core.inspector.browser",
      title: "新标签页",
      path: `about:inspector-new-tab/${id}`,
      displayPath: "新标签页",
      language: "text",
      browserStartPage: true
    });
    requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>(".zion-inspector-browser-address")?.focus({ preventScroll: true });
    });
  };
  const openInspectorBrowser = (value: string, targetId = "") => {
    const url = normalizeInspectorBrowserInput(value);
    if (!url) return false;
    const title = inspectorTitleForUrl(url);
    rememberInspectorRecentPage(url, title);
    const target = targetId ? inspectorRuntime.getItems().find((candidate) => candidate.id === targetId) : null;
    if (target && isInspectorBrowserItem(target)) {
      inspectorRuntime.update(target.id, {
        title,
        path: url,
        displayPath: url,
        url,
        browserStartPage: false,
        language: "text"
      });
      return true;
    }
    inspectorRuntime.open({
      id: `browser:${encodeURIComponent(url)}`,
      ownerId: "core.inspector.browser",
      title,
      path: url,
      displayPath: url,
      url,
      language: "text"
    });
    return true;
  };
  const hideInspectorHistoryMenu = () => {
    inspectorHistoryMenu.classList.remove("is-open");
    inspectorHistoryButton.classList.remove("is-active");
    inspectorHistoryButton.setAttribute("aria-expanded", "false");
  };
  const hideInspectorBrowserSuggestions = () => {
    inspectorBrowserSuggestions.classList.remove("is-open");
    inspectorBrowserSuggestions.replaceChildren();
    inspectorBrowserSuggestionChoices = [];
    inspectorBrowserSuggestionIndex = -1;
  };
  const setInspectorBrowserSuggestionIndex = (index: number) => {
    inspectorBrowserSuggestionIndex = index;
    const options = Array.from(inspectorBrowserSuggestions.querySelectorAll<HTMLElement>(".zion-inspector-browser-choice"));
    options.forEach((option, optionIndex) => {
      option.classList.toggle("is-selected", optionIndex === index);
      option.setAttribute("aria-selected", optionIndex === index ? "true" : "false");
    });
  };
  const createInspectorBrowserChoice = (choice: InspectorBrowserChoice, onChoose: (value: string) => void) => {
    const button = el("button", "zion-inspector-browser-choice") as HTMLButtonElement;
    button.type = "button";
    button.title = choice.subtitle || choice.title;
    button.setAttribute("role", "option");
    const glyph = el("span", "zion-inspector-browser-choice-icon");
    setCodiconOnly(glyph, choice.icon);
    const text = el("span", "zion-inspector-browser-choice-text");
    const title = el("span", "zion-inspector-browser-choice-title");
    title.textContent = choice.title;
    const subtitle = el("span", "zion-inspector-browser-choice-subtitle");
    subtitle.textContent = choice.subtitle;
    text.appendChild(title);
    text.appendChild(subtitle);
    button.appendChild(glyph);
    button.appendChild(text);
    button.onmousedown = (event) => event.preventDefault();
    button.onclick = () => {
      hideInspectorHistoryMenu();
      hideInspectorBrowserSuggestions();
      onChoose(choice.value);
    };
    return button;
  };
  const buildInspectorBrowserChoices = (query: string, currentUrl = ""): InspectorBrowserChoice[] => {
    const raw = String(query || "").trim();
    const lower = raw.toLowerCase();
    const normalizedCurrent = normalizeInspectorBrowserInput(currentUrl || "");
    const choices: InspectorBrowserChoice[] = [];
    const seen = new Set<string>();
    if (raw) {
      const normalized = normalizeInspectorBrowserInput(raw);
      const search = normalized.includes("www.bing.com/search?");
      choices.push({
        key: `typed:${normalized}`,
        icon: search ? "search" : "globe",
        title: search ? `搜索 "${raw}"` : "打开地址",
        subtitle: normalized,
        value: raw
      });
      seen.add(normalized);
    }
    for (const page of readInspectorRecentPages()) {
      if (page.url === normalizedCurrent || seen.has(page.url)) continue;
      if (lower && !page.url.toLowerCase().includes(lower) && !page.title.toLowerCase().includes(lower)) continue;
      choices.push({
        key: `recent:${page.url}`,
        icon: "history",
        title: page.title || inspectorTitleForUrl(page.url),
        subtitle: page.url,
        value: page.url
      });
      seen.add(page.url);
      if (choices.length >= 8) break;
    }
    return choices.slice(0, 8);
  };
  const showInspectorBrowserSuggestions = (address: HTMLInputElement, onChoose: (value: string) => void, currentUrl = "") => {
    const choices = buildInspectorBrowserChoices(address.value, currentUrl);
    if (!choices.length) {
      hideInspectorBrowserSuggestions();
      return;
    }
    inspectorBrowserSuggestionChoices = choices;
    inspectorBrowserSuggestionIndex = -1;
    inspectorBrowserSuggestions.replaceChildren();
    for (const choice of choices) {
      inspectorBrowserSuggestions.appendChild(createInspectorBrowserChoice(choice, onChoose));
    }
    hideInspectorHistoryMenu();
    inspectorBrowserSuggestions.classList.add("is-open");
  };
  const showInspectorHistoryMenu = () => {
    hideInspectorBrowserSuggestions();
    inspectorHistoryMenu.replaceChildren();
    const currentTarget = getActiveInspectorBrowserItem();
    const recent = readInspectorRecentPages().slice(0, 12);
    if (!recent.length) {
      const empty = el("div", "zion-inspector-history-empty");
      empty.textContent = "暂无历史记录";
      inspectorHistoryMenu.appendChild(empty);
    } else {
      for (const page of recent) {
        inspectorHistoryMenu.appendChild(createInspectorBrowserChoice({
          key: `history:${page.url}`,
          icon: "history",
          title: page.title || inspectorTitleForUrl(page.url),
          subtitle: page.url,
          value: page.url
        }, (value) => openInspectorBrowser(value, currentTarget?.id || "")));
      }
    }
    inspectorHistoryMenu.classList.add("is-open");
    inspectorHistoryButton.classList.add("is-active");
    inspectorHistoryButton.setAttribute("aria-expanded", "true");
  };
  const createInspectorAddressInput = (value: string, onSubmit: (value: string) => void, currentUrl = "") => {
    const address = document.createElement("input");
    address.className = "zion-inspector-browser-address";
    address.type = "text";
    address.value = value;
    address.placeholder = "搜索或输入 URL";
    address.spellcheck = false;
    address.setAttribute("aria-label", "搜索或输入 URL");
    const choose = (nextValue: string) => {
      hideInspectorBrowserSuggestions();
      onSubmit(nextValue);
    };
    address.oninput = () => showInspectorBrowserSuggestions(address, choose, currentUrl);
    address.onfocus = () => showInspectorBrowserSuggestions(address, choose, currentUrl);
    address.onkeydown = (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (!inspectorBrowserSuggestions.classList.contains("is-open")) {
          showInspectorBrowserSuggestions(address, choose, currentUrl);
        }
        if (!inspectorBrowserSuggestionChoices.length) return;
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = inspectorBrowserSuggestionIndex < 0
          ? (direction > 0 ? 0 : inspectorBrowserSuggestionChoices.length - 1)
          : (inspectorBrowserSuggestionIndex + direction + inspectorBrowserSuggestionChoices.length) % inspectorBrowserSuggestionChoices.length;
        setInspectorBrowserSuggestionIndex(nextIndex);
        return;
      }
      if (event.key === "Escape") {
        hideInspectorBrowserSuggestions();
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      const choice = inspectorBrowserSuggestionIndex >= 0 ? inspectorBrowserSuggestionChoices[inspectorBrowserSuggestionIndex] : null;
      choose(choice?.value || address.value);
    };
    return address;
  };
  inspectorNewTabButton.onclick = openInspectorNewTab;
  inspectorHistoryButton.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (inspectorHistoryMenu.classList.contains("is-open")) {
      hideInspectorHistoryMenu();
    } else {
      showInspectorHistoryMenu();
    }
  };
  const renderInspectorStart = (targetId = "") => {
    const start = el("div", "zion-inspector-start");
    const recent = readInspectorRecentPages().slice(0, 12);
    if (recent.length > 0) {
      const heading = el("div", "zion-inspector-start-heading");
      heading.textContent = "最近页面";
      const list = el("div", "zion-inspector-recent-list");
      for (const page of recent) {
        const item = el("button", "zion-inspector-recent-item") as HTMLButtonElement;
        item.type = "button";
        item.title = page.url;
        item.onclick = () => openInspectorBrowser(page.url, targetId);
        const icon = el("span", "zion-inspector-recent-icon");
        setCodiconOnly(icon, "history");
        const text = el("span", "zion-inspector-recent-text");
        const title = el("span", "zion-inspector-recent-title");
        title.textContent = page.title || inspectorTitleForUrl(page.url);
        const url = el("span", "zion-inspector-recent-url");
        url.textContent = page.url;
        text.appendChild(title);
        text.appendChild(url);
        item.appendChild(icon);
        item.appendChild(text);
        list.appendChild(item);
      }
      start.appendChild(heading);
      start.appendChild(list);
    } else {
      const empty = el("div", "zion-inspector-start-empty");
      empty.textContent = "搜索或输入 URL";
      start.appendChild(empty);
    }
    inspectorContent.appendChild(start);
  };
  const updateInspectorToolbarMenuState = () => {
    const hasMenuItems = inspectorToolbarMenu.children.length > 0;
    inspectorToolbarMenuButton.hidden = !hasMenuItems;
    if (!hasMenuItems) {
      inspectorToolbar.classList.remove("is-menu-open");
      inspectorToolbarMenuButton.setAttribute("aria-expanded", "false");
    }
  };
  inspectorToolbarMenuButton.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    hideInspectorHistoryMenu();
    hideInspectorBrowserSuggestions();
    const nextOpen = !inspectorToolbar.classList.contains("is-menu-open");
    inspectorToolbar.classList.toggle("is-menu-open", nextOpen);
    inspectorToolbarMenuButton.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  };
  const closeInspectorToolbarMenuOnOutsideClick = (event: MouseEvent) => {
    if (event.target instanceof Node && inspectorToolbar.contains(event.target)) return;
    hideInspectorHistoryMenu();
    hideInspectorBrowserSuggestions();
    if (!inspectorToolbar.classList.contains("is-menu-open")) return;
    inspectorToolbar.classList.remove("is-menu-open");
    inspectorToolbarMenuButton.setAttribute("aria-expanded", "false");
  };
  document.addEventListener("click", closeInspectorToolbarMenuOnOutsideClick);
  const renderInspectorState = (icon: string, title: string, message: string) => {
    const state = el("div", "zion-inspector-state");
    const glyph = el("span", "zion-inspector-state-icon");
    setCodiconOnly(glyph, icon);
    const heading = el("strong", "zion-inspector-state-title");
    heading.textContent = title;
    const detail = el("span", "zion-inspector-state-detail");
    detail.textContent = message;
    state.appendChild(glyph);
    state.appendChild(heading);
    state.appendChild(detail);
    inspectorContent.appendChild(state);
  };
  const resetInspectorContent = (items: any[]) => {
    const activeIds = new Set(items.map((candidate) => candidate.id));
    for (const [id, cached] of Array.from(inspectorBrowserStages.entries())) {
      if (!activeIds.has(id)) {
        cached.stage.remove();
        inspectorBrowserStages.delete(id);
        continue;
      }
      cached.stage.hidden = true;
    }
    for (const child of Array.from(inspectorContent.children)) {
      if (child instanceof HTMLElement && child.classList.contains("zion-inspector-browser-stage")) continue;
      child.remove();
    }
  };
  const attachInspectorMarkdownSelection = (article: HTMLElement, item: any, content: string) => {
    const toolbar = el("div", "zion-selection-toolbar zion-inspector-selection-toolbar");
    const toolbarItems = createSelectionToolbarItemsContainer();
    toolbar.appendChild(toolbarItems);
    toolbar.style.position = "fixed";
    toolbar.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    document.body.appendChild(toolbar);
    let timer = 0;
    let disposed = false;

    const hide = () => {
      toolbar.classList.remove("is-visible");
      toolbarItems.replaceChildren();
    };
    const update = () => {
      if (disposed || !article.isConnected) return hide();
      const selection = getInspectorMarkdownSelection(article, content);
      if (!selection) return hide();
      const context: any = {
        view: null,
        sourceKind: "inspector",
        inspectorItemId: item.id,
          sourceSessionId: getInspectorTextSessionId(item),
          sourcePath: item.path || item.displayPath || "",
          sourceTitle: item.title,
          sourceText: content,
        selectionText: selection.selectionText,
        from: selection.from,
          to: selection.to
      };
      const items = ((window as any).zion?.editor?.selectionToolbar?.list?.() || []).filter((candidate: any) => {
        try {
          if (candidate.id !== "comments.create") return false;
          return typeof candidate.when === "function" ? !!candidate.when(context) : true;
        } catch {
          return false;
        }
      });
      if (!items.length) return hide();
      toolbarItems.replaceChildren();
      for (const candidate of items) {
        const anchor = el("span");
        anchor.style.display = "inline-flex";
        anchor.style.position = "relative";
        const itemContext = { ...context, anchorEl: anchor };
        let node: HTMLElement | null = null;
        if (typeof candidate.render === "function") {
          try { node = candidate.render(itemContext); } catch { node = null; }
        }
        if (!node) {
          node = createSelectionToolbarButton({
            title: candidate.title || candidate.label || candidate.id,
            label: candidate.label || "",
            codicon: candidate.codicon,
            onClick: () => {
              try { candidate.run?.(itemContext); } catch {}
              hide();
            }
          });
        }
        node.onmousedown = (event) => {
          event.preventDefault();
          event.stopPropagation();
        };
        node.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          try { candidate.run?.({ ...itemContext, event }); } catch {}
          hide();
        };
        anchor.appendChild(node);
        toolbarItems.appendChild(anchor);
      }
      toolbar.classList.add("is-visible");
      const toolbarRect = toolbar.getBoundingClientRect();
      const margin = 8;
      const left = Math.max(
        margin,
        Math.min(window.innerWidth - toolbarRect.width - margin, selection.rect.left + selection.rect.width / 2 - toolbarRect.width / 2)
      );
      const above = selection.rect.top - toolbarRect.height - margin;
      const top = above >= margin ? above : selection.rect.bottom + margin;
      toolbar.style.left = `${Math.round(left)}px`;
      toolbar.style.top = `${Math.round(Math.max(margin, Math.min(window.innerHeight - toolbarRect.height - margin, top)))}px`;
    };
    const schedule = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        update();
      }, 80);
    };
    const registryDisposable = (window as any).zion?.editor?.selectionToolbar?.onDidChange?.(schedule) || null;
    document.addEventListener("selectionchange", schedule);
    article.addEventListener("pointerup", schedule);
    inspectorContent.addEventListener("scroll", hide, { passive: true });
    return {
      dispose() {
        disposed = true;
        if (timer) window.clearTimeout(timer);
        try { registryDisposable?.dispose?.(); } catch {}
        document.removeEventListener("selectionchange", schedule);
        article.removeEventListener("pointerup", schedule);
        inspectorContent.removeEventListener("scroll", hide);
        toolbar.remove();
      }
    };
  };
  const renderInspector = (force = false) => {
    const items = inspectorRuntime.getItems();
    const activeId = inspectorRuntime.getActiveItemId();
    const item = inspectorRuntime.getActiveItem() || items[0] || null;
    const renderer = item ? inspectorRuntime.getRenderer(item) : null;
    const itemsSignature = items.map((candidate) => candidate.id).join("\u0000");
    const textDecoratorVersion = inspectorRuntime.getTextEditorDecoratorVersion();
    applyColumnWidths();
    if (
      !force
      && item
      && item === lastInspectorItem
      && renderer === lastInspectorRenderer
      && itemsSignature === lastInspectorItemsSignature
      && textDecoratorVersion === lastInspectorTextDecoratorVersion
    ) return;
    lastInspectorItem = item;
    lastInspectorRenderer = renderer;
    lastInspectorItemsSignature = itemsSignature;
    lastInspectorTextDecoratorVersion = textDecoratorVersion;
    disposeInspectorContent();
    inspectorTabs.innerHTML = "";
    inspectorToolbarActions.innerHTML = "";
    inspectorToolbarMenu.innerHTML = "";
    hideInspectorHistoryMenu();
    hideInspectorBrowserSuggestions();
    updateInspectorToolbarMenuState();
    resetInspectorContent(items);
    inspectorContent.classList.remove("is-empty", "is-browser", "is-browser-start", "is-html-preview");
    inspectorToolbarPath.classList.remove("is-browser-address");
    if (!item) {
      inspectorTitle.textContent = "查看";
      inspectorTitle.title = "";
      inspectorMeta.textContent = "";
      inspectorStatusBar.dataset.saveState = "";
      inspectorToolbarPath.replaceChildren();
      const address = createInspectorAddressInput("", (value) => {
        openInspectorBrowser(value);
      }, "");
      inspectorToolbarPath.appendChild(address);
      inspectorToolbarPath.title = "搜索或输入 URL";
      inspectorToolbarPath.classList.add("is-browser-address");
      inspectorToolbarActions.appendChild(createInspectorAction("search", "打开或搜索", () => {
        openInspectorBrowser(address.value);
      }));
      updateInspectorToolbarMenuState();
      inspectorFileIcon.textContent = "";
      inspectorContent.classList.add("is-empty");
      renderInspectorStart();
      inspectorTabsScrollbar.sync();
      requestAnimationFrame(() => {
        if (inspectorRuntime.getActiveItem()) return;
        try { address.focus({ preventScroll: true }); } catch {}
      });
      return;
    }
    if (item.id !== activeId) inspectorRuntime.activate(item.id);
    inspectorTitle.textContent = item.title;
    inspectorTitle.title = item.title;
    const inspectorMetaParts = [
        item.url || item.browserStartPage ? "网页预览" : item.editable ? "可编辑" : "只读",
      item.language && item.language !== "text" ? item.language.toUpperCase() : "",
        typeof item.file?.size === "number" ? `${Math.max(0, Math.round(item.file.size / 1024)) || 1} KB` : "",
        item.file?.truncated ? `仅预览前 ${Math.max(1, Math.round(Number(item.file.loadedBytes || 0) / 1024))} KB` : ""
    ].filter(Boolean);
    const setInspectorStatus = (status = "") => {
      inspectorMeta.textContent = [...inspectorMetaParts, status].filter(Boolean).join(" · ");
      inspectorStatusBar.dataset.saveState = status === "保存失败"
        ? "error"
        : status === "保存中"
          ? "saving"
          : status === "已修改"
            ? "dirty"
            : status === "已保存"
              ? "saved"
              : "";
    };
    setInspectorStatus();
      inspectorToolbarPath.replaceChildren();
      inspectorToolbarPath.textContent = item.url || item.displayPath || item.path || item.title;
      inspectorToolbarPath.title = inspectorToolbarPath.textContent;
    inspectorFileIcon.textContent = "";
    setCodiconOnly(inspectorFileIcon, getInspectorFileIcon(item));
    for (const action of item.actions || []) {
      inspectorToolbarMenu.appendChild(createInspectorMenuAction(action.icon || "play", action.title, () => {
        void Promise.resolve(action.run(item)).catch(() => {});
      }));
    }
    updateInspectorToolbarMenuState();
    for (const tab of items) {
      const button = el("button", `zion-inspector-tab${tab.id === item.id ? " is-active" : ""}`) as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", tab.id === item.id ? "true" : "false");
      button.tabIndex = tab.id === item.id ? 0 : -1;
      button.title = tab.displayPath || tab.path || tab.title;
      const tabIcon = el("span", "zion-inspector-tab-icon");
      setCodiconOnly(tabIcon, getInspectorFileIcon(tab));
      const label = el("span", "zion-inspector-tab-label");
      label.textContent = tab.title;
      const close = el("button", "zion-inspector-tab-close") as HTMLButtonElement;
      close.type = "button";
      close.title = `关闭 ${tab.title}`;
      close.setAttribute("aria-label", `关闭 ${tab.title}`);
      setCodiconOnly(close, "close");
      close.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        inspectorRuntime.close(tab.id);
      };
      button.onclick = () => inspectorRuntime.activate(tab.id);
      button.onauxclick = (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        inspectorRuntime.close(tab.id);
      };
      button.onkeydown = (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const index = items.findIndex((candidate) => candidate.id === tab.id);
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const next = items[(index + delta + items.length) % items.length];
        if (!next) return;
        inspectorRuntime.activate(next.id);
        requestAnimationFrame(() => {
          Array.from(inspectorTabs.querySelectorAll<HTMLButtonElement>(".zion-inspector-tab"))
            .find((candidate) => candidate.dataset.inspectorItemId === next.id)?.focus();
        });
      };
      button.dataset.inspectorItemId = tab.id;
      button.appendChild(tabIcon);
      button.appendChild(label);
      button.appendChild(close);
      inspectorTabs.appendChild(button);
    }
    const activeInspectorTab = Array.from(inspectorTabs.querySelectorAll<HTMLElement>(".zion-inspector-tab"))
      .find((candidate) => candidate.dataset.inspectorItemId === item.id) || null;
    requestAnimationFrame(() => {
      try { activeInspectorTab?.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch {}
      inspectorTabsScrollbar.sync();
    });
    if (item.browserStartPage) {
      inspectorToolbarPath.replaceChildren();
      const address = createInspectorAddressInput("", (value) => {
        openInspectorBrowser(value, item.id);
      }, "");
      inspectorToolbarPath.appendChild(address);
      inspectorToolbarPath.title = "搜索或输入 URL";
      inspectorToolbarPath.classList.add("is-browser-address");
      inspectorToolbarActions.appendChild(createInspectorAction("search", "打开或搜索", () => {
        openInspectorBrowser(address.value, item.id);
      }));
      inspectorContent.classList.add("is-empty", "is-browser-start");
      renderInspectorStart(item.id);
      requestAnimationFrame(() => {
        if (inspectorRuntime.getActiveItemId() !== item.id) return;
        try { address.focus({ preventScroll: true }); } catch {}
      });
      return;
    }
    const file = item.file || { kind: "binary" as const };
    if (item.url) {
      const currentUrl = normalizeInspectorBrowserInput(item.url);
      if (!currentUrl) {
        inspectorContent.classList.add("is-empty");
        renderInspectorState("warning-triangle", "无法打开网页", "Inspector 网页预览仅支持 HTTP 和 HTTPS 地址。");
        return;
      }
      rememberInspectorRecentPage(currentUrl, item.title);
      let history = inspectorBrowserHistory.get(item.id);
      if (!history) {
        history = { entries: [currentUrl], index: 0 };
        inspectorBrowserHistory.set(item.id, history);
      } else if (history.entries[history.index] !== currentUrl) {
        history.entries = history.entries.slice(0, history.index + 1);
        history.entries.push(currentUrl);
        history.index = history.entries.length - 1;
      }
      const navigate = (url: string, mode: "push" | "history" = "push") => {
        const normalized = normalizeInspectorBrowserInput(url);
        if (!normalized) return;
        if (mode === "push") {
          history!.entries = history!.entries.slice(0, history!.index + 1);
          if (history!.entries[history!.entries.length - 1] !== normalized) history!.entries.push(normalized);
          history!.index = history!.entries.length - 1;
        }
        rememberInspectorRecentPage(normalized);
        inspectorRuntime.update(item.id, {
          url: normalized,
          path: normalized,
          displayPath: normalized,
          title: inspectorTitleForUrl(normalized)
        });
      };
      const address = createInspectorAddressInput(currentUrl, (value) => {
        navigate(value);
      }, currentUrl);
      address.setAttribute("aria-label", "网页地址或搜索内容");
      inspectorToolbarPath.replaceChildren(address);
      inspectorToolbarPath.title = currentUrl;
      inspectorToolbarPath.classList.add("is-browser-address");
      inspectorToolbarActions.appendChild(createInspectorAction("search", "打开或搜索", () => {
        navigate(address.value);
      }));
      const back = createInspectorAction("arrow-left", "后退", () => {
        if (history!.index <= 0) return;
        history!.index -= 1;
        navigate(history!.entries[history!.index], "history");
      });
      const forward = createInspectorAction("arrow-right", "前进", () => {
        if (history!.index >= history!.entries.length - 1) return;
        history!.index += 1;
        navigate(history!.entries[history!.index], "history");
      });
      if (history.index > 0) inspectorToolbarActions.appendChild(back);
      if (history.index < history.entries.length - 1) inspectorToolbarActions.appendChild(forward);
      inspectorContent.classList.add("is-browser");
      let browserStage = inspectorBrowserStages.get(item.id);
      if (browserStage && browserStage.url !== currentUrl) {
        browserStage.stage.remove();
        inspectorBrowserStages.delete(item.id);
        browserStage = undefined;
      }
      if (!browserStage) {
        const stage = el("div", "zion-inspector-browser-stage");
        const frameWrap = el("div", "zion-inspector-browser-frame-wrap");
        const iframe = document.createElement("iframe");
        iframe.className = "zion-inspector-browser-frame";
        iframe.src = currentUrl;
        iframe.title = item.title || currentUrl;
        iframe.referrerPolicy = "no-referrer";
        iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-same-origin");
        iframe.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen");
        frameWrap.appendChild(iframe);
        stage.appendChild(frameWrap);
        browserStage = { url: currentUrl, stage, iframe };
        inspectorBrowserStages.set(item.id, browserStage);
        inspectorContent.appendChild(stage);
      } else if (browserStage.stage.parentElement !== inspectorContent) {
        inspectorContent.appendChild(browserStage.stage);
      }
      browserStage.iframe.title = item.title || currentUrl;
      browserStage.stage.hidden = false;
      inspectorToolbarActions.appendChild(createInspectorAction("refresh", "刷新", () => {
        const cached = inspectorBrowserStages.get(item.id);
        if (!cached) {
          renderInspector(true);
          return;
        }
        cached.iframe.src = "about:blank";
        requestAnimationFrame(() => {
          cached.iframe.src = cached.url;
        });
      }));
      inspectorToolbarActions.appendChild(createInspectorAction("external-link", "在外部浏览器打开", () => {
        try { window.open(currentUrl, "_blank", "noopener,noreferrer"); } catch {}
      }));
      setInspectorStatus("受浏览器嵌入策略限制");
      return;
    }
    if (file.kind === "loading") {
      inspectorContent.classList.add("is-empty");
      renderInspectorState("loader", "正在打开文件", "内容准备好后会自动显示在这里。");
      return;
    }
    if (file.kind === "error") {
      inspectorContent.classList.add("is-empty");
      renderInspectorState("warning-triangle", "无法打开内容", file.message || "请检查文件是否仍然存在，或稍后重试。");
      return;
    }
    inspectorContent.classList.remove("is-empty");
    const customRender = item.render || renderer?.render;
    if (typeof customRender === "function") {
      try {
        const result = customRender(inspectorContent, {
          item,
          update: (patch) => inspectorRuntime.update(item.id, patch),
          close: () => inspectorRuntime.close(item.id),
          openInEditor: () => {
            try { (window as any).zion?.events?.emit?.("ui/inspectorOpenInEditor", { item }); } catch {}
          }
        });
        inspectorCustomDispose = result?.dispose || null;
      } catch (error) {
        inspectorContent.classList.add("is-empty");
        renderInspectorState("error", "内容渲染失败", error instanceof Error ? error.message : "自定义查看器发生错误。");
      }
      return;
    }
    if (file.kind === "pdf" && file.blob instanceof Blob) {
      inspectorObjectUrl = URL.createObjectURL(file.blob);
      const stage = el("div", "zion-inspector-pdf-stage");
      const frame = document.createElement("iframe");
      frame.className = "zion-inspector-pdf-frame";
      frame.src = inspectorObjectUrl;
      frame.title = item.title || "PDF preview";
      stage.appendChild(frame);
      inspectorContent.appendChild(stage);
      setInspectorStatus("PDF 预览");
      return;
    }
    if (file.kind === "image" && file.blob instanceof Blob) {
      inspectorObjectUrl = URL.createObjectURL(file.blob);
      const stage = el("div", "zion-inspector-image-stage");
      const canvas = el("div", "zion-inspector-image-canvas");
      const image = document.createElement("img");
      image.src = inspectorObjectUrl;
      image.alt = item.title;
      let fittedWidth = 0;
      let fittedHeight = 0;
      const updateImageMeta = (scale: number) => {
        const dimensions = image.naturalWidth > 0 ? `${image.naturalWidth} × ${image.naturalHeight} · ` : "";
        inspectorMeta.textContent = `${dimensions}${Math.round(scale * 100)}%`;
      };
      const applyImageScale = (nextScale: number) => {
        const scale = Math.max(0.1, Math.min(16, Math.round(nextScale * 100) / 100));
        inspectorImageScale.set(item.id, scale);
        if (fittedWidth > 0 && fittedHeight > 0) {
          const width = Math.round(fittedWidth * scale);
          const height = Math.round(fittedHeight * scale);
          image.style.width = `${width}px`;
          image.style.height = `${height}px`;
          image.style.maxWidth = "none";
          canvas.style.width = `${Math.max(stage.clientWidth - 48, width)}px`;
          canvas.style.height = `${Math.max(stage.clientHeight - 48, height)}px`;
        }
        updateImageMeta(scale);
      };
      inspectorToolbarActions.appendChild(createInspectorAction("screen-normal", "适应窗口", () => applyImageScale(1)));
      inspectorToolbarMenu.appendChild(createInspectorMenuAction("zoom-out", "缩小", () => applyImageScale((inspectorImageScale.get(item.id) || 1) - 0.25)));
      inspectorToolbarMenu.appendChild(createInspectorMenuAction("symbol-ruler", "原始尺寸", () => {
        applyImageScale(fittedWidth > 0 ? image.naturalWidth / fittedWidth : 1);
      }));
      inspectorToolbarMenu.appendChild(createInspectorMenuAction("zoom-in", "放大", () => applyImageScale((inspectorImageScale.get(item.id) || 1) + 0.25)));
      updateInspectorToolbarMenuState();
      image.onload = () => {
        fittedWidth = image.clientWidth;
        fittedHeight = image.clientHeight;
        applyImageScale(inspectorImageScale.get(item.id) || 1);
      };
      stage.onwheel = (event) => {
        if (!event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        applyImageScale((inspectorImageScale.get(item.id) || 1) + (event.deltaY < 0 ? 0.1 : -0.1));
      };
      canvas.appendChild(image);
      stage.appendChild(canvas);
      inspectorContent.appendChild(stage);
      applyImageScale(inspectorImageScale.get(item.id) || 1);
      return;
    }
    if (file.kind === "text") {
      const content = String(file.content || "");
      const isMarkdown = item.language === "markdown" || /\.md(?:own)?$|\.markdown$/i.test(item.path || item.title);
        const isHtml = item.language === "html" || /\.(?:html?|xhtml)$/i.test(item.path || item.title);
      const previewing = isMarkdown && !inspectorMarkdownPreview.has(item.id);
        const previewingHtml = isHtml && inspectorHtmlPreview.has(item.id);
        if (file.truncated && !previewingHtml) {
          const notice = el("div", "zion-inspector-truncated-notice");
          notice.textContent = `文件较大，仅展示前 ${Math.max(1, Math.round(Number(file.loadedBytes || content.length) / 1024))} KB；预览为只读，避免误覆盖完整文件。`;
          inspectorContent.appendChild(notice);
        }
      if (isMarkdown) {
        inspectorToolbarActions.appendChild(createInspectorAction("eye", previewing ? "查看 Markdown 源码" : "阅读 Markdown", () => {
          if (previewing) inspectorMarkdownPreview.add(item.id);
          else inspectorMarkdownPreview.delete(item.id);
          renderInspector(true);
        }, previewing));
      }
      if (isHtml) {
        inspectorToolbarActions.appendChild(createInspectorAction(
          previewingHtml ? "file-code" : "browser",
          previewingHtml ? "查看 HTML 源码" : "预览 HTML",
          () => {
            if (previewingHtml) {
              inspectorHtmlPreview.delete(item.id);
              renderInspector(true);
              return;
            }
            if (!file.truncated || file.previewContent) {
              inspectorHtmlPreview.add(item.id);
              renderInspector(true);
              return;
            }
            if (typeof file.loadFullContent !== "function") {
              setInspectorStatus("文件过大，无法完整预览");
              return;
            }
            setInspectorStatus("正在加载完整 HTML");
            void file.loadFullContent()
              .then((previewContent) => {
                inspectorHtmlPreview.add(item.id);
                inspectorRuntime.update(item.id, {
                  file: { ...file, previewContent }
                });
              })
              .catch((error) => {
                setInspectorStatus("HTML 预览加载失败");
                try { (window as any).showToast?.(error?.message || String(error || "HTML 预览加载失败")); } catch {}
              });
          },
          previewingHtml
        ));
      }
      inspectorToolbarMenu.appendChild(createInspectorMenuAction("copy", "复制内容", () => {
        const write = navigator.clipboard?.writeText?.(content);
        void (write || Promise.resolve()).catch(() => {});
      }));
        if (!previewing && !previewingHtml) {
        inspectorToolbarActions.appendChild(createInspectorAction("search", "在内容中查找", () => {
          openInspectorSearch(inspectorTextView);
        }));
        const language = String(item.language || "text").toLowerCase();
        let wrapping = inspectorLineWrapping.get(item.id) ?? (language === "text" || language === "markdown");
        const wrapAction = createInspectorMenuAction("word-wrap", wrapping ? "关闭自动换行" : "开启自动换行", () => {
          wrapping = !wrapping;
          inspectorLineWrapping.set(item.id, wrapping);
          setInspectorLineWrapping(inspectorTextView, wrapping);
          wrapAction.classList.toggle("is-active", wrapping);
          const label = wrapAction.querySelector(".zion-inspector-toolbar-menu-label");
          if (label) label.textContent = wrapping ? "关闭自动换行" : "开启自动换行";
        }, wrapping);
        inspectorToolbarMenu.appendChild(wrapAction);
      }
      updateInspectorToolbarMenuState();
        if (previewingHtml) {
          inspectorContent.classList.add("is-html-preview");
          const stage = el("div", "zion-inspector-html-preview");
          const iframe = document.createElement("iframe");
          iframe.className = "zion-inspector-html-preview-frame";
          iframe.title = item.title || "HTML preview";
          iframe.referrerPolicy = "no-referrer";
          iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads");
          iframe.srcdoc = String(file.previewContent || content);
          stage.appendChild(iframe);
          inspectorContent.appendChild(stage);
          setInspectorStatus("沙箱 HTML 预览");
          return;
        }
      if (previewing) {
        const article = renderInspectorMarkdown(inspectorContent, content);
        const previewView = createInspectorMarkdownPreviewView(article, inspectorContent, content);
        const previewEditor = {
          panelId: "inspector",
          editorId: `inspector-preview:${item.id}`,
          sessionId: getInspectorTextSessionId(item),
          sourceKind: "inspector",
          sourceViewKind: "preview",
          inspectorItemId: item.id,
          sourcePath: item.path || item.displayPath || "",
          sourceTitle: item.title,
          getValue: () => content,
          getSelection: () => {
            const selection = previewView.state.selection.main;
            return previewView.state.sliceDoc(selection.from, selection.to);
          },
          getView: () => previewView,
          focus: () => previewView.focus()
        };
        inspectorTextEditorDisposable = inspectorRuntime.attachTextEditor(item.id, previewEditor);
        const selectionDisposable = attachInspectorMarkdownSelection(article, item, content);
        const syncCommentRanges = () => {
          try {
            const ranges = (window as any).zion?.commands?.executeCommand?.("comments.getSourceAnchors", {
              sessionId: getInspectorTextSessionId(item),
              sourceText: content
            }) || [];
            applyInspectorMarkdownCommentRanges(article, Array.isArray(ranges) ? ranges : [], (threadId) => {
              try { (window as any).zion?.commands?.executeCommand?.("comments.activateThread", threadId); } catch {}
            });
          } catch {}
        };
        const onCommentsChanged = () => syncCommentRanges();
        window.addEventListener("zion:comments-changed", onCommentsChanged);
        window.addEventListener("zion:comments-active-changed", onCommentsChanged);
        syncCommentRanges();
        inspectorMarkdownSelectionDisposable = {
          dispose() {
            selectionDisposable.dispose();
            window.removeEventListener("zion:comments-changed", onCommentsChanged);
            window.removeEventListener("zion:comments-active-changed", onCommentsChanged);
          }
        };
        try {
          (window as any).zion?.events?.emit?.("ui/inspectorTextSourceActivated", {
            itemId: item.id,
            sessionId: getInspectorTextSessionId(item),
            editor: previewEditor
          });
        } catch {}
        inspectorContent.scrollTop = inspectorScrollTop.get(item.id) || 0;
        inspectorContent.onscroll = () => {
          inspectorScrollTop.set(item.id, inspectorContent.scrollTop);
          window.dispatchEvent(new CustomEvent("zion:comments-viewport-changed", {
            detail: {
              panelId: "inspector",
              sessionId: previewEditor.sessionId
            }
          }));
        };
        return;
      }
        const editorHost = el("div", `zion-inspector-editor-host${file.truncated ? " is-truncated" : ""}`);
      inspectorContent.appendChild(editorHost);
      inspectorTextViewItemId = item.id;
      editorHost.dataset.inspectorItemId = item.id;
      editorHost.dataset.inspectorSessionId = getInspectorTextSessionId(item);
      let liveView: ReturnType<typeof createInspectorTextView> | null = null;
      const inspectorEditor = {
        panelId: "inspector",
        editorId: `inspector:${item.id}`,
        sessionId: getInspectorTextSessionId(item),
        sourceKind: "inspector",
        inspectorItemId: item.id,
        sourcePath: item.path || item.displayPath || "",
        sourceTitle: item.title,
        getValue: () => liveView?.state.doc.toString() ?? content,
        setValue: (value: string) => {
          if (!liveView) return;
          liveView.dispatch({ changes: { from: 0, to: liveView.state.doc.length, insert: String(value || "") } });
        },
        replaceSelection: (value: string) => {
          if (!liveView) return;
          const selection = liveView.state.selection.main;
          liveView.dispatch({
            changes: { from: selection.from, to: selection.to, insert: String(value || "") },
            selection: { anchor: selection.from + String(value || "").length }
          });
        },
        getSelection: () => {
          const selection = liveView?.state.selection.main;
          return liveView && selection ? liveView.state.sliceDoc(selection.from, selection.to) : "";
        },
        replaceRange: (value: string, from: { line: number; ch: number }, to = from) => {
          if (!liveView) return;
          const offsetAt = (position: { line: number; ch: number }) => {
            const lineNumber = Math.max(1, Math.min(liveView!.state.doc.lines, Number(position?.line || 0) + 1));
            const line = liveView!.state.doc.line(lineNumber);
            return Math.max(line.from, Math.min(line.to, line.from + Math.max(0, Number(position?.ch || 0))));
          };
          liveView.dispatch({ changes: { from: offsetAt(from), to: offsetAt(to), insert: String(value || "") } });
        },
        getCursor: () => {
          if (!liveView) return { line: 0, ch: 0 };
          const position = liveView.state.selection.main.head;
          const line = liveView.state.doc.lineAt(position);
          return { line: line.number - 1, ch: position - line.from };
        },
        setCursor: (position: { line: number; ch: number }) => {
          if (!liveView) return;
          const lineNumber = Math.max(1, Math.min(liveView.state.doc.lines, Number(position?.line || 0) + 1));
          const line = liveView.state.doc.line(lineNumber);
          const anchor = Math.max(line.from, Math.min(line.to, line.from + Math.max(0, Number(position?.ch || 0))));
          liveView.dispatch({ selection: { anchor }, scrollIntoView: true });
        },
        focus: () => liveView?.focus(),
        addVisualExtension: () => {},
        getView: () => liveView
      };
      inspectorTextView = createInspectorTextView(editorHost, {
        content,
        filename: item.path || item.title,
        language: item.language,
          editable: item.editable && !file.truncated,
        lineWrapping: inspectorLineWrapping.get(item.id) ?? (String(item.language || "text").toLowerCase() === "text" || isMarkdown),
        extensions: inspectorRuntime.getTextEditorExtensions(inspectorEditor, item),
        selectionContext: (view) => ({
          sourceKind: "inspector",
          inspectorItemId: item.id,
          sourceSessionId: inspectorEditor.sessionId,
          sourcePath: inspectorEditor.sourcePath,
          sourceTitle: inspectorEditor.sourceTitle,
          sourceText: view.state.doc.toString()
        }),
          onChange: item.editable && !file.truncated ? (nextContent) => {
          setInspectorStatus("已修改");
          if (inspectorSaveTimer) window.clearTimeout(inspectorSaveTimer);
          inspectorPendingSave = async () => {
            if (inspectorRuntime.getActiveItemId() === item.id) setInspectorStatus("保存中");
            try {
              await item.onSave?.(nextContent);
              if (inspectorRuntime.getActiveItemId() === item.id) setInspectorStatus("已保存");
            } catch {
              if (inspectorRuntime.getActiveItemId() === item.id) setInspectorStatus("保存失败");
            }
          };
          inspectorSaveTimer = window.setTimeout(() => {
            inspectorSaveTimer = 0;
            const save = inspectorPendingSave;
            inspectorPendingSave = null;
            void save?.();
          }, 300);
        } : undefined
      });
      liveView = inspectorTextView;
      inspectorTextEditorDisposable = inspectorRuntime.attachTextEditor(item.id, inspectorEditor);
      try {
        (window as any).zion?.events?.emit?.("ui/inspectorTextSourceActivated", {
          itemId: item.id,
          sessionId: inspectorEditor.sessionId,
          editor: inspectorEditor
        });
      } catch {}
      const savedScrollTop = inspectorScrollTop.get(item.id) || 0;
      requestAnimationFrame(() => {
        if (inspectorTextViewItemId === item.id && inspectorTextView) {
          inspectorTextView.scrollDOM.scrollTop = savedScrollTop;
        }
      });
      return;
    }
    inspectorContent.classList.add("is-empty");
    renderInspectorState("file", "暂不支持预览", "这个文件类型可以在主编辑区或对应的外部应用中打开。");
  };

  const dispInspectorTextReveal = inspectorRuntime.setTextRevealHandler((itemId, options = {}) => {
    const item = inspectorRuntime.getItems().find((candidate) => candidate.id === itemId) || null;
    if (!item || item.url || item.file?.kind !== "text") return null;
    inspectorHtmlPreview.delete(item.id);
    if (inspectorRuntime.getActiveItemId() !== item.id) {
      inspectorRuntime.activate(item.id);
    } else {
      renderInspector(true);
    }
    const editor = inspectorRuntime.getTextEditor(item.id);
    const view = editor?.getView?.();
    if (view) {
      const docLength = view.state.doc.length;
      const from = Math.max(0, Math.min(docLength, Number(options.from) || 0));
      const rawTo = Number(options.to);
      const to = Math.max(from, Math.min(docLength, Number.isFinite(rawTo) ? rawTo : from));
      view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
      if (options.focus !== false) view.focus();
    }
    return editor;
  });

  let inspectorDragging = false;
  let inspectorStartX = 0;
  let inspectorStartWidth = inspectorRuntime.getWidth();
  const stopInspectorResize = () => {
    inspectorDragging = false;
    sidePanelResizeActive = false;
    wideningSidePanelByDrag = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
      setResizeDragShield(false);
    inspectorResizer.classList.remove("is-dragging");
    window.removeEventListener("mousemove", onInspectorResize);
    window.removeEventListener("mouseup", stopInspectorResize);
    applyColumnWidths();
  };
  const onInspectorResize = (event: MouseEvent) => {
    if (!inspectorDragging) return;
    event.preventDefault();
    const panelsScroller = editorEl.querySelector<HTMLElement>(".zion-panels-root");
    const previousPanelsWidth = getElementClientWidth(panelsScroller);
    const previousInspectorWidth = getElementClientWidth(inspectorEl);
    const nextWidth = inspectorStartWidth - (event.clientX - inspectorStartX);
    wideningSidePanelByDrag = nextWidth > inspectorStartWidth + 1;
    inspectorRuntime.setWidth(nextWidth, { emit: false });
    applyColumnWidths();
    keepHorizontalScrollerRightEdgeAnchored(
      panelsScroller,
      previousPanelsWidth,
      getElementClientWidth(inspectorEl) - previousInspectorWidth
    );
  };
  inspectorResizer.onmousedown = (event) => {
    event.preventDefault();
    inspectorDragging = true;
    sidePanelResizeActive = true;
    inspectorStartX = event.clientX;
    inspectorStartWidth = inspectorRuntime.getWidth();
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
      setResizeDragShield(true);
    inspectorResizer.classList.add("is-dragging");
    window.addEventListener("mousemove", onInspectorResize);
    window.addEventListener("mouseup", stopInspectorResize);
  };
  inspectorEl.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      inspectorRuntime.hide();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") {
      event.preventDefault();
      const activeId = inspectorRuntime.getActiveItemId();
      if (activeId) inspectorRuntime.close(activeId);
    }
  };

  bottomPanelEl.style.position = "relative";
  const bottomHeader = el("div", "zion-bottompanel-header");
  const bottomTabs = el("div", "zion-bottompanel-tabs");
  const bottomActions = el("div", "zion-bottompanel-actions");
  const bottomMaxBtn = el("button", "zion-bottompanel-action") as HTMLButtonElement;
  bottomMaxBtn.type = "button";
  bottomMaxBtn.title = "Maximize Panel";
  bottomMaxBtn.setAttribute("aria-label", "Maximize Panel");
  setCodiconOnly(bottomMaxBtn, "chevron-up");
  bottomMaxBtn.onclick = () => {
    try {
      if (bottomPanelRuntime.isMaximized()) bottomPanelRuntime.restore();
      else bottomPanelRuntime.maximize();
    } catch {}
  };
  bottomActions.appendChild(bottomMaxBtn);
  bottomHeader.appendChild(bottomTabs);
  bottomHeader.appendChild(bottomActions);

  const bottomContent = el("div", "zion-bottompanel-content");
  const bottomEmpty = el("div", "zion-bottompanel-empty");
  bottomEmpty.textContent = "暂无可用视图";
  const bottomResizer = el("div", "zion-bottompanel-resizer");

  bottomPanelEl.appendChild(bottomResizer);
  bottomPanelEl.appendChild(bottomHeader);
  bottomPanelEl.appendChild(bottomContent);

  let bottomMountedViewId: string | null = null;
  let bottomMountedDisposable: { dispose?: () => void } | null = null;
  let bottomResizeObs: ResizeObserver | null = null;
  const bottomKeepContainers = new Map<string, { container: HTMLElement; disposable: { dispose?: () => void } | null; obs: ResizeObserver | null }>();

  const bottomUnmountView = async (viewId: string | null) => {
    if (!viewId) return;
    const prev = bottomPanelRuntime.getView(viewId);
    try {
      await prev?.onDeactivate?.();
    } catch {}
    const keep = !!prev?.keepWhenActive;
    if (keep) {
      const rec = bottomKeepContainers.get(viewId);
      if (rec?.container) rec.container.style.display = "none";
      return;
    }
    try {
      bottomMountedDisposable?.dispose?.();
    } catch {}
    bottomMountedDisposable = null;
    try {
      bottomResizeObs?.disconnect();
    } catch {}
    bottomResizeObs = null;
    try {
      bottomContent.innerHTML = "";
    } catch {}
  };

  const bottomMountView = async (viewId: string | null) => {
    if (!viewId) {
      bottomContent.innerHTML = "";
      return;
    }
    const view = bottomPanelRuntime.getView(viewId);
    if (!view) {
      bottomContent.innerHTML = "";
      return;
    }

    const keep = !!view.keepWhenActive;
    if (keep) {
      const existing = bottomKeepContainers.get(viewId);
      if (existing) {
        existing.container.style.display = "block";
        try {
          await view.onActivate?.();
        } catch {}
        return;
      }
      const container = el("div", "zion-bottompanel-view");
      container.style.height = "100%";
      container.style.width = "100%";
      container.style.minHeight = "0";
      bottomContent.appendChild(container);
      let disp: any = null;
      try {
        disp = view.component.render(container) as any;
      } catch {
        container.innerHTML = "";
      }
      let obs: ResizeObserver | null = null;
      try {
        obs = new ResizeObserver(() => {
          try {
            const r = container.getBoundingClientRect();
            view.onResize?.({ width: r.width, height: r.height });
          } catch {}
        });
        obs.observe(container);
      } catch {}
      bottomKeepContainers.set(viewId, { container, disposable: disp, obs });
      try {
        await view.onActivate?.();
      } catch {}
      return;
    }

    bottomContent.innerHTML = "";
    try {
      const ret = view.component.render(bottomContent);
      bottomMountedDisposable = (ret as any) || null;
    } catch {
      bottomContent.innerHTML = "";
    }
    try {
      await view.onActivate?.();
    } catch {}
    try {
      bottomResizeObs = new ResizeObserver(() => {
        try {
          const r = bottomContent.getBoundingClientRect();
          view.onResize?.({ width: r.width, height: r.height });
        } catch {}
      });
      bottomResizeObs.observe(bottomContent);
    } catch {}
  };

  const renderBottomPanel = () => {
    applyRowHeights();
    applyColumnWidths();
    const isMobile = responsiveRuntime.getCurrentDeviceType() === "mobile";
    const isCompactOverlay = isMobile || responsiveRuntime.getCurrentMode() === "medium";
    const views = bottomPanelRuntime.getViews();
    try {
      const alive = new Set(views.map(v => v.id));
      for (const [id, rec] of Array.from(bottomKeepContainers.entries())) {
        if (alive.has(id)) continue;
        try {
          rec.obs?.disconnect();
        } catch {}
        try {
          rec.disposable?.dispose?.();
        } catch {}
        try {
          rec.container.remove();
        } catch {}
        bottomKeepContainers.delete(id);
      }
    } catch {}
    const visible = bottomPanelRuntime.isVisible() && views.length > 0;
    if (isCompactOverlay) {
      bottomPanelEl.style.position = "absolute";
      bottomPanelEl.style.left = isMobile
        ? "0"
        : `${getMediumOverlayLeftPx()}px`;
      bottomPanelEl.style.right = `${getBottomPanelOverlayRightPx(isMobile)}px`;
      bottomPanelEl.style.top = "";
      bottomPanelEl.style.bottom = `${getOverlayReservedBottom()}px`;
      bottomPanelEl.style.height = `${visible ? getOverlayBottomHeightPx() : 0}px`;
      bottomPanelEl.style.maxHeight = `${getOverlayBottomHeightPx()}px`;
      bottomPanelEl.style.zIndex = "70";
      bottomPanelEl.style.boxShadow = "0 12px 40px rgba(0, 0, 0, 0.35)";
    } else {
      bottomPanelEl.style.position = "relative";
      bottomPanelEl.style.left = "";
      bottomPanelEl.style.right = "";
      bottomPanelEl.style.top = "";
      bottomPanelEl.style.bottom = "";
      bottomPanelEl.style.height = "";
      bottomPanelEl.style.maxHeight = "";
      bottomPanelEl.style.zIndex = "";
      bottomPanelEl.style.boxShadow = "";
    }
    bottomPanelEl.style.display = visible ? "flex" : "none";
    if (!visible) {
      void bottomUnmountView(bottomMountedViewId);
      bottomMountedViewId = null;
      for (const rec of bottomKeepContainers.values()) {
        try {
          rec.container.style.display = "none";
        } catch {}
      }
      return;
    }

    const activeViewId = bottomPanelRuntime.getActiveViewId();
    const nextId = activeViewId && bottomPanelRuntime.getView(activeViewId) ? activeViewId : views[0]?.id ?? null;
    if (nextId && nextId !== activeViewId) bottomPanelRuntime.activateView(nextId);

    bottomTabs.innerHTML = "";
    for (const v of views) {
      const tab = el("button", "zion-bottompanel-tab") as HTMLButtonElement;
      tab.type = "button";
      const title = translatedTitle(v);
      tab.title = title;
      tab.setAttribute("aria-label", title);
      tab.dataset.viewId = v.id;
      tab.textContent = "";
      const icon = String(v.icon || "").trim();
      const codiconMatch = icon.match(/^\$\(([^)]+)\)$/);
      if (codiconMatch) {
        tab.appendChild(createZionIconFromCodicon(codiconMatch[1]));
      } else if (hasZionIcon(icon)) {
        tab.appendChild(createZionIcon(zionIconName(icon)));
      } else if (icon) {
        const span = document.createElement("span");
        span.textContent = safeText(icon);
        span.setAttribute("aria-hidden", "true");
        tab.appendChild(span);
      }
      const label = document.createElement("span");
      label.textContent = safeText(title);
      tab.appendChild(label);
      if (v.id === nextId) tab.classList.add("is-active");
      tab.onclick = () => bottomPanelRuntime.activateView(v.id);
      installReorderableTab(tab, bottomTabs, v.id, (ids) => bottomPanelRuntime.setViewOrder(ids));
      bottomTabs.appendChild(tab);
    }

    const activeView = nextId ? bottomPanelRuntime.getView(nextId) : null;
    bottomActions.querySelectorAll(".zion-bottompanel-plugin-action").forEach((node) => node.remove());
    for (const action of activeView?.headerActions || []) {
      const btn = el("button", "zion-bottompanel-action zion-bottompanel-plugin-action") as HTMLButtonElement;
      btn.type = "button";
      const title = translatedTitle(action as any);
      btn.title = title;
      btn.setAttribute("aria-label", tr((action as any).ariaLabelKey, safeText(action.ariaLabel || title)));
      btn.textContent = "";
      const actionAny = action as any;
      const actionActive = (() => {
        try {
          return typeof actionAny.active === "function" ? !!actionAny.active() : !!actionAny.active;
        } catch {
          return false;
        }
      })();
      if (actionActive) btn.classList.add("is-active");
      const icon = String(action.icon || "").trim();
      const text = tr((action as any).textKey, String((action as any).text || "").trim()).trim();
      const codiconMatch = icon.match(/^\$\(([^)]+)\)$/);
      if (codiconMatch) {
        btn.appendChild(createZionIconFromCodicon(codiconMatch[1]));
      } else if (hasZionIcon(icon)) {
        btn.appendChild(createZionIcon(zionIconName(icon)));
      } else if (icon) {
        btn.textContent = safeText(icon || title);
      }
      if (text) {
        btn.classList.add("has-label");
        const label = document.createElement("span");
        label.textContent = safeText(text);
        btn.appendChild(label);
      } else if (!icon) {
        btn.textContent = safeText(title);
      }
      btn.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          action.onClick();
        } catch {}
      };
      bottomActions.insertBefore(btn, bottomMaxBtn);
    }

    setCodiconOnly(bottomMaxBtn, bottomPanelRuntime.isMaximized() ? "chevron-down" : "chevron-up");
    bottomMaxBtn.title = bottomPanelRuntime.isMaximized() ? "Restore Panel" : "Maximize Panel";
    bottomMaxBtn.setAttribute("aria-label", bottomPanelRuntime.isMaximized() ? "Restore Panel" : "Maximize Panel");

    if (views.length === 0) {
      if (!bottomContent.contains(bottomEmpty)) {
        bottomContent.innerHTML = "";
        bottomContent.appendChild(bottomEmpty);
      }
      return;
    }

    if (bottomMountedViewId !== nextId) {
      void (async () => {
        await bottomUnmountView(bottomMountedViewId);
        bottomMountedViewId = nextId;
        for (const [id, rec] of bottomKeepContainers.entries()) {
          if (id !== nextId) rec.container.style.display = "none";
        }
        await bottomMountView(bottomMountedViewId);
      })();
    }

    let dragging = false;
    let startY = 0;
    let startH = bottomPanelRuntime.getHeight();

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dy = startY - e.clientY;
      bottomPanelRuntime.setHeight(startH + dy);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
        setResizeDragShield(false);
      bottomResizer.classList.remove("is-dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem("zion.ui.bottomPanelHeight", String(bottomPanelRuntime.getHeight()));
      } catch {}
    };

    bottomResizer.onmousedown = (e) => {
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startH = bottomPanelRuntime.getHeight();
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
      setResizeDragShield(true, "row-resize");
      bottomResizer.classList.add("is-dragging");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  };

  const resetHeaderLeading = () => {
    header.classList.remove("has-leading");
    header.style.removeProperty("--zion-sidebar-leading-width");
    headerLeading.replaceChildren();
  };

  const unmountHeaderLeading = () => {
    const disposable = mountedHeaderLeadingDisposable;
    mountedHeaderLeadingDisposable = null;
    mountedHeaderLeadingViewId = null;
    mountedHeaderLeadingGeneration = null;
    resetHeaderLeading();
    try {
      disposable?.dispose?.();
    } catch {}
  };

  const mountHeaderLeading = (viewId: string | null) => {
    if (mountedHeaderLeadingViewId === viewId) return;
    unmountHeaderLeading();
    if (!viewId) return;
    const view = sideBarRuntime.getView(viewId);
    if (!view?.headerLeading) return;
    mountedHeaderLeadingViewId = viewId;
    const generation = ++nextHeaderLeadingGeneration;
    mountedHeaderLeadingGeneration = generation;
    let requestedVisible = false;
    let validWidth: number | null = null;
    const isCurrent = () =>
      mountedHeaderLeadingViewId === viewId
      && mountedHeaderLeadingGeneration === generation;
    const applyVisibility = () => {
      if (!isCurrent()) return;
      header.classList.toggle("has-leading", requestedVisible && validWidth !== null);
    };
    try {
      const ret = view.headerLeading.render(headerLeading, {
        setVisible: (visible) => {
          if (!isCurrent()) return;
          requestedVisible = !!visible;
          applyVisibility();
        },
        setWidth: (px) => {
          if (!isCurrent()) return;
          const width = Number(px);
          if (!Number.isFinite(width) || width <= 0) {
            applyVisibility();
            return;
          }
          validWidth = Math.max(1, Math.round(width));
          header.style.setProperty("--zion-sidebar-leading-width", `${validWidth}px`);
          applyVisibility();
        }
      });
      const disposable = (ret as any) || null;
      if (!isCurrent()) {
        try {
          disposable?.dispose?.();
        } catch {}
        return;
      }
      mountedHeaderLeadingDisposable = disposable;
    } catch {
      if (isCurrent()) unmountHeaderLeading();
    }
  };

  const unmountView = async (viewId: string | null) => {
    if (!viewId) return;
    const prev = sideBarRuntime.getView(viewId);
    try {
      await prev?.onDeactivate?.();
    } catch {}
    try {
      mountedDisposable?.dispose?.();
    } catch {}
    mountedDisposable = null;
    try {
      resizeObs?.disconnect();
    } catch {}
    resizeObs = null;
  };

  const mountView = async (viewId: string | null, container: HTMLElement) => {
    if (!viewId) {
      container.innerHTML = "";
      return;
    }
    const view = sideBarRuntime.getView(viewId);
    if (!view) {
      container.innerHTML = "";
      return;
    }
    container.innerHTML = "";
    try {
      const ret = view.component.render(container);
      mountedDisposable = (ret as any) || null;
    } catch {
      container.innerHTML = "";
    }
    try {
      await view.onActivate?.();
    } catch {}
    try {
      resizeObs = new ResizeObserver(() => {
        try {
          const r = container.getBoundingClientRect();
          view.onResize?.({ width: r.width, height: r.height });
        } catch {}
      });
      resizeObs.observe(container);
    } catch {}
  };

  const renderSideBar = () => {
    applyColumnWidths();
    const views = sideBarRuntime.getViews();
    const activeViewId = sideBarRuntime.getActiveViewId();
    const nextId = activeViewId && sideBarRuntime.getView(activeViewId)
      ? activeViewId
      : views[0]?.id ?? null;
    const nextView = nextId ? sideBarRuntime.getView(nextId) : null;

    mountHeaderLeading(nextId);
    if (!sideBarRuntime.isVisible()) return;

    headerTitle.textContent = translatedTitle(nextView, "Side Bar");
    headerActions.innerHTML = "";
    if (nextView?.headerActions && Array.isArray(nextView.headerActions)) {
      for (const a of nextView.headerActions) {
        const btn = el("button", "zion-sidebar-action");
        btn.type = "button";
        const title = translatedTitle(a);
        const ariaLabel = tr(a.ariaLabelKey, safeText(a.ariaLabel || title));
        btn.title = title;
        btn.setAttribute("aria-label", ariaLabel);
        const icon = String(a.icon || "").trim();
        btn.textContent = "";
        const codiconMatch = icon.match(/^\$\(([^)]+)\)$/);
        if (codiconMatch) {
          btn.appendChild(createZionIconFromCodicon(codiconMatch[1]));
        } else if (hasZionIcon(icon)) {
          btn.appendChild(createZionIcon(zionIconName(icon)));
        } else {
          btn.textContent = safeText(icon);
        }
        const syncActive = () => {
          if (a.active === undefined) {
            btn.classList.remove("is-active");
            btn.removeAttribute("aria-pressed");
            return;
          }
          let active = false;
          try {
            active = typeof a.active === "function" ? !!a.active() : !!a.active;
          } catch {}
          btn.classList.toggle("is-active", active);
          btn.setAttribute("aria-pressed", String(active));
        };
        syncActive();
        btn.onclick = () => {
          let result: void | Promise<void> = undefined;
          try {
            result = a.onClick() as void | Promise<void>;
          } catch {}
          syncActive();
          void Promise.resolve(result).then(syncActive, syncActive);
        };
        headerActions.appendChild(btn);
      }
    }
    if (nextView?.showHideAction !== false) {
      headerActions.appendChild(hideBtn);
    }

    tabs.style.display = sideBarRuntime.getShowTabs() && views.length > 1 ? "flex" : "none";

    tabs.innerHTML = "";
    if (tabs.style.display !== "none") {
      for (const v of views) {
        const tab = el("button", "zion-sidebar-tab");
        tab.type = "button";
        const title = translatedTitle(v);
        tab.title = title;
        tab.setAttribute("aria-label", title);
        tab.textContent = safeText(v.icon ? `${v.icon} ${title}` : title);
        if (v.id === activeViewId) tab.classList.add("is-active");
        tab.onclick = () => sideBarRuntime.activateView(v.id);
        tabs.appendChild(tab);
      }
    }

    if (nextId !== activeViewId && nextId) {
      sideBarRuntime.activateView(nextId);
    }

    if (views.length === 0) {
      if (!content.contains(emptyMsg)) {
        content.innerHTML = "";
        content.appendChild(emptyMsg);
      }
    } else {
      if (content.contains(emptyMsg)) {
        content.removeChild(emptyMsg);
      }
    }

    if (mountedViewId !== nextId) {
      void (async () => {
        await unmountView(mountedViewId);
        mountedViewId = nextId;
        await mountView(mountedViewId, content);
      })();
    }

    let dragging = false;
    let startX = 0;
    let startW = sideBarRuntime.getWidth();

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      sideBarRuntime.setWidth(startW + dx);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
        setResizeDragShield(false);
      resizer.classList.remove("is-dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem("zion.ui.sidebarWidth", String(sideBarRuntime.getWidth()));
      } catch {}
    };

    resizer.onmousedown = (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startW = sideBarRuntime.getWidth();
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      setResizeDragShield(true);
      resizer.classList.add("is-dragging");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  };

  try {
    const persisted = localStorage.getItem("zion.ui.sidebarWidth");
    const w = persisted ? Number(persisted) : NaN;
    if (isFinite(w)) sideBarRuntime.setWidth(w);
  } catch {}

  try {
    const persisted = localStorage.getItem("zion.ui.auxBarWidth");
    const w = persisted ? Number(persisted) : NaN;
    if (isFinite(w)) auxiliaryBarRuntime.setWidth(w);
    auxiliaryBarRuntime.hide();
  } catch {}

  try {
    const persisted = localStorage.getItem("zion.ui.bottomPanelHeight");
    const h = persisted ? Number(persisted) : NaN;
    if (isFinite(h)) bottomPanelRuntime.setHeight(h);
    else bottomPanelRuntime.setHeight(bottomPanelRuntime.getHeight());
    bottomPanelRuntime.hide();
  } catch {}

  const dispA = activityBarRuntime.onDidChange(() => {
    renderActivityBar();
    renderMobileBar();
  });
    const dispS = sideBarRuntime.onDidChange(() => {
      if (!adjustingSidebarForWidePanels && sidebarAutoCollapsedForWidePanels && sideBarRuntime.isVisible()) {
        sidebarAutoCollapsedForWidePanels = false;
      }
      renderSideBar();
    });
  const dispX = auxiliaryBarRuntime.onDidChange(() => renderAuxiliaryBar());
  const dispInspector = inspectorRuntime.onDidChange(() => renderInspector());
  const dispB = bottomPanelRuntime.onDidChange(() => renderBottomPanel());
  let dispI18n: { dispose?: () => void } | null = null;
  try {
    dispI18n = (window as any).zion?.events?.on?.("i18n/changed", () => {
      renderActivityBar();
      renderSideBar();
      renderAuxiliaryBar();
      renderInspector();
      renderBottomPanel();
      renderMobileBar();
    }) || null;
  } catch {}
  const onResize = () => {
    applyColumnWidths();
    renderMobileBar();
    renderInspector();
    renderBottomPanel();
  };
  window.addEventListener("resize", onResize);

  renderActivityBar();
  renderSideBar();
  renderAuxiliaryBar();
  renderInspector();
  renderBottomPanel();
  renderMobileBar();

  return {
    editorHost,
    editorHeaderPathEl,
    editorTabsBarEl,
    dispose: () => {
        setResizeDragShield(false);
      try {
        dispA.dispose();
      } catch {}
      try {
        dispS.dispose();
      } catch {}
      try {
        dispX.dispose();
      } catch {}
      try {
        dispInspector.dispose();
      } catch {}
      try {
        dispInspectorTextReveal.dispose();
      } catch {}
      try {
        dispB.dispose();
      } catch {}
      try {
        dispI18n?.dispose?.();
      } catch {}
      try {
        window.removeEventListener("resize", onResize);
      } catch {}
      try {
        disposeInspectorContent();
        stopInspectorResize();
        document.removeEventListener("click", closeInspectorToolbarMenuOnOutsideClick);
      } catch {}
      try {
        unmountHeaderLeading();
        void unmountView(mountedViewId);
      } catch {}
      try {
        void auxUnmountView(auxMountedViewId);
      } catch {}
      try {
        for (const rec of auxKeepContainers.values()) {
          try {
            rec.obs?.disconnect();
          } catch {}
          try {
            rec.disposable?.dispose?.();
          } catch {}
        }
      } catch {}
      try {
        void bottomUnmountView(bottomMountedViewId);
      } catch {}
      try {
        for (const rec of bottomKeepContainers.values()) {
          try {
            rec.obs?.disconnect();
          } catch {}
          try {
            rec.disposable?.dispose?.();
          } catch {}
        }
      } catch {}
      try {
        root.remove();
      } catch {}
      try {
        root.removeEventListener("scroll", onScrollCapture, true);
      } catch {}
      try {
        for (const tid of scrollTimers.values()) window.clearTimeout(tid);
      } catch {}
      try {
        scrollTimers.clear();
      } catch {}
    }
  };
}
