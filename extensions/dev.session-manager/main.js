import { registerSessionTools } from "./session-tools.js";
import { openSessionsDB, idbGet, idbGetKV, idbSet, idbSetKV } from "./storage/idb.js";
import { createSessionDocRepo } from "./storage/docs.js";
import { createSessionUrlModel } from "./model/url.js";
import { createSessionTreeModel } from "./model/tree.js";
import { createSessionUIStateModel } from "./model/ui-state.js";
import { createAnnotationsLifecycle } from "./features/annotations-lifecycle.js";
import { findAssistantBlockEndInText } from "./features/assistant-block.js";
import { applyAnnotationsForSessionImpl } from "./features/annotations-apply.js";
import { createPageTitleManager } from "./features/page-title.js";
import { registerSessionAutoRenameCommand } from "./commands/auto-rename.js";
import { registerSessionSidebarCommands } from "./commands/sidebar.js";
import { registerSessionFlushCommand } from "./commands/flush.js";
import { registerSessionDocCommands } from "./commands/doc-apis.js";
import { createSessionAutoSavePlugin } from "./editor/autosave-plugin.js";
import { createSessionsSidebarViewManager } from "./ui/sidebar-view.js";
import { createSessionsPanelManager } from "./ui/panel.js";
import { createSessionsListRendererFactory } from "./ui/list-renderer.js";
import { SessionDocumentRuntime } from "../../src/session/document-runtime";

const I18N_NS = "dev.session-manager";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.sessions": "会话",
    "cmd.new": "新建会话",
    "cmd.saveAsNew": "另存为新会话",
    "cmd.rename": "重命名会话",
    "cmd.delete": "删除会话",
    "cmd.switch": "切换会话",
    "cmd.clone": "克隆会话",
    "cmd.export": "导出会话",
    "cmd.import": "导入会话",
    "cmd.showPanel": "显示会话面板",
    "cmd.showSidebar": "显示会话侧边栏",
    "cmd.hideSidebar": "隐藏会话侧边栏",
    "cmd.toggleSidebar": "切换会话侧边栏",
    "slash.new.description": "创建新的会话",
    "slash.showPanel.description": "打开会话管理面板",
    "slash.toggleSidebar.description": "显示/隐藏会话侧边栏",
    "slash.saveAsNew.description": "将当前内容另存为新会话",
    "ui.sessions": "会话",
    "ui.createNew": "新建会话",
    "ui.actions": "操作",
    "ui.fork": "分叉会话",
    "ui.refresh": "刷新",
    "dialog.newTitle": "新会话标题",
    "dialog.rename": "重命名会话",
    "dialog.deleteSelected": "删除所选项"
  },
  "en-US": {
    "category.sessions": "Sessions",
    "cmd.new": "New Session",
    "cmd.saveAsNew": "Save As New Session",
    "cmd.rename": "Rename Session",
    "cmd.delete": "Delete Session",
    "cmd.switch": "Switch Session",
    "cmd.clone": "Clone Session",
    "cmd.export": "Export Sessions",
    "cmd.import": "Import Sessions",
    "cmd.showPanel": "Show Sessions Panel",
    "cmd.showSidebar": "Show Sessions Sidebar",
    "cmd.hideSidebar": "Hide Sessions Sidebar",
    "cmd.toggleSidebar": "Toggle Sessions Sidebar",
    "slash.new.description": "Create a new session",
    "slash.showPanel.description": "Open the sessions panel",
    "slash.toggleSidebar.description": "Show or hide the sessions sidebar",
    "slash.saveAsNew.description": "Save current content as a new session",
    "ui.sessions": "Sessions",
    "ui.createNew": "Create new session",
    "ui.actions": "Actions",
    "ui.fork": "Fork Session",
    "ui.refresh": "Refresh",
    "dialog.newTitle": "New session title",
    "dialog.rename": "Rename session",
    "dialog.deleteSelected": "Delete selected"
  }
};

function t(key, fallback, values) {
  try {
    const translated = window.zion?.i18n?.t?.(`${I18N_NS}.${key}`, values);
    if (translated && translated !== `${I18N_NS}.${key}`) return translated;
  } catch {}
  return fallback;
}

/** ========== Storage & Utils ========== */
const LS_INDEX = "zion.sessions.index";
const LS_TREE = "zion.sessions.tree";
const LS_LAST = "zion.sessions.lastActiveId";
const LS_AUTO = "zion.autosave";
const LS_FOLDER_OPEN = "zion.sessions.folderOpen";
const URL_SESSION = "zionSession";
const URL_SESSION_ALT = "session";
const PENDING_INLINE_EDIT_KEY = "sessions.pendingInlineEdit";
function debugSessions(event, payload) {
  void event;
  void payload;
}
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
    // Surface storage failures as a notification now that the top status bar is hidden.
    try {
      window.zion?.notification?.show?.("Sessions storage write failed. Some changes may not persist.", {
        type: "warning",
        duration: 0,
        dismissible: true
      });
    } catch {}
  } catch {}
}

/** ======== IndexedDB (sessions) ======== */
const DB_NAME = "zion.sessions.db";
const { docKey, metaKey, loadDoc, saveDoc, loadDocAsync, loadMeta, saveMeta } = createSessionDocRepo({
  dbName: DB_NAME,
  idbGet,
  idbSet,
  warnStorageIssue,
  now,
  applyAnnotationsForSession,
  getZion: () => window.zion
});

/** preload tree/index into memory and migrate legacy localStorage once */
async function initSessionsStorage() {
  try {
    await openSessionsDB(DB_NAME);
    // preload KV: tree/index
    try {
      const tree = await idbGetKV(DB_NAME, "tree");
      if (tree && tree.type === "folder" && Array.isArray(tree.children)) {
        try { window.zion?.state?.set("sessions.treeMem", tree); } catch {}
      }
    } catch {}
    try {
      const idx = await idbGetKV(DB_NAME, "index");
      if (Array.isArray(idx)) {
        try { window.zion?.state?.set("sessions.indexMem", idx); } catch {}
      }
    } catch {}

    // migrate from localStorage if no tree in IDB but legacy tree/index exist
    const hasTreeInIDB = !!(await idbGetKV(DB_NAME, "tree"));
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
          await idbSet(DB_NAME, "docs", { id: sid, text: d });
          await idbSet(DB_NAME, "metas", { id: sid, meta: m });
          try { window.zion?.state?.set(`sessions.doc.${sid}`, d); } catch {}
          try { window.zion?.state?.set(`sessions.meta.${sid}`, m); } catch {}
        } catch (e) {
          console.warn("[sessions] migrate doc/meta error:", sid, e);
        }
      }
      // persist tree/index to idb
      if (legacyTree) {
        await idbSetKV(DB_NAME, "tree", legacyTree);
        try { window.zion?.state?.set("sessions.treeMem", legacyTree); } catch {}
      }
      const legacyIndex = safeJSONParse(legacyIndexRaw || "[]", []);
      if (Array.isArray(legacyIndex)) {
        await idbSetKV(DB_NAME, "index", legacyIndex);
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

const { getSessionIdFromURL, setSessionIdToURL, buildSessionURL, getLastActiveId, setLastActiveId } = createSessionUrlModel({
  urlSessionKey: URL_SESSION,
  urlSessionAltKey: URL_SESSION_ALT,
  lsLastKey: LS_LAST
});

const {
  loadTree,
  saveTree,
  getIndex,
  setIndex,
  rebuildIndexFromTree,
  ensureInitialTree,
  isFolder,
  isSession,
  findNodeAndParent,
  insertFolder,
  insertSessionNode,
  insertSessionNodeAfter,
  removeNode,
  removeNodeRecursive,
  moveNode,
  getFolderOpenMap,
  setFolderOpen,
  isFolderOpen,
  openAncestors
} = createSessionTreeModel({
  dbName: DB_NAME,
  idbSetKV,
  warnStorageIssue,
  loadMeta,
  saveDoc,
  saveMeta,
  deriveTitleFromText,
  genId,
  hashString,
  now,
  getLastActiveId,
  setLastActiveId,
  docKey,
  metaKey,
  lsAutoKey: LS_AUTO,
  lsFolderOpenKey: LS_FOLDER_OPEN,
  getZion: () => window.zion
});

const {
  getSelection,
  setSelection,
  clearSelection,
  isSelected,
  toggleSelection,
  getLastSelectedId,
  setLastSelectedId
} = createSessionUIStateModel({
  getZion: () => window.zion
});

const {
  getAnnotationsState,
  persistCurrentAnnotations,
  attachLifecyclePersistence,
  attachLifecycleRestore,
  attachAnnotationsAutoPersistence
} = createAnnotationsLifecycle({
  dbName: DB_NAME,
  idbGet,
  loadMeta,
  saveMeta,
  now,
  getZion: () => window.zion
});

/**
 * Restore persisted annotations for a session by emitting plugin events.
 * Tool-call cards and thinking cards will rebuild themselves based on saved positions.
 */
function applyAnnotationsForSession(id, panelId) {
  try {
    const meta = loadMeta(id);
    debugSessions("annotations.apply", {
      sessionId: id,
      panelId: panelId || null,
      tools: Array.isArray(meta?.annotations?.tools) ? meta.annotations.tools.length : 0,
      thinking: Array.isArray(meta?.annotations?.thinking) ? meta.annotations.thinking.length : 0,
      toolIds: Array.isArray(meta?.annotations?.tools) ? meta.annotations.tools.map((it) => it?.id).filter(Boolean).map(String) : []
    });
  } catch {}
  applyAnnotationsForSessionImpl({ id, panelId, loadMeta, zion: window.zion });
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
    let source = "loadDoc";
    try {
      const ed = window.zion.window.activeEditor;
      const editorPanelId = ed?.panelId || null;
      const editorPanelSessionId = ed?.sessionId || (editorPanelId
        ? (window.zion?.panelManager?.getPanel?.(editorPanelId)?.activeTabId || null)
        : null);
      if (ed && editorPanelSessionId === id) {
        text = ed.getValue() || "";
        source = "activeEditor";
      } else {
        text = loadDoc(id) || "";
        source = "loadDoc";
      }
    } catch {
      text = loadDoc(id) || "";
      source = "loadDoc";
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
function openModalInput({ title, value, placeholder, okText, cancelText }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.25)";
    overlay.style.zIndex = "100005";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";

    const card = document.createElement("div");
    card.style.width = "min(420px, calc(100vw - 40px))";
    card.style.background = "var(--panel)";
    card.style.border = "1px solid var(--border)";
    card.style.borderRadius = "10px";
    card.style.boxShadow = "0 8px 24px rgba(0,0,0,0.25)";
    card.style.padding = "12px";
    card.style.display = "flex";
    card.style.flexDirection = "column";
    card.style.gap = "10px";

    const header = document.createElement("div");
    header.textContent = title || "Input";
    header.style.fontSize = "13px";
    header.style.fontWeight = "600";
    header.style.color = "var(--fg)";

    const input = document.createElement("input");
    input.type = "text";
    input.value = String(value || "");
    input.placeholder = placeholder || "";
    input.style.width = "100%";
    input.style.boxSizing = "border-box";
    input.style.padding = "8px 10px";
    input.style.borderRadius = "8px";
    input.style.border = "1px solid var(--border)";
    input.style.background = "var(--bg)";
    input.style.color = "var(--fg)";
    input.style.outline = "none"; 

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "8px";

    const mkBtn = (text, primary) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.style.padding = "6px 10px";
      b.style.borderRadius = "8px";
      b.style.border = "1px solid var(--border)";
      b.style.cursor = "pointer";
      b.style.background = primary ? "var(--fg)" : "transparent";
      b.style.color = primary ? "var(--bg)" : "var(--fg)";
      return b;
    };

    const cancel = mkBtn(cancelText || "Cancel", false);
    const ok = mkBtn(okText || "OK", true);
    actions.append(cancel, ok);

    let cleanup = () => {};
    const onKey = (e) => {
      if (e.key === "Escape") cleanup(false);
      if (e.key === "Enter") cleanup(true);
    };

    cleanup = (v) => {
      try { document.removeEventListener("keydown", onKey, true); } catch {}
      try { overlay.remove(); } catch {}
      resolve(v);
    };

    cancel.onclick = () => cleanup(null);
    ok.onclick = () => cleanup(input.value);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(null); };
    input.onkeydown = (e) => {
      if (e.key === "Escape") cleanup(null);
      if (e.key === "Enter") cleanup(input.value);
    };

    card.append(header, input, actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => {
      try {
        input.focus();
        input.select();
      } catch {}
    }, 0);
  });
}

function openModalConfirm({ title, message, okText, cancelText }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.25)";
    overlay.style.zIndex = "100005";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";

    const card = document.createElement("div");
    card.style.width = "min(440px, calc(100vw - 40px))";
    card.style.background = "var(--panel)";
    card.style.border = "1px solid var(--border)";
    card.style.borderRadius = "10px";
    card.style.boxShadow = "0 8px 24px rgba(0,0,0,0.25)";
    card.style.padding = "12px";
    card.style.display = "flex";
    card.style.flexDirection = "column";
    card.style.gap = "10px";

    const header = document.createElement("div");
    header.textContent = title || "Confirm";
    header.style.fontSize = "13px";
    header.style.fontWeight = "600";
    header.style.color = "var(--fg)";

    const msg = document.createElement("div");
    msg.textContent = message || "Are you sure?";
    msg.style.fontSize = "12px";
    msg.style.color = "var(--fg)";
    msg.style.lineHeight = "1.45";

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "8px";

    const mkBtn = (text, primary) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.style.padding = "6px 10px";
      b.style.borderRadius = "8px";
      b.style.border = "1px solid var(--border)";
      b.style.cursor = "pointer";
      b.style.background = primary ? "#cc3a3a" : "transparent";
      b.style.color = primary ? "#fff" : "var(--fg)";
      return b;
    };

    const cancel = mkBtn(cancelText || "Cancel", false);
    const ok = mkBtn(okText || "OK", true);
    actions.append(cancel, ok);

    const onKey = (e) => {
      if (e.key === "Escape") cleanup(false);
      if (e.key === "Enter") cleanup(true);
    };

    const cleanup = (v) => {
      try { document.removeEventListener("keydown", onKey, true); } catch {}
      try { overlay.remove(); } catch {}
      resolve(v);
    };

    cancel.onclick = () => cleanup(false);
    ok.onclick = () => cleanup(true);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    document.addEventListener("keydown", onKey, true);

    card.append(header, msg, actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => { try { ok.focus(); } catch {} }, 0);
  });
}

const createSessionsListRenderer = createSessionsListRendererFactory({
  loadTree,
  ensureInitialTree,
  getIndex,
  loadMeta,
  buildSessionURL,
  truncate,
  setSmallDragImage,
  fmtTime,
  now,
  getSelection,
  setSelection,
  clearSelection,
  isSelected,
  toggleSelection,
  getLastSelectedId,
  setLastSelectedId,
  isFolderOpen,
  setFolderOpen,
  moveNode
});

const __panelManager = createSessionsPanelManager({
  zion: window.zion,
  getIndex,
  createSessionsListRenderer,
  openAncestors,
  openModalInput,
  refreshSessionsSidebarViewIfOpen
});

function openSessionsPanel() {
  __panelManager.open();
}

function refreshSessionsOverlayIfOpen() {
  __panelManager.refreshIfOpen();
}

const __sidebarViewManager = createSessionsSidebarViewManager({
  zion: window.zion,
  createSessionsListRenderer,
  openAncestors
});

function refreshSessionsSidebarViewIfOpen() {
  __sidebarViewManager.refreshIfOpen();
}

function mountSessionsSidebarViewInto(container) {
  return __sidebarViewManager.mountInto(container);
}

const __pageTitleManager = createPageTitleManager({
  zion: window.zion,
  defaultTitle: "Zion Next (CM6) Playground",
  loadMeta,
  isDefaultTitle
});

function updatePageTitle(id) {
  __pageTitleManager.updatePageTitle(id);
}

/** ========== Status Bar ========== */
function refreshStatusBar() {
  const id = window.zion.state.get("sessions.currentId");
  if (!id) return;
  // 同步页面标题
  updatePageTitle(id);
}

function getActivePanelContext() {
  try {
    const panelId = window.zion?.panels?.getActivePanelId?.() || null;
    const panel = panelId
      ? window.zion?.panels?.list?.().find((item) => item.id === panelId) || null
      : null;
    const editor = panelId
      ? window.zion?.panels?.getEditor?.(panelId) || window.zion?.window?.activeEditor || null
      : window.zion?.window?.activeEditor || null;
    return {
      panelId,
      sessionId: panel?.activeTabId || window.zion?.state?.get?.("sessions.currentId") || null,
      editor
    };
  } catch {
    return {
      panelId: null,
      sessionId: window.zion?.state?.get?.("sessions.currentId") || null,
      editor: window.zion?.window?.activeEditor || null
    };
  }
}

async function openSessionForPanel(panelId, sessionId, opts = {}) {
  if (panelId && typeof window.zion?.panels?.openSession === "function") {
    return await window.zion.panels.openSession(panelId, sessionId, {
      focus: opts?.focus !== false,
      forceReload: !!opts?.forceReload
    });
  }
  window.zion.state.set("sessions.currentId", sessionId);
  const text = opts?.text != null ? String(opts.text) : await loadDocAsync(sessionId);
  window.zion.window.activeEditor?.setValue(text, { source: "session-load" });
  try { applyAnnotationsForSession(sessionId); } catch {}
  return true;
}

async function removeSessionFromPanels(sessionId) {
  const panels = (() => {
    try { return window.zion?.panelManager?.listPanels?.() || []; } catch { return []; }
  })();
  const changed = [];
  for (const panel of panels) {
    if (!Array.isArray(panel?.tabs)) continue;
    const idx = panel.tabs.findIndex((tab) => tab?.id === sessionId);
    if (idx < 0) continue;
    const wasActive = panel.activeTabId === sessionId;
    panel.tabs = panel.tabs.filter((tab) => tab?.id !== sessionId);
    changed.push(panel.id);
    if (!wasActive) continue;
    const nextId = panel.tabs[Math.min(idx, panel.tabs.length - 1)]?.id || panel.tabs[panel.tabs.length - 1]?.id || null;
    if (nextId) {
      await openSessionForPanel(panel.id, nextId, {
        focus: window.zion?.panels?.getActivePanelId?.() === panel.id,
        forceReload: true
      });
    } else {
      panel.activeTabId = null;
    }
  }
  for (const panelId of changed) {
    try { window.zion?.events?.emit?.("panel/tabsChanged", { panelId }); } catch {}
  }
  return changed.length > 0;
}

/** ========== CM6 Plugin (auto-save) ========== */
function sessionAutoSavePlugin(getCurrentId, onSaved) {
  return createSessionAutoSavePlugin({
    zion: window.zion,
    getCurrentId,
    onSaved,
    loadMeta,
    saveDoc,
    saveMeta,
    hashString,
    now,
    getAnnotationsState,
    rebuildIndexFromTree,
    upsertIndexEntry,
    postSaved
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
      /* Session manager scrollbar behavior:
         - keep width stable to avoid layout shift (status lamp not squeezed)
         - show thumb only while scrolling (zion-scroll-active), consistent with editor panels
       */
      .zion-sessions-list,
      #zion-sessions-panel-overlay .zion-sessions-panel-content {
        scrollbar-color: transparent transparent;
        scrollbar-width: thin;
        scrollbar-gutter: stable;
      }

      .zion-sessions-list::-webkit-scrollbar,
      #zion-sessions-panel-overlay .zion-sessions-panel-content::-webkit-scrollbar {
        width: 10px;
        height: 10px;
      }
      .zion-sessions-list::-webkit-scrollbar-track,
      #zion-sessions-panel-overlay .zion-sessions-panel-content::-webkit-scrollbar-track {
        background: transparent;
      }
      .zion-sessions-list::-webkit-scrollbar-thumb,
      #zion-sessions-panel-overlay .zion-sessions-panel-content::-webkit-scrollbar-thumb {
        background-color: transparent;
        border-radius: 6px;
        border: 2px solid transparent;
        background-clip: content-box;
      }
      .zion-sessions-list.zion-scroll-active::-webkit-scrollbar-thumb,
      #zion-sessions-panel-overlay .zion-sessions-panel-content.zion-scroll-active::-webkit-scrollbar-thumb {
        background-color: var(--scrollbar-thumb, var(--border, rgba(128, 128, 128, 0.4)));
      }
      /* Disable hover-to-show for session-manager (prefer scroll-active only) */
      .zion-sessions-list:hover::-webkit-scrollbar-thumb,
      #zion-sessions-panel-overlay .zion-sessions-panel-content:hover::-webkit-scrollbar-thumb {
        background-color: transparent;
      }

      /* Scroll container background - ensure clean background */
      .zion-sessions-list {
        background: transparent;
      }

      #zion-sessions-panel-overlay .zion-sessions-panel-content {
        background: var(--panel);
      }

      /* Highlight styles for current session */
      .zion-session-row.is-current {
        background: var(--sessions-current-bg, var(--ext-session-active-bg, rgba(128, 128, 128, 0.15)));
        border: none !important;
        outline: none !important;
        box-shadow: none !important;
      }
      .zion-session-row.is-current:hover {
        background: var(--sessions-current-hover-bg, var(--ext-session-active-hover-bg, rgba(128, 128, 128, 0.25)));
      }
      .zion-session-row:focus,
      .zion-session-row:focus-visible {
        outline: none !important;
        box-shadow: none !important;
      }
      .zion-session-row.is-selected {
        background: var(--sessions-selected-bg, var(--ext-session-selected-bg, rgba(33, 150, 243, 0.2)));
        box-shadow: none !important;
      }
    `;
    document.head.appendChild(style);
  } catch (e) {
    console.warn("[sessions] Failed to inject scrollbar styles:", e);
  }
}

/** ========== Activate Extension ========== */
export async function activate(ctx) {
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

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
  const sessionUiState = new Map();

  // 初始化页面标题
  updatePageTitle(currentId);

  // 将当前会话内容加载到编辑器
  const ed = window.zion.window.activeEditor;
  if (ed) {
    try {
      const text = await loadDocAsync(currentId);
      ed.setValue(text, { source: "session-load" });
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
        dispRun = window.zion.state.onDidChange(`chat.runs.${sid}`, () => {
          updateTitle();
          try { maybeUpdateAutoTitle(sid); } catch {}
        });
      } catch {
        dispRun = null;
      }
    };

    watchRunKey(currentId);

    const dispCur = window.zion.state.onDidChange("sessions.currentId", (nv) => {
      const sid = nv ? String(nv) : null;
      watchRunKey(sid);
      updateTitle();
      try {
        if (sid) {
          // VS Code-like: when active session changes, reveal it in Sessions sidebar (if open),
          // without clearing the user's search query.
          __sidebarViewManager.revealSessionIfOpen(sid, {
            openAncestors: true,
            clearSearch: false,
            flash: false,
            block: "center"
          });
        }
      } catch {}
    });
    const dispReveal = window.zion.events.on("sessions/revealRequested", (payload) => {
      const sid = payload?.sessionId ? String(payload.sessionId) : null;
      if (!sid) return;
      try {
        __sidebarViewManager.revealSessionIfOpen(sid, {
          openAncestors: true,
          clearSearch: false,
          flash: false,
          block: "center"
        });
      } catch {}
    });
    const dispStreaming = window.zion.state.onDidChange("chat.streaming", () => updateTitle());
    ctx.subscriptions.push(dispCur, dispReveal, dispStreaming, { dispose() { try { dispRun?.dispose?.(); } catch {} } });
  } catch {}

  try {
    const focusCurrentSessionInSidebar = () => {
      let tries = 0;
      const tick = () => {
        tries += 1;
        try {
          __sidebarViewManager.anchorToCurrentIfOpen();
          return;
        } catch {}
        if (tries < 20) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    const dispItem = window.zion.activityBar.registerItem({
      id: "sessions.activity",
      pluginId: "dev.session-manager",
      icon: "$(comment-discussion)",
      tooltip: t("ui.sessions", "Sessions"),
      sideBarViewId: "sessions.list",
      order: 10
    });
    const dispView = window.zion.sideBar.registerView({
      id: "sessions.list",
      pluginId: "dev.session-manager",
      title: t("ui.sessions", "Sessions"),
      icon: "💬",
      order: 10,
      location: "sidebar",
      headerActions: [
        {
          id: "sessions.new",
          title: t("ui.createNew", "Create new session"),
          ariaLabel: t("ui.createNew", "Create new session"),
          icon: "$(add)",
          onClick: () => window.zion.commands.executeCommand("zion.sessions.new", {
            parentId: window.zion.state.get("sessions.selectedFolderId") || "root"
          })
        },
        {
          id: "sessions.actions",
          title: t("ui.actions", "Actions"),
          ariaLabel: t("ui.actions", "Actions"),
          icon: "⋮",
          onClick: () => {
            try {
              __sidebarViewManager.toggleMenuIfOpen();
            } catch {}
          }
        }
      ],
      component: {
        render: (container) => {
          const inst = mountSessionsSidebarViewInto(container);
          return {
            dispose: () => {
              try { inst?.dispose?.(); } catch {}
            }
          };
        }
      }
    });
    ctx.subscriptions.push(dispItem, dispView);
    try { window.zion.activityBar.activateItem("sessions.activity"); } catch {}
    focusCurrentSessionInSidebar();
  } catch {}
  // 注册页面生命周期持久化（刷新/隐藏前保存当前会话注解）
  attachLifecyclePersistence(ctx);
  attachAnnotationsAutoPersistence(ctx);
  attachLifecycleRestore(ctx);

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
  ctx.subscriptions.push(...registerSessionSidebarCommands({ zion: window.zion }));

  // 右键菜单挂载
  try {
    const dispMenu1 = window.zion.menus.register("editor/context", {
      command: "zion.sessions.saveAsNew",
      title: t("cmd.saveAsNew", "Save As New Session"),
      when: "editorFocus"
    });
    const dispMenu2 = window.zion.menus.register("editor/context", {
      command: "zion.sessions.showPanel",
      title: t("ui.sessions", "Sessions") + "…",
      when: "editorFocus"
    });
    const dispMenu3 = window.zion.menus.register("editor/context", {
      command: "zion.sessions.fork",
      title: t("ui.fork", "Fork Session"),
      when: "editorFocus"
    });
    ctx.subscriptions.push(dispMenu1, dispMenu2, dispMenu3);
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
            window.zion.notification?.show?.("当前会话已在另一个标签页更新。", {
              type: "info",
              duration: 0,
              dismissible: true,
              actions: [{
                label: t("ui.refresh", "刷新"),
                handler: () => {
                  (async () => {
                    try {
                      const text = await loadDocAsync(cur);
                      const ed2 = window.zion.window.activeEditor;
                      ed2?.setValue(text, { source: "session-load" });
                      try { applyAnnotationsForSession(cur); } catch {}
                      window.zion.state.set("sessions.externalUpdate", null);
                      refreshStatusBar();
                      try { refreshSessionsSidebarViewIfOpen(); } catch {}
                    } catch (e) {
                      console.error("[sessions] refresh on external update error:", e);
                    }
                  })();
                }
              }]
            });
          }
        }
      };
    }
  } catch {}

  // 自动保存插件（通过 Decorator 注入）
  const plugin = sessionAutoSavePlugin(
    (view) => {
      try {
        const editorSessionId = view?.dom?.getAttribute?.("data-session-id") || null;
        if (editorSessionId) return editorSessionId;
        const panelId = view?.dom?.closest?.("[data-panel-id]")?.getAttribute?.("data-panel-id") || null;
        if (panelId) {
          return window.zion?.panelManager?.getPanel?.(panelId)?.activeTabId
            || window.zion?.panels?.list?.().find((panel) => panel.id === panelId)?.activeTabId
            || window.zion.state.get("sessions.currentId");
        }
      } catch {}
      return window.zion.state.get("sessions.currentId");
    },
    (meta) => {
      // 流式阶段避免高频刷新 sessions.catalog；否则 tabs 会频繁重渲染并导致 hover/点击闪烁
      const runState = meta?.id ? (window.zion.state.get(`chat.runs.${meta.id}`) || null) : null;
      const streaming = !!runState?.streaming;
      if (!streaming) {
        window.zion.state.set("sessions.catalog", getIndex());
      }
      refreshStatusBar();
      try {
        if (!streaming) {
          refreshSessionsSidebarViewIfOpen();
        }
      } catch {}
    }
  );
  const dispDec = window.zion.editor.registerDecorator({
    id: "dev.session-manager.autosave",
    apply(editor) {
      editor.addVisualExtension(plugin.extension);
      return { dispose() {} };
    }
  });
  ctx.subscriptions.push(dispDec);

  /** ========== Commands ========== */

  ctx.subscriptions.push(registerSessionFlushCommand({ zion: window.zion, plugin }));

  try {
    let prefetchTimer = 0;
    const schedulePrefetch = () => {
      try { if (prefetchTimer) cancelIdleCallback(prefetchTimer); } catch {}
      try { if (prefetchTimer) clearTimeout(prefetchTimer); } catch {}
      const idle = typeof requestIdleCallback === "function";
      const fn = async () => {
        const ids = window.zion.state.get("ui.editorTabs.openSessionIds");
        const arr = Array.isArray(ids) ? ids : [];
        const uniq = [];
        const seen = new Set();
        for (const it of arr) {
          const s = String(it ?? "").trim();
          if (!s) continue;
          if (seen.has(s)) continue;
          seen.add(s);
          uniq.push(s);
        }
        const cur = window.zion.state.get("sessions.currentId");
        if (cur && !seen.has(cur)) uniq.unshift(cur);
        const max = 6;
        const target = uniq.slice(0, max);
        for (const id of target) {
          try {
            loadMeta(id);
            await loadDocAsync(id);
          } catch {}
        }
      };
      if (idle) prefetchTimer = requestIdleCallback(() => void fn(), { timeout: 1200 });
      else prefetchTimer = setTimeout(() => void fn(), 600);
    };
    const dispTabs = window.zion.state.onDidChange("ui.editorTabs.openSessionIds", () => schedulePrefetch());
    ctx.subscriptions.push({
      dispose() {
        try { dispTabs?.dispose?.(); } catch {}
        try { if (prefetchTimer) cancelIdleCallback(prefetchTimer); } catch {}
        try { if (prefetchTimer) clearTimeout(prefetchTimer); } catch {}
        prefetchTimer = 0;
      }
    });
  } catch {}

  // New empty session
  const dNew = window.zion.commands.registerCommand("zion.sessions.new", async (opts = {}) => {
    const suggested = `Session ${getIndex().length + 1}`;
    const id = genId();
    const text = String(opts?.content ?? "");
    const targetPanelId = opts?.panelId || (() => {
      try { return window.zion?.panels?.getActivePanelId?.() || null; } catch { return null; }
    })();
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
    const parentId = (() => {
      if (opts?.parentId) return opts.parentId;
      const curId = targetPanelId
        ? (window.zion?.panels?.list?.().find((panel) => panel.id === targetPanelId)?.activeTabId || null)
        : window.zion.state.get("sessions.currentId");
      if (curId) {
        const tree = loadTree() || ensureInitialTree();
        const { parent } = findNodeAndParent(tree, curId);
        if (parent && parent.type === "folder") return parent.id;
      }
      return window.zion.state.get("sessions.selectedFolderId") || "root";
    })();
    console.info("[sessions] new: creating", { id, parentId, title: meta.title });
    insertSessionNode(id, parentId, meta.title);
    rebuildIndexFromTree();
    setLastActiveId(id, { push: true });
    window.zion.state.set("sessions.catalog", getIndex());
    try {
      const rs = window.zion.state.get(`chat.runs.${id}`);
      window.zion.state.set("chat.streaming", !!rs?.streaming);
    } catch {}
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
    if (targetPanelId && typeof window.zion?.panels?.openSession === "function") {
      await window.zion.panels.openSession(targetPanelId, id, { focus: opts?.focus !== false, forceReload: true });
    } else {
      window.zion.state.set("sessions.currentId", id);
      const ed = window.zion.window.activeEditor;
      ed?.setValue(text, { source: "session-load" });
      try { applyAnnotationsForSession(id); } catch {}
      ed?.focus?.();
    }
    refreshStatusBar();
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    postSaved(id, meta.updatedAt, meta.hash);
    // 更新页面标题
    updatePageTitle(id);
    return id;
  });
  ctx.subscriptions.push(dNew);

  // Save current content as new session
  const dSaveAsNew = window.zion.commands.registerCommand("zion.sessions.saveAsNew", async () => {
    const target = getActivePanelContext();
    const ed = target.editor;
    const text = ed?.getValue() || "";
    const suggested = `Session ${getIndex().length + 1}`;
    const rawTitle = await openModalInput({
      title: t("dialog.newTitle", "New session title"),
      value: suggested,
      placeholder: "Session title",
      okText: "Create",
      cancelText: "Use default"
    });
    const resolvedTitle = String((rawTitle == null ? suggested : rawTitle) || suggested).trim() || suggested;
    const prevId = target.sessionId;
    const id = genId();
    const isManual = resolvedTitle !== suggested;
    const meta = { id, title: resolvedTitle, createdAt: now(), updatedAt: now(), size: text.length, hash: hashString(text), titleAuto: !isManual };
    try {
      const prevAnn = window.zion?.commands?.executeCommand?.("zion.chatCards.getSessionAnnotations", prevId) || loadMeta(prevId)?.annotations;
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
    window.zion.state.set("sessions.catalog", getIndex());
    try {
      const rs = window.zion.state.get(`chat.runs.${id}`);
      window.zion.state.set("chat.streaming", !!rs?.streaming);
    } catch {}
    await openSessionForPanel(target.panelId, id, { text });
    refreshStatusBar();
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    postSaved(id, meta.updatedAt, meta.hash);
    // 更新页面标题
    updatePageTitle(id);
  });
  ctx.subscriptions.push(dSaveAsNew);

  // Rename
  const dRename = window.zion.commands.registerCommand("zion.sessions.rename", async (opts) => {
    const id = opts?.id || (() => {
      const panelId = opts?.panelId || null;
      if (panelId) {
        try {
          return window.zion?.panels?.list?.().find((panel) => panel.id === panelId)?.activeTabId || null;
        } catch {}
      }
      return window.zion.state.get("sessions.currentId");
    })();
    if (!id) return false;
    const entry = findInIndex(id);
    const nv = String(opts?.title || "");
    const raw = nv
      ? nv
      : await openModalInput({
        title: t("dialog.rename", "Rename session"),
        value: entry?.title || "",
        placeholder: "Session title",
        okText: "Rename",
        cancelText: "Cancel"
      });
    const title = String((raw == null ? (entry?.title || "") : raw) || "").trim();
    if (!title) return false;
    const meta = { ...(loadMeta(id) || {}), id };
    meta.title = title;
    meta.titleAuto = false;
    saveMeta(id, meta);
    try { window.zion.state.set(`sessions.meta.${id}`, meta); } catch {}
    // update tree node title
    const tree = loadTree() || ensureInitialTree();
    const { node } = findNodeAndParent(tree, id);
    if (node && node.type === "session") {
      node.title = title;
      saveTree(tree);
    }
    rebuildIndexFromTree();
    window.zion.state.set("sessions.catalog", getIndex());
    try {
      const panels = window.zion?.panels?.list?.() || [];
      for (const panel of panels) {
        if (panel?.tabs?.some?.((tab) => tab?.id === id)) {
          window.zion.events?.emit?.("panel/tabsChanged", { panelId: panel.id, sessionId: id, reason: "rename" });
        }
      }
      window.zion.events?.emit?.("session/renamed", { id, title, panelId: opts?.panelId || null });
    } catch {}
    refreshStatusBar();
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    // 更新页面标题
    updatePageTitle(id);
    return true;
  });
  ctx.subscriptions.push(dRename);
  const dAutoRename = registerSessionAutoRenameCommand({ zion: window.zion, loadDoc });
  ctx.subscriptions.push(dAutoRename);

  // Delete
  const dDelete = window.zion.commands.registerCommand("zion.sessions.delete", async (id) => {
    const cur = window.zion.state.get("sessions.currentId");
    deleteSession(id);
    const nextId = getLastActiveId() || getIndex()[0]?.id || null;
    window.zion.state.set("sessions.catalog", getIndex());
    await removeSessionFromPanels(id);
    if (id === cur) {
      window.zion.state.set("sessions.currentId", nextId);
      if (nextId) {
        setLastActiveId(nextId);
        if (!window.zion?.panels?.getActivePanelId?.()) {
          try {
            const text = await loadDocAsync(nextId);
            window.zion.window.activeEditor?.setValue(text, { source: "session-load" });
            try { applyAnnotationsForSession(nextId); } catch {}
          } catch {}
        }
      } else {
        window.zion.commands.executeCommand("zion.sessions.new");
      }
    }
    refreshStatusBar();
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    // 更新页面标题（如果当前会话被删除，会切换到新会话）
    updatePageTitle();
    return true;
  });
  ctx.subscriptions.push(dDelete);

  const getTargetEditor = (panelId) => {
    if (panelId) {
      try {
        const panelEditor = window.zion?.panels?.getEditor?.(panelId);
        if (panelEditor) return panelEditor;
      } catch {}
    }
    return window.zion.window.activeEditor;
  };
  const persistSessionPresentation = (sessionId, editor) => {
    if (!sessionId) return;
    try {
      window.zion.commands.executeCommand("zion.sessions.flushPendingSave", sessionId);
    } catch {}
    try {
      const cursor = editor?.getCursor?.();
      const view0 = editor?.core?.view;
      const scrollTop = view0?.scrollDOM?.scrollTop;
      let scrollAnchor = null;
      try {
        if (view0 && typeof scrollTop === "number" && isFinite(scrollTop)) {
          const block = view0.lineBlockAtHeight(scrollTop);
          scrollAnchor = { pos: block.from, yOffset: scrollTop - block.top };
        }
      } catch {}
      sessionUiState.set(sessionId, { cursor, scrollTop, scrollAnchor });
    } catch {}
    try {
      const ann = window.zion?.commands?.executeCommand?.("zion.chatCards.getSessionAnnotations", sessionId);
      if (ann) {
        const metaPrev = loadMeta(sessionId);
        metaPrev.annotations = { ...(metaPrev.annotations || {}), ...ann };
        saveMeta(sessionId, metaPrev);
      }
    } catch {}
    try { maybeUpdateAutoTitle(sessionId); } catch {}
  };

  const restoreSessionViewState = (id, panelId) => {
    try {
      const state = sessionUiState.get(id);
      const ed = getTargetEditor(panelId);
      if (state && ed?.core?.view) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try {
            const view = ed.core.view;
            const cursor = state?.cursor;
            if (cursor && typeof cursor.line === "number" && typeof cursor.ch === "number") {
              const doc = view.state.doc;
              const line = doc.line(Math.max(1, Math.min(doc.lines, cursor.line + 1)));
              const pos = line.from + Math.max(0, Math.min(line.length, cursor.ch));
              view.dispatch({ selection: { anchor: pos } });
            }
            const applyScroll = () => {
              try {
                if (!view?.scrollDOM) return;
                const doc = view.state.doc;
                const anchor = state?.scrollAnchor;
                if (anchor && typeof anchor.pos === "number" && isFinite(anchor.pos)) {
                  const p = Math.max(0, Math.min(doc.length, anchor.pos));
                  const block = view.lineBlockAt(p);
                  const yOff = typeof anchor.yOffset === "number" && isFinite(anchor.yOffset) ? anchor.yOffset : 0;
                  view.scrollDOM.scrollTop = Math.max(0, block.top + yOff);
                  return;
                }
                const st = state?.scrollTop;
                if (typeof st === "number" && isFinite(st)) {
                  view.scrollDOM.scrollTop = Math.max(0, st);
                }
              } catch {}
            };
            applyScroll();
            requestAnimationFrame(() => { try { applyScroll(); } catch {} });
          } catch {}
        }));
      }
    } catch {}
  };

  const documentRuntime = new SessionDocumentRuntime({
    getGlobalSessionId: () => window.zion.state.get("sessions.currentId") || null,
    getPanelSessionId: (panelId) => window.zion?.sessions?.getPanelSessionId?.(panelId) || null,
    setGlobalSessionId: (id) => window.zion.state.set("sessions.currentId", id),
    getTargetEditor,
    persistPreviousSession: persistSessionPresentation,
    setLastActiveId,
    loadDocument: loadDocAsync,
    applyAnnotations: applyAnnotationsForSession,
    restoreUiState: restoreSessionViewState,
    afterSwitch: (id) => {
      try { maybeUpdateAutoTitle(id); } catch {}
      try { window.zion.state.update(`chat.runs.${id}`, (rs) => ({ ...(rs || {}), awaiting: false })); } catch {}
      const rs = window.zion.state.get(`chat.runs.${id}`);
      window.zion.state.set("chat.streaming", !!rs?.streaming);
      refreshStatusBar();
      try { refreshSessionsSidebarViewIfOpen(); } catch {}
    }
  });

  // Switch
  const dSwitch = window.zion.commands.registerCommand("zion.sessions.switch", async (idOrOpts, maybeOpts) => {
    const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts?.id;
    const opts = typeof idOrOpts === "string" ? (maybeOpts || {}) : (idOrOpts || {});
    debugSessions("switch.command.start", {
      id,
      panelId: opts?.panelId || null,
      fromPanelRuntime: !!opts?.__fromPanelRuntime,
      forceReload: !!opts?.forceReload,
      skipPersistPrevious: !!opts?.skipPersistPrevious,
      activePanelId: window.zion?.panels?.getActivePanelId?.() || null,
      currentId: window.zion?.state?.get?.("sessions.currentId") || null
    });
    if (id && opts?.panelId && !opts?.__fromPanelRuntime) {
      try {
        if (typeof window.zion.panels?.openSession === "function") {
          const result = await window.zion.panels.openSession(opts.panelId, id, { focus: opts?.focus !== false, forceReload: opts?.forceReload });
          debugSessions("switch.command.delegatedPanel", { id, panelId: opts.panelId, result });
          return result;
        }
      } catch {}
    }
    if (id && !opts?.panelId) {
      try {
        const panelId = window.zion.panels?.getActivePanelId?.();
        if (panelId && typeof window.zion.panels?.openSession === "function") {
          const result = await window.zion.panels.openSession(panelId, id, { focus: opts?.focus !== false });
          debugSessions("switch.command.delegatedActivePanel", { id, panelId, result });
          return result;
        }
      } catch {}
    }
    const result = await documentRuntime.switchSession({ ...opts, id });
    debugSessions("switch.command.documentRuntimeResult", { id, panelId: opts?.panelId || null, result });
    return result;
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

  ctx.subscriptions.push(
    ...registerSessionDocCommands({
      zion: window.zion,
      loadDoc,
      loadMeta,
      saveDoc,
      saveMeta,
      now,
      hashString,
      upsertIndexEntry,
      getIndex,
      refreshSessionsSidebarViewIfOpen
    })
  );

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
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    try { refreshSessionsOverlayIfOpen(); } catch {}
  });
  const dispRunFinishedUI = window.zion.events.on("chat/runFinished", ({ sessionId }) => {
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    try { refreshSessionsOverlayIfOpen(); } catch {}
  });
  const dispRunErrorUI = window.zion.events.on("chat/runError", ({ sessionId }) => {
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    try { refreshSessionsOverlayIfOpen(); } catch {}
  });
  const dispAbortedUI = window.zion.events.on("chat/aborted", ({ sessionId }) => {
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    try { refreshSessionsOverlayIfOpen(); } catch {}
  });
  ctx.subscriptions.push(dispRunStarted, dispRunFinishedUI, dispRunErrorUI, dispAbortedUI);

  const dispReasoningStart = window.zion.events.on("chat/reasoningStart", async ({ runId, sessionId, silentReasoning }) => {
    try {
      if (silentReasoning) return;
      const cur = window.zion.state.get("sessions.currentId");
      if (!sessionId || sessionId === cur) return; // current session handled by plugin

      // Compute insertion position in background doc
      const hint = window.zion.state.get(`chat.answerAnchorPos.${sessionId}`);
      let start = 0;
      let end = 0;
      await window.zion.commands.executeCommand("zion.sessions.transformDoc", {
        id: sessionId,
        transform: (doc) => {
          const pos = findAssistantBlockEndInText(doc, hint);
          const prevChar = pos > 0 ? doc.slice(pos - 1, pos) : "";
          const prefix = prevChar === "\n" || pos === 0 ? "" : "\n";
          const text = `${prefix}思考\n\n`;
          start = pos + prefix.length;
          end = start + "思考".length;
          return doc.slice(0, pos) + text + doc.slice(pos);
        }
      });

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

  const dispReasoningToken = window.zion.events.on("chat/reasoningToken", ({ runId, sessionId, token, silentReasoning }) => {
    try {
      if (silentReasoning) return;
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

  const dispToolCall = window.zion.events.on("chat/toolCall", async ({ runId, sessionId, toolCall }) => {
    try {
      const cur = window.zion.state.get("sessions.currentId");
      if (!sessionId || sessionId === cur) return;
      const name = toolCall?.name || "tool";

      const hint = window.zion.state.get(`chat.answerAnchorPos.${sessionId}`);
      let start = 0;
      let end = 0;
      await window.zion.commands.executeCommand("zion.sessions.transformDoc", {
        id: sessionId,
        transform: (doc) => {
          const pos = findAssistantBlockEndInText(doc, hint);
          const prevChar = pos > 0 ? doc.slice(pos - 1, pos) : "";
          const prefix = prevChar === "\n" || pos === 0 ? "" : "\n";
          const text = `${prefix}调用 ${name}\n`;
          start = pos + prefix.length;
          end = start + (`调用 ${name}`).length;
          return doc.slice(0, pos) + text + doc.slice(pos);
        }
      });

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
    return (async () => {
    const target = getActivePanelContext();
    const srcId = id || target.sessionId;
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
    window.zion.state.set("sessions.catalog", getIndex());
    await openSessionForPanel(target.panelId, newId, { text });
    refreshStatusBar();
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    postSaved(newId, meta.updatedAt, meta.hash);
    // 更新页面标题
    updatePageTitle(newId);
    return true;
    })();
  });
  ctx.subscriptions.push(dClone);

  const buildForkTitle = (baseTitle, siblingTitles) => {
    const base = String(baseTitle || "Untitled Session").trim() || "Untitled Session";
    const used = new Set((Array.isArray(siblingTitles) ? siblingTitles : []).map((t) => String(t || "").trim()).filter(Boolean));
    const first = `${base} (Fork)`;
    if (!used.has(first)) return first;
    for (let i = 2; i < 1000; i++) {
      const next = `${base} (Fork ${i})`;
      if (!used.has(next)) return next;
    }
    return `${base} (Fork ${Date.now()})`;
  };

  const dFork = window.zion.commands.registerCommand("zion.sessions.fork", async (id) => {
    const req = id && typeof id === "object" ? id : null;
    const sourcePanelId = req?.panelId || window.zion?.panels?.getActivePanelId?.() || null;
    const panelSessionId = sourcePanelId
      ? (window.zion?.panels?.list?.().find((panel) => panel.id === sourcePanelId)?.activeTabId || null)
      : null;
    const srcId = (typeof id === "string" ? id : null)
      || req?.id
      || req?.sessionId
      || panelSessionId
      || window.zion.state.get("sessions.currentId");
    if (!srcId) return false;
    const srcText = await loadDocAsync(srcId);
    const srcMeta = loadMeta(srcId) || { title: "Session" };
    const tree = loadTree() || ensureInitialTree();
    const { parent } = findNodeAndParent(tree, srcId);
    const siblings = Array.isArray(parent?.children) ? parent.children : [];
    const siblingTitles = siblings
      .filter((child) => child?.type === "session" && child?.id !== srcId)
      .map((child) => child?.title || child?.id);
    const newTitle = buildForkTitle(srcMeta.title || srcId, siblingTitles);
    const nextId = genId();
    const copiedMeta = safeJSONParse(JSON.stringify(srcMeta || {}), {}) || {};
    const meta = {
      ...copiedMeta,
      id: nextId,
      title: newTitle,
      createdAt: now(),
      updatedAt: now(),
      size: srcText.length,
      hash: hashString(srcText),
      titleAuto: false
    };
    saveDoc(nextId, srcText);
    saveMeta(nextId, meta);
    insertSessionNodeAfter(nextId, srcId, meta.title);
    rebuildIndexFromTree();
    window.zion.state.set("sessions.catalog", getIndex());
    const targetPanelId = window.zion?.panels?.ensureAtSide?.("right", sourcePanelId || undefined) || sourcePanelId || null;
    if (targetPanelId) {
      try {
        window.zion.panels.focus(targetPanelId);
      } catch {}
      try {
        window.zion.panels.openSession(targetPanelId, nextId, { focus: true });
      } catch {
        try {
          await window.zion.commands.executeCommand("zion.sessions.switch", { id: nextId, panelId: targetPanelId });
        } catch {}
      }
    } else {
      window.zion.state.set("sessions.currentId", nextId);
      try {
        window.zion.window.activeEditor?.setValue(srcText, { source: "session-load" });
        applyAnnotationsForSession(nextId);
      } catch {}
    }
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    refreshStatusBar();
    postSaved(nextId, meta.updatedAt, meta.hash);
    updatePageTitle(nextId);
    return nextId;
  });
  ctx.subscriptions.push(dFork);

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
      try { refreshSessionsSidebarViewIfOpen(); } catch {}
      window.zion.notification?.show?.("Sessions imported successfully", {
        type: "success",
        duration: 3000
      });
    } else {
      window.zion.notification?.show?.("Failed to import sessions", {
        type: "error",
        duration: 5000
      });
    }
    return ok;
  });
  ctx.subscriptions.push(dImport);

  // Bulk selection commands
  const dDeleteSelected = window.zion.commands.registerCommand("zion.sessions.deleteSelected", async () => {
    const sel = getSelection();
    if (!sel.length) return false;
    const ok = await openModalConfirm({
      title: t("dialog.deleteSelected", "Delete selected"),
      message: `Delete ${sel.length} selected item(s)? This cannot be undone.`,
      okText: "Delete",
      cancelText: "Cancel"
    });
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
    if (affectedCurrent) {
      const nextId = getLastActiveId() || getIndex()[0]?.id || null;
      await Promise.all(sel.filter((it) => it.type !== "folder").map((it) => removeSessionFromPanels(it.id)));
      window.zion.state.set("sessions.currentId", nextId);
      if (nextId) {
        setLastActiveId(nextId);
        if (!window.zion?.panels?.getActivePanelId?.()) {
          window.zion.window.activeEditor?.setValue(loadDoc(nextId), { source: "session-load" });
        }
      }
    } else {
      await Promise.all(sel.filter((it) => it.type !== "folder").map((it) => removeSessionFromPanels(it.id)));
    }
    window.zion.state.set("sessions.catalog", getIndex());
    refreshStatusBar();
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
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
    const parentId = String(opts?.parentId || window.zion.state.get("sessions.selectedFolderId") || "root") || "root";
    const title = String(opts?.title || "").trim() || "New Folder";
    const shouldStartInlineRename = opts?.startInlineRename !== false;
    const targetView = String(opts?.targetView || "").trim() || null;
    const id = insertFolder(parentId, title);
    try { openAncestors(id); } catch {}
    try { setFolderOpen(parentId, true); } catch {}
    try { setSelection([{ id, type: "folder" }]); } catch {}
    try { setLastSelectedId(id); } catch {}
    try { window.zion.state.set("sessions.selectedFolderId", id); } catch {}
    if (shouldStartInlineRename) {
      try {
        window.zion.state.set(PENDING_INLINE_EDIT_KEY, {
          id,
          type: "folder",
          isNew: true,
          targetView
        });
      } catch {}
    }
    window.zion.state.set("sessions.catalog", getIndex());
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    return id;
  });
  const dRenameFolder = window.zion.commands.registerCommand("zion.sessions.renameFolder", (opts) => {
    const tree = loadTree() || ensureInitialTree();
    const { node } = findNodeAndParent(tree, opts?.id);
    if (!node || node.type !== "folder") return false;
    node.title = String(opts?.title || node.title || "Folder");
    saveTree(tree);
    window.zion.state.set("sessions.catalog", getIndex());
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    return true;
  });
  const dDeleteFolder = window.zion.commands.registerCommand("zion.sessions.deleteFolder", (id) => {
    const ok = removeNodeRecursive(id);
    window.zion.state.set("sessions.catalog", getIndex());
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
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
        title: t("cmd.new", "新建会话"),
        description: t("slash.new.description", "创建新的会话"),
        priority: 100
      },
      {
        id: "zion.sessions.showPanel",
        triggers: ["sessions", "show-sessions", "session-panel"],
        title: t("cmd.showPanel", "显示会话面板"),
        description: t("slash.showPanel.description", "打开会话管理面板"),
        priority: 90
      },
      {
        id: "zion.sessions.toggleSidebar",
        triggers: ["sidebar", "sessions-sidebar"],
        title: t("cmd.toggleSidebar", "切换会话侧边栏"),
        description: t("slash.toggleSidebar.description", "显示/隐藏会话侧边栏"),
        priority: 80
      },
      {
        id: "zion.sessions.saveAsNew",
        triggers: ["save-as", "save-session"],
        title: t("cmd.saveAsNew", "另存为新会话"),
        description: t("slash.saveAsNew.description", "将当前内容另存为新会话"),
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
