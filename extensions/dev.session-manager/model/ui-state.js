import { workbenchStorage as localStorage } from "../../../src/runtime/workbench-space";
export function createSessionUIStateModel(opts) {
  const getZion = () => {
    try {
      const v = opts?.getZion?.();
      if (v) return v;
    } catch {}
    return window.zion;
  };
  const lsSidebarPinKey = opts?.lsSidebarPinKey;
  const lsSidebarWidthKey = opts?.lsSidebarWidthKey;

  function getSelection() {
    return getZion()?.state?.get("sessions.selection") || [];
  }
  function setSelection(items) {
    getZion()?.state?.set("sessions.selection", Array.isArray(items) ? items : []);
  }
  function getLastSelectedId() {
    try {
      return getZion()?.state?.get("sessions.lastSelectedId") || null;
    } catch {
      return null;
    }
  }
  function setLastSelectedId(id) {
    try {
      getZion()?.state?.set("sessions.lastSelectedId", id || null);
    } catch {}
  }
  function clearSelection() {
    setSelection([]);
    setLastSelectedId(null);
  }
  function isSelected(id) {
    const sel = getSelection();
    return !!sel.find(it => it.id === id);
  }
  function toggleSelection(node) {
    const sel = getSelection();
    const i = sel.findIndex(it => it.id === node.id);
    if (i >= 0) sel.splice(i, 1);
    else sel.push({ id: node.id, type: node.type || "session" });
    setSelection(sel);
    setLastSelectedId(node.id);
  }

  function getTabStorage() {
    try {
      return window.sessionStorage;
    } catch {
      return localStorage;
    }
  }
  function getSidebarPinned() {
    if (!lsSidebarPinKey) return false;
    return getTabStorage().getItem(lsSidebarPinKey) === "1";
  }
  function setSidebarPinned(v) {
    if (!lsSidebarPinKey) return;
    try { getTabStorage().setItem(lsSidebarPinKey, v ? "1" : "0"); } catch {}
  }
  function getSidebarWidth() {
    const raw = lsSidebarWidthKey ? localStorage.getItem(lsSidebarWidthKey) : null;
    const w = parseInt(raw || "300", 10);
    const safe = isNaN(w) ? 300 : w;
    return Math.max(220, Math.min(480, safe));
  }
  function setSidebarWidth(w) {
    if (!lsSidebarWidthKey) return;
    try { localStorage.setItem(lsSidebarWidthKey, String(w)); } catch {}
  }

  return {
    getSelection,
    setSelection,
    clearSelection,
    isSelected,
    toggleSelection,
    getLastSelectedId,
    setLastSelectedId,
    getTabStorage,
    getSidebarPinned,
    setSidebarPinned,
    getSidebarWidth,
    setSidebarWidth
  };
}
