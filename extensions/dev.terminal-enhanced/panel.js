/**
 * Terminal Enhanced Panel with PTY WebSocket + xterm.js
 */
function t(key, fallback, values) {
  const fullKey = `dev.terminal-enhanced.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

export function installTerminalEnhancedPanel(api = { execute: async () => {}, connectPty: null }, opts = {}) {
  const HEIGHT_KEY = "zion.terminalEnhanced.panelHeightPx";
  const WIDTH_KEY = "zion.terminalEnhanced.panelWidthPx";
  const DOCK_KEY = "zion.terminalEnhanced.dock";
  const STYLE_ID = "zion-terminal-enhanced-style";
  const mountEl = opts && opts.mount instanceof HTMLElement ? opts.mount : null;
  const embedded = !!mountEl;
  const rootId = typeof opts?.rootId === "string" && opts.rootId.trim() ? opts.rootId.trim() : null;
  const embedTabsInBottomHeader = embedded && opts?.embedTabsInBottomHeader === true;

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const viewportH = () => window.innerHeight || document.documentElement?.clientHeight || 800;
  const viewportW = () => window.innerWidth || document.documentElement?.clientWidth || 1200;

  function ensurePanelStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.zion-terminal-enhanced-root { pointer-events: none; }
.zion-terminal-enhanced-root .zte-panel { pointer-events: auto; }

.zte-panel {
  background: var(--panel);
  color: var(--fg);
  display: flex;
  flex-direction: column;
  min-height: 200px;
}

/* 滚动条主题化 (WebKit + Firefox) */
.zte-panel {
  scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
  scrollbar-width: thin;
}
.zte-panel::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
.zte-panel::-webkit-scrollbar-track {
  background: var(--scrollbar-track);
}
.zte-panel::-webkit-scrollbar-thumb {
  background-color: var(--scrollbar-thumb);
  border-radius: 6px;
  border: 2px solid transparent;
  background-clip: content-box;
}
.zte-panel:hover::-webkit-scrollbar-thumb {
  background-color: var(--scrollbar-thumb-hover);
}

/* xterm 内部元素间距重置 */
.zte-panel .xterm-viewport {
  top: 0;
  margin: 0;
}
.zte-panel .xterm-screen {
  position: relative;
  margin: 0;
  padding: 0;
}
.zte-panel .xterm {
  height: 100%;
  margin: 0;
  padding: 0;
}

/* 隐藏 xterm 内部高度为 14px 的空白 div（xterm 生成的占位符）- 已移除，可能导致 DOM 偏移 */
/*
.zte-panel .xterm-rows > div[style*="height: 14px"]:empty {
  display: none !important;
}
*/

/* xterm viewport 滚动条主题化 */
.zte-panel .xterm-viewport {
  scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
  scrollbar-width: thin;
}
.zte-panel .xterm-viewport::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
.zte-panel .xterm-viewport::-webkit-scrollbar-track {
  background: var(--scrollbar-track);
}
.zte-panel .xterm-viewport::-webkit-scrollbar-thumb {
  background-color: var(--scrollbar-thumb);
  border-radius: 6px;
  border: 2px solid transparent;
  background-clip: content-box;
}
.zte-panel .xterm-viewport:hover::-webkit-scrollbar-thumb {
  background-color: var(--scrollbar-thumb-hover);
}

.zte-resize-handle {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
  cursor: row-resize;
  z-index: 2;
}

.zion-terminal-enhanced-root[data-zte-dock="right"] .zte-resize-handle {
  top: 0;
  bottom: 0;
  left: 0;
  width: 6px;
  height: auto;
  right: auto;
  cursor: col-resize;
}

/* 失活的 SSH 会话标签样式 */
.zte-tab.is-inactive {
  opacity: 0.75;
}
.zte-tab.is-inactive:hover {
  opacity: 1;
}
.zte-resize-handle::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 1px;
  width: 34px;
  height: 4px;
  transform: translateX(-50%);
  border-radius: 999px;
  background: color-mix(in srgb, var(--fg) 25%, transparent);
  opacity: 0.55;
}

.zion-terminal-enhanced-root[data-zte-dock="right"] .zte-resize-handle::after {
  left: 1px;
  top: 50%;
  width: 4px;
  height: 34px;
  transform: translateY(-50%);
}
.zte-resize-handle:hover::after { opacity: 0.9; }

.zte-topbar {
  height: 36px;
  padding: 0 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: none;
  background: transparent;
}

.zte-topbar.is-bottom-header {
  height: 28px;
  min-width: 0;
  flex: 1 1 0;
  max-width: min(440px, 40vw);
  padding: 0;
  margin: 0 6px 0 auto;
  overflow: hidden;
}
.zte-topbar.is-bottom-header .zte-tabs {
  padding: 0;
}
.zte-topbar.is-bottom-header .zte-tab {
  height: 22px;
  padding: 0 8px;
  border-radius: 5px;
}
.zte-topbar.is-bottom-header .zte-tab-label {
  max-width: 160px;
}
.zte-topbar.is-bottom-header .zte-icon-btn {
  width: 22px;
  height: 22px;
}
.zte-topbar.is-bottom-header .zte-actions {
  gap: 2px;
}

.zte-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  flex: 1;
  min-width: 0;
  padding: 6px 0 4px;
  position: relative;
}

/* 标签页滚动容器 */
.zte-tabs-scroll {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  overflow-y: hidden;
  flex: 1;
  min-width: 0;
  /* 隐藏滚动条但保持滚动功能 */
  scrollbar-width: none; /* Firefox */
  -ms-overflow-style: none; /* IE/Edge */
}
.zte-tabs-scroll::-webkit-scrollbar {
  display: none; /* Chrome/Safari/Edge */
}

.zte-tab {
  height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  flex: 0 0 auto;
  transition: all 80ms ease;
  font-size: 12px;
  line-height: 1;
  position: relative;
  opacity: 0.85;
}
.zte-tab:hover {
  background: color-mix(in srgb, var(--border) 30%, transparent);
  opacity: 1;
}
.zte-tab.is-active {
  background: color-mix(in srgb, var(--border) 60%, transparent);
  color: var(--fg);
  font-weight: 500;
  opacity: 1;
}
.zte-tab.is-active::before {
  content: "";
  position: absolute;
  bottom: -5px;
  left: 10px;
  right: 10px;
  height: 2px;
  border-radius: 1px;
}
.zte-tab-label {
  font-size: 11px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.zte-tab-close {
  border: none;
  background: transparent;
  color: var(--fg);
  opacity: 0;
  padding: 0 2px;
  cursor: pointer;
  pointer-events: none;
  font-size: 12px;
  line-height: 1;
  border-radius: 3px;
  margin-left: 4px;
  transition: all 80ms ease;
}
.zte-tab:hover .zte-tab-close { opacity: 0.7; pointer-events: auto; }
.zte-tab-close:hover {
  opacity: 1;
  background: rgba(255, 100, 100, 0.2);
  color: #ff6b6b;
}

.zte-tab-activate {
  height: 18px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
  font-size: 11px;
  line-height: 18px;
  opacity: 0.85;
  transition: all 120ms ease;
}
.zte-tab-activate:hover {
  opacity: 1;
  background: var(--border);
}
.zte-tab-activate[disabled] {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 标签页导航按钮 */
.zte-tabs-nav {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  margin-left: 4px;
  padding: 0 4px;
  background: transparent;
  border-radius: 4px;
}

.zte-tab-nav-btn {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  border-radius: 3px;
  opacity: 0.55;
  transition: all 80ms ease;
  padding: 0;
}

.zte-tab-nav-btn:hover {
  opacity: 1;
  background: var(--border);
}

.zte-tab-nav-btn:disabled {
  opacity: 0.2;
  cursor: not-allowed;
}

.zte-tab-nav-btn svg {
  width: 12px;
  height: 12px;
}

/* 标签页下拉菜单 */
.zte-tabs-dropdown {
  position: relative;
}

.zte-tabs-menu {
  position: fixed;
  min-width: 240px;
  max-width: 320px;
  max-height: 300px;
  overflow-y: auto;
  background: var(--panel);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  padding: 4px;
  z-index: 960;
  display: none;
  scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
  scrollbar-width: thin;
}

.zte-tabs-menu.show {
  display: block;
}

.zte-tabs-menu::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.zte-tabs-menu::-webkit-scrollbar-track {
  background: var(--scrollbar-track);
}
.zte-tabs-menu::-webkit-scrollbar-thumb {
  background-color: var(--scrollbar-thumb);
  border-radius: 6px;
}

.zte-tabs-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.zte-tabs-menu-item:hover {
  background: color-mix(in srgb, var(--fg) 7%, transparent);
}

.zte-tabs-menu-item.is-active {
  background: color-mix(in srgb, var(--border) 50%, transparent);
  font-weight: 500;
}

.zte-tabs-menu-item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.zte-tabs-menu-item-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.zte-tabs-menu-item-close {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  border-radius: 3px;
  opacity: 0.5;
  transition: all 80ms ease;
}

.zte-tabs-menu-item-close:hover {
  opacity: 1;
  background: rgba(255, 100, 100, 0.2);
  color: #ff6b6b;
}

.zte-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.zte-icon-btn {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--fg);
  padding: 0;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition: all 120ms ease;
}
.zte-icon-btn svg {
  width: 14px;
  height: 14px;
  opacity: 0.75;
}
.zte-icon-btn:hover {
  background: var(--border);
}
.zte-icon-btn:hover svg {
  opacity: 1;
}
.zte-icon-btn:active { transform: translateY(1px); }
.zte-icon-btn[disabled] {
  cursor: not-allowed;
  opacity: 0.4;
}

.zte-toast {
  position: absolute;
  right: 10px;
  bottom: 10px;
  z-index: 6;
  padding: 6px 12px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--fg);
  font-size: 12px;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0,0,0,0.25);
}

.zte-find {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.zte-find-toggle {
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--fg);
  padding: 0 8px;
  cursor: pointer;
  font-size: 12px;
  opacity: 0.75;
  transition: all 120ms ease;
}
.zte-find-toggle.is-on {
  opacity: 1;
  border-color: var(--border);
  background: var(--border);
  color: var(--fg);
}
.zte-find-toggle:hover {
  opacity: 1;
  background: var(--border);
}

.zte-menu {
  backdrop-filter: blur(10px);
}
.zte-menu-item:hover { background: color-mix(in srgb, var(--fg) 7%, transparent); }

.zte-palette-row:hover { background: color-mix(in srgb, var(--fg) 7%, transparent); }

/* Suggest box 滚动条主题化 */
.zte-suggest-box {
  scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
  scrollbar-width: thin;
}
.zte-suggest-box::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.zte-suggest-box::-webkit-scrollbar-track {
  background: var(--scrollbar-track);
}
.zte-suggest-box::-webkit-scrollbar-thumb {
  background-color: var(--scrollbar-thumb);
  border-radius: 6px;
}
.zte-suggest-box:hover::-webkit-scrollbar-thumb {
  background-color: var(--scrollbar-thumb-hover);
}

/* Links (xterm web-links addon) - Canvas 模式下 CSS 无效，仅保留 tooltip 样式 */
.zte-link-tooltip {
  position: absolute;
  z-index: 1005;
  display: none;
  pointer-events: none;
  padding: 6px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--panel) 92%, black);
  border: 1px solid var(--border);
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  color: var(--fg);
  font-size: 12px;
  white-space: nowrap;
}
`;
    document.head.appendChild(style);
  }

  function getActiveEditorElement() {
    try {
      const ed = window?.zion?.window?.activeEditor;
      const dom = ed?.core?.view?.dom;
      if (dom instanceof HTMLElement) return dom;
    } catch {}

    const el = document.querySelector(".cm-editor");
    return el instanceof HTMLElement ? el : null;
  }

  function getEditorContainerElement() {
    try {
      const el = document.querySelector("#app > div") || document.getElementById("app");
      return el instanceof HTMLElement ? el : null;
    } catch {
      return null;
    }
  }

  function getEditorAreaElement() {
    try {
      const el = document.querySelector("#app > div");
      return el instanceof HTMLElement ? el : null;
    } catch {
      return null;
    }
  }

  function getAppElement() {
    try {
      const el = document.getElementById("app");
      return el instanceof HTMLElement ? el : null;
    } catch {
      return null;
    }
  }

  function setRightDockShiftEnabled(enabled) {
    const editorContainer = getEditorContainerElement();
    if (!editorContainer) return;

    const appEl = getAppElement();
    const active = !!root?._zteRightShiftActive;

    if (!enabled) {
      if (!active) return;

      try {
        if (typeof root?._ztePrevEditorContainerWidth === "string") editorContainer.style.width = root._ztePrevEditorContainerWidth;
        if (typeof root?._ztePrevEditorContainerBoxSizing === "string") editorContainer.style.boxSizing = root._ztePrevEditorContainerBoxSizing;
        if (typeof root?._ztePrevEditorContainerMaxWidth === "string") editorContainer.style.maxWidth = root._ztePrevEditorContainerMaxWidth;
        if (typeof root?._ztePrevEditorContainerMarginRight === "string") editorContainer.style.marginRight = root._ztePrevEditorContainerMarginRight;
      } catch {}

      if (appEl) {
        try {
          if (typeof root?._ztePrevAppOverflowX === "string") appEl.style.overflowX = root._ztePrevAppOverflowX;
        } catch {}
      }

      try {
        root._zteRightShiftActive = false;
        delete root._ztePrevEditorContainerWidth;
        delete root._ztePrevEditorContainerBoxSizing;
        delete root._ztePrevEditorContainerMaxWidth;
        delete root._ztePrevEditorContainerMarginRight;
        delete root._ztePrevAppOverflowX;
      } catch {}
      return;
    }

    if (!active) {
      try {
        root._ztePrevEditorContainerWidth = editorContainer.style.width || "";
        root._ztePrevEditorContainerBoxSizing = editorContainer.style.boxSizing || "";
        root._ztePrevEditorContainerMaxWidth = editorContainer.style.maxWidth || "";
        root._ztePrevEditorContainerMarginRight = editorContainer.style.marginRight || "";
      } catch {}

      if (appEl) {
        try {
          root._ztePrevAppOverflowX = appEl.style.overflowX || "";
        } catch {}
      }

      try {
        root._zteRightShiftActive = true;
      } catch {}
    }

    const w = Math.round(root.getBoundingClientRect().width || 0);
    if (!w) return;

    editorContainer.style.boxSizing = "border-box";
    editorContainer.style.marginRight = "0";
    editorContainer.style.maxWidth = "100%";
    editorContainer.style.width = `calc(100% - ${w}px)`;

    if (appEl) {
      try { appEl.style.overflowX = "hidden"; } catch {}
    }
  }

  function setBottomDockShiftEnabled(enabled) {
    const editorArea = getEditorAreaElement();
    if (!editorArea) return;

    const active = !!root?._zteBottomShiftActive;

    if (!enabled) {
      if (!active) return;

      try {
        if (typeof root?._ztePrevEditorAreaHeight === "string") editorArea.style.height = root._ztePrevEditorAreaHeight;
        if (typeof root?._ztePrevEditorAreaMaxHeight === "string") editorArea.style.maxHeight = root._ztePrevEditorAreaMaxHeight;
        if (typeof root?._ztePrevEditorAreaBoxSizing === "string") editorArea.style.boxSizing = root._ztePrevEditorAreaBoxSizing;
      } catch {}

      try {
        root._zteBottomShiftActive = false;
        delete root._ztePrevEditorAreaHeight;
        delete root._ztePrevEditorAreaMaxHeight;
        delete root._ztePrevEditorAreaBoxSizing;
      } catch {}
      return;
    }

    if (!active) {
      try {
        root._ztePrevEditorAreaHeight = editorArea.style.height || "";
        root._ztePrevEditorAreaMaxHeight = editorArea.style.maxHeight || "";
        root._ztePrevEditorAreaBoxSizing = editorArea.style.boxSizing || "";
      } catch {}

      try {
        root._zteBottomShiftActive = true;
      } catch {}
    }

    const h = Math.round(root.getBoundingClientRect().height || 0);
    if (!h) return;

    editorArea.style.boxSizing = "border-box";
    editorArea.style.maxHeight = "none";
    editorArea.style.height = `calc(100% - ${h}px)`;
  }

  function getDockBox() {
    const edEl = getActiveEditorElement();
    if (!edEl) return null;
    const r = edEl.getBoundingClientRect();
    if (!r || !Number.isFinite(r.left) || !Number.isFinite(r.right) || r.width <= 0) return null;

    const left = Math.max(0, Math.min(window.innerWidth, r.left));
    const right = Math.max(0, Math.min(window.innerWidth, r.right));
    if (right <= left) return null;
    const top = Math.max(0, Math.min(window.innerHeight, r.top));
    const bottom = Math.max(0, Math.min(window.innerHeight, r.bottom));
    if (bottom <= top) return null;
    return { left, right, top, bottom };
  }

  function applyDocking(root) {
    const mode = root?.dataset?.zteDock === "right" ? "right" : "bottom";
    const box = getDockBox();
    const shouldShift = root.style.display === "block";
    try {
      if (mode === "right") {
        setRightDockShiftEnabled(shouldShift);
        setBottomDockShiftEnabled(false);
      } else {
        setRightDockShiftEnabled(false);
        setBottomDockShiftEnabled(shouldShift);
      }
    } catch {}
    if (!box) {
      if (mode === "right") {
        root.style.left = "";
        root.style.right = "0";
        root.style.top = "0";
        root.style.bottom = "0";
      } else {
        root.style.left = "0";
        root.style.right = "0";
        root.style.top = "";
        root.style.bottom = "0";
      }
      return;
    }

    const leftPx = Math.round(box.left);
    if (mode === "right") {
      const topPx = Math.round(box.top);
      const bottomGapPx = Math.max(0, Math.round(window.innerHeight - box.bottom));
      root.style.left = "";
      root.style.right = "0";
      root.style.top = `${topPx}px`;
      root.style.bottom = `${bottomGapPx}px`;
    } else {
      // Check for sessions sidebar and adjust left position to avoid being covered
      const sidebar = document.getElementById("zion-sessions-sidebar");
      let sidebarWidth = 0;
      if (sidebar && sidebar.style.display !== "none") {
        try {
          sidebarWidth = parseInt(sidebar.style.width || "0", 10) || 0;
        } catch {}
      }
      root.style.left = `${sidebarWidth}px`;
      root.style.right = "0";
      root.style.top = "";
      root.style.bottom = "0";
    }
  }

  function ensureDocking(root) {
    if (root?._zteDockingInstalled) return;
    root._zteDockingInstalled = true;

    let raf = 0;
    let ro = null;
    let roEditorArea = null;
    let observedEl = null;
    let observedEditorArea = null;
    const onRaf = () => {
      raf = 0;
      try {
        const nextEl = getActiveEditorElement();
        if (ro && nextEl !== observedEl) {
          try { if (observedEl) ro.unobserve(observedEl); } catch {}
          observedEl = nextEl;
          try { if (observedEl) ro.observe(observedEl); } catch {}
        }
      } catch {}
      try { applyDocking(root); } catch {}
    };
    const schedule = () => {
      if (raf) return;
      const rAF = globalThis?.requestAnimationFrame;
      if (typeof rAF !== "function") {
        onRaf();
        return;
      }
      raf = rAF(onRaf);
    };

    const onResize = () => schedule();
    const onScroll = () => schedule();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);

    let mo = null;
    try {
      const MO = globalThis?.MutationObserver;
      if (typeof MO === "function") mo = new MO(schedule);
      mo.observe(document.body, { attributes: true, attributeFilter: ["style", "class"] });
    } catch {}

    try {
      const RO = globalThis?.ResizeObserver;
      if (typeof RO === "function") ro = new RO(schedule);
      observedEl = getActiveEditorElement();
      if (observedEl) ro.observe(observedEl);
    } catch {
      ro = null;
      observedEl = null;
    }

    try {
      const RO = globalThis?.ResizeObserver;
      if (typeof RO === "function") roEditorArea = new RO(schedule);
      observedEditorArea = getEditorAreaElement();
      if (observedEditorArea) roEditorArea.observe(observedEditorArea);
    } catch {
      roEditorArea = null;
      observedEditorArea = null;
    }

    let dispWm = null;
    try {
      dispWm = window?.zion?.state?.onDidChange?.("ui.editorWidthMode", schedule);
    } catch {}

    root._zteDockingDispose = () => {
      try {
        const cAF = globalThis?.cancelAnimationFrame;
        if (raf && typeof cAF === "function") cAF(raf);
      } catch {}
      raf = 0;
      try { window.removeEventListener("resize", onResize); } catch {}
      try { window.removeEventListener("scroll", onScroll, true); } catch {}
      try { mo?.disconnect?.(); } catch {}
      try {
        if (ro) {
          try { if (observedEl) ro.unobserve(observedEl); } catch {}
          ro.disconnect();
        }
      } catch {}
      try {
        if (roEditorArea) {
          try { if (observedEditorArea) roEditorArea.unobserve(observedEditorArea); } catch {}
          roEditorArea.disconnect();
        }
      } catch {}
      try { dispWm?.dispose?.(); } catch {}
    };

    schedule();
  }

  function readSavedDockMode() {
    try {
      const s = localStorage.getItem(DOCK_KEY);
      return s === "right" ? "right" : "bottom";
    } catch {
      return "bottom";
    }
  }

  function saveDockMode(mode) {
    try { localStorage.setItem(DOCK_KEY, String(mode || "bottom")); } catch {}
  }

  function readSavedWidthPx() {
    try {
      const s = localStorage.getItem(WIDTH_KEY);
      const n = s ? Number(s) : NaN;
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  function saveWidthPx(px) {
    try { localStorage.setItem(WIDTH_KEY, String(px)); } catch {}
  }

  function readSavedHeightPx() {
    try {
      const s = localStorage.getItem(HEIGHT_KEY);
      const n = s ? Number(s) : NaN;
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  function saveHeightPx(px) {
    try { localStorage.setItem(HEIGHT_KEY, String(px)); } catch {}
  }

  let root = null;
  if (!embedded) {
    root = document.getElementById("zion-terminal-enhanced-root");
    if (root) {
      ensurePanelStyles();
      ensureDocking(root);
      return createHandle(root);
    }
  }

  ensurePanelStyles();

  root = document.createElement("div");
  root.className = "zion-terminal-enhanced-root";
  if (!embedded) root.id = "zion-terminal-enhanced-root";
  else if (rootId) root.id = rootId;
  const initialDockMode = embedded ? "bottom" : readSavedDockMode();
  root.dataset.zteDock = initialDockMode;
  if (embedded) {
    Object.assign(root.style, {
      position: "relative",
      inset: "0",
      height: "100%",
      width: "100%",
      background: "transparent",
      zIndex: "",
      display: "block",
      minHeight: "0",
      overflow: "hidden"
    });
  } else {
    Object.assign(root.style, {
      position: "fixed",
      left: "0",
      right: "0",
      bottom: "0",
      height: "35vh",
      background: "transparent",
      zIndex: "900",
      display: "none"
    });
  }

  if (!embedded && initialDockMode === "right") {
    const savedW = readSavedWidthPx();
    const w0 = Number.isFinite(savedW) ? savedW : 420;
    const w = clamp(Math.floor(Number(w0 || 420)), 280, Math.floor(viewportW() * 0.75));
    root.style.width = `${w}px`;
    root.style.height = "";
  } else {
    if (!embedded) {
      const savedH = readSavedHeightPx();
      if (savedH) root.style.height = `${savedH}px`;
      root.style.width = "";
    }
  }

  const panel = document.createElement("div");
  panel.className = "zte-panel";
  Object.assign(panel.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    background: "var(--panel)",
    color: "var(--fg)",
    borderTop: embedded ? "0" : "1px solid var(--border)",
    borderLeft: embedded ? "0" : "1px solid var(--border)",
    borderRight: embedded ? "0" : "1px solid var(--border)",
    borderBottom: "0",
    borderRadius: "0",
    boxShadow: "none",
    display: "grid",
    gridTemplateRows: embedTabsInBottomHeader ? "1fr auto" : "auto 1fr auto",
    padding: "0",
    boxSizing: "border-box",
    fontFamily: "var(--font-sans)"
  });

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "zte-resize-handle";
  resizeHandle.title = t("panel.resize", "Drag to resize terminal");
  if (embedded) resizeHandle.style.display = "none";
  panel.appendChild(resizeHandle);

  const topbar = document.createElement("div");
  topbar.className = "zte-topbar";
  if (embedTabsInBottomHeader) topbar.classList.add("is-bottom-header");
  Object.assign(topbar.style, {
    overflow: "hidden"
  });

  const tabs = document.createElement("div");
  tabs.className = "zte-tabs";
  topbar.appendChild(tabs);

  // 创建标签页滚动容器
  const tabsScroll = document.createElement("div");
  tabsScroll.className = "zte-tabs-scroll";
  tabs.appendChild(tabsScroll);

  const actions = document.createElement("div");
  actions.className = "zte-actions";

  // SVG 图标定义
  const ICONS = {
    plus: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>`,
    trash: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1M6 7v6M10 7v6"/></svg>`,
    dockBottom: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 2.5h11v11h-11z"/><path d="M2.5 10.5h11"/></svg>`,
    dockRight: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 2.5h11v11h-11z"/><path d="M10.5 2.5v11"/></svg>`,
    x: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
    chevronLeft: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 3L5 8l5 5"/></svg>`,
    chevronRight: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3l5 5-5 5"/></svg>`,
    chevronDown: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6l4 4 4-4"/></svg>`
  };

  // 创建标签页导航按钮（左/右滚动）
  const tabsNav = document.createElement("div");
  tabsNav.className = "zte-tabs-nav";

  const tabNavLeft = document.createElement("button");
  tabNavLeft.type = "button";
  tabNavLeft.className = "zte-tab-nav-btn";
  tabNavLeft.innerHTML = ICONS.chevronLeft;
  tabNavLeft.title = t("panel.scrollLeft", "Scroll tabs left");
  tabNavLeft.disabled = true;
  tabsNav.appendChild(tabNavLeft);

  const tabNavRight = document.createElement("button");
  tabNavRight.type = "button";
  tabNavRight.className = "zte-tab-nav-btn";
  tabNavRight.innerHTML = ICONS.chevronRight;
  tabNavRight.title = t("panel.scrollRight", "Scroll tabs right");
  tabNavRight.disabled = true;
  tabsNav.appendChild(tabNavRight);

  // 创建标签页下拉菜单容器
  const tabsDropdown = document.createElement("div");
  tabsDropdown.className = "zte-tabs-dropdown";

  const tabDropdownBtn = document.createElement("button");
  tabDropdownBtn.type = "button";
  tabDropdownBtn.className = "zte-tab-nav-btn";
  tabDropdownBtn.innerHTML = ICONS.chevronDown;
  tabDropdownBtn.title = t("panel.showAll", "Show all sessions");
  tabsDropdown.appendChild(tabDropdownBtn);

  const tabsMenu = document.createElement("div");
  tabsMenu.className = "zte-tabs-menu";
  // 将下拉菜单添加到 body 而不是 dropdown 内部，以避免被 terminal 遮挡
  document.body.appendChild(tabsMenu);

  tabsNav.appendChild(tabsDropdown);
  tabs.appendChild(tabsNav);

  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "zte-icon-btn";
  newBtn.innerHTML = ICONS.plus;
  newBtn.title = t("panel.newSession", "New terminal session");

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "zte-icon-btn";
  closeBtn.innerHTML = ICONS.x;
  closeBtn.title = embedded ? t("panel.hide", "Hide terminal panel") : t("panel.hideEsc", "Hide terminal panel (Esc)");
  if (embedded) closeBtn.style.display = "none";

  const dockBtn = document.createElement("button");
  dockBtn.type = "button";
  dockBtn.className = "zte-icon-btn";
  if (embedded) dockBtn.style.display = "none";

  actions.appendChild(newBtn);
  actions.appendChild(dockBtn);
  actions.appendChild(closeBtn);
  topbar.appendChild(actions);

  // Content (either xterm or fallback pre)
  const content = document.createElement("div");
  Object.assign(content.style, {
    position: "relative",
    overflow: "hidden",
    padding: "0",
    margin: "0",
    background: "var(--panel)"
  });

  // xterm container
  const termWrap = document.createElement("div");
  Object.assign(termWrap.style, {
    width: "100%",
    height: "100%",
    display: "none",
    overflow: "hidden",
    padding: "0 8px",
    margin: "0"
  });
  content.appendChild(termWrap);

  // Fallback Output area
  const fallbackPre = document.createElement("pre");
  Object.assign(fallbackPre.style, {
    margin: 0,
    padding: "12px 16px",
    background: "transparent",
    border: "0",
    borderRadius: "0",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    minHeight: "180px",
    maxHeight: "100%",
    overflow: "auto",
    display: "block"
  });
  content.appendChild(fallbackPre);

  // Footer with command input + Run + Quick
  const footer = document.createElement("div");
  Object.assign(footer.style, {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 8px",
    borderTop: "1px solid var(--border)",
    position: "relative",
    background: "transparent"
  });
  const cmdInput = document.createElement("input");
  cmdInput.type = "text";
  cmdInput.placeholder = t("panel.commandPlaceholder", "输入命令并回车执行...");
  Object.assign(cmdInput.style, {
    flex: "1",
    boxSizing: "border-box",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    background: "var(--panel)",
    color: "var(--fg)",
    outline: "none",
    padding: "4px 8px",
    fontSize: "12px",
    fontFamily: "var(--font-mono)",
    transition: "border-color 120ms ease"
  });
  // Add focus style via JS
  cmdInput.addEventListener("focus", () => {
    cmdInput.style.borderColor = "var(--border)";
    cmdInput.style.background = "var(--panel)";
  });
  cmdInput.addEventListener("blur", () => {
    cmdInput.style.borderColor = "var(--border)";
  });
  footer.appendChild(cmdInput);

  const suggestBox = document.createElement("div");
  suggestBox.className = "zte-suggest-box";
  Object.assign(suggestBox.style, {
    position: "absolute",
    left: "8px",
    right: "8px",
    bottom: "46px",
    maxHeight: "220px",
    overflow: "auto",
    background: "var(--panel)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    display: "none",
    zIndex: "1002"
  });
  footer.appendChild(suggestBox);

  if (!embedTabsInBottomHeader) panel.appendChild(topbar);
  panel.appendChild(content);
  panel.appendChild(footer);
  root.appendChild(panel);
  if (embedded) {
    mountEl.appendChild(root);
  } else {
    document.body.appendChild(root);
    ensureDocking(root);
  }

  let hostHeader = null;
  function syncHostHeaderTabsVisibility() {
    if (!embedTabsInBottomHeader) return;
    try {
      const activeId = window.zion?.state?.get?.("ui.bottomPanel.activeViewId");
      const visible = window.zion?.state?.get?.("ui.bottomPanel.visible") === true;
      topbar.style.display = visible && activeId === "terminal.enhanced.view" ? "flex" : "none";
    } catch {
      topbar.style.display = "flex";
    }
  }
  if (embedTabsInBottomHeader) {
    try {
      const panelHost = mountEl?.closest?.(".zion-bottompanel");
      hostHeader = panelHost?.querySelector?.(".zion-bottompanel-header") || null;
      const actionsHost = hostHeader?.querySelector?.(".zion-bottompanel-actions") || null;
      if (hostHeader && actionsHost) hostHeader.insertBefore(topbar, actionsHost);
      else if (hostHeader) hostHeader.appendChild(topbar);
      else panel.insertBefore(topbar, content);
    } catch {
      try { panel.insertBefore(topbar, content); } catch {}
    }
    syncHostHeaderTabsVisibility();
  }

  const toast = document.createElement("div");
  toast.className = "zte-toast";
  toast.style.display = "none";
  panel.appendChild(toast);

  const linkTooltip = document.createElement("div");
  linkTooltip.className = "zte-link-tooltip";
  linkTooltip.textContent = t("panel.followLink", "Follow link (Cmd+Click)");
  panel.appendChild(linkTooltip);

  let toastTimer = 0;
  function showToast(message, ms = 1200) {
    const text = String(message || "").trim();
    if (!text) return;
    try { clearTimeout(toastTimer); } catch {}
    toast.textContent = text;
    toast.style.display = "block";
    toastTimer = setTimeout(() => {
      toast.style.display = "none";
    }, ms);
  }

  function refreshI18n() {
    resizeHandle.title = t("panel.resize", "Drag to resize terminal");
    tabNavLeft.title = t("panel.scrollLeft", "Scroll tabs left");
    tabNavRight.title = t("panel.scrollRight", "Scroll tabs right");
    tabDropdownBtn.title = t("panel.showAll", "Show all sessions");
    newBtn.title = t("panel.newSession", "New terminal session");
    closeBtn.title = embedded ? t("panel.hide", "Hide terminal panel") : t("panel.hideEsc", "Hide terminal panel (Esc)");
    cmdInput.placeholder = t("panel.commandPlaceholder", "输入命令并回车执行...");
    linkTooltip.textContent = t("panel.followLink", "Follow link (Cmd+Click)");
    updateDockBtn();
    renderTabs();
    if (!isActiveUsingPty()) renderFallbackOutputs();
  }

  let linkHoverTimer = 0;
  let hoveringLink = false;

  function hideLinkTooltip() {
    try { clearTimeout(linkHoverTimer); } catch {}
    linkHoverTimer = 0;
    hoveringLink = false;
    try { linkTooltip.style.display = "none"; } catch {}
  }

  function positionLinkTooltip(clientX, clientY) {
    if (linkTooltip.style.display !== "block") return;
    const rect = panel.getBoundingClientRect();
    const panelW = rect.width || 1;
    const panelH = rect.height || 1;
    const padding = 8;
    const offset = 12;
    let x = clientX - rect.left + offset;
    let y = clientY - rect.top + offset;
    const w = linkTooltip.offsetWidth || 1;
    const h = linkTooltip.offsetHeight || 1;
    if (x + w + padding > panelW) x = panelW - w - padding;
    if (y + h + padding > panelH) y = panelH - h - padding;
    if (x < padding) x = padding;
    if (y < padding) y = padding;
    linkTooltip.style.left = `${Math.floor(x)}px`;
    linkTooltip.style.top = `${Math.floor(y)}px`;
  }

  function scheduleLinkTooltip(clientX, clientY) {
    try { clearTimeout(linkHoverTimer); } catch {}
    linkHoverTimer = setTimeout(() => {
      linkHoverTimer = 0;
      if (!hoveringLink) return;
      if (root.style.display === "none") return;
      linkTooltip.style.display = "block";
      positionLinkTooltip(clientX, clientY);
    }, 500);
  }

  function setPanelHeightPx(nextPx, persist = true) {
    if (embedded) {
      try { fitActiveView(); } catch {}
      return;
    }
    const maxPx = Math.floor(viewportH() * 0.85);
    const minPx = 180;
    const px = clamp(Math.floor(Number(nextPx || 0)), minPx, maxPx);
    root.style.height = `${px}px`;
    if (persist) saveHeightPx(px);
    try { fitActiveView(); } catch {}
  }

  function setPanelWidthPx(nextPx, persist = true) {
    if (embedded) {
      try { fitActiveView(); } catch {}
      return;
    }
    const maxPx = Math.floor(viewportW() * 0.75);
    const minPx = 280;
    const px = clamp(Math.floor(Number(nextPx || 0)), minPx, maxPx);
    root.style.width = `${px}px`;
    if (persist) saveWidthPx(px);
    try { fitActiveView(); } catch {}
    try {
      if (dockMode === "right" && root.style.display === "block") {
        setRightDockShiftEnabled(true);
      }
    } catch {}
  }

  let dockMode = root?.dataset?.zteDock === "right" ? "right" : "bottom";
  if (embedded) dockMode = "bottom";

  function updateDockBtn() {
    if (dockMode === "right") {
      dockBtn.innerHTML = ICONS.dockBottom;
      dockBtn.title = t("panel.dockBottom", "Dock terminal panel to bottom");
    } else {
      dockBtn.innerHTML = ICONS.dockRight;
      dockBtn.title = t("panel.dockRight", "Dock terminal panel to right");
    }
  }

  function setDockMode(nextMode, persist = true) {
    if (embedded) return;
    const next = nextMode === "right" ? "right" : "bottom";
    dockMode = next;
    root.dataset.zteDock = next;
    if (persist) saveDockMode(next);

    if (next === "right") {
      root.style.height = "";
      const savedW = readSavedWidthPx();
      const w0 = Number.isFinite(savedW) ? savedW : 420;
      setPanelWidthPx(w0, false);
      panel.style.borderBottom = "1px solid var(--border)";
    } else {
      root.style.width = "";
      const savedH = readSavedHeightPx();
      const h0 = Number.isFinite(savedH) ? savedH : Math.floor(viewportH() * 0.35);
      setPanelHeightPx(h0, false);
      panel.style.borderBottom = "0";
    }

    try { applyDocking(root); } catch {}
    updateDockBtn();
    try { requestAnimationFrame(() => fitActiveView()); } catch {}
  }

  if (!embedded) (function attachResize() {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startSize = 0;
    let raf = 0;
    let pending = null;

    const onMove = (ev) => {
      if (!dragging) return;
      if (dockMode === "right") {
        const dx = startX - ev.clientX;
        pending = startSize + dx;
      } else {
        const dy = startY - ev.clientY;
        pending = startSize + dy;
      }
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (pending == null) return;
        if (dockMode === "right") setPanelWidthPx(pending, false);
        else setPanelHeightPx(pending, false);
        pending = null;
      });
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      try { document.body.style.userSelect = ""; } catch {}
      try { document.body.style.cursor = ""; } catch {}
      try { document.removeEventListener("mousemove", onMove); } catch {}
      try { document.removeEventListener("mouseup", onUp); } catch {}
      const rect = root.getBoundingClientRect();
      if (dockMode === "right") setPanelWidthPx(rect.width, true);
      else setPanelHeightPx(rect.height, true);
    };

    resizeHandle.addEventListener("mousedown", (ev) => {
      dragging = true;
      startX = ev.clientX;
      startY = ev.clientY;
      const rect = root.getBoundingClientRect();
      startSize = dockMode === "right" ? rect.width : rect.height;
      try { document.body.style.userSelect = "none"; } catch {}
      try { document.body.style.cursor = dockMode === "right" ? "col-resize" : "row-resize"; } catch {}
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    resizeHandle.addEventListener("dblclick", () => {
      const rect = root.getBoundingClientRect();
      if (dockMode === "right") {
        const cur = rect.width;
        const maxPx = Math.floor(viewportW() * 0.75);
        const defPx = 420;
        const nearMax = Math.abs(cur - maxPx) < 10;
        setPanelWidthPx(nearMax ? defPx : maxPx, true);
      } else {
        const cur = rect.height;
        const maxPx = Math.floor(viewportH() * 0.85);
        const defPx = Math.floor(viewportH() * 0.35);
        const nearMax = Math.abs(cur - maxPx) < 10;
        setPanelHeightPx(nearMax ? defPx : maxPx, true);
      }
    });
  })();

  updateDockBtn();
  setDockMode(dockMode, false);

  // State
  let currentSessionId = window.zion?.state?.get("terminal.activeSessionId") || null;
  const sessionViews = new Map();
  let activeViewId = null;
  let xtermCtors = null;
  let xtermLoaded = false;
  let termContextMenu = null;
  let termFindWidget = null;
  const MAX_PTY_RETRY = 3;
  let findState = { caseSensitive: false, regex: false, wholeWord: false };
  let termWrapResizeObserver = null;
  const normId = (v) => String(v || "").trim();
  const reactivateInFlight = new Map();
  let refreshSessionsInFlight = null;
  let refreshSessionsInFlightAt = 0;
  const ptyNoticeAt = new Map();
  const onWindowResize = () => {
    if (root.style.display === "none") return;
    fitActiveView();
  };

  function getActiveView() {
    const sid = normId(activeViewId || currentSessionId || "");
    if (!sid) return null;
    return sessionViews.get(sid) || null;
  }

  async function refreshSessionsOnce() {
    const now = Date.now();
    if (refreshSessionsInFlight && now - refreshSessionsInFlightAt < 1500) return refreshSessionsInFlight;
    refreshSessionsInFlightAt = now;
    refreshSessionsInFlight = Promise.resolve(window.zion?.commands?.executeCommand?.("terminal.refreshSessions")).catch(() => null).finally(() => {
      refreshSessionsInFlight = null;
    });
    return refreshSessionsInFlight;
  }

  async function reactivateSessionOnce(sessionId) {
    const sid = normId(sessionId);
    if (!sid) return false;
    const existing = reactivateInFlight.get(sid);
    if (existing) return existing;
    const p = Promise.resolve(window.zion?.commands?.executeCommand?.("terminal.reactivateSession", { session_id: sid }))
      .then((v) => !!v)
      .catch(() => false)
      .finally(() => {
        reactivateInFlight.delete(sid);
      });
    reactivateInFlight.set(sid, p);
    return p;
  }

  async function connectSelectedSession(sessionId) {
    const id = normId(sessionId);
    if (!id) return;
    if (currentSessionId !== id) return;
    if (root.style.display === "none") return;

    try {
      const s2 = getSessionById(id);
      const isSsh2 = (s2?.type || "local") === "ssh";
      const isInactive2 = isSsh2 && s2?.active === false;

      if (isSsh2 && isInactive2) {
        const result = await reactivateSessionOnce(id);
        if (currentSessionId !== id) return;
        if (result) {
          await refreshSessionsOnce();
          renderTabs();
        } else {
          try { showToast("会话已失活，可点击“激活”重连"); } catch {}
          return;
        }
      }

      if (currentSessionId !== id) return;
      const ok = await connectPtyForSession(id);
      if (!ok && currentSessionId === id) {
        if (xtermLoaded) {
          activateView(id);
          setPanelModeForActive("pty");
          writeTerminalNotice(getActiveView(), t("panel.ptyReconnectTriggered", "PTY 未连接，已触发重连"));
        } else {
          fallbackPre.textContent = currentOutputsToText();
        }
      }
    } catch (e) {
      try { console.warn("[terminal] Session connect error:", e); } catch {}
    }
  }

  function scheduleConnectSelectedSession(sessionId) {
    const id = normId(sessionId);
    if (!id) return;
    setTimeout(() => {
      connectSelectedSession(id);
    }, 0);
  }

  function switchToSession(sid) {
    const id = String(sid || "").trim();
    if (!id) return;
    currentSessionId = id;
    try { window.zion?.state?.set("terminal.activeSessionId", id); } catch {}
    activeViewId = id;
    renderTabs();

    const existing = sessionViews.get(id);
    if (existing) {
      activateView(id);
      setPanelModeForActive("pty");
      setTimeout(() => {
        if (currentSessionId !== id) return;
        try { getActiveView()?.term?.focus?.(); } catch {}
      }, 0);
      return;
    }

    setPanelModeForActive("pre");
    renderFallbackOutputs();
    setTimeout(() => {
      if (currentSessionId !== id) return;
      try { cmdInput?.focus?.(); } catch {}
    }, 0);
    Promise.resolve(ensureView(id))
      .then(() => {
        if (currentSessionId !== id) return;
        activeViewId = id;
        activateView(id);
        setPanelModeForActive("pty");
        setTimeout(() => {
          if (currentSessionId !== id) return;
          try { getActiveView()?.term?.focus?.(); } catch {}
        }, 0);
      })
      .catch(() => {
        if (currentSessionId !== id) return;
        setPanelModeForActive("pre");
        renderFallbackOutputs();
        setTimeout(() => {
          if (currentSessionId !== id) return;
          try { cmdInput?.focus?.(); } catch {}
        }, 0);
      });
  }

  function fitActiveView(immediate = false, retryCount = 0) {
    const v = getActiveView();
    if (!v || !v.term || !v.fitAddon) return;

    const doFit = () => {
      try {
        // Force reflow
        try { v.container.offsetHeight; } catch {}
        
        try { v.fitAddon.fit(); } catch {}
        
        if (v.pty) {
          const cols = v.term.cols;
          const rows = v.term.rows;
          // Avoid resizing to invalid/too small dimensions which causes shell prompt wrapping artifacts
          if (!cols || !rows || cols < 20 || rows < 2) {
             if (retryCount < 5 && root.style.display !== "none") {
               setTimeout(() => fitActiveView(true, retryCount + 1), 100);
             }
             return;
          }

          // Check if dimensions actually changed
          if (v.lastCols === cols && v.lastRows === rows) return;
          v.lastCols = cols;
          v.lastRows = rows;

          v.pty.resize?.(cols, rows);
        }
      } catch (e) {
        console.warn('[terminal] fitActiveView error:', e);
      }
    };

    if (immediate) {
      doFit();
    } else {
      setTimeout(doFit, 0);
    }
  }

  function isActiveUsingPty() {
    const v = getActiveView();
    return !!(xtermLoaded && v?.term);
  }

  function writeTerminalNotice(v, message) {
    if (!v?.term) return;
    const msg = String(message || "").trim();
    if (!msg) return;
    try { v.term.writeln(""); } catch {}
    try { v.term.writeln(msg); } catch {}
  }

  async function sendCommandToSessionPty(sessionId, command) {
    const sid = String(sessionId || "").trim();
    const raw = String(command || "");
    const cmd = raw.endsWith("\r") ? raw : (raw + "\r");
    if (!sid || !cmd.trim()) return false;

    let v = null;
    try {
      v = await ensureView(sid);
      activateView(sid);
      setPanelModeForActive("pty");
    } catch {
      v = null;
    }

    try {
      await connectPtyForSession(sid, { background: false });
    } catch {}

    const vv = v || sessionViews.get(sid) || getActiveView();
    if (!vv) return false;
    const wsOpen = !!(vv.pty?.ws && vv.pty.ws.readyState === WebSocket.OPEN);
    if (wsOpen) {
      try { vv.pty.send(cmd); } catch {}
      return true;
    }

    try {
      const execRet = await api.execute?.(raw, sid);
      const out = typeof execRet === "string" ? execRet : (execRet && typeof execRet === "object" ? (execRet.output ?? execRet.stdout ?? execRet.stderr ?? "") : "");
      const outText = String(out ?? "");

      if (xtermLoaded && vv?.term) {
        try { vv.term.writeln(""); } catch {}
        try { vv.term.writeln(`$ ${raw}`); } catch {}
        for (const line of outText.split("\n")) {
          try { vv.term.writeln(line); } catch {}
        }
        try { vv.term.focus(); } catch {}
      } else {
        renderFallbackOutputs();
      }
      return true;
    } catch {
      if (vv.ptyInputBuffer.length < 8192) vv.ptyInputBuffer += cmd;
      try { showToast("PTY 连接中…", 800); } catch {}
      writeTerminalNotice(vv, "PTY 连接中…");
      schedulePtyReconnect(sid);
      return false;
    }
  }

  function applyThemeToTerm(t) {
    if (!t) return;
    const newBg = getComputedStyle(document.documentElement).getPropertyValue('--panel')?.trim() || '#1e1e1e';
    const newFg = getComputedStyle(document.documentElement).getPropertyValue('--fg')?.trim() || '#d4d4d4';
    const newSelBg = getComputedStyle(document.documentElement).getPropertyValue('--selection-bg')?.trim() || 'rgba(98,114,164,0.35)';
    try {
      t.options.theme = { ...t.options.theme, background: newBg, foreground: newFg, selectionBackground: newSelBg };
    } catch {}
  }

  function applyThemeToAllTerms() {
    for (const v of sessionViews.values()) {
      applyThemeToTerm(v?.term);
    }
  }

  function getSessionById(sessionId) {
    const sid = String(sessionId || "").trim();
    if (!sid) return null;
    const sessions = window.zion?.state?.get("terminal.sessions") || [];
    const list = Array.isArray(sessions) ? sessions : [];
    return list.find(s => String(s?.id || "").trim() === sid) || null;
  }

  function isInactiveSshSession(sessionId) {
    const s = getSessionById(sessionId);
    return (s?.type === "ssh") && (s?.active === false);
  }

  function shellSingleQuote(s) {
    return `'${String(s || "").replace(/'/g, `'\\''`)}'`;
  }

  // Lazy load xterm (prefer local dependency; fallback to CDN)
  let xtermLoadingPromise = null;
  async function ensureXtermLoaded() {
    if (xtermLoaded) return;
    if (xtermLoadingPromise) return xtermLoadingPromise;

    xtermLoadingPromise = (async () => {
      const ensureCss = (href) => {
        if (!href) return;
        if (document.getElementById("xterm-css")) return;
        const link = document.createElement("link");
        link.id = "xterm-css";
        link.rel = "stylesheet";
        link.href = href;
        document.head.appendChild(link);
      };

      let Terminal = null;
      let FitAddon = null;
      let SearchAddon = null;
      let WebLinksAddon = null;

      const loadFromLocal = async () => {
        try {
          const cssMod = await import("xterm/css/xterm.css?url");
          ensureCss(cssMod?.default || cssMod);
        } catch {}

        const xtermMod = await import("xterm");
        Terminal = xtermMod?.Terminal || xtermMod?.default?.Terminal || xtermMod?.default;

        const fitMod = await import("xterm-addon-fit");
        FitAddon = fitMod?.FitAddon || fitMod?.default?.FitAddon || fitMod?.default;

        const searchMod = await import("xterm-addon-search");
        SearchAddon = searchMod?.SearchAddon || searchMod?.default?.SearchAddon || searchMod?.default;

        const webLinksMod = await import("xterm-addon-web-links");
        WebLinksAddon = webLinksMod?.WebLinksAddon || webLinksMod?.default?.WebLinksAddon || webLinksMod?.default;
      };

      const loadFromCdn = async () => {
        ensureCss("https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css");
        const xtermMod = await import("https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js");
        const fitMod = await import("https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js");
        const searchMod = await import("https://cdn.jsdelivr.net/npm/xterm-addon-search@0.15.0/lib/xterm-addon-search.js");
        const webLinksMod = await import("https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.11.0/lib/xterm-addon-web-links.js");

        Terminal = xtermMod?.Terminal || xtermMod?.default?.Terminal || xtermMod?.default;
        FitAddon = fitMod?.FitAddon || fitMod?.default?.FitAddon || fitMod?.default;
        SearchAddon = searchMod?.SearchAddon || searchMod?.default?.SearchAddon || searchMod?.default;
        WebLinksAddon = webLinksMod?.WebLinksAddon || webLinksMod?.default?.WebLinksAddon || webLinksMod?.default;
      };

      try {
        await loadFromLocal();
      } catch {
        await loadFromCdn();
      }

      if (!Terminal || !FitAddon || !SearchAddon || !WebLinksAddon) {
        throw new Error("xterm load failed");
      }

      xtermCtors = { Terminal, FitAddon, SearchAddon, WebLinksAddon };
      const MO = globalThis.MutationObserver;
      const observer = typeof MO === "function" ? new MO(() => applyThemeToAllTerms()) : null;
      try { observer?.observe?.(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); } catch {}
      xtermCtors._zionThemeObserver = observer;
      xtermLoaded = true;
    })();

    try {
      await xtermLoadingPromise;
    } finally {
      xtermLoadingPromise = null;
    }
  }

  async function ensureView(sessionId) {
    const sid = String(sessionId || "").trim();
    if (!sid) return null;
    const existing = sessionViews.get(sid);
    if (existing) return existing;
    await ensureXtermLoaded();
    if (!xtermCtors?.Terminal) return null;

    const wrap = document.createElement("div");
    wrap.className = "zte-term-view";
    wrap.dataset.zteSessionId = sid;
    Object.assign(wrap.style, { width: "100%", height: "100%", overflow: "hidden", display: "none" });
    termWrap.appendChild(wrap);

    const ansiColors = {
      black: '#2e2e2e',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff'
    };

    const t = new xtermCtors.Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      allowProposedApi: true,
      convertEol: true,
      scrollback: 5000,
      altClickMovesCursor: true,
      theme: {
        background: getComputedStyle(document.documentElement).getPropertyValue('--panel') || '#1e1e1e',
        foreground: getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#d4d4d4',
        cursor: getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#d4d4d4',
        cursorAccent: getComputedStyle(document.documentElement).getPropertyValue('--panel') || '#1e1e1e',
        selectionBackground: getComputedStyle(document.documentElement).getPropertyValue('--selection-bg') || 'rgba(98,114,164,0.35)',
        selectionForeground: getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#d4d4d4',
        black: ansiColors.black,
        red: ansiColors.red,
        green: ansiColors.green,
        yellow: ansiColors.yellow,
        blue: ansiColors.blue,
        magenta: ansiColors.magenta,
        cyan: ansiColors.cyan,
        white: ansiColors.white,
        brightBlack: ansiColors.brightBlack,
        brightRed: ansiColors.brightRed,
        brightGreen: ansiColors.brightGreen,
        brightYellow: ansiColors.brightYellow,
        brightBlue: ansiColors.brightBlue,
        brightMagenta: ansiColors.brightMagenta,
        brightCyan: ansiColors.brightCyan,
        brightWhite: ansiColors.brightWhite
      }
    });
    const fa = new xtermCtors.FitAddon();
    const sa = new xtermCtors.SearchAddon();
    const wa = new xtermCtors.WebLinksAddon(
      (event, uri) => {
        const allow = !!(event?.metaKey || event?.ctrlKey);
        if (!allow) return;
        try { event.preventDefault(); } catch {}
        try { event.stopPropagation(); } catch {}
        const url = String(uri || "");
        if (!url) return;
        try {
          window.open(url, "_blank", "noopener,noreferrer");
        } catch {
          try { location.href = url; } catch {}
        }
      },
      {
        hover: (event, uri) => {
          hoveringLink = true;
          scheduleLinkTooltip(event.clientX, event.clientY);
        },
        leave: (event, uri) => {
          hideLinkTooltip();
        }
      }
    );
    t.loadAddon(fa);
    t.loadAddon(sa);
    t.loadAddon(wa);
    t.open(wrap);
    applyThemeToTerm(t);

    const v = {
      sessionId: sid,
      container: wrap,
      term: t,
      fitAddon: fa,
      searchAddon: sa,
      webLinksAddon: wa,
      usingPty: true,
      pty: null,
      ptyConnecting: false,
      ptyInputBuffer: "",
      ptyConnectNonce: 0,
      ptyRetryTimer: 0,
      ptyRetryCount: 0,
      termDataDisp: null,
      lastCols: 0,
      lastRows: 0
    };

    v.termDataDisp = t.onData((data) => {
      const wsOpen = !!(v.pty?.ws && v.pty.ws.readyState === WebSocket.OPEN);
      if (wsOpen) {
        try { v.pty.send(data); } catch {}
        return;
      }
      if (v.ptyInputBuffer.length < 8192) v.ptyInputBuffer += String(data || "");
      if (!v.ptyConnecting) Promise.resolve(connectPtyForSession(v.sessionId, { background: true })).catch(() => {});
    });

    installTerminalInteractionsForView(v);
    sessionViews.set(sid, v);
    return v;
  }

  function activateView(sessionId) {
    const sid = String(sessionId || "").trim();
    if (!sid) return;
    activeViewId = sid;
    for (const v of sessionViews.values()) {
      try { v.container.style.display = v.sessionId === sid ? "block" : "none"; } catch {}
    }
    try { fitActiveView(); } catch {}
  }

  function disposeView(sessionId) {
    const sid = String(sessionId || "").trim();
    const v = sid ? (sessionViews.get(sid) || null) : null;
    if (!v) return;
    try { clearTimeout(v.ptyRetryTimer); } catch {}
    try { clearTimeout(v.ptyStableTimer); } catch {}
    try { v.termDataDisp?.dispose?.(); } catch {}
    try { v.pty?.dispose?.(); } catch {}
    try { v.term?.dispose?.(); } catch {}
    try { v.container?.remove?.(); } catch {}
    sessionViews.delete(sid);
    if (activeViewId === sid) activeViewId = null;
  }

  function schedulePtyReconnect(sessionId) {
    const sid = normId(sessionId);
    const v = sid ? (sessionViews.get(sid) || null) : null;
    if (!v) return;
    try { clearTimeout(v.ptyRetryTimer); } catch {}
    v.ptyRetryTimer = 0;
    if (root.style.display === "none") return;
    if (sid !== normId(activeViewId || currentSessionId || "")) return;
    if (isInactiveSshSession(sid)) return;
    if (v.ptyRetryCount >= MAX_PTY_RETRY) {
      try { showToast("PTY 多次连接失败，已停止自动重连", 1600); } catch {}
      return;
    }
    const delay = Math.min(4000, 250 * (2 ** v.ptyRetryCount));
    v.ptyRetryCount += 1;
    v.ptyRetryTimer = setTimeout(() => {
      v.ptyRetryTimer = 0;
      if (root.style.display === "none") return;
      const vv = sessionViews.get(sid);
      if (!vv) return;
      if (vv.pty?.ws && vv.pty.ws.readyState === WebSocket.OPEN) return;
      if (vv.ptyConnecting) return;
      connectPtyForSession(sid, { background: true });
    }, delay);
  }

  function getTabLabelForSession(s) {
    if (!s) return "";

    const type = s.type || "local";
    const cwd = String(s?.cwd || "").trim();

    if (type === "ssh") {
      const host = s.ssh_host || "unknown";
      const port = s.ssh_port || 22;
      const cwdShort = cwd ? cwd.split("/").filter(Boolean).slice(-2).join("/") : "";
      if (cwdShort) {
        return `${host}:${cwdShort}`;
      }
      return `${host}:${port}`;
    }

    // Local session - show cwd
    const cwdShort = cwd ? cwd.split("/").filter(Boolean).slice(-2).join("/") : "";
    if (cwdShort) {
      return cwdShort;
    }

    // Fallback to ID
    return s.id || "";
  }

  function setClipboardText(text) {
    const val = String(text || "");
    if (!val) return Promise.resolve(false);
    if (navigator?.clipboard?.writeText) return navigator.clipboard.writeText(val).then(() => true).catch(() => false);
    try {
      const ta = document.createElement("textarea");
      ta.value = val;
      ta.setAttribute("readonly", "true");
      Object.assign(ta.style, { position: "fixed", left: "-9999px", top: "-9999px" });
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand?.("copy");
      ta.remove();
      return Promise.resolve(!!ok);
    } catch {
      return Promise.resolve(false);
    }
  }

  function getClipboardText() {
    if (navigator?.clipboard?.readText) return navigator.clipboard.readText().catch(() => "");
    return Promise.resolve("");
  }

  function ensureTermFindWidget() {
    if (termFindWidget) return termFindWidget;

    const wrap = document.createElement("div");
    wrap.className = "zte-find";
    Object.assign(wrap.style, {
      position: "absolute",
      right: "10px",
      top: "10px",
      zIndex: "1004",
      display: "none",
      background: "var(--panel)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
      padding: "6px",
      gap: "6px",
      alignItems: "center"
    });

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = t("panel.find", "Find");
    Object.assign(input.style, {
      width: "220px",
      boxSizing: "border-box",
      border: "1px solid var(--border)",
      borderRadius: "4px",
      background: "var(--panel)",
      color: "var(--fg)",
      outline: "none",
      padding: "6px 8px",
      fontSize: "12px",
      fontFamily: "var(--font-mono)"
    });

    const mkBtn = (label) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      Object.assign(b.style, {
        border: "1px solid var(--border)",
        borderRadius: "4px",
        background: "transparent",
        color: "var(--fg)",
        padding: "4px 8px",
        fontSize: "12px",
        cursor: "pointer",
        whiteSpace: "nowrap",
        transition: "all 120ms ease"
      });
      return b;
    };

    const mkToggle = (label, key, title) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.className = "zte-find-toggle";
      b.title = title;
      const paint = () => {
        const on = !!findState?.[key];
        b.classList.toggle("is-on", on);
      };
      paint();
      b.onclick = () => {
        findState = { ...findState, [key]: !findState?.[key] };
        paint();
        doFind(1);
      };
      return b;
    };

    const prevBtn = mkBtn("↑");
    const nextBtn = mkBtn("↓");
    const closeBtn2 = mkBtn("×");

    const caseBtn = mkToggle("Aa", "caseSensitive", "Case sensitive");
    const regexBtn = mkToggle(".*", "regex", "Regex");
    const wordBtn = mkToggle("W", "wholeWord", "Whole word");

    const doFind = (dir) => {
      const q = String(input.value || "");
      if (!q) return;
      try {
        const opts = { caseSensitive: !!findState.caseSensitive, regex: !!findState.regex, wholeWord: !!findState.wholeWord };
        const v = getActiveView();
        const sa = v?.searchAddon;
        if (dir < 0) sa?.findPrevious?.(q, opts);
        else sa?.findNext?.(q, opts);
      } catch {}
    };

    input.addEventListener("input", () => doFind(1));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        wrap.style.display = "none";
        getActiveView()?.term?.focus?.();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        doFind(e.shiftKey ? -1 : 1);
        return;
      }
    });
    prevBtn.onclick = () => doFind(-1);
    nextBtn.onclick = () => doFind(1);
    closeBtn2.onclick = () => {
      wrap.style.display = "none";
      getActiveView()?.term?.focus?.();
    };

    Object.assign(wrap.style, { display: "none", flexDirection: "row" });
    wrap.appendChild(input);
    wrap.appendChild(caseBtn);
    wrap.appendChild(regexBtn);
    wrap.appendChild(wordBtn);
    wrap.appendChild(prevBtn);
    wrap.appendChild(nextBtn);
    wrap.appendChild(closeBtn2);

    content.appendChild(wrap);
    termFindWidget = { wrap, input };
    return termFindWidget;
  }

  function openTermFind() {
    const w = ensureTermFindWidget();
    w.wrap.style.display = "flex";
    setTimeout(() => {
      try { w.input.focus(); w.input.select(); } catch {}
    }, 0);
  }

  function hideTermContextMenu() {
    try { termContextMenu?.remove(); } catch {}
    termContextMenu = null;
  }

  function openTermContextMenu(x, y) {
    hideTermContextMenu();
    const v = getActiveView();
    const t = v?.term || null;
    const p = v?.pty || null;
    const menu = document.createElement("div");
    menu.className = "zte-menu";
    Object.assign(menu.style, {
      position: "fixed",
      left: `${x}px`,
      top: `${y}px`,
      zIndex: "960",
      minWidth: "160px",
      background: "var(--panel)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
      padding: "6px",
      display: "grid",
      gap: "4px"
    });

    const mkItem = (label, onClick, opts = {}) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.className = "zte-menu-item";
      const disabled = !!opts.disabled;
      b.disabled = disabled;
      Object.assign(b.style, {
        width: "100%",
        textAlign: "left",
        border: "1px solid var(--border)",
        borderRadius: "4px",
        background: "transparent",
        color: "var(--fg)",
        padding: "6px 8px",
        fontSize: "12px",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? "0.55" : "1"
      });
      b.onclick = async () => {
        if (disabled) return;
        hideTermContextMenu();
        await onClick?.();
      };
      return b;
    };

    const hasSel = !!t?.hasSelection?.();
    menu.appendChild(mkItem("Copy", async () => {
      const sel = t?.getSelection?.() || "";
      const ok = await setClipboardText(sel);
      showToast(ok ? "Copied" : "Copy failed");
    }, { disabled: !hasSel }));
    menu.appendChild(mkItem("Paste", async () => {
      const txt = await getClipboardText();
      if (!txt) return;
      try { t?.paste?.(txt); } catch { try { p?.send?.(txt); } catch {} }
      showToast("Pasted");
    }));
    menu.appendChild(mkItem("Find", async () => { openTermFind(); }));
    menu.appendChild(mkItem("Select All", async () => { try { t?.selectAll?.(); } catch {} }));
    menu.appendChild(mkItem("Clear", async () => { try { t?.clear?.(); } catch {} }));

    document.body.appendChild(menu);
    termContextMenu = menu;

    const onDoc = (ev) => {
      if (!menu.contains(ev.target)) hideTermContextMenu();
    };
    setTimeout(() => document.addEventListener("mousedown", onDoc, { once: true }), 0);
  }

  function installTerminalInteractionsForView(v) {
    if (!v?.term) return;
    v.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;

      const key = String(ev.key || "").toLowerCase();
      const mod = !!(ev.ctrlKey || ev.metaKey);

      // Cmd/Ctrl + ArrowLeft: Move to start of command line (like VSCode terminal)
      if (mod && key === "arrowleft") {
        ev.preventDefault();
        try {
          // Send Ctrl+A sequence (start of line)
          v.pty?.send?.("\x01");
        } catch {}
        return false;
      }

      // Cmd/Ctrl + ArrowRight: Move to end of command line (like VSCode terminal)
      if (mod && key === "arrowright") {
        ev.preventDefault();
        try {
          // Send Ctrl+E sequence (end of line)
          v.pty?.send?.("\x05");
        } catch {}
        return false;
      }

      // Option + ArrowLeft: Move cursor left by one word
      if (ev.altKey && key === "arrowleft") {
        ev.preventDefault();
        try {
          // Send Alt+B sequence (bash/readline word backward)
          v.pty?.send?.("\x1bb");
        } catch {}
        return false;
      }

      // Option + ArrowRight: Move cursor right by one word
      if (ev.altKey && key === "arrowright") {
        ev.preventDefault();
        try {
          // Send Alt+F sequence (bash/readline word forward)
          v.pty?.send?.("\x1bf");
        } catch {}
        return false;
      }

      // Cmd/Ctrl + Backspace: Delete word before cursor
      if (mod && key === "backspace") {
        ev.preventDefault();
        try {
          // Send Ctrl+W sequence (kill word backward)
          v.pty?.send?.("\x17");
        } catch {}
        return false;
      }

      // Cmd/Ctrl + Delete: Delete word after cursor
      if (mod && key === "delete") {
        ev.preventDefault();
        try {
          // Send Alt+D sequence (kill word forward)
          v.pty?.send?.("\x1bd");
        } catch {}
        return false;
      }

      // Cmd/Ctrl + A: Select all (xterm built-in)
      // Already handled by xterm.js, no need to override

      // Cmd/Ctrl + K: Clear from cursor to end of line
      if (mod && key === "k") {
        ev.preventDefault();
        try {
          // Send Ctrl+K sequence
          v.pty?.send?.("\x0b");
        } catch {}
        return false;
      }

      // Cmd/Ctrl + U: Clear from cursor to start of line
      if (mod && key === "u") {
        ev.preventDefault();
        try {
          // Send Ctrl+U sequence
          v.pty?.send?.("\x15");
        } catch {}
        return false;
      }

      // Cmd/Ctrl + L: Clear screen (keep command history)
      if (mod && key === "l") {
        ev.preventDefault();
        try {
          // Send Ctrl+L sequence (clear screen)
          v.pty?.send?.("\x0c");
        } catch {}
        return false;
      }

      // Cmd/Ctrl + Y: Restore (yank) previously deleted text
      if (mod && key === "y") {
        ev.preventDefault();
        try {
          v.pty?.send?.("\x19"); // Ctrl+Y
        } catch {}
        return false;
      }

      // Cmd/Ctrl + T: Transpose (swap) the last two characters
      if (mod && key === "t") {
        ev.preventDefault();
        try {
          v.pty?.send?.("\x14"); // Ctrl+T
        } catch {}
        return false;
      }

      // Home: Move cursor to start of line
      if (key === "home" && !mod) {
        ev.preventDefault();
        try {
          v.pty?.send?.("\x01"); // Ctrl+A
        } catch {}
        return false;
      }

      // End: Move cursor to end of line
      if (key === "end" && !mod) {
        ev.preventDefault();
        try {
          v.pty?.send?.("\x05"); // Ctrl+E
        } catch {}
        return false;
      }

      // Cmd/Ctrl + H: Delete character before cursor (same as Backspace)
      // Already handled by xterm.js

      // Cmd/Ctrl + D: Delete character at cursor or exit if empty
      // Already handled by xterm.js

      // Cmd/Ctrl + P: Previous command in history (same as Up arrow)
      if (mod && key === "p") {
        ev.preventDefault();
        try {
          v.pty?.send?.("\x1b[A");
        } catch {}
        return false;
      }

      // Cmd/Ctrl + N: Next command in history (same as Down arrow)
      if (mod && key === "n") {
        ev.preventDefault();
        try {
          v.pty?.send?.("\x1b[B");
        } catch {}
        return false;
      }

      // Cmd/Ctrl + R: Reverse search in history
      // Already handled by input area, but also useful in PTY mode
      if (mod && key === "r") {
        ev.preventDefault();
        try {
          v.pty?.send?.("\x12"); // Ctrl+R
        } catch {}
        return false;
      }

      // Cmd/Ctrl + Z: Suspend current process (background)
      // Let xterm handle this natively

      // Cmd/Ctrl + C: Copy or interrupt
      if (mod && key === "c" && !v.term?.hasSelection?.()) {
        // If no selection, let xterm handle Ctrl+C (interrupt signal)
        return true;
      }

      if (mod && key === "f") {
        ev.preventDefault();
        openTermFind();
        return false;
      }

      if (mod && (key === "c" || key === "x") && v.term?.hasSelection?.()) {
        ev.preventDefault();
        const sel = v.term?.getSelection?.() || "";
        setClipboardText(sel).then((ok) => showToast(ok ? "Copied" : "Copy failed"));
        return false;
      }

      if ((mod && key === "v") || (ev.shiftKey && ev.key === "Insert")) {
        ev.preventDefault();
        getClipboardText().then((txt) => {
          if (!txt) return;
          try { v.term?.paste?.(txt); } catch { try { v.pty?.send?.(txt); } catch {} }
          showToast("Pasted");
        });
        return false;
      }

      if (mod && ev.shiftKey && key === "c" && v.term?.hasSelection?.()) {
        ev.preventDefault();
        const sel = v.term?.getSelection?.() || "";
        setClipboardText(sel).then((ok) => showToast(ok ? "Copied" : "Copy failed"));
        return false;
      }

      if (mod && ev.shiftKey && key === "v") {
        ev.preventDefault();
        getClipboardText().then((txt) => {
          if (!txt) return;
          try { v.term?.paste?.(txt); } catch { try { v.pty?.send?.(txt); } catch {} }
          showToast("Pasted");
        });
        return false;
      }

      return true;
    });
  }

  function setPanelModeForActive(mode) {
    const v = getActiveView();
    const xtermReady = !!(xtermLoaded && v?.term);
    const resolvedMode = xtermReady ? String(mode || "pty") : "pre";

    if (v) v.usingPty = resolvedMode === "pty";

    const showXterm = xtermReady && resolvedMode === "pty";
    termWrap.style.display = showXterm ? "block" : "none";
    fallbackPre.style.display = showXterm ? "none" : "block";
    footer.style.display = showXterm ? "none" : "flex";

    updateStatusText();

    if (showXterm) {
      setTimeout(() => {
        try { fitActiveView(); } catch {}
      }, 0);
    }
  }

  termWrap.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openTermContextMenu(e.clientX, e.clientY);
  });
  termWrap.addEventListener("mousedown", () => {
    try { getActiveView()?.term?.focus?.(); } catch {}
  });

  /*
  const onTermWrapMouseMove = (e) => {
    // ...
  };
  */

  const onTermWrapMouseLeave = () => hideLinkTooltip();
  const onTermWrapWheel = () => hideLinkTooltip();
  const onTermWrapMouseDownForTip = () => hideLinkTooltip();

  // termWrap.addEventListener("mousemove", onTermWrapMouseMove);
  termWrap.addEventListener("mouseleave", onTermWrapMouseLeave);
  termWrap.addEventListener("wheel", onTermWrapWheel, { passive: true });
  termWrap.addEventListener("mousedown", onTermWrapMouseDownForTip);

  // const onGlobalKeyForLink = (e) => setModLinkActive(!!(e.metaKey || e.ctrlKey));
  // const onGlobalBlurForLink = () => setModLinkActive(false);
  /*
  try {
    window.addEventListener("keydown", onGlobalKeyForLink, true);
    window.addEventListener("keyup", onGlobalKeyForLink, true);
    window.addEventListener("blur", onGlobalBlurForLink, true);
  } catch {}
  */

  try {
    const RO = globalThis.ResizeObserver;
    termWrapResizeObserver = typeof RO === "function" ? new RO(() => fitActiveView()) : null;
    try { termWrapResizeObserver?.observe?.(termWrap); } catch {}
    window.addEventListener("resize", onWindowResize);
  } catch {}

  function updateStatusText() {
    // Status text removed as requested
  }

  function outputsToTextForSession(sessionId) {
    const outputs = window.zion?.state?.get("terminal.outputs") || [];
    const sid = String(sessionId || "").trim();
    if (!sid) return "无活动会话。请先创建或切换会话。";
    const items = Array.isArray(outputs) ? outputs.filter(r => r.sessionId === sid) : [];
    const lines = items.map(r => {
      const ok = r.success ? "0" : String(r.exitCode ?? -1);
      return `# ${new Date(r.timestamp).toLocaleString()} — $ ${r.command}\n${r.output}\n(exit=${ok}, ${r.duration}ms)\n`;
    });
    return lines.join("\n----------------------------------------\n");
  }

  function currentOutputsToText() {
    const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
    return outputsToTextForSession(sid);
  }

  async function connectPtyForSession(sessionId, opts = {}) {
    if (!api.connectPty) return false;
    const sid = String(sessionId || "").trim();
    if (!sid) return false;

    const background = !!opts.background;
    const desiredCwd = String(getSessionById(sid)?.cwd || "").trim();

    if (isInactiveSshSession(sid)) {
      if (!background) {
        const v = await ensureView(sid).catch(() => null);
        activeViewId = sid;
        activateView(sid);
        setPanelModeForActive("pty");
        writeTerminalNotice(v, "会话已失活，请点击标签上的“激活”重连");
        try { showToast("会话已失活，请点击“激活”重连", 1800); } catch {}
      }
      return false;
    }

    let v = null;
    try {
      v = await ensureView(sid);
    } catch {
      v = null;
    }
    if (!v) {
      if (!background) {
        setPanelModeForActive("pre");
      }
      return false;
    }

    if (!background) {
      activateView(sid);
      setPanelModeForActive("pty");
    }

    if (v.pty && v.pty.ws && v.pty.ws.readyState === WebSocket.OPEN) {
      v.ptyConnecting = false;
      try { clearTimeout(v.ptyRetryTimer); } catch {}
      v.ptyRetryTimer = 0;
      v.usingPty = true;
      try { clearTimeout(v.ptyStableTimer); } catch {}
      v.ptyStableTimer = setTimeout(() => {
        const vv = sessionViews.get(sid);
        if (!vv || vv !== v) return;
        if (vv.pty && vv.pty.ws && vv.pty.ws.readyState === WebSocket.OPEN) {
          vv.ptyRetryCount = 0;
          try { clearTimeout(vv.ptyRetryTimer); } catch {}
          vv.ptyRetryTimer = 0;
        }
      }, 900);
      if (!background) {
        try { v.term.focus(); } catch {}
        try { fitActiveView(); } catch {}
      }
      return true;
    }

    if (v.ptyConnecting) {
      v.usingPty = true;
      return true;
    }

    try {
      v.ptyConnecting = true;
      v.ptyInputBuffer = "";
      v.ptyConnectNonce += 1;
      const nonce = v.ptyConnectNonce;
      v.usingPty = true;
      try { clearTimeout(v.ptyStableTimer); } catch {}
      v.ptyStableTimer = 0;

      try { v.pty?.dispose?.(); } catch {}
      v.pty = null;

      const localPty = api.connectPty(sid, v.term.cols, v.term.rows);
      v.pty = localPty;
      localPty.onData((chunk) => {
        try { v.term.write(chunk); } catch {}
      });

      const onBroken = () => {
        if (nonce !== v.ptyConnectNonce) return;
        if (v.pty !== localPty) return;
        try { clearTimeout(v.ptyStableTimer); } catch {}
        v.ptyStableTimer = 0;
        try { localPty?.dispose?.(); } catch {}
        v.pty = null;
        v.ptyConnecting = false;
        v.usingPty = true;
        const isActive = normId(activeViewId || currentSessionId || "") === sid;
        if (!background && isActive) {
          setPanelModeForActive("pty");
          const now = Date.now();
          const last = ptyNoticeAt.get(sid) || 0;
          if (now - last > 1200) {
            ptyNoticeAt.set(sid, now);
            writeTerminalNotice(v, "PTY 连接断开，正在重连…");
            try { showToast("PTY 连接断开，正在重连…", 1200); } catch {}
          }
        }
        if (isActive) schedulePtyReconnect(sid);
      };

      localPty.onError(onBroken);
      localPty.onClose(onBroken);

      let readyTimer = 0;
      const readyTimeout = new Promise((_, rej) => {
        readyTimer = setTimeout(() => rej(new Error("PTY ready timeout")), 12000);
      });
      await Promise.race([localPty.ready, readyTimeout]);
      try { clearTimeout(readyTimer); } catch {}

      if (nonce !== v.ptyConnectNonce || v.pty !== localPty) {
        try { localPty?.dispose?.(); } catch {}
        if (v.pty === localPty) v.pty = null;
        v.ptyConnecting = false;
        return false;
      }

      v.ptyConnecting = false;
      try { clearTimeout(v.ptyStableTimer); } catch {}
      v.ptyStableTimer = setTimeout(() => {
        const vv = sessionViews.get(sid);
        if (!vv || vv.pty !== localPty) return;
        if (vv.pty && vv.pty.ws && vv.pty.ws.readyState === WebSocket.OPEN) {
          vv.ptyRetryCount = 0;
          try { clearTimeout(vv.ptyRetryTimer); } catch {}
          vv.ptyRetryTimer = 0;
        }
      }, 900);

      setTimeout(() => {
        try {
          localPty.send('export TERM=xterm-256color\r');
          localPty.send('export COLORTERM=truecolor\r');
          localPty.send('alias ls="ls --color=auto"\r');
        } catch {}
      }, 100);
      setTimeout(() => {
        try {
          localPty.send('export CLICOLOR=1\r');
          localPty.send('export FORCE_COLOR=1\r');
          localPty.send('ls --color=auto >/dev/null 2>&1 && alias ls="ls --color=auto" || alias ls="ls -G"\r');
          if (desiredCwd) {
            localPty.send(`cd -- ${shellSingleQuote(desiredCwd)}\r`);
          }
        } catch {}
      }, 120);

      if (v.ptyInputBuffer) {
        try { localPty.send(v.ptyInputBuffer); } catch {}
        v.ptyInputBuffer = "";
      }

      if (!background && activeViewId === sid) {
        try { v.term.focus(); } catch {}
        try { fitActiveView(); } catch {}
      }
      return true;
    } catch {
      try { v.pty?.dispose?.(); } catch {}
      v.pty = null;
      v.ptyConnecting = false;
      v.usingPty = true;
      try { clearTimeout(v.ptyStableTimer); } catch {}
      v.ptyStableTimer = 0;
      const isActive = normId(activeViewId || currentSessionId || "") === sid;
      if (!background && isActive) {
        setPanelModeForActive("pty");
        writeTerminalNotice(v, "PTY 连接失败，正在重试…");
        try { showToast("PTY 连接失败，正在重试…", 1200); } catch {}
      }
      if (isActive) schedulePtyReconnect(sid);
      return false;
    }
  }

  // Build tabs from sessions
  function renderTabs() {
    const sessions = window.zion?.state?.get("terminal.sessions") || [];
    const sessionList = Array.isArray(sessions) ? sessions : [];
    const existingIds = new Set(sessionList.map(s => String(s?.id || "").trim()).filter(Boolean));
    for (const sid of Array.from(sessionViews.keys())) {
      if (!existingIds.has(sid)) disposeView(sid);
    }
    if (sessionList.length) {
      const stateActive = String(window.zion?.state?.get("terminal.activeSessionId") || "").trim();
      const hasStateActive = stateActive && existingIds.has(stateActive);
      const hasCurrent = currentSessionId && existingIds.has(currentSessionId);
      const nextActive = hasStateActive ? stateActive : (hasCurrent ? currentSessionId : String(sessionList.find(s => String(s?.id || "").trim())?.id || "").trim());
      if (nextActive && nextActive !== currentSessionId) {
        currentSessionId = nextActive;
        activeViewId = nextActive;
        try {
          if (String(window.zion?.state?.get("terminal.activeSessionId") || "").trim() !== nextActive) {
            window.zion?.state?.set("terminal.activeSessionId", nextActive);
          }
        } catch {}
      }
      if (!nextActive) {
        currentSessionId = null;
        activeViewId = null;
        try { window.zion?.state?.set("terminal.activeSessionId", null); } catch {}
      }
    } else {
      currentSessionId = null;
      activeViewId = null;
      try { window.zion?.state?.set("terminal.activeSessionId", null); } catch {}
    }
    tabsScroll.innerHTML = "";
    if (!sessionList.length) {
      const empty = document.createElement("div");
      empty.textContent = t("panel.noSessionsHint", "No sessions (use Terminal Manager to create)");
      empty.style.fontSize = "11px";
      empty.style.opacity = "0.75";
      tabsScroll.appendChild(empty);
      updateStatusText();
      updateTabsNavState();
      return;
    }
    sessionList.forEach((s) => {
      const id = String(s?.id || "").trim();
      if (!id) return;
      const tab = document.createElement("div");
      const isActive = currentSessionId === id;
      const isSsh = (s?.type || "local") === "ssh";
      const isInactive = isSsh && s?.active === false;
      tab.className = `zte-tab${isActive ? " is-active" : ""}${isInactive ? " is-inactive" : ""}`;

      const label = document.createElement("div");
      label.textContent = getTabLabelForSession(s);
      label.className = "zte-tab-label";

      const xbtn = document.createElement("button");
      xbtn.type = "button";
      xbtn.textContent = "×";
      xbtn.className = "zte-tab-close";
      xbtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await window.zion?.commands?.executeCommand?.("terminal.closeSession", { session_id: id });
        } catch {}
      };

      // Add reactivate button for inactive SSH sessions
      if (isSsh && isInactive) {
        const reactivateBtn = document.createElement("button");
        reactivateBtn.type = "button";
        reactivateBtn.textContent = t("panel.reactivate", "激活");
        reactivateBtn.className = "zte-tab-activate";
        reactivateBtn.title = t("panel.reactivateSsh", "激活 SSH 会话");
        reactivateBtn.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            reactivateBtn.disabled = true;
            reactivateBtn.textContent = t("panel.reactivating", "激活中");
            const result = await reactivateSessionOnce(id);
            if (result) {
              // Refresh sessions list and reconnect
              await refreshSessionsOnce();
              renderTabs();
              // Try to connect to the reactivated session
              if (id === currentSessionId) {
                const ok = await connectPtyForSession(id);
                if (!ok) {
                  if (xtermLoaded) {
                    activateView(id);
                    setPanelModeForActive("pty");
                    writeTerminalNotice(getActiveView(), t("panel.ptyReconnectTriggered", "PTY 未连接，已触发重连"));
                  } else {
                    fallbackPre.textContent = currentOutputsToText();
                  }
                }
              }
            }
          } catch (err) {
            console.error("Failed to reactivate session:", err);
            alert(t("panel.reactivateFailed", "Failed to reactivate session: {message}", { message: err?.message || String(err) }));
          } finally {
            reactivateBtn.disabled = false;
            renderTabs();
          }
        };
        tab.appendChild(reactivateBtn);
      }

      tab.onclick = () => {
        switchToSession(id);
        scheduleConnectSelectedSession(id);
      };

      tab.appendChild(label);
      tab.appendChild(xbtn);
      tabsScroll.appendChild(tab);
    });

    // Scroll active tab into view immediately
    const activeTabElement = tabsScroll.querySelector('.zte-tab.is-active');
    if (activeTabElement) {
      requestAnimationFrame(() => {
        try {
          activeTabElement.scrollIntoView({
            behavior: 'auto',
            block: 'nearest',
            inline: 'nearest'
          });
        } catch (e) {
          // Fallback: manual scroll calculation if scrollIntoView fails
          try {
            const scrollLeft = tabsScroll.scrollLeft;
            const clientWidth = tabsScroll.clientWidth;
            const tabLeft = activeTabElement.offsetLeft;
            const tabRight = tabLeft + activeTabElement.offsetWidth;

            // If tab is not fully visible, scroll it into view
            if (tabLeft < scrollLeft) {
              tabsScroll.scrollTo({ left: tabLeft - 8, behavior: 'auto' });
            } else if (tabRight > scrollLeft + clientWidth) {
              // Center the tab in the visible area
              const targetLeft = tabLeft - (clientWidth - activeTabElement.offsetWidth) / 2;
              tabsScroll.scrollTo({ left: targetLeft, behavior: 'auto' });
            }
          } catch (e2) {
            // Ignore scroll errors
          }
        }
      });
    }

    updateTabsNavState();
    updateStatusText();
  }

  // Fallback render outputs
  function renderFallbackOutputs() {
    const text = currentOutputsToText();
    if (!text) {
      if (!xtermLoaded) {
        fallbackPre.textContent = t("panel.loadingComponents", "正在加载终端组件...");
      } else {
        fallbackPre.textContent = t("panel.ready", "终端已就绪。输入命令以开始。");
      }
    } else {
      fallbackPre.textContent = text;
    }
    fallbackPre.scrollTop = fallbackPre.scrollHeight;
  }

  async function runCommandFromInput() {
    const cmd = cmdInput.value.trim();
    if (!cmd) return;
    const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
    if (!sid) {
      alert(t("panel.noActiveSessionCreate", "没有活动会话，请先创建或切换会话"));
      return;
    }
    cmdInput.disabled = true;
    try {
      await sendCommandToSessionPty(sid, cmd);
      cmdInput.value = "";
    } finally {
      cmdInput.disabled = false;
      cmdInput.focus();
    }
  }
  let suggestItems = [];
  let suggestIndex = 0;
  let suggestOpen = false;
  let suggestReqId = 0;
  let suggestTimer = 0;

  function hideSuggest() {
    suggestOpen = false;
    suggestItems = [];
    suggestIndex = 0;
    suggestBox.style.display = "none";
    suggestBox.innerHTML = "";
  }

  function renderSuggest() {
    if (!suggestItems.length) {
      hideSuggest();
      return;
    }
    suggestOpen = true;
    suggestBox.style.display = "block";
    suggestBox.innerHTML = "";

    const max = Math.min(suggestItems.length, 10);
    for (let i = 0; i < max; i++) {
      const it = suggestItems[i];
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "10px",
        padding: "6px 8px",
        cursor: "pointer",
        background: i === suggestIndex ? "rgba(255,255,255,0.08)" : "transparent"
      });
      const left = document.createElement("div");
      left.textContent = it.label;
      Object.assign(left.style, { fontFamily: "var(--font-mono)", fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
      const right = document.createElement("div");
      right.textContent = it.detail || "";
      Object.assign(right.style, { fontSize: "11px", opacity: "0.75", whiteSpace: "nowrap" });
      row.appendChild(left);
      row.appendChild(right);
      row.onmouseenter = () => {
        suggestIndex = i;
        renderSuggest();
      };
      row.onclick = () => {
        applySuggestion(it);
      };
      suggestBox.appendChild(row);
    }
  }

  function applySuggestion(it) {
    if (!it) return;
    cmdInput.value = String(it.insertText || it.label || "");
    hideSuggest();
    cmdInput.focus();
    try {
      cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length);
    } catch {}
  }

  function readBaseUrl() {
    const st1 = window.zion?.state?.get("localTools.baseUrl");
    if (typeof st1 === "string" && st1.trim()) return st1.trim();
    try {
      const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
      if (s) return s.trim();
    } catch {}
    return "http://127.0.0.1:8765";
  }

  async function readFileRaw(path, sessionId) {
    const base = readBaseUrl().replace(/\/$/, "");
    let url = `${base}/files/read?path=${encodeURIComponent(String(path || ""))}&offset=1&limit=5000`;
    if (sessionId) url += `&session_id=${encodeURIComponent(String(sessionId))}`;
    const res = await fetch(url, { method: "GET" });
    const data = await res.json().catch(() => null);
    const content = typeof data?.content === "string" ? data.content : "";
    const lines = String(content).replace(/\r/g, "").split("\n");
    const cleaned = lines.map(l => l.replace(/^\s*\d+\s*(\||→)\s?/, ""));
    return cleaned.join("\n");
  }

  async function glob(pattern, path, sessionId) {
    const base = readBaseUrl().replace(/\/$/, "");
    let url = `${base}/files/glob?pattern=${encodeURIComponent(String(pattern || ""))}`;
    if (path) url += `&path=${encodeURIComponent(String(path))}`;
    if (sessionId) url += `&session_id=${encodeURIComponent(String(sessionId))}`;
    const res = await fetch(url, { method: "GET" });
    const data = await res.json().catch(() => null);
    const results = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
    return results;
  }

  function getSessionInfo(sessionId) {
    const sessions = window.zion?.state?.get("terminal.sessions") || [];
    const list = Array.isArray(sessions) ? sessions : [];
    const s = list.find(x => String(x?.id || "").trim() === String(sessionId || "").trim());
    return s || null;
  }

  const projectCache = new Map();
  async function getProjectInfo(sessionId) {
    const sid = String(sessionId || "").trim();
    if (!sid) return { scripts: [], makeTargets: [], hasDockerCompose: false };
    const now = Date.now();
    const cached = projectCache.get(sid);
    if (cached && now - cached.ts < 15000) return cached.data;
    const s = getSessionInfo(sid);
    const cwd = String(s?.cwd || "").trim();
    const data = { scripts: [], makeTargets: [], hasDockerCompose: false };
    if (!cwd) {
      projectCache.set(sid, { ts: now, data });
      return data;
    }
    try {
      const pkgRaw = await readFileRaw(`${cwd.replace(/\/$/, "")}/package.json`, sid).catch(() => "");
      if (pkgRaw) {
        const pkg = JSON.parse(pkgRaw);
        const scripts = pkg && typeof pkg === "object" ? (pkg.scripts || {}) : {};
        const keys = scripts && typeof scripts === "object" ? Object.keys(scripts) : [];
        data.scripts = keys.filter(Boolean).slice(0, 80);
      }
    } catch {}
    try {
      const mk = await readFileRaw(`${cwd.replace(/\/$/, "")}/Makefile`, sid).catch(() => "");
      if (mk) {
        const targets = new Set();
        mk.replace(/\r/g, "").split("\n").forEach((ln) => {
          const s1 = ln.trimEnd();
          if (!s1 || s1.startsWith("#") || s1.startsWith(".")) return;
          if (/^\s/.test(ln)) return;
          const m = s1.match(/^([A-Za-z0-9_\-\.]+)\s*:/);
          if (m && m[1] && !m[1].includes("%")) targets.add(m[1]);
        });
        data.makeTargets = Array.from(targets).slice(0, 80);
      }
    } catch {}
    try {
      const g = await glob("docker-compose*.yml", cwd, sid).catch(() => []);
      data.hasDockerCompose = Array.isArray(g) && g.length > 0;
    } catch {}
    projectCache.set(sid, { ts: now, data });
    return data;
  }

  function uniqByInsert(items) {
    const seen = new Set();
    const out = [];
    items.forEach((it) => {
      const k = String(it.insertText || it.label || "");
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(it);
    });
    return out;
  }

  function scoreMatch(q, text) {
    const a = String(q || "").toLowerCase();
    const b = String(text || "").toLowerCase();
    if (!a) return 0;
    if (b === a) return 100;
    if (b.startsWith(a)) return 70;
    const idx = b.indexOf(a);
    if (idx >= 0) return 40 - Math.min(idx, 20);
    return -1;
  }

  async function buildSuggestions(query) {
    const q = String(query || "").trim();
    const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || "";
    const history = window.zion?.state?.get("terminal.history") || [];
    const histList = Array.isArray(history) ? history : [];
    const freq = new Map();
    histList.forEach((r) => {
      const c = String(r?.command || "").trim();
      if (!c) return;
      freq.set(c, (freq.get(c) || 0) + 1);
    });

    const items = [];
    const qc = window.zion?.state?.get("terminal.quickCommands") || {};
    Object.entries(qc).forEach(([name, cmd]) => {
      const label = String(cmd || "");
      const s1 = Math.max(scoreMatch(q, name), scoreMatch(q, label));
      if (q && s1 < 0) return;
      items.push({ label, insertText: label, detail: `quick:${name}`, score: (s1 < 0 ? 0 : s1) + 30 });
    });

    const seenCmd = new Set();
    histList
      .slice()
      .reverse()
      .forEach((r) => {
        const cmd = String(r?.command || "").trim();
        if (!cmd || seenCmd.has(cmd)) return;
        seenCmd.add(cmd);
        const s1 = q ? scoreMatch(q, cmd) : 0;
        if (q && s1 < 0) return;
        const w = Number(freq.get(cmd) || 1);
        const per = sid && String(r?.sessionId || "") === String(sid) ? 20 : 0;
        items.push({ label: cmd, insertText: cmd, detail: `history ×${w}`, score: (s1 < 0 ? 0 : s1) + per + Math.min(w, 20) });
      });

    const proj = await getProjectInfo(sid);
    if (proj?.scripts?.length) {
      proj.scripts.forEach((sc) => {
        const cmd = `npm run ${sc}`;
        const s1 = q ? scoreMatch(q, cmd) : 0;
        if (q && s1 < 0) return;
        items.push({ label: cmd, insertText: cmd, detail: "package.json", score: (s1 < 0 ? 0 : s1) + 15 });
      });
    }
    if (proj?.makeTargets?.length) {
      proj.makeTargets.forEach((t) => {
        const cmd = `make ${t}`;
        const s1 = q ? scoreMatch(q, cmd) : 0;
        if (q && s1 < 0) return;
        items.push({ label: cmd, insertText: cmd, detail: "Makefile", score: (s1 < 0 ? 0 : s1) + 10 });
      });
    }
    if (proj?.hasDockerCompose) {
      ["docker compose up", "docker compose down", "docker compose ps", "docker compose logs -f"].forEach((cmd) => {
        const s1 = q ? scoreMatch(q, cmd) : 0;
        if (q && s1 < 0) return;
        items.push({ label: cmd, insertText: cmd, detail: "docker-compose", score: (s1 < 0 ? 0 : s1) + 8 });
      });
    }

    const sorted = uniqByInsert(items)
      .sort((a, b) => (Number(b.score || 0) - Number(a.score || 0)));
    return sorted.slice(0, 50);
  }

  async function refreshSuggest() {
    const q = cmdInput.value;
    const id = ++suggestReqId;
    const list = await buildSuggestions(q).catch(() => []);
    if (id !== suggestReqId) return;
    suggestItems = Array.isArray(list) ? list : [];
    suggestIndex = 0;
    renderSuggest();
  }

  function scheduleSuggest() {
    try { clearTimeout(suggestTimer); } catch {}
    suggestTimer = setTimeout(() => {
      refreshSuggest();
    }, 120);
  }

  function getHistoryCommandsForNav() {
    const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || "";
    const history = window.zion?.state?.get("terminal.history") || [];
    const list = Array.isArray(history) ? history : [];
    const seen = new Set();
    const out = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      const cmd = String(r?.command || "").trim();
      if (!cmd) continue;
      if (sid && String(r?.sessionId || "") !== String(sid)) continue;
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      out.push(cmd);
      if (out.length >= 200) break;
    }
    return out;
  }

  let histNav = { list: [], idx: -1, base: "" };
  function resetHistNav() {
    histNav = { list: getHistoryCommandsForNav(), idx: -1, base: cmdInput.value };
  }

  cmdInput.addEventListener("focus", () => resetHistNav());
  cmdInput.addEventListener("input", () => {
    resetHistNav();
    scheduleSuggest();
  });

  cmdInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (suggestOpen) {
        e.preventDefault();
        hideSuggest();
        return;
      }
      e.preventDefault();
      close();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
      e.preventDefault();
      openHistoryPalette();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === " ") {
      e.preventDefault();
      refreshSuggest();
      return;
    }
    if (suggestOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      if (e.key === "ArrowDown") {
        suggestIndex = Math.min(suggestIndex + 1, Math.min(suggestItems.length, 10) - 1);
      } else {
        suggestIndex = Math.max(suggestIndex - 1, 0);
      }
      renderSuggest();
      return;
    }
    if (suggestOpen && e.key === "Tab") {
      e.preventDefault();
      applySuggestion(suggestItems[suggestIndex]);
      return;
    }
    if (!suggestOpen && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (!histNav.list.length) return;
      e.preventDefault();
      if (e.key === "ArrowUp") {
        histNav.idx = Math.min(histNav.idx + 1, histNav.list.length - 1);
        cmdInput.value = histNav.list[histNav.idx] || "";
      } else {
        histNav.idx = Math.max(histNav.idx - 1, -1);
        cmdInput.value = histNav.idx === -1 ? histNav.base : (histNav.list[histNav.idx] || "");
      }
      try { cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length); } catch {}
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      hideSuggest();
      runCommandFromInput();
      return;
    }
  });

  newBtn.onclick = async () => {
    try {
      const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
      const sessions = window.zion?.state?.get("terminal.sessions") || [];
      const list = Array.isArray(sessions) ? sessions : [];
      const s = sid ? list.find(x => String(x?.id || "").trim() === String(sid || "").trim()) : null;
      const initial_cwd = typeof s?.cwd === "string" && s.cwd.trim() ? s.cwd.trim() : undefined;
      await window.zion?.commands?.executeCommand?.("terminal.createSession", { type: "local", initial_cwd });
    } catch {}
  };

  dockBtn.onclick = () => {
    setDockMode(dockMode === "right" ? "bottom" : "right", true);
  };

  closeBtn.onclick = () => close();

  // 标签页滚动导航事件
  function updateTabsNavState() {
    if (!tabsScroll) return;
    const canScrollLeft = tabsScroll.scrollLeft > 0;
    const canScrollRight = tabsScroll.scrollLeft < (tabsScroll.scrollWidth - tabsScroll.clientWidth - 1);
    if (tabNavLeft) tabNavLeft.disabled = !canScrollLeft;
    if (tabNavRight) tabNavRight.disabled = !canScrollRight;
  }

  tabNavLeft.onclick = () => {
    if (!tabsScroll) return;
    tabsScroll.scrollBy({ left: -200, behavior: "smooth" });
  };

  tabNavRight.onclick = () => {
    if (!tabsScroll) return;
    tabsScroll.scrollBy({ left: 200, behavior: "smooth" });
  };

  tabsScroll.addEventListener("scroll", () => {
    updateTabsNavState();
  });

  // 标签页下拉菜单
  tabDropdownBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();

    // 动态计算菜单位置
    const rect = tabDropdownBtn.getBoundingClientRect();
    const menuWidth = 280; // 估算的菜单宽度
    const menuHeight = 300; // 最大高度

    // 默认位置：按钮下方，右侧对齐
    let top = rect.bottom + 4;
    let left = rect.right - menuWidth;

    // 如果右边超出屏幕，则左对齐
    if (left + menuWidth > window.innerWidth) {
      left = rect.left;
    }

    // 如果下方超出屏幕，则显示在按钮上方
    if (top + menuHeight > window.innerHeight) {
      top = rect.top - menuHeight - 4;
    }

    tabsMenu.style.top = `${top}px`;
    tabsMenu.style.left = `${left}px`;
    tabsMenu.style.right = "auto";

    tabsMenu.classList.toggle("show");
    renderTabsMenu();
  };

  function hideTabsMenu() {
    tabsMenu.classList.remove("show");
  }

  document.addEventListener("mousedown", (e) => {
    // 如果点击不在下拉按钮和菜单内部，则隐藏菜单
    if (!tabsDropdown.contains(e.target) && !tabsMenu.contains(e.target)) {
      hideTabsMenu();
    }
  });

  function renderTabsMenu() {
    const sessions = window.zion?.state?.get("terminal.sessions") || [];
    const sessionList = Array.isArray(sessions) ? sessions : [];
    tabsMenu.innerHTML = "";

    if (!sessionList.length) {
      const empty = document.createElement("div");
      empty.textContent = t("ui.noSessions", "No sessions");
      empty.style.padding = "8px";
      empty.style.fontSize = "11px";
      empty.style.opacity = "0.75";
      tabsMenu.appendChild(empty);
      return;
    }

    sessionList.forEach((s) => {
      const id = String(s?.id || "").trim();
      if (!id) return;
      const isActive = currentSessionId === id;
      const item = document.createElement("div");
      item.className = `zte-tabs-menu-item${isActive ? " is-active" : ""}`;

      const label = document.createElement("div");
      label.className = "zte-tabs-menu-item-label";
      label.textContent = getTabLabelForSession(s);

      const actions = document.createElement("div");
      actions.className = "zte-tabs-menu-item-actions";

      const closeBtn2 = document.createElement("button");
      closeBtn2.type = "button";
      closeBtn2.className = "zte-tabs-menu-item-close";
      closeBtn2.textContent = "×";
      closeBtn2.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await window.zion?.commands?.executeCommand?.("terminal.closeSession", { session_id: id });
          renderTabsMenu();
        } catch {}
      };

      actions.appendChild(closeBtn2);
      item.appendChild(label);
      item.appendChild(actions);

      item.onclick = () => {
        hideTabsMenu();
        switchToSession(id);
        scheduleConnectSelectedSession(id);
      };

      tabsMenu.appendChild(item);
    });
  }

  function openHistoryPalette() {
    const history = window.zion?.state?.get("terminal.history") || [];
    const list = Array.isArray(history) ? history.slice() : [];
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0,0,0,0.35)",
      zIndex: "960"
    });
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      left: "50%",
      top: "18%",
      transform: "translateX(-50%)",
      width: "720px",
      maxHeight: "60vh",
      overflow: "hidden",
      background: "var(--panel)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
      display: "grid",
      gridTemplateRows: "auto 1fr",
      boxSizing: "border-box",
      fontFamily: "var(--font-sans)"
    });

    const head = document.createElement("div");
    Object.assign(head.style, { padding: "8px", borderBottom: "1px solid var(--border)", display: "flex", gap: "8px", alignItems: "center" });
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = t("panel.historyPlaceholder", "搜索历史命令...");
    Object.assign(input.style, {
      flex: "1",
      boxSizing: "border-box",
      border: "1px solid var(--border)",
      borderRadius: "4px",
      background: "var(--panel)",
      color: "var(--fg)",
      outline: "none",
      padding: "6px 8px",
      fontSize: "12px",
      fontFamily: "var(--font-mono)"
    });
    const cbtn = document.createElement("button");
    cbtn.type = "button";
    cbtn.textContent = t("panel.close", "Close");
    Object.assign(cbtn.style, {
      border: "1px solid var(--border)",
      borderRadius: "4px",
      background: "transparent",
      color: "var(--fg)",
      padding: "6px 10px",
      fontSize: "12px",
      cursor: "pointer"
    });
    cbtn.onclick = () => overlay.remove();
    head.appendChild(input);
    head.appendChild(cbtn);

    const body = document.createElement("div");
    Object.assign(body.style, { overflow: "auto" });

    let rows = [];
    let sel = 0;

    function render() {
      const q = String(input.value || "").trim().toLowerCase();
      const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || "";
      rows = list
        .slice()
        .reverse()
        .filter((r) => {
          const cmd = String(r?.command || "");
          if (!cmd) return false;
          if (sid && String(r?.sessionId || "") !== String(sid)) return false;
          if (!q) return true;
          return cmd.toLowerCase().includes(q);
        })
        .slice(0, 200);
      sel = Math.min(sel, Math.max(rows.length - 1, 0));
      body.innerHTML = "";
      rows.forEach((r, idx) => {
        const row = document.createElement("div");
        row.className = "zte-palette-row";
        Object.assign(row.style, {
          padding: "8px",
          borderBottom: "1px solid var(--border)",
          cursor: "pointer",
          background: idx === sel ? "rgba(127,127,127,0.18)" : "transparent"
        });
        const t = new Date(Number(r?.timestamp || Date.now())).toLocaleString();
        const meta = document.createElement("div");
        meta.textContent = `${t}  (${String(r?.sessionId || "").trim() || "-"})`;
        Object.assign(meta.style, { fontSize: "11px", opacity: "0.75", marginBottom: "4px" });
        const cmd = document.createElement("div");
        cmd.textContent = String(r?.command || "");
        Object.assign(cmd.style, { fontFamily: "var(--font-mono)", fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
        row.appendChild(meta);
        row.appendChild(cmd);
        row.onmouseenter = () => { sel = idx; render(); };
        row.onclick = () => {
          overlay.remove();
          cmdInput.value = String(r?.command || "");
          cmdInput.focus();
          try { cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length); } catch {}
          scheduleSuggest();
        };
        body.appendChild(row);
      });
    }

    input.addEventListener("input", () => render());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        overlay.remove();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        sel = Math.min(sel + 1, Math.max(rows.length - 1, 0));
        render();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        sel = Math.max(sel - 1, 0);
        render();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const r = rows[sel];
        if (!r) return;
        overlay.remove();
        cmdInput.value = String(r?.command || "");
        cmdInput.focus();
        try { cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length); } catch {}
        scheduleSuggest();
      }
    });

    box.appendChild(head);
    box.appendChild(body);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    render();
    setTimeout(() => input.focus(), 0);
  }

  function openQuickPalette() {
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0,0,0,0.35)",
      zIndex: "960"
    });
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      left: "50%",
      top: "18%",
      transform: "translateX(-50%)",
      width: "720px",
      maxHeight: "60vh",
      overflow: "hidden",
      background: "var(--panel)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
      display: "grid",
      gridTemplateRows: "auto 1fr",
      boxSizing: "border-box",
      fontFamily: "var(--font-sans)"
    });

    const head = document.createElement("div");
    Object.assign(head.style, { padding: "8px", borderBottom: "1px solid var(--border)", display: "flex", gap: "8px", alignItems: "center" });
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = t("panel.quickPlaceholder", "搜索并执行命令...");
    Object.assign(input.style, {
      flex: "1",
      boxSizing: "border-box",
      border: "1px solid var(--border)",
      borderRadius: "4px",
      background: "var(--panel)",
      color: "var(--fg)",
      outline: "none",
      padding: "6px 8px",
      fontSize: "12px",
      fontFamily: "var(--font-mono)"
    });
    const cbtn = document.createElement("button");
    cbtn.type = "button";
    cbtn.textContent = t("panel.close", "Close");
    Object.assign(cbtn.style, {
      border: "1px solid var(--border)",
      borderRadius: "4px",
      background: "transparent",
      color: "var(--fg)",
      padding: "6px 10px",
      fontSize: "12px",
      cursor: "pointer"
    });
    cbtn.onclick = () => overlay.remove();
    head.appendChild(input);
    head.appendChild(cbtn);

    const body = document.createElement("div");
    Object.assign(body.style, { overflow: "auto" });

    let rows = [];
    let sel = 0;
    let rid = 0;
    let timer = 0;

    function paint() {
      sel = Math.min(sel, Math.max(rows.length - 1, 0));
      body.innerHTML = "";
      rows.forEach((it, idx) => {
        const row = document.createElement("div");
        row.className = "zte-palette-row";
        Object.assign(row.style, {
          padding: "8px",
          borderBottom: "1px solid var(--border)",
          cursor: "pointer",
          background: idx === sel ? "rgba(127,127,127,0.18)" : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px"
        });
        const left = document.createElement("div");
        left.textContent = String(it.label || "");
        Object.assign(left.style, { fontFamily: "var(--font-mono)", fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
        const right = document.createElement("div");
        right.textContent = String(it.detail || "");
        Object.assign(right.style, { fontSize: "11px", opacity: "0.75", whiteSpace: "nowrap" });
        row.appendChild(left);
        row.appendChild(right);
        row.onmouseenter = () => { sel = idx; paint(); };
        row.onclick = async () => {
          const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
          if (!sid) { alert(t("panel.noActiveSession", "没有活动会话")); return; }
          const cmd = String(it.insertText || it.label || "");
          if (!cmd.trim()) return;
          overlay.remove();
          hideSuggest();
          cmdInput.value = "";
          await sendCommandToSessionPty(sid, cmd);
          cmdInput.focus();
        };
        body.appendChild(row);
      });
    }

    async function update() {
      const id = ++rid;
      const q = String(input.value || "");
      const next = await buildSuggestions(q).catch(() => []);
      if (id !== rid) return;
      rows = Array.isArray(next) ? next.slice(0, 200) : [];
      paint();
    }

    function scheduleUpdate() {
      try { clearTimeout(timer); } catch {}
      timer = setTimeout(() => update(), 120);
    }

    input.addEventListener("input", () => { scheduleUpdate(); });
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        overlay.remove();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        sel = Math.min(sel + 1, Math.max(rows.length - 1, 0));
        paint();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        sel = Math.max(sel - 1, 0);
        paint();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const it = rows[sel];
        if (!it) return;
        const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
        if (!sid) { alert(t("panel.noActiveSession", "没有活动会话")); return; }
        const cmd = String(it.insertText || it.label || "");
        if (!cmd.trim()) return;
        overlay.remove();
        hideSuggest();
        cmdInput.value = "";
        await sendCommandToSessionPty(sid, cmd);
        cmdInput.focus();
      }
    });

    box.appendChild(head);
    box.appendChild(body);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    update();
    setTimeout(() => input.focus(), 0);
  }

  // Wiring state changes
  const disp1 = window.zion.state.onDidChange("terminal.sessions", () => { renderTabs(); });
  const disp2 = window.zion.state.onDidChange("terminal.activeSessionId", async (nv) => {
    const nextRaw = String(nv || "").trim();
    if (nextRaw) {
      currentSessionId = nextRaw;
      activeViewId = nextRaw;
    } else {
      const sessions = window.zion?.state?.get("terminal.sessions") || [];
      const list = Array.isArray(sessions) ? sessions : [];
      const first = String(list.find(s => String(s?.id || "").trim())?.id || "").trim();
      currentSessionId = first || null;
      activeViewId = currentSessionId;
      if (currentSessionId) {
        try { window.zion?.state?.set("terminal.activeSessionId", currentSessionId); } catch {}
      }
    }
    renderTabs();
    if (root.style.display === "none") return;
    if (currentSessionId) {
      scheduleConnectSelectedSession(currentSessionId);
    }
  });
  const disp3 = window.zion.state.onDidChange("terminal.outputs", () => { if (!isActiveUsingPty()) renderFallbackOutputs(); });
  const disp4 = window.zion.events.on("terminal/commandExecuted", () => { if (!isActiveUsingPty()) renderFallbackOutputs(); });
  const disp5 = window.zion.events.on("i18n/changed", refreshI18n);
  const disp6 = embedTabsInBottomHeader ? window.zion.state.onDidChange("ui.bottomPanel.activeViewId", syncHostHeaderTabsVisibility) : null;
  const disp7 = embedTabsInBottomHeader ? window.zion.state.onDidChange("ui.bottomPanel.visible", syncHostHeaderTabsVisibility) : null;

  async function open(opts = {}) {
    // 先显示 root，确保 DOM 准备好
    const wasVisible = embedded ? true : root.style.display === "block";
    if (!embedded) {
      root.style.display = "block";
      try { root.offsetHeight; } catch {} // Force reflow
      try { applyDocking(root); } catch {}
    }
    try { if (xtermLoaded && getActiveView()?.term) fitActiveView(true); } catch {}

    const av = getActiveView();
    if (wasVisible && av?.pty?.ws?.readyState === WebSocket.OPEN) {
      try { fitActiveView(true); } catch {}
      if (opts.openQuick) {
        setTimeout(() => openQuickPalette(), 0);
      } else if (opts.openHistory) {
        setTimeout(() => openHistoryPalette(), 0);
      } else {
        setTimeout(() => {
          try { getActiveView()?.term?.focus?.(); } catch {}
        }, 0);
      }
      return;
    }

    try {
      const sessions0 = window.zion?.state?.get("terminal.sessions") || [];
      const list0 = Array.isArray(sessions0) ? sessions0 : [];
      if (!list0.length) {
        await window.zion?.commands?.executeCommand?.("terminal.refreshSessions");
      }
    } catch {}

    try {
      const sessions1 = window.zion?.state?.get("terminal.sessions") || [];
      const list1 = Array.isArray(sessions1) ? sessions1 : [];
      if (!list1.length) {
        await window.zion?.commands?.executeCommand?.("terminal.createSession", { type: "local" });
      }
    } catch {}

    renderTabs();

    let sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
    if (!sid) {
      try {
        const sessions2 = window.zion?.state?.get("terminal.sessions") || [];
        const list2 = Array.isArray(sessions2) ? sessions2 : [];
        const first = list2.find(s => String(s?.id || "").trim());
        sid = String(first?.id || "").trim() || null;
        if (sid) {
          currentSessionId = sid;
          window.zion?.state?.set("terminal.activeSessionId", sid);
        }
      } catch {}
    }

    try {
      await ensureXtermLoaded();
      if (sid) {
        await ensureView(sid);
        activateView(sid);
      }
      if (sid && api.connectPty) setPanelModeForActive("pty");
      else setPanelModeForActive("pre");
    } catch {
      setPanelModeForActive("pre");
    }

    if (sid) {
      scheduleConnectSelectedSession(sid);
    } else {
      renderFallbackOutputs();
    }

    if (xtermLoaded) {
      setTimeout(() => {
        try { fitActiveView(); } catch {}
      }, 50);
    }

    if (opts.openQuick) {
      setTimeout(() => openQuickPalette(), 0);
    } else if (opts.openHistory) {
      setTimeout(() => openHistoryPalette(), 0);
    } else if (opts.focusCommand) {
      setTimeout(() => {
        if (xtermLoaded && getActiveView()?.term) {
          try { getActiveView().term.focus(); } catch {}
          return;
        }
        cmdInput.focus();
      }, 0);
    }
  }
  function close() {
    if (embedded) {
      try { api?.requestClose?.(); } catch {}
      return;
    }
    root.style.display = "none";
    try { setRightDockShiftEnabled(false); } catch {}
    try { setBottomDockShiftEnabled(false); } catch {}
    hideSuggest();
    try { window.zion?.window?.activeEditor?.focus?.(); } catch {}
    try { setTimeout(() => window.zion?.window?.activeEditor?.focus?.(), 0); } catch {}
  }
  function dispose() {
    try { disp1?.dispose?.(); disp2?.dispose?.(); disp3?.dispose?.(); disp4?.dispose?.(); disp5?.dispose?.(); disp6?.dispose?.(); disp7?.dispose?.(); } catch {}
    try {
      // termWrap.removeEventListener("mousemove", onTermWrapMouseMove);
      termWrap.removeEventListener("mouseleave", onTermWrapMouseLeave);
      termWrap.removeEventListener("wheel", onTermWrapWheel);
      termWrap.removeEventListener("mousedown", onTermWrapMouseDownForTip);
    } catch {}
    try {
      // window.removeEventListener("keydown", onGlobalKeyForLink, true);
      // window.removeEventListener("keyup", onGlobalKeyForLink, true);
      // window.removeEventListener("blur", onGlobalBlurForLink, true);
    } catch {}
    try {
      for (const sid of Array.from(sessionViews.keys())) disposeView(sid);
    } catch {}
    try { xtermCtors?._zionThemeObserver?.disconnect?.(); } catch {}
    try { termWrapResizeObserver?.disconnect?.(); } catch {}
    try { window.removeEventListener("resize", onWindowResize); } catch {}
    try { hideTermContextMenu(); } catch {}
    try { termFindWidget?.wrap?.remove?.(); } catch {}
    try { root?._zteDockingDispose?.(); } catch {}
    try { setRightDockShiftEnabled(false); } catch {}
    try { setBottomDockShiftEnabled(false); } catch {}
    try { if (embedTabsInBottomHeader) topbar.remove(); } catch {}
    try { root.remove(); } catch {}
  }

  try {
    root._zionTerminalEnhanced = { open, close, dispose, openQuickPalette, openHistoryPalette };
  } catch {}

  return { open, close, dispose, openQuickPalette, openHistoryPalette };
}

function createHandle(root) {
  return {
    open(opts) {
      try {
        const h = root._zionTerminalEnhanced;
        if (h?.open) return h.open(opts);
      } catch {}
      root.style.display = "block";
    },
    close() {
      try {
        const h = root._zionTerminalEnhanced;
        if (h?.close) return h.close();
      } catch {}
      root.style.display = "none";
    },
    dispose() {
      try {
        const h = root._zionTerminalEnhanced;
        if (h?.dispose) return h.dispose();
      } catch {}
      root.remove();
    }
  };
}
