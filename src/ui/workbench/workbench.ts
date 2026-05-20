import { activityBarRuntime, auxiliaryBarRuntime, bottomPanelRuntime, responsiveRuntime, sideBarRuntime } from "./runtime";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function safeText(text: string) {
  return String(text ?? "");
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
  const bottomPanelEl = el("div", "zion-bottompanel");
  const overlayMaskEl = el("div", "zion-overlay-mask");
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
  root.appendChild(auxiliaryBarEl);
  root.appendChild(bottomPanelEl);
  root.appendChild(overlayMaskEl);
  root.appendChild(mobileBarEl);

  host.appendChild(root);

  const scrollTimers = new Map<HTMLElement, number>();
  const onScrollCapture = (e: Event) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    try {
      t.classList.add("zion-scroll-active");
      const prev = scrollTimers.get(t);
      if (prev) window.clearTimeout(prev);
      const tid = window.setTimeout(() => {
        try { t.classList.remove("zion-scroll-active"); } catch {}
      }, 700);
      scrollTimers.set(t, tid);
    } catch {}
  };
  root.addEventListener("scroll", onScrollCapture, true);

  const updateOverlayMask = () => {
    const isMobile = responsiveRuntime.getCurrentDeviceType() === "mobile";
    const isCompactOverlay = isMobile || responsiveRuntime.getCurrentMode() === "medium";
    const hasSide = sideBarRuntime.isVisible() && sideBarRuntime.getViews().length > 0;
    const hasAux = auxiliaryBarRuntime.isVisible() && auxiliaryBarRuntime.getViews().length > 0;
    const hasBottom = bottomPanelRuntime.isVisible() && bottomPanelRuntime.getViews().length > 0;
    const hasOverlay =
      (isMobile && hasSide) ||
      (isCompactOverlay && hasAux) ||
      (isCompactOverlay && hasBottom);
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

  const applyColumnWidths = () => {
    const isMobile = responsiveRuntime.getCurrentDeviceType() === "mobile";
    const isCompactOverlay = isMobile || responsiveRuntime.getCurrentMode() === "medium";
    const aVisible = activityBarRuntime.isVisible();
    const sVisible = sideBarRuntime.isVisible() && sideBarRuntime.getViews().length > 0;
    const xVisible = auxiliaryBarRuntime.isVisible() && auxiliaryBarRuntime.getViews().length > 0;
    const w = sideBarRuntime.getWidth();
    const xw = auxiliaryBarRuntime.getWidth();
    if (isMobile) {
      root.style.setProperty("--activitybar-w", "0px");
      root.style.setProperty("--sidebar-w", "0px");
      root.style.setProperty("--auxbar-w", "0px");
      root.style.setProperty("--sidebar-overlay-w", `${w}px`);
      root.style.setProperty("--auxbar-overlay-w", `${xw}px`);
      activityBarEl.style.visibility = "hidden";
      activityBarEl.style.pointerEvents = "none";
    } else {
      root.style.setProperty("--activitybar-w", aVisible ? "48px" : "0px");
      root.style.setProperty("--sidebar-w", sVisible ? `${w}px` : "0px");
      root.style.setProperty("--auxbar-w", !isCompactOverlay && xVisible ? `${xw}px` : "0px");
      root.style.setProperty("--auxbar-overlay-w", `${xw}px`);
      activityBarEl.style.visibility = aVisible ? "visible" : "hidden";
      activityBarEl.style.pointerEvents = aVisible ? "auto" : "none";
    }
    sideBarEl.style.visibility = sVisible ? "visible" : "hidden";
    sideBarEl.style.pointerEvents = sVisible ? "auto" : "none";
    auxiliaryBarEl.style.visibility = xVisible ? "visible" : "hidden";
    auxiliaryBarEl.style.pointerEvents = xVisible ? "auto" : "none";
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
      const rect = root.getBoundingClientRect();
      const maxAllowed = isMobile
        ? Math.round(rect.width * 0.92)
        : Math.round(Math.min(420, rect.width * 0.7));
      return Math.max(240, Math.min(maxAllowed, Math.round(requested)));
    } catch {
      return Math.max(240, Math.round(requested));
    }
  };

  const getMediumOverlayLeftPx = () => {
    try {
      const activityW = activityBarRuntime.isVisible() ? 48 : 0;
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
        const span = document.createElement("span");
        span.className = `codicon codicon-${codiconMatch[1]}`;
        btn.appendChild(span);
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
    cmdBtn.textContent = "⌘";
    cmdBtn.onclick = () => {
      try {
        (window as any).zion?.commands?.executeCommand?.("commandPalette.open");
      } catch {}
    };
    mobileBarActionsEl.appendChild(cmdBtn);
  };

  const renderActivityBar = () => {
    applyColumnWidths();
    activityBarEl.innerHTML = "";
    if (!activityBarRuntime.isVisible()) return;

    const items = activityBarRuntime.getItems();
    const activeId = activityBarRuntime.getActiveItemId();

    const list = el("div", "zion-activitybar-list");
    for (const it of items) {
      const btn = el("button", "zion-activitybar-item");
      btn.type = "button";
      btn.title = safeText(it.tooltip || "");
      btn.setAttribute("aria-label", safeText(it.tooltip || it.id));
      if (activeId === it.id) btn.classList.add("is-active");
      const icon = String(it.icon || "").trim();
      btn.textContent = "";
      const codiconMatch = icon.match(/^\$\(([^)]+)\)$/);
      if (codiconMatch) {
        const span = document.createElement("span");
        span.className = `codicon codicon-${codiconMatch[1]}`;
        btn.appendChild(span);
      } else {
        btn.textContent = safeText(icon);
      }
      btn.onclick = () => activityBarRuntime.activateItem(it.id);
      list.appendChild(btn);
    }
    activityBarEl.appendChild(list);

    // Bottom actions area (settings + commands)
    const bottom = el("div", "zion-activitybar-bottom");

    const settingsBtn = el("button", "zion-activitybar-item zion-activitybar-settings") as HTMLButtonElement;
    settingsBtn.type = "button";
    settingsBtn.title = "设置";
    settingsBtn.setAttribute("aria-label", "设置");
    const settingsIcon = document.createElement("span");
    settingsIcon.className = "codicon codicon-gear";
    settingsBtn.appendChild(settingsIcon);
    settingsBtn.onclick = () => {
      try {
        (window as any).zion?.settings?.open?.();
      } catch {}
    };
    bottom.appendChild(settingsBtn);

    const cmdBtn = el("button", "zion-activitybar-item zion-activitybar-command") as HTMLButtonElement;
    cmdBtn.type = "button";
    cmdBtn.title = "Commands";
    cmdBtn.setAttribute("aria-label", "Commands");
    cmdBtn.textContent = "⌘";
    cmdBtn.onclick = () => {
      try {
        (window as any).zion?.commands?.executeCommand?.("commandPalette.open");
      } catch {}
    };
    bottom.appendChild(cmdBtn);

    activityBarEl.appendChild(bottom);
  };

  let mountedViewId: string | null = null;
  let mountedDisposable: { dispose?: () => void } | null = null;
  let resizeObs: ResizeObserver | null = null;

  sideBarEl.style.position = "relative";
  const header = el("div", "zion-sidebar-header");
  const headerTitle = el("div", "zion-sidebar-title");
  const headerActions = el("div", "zion-sidebar-actions");
  const hideBtn = el("button", "zion-sidebar-action");
  hideBtn.type = "button";
  hideBtn.title = "Hide";
  hideBtn.setAttribute("aria-label", "Hide sidebar");
  hideBtn.textContent = "×";
  hideBtn.onclick = () => sideBarRuntime.hide();
  headerActions.appendChild(hideBtn);
  header.appendChild(headerTitle);
  header.appendChild(headerActions);

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
  preventScrollChain(auxiliaryBarEl, auxiliaryBarEl);
  preventScrollChain(bottomPanelEl, bottomPanelEl);

  auxiliaryBarEl.style.position = "relative";
  const auxHeader = el("div", "zion-auxbar-header");
  const auxHeadLeft = el("div", "zion-auxbar-headleft");
  const auxTabs = el("div", "zion-auxbar-tabs");
  const auxTitle = el("div", "zion-auxbar-title");
  const auxActions = el("div", "zion-auxbar-actions");
  const auxHideBtn = el("button", "zion-auxbar-action") as HTMLButtonElement;
  auxHideBtn.type = "button";
  auxHideBtn.title = "Hide";
  auxHideBtn.setAttribute("aria-label", "Hide auxiliary bar");
  auxHideBtn.textContent = "×";
  auxHideBtn.onclick = () => {
    try {
      auxiliaryBarRuntime.hide();
    } catch {}
  };
  auxActions.appendChild(auxHideBtn);
  auxHeadLeft.appendChild(auxTitle);
  auxHeadLeft.appendChild(auxTabs);
  auxHeader.appendChild(auxHeadLeft);
  auxHeader.appendChild(auxActions);
  const auxContent = el("div", "zion-auxbar-content");
  const auxEmpty = el("div", "zion-auxbar-empty");
  auxEmpty.textContent = "暂无可用视图";
  const auxResizer = el("div", "zion-auxbar-resizer");

  auxiliaryBarEl.appendChild(auxHeader);
  auxiliaryBarEl.appendChild(auxContent);
  auxiliaryBarEl.appendChild(auxResizer);

  let auxMountedViewId: string | null = null;
  let auxTransientContainer: HTMLElement | null = null;
  let auxTransientDisposable: { dispose?: () => void } | null = null;
  let auxTransientResizeObs: ResizeObserver | null = null;
  const auxKeepContainers = new Map<
    string,
    { container: HTMLElement; disposable: { dispose?: () => void } | null; obs: ResizeObserver | null }
  >();

  const auxUnmountView = async (viewId: string | null) => {
    if (!viewId) return;
    const prev = auxiliaryBarRuntime.getView(viewId);
    try {
      await prev?.onDeactivate?.();
    } catch {}
    const keep = !!prev?.keepWhenActive;
    if (keep) {
      const rec = auxKeepContainers.get(viewId);
      if (rec?.container) rec.container.style.display = "none";
      return;
    }
    try {
      auxTransientDisposable?.dispose?.();
    } catch {}
    auxTransientDisposable = null;
    try {
      auxTransientResizeObs?.disconnect();
    } catch {}
    auxTransientResizeObs = null;
    try {
      auxTransientContainer?.remove();
    } catch {}
    auxTransientContainer = null;
  };

  const auxMountView = async (viewId: string | null, container: HTMLElement) => {
    if (!viewId) {
      return;
    }
    const view = auxiliaryBarRuntime.getView(viewId);
    if (!view) {
      return;
    }
    const keep = !!view.keepWhenActive;
    if (keep) {
      const existing = auxKeepContainers.get(viewId);
      if (existing) {
        existing.container.style.display = "block";
        try {
          await view.onActivate?.();
        } catch {}
        return;
      }
      const c = el("div", "zion-auxbar-view");
      c.style.height = "100%";
      c.style.width = "100%";
      c.style.minHeight = "0";
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
        await view.onActivate?.();
      } catch {}
      return;
    }

    const c = el("div", "zion-auxbar-view");
    c.style.height = "100%";
    c.style.width = "100%";
    c.style.minHeight = "0";
    container.appendChild(c);
    auxTransientContainer = c;
    try {
      const ret = view.component.render(c);
      auxTransientDisposable = (ret as any) || null;
    } catch {
      c.innerHTML = "";
    }
    try {
      await view.onActivate?.();
    } catch {}
    try {
      auxTransientResizeObs = new ResizeObserver(() => {
        try {
          const r = c.getBoundingClientRect();
          view.onResize?.({ width: r.width, height: r.height });
        } catch {}
      });
      auxTransientResizeObs.observe(c);
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
      void auxUnmountView(auxMountedViewId);
      auxMountedViewId = null;
      auxTabs.innerHTML = "";
      try {
        for (const rec of auxKeepContainers.values()) rec.container.style.display = "none";
      } catch {}
      return;
    }

    const activeViewId = auxiliaryBarRuntime.getActiveViewId();

    auxTabs.style.display = views.length > 1 ? "flex" : "none";
    auxTitle.style.display = views.length > 1 ? "none" : "block";
    auxTitle.textContent = safeText(views[0]?.title || "");
    auxTabs.innerHTML = "";
    if (auxTabs.style.display !== "none") {
      for (const v of views) {
        const tab = el("button", "zion-auxbar-tab");
        (tab as HTMLButtonElement).type = "button";
        tab.title = safeText(v.title);
        tab.setAttribute("aria-label", safeText(v.title));
        tab.textContent = safeText(v.icon ? `${v.icon} ${v.title}` : v.title);
        if (v.id === activeViewId) tab.classList.add("is-active");
        (tab as HTMLButtonElement).onclick = () => auxiliaryBarRuntime.activateView(v.id);
        auxTabs.appendChild(tab);
      }
    }

    const nextId = activeViewId && auxiliaryBarRuntime.getView(activeViewId) ? activeViewId : views[0]?.id ?? null;
    if (nextId !== activeViewId && nextId) {
      auxiliaryBarRuntime.activateView(nextId);
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
      void (async () => {
        await auxUnmountView(auxMountedViewId);
        auxMountedViewId = nextId;
        for (const [id, rec] of auxKeepContainers.entries()) {
          if (id !== nextId) rec.container.style.display = "none";
        }
        await auxMountView(auxMountedViewId, auxContent);
      })();
    }

    let dragging = false;
    let startX = 0;
    let startW = auxiliaryBarRuntime.getWidth();

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = startX - e.clientX;
      auxiliaryBarRuntime.setWidth(startW + dx);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem("zion.ui.auxBarWidth", String(auxiliaryBarRuntime.getWidth()));
      } catch {}
    };

    auxResizer.onmousedown = (e) => {
      dragging = true;
      startX = e.clientX;
      startW = auxiliaryBarRuntime.getWidth();
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  };

  bottomPanelEl.style.position = "relative";
  const bottomHeader = el("div", "zion-bottompanel-header");
  const bottomTabs = el("div", "zion-bottompanel-tabs");
  const bottomActions = el("div", "zion-bottompanel-actions");
  const bottomMaxBtn = el("button", "zion-bottompanel-action") as HTMLButtonElement;
  bottomMaxBtn.type = "button";
  bottomMaxBtn.title = "Maximize";
  bottomMaxBtn.setAttribute("aria-label", "Maximize bottom panel");
  bottomMaxBtn.textContent = "⬆";
  bottomMaxBtn.onclick = () => {
    try {
      if (bottomPanelRuntime.isMaximized()) bottomPanelRuntime.restore();
      else bottomPanelRuntime.maximize();
    } catch {}
  };
  const bottomHideBtn = el("button", "zion-bottompanel-action") as HTMLButtonElement;
  bottomHideBtn.type = "button";
  bottomHideBtn.title = "Hide";
  bottomHideBtn.setAttribute("aria-label", "Hide bottom panel");
  bottomHideBtn.textContent = "×";
  bottomHideBtn.onclick = () => {
    try {
      bottomPanelRuntime.hide();
    } catch {}
  };
  bottomActions.appendChild(bottomMaxBtn);
  bottomActions.appendChild(bottomHideBtn);
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
      bottomPanelEl.style.right = "0";
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
      tab.title = safeText(v.title);
      tab.setAttribute("aria-label", safeText(v.title));
      tab.textContent = safeText(v.icon ? `${v.icon} ${v.title}` : v.title);
      if (v.id === nextId) tab.classList.add("is-active");
      tab.onclick = () => bottomPanelRuntime.activateView(v.id);
      bottomTabs.appendChild(tab);
    }

    bottomMaxBtn.textContent = bottomPanelRuntime.isMaximized() ? "⬇" : "⬆";
    bottomMaxBtn.title = bottomPanelRuntime.isMaximized() ? "Restore" : "Maximize";
    bottomMaxBtn.setAttribute("aria-label", bottomPanelRuntime.isMaximized() ? "Restore bottom panel" : "Maximize bottom panel");

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
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem("zion.ui.bottomPanelHeight", String(bottomPanelRuntime.getHeight()));
      } catch {}
    };

    bottomResizer.onmousedown = (e) => {
      dragging = true;
      startY = e.clientY;
      startH = bottomPanelRuntime.getHeight();
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
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
    if (!sideBarRuntime.isVisible()) return;
    const views = sideBarRuntime.getViews();
    const activeViewId = sideBarRuntime.getActiveViewId();
    const activeView = activeViewId ? sideBarRuntime.getView(activeViewId) : null;

    headerTitle.textContent = safeText(activeView?.title || "Side Bar");

    headerActions.innerHTML = "";
    if (activeView?.headerActions && Array.isArray(activeView.headerActions)) {
      for (const a of activeView.headerActions) {
        const btn = el("button", "zion-sidebar-action");
        btn.type = "button";
        btn.title = safeText(a.title);
        btn.setAttribute("aria-label", safeText(a.ariaLabel || a.title));
        const icon = String(a.icon || "").trim();
        btn.textContent = "";
        const codiconMatch = icon.match(/^\$\(([^)]+)\)$/);
        if (codiconMatch) {
          const span = document.createElement("span");
          span.className = `codicon codicon-${codiconMatch[1]}`;
          span.setAttribute("aria-hidden", "true");
          btn.appendChild(span);
        } else {
          btn.textContent = safeText(icon);
        }
        btn.onclick = () => {
          try {
            a.onClick();
          } catch {}
        };
        headerActions.appendChild(btn);
      }
    }
    headerActions.appendChild(hideBtn);

    tabs.style.display = sideBarRuntime.getShowTabs() && views.length > 1 ? "flex" : "none";

    tabs.innerHTML = "";
    if (tabs.style.display !== "none") {
      for (const v of views) {
        const tab = el("button", "zion-sidebar-tab");
        tab.type = "button";
        tab.title = safeText(v.title);
        tab.setAttribute("aria-label", safeText(v.title));
        tab.textContent = safeText(v.icon ? `${v.icon} ${v.title}` : v.title);
        if (v.id === activeViewId) tab.classList.add("is-active");
        tab.onclick = () => sideBarRuntime.activateView(v.id);
        tabs.appendChild(tab);
      }
    }

    const nextId = activeViewId && sideBarRuntime.getView(activeViewId) ? activeViewId : views[0]?.id ?? null;
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
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem("zion.ui.sidebarWidth", String(sideBarRuntime.getWidth()));
      } catch {}
    };

    resizer.onmousedown = (e) => {
      dragging = true;
      startX = e.clientX;
      startW = sideBarRuntime.getWidth();
      document.body.style.userSelect = "none";
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

  const dispA = activityBarRuntime.onDidChange(() => renderActivityBar());
  const dispS = sideBarRuntime.onDidChange(() => renderSideBar());
  const dispX = auxiliaryBarRuntime.onDidChange(() => renderAuxiliaryBar());
  const dispB = bottomPanelRuntime.onDidChange(() => renderBottomPanel());
  const onResize = () => {
    renderMobileBar();
    renderBottomPanel();
  };
  window.addEventListener("resize", onResize);

  renderActivityBar();
  renderSideBar();
  renderAuxiliaryBar();
  renderBottomPanel();
  renderMobileBar();

  return {
    editorHost,
    editorHeaderPathEl,
    editorTabsBarEl,
    dispose: () => {
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
        dispB.dispose();
      } catch {}
      try {
        window.removeEventListener("resize", onResize);
      } catch {}
      try {
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
