import { ViewPlugin } from "@codemirror/view";
import { registerSessionTools } from "./session-tools.js";

/** ========== Storage & Utils ========== */
const LS_INDEX = "zion.sessions.index";
const LS_TREE = "zion.sessions.tree";
const LS_LAST = "zion.sessions.lastActiveId";
const LS_AUTO = "zion.autosave";
const LS_SIDEBAR_PIN = "zion.sessions.sidebarPinned";
const LS_SIDEBAR_W = "zion.sessions.sidebarWidth";
const LS_FOLDER_OPEN = "zion.sessions.folderOpen";
const URL_SESSION = "zionSession";
const URL_SESSION_ALT = "session";
function now() {
  return Date.now();
}
function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}
function safeJSONParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Storage error warning: log and surface a status item (first time). */
function warnStorageIssue(where, error) {
  try {
    console.error("[sessions] storage write failed at", where, error);
    // mark an error state for diagnostics
    try { window.zion?.state?.set("sessions.storageError", { where, error: String(error) }); } catch {}
    // surface a compact status item (id reused to update text)
    try {
      window.zion?.statusBar?.registerItem({
        id: "session.storage.warn",
        text: "⚠ Storage",
        tooltip: "Sessions storage write failed. Some changes may not persist."
      });
    } catch {}
  } catch {}
}

/** ======== IndexedDB (sessions) ======== */
const DB_NAME = "zion.sessions.db";
let __dbPromise = null;

function openSessionsDB() {
  if (__dbPromise) return __dbPromise;
  __dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        try {
          const db = e.target.result;
          if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "id" });
          if (!db.objectStoreNames.contains("metas")) db.createObjectStore("metas", { keyPath: "id" });
          if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "key" });
        } catch (err) {
          console.error("[sessions] idb upgrade error:", err);
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error || new Error("idb open error"));
    } catch (err) {
      reject(err);
    }
  });
  return __dbPromise;
}

async function idbGet(store, key) {
  const db = await openSessionsDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(store, "readonly");
      const st = tx.objectStore(store);
      const req = st.get(key);
      req.onsuccess = () => {
        const v = req.result;
        if (!v) return resolve(undefined);
        if (store === "docs" || store === "metas") {
          resolve(v);
        } else {
          resolve(v?.value);
        }
      };
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}
async function idbSet(store, record) {
  const db = await openSessionsDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(store, "readwrite");
      const st = tx.objectStore(store);
      const req = st.put(record);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}
async function idbDel(store, key) {
  const db = await openSessionsDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(store, "readwrite");
      const st = tx.objectStore(store);
      const req = st.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}
// kv helpers
const idbGetKV = (key) => idbGet("kv", key);
const idbSetKV = (key, value) => idbSet("kv", { key, value });
const idbDelKV = (key) => idbDel("kv", key);

/** preload tree/index into memory and migrate legacy localStorage once */
async function initSessionsStorage() {
  try {
    await openSessionsDB();
    // preload KV: tree/index
    try {
      const tree = await idbGetKV("tree");
      if (tree && tree.type === "folder" && Array.isArray(tree.children)) {
        try { window.zion?.state?.set("sessions.treeMem", tree); } catch {}
      }
    } catch {}
    try {
      const idx = await idbGetKV("index");
      if (Array.isArray(idx)) {
        try { window.zion?.state?.set("sessions.indexMem", idx); } catch {}
      }
    } catch {}

    // migrate from localStorage if no tree in IDB but legacy tree/index exist
    const hasTreeInIDB = !!(await idbGetKV("tree"));
    const legacyTreeRaw = localStorage.getItem(LS_TREE);
    const legacyIndexRaw = localStorage.getItem(LS_INDEX);
    if (!hasTreeInIDB && (legacyTreeRaw || legacyIndexRaw)) {
      console.info("[sessions] migrating from localStorage to IndexedDB...");
      const legacyTree = safeJSONParse(legacyTreeRaw || "", null);
      let ids = [];
      if (legacyTree && legacyTree.type === "folder") {
        const collect = (n) => n.type === "session" ? [n.id] : (Array.isArray(n.children) ? n.children.flatMap(collect) : []);
        ids = collect(legacyTree);
      } else {
        const legacyIndex = safeJSONParse(legacyIndexRaw || "[]", []);
        if (Array.isArray(legacyIndex)) ids = legacyIndex.map(it => it.id).filter(Boolean);
      }
      // migrate docs/metas
      for (const sid of ids) {
        try {
          const d = localStorage.getItem(docKey(sid)) || "";
          const m = safeJSONParse(localStorage.getItem(metaKey(sid)) || "{}", { id: sid, title: `Session ${sid}`, createdAt: now(), updatedAt: now(), size: d.length, hash: "", titleAuto: true });
          await idbSet("docs", { id: sid, text: d });
          await idbSet("metas", { id: sid, meta: m });
          try { window.zion?.state?.set(`sessions.doc.${sid}`, d); } catch {}
          try { window.zion?.state?.set(`sessions.meta.${sid}`, m); } catch {}
        } catch (e) {
          console.warn("[sessions] migrate doc/meta error:", sid, e);
        }
      }
      // persist tree/index to idb
      if (legacyTree) {
        await idbSetKV("tree", legacyTree);
        try { window.zion?.state?.set("sessions.treeMem", legacyTree); } catch {}
      }
      const legacyIndex = safeJSONParse(legacyIndexRaw || "[]", []);
      if (Array.isArray(legacyIndex)) {
        await idbSetKV("index", legacyIndex);
        try { window.zion?.state?.set("sessions.indexMem", legacyIndex); } catch {}
      }
      // clean heavy localStorage keys
      try {
        localStorage.removeItem(LS_TREE);
        localStorage.removeItem(LS_INDEX);
        // remove zion.session.* keys
        const toDel = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith("zion.session.") && (k.endsWith(".doc") || k.endsWith(".meta")))) {
            toDel.push(k);
          }
        }
        toDel.forEach(k => { try { localStorage.removeItem(k); } catch {} });
      } catch {}
      console.info("[sessions] migration to IndexedDB finished.");
      window.zion?.statusBar?.registerItem({
        id: "session.migrated",
        text: "✓ Migrated",
        tooltip: "Sessions migrated to IndexedDB"
      });
    }
  } catch (e) {
    console.error("[sessions] initSessionsStorage error:", e);
  }
}

/** 设置一个小尺寸的拖拽预览，避免遮挡落点 */
function setSmallDragImage(ev, label) {
  try {
    const ghost = document.createElement("div");
    ghost.textContent = String(label || "");
    ghost.style.position = "fixed";
    ghost.style.top = "-9999px";
    ghost.style.left = "-9999px";
    ghost.style.background = "var(--panel)";
    ghost.style.color = "var(--fg)";
    ghost.style.border = "1px solid var(--border)";
    ghost.style.borderRadius = "6px";
    ghost.style.padding = "2px 6px";
    ghost.style.fontSize = "11px";
    ghost.style.lineHeight = "1.4";
    ghost.style.boxShadow = "0 2px 6px rgba(0,0,0,0.2)";
    ghost.style.pointerEvents = "none";
    document.body.appendChild(ghost);
    if (ev.dataTransfer?.setDragImage) {
      // 将拖拽预览设置为小胶囊标签
      ev.dataTransfer.setDragImage(ghost, Math.round(ghost.offsetWidth / 2), Math.round(ghost.offsetHeight / 2));
    }
    const cleanup = () => { try { ghost.remove(); } catch {} };
    try {
      (ev.target instanceof HTMLElement) && ev.target.addEventListener("dragend", cleanup, { once: true });
    } catch {}
    // 兜底清理
    setTimeout(cleanup, 2000);
  } catch {}
}

/** ========== Tree storage (folders + sessions) ========== */
function loadTree() {
  // memory-first; initial preload handled by initSessionsStorage()
  try {
    const mem = window.zion?.state?.get("sessions.treeMem");
    if (mem && mem.type === "folder" && Array.isArray(mem.children)) return mem;
  } catch {}
  return null;
}
function saveTree(tree) {
  (async () => {
    try {
      await idbSetKV("tree", tree);
    } catch (e) {
      warnStorageIssue("saveTree", e);
    } finally {
      try { window.zion?.state?.set("sessions.treeMem", tree); } catch {}
    }
  })();
}
function getIndexLegacy() {
  try {
    const mem = window.zion?.state?.get("sessions.indexMem");
    if (Array.isArray(mem)) return mem;
  } catch {}
  return [];
}
function flattenTree(tree) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.type === "session") {
      const meta = loadMeta(node.id);
      out.push({
        id: node.id,
        title: node.title ?? meta?.title ?? node.id,
        updatedAt: meta?.updatedAt ?? 0,
        size: meta?.size ?? 0,
        hash: meta?.hash ?? "",
        createdAt: meta?.createdAt ?? 0
      });
    } else if (node.type === "folder" && Array.isArray(node.children)) {
      node.children.forEach(walk);
    }
  };
  walk(tree);
  return out;
}
function getIndex() {
  // prefer memory-cached index (preloaded or maintained), else rebuild from tree (best effort)
  try {
    const mem = window.zion?.state?.get("sessions.indexMem");
    if (Array.isArray(mem)) return mem;
  } catch {}
  const tree = loadTree();
  if (tree) return flattenTree(tree);
  return getIndexLegacy();
}
function setIndex(list) {
  (async () => {
    try {
      await idbSetKV("index", list);
    } catch (e) {
      warnStorageIssue("setIndex", e);
    } finally {
      try { window.zion?.state?.set("sessions.indexMem", list); } catch {}
    }
  })();
}
function rebuildIndexFromTree() {
  const tree = loadTree();
  if (!tree) return;
  const flat = flattenTree(tree);
  setIndex(flat);
}
function getSessionIdFromURL() {
  try {
    const url = new URL(window.location.href);
    const q = url.searchParams.get(URL_SESSION) || url.searchParams.get(URL_SESSION_ALT);
    if (q) return String(q);
    const hash = (url.hash || "").replace(/^#/, "");
    if (!hash) return null;
    const hp = new window.URLSearchParams(hash.startsWith("?") ? hash.slice(1) : hash);
    const h = hp.get(URL_SESSION) || hp.get(URL_SESSION_ALT);
    return h ? String(h) : null;
  } catch {
    return null;
  }
}
function setSessionIdToURL(id, opts) {
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set(URL_SESSION, String(id));
    else url.searchParams.delete(URL_SESSION);
    const next = url.toString();
    const push = !!opts?.push;
    const st = { ...(window.history.state || {}), zionSessionId: id || null };
    if (push) window.history.pushState(st, "", next);
    else window.history.replaceState(st, "", next);
  } catch {}
}
function buildSessionURL(id) {
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set(URL_SESSION, String(id));
    else url.searchParams.delete(URL_SESSION);
    url.searchParams.delete(URL_SESSION_ALT);
    return url.toString();
  } catch {
    return window.location.href;
  }
}
function getLastActiveId() {
  const fromUrl = getSessionIdFromURL();
  if (fromUrl) return fromUrl;
  return localStorage.getItem(LS_LAST) || null;
}
function setLastActiveId(id, opts) {
  try { setSessionIdToURL(id, opts); } catch {}
  try { localStorage.setItem(LS_LAST, id); } catch {}
}

/** ========== Tree helpers ========== */
function ensureInitialTree() {
  let tree = loadTree();
  if (tree) return tree;

  // fallback: build from legacy index or autosave
  let legacy = getIndexLegacy();
  if (legacy.length === 0) {
    // create initial session from autosave or empty
    const cached = localStorage.getItem(LS_AUTO) || "";
    const id = genId();
    const doc = cached || "";
    const derived = deriveTitleFromText(doc);
    const title = derived || "Session 1";
    const meta = {
      id,
      title,
      createdAt: now(),
      updatedAt: now(),
      size: doc.length,
      hash: hashString(doc),
      titleAuto: true
    };
    saveDoc(id, doc);
    saveMeta(id, meta);
    legacy = [{ id, title, updatedAt: meta.updatedAt, size: meta.size, hash: meta.hash, createdAt: meta.createdAt }];
    setIndex(legacy);
    setLastActiveId(id);
  }

  tree = {
    id: "root",
    type: "folder",
    title: "Sessions",
    children: legacy.map(it => ({ id: it.id, type: "session", title: it.title }))
  };
  saveTree(tree);
  return tree;
}
function isFolder(node) { return node && node.type === "folder"; }
function isSession(node) { return node && node.type === "session"; }
function findNodeAndParent(root, id) {
  let found = null, parent = null;
  const dfs = (node, p) => {
    if (!node) return;
    if (node.id === id) { found = node; parent = p; return; }
    if (isFolder(node) && Array.isArray(node.children)) {
      for (const ch of node.children) {
        dfs(ch, node);
        if (found) return;
      }
    }
  };
  dfs(root, null);
  return { node: found, parent };
}
function insertFolder(parentId, title) {
  const tree = loadTree() || ensureInitialTree();
  const { node: p } = parentId ? findNodeAndParent(tree, parentId) : { node: tree };
  const parent = p && isFolder(p) ? p : tree;
  const id = "fld_" + genId();
  const n = { id, type: "folder", title: title || "New Folder", children: [] };
  parent.children = parent.children || [];
  parent.children.unshift(n);
  saveTree(tree);
  try {
    rebuildIndexFromTree();
    try { window.zion.state.set("sessions.catalog", getIndex()); } catch {}
    console.info("[sessions] insertFolder:", { folderId: id, parentId: parent.id, title: n.title });
  } catch (e) {
    console.error("[sessions] insertFolder failed to rebuild index:", e);
  }
  return id;
}
function insertSessionNode(sessionId, parentId, title) {
  const tree = loadTree() || ensureInitialTree();
  const { node: p } = parentId ? findNodeAndParent(tree, parentId) : { node: tree };
  const parent = p && isFolder(p) ? p : tree;
  const n = { id: sessionId, type: "session", title: title || sessionId };
  parent.children = parent.children || [];
  parent.children.unshift(n);
  saveTree(tree);
  try {
    rebuildIndexFromTree();
    try { window.zion.state.set("sessions.catalog", getIndex()); } catch {}
    console.info("[sessions] insertSessionNode:", { sessionId, parentId: parent.id, title: n.title });
  } catch (e) {
    console.error("[sessions] insertSessionNode failed to rebuild index:", e);
  }
}
function removeNode(nodeId) {
  const tree = loadTree();
  if (!tree) return false;
  const { node, parent } = findNodeAndParent(tree, nodeId);
  if (!node || !parent || !Array.isArray(parent.children)) return false;
  parent.children = parent.children.filter(c => c.id !== nodeId);
  saveTree(tree);
  return true;
}
function removeNodeRecursive(nodeId) {
  const tree = loadTree();
  if (!tree) return false;
  const { node, parent } = findNodeAndParent(tree, nodeId);
  if (!node || !parent || !Array.isArray(parent.children)) return false;

  const collectSessions = (n) => {
    if (isSession(n)) return [n.id];
    if (isFolder(n)) {
      return (n.children || []).flatMap(collectSessions);
    }
    return [];
  };
  const ids = collectSessions(node);
  // remove docs/metas for all sessions in subtree
  for (const sid of ids) {
    try { localStorage.removeItem(docKey(sid)); } catch {}
    try { localStorage.removeItem(metaKey(sid)); } catch {}
    // clear memory mirrors as well
    try { window.zion?.state?.set(`sessions.doc.${sid}`, undefined); } catch {}
    try { window.zion?.state?.set(`sessions.meta.${sid}`, undefined); } catch {}
  }
  // detach subtree
  parent.children = parent.children.filter(c => c.id !== nodeId);
  saveTree(tree);
  rebuildIndexFromTree();
  // adjust last active if needed
  const last = getLastActiveId();
  if (last && ids.includes(last)) {
    const flat = getIndex();
    const next = flat[0]?.id || null;
    if (next) setLastActiveId(next);
  }
  return true;
}

/** Move a node (session or folder) under a target folder. Prevent moving into itself/descendant. */
function moveNode(nodeId, targetFolderId) {
  const tree = loadTree() || ensureInitialTree();
  if (!tree) return false;
  if (!nodeId || !targetFolderId) return false;
  if (nodeId === "root") return false; // cannot move root

  const { node, parent } = findNodeAndParent(tree, nodeId);
  const { node: target } = findNodeAndParent(tree, targetFolderId);
  const dest = target && isFolder(target) ? target : tree;
  if (!node || !dest) return false;

  // prevent moving a folder into itself or its descendant
  const isDescendant = (n, id) => {
    if (!n) return false;
    if (n.id === id) return true;
    if (isFolder(n)) {
      for (const ch of (n.children || [])) {
        if (isDescendant(ch, id)) return true;
      }
    }
    return false;
  };
  if (isFolder(node)) {
    if (node.id === dest.id) return false;
    if (isDescendant(node, dest.id)) return false;
  }

  // detach from old parent
  if (parent && Array.isArray(parent.children)) {
    parent.children = parent.children.filter(c => c.id !== nodeId);
  } else {
    // no valid parent (shouldn't happen)
    return false;
  }

  // attach to dest folder (prepend)
  dest.children = dest.children || [];
  dest.children.unshift(node);

  saveTree(tree);
  rebuildIndexFromTree();
  return true;
}

/** folder open state */
function getFolderOpenMap() {
  const raw = localStorage.getItem(LS_FOLDER_OPEN);
  const m = safeJSONParse(raw || "{}", {});
  return typeof m === "object" && m ? m : {};
}
function setFolderOpen(id, open) {
  const m = getFolderOpenMap();
  m[id] = !!open;
  try { localStorage.setItem(LS_FOLDER_OPEN, JSON.stringify(m)); } catch {}
}
function isFolderOpen(id) {
  const m = getFolderOpenMap();
  const v = m[id];
  if (typeof v === "boolean") return v;
  // default open for root
  return id === "root";
}

/** ========== Selection helpers (multi-select) ========== */
function getSelection() {
  return window.zion.state.get("sessions.selection") || [];
}
function setSelection(items) {
  window.zion.state.set("sessions.selection", Array.isArray(items) ? items : []);
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
  if (i >= 0) {
    sel.splice(i, 1);
  } else {
    sel.push({ id: node.id, type: node.type || "session" });
  }
  setSelection(sel);
  setLastSelectedId(node.id);
}

// 记录/读取最近一次选择锚点（用于 Shift 连片选择）
function getLastSelectedId() {
  try {
    return window.zion.state.get("sessions.lastSelectedId") || null;
  } catch {
    return null;
  }
}
function setLastSelectedId(id) {
  try {
    window.zion.state.set("sessions.lastSelectedId", id || null);
  } catch {}
}

// Sidebar prefs
function getTabStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return localStorage;
  }
}
function getSidebarPinned() {
  return getTabStorage().getItem(LS_SIDEBAR_PIN) === "1";
}
function setSidebarPinned(v) {
  try { getTabStorage().setItem(LS_SIDEBAR_PIN, v ? "1" : "0"); } catch {}
}
function getSidebarWidth() {
  const raw = localStorage.getItem(LS_SIDEBAR_W);
  const w = parseInt(raw || "300", 10);
  const safe = isNaN(w) ? 300 : w;
  return Math.max(220, Math.min(480, safe));
}
function setSidebarWidth(w) {
  try { localStorage.setItem(LS_SIDEBAR_W, String(w)); } catch {}
}

function docKey(id) { return `zion.session.${id}.doc`; }
function metaKey(id) { return `zion.session.${id}.meta`; }

function loadDoc(id) {
  try {
    const mem = window.zion?.state?.get(`sessions.doc.${id}`);
    if (typeof mem === "string") return mem;
  } catch {}
  // fallback: try IndexedDB (async to sync bridge via default empty + async hydrate)
  // Return empty string immediately; then hydrate memory asynchronously so future reads are hot.
  (async () => {
    try {
      const rec = await idbGet("docs", id);
      const text = rec?.text || "";
      try { window.zion?.state?.set(`sessions.doc.${id}`, text); } catch {}
      // If this session is currently active and editor is empty, populate it once hydrated.
      try {
        const cur = window.zion?.state?.get("sessions.currentId");
        if (cur === id) {
          const ed = window.zion?.window?.activeEditor;
          if (ed) {
            const curText = ed.getValue?.() || "";
            if (!curText) {
              ed.setValue(text);
              try { applyAnnotationsForSession(id); } catch {}
            }
          }
        }
      } catch {}
    } catch (e) {}
  })();
  return "";
}
function saveDoc(id, text) {
  (async () => {
    try {
      await idbSet("docs", { id, text: String(text || "") });
    } catch (e) {
      warnStorageIssue("saveDoc", e);
    } finally {
      try { window.zion?.state?.set(`sessions.doc.${id}`, String(text || "")); } catch {}
    }
  })();
}

/** Async loader for session doc: returns memory if present, else fetches from IDB and caches. */
async function loadDocAsync(id) {
  try {
    const mem = window.zion?.state?.get(`sessions.doc.${id}`);
    if (typeof mem === "string") return mem;
  } catch {}
  try {
    const rec = await idbGet("docs", id);
    const text = rec?.text || "";
    try { window.zion?.state?.set(`sessions.doc.${id}`, text); } catch {}
    return text;
  } catch {
    return "";
  }
}
function loadMeta(id) {
  try {
    const mem = window.zion?.state?.get(`sessions.meta.${id}`);
    if (mem && typeof mem === "object") return mem;
  } catch {}
  // async hydrate from IDB
  (async () => {
    try {
      const rec = await idbGet("metas", id);
      const meta = rec?.meta || { id, title: `Session ${id}`, createdAt: now(), updatedAt: now(), size: 0, hash: "", titleAuto: true };
      try { window.zion?.state?.set(`sessions.meta.${id}`, meta); } catch {}
    } catch {}
  })();
  return { id, title: `Session ${id}`, createdAt: now(), updatedAt: now(), size: 0, hash: "", titleAuto: true };
}
function saveMeta(id, meta) {
  (async () => {
    try {
      await idbSet("metas", { id, meta });
    } catch (e) {
      warnStorageIssue("saveMeta", e);
    } finally {
      try { window.zion?.state?.set(`sessions.meta.${id}`, meta); } catch {}
    }
  })();
}

// Persisted annotations helpers
function getAnnotationsState(id) {
  try {
    return window.zion?.state?.get(`sessions.annotations.${id}`) || null;
  } catch {
    return null;
  }
}

/** Persist current session's annotations into meta.storage (for refresh/sleep lifecycle) */
function persistCurrentAnnotations() {
  try {
    const id = window.zion?.state?.get("sessions.currentId");
    if (!id) return;
    const meta = loadMeta(id);
    const ann = getAnnotationsState(id) || meta.annotations;
    if (ann) {
      meta.annotations = ann;
      saveMeta(id, meta);
    }
  } catch (e) {
    console.warn("[sessions] persistCurrentAnnotations error:", e);
  }
}

/** Attach page lifecycle listeners to persist annotations before unload/hidden */
function attachLifecyclePersistence(ctx) {
  try {
    const handler = () => {
      try { persistCurrentAnnotations(); } catch {}
    };
    const visHandler = () => {
      try { if (document.hidden) handler(); } catch {}
    };
    window.addEventListener("beforeunload", handler);
    window.addEventListener("pagehide", handler);
    document.addEventListener("visibilitychange", visHandler);
    // cleanup on deactivate
    ctx.subscriptions.push({
      dispose() {
        try { window.removeEventListener("beforeunload", handler); } catch {}
        try { window.removeEventListener("pagehide", handler); } catch {}
        try { document.removeEventListener("visibilitychange", visHandler); } catch {}
      }
    });
  } catch (e) {
    console.warn("[sessions] attachLifecyclePersistence error:", e);
  }
}

function attachAnnotationsAutoPersistence(ctx) {
  let curId = null;
  let dispAnn = null;
  let dispCur = null;
  let timer = null;
  let lastJson = "";

  const clearTimer = () => {
    if (timer) {
      try { clearTimeout(timer); } catch {}
      timer = null;
    }
  };

  const persist = async (id) => {
    try {
      const ann = getAnnotationsState(id);
      if (!ann) return;
      let json = "";
      try { json = JSON.stringify(ann); } catch { json = ""; }
      if (json && json === lastJson) return;
      if (json) lastJson = json;

      let meta = null;
      try {
        const mem = window.zion?.state?.get(`sessions.meta.${id}`);
        if (mem && typeof mem === "object") meta = mem;
      } catch {}

      if (!meta || typeof meta !== "object") {
        try {
          const rec = await idbGet("metas", id);
          if (rec && rec.meta && typeof rec.meta === "object") meta = rec.meta;
        } catch {}
      }

      if (!meta || typeof meta !== "object") {
        meta = { id, title: `Session ${id}`, createdAt: now(), updatedAt: now(), size: 0, hash: "", titleAuto: true };
      } else {
        meta = { ...meta };
      }

      meta.annotations = ann;
      meta.updatedAt = now();
      saveMeta(id, meta);
    } catch (e) {
      try { console.warn("[sessions] auto persist annotations error:", e); } catch {}
    }
  };

  const schedule = (id) => {
    if (!id) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      persist(id);
    }, 800);
  };

  const setWatch = (id) => {
    if (id === curId) return;
    curId = id || null;
    lastJson = "";
    try { dispAnn?.dispose?.(); } catch {}
    dispAnn = null;
    if (!curId) return;
    try {
      dispAnn = window.zion.state.onDidChange(`sessions.annotations.${curId}`, () => schedule(curId));
    } catch {
      dispAnn = null;
    }
    schedule(curId);
  };

  try {
    const initial = window.zion?.state?.get("sessions.currentId");
    setWatch(typeof initial === "string" ? initial : null);
  } catch {}

  try {
    dispCur = window.zion.state.onDidChange("sessions.currentId", (nv, ov) => {
      const prev = typeof ov === "string" ? ov : null;
      if (prev) schedule(prev);
      setWatch(typeof nv === "string" ? nv : null);
    });
  } catch {
    dispCur = null;
  }

  ctx.subscriptions.push({
    dispose() {
      clearTimer();
      try { dispAnn?.dispose?.(); } catch {}
      try { dispCur?.dispose?.(); } catch {}
    }
  });
}

/** Compute assistant block end position in a plain text document. If hintPos provided, use nearest assistant block. */
function findAssistantBlockEndInText(text, hintPos) {
  const src = String(text || "").replace(/\r/g, "");
  const lines = src.split("\n");
  const len = src.length;
  const idxToPos = (lineIdx, ch) => {
    let pos = 0;
    for (let i = 0; i < lineIdx; i++) pos += lines[i].length + 1; // +1 for '\n'
    return pos + ch;
  };

  const isRoleHead = (s) => /^(system|user|assistant|tool)\s+/.test(s);
  const lastAssistantIdx = (() => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*assistant\s+/.test(lines[i])) return i;
    }
    return -1;
  })();

  // derive target assistant head
  let headIdx = lastAssistantIdx;
  if (typeof hintPos === "number") {
    // map hint pos to line index
    let acc = 0;
    let hintLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const next = acc + lines[i].length + 1;
      if (hintPos < next) { hintLine = i; break; }
      acc = next;
    }
    for (let i = hintLine; i >= 0; i--) {
      if (/^\s*assistant\s+/.test(lines[i])) { headIdx = i; break; }
    }
    if (headIdx < 0) headIdx = lastAssistantIdx;
  }
  if (headIdx < 0) return len;

  // scan down until next role head
  let endIdx = headIdx;
  for (let i = headIdx + 1; i < lines.length; i++) {
    if (isRoleHead(lines[i])) break;
    endIdx = i;
  }
  const endLine = endIdx;
  const endCh = lines[endLine].length;
  return idxToPos(endLine, endCh);
}

/**
 * Restore persisted annotations for a session by emitting plugin events.
 * Tool-call cards and thinking cards will rebuild themselves based on saved positions.
 */
function applyAnnotationsForSession(id) {
  try {
    const meta = loadMeta(id);
    const ann = meta?.annotations;
    if (!ann) return;

    try { window.zion?.state?.set(`sessions.annotations.${id}`, ann); } catch {}
    const tools = Array.isArray(ann.tools) ? ann.tools : [];
    const thinking = Array.isArray(ann.thinking) ? ann.thinking : [];
    if (tools.length) {
      try { window.zion?.state?.set(`sessions.pendingRestore.tools.${id}`, tools); } catch {}
      try { window.zion?.events?.emit("toolcards/restore", { items: tools }); } catch {}
    }
    if (thinking.length) {
      try { window.zion?.state?.set(`sessions.pendingRestore.thinking.${id}`, thinking); } catch {}
      try { window.zion?.events?.emit("thinking/restore", { items: thinking }); } catch {}
    }
  } catch (e) {
    console.error("[sessions] apply annotations error:", e);
  }
}

/** 简易 FNV-1a 哈希（32-bit） */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  // 转无符号并十六进制
  return (h >>> 0).toString(16);
}

/** 生成新会话 id（短随机） */
function genId() {
  return Math.random().toString(36).slice(2, 8);
}

/** 取前 max 字符，超出加省略号 */
function truncate(str, max = 30) {
  const s = String(str || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max).trim() + "…";
}

/** 简单清洗 Markdown/前缀符号 */
function sanitizeCandidate(s) {
  let t = String(s || "");
  // 去除行首常见 Markdown 符号与多余空格
  t = t.replace(/^[\s#>*-]+/, "");
  // 去除行内反引号
  t = t.replace(/`+/g, "");
  // 合并空白
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** 按句子分割（支持中英文简单标点） */
function splitSentences(s) {
  const text = String(s || "").trim();
  if (!text) return [];
  const parts = text.split(/(?<=[。！？!?\.])\s+/);
  return parts.map(p => p.trim()).filter(Boolean);
}

/** 从文本派生标题：优先首个非空行，其次首句；截断为 30 字符 */
function deriveTitleFromText(text) {
  const src = String(text || "");
  if (!src.trim()) return null;
  const lines = src.split(/\r?\n/);
  const firstNonEmpty = lines.find(l => String(l).trim().length > 0);
  if (firstNonEmpty) {
    return truncate(sanitizeCandidate(firstNonEmpty));
  }
  const sentences = splitSentences(src);
  if (sentences.length > 0) {
    return truncate(sanitizeCandidate(sentences[0]));
  }
  return null;
}

/** 默认标题判定（用于旧数据或无 titleAuto 字段时的启发式） */
function isDefaultTitle(t) {
  const s = String(t || "");
  return /^Session\b/i.test(s) || /^Imported Session\b/i.test(s);
}

/** 当前是否应自动标题：显式开启时遵循；否则只要标题仍是默认样式（Session/Imported Session）就继续尝试自动派生。 */
function shouldAutoTitle(meta) {
  if (!meta) return false;
  if (meta.titleAuto === true) return true;
  // 即便显式标记为 false，只要还是默认标题，也允许自动派生一次以提升可用性
  if (isDefaultTitle(meta.title)) return true;
  return false;
}

/** 当需要自动标题时，基于文档内容更新会话标题（首个非空行或首句）。同步树与索引，并刷新状态。 */
function maybeUpdateAutoTitle(id) {
  try {
    const meta = loadMeta(id);
    // 优先使用当前编辑器中的最新文本（避免依赖未及时写入的 localStorage）
    let text = "";
    try {
      const curId = window.zion.state.get("sessions.currentId");
      const ed = window.zion.window.activeEditor;
      if (curId === id && ed) {
        text = ed.getValue() || "";
      } else {
        text = loadDoc(id) || "";
      }
    } catch {
      text = loadDoc(id) || "";
    }
    const derived = deriveTitleFromText(text);
    // 仅当仍为“默认标题”或未明确禁用自动标题时执行；派生成功后“锁定”标题（titleAuto=false）
    if (shouldAutoTitle(meta) && derived && derived !== meta.title) {
      meta.title = derived;
      meta.titleAuto = false; // 首次派生后锁定，后续不再自动更新（仅重命名可改变）
      saveMeta(id, meta);
      // 更新树节点标题
      const tree = loadTree() || ensureInitialTree();
      const { node } = findNodeAndParent(tree, id);
      if (node && node.type === "session") {
        node.title = meta.title;
        saveTree(tree);
      }
      // 重建索引并刷新状态
      rebuildIndexFromTree();
      try { window.zion.state.set("sessions.catalog", getIndex()); } catch {}
      try { refreshStatusBar(); } catch {}
      return true;
    }
  } catch {}
  return false;
}

/** 兼容旧逻辑：确保初始树/会话存在 */
function ensureInitialSession() {
  ensureInitialTree();
  const idx = getIndex();
  return idx;
}

/** 从索引查会话条目 */
function findInIndex(id) {
  const index = getIndex();
  return index.find(s => s.id === id) || null;
}

/** 更新索引条目（无则追加） */
function upsertIndexEntry(entry) {
  const idx = getIndex();
  const i = idx.findIndex(s => s.id === entry.id);
  if (i >= 0) {
    idx[i] = { ...idx[i], ...entry };
  } else {
    idx.push(entry);
  }
  setIndex(idx);
  return idx;
}

/** 删除会话（树+索引+doc+meta） */
function deleteSession(id) {
  try { localStorage.removeItem(docKey(id)); } catch {}
  try { localStorage.removeItem(metaKey(id)); } catch {}
  // clear memory mirrors as well
  try { window.zion?.state?.set(`sessions.doc.${id}`, undefined); } catch {}
  try { window.zion?.state?.set(`sessions.meta.${id}`, undefined); } catch {}
  removeNode(id);
  rebuildIndexFromTree();
  const last = getLastActiveId();
  if (last === id) {
    const next = getIndex()[0]?.id || null;
    if (next) setLastActiveId(next);
  }
  return getIndex();
}

/** ========== Broadcast for cross-tab ========== */
let bc = null;
function getChannel() {
  if (bc) return bc;
  try {
    bc = new BroadcastChannel("zion.sessions");
  } catch {
    bc = null;
  }
  return bc;
}
function postSaved(id, updatedAt, hash) {
  const ch = getChannel();
  if (!ch) return;
  try {
    ch.postMessage({ type: "saved", id, updatedAt, hash });
  } catch {}
}

/** ========== Shared List Renderer (Panel & Sidebar) ========== */
function createSessionsListRenderer({ listEl, hostElement, getQuery, getSort, onSwitchSession, onAfterChange }) {
  // Small icon button
  const mkIconBtn = (icon, title, onClick) => {
    const b = document.createElement("button");
    b.innerHTML = icon;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.style.background = "transparent";
    b.style.color = "var(--fg)";
    b.style.border = "none";
    b.style.borderRadius = "6px";
    b.style.padding = "2px";
    b.style.cursor = "pointer";
    b.style.fontSize = "14px";
    b.style.display = "flex";
    b.style.alignItems = "center";
    b.style.transition = "opacity 120ms ease";
    b.className = "zion-session-more-btn";
    b.onclick = onClick;
    return b;
  };

  const render = () => {
    // prevent flicker
    document.body.classList.add("zion-sessions-no-transitions");

    listEl.innerHTML = "";
    if (hostElement) {
      hostElement.classList.toggle("zion-selection-multiple", getSelection().length > 1);
    }
    const query = String(getQuery() || "").trim().toLowerCase();
    const sortBy = (getSort && getSort()) || "updated";

    const tree = loadTree() || ensureInitialTree();
    const visibleOrder = [];

    // restore transitions in next frame
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.body.classList.remove("zion-sessions-no-transitions");
    }));

    const mkRowMenu = (item) => {
      // session row menu
      const menu = document.createElement("div");
      menu.style.position = "absolute";
      menu.style.top = "28px";
      menu.style.right = "0";
      menu.style.background = "var(--panel)";
      menu.style.border = "1px solid var(--border)";
      menu.style.borderRadius = "6px";
      menu.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
      menu.style.padding = "4px 0";
      menu.style.zIndex = "100001";
      menu.style.display = "none";
      menu.style.minWidth = "140px";

      const mkItem = (text, onClick) => {
        const it = document.createElement("div");
        it.textContent = text;
        it.style.padding = "6px 16px";
        it.style.cursor = "pointer";
        it.style.fontSize = "13px";
        it.style.color = "var(--fg)";
        it.onmouseenter = () => { it.style.background = "var(--border)"; };
        it.onmouseleave = () => { it.style.background = "transparent"; };
        it.onclick = () => { menu.style.display = "none"; onClick(); };
        return it;
      };

      menu.appendChild(mkItem("Open in New Tab", () => {
        const u = buildSessionURL(item.id);
        const a = document.createElement("a");
        a.href = u;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.click();
      }));

      menu.appendChild(mkItem("Rename", () => {
        const nv = prompt("Rename session:", item.title || "");
        if (nv && nv.trim()) {
          window.zion.commands.executeCommand("zion.sessions.rename", { id: item.id, title: nv.trim() });
          if (typeof onAfterChange === "function") onAfterChange();
          render();
        }
      }));
      menu.appendChild(mkItem("Clone", () => {
        window.zion.commands.executeCommand("zion.sessions.clone", item.id);
        if (typeof onAfterChange === "function") onAfterChange();
        render();
      }));
      menu.appendChild(mkItem("Export", () => {
        window.zion.commands.executeCommand("zion.sessions.export", item.id);
      }));
      menu.appendChild(mkItem("Delete", () => {
        const ok = confirm(`Delete session "${item.title}"? This cannot be undone.`);
        if (ok) {
          window.zion.commands.executeCommand("zion.sessions.delete", item.id);
          if (typeof onAfterChange === "function") onAfterChange();
          render();
        }
      }));

      return menu;
    };

    const mkFolderMenu = (folder) => {
      const menu = document.createElement("div");
      menu.style.position = "absolute";
      menu.style.top = "28px";
      menu.style.right = "0";
      menu.style.background = "var(--panel)";
      menu.style.border = "1px solid var(--border)";
      menu.style.borderRadius = "6px";
      menu.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
      menu.style.padding = "4px 0";
      menu.style.zIndex = "100001";
      menu.style.display = "none";
      menu.style.minWidth = "160px";

      const mkItem = (text, onClick) => {
        const it = document.createElement("div");
        it.textContent = text;
        it.style.padding = "6px 16px";
        it.style.cursor = "pointer";
        it.style.fontSize = "13px";
        it.style.color = "var(--fg)";
        it.onmouseenter = () => { it.style.background = "var(--border)"; };
        it.onmouseleave = () => { it.style.background = "transparent"; };
        it.onclick = () => { menu.style.display = "none"; onClick(); };
        return it;
      };

      menu.appendChild(mkItem("New Session", () => {
        window.zion.commands.executeCommand("zion.sessions.new", { parentId: folder.id });
        if (typeof onAfterChange === "function") onAfterChange();
        render();
      }));
      menu.appendChild(mkItem("New Folder", () => {
        window.zion.commands.executeCommand("zion.sessions.newFolder", { parentId: folder.id });
        if (typeof onAfterChange === "function") onAfterChange();
        render();
      }));
      menu.appendChild(mkItem("Rename Folder", () => {
        const nv = prompt("Rename folder:", folder.title || "");
        if (nv && nv.trim()) {
          window.zion.commands.executeCommand("zion.sessions.renameFolder", { id: folder.id, title: nv.trim() });
          if (typeof onAfterChange === "function") onAfterChange();
          render();
        }
      }));
      menu.appendChild(mkItem("Export Folder", () => {
        window.zion.commands.executeCommand("zion.sessions.exportFolder", folder.id);
      }));
      menu.appendChild(mkItem("Delete Folder", () => {
        const ok = confirm(`Delete folder "${folder.title}" and all sessions inside? This cannot be undone.`);
        if (ok) {
          window.zion.commands.executeCommand("zion.sessions.deleteFolder", folder.id);
          if (typeof onAfterChange === "function") onAfterChange();
          render();
        }
      }));

      return menu;
    };

    const renderFolder = (folder, depth = 0) => {
      // folder row
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.padding = "8px 10px";
      row.style.gap = "8px";
      row.style.borderRadius = "8px";
      row.style.transition = "background 120ms ease";
      row.style.position = "relative";
      row.className = "zion-session-row";
      row.style.whiteSpace = "nowrap";
      row.style.paddingLeft = `${depth * 12}px`;
      row.dataset.depth = String(depth);
      visibleOrder.push({ id: folder.id, type: "folder" });

      const labelWrap = document.createElement("div");
      labelWrap.style.display = "flex";
      labelWrap.style.alignItems = "center";
      labelWrap.style.gap = "8px";
      labelWrap.style.flex = "1 1 auto";
      labelWrap.style.minWidth = "0";

      const chevron = document.createElement("span");
      chevron.innerHTML = isFolderOpen(folder.id)
        ? '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';
      chevron.style.opacity = "0.8";

      const ttl = document.createElement("span");
      ttl.textContent = folder.title || "Folder";
      ttl.style.fontWeight = "500";
      ttl.style.fontSize = "12px";
      ttl.style.flex = "1 1 auto";
      ttl.style.minWidth = "0";
      ttl.style.whiteSpace = "nowrap";
      ttl.style.overflow = "hidden";
      ttl.style.textOverflow = "ellipsis";

      if (isSelected(folder.id)) row.classList.add("is-selected");

      labelWrap.appendChild(chevron);
      labelWrap.appendChild(ttl);

      const btns = document.createElement("div");
      btns.style.display = "flex";
      btns.style.gap = "4px";
      btns.style.alignItems = "center";
      btns.style.position = "absolute";
      btns.style.right = "8px";
      btns.style.top = "50%";
      btns.style.transform = "translateY(-50%)";

      const bNewSession = mkIconBtn(
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
        "New session here",
        (ev) => {
          ev.stopPropagation();
          window.zion.commands.executeCommand("zion.sessions.new", { parentId: folder.id });
          if (typeof onAfterChange === "function") onAfterChange();
          render();
        }
      );
      const bNewFolder = mkIconBtn(
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h4l1.2 1.5H13a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 11V6a1.5 1.5 0 0 1 1-1.5z" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M11 5.5h1.5M11.75 4.75v1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
        "New folder here",
        (ev) => {
          ev.stopPropagation();
          window.zion.commands.executeCommand("zion.sessions.newFolder", { parentId: folder.id });
          if (typeof onAfterChange === "function") onAfterChange();
          render();
        }
      );

      const bMore = mkIconBtn(
        '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="4" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="12" cy="8" r="1.5" fill="currentColor"/></svg>',
        "Folder actions",
        (ev) => {
          ev.stopPropagation();
          const isOpen = folderMenu.style.display === "block";
          Array.from(listEl.querySelectorAll(".session-row-menu")).forEach(m => m.style.display = "none");
          folderMenu.style.display = isOpen ? "none" : "block";
        }
      );
      const folderMenu = mkFolderMenu(folder);
      folderMenu.className = "session-row-menu";
      row.appendChild(folderMenu);
      row.addEventListener("click", () => { folderMenu.style.display = "none"; });

      // drag folder
      row.setAttribute("draggable", "true");
      row.addEventListener("dragstart", (ev) => {
        try {
          const sel = getSelection();
          let items = sel.length ? sel : [{ id: folder.id, type: "folder" }];
          if (!sel.find(it => it.id === folder.id)) items = [{ id: folder.id, type: "folder" }];
          ev.dataTransfer?.setData("application/zion-nodes", JSON.stringify({ items }));
          if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
          const count = Array.isArray(items) ? items.length : 1;
          const label = count > 1 ? `移动 ${count} 项` : `文件夹: ${truncate(folder.title || "Folder", 16)}`;
          setSmallDragImage(ev, label);
        } catch {}
      });
      row.addEventListener("dragenter", (ev) => { ev.preventDefault(); row.classList.add("is-drop-target"); });
      row.addEventListener("dragover", (ev) => { ev.preventDefault(); row.classList.add("is-drop-target"); });
      row.addEventListener("dragleave", () => { row.classList.remove("is-drop-target"); });
      row.addEventListener("drop", (ev) => {
        ev.preventDefault();
        try {
          const rawMulti = ev.dataTransfer?.getData("application/zion-nodes") || "";
          const rawSingle = ev.dataTransfer?.getData("application/zion-node") || "";
          let items = [];
          if (rawMulti) {
            const payload = JSON.parse(rawMulti);
            items = Array.isArray(payload.items) ? payload.items : [];
          } else if (rawSingle) {
            const payload = JSON.parse(rawSingle);
            if (payload && payload.id) items = [{ id: payload.id, type: payload.type || "session" }];
          }
          let moved = false;
          for (const it of items) {
            if (it.id && it.id !== folder.id) {
              if (moveNode(it.id, folder.id)) moved = true;
            }
          }
          if (moved) {
            window.zion.state.set("sessions.catalog", getIndex());
            render();
            if (typeof onAfterChange === "function") onAfterChange();
          }
        } catch {}
        finally {
          row.classList.remove("is-drop-target");
        }
      });

      btns.appendChild(bNewSession);
      btns.appendChild(bNewFolder);
      btns.appendChild(bMore);
      btns.style.pointerEvents = "none";
      bNewSession.style.opacity = "0";
      bNewFolder.style.opacity = "0";
      bMore.style.opacity = "0";
      row.addEventListener("mouseenter", () => {
        const reserve = (btns.offsetWidth || 0) + 8;
        row.style.paddingRight = reserve + "px";
        btns.style.pointerEvents = "auto";
        bNewSession.style.opacity = "1";
        bNewFolder.style.opacity = "1";
        bMore.style.opacity = "1";
      });
      row.addEventListener("mouseleave", () => {
        row.style.paddingRight = "";
        btns.style.pointerEvents = "none";
        bNewSession.style.opacity = "0";
        bNewFolder.style.opacity = "0";
        bMore.style.opacity = "0";
      });
      row.addEventListener("focus", () => {
        const reserve = (btns.offsetWidth || 0) + 8;
        row.style.paddingRight = reserve + "px";
        btns.style.pointerEvents = "auto";
        bNewSession.style.opacity = "1";
        bNewFolder.style.opacity = "1";
        bMore.style.opacity = "1";
      });
      row.addEventListener("blur", () => {
        row.style.paddingRight = "";
        btns.style.pointerEvents = "none";
        bNewSession.style.opacity = "0";
        bNewFolder.style.opacity = "0";
        bMore.style.opacity = "0";
      });

      row.addEventListener("click", (ev) => {
        if (bMore.contains(ev.target) || folderMenu.contains(ev.target)) return;
        const anchorId = getLastSelectedId();
        if (ev.shiftKey) {
          if (anchorId) {
            const ids = visibleOrder.map(n => n.id);
            const a = ids.indexOf(anchorId);
            const b = ids.indexOf(folder.id);
            if (a !== -1 && b !== -1) {
              const [from, to] = a < b ? [a, b] : [b, a];
              const items = visibleOrder.slice(from, to + 1).map(n => ({ id: n.id, type: n.type || "session" }));
              setSelection(items);
              setLastSelectedId(folder.id);
              render();
              return;
            }
          }
          setSelection([{ id: folder.id, type: "folder" }]);
          setLastSelectedId(folder.id);
          render();
          return;
        }
        if (ev.metaKey || ev.ctrlKey) {
          toggleSelection({ id: folder.id, type: "folder" });
          setLastSelectedId(folder.id);
          render();
          return;
        }
        if (getSelection().length > 1) clearSelection();
        setLastSelectedId(folder.id);
        const open = isFolderOpen(folder.id);
        setFolderOpen(folder.id, !open);
        try { window.zion.state.set("sessions.selectedFolderId", folder.id); } catch {}
        render();
      });

      row.append(labelWrap, btns);
      listEl.appendChild(row);

      if (isFolderOpen(folder.id)) {
        const children = (folder.children || []).slice();

        const matchNode = (n) => (n.title || "").toLowerCase().includes(query);
        const filterTree = (nodes) => {
          const out = [];
          for (const n of nodes) {
            if (n.type === "folder") {
              const sub = filterTree(n.children || []);
              if (matchNode(n) || sub.length > 0) out.push({ ...n, children: sub });
            } else if (n.type === "session") {
              if (matchNode(n)) out.push(n);
            }
          }
          return out;
        };
        const nodes = query ? filterTree(children) : children;

        const sortNodes = (nodes) => {
          const fs = nodes.filter(n => n.type === "folder").sort((a,b) => (a.title||"").localeCompare(b.title||""));
          const ss = nodes.filter(n => n.type === "session").sort((a,b) => {
            if (sortBy === "updated") {
              const am = loadMeta(a.id), bm = loadMeta(b.id);
              return (bm?.updatedAt||0) - (am?.updatedAt||0);
            } else {
              return (a.title||a.id).localeCompare(b.title||b.id);
            }
          });
          return [...fs, ...ss];
        };

        for (const ch of sortNodes(nodes)) {
          if (ch.type === "folder") {
            renderFolder(ch, depth + 1);
          } else {
            // session row
            const srow = document.createElement("div");
            srow.style.display = "flex";
            srow.style.alignItems = "center";
            srow.style.justifyContent = "space-between";
            srow.style.padding = "8px 10px";
            srow.style.gap = "8px";
            srow.style.borderRadius = "8px";
            srow.style.transition = "background 120ms ease";
            srow.tabIndex = 0;
            srow.style.position = "relative";
            srow.className = "zion-session-row";
            srow.style.whiteSpace = "nowrap";
            srow.style.paddingLeft = `${(depth + 1) * 12}px`;
            srow.dataset.depth = String(depth + 1);
            visibleOrder.push({ id: ch.id, type: "session" });

            // drag session
            srow.setAttribute("draggable", "true");
            srow.addEventListener("dragstart", (ev) => {
              try {
                const sel = getSelection();
                let items = sel.length ? sel : [{ id: ch.id, type: "session" }];
                if (!sel.find(it => it.id === ch.id)) items = [{ id: ch.id, type: "session" }];
                ev.dataTransfer?.setData("application/zion-nodes", JSON.stringify({ items }));
                if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
                const count = Array.isArray(items) ? items.length : 1;
                const label = count > 1 ? `移动 ${count} 项` : `会话: ${truncate((ch.title || ch.id), 16)}`;
                setSmallDragImage(ev, label);
              } catch {}
            });

            const labelWrap2 = document.createElement("div");
            labelWrap2.style.display = "flex";
            labelWrap2.style.flexDirection = "column";
            labelWrap2.style.flex = "1 1 auto";
            labelWrap2.style.minWidth = "0";

            const titleLine = document.createElement("span");
            titleLine.style.fontSize = "12px";
            titleLine.style.display = "flex";
            titleLine.style.alignItems = "center";
            titleLine.style.gap = "6px";
            titleLine.style.fontWeight = "500";
            titleLine.style.flex = "1 1 auto";
            titleLine.style.minWidth = "0";

            const curId = window.zion.state.get("sessions.currentId");
            if (ch.id === curId) srow.classList.add("is-current");
            if (isSelected(ch.id)) srow.classList.add("is-selected");

            const ttl2 = document.createElement("span");
            ttl2.textContent = ch.title || ch.id;
            ttl2.style.flex = "1 1 auto";
            ttl2.style.minWidth = "0";
            ttl2.style.whiteSpace = "nowrap";
            ttl2.style.overflow = "hidden";
            ttl2.style.textOverflow = "ellipsis";
            titleLine.appendChild(ttl2);

            const meta = loadMeta(ch.id);
            srow.title = `Updated: ${fmtTime(meta?.updatedAt || now())} · ${meta?.size || 0} chars`;

            labelWrap2.append(titleLine);

            const rightWrap = document.createElement("div");
            rightWrap.style.display = "flex";
            rightWrap.style.gap = "6px";
            rightWrap.style.alignItems = "center";
            rightWrap.style.position = "absolute";
            rightWrap.style.right = "8px";
            rightWrap.style.top = "50%";
            rightWrap.style.transform = "translateY(-50%)";

            const sMenu = mkRowMenu(ch);
            sMenu.className = "session-row-menu";
            srow.appendChild(sMenu);
            srow.addEventListener("click", () => { sMenu.style.display = "none"; });

            const bOpenNewTab = mkIconBtn(
              '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 4H4.5A1.5 1.5 0 0 0 3 5.5v6A1.5 1.5 0 0 0 4.5 13h6A1.5 1.5 0 0 0 12 11.5V10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M9 3h4v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 3L8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
              "Open in new tab",
              (ev) => {
                ev.stopPropagation();
                const u = buildSessionURL(ch.id);
                const a = document.createElement("a");
                a.href = u;
                a.target = "_blank";
                a.rel = "noopener noreferrer";
                a.click();
              }
            );
            bOpenNewTab.style.opacity = "0";

            const bMore2 = mkIconBtn(
              '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="4" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="12" cy="8" r="1.5" fill="currentColor"/></svg>',
              "More actions",
              (ev) => {
                ev.stopPropagation();
                const isOpen = sMenu.style.display === "block";
                Array.from(listEl.querySelectorAll(".session-row-menu")).forEach(m => m.style.display = "none");
                sMenu.style.display = isOpen ? "none" : "block";
              }
            );
            bMore2.style.opacity = "0";

            const rs = window.zion.state.get(`chat.runs.${ch.id}`) || null;
            let statusBadge = null;

            // Compute an opaque background color that visually matches the row background.
            // If the row background is semi-transparent (e.g., sessions highlight), blend with panel.
            const parseColor = (str) => {
              if (!str) return null;
              str = String(str).trim();
              // rgba()/rgb()
              let m = str.match(/^rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
              if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] != null ? +m[4] : 1 };
              // #rrggbb or #rgb
              if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(str)) {
                let hex = str.slice(1);
                if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
                const num = parseInt(hex, 16);
                return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255, a: 1 };
              }
              return null;
            };
            const toRgb = (c) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
            const getPanelColor = () => {
              try {
                const v = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim();
                const parsed = parseColor(v);
                if (parsed) return parsed;
                // allow hex without parsing via computed background
                const bodyBg = getComputedStyle(document.body).backgroundColor;
                return parseColor(bodyBg) || { r: 40, g: 42, b: 54, a: 1 };
              } catch {
                return { r: 40, g: 42, b: 54, a: 1 };
              }
            };
            const blendOverPanel = (fg) => {
              const base = getPanelColor();
              const a = fg.a == null ? 1 : fg.a;
              return {
                r: fg.r * a + base.r * (1 - a),
                g: fg.g * a + base.g * (1 - a),
                b: fg.b * a + base.b * (1 - a),
                a: 1
              };
            };
            const computeOpaqueBg = (rowEl) => {
              try {
                const bg = getComputedStyle(rowEl).backgroundColor;
                if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") {
                  return toRgb(getPanelColor());
                }
                const c = parseColor(bg);
                if (!c) return toRgb(getPanelColor());
                if (c.a == null || c.a >= 1) return `rgb(${c.r}, ${c.g}, ${c.b})`;
                const blended = blendOverPanel(c);
                return toRgb(blended);
              } catch {
                return toRgb(getPanelColor());
              }
            };
            const applyBadgeBg = (el) => {
              try {
                el.style.backgroundColor = computeOpaqueBg(srow);
              } catch {}
            };

            if (rs && (rs.streaming || rs.awaiting)) {
              statusBadge = document.createElement("span");
              statusBadge.className = `zion-session-status-badge ${rs.streaming ? "streaming" : "ready"}`;
              statusBadge.textContent = "●";
              statusBadge.title = rs.streaming ? "Model generating…" : "Answer ready";
              applyBadgeBg(statusBadge);
            }

            rightWrap.appendChild(bOpenNewTab);
            rightWrap.appendChild(bMore2);
            if (statusBadge) rightWrap.appendChild(statusBadge);

            rightWrap.style.pointerEvents = "none";
            srow.addEventListener("mouseenter", () => {
              const reserve = (rightWrap.offsetWidth || 0) + 8;
              srow.style.paddingRight = reserve + "px";
              rightWrap.style.pointerEvents = "auto";
              bOpenNewTab.style.opacity = "1";
              bMore2.style.opacity = "1";
              try { if (statusBadge) applyBadgeBg(statusBadge); } catch {}
            });
            srow.addEventListener("mouseleave", () => {
              srow.style.paddingRight = "";
              rightWrap.style.pointerEvents = "none";
              bOpenNewTab.style.opacity = "0";
              bMore2.style.opacity = "0";
              try { if (statusBadge) applyBadgeBg(statusBadge); } catch {}
            });
            srow.addEventListener("focus", () => {
              const reserve = (rightWrap.offsetWidth || 0) + 8;
              srow.style.paddingRight = reserve + "px";
              rightWrap.style.pointerEvents = "auto";
              bOpenNewTab.style.opacity = "1";
              bMore2.style.opacity = "1";
              try { if (statusBadge) applyBadgeBg(statusBadge); } catch {}
            });
            srow.addEventListener("blur", () => {
              srow.style.paddingRight = "";
              rightWrap.style.pointerEvents = "none";
              bOpenNewTab.style.opacity = "0";
              bMore2.style.opacity = "0";
              try { if (statusBadge) applyBadgeBg(statusBadge); } catch {}
            });

            srow.appendChild(rightWrap);

            srow.addEventListener("keydown", (ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                if (typeof onSwitchSession === "function") onSwitchSession(ch.id);
              } else if (ev.key.toLowerCase() === "r") {
                ev.preventDefault(); sMenu.children[0]?.click();
              } else if (ev.key.toLowerCase() === "c") {
                ev.preventDefault(); sMenu.children[1]?.click();
              } else if (ev.key.toLowerCase() === "e") {
                ev.preventDefault(); sMenu.children[2]?.click();
              } else if (ev.key === "Delete" || ev.key === "Backspace") {
                ev.preventDefault();
                const sel = getSelection();
                if (sel.length > 1) {
                  window.zion.commands.executeCommand("zion.sessions.deleteSelected");
                } else {
                  sMenu.children[3]?.click();
                }
                if (typeof onAfterChange === "function") onAfterChange();
                render();
              }
            });

            srow.addEventListener("click", (ev) => {
              if (bOpenNewTab.contains(ev.target) || bMore2.contains(ev.target) || sMenu.contains(ev.target)) return;
              const anchorId = getLastSelectedId();
              if (ev.shiftKey) {
                if (anchorId) {
                  const ids = visibleOrder.map(n => n.id);
                  const a = ids.indexOf(anchorId);
                  const b = ids.indexOf(ch.id);
                  if (a !== -1 && b !== -1) {
                    const [from, to] = a < b ? [a, b] : [b, a];
                    const items = visibleOrder.slice(from, to + 1).map(n => ({ id: n.id, type: n.type || "session" }));
                    setSelection(items);
                    setLastSelectedId(ch.id);
                    render();
                    return;
                  }
                }
                setSelection([{ id: ch.id, type: "session" }]);
                setLastSelectedId(ch.id);
                render();
                return;
              }
              if (ev.metaKey || ev.ctrlKey) {
                toggleSelection({ id: ch.id, type: "session" });
                setLastSelectedId(ch.id);
                render();
                return;
              }
              setSelection([{ id: ch.id, type: "session" }]);
              setLastSelectedId(ch.id);
              if (typeof onSwitchSession === "function") onSwitchSession(ch.id);
            });

            srow.append(labelWrap2);
            listEl.appendChild(srow);
            // 追加到 DOM 后再计算一次徽标背景，确保读取到最终的行背景（含选中/当前状态）
            try { if (statusBadge) requestAnimationFrame(() => requestAnimationFrame(() => applyBadgeBg(statusBadge))); } catch {}
          }
        }
      }
    };

    const root = tree;
    if (!root || !Array.isArray(root.children) || root.children.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = query ? "No sessions match your search." : "No sessions yet.";
      empty.style.opacity = "0.8";
      empty.style.fontSize = "12px";
      empty.style.padding = "8px 4px";
      listEl.appendChild(empty);
      return;
    }
    renderFolder(root, 0);
  };

  return render;
}

/** ========== UI Panel ========== */
function openSessionsPanel() {
  try {
    const existing = document.getElementById("zion-sessions-panel-overlay");
    if (existing) existing.remove();

    // Overlay
    const overlay = document.createElement("div");
    overlay.id = "zion-sessions-panel-overlay";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.35)";
    overlay.style.zIndex = "99998";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    // Panel
    const panel = document.createElement("div");
    panel.className = "zion-sessions-panel-content";
    panel.style.position = "fixed";
    panel.style.right = "20px";
    panel.style.top = "60px";
    panel.style.width = "380px";
    panel.style.maxHeight = "65vh";
    panel.style.overflow = "auto";
    panel.style.background = "var(--panel)";
    panel.style.border = "1px solid var(--border)";
    panel.style.borderRadius = "8px";
    panel.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";
    panel.style.padding = "10px";
    panel.style.zIndex = "99999";
    panel.style.color = "var(--fg)";
    panel.onclick = (e) => e.stopPropagation();

    // Header with title, count and close
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.marginBottom = "8px";

    const titleWrap = document.createElement("div");
    titleWrap.style.display = "flex";
    titleWrap.style.alignItems = "center";
    titleWrap.style.gap = "8px";

    const title = document.createElement("div");
    title.textContent = "Sessions";
    title.style.fontWeight = "500";
    title.style.fontSize = "12px";

    const count = document.createElement("span");
    const total = getIndex().length;
    count.textContent = `(${total})`;
    count.style.opacity = "0.8";
    count.style.fontSize = "12px";

    titleWrap.appendChild(title);
    titleWrap.appendChild(count);

    const closeBtn = document.createElement("button");
    closeBtn.setAttribute("aria-label", "Close sessions panel");
    closeBtn.title = "Close";
    closeBtn.textContent = "×";
    closeBtn.style.background = "transparent";
    closeBtn.style.color = "var(--fg)";
    closeBtn.style.border = "none";
    closeBtn.style.borderRadius = "6px";
    closeBtn.style.padding = "2px 6px";
    closeBtn.style.cursor = "pointer";
    closeBtn.style.fontSize = "14px";
    closeBtn.onmouseenter = () => { closeBtn.style.background = "var(--border)"; };
    closeBtn.onmouseleave = () => { closeBtn.style.background = "transparent"; };
    closeBtn.onclick = () => overlay.remove();

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Controls: search, sort, actions (合并为下拉菜单)
    const controls = document.createElement("div");
    controls.style.display = "grid";
    controls.style.gridTemplateColumns = "1fr auto auto";
    controls.style.gap = "6px";
    controls.style.marginBottom = "8px";

    // 搜索框
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search by title…";
    searchInput.setAttribute("aria-label", "Search sessions by title");
    searchInput.style.background = "var(--panel)";
    searchInput.style.color = "var(--fg)";
    searchInput.style.border = "1px solid var(--border)";
    searchInput.style.borderRadius = "6px";
    searchInput.style.padding = "6px 8px";
    searchInput.style.fontSize = "12px";

    // 排序下拉
    const sortSelect = document.createElement("select");
    sortSelect.setAttribute("aria-label", "Sort sessions");
    sortSelect.title = "Sort";
    sortSelect.style.background = "var(--panel)";
    sortSelect.style.color = "var(--fg)";
    sortSelect.style.border = "1px solid var(--border)";
    sortSelect.style.borderRadius = "4px";
    sortSelect.style.padding = "2px 6px";
    sortSelect.style.fontSize = "11px";
    sortSelect.style.minWidth = "48px";
    sortSelect.style.width = "auto";
    const optUpdated = document.createElement("option");
    optUpdated.value = "updated";
    optUpdated.textContent = "🕒";
    optUpdated.title = "Sort by updated (newest first)";
    const optTitle = document.createElement("option");
    optTitle.value = "title";
    optTitle.textContent = "Aa";
    optTitle.title = "Sort by title (A→Z)";
    sortSelect.append(optUpdated, optTitle);

    // 操作下拉按钮（三点图标）
    const actions = document.createElement("div");
    actions.style.position = "relative";
    const actionBtn = document.createElement("button");
    actionBtn.innerHTML = "&#x22EE;"; // 三点竖排
    actionBtn.title = "More actions";
    actionBtn.setAttribute("aria-label", "More actions");
    actionBtn.style.background = "transparent";
    actionBtn.style.color = "var(--fg)";
    actionBtn.style.border = "none";
    actionBtn.style.borderRadius = "6px";
    actionBtn.style.padding = "2px";
    actionBtn.style.cursor = "pointer";
    actionBtn.style.fontSize = "14px";
    actionBtn.style.width = "24px";
    actionBtn.style.height = "24px";
    actionBtn.style.display = "flex";
    actionBtn.style.alignItems = "center";
    actionBtn.style.justifyContent = "center";
    actionBtn.onmouseenter = () => { actionBtn.style.background = "var(--border)"; };
    actionBtn.onmouseleave = () => { actionBtn.style.background = "transparent"; };

    // 下拉菜单
    const menu = document.createElement("div");
    menu.style.position = "absolute";
    menu.style.top = "36px";
    menu.style.right = "0";
    menu.style.background = "var(--panel)";
    menu.style.border = "1px solid var(--border)";
    menu.style.borderRadius = "6px";
    menu.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
    menu.style.padding = "4px 0";
    menu.style.zIndex = "100000";
    menu.style.display = "none";
    menu.style.minWidth = "120px";

    const mkMenuItem = (text, onClick) => {
      const item = document.createElement("div");
      item.textContent = text;
      item.style.padding = "6px 16px";
      item.style.cursor = "pointer";
      item.style.fontSize = "13px";
      item.style.color = "var(--fg)";
      item.onmouseenter = () => { item.style.background = "var(--border)"; };
      item.onmouseleave = () => { item.style.background = "transparent"; };
      item.onclick = () => { menu.style.display = "none"; onClick(); };
      return item;
    };

    menu.appendChild(mkMenuItem("New Session", () => {
      const selFolder = window.zion.state.get("sessions.selectedFolderId") || "root";
      window.zion.commands.executeCommand("zion.sessions.new", { parentId: selFolder });
      setTimeout(() => { overlay.remove(); openSessionsPanel(); }, 30);
    }));
    menu.appendChild(mkMenuItem("New Folder", () => {
      const selFolder = window.zion.state.get("sessions.selectedFolderId") || "root";
      window.zion.commands.executeCommand("zion.sessions.newFolder", { parentId: selFolder });
      setTimeout(() => { overlay.remove(); openSessionsPanel(); }, 30);
    }));
    menu.appendChild(mkMenuItem("Import Sessions", () => {
      window.zion.commands.executeCommand("zion.sessions.import");
      setTimeout(() => { overlay.remove(); openSessionsPanel(); }, 300);
    }));
    menu.appendChild(mkMenuItem("Export All Sessions", () => {
      window.zion.commands.executeCommand("zion.sessions.export");
    }));
    menu.appendChild(mkMenuItem("Export Selected", () => {
      window.zion.commands.executeCommand("zion.sessions.exportSelected");
    }));
    menu.appendChild(mkMenuItem("Delete Selected", () => {
      window.zion.commands.executeCommand("zion.sessions.deleteSelected");
      setTimeout(() => { overlay.remove(); openSessionsPanel(); }, 30);
    }));

    actionBtn.onclick = (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === "none" ? "block" : "none";
    };
    actions.appendChild(actionBtn);
    actions.appendChild(menu);

    // 点击面板其他区域关闭菜单
    panel.addEventListener("click", () => { menu.style.display = "none"; });

    controls.append(searchInput, sortSelect, actions);
    panel.appendChild(controls);

    // List container
    const list = document.createElement("div");
    panel.appendChild(list);

    const render = createSessionsListRenderer({
      listEl: list,
      hostElement: panel,
      getQuery: () => (searchInput.value || "").trim().toLowerCase(),
      getSort: () => sortSelect.value || "updated",
      onSwitchSession: (id) => {
        window.zion.commands.executeCommand("zion.sessions.switch", id);
        setTimeout(() => { overlay.remove(); }, 30);
      },
      onAfterChange: () => {
        try { mountSessionsSidebar(); } catch {}
        count.textContent = `(${getIndex().length})`;
      }
    });

    // react to search/sort changes
    searchInput.addEventListener("input", () => render());
    sortSelect.addEventListener("change", () => render());

    // initial render
    render();

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  } catch (e) {
    console.error("[sessions] open panel error:", e);
  }
}

// Helper: refresh Sessions overlay panel if currently open
function refreshSessionsOverlayIfOpen() {
  try {
    const overlay = document.getElementById("zion-sessions-panel-overlay");
    if (overlay) {
      overlay.remove();
      openSessionsPanel();
    }
  } catch {}
}

 // ========== Sidebar (left) ==========
function mountSessionsSidebar() {
  try {
    let bar = document.getElementById("zion-sessions-sidebar");
    const width = getSidebarWidth();
    const pinned = getSidebarPinned();
    // preserve current scrollTop before clearing
    let prevScroll = 0;
    if (bar) {
      try {
        const prevList = bar.querySelector(".zion-sessions-list");
        if (prevList) prevScroll = prevList.scrollTop || 0;
      } catch {}
    }

    if (!bar) {
      bar = document.createElement("div");
      bar.id = "zion-sessions-sidebar";
      bar.style.position = "fixed";
      bar.style.left = "0";
      bar.style.top = "0";
      bar.style.bottom = "0";
      bar.style.width = width + "px";
      bar.style.background = "var(--panel)";
      bar.style.borderRight = "1px solid var(--border)";
      bar.style.color = "var(--fg)";
      bar.style.zIndex = "99990";
      bar.style.display = pinned ? "flex" : "none";
      bar.style.flexDirection = "column";
      // bar.style.boxShadow = "2px 0 12px rgba(0,0,0,0.2)";
      bar.style.overflow = "hidden";
      document.body.appendChild(bar);
    } else {
      bar.style.width = width + "px";
      bar.innerHTML = "";
      bar.style.display = pinned ? "flex" : "none";
    }

    // layout shift when pinned
    document.body.style.marginLeft = pinned ? width + "px" : "";

    // Header
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.padding = "8px 10px";
    // header.style.borderBottom = "1px solid var(--border)";

    const titleWrap = document.createElement("div");
    titleWrap.style.display = "flex";
    titleWrap.style.alignItems = "center";
    titleWrap.style.gap = "8px";

    const title = document.createElement("div");
    title.textContent = "Sessions";
    title.style.fontWeight = "500";
    title.style.fontSize = "12px";

    const count = document.createElement("span");
    const total = getIndex().length;
    count.textContent = `(${total})`;
    count.style.opacity = "0.8";
    count.style.fontSize = "12px";

    titleWrap.appendChild(title);
    titleWrap.appendChild(count);

    const controlsRight = document.createElement("div");
    controlsRight.style.display = "flex";
    controlsRight.style.gap = "6px";

    const pinBtn = document.createElement("button");
    const ICON_SHOW = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1.5 8s2.5-4.5 6.5-4.5 6.5 4.5 6.5 4.5-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.2"/></svg>';
    const ICON_HIDE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1.5 8s2.5-4.5 6.5-4.5 6.5 4.5 6.5 4.5-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" stroke="currentColor" stroke-width="1.2"/><line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" stroke-width="1.2"/></svg>';
    pinBtn.innerHTML = pinned ? ICON_HIDE : ICON_SHOW;
    pinBtn.title = pinned ? "Hide sidebar" : "Show sidebar";
    pinBtn.setAttribute("aria-label", pinBtn.title);
    pinBtn.style.background = "transparent";
    pinBtn.style.color = "var(--fg)";
    pinBtn.style.border = "none";
    pinBtn.style.borderRadius = "6px";
    pinBtn.style.padding = "2px 6px";
    pinBtn.style.cursor = "pointer";
    pinBtn.style.fontSize = "12px";
    pinBtn.onmouseenter = () => { pinBtn.style.background = "var(--border)"; };
    pinBtn.onmouseleave = () => { pinBtn.style.background = "transparent"; };
    pinBtn.onclick = () => {
      const cur = getSidebarPinned();
      setSidebarPinned(!cur);
      if (!cur) {
        bar.style.display = "flex";
        document.body.style.marginLeft = getSidebarWidth() + "px";
      } else {
        bar.style.display = "none";
        document.body.style.marginLeft = "";
      }
      // refresh icon and label
      pinBtn.innerHTML = !cur ? ICON_HIDE : ICON_SHOW;
      pinBtn.title = !cur ? "Hide sidebar" : "Show sidebar";
      pinBtn.setAttribute("aria-label", pinBtn.title);
    };

    controlsRight.appendChild(pinBtn);

    // Quick new session button (frequent action)
    const newBtn = document.createElement("button");
    const ICON_PLUS = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    newBtn.innerHTML = ICON_PLUS;
    newBtn.title = "Create new session";
    newBtn.setAttribute("aria-label", newBtn.title);
    newBtn.style.background = "transparent";
    newBtn.style.color = "var(--fg)";
    newBtn.style.border = "none";
    newBtn.style.borderRadius = "6px";
    newBtn.style.padding = "2px 6px";
    newBtn.style.cursor = "pointer";
    newBtn.style.fontSize = "12px";
    newBtn.onmouseenter = () => { newBtn.style.background = "var(--border)"; };
    newBtn.onmouseleave = () => { newBtn.style.background = "transparent"; };
    newBtn.onclick = () => {
      window.zion.commands.executeCommand("zion.sessions.new");
    };
    controlsRight.appendChild(newBtn);

    // Header actions (move the compact actions/menu here so it won't be clipped in narrow sidebar)
    const headerActions = document.createElement("div");
    headerActions.style.position = "relative";
    headerActions.style.display = "flex";
    headerActions.style.alignItems = "center";

    const headerActionBtn = document.createElement("button");
    headerActionBtn.innerHTML = "&#x22EE;"; // vertical ellipsis
    headerActionBtn.title = "Actions";
    headerActionBtn.setAttribute("aria-label", "Actions");
    headerActionBtn.style.background = "transparent";
    headerActionBtn.style.color = "var(--fg)";
    headerActionBtn.style.border = "none";
    headerActionBtn.style.borderRadius = "6px";
    headerActionBtn.style.padding = "2px";
    headerActionBtn.style.cursor = "pointer";
    headerActionBtn.style.fontSize = "14px";
    headerActionBtn.style.width = "24px";
    headerActionBtn.style.height = "24px";
    headerActionBtn.style.display = "flex";
    headerActionBtn.style.alignItems = "center";
    headerActionBtn.style.justifyContent = "center";
    headerActionBtn.onmouseenter = () => { headerActionBtn.style.background = "var(--border)"; };
    headerActionBtn.onmouseleave = () => { headerActionBtn.style.background = "transparent"; };

    const headerMenu = document.createElement("div");
    headerMenu.style.position = "absolute";
    headerMenu.style.top = "36px";
    headerMenu.style.right = "0";
    headerMenu.style.background = "var(--panel)";
    headerMenu.style.border = "1px solid var(--border)";
    headerMenu.style.borderRadius = "6px";
    headerMenu.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
    headerMenu.style.padding = "4px 0";
    headerMenu.style.zIndex = "100000";
    headerMenu.style.display = "none";
    headerMenu.style.minWidth = "140px";

    const mkHeaderMenuItem = (text, onClick) => {
      const item = document.createElement("div");
      item.textContent = text;
      item.style.padding = "6px 16px";
      item.style.cursor = "pointer";
      item.style.fontSize = "13px";
      item.style.color = "var(--fg)";
      item.onmouseenter = () => { item.style.background = "var(--border)"; };
      item.onmouseleave = () => { item.style.background = "transparent"; };
      item.onclick = () => { headerMenu.style.display = "none"; onClick(); };
      return item;
    };


    headerMenu.appendChild(mkHeaderMenuItem("Import Sessions", () => {
      window.zion.commands.executeCommand("zion.sessions.import");
    }));
    headerMenu.appendChild(mkHeaderMenuItem("Export All Sessions", () => {
      window.zion.commands.executeCommand("zion.sessions.export");
    }));
    headerMenu.appendChild(mkHeaderMenuItem("Export Selected", () => {
      window.zion.commands.executeCommand("zion.sessions.exportSelected");
    }));
    headerMenu.appendChild(mkHeaderMenuItem("Delete Selected", () => {
      window.zion.commands.executeCommand("zion.sessions.deleteSelected");
    }));

    headerActionBtn.onclick = (e) => {
      e.stopPropagation();
      headerMenu.style.display = headerMenu.style.display === "none" ? "block" : "none";
    };

    headerActions.appendChild(headerActionBtn);
    headerActions.appendChild(headerMenu);
    controlsRight.appendChild(headerActions);

    // clicking inside the bar should hide header menu when appropriate
    bar.addEventListener("click", () => { headerMenu.style.display = "none"; });

    header.appendChild(titleWrap);
    header.appendChild(controlsRight);
    bar.appendChild(header);

    // Top controls (search + sort only; actions moved to header to avoid clipping)
    const controls = document.createElement("div");
    controls.style.display = "grid";
    controls.style.gridTemplateColumns = "1fr auto";
    controls.style.gap = "6px";
    controls.style.padding = "8px 10px";
    // controls.style.borderBottom = "1px solid var(--border)";

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search by title…";
    searchInput.setAttribute("aria-label", "Search sessions by title");
    searchInput.style.background = "var(--panel)";
    searchInput.style.color = "var(--fg)";
    searchInput.style.border = "1px solid var(--border)";
    searchInput.style.borderRadius = "6px";
    searchInput.style.padding = "6px 8px";
    searchInput.style.fontSize = "12px";

    const sortSelect = document.createElement("select");
    sortSelect.setAttribute("aria-label", "Sort sessions");
    sortSelect.title = "Sort";
    sortSelect.style.background = "var(--panel)";
    sortSelect.style.color = "var(--fg)";
    sortSelect.style.border = "1px solid var(--border)";
    sortSelect.style.borderRadius = "4px";
    sortSelect.style.padding = "2px 6px";
    sortSelect.style.fontSize = "11px";
    sortSelect.style.minWidth = "48px";
    sortSelect.style.width = "auto";
    const optUpdated = document.createElement("option");
    optUpdated.value = "updated";
    optUpdated.textContent = "🕒";
    optUpdated.title = "Sort by updated (newest first)";
    const optTitle = document.createElement("option");
    optTitle.value = "title";
    optTitle.textContent = "Aa";
    optTitle.title = "Sort by title (A→Z)";
    sortSelect.append(optUpdated, optTitle);

    controls.append(searchInput, sortSelect);
    bar.appendChild(controls);

    // List container (scroll)
    const listWrap = document.createElement("div");
    listWrap.className = "zion-sessions-list";
    listWrap.style.flex = "1 1 auto";
    listWrap.style.overflow = "auto";
    listWrap.style.padding = "6px 6px";
    const list = document.createElement("div");
    listWrap.appendChild(list);
    bar.appendChild(listWrap);

    const render = createSessionsListRenderer({
      listEl: list,
      hostElement: bar,
      getQuery: () => (searchInput.value || "").trim().toLowerCase(),
      getSort: () => sortSelect.value || "updated",
      onSwitchSession: (id) => {
        window.zion.commands.executeCommand("zion.sessions.switch", id);
      },
      onAfterChange: () => {
        try { mountSessionsSidebar(); } catch {}
      }
    });

    searchInput.addEventListener("input", () => render());
    sortSelect.addEventListener("change", () => render());
    render();
    // restore previous scrollTop after initial render
    try { listWrap.scrollTop = prevScroll; } catch {}

    // Resizer handle
    const resizer = document.createElement("div");
    resizer.style.position = "absolute";
    resizer.style.right = "0";
    resizer.style.top = "0";
    resizer.style.bottom = "0";
    resizer.style.width = "4px";
    resizer.style.cursor = "col-resize";
    resizer.style.background = "transparent";
    resizer.onmouseenter = () => { resizer.style.background = "var(--border)"; };
    resizer.onmouseleave = () => { resizer.style.background = "transparent"; };
    let dragging = false;
    let startX = 0;
    let startW = width;
    resizer.addEventListener("mousedown", (e) => {
      dragging = true;
      startX = e.clientX;
      startW = getSidebarWidth();
      document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const delta = e.clientX - startX;
      const newW = Math.max(220, Math.min(480, startW + delta));
      bar.style.width = newW + "px";
      setSidebarWidth(newW);
      if (getSidebarPinned()) {
        document.body.style.marginLeft = newW + "px";
      }
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
    });
    bar.appendChild(resizer);
  } catch (e) {
    console.error("[sessions] mount sidebar error:", e);
  }
}

/** ========== Page Title ========== */
const DEFAULT_PAGE_TITLE = "Zion Next (CM6) Playground";

let __favSnapshot = null;
let __favDotKey = null;
function snapshotFavicons() {
  if (__favSnapshot) return __favSnapshot;
  try {
    const links = Array.from(document.querySelectorAll('link[rel~="icon"]'));
    __favSnapshot = links.map((el) => ({ el, href: el.getAttribute("href") || "" }));
  } catch {
    __favSnapshot = [];
  }
  return __favSnapshot;
}
function restoreFavicons() {
  try {
    const snap = snapshotFavicons();
    for (const it of snap) {
      try {
        if (!it?.el) continue;
        if (it.href) it.el.setAttribute("href", it.href);
      } catch {}
    }
  } catch {}
}
function getCssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}
function setFaviconDot(color) {
  try {
    const snap = snapshotFavicons();
    let links = snap.map(s => s.el).filter(Boolean);
    if (links.length === 0) {
      const el = document.createElement("link");
      el.setAttribute("rel", "icon");
      document.head.appendChild(el);
      __favSnapshot = [{ el, href: "" }];
      links = [el];
    }

    const d = 64;
    const canvas = document.createElement("canvas");
    canvas.width = d;
    canvas.height = d;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, d, d);
    ctx.beginPath();
    ctx.arc(d / 2, d / 2, d * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = Math.max(2, Math.round(d * 0.05));
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.stroke();

    const url = canvas.toDataURL("image/png");
    for (const el of links) {
      try { el.setAttribute("href", url); } catch {}
    }
  } catch {}
}
function syncFaviconForRunState(sessionId) {
  try {
    const rs = window.zion?.state?.get(`chat.runs.${sessionId}`) || null;
    const streaming = !!rs?.streaming;
    const awaiting = !!rs?.awaiting;
    const aborted = !!rs?.aborted;
    const key = streaming ? "streaming" : (awaiting ? "awaiting" : (aborted ? "aborted" : "idle"));
    if (key === __favDotKey) return;
    __favDotKey = key;
    if (key === "idle") {
      restoreFavicons();
      return;
    }
    const accent = getCssVar("--accent", "#6272a4");
    const ok = getCssVar("--ok", "#50fa7b");
    const theme = (document.documentElement.getAttribute("data-theme") || "").toLowerCase();
    const abortedColor = theme === "light" ? "#dc2626" : "#ff5555";
    const color = key === "streaming" ? accent : (key === "awaiting" ? ok : abortedColor);
    setFaviconDot(color);
  } catch {}
}

function updatePageTitle(id) {
  const sessionId = id || window.zion.state.get("sessions.currentId");
  if (!sessionId) {
    document.title = DEFAULT_PAGE_TITLE;
    try { __favDotKey = null; restoreFavicons(); } catch {}
    return;
  }
  const meta = loadMeta(sessionId);
  const title = meta?.title;
  const base = (!title || isDefaultTitle(title)) ? DEFAULT_PAGE_TITLE : title;
  document.title = base;
  syncFaviconForRunState(sessionId);
}

/** ========== Status Bar ========== */
function refreshStatusBar() {
  const id = window.zion.state.get("sessions.currentId");
  if (!id) return;
  const meta = loadMeta(id);
  window.zion.statusBar.registerItem({
    id: "session.current",
    text: `Session: ${meta.title || id}`,
    tooltip: `Updated: ${fmtTime(meta.updatedAt)}; Size: ${meta.size}`,
    onClick: () => window.zion.commands.executeCommand("zion.sessions.toggleSidebar")
  });
  // 同步页面标题
  updatePageTitle(id);
}

/** ========== CM6 Plugin (auto-save) ========== */
function sessionAutoSavePlugin(getCurrentId, onSaved) {
  let timer = 0;
  let pendingText = null;

  const scheduleSave = (view) => {
    try { if (timer) cancelIdleCallback(timer); } catch {}
    try { if (timer) clearTimeout(timer); } catch {}
    const idle = typeof requestIdleCallback === "function";
    const fn = () => {
      const id = getCurrentId();
      if (!id || pendingText == null) return;
      const text = pendingText;
      pendingText = null;
      // compare hash; avoid updating if no content change
      const meta = loadMeta(id);
      const newHash = hashString(text);
      if (newHash === (meta.hash || "")) {
        return;
      }
      // write
      saveDoc(id, text);
      const rs = window.zion?.state?.get(`chat.runs.${id}`) || null;
      if (rs && rs.streaming) {
        // 流式进行中：仅更新 size/hash，不刷新 updatedAt 与索引，避免列表频繁跳动
        meta.size = text.length;
        meta.hash = newHash;
        // carry persisted annotations (tool cards / thinking cards)
        try {
          const ann = getAnnotationsState(id);
          if (ann) meta.annotations = ann;
        } catch {}
        // 首次自动标题在“切换会话”时处理；此处不再更新标题，也不触发侧边栏刷新
        saveMeta(id, meta);
        try { onSaved(meta); } catch {}
      } else {
        // 正常保存：更新时间与索引
        meta.updatedAt = now();
        meta.size = text.length;
        meta.hash = newHash;
        try {
          const ann = getAnnotationsState(id);
          if (ann) meta.annotations = ann;
        } catch {}
        // 首次自动标题在“切换会话”时处理；此处不再更新标题
        saveMeta(id, meta);
        // 重建索引，保持面板/列表同步
        rebuildIndexFromTree();
        upsertIndexEntry({ id, title: meta.title, updatedAt: meta.updatedAt, size: meta.size, hash: meta.hash, createdAt: meta.createdAt });
        try { postSaved(id, meta.updatedAt, meta.hash); } catch {}
        try { onSaved(meta); } catch {}
      }
    };
    if (idle) {
      timer = requestIdleCallback(fn, { timeout: 1200 });
    } else {
      timer = setTimeout(fn, 600);
    }
  };

  return ViewPlugin.fromClass(class {
    constructor(view) {}
    update(update) {
      if (update.docChanged) {
        pendingText = update.state.doc.toString();
        scheduleSave(update.view);
      }
    }
    destroy() {
      try { if (timer) cancelIdleCallback(timer); } catch {}
      try { if (timer) clearTimeout(timer); } catch {}
    }
  });
}

/** ========== Export / Import ========== */
function download(filename, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function importSessionsFromFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(false);
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = safeJSONParse(String(reader.result), null);
          if (!data) return resolve(false);
          // 支持单个或数组
          const arr = Array.isArray(data) ? data : [data];
          // 导入到当前选中的文件夹（默认 root）
          const parentId = (() => {
            try { return window.zion?.state?.get("sessions.selectedFolderId") || "root"; }
            catch { return "root"; }
          })();

          for (const item of arr) {
            const id = genId();
            const rawTitle = item?.meta?.title ?? item?.title ?? "Imported Session";
            let title = String(rawTitle).trim();
            const doc = item?.doc || "";
            const derived = deriveTitleFromText(doc);
            // 若原始没有显式标题或是默认样式，则派生并标记为自动
            let titleAuto = false;
            if (!item?.meta?.title && (derived || isDefaultTitle(title))) {
              title = derived || title;
              titleAuto = true;
            }
            const meta = {
              id,
              title,
              createdAt: now(),
              updatedAt: now(),
              size: doc.length,
              hash: hashString(doc),
              titleAuto
            };
            saveDoc(id, doc);
            saveMeta(id, meta);
            // 插入到树中，确保树与索引一致
            insertSessionNode(id, parentId, meta.title);
          }
          // 基于树重建索引
          rebuildIndexFromTree();
          resolve(true);
        } catch {
          resolve(false);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  });
}

/** ========== CSS for custom scrollbars ========== */
// Inject custom scrollbar styles to make them appear only when needed and with better styling
function injectScrollbarStyles() {
  try {
    const styleId = "zion-session-manager-scrollbar-styles";
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      /* Custom scrollbar for session list - hide when not scrolling */
      #zion-sessions-sidebar .zion-sessions-list::-webkit-scrollbar,
      #zion-sessions-panel-overlay .zion-sessions-panel-content::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }

      /* Scrollbar track */
      #zion-sessions-sidebar .zion-sessions-list::-webkit-scrollbar-track,
      #zion-sessions-panel-overlay .zion-sessions-panel-content::-webkit-scrollbar-track {
        background: transparent;
        border-radius: 4px;
      }

      /* Scrollbar thumb */
      #zion-sessions-sidebar .zion-sessions-list::-webkit-scrollbar-thumb,
      #zion-sessions-panel-overlay .zion-sessions-panel-content::-webkit-scrollbar-thumb {
        background: transparent;
        border-radius: 4px;
        border: 2px solid transparent;
        background-clip: padding-box;
        transition: background 0.15s ease;
      }

      /* Show scrollbar thumb on hover */
      #zion-sessions-sidebar .zion-sessions-list:hover::-webkit-scrollbar-thumb,
      #zion-sessions-panel-overlay .zion-sessions-panel-content:hover::-webkit-scrollbar-thumb {
        background: var(--border, rgba(128, 128, 128, 0.4));
        background-clip: padding-box;
      }

      /* Hover state for scrollbar thumb */
      #zion-sessions-sidebar .zion-sessions-list::-webkit-scrollbar-thumb:hover,
      #zion-sessions-panel-overlay .zion-sessions-panel-content::-webkit-scrollbar-thumb:hover {
        background: rgba(128, 128, 128, 0.6);
        background-clip: padding-box;
      }

      /* Firefox scrollbar */
      #zion-sessions-sidebar .zion-sessions-list,
      #zion-sessions-panel-overlay .zion-sessions-panel-content {
        scrollbar-width: thin;
        scrollbar-color: transparent transparent;
      }

      #zion-sessions-sidebar .zion-sessions-list:hover,
      #zion-sessions-panel-overlay .zion-sessions-panel-content:hover {
        scrollbar-color: var(--border, rgba(128, 128, 128, 0.4)) transparent;
      }

      /* Scroll container background - ensure clean background */
      #zion-sessions-sidebar .zion-sessions-list {
        background: var(--panel);
      }

      #zion-sessions-panel-overlay .zion-sessions-panel-content {
        background: var(--panel);
      }
    `;
    document.head.appendChild(style);
  } catch (e) {
    console.warn("[sessions] Failed to inject scrollbar styles:", e);
  }
}

/** ========== Activate Extension ========== */
export async function activate(ctx) {
  // Inject custom scrollbar styles
  injectScrollbarStyles();
  // 初始化 IndexedDB 并预载数据/迁移
  await initSessionsStorage();

  // 初始化树/索引/会话
  ensureInitialTree();
  rebuildIndexFromTree();
  // 注册会话相关工具（供大模型使用）
  try { registerSessionTools(); } catch {}
  let currentId = getLastActiveId() || getIndex()[0]?.id || null;
  try {
    if (currentId && !findInIndex(currentId)) {
      currentId = getIndex()[0]?.id || null;
    }
  } catch {}
  if (!currentId) {
    // 没有会话，创建一个空的
    const id = genId();
    const doc = "";
    const title = "Session 1";
    const meta = { id, title, createdAt: now(), updatedAt: now(), size: 0, hash: hashString(doc), titleAuto: true };
    saveDoc(id, doc);
    saveMeta(id, meta);
    upsertIndexEntry({ id, title, updatedAt: meta.updatedAt, size: meta.size, hash: meta.hash, createdAt: meta.createdAt });
    currentId = id;
  }
  setLastActiveId(currentId);
  window.zion.state.set("sessions.currentId", currentId);
  window.zion.state.set("sessions.catalog", getIndex());

  // 初始化页面标题
  updatePageTitle(currentId);

  // 将当前会话内容加载到编辑器
  const ed = window.zion.window.activeEditor;
  if (ed) {
    try {
      const text = await loadDocAsync(currentId);
      ed.setValue(text);
      try { applyAnnotationsForSession(currentId); } catch {}
    } catch (e) {
      console.error("[sessions] setValue error:", e);
    }
  }

  // 注册状态栏项
  refreshStatusBar();

  try {
    const updateTitle = () => {
      try { updatePageTitle(); } catch {}
    };
    let dispRun = null;
    const watchRunKey = (sid) => {
      try { dispRun?.dispose?.(); } catch {}
      if (!sid) { dispRun = null; return; }
      try {
        dispRun = window.zion.state.onDidChange(`chat.runs.${sid}`, () => updateTitle());
      } catch {
        dispRun = null;
      }
    };

    watchRunKey(currentId);

    const dispCur = window.zion.state.onDidChange("sessions.currentId", (nv) => {
      const sid = nv ? String(nv) : null;
      watchRunKey(sid);
      updateTitle();
    });
    const dispStreaming = window.zion.state.onDidChange("chat.streaming", () => updateTitle());
    ctx.subscriptions.push(dispCur, dispStreaming, { dispose() { try { dispRun?.dispose?.(); } catch {} } });
  } catch {}

  // 初始化侧边栏：默认首次启用时固定
  if (getTabStorage().getItem(LS_SIDEBAR_PIN) == null) {
    setSidebarPinned(true);
  }
  try { mountSessionsSidebar(); } catch {}
  // 注册页面生命周期持久化（刷新/隐藏前保存当前会话注解）
  attachLifecyclePersistence(ctx);
  attachAnnotationsAutoPersistence(ctx);

  // 在所有扩展加载完成后，重新应用当前会话的注解（确保相关插件已注册）
  try {
    const dispExtLoaded = window.zion.events.on("extensions:loaded", () => {
      try {
        const cid = window.zion.state.get("sessions.currentId");
        if (cid) applyAnnotationsForSession(cid);
      } catch {}
    });
    ctx.subscriptions.push(dispExtLoaded);
  } catch {}

  // 侧边栏显示/隐藏/切换命令
  const dShowSidebar = window.zion.commands.registerCommand("zion.sessions.showSidebar", () => {
    setSidebarPinned(true);
    document.body.style.marginLeft = getSidebarWidth() + "px";
    try { mountSessionsSidebar(); } catch {}
    return true;
  });
  const dHideSidebar = window.zion.commands.registerCommand("zion.sessions.hideSidebar", () => {
    setSidebarPinned(false);
    document.body.style.marginLeft = "";
    try { mountSessionsSidebar(); } catch {}
    return true;
  });
  const dToggleSidebar = window.zion.commands.registerCommand("zion.sessions.toggleSidebar", () => {
    const pinned = getSidebarPinned();
    setSidebarPinned(!pinned);
    document.body.style.marginLeft = !pinned ? getSidebarWidth() + "px" : "";
    try { mountSessionsSidebar(); } catch {}
    return true;
  });
  ctx.subscriptions.push(dShowSidebar, dHideSidebar, dToggleSidebar);

  // 右键菜单挂载
  try {
    const dispMenu1 = window.zion.menus.register("editor/context", {
      command: "zion.sessions.saveAsNew",
      title: "Save As New Session",
      when: "editorFocus"
    });
    const dispMenu2 = window.zion.menus.register("editor/context", {
      command: "zion.sessions.showPanel",
      title: "Sessions…",
      when: "editorFocus"
    });
    ctx.subscriptions.push(dispMenu1, dispMenu2);
  } catch {}

  // 监听跨标签更新
  try {
    const ch = getChannel();
    if (ch) {
      ch.onmessage = (ev) => {
        const msg = ev?.data;
        if (!msg || msg.type !== "saved") return;
        const cur = window.zion.state.get("sessions.currentId");
        if (msg.id === cur) {
          // 对比哈希；不同则提示
          const meta = loadMeta(cur);
          if (meta.hash !== msg.hash) {
            window.zion.state.set("sessions.externalUpdate", { id: msg.id, updatedAt: msg.updatedAt, hash: msg.hash });
            window.zion.statusBar.registerItem({
              id: "session.externalUpdate",
              text: "⟳",
              tooltip: "This session was updated in another tab. Click to refresh.",
              onClick: () => {
                (async () => {
                  try {
                    const text = await loadDocAsync(cur);
                    const ed2 = window.zion.window.activeEditor;
                    ed2?.setValue(text);
                    try { applyAnnotationsForSession(cur); } catch {}
                    // 清理提示
                    window.zion.state.set("sessions.externalUpdate", null);
                    // 刷新状态
                    refreshStatusBar();
                    try { mountSessionsSidebar(); } catch {}
                  } catch (e) {
                    console.error("[sessions] refresh on external update error:", e);
                  }
                })();
              }
            });
          }
        }
      };
    }
  } catch {}

  // 自动保存插件（通过 Decorator 注入）
  const plugin = sessionAutoSavePlugin(
    () => window.zion.state.get("sessions.currentId"),
    (meta) => {
      // 更新状态与状态栏；仅在非流式状态下刷新侧边栏，避免 hover 闪烁
      window.zion.state.set("sessions.catalog", getIndex());
      refreshStatusBar();
      try {
        const streaming = !!window.zion.state.get("chat.streaming");
        if (!streaming) {
          mountSessionsSidebar();
        }
      } catch {}
    }
  );
  const dispDec = window.zion.editor.registerDecorator({
    id: "dev.session-manager.autosave",
    apply(editor) {
      editor.addVisualExtension(plugin);
      return { dispose() {} };
    }
  });
  ctx.subscriptions.push(dispDec);

  /** ========== Commands ========== */

  // New empty session
  const dNew = window.zion.commands.registerCommand("zion.sessions.new", (opts) => {
    const suggested = `Session ${getIndex().length + 1}`;
    const id = genId();
    const text = String(opts?.content ?? "");
    // title: prefer provided; else derive from content; else fallback suggested
    const derived = deriveTitleFromText(text);
    const explicitTitle = String(opts?.title || "").trim();
    const title = explicitTitle || derived || suggested;
    const meta = {
      id,
      title,
      createdAt: now(),
      updatedAt: now(),
      size: text.length,
      hash: hashString(text),
      titleAuto: !explicitTitle && !!derived
    };
    saveDoc(id, text);
    saveMeta(id, meta);
    const parentId = opts?.parentId || window.zion.state.get("sessions.selectedFolderId") || "root";
    console.info("[sessions] new: creating", { id, parentId, title: meta.title });
    insertSessionNode(id, parentId, meta.title);
    rebuildIndexFromTree();
    setLastActiveId(id, { push: true });
    window.zion.state.set("sessions.currentId", id);
    window.zion.state.set("sessions.catalog", getIndex());
    try {
      const present = !!getIndex().find(s => s.id === id);
      if (!present) {
        console.error("[sessions] new: index missing new session; forcing rebuild", { id, parentId, tree: loadTree() });
        rebuildIndexFromTree();
        window.zion.state.set("sessions.catalog", getIndex());
      }
    } catch (e) {
      console.warn("[sessions] new: verification error", e);
    }
    const ed = window.zion.window.activeEditor;
    ed?.setValue(text);
    try { applyAnnotationsForSession(id); } catch {}
    ed?.focus?.();
    refreshStatusBar();
    try { mountSessionsSidebar(); } catch (e) { console.log("new session failed:", e)}
    postSaved(id, meta.updatedAt, meta.hash);
    // 更新页面标题
    updatePageTitle(id);
  });
  ctx.subscriptions.push(dNew);

  // Save current content as new session
  const dSaveAsNew = window.zion.commands.registerCommand("zion.sessions.saveAsNew", () => {
    const ed = window.zion.window.activeEditor;
    const text = ed?.getValue() || "";
    const suggested = `Session ${getIndex().length + 1}`;
    const rawTitle = prompt("New session title:", suggested) || suggested;
    const prevId = window.zion.state.get("sessions.currentId");
    const id = genId();
    const isManual = rawTitle.trim() !== suggested;
    const meta = { id, title: rawTitle.trim(), createdAt: now(), updatedAt: now(), size: text.length, hash: hashString(text), titleAuto: !isManual };
    try {
      const prevAnn = window.zion?.state?.get(`sessions.annotations.${prevId}`) || loadMeta(prevId)?.annotations;
      if (prevAnn) meta.annotations = prevAnn;
    } catch {}
    saveDoc(id, text);
    saveMeta(id, meta);
    // place in same folder as previous session (default root)
    const tree = loadTree() || ensureInitialTree();
    const { parent } = findNodeAndParent(tree, prevId);
    const parentId = parent?.id || "root";
    insertSessionNode(id, parentId, meta.title);
    rebuildIndexFromTree();
    setLastActiveId(id, { push: true });
    window.zion.state.set("sessions.currentId", id);
    window.zion.state.set("sessions.catalog", getIndex());
    try { applyAnnotationsForSession(id); } catch {}
    refreshStatusBar();
    try { mountSessionsSidebar(); } catch {}
    postSaved(id, meta.updatedAt, meta.hash);
    // 更新页面标题
    updatePageTitle(id);
  });
  ctx.subscriptions.push(dSaveAsNew);

  // Rename
  const dRename = window.zion.commands.registerCommand("zion.sessions.rename", (opts) => {
    const id = opts?.id || window.zion.state.get("sessions.currentId");
    if (!id) return false;
    const entry = findInIndex(id);
    const nv = opts?.title || prompt("Rename session:", entry?.title || "") || (entry?.title || "");
    const title = nv.trim();
    const meta = loadMeta(id);
    meta.title = title;
    meta.titleAuto = false;
    saveMeta(id, meta);
    // update tree node title
    const tree = loadTree() || ensureInitialTree();
    const { node } = findNodeAndParent(tree, id);
    if (node && node.type === "session") {
      node.title = title;
      saveTree(tree);
    }
    rebuildIndexFromTree();
    window.zion.state.set("sessions.catalog", getIndex());
    refreshStatusBar();
    try { mountSessionsSidebar(); } catch {}
    // 更新页面标题
    updatePageTitle(id);
    return true;
  });
  ctx.subscriptions.push(dRename);

  // Delete
  const dDelete = window.zion.commands.registerCommand("zion.sessions.delete", (id) => {
    const cur = window.zion.state.get("sessions.currentId");
    deleteSession(id);
    const nextId = getLastActiveId() || getIndex()[0]?.id || null;
    window.zion.state.set("sessions.catalog", getIndex());
    if (id === cur) {
      window.zion.state.set("sessions.currentId", nextId);
      if (nextId) {
        setLastActiveId(nextId);
        (async () => {
          try {
            const text = await loadDocAsync(nextId);
            window.zion.window.activeEditor?.setValue(text);
            try { applyAnnotationsForSession(nextId); } catch {}
          } catch {}
        })();
      } else {
        window.zion.commands.executeCommand("zion.sessions.new");
      }
    }
    refreshStatusBar();
    try { mountSessionsSidebar(); } catch {}
    // 更新页面标题（如果当前会话被删除，会切换到新会话）
    updatePageTitle();
    return true;
  });
  ctx.subscriptions.push(dDelete);

  // Switch
  const dSwitch = window.zion.commands.registerCommand("zion.sessions.switch", async (idOrOpts, maybeOpts) => {
    const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts?.id;
    const opts = typeof idOrOpts === "string" ? (maybeOpts || {}) : (idOrOpts || {});
    if (!id) return false;
    // Persist annotations of current session before switching
    try {
      const curPrev = window.zion.state.get("sessions.currentId");
      if (curPrev) {
        try {
          const ed = window.zion.window.activeEditor;
          const text = ed?.getValue?.();
          if (typeof text === "string") {
            saveDoc(curPrev, text);
            const metaPrev0 = loadMeta(curPrev);
            metaPrev0.size = text.length;
            metaPrev0.hash = hashString(text);
            saveMeta(curPrev, metaPrev0);
          }
        } catch {}
        const ann = window.zion.state.get(`sessions.annotations.${curPrev}`);
        if (ann) {
          const metaPrev = loadMeta(curPrev);
          metaPrev.annotations = { ...(metaPrev.annotations || {}), ...ann };
          saveMeta(curPrev, metaPrev);
        }
        // 离开当前会话前尝试自动更新标题
        try { maybeUpdateAutoTitle(curPrev); } catch {}
      }
    } catch {}
    if (opts.writeUrl !== false) {
      setLastActiveId(id, { push: opts.pushUrl !== false });
    }
    window.zion.state.set("sessions.currentId", id);
    try {
      const text = await loadDocAsync(id);
      window.zion.window.activeEditor?.setValue(text);
      try { applyAnnotationsForSession(id); } catch {}
    } catch {}
    // 进入目标会话后尝试自动更新其标题（如仍为默认）
    try { maybeUpdateAutoTitle(id); } catch {}
    // 清除该会话的“待查看”标识
    try { window.zion.state.update(`chat.runs.${id}`, (rs) => ({ ...(rs || {}), awaiting: false })); } catch {}
    // 同步兼容状态栏 streaming 显示
    const rs = window.zion.state.get(`chat.runs.${id}`);
    window.zion.state.set("chat.streaming", !!rs?.streaming);
    refreshStatusBar();
    try { mountSessionsSidebar(); } catch {}
    return true;
  });
  ctx.subscriptions.push(dSwitch);

  try {
    const onUrlChange = () => {
      try {
        const nextId = getSessionIdFromURL();
        if (!nextId) return;
        const curId = window.zion.state.get("sessions.currentId");
        if (curId === nextId) return;
        if (!findInIndex(nextId)) return;
        window.zion.commands.executeCommand("zion.sessions.switch", { id: nextId, writeUrl: false, pushUrl: false });
      } catch {}
    };
    window.addEventListener("popstate", onUrlChange);
    window.addEventListener("hashchange", onUrlChange);
    ctx.subscriptions.push({
      dispose() {
        try { window.removeEventListener("popstate", onUrlChange); } catch {}
        try { window.removeEventListener("hashchange", onUrlChange); } catch {}
      }
    });
  } catch {}

  // ===== Session doc APIs for background streaming =====
  const dGetDoc = window.zion.commands.registerCommand("zion.sessions.getDoc", (id) => {
    if (!id) return "";
    return loadDoc(id);
  });
  const dGetMeta = window.zion.commands.registerCommand("zion.sessions.getMeta", (id) => {
    if (!id) return null;
    return loadMeta(id);
  });
  const dSetDoc = window.zion.commands.registerCommand("zion.sessions.setDoc", ({ id, text }) => {
    if (!id) return false;
    saveDoc(id, String(text || ""));
    const meta = loadMeta(id);
    meta.size = String(text || "").length;
    meta.hash = hashString(String(text || ""));
    saveMeta(id, meta);
    // 索引与更新时间由自动保存/外部触发控制
    const cur = window.zion.state.get("sessions.currentId");
    if (cur === id) {
      try { window.zion.window.activeEditor?.setValue(String(text || "")); } catch {}
    }
    return true;
  });
  const dAppendToken = window.zion.commands.registerCommand("zion.sessions.appendAssistantToken", ({ id, token }) => {
    if (!id || token == null) return false;
    const doc = loadDoc(id);
    const lines = doc.split("\n");
    // 寻找最后一个 assistant 区块的末行
    let assistantLine = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*assistant\s+/.test(lines[i])) { assistantLine = i; break; }
    }
    if (assistantLine === -1) {
      // 若不存在，追加头行到末尾
      const head = (doc.endsWith("\n") || doc.length === 0) ? "assistant " : "\nassistant ";
      const newDoc = doc + head + String(token);
      window.zion.commands.executeCommand("zion.sessions.setDoc", { id, text: newDoc });
      return true;
    }
    // 计算该区块末行（直到遇到新角色头）
    let endLine = assistantLine;
    for (let i = assistantLine + 1; i < lines.length; i++) {
      if (/^\s*(system|user|assistant|tool)\s+/.test(lines[i])) break;
      endLine = i;
    }
    lines[endLine] = (lines[endLine] || "") + String(token);
    const newDoc = lines.join("\n");
    window.zion.commands.executeCommand("zion.sessions.setDoc", { id, text: newDoc });
    return true;
  });
  const dBumpUpdated = window.zion.commands.registerCommand("zion.sessions.bumpUpdatedAt", (id) => {
    if (!id) return false;
    const meta = loadMeta(id);
    meta.updatedAt = now();
    meta.size = loadDoc(id).length;
    meta.hash = hashString(loadDoc(id));
    saveMeta(id, meta);
    upsertIndexEntry({ id, title: meta.title, updatedAt: meta.updatedAt, size: meta.size, hash: meta.hash, createdAt: meta.createdAt });
    window.zion.state.set("sessions.catalog", getIndex());
    try { mountSessionsSidebar(); } catch {}
    return true;
  });
  ctx.subscriptions.push(dGetDoc, dGetMeta, dSetDoc, dAppendToken, dBumpUpdated);

  // ===== Background annotations for non-active sessions (thinking/tool calls) =====
  // Persist markers and card content into session docs/meta so they can be restored when switching back.
  const dispRunStarted = window.zion.events.on("chat/runStarted", ({ runId, sessionId }) => {
    try {
      // initialize per-run seq counter
      if (sessionId) {
        const key = `thinking.seq.${sessionId}.${runId}`;
        window.zion.state.set(key, 0);
      }
    } catch {}
    // Refresh UI to reflect "streaming" status badge immediately
    try { mountSessionsSidebar(); } catch {}
    try { refreshSessionsOverlayIfOpen(); } catch {}
  });
  const dispRunFinishedUI = window.zion.events.on("chat/runFinished", ({ sessionId }) => {
    try { mountSessionsSidebar(); } catch {}
    try { refreshSessionsOverlayIfOpen(); } catch {}
  });
  const dispRunErrorUI = window.zion.events.on("chat/runError", ({ sessionId }) => {
    try { mountSessionsSidebar(); } catch {}
    try { refreshSessionsOverlayIfOpen(); } catch {}
  });
  const dispAbortedUI = window.zion.events.on("chat/aborted", ({ sessionId }) => {
    try { mountSessionsSidebar(); } catch {}
    try { refreshSessionsOverlayIfOpen(); } catch {}
  });
  ctx.subscriptions.push(dispRunStarted, dispRunFinishedUI, dispRunErrorUI, dispAbortedUI);

  const dispReasoningStart = window.zion.events.on("chat/reasoningStart", ({ runId, sessionId }) => {
    try {
      const cur = window.zion.state.get("sessions.currentId");
      if (!sessionId || sessionId === cur) return; // current session handled by plugin

      // Compute insertion position in background doc
      const doc = window.zion.commands.executeCommand("zion.sessions.getDoc", sessionId) || "";
      const hint = window.zion.state.get(`chat.answerAnchorPos.${sessionId}`);
      const pos = findAssistantBlockEndInText(doc, hint);

      const prevChar = pos > 0 ? doc.slice(pos - 1, pos) : "";
      const prefix = prevChar === "\n" || pos === 0 ? "" : "\n";
      const text = `${prefix}思考\n\n`;
      const start = pos + prefix.length;
      const end = start + "思考".length;
      const newDoc = doc.slice(0, pos) + text + doc.slice(pos);
      window.zion.commands.executeCommand("zion.sessions.setDoc", { id: sessionId, text: newDoc });

      // seq for this run
      const key = `thinking.seq.${sessionId}.${runId}`;
      const seq = (window.zion.state.get(key) || 0) + 1;
      window.zion.state.set(key, seq);
      const thinkingId = `thinking:${runId}:${seq}`;

      // Merge into meta.annotations
      const meta = loadMeta(sessionId);
      const ann = meta.annotations || {};
      const list = Array.isArray(ann.thinking) ? ann.thinking.slice() : [];
      list.push({ id: thinkingId, text: "", expanded: false, from: start, to: end });
      meta.annotations = { ...ann, thinking: list };
      saveMeta(sessionId, meta);
    } catch (e) {
      console.warn("[sessions] background reasoningStart error:", e);
    }
  });
  ctx.subscriptions.push(dispReasoningStart);

  const dispReasoningToken = window.zion.events.on("chat/reasoningToken", ({ runId, sessionId, token }) => {
    try {
      const cur = window.zion.state.get("sessions.currentId");
      if (!sessionId || sessionId === cur) return;
      const key = `thinking.seq.${sessionId}.${runId}`;
      const seq = window.zion.state.get(key) || 1;
      const thinkingId = `thinking:${runId}:${seq}`;
      const meta = loadMeta(sessionId);
      const ann = meta.annotations || {};
      const list = Array.isArray(ann.thinking) ? ann.thinking.slice() : [];
      const i = list.findIndex(it => it.id === thinkingId);
      if (i >= 0) {
        list[i] = { ...list[i], text: (list[i].text || "") + String(token || "") };
      }
      meta.annotations = { ...ann, thinking: list };
      saveMeta(sessionId, meta);
    } catch (e) {
      console.warn("[sessions] background reasoningToken error:", e);
    }
  });
  ctx.subscriptions.push(dispReasoningToken);

  const dispToolCall = window.zion.events.on("chat/toolCall", ({ runId, sessionId, toolCall }) => {
    try {
      const cur = window.zion.state.get("sessions.currentId");
      if (!sessionId || sessionId === cur) return;
      const name = toolCall?.name || "tool";

      const doc = window.zion.commands.executeCommand("zion.sessions.getDoc", sessionId) || "";
      const hint = window.zion.state.get(`chat.answerAnchorPos.${sessionId}`);
      const pos = findAssistantBlockEndInText(doc, hint);
      const prevChar = pos > 0 ? doc.slice(pos - 1, pos) : "";
      const prefix = prevChar === "\n" || pos === 0 ? "" : "\n";
      const text = `${prefix}调用 ${name}\n`;
      const start = pos + prefix.length;
      const end = start + (`调用 ${name}`).length;
      const newDoc = doc.slice(0, pos) + text + doc.slice(pos);
      window.zion.commands.executeCommand("zion.sessions.setDoc", { id: sessionId, text: newDoc });

      // Persist meta.annotations.tools
      const meta = loadMeta(sessionId);
      const ann = meta.annotations || {};
      const list = Array.isArray(ann.tools) ? ann.tools.slice() : [];
      list.push({ id: toolCall.id, name, args: toolCall.args, result: null, expanded: false, from: start, to: end });
      meta.annotations = { ...ann, tools: list };
      saveMeta(sessionId, meta);
    } catch (e) {
      console.warn("[sessions] background toolCall error:", e);
    }
  });
  ctx.subscriptions.push(dispToolCall);

  const dispToolResult = window.zion.events.on("chat/toolResult", ({ sessionId, toolCallId, result }) => {
    try {
      const cur = window.zion.state.get("sessions.currentId");
      if (!sessionId || sessionId === cur) return;
      const meta = loadMeta(sessionId);
      const ann = meta.annotations || {};
      const list = Array.isArray(ann.tools) ? ann.tools.slice() : [];
      const i = list.findIndex(it => it.id === toolCallId);
      if (i >= 0) {
        list[i] = { ...list[i], result };
      }
      meta.annotations = { ...ann, tools: list };
      saveMeta(sessionId, meta);
    } catch (e) {
      console.warn("[sessions] background toolResult error:", e);
    }
  });
  ctx.subscriptions.push(dispToolResult);

  // ===== Persist annotations for CURRENT session on chat lifecycle/events =====
  const dispCurToolResult = window.zion.events.on("chat/toolResult", ({ sessionId }) => {
    try {
      const cur = window.zion.state.get("sessions.currentId");
      if (!sessionId || sessionId === cur) persistCurrentAnnotations();
    } catch {}
  });
  const dispCurReasoningEnd = window.zion.events.on("chat/reasoningEnd", ({ sessionId }) => {
    try {
      const cur = window.zion.state.get("sessions.currentId");
      if (!sessionId || sessionId === cur) persistCurrentAnnotations();
    } catch {}
  });
  const dispCurRunFinished = window.zion.events.on("chat/runFinished", ({ sessionId }) => {
    try {
      const cur = window.zion.state.get("sessions.currentId");
      if (!sessionId || sessionId === cur) persistCurrentAnnotations();
    } catch {}
  });
  const dispCurRunError = window.zion.events.on("chat/runError", ({ sessionId }) => {
    try {
      const cur = window.zion.state.get("sessions.currentId");
      if (!sessionId || sessionId === cur) persistCurrentAnnotations();
    } catch {}
  });
  const dispCurAborted = window.zion.events.on("chat/aborted", ({ sessionId }) => {
    try {
      const cur = window.zion.state.get("sessions.currentId");
      if (!sessionId || sessionId === cur) persistCurrentAnnotations();
    } catch {}
  });
  ctx.subscriptions.push(dispCurToolResult, dispCurReasoningEnd, dispCurRunFinished, dispCurRunError, dispCurAborted);

  // Clone
  const dClone = window.zion.commands.registerCommand("zion.sessions.clone", (id) => {
    const srcId = id || window.zion.state.get("sessions.currentId");
    if (!srcId) return false;
    const srcMeta = loadMeta(srcId);
    const text = loadDoc(srcId);
    const newId = genId();
    const title = `${srcMeta.title || "Session"} (copy)`;
    const meta = { id: newId, title, createdAt: now(), updatedAt: now(), size: text.length, hash: hashString(text), titleAuto: false };
    // copy annotations from source
    if (srcMeta?.annotations) {
      meta.annotations = srcMeta.annotations;
    }
    saveDoc(newId, text);
    saveMeta(newId, meta);
    upsertIndexEntry({ id: newId, title: meta.title, updatedAt: meta.updatedAt, size: meta.size, hash: meta.hash, createdAt: meta.createdAt });
    setLastActiveId(newId, { push: true });
    window.zion.state.set("sessions.currentId", newId);
    window.zion.state.set("sessions.catalog", getIndex());
    window.zion.window.activeEditor?.setValue(text);
    try { applyAnnotationsForSession(newId); } catch {}
    refreshStatusBar();
    try { mountSessionsSidebar(); } catch {}
    postSaved(newId, meta.updatedAt, meta.hash);
    // 更新页面标题
    updatePageTitle(newId);
    return true;
  });
  ctx.subscriptions.push(dClone);

  // Export
  const dExport = window.zion.commands.registerCommand("zion.sessions.export", (id) => {
    const idx = getIndex();
    const pickId = id || window.zion.state.get("sessions.currentId");
    if (pickId) {
      const meta = loadMeta(pickId);
      const doc = loadDoc(pickId);
      const payload = { meta, doc };
      download(`session-${(meta.title || pickId).replace(/\s+/g, "_")}.json`, JSON.stringify(payload, null, 2));
    } else {
      const payload = idx.map(it => ({ meta: loadMeta(it.id), doc: loadDoc(it.id) }));
      download("sessions.json", JSON.stringify(payload, null, 2));
    }
    return true;
  });

  // Export folder
  const dExportFolder = window.zion.commands.registerCommand("zion.sessions.exportFolder", (folderId) => {
    const tree = loadTree() || ensureInitialTree();
    const { node } = findNodeAndParent(tree, folderId);
    if (!node || node.type !== "folder") return false;
    const collect = (n) => {
      if (n.type === "folder") {
        return {
          id: n.id,
          type: "folder",
          title: n.title,
          children: (n.children || []).map(collect)
        };
      } else {
        return {
          id: n.id,
          type: "session",
          meta: loadMeta(n.id),
          doc: loadDoc(n.id)
        };
      }
    };
    const payload = collect(node);
    download(`folder-${(node.title || node.id).replace(/\s+/g, "_")}.json`, JSON.stringify(payload, null, 2));
    return true;
  });
  ctx.subscriptions.push(dExport);

  // Import
  const dImport = window.zion.commands.registerCommand("zion.sessions.import", async () => {
    const ok = await importSessionsFromFile();
    if (ok) {
      window.zion.state.set("sessions.catalog", getIndex());
      refreshStatusBar();
      try { mountSessionsSidebar(); } catch {}
      // notify
      window.zion.statusBar.registerItem({
        id: "session.import.ok",
        text: "✓",
        tooltip: "Sessions imported successfully"
      });
    } else {
      window.zion.statusBar.registerItem({
        id: "session.import.err",
        text: "⚠",
        tooltip: "Failed to import sessions"
      });
    }
    return ok;
  });
  ctx.subscriptions.push(dImport);

  // Bulk selection commands
  const dDeleteSelected = window.zion.commands.registerCommand("zion.sessions.deleteSelected", () => {
    const sel = getSelection();
    if (!sel.length) return false;
    const ok = confirm(`Delete ${sel.length} selected item(s)? This cannot be undone.`);
    if (!ok) return false;
    let affectedCurrent = false;
    const cur = window.zion.state.get("sessions.currentId");
    for (const it of sel) {
      if (it.type === "folder") {
        // delete whole subtree
        if (removeNodeRecursive(it.id)) {
          const tree = loadTree() || ensureInitialTree();
          const { node } = findNodeAndParent(tree, it.id);
          // node removed; check current
        }
      } else {
        if (cur === it.id) affectedCurrent = true;
        deleteSession(it.id);
      }
    }
    clearSelection();
    const nextId = getLastActiveId() || getIndex()[0]?.id || null;
    if (affectedCurrent) {
      window.zion.state.set("sessions.currentId", nextId);
      if (nextId) {
        setLastActiveId(nextId);
        window.zion.window.activeEditor?.setValue(loadDoc(nextId));
      }
    }
    window.zion.state.set("sessions.catalog", getIndex());
    refreshStatusBar();
    try { mountSessionsSidebar(); } catch {}
    return true;
  });
  const dExportSelected = window.zion.commands.registerCommand("zion.sessions.exportSelected", () => {
    const sel = getSelection();
    if (!sel.length) return false;
    const tree = loadTree() || ensureInitialTree();
    const collectFolder = (n) => {
      if (n.type === "folder") {
        return {
          id: n.id,
          type: "folder",
          title: n.title,
          children: (n.children || []).map(collectFolder)
        };
      } else {
        return {
          id: n.id,
          type: "session",
          meta: loadMeta(n.id),
          doc: loadDoc(n.id)
        };
      }
    };
    const payload = [];
    for (const it of sel) {
      const { node } = findNodeAndParent(tree, it.id);
      if (!node) continue;
      if (node.type === "folder") {
        payload.push(collectFolder(node));
      } else {
        payload.push({ meta: loadMeta(node.id), doc: loadDoc(node.id) });
      }
    }
    download("sessions-selected.json", JSON.stringify(payload, null, 2));
    return true;
  });
  ctx.subscriptions.push(dDeleteSelected, dExportSelected);

  // Folder commands
  const dNewFolder = window.zion.commands.registerCommand("zion.sessions.newFolder", (opts) => {
    let title = String(opts?.title || "");
    if (!title) {
      const input = prompt("Folder name:", "New Folder");
      title = (input || "New Folder").trim();
    }
    const id = insertFolder(opts?.parentId || window.zion.state.get("sessions.selectedFolderId") || "root", title);
    window.zion.state.set("sessions.catalog", getIndex());
    try { mountSessionsSidebar(); } catch {}
    return id;
  });
  const dRenameFolder = window.zion.commands.registerCommand("zion.sessions.renameFolder", (opts) => {
    const tree = loadTree() || ensureInitialTree();
    const { node } = findNodeAndParent(tree, opts?.id);
    if (!node || node.type !== "folder") return false;
    node.title = String(opts?.title || node.title || "Folder");
    saveTree(tree);
    window.zion.state.set("sessions.catalog", getIndex());
    try { mountSessionsSidebar(); } catch {}
    return true;
  });
  const dDeleteFolder = window.zion.commands.registerCommand("zion.sessions.deleteFolder", (id) => {
    const ok = removeNodeRecursive(id);
    window.zion.state.set("sessions.catalog", getIndex());
    try { mountSessionsSidebar(); } catch {}
    return ok;
  });
  ctx.subscriptions.push(dNewFolder, dRenameFolder, dDeleteFolder, dExportFolder);

  // Show Panel
  const dShow = window.zion.commands.registerCommand("zion.sessions.showPanel", () => {
    openSessionsPanel();
    return true;
  });
  ctx.subscriptions.push(dShow);

  // 注册快捷键（manifest 已声明，这里可选）
  try {
    const kb1 = window.zion.keybindings.register({ command: "zion.sessions.new", key: "Mod-Shift-n", when: "editorFocus" });
    const kb2 = window.zion.keybindings.register({ command: "zion.sessions.toggleSidebar", key: "Mod-Shift-s", when: "editorFocus" });
    ctx.subscriptions.push(kb1, kb2);
  } catch {}

  // Register slash commands
  try {
    const slashCommands = [
      {
        id: "zion.sessions.new",
        triggers: ["new", "new-session", "ns"],
        title: "新建会话",
        description: "创建新的会话",
        priority: 100
      },
      {
        id: "zion.sessions.showPanel",
        triggers: ["sessions", "show-sessions", "session-panel"],
        title: "显示会话面板",
        description: "打开会话管理面板",
        priority: 90
      },
      {
        id: "zion.sessions.toggleSidebar",
        triggers: ["sidebar", "sessions-sidebar"],
        title: "切换会话侧边栏",
        description: "显示/隐藏会话侧边栏",
        priority: 80
      },
      {
        id: "zion.sessions.saveAsNew",
        triggers: ["save-as", "save-session"],
        title: "另存为新会话",
        description: "将当前内容另存为新会话",
        priority: 70
      }
    ];

    slashCommands.forEach(cmd => {
      const d = window.zion.slash?.registerCommand?.({
        id: cmd.id,
        trigger: cmd.triggers,
        title: cmd.title,
        description: cmd.description,
        category: "session",
        icon: "📄",
        priority: cmd.priority,
        execute: () => {
          window.zion.commands.executeCommand(cmd.id);
        }
      });
      if (d) ctx.subscriptions.push(d);
    });
  } catch (e) {
    console.error("[dev.session-manager] Error registering slash commands:", e);
  }
}
