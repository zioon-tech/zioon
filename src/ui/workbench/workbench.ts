import { activityBarRuntime, sideBarRuntime } from "./runtime";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function safeText(text: string) {
  return String(text ?? "");
}

function isScrollable(el: HTMLElement): boolean {
  try {
    const st = getComputedStyle(el);
    const oy = st.overflowY;
    if (oy !== "auto" && oy !== "scroll") return false;
    return el.scrollHeight > el.clientHeight + 1;
  } catch {
    return false;
  }
}

function findScrollableTarget(start: EventTarget | null, root: HTMLElement): HTMLElement | null {
  let cur = start as any;
  while (cur && cur instanceof HTMLElement) {
    if (cur === root) return null;
    if (root.contains(cur) && isScrollable(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

export function initWorkbench(host: HTMLElement): { editorHost: HTMLElement; dispose: () => void } {
  const root = el("div", "zion-workbench");
  const activityBarEl = el("div", "zion-activitybar");
  const sideBarEl = el("div", "zion-sidebar");
  const editorEl = el("div", "zion-editor");

  root.appendChild(activityBarEl);
  root.appendChild(sideBarEl);
  root.appendChild(editorEl);

  host.appendChild(root);

  const applyColumnWidths = () => {
    const aVisible = activityBarRuntime.isVisible();
    const sVisible = sideBarRuntime.isVisible();
    const w = sideBarRuntime.getWidth();
    root.style.setProperty("--activitybar-w", aVisible ? "48px" : "0px");
    root.style.setProperty("--sidebar-w", sVisible ? `${w}px` : "0px");
    activityBarEl.style.visibility = aVisible ? "visible" : "hidden";
    activityBarEl.style.pointerEvents = aVisible ? "auto" : "none";
    sideBarEl.style.visibility = sVisible ? "visible" : "hidden";
    sideBarEl.style.pointerEvents = sVisible ? "auto" : "none";
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
      btn.textContent = safeText(it.icon || "");
      btn.onclick = () => activityBarRuntime.activateItem(it.id);
      list.appendChild(btn);
    }
    activityBarEl.appendChild(list);
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
        const target = findScrollableTarget(we.target, rootEl) || fallback;
        try {
          target.scrollTop += we.deltaY;
        } catch {}
        we.preventDefault();
        we.stopPropagation();
      },
      { passive: false }
    );
  };

  preventScrollChain(activityBarEl, activityBarEl);
  preventScrollChain(sideBarEl, content);

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
        btn.textContent = safeText(a.icon || "");
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

  const dispA = activityBarRuntime.onDidChange(() => renderActivityBar());
  const dispS = sideBarRuntime.onDidChange(() => renderSideBar());

  renderActivityBar();
  renderSideBar();

  return {
    editorHost: editorEl,
    dispose: () => {
      try {
        dispA.dispose();
      } catch {}
      try {
        dispS.dispose();
      } catch {}
      try {
        void unmountView(mountedViewId);
      } catch {}
      try {
        root.remove();
      } catch {}
    }
  };
}
