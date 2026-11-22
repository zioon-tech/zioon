import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
import { EditorState, Prec, Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { addCursorAbove, addCursorBelow, copyLineDown, copyLineUp, moveLineDown, moveLineUp } from "@codemirror/commands";
import { EditorCore } from "../../src/editor/EditorCore.ts";
import { parseMessages } from "../../src/chat/doc.ts";
import { stripAssistantBlockIdComment } from "../../src/chat/restore.ts";
import { isContinuationBoundaryLine } from "../../src/chat/session-document-format.js";
import { reconstructWidgetHistoryMessages } from "../../src/chat/widget-history.ts";
import {
  DEFAULT_REASONING_CONTENT_PLACEHOLDER,
  normalizeToolCallsReasoningContentMode,
  shouldForceReasoningContentWithToolCalls
} from "../dev.langchain-chat/reasoning-policy.js";
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
const THREAD_RECORD_KEY_PREFIX = "zion.comments.threadRecord.";
const THREAD_RECORD_IDS_KEY = "zion.comments.threadRecordIds.v1";
const HOT_THREAD_INDEX_LIMIT = 120;
const EMERGENCY_THREAD_INDEX_LIMIT = 24;
const MAX_STORED_SOURCE_CONTEXT_CHARS = 4000;
const AGGRESSIVE_MAX_STORED_SOURCE_CONTEXT_CHARS = 1500;
const DEFAULT_MAX_STORED_ANCHOR_CHARS = 2000;
const AGGRESSIVE_MAX_STORED_ANCHOR_CHARS = 800;
const DEFAULT_MAX_STORED_QUOTE_CHARS = 1000;
const AGGRESSIVE_MAX_STORED_QUOTE_CHARS = 400;
const COMMENT_PANEL_MIN_ROW_GAP = 8;
const COMMENT_WHEEL_GESTURE_IDLE_MS = 220;
const PANEL_COMMENT_BUTTON_ATTR = "data-zion-comments-panel-button";
let pendingFocusThreadId = "";
let pendingExpandThreadId = "";
let pendingRevealThreadId = "";
let pendingLocatedThreadId = "";
let recentLocatedThreadId = "";
let lastCommentsEditorHandle = null;
let lastCommentSourceFocus = null;
const annotationPersistTimers = new Map();
const commentEditorHandlesBySession = new Map();
const detachedCommentTailFollowSessions = new Set();
const commentAnchorPreserveSessions = new Set();
const commentRunFollowTargetsBySession = new Map();
const threadPayloadCache = new Map();
const threadPayloadLoads = new Map();
const pendingThreadPayloadPersists = new Map();
const threadRecordCache = new Map();
const pendingThreadRecordPersists = new Map();
let pendingThreadRecordFlush = false;
let threadRecordArchiveLoaded = false;
let threadArchiveReady = false;
const liveAnchorOverrides = new Map();
const liveAnchorDirtyBySession = new Map();
const liveAnchorPersistTimers = new Map();

export function isCommentPanelUserScrollActive(list, now = Date.now()) {
  return !!list && Number(now) <= Number(list.__zionUserScrollIntentUntil || 0);
}

export function shouldDetachCommentTailFollow(reason) {
  return reason === "comment-thread-scroll";
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
    target.__zionScrollRestoreVersion = (Number(target.__zionScrollRestoreVersion) || 0) + 1;
  } catch {}
}

export function canScrollCommentEditorInDirection(scroller, deltaY) {
  try {
    const delta = Number(deltaY) || 0;
    if (!scroller || !delta) return false;
    const maxScroll = Math.max(
      0,
      Number(scroller.scrollHeight || 0) - Number(scroller.clientHeight || 0)
    );
    if (maxScroll <= 1) return false;
    const current = Math.max(0, Number(scroller.scrollTop) || 0);
    return delta < 0 ? current > 1 : current < maxScroll - 1;
  } catch {
    return false;
  }
}

export function shouldContainCommentEditorWheel(scroller, deltaY, panelOwnsGesture = false) {
  const delta = Number(deltaY) || 0;
  if (!delta || panelOwnsGesture) return false;
  return !canScrollCommentEditorInDirection(scroller, delta);
}

export function runCommentEditorCommand(view, command) {
  if (!view || typeof command !== "function") return false;
  const list = view.dom?.closest?.(".zion-comments-list") || null;
  const listScrollTop = Number(list?.scrollTop) || 0;
  const restoreOuterScroll = () => {
    if (!list) return;
    markCommentListProgrammaticScroll(list, 180);
    list.scrollTop = listScrollTop;
  };
  let handled = false;
  try {
    handled = !!command(view);
  } catch {
    return false;
  }
  restoreOuterScroll();
  try {
    requestAnimationFrame(() => {
      restoreOuterScroll();
      requestAnimationFrame(restoreOuterScroll);
    });
  } catch {}
  return handled;
}

export function moveCommentEditorToBoundary(view, toEnd, extend = false) {
  try {
    if (!view?.state?.doc) return false;
    const scroller = view.scrollDOM;
    const list = view.dom?.closest?.(".zion-comments-list");
    const listScrollTop = Number(list?.scrollTop) || 0;
    const boundaryPos = toEnd ? view.state.doc.length : 0;
    const current = view.state.selection.main;
    const selection = extend
      ? { anchor: current.anchor, head: boundaryPos }
      : { anchor: boundaryPos };

    view.dispatch({ selection, scrollIntoView: false });

    const applyScroll = (target) => {
      if (!scroller || view.state.selection.main.head !== boundaryPos) return;
      scroller.__zionProgrammaticScrollUntil = Math.max(
        Number(scroller.__zionProgrammaticScrollUntil) || 0,
        Date.now() + 240
      );
      const nextTop = Math.max(0, Number(target) || 0);
      if (Math.abs((Number(scroller.scrollTop) || 0) - nextTop) >= 1) {
        scroller.scrollTop = nextTop;
      }
    };
    const readTarget = () => toEnd
      ? Math.max(0, Number(scroller?.scrollHeight || 0) - Number(scroller?.clientHeight || 0))
      : 0;

    applyScroll(readTarget());
    if (list && Math.abs((Number(list.scrollTop) || 0) - listScrollTop) >= 1) {
      markCommentListProgrammaticScroll(list, 120);
      list.scrollTop = listScrollTop;
    }
    const restoreVersion = Number(scroller?.__zionScrollRestoreVersion) || 0;
    try {
      view.requestMeasure?.({
        read: readTarget,
        write(target) {
          if ((Number(scroller?.__zionScrollRestoreVersion) || 0) !== restoreVersion) return;
          applyScroll(target);
        }
      });
    } catch {}
    return true;
  } catch {
    return false;
  }
}

export function handleCommentEditorBoundaryKeydown(event, view) {
  try {
    const isBoundaryKey = event?.metaKey
      && !event.ctrlKey
      && !event.altKey
      && (event.key === "ArrowUp" || event.key === "ArrowDown");
    if (!isBoundaryKey) return false;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    return moveCommentEditorToBoundary(view, event.key === "ArrowDown", !!event.shiftKey);
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
      "panel.open": "打开评论",
      "thread.created": "已创建评论线程",
      "thread.createFailedStorage": "创建评论失败：评论数据库与本地索引均不可写，请检查浏览器存储权限后重试",
    "header.subtitle": "正文中的锚定评论",
    "anchor.open": "打开评论",
    "anchor.count": "{count} 条评论",
    "stats.open": "{count} 未解决",
    "stats.resolved": "{count} 已解决",
    "stats.lost": "{count} 锚点丢失",
      "stats.all": "全部 {count}",
      "stats.streaming": "{count} 回答中",
      "stats.completed": "{count} 已完成",
      "history.jump": "跳转到评论",
      "history.emptyFiltered": "当前筛选下没有评论",
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
    "threadMeta.updating": "正在更新总结...",
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
      "panel.open": "Open comments",
      "thread.created": "Comment thread created",
      "thread.createFailedStorage": "Failed to create comment: both the comment database and local index are unavailable. Check browser storage permissions and try again.",
    "header.subtitle": "Anchored comments in the source document",
    "anchor.open": "Open comments",
    "anchor.count": "{count} comments",
    "stats.open": "{count} open",
    "stats.resolved": "{count} resolved",
    "stats.lost": "{count} lost",
      "stats.all": "All {count}",
      "stats.streaming": "{count} answering",
      "stats.completed": "{count} completed",
      "history.jump": "Jump to comment",
      "history.emptyFiltered": "No comments match this filter",
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
    "threadMeta.updating": "Updating summary...",
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

export function resolveCommentSessionId(editor, zion = window.zion) {
  try {
    const direct = String(editor?.sessionId || "").trim();
    if (direct) return direct;
  } catch {}
  try {
    const direct = String(
      editor?.getSessionId?.()
      || editor?.core?.getSessionId?.()
      || editor?.getView?.()?.dom?.getAttribute?.("data-session-id")
      || ""
    ).trim();
    if (direct) return direct;
  } catch {}
  try {
    const panelId = editor?.panelId || zion?.panels?.getActivePanelId?.();
    if (panelId) {
      const item = zion?.panels?.list?.().find((p) => p.id === panelId);
      if (item?.activeTabId) return String(item.activeTabId);
    }
  } catch {}
  try {
    return zion?.state?.get?.("sessions.currentId") || "global";
  } catch {
    return "global";
  }
}

function getSessionId(editor) {
  return resolveCommentSessionId(editor);
}

function getThreadSessionId(thread) {
  if (thread?.threadSessionId) return String(thread.threadSessionId);
  if (thread?.id) return `comment:${thread.id}`;
  return `comment:${uid()}`;
}

function getThreadPayloadStorageKey(threadId) {
  return `${THREAD_PAYLOAD_KEY_PREFIX}${String(threadId || "")}`;
}

function getThreadRecordStorageKey(threadId) {
  return `${THREAD_RECORD_KEY_PREFIX}${String(threadId || "")}`;
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

function normalizeThreadRecord(thread, mode = "default") {
  const id = String(thread?.id || "");
  if (!id) return null;
  return compactThreadForStorage(stripThreadForStorage(thread), mode);
}

function chooseLocalThreadIndex(threads, limit = HOT_THREAD_INDEX_LIMIT) {
  const activeId = String(window.zion?.state?.get?.(ACTIVE_KEY) || "");
  return [...(Array.isArray(threads) ? threads : [])]
    .filter((thread) => thread?.id)
    .sort((left, right) => {
      const leftActive = String(left?.id || "") === activeId ? 1 : 0;
      const rightActive = String(right?.id || "") === activeId ? 1 : 0;
      if (leftActive !== rightActive) return rightActive - leftActive;
      const leftOpen = left?.resolved ? 0 : 1;
      const rightOpen = right?.resolved ? 0 : 1;
      if (leftOpen !== rightOpen) return rightOpen - leftOpen;
      return getThreadLatestAt(right) - getThreadLatestAt(left);
    })
    .slice(0, Math.max(1, Number(limit) || HOT_THREAD_INDEX_LIMIT));
}

async function persistThreadRecordIds(ids) {
  try {
    await openSessionsDB(SESSIONS_DB_NAME);
    await idbSetKV(SESSIONS_DB_NAME, THREAD_RECORD_IDS_KEY, [...new Set(ids.map(String).filter(Boolean))]);
    threadArchiveReady = true;
    return true;
  } catch {
    return false;
  }
}

function schedulePersistThreadRecords(threads) {
  for (const thread of Array.isArray(threads) ? threads : []) {
    const record = normalizeThreadRecord(thread);
    const id = String(record?.id || "");
    if (!id) continue;
    let changed = true;
    try {
      changed = JSON.stringify(threadRecordCache.get(id) || null) !== JSON.stringify(record);
    } catch {}
    threadRecordCache.set(id, record);
    if (changed || !threadRecordArchiveLoaded) pendingThreadRecordPersists.set(id, record);
  }
  if (pendingThreadRecordFlush) return;
  pendingThreadRecordFlush = true;
  Promise.resolve().then(async () => {
    pendingThreadRecordFlush = false;
    const pending = [...pendingThreadRecordPersists.values()];
    pendingThreadRecordPersists.clear();
    if (!pending.length) return;
    try {
      await openSessionsDB(SESSIONS_DB_NAME);
      for (const record of pending) {
        await idbSetKV(SESSIONS_DB_NAME, getThreadRecordStorageKey(record.id), record);
      }
      const storedIds = await idbGetKV(SESSIONS_DB_NAME, THREAD_RECORD_IDS_KEY);
      const ids = Array.isArray(storedIds) ? storedIds.map(String).filter(Boolean) : [];
      await persistThreadRecordIds([
        ...pending.map((record) => String(record.id)),
        ...ids
      ]);
    } catch {}
  });
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
    threadArchiveReady = true;
    return true;
  } catch {
    return false;
  }
}

function schedulePersistThreadPayload(thread) {
  const id = String(thread?.id || "");
  if (!id) return;
  const payload = normalizeThreadPayload(extractThreadPayload(thread));
  if (!hasStoredThreadPayload(payload)) return;
  let unchanged = false;
  try {
    const cached = threadPayloadCache.get(id);
    unchanged = !!cached && JSON.stringify(cached) === JSON.stringify(payload);
  } catch {}
  if (unchanged) return;
  threadPayloadCache.set(id, payload);
  const alreadyScheduled = pendingThreadPayloadPersists.get(id)?.scheduled === true;
  pendingThreadPayloadPersists.set(id, { id, ...payload, scheduled: true });
  if (alreadyScheduled) return;
  Promise.resolve().then(() => {
    const pending = pendingThreadPayloadPersists.get(id);
    pendingThreadPayloadPersists.delete(id);
    if (!pending) return;
    const nextThread = { ...pending };
    delete nextThread.scheduled;
    persistThreadPayload(nextThread);
  });
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
  pendingThreadPayloadPersists.delete(id);
  Promise.resolve().then(async () => {
    try {
      await openSessionsDB(SESSIONS_DB_NAME);
      await idbDelKV(SESSIONS_DB_NAME, getThreadPayloadStorageKey(id));
    } catch {}
  });
}

function deleteThreadRecord(threadId) {
  const id = String(threadId || "");
  if (!id) return;
  threadRecordCache.delete(id);
  pendingThreadRecordPersists.delete(id);
  Promise.resolve().then(async () => {
    try {
      await openSessionsDB(SESSIONS_DB_NAME);
      await idbDelKV(SESSIONS_DB_NAME, getThreadRecordStorageKey(id));
      const storedIds = await idbGetKV(SESSIONS_DB_NAME, THREAD_RECORD_IDS_KEY);
      const ids = Array.isArray(storedIds) ? storedIds.map(String).filter(Boolean) : [];
      await persistThreadRecordIds(ids.filter((item) => item !== id));
    } catch {}
  });
}

function deleteThreadArchive(threadId) {
  deleteThreadPayload(threadId);
  deleteThreadRecord(threadId);
}

function resetThreadStorageRuntime() {
  threadPayloadCache.clear();
  threadPayloadLoads.clear();
  pendingThreadPayloadPersists.clear();
  threadRecordCache.clear();
  pendingThreadRecordPersists.clear();
  pendingThreadRecordFlush = false;
  threadRecordArchiveLoaded = false;
  threadArchiveReady = false;
}

async function hydrateThreadRecordArchive(opts = {}) {
  if (threadRecordArchiveLoaded && !opts.force) return threadRecordCache.size;
  try {
    await openSessionsDB(SESSIONS_DB_NAME);
    const storedIds = await idbGetKV(SESSIONS_DB_NAME, THREAD_RECORD_IDS_KEY);
    const ids = Array.isArray(storedIds) ? storedIds.map(String).filter(Boolean) : [];
    let changed = false;
    for (const id of ids) {
      const record = await idbGetKV(SESSIONS_DB_NAME, getThreadRecordStorageKey(id));
      if (!record?.id) continue;
      const before = threadRecordCache.has(String(record.id));
      threadRecordCache.set(String(record.id), record);
      changed = changed || !before;
    }
    threadArchiveReady = true;
    threadRecordArchiveLoaded = true;
    if (changed && opts.emitChanged) emitChanged();
    return threadRecordCache.size;
  } catch {
    threadRecordArchiveLoaded = true;
    return threadRecordCache.size;
  }
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

function writeLocalThreads(payload) {
  try {
    localStorage.setItem(STORAGE_KEY, payload);
    return { ok: true, error: null };
  } catch (error) {
    try {
      if (localStorage.getItem(STORAGE_KEY) === payload) return { ok: true, error: null };
    } catch {}
    return { ok: false, error };
  }
}

function isQuotaError(error) {
  const name = String(error?.name || "");
  const message = String(error?.message || error || "");
  return name === "QuotaExceededError" || /quota|storage.*full|exceeded/i.test(message);
}

function readAllThreads() {
  const byId = new Map();
  for (const thread of readStoredThreadsRaw()) {
    const id = String(thread?.id || "");
    if (id) byId.set(id, thread);
  }
  for (const thread of threadRecordCache.values()) {
    const id = String(thread?.id || "");
    if (id) byId.set(id, thread);
  }
  return [...byId.values()]
    .sort((left, right) => getThreadLatestAt(right) - getThreadLatestAt(left))
    .map((thread) => {
      const id = String(thread?.id || "");
      const withLiveAnchor = id && liveAnchorOverrides.has(id)
        ? { ...thread, ...liveAnchorOverrides.get(id) }
        : thread;
      return applyThreadPayload(withLiveAnchor, threadPayloadCache.get(id));
    });
}

function persistLiveAnchorsForSession(sessionId) {
  const sid = String(sessionId || "");
  if (!sid) return false;
  const dirtyIds = liveAnchorDirtyBySession.get(sid);
  if (!dirtyIds?.size) return false;
  const result = writeAllThreads(readAllThreads(), { silent: true });
  if (!result?.ok) return false;
  for (const id of dirtyIds) liveAnchorOverrides.delete(id);
  liveAnchorDirtyBySession.delete(sid);
  return true;
}

function scheduleLiveAnchorPersistence(sessionId) {
  const sid = String(sessionId || "");
  if (!sid || !liveAnchorDirtyBySession.get(sid)?.size) return;
  const existing = liveAnchorPersistTimers.get(sid);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    liveAnchorPersistTimers.delete(sid);
    persistLiveAnchorsForSession(sid);
  }, 180);
  liveAnchorPersistTimers.set(sid, timer);
}

function flushLiveAnchorPersistence() {
  const sessionIds = new Set([
    ...liveAnchorPersistTimers.keys(),
    ...liveAnchorDirtyBySession.keys()
  ]);
  for (const sid of sessionIds) {
    const timer = liveAnchorPersistTimers.get(sid);
    if (timer) clearTimeout(timer);
    liveAnchorPersistTimers.delete(sid);
    persistLiveAnchorsForSession(sid);
  }
}

export function mapStoredCommentAnchor(thread, changes, beforeDoc, afterDoc) {
  if (!thread || !changes || !beforeDoc || !afterDoc) return null;
  const docLenBefore = beforeDoc.length;
  const oldFrom = Math.max(0, Math.min(docLenBefore, Number(thread?.from) || 0));
  const oldTo = Math.max(oldFrom, Math.min(docLenBefore, Number(thread?.to) || oldFrom));
  let kind = thread?.anchorKind;

  if (kind === "lost") return null;
  if (kind !== "range" && kind !== "line") {
    const text = String(thread?.anchorText || thread?.quote || "");
    if (!(oldTo > oldFrom && text && beforeDoc.sliceString(oldFrom, oldTo) === text)) return null;
    kind = "range";
  }

  let from;
  let to;
  if (kind === "line") {
    from = Math.max(0, Math.min(afterDoc.length, changes.mapPos(oldFrom, -1)));
    to = from;
  } else {
    from = Math.max(0, Math.min(afterDoc.length, changes.mapPos(oldFrom, -1)));
    to = Math.max(from, Math.min(afterDoc.length, changes.mapPos(oldTo, 1)));
    if (to === from) kind = "lost";
  }
  const startLine = afterDoc.lineAt(from).number - 1;
  const endLine = afterDoc.lineAt(to).number - 1;
  return { from, to, startLine, endLine, anchorKind: kind };
}

function mapCommentAnchorsThroughChanges(update, editor) {
  try {
    if (!update?.docChanged || !update?.changes) return;
    const shouldSkipMapping = update.transactions?.some?.((tr) => {
      const userEvent = tr?.annotation?.(Transaction.userEvent);
      return userEvent === "zion.sessionLoad"
        || userEvent === "zion.sessionSeed"
        || userEvent === "zion.sessionSync";
    });
    if (shouldSkipMapping) return;
    const sessionId = getSessionId(editor);
    const beforeDoc = update.startState?.doc;
    const afterDoc = update.state?.doc;
    if (!sessionId || !beforeDoc || !afterDoc) return;
    if (beforeDoc.length === 0 && afterDoc.length > 0) return;
    const dirtyIds = liveAnchorDirtyBySession.get(sessionId) || new Set();
    let changed = false;

    for (const thread of readAllThreads()) {
      if (String(thread?.sessionId || "") !== sessionId) continue;
      const next = mapStoredCommentAnchor(thread, update.changes, beforeDoc, afterDoc);
      if (!next) continue;
      if (
        next.from === Number(thread?.from)
        && next.to === Number(thread?.to)
        && next.anchorKind === thread?.anchorKind
        && next.startLine === Number(thread?.startLine)
        && next.endLine === Number(thread?.endLine)
      ) continue;
      liveAnchorOverrides.set(String(thread.id), next);
      dirtyIds.add(String(thread.id));
      changed = true;
    }

    if (changed) {
      liveAnchorDirtyBySession.set(sessionId, dirtyIds);
      scheduleLiveAnchorPersistence(sessionId);
    }
  } catch {}
}

function persistRelocatedThreadAnchor(thread, view, from, to, lines, anchorKind = "range") {
  try {
    const id = String(thread?.id || "");
    const sessionId = String(thread?.sessionId || "");
    if (!id || !sessionId) return;
    const fallbackStartLine = Number(thread?.startLine);
    const fallbackEndLine = Number(thread?.endLine);
    const next = {
      from,
      to,
      startLine: Number.isFinite(lines?.startLine) ? lines.startLine : (Number.isFinite(fallbackStartLine) ? fallbackStartLine : 0),
      endLine: Number.isFinite(lines?.endLine) ? lines.endLine : (Number.isFinite(fallbackEndLine) ? fallbackEndLine : (Number.isFinite(fallbackStartLine) ? fallbackStartLine : 0)),
      anchorKind
    };
    const sourceContext = buildSourceContextSnapshot(view, from, to);
    if (sourceContext?.text) {
      next.sourceContextText = sourceContext.text;
      next.sourceContextFrom = sourceContext.from;
      next.sourceContextTo = sourceContext.to;
      next.sourceContextStartLine = sourceContext.startLine;
      next.sourceContextEndLine = sourceContext.endLine;
    }
    liveAnchorOverrides.set(id, next);
    const dirtyIds = liveAnchorDirtyBySession.get(sessionId) || new Set();
    dirtyIds.add(id);
    liveAnchorDirtyBySession.set(sessionId, dirtyIds);
    scheduleLiveAnchorPersistence(sessionId);
  } catch {}
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

  const attempts = [];
  const addAttempts = (items, label) => {
    for (const mode of modes) attempts.push({ items, mode, label });
  };
  if (rawList.length <= HOT_THREAD_INDEX_LIMIT) addAttempts(rawList, "full");
  addAttempts(chooseLocalThreadIndex(rawList, HOT_THREAD_INDEX_LIMIT), "hot");
  addAttempts(chooseLocalThreadIndex(rawList, EMERGENCY_THREAD_INDEX_LIMIT), "emergency");

  for (const attempt of attempts) {
    const normalizedList = attempt.items.map((item) => compactThreadForStorage(
      threadArchiveReady ? stripThreadForStorage(item) : item,
      attempt.mode
    ));
    const payload = JSON.stringify(normalizedList);
    lastPayloadLength = payload.length;
    const result = writeLocalThreads(payload);
    if (result.ok) {
      schedulePersistThreadRecords(rawList);
      for (const thread of rawList) schedulePersistThreadPayload(thread);
      if (!opts.silent) emitChanged();
      return {
        ok: true,
        list: rawList,
        storedList: normalizedList,
        payloadLength: payload.length,
        storedCount: normalizedList.length,
        compactionMode: attempt.mode,
        indexMode: attempt.label
      };
    }
    lastError = result.error;
    if (!isQuotaError(result.error)) break;
  }

  if (threadArchiveReady) {
    schedulePersistThreadRecords(rawList);
    for (const thread of rawList) schedulePersistThreadPayload(thread);
    if (!opts.silent) emitChanged();
    return {
      ok: true,
      list: rawList,
      storedList: [],
      payloadLength: lastPayloadLength,
      storedCount: 0,
      compactionMode: "none",
      indexMode: "indexeddb-only",
      localIndexPersisted: false,
      localIndexError: lastError
    };
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

  function getCommentAnchorY(view, anchor, fallbackLine) {
    try {
      if (view && anchor && typeof anchor.from === "number") {
        const pos = typeof anchor.markerPos === "number" ? anchor.markerPos : anchor.from;
        const block = view.lineBlockAt?.(pos);
        if (block && Number.isFinite(Number(block.top))) {
          return Number(block.top) + Math.max(0, Number(block.height) || 0) / 2;
        }
      }
    } catch {}
    const line = Number.isFinite(Number(anchor?.startLine)) ? Number(anchor.startLine) : Number(fallbackLine) || 0;
    return Math.max(0, line * 22 + 11);
  }

  function alignCommentRowsToAnchors(list, view, threads, anchorById, reason = "layout") {
    try {
      if (!list || !Array.isArray(threads) || !threads.length) return;
      const measurements = [];
      for (const item of threads) {
        const row = list.querySelector(`.zion-comments-row[data-thread-id="${cssEscape(item.id)}"]`);
        if (!row) continue;
        const header = row.querySelector?.(".zion-comments-editor-header");
        const rowRect = row.getBoundingClientRect?.();
        const headerRect = header?.getBoundingClientRect?.();
        const rowHeight = Math.max(1, Math.ceil(rowRect?.height || row.offsetHeight || 0));
        const anchor = anchorById?.get?.(item.id) || null;
        measurements.push({
          item,
          row,
          rowHeight,
          rowAnchorOffset: rowRect && headerRect
            ? Math.max(0, (headerRect.top - rowRect.top) + headerRect.height / 2)
            : Math.min(18, rowHeight / 2),
          anchorY: anchor ? getCommentAnchorY(view, anchor, item.startLine) : null
        });
      }

      let panelCursorTop = 0;
      const rows = [];
      for (const measurement of measurements) {
        const { item, row, rowHeight, rowAnchorOffset } = measurement;
        const minGap = rows.length ? COMMENT_PANEL_MIN_ROW_GAP : 0;
        const anchorY = measurement.anchorY ?? panelCursorTop + minGap;
        const targetTop = measurement.anchorY != null ? anchorY - rowAnchorOffset : anchorY;
        const rowGap = Math.max(minGap, Math.round(targetTop - panelCursorTop));
        row.style.marginTop = `${rowGap}px`;
        const rowTop = panelCursorTop + rowGap;
        panelCursorTop = rowTop + rowHeight;
        rows.push({
          id: item.id,
          anchorY,
          rowTop,
          rowHeight,
          rowGap,
          rowAnchorOffset: Math.round(rowAnchorOffset),
          delta: Math.round(rowTop + rowAnchorOffset - anchorY)
        });
      }
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
        const hasSummary = typeof thread?.summary === "string" && thread.summary.trim();
        const raw = String(hasSummary ? thread.summary : (thread?.body || fallback || "")).trim();
        if (!raw) return "";
        // Generated summaries are Markdown by contract. Keep their source intact
        // so the folded renderer can preserve headings, lists, and inline markup.
        if (hasSummary) return raw;
        const cleaned = raw
          .replace(/```[\s\S]*?```/g, " ")
          .replace(/`([^`]+)`/g, "$1")
          .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
          .replace(/\[[^\]]+\]\(([^)]+)\)/g, "$1")
          .split(/\n+/)
          .map((line) => line
            .replace(/^\s*(user|assistant|system)\s*[:：]\s*/i, "")
            .trim())
          .filter(Boolean)
          .join("\n");
        return compactText(cleaned, 150);
      } catch {
        return compactText(fallback, 150);
      }
  }

function getThreadLogTitle(thread) {
  return compactText(
    thread?.title
    || thread?.summary
    || thread?.quote
    || thread?.anchorText
    || thread?.sourceTitle
    || thread?.id,
    72
  );
}

function appendSummaryInlineMarkdown(target, value) {
  const source = String(value || "");
  const tokenRe = /(\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`\n]+)`|\*([^*\n]+)\*)/g;
  let cursor = 0;
  let match;
  while ((match = tokenRe.exec(source))) {
    if (match.index > cursor) target.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    if (match[2] != null) {
      let href = "";
      try {
        const url = new URL(match[3], window.location.href);
        if (url.protocol === "http:" || url.protocol === "https:") href = url.href;
      } catch {}
      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = match[2];
        target.appendChild(link);
      } else {
        target.appendChild(document.createTextNode(match[2]));
      }
    } else if (match[4] != null) {
      const strong = document.createElement("strong");
      strong.textContent = match[4];
      target.appendChild(strong);
    } else if (match[5] != null) {
      const code = document.createElement("code");
      code.textContent = match[5];
      target.appendChild(code);
    } else if (match[6] != null) {
      const emphasis = document.createElement("em");
      emphasis.textContent = match[6];
      target.appendChild(emphasis);
    }
    cursor = tokenRe.lastIndex;
  }
  if (cursor < source.length) target.appendChild(document.createTextNode(source.slice(cursor)));
}

function createThreadSummaryView(text, empty = false) {
  const summary = document.createElement("div");
  summary.className = `zion-comments-summary${empty ? " is-empty" : ""}`;
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  let list = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      list = null;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      list = null;
      const title = document.createElement("div");
      title.className = `zion-comments-summary-heading is-level-${heading[1].length}`;
      appendSummaryInlineMarkdown(title, heading[2]);
      summary.appendChild(title);
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!list) {
        list = document.createElement("ul");
        list.className = "zion-comments-summary-list";
        summary.appendChild(list);
      }
      const item = document.createElement("li");
      appendSummaryInlineMarkdown(item, bullet[1]);
      list.appendChild(item);
      continue;
    }
    list = null;
    const paragraph = document.createElement("div");
    paragraph.className = "zion-comments-summary-paragraph";
    appendSummaryInlineMarkdown(paragraph, line);
    summary.appendChild(paragraph);
  }

  if (!summary.childNodes.length) summary.textContent = text;
  return summary;
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
  if (result?.ok) deleteThreadArchive(id);
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
      const exactEditor = window.zion?.panels?.getEditorBySession?.(pid, sid) || null;
      const panelEditor = window.zion?.panels?.getEditor?.(pid) || null;
      const editor = exactEditor
        || (String(getSessionId(panelEditor) || "") === sid ? panelEditor : null);
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
    const view = active?.getView?.();
    const focused = !!(view?.hasFocus || view?.dom?.contains?.(document.activeElement));
    if (focused && active && !isCommentPanelId(active?.panelId)) {
      rememberSourceFocus(active);
      return active;
    }
  } catch {}

  try {
    const remembered = lastCommentSourceFocus;
    if (remembered?.panelId === "inspector" && remembered?.sessionId) {
        return window.zion?.inspector?.getTextEditor?.(remembered.sessionId)
          || getInspectorSourceEditor(remembered.sessionId)
          || null;
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
  if (thread?.sourceKind === "inspector") {
    try {
      const sessionId = getThreadSourceSessionId(thread);
      const existing = window.zion?.inspector?.getTextEditor?.(thread.sourceItemId || sessionId)
        || window.zion?.inspector?.getTextEditor?.(sessionId)
        || null;
      if (existing) {
        rememberThreadSource(thread, existing);
        revealThreadAnchor(thread, {
          editor: existing,
          focus: opts.focus !== false,
          smooth: false
        });
        return true;
      }
      const editor = window.zion?.inspector?.revealText?.(getThreadSourceSessionId(thread), {
        from: thread.from,
        to: thread.from,
        focus: opts.focus !== false
      }) || window.zion?.inspector?.revealText?.(thread.sourceItemId, {
        from: thread.from,
        to: thread.from,
        focus: opts.focus !== false
      });
      if (editor) rememberThreadSource(thread, editor);
      return !!editor;
    } catch {
      return false;
    }
  }
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
  scheduleFocusCommentThreadEditor(lastCommentsEditorHandle, { forceFocus: true });
  return true;
}

function markCommentThreadViewed(threadId) {
  const id = String(threadId || "").trim();
  if (!id) return false;
  const sessionId = `comment:${id}`;
  try {
    const handled = window.zion?.commands?.executeCommand?.("zion.sessions.markViewed", sessionId);
    if (handled !== undefined) return !!handled;
  } catch {}
  try {
    const key = `chat.runs.${sessionId}`;
    const runState = window.zion?.state?.get?.(key) || null;
    if (!runState?.awaiting) return false;
    window.zion?.state?.set?.(key, { ...runState, awaiting: false });
    return true;
  } catch {
    return false;
  }
}

function setActiveThread(id) {
  const next = id || "";
  markCommentThreadViewed(next);
  if (recentLocatedThreadId && recentLocatedThreadId !== next) {
    recentLocatedThreadId = "";
  }
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
  recentLocatedThreadId = threadId;
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
  if (thread?.anchorKind === "line") return "";
  return String(thread?.anchorText || thread?.quote || "");
}

function findClosestTextOccurrence(docText, text, hintPos) {
  if (!text) return -1;
  let found = docText.indexOf(text);
  let closest = found;
  let closestDistance = found >= 0 ? Math.abs(found - hintPos) : Number.POSITIVE_INFINITY;
  while (found >= 0) {
    const distance = Math.abs(found - hintPos);
    if (distance < closestDistance) {
      closest = found;
      closestDistance = distance;
    }
    found = docText.indexOf(text, found + 1);
  }
  return closest;
}

export function resolveStoredRangeAnchor(docText, thread) {
  const text = String(thread?.anchorText || thread?.quote || "");
  const docLen = docText.length;
  const rawFrom = Number(thread?.from);
  const rawTo = Number(thread?.to);
  const savedFrom = Math.max(0, Math.min(docLen, Number.isFinite(rawFrom) ? rawFrom : 0));
  const savedTo = Math.max(savedFrom, Math.min(docLen, Number.isFinite(rawTo) ? rawTo : savedFrom));
  if (!text) {
    return savedTo > savedFrom ? { from: savedFrom, to: savedTo, relocated: false } : null;
  }

  if (
    savedTo - savedFrom >= text.length
    && docText.slice(savedFrom, savedFrom + text.length) === text
  ) {
    return { from: savedFrom, to: savedTo, relocated: false };
  }

  const found = findClosestTextOccurrence(docText, text, savedFrom);
  if (found < 0) return null;
  const savedLength = Number.isFinite(rawFrom) && Number.isFinite(rawTo)
    ? Math.max(0, rawTo - rawFrom)
    : 0;
  const recoveredLength = savedLength > 0 && savedLength < docLen
    ? Math.max(text.length, savedLength)
    : text.length;
  return {
    from: found,
    to: Math.min(docLen, found + recoveredLength),
    relocated: found !== savedFrom || found + recoveredLength !== savedTo
  };
}

function resolveStoredLineAnchor(docText, thread) {
  const docLen = docText.length;
  const savedFrom = Math.max(0, Math.min(docLen, Number(thread?.from) || 0));
  const context = String(thread?.sourceContextText || "").slice(-1000);
  if (!context) return { from: savedFrom, relocated: false };
  const savedContextFrom = savedFrom - context.length;
  if (savedContextFrom >= 0 && docText.slice(savedContextFrom, savedFrom) === context) {
    return { from: savedFrom, relocated: false };
  }
  const found = findClosestTextOccurrence(docText, context, Math.max(0, savedContextFrom));
  if (found < 0) return { from: savedFrom, relocated: false };
  return { from: Math.min(docLen, found + context.length), relocated: true };
}

  function locateThreadAnchor(view, thread, cachedDocText = null) {
  try {
    if (!view || !thread) return null;
    const doc = view.state.doc;
      const docText = typeof cachedDocText === "string" ? cachedDocText : doc.toString();
    const docLen = doc.length;
    const savedFrom = Math.max(0, Math.min(docLen, Number(thread.from) || 0));
    const savedTo = Math.max(savedFrom, Math.min(docLen, Number(thread.to) || savedFrom));
    if (thread?.anchorKind === "lost") return null;
    if (thread?.anchorKind === "line") {
        const resolved = resolveStoredLineAnchor(docText, thread);
      const lines = lineRangeFor(view, resolved.from, resolved.from);
      if (resolved.relocated) {
        persistRelocatedThreadAnchor(thread, view, resolved.from, resolved.from, lines, "line");
      }
      return { from: resolved.from, to: resolved.from, ...lines, relocated: resolved.relocated, kind: "line" };
    }
    if (thread?.anchorKind === "range") {
        const resolved = resolveStoredRangeAnchor(docText, thread);
      if (!resolved) return null;
      const lines = lineRangeFor(view, resolved.from, resolved.to);
      if (resolved.relocated) {
        persistRelocatedThreadAnchor(thread, view, resolved.from, resolved.to, lines);
      }
      return { ...resolved, ...lines, kind: "range" };
    }
    const text = getAnchorText(thread);
    if (!text) return null;

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

      const found = docText.indexOf(text);
    if (found >= 0) {
      const from = found;
      const to = found + text.length;
      const lines = lineRangeFor(view, from, to);
      return { from, to, ...lines, relocated: true };
    }
  } catch {}
  return null;
}

function clearSourceSelectionAfterThreadCreate(view, anchorTo) {
  try {
    window.zion?.state?.set?.("selectionToolbar.suppressUntil", Date.now() + 700);
    window.zion?.state?.set?.("selectionToolbar.domAnchorRect", null);
  } catch {}
  try {
    const selection = document.getSelection?.();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
  } catch {}
  try {
    const docLen = Number(view?.state?.doc?.length) || 0;
    const pos = Math.max(0, Math.min(docLen, Number(anchorTo) || 0));
    view?.dispatch?.({ selection: { anchor: pos } });
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent("selectionToolbar.domAnchorChanged"));
  } catch {}
}

function createThreadFromSelection({ view, from, to, selectionText, editor: sourceEditor = null }) {
  const editor = sourceEditor
    || window.zion?.editor?.getEditorForView?.(view)
    || window.zion?.window?.activeEditor
    || null;
  const sessionId = getSessionId(editor);
  const doc = view?.state?.doc;
  if (!view || !doc) return null;
  let anchorFrom = Math.max(0, Math.min(doc.length, Number(from) || 0));
  let anchorTo = Math.max(anchorFrom, Math.min(doc.length, Number(to) || anchorFrom));
  const hasSelection = anchorTo > anchorFrom;
  let anchorKind = hasSelection ? "range" : "line";
  let anchorText = hasSelection ? String(selectionText ?? (view.state.sliceDoc(anchorFrom, anchorTo) || "")) : "";
  let quote = anchorText.trim();
  if (!hasSelection) {
    const line = doc.lineAt(anchorFrom);
    anchorFrom = line.from;
    anchorTo = anchorFrom;
    quote = `L${line.number}`;
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
    sourceKind: editor?.sourceKind || "editor",
    sourceItemId: editor?.inspectorItemId || null,
    sourcePath: editor?.sourcePath || null,
    sourceTitle: editor?.sourceTitle || null,
    from: anchorFrom,
    to: anchorTo,
    anchorKind,
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
          t("thread.createFailedStorage", "Failed to create comment: both the comment database and local index are unavailable. Check browser storage permissions and try again."),
          { type: "error", duration: 2600 }
        );
      } catch {}
      return null;
    }
    setActiveThread(persistedThread.id);
    if (hasSelection) clearSourceSelectionAfterThreadCreate(view, anchorTo);
    pendingExpandThreadId = persistedThread.id;
    pendingFocusThreadId = persistedThread.id;
      pendingLocatedThreadId = persistedThread.id;
  openCommentsPanel();
    try {
      requestAnimationFrame(() => {
        try { signalCommentThreadLocated(persistedThread.id, "create"); } catch {}
      });
    } catch {}
  try {
    window.zion?.notification?.show?.(t("thread.created", "Comment thread created"), { type: "success", duration: 1400 });
  } catch {}
    return persistedThread;
}

function createThreadFromInspectorText({ sourceText, sourceSessionId, sourcePath, sourceTitle, inspectorItemId, from, to, selectionText }) {
  const content = String(sourceText || "");
  const sessionId = String(sourceSessionId || "");
  if (!sessionId || !content) return null;
  const anchor = Math.max(0, Math.min(content.length, Number(from) || 0));
  const head = Math.max(anchor, Math.min(content.length, Number(to) || anchor));
  let state = EditorState.create({
    doc: content,
    selection: { anchor, head }
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec) {
      try { state = state.update(spec).state; } catch {}
    },
    focus() {}
  };
  const editor = {
    panelId: "inspector",
    sessionId,
    sourceKind: "inspector",
    inspectorItemId: String(inspectorItemId || ""),
    sourcePath: String(sourcePath || ""),
    sourceTitle: String(sourceTitle || sourcePath || ""),
    getView: () => view,
    focus() {}
  };
  return createThreadFromSelection({
    view,
    editor,
    from: anchor,
    to: head,
    selectionText: String(selectionText ?? content.slice(anchor, head))
  });
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
  try { window.zion?.auxiliaryBar?.activateView?.(VIEW_ID); } catch {}
  try { markCommentThreadViewed(window.zion?.state?.get?.(ACTIVE_KEY)); } catch {}
  try { updatePanelCommentButtons(); } catch {}
}

function isCommentsAuxiliaryViewActive() {
  try {
    return window.zion?.state?.get?.("ui.auxiliaryBar.visible") === true
      && String(window.zion?.state?.get?.("ui.auxiliaryBar.activeViewId") || "") === VIEW_ID;
  } catch {
    return false;
  }
}

export function updatePanelCommentButtons() {
  const activePanelId = String(window.zion?.panels?.getActivePanelId?.() || "");
  const commentsActive = isCommentsAuxiliaryViewActive();
  for (const button of document.querySelectorAll(`[${PANEL_COMMENT_BUTTON_ATTR}="1"]`)) {
    const panelId = String(button.closest?.("[data-panel-id]")?.getAttribute?.("data-panel-id") || "");
    const active = commentsActive && !!panelId && panelId === activePanelId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

export function mountPanelCommentButton(panelRoot) {
  if (!(panelRoot instanceof HTMLElement)) return null;
  const panelId = String(panelRoot.getAttribute("data-panel-id") || "");
  const editorHost = Array.from(panelRoot.children).find((child) => child.classList?.contains("zion-editor-host"));
  if (!panelId || !(editorHost instanceof HTMLElement)) return null;

  let button = panelRoot.querySelector(`[${PANEL_COMMENT_BUTTON_ATTR}="1"]`);
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "zion-panel-comment-button";
    button.innerHTML = '<span class="codicon codicon-comment-discussion" aria-hidden="true"></span>';
    button.title = t("panel.open", "打开评论");
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", "false");
    button.setAttribute(PANEL_COMMENT_BUTTON_ATTR, "1");
    button.onclick = (event) => {
      try {
        event.preventDefault();
        event.stopPropagation();
      } catch {}
      try { window.zion?.panels?.focus?.(panelId); } catch {}
      try {
        const panel = window.zion?.panels?.list?.()?.find?.((item) => String(item?.id || "") === panelId);
        const sessionId = String(panel?.activeTabId || "");
        if (sessionId) rememberSourcePanelSession(panelId, sessionId);
        else rememberSourceFocus(window.zion?.panels?.getEditor?.(panelId) || null);
      } catch {}
      openCommentsPanel();
      updatePanelCommentButtons();
    };
  }
  if (button.parentElement !== editorHost) editorHost.appendChild(button);
  updatePanelCommentButtons();
  return button;
}

function installPanelCommentButtons() {
  let disposed = false;
  const mountAll = () => {
    if (disposed) return;
    for (const panelRoot of document.querySelectorAll(".zion-panel[data-panel-id]")) {
      mountPanelCommentButton(panelRoot);
    }
  };
  const mountPanel = (panelId) => {
    if (disposed) return;
    const root = Array.from(document.querySelectorAll(".zion-panel[data-panel-id]"))
      .find((item) => String(item.getAttribute("data-panel-id") || "") === String(panelId || ""));
    if (root) mountPanelCommentButton(root);
  };

  mountAll();
  const frame = requestAnimationFrame(mountAll);
  const disposables = [];
  try {
    disposables.push(window.zion?.events?.on?.("panel/created", ({ panelId } = {}) => {
      mountPanel(panelId);
      requestAnimationFrame(() => mountPanel(panelId));
    }));
  } catch {}
  try { disposables.push(window.zion?.events?.on?.("panel/focusChanged", updatePanelCommentButtons)); } catch {}
  try {
    disposables.push(window.zion?.events?.on?.("panel/tabActivated", () => {
      mountAll();
      requestAnimationFrame(mountAll);
    }));
  } catch {}
  try { disposables.push(window.zion?.events?.on?.("ui/auxiliaryBarActiveViewChanged", updatePanelCommentButtons)); } catch {}
  try { disposables.push(window.zion?.state?.onDidChange?.("ui.auxiliaryBar.visible", updatePanelCommentButtons)); } catch {}
  try { disposables.push(window.zion?.state?.onDidChange?.("ui.auxiliaryBar.activeViewId", updatePanelCommentButtons)); } catch {}

  return {
    dispose() {
      disposed = true;
      try { window.cancelAnimationFrame(frame); } catch {}
      for (const disposable of disposables) {
        try { disposable?.dispose?.(); } catch {}
      }
      for (const button of document.querySelectorAll(`[${PANEL_COMMENT_BUTTON_ATTR}="1"]`)) {
        try { button.remove(); } catch {}
      }
    }
  };
}

function getInspectorSourceEditor(threadOrSessionId) {
  try {
    const thread = typeof threadOrSessionId === "object" ? threadOrSessionId : null;
    const sessionId = thread ? getThreadSourceSessionId(thread) : String(threadOrSessionId || "");
    const source = window.zion?.inspector?.getTextSource?.(sessionId)
      || window.zion?.inspector?.getTextSource?.(thread?.sourceItemId)
      || null;
    if (!source?.content && source?.content !== "") return null;
    let state = EditorState.create({ doc: String(source.content || "") });
    const view = {
      get state() {
        return state;
      },
      dispatch(spec) {
        try { state = state.update(spec).state; } catch {}
      },
      focus() {}
    };
    return {
      panelId: "inspector",
      sessionId: source.sessionId || sessionId,
      sourceKind: "inspector",
      sourceViewKind: "logical",
      inspectorItemId: source.item?.id || thread?.sourceItemId || "",
      sourcePath: source.item?.path || source.item?.displayPath || thread?.sourcePath || "",
      sourceTitle: source.item?.title || thread?.sourceTitle || "",
      getView: () => view,
      focus() {}
    };
  } catch {
    return null;
  }
}

function getEditorForThread(thread, opts = {}) {
    if (opts.editor) return opts.editor;
  const sessionId = getThreadSourceSessionId(thread);
  if (thread?.sourceKind === "inspector") {
    try {
      return window.zion?.inspector?.getTextEditor?.(thread?.sourceItemId || sessionId)
        || window.zion?.inspector?.getTextEditor?.(sessionId)
        || getInspectorSourceEditor(thread)
        || null;
    } catch {
      return null;
    }
  }
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
  const sessionId = getThreadSourceSessionId(thread);
  if (!sessionId || sessionId === "global") return null;
  if (thread?.sourceKind === "inspector") {
    if (existing && existing?.sourceViewKind !== "logical") return existing;
    try {
      const revealOptions = {
        from: thread.from,
        to: thread.to,
        focus: opts.focusSource === true
      };
      return window.zion?.inspector?.revealText?.(sessionId, revealOptions)
        || window.zion?.inspector?.revealText?.(thread.sourceItemId, revealOptions)
        || null;
    } catch {
      return null;
    }
  }
    if (existing) return existing;

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

function createCommentRailButton(count, threadId, active = false, sourceEditor = null) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `zion-comment-anchor${active ? " is-active" : ""}`;
  button.title = count > 1 ? t("anchor.count", "{count} comments", { count }) : t("anchor.open", "Open comments");
    button.setAttribute("aria-label", button.title);
      if (count > 1) {
        button.dataset.count = String(count);
        button.textContent = String(count);
      } else {
        button.textContent = "";
      }
    button.onclick = (event) => {
      try { event.preventDefault(); event.stopPropagation(); } catch {}
      rememberSourceFocus(sourceEditor);
      setActiveThread(threadId);
      signalCommentThreadLocated(threadId, "source-anchor");
      openCommentsPanel();
    };
  return button;
}

function buildCommentRailGroups(view, editor) {
  const groups = new Map();
  try {
    const sessionId = getSessionId(editor);
    const threads = getThreadsForSession(sessionId).filter((item) => !item.resolved);
      const docText = view?.state?.doc?.toString?.() || "";
    const activeThreadId = String(window.zion?.state?.get?.(ACTIVE_KEY) || "");
    for (const thread of threads) {
        const anchor = locateThreadAnchor(view, thread, docText);
      if (!anchor) continue;
      let markerPos = anchor.from;
      try {
        markerPos = view.state.doc.lineAt(Math.max(0, Math.min(view.state.doc.length, anchor.from))).from;
      } catch {}
      const entries = groups.get(markerPos) || [];
      entries.push({
        id: thread.id,
        active: thread.id === activeThreadId
      });
      groups.set(markerPos, entries);
    }
  } catch {}
  return groups;
}

function buildCommentDecorations(view, editor) {
  const sessionId = getSessionId(editor);
  const threads = getThreadsForSession(sessionId).filter((item) => !item.resolved);
    const docText = view?.state?.doc?.toString?.() || "";
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
      let markerPos = anchor.from;
      try {
        markerPos = view.state.doc.lineAt(Math.max(0, Math.min(view.state.doc.length, anchor.from))).from;
      } catch {}
      tableAnchors.push({
        id: thread.id,
        from: anchor.from,
        to: anchor.to,
        markerPos,
        active
      });
    if (anchor.to > anchor.from) {
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
        this.commentSessionId = getSessionId(this.editor);
        this.hasOpenThreads = getThreadsForSession(this.commentSessionId).some((item) => !item.resolved);
        this.rail = document.createElement("div");
        this.rail.className = "zion-comment-rail";
        try {
          view.dom.classList.add("zion-comment-rail-host");
          view.dom.appendChild(this.rail);
        } catch {}
        this.decorations = buildCommentDecorations(view, this.editor);
          this.onViewportChanged = () => {
            try {
              this.renderRail();
              window.dispatchEvent(new CustomEvent("zion:comments-viewport-changed", {
                detail: {
                  panelId: this.editor?.panelId || "",
                  sessionId: getSessionId(this.editor)
                }
              }));
            } catch {}
          };
        this.onChanged = () => {
          this.commentSessionId = getSessionId(this.editor);
          this.hasOpenThreads = getThreadsForSession(this.commentSessionId).some((item) => !item.resolved);
          this.decorations = buildCommentDecorations(this.view, this.editor);
            this.renderRail();
            try { this.view.dispatch({ annotations: Transaction.userEvent.of("wysiwyg-refresh") }); } catch {}
        };
        try { window.addEventListener("zion:comments-changed", this.onChanged); } catch {}
          try { window.addEventListener("zion:comments-active-changed", this.onChanged); } catch {}
          try { this.activeDisposable = window.zion?.state?.onDidChange?.(ACTIVE_KEY, this.onChanged) || null; } catch { this.activeDisposable = null; }
          try { view.scrollDOM?.addEventListener?.("scroll", this.onViewportChanged, { passive: true }); } catch {}
          this.renderRail();
      }
      renderRail() {
        try {
          if (!this.rail || !this.view?.scrollDOM) return;
          const view = this.view;
          const rail = this.rail;
          rail.textContent = "";
          const groups = buildCommentRailGroups(view, this.editor);
          if (!groups.size) return;
          const scrollTop = Number(view.scrollDOM.scrollTop) || 0;
          const scrollRect = view.scrollDOM.getBoundingClientRect?.();
          const editorRect = view.dom.getBoundingClientRect?.();
          const scrollOffsetTop = scrollRect && editorRect ? scrollRect.top - editorRect.top : 0;
          const minY = scrollOffsetTop;
          const maxY = scrollOffsetTop + Math.max(0, Number(view.scrollDOM.clientHeight) || 0);
          const frag = document.createDocumentFragment();
          for (const [pos, entries] of groups) {
            let y = 0;
            try {
              const block = view.lineBlockAt?.(pos);
              if (!block || !Number.isFinite(Number(block.top))) continue;
              y = scrollOffsetTop + Number(block.top) - scrollTop + Math.max(0, Number(block.height) || 0) / 2;
            } catch {
              continue;
            }
            if (y < minY - 18 || y > maxY + 18) continue;
            const primary = entries.find((item) => item.active) || entries[0];
            if (!primary) continue;
            const button = createCommentRailButton(entries.length, primary.id, !!primary.active, this.editor);
            button.style.top = `${Math.round(y)}px`;
            frag.appendChild(button);
          }
          rail.appendChild(frag);
        } catch {}
      }
      update(update) {
        const currentCommentSessionId = getSessionId(this.editor);
        if (currentCommentSessionId !== this.commentSessionId) {
          this.commentSessionId = currentCommentSessionId;
          this.hasOpenThreads = getThreadsForSession(this.commentSessionId).some((item) => !item.resolved);
        }
        if (!this.hasOpenThreads) {
          this.decorations = Decoration.none;
          if (this.rail?.childNodes?.length) this.rail.textContent = "";
          return;
        }
        if (update.docChanged) {
          mapCommentAnchorsThroughChanges(update, this.editor);
        }
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildCommentDecorations(update.view, this.editor);
          this.renderRail();
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
          try { this.rail?.remove?.(); } catch {}
          try { this.view?.dom?.classList?.remove?.("zion-comment-rail-host"); } catch {}
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
        rememberSourceFocus(editor);
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

function readChatBoolDefaultTrue(key) {
  try {
    return window.zion?.state?.get?.(key) !== false;
  } catch {
    return true;
  }
}

// 解析当前活动模型的 preservedThinking / forceReasoning，语义与主编辑器 doRun 保持一致，
// 以便评论线程重建思考/工具历史时采用与主编辑器相同的策略。
async function resolveWidgetHistoryModelPolicy() {
  let preservedThinking = false;
  let interleavedThinking = false;
  let forceReasoning = false;
  try {
    const active = window.zion?.state?.get?.("chat.activeModel") || null;
    let activeCfg = null;
    try {
      const prov = window.zion?.models?.getProvider?.(active?.providerId);
      activeCfg = await prov?.resolve?.(active?.modelId);
      preservedThinking = !!activeCfg?.preservedThinking;
      interleavedThinking = !!activeCfg?.interleavedThinking;
    } catch {}
    const mode = normalizeToolCallsReasoningContentMode(
      window.zion?.state?.get?.("chat.toolCallsReasoningContentMode")
    );
    forceReasoning = shouldForceReasoningContentWithToolCalls({
      mode,
      modelId: active?.modelId,
      modelName: activeCfg?.modelName || active?.modelId,
      providerId: active?.providerId,
      providerType: activeCfg?.providerType,
      cfg: activeCfg
    });
  } catch {}
  return { preservedThinking, interleavedThinking, forceReasoning };
}

async function buildThreadContextMessages(thread) {
  const sourceContext = resolveThreadSourceContext(thread);
  const upstream = resolveThreadUpstreamText(thread);
  const upstreamText = String(upstream?.text || "");
  const anchorText = thread?.anchorText || thread?.quote || "（无）";
  const commentInstruction = [
    "你正在回复 Zion Comments 中的一个独立评论会话。以上原会话消息是被评论片段之前的上下文。",
    "请重点围绕被评论片段回答，必要时给出可执行的修改建议；不要假设你正在直接编辑主文档。",
    `锚点行：${formatThreadLineRange(thread, sourceContext)}`,
    "",
    "被评论片段：",
    anchorText
  ].join("\n");

  const messages = [];

  let upstreamMessages = [];
  try {
    upstreamMessages = parseMessages(upstreamText)
      .map((m) => ({ role: m?.role, content: m?.content }))
      .filter((m) => m?.role && typeof m.content === "string" && m.content.trim());
  } catch {
    upstreamMessages = [];
  }

  // 与主编辑器一致：把父会话文档中折叠的思考/工具桩行重建为标准 OpenAI 结构，
  // 注入到对应 assistant 消息之后（评论会话继承父会话的思考/工具上下文，但不污染主编辑器）。
  const includeToolHistory = readChatBoolDefaultTrue("chat.includeToolHistory");
  const includeThinkingHistory = readChatBoolDefaultTrue("chat.includeThinkingHistory");
  if (upstreamMessages.length && (includeToolHistory || includeThinkingHistory)) {
    try {
      const parentSessionId = thread?.parentSessionId || thread?.sessionId || "";
      const ann = parentSessionId ? getSessionAnnotations(parentSessionId) : {};
      const {
        preservedThinking,
        interleavedThinking,
        forceReasoning
      } = await resolveWidgetHistoryModelPolicy();
      upstreamMessages = reconstructWidgetHistoryMessages(upstreamMessages, upstreamText, ann, {
        includeToolHistory,
        includeThinkingHistory,
        preservedThinking,
        interleavedThinking,
        forceReasoning,
        reasoningPlaceholder: DEFAULT_REASONING_CONTENT_PLACEHOLDER
      });
    } catch {}
  }

  if (upstreamMessages.length) {
    messages.push(...upstreamMessages);
  } else if (upstreamText.trim()) {
    messages.push({
      role: "system",
      content: `原会话编辑器上文（被评论片段之前的全部内容）：\n${upstreamText}`
    });
  }
  messages.push({ role: "system", content: commentInstruction });

  return messages;
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
      const scroller = view?.scrollDOM;
      if (!list || !scroller) return false;
      const scrollerRect = scroller.getBoundingClientRect();
      if (!scrollerRect?.height) return false;

    const runTarget = getCommentRunFollowTargetRect(view);
    if (!runTarget) return false;

    const block = view.lineBlockAt?.(runTarget.pos);
    if (!block) return false;

    const contentRect = view.contentDOM.getBoundingClientRect();
    const targetScreenTop = contentRect.top + block.top;
    const targetScreenBottom = contentRect.top + block.bottom;

      const topLimit = scrollerRect.top + 24;
      const bottomLimit = scrollerRect.bottom - 28;

    let delta = 0;
    if (targetScreenBottom > bottomLimit) {
      delta = targetScreenBottom - bottomLimit;
    } else if (targetScreenTop < topLimit) {
      delta = targetScreenTop - topLimit;
    }

    if (Math.abs(delta) < 1) return false;

      const beforeScrollTop = Number(scroller.scrollTop) || 0;
      scroller.__zionProgrammaticScrollUntil = Math.max(
        Number(scroller.__zionProgrammaticScrollUntil) || 0,
        Date.now() + 900
      );
      scroller.scrollTop += delta;

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
  const run = (phase) => {
    const allowed = shouldRunScheduledCommentTail(sessionId, opts);
    if (allowed) {
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
    return;
  }
  const handle = commentEditorHandlesBySession.get(sid);
  if (!handle?.view) {
    return;
  }
  scheduleCommentThreadTailScroll(handle.view, sid, reason, opts);
}

function createThreadEditor(container, thread, onSave, onRun, onLayoutChange, onUserInteraction) {
  let saveTimer = 0;
  let disposed = false;
  const keyDisposers = [];
  const panelId = `comments:${thread.id}`;
  const sessionId = getThreadSessionId(thread);
  const initialValue = typeof thread?.body === "string" ? thread.body : "";
  let lastSavedValue = initialValue;
  const core = new EditorCore(container, initialValue, panelId, {
    lineNumbers: false,
    activeLineHighlight: false,
    folding: false
  });
  core.setSessionId(sessionId);
    try {
      core.view.dom.dataset.sessionId = sessionId;
      core.view.dom.dataset.zionSessionPersistence = "skip";
    } catch {}
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
    const saveIfChanged = () => {
      const nextValue = view.state.doc.toString();
      if (nextValue === lastSavedValue) return false;
      lastSavedValue = nextValue;
      onSave(nextValue);
      return true;
    };
  let userViewportAnchor = null;
  let suppressLayoutChangeUntil = 0;
  const captureUserViewportAnchor = () => {
    try {
      const list = view?.dom?.closest?.(".zion-comments-list");
      if (!list || !view?.contentDOM || typeof view.lineBlockAtHeight !== "function") return null;
      const listRect = list.getBoundingClientRect();
      const contentRect = view.contentDOM.getBoundingClientRect();
      if (!listRect?.height) return null;
      const screenY = Math.min(listRect.bottom - 24, listRect.top + 72);
      const docY = Math.max(0, screenY - contentRect.top);
      const block = view.lineBlockAtHeight(docY);
      if (!block) return null;
      return {
        pos: Math.max(0, Math.min(view.state.doc.length, block.from)),
        offset: Math.max(0, docY - Number(block.top || 0)),
        screenY
      };
    } catch {
      return null;
    }
  };
  const preserveDetachedViewportAnchor = (update, reason) => {
    try {
      const runState = window.zion?.state?.get?.(`chat.runs.${sessionId}`) || null;
      if (
        !runState?.streaming
        || !detachedCommentTailFollowSessions.has(sessionId)
        || !commentAnchorPreserveSessions.has(sessionId)
      ) return;
      const list = update.view?.dom?.closest?.(".zion-comments-list");
      if (!list || !update.view?.contentDOM || !userViewportAnchor) return;
      requestAnimationFrame(() => {
        try {
          if (!detachedCommentTailFollowSessions.has(sessionId) || !commentAnchorPreserveSessions.has(sessionId)) return;
          if (isCommentPanelUserScrollActive(list)) {
            userViewportAnchor = captureUserViewportAnchor() || userViewportAnchor;
            return;
          }
          const listRect = list.getBoundingClientRect();
          const contentRect = update.view.contentDOM.getBoundingClientRect();
          const block = update.view.lineBlockAt?.(userViewportAnchor.pos);
          if (!block || !listRect?.height) return;
          const targetScreenY = contentRect.top + Number(block.top || 0) + Number(userViewportAnchor.offset || 0);
          const delta = targetScreenY - Number(userViewportAnchor.screenY || 0);
          if (Math.abs(delta) < 1) return;
          markCommentListProgrammaticScroll(list, 240);
          list.scrollTop += delta;
          list.dispatchEvent(new Event("scroll"));
          userViewportAnchor = captureUserViewportAnchor() || userViewportAnchor;
        } catch {}
      });
    } catch {}
  };
    try {
      let lastCmScrollTop = Math.round(Number(view.scrollDOM?.scrollTop) || 0);
      const createdAt = Date.now();
      const markThreadScrollIntent = () => markCommentUserScrollIntent(view.scrollDOM, 900);
        const handleBoundaryKeydown = (event) => {
          const isBoundaryKey = event?.metaKey
            && !event.ctrlKey
            && !event.altKey
            && (event.key === "ArrowUp" || event.key === "ArrowDown");
          if (!isBoundaryKey) return;
          markThreadScrollIntent();
          suppressLayoutChangeUntil = Date.now() + 180;
          handleCommentEditorBoundaryKeydown(event, view);
        };
        const markThreadKeyScrollIntent = (event) => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
            markThreadScrollIntent();
          }
        };
        const passWheelToCommentsListAtBoundary = (event) => {
          try {
            const scroller = view.scrollDOM;
            if (!scroller) return;
            const deltaY = Number(event.deltaY) || 0;
            if (!deltaY || Math.abs(deltaY) < Math.abs(Number(event.deltaX) || 0)) return;
            const list = view.dom?.closest?.(".zion-comments-list");
            const panelOwnsGesture = list?.__zionWheelOwner === "panel"
              && Date.now() <= Number(list.__zionWheelOwnerUntil || 0);
            if (panelOwnsGesture) {
              // The gesture started on the panel. Keep that ownership even after
              // the pointer crosses an expanded editor, otherwise a long panel
              // scroll appears to get stuck on the editor under the pointer.
              if (!list) return;
              markCommentUserScrollIntent(list, 900);
              onUserInteraction?.("comment-panel-wheel", {
                sessionId,
                deltaY: Math.round(deltaY),
                listScrollTop: Math.round(Number(list.scrollTop) || 0)
              });
              event.preventDefault();
              event.stopPropagation();
              list.scrollTop += deltaY;
              return;
            }
            if (shouldContainCommentEditorWheel(scroller, deltaY)) {
              // A gesture that starts in the editor belongs to the editor for its
              // entire duration. At a boundary, consume the excess wheel delta.
              markThreadScrollIntent();
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            markThreadScrollIntent();
          } catch {}
        };
      const onCmScroll = () => {
        const nextCmScrollTop = Math.round(Number(view.scrollDOM?.scrollTop) || 0);
        const hasUserIntent = Date.now() <= Number(view.scrollDOM?.__zionUserScrollIntentUntil || 0);
        const isProgrammatic = Date.now() <= Number(view.scrollDOM?.__zionProgrammaticScrollUntil || 0);
        if (hasUserIntent && !isProgrammatic && Date.now() > createdAt + 500 && Math.abs(nextCmScrollTop - lastCmScrollTop) >= 2) {
          onUserInteraction?.("comment-thread-scroll", {
            sessionId,
            cmScrollTop: nextCmScrollTop
          });
        }
        userViewportAnchor = captureUserViewportAnchor() || userViewportAnchor;
        lastCmScrollTop = nextCmScrollTop;
      };
      const bindListScroll = () => {
        const list = view?.dom?.closest?.(".zion-comments-list");
        if (!list) return;
        const onListScroll = () => {
          userViewportAnchor = captureUserViewportAnchor() || userViewportAnchor;
        };
        list.addEventListener("scroll", onListScroll, { passive: true });
        keyDisposers.push(() => list.removeEventListener("scroll", onListScroll));
      };
        view.scrollDOM?.addEventListener?.("wheel", passWheelToCommentsListAtBoundary, { passive: false });
        view.scrollDOM?.addEventListener?.("wheel", markThreadScrollIntent, { passive: true });
      view.scrollDOM?.addEventListener?.("touchstart", markThreadScrollIntent, { passive: true });
        view.dom?.addEventListener?.("keydown", handleBoundaryKeydown, true);
        view.dom?.addEventListener?.("keydown", markThreadKeyScrollIntent, true);
      view.scrollDOM?.addEventListener?.("pointerdown", (event) => {
        try {
          const rect = view.scrollDOM.getBoundingClientRect();
          if (event.clientX >= rect.right - 16) markThreadScrollIntent();
        } catch {}
      }, { passive: true });
      view.scrollDOM?.addEventListener?.("scroll", onCmScroll, { passive: true });
        keyDisposers.push(() => view.scrollDOM?.removeEventListener?.("wheel", passWheelToCommentsListAtBoundary));
      keyDisposers.push(() => view.scrollDOM?.removeEventListener?.("wheel", markThreadScrollIntent));
      keyDisposers.push(() => view.scrollDOM?.removeEventListener?.("touchstart", markThreadScrollIntent));
        keyDisposers.push(() => view.dom?.removeEventListener?.("keydown", handleBoundaryKeydown, true));
        keyDisposers.push(() => view.dom?.removeEventListener?.("keydown", markThreadKeyScrollIntent, true));
      keyDisposers.push(() => view.scrollDOM?.removeEventListener?.("scroll", onCmScroll));
      requestAnimationFrame(bindListScroll);
    } catch {}
  try {
    core.addExternalExtension(EditorView.updateListener.of((update) => {
        if (userViewportAnchor && update.docChanged) {
          try {
            userViewportAnchor = {
              ...userViewportAnchor,
              pos: Math.max(0, Math.min(update.view.state.doc.length, update.changes.mapPos(userViewportAnchor.pos, 1)))
            };
          } catch {}
        }
        requestAnimationFrame(clampCommentEditorScroll);
      const suppressLayoutChange = Date.now() < suppressLayoutChangeUntil && !update.docChanged;
      if (!suppressLayoutChange && (update.docChanged || update.heightChanged || update.geometryChanged)) {
        try { requestAnimationFrame(() => onLayoutChange?.()); } catch {}
      }
        if (
          (update.docChanged || update.heightChanged || update.viewportChanged || update.geometryChanged)
          && window.zion?.state?.get?.(`chat.runs.${sessionId}`)?.streaming
        ) {
          const runState = window.zion?.state?.get?.(`chat.runs.${sessionId}`) || null;
          preserveDetachedViewportAnchor(update, "thread-stream-update");
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
        saveTimer = window.setTimeout(saveIfChanged, 250);
    }));
  } catch {}
  try {
      const runKeyboardJumpCommand = (command) => runCommentEditorCommand(view, command);
    core.addExternalExtension(Prec.highest(keymap.of([
        {
          key: "Alt-ArrowUp",
          run: () => runKeyboardJumpCommand(moveLineUp)
        },
        {
          key: "Alt-ArrowDown",
          run: () => runKeyboardJumpCommand(moveLineDown)
        },
        {
          key: "Shift-Alt-ArrowUp",
          run: () => runKeyboardJumpCommand(copyLineUp)
        },
        {
          key: "Shift-Alt-ArrowDown",
          run: () => runKeyboardJumpCommand(copyLineDown)
        },
        {
          key: "Mod-Alt-ArrowUp",
          run: () => runKeyboardJumpCommand(addCursorAbove)
        },
        {
          key: "Mod-Alt-ArrowDown",
          run: () => runKeyboardJumpCommand(addCursorBelow)
        },
      {
        key: "Mod-Enter",
        run() {
          if (isThreadStreaming(thread)) {
            try { window.zion?.commands?.executeCommand?.("chat.stop", sessionId); } catch {}
            return true;
          }
            saveIfChanged();
          onUserInteraction?.("comment-run-keyboard", { sessionId });
          onRun?.({ core, proxy, view, panelId, sessionId });
          return true;
        }
      },
      {
        key: "Escape",
        run() {
          if (!isThreadStreaming(thread)) return false;
          try { window.zion?.commands?.executeCommand?.("chat.stop", sessionId); } catch {}
          return true;
        }
      },
      {
        key: "Mod-Shift-c",
        run() {
          saveIfChanged();
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
            lastSavedValue = bodyText;
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
        try { saveIfChanged(); } catch {}
      try {
        const annotations = getSessionAnnotations(sessionId);
        if (hasThreadAnnotations(annotations) || hasThreadAnnotations(thread?.chatAnnotations)) {
          window.zion?.commands?.executeCommand?.("zion.chatCards.snapshotSession", { sessionId, panelId });
          persistThreadAnnotations(thread, getSessionAnnotations(sessionId));
        }
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
          if (bodyText !== current && (!current || current === initialValue)) {
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
  let programmaticSourceScrollUntil = 0;
  let lastUserListScrollTop = 0;

  const disposables = [];
  let renderScheduled = false;
  let lastRenderedSessionId = "";
    let lastRenderedPanelId = "";
    let syncedThreadId = "";
    let lockedSyncedThreadId = "";
    let lastSourceSyncScrollTop = NaN;
      let anchoredPanelFollowThreadId = "";
      let anchoredPanelFollowSourceScrollTop = NaN;
      let anchoredPanelFollowListScrollTop = NaN;
    let syncScheduled = false;
    let rowResizeObserver = null;
    let rowResizeAlignFrame = 0;
    let deferredEditorMountHandle = 0;
    let deferredEditorMountKind = "";
    let deferredEditorMountVersion = 0;
    let suppressPanelSyncUntil = 0;
        let restoredPanelTabUiUntil = 0;
      let suppressOutsideActiveClearUntil = 0;
      let suppressNextActiveRender = false;
    let filterKind = "all";
    let historyVisible = false;
    let pendingControlFocusSelector = "";
    let pendingToggleLayout = null;
    const expandedThreadIds = new Set();
      const panelTabUiState = new Map();
      const getPanelTabUiKey = (panelId, sessionId) => {
        const pid = String(panelId || "");
        const sid = String(sessionId || "");
        if (!pid || !sid) return "";
        return `${pid}::${sid}`;
      };
      const getSourcePanelTabUiKey = (editor = null, sessionId = "") => {
        try {
          const activeEditor = editor || getSourceEditorForCommentsPanel();
          const sid = String(sessionId || getSourceSessionIdForCommentsPanel(activeEditor) || "");
          const pid = String(activeEditor?.panelId || lastCommentSourceFocus?.panelId || "");
          return getPanelTabUiKey(pid, sid);
        } catch {
          return "";
        }
      };
        const prunePanelTabUiState = () => {
          try {
            const panels = window.zion?.panels?.list?.() || [];
            if (!panels.length || !panels.every((panel) => Array.isArray(panel?.tabs))) return;
            const openKeys = new Set();
            for (const panel of panels) {
              const panelId = String(panel?.id || "");
              if (!panelId) continue;
              for (const tab of panel.tabs || []) {
                const tabId = String(tab?.id || "");
                if (tabId) openKeys.add(getPanelTabUiKey(panelId, tabId));
              }
            }
            for (const key of Array.from(panelTabUiState.keys())) {
              if (!openKeys.has(key)) panelTabUiState.delete(key);
            }
          } catch {}
        };
        const deletePanelTabUiStateForPanel = (panelId) => {
          try {
            const prefix = `${String(panelId || "")}::`;
            if (!prefix || prefix === "::") return;
            for (const key of Array.from(panelTabUiState.keys())) {
              if (key.startsWith(prefix)) panelTabUiState.delete(key);
            }
          } catch {}
        };
      const saveCurrentPanelTabUiState = () => {
        try {
          const key = getPanelTabUiKey(lastRenderedPanelId, lastRenderedSessionId);
          if (!key) return;
          const list = root.querySelector(".zion-comments-list");
          const scrollTop = list ? Number(list.scrollTop) || 0 : Number(listScrollTop) || 0;
          listScrollTop = scrollTop;
          lastUserListScrollTop = scrollTop;
            const previous = panelTabUiState.get(key) || {};
            const threadEditorScrollTops = { ...(previous.threadEditorScrollTops || {}) };
            for (const [threadId, handle] of editorHandles.entries()) {
              try {
                const value = Number(handle?.view?.scrollDOM?.scrollTop);
                  if (!Number.isFinite(value)) continue;
                  const id = String(threadId);
                  const previousValue = Number(threadEditorScrollTops[id]);
                  if (Date.now() < restoredPanelTabUiUntil && value <= 1 && previousValue > 1) continue;
                  threadEditorScrollTops[id] = Math.max(0, value);
              } catch {}
            }
            panelTabUiState.set(key, {
            scrollTop,
            lastUserListScrollTop,
            panelFollowsSourceScroll,
            syncedThreadId,
            lockedSyncedThreadId,
            lastSourceSyncScrollTop,
            anchoredPanelFollowThreadId,
            anchoredPanelFollowSourceScrollTop,
            anchoredPanelFollowListScrollTop,
              threadEditorScrollTops,
            expandedThreadIds: Array.from(expandedThreadIds)
          });
        } catch {}
      };
      const restorePanelTabUiState = (key, activeView = null) => {
        try {
          const state = key ? panelTabUiState.get(key) : null;
          if (!state) {
            const sourceScrollTop = Number(activeView?.scrollDOM?.scrollTop);
            listScrollTop = Number.isFinite(sourceScrollTop) ? Math.max(0, sourceScrollTop) : 0;
            lastUserListScrollTop = listScrollTop;
            panelFollowsSourceScroll = true;
            syncedThreadId = "";
            lockedSyncedThreadId = "";
            lastSourceSyncScrollTop = Number.isFinite(sourceScrollTop) ? sourceScrollTop : NaN;
            anchoredPanelFollowThreadId = "";
            anchoredPanelFollowSourceScrollTop = NaN;
            anchoredPanelFollowListScrollTop = NaN;
            expandedThreadIds.clear();
            return false;
          }
          listScrollTop = Math.max(0, Number(state.scrollTop) || 0);
          lastUserListScrollTop = Math.max(0, Number(state.lastUserListScrollTop ?? state.scrollTop) || 0);
          panelFollowsSourceScroll = state.panelFollowsSourceScroll !== false;
          syncedThreadId = String(state.syncedThreadId || "");
          lockedSyncedThreadId = String(state.lockedSyncedThreadId || "");
          lastSourceSyncScrollTop = Number.isFinite(Number(state.lastSourceSyncScrollTop)) ? Number(state.lastSourceSyncScrollTop) : NaN;
          anchoredPanelFollowThreadId = String(state.anchoredPanelFollowThreadId || "");
          anchoredPanelFollowSourceScrollTop = Number.isFinite(Number(state.anchoredPanelFollowSourceScrollTop)) ? Number(state.anchoredPanelFollowSourceScrollTop) : NaN;
          anchoredPanelFollowListScrollTop = Number.isFinite(Number(state.anchoredPanelFollowListScrollTop)) ? Number(state.anchoredPanelFollowListScrollTop) : NaN;
          expandedThreadIds.clear();
          for (const id of state.expandedThreadIds || []) {
            if (id) expandedThreadIds.add(String(id));
          }
            restoredPanelTabUiUntil = Date.now() + 1200;
          return true;
        } catch {
          return false;
        }
      };
        const restoreThreadEditorScrollTop = (handle, scrollTop) => {
          try {
            const scroller = handle?.view?.scrollDOM;
            const target = Math.max(0, Number(scrollTop) || 0);
            if (!scroller) return;
            const restoreVersion = Number(scroller.__zionScrollRestoreVersion) || 0;
            const apply = () => {
              try {
                if ((Number(scroller.__zionScrollRestoreVersion) || 0) !== restoreVersion) return;
                const maxScroll = Math.max(0, Number(scroller.scrollHeight || 0) - Number(scroller.clientHeight || 0));
                const nextTop = maxScroll > 0 ? Math.min(target, maxScroll) : target;
                scroller.__zionProgrammaticScrollUntil = Math.max(
                  Number(scroller.__zionProgrammaticScrollUntil) || 0,
                  Date.now() + 500
                );
                scroller.scrollTop = nextTop;
              } catch {}
            };
            restoredPanelTabUiUntil = Math.max(restoredPanelTabUiUntil, Date.now() + 1200);
            apply();
            requestAnimationFrame(() => {
              apply();
              requestAnimationFrame(apply);
            });
            window.setTimeout(apply, 80);
            window.setTimeout(apply, 180);
          } catch {}
        };
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
      const cancelDeferredEditorMounts = () => {
        deferredEditorMountVersion += 1;
        if (!deferredEditorMountHandle) return;
        try {
          if (deferredEditorMountKind === "idle") {
            window.cancelIdleCallback?.(deferredEditorMountHandle);
          } else {
            window.clearTimeout(deferredEditorMountHandle);
          }
        } catch {}
        deferredEditorMountHandle = 0;
        deferredEditorMountKind = "";
      };
      const scheduleDeferredEditorMounts = (tasks) => {
        if (!Array.isArray(tasks) || !tasks.length) return;
        const version = deferredEditorMountVersion;
        const run = (deadline = null) => {
          deferredEditorMountHandle = 0;
          deferredEditorMountKind = "";
          if (disposed || version !== deferredEditorMountVersion) return;
          const startedAt = performance.now();
          let mounted = 0;
          while (
            tasks.length
            && (
              mounted === 0
              || (
                Number(deadline?.timeRemaining?.() || 0) > 6
                && performance.now() - startedAt < 8
              )
            )
          ) {
            const task = tasks.shift();
            try { task?.(); } catch {}
            mounted += 1;
          }
          if (!tasks.length || disposed || version !== deferredEditorMountVersion) return;
          scheduleNext();
        };
        const scheduleNext = () => {
          if (typeof window.requestIdleCallback === "function") {
            deferredEditorMountKind = "idle";
            deferredEditorMountHandle = window.requestIdleCallback(run, { timeout: 200 });
          } else {
            deferredEditorMountKind = "timeout";
            deferredEditorMountHandle = window.setTimeout(run, 16);
          }
        };
        scheduleNext();
      };
      const scheduleRowLayout = (list, view, threads, anchorById) => {
        if (rowResizeAlignFrame) return;
        rowResizeAlignFrame = window.requestAnimationFrame(() => {
          rowResizeAlignFrame = 0;
          if (disposed || !list?.isConnected || !root.contains(list)) return;
          alignCommentRowsToAnchors(list, view, threads, anchorById, "scheduled");
          updateCommentListScrollRange(list, view, "scheduled-range");
        });
      };
    const markProgrammaticListScroll = (duration = 180) => {
      programmaticListScrollUntil = Math.max(programmaticListScrollUntil, Date.now() + duration);
      markCommentListProgrammaticScroll(root.querySelector(".zion-comments-list"), duration);
    };
    const markProgrammaticSourceScroll = (view, duration = 180) => {
      try {
        programmaticSourceScrollUntil = Math.max(programmaticSourceScrollUntil, Date.now() + duration);
        if (view?.scrollDOM) {
          view.scrollDOM.__zionCommentsProgrammaticSourceScrollUntil = Math.max(
            Number(view.scrollDOM.__zionCommentsProgrammaticSourceScrollUntil) || 0,
            Date.now() + duration
          );
        }
      } catch {}
    };
    const detachCommentRunTailFollow = (reason, data = {}) => {
      try {
        if (!shouldDetachCommentTailFollow(reason)) return;
        const sessions = new Set();
        const dataSessionId = String(data?.sessionId || "");
        if (dataSessionId.startsWith("comment:")) sessions.add(dataSessionId);
        if (!sessions.size) {
          for (const sid of commentEditorHandlesBySession.keys()) {
            if (String(sid || "").startsWith("comment:")) sessions.add(String(sid));
          }
        }
        const preserveAnchor = reason === "comment-panel-scroll"
          || reason === "comment-thread-scroll"
          || reason === "comment-panel-wheel";
        for (const sid of sessions) {
          const state = window.zion?.state?.get?.(`chat.runs.${sid}`) || null;
          if (!state?.streaming) continue;
          detachedCommentTailFollowSessions.add(sid);
          if (preserveAnchor) commentAnchorPreserveSessions.add(sid);
          else commentAnchorPreserveSessions.delete(sid);
        }
      } catch {}
    };
    const syncSourceToCommentListScroll = (list) => {
      try {
        if (!list || Date.now() <= Number(list.__zionProgrammaticScrollUntil || 0)) return;
        const activeEditor = getSourceEditorForCommentsPanel();
        const activeView = activeEditor?.getView?.();
        const sessionId = getSourceSessionIdForCommentsPanel(activeEditor);
        const sourceScroller = activeView?.scrollDOM;
        if (!activeView || !sourceScroller || String(sessionId || "") !== String(lastRenderedSessionId || "")) return;
        const listDelta = Number(list.scrollTop || 0) - Number(lastUserListScrollTop || 0);
        if (!Number.isFinite(listDelta) || Math.abs(listDelta) < 1) return;
        const maxSourceScroll = Math.max(0, Number(sourceScroller.scrollHeight || 0) - Number(sourceScroller.clientHeight || 0));
        const beforeSourceTop = Number(sourceScroller.scrollTop) || 0;
        const nextSourceTop = Math.max(0, Math.min(maxSourceScroll, beforeSourceTop + listDelta));
        if (Math.abs(nextSourceTop - beforeSourceTop) < 1) return;
        markProgrammaticSourceScroll(activeView, 180);
        sourceScroller.scrollTop = nextSourceTop;
        lastSourceSyncScrollTop = nextSourceTop;
        panelFollowsSourceScroll = true;
        suppressPanelSyncUntil = 0;
      } catch {}
    };
    const pausePanelSourceFollow = (reason, data = {}) => {
      try {
        if (!panelFollowsSourceScroll) return;
        panelFollowsSourceScroll = false;
        lockedSyncedThreadId = "";
          anchoredPanelFollowThreadId = "";
          anchoredPanelFollowSourceScrollTop = NaN;
          anchoredPanelFollowListScrollTop = NaN;
        const list = root.querySelector(".zion-comments-list");
        if (list) {
          listScrollTop = Number(list.scrollTop) || 0;
          lastUserListScrollTop = listScrollTop;
        }
      } catch {}
    };
    const resumePanelSourceFollow = (reason, data = {}) => {
      try {
        const wasFollowing = panelFollowsSourceScroll;
        panelFollowsSourceScroll = true;
        suppressPanelSyncUntil = 0;
        lastSourceSyncScrollTop = NaN;
        if (data?.threadId) {
          syncedThreadId = String(data.threadId || "");
          lockedSyncedThreadId = syncedThreadId;
          anchoredPanelFollowThreadId = syncedThreadId;
          anchoredPanelFollowSourceScrollTop = NaN;
          anchoredPanelFollowListScrollTop = NaN;
        }
        if (!data?.threadId) {
          requestAnimationFrame(() => {
            try { syncListToSourceViewport(); } catch {}
          });
        }
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
      const captureAnchoredPanelFollowBaseline = (threadId, list, view) => {
        try {
          const id = String(threadId || "");
          const sourceScrollTop = Number(view?.scrollDOM?.scrollTop);
          const panelScrollTop = Number(list?.scrollTop);
          if (!id || !Number.isFinite(sourceScrollTop) || !Number.isFinite(panelScrollTop)) return;
          anchoredPanelFollowThreadId = id;
          anchoredPanelFollowSourceScrollTop = sourceScrollTop;
          anchoredPanelFollowListScrollTop = panelScrollTop;
          lastSourceSyncScrollTop = sourceScrollTop;
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
            captureAnchoredPanelFollowBaseline(threadId, list, view);
            suppressPanelSyncUntil = 0;
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
              const thread = readAllThreads().find((item) => item?.id === id) || null;
              const editor = thread ? (getEditorForThread(thread) || getSourceEditorForCommentsPanel()) : getSourceEditorForCommentsPanel();
              captureAnchoredPanelFollowBaseline(id, root.querySelector(".zion-comments-list"), editor?.getView?.());
          }
          return true;
        } catch {
          return false;
        }
      };
      const isAnchorNearSourceViewport = (view, anchor) => {
        try {
          if (!view?.scrollDOM || !anchor) return false;
          const sourceScrollTop = Number(view.scrollDOM.scrollTop) || 0;
          const viewportHeight = Math.max(1, Number(view.scrollDOM.clientHeight) || 1);
          const anchorY = getCommentAnchorY(view, anchor, 0);
          if (!Number.isFinite(anchorY)) return false;
          const viewportY = anchorY - sourceScrollTop;
          return viewportY >= -viewportHeight * 0.75 && viewportY <= viewportHeight * 1.25;
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
          pendingLocatedThreadId = threadId;
          schedule({ force: true });
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
    const isCommentEditorHandleStreaming = (handle) => {
      try {
        const sessionId = String(handle?.sessionId || "");
        return !!(sessionId && window.zion?.state?.get?.(`chat.runs.${sessionId}`)?.streaming);
      } catch {
        return false;
      }
    };
    const disposeCommentEditors = (opts = {}) => {
      const preserveStreaming = opts?.preserveStreaming === true;
      const preserveThreadIds = opts?.preserveThreadIds instanceof Set
        ? opts.preserveThreadIds
        : new Set();
      const preserved = new Map();
      for (const [threadId, handle] of editorHandles.entries()) {
        if (
          (preserveStreaming && isCommentEditorHandleStreaming(handle))
          || preserveThreadIds.has(threadId)
        ) {
          preserved.set(threadId, handle);
          continue;
        }
        try { handle?.dispose?.(); } catch {}
      }
      editorHandles.clear();
      for (const [threadId, handle] of preserved.entries()) {
        editorHandles.set(threadId, handle);
      }
      updateRunActions.clear();
      if (lastCommentsEditorHandle && !Array.from(preserved.values()).includes(lastCommentsEditorHandle)) {
        lastCommentsEditorHandle = null;
      }
      return preserved;
    };
    const activateSourcePanelFromPayload = (payload) => {
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
        saveCurrentPanelTabUiState();
        const sourceEditor = rememberSourcePanelSession(payloadPanelId, payloadSessionId);
        if (!sourceEditor) return;
        if (payloadSessionId === lastRenderedSessionId && payloadPanelId === lastRenderedPanelId) {
          return;
        }
      }
      if (Date.now() < suppressPanelSyncUntil) {
        return;
      }
      schedule({ force: true });
    };
    try { disposables.push(window.zion?.events?.on?.("panel/tabActivated", (payload) => {
      activateSourcePanelFromPayload(payload);
    })); } catch {}
    try { disposables.push(window.zion?.events?.on?.("panel/focusChanged", (payload) => {
      activateSourcePanelFromPayload(payload);
    })); } catch {}
    try { disposables.push(window.zion?.events?.on?.("session/afterSwitch", (payload) => {
      activateSourcePanelFromPayload(payload);
    })); } catch {}
      try { disposables.push(window.zion?.events?.on?.("panel/tabsChanged", () => {
        prunePanelTabUiState();
      })); } catch {}
      try { disposables.push(window.zion?.events?.on?.("panel/closed", (payload) => {
        deletePanelTabUiStateForPanel(payload?.panelId);
      })); } catch {}
  const refreshRunAction = (payload) => {
    if (disposed) return;
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
      const commentList = root.querySelector(".zion-comments-list");
      const panelUserIntentActive = isCommentPanelUserScrollActive(commentList);
      if (Date.now() <= programmaticSourceScrollUntil) {
        return;
      }
      if (panelUserIntentActive) {
        return;
      }
      if (!panelFollowsSourceScroll) {
        panelFollowsSourceScroll = true;
        suppressPanelSyncUntil = 0;
      }
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
      if (Date.now() < suppressOutsideActiveClearUntil) return;
      try {
        const activeThread = getActiveThread();
        const activeSessionId = activeThread ? getThreadSessionId(activeThread) : "";
        // Keep the active comment thread stable while it is still streaming.
        // Otherwise an outside focus change triggers a panel rerender, which
        // disposes the live comment editor instance mid-response.
        if (activeThread && isThreadStreaming(activeThread)) return;
      } catch {}
      if (window.zion?.state?.get?.(ACTIVE_KEY)) {
        suppressNextActiveRender = true;
        setActiveThread("");
        updateActiveThreadClasses("");
      }
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
    const closeHistoryPopover = (event) => {
      if (!historyVisible) return;
      if (event?.type === "keydown") {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        pendingControlFocusSelector = ".js-comments-history";
      } else if (event?.target && root.querySelector(".zion-comments-header")?.contains?.(event.target)) {
        return;
      }
      historyVisible = false;
      schedule({ force: true });
    };
    try {
      document.addEventListener("pointerdown", closeHistoryPopover, true);
      document.addEventListener("keydown", closeHistoryPopover, true);
      disposables.push({
        dispose: () => {
          document.removeEventListener("pointerdown", closeHistoryPopover, true);
          document.removeEventListener("keydown", closeHistoryPopover, true);
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
      cancelDeferredEditorMounts();
      try { rowResizeObserver?.disconnect?.(); } catch {}
      if (rowResizeAlignFrame) {
        try { window.cancelAnimationFrame(rowResizeAlignFrame); } catch {}
        rowResizeAlignFrame = 0;
      }
          saveCurrentPanelTabUiState();
        disposeCommentEditors();
      for (const d of disposables.splice(0)) {
        try { d?.dispose?.(); } catch {}
      }
      try { root.remove(); } catch {}
    }
  };

  function render() {
    if (disposed) return;
    cancelDeferredEditorMounts();
    try { rowResizeObserver?.disconnect?.(); } catch {}
    rowResizeObserver = null;
    if (rowResizeAlignFrame) {
      try { window.cancelAnimationFrame(rowResizeAlignFrame); } catch {}
      rowResizeAlignFrame = 0;
    }
    const previousList = root.querySelector(".zion-comments-list");
    const previousVisualAnchor = (() => {
      try {
        if (!previousList) return null;
        const listRect = previousList.getBoundingClientRect();
        const rows = Array.from(previousList.querySelectorAll(".zion-comments-row[data-thread-id]"));
        const preferredRow = pendingToggleLayout?.threadId
          ? rows.find((item) => item.dataset.threadId === pendingToggleLayout.threadId)
          : null;
        const row = preferredRow || rows.find((item) => {
          const rect = item.getBoundingClientRect();
          return rect.bottom > listRect.top && rect.top < listRect.bottom;
        });
        if (!row) return null;
        const rect = row.getBoundingClientRect();
        return {
          threadId: String(row.dataset.threadId || ""),
          offsetTop: Number(rect.top) - Number(listRect.top)
        };
      } catch {
        return null;
      }
    })();
    if (previousList) listScrollTop = previousList.scrollTop;
      if (previousList) saveCurrentPanelTabUiState();
    const activeEditor = getSourceEditorForCommentsPanel();
    const activeView = activeEditor?.getView?.();
    const sessionId = getSourceSessionIdForCommentsPanel(activeEditor);
      const panelId = String(activeEditor?.panelId || "");
      const nextUiKey = getPanelTabUiKey(panelId, sessionId);
      const prevUiKey = getPanelTabUiKey(lastRenderedPanelId, lastRenderedSessionId);
      const switchingPanelTab = !!prevUiKey && nextUiKey !== prevUiKey;
        const restoredPanelTabUiThisRender = switchingPanelTab && restorePanelTabUiState(nextUiKey, activeView);
    lastRenderedSessionId = String(sessionId || "");
      lastRenderedPanelId = panelId;
    let threads = getThreadsForSession(sessionId);
      if (recentLocatedThreadId && !threads.some((item) => item?.id === recentLocatedThreadId)) {
        recentLocatedThreadId = "";
      }
      const preservedEditors = disposeCommentEditors({
        preserveStreaming: true,
        preserveThreadIds: new Set(
          threads
            .filter((item) => expandedThreadIds.has(item.id))
            .map((item) => item.id)
        )
      });
    root.replaceChildren();

    const anchorById = new Map();
      const sourceDocText = activeView?.state?.doc?.toString?.() || "";
    for (const item of threads) {
        anchorById.set(
          item.id,
          activeView ? locateThreadAnchor(activeView, item, sourceDocText) : null
        );
    }
    threads = sortThreadsByDocumentOrder(threads, anchorById);
    const stateActive = getActiveThread();
    const active = stateActive && threads.some((item) => item.id === stateActive.id) ? stateActive : null;
    const allThreads = threads;
    const openCount = allThreads.filter((item) => !item.resolved).length;
      const streamingCount = allThreads.filter((item) => !item.resolved && isThreadStreaming(item)).length;
      const completedCount = allThreads.filter((item) => {
        if (item.resolved || isThreadStreaming(item)) return false;
        return !!String(item.summary || item.body || "").trim();
      }).length;
      const resolvedCount = allThreads.filter((item) => !!item.resolved).length;
    const filteredThreads = allThreads.filter((item) => {
      const anchor = anchorById.get(item.id);
        if (filterKind === "streaming") return !item.resolved && isThreadStreaming(item);
        if (filterKind === "completed") {
          return !item.resolved && !isThreadStreaming(item) && !!String(item.summary || item.body || "").trim();
        }
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
      suppressPanelSyncUntil = 0;
      syncedThreadId = next.id;
      lockedSyncedThreadId = next.id;
      lastSourceSyncScrollTop = NaN;
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
    const historyItems = allThreads.map((item) => {
      const anchor = anchorById.get(item.id);
      const status = item.resolved ? "resolved" : !anchor ? "lost" : getThreadRunStatus(item);
      const dotClass = status === "resolved" ? "is-resolved" : status === "lost" ? "is-lost" : `is-${status}`;
      const lineText = anchor ? `L${anchor.startLine + 1}${anchor.endLine > anchor.startLine ? `-${anchor.endLine + 1}` : ""}` : t("threadStatus.lost", "Anchor missing");
      const title = compactText(item.title || item.quote || item.anchorText || t("row.fallback", "Comment"), 64);
      return `
          <button class="zion-comments-popover-item is-${dotClass.replace("is-", "")}" data-thread-id="${escapeHtml(item.id)}" type="button" title="${escapeHtml(t("history.jump", "Jump to comment"))}">
          <span class="zion-comments-popover-dot ${dotClass}"></span>
          <span class="zion-comments-popover-item-text">
            <span class="zion-comments-popover-item-title">${escapeHtml(title)}</span>
            <span class="zion-comments-popover-item-meta">${escapeHtml(`${lineText} · ${threadRunStatusTitle(status)}`)}</span>
          </span>
            <span class="zion-comments-popover-item-jump" aria-hidden="true">${iconSvg("chevron")}</span>
        </button>`;
    }).join("");
    header.innerHTML = `
      <div class="zion-comments-header-left">
        <button class="zion-comments-hdr-btn js-comments-history${historyVisible ? " is-active" : ""}" type="button" title="${escapeHtml(t("title", "Comments"))}" aria-haspopup="true" aria-expanded="${historyVisible ? "true" : "false"}">
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
        <button class="zion-comments-hdr-btn js-comments-collapse-all" type="button" title="${escapeHtml(t("thread.collapse", "Collapse editor"))}">
          ${iconSvg("fold")}
        </button>
        <button class="zion-comments-hdr-btn js-comments-expand-all" type="button" title="${escapeHtml(t("thread.expand", "Expand editor"))}">
          ${iconSvg("unfold")}
          </button>
        </div>
        <div class="zion-comments-stats" role="group" aria-label="${escapeHtml(t("header.subtitle", "Anchored comments in the source document"))}">
          <button class="zion-comments-stat${filterKind === "all" ? " is-active" : ""}" data-stat-filter="all" type="button">
            <strong>${escapeHtml(String(allThreads.length))}</strong><span>${escapeHtml(t("stats.all", "All {count}", { count: allThreads.length }).replace(String(allThreads.length), "").trim())}</span>
          </button>
          <button class="zion-comments-stat${streamingCount ? " is-streaming" : ""}${filterKind === "streaming" ? " is-active" : ""}" data-stat-filter="streaming" type="button" ${streamingCount ? "" : "disabled"}>
            <strong>${escapeHtml(String(streamingCount))}</strong><span>${escapeHtml(t("stats.streaming", "{count} answering", { count: streamingCount }).replace(String(streamingCount), "").trim())}</span>
          </button>
          <button class="zion-comments-stat${filterKind === "completed" ? " is-active" : ""}" data-stat-filter="completed" type="button" ${completedCount ? "" : "disabled"}>
            <strong>${escapeHtml(String(completedCount))}</strong><span>${escapeHtml(t("stats.completed", "{count} completed", { count: completedCount }).replace(String(completedCount), "").trim())}</span>
          </button>
          <button class="zion-comments-stat${filterKind === "resolved" ? " is-active" : ""}" data-stat-filter="resolved" type="button" ${resolvedCount ? "" : "disabled"}>
            <strong>${escapeHtml(String(resolvedCount))}</strong><span>${escapeHtml(t("stats.resolved", "{count} resolved", { count: resolvedCount }).replace(String(resolvedCount), "").trim())}</span>
          </button>
        </div>`;
    root.appendChild(header);
    const popover = document.createElement("div");
    popover.className = `zion-comments-popover${historyVisible ? " is-visible" : ""}`;
    popover.setAttribute("aria-label", t("history.jump", "Jump to comment"));
    popover.innerHTML = `
      <div class="zion-comments-popover-head">
          <div>
            <strong>${escapeHtml(t("title", "Comments"))}</strong>
            <span>${escapeHtml(t("header.subtitle", "Anchored comments in the source document"))}</span>
          </div>
          <span class="zion-comments-popover-total">${escapeHtml(`${allThreads.length}`)}</span>
      </div>
        <div class="zion-comments-popover-list">${historyItems || `<div class="zion-comments-popover-empty">${escapeHtml(allThreads.length ? t("history.emptyFiltered", "No comments match this filter") : t("empty.title", "No comment threads yet"))}</div>`}</div>`;
    header.appendChild(popover);
    header.querySelector(".js-comments-history")?.addEventListener("click", (event) => {
      event.stopPropagation();
      historyVisible = !historyVisible;
      pendingControlFocusSelector = historyVisible
        ? ".zion-comments-popover-item"
        : ".js-comments-history";
      schedule({ force: true });
    });
    header.querySelector(".js-comments-prev")?.addEventListener("click", (event) => {
      event.stopPropagation();
      pendingControlFocusSelector = ".js-comments-prev";
      resumePanelSourceFollow("nav-previous");
      navigateThread(-1);
    });
    header.querySelector(".js-comments-next")?.addEventListener("click", (event) => {
      event.stopPropagation();
      pendingControlFocusSelector = ".js-comments-next";
      resumePanelSourceFollow("nav-next");
      navigateThread(1);
    });
    header.querySelector(".js-comments-collapse-all")?.addEventListener("click", (event) => {
      event.stopPropagation();
      pendingControlFocusSelector = ".js-comments-collapse-all";
      expandedThreadIds.clear();
          saveCurrentPanelTabUiState();
      schedule({ force: true });
    });
    header.querySelector(".js-comments-expand-all")?.addEventListener("click", (event) => {
      event.stopPropagation();
      pendingControlFocusSelector = ".js-comments-expand-all";
      for (const item of filteredThreads) expandedThreadIds.add(item.id);
          saveCurrentPanelTabUiState();
      schedule({ force: true });
    });
      header.querySelectorAll(".zion-comments-stat[data-stat-filter]").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          if (button.disabled) return;
          filterKind = String(button.dataset.statFilter || "all");
          historyVisible = false;
          pendingControlFocusSelector = `.zion-comments-stat[data-stat-filter="${cssEscape(filterKind)}"]`;
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
      recentLocatedThreadId = "";
    };
    const markListKeyScrollIntent = (event) => {
      try {
        if (event?.target?.closest?.(".zion-comments-thread-editor")) return;
      } catch {}
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        markListScrollIntent();
      }
    };
    const trackWheelGestureOwner = (event) => {
      try {
        const deltaY = Number(event.deltaY) || 0;
        if (!deltaY || Math.abs(deltaY) < Math.abs(Number(event.deltaX) || 0)) return;
        const nowTs = Date.now();
        const target = event.target;
        const startedInEditor = !!target?.closest?.(".zion-comments-thread-editor");
        const ownerActive = nowTs <= Number(list.__zionWheelOwnerUntil || 0);
        // Preserve ownership for one continuous gesture. A fresh wheel gesture
        // over an editor deliberately belongs to that editor; any gesture that
        // began outside belongs to the panel even after crossing an editor.
        if (!ownerActive) list.__zionWheelOwner = startedInEditor ? "editor" : "panel";
        else if (!startedInEditor) list.__zionWheelOwner = "panel";
        list.__zionWheelOwnerUntil = nowTs + COMMENT_WHEEL_GESTURE_IDLE_MS;
      } catch {}
    };
    list.addEventListener("wheel", trackWheelGestureOwner, { capture: true, passive: true });
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
        syncSourceToCommentListScroll(list);
      }
      lastUserListScrollTop = nextTop;
        saveCurrentPanelTabUiState();
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
    const deferredEditorMounts = [];
    const eagerExpandedThreadId = String(
      pendingFocusThreadId
      || (
        active?.id
        && (expandedThreadIds.has(active.id) || pendingExpandThreadId === active.id)
        && active.id
      )
      || (
        syncedThreadId
        && (expandedThreadIds.has(syncedThreadId) || pendingExpandThreadId === syncedThreadId)
        && syncedThreadId
      )
      || (
        anchoredPanelFollowThreadId
        && (
          expandedThreadIds.has(anchoredPanelFollowThreadId)
          || pendingExpandThreadId === anchoredPanelFollowThreadId
        )
        && anchoredPanelFollowThreadId
      )
      || filteredThreads.find((item) =>
        (expandedThreadIds.has(item.id) || pendingExpandThreadId === item.id)
        && isThreadStreaming(item)
      )?.id
      || filteredThreads.find((item) =>
        expandedThreadIds.has(item.id) || pendingExpandThreadId === item.id
      )?.id
      || ""
    );
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
          suppressPanelSyncUntil = 0;
          suppressOutsideActiveClearUntil = Date.now() + 700;
          focusEditorSource(item, { reveal: true });
          requestAnimationFrame(() => {
            const sourceEditor = getEditorForThread(item);
            revealThreadAnchor(item, { focus: true, editor: sourceEditor, smooth: false });
              requestAnimationFrame(() => {
                try { alignLocatedThreadToSourceViewport(item.id, row); } catch {}
              });
          });
        };
        row.addEventListener("pointerdown", (event) => {
          if (!shouldRevealSourceFromCommentItemPointer(event, isExpanded)) return;
          suppressNextActiveRender = String(window.zion?.state?.get?.(ACTIVE_KEY) || "") !== String(item.id || "");
          setActiveThread(item.id);
          updateActiveThreadClasses(item.id);
        });
          row.addEventListener("focusin", () => {
            suppressNextActiveRender = String(window.zion?.state?.get?.(ACTIVE_KEY) || "") !== String(item.id || "");
            setActiveThread(item.id);
            updateActiveThreadClasses(item.id);
          });
        row.addEventListener("click", revealSourceFromItem);
      list.appendChild(row);

        const activeAnchor = anchor;

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
        let mountExpandedEditor = null;
          const expandThread = () => {
            if (expandedThreadIds.has(item.id)) return;
            expandedThreadIds.add(item.id);
            setActiveThread(item.id);
                saveCurrentPanelTabUiState();
            schedule({ force: true });
          };
          const collapseThread = () => {
            if (!expandedThreadIds.has(item.id)) return;
            expandedThreadIds.delete(item.id);
            setActiveThread(item.id);
                saveCurrentPanelTabUiState();
            schedule({ force: true });
          };
            const quoteToggle = quote.querySelector(".zion-comments-quote-toggle");
            quoteToggle?.addEventListener("pointerdown", (event) => {
              try { event.stopPropagation(); } catch {}
            });
            quoteToggle?.addEventListener("click", (event) => {
            try { event.preventDefault(); } catch {}
            try { event.stopPropagation(); } catch {}
            pendingControlFocusSelector = `.zion-comments-row[data-thread-id="${cssEscape(item.id)}"] .zion-comments-quote-toggle`;
            const listRect = list.getBoundingClientRect();
            const headerRect = editorHeader.getBoundingClientRect();
            const sourceScrollTop = Number(activeView?.scrollDOM?.scrollTop) || 0;
            pendingToggleLayout = {
              threadId: String(item.id || ""),
              headerOffset: Number(headerRect.top) - Number(listRect.top),
              sourceScrollTop
            };
            lastSourceSyncScrollTop = sourceScrollTop;
            suppressPanelSyncUntil = Date.now() + 500;
            if (expandedThreadIds.has(item.id)) collapseThread();
            else expandThread();
            });
        const runAction = makeAction("play", () => {
            if (!isExpanded) {
              expandThread();
              return;
            }
          if (isThreadStreaming(item)) stopThread(item);
          else {
            if (!threadEditorHandle) mountExpandedEditor?.();
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
        actions.appendChild(makeAction("external", () => {
          if (isExpanded && !threadEditorHandle) mountExpandedEditor?.();
          promoteThread(item, threadEditorHandle);
        }, "", t("thread.promote", "Promote to standalone session")));

        const editorHost = document.createElement("div");
        editorHost.className = "zion-comments-editor";
        editorFrame.appendChild(editorHost);
        const editorThread = applyThreadPayload(item, threadPayloadCache.get(String(item?.id || "")));
        const renderSummary = (sourceThread) => {
          const summaryText = getThreadSummaryText(sourceThread, item.quote || item.anchorText || "");
          const latestAt = getThreadLatestAt(sourceThread);
          const latestText = formatCompactTime(latestAt);
          const latestTitle = formatThreadTimeTitle(latestAt);
          const isUpdating = isThreadSummaryUpdating(sourceThread);
          const updatedLabel = latestText
            ? t("threadMeta.updated", "Updated {time}", { time: latestText }).replace("{time}", latestText)
            : "";
          const summary = createThreadSummaryView(
            summaryText || t("thread.emptySummary", "No comment yet. Expand to start the conversation."),
            !summaryText
          );
          editorHost.replaceChildren(summary);
          if (isUpdating || updatedLabel) {
            const meta = document.createElement("div");
            meta.className = `zion-comments-summary-meta${isUpdating ? " is-updating" : ""}`;
            if (isUpdating) {
              const spinner = document.createElement("span");
              spinner.className = "zion-comments-summary-spinner";
              spinner.setAttribute("aria-hidden", "true");
              meta.appendChild(spinner);
              meta.appendChild(document.createTextNode(t("threadMeta.updating", "Updating summary...")));
            } else {
              meta.textContent = updatedLabel;
              if (latestTitle) meta.title = latestTitle;
            }
            editorHost.appendChild(meta);
          }
        };
        if (isExpanded) {
          const preservedHandle = preservedEditors.get(item.id) || null;
          mountExpandedEditor = () => {
            if (
              threadEditorHandle
              || disposed
              || !editorHost.isConnected
              || !expandedThreadIds.has(item.id)
            ) {
              return threadEditorHandle;
            }
            editorHost.removeAttribute("aria-busy");
            editorHost.replaceChildren();
            const hydratedThread = applyThreadPayload(
              item,
              threadPayloadCache.get(String(item?.id || ""))
            );
            threadEditorHandle = createThreadEditor(editorHost, hydratedThread, (bodyText) => {
              patchThread(item.id, { body: bodyText }, { silent: true });
            }, (handle) => runThread(item, handle), () => {
              scheduleRowLayout(list, activeView, threads, anchorById);
            }, (reason, data = {}) => {
              if (reason === "comment-thread-scroll") {
                detachCommentRunTailFollow(reason, {
                  threadId: item.id,
                  sessionId: getThreadSessionId(item),
                  ...data
                });
                if (Number.isFinite(Number(data?.cmScrollTop))) {
                  const state = panelTabUiState.get(nextUiKey) || {};
                  const threadEditorScrollTops = { ...(state.threadEditorScrollTops || {}) };
                  threadEditorScrollTops[item.id] = Math.max(0, Number(data.cmScrollTop) || 0);
                  panelTabUiState.set(nextUiKey, { ...state, threadEditorScrollTops });
                }
                saveCurrentPanelTabUiState();
              }
            });
            editorHandles.set(item.id, threadEditorHandle);
            const restoredThreadScrollTop = Number(
              panelTabUiState.get(nextUiKey)?.threadEditorScrollTops?.[item.id]
            );
            if (Number.isFinite(restoredThreadScrollTop)) {
              restoreThreadEditorScrollTop(threadEditorHandle, restoredThreadScrollTop);
            }
            if (!lastCommentsEditorHandle || isActive) {
              lastCommentsEditorHandle = threadEditorHandle;
            }
            if (pendingFocusThreadId === item.id && threadEditorHandle?.view) {
              pendingFocusThreadId = "";
              scheduleFocusCommentThreadEditor(threadEditorHandle, { forceFocus: true });
            }
            scheduleRowLayout(list, activeView, threads, anchorById);
            return threadEditorHandle;
          };
          if (preservedHandle) {
            threadEditorHandle = preservedHandle;
            try { editorHost.appendChild(preservedHandle.view.dom); } catch {}
          } else if (item.id === eagerExpandedThreadId || isThreadStreaming(item)) {
            mountExpandedEditor();
          } else {
            editorHost.setAttribute("aria-busy", "true");
            renderSummary(editorThread);
            const mountOnInteraction = () => mountExpandedEditor?.();
            editorHost.addEventListener("pointerdown", mountOnInteraction, { once: true });
            editorHost.addEventListener("focusin", mountOnInteraction, { once: true });
            deferredEditorMounts.push(mountExpandedEditor);
          }
        } else {
          renderSummary(editorThread);
          loadThreadPayload(item).then((payload) => {
            if (
              disposed
              || !editorHost.isConnected
              || !payload
              || typeof payload !== "object"
              || expandedThreadIds.has(item.id)
            ) {
              return;
            }
            renderSummary(applyThreadPayload(item, payload));
            scheduleRowLayout(list, activeView, threads, anchorById);
          });
        }
        editorHandles.set(item.id, threadEditorHandle);
        setEditorFrameExpanded(row, editorFrame, threadEditorHandle, isExpanded);
        if (isExpanded && threadEditorHandle && (!lastCommentsEditorHandle || isActive)) {
          lastCommentsEditorHandle = threadEditorHandle;
        }
    }
    scheduleDeferredEditorMounts(deferredEditorMounts);
      alignCommentRowsToAnchors(list, activeView, threads, anchorById, "render");
      updateCommentListScrollRange(list, activeView, "render-range");
      markProgrammaticListScroll(180);
      list.scrollTop = listScrollTop;
      if (
        previousVisualAnchor?.threadId
        && !switchingPanelTab
        && !pendingRevealThreadId
        && !pendingLocatedThreadId
      ) {
        try {
          const anchoredRow = list.querySelector(
            `.zion-comments-row[data-thread-id="${cssEscape(previousVisualAnchor.threadId)}"]`
          );
          const listRect = list.getBoundingClientRect();
          const rowRect = anchoredRow?.getBoundingClientRect?.();
          if (rowRect) {
            const currentOffset = Number(rowRect.top) - Number(listRect.top);
            const delta = currentOffset - Number(previousVisualAnchor.offsetTop || 0);
            if (Math.abs(delta) >= 1) {
              markProgrammaticListScroll(180);
              list.scrollTop += delta;
              listScrollTop = Number(list.scrollTop) || 0;
            }
          }
        } catch {}
      }
      const toggleLayoutForRender = pendingToggleLayout;
      const restoreToggleLayoutAnchor = (finish = false) => {
        try {
          if (!toggleLayoutForRender || pendingToggleLayout !== toggleLayoutForRender) return false;
          const toggleRow = list.querySelector(
            `.zion-comments-row[data-thread-id="${cssEscape(toggleLayoutForRender.threadId)}"]`
          );
          const toggleHeader = toggleRow?.querySelector?.(".zion-comments-editor-header");
          const rowHeaderRect = toggleHeader?.getBoundingClientRect?.();
          const listRect = list.getBoundingClientRect();
          if (!rowHeaderRect) {
            if (finish && pendingToggleLayout === toggleLayoutForRender) {
              suppressPanelSyncUntil = 0;
              pendingToggleLayout = null;
            }
            return false;
          }
          const currentSourceScrollTop = Number(activeView?.scrollDOM?.scrollTop) || 0;
          const sourceDelta = currentSourceScrollTop - Number(toggleLayoutForRender.sourceScrollTop || 0);
          const targetOffset = Number(toggleLayoutForRender.headerOffset || 0) - sourceDelta;
          const currentOffset = Number(rowHeaderRect.top) - Number(listRect.top);
          const delta = currentOffset - targetOffset;
          if (Math.abs(delta) >= 1) {
            markProgrammaticListScroll(240);
            list.scrollTop += delta;
          }
          listScrollTop = Number(list.scrollTop) || 0;
          lastUserListScrollTop = listScrollTop;
          if (finish) {
            captureAnchoredPanelFollowBaseline(
              toggleLayoutForRender.threadId,
              list,
              activeView
            );
            panelFollowsSourceScroll = true;
            suppressPanelSyncUntil = 0;
            pendingToggleLayout = null;
          }
          return true;
        } catch {
          if (finish && pendingToggleLayout === toggleLayoutForRender) {
            suppressPanelSyncUntil = 0;
            pendingToggleLayout = null;
          }
          return false;
        }
      };
      restoreToggleLayoutAnchor();
      if (typeof window.ResizeObserver === "function") {
        const observedList = list;
        rowResizeObserver = new window.ResizeObserver((entries) => {
          if (
            disposed
            || !recentLocatedThreadId
            || !observedList.isConnected
            || !entries?.length
          ) {
            return;
          }
          scheduleRowLayout(observedList, activeView, threads, anchorById);
        });
        for (const row of list.querySelectorAll(".zion-comments-row[data-thread-id]")) {
          rowResizeObserver.observe(row);
        }
      }
      lastUserListScrollTop = Number(list.scrollTop) || 0;
      if (pendingControlFocusSelector) {
        const focusSelector = pendingControlFocusSelector;
        pendingControlFocusSelector = "";
        requestAnimationFrame(() => {
          try {
            const target = root.querySelector(focusSelector)
              || root.querySelector(".js-comments-history");
            target?.focus?.({ preventScroll: true });
          } catch {}
        });
      }
    const finalLayoutAlignId = String(
      pendingRevealThreadId
      || pendingLocatedThreadId
      || recentLocatedThreadId
      || ""
    );
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
          if (disposed || !list.isConnected || !root.contains(list)) return;
        alignCommentRowsToAnchors(list, activeView, threads, anchorById, "render-frame");
        updateCommentListScrollRange(list, activeView, "render-frame-range");
        if (toggleLayoutForRender && pendingToggleLayout === toggleLayoutForRender) {
          restoreToggleLayoutAnchor();
          requestAnimationFrame(() => {
            alignCommentRowsToAnchors(list, activeView, threads, anchorById, "toggle-settle");
            updateCommentListScrollRange(list, activeView, "toggle-settle-range");
            restoreToggleLayoutAnchor(true);
          });
        } else if (!restoredPanelTabUiThisRender && Date.now() > restoredPanelTabUiUntil) {
          syncListToSourceViewport();
        }
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
        if (isCommentPanelUserScrollActive(list)) {
          listScrollTop = Number(list.scrollTop) || 0;
          lastUserListScrollTop = listScrollTop;
          return;
        }
        if (pendingRevealThreadId || pendingLocatedThreadId) {
          listScrollTop = list.scrollTop;
          lastUserListScrollTop = Number(list.scrollTop) || 0;
          return;
        }
        if (Date.now() < suppressPanelSyncUntil) {
          listScrollTop = list.scrollTop;
          lastUserListScrollTop = Number(list.scrollTop) || 0;
          return;
        }
        if (!panelFollowsSourceScroll) {
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
        let nextId = pickThreadForViewport(activeView, threads, anchorById);
        if (lockedSyncedThreadId) {
          const lockedAnchor = anchorById.get(lockedSyncedThreadId);
          if (isAnchorNearSourceViewport(activeView, lockedAnchor)) {
            nextId = lockedSyncedThreadId;
          } else {
            lockedSyncedThreadId = "";
              anchoredPanelFollowThreadId = "";
              anchoredPanelFollowSourceScrollTop = NaN;
              anchoredPanelFollowListScrollTop = NaN;
          }
        }
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
            const effectiveThread = syncedThreadId ? threads.find((item) => item?.id === syncedThreadId) : null;
            const effectiveSessionId = effectiveThread ? getThreadSessionId(effectiveThread) : "";
            const hasAnchoredBaseline = !!anchoredPanelFollowThreadId
              && anchoredPanelFollowThreadId === lockedSyncedThreadId
              && Number.isFinite(anchoredPanelFollowSourceScrollTop)
              && Number.isFinite(anchoredPanelFollowListScrollTop);
            const hasSourceDelta = Number.isFinite(lastSourceSyncScrollTop);
            const effectiveRunState = effectiveSessionId
              ? window.zion?.state?.get?.(`chat.runs.${effectiveSessionId}`)
              : null;
            if (hasSourceDelta && Math.abs(sourceDelta) >= 2 && effectiveRunState?.streaming) {
              detachCommentRunTailFollow("source-viewport-scroll", {
                threadId: effectiveThread?.id || syncedThreadId || "",
                sessionId: effectiveSessionId,
                sourceDelta: Math.round(sourceDelta)
              });
            }
            const nextScrollTop = hasAnchoredBaseline
              ? Math.max(0, Math.min(maxScrollTop, anchoredPanelFollowListScrollTop + (sourceScrollTop - anchoredPanelFollowSourceScrollTop)))
              : Math.max(0, Math.min(maxScrollTop, hasSourceDelta ? beforeScrollTop + sourceDelta : sourceScrollTop));
            if (Math.abs(nextScrollTop - beforeScrollTop) >= 1) {
              markProgrammaticListScroll(120);
              list.scrollTop = nextScrollTop;
            }
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

function comparableThreadAnnotations(annotations) {
  const normalized = normalizeThreadAnnotations(annotations);
  delete normalized.savedAt;
  return normalized;
}

function hasThreadAnnotations(annotations) {
  const comparable = comparableThreadAnnotations(annotations);
  return comparable.tools.length > 0
    || comparable.thinking.length > 0
    || Object.keys(comparable).some((key) => key !== "tools" && key !== "thinking");
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
  const patch = {};
  if (thread.threadSessionId !== sessionId) patch.threadSessionId = sessionId;
  try {
    if (
      JSON.stringify(comparableThreadAnnotations(thread.chatAnnotations))
      !== JSON.stringify(comparableThreadAnnotations(nextAnnotations))
    ) {
      patch.chatAnnotations = nextAnnotations;
    }
  } catch {
    patch.chatAnnotations = nextAnnotations;
  }
  const liveBody = getLiveThreadBodyForSession(sessionId);
  if (typeof liveBody === "string" && liveBody !== String(thread?.body ?? "")) patch.body = liveBody;
  if (Object.keys(patch).length) patchThread(thread.id, patch, { silent: true });
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

function scheduleFocusCommentThreadEditor(handle, opts = {}) {
  if (!handle?.view) return false;
  const forceFocus = opts?.forceFocus !== false;
  const focus = () => {
    try { handle?.proxy?.focus?.(); } catch {}
    return focusThreadUserPrompt(handle.view, { forceFocus, schedule: false });
  };
  focus();
  try {
    requestAnimationFrame(() => {
      focus();
      requestAnimationFrame(focus);
    });
  } catch {
    setTimeout(focus, 0);
  }
  try { setTimeout(focus, 80); } catch {}
  return true;
}

export function focusThreadUserPrompt(view, opts = {}) {
  if (!view) return false;
  const forceFocus = !!opts?.forceFocus;
  const shouldSchedule = opts?.schedule !== false;
  const shouldKeepFocus = () => {
    if (forceFocus) return true;
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
      return true;
    } catch {}
    return false;
  };
  const focused = focus();
  if (shouldSchedule) {
    try {
      requestAnimationFrame(() => requestAnimationFrame(focus));
    } catch {
      setTimeout(focus, 0);
    }
  }
  return focused;
}

const summarizeInflight = new Set();
const titleInflight = new Set();

function isThreadSummaryUpdating(thread) {
  return summarizeInflight.has(String(thread?.id || ""));
}

function refreshFoldedSummaryState(threadId) {
  try {
    const id = String(threadId || "");
    if (!id) return;
    const row = document.querySelector(`.zion-comments-row[data-thread-id="${cssEscape(id)}"]`);
    if (row && !row.classList.contains("is-expanded")) emitChanged();
  } catch {}
}

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
      requestSource: "comments-title",
      silentReasoning: true
    });
    if (err) throw err;

    const title = cleanThreadTitle(out);
    if (!title) return;
    const latest = readAllThreads().find((item) => item?.id === id) || thread;
    if (latest?.titleAuto === false) return;
    patchThread(id, { title, titleAuto: true, titleUpdatedAt: now() }, { silent: true });
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
      if (isContinuationBoundaryLine(line)) {
        flush();
        role = "user";
        content = [];
        spanFrom = lineEnd + 1;
        spanTo = lineEnd + 1;
        offset = lineEnd + 1;
        continue;
      }

      if (roleMatch) {
        const body = roleMatch[1] === "assistant"
          ? stripAssistantBlockIdComment(roleMatch[2] || "")
          : (roleMatch[2] || "");
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

function mapTranscriptSpansToMessages(spans, messages) {
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const mapping = new Map();
  let searchFrom = 0;
  for (const span of spans) {
    const spanText = normalize(span?.content);
    if (!spanText) continue;
    let matchedIndex = -1;
    for (let i = searchFrom; i < messages.length; i++) {
      const message = messages[i];
      if (span?.role && message?.role && span.role !== message.role) continue;
      const messageText = normalize(messageContentText(message));
      if (
        messageText
        && (
          messageText === spanText
          || messageText.includes(spanText)
          || spanText.includes(messageText)
        )
      ) {
        matchedIndex = i;
        break;
      }
    }
    if (matchedIndex < 0) continue;
    mapping.set(span, matchedIndex);
    searchFrom = matchedIndex + 1;
  }
  return mapping;
}

export function getCommentSummaryInsertionBoundary(messages, targetIndex) {
  if (!Array.isArray(messages) || targetIndex < 0 || targetIndex >= messages.length) {
    return -1;
  }
  let boundary = targetIndex;
  const target = messages[targetIndex];
  if (target?.role !== "assistant" || !Array.isArray(target?.tool_calls) || !target.tool_calls.length) {
    return boundary;
  }
  while (boundary + 1 < messages.length && messages[boundary + 1]?.role === "tool") {
    boundary += 1;
  }
  return boundary;
}

export function insertCommentSummariesIntoMessages(messages, editor) {
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
  const spanMessageIndices = mapTranscriptSpansToMessages(spans, baseMessages);

  const insertAfter = new Map();
  const unmatched = [];

  for (const entry of entries) {
    const anchorFrom = Number(entry.anchorFrom);
    const anchorTo = Number(entry.anchorTo);
    const containingSpan = spans.find((item) => {
      if (!Number.isFinite(anchorFrom) || !Number.isFinite(anchorTo)) return false;
      return item.from <= anchorTo && item.to >= anchorFrom;
    });
    const span = containingSpan || [...spans].reverse().find((item) => item.to <= anchorTo);
    const spanText = normalize(span?.content || "");
    const firstLine = String(entry.anchorText || "").split("\n").find((l) => l.trim()) || entry.anchorText || "";
    const snippet = normalize(firstLine).slice(0, 120);
    let target = Number(spanMessageIndices.get(span));
    if (!Number.isInteger(target)) target = -1;
    if (target < 0 && spanText) {
      for (let i = 0; i < normalizedMsgs.length; i++) {
        if (span?.role && baseMessages[i]?.role && span.role !== baseMessages[i].role) continue;
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
      const boundary = getCommentSummaryInsertionBoundary(baseMessages, target);
      if (!insertAfter.has(boundary)) insertAfter.set(boundary, []);
      insertAfter.get(boundary).push(summaryMsg);
    } else {
      unmatched.push(summaryMsg);
    }
  }

  if (insertAfter.size === 0 && !unmatched.length) return messages;

  const out = [];
  for (let i = 0; i < baseMessages.length; i++) {
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
  refreshFoldedSummaryState(id);
  try {
    const anchorText = String(thread?.anchorText || thread?.quote || "").slice(0, 800);
    const excerpt = transcript.length > 12000
      ? `${transcript.slice(0, 6000)}\n\n[中间部分省略]\n\n${transcript.slice(-6000)}`
      : transcript;
    const messages = [
      {
        role: "system",
        content: [
          "你是 Zion Comments 的局部工作记忆总结器，不是聊天助手。",
          "这条总结会在后续主会话请求中，被插入到被评论内容所在 message 的下方，作为模型继续工作的局部上下文。",
          "任务：把下面围绕某段被评论内容展开的评论对话，整理成一份可恢复、可继续执行的结构化工作结果。",
          "",
          "输出契约：",
          "1. Context Brief: 这条评论关注的局部问题或背景。",
          "2. Work Result: 已达成的结论、修改方向、设计取舍或约束。",
          "3. Evidence: 对话中支撑结论的关键依据；没有则写“无明确证据”。",
          "4. Next Actions: 后续处理该被评论内容时应记住的动作、注意事项或未决问题；没有则写“无”。",
          "",
          "要求：",
          "- 必须使用上述英文标题作为 Markdown 小节标题，方便后续解析和阅读。",
          "- 每个小节可以写 1-3 句；保留具体文件、行为、约束、验证结果和未决事项等关键细节，不要为了追求短而丢失信息。",
          "- 不要复述完整对话过程，不要写“用户问/助手答”。",
          "- 不要编造对话里没有的信息。",
          "- 输出应与 Zion Agents 的结构化结果保持一致：完整但聚焦，能够让后续主会话据此继续工作。"
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
      requestSource: "comments-summary",
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
    refreshFoldedSummaryState(id);
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
      window.zion?.state?.set?.(`chat.followLatest.${threadSessionId}`, false);
      window.zion?.state?.set?.(`chat.followSuppressUntil.${threadSessionId}`, Date.now() + 300);
    } catch {}
    const contextMessages = await buildThreadContextMessages(thread);
    const threadLogTitle = getThreadLogTitle(thread);
    await window.zion?.commands?.executeCommand?.("chat.run", {
      editor,
      sessionId: threadSessionId,
      panelId: handle?.panelId || `comments:${thread.id}`,
      title: threadLogTitle ? `评论 · ${threadLogTitle}` : "",
      displayName: threadLogTitle,
      sourceTitle: thread?.sourceTitle || "",
      source: {
        pluginId: "dev.comments",
        kind: "comment",
        id: String(thread?.id || threadSessionId)
      },
      metadata: {
        commentId: String(thread?.id || ""),
        threadId: String(thread?.id || ""),
        commentTitle: threadLogTitle,
        sourceTitle: String(thread?.sourceTitle || ""),
        parentSessionId: String(thread?.parentSessionId || thread?.sessionId || "")
      },
      skipSessionPersistence: true,
      autoInsertUserPrompt: false,
      autoFocusUserPrompt: false,
      autoScrollAssistant: false,
      followLatest: false,
      moveSelectionToAssistant: false,
      usageSessionId: thread.parentSessionId || thread.sessionId,
      requestSource: "comments",
      contextMessages
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
  resetThreadStorageRuntime();
  try { await migrateLegacyThreadPayloadStorage(); } catch {}
  try { await hydrateThreadRecordArchive({ emitChanged: false }); } catch {}
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) disposables.push(disp);
  } catch {}

  disposables.push(window.zion.commands.registerCommand("comments.openPanel", openCommentsPanel));
  disposables.push(window.zion.commands.registerCommand("comments.revealThread", (threadId, opts = {}) => revealThread(threadId, opts)));
  disposables.push(window.zion.commands.registerCommand("comments.activateThread", (threadId) => {
    const id = String(threadId || "");
    if (!id) return false;
    const thread = readAllThreads().find((item) => String(item?.id || "") === id);
    if (!thread) return false;
    setActiveThread(id);
    pendingLocatedThreadId = id;
    openCommentsPanel();
    signalCommentThreadLocated(id, "inspector-preview");
    return true;
  }));
  disposables.push(window.zion.commands.registerCommand("comments.listThreadRelations", () =>
    readAllThreads().map((thread) => ({
      id: String(thread?.id || ""),
      sessionId: String(thread?.sessionId || ""),
      parentSessionId: String(thread?.parentSessionId || thread?.sessionId || ""),
      threadSessionId: getThreadSessionId(thread),
      title: String(thread?.title || ""),
      summary: String(thread?.summary || ""),
      quote: String(thread?.quote || ""),
      anchorText: String(thread?.anchorText || ""),
      startLine: Number(thread?.startLine),
      from: Number(thread?.from),
      resolved: thread?.resolved === true,
      createdAt: Number(thread?.createdAt) || 0,
      updatedAt: Number(thread?.updatedAt) || 0,
      titleUpdatedAt: Number(thread?.titleUpdatedAt) || 0,
      summaryUpdatedAt: Number(thread?.summaryUpdatedAt) || 0
    }))
  ));
  disposables.push(window.zion.commands.registerCommand("comments.getSourceAnchors", (opts = {}) => {
    const sessionId = String(opts?.sessionId || "");
    const sourceText = String(opts?.sourceText || "");
    if (!sessionId) return [];
    const activeId = String(window.zion?.state?.get?.(ACTIVE_KEY) || "");
    return getThreadsForSession(sessionId)
      .filter((thread) => !thread?.resolved && thread?.anchorKind !== "lost")
      .map((thread) => {
        const resolved = thread?.anchorKind === "range"
          ? resolveStoredRangeAnchor(sourceText, thread)
          : {
              from: Math.max(0, Math.min(sourceText.length, Number(thread?.from) || 0)),
              to: Math.max(0, Math.min(sourceText.length, Number(thread?.to) || Number(thread?.from) || 0))
            };
        if (!resolved) return null;
        return {
          id: String(thread.id || ""),
          from: Number(resolved.from) || 0,
          to: Math.max(Number(resolved.from) || 0, Number(resolved.to) || Number(resolved.from) || 0),
          active: String(thread.id || "") === activeId
        };
      })
      .filter(Boolean);
  }));
  disposables.push(window.zion.commands.registerCommand("comments.getThreadContextMessages", async (opts = {}) => {
    try {
      const threadId = String(opts?.threadId || "").trim();
      const sessionId = String(opts?.sessionId || "").trim();
      const panelId = String(opts?.panelId || "").trim();
      const fallbackThreadId = panelId.startsWith("comments:") ? panelId.slice("comments:".length) : "";
      const targetId = threadId || fallbackThreadId;
      const thread = targetId
        ? readAllThreads().find((item) => String(item?.id || "") === targetId)
        : readAllThreads().find((item) => getThreadSessionId(item) === sessionId);
      if (!thread) return [];
      return await buildThreadContextMessages(thread);
    } catch {
      return [];
    }
  }));
  disposables.push(window.zion.commands.registerCommand("comments.createFromSelection", () => {
    return createThreadFromEditor(window.zion?.window?.activeEditor || null);
  }));
  disposables.push(window.zion.commands.registerCommand("comments.focusEditor", focusCommentEditor));
  disposables.push(window.zion.commands.registerCommand("comments.focusSource", () => focusEditorSource(getActiveThread())));
  try {
    const inspectorSource = window.zion?.events?.on?.("ui/inspectorTextSourceActivated", (payload) => {
      const sessionId = String(payload?.sessionId || "");
      if (!sessionId) return;
      if (payload?.editor) {
        rememberSourceFocus(payload.editor);
      } else {
        lastCommentSourceFocus = {
          panelId: "inspector",
          sessionId,
          anchor: null,
          head: null
        };
      }
      emitChanged();
    });
    if (inspectorSource) disposables.push(inspectorSource);
  } catch {}
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
              commentAnchorPreserveSessions.delete(sid);
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
          if (!allowFollow) {
              if ((eventName === "chat/runFinished" || eventName === "chat/runError") && sid) {
                detachedCommentTailFollowSessions.delete(sid);
                commentAnchorPreserveSessions.delete(sid);
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
              commentAnchorPreserveSessions.delete(sid);
              commentRunFollowTargetsBySession.delete(sid);
            }
        });
        if (disp) disposables.push(disp);
      }
    } catch {}
  try {
    const flushCommentAnnotations = () => {
      try {
          flushLiveAnchorPersistence();
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
      if (ctx?.sourceKind === "inspector") return true;
      const panelId = ctx?.view?.dom?.closest?.("[data-panel-id]")?.getAttribute?.("data-panel-id") || "";
      return !String(panelId).startsWith("comments:");
    },
    run: (ctx) => {
      if (ctx?.sourceKind === "inspector" && !ctx?.view) {
        return createThreadFromInspectorText(ctx);
      }
      const editor = ctx?.view
        ? window.zion?.editor?.getEditorForView?.(ctx.view)
        : ctx?.getEditor?.();
      const view = ctx?.view || editor?.getView?.();
      if (!view) return null;
      return createThreadFromSelection({ ...ctx, view, editor });
    }
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
  disposables.push(installPanelCommentButtons());

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
    const inspectorDecorator = window.zion.inspector?.registerTextEditorDecorator?.({
      id: "dev.comments.inspectorAnchors",
      priority: 50,
      createExtension(editor) {
        return installCommentAnchors(editor);
      }
    });
    if (inspectorDecorator) disposables.push(inspectorDecorator);
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
