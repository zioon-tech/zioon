import { workbenchStorage as localStorage, spaceScopedName, isSharedWorkbenchDocument, sharedDocumentEditable } from "../../src/runtime/workbench-space";
import { currentAccountSession } from "../../packages/account-ui/src/client";
import { registerSessionTools } from "./session-tools.js";
import { deriveSessionTitleFromContent } from "../../packages/runtime-client/src/session-title.mjs";
import { localSessionAnnotationCopy } from "../../packages/runtime-client/src/session-annotations.mjs";
import {
  clearMigratedBrowserSessions,
  readBrowserSessionCandidate
} from "./storage/browser-migration.js";
import { createSessionDocRepo } from "./storage/docs.js";
import { catalogResponseIsCurrent, hydrateSessionCatalog } from "./storage/catalog.js";
import {
  deleteRemoteSession,
  hydrateRemoteAnnotations,
  deleteRemoteFolder,
  forkRemoteChatSession,
  migrateBrowserSessionStorage,
  readRemoteActiveRun,
  readRemoteRunEvent,
  readRemoteTree,
  readRemoteSession,
  readRemoteSessionMetadata,
  readRemoteSessionKV,
  readRemoteCatalog,
  searchRemoteSessions,
  readRemoteStatus,
  subscribeRemoteEvents,
  updateRemoteRuntimeSession,
  writeRemoteSession,
  writeRemoteSessionKV,
  writeRemoteTree
} from "./storage/remote.js";
import { createSessionRealtimeSync } from "./storage/realtime.js";
import { createSessionMutationQueue } from "./storage/mutation-queue.js";
import { createSessionConflictNotifications } from "./storage/conflict-notifications.js";
import {
  classifySessionStorageError,
  sessionStorageFailureMessage
} from "./storage/errors.js";
import {
  createSessionTagIndex,
  getIndexedSessionTags,
  removeSessionTagIndexEntry,
  sessionTagIndexContentsEqual,
  updateSessionTagIndex,
  validateSessionTagIndex
} from "./model/session-tag-index.js";
import { normalizeTagPath, validateCatalog } from "./model/tag-catalog.js";
import { createSessionUrlModel } from "./model/url.js";
import { createSessionTreeModel } from "./model/tree.js";
import { createSharedSessionView, isReceivedNode } from "./model/shared-view.js";
import { createSharedSessionMover } from "./model/shared-move.js";
import { createSessionUIStateModel } from "./model/ui-state.js";
import { createAnnotationsLifecycle } from "./features/annotations-lifecycle.js";
import { applyAnnotationsForSessionImpl } from "./features/annotations-apply.js";
import { beginSessionPresentation } from "../../src/session/presentation.ts";
import {
  createChatCardWriterLeases,
  shouldPersistChatCardInBackground
} from "./features/chat-card-writer.js";
import { createPageTitleManager } from "./features/page-title.js";
import { createChatAutoRenameTrigger } from "./features/chat-auto-rename.js";
import { removeDeletedSessions } from "./features/deleted-sessions.js";
import { createSessionDeletionController } from "./features/deletion-controller.js";
import { deleteSelectedSessions } from "./commands/delete-selected.js";
import { registerSessionAutoRenameCommand } from "./commands/auto-rename.js";
import { registerSessionSidebarCommands } from "./commands/sidebar.js";
import { registerSessionFlushCommand } from "./commands/flush.js";
import { createSessionReloadPreparation } from "./commands/prepare-reload.js";
import { registerSessionDocCommands } from "./commands/doc-apis.js";
import { registerSessionTagExclusionCommands } from "./commands/tag-exclusions.js";
import { registerSessionTreeCommands } from "./commands/tree-apis.js";
import { createSessionAutoSavePlugin } from "./editor/autosave-plugin.js";
import {
  createSessionCollaborationManager
} from "./collaboration-client.js";
import { renderSessionsTagHeader } from "./ui/sidebar-header.js";
import { createSessionsSidebarViewManager } from "./ui/sidebar-view.js";
import { createSessionsPanelManager } from "./ui/panel.js";
import { createSessionsListRendererFactory } from "./ui/list-renderer.js";
import { extractDocumentLeadPreview } from "../shared/session-preview.js";
import { markSessionRunViewed } from "./features/run-state.js";
import {
  observeLlmRequestWorkbenchEvent
} from "../../src/runtime/llm-request-observability.ts";
import {
  planAssistantMarkerInsertionById,
  thinkingMarkerText,
  toolMarkerText
} from "../../src/chat/restore";
import { resolveToolCardId } from "../../src/chat/tool-card-id";
import { SessionDocumentRuntime } from "../../src/session/document-runtime";

const I18N_NS = "dev.session-manager";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.sessions": "会话",
    "cmd.new": "新建会话",
    "cmd.newInFolder": "会话：在指定文件夹中新建",
    "cmd.newInFolder.description": "选择目标文件夹并创建新会话",
    "cmd.saveAsNew": "另存为新会话",
    "cmd.rename": "重命名会话",
    "cmd.autoRename": "AI 重命名会话",
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
    "ui.newFolder": "新建文件夹",
    "ui.actions": "操作",
    "ui.toggleViewMode": "切换列表/卡片视图",
    "ui.toggleTagSplit": "切换标签分栏",
    "ui.import": "导入会话",
    "ui.exportAll": "导出全部会话",
    "ui.exportSelected": "导出所选项",
    "ui.close": "关闭",
    "ui.closePanel": "关闭会话面板",
    "ui.sort": "排序",
    "ui.sortSessions": "排序会话",
    "ui.sortUpdated": "按更新时间排序（最新在前）",
    "ui.sortTitle": "按标题排序（A 到 Z）",
    "ui.moreActions": "更多操作",
    "ui.selectedCount": "已选择 {count} 项",
    "ui.updated": "更新于",
    "ui.chars": "{count} 字符",
    "ui.justNow": "刚刚",
    "ui.minutesAgo": "{count} 分钟前",
    "ui.hoursAgo": "{count} 小时前",
    "ui.daysAgo": "{count} 天前",
    "ui.noSessionsYet": "暂无会话。",
    "ui.noMatchingSessions": "没有匹配的会话",
    "ui.cancel": "取消",
    "ui.delete": "删除",
    "ui.deleting": "删除中",
    "ui.deleteWaitingNetwork": "等待网络恢复",
    "ui.deleteSelectedConfirm": "确认删除选中的 {count} 项？删除后无法撤销。",
    "ui.deleteConfirm": "确认删除？",
    "ui.openNewTab": "在新标签页打开",
    "ui.rename": "重命名",
    "ui.autoRename": "自动重命名",
    "ui.clone": "克隆",
    "ui.export": "导出",
    "ui.renameFolder": "重命名文件夹",
    "ui.exportFolder": "导出文件夹",
    "ui.deleteFolder": "删除文件夹",
    "ui.deleteFolderConfirm": "确认删除文件夹？",
    "ui.deleteSessionConfirm": "确认删除会话？",
    "ui.newSessionHere": "在此新建会话",
    "ui.newFolderHere": "在此新建文件夹",
    "ui.moveToRoot": "移到最外层",
    "ui.folderActions": "文件夹操作",
    "ui.folderName": "文件夹名称",
    "ui.sessionTitle": "会话标题",
    "ui.fork": "分叉会话",
    "ui.refresh": "刷新",
    "ui.comment": "评论",
    "ui.commentOpen": "未解决",
    "ui.commentResolved": "已解决",
    "ui.agentTask": "子 Agent",
    "ui.expandChildren": "展开评论和子 Agent",
    "ui.collapseChildren": "折叠评论和子 Agent",
    "ui.modelGenerating": "正在生成",
    "ui.answerReady": "回答完成，待查看",
    "ui.answerFailed": "会话异常结束，待查看",
    "ui.answerStopped": "会话已停止，待查看",
    "dialog.newTitle": "新会话标题",
    "dialog.rename": "重命名会话",
    "dialog.deleteSelected": "删除所选项",
    "heatmap.activity": "活动",
    "heatmap.expand": "展开热力图",
    "heatmap.collapse": "折叠热力图",
    "heatmap.previous35Days": "查看更早的 35 天",
    "heatmap.next35Days": "查看之后的 35 天",
    "heatmap.previousDays": "查看更早日期",
    "heatmap.nextDays": "查看之后日期",
    "heatmap.filterRange": "按日期范围筛选会话",
    "heatmap.clear": "清除",
    "heatmap.all": "全部",
    "heatmap.today": "今天",
    "heatmap.last1Day": "1 天",
    "heatmap.last3Days": "3 天",
    "heatmap.last7Days": "7 天",
    "heatmap.last14Days": "14 天",
    "heatmap.last30Days": "30 天",
    "heatmap.clearTitle": "清除日期筛选，显示全部会话",
    "heatmap.todayTitle": "跳到今天并筛选今天",
    "heatmap.allRange": "全部 · {range}",
    "heatmap.dayTitle": "{day} · {sessions} 个会话 · {tokens} tok · {cost}",
    "heatmap.dayTitleNoCost": "{day} · {sessions} 个会话 · {tokens} tok",
    "heatmap.costNA": "cost n/a",
    "heatmap.sessions": "会话",
    "heatmap.tokens": "Token",
    "heatmap.cache": "缓存",
    "heatmap.cost": "费用",
    "heatmap.noModelUsage": "当天没有模型消耗",
    "tags.title": "标签",
    "tags.addTag": "新建标签",
    "tags.addChild": "新建子标签",
    "tags.rename": "重命名",
    "tags.pin": "置顶",
    "tags.unpin": "取消置顶",
    "tags.delete": "删除",
    "tags.automatic": "自动",
    "tags.automaticSource": "自动标签 · {source}",
    "tags.ignoreMatches": "在匹配会话中忽略",
    "tags.ignoreConfirmSubtree": "在 {sessions} 个会话中忽略 {tags} 个标签（包含子标签）？",
    "tags.ignoreYes": "忽略",
    "tags.ignoreDone": "已在 {sessions} 个会话中忽略 {tags} 个标签",
    "tags.tagName": "标签名称",
    "tags.noMatches": "未找到匹配标签",
    "tags.deleteYes": "删除",
    "tags.deleteConfirmLeaf": "从 {count} 个会话中移除该标签？",
    "tags.deleteConfirmSubtree": "删除 {children} 个子标签，并从 {count} 个会话中移除引用？",
    "tags.searchTags": "搜索标签",
    "tags.expand": "展开标签",
    "tags.collapse": "折叠标签",
    "tags.empty": "暂无标签",
    "tags.clear": "清除",
    "tags.clearTitle": "清除标签筛选",
    "tags.expandNode": "展开 {tag}",
    "tags.collapseNode": "折叠 {tag}",
    "tags.filterTitle": "按 {tag} 筛选会话"
  },
  "en-US": {
    "category.sessions": "Sessions",
    "cmd.new": "New Session",
    "cmd.newInFolder": "Sessions: New in Folder",
    "cmd.newInFolder.description": "Choose a target folder and create a new session",
    "cmd.saveAsNew": "Save As New Session",
    "cmd.rename": "Rename Session",
    "cmd.autoRename": "AI Rename Session",
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
    "ui.newFolder": "New Folder",
    "ui.actions": "Actions",
    "ui.toggleViewMode": "Toggle list/card view",
    "ui.toggleTagSplit": "Toggle tag column",
    "ui.import": "Import Sessions",
    "ui.exportAll": "Export All Sessions",
    "ui.exportSelected": "Export Selected",
    "ui.close": "Close",
    "ui.closePanel": "Close sessions panel",
    "ui.sort": "Sort",
    "ui.sortSessions": "Sort sessions",
    "ui.sortUpdated": "Sort by updated (newest first)",
    "ui.sortTitle": "Sort by title (A to Z)",
    "ui.moreActions": "More actions",
    "ui.selectedCount": "{count} Selected",
    "ui.updated": "Updated",
    "ui.chars": "{count} chars",
    "ui.justNow": "Just now",
    "ui.minutesAgo": "{count} min ago",
    "ui.hoursAgo": "{count} hr ago",
    "ui.daysAgo": "{count} days ago",
    "ui.noSessionsYet": "No sessions yet.",
    "ui.noMatchingSessions": "No matching sessions.",
    "ui.cancel": "Cancel",
    "ui.delete": "Delete",
    "ui.deleting": "Deleting",
    "ui.deleteWaitingNetwork": "Waiting for connection",
    "ui.deleteSelectedConfirm": "Delete {count} selected item(s)? This cannot be undone.",
    "ui.deleteConfirm": "Delete?",
    "ui.openNewTab": "Open in New Tab",
    "ui.rename": "Rename",
    "ui.autoRename": "Auto Rename",
    "ui.clone": "Clone",
    "ui.export": "Export",
    "ui.renameFolder": "Rename Folder",
    "ui.exportFolder": "Export Folder",
    "ui.deleteFolder": "Delete Folder",
    "ui.deleteFolderConfirm": "Delete folder?",
    "ui.deleteSessionConfirm": "Delete session?",
    "ui.newSessionHere": "New session here",
    "ui.newFolderHere": "New folder here",
    "ui.moveToRoot": "Move to top level",
    "ui.folderActions": "Folder actions",
    "ui.folderName": "Folder name",
    "ui.sessionTitle": "Session title",
    "ui.fork": "Fork Session",
    "ui.refresh": "Refresh",
    "ui.comment": "Comment",
    "ui.commentOpen": "Open",
    "ui.commentResolved": "Resolved",
    "ui.agentTask": "Sub-agent",
    "ui.expandChildren": "Expand comments and sub-agents",
    "ui.collapseChildren": "Collapse comments and sub-agents",
    "ui.modelGenerating": "Generating answer",
    "ui.answerReady": "Answer ready to review",
    "ui.answerFailed": "Answer failed; review needed",
    "ui.answerStopped": "Answer stopped; review needed",
    "dialog.newTitle": "New session title",
    "dialog.rename": "Rename session",
    "dialog.deleteSelected": "Delete selected",
    "heatmap.activity": "Activity",
    "heatmap.expand": "Expand heatmap",
    "heatmap.collapse": "Collapse heatmap",
    "heatmap.previous35Days": "View earlier 35 days",
    "heatmap.next35Days": "View next 35 days",
    "heatmap.previousDays": "View earlier days",
    "heatmap.nextDays": "View next days",
    "heatmap.filterRange": "Filter sessions by date range",
    "heatmap.clear": "Clear",
    "heatmap.all": "All",
    "heatmap.today": "Today",
    "heatmap.last1Day": "1d",
    "heatmap.last3Days": "3d",
    "heatmap.last7Days": "7d",
    "heatmap.last14Days": "14d",
    "heatmap.last30Days": "30d",
    "heatmap.clearTitle": "Clear date filter and show all sessions",
    "heatmap.todayTitle": "Jump to today and filter today",
    "heatmap.allRange": "All · {range}",
    "heatmap.dayTitle": "{day} · {sessions} sessions · {tokens} tok · {cost}",
    "heatmap.dayTitleNoCost": "{day} · {sessions} sessions · {tokens} tok",
    "heatmap.costNA": "cost n/a",
    "heatmap.sessions": "sessions",
    "heatmap.tokens": "tokens",
    "heatmap.cache": "cache",
    "heatmap.cost": "cost",
    "heatmap.noModelUsage": "No model usage on this day",
    "tags.title": "Tags",
    "tags.addTag": "New tag",
    "tags.addChild": "New child tag",
    "tags.rename": "Rename",
    "tags.pin": "Pin",
    "tags.unpin": "Unpin",
    "tags.delete": "Delete",
    "tags.automatic": "Automatic",
    "tags.automaticSource": "Automatic tag · {source}",
    "tags.ignoreMatches": "Ignore in matching sessions",
    "tags.ignoreConfirmSubtree": "Ignore {tags} tags, including descendants, in {sessions} sessions?",
    "tags.ignoreYes": "Ignore",
    "tags.ignoreDone": "Ignored {tags} tags in {sessions} sessions",
    "tags.tagName": "Tag name",
    "tags.noMatches": "No matching tags",
    "tags.deleteYes": "Delete",
    "tags.deleteConfirmLeaf": "Remove this tag from {count} sessions?",
    "tags.deleteConfirmSubtree": "Delete {children} child tags and remove references from {count} sessions?",
    "tags.searchTags": "Search tags",
    "tags.expand": "Expand tags",
    "tags.collapse": "Collapse tags",
    "tags.empty": "No tags yet",
    "tags.clear": "Clear",
    "tags.clearTitle": "Clear tag filter",
    "tags.expandNode": "Expand {tag}",
    "tags.collapseNode": "Collapse {tag}",
    "tags.filterTitle": "Filter sessions by {tag}"
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
const LS_LAST = "zion.sessions.lastActiveId";
const LS_AUTO = "zion.autosave";
const LS_FOLDER_OPEN = "zion.sessions.folderOpen";
const URL_SESSION = "zionSession";
const URL_SESSION_ALT = "session";
const PENDING_INLINE_EDIT_KEY = "sessions.pendingInlineEdit";
const INTENTIONAL_RELOAD_KEY = "sessions.intentionalReload";
const RELOAD_PREPARING_KEY = "sessions.reloadPreparing";
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

let storageWarningNotification = null;
let storageWarningLastShownAt = 0;
let storageWarningCount = 0;
let storageWarningKey = "";
const reportedStorageErrors = new WeakSet();

function findStorageWarningNotification() {
  try {
    const marked = document.querySelector("[data-zion-session-storage-warning]");
    if (marked) return marked;
    return Array.from(document.querySelectorAll(".zion-notification"))
      .find((item) => String(item.textContent || "").includes("Sessions storage write failed")) || null;
  } catch {
    return null;
  }
}

function clearStorageWarning() {
  try {
    const warnings = Array.from(document.querySelectorAll(
      "[data-zion-session-storage-warning], .zion-notification"
    ));
    for (const item of warnings) {
      const legacy = String(item.textContent || "").includes("Sessions storage write failed");
      if (legacy || item.hasAttribute("data-zion-session-storage-warning")) item.remove();
    }
  } catch {}
  storageWarningNotification = null;
  storageWarningLastShownAt = 0;
  storageWarningCount = 0;
  storageWarningKey = "";
  try { window.zion?.state?.set("sessions.storageError", null); } catch {}
  try { window.zion?.state?.set("sessions.storageUnavailable", false); } catch {}
}

const loggedStorageFailures = new WeakSet();
/** One queue failure can reject many document/tree/meta waiters. Log it once. */
function warnStorageIssue(where, error, options = {}) {
  try {
    if (error && typeof error === "object") {
      // Queue failures also reach saveMeta/saveDoc callers. Report once.
      if (reportedStorageErrors.has(error)) return;
      reportedStorageErrors.add(error);
    }
    const issue = classifySessionStorageError(error);
    const operation = String(where).startsWith("load") ? "read" : "write";
    console.error(`[sessions] storage ${operation} failed at`, where, issue);
    storageWarningCount += 1;
    try {
      window.zion?.state?.set("sessions.storageError", {
        where,
        error: issue.kind,
        ...issue,
        retrying: options.retrying === true && issue.retryable,
        count: storageWarningCount,
        at: now()
      });
    } catch {}
    try {
      window.zion?.state?.set("sessions.storageUnavailable",
        !["conflict", "too-large", "rejected"].includes(issue.kind));
    } catch {}
    if (options.notify === false) return;
    try {
      if (
        window.zion?.state?.get(RELOAD_PREPARING_KEY) === true
        || window.zion?.state?.get(INTENTIONAL_RELOAD_KEY) === true
      ) return;
    } catch {}
    storageWarningNotification = storageWarningNotification?.isConnected
      ? storageWarningNotification
      : findStorageWarningNotification();
    const hasVisibleWarning = storageWarningNotification?.isConnected === true;
    const recentlyShown = now() - storageWarningLastShownAt < 30000;
    const warningKey = `${issue.kind}:${operation}:${options.mutationType || "session"}:${options.background === true}:${options.retrying === true}`;
    if (storageWarningKey === warningKey && (hasVisibleWarning || recentlyShown)) return;
    if (hasVisibleWarning) storageWarningNotification.remove();
    try {
      storageWarningKey = warningKey;
      storageWarningLastShownAt = now();
      storageWarningNotification = window.zion?.notification?.show?.(
        sessionStorageFailureMessage(error, { ...options, operation }), {
        type: "warning",
        duration: 12000,
        dismissible: true
      });
      try { storageWarningNotification?.setAttribute?.("data-zion-session-storage-warning", "true"); } catch {}
    } catch {}
  } catch {}
}

/** ======== Durable Workbench session storage (Zion Runtime PostgreSQL) ======== */
const DB_NAME = spaceScopedName("zion.sessions.db");
let remoteSnapshotQueue = Promise.resolve();
let remoteStorageOnline = false;
let remoteSyncTimer = 0;
// Only a fully applied catalog confirms the account-wide storage revision.
// A session receipt or an event may include changes this client has not read.
let remoteCatalogRevision = null;
let remoteEventCursor = 0;
let remoteRealtimeSync = null;
const durableSessionIds = new Set();
const remoteSessionRevisions = new Map();
const remoteSessionKV = new Map();
let remoteTreeBase = null;
const remoteMutationQueue = createSessionMutationQueue({
  execute: executeRemoteMutation,
  onCommit: commitRemoteMutation,
  onFailure: handleRemoteMutationFailure,
  onState: publishRemoteQueueState,
  operationId: mutation => createRemoteOperationId(mutation.type, mutation.id),
  prepare: mutation => ({
    ...mutation,
    expectedSessionRevision: remoteSessionRevisions.get(mutation.id)
  })
});
const pendingRemoteMutations = remoteMutationQueue.pending;
const sessionConflictNotifications = createSessionConflictNotifications({
  getQueue: () => remoteMutationQueue,
  show: (message, options) => window.zion?.notification?.show?.(message, options),
  resolve: async mutation => {
    try {
      if (mutation.type === "session") {
        invalidateSession(mutation.id);
        await applyRemoteSessionRecord({ sessionId: mutation.id });
      }
      await syncRemoteStorage({ force: true });
    } catch (error) { setRemoteStorageState(false, error); }
  }
});
let sessionTagIndex = createSessionTagIndex();
let sessionTagIndexReady = false;
let sessionTagIndexTimer = 0;
let sessionTagIndexBackfillHandle = 0;
let sessionPreviewBackfillHandle = 0;
const pendingSessionTagDocs = new Map();

function workbenchClientId() {
  return globalThis.crypto?.randomUUID?.()
    || `workbench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const WORKBENCH_CLIENT_ID = workbenchClientId();

function flattenLegacyTagCatalog(raw) {
  const tags = Array.isArray(raw?.tags) ? raw.tags : [];
  const byId = new Map(tags.map((tag) => [String(tag?.id || ""), tag]));
  const paths = [];
  const resolvePath = (tag, seen = new Set()) => {
    if (!tag || typeof tag !== "object") return "";
    const id = String(tag.id || "");
    if (id && seen.has(id)) return "";
    const nextSeen = new Set(seen);
    if (id) nextSeen.add(id);
    const parent = tag.parentId ? byId.get(String(tag.parentId)) : null;
    const parentPath = parent ? resolvePath(parent, nextSeen) : "";
    return [parentPath, tag.name].filter(Boolean).join("/");
  };
  for (const tag of tags) {
    const path = normalizeTagPath(resolvePath(tag));
    if (path) paths.push(path);
  }
  return Array.from(new Set(paths));
}

function collectSessionTagIndexPaths(index) {
  const paths = new Set();
  const current = validateSessionTagIndex(index);
  for (const sessionId of Object.keys(current.sessions || {})) {
    for (const path of getIndexedSessionTags(current, sessionId)) paths.add(path);
  }
  return Array.from(paths);
}

function collectDerivedTagPaths() {
  const paths = new Set();
  let registry = null;
  try { registry = window.zion?.state?.get?.("sessions.derivedTags"); } catch {}
  if (!registry || typeof registry !== "object") return [];
  for (const source of Object.values(registry)) {
    for (const tags of Object.values(source?.sessions || {})) {
      for (const tag of Array.isArray(tags) ? tags : []) {
        const path = normalizeTagPath(typeof tag === "string" ? tag : tag?.path);
        if (path) paths.add(path);
      }
    }
  }
  return Array.from(paths);
}

async function loadSessionTagVocabulary() {
  const storedCatalog = remoteSessionKV.has("sessions.tagCatalog")
    ? remoteSessionKV.get("sessions.tagCatalog")
    : (await readRemoteSessionKV("sessions.tagCatalog").catch(() => null))?.value || [];
  const legacyCatalog = remoteSessionKV.has("tagCatalog.v1")
    ? remoteSessionKV.get("tagCatalog.v1")
    : (await readRemoteSessionKV("tagCatalog.v1").catch(() => null))?.value || null;
  const catalog = validateCatalog(storedCatalog).entries.map((entry) => entry.path);
  const legacy = flattenLegacyTagCatalog(legacyCatalog);
  const document = collectSessionTagIndexPaths(sessionTagIndex);
  const derived = collectDerivedTagPaths();
  return {
    catalog,
    legacyCatalog: legacy,
    document,
    derived,
    all: Array.from(new Set([...catalog, ...legacy, ...document, ...derived]))
  };
}

function publishSessionTagIndex(next) {
  sessionTagIndex = validateSessionTagIndex(next);
  try { window.zion?.state?.set("sessions.tagIndex", sessionTagIndex); } catch {}
  return sessionTagIndex;
}

function persistCurrentSessionTagIndex({ background = false } = {}) {
  // Enqueue immediately so the durable queue can retain one latest waiting
  // snapshot, rather than replaying a Promise chain of obsolete whole indexes.
  void enqueueRemoteMutation({
    type: "kv",
    id: "sessions.tagIndex",
    value: sessionTagIndex,
    coalesceLatest: true,
    background
  }).catch((error) => {
    warnStorageIssue("saveTagIndex", error, { mutationType: "kv" });
  });
}

function commitSessionTagIndex(next, options = {}) {
  const changed = !sessionTagIndexContentsEqual(sessionTagIndex, next);
  publishSessionTagIndex(next);
  if (changed) {
    persistCurrentSessionTagIndex(options);
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
  }
  return sessionTagIndex;
}

function flushPendingSessionTagDocs() {
  sessionTagIndexTimer = 0;
  if (!sessionTagIndexReady || !pendingSessionTagDocs.size) return;
  let next = sessionTagIndex;
  for (const [id, text] of pendingSessionTagDocs) {
    next = updateSessionTagIndex(next, id, text, hashString(text));
  }
  pendingSessionTagDocs.clear();
  commitSessionTagIndex(next, { background: true });
}

function scheduleSessionTagIndexUpdate(id, text) {
  if (isSharedWorkbenchDocument(id)) return;
  const sessionId = String(id || "").trim();
  if (!sessionTagIndexReady || !sessionId) return;
  pendingSessionTagDocs.set(sessionId, String(text || ""));
  if (sessionTagIndexTimer) window.clearTimeout(sessionTagIndexTimer);
  sessionTagIndexTimer = window.setTimeout(flushPendingSessionTagDocs, 300);
}

function removeIndexedSessionTags(id) {
  const sessionId = String(id || "");
  pendingSessionTagDocs.delete(sessionId);
  if (!Object.prototype.hasOwnProperty.call(sessionTagIndex.sessions || {}, sessionId)) return;
  const next = removeSessionTagIndexEntry(sessionTagIndex, id);
  commitSessionTagIndex(next);
}

function setRemoteStorageState(online, error = null) {
  remoteStorageOnline = !!online;
  try {
    window.zion?.state?.set("sessions.remoteStorageOnline", remoteStorageOnline);
    window.zion?.state?.set("sessions.remoteStorageError", error ? classifySessionStorageError(error).kind : null);
    window.zion?.state?.set("sessions.remoteStorageErrorDetails", error ? classifySessionStorageError(error) : null);
  } catch {}
}

function createRemoteOperationId(kind, id) {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${kind}:${String(id || "global")}:${random}`;
}

function publishRemoteQueueState({ status, error, pending, conflicts, active, timings }) {
  try {
    sessionConflictNotifications.reconcile();
    window.zion?.state?.set("sessions.persistence", {
      status,
      pending,
      conflicts,
      lastCommittedAt: status === "saved" ? now() : null,
      error: error ? classifySessionStorageError(error).kind : null,
      issue: error ? classifySessionStorageError(error) : null
    });
    window.zion?.state?.set("sessions.operationTimings", timings || []);
    window.zion?.state?.set("sessions.activeMutation", active || null);
    window.zion?.state?.set("sessions.persistenceConflicts", remoteMutationQueue.conflicts.map(item => ({
      type: item.type, id: item.id, operationId: item.operationId,
      tree: item.tree, baseTree: item.baseTree, payload: item.payload,
      error: classifySessionStorageError(item.error).kind,
      issue: classifySessionStorageError(item.error)
    })));
    if (status === "saved") clearStorageWarning();
  } catch {}
}

async function executeRemoteMutation(mutation) {
  if (window.zion?.state?.get("workbench.accessChanged")) {
    throw Object.assign(new Error("账户或访问权限已变化，请重新进入工作台"), {
      status: 403, code: "WORKBENCH_ACCESS_CHANGED"
    });
  }
  if (mutation.type === "session") {
    if (window.zion?.state?.get(`sessions.deleted.${mutation.id}`)) return { ok: true, skipped: true };
    const payload = collaborationSynced(mutation.id)
      ? Object.fromEntries(Object.entries(mutation.payload || {}).filter(([key]) => key !== "text"))
      : mutation.payload;
    if (!Object.keys(payload || {}).length) return { ok: true, skipped: true };
    try {
      return await writeRemoteSession(mutation.id, payload, {
        operationId: mutation.operationId,
        expectedSessionRevision: mutation.expectedSessionRevision,
        retryOnConflict: false,
        sourceClientId: WORKBENCH_CLIENT_ID
      });
    } catch (error) {
      if (Number(error?.status) !== 410) throw error;
      window.zion?.state?.set(`sessions.deleted.${mutation.id}`, true);
      return { ok: true, skipped: true, deleted: true };
    }
  }
  if (mutation.type === "delete") return deleteRemoteSession(mutation.id, {
    signal: mutation.controller?.signal,
    operationId: mutation.operationId,
    expectedSessionRevision: remoteSessionRevisions.get(mutation.id),
    sourceClientId: WORKBENCH_CLIENT_ID
  });
  if (mutation.type === "folder-delete") {
    const result = await deleteRemoteFolder(mutation.id, mutation.baseTree, {
      operationId: mutation.operationId, sourceClientId: WORKBENCH_CLIENT_ID, signal: mutation.controller?.signal
    });
    return result?.duplicate ? { ...result, ...await readRemoteTree() } : result;
  }
  if (mutation.type === "tree") {
    const result = await writeRemoteTree(mutation.tree, mutation.index, null, {
      operationId: mutation.operationId,
      sourceClientId: WORKBENCH_CLIENT_ID,
      baseTree: mutation.baseTree
    });
    // A receipt confirms the old save, but its tree may predate other edits.
    return result?.duplicate ? { ...result, ...await readRemoteTree() } : result;
  }
  if (mutation.type === "kv") return writeRemoteSessionKV(mutation.id, mutation.value, {
    sourceClientId: WORKBENCH_CLIENT_ID
  });
  throw Object.assign(new Error("Unknown session mutation"), { status: 400 });
}

async function commitRemoteMutation(mutation, result, pending) {
  if (mutation.type === "session" && window.zion?.state?.get(`sessions.localDraft.${mutation.id}`)) {
    window.zion.state.set(`sessions.durableReady.${mutation.id}`, true);
  }
  if (mutation.id && result?.session_revision != null) remoteSessionRevisions.set(
    String(mutation.id),
    Math.max(remoteSessionRevisions.get(mutation.id) || 0, Number(result.session_revision) || 0)
  );
  for (const next of pending) {
    if (next.type === "session" && next.id === mutation.id && !next.attempted
      && next.expectedSessionRevision === mutation.expectedSessionRevision
      && result?.session_revision != null) next.expectedSessionRevision = Number(result.session_revision);
  }
  if (mutation.type === "kv") remoteSessionKV.set(mutation.id, mutation.value);
  if ((mutation.type === "tree" || mutation.type === "folder-delete") && result?.tree) {
    remoteTreeBase = structuredClone(result.tree);
    const nextTree = pending.find(item => item.type === "tree");
    if (mutation.type === "tree" && nextTree && !nextTree.attempted) {
      nextTree.baseTree = structuredClone(mutation.tree);
    }
    if (!pending.some(item => item.type === "tree")
      && !remoteMutationQueue.conflicts.some(item => item.type === "tree")) {
      window.zion?.state?.set("sessions.treeMem", result.tree);
      window.zion?.state?.set("sessions.indexMem", result.index);
      window.zion?.state?.set("sessions.catalog", result.index);
    }
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
  }
  if (mutation.type === "folder-delete") {
    const deletedIds = result?.deleted_session_ids || [];
    for (const id of deletedIds) {
      window.zion?.state?.set(`sessions.deleted.${id}`, true);
      window.zion?.events?.emit?.("session/deleting", { sessionId: id });
      invalidateSession(id);
      durableSessionIds.delete(id);
      remoteSessionRevisions.delete(id);
      window.zion?.state?.set(`sessions.summary.${id}`, undefined);
      removeIndexedSessionTags(id);
    }
    // Opening a replacement editor may itself flush the persistence queue.
    // Never hold this queue's committed receipt behind that UI work.
    void Promise.resolve(removeSessionsFromPanels(deletedIds)).catch(error =>
      handleRemoteMutationFailure(mutation, error, { committed: true }));
  }
  setRemoteStorageState(true);
  if (mutation.type === "session" && mutation.payload?.meta_changes
    && !result?.skipped && (!result?.unchanged || mutation.payload?.automatic_title)
    && !pending.some(item => item.id === mutation.id)) {
    // The accepted patch may have preserved another window's title/annotations.
    void Promise.resolve(applyRemoteSessionRecord({ sessionId: mutation.id })).catch(error =>
      handleRemoteMutationFailure(mutation, error, { committed: true }));
  }
}

function handleRemoteMutationFailure(mutation, error, { retrying, committed }) {
  if (["DELETE_OUTCOME_UNKNOWN", "DELETE_NOT_SENT"].includes(error?.code)) {
    window.zion?.notification?.show?.(error.message, {
      type: "warning", duration: 0,
      actions: [{ label: "核对删除结果", handler: () =>
        remoteMutationQueue.retryDeletion(mutation.operationId).catch(() => {}) }]
    });
    return;
  }
  if (committed) {
    setRemoteStorageState(false, error);
    void syncRemoteStorage({ force: true });
    return;
  }
  const where = mutation.type === "kv" ? "saveTagIndex"
    : mutation.type === "session" ? (mutation.payload?.meta_changes ? "saveMeta" : "saveDoc")
      : mutation.type === "tree" ? "saveTree" : "delete";
  const issue = classifySessionStorageError(error);
  const needsConflictAction = ["conflict", "too-large", "rejected"].includes(issue.kind);
  const background = mutation.type === "kv" && mutation.id === "sessions.tagIndex"
    && mutation.background === true;
  warnStorageIssue(where, error, {
    retrying, retained: !background, mutationType: mutation.type, background,
    // A single background retry is diagnostic state, not a draft-loss alert.
    // Repeated failures and explicit exclusion edits still need attention.
    notify: retrying ? (!background || mutation.attempts >= 2) : !needsConflictAction
  });
  if (retrying) {
    setRemoteStorageState(false, error);
    return;
  }
  setRemoteStorageState(!["unauthenticated", "forbidden", "access-changed", "upgrade-required"].includes(issue.kind), error);
  if (!needsConflictAction) return;
  sessionConflictNotifications.notify(mutation, error);
}

const flushRemoteMutations = () => remoteMutationQueue.flush();
const flushSessionRemoteMutations = id => id ? remoteMutationQueue.flushSession(id) : flushRemoteMutations();
const enqueueRemoteMutation = mutation => remoteMutationQueue.enqueue(mutation);

function scheduleRemoteSnapshot(kind, id, value, options = {}) {
  if (isSharedWorkbenchDocument(id)) {
    if (kind === "meta" || !sharedDocumentEditable(id)) return Promise.resolve(true);
  }
  if (kind === "doc" || kind === "meta") {
    return enqueueRemoteMutation({
      type: "session",
      id: String(id || ""),
      payload: kind === "doc" ? { text: String(value || "") } : {
        meta_changes: options.changes || [],
        ...(options.automaticTitle ? { automatic_title: true } : {})
      }
    });
  }
  // The Runtime derives its index from documents and the tree. Updating a
  // local size/hash/preview must not resend the entire shared tree.
  if (kind === "index") return Promise.resolve(true);
  if (kind === "tree") {
    return enqueueRemoteMutation({
      type: "tree",
      id: "tree",
      tree: structuredClone(window.zion?.state?.get("sessions.treeMem")),
      baseTree: remoteTreeBase ? structuredClone(remoteTreeBase) : null,
      index: window.zion?.state?.get("sessions.indexMem") || []
    });
  }
  return Promise.resolve(false);
}

function scheduleRemoteDelete(id) {
  return enqueueRemoteMutation({
    type: "delete",
    id: String(id || "")
  });
}

async function purgeSessionData(id) {
  // #region debug-point A:delete-queued
  if (window.zion?.state?.get?.("debug.sessionStreamUrl")) void fetch(window.zion.state.get("debug.sessionStreamUrl"), { method: "POST", body: JSON.stringify({ sessionId: "session-stream-consistency", hypothesisId: "A", location: "purgeSessionData", ts: Date.now(), data: { id, queued: pendingRemoteMutations.filter(item => item.id === id).map(item => item.type) } }) }).catch(() => {});
  // #endregion
  const key = `sessions.deleted.${id}`;
  await scheduleRemoteDelete(id);
  window.zion?.state?.set(key, true);
  window.zion?.events?.emit?.("session/deleting", { sessionId: id });
  try { localStorage.removeItem(docKey(id)); } catch {}
  try { localStorage.removeItem(metaKey(id)); } catch {}
  invalidateSession(id);
  try { window.zion?.state?.set(`sessions.summary.${id}`, undefined); } catch {}
  durableSessionIds.delete(String(id || ""));
  removeIndexedSessionTags(id);
}

async function hydrateRemoteCatalogResponse(response) {
  if (!response?.catalog) {
    hydrateFromDurableSnapshot(response?.snapshot || response);
    return;
  }
  const refreshIds = hydrateSessionCatalog(response.catalog, {
    state: window.zion.state,
    durableIds: durableSessionIds,
    revisions: remoteSessionRevisions,
    invalidate: invalidateSession,
    hasPending: (id) => id === "tree"
      ? pendingRemoteMutations.some(mutation => ["tree", "session", "delete", "folder-delete"].includes(mutation.type))
        || remoteMutationQueue.conflicts.some(mutation => mutation.type === "tree")
      : [...pendingRemoteMutations, ...remoteMutationQueue.conflicts].some(mutation => mutation.id === id),
    isOpen: (id) => openSessionEditors(id).length > 0
  });
  if (![...pendingRemoteMutations, ...remoteMutationQueue.conflicts].some(item => item.type === "tree") && response.catalog.tree) {
    remoteTreeBase = structuredClone(response.catalog.tree);
  }
  remoteSessionKV.clear();
  for (const [key, value] of Object.entries(response.catalog.kv || {})) {
    remoteSessionKV.set(key, value);
  }
  if (sessionTagIndexReady && !pendingSessionTagDocs.size
    && ![...pendingRemoteMutations, ...remoteMutationQueue.conflicts]
      .some(item => item.type === "kv" && item.id === "sessions.tagIndex")) {
    publishSessionTagIndex(remoteSessionKV.get("sessions.tagIndex"));
  }
  for (const sessionId of refreshIds) await applyRemoteSessionRecord({ sessionId });
  try { refreshSessionsSidebarViewIfOpen(); } catch {}
  try { refreshSessionsOverlayIfOpen(); } catch {}
}

function hydrateFromDurableSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  const previousIds = new Set(durableSessionIds);
  durableSessionIds.clear();
  const docs = Array.isArray(snapshot.docs) ? snapshot.docs : [];
  const metas = Array.isArray(snapshot.metas) ? snapshot.metas : [];
  for (const item of docs) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    durableSessionIds.add(id);
    previousIds.delete(id);
    if (Number.isFinite(Number(item?.session_revision))) {
      remoteSessionRevisions.set(id, Number(item.session_revision));
    }
    try { window.zion?.state?.set(`sessions.doc.${id}`, String(item.text || "")); } catch {}
  }
  for (const item of metas) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    durableSessionIds.add(id);
    previousIds.delete(id);
    try { window.zion?.state?.set(`sessions.meta.${id}`, { ...(item.meta || {}), id }); } catch {}
    try { window.zion?.state?.set(`sessions.metaLoaded.${id}`, true); } catch {}
  }
  for (const id of previousIds) {
    try { window.zion?.state?.set(`sessions.doc.${id}`, undefined); } catch {}
    try { window.zion?.state?.set(`sessions.meta.${id}`, undefined); } catch {}
    remoteSessionRevisions.delete(id);
  }
  if (snapshot.tree?.type === "folder") {
    remoteTreeBase = structuredClone(snapshot.tree);
    try { window.zion?.state?.set("sessions.treeMem", snapshot.tree); } catch {}
  }
  try {
    window.zion?.state?.set(
      "sessions.indexMem",
      Array.isArray(snapshot.index) ? snapshot.index : []
    );
    window.zion?.state?.set("sessions.metaReady", true);
  } catch {}
  remoteSessionKV.clear();
  for (const [key, value] of Object.entries(snapshot.kv || {})) {
    remoteSessionKV.set(key, value);
  }
}

async function syncRemoteStorage({ force = false } = {}) {
  try {
    await flushRemoteMutations();
    const generation = remoteMutationQueue.generation;
    const status = await readRemoteStatus();
    if (!force && remoteCatalogRevision && status?.revision === remoteCatalogRevision
      && !remoteMutationQueue.hasUnpersistedChanges) {
      setRemoteStorageState(true);
      return true;
    }
    const response = await readRemoteCatalog();
    if (!catalogResponseIsCurrent(response, generation, remoteMutationQueue.generation, remoteEventCursor)) return true;
    await hydrateRemoteCatalogResponse(response);
    // Hydration preserves pending edits. Those skipped fields still need
    // reconciliation after the edit commits or its conflict is resolved.
    if (!remoteMutationQueue.hasUnpersistedChanges) {
      remoteCatalogRevision = response?.revision || status?.revision || null;
      remoteEventCursor = Math.max(
        remoteEventCursor,
        Number(response?.event_cursor) || 0
      );
      remoteRealtimeSync?.setCursor(remoteEventCursor);
    }
    setRemoteStorageState(true);
    return true;
  } catch (error) {
    setRemoteStorageState(false, error);
    return false;
  }
}

function openSessionEditors(sessionId) {
  const id = String(sessionId || "");
  if (!id) return [];
  const editors = [];
  try {
    for (const entry of window.zion?.panels?.listEditors?.() || []) {
      if (String(entry?.sessionId || "") !== id) continue;
      const editor = window.zion?.panels?.getEditorBySession?.(
        entry.panelId,
        id
      );
      if (editor && !editors.includes(editor)) editors.push(editor);
    }
  } catch {}
  return editors;
}

function collaborationSynced(sessionId) {
  const state = window.zion?.state?.get?.(
    `sessions.collaboration.${String(sessionId || "")}`
  );
  return state?.connected === true && state?.synced === true;
}

async function refreshRemoteTree() {
  const beforeTree = window.zion?.state?.get("sessions.treeMem");
  const beforeIndex = window.zion?.state?.get("sessions.indexMem") || [];
  const remote = await readRemoteTree();
  if ([...pendingRemoteMutations, ...remoteMutationQueue.conflicts].some(item => item.type === "tree")
    || window.zion?.state?.get("sessions.treeMem") !== beforeTree) return remote;
  if (remote?.tree?.type === "folder") {
    remoteTreeBase = structuredClone(remote.tree);
    window.zion?.state?.set("sessions.treeMem", remote.tree);
  }
  if (Array.isArray(remote?.index)) {
    const available = new Set(remote.index.map(entry => entry.id));
    const retired = [];
    for (const entry of beforeIndex) {
      if (available.has(entry.id) || !durableSessionIds.has(entry.id)
        || pendingRemoteMutations.some(item => item.type === "delete" && item.id === entry.id)) continue;
      // A catalog refresh can represent deletion or withdrawn access. Stop
      // open editors from queuing saves against a document that is now gone.
      window.zion?.state?.set(`sessions.deleted.${entry.id}`, true);
      window.zion?.events?.emit?.("session/deleting", { sessionId: entry.id });
      durableSessionIds.delete(entry.id);
      remoteSessionRevisions.delete(entry.id);
      invalidateSession(entry.id);
      retired.push(entry.id);
    }
    window.zion?.state?.set("sessions.indexMem", remote.index);
    window.zion?.state?.set("sessions.catalog", remote.index);
    if (retired.length) await removeSessionsFromPanels(retired);
  }
  try { refreshSessionsSidebarViewIfOpen(); } catch {}
  try { refreshSessionsOverlayIfOpen(); } catch {}
  return remote;
}

async function applyRemoteSessionRecord(event) {
  const sessionId = String(event?.sessionId || "");
  if (!sessionId) return;
  const beforeText = window.zion?.state?.get(`sessions.doc.${sessionId}`);
  const beforeMeta = window.zion?.state?.get(`sessions.meta.${sessionId}`);
  if (beforeText === undefined && !openSessionEditors(sessionId).length && event?.data?.indexEntry) {
    const entry = event.data.indexEntry;
    if (Number(event.sessionRevision) < (remoteSessionRevisions.get(sessionId) || 0)) return;
    durableSessionIds.add(sessionId);
    if (Number.isFinite(Number(event.sessionRevision))) {
      remoteSessionRevisions.set(sessionId, Number(event.sessionRevision));
    }
    window.zion?.state?.set(`sessions.summary.${sessionId}`, {
      ...window.zion?.state?.get(`sessions.summary.${sessionId}`), ...entry
    });
    if (!pendingRemoteMutations.some(mutation => mutation.id === sessionId)) {
      // A closed session may now have metadata without a body. An index event
      // only refreshes its summary; the old complete metadata becomes unknown.
      window.zion?.state?.set(`sessions.meta.${sessionId}`, undefined);
      window.zion?.state?.set(`sessions.metaLoaded.${sessionId}`, false);
    }
    // Remote facts update the cache; setIndex/upsertIndexEntry would enqueue
    // another shared tree write from this receiving device.
    const index = (window.zion?.state?.get("sessions.indexMem") || [])
      .filter(item => item.id !== sessionId);
    index.push(entry);
    window.zion?.state?.set("sessions.indexMem", index);
    window.zion?.state?.set("sessions.catalog", index);
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    try { refreshSessionsOverlayIfOpen(); } catch {}
    return;
  }
  const record = await readRemoteSession(sessionId, { source: "realtime", minRevision: Number(event.sessionRevision) || 0 });
  if (!record || record.deleted) return;
  if (
    window.zion?.state?.get(`sessions.doc.${sessionId}`) !== beforeText
    || window.zion?.state?.get(`sessions.meta.${sessionId}`) !== beforeMeta
    || pendingRemoteMutations.some((mutation) => mutation.id === sessionId)
    || Number(record.session_revision) < (remoteSessionRevisions.get(sessionId) || 0)
  ) return;
  const previousText = window.zion?.state?.get?.(`sessions.doc.${sessionId}`);
  const editors = openSessionEditors(sessionId);
  const dirty = !collaborationSynced(sessionId)
    && editors.some((editor) =>
      typeof previousText === "string"
      && String(editor?.getValue?.() ?? "") !== previousText
    );
  remoteSessionRevisions.set(
    sessionId,
    Number(record.session_revision) || 0
  );
  window.zion?.state?.set(`sessions.meta.${sessionId}`, {
    ...(record.meta || {}),
    id: sessionId
  });
  window.zion?.state?.set(`sessions.metaLoaded.${sessionId}`, true);
  const indexEntry = event?.data?.indexEntry || {
    id: sessionId,
    title: record.meta?.title || sessionId,
    updatedAt: record.meta?.updatedAt || event?.createdAt || 0,
    createdAt: record.meta?.createdAt || 0,
    size: record.meta?.size || String(record.text || "").length,
    hash: record.meta?.hash || record.content_hash || ""
  };
  const currentIndex = window.zion?.state?.get("sessions.indexMem");
  const nextIndex = Array.isArray(currentIndex)
    ? currentIndex.slice()
    : [];
  const existingIndex = nextIndex.findIndex((item) => item?.id === sessionId);
  if (existingIndex >= 0) {
    nextIndex[existingIndex] = {
      ...nextIndex[existingIndex],
      ...indexEntry
    };
  } else {
    nextIndex.push(indexEntry);
  }
  window.zion?.state?.set("sessions.indexMem", nextIndex);
  window.zion?.state?.set("sessions.catalog", nextIndex);
  if (dirty) {
    window.zion?.state?.set("sessions.externalUpdate", {
      id: sessionId,
      updatedAt: event?.createdAt || Date.now(),
      hash: record.content_hash || "",
      sessionRevision: record.session_revision
    });
  } else {
    const text = String(record.text || "");
    window.zion?.state?.set(`sessions.doc.${sessionId}`, text);
    if (!collaborationSynced(sessionId)) {
      for (const editor of editors) {
        if (String(editor?.getValue?.() ?? "") !== text) {
          editor?.setValue?.(text, { source: "session-load" });
        }
      }
    }
  }
  try { refreshSessionsSidebarViewIfOpen(); } catch {}
  try { refreshSessionsOverlayIfOpen(); } catch {}
}

async function applyRemoteWorkbenchEvent(event, options = {}) {
  if (!event || typeof event !== "object") return;
  await processRemoteWorkbenchEvent(event, options);
  // Failed reads must remain replayable; observing an event is not applying it.
  remoteEventCursor = Math.max(
    remoteEventCursor,
    Number(event.sequence) || 0
  );
  window.zion?.state?.set("sessions.realtimeCursor", remoteEventCursor);
}

async function refreshRemoteSessionKV(key) {
  if (!key) return;
  let record;
  try { record = await readRemoteSessionKV(key); }
  catch (error) {
    if (Number(error?.status) !== 404) throw error;
    record = null;
  }
  if ([...pendingRemoteMutations, ...remoteMutationQueue.conflicts]
    .some(item => item.type === "kv" && item.id === key)) return;
  if (record) remoteSessionKV.set(key, record.value);
  else remoteSessionKV.delete(key);
  if (key === "sessions.tagIndex" && sessionTagIndexReady && !pendingSessionTagDocs.size) {
    publishSessionTagIndex(record?.value);
  }
  try { refreshSessionsSidebarViewIfOpen(); } catch {}
  try { refreshSessionsOverlayIfOpen(); } catch {}
}

async function processRemoteWorkbenchEvent(event, { ownEvent = false } = {}) {
  const sessionId = String(event.sessionId || "");

  if (event.type === "llm.request") {
    // The inspector payload is optional detail. It must not hold run.started,
    // run.completed or document updates behind another network round trip.
    const sourceSync = remoteRealtimeSync;
    observeLlmRequestWorkbenchEvent({
      event,
      zion: window.zion,
      resolveDetail: (runId, sequence) => readRemoteRunEvent(runId, sequence),
      isCurrent: () => remoteRealtimeSync === sourceSync && !window.zion?.state?.get("workbench.accessChanged"),
      onError: error => console.warn(
        "[dev.session-manager] failed to load LLM request detail:",
        error
      )
    });
    return;
  }
  if (String(event.type || "").startsWith("run.")) {
    const active = event.type === "run.started";
    window.zion?.state?.set(`sessions.activeRun.${sessionId}`, active
      ? {
          runId: event.runId,
          attemptId: event.data?.attemptId || "",
          status: event.data?.status || "running",
          sequence: event.sequence
        }
      : null);
    window.zion?.events?.emit?.("runtime/sessionRunEvent", {
      ...event,
      ownEvent
    });
    return;
  }
  if (event.type === "session.deleted") {
    remoteMutationQueue.confirmDeletion?.(sessionId, {
      ok: true, session_revision: event.sessionRevision, event_sequence: event.sequence
    });
  }
  if (event.type === "tree.updated" && event.data?.reason === "folder-delete") {
    const tree = await readRemoteTree();
    remoteMutationQueue.confirmDeletion?.(event.data.folderId, {
      ...tree, ok: true, deleted_session_ids: event.data.sessionIds || []
    }, "folder-delete");
  }
  if (ownEvent && event.type !== "session.deleted") return;
  if (event.type === "kv.updated") {
    await refreshRemoteSessionKV(String(event.data?.key || ""));
    return;
  }
  if (event.type === "document.checkpointed") {
    if (!collaborationSynced(sessionId)) {
      await applyRemoteSessionRecord(event);
    }
    return;
  }
  if (
    event.type === "collaboration.updated"
    || (
      event.type === "session.updated"
      && event.data?.reason === "collaboration"
    )
  ) {
    return;
  }
  if (event.type === "session.deleted") {
    window.zion?.state?.set(`sessions.deleted.${sessionId}`, true);
    window.zion?.events?.emit?.("session/deleting", { sessionId });
    durableSessionIds.delete(sessionId);
    remoteSessionRevisions.delete(sessionId);
    invalidateSession(sessionId);
    window.zion?.state?.set(`sessions.summary.${sessionId}`, undefined);
    await refreshRemoteTree();
    removeIndexedSessionTags(sessionId);
    await removeSessionsFromPanels([sessionId]);
    return;
  }
  if (event.type === "tree.updated" || event.type === "catalog.changed") {
    await refreshRemoteTree();
    return;
  }
  if (
    event.type === "session.created"
    || event.type === "session.updated"
  ) {
    await applyRemoteSessionRecord(event);
    if (event.type === "session.created") await refreshRemoteTree();
  }
}

function startRemoteRealtimeSync() {
  if (remoteRealtimeSync) return remoteRealtimeSync;
  remoteRealtimeSync = createSessionRealtimeSync({
    subscribe: subscribeRemoteEvents,
    initialCursor: remoteEventCursor,
    clientId: WORKBENCH_CLIENT_ID,
    onEvent: applyRemoteWorkbenchEvent,
    async onReset() {
      await syncRemoteStorage({ force: true });
      return remoteEventCursor;
    },
    onStatus(status) {
      window.zion?.state?.set("sessions.realtime", status);
    }
  });
  void remoteRealtimeSync.start();
  return remoteRealtimeSync;
}

async function discoverActiveSessionRun(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  try {
    const result = await readRemoteActiveRun(id);
    if (!result?.activeRun?.runId) return null;
    const event = {
      sequence: remoteEventCursor,
      type: "run.started",
      sessionId: id,
      runId: result.activeRun.runId,
      data: {
        attemptId: result.activeRun.attemptId || "",
        status: result.activeRun.status || "running",
        discovered: true
      },
      ownEvent: false
    };
    window.zion?.state?.set(`sessions.activeRun.${id}`, {
      runId: event.runId,
      attemptId: event.data.attemptId,
      status: event.data.status,
      sequence: event.sequence
    });
    window.zion?.events?.emit?.("runtime/sessionRunEvent", event);
    return event;
  } catch {
    return null;
  }
}

const {
  docKey,
  metaKey,
  loadDoc,
  saveDoc: persistSessionDoc,
  loadDocAsync,
  peekMeta,
  loadMeta,
  loadMetaAsync,
  invalidate: invalidateSession,
  saveMeta: persistSessionMeta
} = createSessionDocRepo({
  warnStorageIssue,
  now,
  onPersist: scheduleRemoteSnapshot,
  onLoad: readRemoteSession,
  onLoadMeta: readRemoteSessionMetadata,
  getKnownRevision: (id) => remoteSessionRevisions.get(id) || 0,
  onLoaded: (id, record) => {
    remoteSessionRevisions.set(id, Math.max(
      remoteSessionRevisions.get(id) || 0, Number(record.session_revision) || 0
    ));
    scheduleSessionTagIndexBackfill();
    scheduleSessionDocumentPreviewBackfill();
  },
  getZion: () => window.zion
});

function saveDoc(id, text) {
  if (!id || window.zion?.state?.get(`sessions.deleted.${id}`)
    || window.zion?.state?.get(`sessions.deleting.${id}`)) return Promise.resolve(false);
  durableSessionIds.add(String(id || ""));
  const value = String(text || "");
  const result = persistSessionDoc(id, value);
  scheduleSessionTagIndexUpdate(id, value);
  return result;
}

function saveMeta(id, meta, options) {
  if (!id || window.zion?.state?.get(`sessions.deleted.${id}`)
    || window.zion?.state?.get(`sessions.deleting.${id}`)) return Promise.resolve(false);
  durableSessionIds.add(String(id || ""));
  return persistSessionMeta(id, meta, options);
}

const sessionCreationSaves = new Map();

function saveNewSession(id, text, meta) {
  const defaultModel = window.zion?.state?.get("chat.defaultModel");
  if (!meta.model && defaultModel) meta = { ...meta, model: { ...defaultModel } };
  // Track only this session's initial writes; opening its editor stays immediate.
  const write = (annotations = meta.annotations) => {
    if (annotations) meta = { ...meta, annotations: localSessionAnnotationCopy(annotations) };
    return Promise.all([saveDoc(id, text), saveMeta(id, meta)]);
  };
  const needsDetails = ["tools", "thinking"].some(kind => meta.annotations?.[kind]?.some(item => item.detailRef || item.bodyRef));
  const creation = (needsDetails ? hydrateRemoteAnnotations(meta.annotations).then(write) : write())
    .then(results => results.every(saved => saved === true), () => false);
  sessionCreationSaves.set(id, creation);
  void creation.then(() => {
    if (sessionCreationSaves.get(id) === creation) sessionCreationSaves.delete(id);
  });
  return creation;
}

function hasBrowserSessionCandidate(candidate) {
  const snapshot = candidate?.snapshot || {};
  return Number(candidate?.candidates || 0) > 0
    || snapshot.tree?.type === "folder"
    || (Array.isArray(snapshot.index) && snapshot.index.length > 0)
    || Object.keys(snapshot.kv || {}).length > 0;
}

/** Recover browser-era data once, then use Runtime as the only session source. */
async function initSessionsStorage() {
  try {
    await remoteMutationQueue.restart();
    const candidate = currentAccountSession() ? null : await readBrowserSessionCandidate(DB_NAME);
    if (hasBrowserSessionCandidate(candidate)) {
      const report = await migrateBrowserSessionStorage(
        candidate.sourceId,
        candidate.snapshot,
        candidate.fingerprint
      );
      try { window.zion?.state?.set("sessions.browserMigration", report); } catch {}
      if (!report?.verified) {
        throw new Error("browser session migration could not verify every candidate");
      }
      try {
        await clearMigratedBrowserSessions(DB_NAME);
      } catch (cleanupError) {
        try { console.warn("[sessions] migrated browser data cleanup failed", cleanupError); } catch {}
      }
    } else if (!candidate?.available && candidate?.error) {
      try { console.warn("[sessions] legacy IndexedDB could not be inspected", candidate.error); } catch {}
    }

    let response = await readRemoteCatalog();
    if (!response) {
      const initialTree = {
        id: "root",
        type: "folder",
        title: "Sessions",
        children: []
      };
      await writeRemoteTree(initialTree, [], null, { baseTree: initialTree });
      response = await readRemoteCatalog();
    }
    const snapshot = response?.catalog || response?.snapshot || response;
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error("durable session snapshot unavailable");
    }
    await hydrateRemoteCatalogResponse(response);
    remoteCatalogRevision = response?.revision || null;
    remoteEventCursor = Math.max(
      0,
      Number(response?.event_cursor) || 0
    );
    sessionTagIndex = validateSessionTagIndex(
      remoteSessionKV.get("sessions.tagIndex")
    );
    sessionTagIndexReady = true;
    publishSessionTagIndex(sessionTagIndex);
    setRemoteStorageState(true);
    scheduleSessionTagIndexBackfill();
    scheduleSessionDocumentPreviewBackfill();
    if (!remoteSyncTimer) {
      remoteSyncTimer = window.setInterval(() => { void syncRemoteStorage(); }, 30000);
    }
    return { ok: true };
  } catch (e) {
    console.error("[sessions] initSessionsStorage error:", e);
    return { ok: false, reason: "initSessionsStorage", error: e };
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
  warnStorageIssue,
  loadMeta,
  peekMeta,
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
  getZion: () => window.zion,
  onPersist: scheduleRemoteSnapshot,
  onDelete: purgeSessionData,
  onDeleteFolder: (id, baseTree) => enqueueRemoteMutation({
    type: "folder-delete", id, baseTree
  })
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
  persistAnnotations,
  persistCurrentAnnotations,
  attachLifecyclePersistence,
  attachLifecycleRestore,
  attachAnnotationsAutoPersistence
} = createAnnotationsLifecycle({
  peekMeta,
  loadMeta,
  loadMetaAsync,
  saveMeta,
  now,
  shouldSkipLifecyclePersistence: () => (
    window.zion?.state?.get(INTENTIONAL_RELOAD_KEY) === true
  ),
  getZion: () => window.zion
});

/**
 * Restore persisted annotations for a session by emitting plugin events.
 * Tool-call cards and thinking cards will rebuild themselves based on saved positions.
 */
function applyAnnotationsForSession(id, panelId) {
  try {
    const meta = peekMeta(id);
    debugSessions("annotations.apply", {
      sessionId: id,
      panelId: panelId || null,
      tools: Array.isArray(meta?.annotations?.tools) ? meta.annotations.tools.length : 0,
      thinking: Array.isArray(meta?.annotations?.thinking) ? meta.annotations.thinking.length : 0,
      toolIds: Array.isArray(meta?.annotations?.tools) ? meta.annotations.tools.map((it) => it?.id).filter(Boolean).map(String) : []
    });
  } catch {}
  return applyAnnotationsForSessionImpl({ id, panelId, loadMeta: peekMeta, zion: window.zion });
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

async function backfillSessionTagIndex() {
  sessionTagIndexBackfillHandle = 0;
  if (!sessionTagIndexReady) return false;
  const sessions = getIndex();
  const activeIds = new Set(
    sessions.map((entry) => String(entry?.id || "").trim()).filter(Boolean)
  );
  const staleIds = [];
  for (const id of activeIds) {
    if (typeof window.zion?.state?.get(`sessions.doc.${id}`) !== "string") continue;
    const indexed = sessionTagIndex.sessions?.[id];
    const metaHash = String(peekMeta(id)?.hash || "");
    if (!indexed || (metaHash && indexed.hash !== metaHash)) staleIds.push(id);
  }
  const hasOrphans = Object.keys(sessionTagIndex.sessions || {})
    .some((id) => !activeIds.has(id));
  if (!staleIds.length && !hasOrphans) return false;

  let next = sessionTagIndex;
  for (const id of staleIds) {
    // Only already-loaded documents participate. Keep extraction synchronous
    // so a suspended backfill cannot overwrite a newer user exclusion edit.
    const text = window.zion?.state?.get(`sessions.doc.${id}`);
    if (typeof text !== "string") continue;
    const metaHash = String(peekMeta(id)?.hash || "");
    next = updateSessionTagIndex(next, id, text, metaHash || hashString(text));
  }
  for (const id of Object.keys(next.sessions || {})) {
    if (!activeIds.has(id)) next = removeSessionTagIndexEntry(next, id);
  }
  commitSessionTagIndex(next, { background: true });
  return true;
}

function scheduleSessionTagIndexBackfill() {
  if (sessionTagIndexBackfillHandle) return;
  const run = () => {
    void backfillSessionTagIndex().catch((error) => {
      try { console.warn("[sessions] tag index backfill failed", error); } catch {}
    });
  };
  if (typeof requestIdleCallback === "function") {
    sessionTagIndexBackfillHandle = requestIdleCallback(run, { timeout: 1600 });
  } else {
    sessionTagIndexBackfillHandle = window.setTimeout(run, 500);
  }
}

async function backfillSessionDocumentPreviews() {
  sessionPreviewBackfillHandle = 0;
  const activeIds = new Set(
    getIndex().map((entry) => String(entry?.id || "").trim()).filter(Boolean)
  );
  const missing = new Set();
  for (const id of activeIds) {
    if (typeof window.zion?.state?.get(`sessions.doc.${id}`) !== "string") continue;
    if (Number(peekMeta(id)?.documentPreviewVersion || 0) < 1) missing.add(id);
  }
  if (!missing.size) return false;

  for (const id of missing) {
    const meta = peekMeta(id) || { id };
    const text = await loadDocAsync(id);
    // A display fallback is local derived data, not a user edit. Persisting
    // every loaded legacy preview floods the write queue and changes ordering.
    window.zion?.state?.set(`sessions.meta.${id}`, {
      ...meta,
      id,
      documentPreview: extractDocumentLeadPreview(text || ""),
      documentPreviewVersion: 1
    });
  }
  try { refreshSessionsSidebarViewIfOpen({ listOnly: true }); } catch {}
  return true;
}

function scheduleSessionDocumentPreviewBackfill() {
  if (sessionPreviewBackfillHandle) return;
  const run = () => {
    void backfillSessionDocumentPreviews().catch((error) => {
      try { console.warn("[sessions] document preview backfill failed", error); } catch {}
    });
  };
  if (typeof requestIdleCallback === "function") {
    sessionPreviewBackfillHandle = requestIdleCallback(run, { timeout: 1800 });
  } else {
    sessionPreviewBackfillHandle = window.setTimeout(run, 700);
  }
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

/** Use the same title projection as Runtime; derived titles are not manual edits. */
function deriveTitleFromText(text) {
  return deriveSessionTitleFromContent(text) || null;
}

/** 默认标题判定（用于旧数据或无 titleAuto 字段时的启发式） */
function isDefaultTitle(t) {
  const s = String(t || "");
  return /^Session\b/i.test(s) || /^Imported Session\b/i.test(s);
}

function getLatestSessionText(id) {
  try {
    const ed = window.zion.window.activeEditor;
    const editorPanelId = ed?.panelId || null;
    const managed = ed?.getView?.()?.dom?.hasAttribute?.("data-editor-id");
    const editorPanelSessionId = ed?.getSessionId?.() || ed?.sessionId || (!managed && editorPanelId
      ? (window.zion?.panelManager?.getPanel?.(editorPanelId)?.activeTabId || null)
      : null);
    if (ed && editorPanelSessionId === id) return ed.getValue() || "";
  } catch {}
  return loadDoc(id) || "";
}

function isMeaningfulAutoRenameContent(text) {
  const cleaned = String(text || "")
    .replace(/^\s*(system|user|assistant|tool)\s+/gim, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 12;
}

/** 未触发对话前，用首行/首句本地派生标题；仍保留 titleAuto=true，之后可被 AI 标题替换。 */
function maybeUpdateLocalAutoTitle(id, opts = {}) {
  try {
    if (!id || window.zion?.state?.get(`sessions.deleted.${id}`)
      || window.zion?.state?.get(`sessions.deleting.${id}`)) return false;
    const meta = loadMeta(id);
    if (!meta || meta.titleAuto !== true) return false;
    const derived = deriveTitleFromText(getLatestSessionText(id));
    if (!derived || derived === meta.title) return false;
    meta.title = derived;
    meta.titleAuto = true;
    saveMeta(id, meta, { automaticTitle: true });
    // The metadata write owns the durable title. Updating the tree as a second
    // write would replay another title snapshot and compete with the server.
    rebuildIndexFromTree();
    try { window.zion.state.set("sessions.catalog", getIndex()); } catch {}
    try { refreshStatusBar(); } catch {}
    if (!opts?.skipRefresh) {
      try { refreshSessionsSidebarViewIfOpen(); } catch {}
    }
    try { updatePageTitle(id); } catch {}
    return true;
  } catch {}
  return false;
}

/** 对话首次触发时，再启动 AI 标题生成；手动改名会通过 titleAuto=false 自动阻止。 */
const maybeTriggerChatAutoRename = createChatAutoRenameTrigger({
  loadMeta, saveMeta, getLatestSessionText, isMeaningfulAutoRenameContent, now
});

/** 兼容旧逻辑：确保初始树/会话存在 */
function ensureInitialSession() {
  ensureInitialTree();
  const idx = getIndex();
  return idx;
}

/** 从索引查会话条目 */
function findInIndex(id) {
  const index = getIndex();
  return index.find(s => s.id === id) || sharedSessionView.entry(id) || null;
}

/** 更新索引条目（无则追加） */
function upsertIndexEntry(entry) {
  if (isSharedWorkbenchDocument(entry.id)) return getIndex();
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
async function deleteSession(id) {
  await purgeSessionData(id);
  // DELETE already committed the tree removal on the Runtime.
  removeNode(id, { persist: false });
  rebuildIndexFromTree();
  return getIndex();
}

/** ========== Broadcast for cross-tab ========== */
let bc = null;
function getChannel() {
  if (bc) return bc;
  try {
    bc = new BroadcastChannel(spaceScopedName("zion.sessions"));
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

const sharedSessionView = createSharedSessionView({
  loadTree, getIndex, loadMeta,
  onChange: () => { refreshSessionsSidebarViewIfOpen(); refreshSessionsOverlayIfOpen(); }
});
const moveSessionWithSharing = createSharedSessionMover({
  getZion: () => window.zion, view: sharedSessionView, moveOwn: moveNode,
  isOwnSession: id => getIndex().some(entry => entry.id === id),
  refreshOwn: refreshRemoteTree, getRevision: id => remoteSessionRevisions.get(id)
});
const createSessionsListRenderer = createSessionsListRendererFactory({
  loadTree: () => sharedSessionView.tree(),
  ensureInitialTree,
  getIndex: () => sharedSessionView.index(),
  loadMeta: id => sharedSessionView.meta(id),
  buildSessionURL,
  truncate,
  setSmallDragImage,
  fmtTime,
  now,
  getSelection: () => getSelection().filter(node => !isReceivedNode(node.id)),
  setSelection: nodes => setSelection(nodes.filter(node => !isReceivedNode(node.id))),
  clearSelection,
  isSelected,
  toggleSelection: node => { if (!isReceivedNode(node.id)) toggleSelection(node); },
  getLastSelectedId,
  setLastSelectedId,
  isFolderOpen,
  setFolderOpen,
  moveNode: moveSessionWithSharing
});

const __panelManager = createSessionsPanelManager({
  zion: window.zion,
  getIndex: () => sharedSessionView.index(),
  createSessionsListRenderer,
  openAncestors: id => { if (!sharedSessionView.openAncestors(id, setFolderOpen)) openAncestors(id); },
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
  openAncestors: id => { if (!sharedSessionView.openAncestors(id, setFolderOpen)) openAncestors(id); },
  getIndex: () => sharedSessionView.index(),
  loadMeta: id => sharedSessionView.meta(id),
  sharingView: sharedSessionView,
  dbName: DB_NAME,
  loadTagCatalog: async () => validateCatalog(
    remoteSessionKV.get("sessions.tagCatalog") || []
  ).entries,
  saveTagCatalog: async (_dbName, entries) => {
    const clean = validateCatalog(entries).entries;
    await enqueueRemoteMutation({
      type: "kv",
      id: "sessions.tagCatalog",
      value: clean
    });
    return clean;
  },
  getAllSessionDocs: async () => {
    const docs = [];
    for (const id of durableSessionIds) {
      try {
        docs.push({ id, text: String(await loadDocAsync(id) || "") });
      } catch {}
    }
    return docs;
  },
  writeSessionDoc: async (id, text) => {
    await saveDoc(String(id || ""), String(text || ""));
  }
});

function refreshSessionsSidebarViewIfOpen(opts) {
  __sidebarViewManager.refreshIfOpen(opts);
}

function mountSessionsSidebarViewInto(container) {
  return __sidebarViewManager.mountInto(container);
}

const __pageTitleManager = createPageTitleManager({
  zion: window.zion,
      defaultTitle: "Zioon",
  loadMeta: peekMeta,
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
      forceReload: !!opts?.forceReload,
      skipPersistPrevious: !!opts?.skipPersistPrevious
    });
  }
  window.zion.state.set("sessions.currentId", sessionId);
  const text = opts?.text != null ? String(opts.text) : await loadDocAsync(sessionId);
  window.zion.window.activeEditor?.setSessionId?.(sessionId);
  window.zion.window.activeEditor?.setValue(text, { source: "session-load" });
  try { applyAnnotationsForSession(sessionId); } catch {}
  return true;
}

const removeSessionsFromPanels = ids => removeDeletedSessions({
  zion: window.zion, ids, getIndex, getLastActiveId, setLastActiveId, openSessionForPanel
});
const removeSessionFromPanels = id => removeSessionsFromPanels([id]);

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
            saveNewSession(id, doc, meta);
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

/** ========== Activate Extension ========== */
export async function activate(ctx) {
  window.zion?.state?.set("sessions.ready", false);
  clearStorageWarning();
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  // Recover legacy browser data, then preload the authoritative Runtime snapshot.
  const storageStatus = await initSessionsStorage();
  if (!storageStatus?.ok) {
    try { window.zion?.state?.set("sessions.storageUnavailable", true); } catch {}
    try { window.zion?.state?.set("sessions.catalog", getIndex()); } catch {}
    try {
      window.zion?.notification?.show?.(
        "Runtime 会话存储暂不可用。",
        {
          type: "error", duration: 0, dismissible: true,
          actions: [{
            label: "重试",
            handler: () => { void window.zion?.plugins?.retryFailedPlugins?.(); }
          }]
        }
      );
    } catch {}
    throw storageStatus.error || new Error("Session storage initialization failed");
  }
  try { window.zion?.state?.set("sessions.storageUnavailable", false); } catch {}
  try { window.zion?.state?.set("sessions.clientId", WORKBENCH_CLIENT_ID); } catch {}
  const realtimeSync = startRemoteRealtimeSync();
  ctx.subscriptions.push({
    dispose() {
      remoteMutationQueue.dispose();
      sessionConflictNotifications.dispose();
      realtimeSync.dispose();
      remoteRealtimeSync = null;
      if (remoteSyncTimer) {
        window.clearInterval(remoteSyncTimer);
        remoteSyncTimer = 0;
      }
    }
  });
  const collaborationManager = createSessionCollaborationManager({
    zion: window.zion,
    clientId: WORKBENCH_CLIENT_ID,
    getSessionCreation: id => sessionCreationSaves.get(id)
  });
  ctx.subscriptions.push(window.zion.commands.registerCommand("zion.sessions.restoreCollaborationDraft", async (id, copyIndex = 0) => {
    const sessionId = String(id || window.zion.state.get("sessions.currentId") || "");
    const draft = window.zion.state.get(`sessions.collaborationDraft.${sessionId}`);
    const copy = [draft, ...(draft?.alternatives || [])][copyIndex];
    if (typeof copy?.text !== "string") return false;
    return window.zion.commands.executeCommand("zion.sessions.new", {
      content: copy.text, title: `${loadMeta(sessionId)?.title || "Session"} · 恢复草稿`
    });
  }));
  ctx.subscriptions.push(window.zion.commands.registerCommand("zion.sessions.search", async (options = {}) => {
    if (remoteStorageOnline) return searchRemoteSessions(options);
    const query = String(options.query || "").trim().toLowerCase();
    const offset = Math.max(0, Number(options.offset) || 0);
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
    const matches = [];
    for (const entry of getIndex()) {
      const text = query ? String(await loadDocAsync(entry.id) || "") : "";
      const position = text.toLowerCase().indexOf(query);
      if (query && !String(entry.title || "").toLowerCase().includes(query) && position < 0) continue;
      matches.push({ ...entry, snippet: text.slice(Math.max(0, position - 80), Math.max(0, position - 80) + 240) });
    }
    return { sessions: matches.slice(offset, offset + limit), hasMore: matches.length > offset + limit, nextOffset: offset + limit };
  }));
  const collaborationAnchorCommand = window.zion?.commands?.registerCommand?.(
    "zion.sessions.createCollaborationAnchor",
    ({ id, index, before, after } = {}) =>
      collaborationManager.createAnchor(id, index, { before, after })
  );
  if (collaborationAnchorCommand) ctx.subscriptions.push(collaborationAnchorCommand);
  ctx.subscriptions.push(window.zion.commands.registerCommand("zion.sessions.flushCollaboration", (id) =>
    collaborationManager.flush({ sessionId: String(id || "") })
  ));
  ctx.subscriptions.push(window.zion.commands.registerCommand("zion.sessions.flushRunInput", async (id) => {
    const sessionId = String(id || "");
    const creation = sessionCreationSaves.get(sessionId);
    if (creation && !await creation) return false;
    if (window.zion?.state?.get(`sessions.deleted.${sessionId}`)) return false;
    if (collaborationManager.enabled && !collaborationManager.isSynced(sessionId)) {
      if (!await collaborationManager.flush({ sessionId })) return false;
    }
    if (window.zion?.state?.get(`sessions.deleted.${sessionId}`)) return false;
    if (!collaborationManager.isSynced(sessionId)) {
      return window.zion.commands.executeCommand("zion.sessions.flushPendingSave", sessionId);
    }
    // The synchronized document owns run input. Metadata and sidebar writes
    // continue through the autosave queue without delaying model admission.
    plugin?.flush?.(sessionId);
    void flushSessionRemoteMutations(sessionId);
    return collaborationManager.flush({ sessionId });
  }));
  if (collaborationManager.enabled) {
    const collaborationDecorator = window.zion?.editor?.registerDecorator?.({
      id: "dev.session-manager.collaboration",
      apply: (editor) => collaborationManager.bindEditor(editor)
    });
    if (collaborationDecorator) ctx.subscriptions.push(collaborationDecorator);
  }
  ctx.subscriptions.push({
    dispose() {
      collaborationManager.dispose();
    }
  });
  const activeRunDiscovery = window.zion?.events?.on?.(
    "session/afterSwitch",
    ({ sessionId } = {}) => {
      void discoverActiveSessionRun(sessionId);
    }
  );
  if (activeRunDiscovery) ctx.subscriptions.push(activeRunDiscovery);
  void discoverActiveSessionRun(
    window.zion?.state?.get?.("sessions.currentId")
  );
  scheduleSessionTagIndexBackfill();
  ctx.subscriptions.push(registerSessionTreeCommands({
    zion: window.zion,
    loadTree,
    insertFolder,
    moveNode,
    getIndex,
    refreshSessionsSidebarViewIfOpen
  }));

  const markSessionViewed = (sessionId) => markSessionRunViewed(window.zion, sessionId);
  const isSessionCurrentlyVisible = (sessionId) => {
    const sid = String(sessionId || "").trim();
    if (!sid || document.visibilityState === "hidden") return false;
    if (sid.startsWith("comment:")) {
      try {
        const panelVisible = window.zion?.state?.get?.("ui.auxiliaryBar.visible") === true;
        const activeViewId = String(window.zion?.state?.get?.("ui.auxiliaryBar.activeViewId") || "");
        const activeThreadId = String(window.zion?.state?.get?.("comments.activeThreadId") || "");
        return panelVisible && activeViewId === "dev.comments.panel" && sid === `comment:${activeThreadId}`;
      } catch {
        return false;
      }
    }
    try {
      const panels = window.zion?.panels?.list?.() || [];
      const activePanelId = String(window.zion?.panels?.getActivePanelId?.() || "");
      const activePanel = activePanelId
        ? panels.find((panel) => String(panel?.id || "") === activePanelId)
        : null;
      if (activePanel) return String(activePanel.activeTabId || "") === sid;
    } catch {}
    try {
      return String(window.zion?.state?.get?.("sessions.currentId") || "") === sid;
    } catch {
      return false;
    }
  };
  const markSessionViewedIfVisible = (sessionId) => {
    if (!isSessionCurrentlyVisible(sessionId)) return false;
    return markSessionViewed(sessionId);
  };
  const dMarkSessionViewed = window.zion.commands.registerCommand("zion.sessions.markViewed", markSessionViewed);
  const dToggleViewMode = window.zion.commands.registerCommand("zion.sessions.toggleViewMode", () => {
    try {
      return __sidebarViewManager.toggleSessionViewModeIfOpen?.();
    } catch {
      return undefined;
    }
  });
  const dToggleTagSplit = window.zion.commands.registerCommand("zion.sessions.toggleTagSplit", () => {
    try {
      return __sidebarViewManager.toggleTagSplitIfOpen?.();
    } catch {
      return undefined;
    }
  });
  const dTagExclusions = registerSessionTagExclusionCommands({
    zion: window.zion,
    getIndex: () => sessionTagIndex,
    commitIndex: commitSessionTagIndex,
    getCurrentSessionId: () => window.zion?.state?.get?.("sessions.currentId")
  });
  ctx.subscriptions.push(
    dMarkSessionViewed,
    dToggleViewMode,
    dToggleTagSplit,
    dTagExclusions
  );

  // 初始化树/索引/会话
  ensureInitialTree();
  rebuildIndexFromTree();
  ctx.subscriptions.push(window.zion.commands.registerCommand(
    "zion.sessions.peekAnnotations", id => id ? peekMeta(id)?.annotations ?? null : null
  ));
  ctx.subscriptions.push(sharedSessionView.start(window.zion));
  const sharingReady = sharedSessionView.refresh();
  const shouldStartEmpty = window.zion?.state?.get?.("sessions.startEmpty") === true;
  const lastId = shouldStartEmpty ? null : getLastActiveId();
  // Received documents must be registered with their origin and access role
  // before routing any document request. Private catalog entries already are.
  if (lastId && !getIndex().some(entry => entry.id === lastId)) await sharingReady;
  // 注册会话相关工具（供大模型使用）
  try { registerSessionTools(); } catch {}
  let currentId = shouldStartEmpty ? null : (lastId || getIndex()[0]?.id || null);
  try {
    if (currentId && !findInIndex(currentId)) {
      currentId = getIndex()[0]?.id || null;
    }
  } catch {}
  if (currentId) setLastActiveId(currentId);
  else setLastActiveId(null);
  window.zion.state.set("sessions.currentId", currentId);
  window.zion.state.set("sessions.catalog", getIndex());
  const sessionUiState = new Map();

  // 初始化页面标题
  updatePageTitle(currentId);

  // 将当前会话内容加载到编辑器
  const ed = window.zion.window.activeEditor;
  if (ed && currentId && window.zion?.state?.get("sessions.restoreWorkspace") !== true) {
    const presentation = beginSessionPresentation(ed);
    try {
      const text = await loadDocAsync(currentId);
      const collaborationBound =
        ed?.getView?.()?.dom?.dataset?.zionCollaborationBound === "true";
      if (!collaborationBound) {
        ed.setValue(text, { source: "session-load" });
      }
      try { await applyAnnotationsForSession(currentId); } catch {}
      await presentation.finish();
    } catch (e) {
      presentation.fail(() => { void window.zion?.plugins?.retryFailedPlugins?.(); });
      console.error("[sessions] setValue error:", e);
      throw e;
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
          try { maybeUpdateLocalAutoTitle(sid); } catch {}
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
    let panelFocusViewedRaf = 0;
    const dispPanelFocus = window.zion.events.on("panel/focusChanged", ({ panelId } = {}) => {
      if (!panelId) return;
      if (panelFocusViewedRaf) window.cancelAnimationFrame(panelFocusViewedRaf);
      panelFocusViewedRaf = window.requestAnimationFrame(() => {
        panelFocusViewedRaf = 0;
        if (window.zion?.panels?.getActivePanelId?.() !== panelId) return;
        const panel = window.zion?.panels?.list?.().find?.((item) => item?.id === panelId) || null;
        markSessionViewed(panel?.activeTabId);
      });
    });
    const dispSessionSwitch = window.zion.events.on("session/afterSwitch", ({ sessionId } = {}) => {
      markSessionViewed(sessionId);
    });
    ctx.subscriptions.push(dispPanelFocus, dispSessionSwitch, {
      dispose() {
        if (panelFocusViewedRaf) window.cancelAnimationFrame(panelFocusViewedRaf);
      }
    });
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
      icon: "$(messages-square)",
      tooltip: t("ui.sessions", "Sessions"),
      tooltipKey: "dev.session-manager.ui.sessions",
      sideBarViewId: "sessions.list",
      order: 10
    });
    const dispView = window.zion.sideBar.registerView({
      id: "sessions.list",
      pluginId: "dev.session-manager",
      title: t("ui.sessions", "Sessions"),
      titleKey: "dev.session-manager.ui.sessions",
      icon: "$(messages-square)",
      order: 10,
      location: "sidebar",
      headerLeading: {
        render: (container, context) => renderSessionsTagHeader(container, context, {
          manager: __sidebarViewManager,
          t
        })
      },
      headerActions: [
        {
          id: "sessions.viewMode",
          title: t("ui.toggleViewMode", "Toggle list/card view"),
          titleKey: "dev.session-manager.ui.toggleViewMode",
          ariaLabel: t("ui.toggleViewMode", "Toggle list/card view"),
          ariaLabelKey: "dev.session-manager.ui.toggleViewMode",
          icon: "$(layout-grid)",
          active: () => __sidebarViewManager.getSessionViewMode?.() === "card",
          onClick: () => window.zion.commands.executeCommand("zion.sessions.toggleViewMode")
        },
        {
          id: "sessions.tagSplit",
          title: t("ui.toggleTagSplit", "Toggle tag column"),
          titleKey: "dev.session-manager.ui.toggleTagSplit",
          ariaLabel: t("ui.toggleTagSplit", "Toggle tag column"),
          ariaLabelKey: "dev.session-manager.ui.toggleTagSplit",
          icon: "$(tag)",
          active: () => !!__sidebarViewManager.isTagSplitEnabled?.(),
          onClick: () => window.zion.commands.executeCommand("zion.sessions.toggleTagSplit")
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
      },
      onActivate: () => __sidebarViewManager.activateTagSplitWidthIfEnabled?.(),
      onDeactivate: () => __sidebarViewManager.deactivateTagSplitWidthIfEnabled?.()
    });
    ctx.subscriptions.push(dispItem, dispView);
    ctx.subscriptions.push(window.zion.events.on("i18n/changed", () => {
      try { refreshSessionsSidebarViewIfOpen(); } catch {}
      try { refreshSessionsOverlayIfOpen(); } catch {}
    }));
      const refreshRelatedChildren = () => {
        try { refreshSessionsSidebarViewIfOpen({ listOnly: true }); } catch {}
    };
    window.addEventListener("zion:comments-changed", refreshRelatedChildren);
    window.addEventListener("zion:agents-changed", refreshRelatedChildren);
    ctx.subscriptions.push({
      dispose() {
        try { window.removeEventListener("zion:comments-changed", refreshRelatedChildren); } catch {}
        try { window.removeEventListener("zion:agents-changed", refreshRelatedChildren); } catch {}
      }
    });
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
      ch.onmessage = null;
    }
    if (collaborationManager.enabled) {
      window.zion.state.set("sessions.externalUpdate", null);
    } else if (ch) {
      const onLegacySessionMessage = (ev) => {
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
      ch.onmessage = onLegacySessionMessage;
      ctx.subscriptions.push({
        dispose() {
          if (ch.onmessage === onLegacySessionMessage) ch.onmessage = null;
        }
      });
    }
  } catch {}

  // 自动保存插件（通过 Decorator 注入）
  const plugin = sessionAutoSavePlugin(
    (view) => {
      try {
        const editorSessionId = view?.dom?.getAttribute?.("data-session-id") || null;
        // Managed editors retain their own identity while the active tab changes.
        // A retired editor with no session must never inherit the replacement tab.
        if (view?.dom?.hasAttribute?.("data-editor-id")) return editorSessionId;
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
      try { maybeUpdateLocalAutoTitle(meta?.id); } catch {}
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

  ctx.subscriptions.push(registerSessionFlushCommand({
    zion: window.zion,
    plugin,
    flushRemote: flushSessionRemoteMutations
  }));
  ctx.subscriptions.push(window.zion.commands.registerCommand(
    "zion.sessions.prepareForReload",
    createSessionReloadPreparation({
      zion: window.zion, plugin, collaborationManager,
      queue: remoteMutationQueue, persistAnnotations: persistCurrentAnnotations
    })
  ));
  try { window.zion?.state?.set(INTENTIONAL_RELOAD_KEY, false); } catch {}
  try { window.zion?.state?.set(RELOAD_PREPARING_KEY, false); } catch {}
  const flushPendingSessionWrites = () => {
    try {
      if (window.zion?.state?.get(INTENTIONAL_RELOAD_KEY) === true) return;
    } catch {}
    try { plugin.flush(); } catch {}
    void flushRemoteMutations();
  };
  const flushWhenHidden = () => {
    if (document.visibilityState === "hidden") flushPendingSessionWrites();
  };
  const protectPendingWrites = (event) => {
    try {
      if (window.zion?.state?.get(INTENTIONAL_RELOAD_KEY) === true) return;
    } catch {}
    if (!remoteMutationQueue.hasUnpersistedChanges
      && !plugin.hasPendingDrafts()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("pagehide", flushPendingSessionWrites);
  window.addEventListener("beforeunload", protectPendingWrites);
  document.addEventListener("visibilitychange", flushWhenHidden);
  ctx.subscriptions.push({
    dispose() {
      window.removeEventListener("pagehide", flushPendingSessionWrites);
      window.removeEventListener("beforeunload", protectPendingWrites);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    }
  });

  try {
    let prefetchTimer = 0;
    const schedulePrefetch = () => {
      try { if (prefetchTimer) cancelIdleCallback(prefetchTimer); } catch {}
      try { if (prefetchTimer) clearTimeout(prefetchTimer); } catch {}
      const idle = typeof requestIdleCallback === "function";
      const fn = async () => {
        const panels = window.zion?.panels?.list?.() || [];
        const arr = panels.map(panel => panel?.activeTabId);
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
        for (const id of uniq) {
          if (remoteStorageOnline && !durableSessionIds.has(id)) continue;
          try {
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
    const targetPanelId = opts?.panelId || (() => {
      try { return window.zion?.panels?.getActivePanelId?.() || null; } catch { return null; }
    })();
    const parentId = (() => {
      if (opts?.parentId) return opts.parentId;
      const curId = targetPanelId
        ? (window.zion?.panels?.list?.().find((panel) => panel.id === targetPanelId)?.activeTabId || null)
        : window.zion.state.get("sessions.currentId");
      if (curId) {
        const tree = isReceivedNode(curId) ? sharedSessionView.tree() : loadTree() || ensureInitialTree();
        const { parent } = findNodeAndParent(tree, curId);
        if (parent && parent.type === "folder") return parent.id;
      }
      return window.zion.state.get("sessions.selectedFolderId") || "root";
    })();
    if (isReceivedNode(parentId)) {
      const id = await sharedSessionView.mutate(parentId, {
        action: "createDocument", title: String(opts.title || "New Session"), text: String(opts.content || "")
      });
      if (opts.open !== false) await window.zion.commands.executeCommand("zion.sessions.switch", id, { panelId: opts.panelId });
      return id;
    }
    const suggested = `Session ${getIndex().length + 1}`;
    const id = genId();
    const text = String(opts?.content ?? "");
    const shouldOpen = opts?.open !== false;
    // Keep new sessions on a stable placeholder; AI rename runs once after real content arrives.
    const explicitTitle = String(opts?.title || "").trim();
    const title = explicitTitle || suggested;
    const extraMeta = opts?.meta && typeof opts.meta === "object" ? opts.meta : {};
    const meta = {
      ...extraMeta,
      id,
      title,
      createdAt: now(),
      updatedAt: now(),
      size: text.length,
      hash: hashString(text),
      titleAuto: !explicitTitle
    };
    window.zion.state.set(`sessions.localDraft.${id}`, true);
    saveNewSession(id, text, meta);
    console.info("[sessions] new: creating", { id, parentId, title: meta.title });
    insertSessionNode(id, parentId, meta.title);
    rebuildIndexFromTree();
    if (shouldOpen) setLastActiveId(id, { push: true });
    window.zion.state.set("sessions.catalog", getIndex());
    if (shouldOpen) {
      try {
        const rs = window.zion.state.get(`chat.runs.${id}`);
        window.zion.state.set("chat.streaming", !!rs?.streaming);
      } catch {}
    }
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
    // Background callers create a normal indexed session without stealing focus
    // or replacing the document currently shown in an editor panel.
    if (shouldOpen) {
      if (targetPanelId && typeof window.zion?.panels?.openSession === "function") {
        await window.zion.panels.openSession(targetPanelId, id, { focus: opts?.focus !== false, forceReload: true });
      } else {
        window.zion.state.set("sessions.currentId", id);
        const ed = window.zion.window.activeEditor;
        ed?.setValue(text, { source: "session-load" });
        try { applyAnnotationsForSession(id); } catch {}
        ed?.focus?.();
      }
      if (opts?.focus !== false) {
        const focusCreatedEditor = () => {
          const activeSessionId = targetPanelId
            ? window.zion?.panels?.list?.().find((panel) => panel.id === targetPanelId)?.activeTabId
            : window.zion?.state?.get?.("sessions.currentId");
          if (String(activeSessionId || "") !== id) return;
          const targetEditor = targetPanelId
            ? window.zion?.panels?.getEditor?.(targetPanelId)
            : window.zion?.window?.activeEditor;
          try { targetEditor?.focus?.(); } catch {}
          try { targetEditor?.getView?.()?.contentDOM?.focus?.({ preventScroll: true }); } catch {}
        };
        focusCreatedEditor();
        globalThis.queueMicrotask(focusCreatedEditor);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          focusCreatedEditor();
          window.setTimeout(focusCreatedEditor, 60);
        }));
      }
    }
    refreshStatusBar();
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    postSaved(id, meta.updatedAt, meta.hash);
    if (shouldOpen) {
      // 更新页面标题
      updatePageTitle(id);
      try { maybeUpdateLocalAutoTitle(id); } catch {}
    }
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
    saveNewSession(id, text, meta);
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
    try { maybeUpdateLocalAutoTitle(id); } catch {}
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
    if (isReceivedNode(id)) {
      const entry = sharedSessionView.entry(id);
      const title = opts?.title || await openModalInput({ title: t("dialog.rename", "Rename session"),
        value: entry?.title || "", okText: "Rename", cancelText: "Cancel" });
      if (!String(title || "").trim()) return false;
      await sharedSessionView.mutate(id, { action: "rename", title: String(title).trim() });
      window.zion.events?.emit?.("session/renamed", { id, title });
      return true;
    }
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
    if (window.zion.state.get(`sessions.deleted.${id}`) === true
      || window.zion.state.get(`sessions.deleting.${id}`) === true) return false;
    const meta = loadMeta(id) || { id };
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
    void updateRemoteRuntimeSession(id, { title }).catch((error) => {
      if (Number(error?.status || 0) !== 404) {
        console.warn("[sessions] Runtime title synchronization failed", error);
      }
    });
    return true;
  });
  ctx.subscriptions.push(dRename);
  const dAutoRename = registerSessionAutoRenameCommand({ zion: window.zion, loadDoc });
  ctx.subscriptions.push(dAutoRename);

  // Delete
  const deletionController = createSessionDeletionController(window.zion);
  const deletionSessionIds = targets => {
    const tree = loadTree();
    const ids = [];
    const collect = node => {
      if (node?.type === "session") ids.push(node.id);
      else for (const child of node?.children || []) collect(child);
    };
    for (const item of targets) {
      if (item.type === "session") ids.push(item.id);
      else collect(tree && findNodeAndParent(tree, item.id).node);
    }
    return ids;
  };
  const refreshAfterDelete = () => {
    window.zion.state.set("sessions.catalog", getIndex());
    refreshStatusBar();
    updatePageTitle();
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    try { refreshSessionsOverlayIfOpen(); } catch {}
  };
  const dDelete = window.zion.commands.registerCommand("zion.sessions.delete", async (id) => {
    if (!id) return false;
    if (isReceivedNode(id)) {
      await sharedSessionView.mutate(id, { action: "delete" });
      await removeSessionFromPanels(id);
      return true;
    }
    return deletionController.run({
      targets: [{ type: "session", id }], sessionIds: [id],
      execute: async progress => {
        await deleteSession(id);
        progress(1);
        void Promise.resolve(removeSessionFromPanels(id)).catch(error =>
          warnStorageIssue("switchAfterDelete", error, { operation: "read" }));
        refreshAfterDelete();
        return true;
      }
    });
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
    try { maybeUpdateLocalAutoTitle(sessionId); } catch {}
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
            const anchor = state?.scrollAnchor;
            const st = state?.scrollTop;
            const hasExplicitScrollState = !!(anchor && typeof anchor.pos === "number" && isFinite(anchor.pos));
            const preservedScroll = !hasExplicitScrollState && view?.scrollDOM
              ? {
                  top: Math.max(0, Number(view.scrollDOM.scrollTop) || 0),
                  left: Math.max(0, Number(view.scrollDOM.scrollLeft) || 0)
                }
              : null;
            const restorePreservedScroll = (phase) => {
              if (!preservedScroll || !view?.scrollDOM) return;
              try {
                const beforeTop = Math.max(0, Number(view.scrollDOM.scrollTop) || 0);
                view.scrollDOM.scrollTop = preservedScroll.top;
                view.scrollDOM.scrollLeft = preservedScroll.left;
              } catch {}
            };
            if (cursor && typeof cursor.line === "number" && typeof cursor.ch === "number") {
              const doc = view.state.doc;
              const line = doc.line(Math.max(1, Math.min(doc.lines, cursor.line + 1)));
              const pos = line.from + Math.max(0, Math.min(line.length, cursor.ch));
              view.dispatch({ selection: { anchor: pos } });
              restorePreservedScroll("sync-after-selection");
              requestAnimationFrame(() => {
                try {
                  restorePreservedScroll("raf1-after-selection");
                  requestAnimationFrame(() => restorePreservedScroll("raf2-after-selection"));
                } catch {}
              });
              setTimeout(() => restorePreservedScroll("timeout80-after-selection"), 80);
              setTimeout(() => restorePreservedScroll("timeout180-after-selection"), 180);
            }
            const applyScroll = () => {
              try {
                if (!view?.scrollDOM) return;
                const doc = view.state.doc;
                if (anchor && typeof anchor.pos === "number" && isFinite(anchor.pos)) {
                  const p = Math.max(0, Math.min(doc.length, anchor.pos));
                  const block = view.lineBlockAt(p);
                  const yOff = typeof anchor.yOffset === "number" && isFinite(anchor.yOffset) ? anchor.yOffset : 0;
                  const nextTop = Math.max(0, block.top + yOff);
                  view.scrollDOM.scrollTop = nextTop;
                  return;
                }
                if (typeof st === "number" && isFinite(st)) {
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
    getActivePanelId: () => window.zion?.panels?.getActivePanelId?.() || null,
    setGlobalSessionId: (id) => window.zion.state.set("sessions.currentId", id),
    getTargetEditor,
    persistPreviousSession: persistSessionPresentation,
    setLastActiveId,
    loadDocument: (id) => {
      try {
        const prefetched = window.zion.state.get(`sessions.doc.${id}`);
        if (typeof prefetched === "string") return prefetched;
      } catch {}
      return loadDocAsync(id);
    },
    applyAnnotations: applyAnnotationsForSession,
    restoreUiState: async (id, panelId) => {
      if (window.zion.state.get("sessions.restoreWorkspace") === true && panelId) {
        return window.zion.commands.executeCommand("zion.panels.restoreInitialView", panelId);
      }
      restoreSessionViewState(id, panelId);
    },
    afterSwitch: (id, panelId) => {
      try { maybeUpdateLocalAutoTitle(id); } catch {}
      markSessionViewed(id);
      if (panelId && window.zion?.panels?.getActivePanelId?.() !== panelId) return;
      const rs = window.zion.state.get(`chat.runs.${id}`);
      window.zion.state.set("chat.streaming", !!rs?.streaming);
      refreshStatusBar();
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
          const result = await window.zion.panels.openSession(opts.panelId, id, {
            focus: opts?.focus !== false, forceReload: opts?.forceReload,
            skipPersistPrevious: opts?.skipPersistPrevious
          });
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
      loadDocAsync,
      loadMeta,
        loadMetaAsync,
      saveDoc,
      saveMeta,
      now,
      hashString,
      upsertIndexEntry,
      getIndex,
      refreshSessionsSidebarViewIfOpen,
      onDocChanged: (id) => {
        try { maybeUpdateLocalAutoTitle(id); } catch {}
      }
    })
  );

  // ===== Background annotations for non-active sessions (thinking/tool calls) =====
  // Persist markers and card content into session docs/meta so they can be restored when switching back.
  const writerLeases = createChatCardWriterLeases(window.zion);
  const dispRunStarted = window.zion.events.on("chat/runStarted", (payload = {}) => {
    const { runId, sessionId } = payload;
    writerLeases.startRun(payload);
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
  const dispRunFinishedUI = window.zion.events.on("chat/runFinished", ({ sessionId, recovered } = {}) => {
    if (!recovered) {
      try { maybeTriggerChatAutoRename(sessionId); } catch {}
    }
    markSessionViewedIfVisible(sessionId);
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    try { refreshSessionsOverlayIfOpen(); } catch {}
  });
  const dispRunErrorUI = window.zion.events.on("chat/runError", ({ sessionId }) => {
    markSessionViewedIfVisible(sessionId);
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    try { refreshSessionsOverlayIfOpen(); } catch {}
  });
  const dispAbortedUI = window.zion.events.on("chat/aborted", ({ sessionId }) => {
    markSessionViewedIfVisible(sessionId);
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    try { refreshSessionsOverlayIfOpen(); } catch {}
  });
  ctx.subscriptions.push(dispRunStarted, dispRunFinishedUI, dispRunErrorUI, dispAbortedUI);

  const backgroundWriteQueues = new Map();
  const enqueueBackgroundWrite = (key, payload, task) => {
    const previous = backgroundWriteQueues.get(key) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => {
        if (!writerLeases.isWriteValid(payload)) return;
        return task(() => writerLeases.isWriteValid(payload));
      })
      .finally(() => {
        if (backgroundWriteQueues.get(key) === next) backgroundWriteQueues.delete(key);
      });
    backgroundWriteQueues.set(key, next);
    return next;
  };

  const dispReasoningStart = window.zion.events.on("chat/reasoningStart", async (payload = {}) => {
    try {
      const { runId, sessionId, silentReasoning, assistantBlockId } = payload;
      if (silentReasoning) return;
      if (!assistantBlockId || !writerLeases.claimRun(payload)) return;

      // seq for this run
      const key = `thinking.seq.${sessionId}.${runId}`;
      const seq = (window.zion.state.get(key) || 0) + 1;
      window.zion.state.set(key, seq);
      const thinkingId = `thinking:${runId}:${seq}`;

      await enqueueBackgroundWrite(`thinking:${sessionId}:${runId}`, payload, async (isWriteValid) => {
        if (!isWriteValid()) return;
        let start = 0;
        let end = 0;
        let inserted = false;
        await window.zion.commands.executeCommand("zion.sessions.transformDoc", {
          id: sessionId,
          transform: (doc) => {
            if (!isWriteValid()) return null;
            const plan = planAssistantMarkerInsertionById({
              docText: doc,
              assistantBlockId,
              markerText: thinkingMarkerText(thinkingId),
              trailingNewlines: 2
            });
            if (!plan) return null;
            start = plan.markerFrom;
            end = plan.markerTo;
            inserted = true;
            return doc.slice(0, plan.replaceFrom) + plan.insertText + doc.slice(plan.replaceTo);
          }
        });
        if (!isWriteValid()) return;
        if (!inserted) {
          try {
            const previous = window.zion.commands.executeCommand("zion.chatCards.getPendingRestore", {
              sessionId,
              kind: "thinking"
            }) || [];
            const item = { id: thinkingId, runId, assistantBlockId, text: "", expanded: false };
            const next = previous.filter((entry) => String(entry?.id || "") !== thinkingId);
            window.zion.commands.executeCommand("zion.chatCards.setPendingRestore", {
              sessionId,
              kind: "thinking",
              items: [...next, item]
            });
          } catch {}
          return;
        }

        const meta = loadMeta(sessionId);
        const ann = meta.annotations || {};
        const list = Array.isArray(ann.thinking) ? ann.thinking.slice() : [];
        list.push({ id: thinkingId, text: "", expanded: false, from: start, to: end, runId, assistantBlockId });
        meta.annotations = { ...ann, thinking: list };
        saveMeta(sessionId, meta);
      });
    } catch (e) {
      console.warn("[sessions] background reasoningStart error:", e);
    }
  });
  ctx.subscriptions.push(dispReasoningStart);

  const dispReasoningToken = window.zion.events.on("chat/reasoningToken", async (payload = {}) => {
    try {
      const { runId, sessionId, token, silentReasoning } = payload;
      if (silentReasoning) return;
      if (!writerLeases.ownsRun(payload)) return;
      const key = `thinking.seq.${sessionId}.${runId}`;
      const seq = window.zion.state.get(key) || 1;
      const thinkingId = `thinking:${runId}:${seq}`;
      await enqueueBackgroundWrite(`thinking:${sessionId}:${runId}`, payload, (isWriteValid) => {
        if (!isWriteValid()) return;
        const meta = loadMeta(sessionId);
        const ann = meta.annotations || {};
        const list = Array.isArray(ann.thinking) ? ann.thinking.slice() : [];
        const i = list.findIndex(it => it.id === thinkingId);
        if (i >= 0) {
          if (!isWriteValid()) return;
          list[i] = { ...list[i], text: (list[i].text || "") + String(token || "") };
          meta.annotations = { ...ann, thinking: list };
          saveMeta(sessionId, meta);
          return;
        }
        try {
          const previous = window.zion.commands.executeCommand("zion.chatCards.getPendingRestore", {
            sessionId,
            kind: "thinking"
          }) || [];
          const next = previous.map((entry) =>
            String(entry?.id || "") === thinkingId
              ? { ...entry, text: (entry.text || "") + String(token || "") }
              : entry
          );
          window.zion.commands.executeCommand("zion.chatCards.setPendingRestore", {
            sessionId,
            kind: "thinking",
            items: next
          });
        } catch {}
      });
    } catch (e) {
      console.warn("[sessions] background reasoningToken error:", e);
    }
  });
  ctx.subscriptions.push(dispReasoningToken);

  const dispToolCall = window.zion.events.on("chat/toolCall", async (payload = {}) => {
    try {
      const { runId, sessionId, toolCall, assistantBlockId } = payload;
      const name = toolCall?.name || "tool";
      const toolCallId = String(toolCall?.id || "");
      const cardId = resolveToolCardId(payload);
      if (!toolCallId || !cardId) return;
      if (!assistantBlockId || !writerLeases.claimCard(payload, cardId)) return;

      await enqueueBackgroundWrite(`tool:${sessionId}:${cardId}`, payload, async (isWriteValid) => {
        if (!isWriteValid()) return;
        let start = 0;
        let end = 0;
        let inserted = false;
        await window.zion.commands.executeCommand("zion.sessions.transformDoc", {
          id: sessionId,
          transform: (doc) => {
            if (!isWriteValid()) return null;
            const plan = planAssistantMarkerInsertionById({
              docText: doc,
              assistantBlockId,
              markerText: toolMarkerText(name, cardId),
              trailingNewlines: 1
            });
            if (!plan) return null;
            start = plan.markerFrom;
            end = plan.markerTo;
            inserted = true;
            return doc.slice(0, plan.replaceFrom) + plan.insertText + doc.slice(plan.replaceTo);
          }
        });
        if (!isWriteValid()) return;
        const item = {
          id: cardId,
          toolCallId,
          runId,
          name,
          args: toolCall.args,
          result: null,
          expanded: false,
          assistantBlockId,
          ...(inserted ? { from: start, to: end } : {})
        };
        if (!inserted) {
          try {
            const previous = window.zion.commands.executeCommand("zion.chatCards.getPendingRestore", {
              sessionId,
              kind: "tools"
            }) || [];
            const next = previous.filter((entry) => String(entry?.id || "") !== cardId);
            window.zion.commands.executeCommand("zion.chatCards.setPendingRestore", {
              sessionId,
              kind: "tools",
              items: [...next, item]
            });
          } catch {}
          return;
        }

        const meta = loadMeta(sessionId);
        const ann = meta.annotations || {};
        const list = Array.isArray(ann.tools) ? ann.tools.slice() : [];
        const existingIndex = list.findIndex((entry) => String(entry?.id || "") === cardId);
        if (existingIndex >= 0) list[existingIndex] = { ...list[existingIndex], ...item };
        else list.push(item);
        meta.annotations = { ...ann, tools: list };
        saveMeta(sessionId, meta);
      });
    } catch (e) {
      console.warn("[sessions] background toolCall error:", e);
    }
  });
  ctx.subscriptions.push(dispToolCall);

  const dispToolResult = window.zion.events.on("chat/toolResult", async (payload = {}) => {
    try {
      const { sessionId, result, ok } = payload;
      const cardId = resolveToolCardId(payload);
      if (!cardId) return;
      if (!writerLeases.ownsCard(payload, cardId)) return;
      await enqueueBackgroundWrite(`tool:${sessionId}:${cardId}`, payload, (isWriteValid) => {
        if (!isWriteValid()) return;
        const meta = loadMeta(sessionId);
        const ann = meta.annotations || {};
        const list = Array.isArray(ann.tools) ? ann.tools.slice() : [];
        const i = list.findIndex(it => String(it?.id || "") === cardId);
        if (i >= 0) {
          if (!isWriteValid()) return;
          list[i] = { ...list[i], result, ok };
          meta.annotations = { ...ann, tools: list };
          saveMeta(sessionId, meta);
        } else {
          try {
            const previous = window.zion.commands.executeCommand("zion.chatCards.getPendingRestore", {
              sessionId,
              kind: "tools"
            }) || [];
            const next = previous.map((entry) =>
              String(entry?.id || "") === cardId ? { ...entry, result, ok } : entry
            );
            window.zion.commands.executeCommand("zion.chatCards.setPendingRestore", {
              sessionId,
              kind: "tools",
              items: next
            });
          } catch {}
        }
        writerLeases.releaseCard(payload, cardId);
      });
    } catch (e) {
      console.warn("[sessions] background toolResult error:", e);
    }
  });
  ctx.subscriptions.push(dispToolResult);

  // Live editor plugins own their session annotations even when another panel is active.
  const persistLiveAnnotations = (payload = {}) => {
    try {
      if (payload?.documentWriter === false) return;
      const cardId = resolveToolCardId(payload);
      if (writerLeases.ownsRun(payload) || (cardId && writerLeases.ownsCard(payload, cardId))) return;
      if (shouldPersistChatCardInBackground(window.zion, payload)) return;
      const sessionId = payload?.sessionId || window.zion.state.get("sessions.currentId");
      if (sessionId) persistAnnotations(sessionId, payload?.panelId || null);
    } catch {}
  };
  const dispCurToolResult = window.zion.events.on("chat/toolResult", persistLiveAnnotations);
  const dispCurReasoningEnd = window.zion.events.on("chat/reasoningEnd", persistLiveAnnotations);
  const dispCurRunFinished = window.zion.events.on("chat/runFinished", persistLiveAnnotations);
  const dispCurRunError = window.zion.events.on("chat/runError", persistLiveAnnotations);
  const dispCurAborted = window.zion.events.on("chat/aborted", persistLiveAnnotations);
  ctx.subscriptions.push(dispCurToolResult, dispCurReasoningEnd, dispCurRunFinished, dispCurRunError, dispCurAborted);

  ctx.subscriptions.push(
    window.zion.events.on("chat/runFinished", (payload = {}) => writerLeases.finishRun(payload)),
    window.zion.events.on("chat/runError", (payload = {}) => writerLeases.cancelRun(payload)),
    window.zion.events.on("chat/aborted", (payload = {}) => writerLeases.cancelRun(payload))
  );

  // Clone
  const dClone = window.zion.commands.registerCommand("zion.sessions.clone", (id) => {
    return (async () => {
    const target = getActivePanelContext();
    const srcId = id || target.sessionId;
    if (!srcId) return false;
    const text = await loadDocAsync(srcId);
    const srcMeta = await loadMetaAsync(srcId);
    const newId = genId();
    const title = `${srcMeta.title || "Session"} (copy)`;
    const meta = { id: newId, title, createdAt: now(), updatedAt: now(), size: text.length, hash: hashString(text), titleAuto: false };
    // copy annotations from source
    if (srcMeta?.annotations) {
      meta.annotations = srcMeta.annotations;
    }
    if (!await saveNewSession(newId, text, meta)) throw new Error("复制会话失败，请重试。");
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
    if (!await saveNewSession(nextId, srcText, meta)) throw new Error("复制会话失败，请重试。");
    insertSessionNodeAfter(nextId, srcId, meta.title);
    rebuildIndexFromTree();
    window.zion.state.set("sessions.catalog", getIndex());
    if (window.zion?.state?.get?.("runtime.connection")?.backend === "runtime") {
      try {
        await forkRemoteChatSession(srcId, {
          id: nextId,
          title: newTitle
        });
      } catch (error) {
        if (Number(error?.status || 0) !== 404) {
          console.warn("[sessions] Runtime transcript fork failed", error);
        }
      }
    }
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
  const readExportSession = async (id) => {
    const doc = await loadDocAsync(id);
    return { meta: await loadMetaAsync(id), doc };
  };
  const collectExportNode = async (node) => node.type === "folder"
    ? {
        id: node.id, type: "folder", title: node.title,
        children: await Promise.all((node.children || []).map(collectExportNode))
      }
    : { id: node.id, type: "session", ...await readExportSession(node.id) };
  const dExport = window.zion.commands.registerCommand("zion.sessions.export", async (id) => {
    const idx = getIndex();
    const pickId = id || window.zion.state.get("sessions.currentId");
    if (pickId) {
      const payload = await readExportSession(pickId);
      const { meta } = payload;
      download(`session-${(meta.title || pickId).replace(/\s+/g, "_")}.json`, JSON.stringify(payload, null, 2));
    } else {
      const payload = [];
      for (const item of idx) payload.push(await readExportSession(item.id));
      download("sessions.json", JSON.stringify(payload, null, 2));
    }
    return true;
  });

  // Export folder
  const dExportFolder = window.zion.commands.registerCommand("zion.sessions.exportFolder", async (folderId) => {
    const tree = loadTree() || ensureInitialTree();
    const { node } = findNodeAndParent(tree, folderId);
    if (!node || node.type !== "folder") return false;
    const payload = await collectExportNode(node);
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
  const dDeleteSelected = window.zion.commands.registerCommand("zion.sessions.deleteSelected", () => {
    const selection = getSelection();
    const initialTree = loadTree();
    const targets = selection.filter(item => !selection.some(parent =>
      parent.type === "folder" && parent.id !== item.id && (() => {
        let node = initialTree && findNodeAndParent(initialTree, item.id).parent;
        while (node) {
          if (node.id === parent.id) return true;
          node = findNodeAndParent(initialTree, node.id).parent;
        }
        return false;
      })()
    ));
    return deleteSelectedSessions({
      selection,
      isDescendant: (ancestorId, childId) => {
        let parent = initialTree && findNodeAndParent(initialTree, childId).parent;
        while (parent) {
          if (parent.id === ancestorId) return true;
          parent = findNodeAndParent(initialTree, parent.id).parent;
        }
        return false;
      },
      confirm: () => openModalConfirm({
        title: t("dialog.deleteSelected", "Delete selected"),
        message: t("ui.deleteSelectedConfirm", "Delete {count} selected item(s)? This cannot be undone.", { count: selection.length }),
        okText: t("ui.delete", "Delete"), cancelText: t("ui.cancel", "Cancel")
      }),
      deleteFolder: removeNodeRecursive,
      deleteSession,
      isDeleted: id => !!window.zion.state.get(`sessions.deleted.${id}`),
      onDeleted: removeSessionsFromPanels,
      clearSelection,
      afterDelete: refreshAfterDelete,
      run: execute => deletionController.run({
        targets, sessionIds: deletionSessionIds(targets), execute
      }),
      onProgress: (count, item) => {
        setSelection(getSelection().filter(selected => selected.id !== item.id
          && !(item.type === "folder" && targets.some(target => target.id === item.id)
            && (() => {
              let node = initialTree && findNodeAndParent(initialTree, selected.id).parent;
              while (node) {
                if (node.id === item.id) return true;
                node = findNodeAndParent(initialTree, node.id).parent;
              }
              return false;
            })())));
      }
    });
  });
  const dExportSelected = window.zion.commands.registerCommand("zion.sessions.exportSelected", async () => {
    const sel = getSelection();
    if (!sel.length) return false;
    const tree = loadTree() || ensureInitialTree();
    const payload = [];
    for (const it of sel) {
      const { node } = findNodeAndParent(tree, it.id);
      if (!node) continue;
      if (node.type === "folder") {
        payload.push(await collectExportNode(node));
      } else {
        payload.push(await readExportSession(node.id));
      }
    }
    download("sessions-selected.json", JSON.stringify(payload, null, 2));
    return true;
  });
  ctx.subscriptions.push(dDeleteSelected, dExportSelected);

  // Folder commands
  const dNewFolder = window.zion.commands.registerCommand("zion.sessions.newFolder", async (opts) => {
    const parentId = String(opts?.parentId || window.zion.state.get("sessions.selectedFolderId") || "root") || "root";
    const title = String(opts?.title || "").trim() || "New Folder";
    const shouldStartInlineRename = opts?.startInlineRename !== false;
    const targetView = String(opts?.targetView || "").trim() || null;
    const id = isReceivedNode(parentId)
      ? await sharedSessionView.mutate(parentId, { action: "createFolder", title })
      : insertFolder(parentId, title);
    try {
      if (isReceivedNode(id)) sharedSessionView.openAncestors(id, setFolderOpen);
      else openAncestors(id);
    } catch {}
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
  const dRenameFolder = window.zion.commands.registerCommand("zion.sessions.renameFolder", async (opts) => {
    if (isReceivedNode(opts?.id)) {
      await sharedSessionView.mutate(opts.id, { action: "rename", title: String(opts.title || "") });
      return true;
    }
    const tree = loadTree() || ensureInitialTree();
    const { node } = findNodeAndParent(tree, opts?.id);
    if (!node || node.type !== "folder") return false;
    node.title = String(opts?.title || node.title || "Folder");
    saveTree(tree);
    window.zion.state.set("sessions.catalog", getIndex());
    try { refreshSessionsSidebarViewIfOpen(); } catch {}
    return true;
  });
  const dDeleteFolder = window.zion.commands.registerCommand("zion.sessions.deleteFolder", async (id) => {
    if (!id || id === "root") return false;
    if (isReceivedNode(id)) {
      const sessionIds = [];
      const walk = node => {
        if (node?.type === "session") sessionIds.push(node.id);
        (node?.children || []).forEach(walk);
      };
      walk(sharedSessionView.entry(id));
      await sharedSessionView.mutate(id, { action: "delete" });
      await removeSessionsFromPanels(sessionIds);
      return true;
    }
    const targets = [{ type: "folder", id }];
    return deletionController.run({
      targets, sessionIds: deletionSessionIds(targets),
      execute: async progress => {
        const ok = await removeNodeRecursive(id);
        if (ok) progress(1);
        refreshAfterDelete();
        return ok;
      }
    });
  });
  ctx.subscriptions.push(dNewFolder, dRenameFolder, dDeleteFolder, dExportFolder);

  // Show Panel
  const dShow = window.zion.commands.registerCommand("zion.sessions.showPanel", () => {
    openSessionsPanel();
    return true;
  });
  const dGetTagVocabulary = window.zion.commands.registerCommand("zion.sessions.getTagVocabulary", () => (
    loadSessionTagVocabulary()
  ));
  ctx.subscriptions.push(dShow, dGetTagVocabulary);

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
        icon: "$(history)",
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
  ctx.subscriptions.push(window.zion.commands.registerCommand(
    "zion.sessions.discoverActiveRun", discoverActiveSessionRun
  ));
  window.zion.state.set("sessions.ready", true);
  ctx.subscriptions.push({
    dispose() { window.zion?.state?.set("sessions.ready", false); }
  });
}
