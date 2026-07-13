import { EditorState, Prec, Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from "@codemirror/view";
import { EditorCore } from "../../src/editor/EditorCore.ts";
import { parseMessages } from "../../src/chat/doc.ts";
import { createChatOverviewRail } from "../dev.langchain-chat/overview-rail.js";
import { roles as createRolesExtension } from "../dev.roles/roles.js";
import { installThinkingCards } from "../dev.thinking/thinking-cards.js";
import { installToolCallCards } from "../dev.tools/tool-calls.js";
import { openSessionsDB, idbGetKV, idbSetKV, idbDelKV } from "../dev.session-manager/storage/idb.js";

const VIEW_ID = "dev.comments.panel";
const I18N_NS = "dev.comments";
const STORAGE_KEY = "zion.comments.threads.v1";
const ACTIVE_KEY = "comments.activeThreadId";
const CHANGED_EVENT = "comments/changed";
const SESSIONS_DB_NAME = "zion.sessions.db";
const THREAD_PAYLOAD_KEY_PREFIX = "zion.comments.threadPayload.";
const MAX_STORED_SOURCE_CONTEXT_CHARS = 4000;
const AGGRESSIVE_MAX_STORED_SOURCE_CONTEXT_CHARS = 1500;
const DEFAULT_MAX_STORED_ANCHOR_CHARS = 2000;
const AGGRESSIVE_MAX_STORED_ANCHOR_CHARS = 800;
const DEFAULT_MAX_STORED_QUOTE_CHARS = 1000;
const AGGRESSIVE_MAX_STORED_QUOTE_CHARS = 400;
const COMMENT_PANEL_MIN_ROW_GAP = 8;
let pendingFocusThreadId = "";
let pendingExpandThreadId = "";
let pendingRevealThreadId = "";
let pendingLocatedThreadId = "";
let lastCommentsEditorHandle = null;
let lastCommentSourceFocus = null;
const annotationPersistTimers = new Map();
const commentEditorHandlesBySession = new Map();
const detachedCommentTailFollowSessions = new Set();
const commentRunFollowTargetsBySession = new Map();
const threadPayloadCache = new Map();
const threadPayloadLoads = new Map();

function isCommentsLayoutDebugEnabled() {
  try {
    return localStorage.getItem("zion.comments.debugLayout") === "1"
      || String(location.search || "").includes("debugCommentsLayout");
  } catch {
    return false;
  }
}

function reportCommentLayoutDebug(label, data = {}) {
  try {
    if (!isCommentsLayoutDebugEnabled()) return;
    console.debug(`[comments:layout] ${label}`, data);
  } catch {}
}

// #region debug-point A:comment-scroll-jitter
function debugCommentScrollJitter(hypothesisId, location, data = {}) {
  try {
    fetch("http://127.0.0.1:7777/event", {
      method: "POST",
      body: JSON.stringify({
        sessionId: "comment-scroll-jitter",
        runId: "post-fix",
        hypothesisId,
        location,
        msg: `[DEBUG] ${location}`,
        data,
        ts: Date.now()
      })
    }).catch(() => {});
  } catch {}
}
// #endregion

function getCommentScrollDebugSnapshot(view) {
  try {
    const list = view?.dom?.closest?.(".zion-comments-list") || null;
    const scroller = view?.scrollDOM || null;
    const sel = view?.state?.selection?.main || null;
    const head = typeof sel?.head === "number" ? sel.head : null;
    const coords = typeof head === "number" ? view.coordsAtPos(head) : null;
    const sessionId = String(view?.dom?.dataset?.sessionId || "");
    return {
      sessionId,
      listScrollTop: Math.round(Number(list?.scrollTop) || 0),
      listScrollHeight: Math.round(Number(list?.scrollHeight) || 0),
      listClientHeight: Math.round(Number(list?.clientHeight) || 0),
      cmScrollTop: Math.round(Number(scroller?.scrollTop) || 0),
      cmScrollHeight: Math.round(Number(scroller?.scrollHeight) || 0),
      cmClientHeight: Math.round(Number(scroller?.clientHeight) || 0),
      selectionHead: head,
      cursorTop: coords ? Math.round(Number(coords.top) || 0) : null,
      cursorBottom: coords ? Math.round(Number(coords.bottom) || 0) : null,
      docLength: Math.round(Number(view?.state?.doc?.length) || 0),
      streaming: sessionId ? !!window.zion?.state?.get?.(`chat.runs.${sessionId}`)?.streaming : false,
      runTarget: sessionId ? commentRunFollowTargetsBySession.get(sessionId) || null : null,
      activeElementClass: String(document.activeElement?.className || "").slice(0, 120)
    };
  } catch {
    return {};
  }
}

function markCommentListProgrammaticScroll(list, duration = 180) {
  try {
    if (!list) return;
    list.__zionProgrammaticScrollUntil = Math.max(
      Number(list.__zionProgrammaticScrollUntil) || 0,
      Date.now() + duration
    );
  } catch {}
}

function markCommentUserScrollIntent(target, duration = 900) {
  try {
    if (!target) return;
    target.__zionUserScrollIntentUntil = Math.max(
      Number(target.__zionUserScrollIntentUntil) || 0,
      Date.now() + duration
    );
    target.__zionProgrammaticScrollUntil = 0;
  } catch {}
}

function isCommentsFlowDebugEnabled() {
  try {
    return localStorage.getItem("zion.comments.debugFlow") === "1"
      || localStorage.getItem("zion.comments.debugLayout") === "1"
      || String(location.search || "").includes("debugCommentsFlow")
      || String(location.search || "").includes("debugCommentsLayout");
  } catch {
    return false;
  }
}

const I18N_MESSAGES = {
  "zh-CN": {
    "title": "评论",
    "cmd.openPanel": "打开评论面板",
    "cmd.openPanel.description": "打开右侧评论面板",
    "cmd.createFromSelection": "为选区创建评论",
    "cmd.createFromSelection.description": "基于当前编辑器选区创建一个评论线程",
    "slash.comment.title": "评论",
    "slash.comment.description": "在当前位置或当前选区创建评论",
    "cmd.focusEditor": "聚焦评论编辑器",
    "cmd.focusEditor.description": "聚焦当前评论线程的编辑器",
    "cmd.focusSource": "返回评论来源",
    "cmd.focusSource.description": "从评论编辑器返回主编辑器中的评论来源",
      "toolbar.createThread": "创建评论线程",
      "toolbar.comment": "评论",
      "thread.created": "已创建评论线程",
      "thread.createFailedStorage": "创建评论失败：本地评论存储空间不足，请删除部分旧评论后重试",
    "header.subtitle": "正文中的锚定评论",
    "anchor.open": "打开评论",
    "anchor.count": "{count} 条评论",
    "stats.open": "{count} 未解决",
    "stats.resolved": "{count} 已解决",
    "stats.lost": "{count} 锚点丢失",
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
    "thread.resolve": "标记为已解决",
    "thread.reopen": "重新打开评论",
    "thread.expand": "展开编辑器",
    "thread.collapse": "收起编辑器",
      "thread.emptySummary": "暂无评论内容。展开开始会话。",
      "threadMeta.updated": "更新于 {time}",
    "threadStatus.resolved": "已解决",
    "threadStatus.lost": "锚点丢失",
    "threadStatus.moved": "已重定位",
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
    "slash.comment.title": "Comment",
    "slash.comment.description": "Create a comment at the cursor or current selection",
    "cmd.focusEditor": "Focus Comment Editor",
    "cmd.focusEditor.description": "Focus the active comment thread editor",
    "cmd.focusSource": "Focus Comment Source",
    "cmd.focusSource.description": "Return from the comment editor to the source editor",
      "toolbar.createThread": "Create comment thread",
      "toolbar.comment": "Comment",
      "thread.created": "Comment thread created",
      "thread.createFailedStorage": "Failed to create comment: local comment storage is full. Delete older comments and try again.",
    "header.subtitle": "Anchored comments in the source document",
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
    "thread.resolve": "Mark as resolved",
    "thread.reopen": "Reopen comment",
    "thread.expand": "Expand editor",
    "thread.collapse": "Collapse editor",
      "thread.emptySummary": "No comment yet. Expand to start the conversation.",
      "threadMeta.updated": "Updated {time}",
    "threadStatus.resolved": "Resolved",
    "threadStatus.lost": "Anchor missing",
    "threadStatus.moved": "Relocated",
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

function getThreadPayloadStorageKey(threadId) {
  return `${THREAD_PAYLOAD_KEY_PREFIX}${String(threadId || "")}`;
}

function normalizeThreadPayload(payload) {
  const next = payload && typeof payload === "object" ? { ...payload } : {};
  if (typeof next.body !== "string") delete next.body;
  if (!next.chatAnnotations || typeof next.chatAnnotations !== "object") delete next.chatAnnotations;
  if (typeof next.summary !== "string") delete next.summary;
  if (!Number.isFinite(Number(next.summaryUpdatedAt))) delete next.summaryUpdatedAt;
  else next.summaryUpdatedAt = Number(next.summaryUpdatedAt);
  if (typeof next.sourceContextText !== "string") delete next.sourceContextText;
  if (!Number.isFinite(Number(next.sourceContextFrom))) delete next.sourceContextFrom;
  else next.sourceContextFrom = Number(next.sourceContextFrom);
  if (!Number.isFinite(Number(next.sourceContextTo))) delete next.sourceContextTo;
  else next.sourceContextTo = Number(next.sourceContextTo);
  if (!Number.isFinite(Number(next.sourceContextStartLine))) delete next.sourceContextStartLine;
  else next.sourceContextStartLine = Number(next.sourceContextStartLine);
  if (!Number.isFinite(Number(next.sourceContextEndLine))) delete next.sourceContextEndLine;
  else next.sourceContextEndLine = Number(next.sourceContextEndLine);
  return next;
}

function hasStoredThreadPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  return typeof payload.body === "string"
    || typeof payload.sourceContextText === "string"
    || typeof payload.summary === "string"
    || !!(payload.chatAnnotations && typeof payload.chatAnnotations === "object")
    || Number.isFinite(Number(payload.sourceContextFrom))
    || Number.isFinite(Number(payload.sourceContextTo))
    || Number.isFinite(Number(payload.sourceContextStartLine))
    || Number.isFinite(Number(payload.sourceContextEndLine));
}

function extractThreadPayload(thread) {
  if (!thread || typeof thread !== "object") return {};
  return normalizeThreadPayload({
    body: thread.body,
    chatAnnotations: thread.chatAnnotations,
    summary: thread.summary,
    summaryUpdatedAt: thread.summaryUpdatedAt,
    sourceContextText: thread.sourceContextText,
    sourceContextFrom: thread.sourceContextFrom,
    sourceContextTo: thread.sourceContextTo,
    sourceContextStartLine: thread.sourceContextStartLine,
    sourceContextEndLine: thread.sourceContextEndLine
  });
}

function stripThreadForStorage(thread) {
  const next = thread && typeof thread === "object" ? { ...thread } : thread;
  if (!next || typeof next !== "object") return next;
  delete next.body;
  delete next.chatAnnotations;
  delete next.summary;
  delete next.summaryUpdatedAt;
  delete next.sourceContextText;
  delete next.sourceContextFrom;
  delete next.sourceContextTo;
  delete next.sourceContextStartLine;
  delete next.sourceContextEndLine;
  return next;
}

function applyThreadPayload(thread, payload) {
  if (!thread || typeof thread !== "object" || !payload || typeof payload !== "object") return thread;
  const next = { ...thread };
  if ("body" in payload) next.body = payload.body;
  if ("chatAnnotations" in payload) next.chatAnnotations = payload.chatAnnotations;
  if ("summary" in payload) next.summary = payload.summary;
  if ("summaryUpdatedAt" in payload) next.summaryUpdatedAt = payload.summaryUpdatedAt;
  if ("sourceContextText" in payload) next.sourceContextText = payload.sourceContextText;
  if ("sourceContextFrom" in payload) next.sourceContextFrom = payload.sourceContextFrom;
  if ("sourceContextTo" in payload) next.sourceContextTo = payload.sourceContextTo;
  if ("sourceContextStartLine" in payload) next.sourceContextStartLine = payload.sourceContextStartLine;
  if ("sourceContextEndLine" in payload) next.sourceContextEndLine = payload.sourceContextEndLine;
  return next;
}

function cacheThreadPayload(threadId, payload) {
  const id = String(threadId || "");
  if (!id) return {};
  const normalized = normalizeThreadPayload(payload);
  threadPayloadCache.set(id, normalized);
  return normalized;
}

async function persistThreadPayload(thread) {
  const id = String(thread?.id || "");
  if (!id) return false;
  const payload = cacheThreadPayload(id, extractThreadPayload(thread));
  try {
    await openSessionsDB(SESSIONS_DB_NAME);
    if (hasStoredThreadPayload(payload)) {
      await idbSetKV(SESSIONS_DB_NAME, getThreadPayloadStorageKey(id), payload);
    } else {
      await idbDelKV(SESSIONS_DB_NAME, getThreadPayloadStorageKey(id));
    }
    return true;
    } catch {
    return false;
  }
}

function schedulePersistThreadPayload(thread) {
  if (!thread?.id || !hasStoredThreadPayload(extractThreadPayload(thread))) return;
  Promise.resolve().then(() => persistThreadPayload(thread));
}

async function loadThreadPayload(threadOrId, opts = {}) {
  const id = typeof threadOrId === "string" ? String(threadOrId || "") : String(threadOrId?.id || "");
  if (!id) return {};
  if (threadPayloadCache.has(id)) return threadPayloadCache.get(id) || {};
  if (threadPayloadLoads.has(id)) return threadPayloadLoads.get(id);
  const load = (async () => {
    try {
      await openSessionsDB(SESSIONS_DB_NAME);
      const stored = await idbGetKV(SESSIONS_DB_NAME, getThreadPayloadStorageKey(id));
      const payload = cacheThreadPayload(id, stored || {});
      if (opts.emitChanged && hasStoredThreadPayload(payload)) {
        try { window.dispatchEvent(new CustomEvent("zion:comments-changed")); } catch {}
      }
      return payload;
      } catch {
      return {};
    } finally {
      threadPayloadLoads.delete(id);
    }
  })();
  threadPayloadLoads.set(id, load);
  return load;
}

function deleteThreadPayload(threadId) {
  const id = String(threadId || "");
  if (!id) return;
  threadPayloadCache.delete(id);
  threadPayloadLoads.delete(id);
  Promise.resolve().then(async () => {
    try {
      await openSessionsDB(SESSIONS_DB_NAME);
      await idbDelKV(SESSIONS_DB_NAME, getThreadPayloadStorageKey(id));
      } catch {}
  });
}

function readStoredThreadsRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function readAllThreads() {
  return readStoredThreadsRaw().map((thread) => applyThreadPayload(thread, threadPayloadCache.get(String(thread?.id || ""))));
}

function trimStoredText(value, maxChars) {
  if (typeof value !== "string") return value;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function clearStoredSourceContext(thread) {
  const next = thread && typeof thread === "object" ? thread : {};
  const anchorFrom = Math.max(0, Number(next.from) || 0);
  const anchorTo = Math.max(anchorFrom, Number(next.to) || anchorFrom);
  const startLine = Math.max(0, Number(next.startLine) || 0);
  const endLine = Math.max(startLine, Number(next.endLine) || startLine);
  next.sourceContextText = "";
  next.sourceContextFrom = anchorFrom;
  next.sourceContextTo = anchorTo;
  next.sourceContextStartLine = startLine;
  next.sourceContextEndLine = endLine;
  return next;
}

function compactThreadForStorage(thread, mode = "default") {
  const next = thread && typeof thread === "object" ? { ...thread } : thread;
  if (!next || typeof next !== "object") return next;

  const aggressive = mode === "aggressive" || mode === "minimal";
  const anchorLimit = aggressive ? AGGRESSIVE_MAX_STORED_ANCHOR_CHARS : DEFAULT_MAX_STORED_ANCHOR_CHARS;
  const quoteLimit = aggressive ? AGGRESSIVE_MAX_STORED_QUOTE_CHARS : DEFAULT_MAX_STORED_QUOTE_CHARS;
  const contextLimit = mode === "minimal"
    ? 0
    : (aggressive ? AGGRESSIVE_MAX_STORED_SOURCE_CONTEXT_CHARS : MAX_STORED_SOURCE_CONTEXT_CHARS);

  next.anchorText = trimStoredText(next.anchorText, anchorLimit);
  next.quote = trimStoredText(next.quote, quoteLimit);

  if (!next.anchorText && next.quote) next.anchorText = next.quote;
  if (!next.quote && next.anchorText) next.quote = next.anchorText;

  if (contextLimit <= 0) {
    return clearStoredSourceContext(next);
  }

  const text = typeof next.sourceContextText === "string" ? next.sourceContextText : "";
  if (!text || text.length <= contextLimit) return next;

  const compactedText = text.slice(-contextLimit);
  const prevTo = Number(next.sourceContextTo);
  const nextTo = Number.isFinite(prevTo) && prevTo > 0 ? prevTo : compactedText.length;
  const nextFrom = Math.max(0, nextTo - compactedText.length);
  const endLine = Number(next.sourceContextEndLine) || Number(next.endLine) || Number(next.startLine) || 0;
  const approxLineCount = compactedText.split("\n").length;

  next.sourceContextText = compactedText;
  next.sourceContextFrom = nextFrom;
  next.sourceContextTo = nextTo;
  next.sourceContextEndLine = endLine;
  next.sourceContextStartLine = Math.max(0, endLine - Math.max(0, approxLineCount - 1));
  return next;
}

function writeAllThreads(list, opts = {}) {
  const rawList = Array.isArray(list) ? list : [];
  const modes = Array.isArray(opts.compactionModes) && opts.compactionModes.length
    ? opts.compactionModes
    : ["default", "aggressive", "minimal"];
  let lastError = null;
  let lastPayloadLength = -1;

  for (const mode of modes) {
    const normalizedList = rawList.map((item) => compactThreadForStorage(stripThreadForStorage(item), mode));
    const payload = JSON.stringify(normalizedList);
    lastPayloadLength = payload.length;
    try {
      localStorage.setItem(STORAGE_KEY, payload);
      for (const thread of rawList) schedulePersistThreadPayload(thread);
      if (!opts.silent) emitChanged();
        return { ok: true, list: rawList, storedList: normalizedList, payloadLength: payload.length, storedCount: normalizedList.length, compactionMode: mode };
    } catch (error) {
      lastError = error;
      if (String(error?.name || "") !== "QuotaExceededError") break;
    }
  }

  return {
    ok: false,
    error: lastError,
    nextCount: rawList.length,
    payloadLength: lastPayloadLength
  };
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

  function getCommentAnchorTop(view, anchor, fallbackLine) {
    try {
      if (view && anchor && typeof anchor.from === "number") {
        const block = view.lineBlockAt?.(anchor.from);
        if (block && Number.isFinite(Number(block.top))) return Number(block.top);
      }
    } catch {}
    const line = Number.isFinite(Number(anchor?.startLine)) ? Number(anchor.startLine) : Number(fallbackLine) || 0;
    return Math.max(0, line * 22);
  }

  function alignCommentRowsToAnchors(list, view, threads, anchorById, reason = "layout") {
    try {
      if (!list || !Array.isArray(threads) || !threads.length) return;
      let panelCursorTop = 0;
      const rows = [];
      for (const item of threads) {
        const row = list.querySelector(`.zion-comments-row[data-thread-id="${cssEscape(item.id)}"]`);
        if (!row) continue;
        const anchor = anchorById?.get?.(item.id) || null;
        const minGap = rows.length ? COMMENT_PANEL_MIN_ROW_GAP : 0;
        const anchorTop = anchor
          ? getCommentAnchorTop(view, anchor, item.startLine)
          : panelCursorTop + minGap;
        const rowGap = Math.max(minGap, Math.round(anchorTop - panelCursorTop));
        row.style.marginTop = `${rowGap}px`;
        const rowTop = panelCursorTop + rowGap;
        const rowHeight = Math.max(1, Math.ceil(row.getBoundingClientRect?.().height || row.offsetHeight || 0));
        panelCursorTop = rowTop + rowHeight;
        rows.push({
          id: item.id,
          anchorTop,
          rowTop,
          rowHeight,
          rowGap,
          delta: Math.round(rowTop - anchorTop)
        });
      }
      reportCommentLayoutDebug(reason, {
        sourceScrollTop: Math.round(Number(view?.scrollDOM?.scrollTop) || 0),
        listScrollTop: Math.round(Number(list.scrollTop) || 0),
        rows
      });
    } catch {}
  }

  function updateCommentListScrollRange(list, view, reason = "scroll-range") {
    try {
      if (!list || !view?.scrollDOM) return;
      const sourceMaxScroll = Math.max(0, Math.ceil((view.scrollDOM.scrollHeight || 0) - (view.scrollDOM.clientHeight || 0)));
      const currentSpacer = Number(list.__zionCommentsEndSpacer || 0);
      const panelMaxScroll = Math.max(0, Math.ceil((list.scrollHeight || 0) - (list.clientHeight || 0)));
      const panelMaxWithoutSpacer = Math.max(0, panelMaxScroll - currentSpacer);
      const minSpacer = Math.max(360, Math.ceil(list.clientHeight || 0));
      const nextSpacer = Math.max(minSpacer, Math.ceil(sourceMaxScroll - panelMaxWithoutSpacer + 8));
      if (Math.abs(nextSpacer - currentSpacer) > 1) {
        list.__zionCommentsEndSpacer = nextSpacer;
        list.style.setProperty("--zion-comments-end-spacer", `${nextSpacer}px`);
      }
      reportCommentLayoutDebug(reason, {
        sourceMaxScroll,
        panelMaxScroll,
        panelMaxWithoutSpacer,
        currentSpacer,
        nextSpacer,
        sourceScrollTop: Math.round(Number(view.scrollDOM.scrollTop) || 0),
        listScrollTop: Math.round(Number(list.scrollTop) || 0)
      });
    } catch {}
  }

  function pickThreadForViewport(view, threads, anchorById) {
    try {
      const viewport = view?.viewport;
      if (!viewport || !Array.isArray(threads) || !threads.length) return "";
      const top = Number(viewport.from) || 0;
      const bottom = Number(viewport.to) || top;
      let best = null;
      for (const thread of threads) {
        const anchor = anchorById?.get?.(thread?.id);
        if (!anchor) continue;
        const from = Number(anchor.from);
        const to = Number(anchor.to);
        if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
        if (to < top || from > bottom) continue;
        const score = Math.abs(from - top);
        if (!best || score < best.score) best = { id: thread.id, score };
  }
      return best?.id || "";
    } catch {
      return "";
  }
  }

function compactText(value, max = 88) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

  function getThreadSummaryText(thread, fallback = "") {
    try {
      const raw = String(thread?.summary || thread?.body || fallback || "").trim();
      if (!raw) return "";
      const cleaned = raw
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
        .replace(/\[[^\]]+\]\(([^)]+)\)/g, "$1")
        .split(/\n+/)
        .map((line) => line
          .replace(/^\s{0,3}(#{1,6}|[-*+>]|\d+[.)])\s+/g, "")
          .replace(/^\s*(user|assistant|system)\s*[:：]\s*/i, "")
          .trim())
        .filter(Boolean)
        .join(" ");
      return compactText(cleaned, 150);
    } catch {
      return compactText(fallback, 150);
    }
  }

function cssEscape(value) {
  try {
    return globalThis.CSS?.escape?.(String(value || "")) || String(value || "").replace(/["\\]/g, "\\$&");
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

  function getThreadLatestAt(thread) {
    try {
      return Math.max(
        Number(thread?.summaryUpdatedAt) || 0,
        Number(thread?.updatedAt) || 0,
        Number(thread?.createdAt) || 0
      );
    } catch {
      return 0;
    }
  }

  function formatThreadTimeTitle(ts) {
    const value = Number(ts) || 0;
    if (!value) return "";
    try {
      return new Date(value).toLocaleString();
    } catch {
      return "";
    }
  }

function saveThread(thread) {
  const list = readAllThreads();
  const idx = list.findIndex((item) => item?.id === thread?.id);
  if (idx >= 0) list[idx] = thread;
  else list.unshift(thread);
  const result = writeAllThreads(list);
  if (!result?.ok) return null;
  return result.list?.find((item) => item?.id === thread?.id) || thread;
}

function patchThread(id, patch, opts = {}) {
  const list = readAllThreads();
  const idx = list.findIndex((item) => item?.id === id);
  if (idx < 0) return null;
  const next = { ...list[idx], ...(patch || {}), updatedAt: now() };
  list[idx] = next;
  const result = writeAllThreads(list, opts);
  if (!result?.ok) return null;
  return result.list?.find((item) => item?.id === id) || next;
}

function deleteThread(id) {
  const result = writeAllThreads(readAllThreads().filter((item) => item?.id !== id));
  if (result?.ok) deleteThreadPayload(id);
  return result;
}

function getActiveThread() {
  const id = window.zion?.state?.get?.(ACTIVE_KEY);
  const thread = readAllThreads().find((item) => item?.id === id) || null;
  if (thread && !hasStoredThreadPayload(extractThreadPayload(thread))) {
    loadThreadPayload(thread, { emitChanged: true });
  }
  return thread;
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

function rememberSourcePanelSession(panelId, sessionId) {
  try {
    const pid = String(panelId || "");
    const sid = String(sessionId || "");
    if (!pid || !sid || isCommentPanelId(pid)) {
      return null;
    }
    const editor = window.zion?.panels?.getEditorBySession?.(pid, sid)
      || window.zion?.panels?.getEditor?.(pid)
      || null;
    if (editor && !isCommentPanelId(editor?.panelId)) {
      rememberSourceFocus(editor);
      return editor;
    }
    lastCommentSourceFocus = {
      panelId: pid,
      sessionId: sid,
      anchor: null,
      head: null
    };
  } catch {}
  return null;
}

function rememberThreadSource(thread, editor = null) {
  try {
    const sessionId = getThreadSourceSessionId(thread);
    const panelId = String(editor?.panelId || getCurrentPanelIdForThread(thread) || thread?.panelId || "");
    if (editor && !isCommentPanelId(editor?.panelId)) {
      rememberSourceFocus(editor);
    }
    lastCommentSourceFocus = {
      panelId,
      sessionId,
      anchor: typeof thread?.from === "number" ? thread.from : null,
      head: typeof thread?.to === "number" ? thread.to : (typeof thread?.from === "number" ? thread.from : null)
    };
  } catch {}
}

function getSourceEditorForCommentsPanel() {
  try {
    const revealId = String(pendingRevealThreadId || pendingLocatedThreadId || "");
    if (revealId) {
      const thread = readAllThreads().find((item) => item?.id === revealId) || null;
      if (thread) {
        const editor = getEditorForThread(thread);
        rememberThreadSource(thread, editor);
        if (editor && !isCommentPanelId(editor?.panelId)) return editor;
        return null;
      }
    }
  } catch {}

  try {
    const active = window.zion?.window?.activeEditor || null;
    if (active && !isCommentPanelId(active?.panelId)) {
      rememberSourceFocus(active);
      return active;
    }
  } catch {}

  try {
    const remembered = lastCommentSourceFocus;
    if (remembered?.panelId && remembered?.sessionId) {
      const editor = window.zion?.panels?.getEditorBySession?.(remembered.panelId, remembered.sessionId)
        || window.zion?.panels?.getEditor?.(remembered.panelId)
        || null;
      if (editor && !isCommentPanelId(editor?.panelId)) {
        return editor;
      }
    }
  } catch {}

  const activeThread = getActiveThread();
  if (activeThread) {
    const editor = getEditorForThread(activeThread);
    if (editor && !isCommentPanelId(editor?.panelId)) {
      rememberThreadSource(activeThread, editor);
      return editor;
    }
  }

  return null;
}

function getSourceSessionIdForCommentsPanel(sourceEditor = null) {
  try {
    if (sourceEditor && !isCommentPanelId(sourceEditor?.panelId)) {
      const sessionId = getSessionId(sourceEditor);
      return sessionId;
    }
  } catch {}
  if (lastCommentSourceFocus?.sessionId) {
    return String(lastCommentSourceFocus.sessionId);
  }
  const activeThread = getActiveThread();
  if (activeThread) {
    const sessionId = getThreadSourceSessionId(activeThread);
    return sessionId;
  }
  try {
    const active = window.zion?.window?.activeEditor || null;
    if (active && !isCommentPanelId(active?.panelId)) {
      const sessionId = getSessionId(active);
      return sessionId;
    }
  } catch {}
  return "global";
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
      if ((window.zion?.state?.get?.(ACTIVE_KEY) || "") === next) {
        try { window.dispatchEvent(new CustomEvent("zion:comments-active-changed", { detail: { id: next } })); } catch {}
        return;
      }
    window.zion?.state?.set?.(ACTIVE_KEY, next);
  } catch {
    emitChanged();
  }
  try { window.dispatchEvent(new CustomEvent("zion:comments-active-changed", { detail: { id: next } })); } catch {}
}

function signalCommentThreadLocated(id, source = "source") {
  const threadId = String(id || "");
  if (!threadId) return;
  pendingLocatedThreadId = threadId;
  try {
    window.dispatchEvent(new CustomEvent("zion:comments-thread-located", {
      detail: {
        threadId,
        source,
        ts: Date.now()
      }
    }));
  } catch {}
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

function renderCommentStateBadge(status) {
  if (status === "resolved") return `<span class="zion-comments-state-badge is-resolved">${escapeHtml(t("threadStatus.resolved", "Resolved"))}</span>`;
  if (status === "lost") return `<span class="zion-comments-state-badge is-lost">${escapeHtml(t("threadStatus.lost", "Anchor missing"))}</span>`;
  return "";
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

function buildSourceContextSnapshot(view, anchorFrom, anchorTo) {
  try {
    const doc = view?.state?.doc;
    if (!view || !doc) return null;
    const rawFrom = Math.max(0, Math.min(doc.length, (Number(anchorTo) || 0) - MAX_STORED_SOURCE_CONTEXT_CHARS));
    const rawTo = Math.max(0, Math.min(doc.length, Number(anchorTo) || 0));
    const from = doc.lineAt(rawFrom).from;
    const to = Math.max(from, rawTo, Math.max(0, Math.min(doc.length, Number(anchorFrom) || 0)));
    const lines = lineRangeFor(view, from, to);
    return {
      text: view.state.sliceDoc(from, to),
      from,
      to,
      startLine: lines.startLine,
      endLine: lines.endLine
    };
  } catch {
    return null;
  }
}

function resolveThreadSourceContext(thread) {
  try {
    const editor = getEditorForThread(thread);
    const view = editor?.getView?.();
    const anchor = view ? locateThreadAnchor(view, thread) : null;
    const from = typeof anchor?.from === "number" ? anchor.from : Number(thread?.from);
    const to = typeof anchor?.to === "number" ? anchor.to : Number(thread?.to);
    const snapshot = buildSourceContextSnapshot(view, from, to);
    if (snapshot?.text) return { ...snapshot, current: true };
  } catch {}
  const text = String(thread?.sourceContextText || "");
  if (!text && thread?.id) loadThreadPayload(thread, { emitChanged: true });
  if (!text) return null;
  return {
    text,
    from: Number(thread?.sourceContextFrom) || 0,
    to: Number(thread?.sourceContextTo) || text.length,
    startLine: Number(thread?.sourceContextStartLine) || 0,
    endLine: Number(thread?.sourceContextEndLine) || Number(thread?.endLine) || Number(thread?.startLine) || 0,
    current: false
  };
}

function resolveThreadUpstreamText(thread) {
  try {
    const editor = getEditorForThread(thread);
    const view = editor?.getView?.();
    if (view?.state?.doc) {
      const anchor = locateThreadAnchor(view, thread);
      const docLen = view.state.doc.length;
      const rawTo = typeof anchor?.to === "number" ? anchor.to : Number(thread?.to);
      const to = Math.max(0, Math.min(docLen, Number.isFinite(rawTo) ? rawTo : docLen));
      return { text: view.state.sliceDoc(0, to), current: true };
    }
  } catch {}
  const fallback = resolveThreadSourceContext(thread);
  return { text: String(fallback?.text || ""), current: false };
}

function formatThreadLineRange(thread, context) {
  const start = Number.isFinite(Number(thread?.startLine)) ? Number(thread.startLine) : Number(context?.startLine) || 0;
  const end = Number.isFinite(Number(thread?.endLine)) ? Number(thread.endLine) : Number(context?.endLine) || start;
  return `${start + 1}-${end + 1}`;
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
  const editor = window.zion?.editor?.getEditorForView?.(view) || window.zion?.window?.activeEditor || null;
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
  const sourceContext = buildSourceContextSnapshot(view, anchorFrom, anchorTo);
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
    sourceContextText: sourceContext?.text || anchorText,
    sourceContextFrom: sourceContext?.from ?? 0,
    sourceContextTo: sourceContext?.to ?? anchorTo,
    sourceContextStartLine: sourceContext?.startLine ?? 0,
      sourceContextEndLine: sourceContext?.endLine ?? lines.endLine,
      body: "",
      title: "",
      titleAuto: true,
    resolved: false,
    createdAt: now(),
    updatedAt: now()
  };
    rememberSourceFocus(editor);
    const persistedThread = saveThread(thread);
    if (!persistedThread) {
      try {
        window.zion?.notification?.show?.(
          t("thread.createFailedStorage", "Failed to create comment: local comment storage is full. Delete older comments and try again."),
          { type: "error", duration: 2600 }
        );
      } catch {}
      return null;
    }
    setActiveThread(persistedThread.id);
    pendingExpandThreadId = persistedThread.id;
    pendingFocusThreadId = persistedThread.id;
  openCommentsPanel();
  try {
    window.zion?.notification?.show?.(t("thread.created", "Comment thread created"), { type: "success", duration: 1400 });
  } catch {}
    return persistedThread;
}

function createThreadFromEditor(editor = null) {
  const sourceEditor = editor || window.zion?.window?.activeEditor || null;
  if (!sourceEditor || isCommentPanelId(sourceEditor?.panelId)) return null;
  const view = sourceEditor?.getView?.();
  const sel = view?.state?.selection?.main;
  if (!view || !sel) return null;
  return createThreadFromSelection({
    view,
    from: sel.from,
    to: sel.to,
    selectionText: view.state.sliceDoc(sel.from, sel.to)
  });
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
  try {
    const panels = window.zion?.panels?.list?.() || [];
    for (const panel of panels) {
      if (!panel?.id) continue;
      const panelEditor = window.zion?.panels?.getEditorBySession?.(panel.id, sessionId)
        || window.zion?.panels?.getEditor?.(panel.id);
      if (panelEditor && !isCommentPanelId(panelEditor?.panelId) && String(getSessionId(panelEditor) || "") === sessionId) {
        if (thread?.id && thread?.panelId !== panel.id) patchThread(thread.id, { panelId: panel.id }, { silent: true });
        return panelEditor;
      }
    }
  } catch {}
  return null;
}

async function ensureEditorForThread(thread, opts = {}) {
  const existing = getEditorForThread(thread, opts);
  if (existing) return existing;

  const sessionId = getThreadSourceSessionId(thread);
  if (!sessionId || sessionId === "global") return null;

  const panels = (() => {
    try { return window.zion?.panels?.list?.() || []; } catch { return []; }
  })();
  const panelId = String(
    opts.panelId ||
    thread?.panelId ||
    window.zion?.panels?.getActivePanelId?.() ||
    window.zion?.panelManager?.getActivePanelId?.() ||
    panels.find((panel) => panel?.id && !isCommentPanelId(panel.id))?.id ||
    ""
  );

  if (panelId && typeof window.zion?.panels?.openSession === "function") {
    try {
      await Promise.resolve(window.zion.panels.openSession(panelId, sessionId, { focus: opts.focusSource === true }));
      const editor = window.zion?.panels?.getEditorBySession?.(panelId, sessionId)
        || window.zion?.panels?.getEditor?.(panelId)
        || getEditorForThread(thread, opts);
      if (editor && !isCommentPanelId(editor?.panelId)) {
        if (thread?.id && thread?.panelId !== panelId) patchThread(thread.id, { panelId }, { silent: true });
        return editor;
      }
    } catch {}
  }

  try {
    await Promise.resolve(window.zion?.commands?.executeCommand?.("zion.sessions.switch", sessionId));
    const editor = getEditorForThread(thread, opts) || window.zion?.window?.activeEditor || null;
    if (editor && !isCommentPanelId(editor?.panelId)) return editor;
  } catch {}
  return getEditorForThread(thread, opts);
}

function revealThread(threadId, opts = {}) {
  const thread = typeof threadId === "object"
    ? threadId
    : readAllThreads().find((item) => item?.id === threadId) || null;
  if (!thread) return false;
  pendingRevealThreadId = thread.id || "";
  setActiveThread(thread.id);
  openCommentsPanel();
    const shouldRevealSource = opts.revealSource !== false;
  void ensureEditorForThread(thread, opts).then((editor) => {
    rememberThreadSource(thread, editor);
      if (shouldRevealSource) {
        revealThreadAnchor(thread, { focus: opts.focus === true, editor, smooth: opts.smooth });
      }
    signalCommentThreadLocated(thread.id, "reveal");
  }).catch(() => {
    rememberThreadSource(thread, null);
    signalCommentThreadLocated(thread.id, "reveal");
  });
  try {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      try {
        const selector = `.zion-comments-row[data-thread-id="${cssEscape(thread.id)}"]`;
        document.querySelector(selector)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      } catch {}
    }));
  } catch {}
  return true;
}

  class CommentMarkerWidget extends WidgetType {
    constructor(count, threadId, active = false) {
    super();
    this.count = count;
    this.threadId = threadId;
      this.active = !!active;
  }
  eq(other) {
      return other?.count === this.count && other?.threadId === this.threadId && other?.active === this.active;
  }
  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
      button.className = `zion-comment-anchor${this.active ? " is-active" : ""}`;
    button.title = this.count > 1 ? t("anchor.count", "{count} comments", { count: this.count }) : t("anchor.open", "Open comments");
    button.setAttribute("aria-label", button.title);
      if (this.count > 1) {
        button.dataset.count = String(this.count);
        button.textContent = String(this.count);
      } else {
        button.textContent = "";
      }
    button.onclick = (event) => {
      try { event.preventDefault(); event.stopPropagation(); } catch {}
      setActiveThread(this.threadId);
      signalCommentThreadLocated(this.threadId, "source-anchor");
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
    const tableAnchors = [];
    if (!threads.length) {
      try {
        if (!window.__zionCommentAnchorsByView) window.__zionCommentAnchorsByView = new WeakMap();
        window.__zionCommentAnchorsByView.set(view, tableAnchors);
      } catch {}
      return Decoration.none;
    }
  const ranges = [];
    const activeThreadId = String(window.zion?.state?.get?.(ACTIVE_KEY) || "");
  for (const thread of threads) {
    const anchor = locateThreadAnchor(view, thread);
    if (!anchor) continue;
      const active = thread.id === activeThreadId;
    if (anchor.to > anchor.from) {
          tableAnchors.push({
            id: thread.id,
            from: anchor.from,
            to: anchor.to,
            active
          });
        ranges.push(Decoration.mark({
          class: `zion-comment-range${active ? " is-active" : ""}`,
          attributes: {
            "data-comment-id": thread.id,
            title: t("anchor.open", "Open comments")
          }
        }).range(anchor.from, anchor.to));
    }
  }
    try {
      if (!window.__zionCommentAnchorsByView) window.__zionCommentAnchorsByView = new WeakMap();
      window.__zionCommentAnchorsByView.set(view, tableAnchors);
    } catch {}
  return Decoration.set(ranges, true);
}

function installCommentAnchors(editor) {
    const anchorsPlugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.editor = editor;
        this.decorations = buildCommentDecorations(view, this.editor);
          this.onViewportChanged = () => {
            try {
              window.dispatchEvent(new CustomEvent("zion:comments-viewport-changed", {
                detail: {
                  panelId: this.editor?.panelId || "",
                  sessionId: getSessionId(this.editor)
                }
              }));
            } catch {}
          };
        this.onChanged = () => {
          this.decorations = buildCommentDecorations(this.view, this.editor);
            try { this.view.dispatch({ annotations: Transaction.userEvent.of("wysiwyg-refresh") }); } catch {}
        };
        try { window.addEventListener("zion:comments-changed", this.onChanged); } catch {}
          try { window.addEventListener("zion:comments-active-changed", this.onChanged); } catch {}
          try { this.activeDisposable = window.zion?.state?.onDidChange?.(ACTIVE_KEY, this.onChanged) || null; } catch { this.activeDisposable = null; }
          try { view.scrollDOM?.addEventListener?.("scroll", this.onViewportChanged, { passive: true }); } catch {}
      }
      update(update) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildCommentDecorations(update.view, this.editor);
        }
          if (update.viewportChanged) this.onViewportChanged();
        if (update.docChanged) {
          try { window.dispatchEvent(new CustomEvent("zion:comments-anchor-updated")); } catch {}
        }
      }
      destroy() {
        try { window.removeEventListener("zion:comments-changed", this.onChanged); } catch {}
          try { window.removeEventListener("zion:comments-active-changed", this.onChanged); } catch {}
          try { this.activeDisposable?.dispose?.(); } catch {}
          try { this.view?.scrollDOM?.removeEventListener?.("scroll", this.onViewportChanged); } catch {}
      }
    },
    { decorations: (value) => value.decorations }
  );
    const clickHandler = EditorView.domEventHandlers({
      click(event) {
        const target = event.target;
        const el = target?.closest?.(".zion-comment-range[data-comment-id]");
        if (!el || !viewContainsEventTarget(event, el)) return false;
        const id = el.getAttribute("data-comment-id") || "";
        if (!id) return false;
        try { event.preventDefault(); event.stopPropagation(); } catch {}
        setActiveThread(id);
        signalCommentThreadLocated(id, "source-range");
        openCommentsPanel();
        return true;
      }
    });
    function viewContainsEventTarget(event, el) {
      try {
        const viewDom = event?.currentTarget;
        return !!viewDom?.contains?.(el);
      } catch {
        return false;
      }
    }
    return [anchorsPlugin, clickHandler];
}

function buildThreadContextMessages(thread) {
  const sourceContext = resolveThreadSourceContext(thread);
  const upstream = resolveThreadUpstreamText(thread);
  const upstreamText = String(upstream?.text || "");
  const anchorText = thread?.anchorText || thread?.quote || "（无）";
  const system = [
    "你正在回复 Zion Comments 中的一个独立评论会话。",
    "这个会话独立于主编辑器，但继承主文档中被评论片段之前的全部上文。",
    "上文会以正常的 user/assistant 对话消息形式提供给你（按主编辑器的原始角色解析），请把它当作被评论内容发生的完整背景。",
    "请重点围绕被评论片段回答，必要时给出可执行的修改建议；不要假设你正在直接编辑主文档。",
    "",
    `主会话 ID：${thread?.parentSessionId || thread?.sessionId || "unknown"}`,
    `评论线程 ID：${thread?.id || "unknown"}`,
    `锚点行：${formatThreadLineRange(thread, sourceContext)}`,
    "",
    "被评论片段：",
    anchorText
  ].join("\n");

  const messages = [{ role: "system", content: system }];

  let upstreamMessages = [];
  try {
    upstreamMessages = parseMessages(upstreamText)
      .map((m) => ({ role: m?.role, content: m?.content }))
      .filter((m) => m?.role && typeof m.content === "string" && m.content.trim());
  } catch {
    upstreamMessages = [];
  }

  if (upstreamMessages.length) {
    messages.push({
      role: "system",
      content: "以下为被评论片段之前的原会话上文（已按原始角色解析为对话消息）："
    });
    messages.push(...upstreamMessages);
  } else if (upstreamText.trim()) {
    messages.push({
      role: "system",
      content: `原会话编辑器上文（被评论片段之前的全部内容）：\n${upstreamText}`
    });
  }

  return messages;
}

function scrollCommentThreadCursorIntoView(view, reason = "keyboard") {
  try {
    const scroller = view?.scrollDOM;
    if (!scroller) return;
    const head = Math.max(0, Math.min(view.state.doc.length, view.state.selection.main.head));
    const coords = view.coordsAtPos(head);
    if (!coords) {
      view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "nearest", yMargin: 40 }) });
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    if (!scrollerRect?.height) return;
    const topLimit = scrollerRect.top + 24;
    const bottomLimit = scrollerRect.bottom - 28;
    let delta = 0;
    if (coords.top < topLimit) delta = coords.top - topLimit;
    else if (coords.bottom > bottomLimit) delta = coords.bottom - bottomLimit;
    if (!delta) return;
    scroller.scrollTop += delta;
    reportCommentLayoutDebug("thread-cursor-scroll", {
      reason,
      delta: Math.round(delta),
      head,
      cursorTop: Math.round(coords.top),
      cursorBottom: Math.round(coords.bottom),
      scrollerTop: Math.round(scrollerRect.top),
      scrollerBottom: Math.round(scrollerRect.bottom),
      nextScrollTop: Math.round(scroller.scrollTop)
    });
  } catch {}
}

function scheduleCommentThreadCursorScroll(view, reason) {
  try {
    requestAnimationFrame(() => {
      scrollCommentThreadCursorIntoView(view, reason);
      requestAnimationFrame(() => scrollCommentThreadCursorIntoView(view, `${reason}:after-layout`));
    });
  } catch {}
}

function shouldFollowCommentThreadSession(sessionId) {
  const sid = String(sessionId || "");
  if (!sid.startsWith("comment:")) return false;
  try {
    return window.zion?.state?.get?.(`chat.followLatest.${sid}`) !== false;
  } catch {
    return true;
  }
}

function shouldFollowActiveCommentRun(sessionId, runId = "") {
  const sid = String(sessionId || "");
  if (!sid.startsWith("comment:")) return false;
  const target = commentRunFollowTargetsBySession.get(sid);
  if (!target) return false;
  const state = window.zion?.state?.get?.(`chat.runs.${sid}`) || null;
  if (!state?.streaming) return false;
  const expectedRunId = String(target.runId || state?.runId || "");
  const actualRunId = String(runId || state?.runId || "");
  return !expectedRunId || !actualRunId || expectedRunId === actualRunId;
}

function shouldRunScheduledCommentTail(sessionId, opts = {}) {
  const sid = String(sessionId || "");
  if (!sid.startsWith("comment:")) return false;
  if (detachedCommentTailFollowSessions.has(sid) && !opts.allowDetached) return false;
  const state = window.zion?.state?.get?.(`chat.runs.${sid}`) || null;
  const runId = String(opts.runId || "");
  if (runId && String(state?.runId || "") !== runId) return false;
  if (!shouldFollowCommentThreadSession(sid) && !shouldFollowActiveCommentRun(sid, runId)) return false;
  return !!state?.streaming || !!opts.allowAfterRun;
}

function shouldFollowCommentChatEvent(eventName, payload) {
  const sid = String(payload?.sessionId || "");
  if (!sid || !sid.startsWith("comment:")) return false;
  if (detachedCommentTailFollowSessions.has(sid)) return false;
  const state = window.zion?.state?.get?.(`chat.runs.${sid}`) || null;
  const runId = String(payload?.runId || "");
  const currentRunId = String(state?.runId || "");
  if (runId && currentRunId && runId !== currentRunId) return false;
  if (eventName === "chat/runStarted") return false;
  if (!shouldFollowCommentThreadSession(sid) && !shouldFollowActiveCommentRun(sid, runId)) return false;
  if (state?.streaming) return true;
  return false;
}

function scrollCommentThreadTailIntoView(view, reason = "thread-tail", opts = {}) {
  try {
    const list = view?.dom?.closest(".zion-comments-list");
    if (!list) return false;
    const listRect = list.getBoundingClientRect();
    if (!listRect?.height) return false;

    const runTarget = getCommentRunFollowTargetRect(view);
    if (!runTarget) return false;

    const block = view.lineBlockAt?.(runTarget.pos);
    if (!block) return false;

    const contentRect = view.contentDOM.getBoundingClientRect();
    const targetScreenTop = contentRect.top + block.top;
    const targetScreenBottom = contentRect.top + block.bottom;

    const topLimit = listRect.top + 30 + 40;
    const bottomLimit = listRect.bottom - 60;

    let delta = 0;
    if (targetScreenBottom > bottomLimit) {
      delta = targetScreenBottom - bottomLimit;
    } else if (targetScreenTop < topLimit) {
      delta = targetScreenTop - topLimit;
    }

    if (Math.abs(delta) < 1) return false;

    const beforeScrollTop = Number(list.scrollTop) || 0;
    markCommentListProgrammaticScroll(list, 900);
    list.scrollTop += delta;
    list.dispatchEvent(new Event('scroll'));

    debugCommentScrollJitter("B", "tail.apply", {
      reason,
      beforeScrollTop,
      afterScrollTop: list.scrollTop,
      delta,
      targetScreenTop,
      targetScreenBottom,
      topLimit,
      bottomLimit,
      listRectTop: listRect.top,
      contentRectTop: contentRect.top
    });

    return true;
  } catch (err) {
    console.error(err);
  }
  return false;
}

function getCommentRunFollowTargetRect(view) {
  try {
    const sessionId = String(view?.dom?.dataset?.sessionId || "");
    const target = sessionId ? commentRunFollowTargetsBySession.get(sessionId) : null;
    const doc = view?.state?.doc;
    if (!target || !doc) return null;
    const text = doc.toString();
    const lines = text.split("\n");
    const startLine = Math.max(0, Number(target.answerHeadLine ?? target.insertLine ?? 0) || 0);
    let assistantIndex = -1;
    for (let i = Math.min(startLine, lines.length - 1); i < lines.length; i++) {
      if (/^\s*assistant\b/.test(lines[i] || "")) {
        assistantIndex = i;
        break;
      }
      if (i > startLine && /^\s*(system|user|tool)\b/.test(lines[i] || "")) break;
    }
    if (assistantIndex < 0) {
      for (let i = Math.min(startLine, lines.length - 1); i >= 0; i--) {
        if (/^\s*assistant\b/.test(lines[i] || "")) {
          assistantIndex = i;
          break;
        }
        if (i < startLine && /^\s*(system|user|tool)\b/.test(lines[i] || "")) break;
      }
    }
    if (assistantIndex < 0) return null;
    let endIndex = assistantIndex;
    for (let i = assistantIndex + 1; i < lines.length; i++) {
      if (/^\s*(system|user|assistant|tool)\b/.test(lines[i] || "")) break;
      endIndex = i;
    }
    const line = doc.line(Math.max(1, Math.min(doc.lines, endIndex + 1)));
    const coords = view.coordsAtPos(line.to);
    return { 
      lineNumber: endIndex + 1, 
      pos: line.to, 
      top: coords ? coords.top : null, 
      bottom: coords ? coords.bottom : null,
      isVirtual: !coords 
    };
  } catch {}
  return null;
}

function scheduleCommentThreadTailScroll(view, sessionId, reason = "thread-tail", opts = {}) {
  if (!view || !shouldRunScheduledCommentTail(sessionId, opts)) return;
  // #region debug-point A:tail-schedule
  debugCommentScrollJitter("A", "tail.schedule", {
    sessionId: String(sessionId || ""),
    reason,
    listScrollTop: Math.round(Number(view?.dom?.closest?.(".zion-comments-list")?.scrollTop) || 0),
    sourceScrollTop: Math.round(Number(getSourceEditorForCommentsPanel()?.getView?.()?.scrollDOM?.scrollTop) || 0),
    streaming: !!window.zion?.state?.get?.(`chat.runs.${String(sessionId || "")}`)?.streaming,
      followLatest: window.zion?.state?.get?.(`chat.followLatest.${String(sessionId || "")}`),
        detached: detachedCommentTailFollowSessions.has(String(sessionId || "")),
      runId: opts.runId || "",
      allowAfterRun: !!opts.allowAfterRun,
      forceAlign: !!opts.forceAlign
  });
  // #endregion
  const run = (phase) => {
      if (shouldRunScheduledCommentTail(sessionId, opts)) {
      scrollCommentThreadTailIntoView(view, `${reason}:${phase}`, {
        forceAlign: !!opts.forceAlign
      });
    }
  };
  try {
    run("sync");
    requestAnimationFrame(() => {
      run("raf1");
      requestAnimationFrame(() => run("raf2"));
    });
  } catch {
    setTimeout(() => run("timeout0"), 0);
  }
  try { setTimeout(() => run("timeout80"), 80); } catch {}
  try { setTimeout(() => run("timeout180"), 180); } catch {}
}

function scheduleCommentSessionTailScroll(sessionId, reason = "chat-event", opts = {}) {
  const sid = String(sessionId || "");
  if (!sid || !shouldRunScheduledCommentTail(sid, opts)) {
    // #region debug-point A:tail-session-skipped
    debugCommentScrollJitter("A", "tail.sessionSkipped", {
      sessionId: sid,
      reason,
      followLatest: sid ? window.zion?.state?.get?.(`chat.followLatest.${sid}`) : null,
      runId: opts.runId || "",
      allowAfterRun: !!opts.allowAfterRun,
      streaming: sid ? !!window.zion?.state?.get?.(`chat.runs.${sid}`)?.streaming : false,
        currentRunId: sid ? String(window.zion?.state?.get?.(`chat.runs.${sid}`)?.runId || "") : "",
        detached: detachedCommentTailFollowSessions.has(sid)
    });
    // #endregion
    return;
  }
  const handle = commentEditorHandlesBySession.get(sid);
  if (!handle?.view) {
    // #region debug-point E:tail-no-handle
    debugCommentScrollJitter("E", "tail.noHandle", {
      sessionId: sid,
      reason,
      knownSessions: Array.from(commentEditorHandlesBySession.keys()).slice(0, 8)
    });
    // #endregion
    return;
  }
  scheduleCommentThreadTailScroll(handle.view, sid, reason, opts);
}

function createThreadEditor(container, thread, onSave, onRun, onLayoutChange, onUserInteraction) {
  let saveTimer = 0;
  let disposed = false;
  let pendingKeyboardCursorScrollUntil = 0;
  const keyDisposers = [];
  const panelId = `comments:${thread.id}`;
  const sessionId = getThreadSessionId(thread);
  const initialValue = typeof thread?.body === "string" ? thread.body : "";
  const core = new EditorCore(container, initialValue, panelId);
  core.setSessionId(sessionId);
    try { core.view.dom.dataset.sessionId = sessionId; } catch {}
  try { core.setLineNumbersEnabled(false); } catch {}
  try { core.setFoldingEnabled(false); } catch {}
  try { core.setActiveLineHighlightEnabled(false); } catch {}
  const proxy = window.zion?.editor?.attachEditor?.(core, panelId) || null;
  try { proxy?.setSessionId?.(sessionId); } catch {}
  const view = core.view;
  try { core.addExternalExtension(EditorView.editorAttributes.of({ class: "zion-comments-thread-editor" })); } catch {}
    const clampCommentEditorScroll = () => {
      try {
        const scroller = view?.scrollDOM;
        if (!scroller) return;
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (scroller.scrollTop > maxScroll) scroller.scrollTop = maxScroll;
      } catch {}
    };
  let overviewRail = null;
  try { overviewRail = createChatOverviewRail(proxy || core); } catch {}
    try {
      let lastCmScrollTop = Math.round(Number(view.scrollDOM?.scrollTop) || 0);
      const createdAt = Date.now();
      const markThreadScrollIntent = () => markCommentUserScrollIntent(view.scrollDOM, 900);
      const markThreadKeyScrollIntent = (event) => {
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
          markThreadScrollIntent();
        }
      };
      const onCmScroll = () => {
        const nextCmScrollTop = Math.round(Number(view.scrollDOM?.scrollTop) || 0);
        const hasUserIntent = Date.now() <= Number(view.scrollDOM?.__zionUserScrollIntentUntil || 0);
        const isProgrammatic = Date.now() <= Number(view.scrollDOM?.__zionProgrammaticScrollUntil || 0);
        if (hasUserIntent && !isProgrammatic && Date.now() > createdAt + 500 && Math.abs(nextCmScrollTop - lastCmScrollTop) >= 2) {
          onUserInteraction?.("comment-thread-scroll", getCommentScrollDebugSnapshot(view));
        }
        lastCmScrollTop = nextCmScrollTop;
        debugCommentScrollJitter("I", "thread.cmScroll", getCommentScrollDebugSnapshot(view));
      };
      const bindListScroll = () => {
        const list = view?.dom?.closest?.(".zion-comments-list");
        if (!list) return;
        const onListScroll = () => {
          debugCommentScrollJitter("I", "thread.listScroll", getCommentScrollDebugSnapshot(view));
        };
        list.addEventListener("scroll", onListScroll, { passive: true });
        keyDisposers.push(() => list.removeEventListener("scroll", onListScroll));
      };
      view.scrollDOM?.addEventListener?.("wheel", markThreadScrollIntent, { passive: true });
      view.scrollDOM?.addEventListener?.("touchstart", markThreadScrollIntent, { passive: true });
      view.scrollDOM?.addEventListener?.("keydown", markThreadKeyScrollIntent, true);
      view.scrollDOM?.addEventListener?.("pointerdown", (event) => {
        try {
          const rect = view.scrollDOM.getBoundingClientRect();
          if (event.clientX >= rect.right - 16) markThreadScrollIntent();
        } catch {}
      }, { passive: true });
      view.scrollDOM?.addEventListener?.("scroll", onCmScroll, { passive: true });
      keyDisposers.push(() => view.scrollDOM?.removeEventListener?.("wheel", markThreadScrollIntent));
      keyDisposers.push(() => view.scrollDOM?.removeEventListener?.("touchstart", markThreadScrollIntent));
      keyDisposers.push(() => view.scrollDOM?.removeEventListener?.("keydown", markThreadKeyScrollIntent, true));
      keyDisposers.push(() => view.scrollDOM?.removeEventListener?.("scroll", onCmScroll));
      requestAnimationFrame(bindListScroll);
    } catch {}
  try {
    const handleCapturedKeydown = (event) => {
      try {
        const isVerticalJump = (event.key === "ArrowUp" || event.key === "ArrowDown")
          && (event.metaKey || event.altKey);
        if (!isVerticalJump) return;
        if (!view?.dom?.contains?.(event.target)) return;
        pendingKeyboardCursorScrollUntil = Date.now() + 500;
        scheduleCommentThreadCursorScroll(view, "thread-keyboard-capture");
      } catch {}
    };
    view.dom?.addEventListener?.("keydown", handleCapturedKeydown, true);
    keyDisposers.push(() => view.dom?.removeEventListener?.("keydown", handleCapturedKeydown, true));
  } catch {}
  try {
    core.addExternalExtension(EditorView.updateListener.of((update) => {
        requestAnimationFrame(clampCommentEditorScroll);
        if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged || update.heightChanged) {
          debugCommentScrollJitter("I", "thread.update.detail", {
            ...getCommentScrollDebugSnapshot(update.view),
            docChanged: !!update.docChanged,
            selectionSet: !!update.selectionSet,
            viewportChanged: !!update.viewportChanged,
            geometryChanged: !!update.geometryChanged,
            heightChanged: !!update.heightChanged
          });
        }
      if (
        pendingKeyboardCursorScrollUntil
        && Date.now() <= pendingKeyboardCursorScrollUntil
        && (update.selectionSet || update.docChanged || update.geometryChanged)
      ) {
        scheduleCommentThreadCursorScroll(update.view, "thread-keyboard-update");
      }
      if (update.docChanged || update.heightChanged || update.viewportChanged) {
        try { requestAnimationFrame(() => onLayoutChange?.()); } catch {}
      }
        if (
          (update.docChanged || update.heightChanged || update.viewportChanged || update.geometryChanged)
          && window.zion?.state?.get?.(`chat.runs.${sessionId}`)?.streaming
        ) {
          // #region debug-point A:thread-stream-update
          const runState = window.zion?.state?.get?.(`chat.runs.${sessionId}`) || null;
          debugCommentScrollJitter("A", "thread.update.streaming", {
            sessionId,
            docChanged: !!update.docChanged,
            heightChanged: !!update.heightChanged,
            viewportChanged: !!update.viewportChanged,
            geometryChanged: !!update.geometryChanged,
            listScrollTop: Math.round(Number(update.view?.dom?.closest?.(".zion-comments-list")?.scrollTop) || 0),
            sourceScrollTop: Math.round(Number(getSourceEditorForCommentsPanel()?.getView?.()?.scrollDOM?.scrollTop) || 0),
            runId: String(runState?.runId || "")
          });
          // #endregion
          scheduleCommentThreadTailScroll(update.view, sessionId, "thread-stream-update", { runId: String(runState?.runId || "") });
        }
      if (!update.docChanged) return;
      if (saveTimer) window.clearTimeout(saveTimer);
      const isUserEdit = update.transactions?.some?.((tr) => {
        const userEvent = tr?.annotation?.(Transaction.userEvent);
        return typeof userEvent === "string" && userEvent.startsWith("input");
      });
      if (isUserEdit) {
        onUserInteraction?.("comment-thread-edit", {
          sessionId,
          docLength: Math.round(Number(update.view?.state?.doc?.length) || 0)
        });
      }
      saveTimer = window.setTimeout(() => onSave(view.state.doc.toString()), 250);
    }));
  } catch {}
  try {
    core.addExternalExtension(Prec.highest(keymap.of([
      {
        key: "Mod-Enter",
        run() {
          onSave(view.state.doc.toString());
          onUserInteraction?.("comment-run-keyboard", getCommentScrollDebugSnapshot(view));
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
  loadThreadPayload(thread).then((payload) => {
    if (disposed || !payload || typeof payload !== "object") return;
    const bodyText = typeof payload.body === "string" ? payload.body : "";
    if (bodyText) {
      const current = view.state.doc.toString();
      if (!current || current === initialValue) {
        try {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: bodyText },
            selection: { anchor: bodyText.length }
          });
            requestAnimationFrame(clampCommentEditorScroll);
            try { requestAnimationFrame(() => onLayoutChange?.()); } catch {}
        } catch {}
      }
    }
    const annotations = normalizeThreadAnnotations(payload.chatAnnotations || {});
    const hasCards = annotations.tools.length > 0 || annotations.thinking.length > 0;
    if (hasCards) {
      setSessionAnnotations(sessionId, annotations);
      restoreSessionAnnotations(sessionId, panelId, annotations);
    }
  });
    const handle = {
    core,
    proxy,
    view,
    panelId,
    sessionId,
    dispose() {
      disposed = true;
      if (saveTimer) window.clearTimeout(saveTimer);
      try { onSave(view.state.doc.toString()); } catch {}
      try {
        window.zion?.commands?.executeCommand?.("zion.chatCards.snapshotSession", { sessionId, panelId });
        persistThreadAnnotations(thread, getSessionAnnotations(sessionId));
      } catch {}
      try { overviewRail?.dispose?.(); } catch {}
      try { window.zion?.editor?.detachEditor?.(panelId); } catch {}
      for (const disposeKey of keyDisposers.splice(0)) {
        try { disposeKey(); } catch {}
      }
        if (lastCommentsEditorHandle?.panelId === panelId) lastCommentsEditorHandle = null;
        if (commentEditorHandlesBySession.get(sessionId)?.panelId === panelId) {
          commentEditorHandlesBySession.delete(sessionId);
        }
      core.dispose();
    }
  };
    commentEditorHandlesBySession.set(sessionId, handle);
    return handle;
}

function createFoldedThreadEditor(container, thread, onLoaded) {
  let disposed = false;
  const panelId = `comments:folded:${thread.id}`;
  const sessionId = `comment:folded:${thread.id}`;
  const initialValue = typeof thread?.body === "string" ? thread.body : "";
  const core = new EditorCore(container, initialValue, panelId);
  try { core.setSessionId(sessionId); } catch {}
  const view = core.view;
  try { core.setLineNumbersEnabled(false); } catch {}
  try { core.setFoldingEnabled(false); } catch {}
  try { core.setActiveLineHighlightEnabled(false); } catch {}
  try {
    core.addExternalExtension([
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      createRolesExtension(),
        installThinkingCards(),
        installToolCallCards(),
      EditorView.editorAttributes.of({ class: "zion-comments-thread-editor zion-comments-folded-thread-editor" })
    ]);
  } catch {}
    const restoreFoldedCards = (sourceThread) => {
      try {
        const annotations = normalizeThreadAnnotations(sourceThread?.chatAnnotations || {});
        if (!annotations.tools.length && !annotations.thinking.length) return;
        setSessionAnnotations(sessionId, annotations);
        restoreSessionAnnotations(sessionId, panelId, annotations);
      } catch {}
    };
    restoreFoldedCards(thread);
  loadThreadPayload(thread).then((payload) => {
    if (disposed || !payload || typeof payload !== "object") return;
    const bodyText = typeof payload.body === "string" ? payload.body : "";
      const payloadThread = applyThreadPayload(thread, payload);
    try {
        if (bodyText) {
          const current = view.state.doc.toString();
          if (!current || current === initialValue) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: bodyText },
              selection: { anchor: 0 }
            });
          }
        }
        restoreFoldedCards(payloadThread);
        onLoaded?.();
    } catch {}
  });
  return {
    core,
    view,
    panelId,
    dispose() {
      disposed = true;
      core.dispose();
    }
  };
}

function renderCommentsPanel(container) {
  const root = document.createElement("div");
  root.className = "zion-comments-panel";
  container.appendChild(root);
    let editorHandles = new Map();
  let disposed = false;
    let updateRunActions = new Map();
  let listScrollTop = 0;
  let panelFollowsSourceScroll = true;
  let programmaticListScrollUntil = 0;
  let lastUserListScrollTop = 0;

  const disposables = [];
  let renderScheduled = false;
  let lastRenderedSessionId = "";
    let syncedThreadId = "";
    let lastSourceSyncScrollTop = NaN;
    let syncScheduled = false;
    let suppressPanelSyncUntil = 0;
      let suppressNextActiveRender = false;
    let filterKind = "all";
    let filterVisible = false;
    let historyVisible = false;
    const expandedThreadIds = new Set();
  const schedule = (opts = {}) => {
    if (disposed) return;
      const force = !!opts.force;
      if (!force && Date.now() < suppressPanelSyncUntil) {
        return;
      }
    if (renderScheduled) return;
    renderScheduled = true;
    window.requestAnimationFrame(() => {
      renderScheduled = false;
        if (!force && Date.now() < suppressPanelSyncUntil) {
          return;
        }
      render();
    });
    };
    const markProgrammaticListScroll = (duration = 180) => {
      programmaticListScrollUntil = Math.max(programmaticListScrollUntil, Date.now() + duration);
      markCommentListProgrammaticScroll(root.querySelector(".zion-comments-list"), duration);
    };
    const detachCommentRunTailFollow = (reason, data = {}) => {
      try {
        const sessions = new Set();
        const dataSessionId = String(data?.sessionId || "");
        if (dataSessionId.startsWith("comment:")) sessions.add(dataSessionId);
        for (const sid of commentEditorHandlesBySession.keys()) {
          if (String(sid || "").startsWith("comment:")) sessions.add(String(sid));
        }
        for (const sid of sessions) {
          const state = window.zion?.state?.get?.(`chat.runs.${sid}`) || null;
          if (!state?.streaming) continue;
          detachedCommentTailFollowSessions.add(sid);
          debugCommentScrollJitter("F", "tail.detached", {
            reason,
            sessionId: sid,
            runId: String(state?.runId || ""),
            listScrollTop: Math.round(Number(root.querySelector(".zion-comments-list")?.scrollTop) || 0),
            sourceScrollTop: Math.round(Number(getSourceEditorForCommentsPanel()?.getView?.()?.scrollDOM?.scrollTop) || 0),
            ...data
          });
        }
      } catch {}
    };
    const pausePanelSourceFollow = (reason, data = {}) => {
      try {
        if (!panelFollowsSourceScroll) return;
        panelFollowsSourceScroll = false;
        const list = root.querySelector(".zion-comments-list");
        if (list) {
          listScrollTop = Number(list.scrollTop) || 0;
          lastUserListScrollTop = listScrollTop;
        }
        debugCommentScrollJitter("F", "sync.followPaused", {
          reason,
          listScrollTop: Math.round(Number(listScrollTop) || 0),
          sourceScrollTop: Math.round(Number(getSourceEditorForCommentsPanel()?.getView?.()?.scrollDOM?.scrollTop) || 0),
          ...data
        });
      } catch {}
    };
    const resumePanelSourceFollow = (reason, data = {}) => {
      try {
        if (panelFollowsSourceScroll) return;
        panelFollowsSourceScroll = true;
        lastSourceSyncScrollTop = NaN;
        debugCommentScrollJitter("F", "sync.followResumed", {
          reason,
          listScrollTop: Math.round(Number(root.querySelector(".zion-comments-list")?.scrollTop) || 0),
          sourceScrollTop: Math.round(Number(getSourceEditorForCommentsPanel()?.getView?.()?.scrollDOM?.scrollTop) || 0),
          ...data
        });
      } catch {}
    };
      const updateActiveThreadClasses = (nextId) => {
        try {
          root.querySelectorAll(".zion-comments-row.is-active").forEach((row) => {
            if (row?.dataset?.threadId !== nextId) row.classList.remove("is-active");
          });
          if (nextId) root.querySelector(`.zion-comments-row[data-thread-id="${cssEscape(nextId)}"]`)?.classList?.add?.("is-active");
        } catch {}
      };
      try {
        disposables.push(window.zion?.state?.onDidChange?.(ACTIVE_KEY, () => {
          const nextId = String(window.zion?.state?.get?.(ACTIVE_KEY) || "");
          if (suppressNextActiveRender) {
            suppressNextActiveRender = false;
            updateActiveThreadClasses(nextId);
            return;
          }
          schedule();
      }));
      } catch {}
      const alignLocatedThreadToSourceViewport = (threadId, row) => {
        try {
          const list = root.querySelector(".zion-comments-list");
          if (!list || !row) return false;
          const thread = readAllThreads().find((item) => item?.id === threadId) || null;
          if (!thread) return false;
          const editor = getEditorForThread(thread) || getSourceEditorForCommentsPanel();
          const view = editor?.getView?.();
          const anchor = view ? locateThreadAnchor(view, thread) : null;
          const scroller = view?.scrollDOM;
          if (!anchor || !scroller || typeof anchor.from !== "number") return false;
          const listRect = list.getBoundingClientRect?.();
          const rowRect = row.getBoundingClientRect?.();
          if (!listRect || !rowRect) return false;
          const sourceCoords = view.coordsAtPos?.(anchor.from);
          let sourceViewportTop = Number(sourceCoords?.top);
          if (!Number.isFinite(sourceViewportTop)) {
            const block = view.lineBlockAt?.(anchor.from);
            const scrollerRect = scroller.getBoundingClientRect?.();
            const sourceTop = Number(block?.top) - Number(scroller.scrollTop || 0);
            sourceViewportTop = Number(scrollerRect?.top) + sourceTop;
          }
          if (!Number.isFinite(sourceViewportTop)) return false;
          const desiredTop = sourceViewportTop - Number(listRect.top || 0);
          const rowTopInList = Number(rowRect.top || 0) - Number(listRect.top || 0);
          const maxVisibleTop = Math.max(0, list.clientHeight - Math.min(rowRect.height || row.offsetHeight || 0, list.clientHeight));
          const visibleTop = Math.max(0, Math.min(desiredTop, maxVisibleTop));
          const maxScroll = Math.max(0, (list.scrollHeight || 0) - (list.clientHeight || 0));
          const nextScrollTop = Math.max(0, Math.min(maxScroll, Math.round((list.scrollTop || 0) + rowTopInList - visibleTop)));
          markProgrammaticListScroll(260);
          list.scrollTop = nextScrollTop;
          listScrollTop = nextScrollTop;
          lastUserListScrollTop = nextScrollTop;
          suppressPanelSyncUntil = Date.now() + 650;
          reportCommentLayoutDebug("located-align", {
            threadId,
            sourceViewportTop: Math.round(sourceViewportTop),
            listViewportTop: Math.round(Number(listRect.top || 0)),
            desiredTop: Math.round(desiredTop),
            visibleTop: Math.round(visibleTop),
            rowTopInList: Math.round(rowTopInList),
            listScrollTop: Math.round(nextScrollTop)
          });
          return true;
        } catch {
          return false;
        }
      };
      const pulseLocatedThread = (threadId) => {
        try {
          const id = String(threadId || "");
          if (!id) return false;
          const row = root.querySelector(`.zion-comments-row[data-thread-id="${cssEscape(id)}"]`);
          if (!row) return false;
          const aligned = alignLocatedThreadToSourceViewport(id, row);
          if (!aligned) {
            markProgrammaticListScroll(260);
            row.scrollIntoView?.({ block: "nearest", inline: "nearest" });
          }
            // #region debug-point C:located-pulse
            debugCommentScrollJitter("C", "located.pulse", {
              threadId: id,
              aligned,
              listScrollTop: Math.round(Number(root.querySelector(".zion-comments-list")?.scrollTop) || 0),
              rowTop: Math.round(Number(row.getBoundingClientRect?.()?.top) || 0)
            });
            // #endregion
          row.classList.remove("is-located");
          void row.offsetWidth;
          row.classList.add("is-located");
          window.setTimeout(() => {
            try { row.classList.remove("is-located"); } catch {}
          }, 1400);
          return true;
        } catch {
          return false;
        }
      };
      try {
        const onThreadLocated = (event) => {
          const threadId = String(event?.detail?.threadId || "");
          if (!threadId) return;
          resumePanelSourceFollow(`external:${String(event?.detail?.source || "located")}`, { threadId });
          updateActiveThreadClasses(threadId);
          const pulsed = pulseLocatedThread(threadId);
          // #region debug-point C:located-event
          debugCommentScrollJitter("C", "located.event", {
            threadId,
            pulsed,
            pendingRevealThreadId,
            pendingLocatedThreadId
          });
          // #endregion
          if (pulsed) {
            if (pendingLocatedThreadId === threadId) pendingLocatedThreadId = "";
            if (pendingRevealThreadId === threadId) pendingRevealThreadId = "";
            return;
          }
          if (!pulsed) {
            pendingLocatedThreadId = threadId;
            pendingRevealThreadId = threadId;
            schedule({ force: true });
          }
        };
        window.addEventListener("zion:comments-thread-located", onThreadLocated);
        disposables.push({ dispose: () => window.removeEventListener("zion:comments-thread-located", onThreadLocated) });
      } catch {}
    try {
      disposables.push(window.zion?.events?.on?.(CHANGED_EVENT, () => {
        if (Date.now() < suppressPanelSyncUntil) return;
        schedule();
      }));
    } catch {}
    const disposeCommentEditors = () => {
      for (const handle of editorHandles.values()) {
        try { handle?.dispose?.(); } catch {}
      }
      editorHandles.clear();
      updateRunActions.clear();
      lastCommentsEditorHandle = null;
    };
    const activateSourcePanelFromPayload = (eventName, payload) => {
      const payloadPanelId = String(payload?.panelId || "");
      const panel = payloadPanelId
        ? (window.zion?.panels?.list?.() || []).find((item) => item?.id === payloadPanelId)
        : null;
      const payloadSessionId = String(payload?.sessionId || payload?.tabId || panel?.activeTabId || "");
      const isCommentEditorTab = payloadSessionId && Array.from(editorHandles.values()).some((handle) => handle?.sessionId === payloadSessionId);
      if (isCommentEditorTab) {
        return;
      }
      if (payloadPanelId && payloadSessionId) {
        const editor = rememberSourcePanelSession(payloadPanelId, payloadSessionId);
        const sourceScrollTop = Number(editor?.getView?.()?.scrollDOM?.scrollTop);
        if (panelFollowsSourceScroll) {
          listScrollTop = Number.isFinite(sourceScrollTop) ? Math.max(0, sourceScrollTop) : listScrollTop;
          lastUserListScrollTop = listScrollTop;
        }
          lastSourceSyncScrollTop = Number.isFinite(sourceScrollTop) ? sourceScrollTop : NaN;
        syncedThreadId = "";
      }
      if (payloadSessionId && payloadSessionId === lastRenderedSessionId) {
        return;
      }
      if (Date.now() < suppressPanelSyncUntil) {
        return;
      }
      schedule({ force: true });
    };
    try { disposables.push(window.zion?.events?.on?.("panel/tabActivated", (payload) => {
      activateSourcePanelFromPayload("panel/tabActivated", payload);
    })); } catch {}
    try { disposables.push(window.zion?.events?.on?.("panel/focusChanged", (payload) => {
      activateSourcePanelFromPayload("panel/focusChanged", payload);
    })); } catch {}
  const refreshRunAction = (payload) => {
    if (disposed) return;
      const sid = String(payload?.sessionId || "");
      if (sid.startsWith("comment:") && window.zion?.state?.get?.(`chat.runs.${sid}`)?.streaming) {
        pausePanelSourceFollow("comment-run-event", { sessionId: sid, runId: String(payload?.runId || "") });
      }
      for (const update of updateRunActions.values()) {
        try { update?.(payload); } catch {}
      }
    updateThreadStatusIndicators(root);
  };
  try { disposables.push(window.zion?.events?.on?.("chat/runStarted", refreshRunAction)); } catch {}
  try { disposables.push(window.zion?.events?.on?.("chat/runFinished", refreshRunAction)); } catch {}
  try { disposables.push(window.zion?.events?.on?.("chat/aborted", refreshRunAction)); } catch {}
  try { disposables.push(window.zion?.events?.on?.("chat/runError", refreshRunAction)); } catch {}
  try { disposables.push(window.zion?.events?.on?.("i18n/changed", schedule)); } catch {}
    const scheduleViewportSync = (event) => {
      if (disposed || syncScheduled) return;
      const eventSessionId = String(event?.detail?.sessionId || "");
      if (eventSessionId && lastRenderedSessionId && eventSessionId !== lastRenderedSessionId) return;
      syncScheduled = true;
      window.requestAnimationFrame(() => {
        syncScheduled = false;
        syncListToSourceViewport();
      });
    };
    try {
      window.addEventListener("zion:comments-viewport-changed", scheduleViewportSync);
      disposables.push({ dispose: () => window.removeEventListener("zion:comments-viewport-changed", scheduleViewportSync) });
    } catch {}
    const isCommentFocusTarget = (target) => {
      try {
        if (!target) return false;
        if (root.contains(target)) return true;
        return !!target.closest?.(".zion-comment-range[data-comment-id], .zion-comment-anchor");
      } catch {
        return false;
      }
    };
    const clearActiveThreadOnOutsideFocus = (event) => {
      if (disposed) return;
      if (isCommentFocusTarget(event?.target)) return;
      if (window.zion?.state?.get?.(ACTIVE_KEY)) setActiveThread("");
    };
    try {
      document.addEventListener("pointerdown", clearActiveThreadOnOutsideFocus, true);
      document.addEventListener("focusin", clearActiveThreadOnOutsideFocus, true);
      disposables.push({
        dispose: () => {
          document.removeEventListener("pointerdown", clearActiveThreadOnOutsideFocus, true);
          document.removeEventListener("focusin", clearActiveThreadOnOutsideFocus, true);
        }
      });
    } catch {}
  const restoreActiveThreadCards = () => {
    try {
        const handles = Array.from(editorHandles.values());
        for (const handle of handles) {
          const sid = handle?.sessionId;
          if (!sid) continue;
          const runtimeAnnotations = getSessionAnnotations(sid);
          const thread = readAllThreads().find((item) => getThreadSessionId(item) === sid) || null;
          const storedAnnotations = thread ? hydrateThreadAnnotations(thread) : {};
          const annotations = (Array.isArray(runtimeAnnotations.tools) && runtimeAnnotations.tools.length) ||
            (Array.isArray(runtimeAnnotations.thinking) && runtimeAnnotations.thinking.length)
            ? runtimeAnnotations
            : storedAnnotations;
          if (!annotations?.tools?.length && !annotations?.thinking?.length) continue;
          restoreSessionAnnotations(sid, handle?.panelId, annotations);
        }
    } catch {}
  };
  try {
    let wasHidden = document.hidden;
    const onVisible = () => {
      const isHidden = document.hidden;
      if (wasHidden && !isHidden) setTimeout(restoreActiveThreadCards, 180);
      wasHidden = isHidden;
    };
    document.addEventListener("visibilitychange", onVisible);
    disposables.push({ dispose: () => document.removeEventListener("visibilitychange", onVisible) });
  } catch {}
  try {
    const onFocus = () => {
      setTimeout(restoreActiveThreadCards, 180);
    };
    window.addEventListener("focus", onFocus);
    disposables.push({ dispose: () => window.removeEventListener("focus", onFocus) });
  } catch {}

  render();
  return {
    dispose() {
      disposed = true;
        disposeCommentEditors();
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
    const activeEditor = getSourceEditorForCommentsPanel();
    const activeView = activeEditor?.getView?.();
    const sessionId = getSourceSessionIdForCommentsPanel(activeEditor);
    lastRenderedSessionId = String(sessionId || "");
    let threads = getThreadsForSession(sessionId);
      disposeCommentEditors();
    root.replaceChildren();

    const anchorById = new Map();
    for (const item of threads) {
      anchorById.set(item.id, activeView ? locateThreadAnchor(activeView, item) : null);
    }
    threads = sortThreadsByDocumentOrder(threads, anchorById);
    const stateActive = getActiveThread();
    const active = stateActive && threads.some((item) => item.id === stateActive.id) ? stateActive : null;
    const allThreads = threads;
    const openCount = allThreads.filter((item) => !item.resolved).length;
    const filteredThreads = allThreads.filter((item) => {
      const anchor = anchorById.get(item.id);
      if (filterKind === "open") return !item.resolved;
      if (filterKind === "resolved") return !!item.resolved;
      if (filterKind === "lost") return !anchor;
      return true;
    });
    const navigateThread = (direction) => {
      if (!filteredThreads.length) return;
      const activeId = String(active?.id || syncedThreadId || "");
      let currentIndex = filteredThreads.findIndex((item) => String(item.id) === activeId);
      if (currentIndex < 0) currentIndex = direction > 0 ? -1 : 0;
      const nextIndex = (currentIndex + direction + filteredThreads.length) % filteredThreads.length;
      const next = filteredThreads[nextIndex];
      if (!next?.id) return;
      historyVisible = false;
      filterVisible = false;
      suppressPanelSyncUntil = Date.now() + 900;
      syncedThreadId = next.id;
      pendingRevealThreadId = next.id;
      pendingLocatedThreadId = next.id;
      setActiveThread(next.id);
      try {
        const editor = getEditorForThread(next) || activeEditor || getSourceEditorForCommentsPanel();
        revealThreadAnchor(next, { focus: false, editor, smooth: false });
      } catch {}
      schedule({ force: true });
    };

    const header = document.createElement("div");
    header.className = "zion-comments-header";
    const filterChip = (kind, label) => `<button class="zion-comments-filter-chip${filterKind === kind ? " is-active" : ""}" data-filter="${kind}" type="button">${escapeHtml(label)}</button>`;
    const historyItems = allThreads.map((item) => {
      const anchor = anchorById.get(item.id);
      const status = item.resolved ? "resolved" : !anchor ? "lost" : getThreadRunStatus(item);
      const dotClass = status === "resolved" ? "is-resolved" : status === "lost" ? "is-lost" : `is-${status}`;
      const lineText = anchor ? `L${anchor.startLine + 1}${anchor.endLine > anchor.startLine ? `-${anchor.endLine + 1}` : ""}` : t("threadStatus.lost", "Anchor missing");
      const title = compactText(item.title || item.quote || item.anchorText || t("row.fallback", "Comment"), 64);
      return `
        <button class="zion-comments-popover-item" data-thread-id="${escapeHtml(item.id)}" type="button">
          <span class="zion-comments-popover-dot ${dotClass}"></span>
          <span class="zion-comments-popover-item-text">
            <span class="zion-comments-popover-item-title">${escapeHtml(title)}</span>
            <span class="zion-comments-popover-item-meta">${escapeHtml(`${lineText} · ${threadRunStatusTitle(status)}`)}</span>
          </span>
        </button>`;
    }).join("");
    header.innerHTML = `
      <div class="zion-comments-header-left">
        <button class="zion-comments-hdr-btn js-comments-history${historyVisible ? " is-active" : ""}" type="button" title="${escapeHtml(t("title", "Comments"))}">
          ${iconSvg("history")}
        </button>
        <button class="zion-comments-hdr-btn js-comments-prev" type="button" title="${escapeHtml(t("nav.previous", "Previous comment"))}"${filteredThreads.length ? "" : " disabled"}>
          ${iconSvg("previous")}
        </button>
        <button class="zion-comments-hdr-btn js-comments-next" type="button" title="${escapeHtml(t("nav.next", "Next comment"))}"${filteredThreads.length ? "" : " disabled"}>
          ${iconSvg("next")}
        </button>
        <span class="zion-comments-count${openCount ? " is-open" : ""}" title="${escapeHtml(t("stats.open", "{count} open", { count: openCount }))}">${escapeHtml(String(openCount))}</span>
      </div>
      <div class="zion-comments-header-right">
        <button class="zion-comments-hdr-btn js-comments-filter${filterVisible ? " is-active" : ""}" type="button" title="${escapeHtml(t("stats.open", "{count} open", { count: openCount }))}">
          ${iconSvg("search")}
        </button>
        <button class="zion-comments-hdr-btn js-comments-collapse-all" type="button" title="${escapeHtml(t("thread.collapse", "Collapse editor"))}">
          ${iconSvg("fold")}
        </button>
        <button class="zion-comments-hdr-btn js-comments-expand-all" type="button" title="${escapeHtml(t("thread.expand", "Expand editor"))}">
          ${iconSvg("unfold")}
        </button>
      </div>
      <div class="zion-comments-filter${filterVisible ? " is-visible" : ""}">
        ${filterChip("all", "全部")}
        ${filterChip("open", "未解决")}
        ${filterChip("resolved", "已解决")}
        ${filterChip("lost", "锚点丢失")}
      </div>`;
    root.appendChild(header);
    const popover = document.createElement("div");
    popover.className = `zion-comments-popover${historyVisible ? " is-visible" : ""}`;
    popover.innerHTML = `
      <div class="zion-comments-popover-head">
        <span>${escapeHtml(t("header.subtitle", "Anchored comments in the source document"))}</span>
        <span>${escapeHtml(`${allThreads.length}`)}</span>
      </div>
      ${historyItems || `<div class="zion-comments-popover-empty">${escapeHtml(t("empty.title", "No comment threads yet"))}</div>`}`;
    header.appendChild(popover);
    header.querySelector(".js-comments-history")?.addEventListener("click", (event) => {
      event.stopPropagation();
      historyVisible = !historyVisible;
      filterVisible = false;
      schedule({ force: true });
    });
    header.querySelector(".js-comments-filter")?.addEventListener("click", (event) => {
      event.stopPropagation();
      filterVisible = !filterVisible;
      historyVisible = false;
      schedule({ force: true });
    });
    header.querySelector(".js-comments-prev")?.addEventListener("click", (event) => {
      event.stopPropagation();
      resumePanelSourceFollow("nav-previous");
      navigateThread(-1);
    });
    header.querySelector(".js-comments-next")?.addEventListener("click", (event) => {
      event.stopPropagation();
      resumePanelSourceFollow("nav-next");
      navigateThread(1);
    });
    header.querySelector(".js-comments-collapse-all")?.addEventListener("click", (event) => {
      event.stopPropagation();
      expandedThreadIds.clear();
      schedule({ force: true });
    });
    header.querySelector(".js-comments-expand-all")?.addEventListener("click", (event) => {
      event.stopPropagation();
      for (const item of filteredThreads) expandedThreadIds.add(item.id);
      schedule({ force: true });
    });
    header.querySelectorAll(".zion-comments-filter-chip").forEach((chip) => {
      chip.addEventListener("click", (event) => {
        event.stopPropagation();
        filterKind = String(chip.dataset.filter || "all");
        schedule({ force: true });
      });
    });
    header.querySelectorAll(".zion-comments-popover-item[data-thread-id]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const id = String(button.dataset.threadId || "");
        historyVisible = false;
        resumePanelSourceFollow("history-item", { threadId: id });
        setActiveThread(id);
        pendingRevealThreadId = id;
        pendingLocatedThreadId = id;
        schedule({ force: true });
      });
    });

    const body = document.createElement("div");
    body.className = "zion-comments-body";
    root.appendChild(body);

    const list = document.createElement("div");
    list.className = "zion-comments-list";
    const markListScrollIntent = () => {
      markCommentUserScrollIntent(list, 900);
      programmaticListScrollUntil = 0;
    };
    const markListKeyScrollIntent = (event) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        markListScrollIntent();
      }
    };
    list.addEventListener("wheel", markListScrollIntent, { passive: true });
    list.addEventListener("touchstart", markListScrollIntent, { passive: true });
    list.addEventListener("keydown", markListKeyScrollIntent, true);
    list.addEventListener("pointerdown", (event) => {
      try {
        const rect = list.getBoundingClientRect();
        if (event.clientX >= rect.right - 16) markListScrollIntent();
      } catch {}
    }, { passive: true });
    list.onscroll = () => {
      const nextTop = Number(list.scrollTop) || 0;
      listScrollTop = nextTop;
      const programmaticUntil = Math.max(
        Number(programmaticListScrollUntil) || 0,
        Number(list.__zionProgrammaticScrollUntil) || 0
      );
      const hasUserIntent = Date.now() <= Number(list.__zionUserScrollIntentUntil || 0);
      const scrollDelta = Math.abs(nextTop - lastUserListScrollTop);
      const looksLikeProgrammaticJump = scrollDelta > Math.max(80, (list.clientHeight || 0) * 0.25);
      if (hasUserIntent && !looksLikeProgrammaticJump && Date.now() > programmaticUntil && scrollDelta >= 2) {
        pausePanelSourceFollow("comment-panel-scroll", {
          beforeScrollTop: Math.round(lastUserListScrollTop),
          afterScrollTop: Math.round(nextTop)
        });
        detachCommentRunTailFollow("comment-panel-scroll", {
          beforeScrollTop: Math.round(lastUserListScrollTop),
          afterScrollTop: Math.round(nextTop)
        });
      } else if (looksLikeProgrammaticJump) {
        debugCommentScrollJitter("F", "commentPanelScroll.ignoredLargeDelta", {
          beforeScrollTop: Math.round(lastUserListScrollTop),
          afterScrollTop: Math.round(nextTop),
          scrollDelta: Math.round(scrollDelta),
          hasUserIntent,
          programmaticRemainingMs: Math.max(0, Math.round(programmaticUntil - Date.now()))
        });
      }
      lastUserListScrollTop = nextTop;
    };
    body.appendChild(list);
    if (!allThreads.length) {
      const empty = document.createElement("div");
      empty.className = "zion-comments-empty";
      empty.innerHTML = `<div class="zion-comments-empty-title">${escapeHtml(t("empty.title", "No comment threads yet"))}</div><div>${escapeHtml(t("empty.description", "Select text and click Comment in the toolbar to start an anchored discussion."))}</div>`;
      list.appendChild(empty);
      }
    if (allThreads.length && !filteredThreads.length) {
      const empty = document.createElement("div");
      empty.className = "zion-comments-empty";
      empty.innerHTML = `<div class="zion-comments-empty-title">${escapeHtml(t("empty.title", "No comment threads yet"))}</div><div>${escapeHtml(t("header.subtitle", "Anchored comments in the source document"))}</div>`;
      list.appendChild(empty);
    }
    for (const item of filteredThreads) {
      const anchor = anchorById.get(item.id);
        const status = item.resolved ? "resolved" : !anchor ? "lost" : "open";
      const isActive = item.id === active?.id;
        const isSynced = item.id === syncedThreadId;
        if (pendingExpandThreadId === item.id) {
          expandedThreadIds.add(item.id);
          pendingExpandThreadId = "";
        }
        const isExpanded = expandedThreadIds.has(item.id);
      const row = document.createElement("article");
      row.dataset.threadId = item.id;
        row.className = `zion-comments-row zion-comments-card is-${status}${isActive ? " is-active" : ""}${isSynced ? " is-synced" : ""}${isExpanded ? " is-expanded" : ""}${item.resolved ? " is-resolved" : ""}${!anchor ? " is-orphan" : ""}`;
        let lastItemRevealAt = 0;
        const revealSourceFromItem = (event) => {
          const shouldReveal = shouldRevealSourceFromCommentItemPointer(event, isExpanded);
          if (!shouldReveal) return;
          const nowTs = Date.now();
          if (nowTs - lastItemRevealAt < 80) return;
          lastItemRevealAt = nowTs;
          resumePanelSourceFollow("comment-item-reveal-source", { threadId: item.id });
          suppressPanelSyncUntil = Date.now() + 280;
          focusEditorSource(item, { reveal: true });
          requestAnimationFrame(() => {
            const sourceEditor = getEditorForThread(item);
            revealThreadAnchor(item, { focus: true, editor: sourceEditor, smooth: false });
          });
        };
        row.addEventListener("pointerdown", (event) => {
          revealSourceFromItem(event);
          suppressNextActiveRender = true;
          setActiveThread(item.id);
          updateActiveThreadClasses(item.id);
        });
          row.addEventListener("focusin", () => {
            setActiveThread(item.id);
            updateActiveThreadClasses(item.id);
          });
        row.addEventListener("click", revealSourceFromItem);
      list.appendChild(row);

        const activeAnchor = anchor || (activeView ? locateThreadAnchor(activeView, item) : null);

        const detail = document.createElement("div");
        detail.className = "zion-comments-detail";
        row.appendChild(detail);

        const editorFrame = document.createElement("div");
        editorFrame.className = "zion-comments-editor-frame";
        detail.appendChild(editorFrame);

        const editorHeader = document.createElement("div");
        editorHeader.className = "zion-comments-editor-header";
        editorFrame.appendChild(editorHeader);

          const quote = document.createElement("div");
        quote.className = `zion-comments-quote${!activeAnchor ? " is-orphan" : ""}`;
          quote.title = t("thread.revealSource", "Reveal source");
        quote.innerHTML = `
          ${renderThreadStatusDot(item)}
            <button type="button" class="zion-comments-quote-toggle" aria-label="${escapeHtml(isExpanded ? t("thread.collapse", "Collapse editor") : t("thread.expand", "Expand editor"))}" title="${escapeHtml(isExpanded ? t("thread.collapse", "Collapse editor") : t("thread.expand", "Expand editor"))}">${iconSvg("chevron")}</button>
          ${renderCommentStateBadge(status)}
          <span class="zion-comments-quote-text">${escapeHtml(compactText(item.quote || item.anchorText || "", 160))}</span>`;
        editorHeader.appendChild(quote);

        const actions = document.createElement("div");
        actions.className = "zion-comments-actions";
        editorHeader.appendChild(actions);
        let threadEditorHandle = null;
          const expandThread = () => {
            if (expandedThreadIds.has(item.id)) return;
            expandedThreadIds.add(item.id);
            setActiveThread(item.id);
            schedule({ force: true });
          };
          const collapseThread = () => {
            if (!expandedThreadIds.has(item.id)) return;
            expandedThreadIds.delete(item.id);
            setActiveThread(item.id);
            schedule({ force: true });
          };
            const quoteToggle = quote.querySelector(".zion-comments-quote-toggle");
            quoteToggle?.addEventListener("pointerdown", (event) => {
              try { event.stopPropagation(); } catch {}
            });
            quoteToggle?.addEventListener("click", (event) => {
            try { event.stopPropagation(); } catch {}
            if (isExpanded) collapseThread();
            else expandThread();
            });
        const runAction = makeAction("play", () => {
            if (!isExpanded) {
              expandThread();
              return;
            }
          if (isThreadStreaming(item)) stopThread(item);
          else {
            pausePanelSourceFollow("comment-run", { threadId: item.id, sessionId: getThreadSessionId(item) });
            runThread(item, threadEditorHandle);
          }
        }, "primary", t("run.start", "Start Chat"));
        const updateRunAction = () => {
          const streaming = isThreadStreaming(item);
          runAction.innerHTML = iconSvg(streaming ? "stop" : "play");
          runAction.title = streaming ? t("run.stop", "Stop Answer") : t("run.start", "Start Chat");
          runAction.setAttribute("aria-label", runAction.title);
          runAction.className = `zion-comments-action ${streaming ? "danger" : "primary"}`;
        };
        updateRunAction();
        updateRunActions.set(item.id, updateRunAction);
        actions.appendChild(runAction);
        actions.appendChild(makeAction(item.resolved ? "undo" : "check", () => {
          patchThread(item.id, { resolved: !item.resolved });
          setActiveThread(item.id);
        }, "", item.resolved ? t("thread.reopen", "Reopen comment") : t("thread.resolve", "Mark as resolved")));
        actions.appendChild(makeAction("external", () => promoteThread(item, threadEditorHandle), "", t("thread.promote", "Promote to standalone session")));

        const editorHost = document.createElement("div");
        editorHost.className = "zion-comments-editor";
        editorFrame.appendChild(editorHost);
          const editorThread = applyThreadPayload(item, threadPayloadCache.get(String(item?.id || "")));
          if (isExpanded) {
            threadEditorHandle = createThreadEditor(editorHost, editorThread, (bodyText) => {
              patchThread(item.id, { body: bodyText }, { silent: true });
            }, (handle) => runThread(item, handle), () => {
              alignCommentRowsToAnchors(list, activeView, threads, anchorById, "expanded-editor-layout");
              updateCommentListScrollRange(list, activeView, "expanded-editor-layout-range");
            }, (reason, data = {}) => {
              pausePanelSourceFollow(reason, { threadId: item.id, sessionId: getThreadSessionId(item), ...data });
              if (reason === "comment-thread-scroll") {
                detachCommentRunTailFollow(reason, { threadId: item.id, sessionId: getThreadSessionId(item), ...data });
              }
            });
          } else {
            editorHost.tabIndex = 0;
            editorHost.setAttribute("role", "button");
            editorHost.setAttribute("aria-label", t("thread.expand", "Expand editor"));
            const renderFoldedSummary = (sourceThread) => {
              const summaryText = getThreadSummaryText(sourceThread, item.quote || item.anchorText || "");
              const latestAt = getThreadLatestAt(sourceThread);
              const latestText = formatCompactTime(latestAt);
              const latestTitle = formatThreadTimeTitle(latestAt);
              const updatedLabel = latestText
                ? t("threadMeta.updated", "Updated {time}", { time: latestText }).replace("{time}", latestText)
                : "";
              editorHost.innerHTML = `
                <div class="zion-comments-summary${summaryText ? "" : " is-empty"}">
                  ${escapeHtml(summaryText || t("thread.emptySummary", "No comment yet. Expand to start the conversation."))}
                </div>
                ${updatedLabel ? `<div class="zion-comments-summary-meta" title="${escapeHtml(latestTitle)}">${escapeHtml(updatedLabel)}</div>` : ""}`;
            };
            renderFoldedSummary(editorThread);
            editorHost.addEventListener("dblclick", (event) => {
              try { event.preventDefault(); } catch {}
              expandThread();
            });
            editorHost.addEventListener("keydown", (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              try { event.preventDefault(); } catch {}
              expandThread();
            });
              loadThreadPayload(item).then((payload) => {
                if (!payload || typeof payload !== "object" || expandedThreadIds.has(item.id)) return;
                renderFoldedSummary(applyThreadPayload(item, payload));
                requestAnimationFrame(() => {
                  alignCommentRowsToAnchors(list, activeView, threads, anchorById, "folded-summary-payload");
                  updateCommentListScrollRange(list, activeView, "folded-summary-payload-range");
                });
            });
          }
        editorHandles.set(item.id, threadEditorHandle);
        setEditorFrameExpanded(row, editorFrame, threadEditorHandle, isExpanded);
          if (isExpanded && (!lastCommentsEditorHandle || isActive)) lastCommentsEditorHandle = threadEditorHandle;
        try {
          const annotations = hydrateThreadAnnotations(item);
            if (isExpanded && (annotations.tools.length || annotations.thinking.length)) {
            requestAnimationFrame(() => requestAnimationFrame(() => {
              restoreSessionAnnotations(threadEditorHandle?.sessionId, threadEditorHandle?.panelId, annotations);
            }));
          }
        } catch {}
          if (isExpanded && pendingFocusThreadId === item.id) {
          pendingFocusThreadId = "";
          try {
            requestAnimationFrame(() => {
              try {
                threadEditorHandle?.proxy?.focus?.();
                threadEditorHandle?.view?.focus?.();
              } catch {}
            });
          } catch {}
      }
    }
      alignCommentRowsToAnchors(list, activeView, threads, anchorById, "render");
      updateCommentListScrollRange(list, activeView, "render-range");
        // #region debug-point D:render-restore
        debugCommentScrollJitter("D", "render.restore", {
          beforeScrollTop: Math.round(Number(list.scrollTop) || 0),
          restoreTo: Math.round(Number(listScrollTop) || 0),
          sourceScrollTop: Math.round(Number(activeView?.scrollDOM?.scrollTop) || 0),
          pendingRevealThreadId,
          pendingLocatedThreadId,
          lastRenderedSessionId
        });
        // #endregion
      markProgrammaticListScroll(180);
      list.scrollTop = listScrollTop;
      lastUserListScrollTop = Number(list.scrollTop) || 0;
    const finalLayoutAlignId = String(pendingRevealThreadId || pendingLocatedThreadId || "");
    if (pendingRevealThreadId) {
      const revealId = pendingRevealThreadId;
      pendingRevealThreadId = "";
      try {
        requestAnimationFrame(() => {
          try {
            const row = list.querySelector(`.zion-comments-row[data-thread-id="${cssEscape(revealId)}"]`);
            if (pendingLocatedThreadId === revealId) {
              if (pulseLocatedThread(revealId)) {
                pendingLocatedThreadId = "";
                return;
              }
            }
            row?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
          } catch {}
        });
      } catch {}
    }
    if (pendingLocatedThreadId) {
      const locatedId = pendingLocatedThreadId;
      try {
        requestAnimationFrame(() => {
          if (pulseLocatedThread(locatedId)) pendingLocatedThreadId = "";
        });
      } catch {}
    }
      requestAnimationFrame(() => {
        alignCommentRowsToAnchors(list, activeView, threads, anchorById, "render-frame");
        updateCommentListScrollRange(list, activeView, "render-frame-range");
        syncListToSourceViewport();
        if (finalLayoutAlignId) {
          requestAnimationFrame(() => {
            try {
              pulseLocatedThread(finalLayoutAlignId);
            } catch {}
          });
        }
      });

  }

    function syncListToSourceViewport() {
      try {
        if (disposed) return;
        const list = root.querySelector(".zion-comments-list");
        if (!list) return;
        if (pendingRevealThreadId || pendingLocatedThreadId) {
            // #region debug-point D:sync-pending-target
            debugCommentScrollJitter("D", "sync.pendingTarget", {
              listScrollTop: Math.round(Number(list.scrollTop) || 0),
              pendingRevealThreadId,
              pendingLocatedThreadId
            });
            // #endregion
          listScrollTop = list.scrollTop;
          lastUserListScrollTop = Number(list.scrollTop) || 0;
          return;
        }
        if (Date.now() < suppressPanelSyncUntil) {
            // #region debug-point D:sync-suppressed
            debugCommentScrollJitter("D", "sync.suppressed", {
              listScrollTop: Math.round(Number(list.scrollTop) || 0),
              suppressRemainingMs: Math.max(0, Math.round(suppressPanelSyncUntil - Date.now()))
            });
            // #endregion
          listScrollTop = list.scrollTop;
          lastUserListScrollTop = Number(list.scrollTop) || 0;
          return;
        }
        if (!panelFollowsSourceScroll) {
            // #region debug-point F:sync-paused
            debugCommentScrollJitter("F", "sync.paused", {
              listScrollTop: Math.round(Number(list.scrollTop) || 0),
              sourceScrollTop: Math.round(Number(getSourceEditorForCommentsPanel()?.getView?.()?.scrollDOM?.scrollTop) || 0),
              syncedThreadId,
              lastRenderedSessionId
            });
            // #endregion
          listScrollTop = list.scrollTop;
          lastUserListScrollTop = Number(list.scrollTop) || 0;
          return;
        }
        const activeEditor = getSourceEditorForCommentsPanel();
        const activeView = activeEditor?.getView?.();
        const sessionId = getSourceSessionIdForCommentsPanel(activeEditor);
        if (!activeView || String(sessionId || "") !== String(lastRenderedSessionId || "")) {
          return;
        }
        let threads = getThreadsForSession(sessionId);
        const anchorById = new Map();
        for (const item of threads) anchorById.set(item.id, locateThreadAnchor(activeView, item));
        threads = sortThreadsByDocumentOrder(threads, anchorById);
        alignCommentRowsToAnchors(list, activeView, threads, anchorById, "sync-before");
        updateCommentListScrollRange(list, activeView, "sync-range");
        const nextId = pickThreadForViewport(activeView, threads, anchorById);
        const previous = syncedThreadId;
          if (previous && nextId && previous !== nextId) {
          list.querySelector(`.zion-comments-row[data-thread-id="${cssEscape(previous)}"]`)?.classList?.remove?.("is-synced");
        }
          syncedThreadId = nextId || previous;
        const sourceScrollTop = Number(activeView?.scrollDOM?.scrollTop);
        if (Number.isFinite(sourceScrollTop)) {
            const beforeScrollTop = Number(list.scrollTop) || 0;
            const sourceDelta = Number.isFinite(lastSourceSyncScrollTop) ? sourceScrollTop - lastSourceSyncScrollTop : 0;
            const maxScrollTop = Math.max(0, (Number(list.scrollHeight) || 0) - (Number(list.clientHeight) || 0));
              const useDeltaFollow = Number.isFinite(lastSourceSyncScrollTop) && (!nextId || (!!previous && previous === nextId));
              const effectiveThread = syncedThreadId ? threads.find((item) => item?.id === syncedThreadId) : null;
              const effectiveSessionId = effectiveThread ? getThreadSessionId(effectiveThread) : "";
            const nextScrollTop = useDeltaFollow
              ? Math.max(0, Math.min(maxScrollTop, beforeScrollTop + sourceDelta))
              : Math.max(0, Math.min(maxScrollTop, sourceScrollTop));
            // #region debug-point B:sync-write
            debugCommentScrollJitter("B", "sync.write", {
              nextId,
              beforeScrollTop: Math.round(beforeScrollTop),
              nextScrollTop: Math.round(nextScrollTop),
              sourceScrollTop: Math.round(sourceScrollTop),
              sourceDelta: Math.round(sourceDelta),
              mode: useDeltaFollow ? "delta" : "absolute",
              previousSyncedThreadId: previous,
                effectiveSyncedThreadId: syncedThreadId,
                effectiveSessionId,
                tailDetached: effectiveSessionId ? detachedCommentTailFollowSessions.has(effectiveSessionId) : false,
              lastRenderedSessionId
            });
            // #endregion
            markProgrammaticListScroll(180);
            list.scrollTop = nextScrollTop;
            lastUserListScrollTop = Number(list.scrollTop) || 0;
            lastSourceSyncScrollTop = sourceScrollTop;
        }
        if (!nextId) {
          listScrollTop = list.scrollTop;
          return;
        }
        const row = list.querySelector(`.zion-comments-row[data-thread-id="${cssEscape(nextId)}"]`);
        if (!row) return;
        row.classList.add("is-synced");
        listScrollTop = list.scrollTop;
        const anchor = anchorById.get(nextId);
        const anchorTop = anchor ? getCommentAnchorTop(activeView, anchor, 0) : null;
        reportCommentLayoutDebug("sync-after", {
          threadId: nextId,
          sourceScrollTop: Math.round(sourceScrollTop || 0),
          listScrollTop: Math.round(Number(list.scrollTop) || 0),
          anchorTop,
          rowOffsetTop: Math.round(Number(row.offsetTop) || 0),
          visibleDelta: Math.round((row.getBoundingClientRect?.().top || 0) - (list.getBoundingClientRect?.().top || 0))
        });
      } catch {}
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

function shouldRevealSourceFromCommentItemPointer(event, expanded) {
  try {
    const target = event?.target;
    if (!target) return true;
      if (target.closest?.(".zion-comments-quote-toggle")) return false;
    if (target.closest?.("button, a, input, textarea, select, [data-no-comment-reveal]")) return false;
      if (target.closest?.(".zion-comments-quote")) return true;
    if (expanded && target.closest?.(".cm-editor")) return false;
    return true;
  } catch {
    return true;
  }
}

  function setEditorFrameExpanded(row, frame, handle, expanded) {
    try {
      row?.classList?.toggle?.("is-expanded", !!expanded);
      if (!frame) return;
      frame.style.height = "";
      try { handle?.view?.requestMeasure?.(); } catch {}
    } catch {}
  }

function iconSvg(name) {
  const map = {
    play: "play",
    stop: "debug-stop",
    check: "check",
    undo: "discard",
    expand: "screen-full",
    collapse: "screen-normal",
    external: "arrow-up-right",
    trash: "trash",
    history: "history",
    search: "search",
    fold: "fold-vertical",
    unfold: "unfold-vertical",
    previous: "chevron-up",
    next: "chevron-down",
    chevron: "chevron-right"
  };
  const codicon = map[name] || "play";
  try {
    const html = window.zionIcons?.htmlFromCodicon?.(codicon);
    if (html) return html;
  } catch {}
  return `<span class="codicon codicon-${codicon}" aria-hidden="true"></span>`;
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
    view.dispatch({ selection: { anchor: anchor.from }, scrollIntoView: true });
    try {
      const scroller = view.scrollDOM;
      const block = view.lineBlockAt?.(anchor.from);
      if (scroller && block && Number.isFinite(Number(block.top))) {
        const targetTop = Math.max(0, Number(block.top) - Math.max(24, Math.floor((scroller.clientHeight || 0) * 0.22)));
        scroller.scrollTo?.({ top: targetTop, behavior: opts.smooth === false ? "auto" : "smooth" });
      }
    } catch {}
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

function getLiveThreadBodyForSession(sessionId) {
  const sid = String(sessionId || "");
  if (!sid) return null;
  try {
    const handle = lastCommentsEditorHandle;
    if (handle?.sessionId === sid && handle?.view?.state?.doc) {
      return handle.view.state.doc.toString();
    }
  } catch {}
  return null;
}

function persistThreadAnnotations(threadOrSessionId, annotations = null) {
  const sessionId = typeof threadOrSessionId === "string" ? threadOrSessionId : getThreadSessionId(threadOrSessionId);
  if (!sessionId) return null;
  const thread = typeof threadOrSessionId === "string"
    ? readAllThreads().find((item) => getThreadSessionId(item) === sessionId)
    : threadOrSessionId;
  if (!thread?.id) return null;
  const nextAnnotations = normalizeThreadAnnotations(annotations || getSessionAnnotations(sessionId));
  const patch = {
    threadSessionId: sessionId,
    chatAnnotations: nextAnnotations
  };
  const liveBody = getLiveThreadBodyForSession(sessionId);
  if (typeof liveBody === "string" && liveBody !== String(thread?.body ?? "")) patch.body = liveBody;
  patchThread(thread.id, patch, { silent: true });
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
  if (!hasCards && thread?.id) loadThreadPayload(thread, { emitChanged: true });
  if (!sessionId || !hasCards) return annotations;
  setSessionAnnotations(sessionId, annotations);
  return annotations;
}

async function migrateLegacyThreadPayloadStorage() {
  const storedThreads = readStoredThreadsRaw();
  if (!storedThreads.length) return;
  const legacyThreads = storedThreads.filter((thread) => hasStoredThreadPayload(extractThreadPayload(thread)));
  if (!legacyThreads.length) return;
  for (const thread of legacyThreads) {
    try { await persistThreadPayload(thread); } catch {}
  }
  writeAllThreads(storedThreads, { silent: true, compactionModes: ["default", "aggressive", "minimal"] });
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
      const title = t("thread.promotedTitle", "Comment: {title}", { title: compactText(thread.title || thread.quote || thread.anchorText || thread.id, 48) });
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

const summarizeInflight = new Set();
const titleInflight = new Set();

function parseTitlePayload(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const withoutFence = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const tryParse = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      const title = parsed && typeof parsed === "object" ? (parsed.title ?? parsed.name) : "";
      return typeof title === "string" ? title : "";
    } catch {
      return "";
    }
  };
  const direct = tryParse(withoutFence);
  if (direct) return direct;
  const match = withoutFence.match(/\{[\s\S]*?\}/);
  return match ? tryParse(match[0]) : "";
}

function cleanThreadTitle(raw) {
  let title = parseTitlePayload(raw);
  if (!title) title = String(raw || "").split("\n").find((line) => String(line || "").trim()) || "";
  title = title.replace(/^\s*(title|comment title|thread title|name)\s*[:：]\s*/i, "");
  title = title.replace(/^\s*(标题|评论标题|评论名|会话名)\s*[:：]\s*/i, "");
  title = title.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "");
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/^[\-–—:：#*]+/, "").replace(/[\-–—:：#*。.!！?？]+$/, "").trim();
  if (!title) return "";
  if (Array.from(title).length > 36) return "";
  if (/^(当然|可以|好的|首先|其次|以下|这里|这是|这个问题|答案|建议|Sure|Certainly|Here|You can|To )/i.test(title)) return "";
  return title;
}

async function autoRenameThreadTitle(thread, transcriptText) {
  const id = String(thread?.id || "");
  if (!id) return;
  if (titleInflight.has(id)) return;
  const latestBefore = readAllThreads().find((item) => item?.id === id) || thread;
  if (latestBefore?.titleAuto === false) return;
  const transcript = String(transcriptText || "").trim();
  if (!transcript) return;
  const runStream = window.zion?.llm?.runStream;
  if (typeof runStream !== "function") return;

  titleInflight.add(id);
  try {
    const anchorText = String(thread?.anchorText || thread?.quote || "").slice(0, 600);
    const excerpt = transcript.length > 6000 ? transcript.slice(-6000) : transcript;
    const messages = [
      {
        role: "system",
        content: [
          "你是评论线程标题生成器，不是聊天助手。",
          "任务：只根据评论线程里的讨论和回答，生成一个短标题。",
          "禁止：不要回答问题，不要给建议，不要解释，不要复述被评论原文。",
          "标题要求：2-18 个中文字符或 2-8 个英文单词；短、具体、像列表项标题；不要引号；不要句号。",
          "必须只输出一行严格 JSON，格式为：{\"title\":\"评论标题\"}"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          "为下面的评论线程生成标题。",
          "再次强调：不要直接用被评论内容作为标题，优先概括评论里实际讨论/回答的主题。",
          "",
          "被评论内容：",
          anchorText || "（无）",
          "",
          "评论线程内容：",
          "<conversation>",
          excerpt,
          "</conversation>"
        ].join("\n")
      }
    ];

    let out = "";
    let err = null;
    await runStream({
      messages,
      tools: null,
      onToken: (tk) => { out += String(tk || ""); },
      onEnd: () => {},
      onError: (e) => { err = e || new Error("LLM error"); },
      runId: `comments-title-${id}-${Date.now()}`,
      sessionId: getThreadSessionId(thread),
      silentReasoning: true
    });
    if (err) throw err;

    const title = cleanThreadTitle(out);
    if (!title) return;
    const latest = readAllThreads().find((item) => item?.id === id) || thread;
    if (latest?.titleAuto === false) return;
    patchThread(id, { title, titleAuto: true, titleUpdatedAt: now() });
  } catch {
    // 自动标题是尽力而为的增强，失败不影响评论会话。
  } finally {
    titleInflight.delete(id);
  }
}

function collectUpstreamCommentSummaries(editor) {
  try {
    if (!editor || isCommentPanelId(editor?.panelId)) return [];
    const view = editor?.getView?.();
    if (!view?.state?.doc) return [];
    const sessionId = String(getSessionId(editor) || "");
    if (!sessionId) return [];

    const cursorPos = (() => {
      try {
        const sel = view.state.selection?.main;
        if (typeof sel?.from === "number") return sel.from;
      } catch {}
      return view.state.doc.length;
    })();

    const threads = getThreadsForSession(sessionId).filter((thread) => {
      const summary = typeof thread?.summary === "string" ? thread.summary.trim() : "";
      return !!summary;
    });
    if (!threads.length) return [];

    const entries = [];
    for (const thread of threads) {
      const anchor = locateThreadAnchor(view, thread);
      const anchorFrom = typeof anchor?.from === "number" ? anchor.from : Number(thread?.from);
      const anchorTo = typeof anchor?.to === "number" ? anchor.to : Number(thread?.to);
      if (!Number.isFinite(anchorFrom)) continue;
      if (!Number.isFinite(anchorTo)) continue;
      if (anchorTo > cursorPos) continue;
      const anchorText = String(thread?.anchorText || thread?.quote || "");
      entries.push({
        anchorFrom,
        anchorTo,
        anchorText,
        summary: String(thread.summary || "").trim()
      });
    }
    entries.sort((a, b) => a.anchorTo - b.anchorTo);
    return entries;
  } catch {
    return [];
  }
}

function buildCommentSummaryMessage(entry) {
  const label = String(entry?.anchorText || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const quoted = label ? `“${label}”` : "上方某处内容";
  return {
    role: "user",
    content: [
      "【评论上下文】",
      `被评论内容：${quoted}`,
      `评论总结：${entry?.summary || ""}`,
      "这是一条插入到被评论 message 下方的上下文备注，请在后续回答中作为已知背景纳入。"
    ].join("\n")
  };
}

function isCommentSummaryMessage(message) {
  return String(messageContentText(message) || "").trim().startsWith("【评论上下文】");
}

function messageContentText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part?.type === "text" ? String(part.text || "") : "")).join("\n");
  }
  return "";
}

function buildTranscriptMessageSpans(view, cursorPos) {
  try {
    const doc = view?.state?.doc;
    if (!doc) return [];
    const to = Math.max(0, Math.min(doc.length, Number(cursorPos) || doc.length));
    const text = view.state.sliceDoc(0, to);
    const lines = String(text || "").split("\n");
    const roleRe = /^(system|user|assistant)\s+(.*)$/;
    const widgetRe = /^(思考|Thinking)\s*<!--\s*zion-thinking:id=[^>\s]+\s*-->\s*$/i;
    const toolWidgetRe = /^(?:调用|Call)\s+[^\n<]+(?:\s*<!--\s*zion-tool:id=[^>\s]+\s*-->)?\s*$/i;
    const imageRe = /^!\[.*\]\((.*)\)$/;
    const spans = [];
    let role = "user";
    let content = [];
    let spanFrom = 0;
    let spanTo = 0;
    let offset = 0;

    const flush = () => {
      const normalized = content.join("\n").trim();
      if (!normalized) return;
      spans.push({ role, content: normalized, from: spanFrom, to: spanTo });
    };

    for (const line of lines) {
      const lineStart = offset;
      const lineEnd = lineStart + line.length;
      const roleMatch = line.match(roleRe);
      const trimmed = line.trim();
      if (widgetRe.test(trimmed) || toolWidgetRe.test(trimmed)) {
        offset = lineEnd + 1;
        continue;
      }

      if (roleMatch) {
        const body = roleMatch[2] || "";
        if (widgetRe.test(body.trim()) || toolWidgetRe.test(body.trim())) {
          offset = lineEnd + 1;
          continue;
        }
        flush();
        role = roleMatch[1];
        content = body.trim() ? [body] : [];
        spanFrom = lineStart;
        spanTo = lineEnd;
        offset = lineEnd + 1;
        continue;
      }

      if (!imageRe.test(line)) content.push(line);
      spanTo = lineEnd;
      offset = lineEnd + 1;
    }
    flush();
    return spans;
  } catch {
    return [];
  }
}

function insertCommentSummariesIntoMessages(messages, editor) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const baseMessages = messages.filter((m) => !isCommentSummaryMessage(m));
  const entries = collectUpstreamCommentSummaries(editor);
  if (!entries.length) return baseMessages.length === messages.length ? messages : baseMessages;

  const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const normalizedMsgs = baseMessages.map((m) => normalize(messageContentText(m)));
  const view = editor?.getView?.();
  const cursorPos = (() => {
    try {
      const sel = view?.state?.selection?.main;
      if (typeof sel?.from === "number") return sel.from;
    } catch {}
    return view?.state?.doc?.length || 0;
  })();
  const spans = buildTranscriptMessageSpans(view, cursorPos);

  const insertAfter = new Map();
  const unmatched = [];

  for (const entry of entries) {
    const anchorFrom = Number(entry.anchorFrom);
    const anchorTo = Number(entry.anchorTo);
    const span = spans.find((item) => {
      if (!Number.isFinite(anchorFrom) || !Number.isFinite(anchorTo)) return false;
      return item.from <= anchorTo && item.to >= anchorFrom;
    });
    const spanText = normalize(span?.content || "");
    const firstLine = String(entry.anchorText || "").split("\n").find((l) => l.trim()) || entry.anchorText || "";
    const snippet = normalize(firstLine).slice(0, 120);
    let target = -1;
    if (spanText) {
      for (let i = 0; i < normalizedMsgs.length; i++) {
        if (normalizedMsgs[i] && (normalizedMsgs[i] === spanText || normalizedMsgs[i].includes(spanText) || spanText.includes(normalizedMsgs[i]))) {
          target = i;
          break;
        }
      }
    }
    if (target < 0 && snippet) {
      for (let i = 0; i < normalizedMsgs.length; i++) {
        if (normalizedMsgs[i] && normalizedMsgs[i].includes(snippet)) {
          target = i;
          break;
        }
      }
    }
    const summaryMsg = buildCommentSummaryMessage(entry);
    if (target >= 0) {
      if (!insertAfter.has(target)) insertAfter.set(target, []);
      insertAfter.get(target).push(summaryMsg);
    } else {
      unmatched.push(summaryMsg);
    }
  }

  if (insertAfter.size === 0 && !unmatched.length) return messages;

  const out = [];
  const lastIndex = baseMessages.length - 1;
  for (let i = 0; i < baseMessages.length; i++) {
    if (unmatched.length && i === lastIndex) {
      out.push(...unmatched);
      unmatched.length = 0;
    }
    out.push(baseMessages[i]);
    const inserts = insertAfter.get(i);
    if (inserts) out.push(...inserts);
  }
  if (unmatched.length) out.push(...unmatched);
  return out;
}

function extractThreadTranscript(view, thread) {
  try {
    const text = String(view?.state?.doc?.toString?.() || thread?.body || "");
    return text.trim();
  } catch {
    return String(thread?.body || "").trim();
  }
}

async function summarizeThreadAnswer(thread, transcriptText) {
  const id = String(thread?.id || "");
  if (!id) return;
  if (summarizeInflight.has(id)) return;
  const transcript = String(transcriptText || "").trim();
  if (!transcript) return;
  const runStream = window.zion?.llm?.runStream;
  if (typeof runStream !== "function") return;

  summarizeInflight.add(id);
  try {
    const anchorText = String(thread?.anchorText || thread?.quote || "").slice(0, 800);
    const excerpt = transcript.length > 8000 ? transcript.slice(-8000) : transcript;
    const messages = [
      {
        role: "system",
        content: [
          "你是 Zion Comments 的局部工作记忆总结器，不是聊天助手。",
          "这条总结会在后续主会话请求中，被插入到被评论内容所在 message 的下方，作为模型继续工作的局部上下文。",
          "任务：把下面围绕某段被评论内容展开的评论对话，压缩成一条短小、可恢复、可继续执行的工作记忆。",
          "",
          "输出契约：",
          "1. Context Brief: 这条评论关注的局部问题或背景。",
          "2. Work Result: 已达成的结论、修改方向、设计取舍或约束。",
          "3. Evidence: 对话中支撑结论的关键依据；没有则写“无明确证据”。",
          "4. Next Actions: 后续处理该被评论内容时应记住的动作、注意事项或未决问题；没有则写“无”。",
          "",
          "要求：",
          "- 必须使用上述英文标题作为 Markdown 小节标题，方便后续解析和阅读。",
          "- 每个小节 1 句，整体尽量控制在 120-220 个中文字符。",
          "- 不要复述完整对话过程，不要写“用户问/助手答”。",
          "- 不要编造对话里没有的信息。"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          "请为下面的评论会话生成局部工作记忆。",
          "",
          "被评论内容：",
          anchorText || "（无）",
          "",
          "评论会话内容：",
          "<conversation>",
          excerpt,
          "</conversation>"
        ].join("\n")
      }
    ];

    let out = "";
    let err = null;
    await runStream({
      messages,
      tools: null,
      onToken: (tk) => { out += String(tk || ""); },
      onEnd: () => {},
      onError: (e) => { err = e || new Error("LLM error"); },
      runId: `comments-summary-${id}-${Date.now()}`,
      sessionId: getThreadSessionId(thread),
      silentReasoning: true
    });
    if (err) throw err;

    const summary = String(out || "").trim();
    if (!summary) return;
    patchThread(id, { summary, summaryUpdatedAt: now() }, { silent: true });
  } catch {
    // 总结是尽力而为的增强，失败时静默忽略，不影响评论会话本身。
  } finally {
    summarizeInflight.delete(id);
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
    debugCommentScrollJitter("I", "runThread.before", {
      threadId: thread.id,
      ...getCommentScrollDebugSnapshot(view)
    });
    try {
      window.zion?.state?.set?.(`chat.followLatest.${threadSessionId}`, false);
      window.zion?.state?.set?.(`chat.followSuppressUntil.${threadSessionId}`, Date.now() + 300);
    } catch {}
    await window.zion?.commands?.executeCommand?.("chat.run", {
      editor,
      sessionId: threadSessionId,
      panelId: handle?.panelId || `comments:${thread.id}`,
      skipSessionPersistence: true,
      autoInsertUserPrompt: false,
      autoFocusUserPrompt: false,
      autoScrollAssistant: false,
      followLatest: false,
      moveSelectionToAssistant: false,
      usageSessionId: thread.parentSessionId || thread.sessionId,
      requestSource: "comments",
      contextMessages: buildThreadContextMessages(thread)
    });
    debugCommentScrollJitter("I", "runThread.afterChatRun", {
      threadId: thread.id,
      ...getCommentScrollDebugSnapshot(view)
    });
    try {
      window.zion?.commands?.executeCommand?.("zion.chatCards.snapshotSession", {
        sessionId: threadSessionId,
        panelId: handle?.panelId || `comments:${thread.id}`
      });
      const annotations = persistThreadAnnotations(thread, getSessionAnnotations(threadSessionId)) || getSessionAnnotations(threadSessionId);
      restoreSessionAnnotations(threadSessionId, handle?.panelId || `comments:${thread.id}`, annotations);
    } catch {}
    patchThread(thread.id, { body: view.state.doc.toString(), threadSessionId }, { silent: true });
    try {
      const transcript = extractThreadTranscript(view, thread);
      const latest = readAllThreads().find((item) => item?.id === thread.id) || thread;
      Promise.resolve().then(() => autoRenameThreadTitle(latest, transcript));
      Promise.resolve().then(() => summarizeThreadAnswer(latest, transcript));
    } catch {}
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
  try { await migrateLegacyThreadPayloadStorage(); } catch {}
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) disposables.push(disp);
  } catch {}

  disposables.push(window.zion.commands.registerCommand("comments.openPanel", openCommentsPanel));
  disposables.push(window.zion.commands.registerCommand("comments.revealThread", (threadId, opts = {}) => revealThread(threadId, opts)));
  disposables.push(window.zion.commands.registerCommand("comments.createFromSelection", () => {
    return createThreadFromEditor(window.zion?.window?.activeEditor || null);
  }));
  disposables.push(window.zion.commands.registerCommand("comments.focusEditor", focusCommentEditor));
  disposables.push(window.zion.commands.registerCommand("comments.focusSource", () => focusEditorSource(getActiveThread())));
  try {
    const disp = window.zion?.messages?.registerContributor?.({
      id: "dev.comments.upstreamSummaries",
      stage: "post",
      order: 40,
      contribute: (messages, ctx) => {
        try {
          const editor = ctx?.editor || window.zion?.window?.activeEditor || null;
          return insertCommentSummariesIntoMessages(messages, editor);
        } catch {}
        return messages;
      }
    });
    if (disp) disposables.push(disp);
  } catch {}
  try {
    const slash = window.zion?.slash?.registerCommand;
    if (typeof slash === "function") {
      const dSlashComment = slash({
        id: "comments.create",
        trigger: ["comment", "comments", "cmt", "批注", "评论"],
        title: t("slash.comment.title", "Comment"),
        description: t("slash.comment.description", "Create a comment at the cursor or current selection"),
        category: t("title", "Comments"),
        priority: 88,
        execute: (_params, editor) => createThreadFromEditor(editor || window.zion?.window?.activeEditor || null)
      });
      if (dSlashComment) disposables.push(dSlashComment);
    }
  } catch {}
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
      const followEvents = ["chat/runStarted", "chat/token", "chat/toolCall", "chat/toolResult", "chat/reasoningStart", "chat/reasoningToken", "chat/reasoningEnd", "chat/runFinished", "chat/runError"];
      for (const eventName of followEvents) {
        const disp = window.zion?.events?.on?.(eventName, (payload) => {
          const sid = String(payload?.sessionId || "");
            if (eventName === "chat/runStarted" && sid) {
              detachedCommentTailFollowSessions.delete(sid);
              if (sid.startsWith("comment:")) {
                commentRunFollowTargetsBySession.set(sid, {
                  runId: String(payload?.runId || ""),
                  answerHeadLine: Number(payload?.answerHeadLine),
                  answerAnchorPos: Number(payload?.answerAnchorPos),
                  insertLine: Number(payload?.insertLine)
                });
                scheduleCommentSessionTailScroll(sid, "chat/runStarted", {
                  runId: String(payload?.runId || ""),
                  allowAfterRun: true
                });
              }
            }
          const allowFollow = shouldFollowCommentChatEvent(eventName, payload);
          // #region debug-point A:follow-event
          debugCommentScrollJitter("A", "follow.event", {
            eventName,
            sessionId: String(payload?.sessionId || ""),
            panelId: String(payload?.panelId || ""),
            runId: String(payload?.runId || ""),
            followLatest: payload?.sessionId ? window.zion?.state?.get?.(`chat.followLatest.${payload.sessionId}`) : null,
            streaming: payload?.sessionId ? !!window.zion?.state?.get?.(`chat.runs.${payload.sessionId}`)?.streaming : false,
            currentRunId: payload?.sessionId ? String(window.zion?.state?.get?.(`chat.runs.${payload.sessionId}`)?.runId || "") : "",
            hasHandle: payload?.sessionId ? commentEditorHandlesBySession.has(String(payload.sessionId)) : false,
              runTarget: payload?.sessionId ? commentRunFollowTargetsBySession.get(String(payload.sessionId)) || null : null,
            detached: payload?.sessionId ? detachedCommentTailFollowSessions.has(String(payload.sessionId)) : false,
            allowFollow
          });
          // #endregion
          if (!allowFollow) {
              if ((eventName === "chat/runFinished" || eventName === "chat/runError") && sid) {
                detachedCommentTailFollowSessions.delete(sid);
                commentRunFollowTargetsBySession.delete(sid);
              }
            return;
          }
          scheduleCommentSessionTailScroll(payload?.sessionId, eventName, {
            runId: String(payload?.runId || ""),
            allowAfterRun: eventName === "chat/runStarted" || eventName === "chat/runFinished" || eventName === "chat/runError"
          });
            if ((eventName === "chat/runFinished" || eventName === "chat/runError") && sid) {
              detachedCommentTailFollowSessions.delete(sid);
              commentRunFollowTargetsBySession.delete(sid);
            }
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
    icon: "$(comment-discussion)",
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
