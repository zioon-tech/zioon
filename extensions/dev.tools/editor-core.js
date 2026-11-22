import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
const CORE_KEY = "__zionEditorCore";
const CORE_SCOPES_KEY = "__zionEditorCoreScopes";
const EXPLORER_WIDTH_KEY = "zion.editorCore.explorerWidth";
const LEGACY_EXPLORER_WIDTH_KEYS = [
  "zion.devTools.files.explorerWidth",
  "zion.devTools.context.explorerWidth",
  "zion.memory.explorer.width"
];

function scopedExplorerWidthKey(scope) {
  const value = String(scope || "default").replace(/[^a-z0-9_.:-]/gi, "_");
  return value === "default" ? EXPLORER_WIDTH_KEY : `${EXPLORER_WIDTH_KEY}.${value}`;
}

function loadExplorerWidth(scope = "default") {
  try {
    const scopedKey = scopedExplorerWidthKey(scope);
    const keys = scopedKey === EXPLORER_WIDTH_KEY ? [EXPLORER_WIDTH_KEY, ...LEGACY_EXPLORER_WIDTH_KEYS] : [scopedKey, EXPLORER_WIDTH_KEY, ...LEGACY_EXPLORER_WIDTH_KEYS];
    for (const key of keys) {
      const value = Number(localStorage.getItem(key) || "");
      if (Number.isFinite(value) && value >= 160) return Math.max(180, Math.min(520, value));
    }
  } catch {}
  return 296;
}

function saveExplorerWidth(value, scope = "default") {
  try { localStorage.setItem(scopedExplorerWidthKey(scope), String(Math.round(Number(value) || 296))); } catch {}
}

export function getEditorCore(scope = "default") {
  window.zion = window.zion || {};
  const scopeId = String(scope || "default");
  window.zion[CORE_SCOPES_KEY] = window.zion[CORE_SCOPES_KEY] || {};
  if (window.zion[CORE_SCOPES_KEY][scopeId]) return window.zion[CORE_SCOPES_KEY][scopeId];
  if (scopeId === "default" && window.zion[CORE_KEY]) return window.zion[CORE_KEY];

  const tabs = new Map();
  const previewScroll = new Map();
  const listeners = new Set();
  let activeTabId = "";
  let explorerWidth = loadExplorerWidth(scopeId);

  const emit = (reason = "changed") => {
    const payload = { reason, activeTabId, explorerWidth, tabs: Array.from(tabs.values()) };

    for (const listener of Array.from(listeners)) {
      try { listener(payload); } catch (err) { console.error("[editor-core] listener failed", err); }
    }
    try { window.zion?.events?.emit?.("editorCore/changed", payload); } catch {}
    try { window.dispatchEvent(new CustomEvent("zion:editor-core-changed", { detail: payload })); } catch {}
  };

  const sameTab = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

  const api = {
    tabs,
    previewScroll,
    scopeId,
    getTabs: () => Array.from(tabs.values()),
    getTab: (id) => tabs.get(id) || null,
    getActiveTabId: () => activeTabId,
    getActiveTab: () => tabs.get(activeTabId) || null,
    getExplorerWidth: () => explorerWidth,
    getPreviewScroll(id) {
      return previewScroll.get(String(id || "")) || null;
    },
    setPreviewScroll(id, state = {}) {
      const key = String(id || "");
      if (!key) return null;
      const next = {
        top: Math.max(0, Number(state.top || 0)),
        left: Math.max(0, Number(state.left || 0))
      };
      previewScroll.set(key, next);
      return next;
    },
    deletePreviewScroll(id) {
      previewScroll.delete(String(id || ""));
    },
    setExplorerWidth(width, options = {}) {
      const next = Math.max(180, Math.min(520, Math.round(Number(width) || explorerWidth || 296)));
      if (next === explorerWidth) return explorerWidth;
      explorerWidth = next;
      saveExplorerWidth(next, scopeId);
      if (options.silent) return explorerWidth;
      emit(options.reason || "resize");
      return explorerWidth;
    },
    openTab(tab, options = {}) {
      if (!tab?.id) return null;
      const previous = tabs.get(tab.id) || null;
      const previousActive = activeTabId;
      const next = { ...tab };
      tabs.set(next.id, next);
      if (options.active !== false) activeTabId = next.id;
      if (sameTab(previous, next) && previousActive === activeTabId) return next;
      emit(options.reason || "open");
      return next;
    },
    updateTab(id, patch = {}, options = {}) {
      const current = tabs.get(id);
      if (!current) return null;
      const previousActive = activeTabId;
      const next = { ...current, ...patch };
      tabs.set(id, next);
      if (options.active) activeTabId = id;
      if (sameTab(current, next) && previousActive === activeTabId) return next;
      emit(options.reason || "update");
      return next;
    },
    setActiveTab(id, options = {}) {
      const value = String(id || "");
      const next = tabs.has(value) ? value : "";
      if (next === activeTabId) return activeTabId;
      activeTabId = next;
      emit(options.reason || "active");
      return activeTabId;
    },
    closeTab(id, options = {}) {
      const current = tabs.get(id);
      if (!current) return null;
      tabs.delete(id);
      previewScroll.delete(id);
      if (activeTabId === id) activeTabId = Array.from(tabs.keys()).pop() || "";
      emit(options.reason || "close");
      return current;
    },
    notify(reason = "changed") {
      emit(reason);
    },
    subscribe(listener) {
      if (typeof listener !== "function") return { dispose() {} };
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    }
  };

  window.zion[CORE_SCOPES_KEY][scopeId] = api;
  if (scopeId === "default") {
    window.zion[CORE_KEY] = api;
    window.zion.editorCore = api;
  }
  return api;
}
