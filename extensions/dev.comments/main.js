import { Prec } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from "@codemirror/view";
import { EditorCore } from "../../src/editor/EditorCore.ts";
import { createChatOverviewRail } from "../dev.langchain-chat/overview-rail.js";

const VIEW_ID = "dev.comments.panel";
const I18N_NS = "dev.comments";
const STORAGE_KEY = "zion.comments.threads.v1";
const ACTIVE_KEY = "comments.activeThreadId";
const CHANGED_EVENT = "comments/changed";
let pendingFocusThreadId = "";
let pendingRevealThreadId = "";
let lastCommentsEditorHandle = null;
let lastCommentSourceFocus = null;
const annotationPersistTimers = new Map();

// #region debug-point D:comments-focus-return-logger
const FOCUS_RETURN_DEBUG_URL = "http://127.0.0.1:7777/event";
const FOCUS_RETURN_DEBUG_SESSION = "focus-return-scroll-jump";
function reportFocusReturnDebug(hypothesisId, location, msg, data = {}) {
  try {
    fetch(FOCUS_RETURN_DEBUG_URL, {
      method: "POST",
      body: JSON.stringify({
        sessionId: FOCUS_RETURN_DEBUG_SESSION,
        runId: "post-fix",
        hypothesisId,
        location,
        msg: `[DEBUG] ${msg}`,
        data,
        ts: Date.now()
      })
    }).catch(() => {});
  } catch {}
}
function getEditorScrollDebugSnapshot(editor) {
  try {
    const view = editor?.getView?.();
    const scroller = view?.scrollDOM;
    const selection = view?.state?.selection?.main;
    return {
      panelId: editor?.panelId || "",
      sessionId: editor?.sessionId || "",
      hasView: !!view,
      hasFocus: !!view?.hasFocus,
      documentHidden: document.hidden,
      scrollTop: scroller?.scrollTop ?? null,
      scrollHeight: scroller?.scrollHeight ?? null,
      clientHeight: scroller?.clientHeight ?? null,
      viewportFrom: view?.viewport?.from ?? null,
      viewportTo: view?.viewport?.to ?? null,
      selectionHead: selection?.head ?? null
    };
  } catch {
    return {};
  }
}
// #endregion

const I18N_MESSAGES = {
  "zh-CN": {
    "title": "评论",
    "cmd.openPanel": "打开评论面板",
    "cmd.openPanel.description": "打开右侧评论面板",
    "cmd.createFromSelection": "为选区创建评论",
    "cmd.createFromSelection.description": "基于当前编辑器选区创建一个评论线程",
    "cmd.focusEditor": "聚焦评论编辑器",
    "cmd.focusEditor.description": "聚焦当前评论线程的编辑器",
    "cmd.focusSource": "返回评论来源",
    "cmd.focusSource.description": "从评论编辑器返回主编辑器中的评论来源",
    "toolbar.createThread": "创建评论线程",
    "toolbar.comment": "评论",
    "thread.created": "已创建评论线程",
    "anchor.open": "打开评论",
    "anchor.count": "{count} 条评论",
    "stats.open": "{count} open",
    "stats.resolved": "{count} resolved",
    "stats.lost": "{count} lost",
    "empty.title": "还没有评论线程",
    "empty.description": "选中文本后点击工具条里的“评论”，这里会出现锚定讨论。",
    "row.open": "打开并定位到正文评论位置",
    "row.orphan": "打开评论，原文锚点已丢失",
    "row.fallback": "评论",
    "quote.label": "引用 L{from}-{to}",
    "quote.relocated": "已重定位",
    "quote.lost": "锚点已丢失",
    "quote.back": "跳回正文锚点",
    "quote.unavailable": "原文已变化或删除，无法跳回锚点",
    "run.start": "发起会话",
    "run.stop": "停止回答",
    "thread.promote": "提升为独立会话",
    "thread.delete": "删除评论",
    "thread.anchorLost": "评论锚点已丢失：原文已变化或删除",
    "thread.promoted": "已提升为正式会话",
    "thread.promoteFailed": "提升失败：{message}",
    "thread.promotedTitle": "Comment: {title}",
    "status.streaming": "回答中",
    "status.ready": "可继续对话",
    "status.error": "出错",
    "status.aborted": "已停止",
    "status.idle": "未运行"
  },
  "en-US": {
    "title": "Comments",
    "cmd.openPanel": "Open Comments",
    "cmd.openPanel.description": "Open the right-side Comments panel",
    "cmd.createFromSelection": "Create Comment From Selection",
    "cmd.createFromSelection.description": "Create a comment thread from the current editor selection",
    "cmd.focusEditor": "Focus Comment Editor",
    "cmd.focusEditor.description": "Focus the active comment thread editor",
    "cmd.focusSource": "Focus Comment Source",
    "cmd.focusSource.description": "Return from the comment editor to the source editor",
    "toolbar.createThread": "Create comment thread",
    "toolbar.comment": "Comment",
    "thread.created": "Comment thread created",
    "anchor.open": "Open comments",
    "anchor.count": "{count} comments",
    "stats.open": "{count} open",
    "stats.resolved": "{count} resolved",
    "stats.lost": "{count} lost",
    "empty.title": "No comment threads yet",
    "empty.description": "Select text and click “Comment” in the toolbar to start an anchored discussion.",
    "row.open": "Open and reveal the source comment anchor",
    "row.orphan": "Open comment; source anchor is missing",
    "row.fallback": "Comment",
    "quote.label": "Quote L{from}-{to}",
    "quote.relocated": "relocated",
    "quote.lost": "Anchor missing",
    "quote.back": "Jump back to source anchor",
    "quote.unavailable": "Source text changed or was deleted; cannot jump back to anchor",
    "run.start": "Start Chat",
    "run.stop": "Stop Answer",
    "thread.promote": "Promote to standalone session",
    "thread.delete": "Delete comment",
    "thread.anchorLost": "Comment anchor is missing: source text changed or was deleted",
    "thread.promoted": "Promoted to a formal session",
    "thread.promoteFailed": "Promote failed: {message}",
    "thread.promotedTitle": "Comment: {title}",
    "status.streaming": "Answering",
    "status.ready": "Ready to continue",
    "status.error": "Error",
    "status.aborted": "Stopped",
    "status.idle": "Not running"
  }
};

function t(key, fallback, values) {
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

function now() {
  return Date.now();
}

function uid() {
  return `c_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getSessionId(editor) {
  try {
    const panelId = editor?.panelId || window.zion?.panels?.getActivePanelId?.();
    if (panelId) {
      const item = window.zion?.panels?.list?.().find((p) => p.id === panelId);
      if (item?.activeTabId) return String(item.activeTabId);
    }
  } catch {}
  try {
    return window.zion?.state?.get?.("sessions.currentId") || "global";
  } catch {
    return "global";
  }
}

function getThreadSessionId(thread) {
  if (thread?.threadSessionId) return String(thread.threadSessionId);
  if (thread?.id) return `comment:${thread.id}`;
  return `comment:${uid()}`;
}

function readAllThreads() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeAllThreads(list, opts = {}) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.isArray(list) ? list : []));
  } catch {}
  if (!opts.silent) emitChanged();
}

function emitChanged() {
  try { window.zion?.events?.emit?.(CHANGED_EVENT, {}); } catch {}
  try { window.dispatchEvent(new CustomEvent("zion:comments-changed")); } catch {}
}

function getThreadsForSession(sessionId) {
  return readAllThreads()
    .filter((item) => String(item?.sessionId || "global") === String(sessionId || "global"));
}

function getThreadSourceSessionId(thread) {
  return String(thread?.parentSessionId || thread?.sessionId || "global");
}

function findPanelForSession(sessionId, preferredPanelId = "") {
  const sid = String(sessionId || "");
  if (!sid) return null;
  try {
    const panels = window.zion?.panels?.list?.() || [];
    const preferred = preferredPanelId
      ? panels.find((panel) => panel?.id === preferredPanelId && String(panel?.activeTabId || "") === sid)
      : null;
    if (preferred) return preferred;
    return panels.find((panel) => String(panel?.activeTabId || "") === sid) || null;
  } catch {
    return null;
  }
}

function getCurrentPanelIdForThread(thread) {
  const sessionId = getThreadSourceSessionId(thread);
  const panel = findPanelForSession(sessionId, thread?.panelId || "");
  return panel?.id || "";
}

function sortThreadsByDocumentOrder(threads, anchorById) {
  const orderOf = (item) => {
    const anchor = anchorById?.get?.(item?.id);
    if (anchor && typeof anchor.from === "number") return anchor.from;
    if (typeof item?.from === "number") return item.from;
    if (typeof item?.lineFrom === "number") return item.lineFrom * 1000000;
    return Number.MAX_SAFE_INTEGER;
  };
  return [...(Array.isArray(threads) ? threads : [])].sort((a, b) => {
    const ao = orderOf(a);
    const bo = orderOf(b);
    if (ao !== bo) return ao - bo;
    return (a?.createdAt || 0) - (b?.createdAt || 0);
  });
}

function compactText(value, max = 88) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function cssEscape(value) {
  try {
    return CSS.escape(String(value || ""));
  } catch {
    return String(value || "").replace(/["\\]/g, "\\$&");
  }
}

function formatCompactTime(ts) {
  const value = Number(ts) || 0;
  if (!value) return "";
  const diff = Math.max(0, Date.now() - value);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "now";
  if (diff < hour) return `${Math.floor(diff / minute)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  return `${Math.floor(diff / day)}d`;
}

function saveThread(thread) {
  const list = readAllThreads();
  const idx = list.findIndex((item) => item?.id === thread?.id);
  if (idx >= 0) list[idx] = thread;
  else list.unshift(thread);
  writeAllThreads(list);
}

function patchThread(id, patch, opts = {}) {
  const list = readAllThreads();
  const idx = list.findIndex((item) => item?.id === id);
  if (idx < 0) return null;
  const next = { ...list[idx], ...(patch || {}), updatedAt: now() };
  list[idx] = next;
  writeAllThreads(list, opts);
  return next;
}

function deleteThread(id) {
  writeAllThreads(readAllThreads().filter((item) => item?.id !== id));
}

function getActiveThread() {
  const id = window.zion?.state?.get?.(ACTIVE_KEY);
  return readAllThreads().find((item) => item?.id === id) || null;
}

function isCommentPanelId(panelId) {
  return String(panelId || "").startsWith("comments:");
}

function rememberSourceFocus(editor) {
  try {
    const panelId = String(editor?.panelId || "");
    if (!editor || isCommentPanelId(panelId)) return;
    const view = editor.getView?.();
    const sel = view?.state?.selection?.main;
    lastCommentSourceFocus = {
      panelId,
      sessionId: getSessionId(editor),
      anchor: typeof sel?.anchor === "number" ? sel.anchor : null,
      head: typeof sel?.head === "number" ? sel.head : null
    };
  } catch {}
}

function focusEditorSource(thread = null, opts = {}) {
  const currentPanelId = thread ? getCurrentPanelIdForThread(thread) : "";
  const threadTarget = thread
    ? { panelId: currentPanelId || thread.panelId || "", sessionId: getThreadSourceSessionId(thread), anchor: thread.from, head: thread.from }
    : null;
  const target =
    (lastCommentSourceFocus && (!threadTarget || lastCommentSourceFocus.panelId === threadTarget.panelId) ? lastCommentSourceFocus : null) ||
    threadTarget ||
    null;
  const panelId = String(target?.panelId || "");
  const focusTargetEditor = () => {
    const editor = panelId
      ? (window.zion?.panels?.getEditorBySession?.(panelId, target?.sessionId) || window.zion?.panels?.getEditor?.(panelId) || null)
      : (window.zion?.window?.activeEditor || null);
    const view = editor?.getView?.();
    if (view && opts.reveal === true) {
      try {
        const len = view.state.doc.length;
        const anchor = Math.max(0, Math.min(len, Number(target?.anchor) || 0));
        // Returning focus should not create a selection; reveal mode only moves the caret.
        view.dispatch({ selection: { anchor }, scrollIntoView: true });
      } catch {}
    }
    try { editor?.focus?.(); } catch {}
    try { view?.focus?.(); } catch {}
    return !!editor;
  };
  if (panelId) {
    try {
      const activeTabId = window.zion?.panels?.list?.()?.find?.((panel) => panel?.id === panelId)?.activeTabId || "";
      if (target?.sessionId && activeTabId !== target.sessionId) {
        const opened = window.zion?.panels?.openSession?.(panelId, target.sessionId, { focus: false });
        Promise.resolve(opened).then(() => requestAnimationFrame(focusTargetEditor)).catch(() => requestAnimationFrame(focusTargetEditor));
        try { window.zion?.panels?.focus?.(panelId); } catch {}
        return true;
      }
    } catch {}
    try { window.zion?.panels?.focus?.(panelId); } catch {}
  }
  return focusTargetEditor();
}

function focusCommentEditor() {
  const sourceEditor = window.zion?.window?.activeEditor || null;
  rememberSourceFocus(sourceEditor);
  openCommentsPanel();
  const focus = () => {
    try {
      lastCommentsEditorHandle?.proxy?.focus?.();
      lastCommentsEditorHandle?.view?.focus?.();
    } catch {}
  };
  try { requestAnimationFrame(() => requestAnimationFrame(focus)); } catch { setTimeout(focus, 0); }
  return true;
}

function setActiveThread(id) {
  const next = id || "";
  try {
    if ((window.zion?.state?.get?.(ACTIVE_KEY) || "") === next) return;
    window.zion?.state?.set?.(ACTIVE_KEY, next);
  } catch {
    emitChanged();
  }
}

function isThreadStreaming(thread) {
  const sid = getThreadSessionId(thread);
  try {
    if (typeof window.zion?.chat?.isStreaming === "function") return !!window.zion.chat.isStreaming(sid);
  } catch {}
  try {
    return !!window.zion?.state?.get?.(`chat.runs.${sid}`)?.streaming;
  } catch {
    return false;
  }
}

function getThreadRunStatus(thread) {
  const sid = getThreadSessionId(thread);
  try {
    const state = window.zion?.state?.get?.(`chat.runs.${sid}`) || null;
    if (state?.streaming) return "streaming";
    if (state?.error) return "error";
    if (state?.aborted) return "aborted";
    if (state?.awaiting) return "ready";
  } catch {}
  return "idle";
}

function threadRunStatusTitle(status) {
  if (status === "streaming") return t("status.streaming", "Answering");
  if (status === "ready") return t("status.ready", "Ready to continue");
  if (status === "error") return t("status.error", "Error");
  if (status === "aborted") return t("status.aborted", "Stopped");
  return t("status.idle", "Not running");
}

function renderThreadStatusDot(thread) {
  const sid = getThreadSessionId(thread);
  const status = getThreadRunStatus(thread);
  return `<span class="zion-comments-session-dot is-${status}" data-session-id="${escapeHtml(sid)}" title="${escapeHtml(threadRunStatusTitle(status))}"></span>`;
}

function updateThreadStatusIndicators(root) {
  try {
    root?.querySelectorAll?.(".zion-comments-session-dot[data-session-id]")?.forEach((dot) => {
      const sid = dot.getAttribute("data-session-id") || "";
      const state = window.zion?.state?.get?.(`chat.runs.${sid}`) || null;
      const status = state?.streaming ? "streaming" : state?.error ? "error" : state?.aborted ? "aborted" : state?.awaiting ? "ready" : "idle";
      dot.className = `zion-comments-session-dot is-${status}`;
      dot.title = threadRunStatusTitle(status);
    });
  } catch {}
}

function lineRangeFor(view, from, to) {
  try {
    const doc = view.state.doc;
    const a = doc.lineAt(Math.max(0, Math.min(doc.length, from)));
    const b = doc.lineAt(Math.max(0, Math.min(doc.length, to)));
    return { startLine: a.number - 1, endLine: b.number - 1 };
  } catch {
    return { startLine: 0, endLine: 0 };
  }
}

function getAnchorText(thread) {
  return String(thread?.anchorText || thread?.quote || "");
}

function locateThreadAnchor(view, thread) {
  try {
    if (!view || !thread) return null;
    const text = getAnchorText(thread);
    if (!text) return null;
    const doc = view.state.doc;
    const docLen = doc.length;
    const savedFrom = Math.max(0, Math.min(docLen, Number(thread.from) || 0));
    const savedTo = Math.max(savedFrom, Math.min(docLen, Number(thread.to) || savedFrom));

    const candidates = [
      [savedFrom, savedTo],
      [savedFrom, Math.min(docLen, savedFrom + text.length)]
    ];
    for (const [from, to] of candidates) {
      if (to > from && doc.sliceString(from, to) === text) {
        const lines = lineRangeFor(view, from, to);
        return { from, to, ...lines, relocated: false };
      }
    }

    const found = doc.toString().indexOf(text);
    if (found >= 0) {
      const from = found;
      const to = found + text.length;
      const lines = lineRangeFor(view, from, to);
      return { from, to, ...lines, relocated: true };
    }
  } catch {}
  return null;
}

function createThreadFromSelection({ view, from, to, selectionText }) {
  const editor = window.zion?.window?.activeEditor || null;
  const sessionId = getSessionId(editor);
  const doc = view?.state?.doc;
  if (!view || !doc) return null;
  let anchorFrom = Math.max(0, Math.min(doc.length, Number(from) || 0));
  let anchorTo = Math.max(anchorFrom, Math.min(doc.length, Number(to) || anchorFrom));
  let anchorText = String(selectionText || view.state.sliceDoc(anchorFrom, anchorTo) || "");
  let quote = anchorText.trim();
  if (!quote) {
    const line = doc.lineAt(anchorFrom);
    anchorFrom = line.from;
    anchorTo = line.to;
    anchorText = view.state.sliceDoc(anchorFrom, anchorTo);
    quote = anchorText.trim() || `L${line.number}`;
  }
  const lines = lineRangeFor(view, anchorFrom, anchorTo);
  const id = uid();
  const thread = {
    id,
    sessionId,
    parentSessionId: sessionId,
    threadSessionId: `comment:${id}`,
    panelId: editor?.panelId || null,
    from: anchorFrom,
    to: anchorTo,
    startLine: lines.startLine,
    endLine: lines.endLine,
    anchorText,
    quote: quote.slice(0, 4000),
    body: "",
    resolved: false,
    createdAt: now(),
    updatedAt: now()
  };
  saveThread(thread);
  setActiveThread(thread.id);
  pendingFocusThreadId = thread.id;
  openCommentsPanel();
  try {
    window.zion?.notification?.show?.(t("thread.created", "Comment thread created"), { type: "success", duration: 1400 });
  } catch {}
  return thread;
}

function openCommentsPanel() {
  try { window.zion?.auxiliaryBar?.setWidth?.(Math.max(360, window.zion?.state?.get?.("ui.auxiliaryBar.width") || 0)); } catch {}
  try { window.zion?.auxiliaryBar?.activateView?.(VIEW_ID); } catch {}
}

function getEditorForThread(thread, opts = {}) {
  if (opts.editor) return opts.editor;
  const sessionId = getThreadSourceSessionId(thread);
  try {
    const currentPanelId = getCurrentPanelIdForThread(thread);
    if (currentPanelId) {
      const panelEditor = window.zion?.panels?.getEditorBySession?.(currentPanelId, sessionId)
        || window.zion?.panels?.getEditor?.(currentPanelId);
      if (panelEditor) {
        if (thread?.panelId !== currentPanelId) patchThread(thread.id, { panelId: currentPanelId }, { silent: true });
        return panelEditor;
      }
    }
  } catch {}
  try {
    if (thread?.panelId) {
      const panel = findPanelForSession(sessionId, thread.panelId);
      if (panel?.id) {
        const panelEditor = window.zion?.panels?.getEditorBySession?.(panel.id, sessionId)
          || window.zion?.panels?.getEditor?.(panel.id);
        if (panelEditor) return panelEditor;
      }
    }
  } catch {}
  try {
    const active = window.zion?.window?.activeEditor;
    if (active && !isCommentPanelId(active?.panelId) && String(getSessionId(active) || "") === sessionId) return active;
  } catch {}
  return null;
}

function revealThread(threadId, opts = {}) {
  const thread = typeof threadId === "object"
    ? threadId
    : readAllThreads().find((item) => item?.id === threadId) || null;
  if (!thread) return false;
  pendingRevealThreadId = thread.id || "";
  setActiveThread(thread.id);
  openCommentsPanel();
  revealThreadAnchor(thread, { focus: false, editor: getEditorForThread(thread, opts) });
  try {
    window.requestAnimationFrame(() => {
      try {
        const selector = `.zion-comments-row[data-thread-id="${cssEscape(thread.id)}"]`;
        document.querySelector(selector)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      } catch {}
    });
  } catch {}
  return true;
}

class CommentMarkerWidget extends WidgetType {
  constructor(count, threadId) {
    super();
    this.count = count;
    this.threadId = threadId;
  }
  eq(other) {
    return other?.count === this.count && other?.threadId === this.threadId;
  }
  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "zion-comment-anchor";
    button.title = this.count > 1 ? t("anchor.count", "{count} comments", { count: this.count }) : t("anchor.open", "Open comments");
    button.setAttribute("aria-label", button.title);
    button.textContent = this.count > 1 ? String(this.count) : "⋯";
    button.onclick = (event) => {
      try { event.preventDefault(); event.stopPropagation(); } catch {}
      setActiveThread(this.threadId);
      openCommentsPanel();
    };
    return button;
  }
  ignoreEvent() {
    return false;
  }
}

function buildCommentDecorations(view, editor) {
  const sessionId = getSessionId(editor);
  const threads = getThreadsForSession(sessionId).filter((item) => !item.resolved);
  if (!threads.length) return Decoration.none;
  const ranges = [];
  for (const thread of threads) {
    const anchor = locateThreadAnchor(view, thread);
    if (!anchor) continue;
    if (anchor.to > anchor.from) {
      ranges.push(Decoration.mark({ class: "zion-comment-range" }).range(anchor.from, anchor.to));
    }
    ranges.push(
      Decoration.widget({
        widget: new CommentMarkerWidget(1, thread.id),
        side: 1
      }).range(anchor.to)
    );
  }
  return Decoration.set(ranges, true);
}

function installCommentAnchors(editor) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.editor = editor;
        this.decorations = buildCommentDecorations(view, this.editor);
        this.onChanged = () => {
          this.decorations = buildCommentDecorations(this.view, this.editor);
          try { this.view.dispatch({}); } catch {}
        };
        try { window.addEventListener("zion:comments-changed", this.onChanged); } catch {}
      }
      update(update) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildCommentDecorations(update.view, this.editor);
        }
        if (update.docChanged) {
          try { window.dispatchEvent(new CustomEvent("zion:comments-anchor-updated")); } catch {}
        }
      }
      destroy() {
        try { window.removeEventListener("zion:comments-changed", this.onChanged); } catch {}
      }
    },
    { decorations: (value) => value.decorations }
  );
}

function buildThreadContextMessages(thread) {
  const system = [
    "你正在回复 Zion Comments 中的一个独立评论会话。",
    "这个会话独立于主编辑器，但继承主文档中被评论片段的上下文。",
    "请重点围绕被评论片段回答，必要时给出可执行的修改建议；不要假设你正在直接编辑主文档。",
    "",
    `主会话 ID：${thread?.parentSessionId || thread?.sessionId || "unknown"}`,
    `评论线程 ID：${thread?.id || "unknown"}`,
    `锚点行：${thread?.lineFrom || "?"}-${thread?.lineTo || "?"}`,
    "",
    "被评论片段：",
    thread?.anchorText || thread?.quote || "（无）"
  ].join("\n");
  return [{ role: "system", content: system }];
}

function createThreadEditor(container, thread, onSave, onRun) {
  let saveTimer = 0;
  const panelId = `comments:${thread.id}`;
  const sessionId = getThreadSessionId(thread);
  const initialValue = typeof thread?.body === "string" ? thread.body : "";
  const core = new EditorCore(container, initialValue, panelId);
  core.setSessionId(sessionId);
  try { core.setLineNumbersEnabled(false); } catch {}
  try { core.setFoldingEnabled(false); } catch {}
  try { core.setActiveLineHighlightEnabled(false); } catch {}
  const proxy = window.zion?.editor?.attachEditor?.(core, panelId) || null;
  try { proxy?.setSessionId?.(sessionId); } catch {}
  const view = core.view;
  try { core.addExternalExtension(EditorView.editorAttributes.of({ class: "zion-comments-thread-editor" })); } catch {}
  let overviewRail = null;
  try { overviewRail = createChatOverviewRail(proxy || core); } catch {}
  try {
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
  } catch {}
  try {
    core.addExternalExtension(EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => onSave(view.state.doc.toString()), 250);
    }));
  } catch {}
  try {
    core.addExternalExtension(Prec.highest(keymap.of([
      {
        key: "Mod-Enter",
        run() {
          onSave(view.state.doc.toString());
          onRun?.({ core, proxy, view, panelId, sessionId });
          return true;
        }
      },
      {
        key: "Escape",
        run() {
          try { window.zion?.commands?.executeCommand?.("chat.stop", sessionId); } catch {}
          return true;
        }
      },
      {
        key: "Mod-Shift-c",
        run() {
          onSave(view.state.doc.toString());
          return focusEditorSource(thread);
        }
      }
    ])));
  } catch {}
  return {
    core,
    proxy,
    view,
    panelId,
    sessionId,
    dispose() {
      if (saveTimer) window.clearTimeout(saveTimer);
      try { onSave(view.state.doc.toString()); } catch {}
      try {
        window.zion?.commands?.executeCommand?.("zion.chatCards.snapshotSession", { sessionId, panelId });
        persistThreadAnnotations(thread, getSessionAnnotations(sessionId));
      } catch {}
      try { overviewRail?.dispose?.(); } catch {}
      try { window.zion?.editor?.detachEditor?.(panelId); } catch {}
      if (lastCommentsEditorHandle?.panelId === panelId) lastCommentsEditorHandle = null;
      core.dispose();
    }
  };
}

function renderCommentsPanel(container) {
  const root = document.createElement("div");
  root.className = "zion-comments-panel";
  container.appendChild(root);
  let editorHandle = null;
  let disposed = false;
  let updateRunAction = null;
  let listScrollTop = 0;

  const disposables = [];
  let renderScheduled = false;
  let suppressNextActiveThreadSchedule = false;
  let lastRenderedSessionId = "";
  const schedule = () => {
    if (disposed) return;
    if (renderScheduled) return;
    renderScheduled = true;
    window.requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  };
  try { disposables.push(window.zion?.state?.onDidChange?.(ACTIVE_KEY, (payload) => {
    if (suppressNextActiveThreadSchedule) {
      suppressNextActiveThreadSchedule = false;
      return;
    }
    schedule(payload);
  })); } catch {}
  try { disposables.push(window.zion?.events?.on?.(CHANGED_EVENT, schedule)); } catch {}
  try { disposables.push(window.zion?.events?.on?.("panel/tabActivated", (payload) => {
    const payloadSessionId = String(payload?.sessionId || payload?.tabId || "");
    if (editorHandle && payloadSessionId && payloadSessionId === lastRenderedSessionId) {
      return;
    }
    schedule(payload);
  })); } catch {}
  const refreshRunAction = (payload) => {
    if (disposed) return;
    try { updateRunAction?.(payload); } catch {}
    updateThreadStatusIndicators(root);
  };
  try { disposables.push(window.zion?.events?.on?.("chat/runStarted", refreshRunAction)); } catch {}
  try { disposables.push(window.zion?.events?.on?.("chat/runFinished", refreshRunAction)); } catch {}
  try { disposables.push(window.zion?.events?.on?.("chat/aborted", refreshRunAction)); } catch {}
  try { disposables.push(window.zion?.events?.on?.("chat/runError", refreshRunAction)); } catch {}
  try { disposables.push(window.zion?.events?.on?.("i18n/changed", schedule)); } catch {}
  const restoreActiveThreadCards = () => {
    try {
      const sid = editorHandle?.sessionId;
      // #region debug-point D:comments-restore-entry
      reportFocusReturnDebug("D", "extensions/dev.comments/main.js:restoreActiveThreadCards", "comments restoreActiveThreadCards entry", {
        sid: sid || "",
        editorHandlePanelId: editorHandle?.panelId || "",
        activeEditor: getEditorScrollDebugSnapshot(window.zion?.window?.activeEditor || null),
        commentEditor: getEditorScrollDebugSnapshot(editorHandle || null)
      });
      // #endregion
      if (!sid) return;
      const runtimeAnnotations = getSessionAnnotations(sid);
      const thread = readAllThreads().find((item) => getThreadSessionId(item) === sid) || null;
      const storedAnnotations = thread ? hydrateThreadAnnotations(thread) : {};
      const annotations = (Array.isArray(runtimeAnnotations.tools) && runtimeAnnotations.tools.length) ||
        (Array.isArray(runtimeAnnotations.thinking) && runtimeAnnotations.thinking.length)
        ? runtimeAnnotations
        : storedAnnotations;
      // #region debug-point D:comments-restore-annotations
      reportFocusReturnDebug("D", "extensions/dev.comments/main.js:restoreActiveThreadCards", "comments restoreActiveThreadCards annotation choice", {
        sid,
        hasThread: !!thread,
        runtimeTools: runtimeAnnotations?.tools?.length || 0,
        runtimeThinking: runtimeAnnotations?.thinking?.length || 0,
        storedTools: storedAnnotations?.tools?.length || 0,
        storedThinking: storedAnnotations?.thinking?.length || 0,
        selectedTools: annotations?.tools?.length || 0,
        selectedThinking: annotations?.thinking?.length || 0
      });
      // #endregion
      if (!annotations?.tools?.length && !annotations?.thinking?.length) return;
      restoreSessionAnnotations(sid, editorHandle?.panelId, annotations);
      // #region debug-point D:comments-restore-exit
      requestAnimationFrame(() => reportFocusReturnDebug("D", "extensions/dev.comments/main.js:restoreActiveThreadCards", "comments restoreActiveThreadCards after restore frame", {
        activeEditor: getEditorScrollDebugSnapshot(window.zion?.window?.activeEditor || null),
        commentEditor: getEditorScrollDebugSnapshot(editorHandle || null)
      }));
      // #endregion
    } catch {}
  };
  try {
    let wasHidden = document.hidden;
    const onVisible = () => {
      const isHidden = document.hidden;
      // #region debug-point C:comments-visibility
      reportFocusReturnDebug("C", "extensions/dev.comments/main.js:visibilitychange", "comments visibilitychange handler", {
        wasHidden,
        isHidden,
        activeEditor: getEditorScrollDebugSnapshot(window.zion?.window?.activeEditor || null),
        commentEditor: getEditorScrollDebugSnapshot(editorHandle || null)
      });
      // #endregion
      if (wasHidden && !isHidden) setTimeout(restoreActiveThreadCards, 180);
      wasHidden = isHidden;
    };
    document.addEventListener("visibilitychange", onVisible);
    disposables.push({ dispose: () => document.removeEventListener("visibilitychange", onVisible) });
  } catch {}
  try {
    const onFocus = () => {
      // #region debug-point C:comments-window-focus
      reportFocusReturnDebug("C", "extensions/dev.comments/main.js:window-focus", "comments window focus handler", {
        activeEditor: getEditorScrollDebugSnapshot(window.zion?.window?.activeEditor || null),
        commentEditor: getEditorScrollDebugSnapshot(editorHandle || null)
      });
      // #endregion
      setTimeout(restoreActiveThreadCards, 180);
    };
    window.addEventListener("focus", onFocus);
    disposables.push({ dispose: () => window.removeEventListener("focus", onFocus) });
  } catch {}

  render();
  return {
    dispose() {
      disposed = true;
      try { editorHandle?.dispose?.(); } catch {}
      for (const d of disposables.splice(0)) {
        try { d?.dispose?.(); } catch {}
      }
      try { root.remove(); } catch {}
    }
  };

  function render() {
    if (disposed) return;
    const previousList = root.querySelector(".zion-comments-list");
    if (previousList) listScrollTop = previousList.scrollTop;
    const activeEditor = window.zion?.window?.activeEditor || null;
    const activeView = activeEditor?.getView?.();
    const sessionId = getSessionId(activeEditor);
    lastRenderedSessionId = String(sessionId || "");
    let threads = getThreadsForSession(sessionId);
    try { editorHandle?.dispose?.(); } catch {}
    editorHandle = null;
    root.replaceChildren();

    const anchorById = new Map();
    for (const item of threads) {
      anchorById.set(item.id, activeView ? locateThreadAnchor(activeView, item) : null);
    }
    threads = sortThreadsByDocumentOrder(threads, anchorById);
    const stateActive = getActiveThread();
    const active = stateActive && threads.some((item) => item.id === stateActive.id) ? stateActive : threads[0] || null;
    if (active && window.zion?.state?.get?.(ACTIVE_KEY) !== active.id) {
      try {
        suppressNextActiveThreadSchedule = true;
        window.zion.state.set(ACTIVE_KEY, active.id);
      } catch {
        suppressNextActiveThreadSchedule = false;
      }
    }
    const openCount = threads.filter((item) => !item.resolved).length;
    const resolvedCount = threads.length - openCount;
    const orphanCount = threads.filter((item) => !anchorById.get(item.id)).length;

    const header = document.createElement("div");
    header.className = "zion-comments-header";
    header.innerHTML = `
      <div class="zion-comments-stats">
        <span>${escapeHtml(t("stats.open", "{count} open", { count: openCount }))}</span>
        <span>${escapeHtml(t("stats.resolved", "{count} resolved", { count: resolvedCount }))}</span>
        ${orphanCount ? `<span class="is-orphan">${escapeHtml(t("stats.lost", "{count} lost", { count: orphanCount }))}</span>` : ""}
      </div>`;
    root.appendChild(header);

    const body = document.createElement("div");
    body.className = "zion-comments-body";
    root.appendChild(body);

    const list = document.createElement("div");
    list.className = "zion-comments-list";
    list.onscroll = () => { listScrollTop = list.scrollTop; };
    body.appendChild(list);
    if (!threads.length) {
      const empty = document.createElement("div");
      empty.className = "zion-comments-empty";
      empty.innerHTML = `<div class="zion-comments-empty-title">${escapeHtml(t("empty.title", "No comment threads yet"))}</div><div>${escapeHtml(t("empty.description", "Select text and click Comment in the toolbar to start an anchored discussion."))}</div>`;
      list.appendChild(empty);
    }
    for (const item of threads) {
      const anchor = anchorById.get(item.id);
      const status = item.resolved ? "resolved" : !anchor ? "lost" : anchor.relocated ? "moved" : "open";
      const anchorLabel = anchor ? `L${anchor.startLine + 1}` : "lost";
      const timeLabel = formatCompactTime(item.createdAt || item.updatedAt);
      const metaLabel = [anchorLabel, timeLabel].filter(Boolean).join(" · ");
      const row = document.createElement("button");
      row.type = "button";
      row.dataset.threadId = item.id;
      row.title = anchor ? t("row.open", "Open and reveal the source comment anchor") : t("row.orphan", "Open comment; source anchor is missing");
      row.className = `zion-comments-row is-${status}${item.id === active?.id ? " is-active" : ""}${item.resolved ? " is-resolved" : ""}${!anchor ? " is-orphan" : ""}`;
      row.innerHTML = `
        <span class="zion-comments-row-icon codicon codicon-comment-discussion" aria-hidden="true"></span>
        <span class="zion-comments-row-main">
          <span class="zion-comments-row-title"><span class="zion-comments-row-title-text">${escapeHtml(compactText(item.quote || t("row.fallback", "Comment"), 92))}</span></span>
        </span>
        <span class="zion-comments-row-meta">${renderThreadStatusDot(item)}${escapeHtml(metaLabel)}</span>`;
      row.onclick = () => {
        setActiveThread(item.id);
        revealThreadAnchor(item, { focus: false, editor: getEditorForThread(item) });
      };
      list.appendChild(row);
    }
    list.scrollTop = listScrollTop;
    if (pendingRevealThreadId) {
      const revealId = pendingRevealThreadId;
      pendingRevealThreadId = "";
      try {
        requestAnimationFrame(() => {
          try {
            list.querySelector(`.zion-comments-row[data-thread-id="${cssEscape(revealId)}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
          } catch {}
        });
      } catch {}
    }

    const detail = document.createElement("div");
    detail.className = "zion-comments-detail";
    body.appendChild(detail);
    if (!active) return;
    const activeAnchor = anchorById.get(active.id) || (activeView ? locateThreadAnchor(activeView, active) : null);
    const quoteLabel = activeAnchor
      ? `${t("quote.label", "Quote L{from}-{to}", { from: activeAnchor.startLine + 1, to: activeAnchor.endLine + 1 })}${activeAnchor.relocated ? ` · ${t("quote.relocated", "relocated")}` : ""}`
      : t("quote.lost", "Anchor missing");

    const editorFrame = document.createElement("div");
    editorFrame.className = "zion-comments-editor-frame";
    detail.appendChild(editorFrame);

    const editorHeader = document.createElement("div");
    editorHeader.className = "zion-comments-editor-header";
    editorFrame.appendChild(editorHeader);

    const quote = document.createElement("button");
    quote.type = "button";
    quote.className = `zion-comments-quote${!activeAnchor ? " is-orphan" : ""}`;
    quote.title = activeAnchor ? t("quote.back", "Jump back to source anchor") : t("quote.unavailable", "Source text changed or was deleted; cannot jump back to anchor");
    quote.innerHTML = `<span class="zion-comments-quote-label">${escapeHtml(quoteLabel)}</span><span class="zion-comments-quote-text">${escapeHtml(compactText(active.quote || "", 120))}</span>`;
    quote.onclick = () => revealThreadAnchor(active);
    editorHeader.appendChild(quote);

    const actions = document.createElement("div");
    actions.className = "zion-comments-actions";
    editorHeader.appendChild(actions);
    const runAction = makeAction("play", () => {
      if (isThreadStreaming(active)) stopThread(active);
      else runThread(active, editorHandle);
    }, "primary", t("run.start", "Start Chat"));
    updateRunAction = () => {
      const streaming = isThreadStreaming(active);
      runAction.innerHTML = iconSvg(streaming ? "stop" : "play");
      runAction.title = streaming ? t("run.stop", "Stop Answer") : t("run.start", "Start Chat");
      runAction.setAttribute("aria-label", runAction.title);
      runAction.className = `zion-comments-action ${streaming ? "danger" : "primary"}`;
    };
    updateRunAction();
    actions.appendChild(runAction);
    actions.appendChild(makeAction("external", () => promoteThread(active, editorHandle), "", t("thread.promote", "Promote to standalone session")));
    actions.appendChild(makeAction("trash", () => {
      deleteThread(active.id);
      setActiveThread("");
    }, "danger", t("thread.delete", "Delete comment")));

    const editorHost = document.createElement("div");
    editorHost.className = "zion-comments-editor";
    editorFrame.appendChild(editorHost);
    editorHandle = createThreadEditor(editorHost, active, (bodyText) => {
      patchThread(active.id, { body: bodyText }, { silent: true });
    }, (handle) => runThread(active, handle));
    lastCommentsEditorHandle = editorHandle;
    try {
      const annotations = hydrateThreadAnnotations(active);
      if (annotations.tools.length || annotations.thinking.length) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          restoreSessionAnnotations(editorHandle?.sessionId, editorHandle?.panelId, annotations);
        }));
      }
    } catch {}
    if (pendingFocusThreadId === active.id) {
      pendingFocusThreadId = "";
      try {
        requestAnimationFrame(() => {
          try {
            editorHandle?.proxy?.focus?.();
            editorHandle?.view?.focus?.();
          } catch {}
        });
      } catch {}
    }
  }
}

function makeAction(iconName, onClick, kind = "", title = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `zion-comments-action${kind ? ` ${kind}` : ""}`;
  button.innerHTML = iconSvg(iconName);
  button.title = title || iconName;
  button.setAttribute("aria-label", title || iconName);
  button.onclick = () => {
    try { onClick?.(); } catch (err) { console.error("[comments] action failed", err); }
  };
  return button;
}

function iconSvg(name) {
  const paths = {
    play: `<path d="M8 5v14l11-7z"></path>`,
    stop: `<path d="M6 6h12v12H6z"></path>`,
    external: `<path d="M14 4h6v6"></path><path d="M20 4l-9 9"></path><path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5"></path>`,
    trash: `<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M6 6l1 14h10l1-14"></path><path d="M10 11v5"></path><path d="M14 11v5"></path>`
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.play}</svg>`;
}

function revealThreadAnchor(thread, opts = {}) {
  try {
    const editor = opts.editor || getEditorForThread(thread, opts);
    const view = editor?.getView?.();
    if (!view) return;
    const anchor = locateThreadAnchor(view, thread);
    if (!anchor) {
      try {
        window.zion?.notification?.show?.(t("thread.anchorLost", "Comment anchor is missing: source text changed or was deleted"), { type: "warning", duration: 2200 });
      } catch {}
      return;
    }
    // #region debug-point A:comments-reveal-anchor
    reportFocusReturnDebug("A", "extensions/dev.comments/main.js:revealThreadAnchor", "comments revealThreadAnchor before scrollIntoView dispatch", {
      threadId: thread?.id || "",
      focus: opts.focus !== false,
      anchorFrom: anchor.from,
      anchorStartLine: anchor.startLine,
      editor: getEditorScrollDebugSnapshot(editor)
    });
    // #endregion
    view.dispatch({ selection: { anchor: anchor.from }, scrollIntoView: true });
    // #region debug-point A:comments-reveal-anchor-after
    requestAnimationFrame(() => reportFocusReturnDebug("A", "extensions/dev.comments/main.js:revealThreadAnchor", "comments revealThreadAnchor after frame", {
      threadId: thread?.id || "",
      editor: getEditorScrollDebugSnapshot(editor)
    }));
    // #endregion
    if (opts.focus !== false) view.focus?.();
    window.dispatchEvent(new CustomEvent("zion:roles-nav-flash", {
      detail: { view, lineIndex: anchor.startLine }
    }));
  } catch {}
}

function stopThread(thread) {
  try {
    window.zion?.commands?.executeCommand?.("chat.stop", getThreadSessionId(thread));
  } catch {}
}

function buildPromotedSessionContent(thread, bodyText) {
  const parts = [
    "system 这个会话由评论线程提升而来。",
    `主会话 ID：${thread?.parentSessionId || thread?.sessionId || "unknown"}`,
    `评论线程 ID：${thread?.id || "unknown"}`,
    "",
    "被评论片段：",
    thread?.anchorText || thread?.quote || "（无）",
    ""
  ];
  const body = String(bodyText || "").trim();
  if (body) parts.push(body);
  else parts.push("user ");
  return parts.join("\n");
}

function getSessionAnnotations(sessionId) {
  try {
    return window.zion?.commands?.executeCommand?.("zion.chatCards.getSessionAnnotations", sessionId) || {};
  } catch {
    return {};
  }
}

function setSessionAnnotations(sessionId, annotations) {
  try {
    window.zion?.commands?.executeCommand?.("zion.chatCards.setSessionAnnotations", { sessionId, annotations });
  } catch {}
}

function normalizeThreadAnnotations(annotations) {
  const ann = annotations && typeof annotations === "object" ? annotations : {};
  const tools = Array.isArray(ann.tools) ? ann.tools : [];
  const thinking = Array.isArray(ann.thinking) ? ann.thinking : [];
  return {
    ...ann,
    tools,
    thinking,
    savedAt: Date.now()
  };
}

function persistThreadAnnotations(threadOrSessionId, annotations = null) {
  const sessionId = typeof threadOrSessionId === "string" ? threadOrSessionId : getThreadSessionId(threadOrSessionId);
  if (!sessionId) return null;
  const thread = typeof threadOrSessionId === "string"
    ? readAllThreads().find((item) => getThreadSessionId(item) === sessionId)
    : threadOrSessionId;
  if (!thread?.id) return null;
  const nextAnnotations = normalizeThreadAnnotations(annotations || getSessionAnnotations(sessionId));
  patchThread(thread.id, {
    threadSessionId: sessionId,
    chatAnnotations: nextAnnotations
  }, { silent: true });
  return nextAnnotations;
}

function schedulePersistThreadAnnotations(sessionId, delay = 160) {
  const sid = String(sessionId || "");
  if (!sid || !sid.startsWith("comment:")) return;
  try {
    if (annotationPersistTimers.has(sid)) window.clearTimeout(annotationPersistTimers.get(sid));
    const timer = window.setTimeout(() => {
      annotationPersistTimers.delete(sid);
      persistThreadAnnotations(sid);
    }, delay);
    annotationPersistTimers.set(sid, timer);
  } catch {}
}

function hydrateThreadAnnotations(thread) {
  const sessionId = getThreadSessionId(thread);
  const annotations = normalizeThreadAnnotations(thread?.chatAnnotations || {});
  const hasCards = annotations.tools.length > 0 || annotations.thinking.length > 0;
  if (!sessionId || !hasCards) return annotations;
  setSessionAnnotations(sessionId, annotations);
  return annotations;
}

function restoreSessionAnnotations(sessionId, panelId, annotations) {
  try {
    window.zion?.commands?.executeCommand?.("zion.chatCards.restoreSession", {
      sessionId,
      panelId: panelId || null,
      annotations,
      clearFirst: false
    });
  } catch {}
}

async function promoteThread(thread, handle) {
  if (!thread) return null;
  try {
    const bodyText = handle?.view?.state?.doc?.toString?.() ?? thread.body ?? "";
    const threadSessionId = getThreadSessionId(thread);
    try {
      window.zion?.commands?.executeCommand?.("zion.chatCards.snapshotSession", {
        sessionId: threadSessionId,
        panelId: handle?.panelId || `comments:${thread.id}`
      });
    } catch {}
    const annotations = persistThreadAnnotations(thread, getSessionAnnotations(threadSessionId)) || getSessionAnnotations(threadSessionId);
    patchThread(thread.id, { body: String(bodyText || "") }, { silent: true });
    const title = t("thread.promotedTitle", "Comment: {title}", { title: compactText(thread.quote || thread.anchorText || thread.id, 48) });
    const panelId = thread.panelId || window.zion?.panels?.getActivePanelId?.() || null;
    const content = buildPromotedSessionContent(thread, bodyText);
    const id = await window.zion?.commands?.executeCommand?.("zion.sessions.new", {
      title,
      content,
      panelId,
      focus: true
    });
    if (id) {
      setSessionAnnotations(id, annotations);
      try {
        const meta = window.zion?.state?.get?.(`sessions.meta.${id}`);
        if (meta && typeof meta === "object") {
          window.zion.state.set(`sessions.meta.${id}`, { ...meta, annotations });
        }
      } catch {}
      try {
        requestAnimationFrame(() => requestAnimationFrame(() => restoreSessionAnnotations(id, panelId, annotations)));
      } catch {}
      patchThread(thread.id, { promotedSessionId: id }, { silent: true });
      try { window.zion?.notification?.show?.(t("thread.promoted", "Promoted to a formal session"), { type: "success", duration: 1600 }); } catch {}
    }
    return id || null;
  } catch (err) {
    console.error("[comments] promote failed", err);
    try { window.zion?.notification?.show?.(t("thread.promoteFailed", "Promote failed: {message}", { message: err?.message || String(err) }), { type: "error", duration: 2600 }); } catch {}
    return null;
  }
}

function focusThreadUserPrompt(view) {
  if (!view) return;
  const shouldKeepFocus = () => {
    try {
      const active = document.activeElement;
      const panel = view.dom.closest(".zion-comments-panel");
      return !active || active === document.body || view.dom.contains(active) || !!panel?.contains?.(active);
    } catch {
      return true;
    }
  };
  const focus = () => {
    try {
      const keepFocus = shouldKeepFocus();
      const docText = view.state.doc.toString();
      const lines = docText.split("\n");
      let assistantLineIndex = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (/^\s*assistant\s*/.test(lines[i] || "")) {
          assistantLineIndex = i;
          break;
        }
      }
      let userLineIndex = -1;
      for (let i = Math.max(assistantLineIndex + 1, 0); i < lines.length; i++) {
        if (/^\s*user\s*/.test(lines[i] || "")) {
          userLineIndex = i;
          break;
        }
      }
      if (userLineIndex < 0) {
        const prefix = docText && !docText.endsWith("\n") ? "\n\n" : (docText ? "\n" : "");
        view.dispatch({ changes: { from: view.state.doc.length, to: view.state.doc.length, insert: `${prefix}user ` } });
        userLineIndex = view.state.doc.lines - 1;
      }
      const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, userLineIndex + 1)));
      const text = line.text || "";
      const match = /^\s*user\s*/.exec(text);
      const pos = line.from + (match ? match[0].length : text.length);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      if (keepFocus) view.focus?.();
    } catch {}
  };
  focus();
  try {
    requestAnimationFrame(() => requestAnimationFrame(focus));
  } catch {
    setTimeout(focus, 0);
  }
}

async function runThread(thread, handle) {
  const view = handle?.view;
  const editor = handle?.proxy;
  if (!thread || !view || !editor) return;
  const startText = view.state.doc.toString();
  const threadSessionId = getThreadSessionId(thread);
  if (!thread.threadSessionId || thread.threadSessionId !== threadSessionId) {
    patchThread(thread.id, { threadSessionId }, { silent: true });
  }
  patchThread(thread.id, { body: startText, threadSessionId }, { silent: true });
  try {
    try {
      window.zion?.state?.set?.(`chat.followLatest.${threadSessionId}`, true);
      window.zion?.state?.set?.(`chat.followSuppressUntil.${threadSessionId}`, Date.now() + 300);
    } catch {}
    await window.zion?.commands?.executeCommand?.("chat.run", {
      editor,
      sessionId: threadSessionId,
      panelId: handle?.panelId || `comments:${thread.id}`,
      skipSessionPersistence: true,
      usageSessionId: thread.parentSessionId || thread.sessionId,
      contextMessages: buildThreadContextMessages(thread)
    });
    try {
      window.zion?.commands?.executeCommand?.("zion.chatCards.snapshotSession", {
        sessionId: threadSessionId,
        panelId: handle?.panelId || `comments:${thread.id}`
      });
      const annotations = persistThreadAnnotations(thread, getSessionAnnotations(threadSessionId)) || getSessionAnnotations(threadSessionId);
      restoreSessionAnnotations(threadSessionId, handle?.panelId || `comments:${thread.id}`, annotations);
    } catch {}
    focusThreadUserPrompt(view);
    patchThread(thread.id, { body: view.state.doc.toString(), threadSessionId }, { silent: true });
  } catch (err) {
    const msg = `\n\nsystem 评论线程运行失败：${err?.message || String(err || "unknown")}`;
    view.dispatch({ changes: { from: view.state.doc.length, to: view.state.doc.length, insert: msg } });
    patchThread(thread.id, { body: view.state.doc.toString() });
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function activate(ctx) {
  const disposables = [];
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) disposables.push(disp);
  } catch {}

  disposables.push(window.zion.commands.registerCommand("comments.openPanel", openCommentsPanel));
  disposables.push(window.zion.commands.registerCommand("comments.revealThread", (threadId, opts = {}) => revealThread(threadId, opts)));
  disposables.push(window.zion.commands.registerCommand("comments.createFromSelection", () => {
    const editor = window.zion?.window?.activeEditor;
    const view = editor?.getView?.();
    const sel = view?.state?.selection?.main;
    if (!view || !sel) return null;
    return createThreadFromSelection({
      view,
      from: sel.from,
      to: sel.to,
      selectionText: view.state.sliceDoc(sel.from, sel.to)
    });
  }));
  disposables.push(window.zion.commands.registerCommand("comments.focusEditor", focusCommentEditor));
  disposables.push(window.zion.commands.registerCommand("comments.focusSource", () => focusEditorSource(getActiveThread())));
  try {
    const kb = window.zion.keybindings?.register?.({
      command: "comments.focusEditor",
      key: "Mod-Shift-c",
      when: "editorFocus"
    });
    if (kb) disposables.push(kb);
  } catch {}
  try {
    const persistEvents = ["chat/toolCall", "chat/toolResult", "chat/reasoningStart", "chat/reasoningToken", "chat/reasoningEnd", "chat/runFinished", "chat/runError", "chat/aborted"];
    for (const eventName of persistEvents) {
      const disp = window.zion?.events?.on?.(eventName, (payload) => {
        schedulePersistThreadAnnotations(payload?.sessionId);
      });
      if (disp) disposables.push(disp);
    }
  } catch {}
  try {
    const flushCommentAnnotations = () => {
      try {
        for (const [sid, timer] of Array.from(annotationPersistTimers.entries())) {
          try { window.clearTimeout(timer); } catch {}
          annotationPersistTimers.delete(sid);
          persistThreadAnnotations(sid);
        }
        const handle = lastCommentsEditorHandle;
        if (handle?.sessionId) {
          try {
            window.zion?.commands?.executeCommand?.("zion.chatCards.snapshotSession", {
              sessionId: handle.sessionId,
              panelId: handle.panelId
            });
          } catch {}
          persistThreadAnnotations(handle.sessionId);
        }
      } catch {}
    };
    window.addEventListener("pagehide", flushCommentAnnotations);
    window.addEventListener("beforeunload", flushCommentAnnotations);
    disposables.push({
      dispose() {
        flushCommentAnnotations();
        try { window.removeEventListener("pagehide", flushCommentAnnotations); } catch {}
        try { window.removeEventListener("beforeunload", flushCommentAnnotations); } catch {}
      }
    });
  } catch {}

  const selectionItem = window.zion.editor?.selectionToolbar?.registerItem?.({
    id: "comments.create",
    order: 18,
    title: t("toolbar.createThread", "Create comment thread"),
    titleKey: "dev.comments.toolbar.createThread",
    label: t("toolbar.comment", "Comment"),
    labelKey: "dev.comments.toolbar.comment",
    codicon: "comment-discussion",
    when: (ctx) => {
      if (!String(ctx?.selectionText || "").trim()) return false;
      const panelId = ctx?.view?.dom?.closest?.("[data-panel-id]")?.getAttribute?.("data-panel-id") || "";
      return !String(panelId).startsWith("comments:");
    },
    run: (ctx) => createThreadFromSelection(ctx)
  });
  if (selectionItem) disposables.push(selectionItem);

  try {
    const menu = window.zion.menus?.register?.("editor/context", {
      command: "comments.createFromSelection",
      title: t("toolbar.comment", "Comment"),
      when: "editorFocus",
      order: 18
    });
    if (menu) disposables.push(menu);
  } catch {}

  const viewDisposable = window.zion.auxiliaryBar?.registerView?.({
    id: VIEW_ID,
    pluginId: "dev.comments",
    title: t("title", "Comments"),
    titleKey: "dev.comments.title",
    order: 25,
    keepWhenActive: true,
    component: { render: renderCommentsPanel }
  });
  if (viewDisposable) disposables.push(viewDisposable);

  const decorator = window.zion.editor.registerDecorator({
    id: "dev.comments.anchors",
    apply(editor) {
      if (String(editor?.panelId || "").startsWith("comments:")) return { dispose() {} };
      try { editor.addVisualExtension(installCommentAnchors(editor)); } catch {}
      return { dispose() {} };
    }
  });
  disposables.push(decorator);

  try {
    const activity = window.zion.activityBar?.registerItem?.({
      id: "comments.activity",
      pluginId: "dev.comments",
      icon: "$(comment-discussion)",
      tooltip: "Comments",
      order: 35,
      onClick: openCommentsPanel
    });
    if (activity) disposables.push(activity);
  } catch {}

  const disposable = {
    dispose() {
      for (const d of disposables.splice(0)) {
        try { d?.dispose?.(); } catch {}
      }
    }
  };
  try { ctx?.subscriptions?.push?.(disposable); } catch {}
  return disposable;
}
