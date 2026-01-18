/**
 * Terminal Enhanced Panel with PTY WebSocket + xterm.js (fallback to exec panel)
 */
export function installTerminalEnhancedPanel(api = { execute: async () => {}, connectPty: null }) {
  const HEIGHT_KEY = "zion.terminalEnhanced.panelHeightPx";
  const WIDTH_KEY = "zion.terminalEnhanced.panelWidthPx";
  const DOCK_KEY = "zion.terminalEnhanced.dock";
  const STYLE_ID = "zion-terminal-enhanced-style";

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const viewportH = () => window.innerHeight || document.documentElement?.clientHeight || 800;
  const viewportW = () => window.innerWidth || document.documentElement?.clientWidth || 1200;

  function ensurePanelStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
#zion-terminal-enhanced-root { pointer-events: none; }
#zion-terminal-enhanced-root .zte-panel { pointer-events: auto; }

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
.zte-panel > div:nth-child(3) {
  margin: 0;
  padding: 0;
}
.zte-panel > div:nth-child(3) > div {
  margin: 0;
  padding: 0;
}
.zte-panel .xterm-viewport {
  top: 0;
  padding: 0 8px;
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

/* 隐藏 xterm 内部高度为 14px 的空白 div（xterm 生成的占位符） */
.zte-panel .xterm-rows > div[style*="height: 14px"]:empty {
  display: none !important;
}

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

#zion-terminal-enhanced-root[data-zte-dock="right"] .zte-resize-handle {
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

#zion-terminal-enhanced-root[data-zte-dock="right"] .zte-resize-handle::after {
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

.zte-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  flex: 1;
  min-width: 0;
  /* 隐藏滚动条但保持滚动功能 */
  scrollbar-width: none; /* Firefox */
  -ms-overflow-style: none; /* IE/Edge */
  padding: 5px 0;
}
.zte-tabs::-webkit-scrollbar {
  display: none; /* Chrome/Safari/Edge */
}

.zte-tab {
  height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border-radius: 3px;
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
  opacity: 0.5;
  padding: 0 2px;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  border-radius: 3px;
  margin-left: 4px;
  transition: all 80ms ease;
}
.zte-tab:hover .zte-tab-close { opacity: 0.7; }
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

    if (!enabled) {
      try {
        if (typeof root?._ztePrevEditorContainerWidth === "string") editorContainer.style.width = root._ztePrevEditorContainerWidth;
        else editorContainer.style.width = "";
        if (typeof root?._ztePrevEditorContainerBoxSizing === "string") editorContainer.style.boxSizing = root._ztePrevEditorContainerBoxSizing;
        else editorContainer.style.boxSizing = "";
        if (typeof root?._ztePrevEditorContainerMaxWidth === "string") editorContainer.style.maxWidth = root._ztePrevEditorContainerMaxWidth;
        else editorContainer.style.maxWidth = "";
        if (typeof root?._ztePrevEditorContainerMarginRight === "string") editorContainer.style.marginRight = root._ztePrevEditorContainerMarginRight;
        else editorContainer.style.marginRight = "";
      } catch {}

      if (appEl) {
        try {
          if (typeof root?._ztePrevAppOverflowX === "string") appEl.style.overflowX = root._ztePrevAppOverflowX;
          else appEl.style.overflowX = "";
        } catch {}
      }
      return;
    }

    try {
      if (typeof root?._ztePrevEditorContainerWidth !== "string") root._ztePrevEditorContainerWidth = editorContainer.style.width || "";
      if (typeof root?._ztePrevEditorContainerBoxSizing !== "string") root._ztePrevEditorContainerBoxSizing = editorContainer.style.boxSizing || "";
      if (typeof root?._ztePrevEditorContainerMaxWidth !== "string") root._ztePrevEditorContainerMaxWidth = editorContainer.style.maxWidth || "";
      if (typeof root?._ztePrevEditorContainerMarginRight !== "string") root._ztePrevEditorContainerMarginRight = editorContainer.style.marginRight || "";
    } catch {}

    if (appEl) {
      try {
        if (typeof root?._ztePrevAppOverflowX !== "string") root._ztePrevAppOverflowX = appEl.style.overflowX || "";
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
    const shouldShift = mode === "right" && root.style.display === "block";
    try { setRightDockShiftEnabled(shouldShift); } catch {}
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
      const rightGapPx = Math.max(0, Math.round(window.innerWidth - box.right));
      root.style.left = `${leftPx}px`;
      root.style.right = `${rightGapPx}px`;
      root.style.top = "";
      root.style.bottom = "0";
    }
  }

  function ensureDocking(root) {
    if (root?._zteDockingInstalled) return;
    root._zteDockingInstalled = true;

    let raf = 0;
    let ro = null;
    let observedEl = null;
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

  let root = document.getElementById("zion-terminal-enhanced-root");
  if (root) {
    ensurePanelStyles();
    ensureDocking(root);
    return createHandle(root);
  }

  ensurePanelStyles();

  root = document.createElement("div");
  root.id = "zion-terminal-enhanced-root";
  const initialDockMode = readSavedDockMode();
  root.dataset.zteDock = initialDockMode;
  Object.assign(root.style, {
    position: "fixed",
    left: "0",
    right: "0",
    bottom: "0",
    height: "35vh",
    background: "transparent",
    zIndex: "1001",
    display: "none"
  });

  if (initialDockMode === "right") {
    const savedW = readSavedWidthPx();
    const w0 = Number.isFinite(savedW) ? savedW : 420;
    const w = clamp(Math.floor(Number(w0 || 420)), 280, Math.floor(viewportW() * 0.75));
    root.style.width = `${w}px`;
    root.style.height = "";
  } else {
    const savedH = readSavedHeightPx();
    if (savedH) root.style.height = `${savedH}px`;
    root.style.width = "";
  }

  const panel = document.createElement("div");
  panel.className = "zte-panel";
  Object.assign(panel.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    background: "var(--panel)",
    color: "var(--fg)",
    borderTop: "1px solid var(--border)",
    borderLeft: "1px solid var(--border)",
    borderRight: "1px solid var(--border)",
    borderBottom: "0",
    borderRadius: "0",
    boxShadow: "none",
    display: "grid",
    gridTemplateRows: "auto 1fr auto",
    padding: "0",
    boxSizing: "border-box",
    fontFamily: "var(--font-sans)"
  });

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "zte-resize-handle";
  resizeHandle.title = "Drag to resize terminal";
  panel.appendChild(resizeHandle);

  const topbar = document.createElement("div");
  topbar.className = "zte-topbar";
  Object.assign(topbar.style, {
    overflow: "hidden"
  });

  const tabs = document.createElement("div");
  tabs.className = "zte-tabs";
  topbar.appendChild(tabs);

  const actions = document.createElement("div");
  actions.className = "zte-actions";

  // SVG 图标定义
  const ICONS = {
    plus: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>`,
    trash: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1M6 7v6M10 7v6"/></svg>`,
    dockBottom: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 2.5h11v11h-11z"/><path d="M2.5 10.5h11"/></svg>`,
    dockRight: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 2.5h11v11h-11z"/><path d="M10.5 2.5v11"/></svg>`,
    x: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>`
  };

  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "zte-icon-btn";
  newBtn.innerHTML = ICONS.plus;
  newBtn.title = "New terminal session";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "zte-icon-btn";
  closeBtn.innerHTML = ICONS.x;
  closeBtn.title = "Hide terminal panel (Esc)";

  const dockBtn = document.createElement("button");
  dockBtn.type = "button";
  dockBtn.className = "zte-icon-btn";

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
    minHeight: "280px",
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
  cmdInput.placeholder = "输入命令并回车执行…";
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

  panel.appendChild(topbar);
  panel.appendChild(content);
  panel.appendChild(footer);
  root.appendChild(panel);
  document.body.appendChild(root);

  ensureDocking(root);

  const toast = document.createElement("div");
  toast.className = "zte-toast";
  toast.style.display = "none";
  panel.appendChild(toast);

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

  function setPanelHeightPx(nextPx, persist = true) {
    const maxPx = Math.floor(viewportH() * 0.85);
    const minPx = 180;
    const px = clamp(Math.floor(Number(nextPx || 0)), minPx, maxPx);
    root.style.height = `${px}px`;
    if (persist) saveHeightPx(px);
    try { fitActiveView(); } catch {}
  }

  function setPanelWidthPx(nextPx, persist = true) {
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

  function updateDockBtn() {
    if (dockMode === "right") {
      dockBtn.innerHTML = ICONS.dockBottom;
      dockBtn.title = "Dock terminal panel to bottom";
    } else {
      dockBtn.innerHTML = ICONS.dockRight;
      dockBtn.title = "Dock terminal panel to right";
    }
  }

  function setDockMode(nextMode, persist = true) {
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

  (function attachResize() {
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
  const onWindowResize = () => {
    if (root.style.display === "none") return;
    fitActiveView();
  };

  function getActiveView() {
    const sid = String(activeViewId || currentSessionId || "").trim();
    if (!sid) return null;
    return sessionViews.get(sid) || null;
  }

  function fitActiveView() {
    const v = getActiveView();
    if (!v || !v.term || !v.fitAddon) return;
    try {
      v.fitAddon.fit();
      if (v.usingPty && v.pty) {
        const cols = v.term.cols || 80;
        const rows = v.term.rows || 24;
        v.pty.resize?.(cols, rows);
      }
    } catch {}
  }

  function isActiveUsingPty() {
    const v = getActiveView();
    return !!(v && v.usingPty);
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
  async function ensureXtermLoaded() {
    if (xtermLoaded) return;
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
    const wa = new xtermCtors.WebLinksAddon();
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
      usingPty: false,
      usingExec: false,
      pty: null,
      ptyConnecting: false,
      ptyInputBuffer: "",
      ptyConnectNonce: 0,
      ptyRetryTimer: 0,
      ptyRetryCount: 0,
      termDataDisp: null,
      execLine: "",
      execBusy: false,
      execEscState: 0,
      execBooted: false
    };

    v.termDataDisp = t.onData((data) => {
      if (v.usingPty) {
        const wsOpen = !!(v.pty?.ws && v.pty.ws.readyState === WebSocket.OPEN);
        if (wsOpen) {
          try { v.pty.send(data); } catch {}
          return;
        }
        if (v.ptyConnecting) {
          if (v.ptyInputBuffer.length < 8192) v.ptyInputBuffer += String(data || "");
          return;
        }
      }
      if (v.usingExec) {
        handleExecInputForView(v, data);
      }
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
    try { v.termDataDisp?.dispose?.(); } catch {}
    try { v.pty?.dispose?.(); } catch {}
    try { v.term?.dispose?.(); } catch {}
    try { v.container?.remove?.(); } catch {}
    sessionViews.delete(sid);
    if (activeViewId === sid) activeViewId = null;
  }

  function schedulePtyReconnect(sessionId) {
    const sid = String(sessionId || "").trim();
    const v = sid ? (sessionViews.get(sid) || null) : null;
    if (!v) return;
    try { clearTimeout(v.ptyRetryTimer); } catch {}
    v.ptyRetryTimer = 0;
    if (root.style.display === "none") return;
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

  function getPromptForSession(sessionId) {
    const sid = String(sessionId || "");
    const sessions = window.zion?.state?.get("terminal.sessions") || [];
    const list = Array.isArray(sessions) ? sessions : [];
    const s = list.find(x => String(x?.id || "") === sid) || null;
    const cwd = String(s?.cwd || "");
    const cwdShort = cwd ? cwd.split("/").filter(Boolean).slice(-2).join("/") : "";
    return cwdShort ? `${sid}:${cwdShort}$ ` : `${sid}$ `;
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

  function writeExecPromptForView(v) {
    if (!v?.term) return;
    v.execLine = "";
    const prompt = getPromptForSession(v.sessionId);
    try { v.term.write("\x1b[0m" + prompt); } catch {}
  }

  function bootstrapExecForSession(sessionId) {
    const sid = String(sessionId || "").trim();
    const v = sid ? (sessionViews.get(sid) || null) : null;
    if (!v?.term) return;
    if (v.execBooted) return;
    v.execBooted = true;
    try {
      v.term.reset();
      const text = outputsToTextForSession(sid);
      const lines = String(text || "").replace(/\r/g, "").split("\n");
      for (const ln of lines) v.term.writeln(ln);
      v.term.writeln("");
    } catch {}
    writeExecPromptForView(v);
  }

  async function runExecCommandForView(v, command) {
    if (!v?.term) return;
    const cmd = String(command || "").trim();
    if (!cmd) {
      writeExecPromptForView(v);
      return;
    }

    const maybeForceGitColor = (raw) => {
      const s = String(raw || "");
      if (!/^git\s+/i.test(s)) return s;
      if (/\s--no-color\b/i.test(s)) return s;
      if (/\s--color(?:=\w+)?\b/i.test(s)) return s;
      if (/\s-c\s+color\.ui=/i.test(s)) return s;
      if (/\s-c\s+color\.diff=/i.test(s)) return s;
      return s.replace(/^git\b/i, "git -c color.ui=always");
    };

    const sid = String(v.sessionId || "").trim();
    if (!sid) {
      try { v.term.writeln("No active session"); } catch {}
      writeExecPromptForView(v);
      return;
    }
    v.execBusy = true;
    try {
      const finalCmd = maybeForceGitColor(cmd);
      const rec = await api.execute?.(finalCmd, sid);
      const out = typeof rec?.output === "string" ? rec.output : "";
      if (out) {
        const normalized = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        for (const ln of normalized) {
          try { v.term.writeln(ln); } catch {}
        }
      }
    } catch (e) {
      try { v.term.writeln(String(e?.message || e || "exec failed")); } catch {}
    } finally {
      v.execBusy = false;
      writeExecPromptForView(v);
    }
  }

  function handleExecInputForView(v, data) {
    if (!v?.term) return;
    if (v.execBusy) return;

    const s = String(data || "");
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];

      if (v.execEscState !== 0) {
        if (v.execEscState === 1) {
          if (ch === "[" || ch === "O") {
            v.execEscState = 2;
            continue;
          }
          v.execEscState = 0;
          continue;
        }
        const code = ch.charCodeAt(0);
        if (code >= 0x40 && code <= 0x7e) {
          v.execEscState = 0;
        }
        continue;
      }

      if (ch === "\r") {
        const cmd = v.execLine;
        v.execLine = "";
        try { v.term.write("\r\n"); } catch {}
        runExecCommandForView(v, cmd);
        continue;
      }

      if (ch === "\u007f") {
        if (v.execLine.length) {
          v.execLine = v.execLine.slice(0, -1);
          try { v.term.write("\b \b"); } catch {}
        }
        continue;
      }

      if (ch === "\u0003") {
        v.execLine = "";
        try { v.term.write("^C\r\n"); } catch {}
        writeExecPromptForView(v);
        continue;
      }

      if (ch === "\t") {
        continue;
      }

      if (ch === "\n") {
        continue;
      }

      if (ch === "\u001b") {
        v.execEscState = 1;
        continue;
      }

      if (ch >= " ") {
        v.execLine += ch;
        try { v.term.write(ch); } catch {}
      }
    }
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
    input.placeholder = "Find";
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
      zIndex: "1005",
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
    const resolvedMode = xtermReady ? String(mode || "exec") : "pre";

    if (v) {
      v.usingPty = resolvedMode === "pty";
      v.usingExec = resolvedMode === "exec";
    }

    const showXterm = xtermReady && (resolvedMode === "pty" || resolvedMode === "exec");
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
        activeViewId = sid;
        activateView(sid);
        setPanelModeForActive("exec");
        bootstrapExecForSession(sid);
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
      v.ptyRetryCount = 0;
      try { clearTimeout(v.ptyRetryTimer); } catch {}
      v.ptyRetryTimer = 0;
      v.usingPty = true;
      v.usingExec = false;
      if (!background) {
        try { v.term.focus(); } catch {}
        try { fitActiveView(); } catch {}
      }
      return true;
    }

    if (v.ptyConnecting) {
      v.usingPty = true;
      v.usingExec = false;
      return true;
    }

    try {
      v.ptyConnecting = true;
      v.ptyInputBuffer = "";
      v.ptyConnectNonce += 1;
      const nonce = v.ptyConnectNonce;
      v.usingPty = true;
      v.usingExec = false;

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
        try { localPty?.dispose?.(); } catch {}
        v.pty = null;
        v.ptyConnecting = false;
        v.execBooted = false;
        v.usingPty = false;
        v.usingExec = true;
        if (!background && activeViewId === sid) {
          setPanelModeForActive("exec");
          bootstrapExecForSession(sid);
          try { showToast("PTY 连接断开，正在重连…", 1200); } catch {}
        }
        schedulePtyReconnect(sid);
      };

      localPty.onError(onBroken);
      localPty.onClose(onBroken);

      await localPty.ready;

      if (nonce !== v.ptyConnectNonce || v.pty !== localPty) {
        try { localPty?.dispose?.(); } catch {}
        if (v.pty === localPty) v.pty = null;
        v.ptyConnecting = false;
        return false;
      }

      v.ptyConnecting = false;
      v.ptyRetryCount = 0;
      try { clearTimeout(v.ptyRetryTimer); } catch {}
      v.ptyRetryTimer = 0;

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
      v.execBooted = false;
      v.usingPty = false;
      v.usingExec = true;
      if (!background && activeViewId === sid) {
        setPanelModeForActive("exec");
        bootstrapExecForSession(sid);
        try { showToast("PTY 连接失败，正在重试…", 1200); } catch {}
      }
      schedulePtyReconnect(sid);
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
    tabs.innerHTML = "";
    if (!sessionList.length) {
      const empty = document.createElement("div");
      empty.textContent = "No sessions (use Terminal Manager to create)";
      empty.style.fontSize = "11px";
      empty.style.opacity = "0.75";
      tabs.appendChild(empty);
      updateStatusText();
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
        reactivateBtn.textContent = "激活";
        reactivateBtn.className = "zte-tab-activate";
        reactivateBtn.title = "激活 SSH 会话";
        reactivateBtn.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            reactivateBtn.disabled = true;
            reactivateBtn.textContent = "激活中";
            const result = await window.zion?.commands?.executeCommand?.("terminal.reactivateSession", { session_id: id });
            if (result) {
              // Refresh sessions list and reconnect
              await window.zion?.commands?.executeCommand?.("terminal.refreshSessions");
              renderTabs();
              // Try to connect to the reactivated session
              if (isActive || id === currentSessionId) {
                const ok = await connectPtyForSession(id);
                if (!ok) {
                  if (xtermLoaded) {
                    activateView(id);
                    setPanelModeForActive("exec");
                    bootstrapExecForSession(id);
                  } else {
                    fallbackPre.textContent = currentOutputsToText();
                  }
                }
              }
            }
          } catch (err) {
            console.error("Failed to reactivate session:", err);
            alert("Failed to reactivate session: " + (err?.message || String(err)));
          } finally {
            reactivateBtn.disabled = false;
            renderTabs();
          }
        };
        tab.appendChild(reactivateBtn);
      }

      tab.onclick = async () => {
        currentSessionId = id;
        try { window.zion?.state?.set("terminal.activeSessionId", id); } catch {}
        activeViewId = id;
        renderTabs();

        if (isSsh && isInactive) {
          try {
            const result = await window.zion?.commands?.executeCommand?.("terminal.reactivateSession", { session_id: id });
            if (result) {
              await window.zion?.commands?.executeCommand?.("terminal.refreshSessions");
              renderTabs();
            } else {
              try { showToast("会话已失活，可点击“激活”重连"); } catch {}
            }
          } catch {
            try { showToast("会话已失活，可点击“激活”重连"); } catch {}
          }
        }

        const ok = await connectPtyForSession(id);
        if (!ok) {
          if (xtermLoaded) {
            activateView(id);
            setPanelModeForActive("exec");
            bootstrapExecForSession(id);
          } else {
            fallbackPre.textContent = currentOutputsToText();
          }
        }
      };

      tab.appendChild(label);
      tab.appendChild(xbtn);
      tabs.appendChild(tab);
    });
    updateStatusText();
  }

  // Fallback render outputs
  function renderFallbackOutputs() {
    const text = currentOutputsToText();
    fallbackPre.textContent = text;
    fallbackPre.scrollTop = fallbackPre.scrollHeight;
  }

  // Exec handlers
  async function runCommandFromInput() {
    const cmd = cmdInput.value.trim();
    if (!cmd) return;
    const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
    if (!sid) {
      alert("没有活动会话，请先创建或切换会话");
      return;
    }
    cmdInput.disabled = true;
    try {
      const v = getActiveView();
      if (v?.usingPty && v?.pty) {
        v.pty.send(cmd + "\r");
      } else {
        await api.execute?.(cmd, sid);
        renderFallbackOutputs();
      }
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

  function openHistoryPalette() {
    const history = window.zion?.state?.get("terminal.history") || [];
    const list = Array.isArray(history) ? history.slice() : [];
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0,0,0,0.35)",
      zIndex: "1003"
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
    input.placeholder = "搜索历史命令…";
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
    cbtn.textContent = "Close";
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
      zIndex: "1003"
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
    input.placeholder = "搜索并执行命令…";
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
    cbtn.textContent = "Close";
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
          if (!sid) { alert("没有活动会话"); return; }
          const cmd = String(it.insertText || it.label || "");
          if (!cmd.trim()) return;
          overlay.remove();
          hideSuggest();
          cmdInput.value = "";
          const v = getActiveView();
          if (v?.usingPty && v?.pty) {
            v.pty.send(cmd + "\r");
          } else {
            await api.execute?.(cmd, sid);
            renderFallbackOutputs();
          }
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
        if (!sid) { alert("没有活动会话"); return; }
        const cmd = String(it.insertText || it.label || "");
        if (!cmd.trim()) return;
        overlay.remove();
        hideSuggest();
        cmdInput.value = "";
        const v = getActiveView();
        if (v?.usingPty && v?.pty) {
          v.pty.send(cmd + "\r");
        } else {
          await api.execute?.(cmd, sid);
          renderFallbackOutputs();
        }
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
    currentSessionId = nv || currentSessionId;
    if (currentSessionId) activeViewId = currentSessionId;
    renderTabs();
    if (currentSessionId) {
      const ok = await connectPtyForSession(currentSessionId);
      if (!ok) {
        if (xtermLoaded) {
          activateView(currentSessionId);
          setPanelModeForActive("exec");
          bootstrapExecForSession(currentSessionId);
        } else {
          renderFallbackOutputs();
        }
      }
    }
  });
  const disp3 = window.zion.state.onDidChange("terminal.outputs", () => { if (!isActiveUsingPty()) renderFallbackOutputs(); });
  const disp4 = window.zion.events.on("terminal/commandExecuted", () => { if (!isActiveUsingPty()) renderFallbackOutputs(); });

  async function open(opts = {}) {
    // 先显示 root，确保 DOM 准备好
    const wasVisible = root.style.display === "block";
    root.style.display = "block";
    try { applyDocking(root); } catch {}

    const av = getActiveView();
    if (wasVisible && av?.pty?.ws?.readyState === WebSocket.OPEN) {
      try { fitActiveView(); } catch {}
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
      else setPanelModeForActive("exec");
    } catch {
      setPanelModeForActive("pre");
    }

    if (sid) {
      const ok = await connectPtyForSession(sid);
      if (!ok) {
        if (xtermLoaded) {
          activateView(sid);
          setPanelModeForActive("exec");
          bootstrapExecForSession(sid);
        } else {
          renderFallbackOutputs();
        }
      }
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
    root.style.display = "none";
    try { setRightDockShiftEnabled(false); } catch {}
    hideSuggest();
    try { window.zion?.window?.activeEditor?.focus?.(); } catch {}
    try { setTimeout(() => window.zion?.window?.activeEditor?.focus?.(), 0); } catch {}
  }
  function dispose() {
    try { disp1?.dispose?.(); disp2?.dispose?.(); disp3?.dispose?.(); disp4?.dispose?.(); } catch {}
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
