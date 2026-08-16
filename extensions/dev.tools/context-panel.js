/* global CSS */
import { getEditorCore } from "./editor-core.js";
import { createFilesCodeEditor, createFilesCodeViewer, createFilesMarkdownPreview, detectPathKindForContext, ensureRevealSourceForPath, getProvider, iconForFile, isMarkdownTab, languageFromFilename, shouldShowMarkdownPreview, stableFileTabId } from "./files-panel.js";
import { formatCompactChangeCount, formatChangeSummary, getCurrentSessionChangeState, normalizeChangePath } from "./session-change-state.js";
import { getContextFileResourceKey, getContextResourceDeviceKey, isKnownFileToolFailure, mergeContextFileResources } from "./context-file-resources.js";
import { extractObsidianMetadata, findObsidianTargetPosition } from "../shared/obsidian-metadata.js";
import { partitionSessionExtractedTags } from "../shared/session-tag-exclusions.js";

export const CONTEXT_VIEW_ID = "dev.tools.context";

const I18N_NS = "dev.tools";
const PATH_ARG_KEYS = new Set(["path", "file", "filename", "file_path", "target_file", "absolute_path", "relative_path"]);
const LS_CONTEXT_EXPANDED = "zion.devTools.context.expanded";
const LS_CONTEXT_URL_TITLES = "zion.devTools.context.urlTitles";
const LS_COMMENTS_THREADS = "zion.comments.threads.v1";
const LS_AGENT_TASKS = "zion.agents.tasks.v1";
const LS_MEMORY_ITEMS = "zion.memory.items.v1";
const PREVIEW_AUX_WIDTH = 760;
const MAX_SESSION_CONTEXT_RESOURCES = 80;
const CONTEXT_BIOGRAPHY_KINDS = new Set(["decision", "milestone", "outcome", "lesson"]);
let pendingContextOpenFilePayload = null;
let contextFolderMenuEl = null;

function createContextIcon(codiconName, className) {
  const span = document.createElement("span");
  span.className = className || "";
  span.setAttribute("aria-hidden", "true");
  const name = String(codiconName || "").replace(/^codicon-/, "");
  if (!name) return span;
  try {
    const icon = window.zionIcons?.createFromCodicon?.(name);
    if (icon) {
      span.appendChild(icon);
      return span;
    }
  } catch {}
  span.className = `${className || ""} codicon codicon-${name}`.trim();
  return span;
}

function t(key, fallback, values) {
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return String(fallback || "").replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? `{${key}}`));
}

export function registerContextPanel(ctx) {
  const disposables = [];

  const openCommand = window.zion.commands.registerCommand("tools.openContext", () => {
    try { window.zion.auxiliaryBar?.setWidth?.(Math.max(340, window.zion.state?.get?.("ui.auxiliaryBar.width") || 0)); } catch {}
    try { window.zion.auxiliaryBar?.activateView?.(CONTEXT_VIEW_ID); } catch {}
  });
  disposables.push(openCommand);

  const addResourceCommand = window.zion.commands.registerCommand("tools.context.addResource", (payload = {}) => {
    return registerSessionContextResource(payload);
  });
  disposables.push(addResourceCommand);

  const openUrlPreviewCommand = window.zion.commands.registerCommand("tools.context.openUrlPreview", (payload = {}) => {
    const url = typeof payload === "string" ? payload : payload?.url;
    return openUrlInInspector(url);
  });
  disposables.push(openUrlPreviewCommand);

  const openFilePreviewCommand = window.zion.commands.registerCommand("tools.context.openFilePreview", async (payload = {}) => {
    const path = typeof payload === "string" ? payload : payload?.path;
    if (!String(path || "").trim()) return false;
    const sourceId = typeof payload === "object" ? String(payload?.sourceId || "") : "";
    const detected = await detectPathKindForContext(path, sourceId).catch(() => null);
    const detectedKind = String(detected?.kind || "unknown");
    const rawPath = String(path).trim();
    const resourceKind = detectedKind === "directory" || (detectedKind === "unknown" && shouldTreatUnknownContextPathAsFolder(rawPath))
      ? "folder"
      : "file";
    const resourceSourceId = detected?.sourceId || sourceId;
    registerSessionContextResource({
      kind: resourceKind,
      path: rawPath,
      sourceId: resourceSourceId,
      sessionId: typeof payload === "object" ? String(payload?.sessionId || "") : "",
      panelId: typeof payload === "object" ? String(payload?.panelId || "") : "",
      source: "openFilePreview"
    });
    if (resourceKind === "folder" || !shouldOpenContextFilePreview(rawPath, detectedKind)) {
      try { window.zion.auxiliaryBar?.activateView?.(CONTEXT_VIEW_ID); } catch {}
      return true;
    }
    pendingContextOpenFilePayload = {
      path: rawPath,
      sourceId: resourceSourceId
    };
    try { window.zion.events?.emit?.("dev.tools.context/openFilePreview", pendingContextOpenFilePayload); } catch {}
    setTimeout(() => {
      try { window.zion.events?.emit?.("dev.tools.context/openFilePreview", pendingContextOpenFilePayload); } catch {}
    }, 0);
    return true;
  });
  disposables.push(openFilePreviewCommand);

  const viewDisposable = window.zion.auxiliaryBar?.registerView?.({
    id: CONTEXT_VIEW_ID,
    pluginId: "dev.tools",
    title: "Context",
    titleKey: "dev.tools.context.title",
    icon: "$(layers)",
    order: 0,
    keepWhenActive: true,
    component: {
      render: (container) => createContextPanel(container)
    }
  });
  if (viewDisposable) disposables.push(viewDisposable);

  // Context is intended as the default right-side home for session context.
  try { window.zion.auxiliaryBar?.setWidth?.(Math.max(340, window.zion.state?.get?.("ui.auxiliaryBar.width") || 0)); } catch {}
  try { window.zion.auxiliaryBar?.activateView?.(CONTEXT_VIEW_ID); } catch {}

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

function shouldOpenContextFilePreview(path, detectedKind) {
  const kind = String(detectedKind || "unknown");
  if (kind === "file") return true;
  if (kind === "directory" || kind === "other" || kind === "missing") return false;
  return !shouldTreatUnknownContextPathAsFolder(path);
}

function shouldTreatUnknownContextPathAsFolder(path) {
  const raw = stripLineSuffix(String(path || "").trim()).replace(/^file:\/\//, "").replace(/\\/g, "/");
  if (!/^\/(?:Users|Volumes|Applications|Library|System|private|tmp|var|opt)(?:\/|$)/.test(raw)) return false;
  if (raw.endsWith("/")) return true;
  const name = raw.replace(/\/+$/, "").split("/").filter(Boolean).pop() || "";
  if (!name) return false;
  return !/\.[^/.]+$/.test(name);
}

function createContextPanel(container) {
  const root = document.createElement("div");
  root.className = "zion-context-panel";
  container.appendChild(root);


  const disposables = [];
  let disposed = false;
  let renderTimer = 0;
  let selectedKey = "";
  let autoExpandFileFolders = !hasStoredExpandedGroups();
  let lastRefreshSignature = "";
  let lastRenderedSignature = "";
  let preservedScrollTop = 0;
  const editorCore = getEditorCore(CONTEXT_VIEW_ID);
  let activeFileTabId = editorCore.getActiveTabId();
  let previewCodeView = null;
  let previewMemoryEditorItemId = "";
  let previewMemoryEditorSaveTimer = 0;
  let previewMemoryEditorDirty = false;
  let previewObjectUrl = "";
  let explorerWidth = editorCore.getExplorerWidth();
  let suppressEditorCoreRender = 0;
  let previewScrollCleanup = null;
  const expanded = loadExpandedGroups();
  const urlTitleCache = loadUrlTitleCache();
  const pendingTitleFetches = new Set();
  const openFileTabs = editorCore.tabs;
    const biographyEventsBySession = new Map();
    const biographyFetches = new Set();

  const scheduleRender = () => {
    if (disposed) return;
    if (renderTimer) window.cancelAnimationFrame(renderTimer);
    renderTimer = requestAnimationFrame(() => {
      renderTimer = 0;
      render();
    });
  };

  const scheduleContextRefresh = () => {
    scheduleRender();
    setTimeout(scheduleRender, 80);
    setTimeout(scheduleRender, 260);
  };

  const watchState = (key) => {
    try {
      const d = window.zion.state?.onDidChange?.(key, scheduleRender);
      if (d) disposables.push(d);
    } catch {}
  };
  watchState("sessions.currentId");
  watchState("sessions.tagIndex");
  watchState("comments.activeThreadId");
  watchState("terminal.sessions");
  watchState("terminal.activeSessionId");
  watchState("chat.includeTerminalContext");
  watchState("todo.tasks");
  watchState("todo.activeTaskId");
  watchState("todo.list");
  try { disposables.push(window.zion.events?.on?.("chat/annotationsChanged", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("toolcards/toolsUpdated", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("chat/toolCall", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("chat/toolArgsResolved", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("chat/toolResult", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("chat/runStarted", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("chat/runFinished", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("chat/aborted", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("chat/runError", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("chat/usageChanged", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("panel/tabsChanged", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("editor/activeChanged", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("comments/changed", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("agents/changed", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("memory/changed", scheduleContextRefresh)); } catch {}
    try { disposables.push(window.zion.events?.on?.("identity/biographyChanged", (payload = {}) => {
      const sessionId = String(payload?.sessionId || getCurrentSessionId() || "").trim();
      if (sessionId) {
        biographyEventsBySession.delete(sessionId);
        refreshBiographyEventsForSession(sessionId, { force: true });
      }
      scheduleContextRefresh();
    })); } catch {}
  try { disposables.push(window.zion.events?.on?.("dev.tools.context/resourcesChanged", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("i18n/changed", () => { lastRenderedSignature = ""; scheduleRender(); })); } catch {}
  try { disposables.push(window.zion.events?.on?.("dev.tools.context/openFilePreview", (payload) => {
    const path = String(payload?.path || "").trim();
    if (!path) return;
    pendingContextOpenFilePayload = null;
    openContextFilePreview({
      path,
      label: path,
      sourceId: String(payload?.sourceId || "")
    });
  })); } catch {}
  disposables.push(editorCore.subscribe((payload) => {
    activeFileTabId = editorCore.getActiveTabId();
    explorerWidth = editorCore.getExplorerWidth();
    if (suppressEditorCoreRender > 0) return;
    if (shouldRefreshPreviewOnly(payload?.reason)) {
      if (openFileTabs.size) renderPreviewOnly();
      else scheduleRender();
      return;
    }
    lastRenderedSignature = "";
    scheduleRender();
  }));
  try {
    const onCommentsChanged = () => scheduleContextRefresh();
    window.addEventListener("zion:comments-changed", onCommentsChanged);
    disposables.push({ dispose: () => window.removeEventListener("zion:comments-changed", onCommentsChanged) });
  } catch {}
  try {
    const onAgentsChanged = () => scheduleContextRefresh();
    window.addEventListener("zion:agents-changed", onAgentsChanged);
    disposables.push({ dispose: () => window.removeEventListener("zion:agents-changed", onAgentsChanged) });
  } catch {}
  try {
    const onMemoryChanged = () => scheduleContextRefresh();
    window.addEventListener("zion:memory-changed", onMemoryChanged);
    disposables.push({ dispose: () => window.removeEventListener("zion:memory-changed", onMemoryChanged) });
  } catch {}
  const pollTimer = window.setInterval(() => {
    const signature = getContextRefreshSignature();
    if (signature === lastRefreshSignature) return;
    lastRefreshSignature = signature;
    scheduleRender();
  }, 700);
  disposables.push({ dispose: () => window.clearInterval(pollTimer) });

  render();
  setTimeout(() => {
    if (disposed || !pendingContextOpenFilePayload) return;
    try { window.zion.events?.emit?.("dev.tools.context/openFilePreview", pendingContextOpenFilePayload); } catch {}
  }, 0);

  return {
    dispose() {

      disposed = true;
      if (renderTimer) window.cancelAnimationFrame(renderTimer);
      closeContextFolderMenu();
      disposePreviewResources();
      for (const d of disposables.splice(0)) {
        try { d?.dispose?.(); } catch {}
      }
      try { root.remove(); } catch {}
    }
  };

  function render() {
    const previousScroll = root.querySelector(".zion-context-scroll");
    if (previousScroll) preservedScrollTop = previousScroll.scrollTop || 0;

      const sessionId = getCurrentSessionId();
      const snapshot = buildContextSnapshot(urlTitleCache, {
        sessionId,
        biographyEvents: getCachedBiographyEventsForSession(sessionId)
      });
    const changeState = getCurrentSessionChangeState();
    prefetchUrlTitles(snapshot.urls, urlTitleCache, pendingTitleFetches, scheduleRender);
    const renderSignature = getSnapshotRenderSignature(snapshot, expanded, changeState);
    const hasPreviewPane = !!root.querySelector(".zion-context-preview-pane");
    const hasLocalPreview = openFileTabs.size > 0 && !window.zion?.inspector?.open;
    if (renderSignature === lastRenderedSignature && previousScroll && hasPreviewPane === hasLocalPreview) {
      syncSelectedRow(root, selectedKey);
      return;
    }
    lastRenderedSignature = renderSignature;
    const existingWorkspace = root.querySelector(".zion-context-workspace");
    const existingScroll = existingWorkspace?.querySelector(".zion-context-scroll");
    const existingPreview = existingWorkspace?.querySelector(".zion-context-preview-pane");

    const workspace = document.createElement("div");
    workspace.className = `zion-context-workspace${hasLocalPreview ? " has-preview" : ""}`;
    const scroll = document.createElement("div");
    scroll.className = "zion-context-scroll";
    if (hasLocalPreview) scroll.style.flexBasis = `${explorerWidth}px`;
    scroll.appendChild(renderResourceTree(snapshot, {
      expanded,
      defaultExpandFolders: autoExpandFileFolders,
      changeState,
      selectedKey,
      onToggle(key) {
        if (!key) return;
        autoExpandFileFolders = false;
        if (expanded.has(key)) expanded.delete(key);
        else expanded.add(key);
        saveExpandedGroups(expanded);
        scheduleRender();
      },
      onSelect(key) {
        selectedKey = key || "";
        syncSelectedRow(root, selectedKey);
      },
      onOpenFile: openContextFilePreview,
      onOpenMemory: openContextMemoryPreview
    }));

    if (existingWorkspace && existingScroll && existingPreview && hasLocalPreview) {

      existingWorkspace.classList.add("has-preview");
      scroll.style.flexBasis = `${explorerWidth}px`;
      existingScroll.replaceWith(scroll);
      const resizer = existingWorkspace.querySelector(".zion-context-split-resizer");
      if (resizer) resizer.replaceWith(renderContextResizeHandle(existingWorkspace, scroll));
      else existingWorkspace.insertBefore(renderContextResizeHandle(existingWorkspace, scroll), existingPreview);
    } else {
      workspace.appendChild(scroll);
      if (hasLocalPreview) {

        disposePreviewResources();
        workspace.appendChild(renderContextResizeHandle(workspace, scroll));
        workspace.appendChild(renderContextPreviewPane());
      }
      root.replaceChildren(workspace);
    }
    restoreScrollTop(scroll, preservedScrollTop);
    if (!selectedKey || !root.querySelector(`.zion-context-tree-row[data-key="${cssEscape(selectedKey)}"]`)) {
      const firstRow = root.querySelector(".zion-context-tree-row[data-key]");
      selectedKey = firstRow?.dataset?.key || "";
    }
    syncSelectedRow(root, selectedKey);
  }

    function getCachedBiographyEventsForSession(sessionId) {
      const sid = String(sessionId || "").trim();
      if (!sid) return [];
      if (!biographyEventsBySession.has(sid)) refreshBiographyEventsForSession(sid);
      return biographyEventsBySession.get(sid) || [];
    }

    function refreshBiographyEventsForSession(sessionId, options = {}) {
      const sid = String(sessionId || "").trim();
      if (!sid) return;
      if (!options.force && biographyFetches.has(sid)) return;
      biographyFetches.add(sid);
      let result = null;
      try {
        const commandsApi = window.zion?.commands;
        if (typeof commandsApi?.listCommands === "function") {
          const ids = commandsApi.listCommands() || [];
          if (Array.isArray(ids) && !ids.includes("identity.getSessionBiographyEvents")) {
            biographyFetches.delete(sid);
            return;
          }
        }
        result = commandsApi?.executeCommand?.("identity.getSessionBiographyEvents", { sessionId: sid });
      } catch {}
      if (result == null) {
        biographyFetches.delete(sid);
        return;
      }
      Promise.resolve(result)
        .then((events) => {
          const next = normalizeContextBiographyEvents(events);
          const previous = biographyEventsBySession.get(sid) || [];
          if (stableStringify(next) !== stableStringify(previous)) {
            biographyEventsBySession.set(sid, next);
            lastRenderedSignature = "";
            scheduleRender();
          } else if (!biographyEventsBySession.has(sid)) {
            biographyEventsBySession.set(sid, next);
          }
        })
        .catch(() => {
          if (!biographyEventsBySession.has(sid)) biographyEventsBySession.set(sid, []);
        })
        .finally(() => {
          biographyFetches.delete(sid);
        });
    }

  async function openContextFilePreview(item) {
    const path = item?.path || item?.label || "";
    if (!path) return;

    const resourceOptions = getContextResourceOptions();
    const resourceKey = getContextFileResourceKey(item, resourceOptions);
    const existingByPath = Array.from(openFileTabs.values()).find((tab) => {
      const tabKey = tab.resourceKey || getContextFileResourceKey(tab, resourceOptions);
      return resourceKey && tabKey === resourceKey;
    });
    if (existingByPath) {

      if (existingByPath.id === activeFileTabId) {
        return refreshExistingContextFileTab(item, existingByPath);
      }
      saveActivePreviewScrollState();
      activeFileTabId = runWithoutEditorCoreRender(() => editorCore.setActiveTab(existingByPath.id));

      renderPreviewOnly();
      return refreshExistingContextFileTab(item, existingByPath);
    }
    const name = displayFileName(path);
    const sourceHint = item.sourceId || inferFileSource();
    const provisionalTabId = `file:pending:${resourceKey || `${sourceHint}:${path}`}`;
    const existing = openFileTabs.get(provisionalTabId);
    if (existing) {
      if (existing.id === activeFileTabId) {

        return;
      }
      activeFileTabId = runWithoutEditorCoreRender(() => editorCore.setActiveTab(provisionalTabId));

      renderPreviewOnly();
      return;
    }
    const hadPreview = openFileTabs.size > 0 || !!root.querySelector(".zion-context-preview-pane");
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (!hadPreview && !window.zion?.inspector?.open) requestPreviewAuxWidth();
    runWithoutEditorCoreRender(() => editorCore.openTab({
      id: provisionalTabId,
      title: name,
      path,
      displayPath: path,
      language: languageFromFilename(name),
      file: { kind: "loading" },
      sourceId: sourceHint,
      resourceKey,
      token
    }));
    activeFileTabId = editorCore.getActiveTabId();
    renderPreviewOnly();

    let tabId = provisionalTabId;
    try {
      const sourceId = await ensureRevealSourceForPath(path, sourceHint);
      const node = createContextFileNode(path, sourceId, name);
      const resolvedTabId = `file:${stableFileTabId(node)}`;
      const resolvedResourceKey = getContextFileResourceKey({ path, sourceId, kind: "file" }, resourceOptions);

      const current = openFileTabs.get(provisionalTabId);
      if (!current || current.token !== token) {

        return;
      }
      if (resolvedTabId !== provisionalTabId) {
        runWithoutEditorCoreRender(() => editorCore.closeTab(provisionalTabId, { reason: "resolve-file-tab" }));
        const resolvedExisting = openFileTabs.get(resolvedTabId);
        if (resolvedExisting) {
          activeFileTabId = runWithoutEditorCoreRender(() => editorCore.setActiveTab(resolvedTabId));
          renderPreviewOnly();
          return;
        }
      }
      tabId = resolvedTabId;
      runWithoutEditorCoreRender(() => editorCore.openTab({
        ...current,
        id: tabId,
        sourceId,
        resourceKey: resolvedResourceKey,
        file: { kind: "loading" }
      }));
      activeFileTabId = editorCore.getActiveTabId();
      renderPreviewOnly();

      const file = await getProvider(sourceId).readFile(node);

      const latest = openFileTabs.get(tabId);
      if (!latest || latest.token !== token) {

        return;
      }
      runWithoutEditorCoreRender(() => editorCore.openTab({
        ...latest,
        size: typeof file?.size === "number" ? file.size : latest.size,
        file
      }));
      activeFileTabId = editorCore.getActiveTabId();

      renderPreviewOnly();
    } catch (e) {
      const current = openFileTabs.get(tabId) || openFileTabs.get(provisionalTabId);

      if (!current || current.token !== token) return;
      runWithoutEditorCoreRender(() => editorCore.openTab({
        ...current,
        id: current.id || tabId,
        file: { kind: "error", message: e?.message || String(e || "Failed to open file") }
      }));
      activeFileTabId = editorCore.getActiveTabId();
      renderPreviewOnly();
    }
  }

  async function refreshExistingContextFileTab(item, existingTab) {
    const path = item?.path || item?.label || existingTab?.path || existingTab?.displayPath || "";
    const tabId = existingTab?.id || "";
    if (!path || !tabId) return;
    saveActivePreviewScrollState(tabId);
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    runWithoutEditorCoreRender(() => editorCore.updateTab(tabId, { token }, { reason: "refresh-existing" }));
    renderPreviewOnly();
    try {
      const sourceId = existingTab.sourceId || await ensureRevealSourceForPath(path, item?.sourceId || inferFileSource());
        const node = createContextFileNode(path, sourceId, existingTab.title || displayFileName(path));

      const file = await getProvider(sourceId).readFile(node);

      const current = openFileTabs.get(tabId);
      if (!current || current.token !== token) {

        return;
      }
      const sameFile = sameContextPreviewFile(current.file, file);

      if (sameFile) {

        return;
      }
      runWithoutEditorCoreRender(() => editorCore.openTab({
        ...current,
        sourceId,
        size: typeof file?.size === "number" ? file.size : current.size,
        file
      }, { reason: "refresh-existing" }));
      activeFileTabId = editorCore.getActiveTabId();

      renderPreviewOnly();
    } catch (e) {

      window.showToast?.(e?.message || String(e || "Failed to refresh file"));
    }
  }

  function sameContextPreviewFile(a, b) {
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === "text" || a.kind === "memory-text") return String(a.content || "") === String(b.content || "");
    if (a.kind === "binary") return Number(a.size || 0) === Number(b.size || 0);
    if (a.kind === "image") return Number(a.blob?.size || 0) === Number(b.blob?.size || 0);
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function openContextMemoryPreview(item) {
    if (!item?.id) return;
    const tabId = `memory:${item.id}`;
    const latest = window.zion?.memory?.getMemory?.(item.id) || item;
    const existing = openFileTabs.get(tabId);
    const nextTab = {
      id: tabId,
      kind: "memory",
      memoryId: item.id,
      title: displayFileName(latest.path || latest.title || "memory.md"),
      path: latest.path || latest.title || "memory.md",
      displayPath: latest.path || latest.title || "memory.md",
      language: languageFromFilename(latest.path || "memory.md"),
      size: typeof latest.content === "string" ? latest.content.length : 0
    };
    if (existing?.id === activeFileTabId && sameContextPreviewFile(resolveContextPreviewTab(existing).file, resolveContextPreviewTab(nextTab).file)) return;
    const hadPreview = openFileTabs.size > 0 || !!root.querySelector(".zion-context-preview-pane");
    if (!hadPreview && !window.zion?.inspector?.open) requestPreviewAuxWidth();
    runWithoutEditorCoreRender(() => editorCore.openTab(nextTab));
    activeFileTabId = editorCore.getActiveTabId();
    renderPreviewOnly();
  }

  function createContextFileNode(path, sourceId, name = displayFileName(path)) {
    const sessionId = sourceId.startsWith("terminal:") ? sourceId.slice("terminal:".length) : "";
    return {
      key: `context:${sourceId}:${path}`,
      sourceId,
      provider: sourceId.startsWith("terminal:") ? "terminal" : "local",
      sessionId,
      entryId: sourceId === "local" ? "context-local" : "",
      kind: "file",
      name,
      path,
      displayPath: path
    };
  }

  function renderPreviewOnly() {
    const rawTab = openFileTabs.get(activeFileTabId) || openFileTabs.values().next().value;
    const tab = rawTab ? resolveContextPreviewTab(rawTab) : null;
    if (window.zion?.inspector?.open) {
      releasePreviewAuxWidth();
      if (tab) {
        window.zion.inspector.open({
          id: `context:${tab.id}`,
          ownerId: CONTEXT_VIEW_ID,
          title: tab.title,
          path: tab.path,
          displayPath: tab.displayPath,
          language: tab.language,
          file: tab.file?.kind === "memory-text"
            ? { kind: "text", content: tab.file.content || "" }
            : tab.file,
          editable: tab.file?.kind === "memory-text",
          onSave: tab.file?.kind === "memory-text"
            ? (content) => window.zion?.memory?.updateMemory?.(tab.memoryId, { content })
            : undefined
        });
      } else {
        window.zion.inspector.clearOwner?.(CONTEXT_VIEW_ID);
      }
      disposePreviewResources();
      root.querySelector(".zion-context-preview-pane")?.remove();
      root.querySelector(".zion-context-split-resizer")?.remove();
      root.querySelector(".zion-context-workspace")?.classList.remove("has-preview");
      return;
    }
    const existing = root.querySelector(".zion-context-preview-pane");

    if (!openFileTabs.size) {
      if (existing) {
        disposePreviewResources();
        existing.remove();
      }
      releasePreviewAuxWidth();
      root.querySelector(".zion-context-workspace")?.classList.remove("has-preview");
      return;
    }
    if (existing) {
      saveActivePreviewScrollState();

      disposePreviewResources();
      const next = renderContextPreviewPane();
      existing.replaceWith(next);
      return;
    }
    const workspace = root.querySelector(".zion-context-workspace");
    if (workspace) {
      const scroll = root.querySelector(".zion-context-scroll");
      workspace.classList.add("has-preview");
      if (scroll) scroll.style.flexBasis = `${explorerWidth}px`;
      disposePreviewResources();
      const next = renderContextPreviewPane();
      if (scroll && !workspace.querySelector(".zion-context-split-resizer")) {
        workspace.appendChild(renderContextResizeHandle(workspace, scroll));
      }
      workspace.appendChild(next);
    } else {      lastRenderedSignature = "";
      scheduleRender();
    }
  }

  function renderContextResizeHandle(workspace, explorer) {
    const handle = document.createElement("div");
    handle.className = "zion-context-split-resizer";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.title = t("context.resizeExplorer", "Resize Context Explorer");
    handle.onpointerdown = (event) => {
      event.preventDefault();
      const pointerId = event.pointerId;
      try { handle.setPointerCapture(pointerId); } catch {}
      root.classList.add("is-resizing-context");
      const move = (moveEvent) => {
        const rect = workspace.getBoundingClientRect();
        const max = Math.max(220, rect.width - 280);
        const next = Math.max(180, Math.min(max, moveEvent.clientX - rect.left));
        explorerWidth = editorCore.setExplorerWidth(next, { silent: true });
        explorer.style.flexBasis = `${explorerWidth}px`;
      };
      const stop = () => {
        root.classList.remove("is-resizing-context");
        editorCore.notify("resize");
        try { handle.releasePointerCapture(pointerId); } catch {}
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    };
    return handle;
  }

  function renderContextPreviewPane() {
    const pane = document.createElement("div");
    pane.className = "zion-files-preview-pane zion-context-preview-pane";
    const tabs = document.createElement("div");
    tabs.className = "zion-files-preview-tabs";
    for (const tab of openFileTabs.values()) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `zion-files-preview-tab${tab.id === activeFileTabId ? " is-active" : ""}${tab.file?.kind === "loading" ? " is-loading" : ""}`;
      item.title = tab.displayPath || tab.title;
      item.dataset.tabId = tab.id;
      item.onclick = () => {
        if (tab.id === activeFileTabId) return;
        activeFileTabId = runWithoutEditorCoreRender(() => editorCore.setActiveTab(tab.id));
        renderPreviewOnly();
      };
      const icon = createContextIcon(tab.kind === "memory" ? "database" : iconForFile(tab.title), "zion-files-preview-tab-icon");
      const label = document.createElement("span");
      label.className = "zion-files-preview-tab-label";
      label.textContent = tab.title;
      const close = createContextIcon("close", "zion-files-preview-tab-close");
      close.title = t("context.close", "Close");
      close.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeContextFileTab(tab.id);
      };
      item.appendChild(icon);
      item.appendChild(label);
      item.appendChild(close);
      tabs.appendChild(item);
    }
    pane.appendChild(tabs);
    const tab = openFileTabs.get(activeFileTabId) || openFileTabs.values().next().value;
    if (tab) {
      activeFileTabId = tab.id;
      pane.appendChild(renderContextPreviewHeader(resolveContextPreviewTab(tab)));
      const content = document.createElement("div");
      content.className = "zion-files-preview-content";
      renderContextFileTabContent(content, resolveContextPreviewTab(tab));
      pane.appendChild(content);
      pane.dataset.activeTabId = tab.id;
      attachPreviewScrollTracking(tab.id, pane);
      restorePreviewScrollState(tab.id, pane);
    }
    return pane;
  }

  function resolveContextPreviewTab(tab) {
    if (tab?.kind !== "memory") return tab;
    const item = window.zion?.memory?.getMemory?.(tab.memoryId) || null;
    if (!item) return { ...tab, file: { kind: "error", message: "Memory not found" } };
    return {
      ...tab,
      title: displayFileName(item.path || item.title || "memory.md"),
      path: item.path || item.title || "memory.md",
      displayPath: item.path || item.title || "memory.md",
      language: languageFromFilename(item.path || "memory.md"),
      size: typeof item.content === "string" ? item.content.length : 0,
      memory: item,
      file: { kind: "memory-text", content: item.content || "" }
    };
  }

  function renderContextPreviewHeader(tab) {
    const header = document.createElement("div");
    header.className = "zion-files-preview-header";
    const icon = createContextIcon(iconForFile(tab.title), "zion-files-preview-header-icon");
    const title = document.createElement("div");
    title.className = "zion-files-preview-breadcrumb";
    title.title = tab.displayPath || tab.path || tab.title;
    title.textContent = compactMiddle(tab.displayPath || tab.path || tab.title, 72);
    const meta = document.createElement("div");
    meta.className = "zion-files-preview-meta";
    meta.textContent = [
      tab.kind === "memory" ? "Memory" : "",
      typeof tab.size === "number" ? formatBytes(tab.size) : "",
      tab.language && tab.language !== "text" ? tab.language : ""
    ].filter(Boolean).join(" · ");
    header.appendChild(icon);
    header.appendChild(title);
    if (meta.textContent) header.appendChild(meta);
    if (isMarkdownTab(tab)) header.appendChild(renderMarkdownPreviewToggle(tab));
    return header;
  }

  function renderMarkdownPreviewToggle(tab) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `zion-files-preview-mode-button${shouldShowMarkdownPreview(tab) ? " is-active" : ""}`;
    button.title = shouldShowMarkdownPreview(tab) ? "Disable Markdown preview" : "Preview Markdown";
    const icon = createContextIcon("eye", "");
    button.appendChild(icon);
    button.onclick = () => {
      runWithoutEditorCoreRender(() => editorCore.updateTab(tab.id, { markdownPreview: !shouldShowMarkdownPreview(tab) }, { reason: "markdown-preview" }));
      renderPreviewOnly();
    };
    return button;
  }

  function renderContextFileTabContent(parent, tab) {    if (tab.file?.kind === "loading") {
      parent.appendChild(renderContextPreviewMessage("Opening file..."));
      return;
    }
    if (tab.file?.kind === "error") {
      parent.appendChild(renderContextPreviewMessage(tab.file.message || "Failed to open file"));
      return;
    }
    if (tab.file?.kind === "image" && tab.file.blob instanceof Blob) {
      previewObjectUrl = URL.createObjectURL(tab.file.blob);
      const stage = document.createElement("div");
      stage.className = "zion-files-preview-image-stage";
      const img = document.createElement("img");
      img.className = "zion-files-preview-image";
      img.src = previewObjectUrl;
      img.alt = tab.title;
      stage.appendChild(img);
      parent.appendChild(stage);
      return;
    }
    if (tab.file?.kind === "text") {
        if (tab.file.truncated) parent.appendChild(renderContextTruncatedPreviewNotice(tab.file));
      if (shouldShowMarkdownPreview(tab)) {
        createFilesMarkdownPreview(parent, String(tab.file.content || ""));
        return;
      }
      const codeHost = document.createElement("div");
      codeHost.className = "zion-files-preview-code-host";
      parent.appendChild(codeHost);
      previewCodeView = createFilesCodeViewer(codeHost, String(tab.file.content || ""), tab);
      return;
    }
    if (tab.file?.kind === "memory-text") {
      if (shouldShowMarkdownPreview(tab)) {
        createFilesMarkdownPreview(parent, String(tab.file.content || ""));
        return;
      }
      const codeHost = document.createElement("div");
      codeHost.className = "zion-files-preview-code-host";
      parent.appendChild(codeHost);
      previewMemoryEditorItemId = tab.memoryId || "";
      previewCodeView = createFilesCodeEditor(codeHost, String(tab.file.content || ""), tab, (value) => {
        previewMemoryEditorDirty = true;
        if (previewMemoryEditorSaveTimer) window.clearTimeout(previewMemoryEditorSaveTimer);
        previewMemoryEditorSaveTimer = window.setTimeout(() => {
          previewMemoryEditorSaveTimer = 0;
          previewMemoryEditorDirty = false;
          try { window.zion?.memory?.updateMemory?.(previewMemoryEditorItemId, { content: value }, { silent: true }); } catch {}
        }, 250);
      });
      codeHost.addEventListener("focusout", () => flushPreviewMemoryEditor());
      return;
    }
    parent.appendChild(renderContextPreviewMessage("Binary preview is not supported yet"));
  }

  function renderContextTruncatedPreviewNotice(file) {
    const notice = document.createElement("div");
    notice.className = "zion-files-preview-truncated";
    notice.textContent = t("files.previewTruncated", "Large file: showing the first {size} KB as read-only.", {
      size: Math.max(1, Math.round(Number(file?.loadedBytes || 0) / 1024))
    });
    return notice;
  }

  function renderContextPreviewMessage(message) {
    const el = document.createElement("div");
    el.className = "zion-files-preview-empty";
    el.textContent = message;
    return el;
  }

  function closeContextFileTab(tabId) {
    runWithoutEditorCoreRender(() => editorCore.closeTab(tabId));
    activeFileTabId = editorCore.getActiveTabId();
    renderPreviewOnly();
  }

  function requestPreviewAuxWidth() {
    try { window.zion.auxiliaryBar?.requestTemporaryWidth?.(CONTEXT_VIEW_ID, PREVIEW_AUX_WIDTH); } catch {}
  }

  function releasePreviewAuxWidth() {
    try { window.zion.auxiliaryBar?.releaseTemporaryWidth?.(CONTEXT_VIEW_ID); } catch {}
  }

  function shouldRefreshPreviewOnly(reason) {
    return ["active", "open", "update", "close", "markdown-preview", "resolve-file-tab"].includes(String(reason || ""));
  }

  function runWithoutEditorCoreRender(fn) {
    suppressEditorCoreRender += 1;
    try {
      return typeof fn === "function" ? fn() : undefined;
    } finally {
      suppressEditorCoreRender = Math.max(0, suppressEditorCoreRender - 1);
      activeFileTabId = editorCore.getActiveTabId();
      explorerWidth = editorCore.getExplorerWidth();
    }
  }

  function disposePreviewResources() {

    if (previewScrollCleanup) {
      try { previewScrollCleanup(); } catch {}
      previewScrollCleanup = null;
    }
    flushPreviewMemoryEditor();
    try { previewCodeView?.destroy?.(); } catch {}
    previewCodeView = null;
    if (previewObjectUrl) {
      try { URL.revokeObjectURL(previewObjectUrl); } catch {}
      previewObjectUrl = "";
    }
  }

  function saveActivePreviewScrollState(tabId = "") {
    const pane = root.querySelector(".zion-context-preview-pane");
    const id = tabId || pane?.dataset.activeTabId || activeFileTabId;
    if (!id || !pane || pane.querySelector(".zion-files-preview-empty")) return;
    const scrollEl = getPreviewScrollElement(pane);
    if (!scrollEl) return;
    editorCore.setPreviewScroll?.(id, {
      top: scrollEl.scrollTop || 0,
      left: scrollEl.scrollLeft || 0
    });
  }

  function restorePreviewScrollState(tabId, pane) {
    const state = editorCore.getPreviewScroll?.(tabId);
    if (!state) return;
    [0, 1, 4].forEach((frames) => restorePreviewScrollStateSoon(tabId, pane, state, frames));
    for (const img of Array.from(pane.querySelectorAll("img"))) {
      if (!img.complete) {
        img.addEventListener("load", () => restorePreviewScrollStateSoon(tabId, pane, state, 0), { once: true });
        img.addEventListener("error", () => restorePreviewScrollStateSoon(tabId, pane, state, 0), { once: true });
      }
    }
  }

  function restorePreviewScrollStateSoon(tabId, pane, state, frames) {
    let leftFrames = Math.max(0, Number(frames || 0));
    const apply = () => {
      if (disposed || !pane.isConnected || pane.dataset.activeTabId !== tabId) return;
      if (leftFrames > 0) {
        leftFrames -= 1;
        requestAnimationFrame(apply);
        return;
      }
      const scrollEl = getPreviewScrollElement(pane);
      if (!scrollEl) return;
      scrollEl.scrollTop = state.top || 0;
      scrollEl.scrollLeft = state.left || 0;
    };
    requestAnimationFrame(apply);
  }

  function attachPreviewScrollTracking(tabId, pane) {
    if (previewScrollCleanup) {
      try { previewScrollCleanup(); } catch {}
      previewScrollCleanup = null;
    }
    requestAnimationFrame(() => {
      if (disposed || !pane.isConnected || pane.dataset.activeTabId !== tabId) return;
      const scrollEl = getPreviewScrollElement(pane);
      if (!scrollEl) return;
      let ticking = false;
      const save = () => {
        ticking = false;
        if (disposed || !pane.isConnected || pane.dataset.activeTabId !== tabId) return;
        editorCore.setPreviewScroll?.(tabId, {
          top: scrollEl.scrollTop || 0,
          left: scrollEl.scrollLeft || 0
        });
      };
      const onScroll = () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(save);
      };
      scrollEl.addEventListener("scroll", onScroll, { passive: true });
      previewScrollCleanup = () => {
        save();
        scrollEl.removeEventListener("scroll", onScroll);
      };
    });
  }

  function getPreviewScrollElement(pane) {
    if (previewCodeView?.scrollDOM && pane.contains(previewCodeView.dom)) return previewCodeView.scrollDOM;
    return pane.querySelector(".zion-files-markdown-preview")
      || pane.querySelector(".zion-files-preview-image-stage")
      || pane.querySelector(".zion-files-preview-code-host .cm-scroller")
      || pane.querySelector(".zion-files-preview-content");
  }

  function flushPreviewMemoryEditor() {
    if (previewMemoryEditorSaveTimer) {
      window.clearTimeout(previewMemoryEditorSaveTimer);
      previewMemoryEditorSaveTimer = 0;
    }
    if (previewMemoryEditorDirty && previewCodeView && previewMemoryEditorItemId) {
      try { window.zion?.memory?.updateMemory?.(previewMemoryEditorItemId, { content: previewCodeView.state.doc.toString() }); } catch {}
    }
    previewMemoryEditorItemId = "";
    previewMemoryEditorDirty = false;
  }
}

function registerSessionContextResource(payload = {}) {
  const item = normalizeSessionContextResource(payload);
  if (!item) return false;
  const sessionId = resolveContextResourceSessionId(payload);
  if (!sessionId) return false;
  const current = getSessionContextResources(sessionId);
  let next;
  if (item.kind === "url") {
    const key = getSessionContextResourceKey(item);
    next = [
      { ...item, addedAt: Date.now() },
      ...current.filter((entry) => getSessionContextResourceKey(entry) !== key)
    ];
  } else {
    const files = mergeContextFileResources(
      [{ ...item, addedAt: Date.now() }, ...current.filter((entry) => entry.kind !== "url")],
      getContextResourceOptions()
    );
    next = [...files, ...current.filter((entry) => entry.kind === "url")];
  }
  next = next.slice(0, MAX_SESSION_CONTEXT_RESOURCES);
  saveSessionContextResources(sessionId, next);
  return true;
}

function resolveContextResourceSessionId(payload = {}) {
  const explicit = String(payload?.sessionId || "").trim();
  if (explicit && !explicit.startsWith("comment:")) return explicit;
  const panelId = String(payload?.panelId || "").trim();
  if (panelId) {
    try {
      const panel = (window.zion?.panels?.list?.() || []).find((item) => item?.id === panelId);
      const tabId = String(panel?.activeTabId || "").trim();
      if (tabId && !tabId.startsWith("comment:")) return tabId;
    } catch {}
  }
  return getCurrentSessionId() || "";
}

function normalizeSessionContextResource(payload = {}) {
  const kindHint = String(payload?.kind || payload?.type || "").trim().toLowerCase();
  const rawUrl = String(payload?.url || payload?.href || "").trim();
  if (kindHint === "url" || /^https?:\/\//i.test(rawUrl)) {
    const url = normalizeUrl(rawUrl);
    if (!/^https?:\/\//i.test(url)) return null;
    const title = String(payload?.title || "").trim();
    return {
      kind: "url",
      url,
      title,
      label: String(payload?.label || title || hostFromUrl(url) || url).trim(),
      source: String(payload?.source || "link").trim(),
      addedAt: Number(payload?.addedAt) || 0
    };
  }
  const path = stripLineSuffix(String(payload?.path || payload?.file || payload?.filename || payload?.label || "").trim());
  if (!path) return null;
  const kind = kindHint === "folder" || kindHint === "directory" ? "folder" : "file";
  return {
    kind,
    path,
    label: String(payload?.label || path).trim(),
    sourceId: String(payload?.sourceId || "").trim() || "local",
    source: String(payload?.source || "link").trim(),
    executionContext: payload?.executionContext && typeof payload.executionContext === "object"
      ? payload.executionContext
      : null,
    addedAt: Number(payload?.addedAt) || 0
  };
}

function normalizeSessionContextResources(value) {
  const list = Array.isArray(value) ? value : [];
  return list.map(normalizeSessionContextResource).filter(Boolean);
}

function getSessionContextResources(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return [];
  const stateKey = `sessions.contextResources.${sid}`;
  try {
    const live = window.zion?.state?.get?.(stateKey);
    if (Array.isArray(live)) return normalizeSessionContextResources(live);
  } catch {}
  try {
    const meta = window.zion?.commands?.executeCommand?.("zion.sessions.getMeta", sid);
    const resources = normalizeSessionContextResources(meta?.contextResources);
    if (resources.length) {
      try { window.zion?.state?.set?.(stateKey, resources); } catch {}
    }
    return resources;
  } catch {
    return [];
  }
}

function saveSessionContextResources(sessionId, resources) {
  const sid = String(sessionId || "").trim();
  if (!sid) return false;
  const next = normalizeSessionContextResources(resources).slice(0, MAX_SESSION_CONTEXT_RESOURCES);
  const stateKey = `sessions.contextResources.${sid}`;
  try { window.zion?.state?.set?.(stateKey, next); } catch {}
  try {
    window.zion?.commands?.executeCommand?.("zion.sessions.patchMeta", {
      id: sid,
      patch: { contextResources: next }
    });
  } catch {
    try {
      const meta = window.zion?.commands?.executeCommand?.("zion.sessions.getMeta", sid);
      if (meta && typeof meta === "object") {
        window.zion?.state?.set?.(`sessions.meta.${sid}`, { ...meta, contextResources: next });
      }
    } catch {}
  }
  try { window.zion?.events?.emit?.("dev.tools.context/resourcesChanged", { sessionId: sid, resources: next }); } catch {}
  return true;
}

function getSessionContextResourceKey(item) {
  if (!item) return "";
  if (item.kind === "url") return `url:${normalizeUrl(item.url || "")}`;
  return getContextFileResourceKey(item, getContextResourceOptions());
}

function extractFilesFromSessionContextResources(resources) {
  return normalizeSessionContextResources(resources)
    .filter((item) => (item.kind === "file" || item.kind === "folder") && item.path)
    .map((item) => ({
      kind: item.kind,
      path: item.path,
      label: item.label || item.path,
      source: item.source || "link",
      sourceId: item.sourceId || "local",
      executionContext: item.executionContext || null
    }));
}

function extractUrlsFromSessionContextResources(resources, urlTitleCache = {}, titleHints = {}) {
  return normalizeSessionContextResources(resources)
    .filter((item) => item.kind === "url" && item.url)
    .map((item) => makeUrlItem(item.url, urlTitleCache, item.title ? { ...titleHints, [item.url]: item.title } : titleHints));
}

function buildContextSnapshot(urlTitleCache = {}, options = {}) {
  const sessionId = options?.sessionId || getCurrentSessionId();
  const editorText = getActiveEditorText();
  const tools = getCurrentTools(sessionId);
  const urlTitleHints = collectWebFetchTitleHints(editorText, tools);
  mergeUrlTitleHints(urlTitleCache, urlTitleHints);
  const contextResources = getSessionContextResources(sessionId);
  const terminalSessions = Array.isArray(window.zion?.state?.get?.("terminal.sessions")) ? window.zion.state.get("terminal.sessions") : [];
  const activeTerminalId = window.zion?.state?.get?.("terminal.activeSessionId") || "";
  const files = mergeContextFileResources([
    ...extractFilesFromSessionContextResources(contextResources),
    ...extractFilesFromTools(tools)
  ], {
    terminalSessions,
    activeSessionId: activeTerminalId
  });
  const urls = dedupeItems([
    ...extractUrlsFromSessionContextResources(contextResources, urlTitleCache, urlTitleHints),
    ...extractWebFetchUrls(editorText, tools, urlTitleCache, urlTitleHints)
  ], (item) => item.url);
  const includeTerminal = window.zion?.state?.get?.("chat.includeTerminalContext") !== false;
  const usage = sessionId ? window.zion?.usage?.getSession?.(sessionId) : null;
  const allTasks = Array.isArray(window.zion?.state?.get?.("todo.tasks")) ? window.zion.state.get("todo.tasks") : [];
  const activeTodoWrites = getActiveTodoWriteRefs(tools);
  const tasks = filterTasksForSession(allTasks, sessionId, activeTodoWrites);
  const activeTaskId = window.zion?.state?.get?.("todo.activeTaskId") || "";
  const taskSummary = buildTaskSummary(tasks, activeTaskId);
  const comments = getCommentsForSession(sessionId);
  const commentSummary = buildCommentSummary(comments);
  const agentTasks = getAgentTasksForSession(sessionId);
  const agentSummary = buildAgentTaskSummary(agentTasks);
  const biographyEvents = normalizeContextBiographyEvents(options?.biographyEvents || []);
  const biographySummary = buildBiographyContextSummary(biographyEvents);
  const memories = getMemoryItems();
  const memorySummary = buildMemorySummary(memories);
  const extractedObsidian = extractObsidianMetadata(editorText);
  const tagExtractionState = getSessionTagExtractionState(sessionId);
  const tagPartition = partitionSessionExtractedTags(
    extractedObsidian.tags,
    tagExtractionState.exclusions
  );
  const obsidian = {
    ...extractedObsidian,
    tags: tagPartition.visible,
    ignoredTagRules: tagPartition.ignoredRules
  };
  const basics = [
    { label: t("context.session", "Session"), value: sessionId ? shortId(sessionId) : t("context.noSession", "No open session") },
    { label: t("context.terminalContext", "Terminal Context"), value: includeTerminal ? t("context.terminalInjected", "Injected into chat") : t("context.terminalNotInjected", "Not injected into chat") },
    { label: t("context.terminalSessions", "Terminal Sessions"), value: `${t("context.count", "{count}", { count: terminalSessions.length })}${activeTerminalId ? ` · ${t("context.terminalActive", "active {id}", { id: shortId(activeTerminalId) })}` : ""}` },
    { label: t("context.toolArtifacts", "Tool Artifacts"), value: t("context.itemCount", "{count}", { count: tools.length }) }
  ];
  return { sessionId, files, urls, contextResources, basics, usage, tasks, activeTaskId, taskSummary, comments, commentSummary, agentTasks, agentSummary, biographyEvents, biographySummary, memories, memorySummary, obsidian };
}

function getSessionTagExtractionState(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return { sessionId: "", exclusions: [] };
  try {
    const result = window.zion?.commands?.executeCommand?.(
      "zion.sessions.getTagExtractionState",
      { sessionId: sid }
    );
    if (result && typeof result === "object" && !("then" in result)) return result;
  } catch {}
  try {
    const entry = window.zion?.state?.get?.("sessions.tagIndex")?.sessions?.[sid];
    return {
      sessionId: sid,
      exclusions: Array.isArray(entry?.exclusions) ? entry.exclusions : []
    };
  } catch {
    return { sessionId: sid, exclusions: [] };
  }
}

function getSnapshotRenderSignature(snapshot, expanded, changeState) {
  return stableStringify({
    files: (snapshot.files || []).map((item) => [
      item.resourceKey || "",
      item.kind || "",
      item.path || "",
      item.sourceId || "",
      (item.sourceIds || []).join(","),
      (item.sources || []).join(",")
    ]),
    urls: (snapshot.urls || []).map((item) => [item.url || "", item.title || "", item.label || ""]),
    basics: (snapshot.basics || []).map((item) => [item.label || "", item.value || ""]),
    usage: compactUsageSignature(snapshot.usage),
    tasks: compactTaskSignature(snapshot.taskSummary, snapshot.tasks, snapshot.activeTaskId),
    comments: compactCommentSignature(snapshot.commentSummary, snapshot.comments),
    agents: compactAgentTaskSignature(snapshot.agentSummary, snapshot.agentTasks),
    biography: compactBiographySignature(snapshot.biographySummary, snapshot.biographyEvents),
    memory: compactMemorySignature(snapshot.memorySummary, snapshot.memories),
    obsidian: compactObsidianSignature(snapshot.obsidian),
    changes: changeState?.fingerprint || "",
    expanded: Array.from(expanded || []).sort()
  });
}

function renderResourceTree(snapshot, state) {
  const tree = document.createElement("div");
  tree.className = "zion-context-tree";
  tree.setAttribute("role", "tree");

  tree.appendChild(renderGroup({
    key: "files",
    depth: 0,
    label: t("context.files", "Files"),
    count: snapshot.files.length,
    meta: formatContextFilesMeta(snapshot.files.length, state.changeState?.summary),
    metaNode: renderContextFilesMetaNode(snapshot.files.length, state.changeState?.summary),
    empty: t("context.emptyFiles", "No file paths detected in the current session."),
    children: renderFileTreeRows(snapshot.files.slice(0, 80), state),
    state
  }));
  tree.appendChild(renderGroup({
    key: "web",
    depth: 0,
    label: t("context.webPages", "Web Pages"),
    count: snapshot.urls.length,
    empty: t("context.emptyWeb", "No web links detected in the current session."),
    children: snapshot.urls.slice(0, 80).map((item, index) => renderUrlTreeRow(item, index, state)),
    state
  }));
  tree.appendChild(renderGroup({
    key: "tasks",
    depth: 0,
    label: t("context.tasks", "Tasks"),
    count: snapshot.taskSummary?.taskCount || 0,
    meta: formatTaskSummaryMeta(snapshot.taskSummary),
    metaNode: renderTaskSummaryMetaNode(snapshot.taskSummary),
    empty: t("context.emptyTasks", "No todos in the current session."),
    children: renderTaskRows(snapshot.tasks, snapshot.activeTaskId, state),
    state
  }));
  tree.appendChild(renderGroup({
    key: "comments",
    depth: 0,
    label: t("context.comments", "Comments"),
    count: snapshot.commentSummary?.total || 0,
    meta: formatCommentSummaryMeta(snapshot.commentSummary),
    empty: t("context.emptyComments", "No comments in the current session."),
    children: renderCommentRows(snapshot.comments, state),
    state
  }));
  tree.appendChild(renderGroup({
    key: "agents",
    depth: 0,
    label: t("context.agents", "Agents"),
    count: snapshot.agentSummary?.total || 0,
    meta: formatAgentTaskSummaryMeta(snapshot.agentSummary),
    empty: t("context.emptyAgents", "No agent tasks in the current session."),
    children: renderAgentTaskRows(snapshot.agentTasks, state),
    state
  }));
  tree.appendChild(renderGroup({
    key: "biography",
    depth: 0,
    label: t("context.biographyEvents", "Biography Events"),
    count: snapshot.biographySummary?.total || 0,
    meta: formatBiographySummaryMeta(snapshot.biographySummary),
    empty: t("context.emptyBiography", "No biography events in the current session."),
    children: renderBiographyEventRows(snapshot.biographyEvents, state),
    state
  }));
  tree.appendChild(renderGroup({
    key: "tags",
    depth: 0,
    label: t("context.tags", "Tags"),
    count: snapshot.obsidian?.tags?.length || 0,
    empty: t("context.emptyTags", "No tags in the current session."),
    children: renderObsidianTagSection(snapshot, state),
    state
  }));
  tree.appendChild(renderGroup({
    key: "wiki-links",
    depth: 0,
    label: t("context.links", "Links"),
    count: snapshot.obsidian?.wikiLinks?.length || 0,
    empty: t("context.emptyLinks", "No wiki links in the current session."),
    children: renderObsidianWikiLinkRows(snapshot.obsidian?.wikiLinks || [], state),
    state
  }));
  tree.appendChild(renderGroup({
    key: "headings",
    depth: 0,
    label: t("context.headings", "Headings"),
    count: snapshot.obsidian?.headings?.length || 0,
    empty: t("context.emptyHeadings", "No Markdown headings in the current session."),
    children: renderObsidianLocationRows(snapshot.obsidian?.headings || [], "heading", state),
    state
  }));
  tree.appendChild(renderGroup({
    key: "anchors",
    depth: 0,
    label: t("context.anchors", "Anchors"),
    count: snapshot.obsidian?.anchors?.length || 0,
    empty: t("context.emptyAnchors", "No block anchors in the current session."),
    children: renderObsidianLocationRows(snapshot.obsidian?.anchors || [], "anchor", state),
    state
  }));
  tree.appendChild(renderGroup({
    key: "memory",
    depth: 0,
    label: t("context.memory", "Memory"),
    count: snapshot.memorySummary?.total || 0,
    meta: formatMemorySummaryMeta(snapshot.memorySummary),
    empty: t("context.emptyMemory", "No selected memory notes."),
    children: renderMemoryRows(snapshot.memories, state),
    state
  }));
  tree.appendChild(renderGroup({
    key: "usage",
    depth: 0,
    label: t("context.modelUsage", "Model Usage"),
    count: snapshot.usage?.calls || 0,
    meta: formatUsageSummaryMeta(snapshot.usage),
    metaNode: renderUsageSummaryMetaNode(snapshot.usage),
    empty: t("context.emptyUsage", "No model usage available for the current session."),
    children: renderUsageRows(snapshot.usage, state),
    state
  }));
  tree.appendChild(renderGroup({
    key: "basics",
    depth: 0,
    label: t("context.basics", "Basics"),
    count: snapshot.basics.length,
    empty: t("context.emptyBasics", "No basic context information."),
    children: snapshot.basics.map((item, index) => renderBasicTreeRow(item, index, state)),
    state
  }));
  return tree;
}

function formatContextFilesMeta(fileCount, changeSummary) {
  const files = Number(fileCount || 0);
  const changedFiles = Number(changeSummary?.changedFiles || 0);
  if (!changedFiles) return `${files}f`;
  return `${files}f · ${changedFiles}Δ · +${formatCompactChangeCount(changeSummary?.addedLines)} -${formatCompactChangeCount(changeSummary?.removedLines)}`;
}

function renderContextFilesMetaNode(fileCount, changeSummary) {
  const wrap = document.createElement("span");
  wrap.className = "zion-context-change-meta is-summary";
  const files = Number(fileCount || 0);
  const changedFiles = Number(changeSummary?.changedFiles || 0);
  const full = formatChangeSummary(changeSummary);
  const filesLabel = t("context.usage.files", "{count} files", { count: files });
  wrap.title = full ? `${filesLabel} · ${full}` : filesLabel;
  wrap.appendChild(changeMetaPart(`${files}f`));
  if (changedFiles) {
    wrap.appendChild(changeMetaPart(`${changedFiles}Δ`));
    wrap.appendChild(changeMetaPart(`+${formatCompactChangeCount(changeSummary?.addedLines)}`, "add"));
    wrap.appendChild(changeMetaPart(`-${formatCompactChangeCount(changeSummary?.removedLines)}`, "remove"));
  }
  return wrap;
}

function renderChangeMetaNode(change) {
  if (!change) return null;
  const wrap = document.createElement("span");
  wrap.className = "zion-context-change-meta";
  if (change.addedLines || change.removedLines) {
    wrap.appendChild(changeMetaPart(`+${formatCompactChangeCount(change.addedLines)}`, "add"));
    wrap.appendChild(changeMetaPart(`-${formatCompactChangeCount(change.removedLines)}`, "remove"));
  }
  return wrap.childNodes.length ? wrap : null;
}

function formatChangeMetaText(change) {
  if (!change) return "";
  return change.addedLines || change.removedLines
    ? `+${formatCompactChangeCount(change.addedLines)} -${formatCompactChangeCount(change.removedLines)}`
    : "";
}

function changeMetaPart(text, tone = "") {
  const el = document.createElement("span");
  el.className = `zion-context-change-part${tone ? ` is-${tone}` : ""}`;
  el.textContent = text;
  return el;
}

function compactUsageSignature(usage) {
  if (!usage) return "";
  return stableStringify({
    calls: usage.calls || 0,
    tokens: usage.tokens || {},
    cost: usage.cost ?? null,
    byModel: (usage.byModel || []).map((item) => [item.key, item.calls, item.tokens?.total, item.cost ?? null])
  });
}

function compactObsidianSignature(obsidian) {
  if (!obsidian) return "";
  return stableStringify({
    tags: (obsidian.tags || []).map((item) => [item.label, item.line, item.pos]),
    ignoredTagRules: (obsidian.ignoredTagRules || []).map((item) => [
      item.path,
      item.subtree,
      item.matchCount
    ]),
    wikiLinks: (obsidian.wikiLinks || []).map((item) => [item.target, item.label, item.line, item.pos]),
    headings: (obsidian.headings || []).map((item) => [item.label, item.level, item.line, item.pos]),
    anchors: (obsidian.anchors || []).map((item) => [item.label, item.line, item.pos])
  });
}

function formatUsageSummaryMeta(usage) {
  const calls = Number(usage?.calls || 0);
  if (!calls) return "0";
  return `${calls} calls · ${formatUsageTokens(usage?.tokens?.total)} tok · ${formatUsageTokens(getUsageCacheTokens(usage?.tokens))} cache`;
}

function renderUsageSummaryMetaNode(usage) {
  const wrap = document.createElement("span");
  wrap.className = "zion-context-usage-meta is-summary";
  const calls = Number(usage?.calls || 0);
  wrap.title = [
    t("context.usage.modelCalls", "{count} model calls", { count: calls }),
    t("context.usage.input", "input {count}", { count: formatUsageTokens(usage?.tokens?.input || 0) }),
    t("context.usage.output", "output {count}", { count: formatUsageTokens(usage?.tokens?.output || 0) }),
    t("context.usage.cacheRead", "cache read {count}", { count: formatUsageTokens(usage?.tokens?.cacheRead || 0) }),
    t("context.usage.cacheWrite", "cache write {count}", { count: formatUsageTokens(usage?.tokens?.cacheWrite || 0) }),
    `total ${formatUsageTokens(usage?.tokens?.total || 0)}`,
    formatUsageCostText(usage?.cost, usage?.currency)
  ].filter(Boolean).join(" · ");
  if (calls) {
    wrap.appendChild(usageStatChip("tok", formatUsageTokens(usage?.tokens?.total), "tokens"));
    wrap.appendChild(usageStatChip("cache", formatUsageTokens(getUsageCacheTokens(usage?.tokens)), "cache"));
  }
  return wrap;
}

function renderUsageRows(usage, state) {
  if (!usage?.calls) return [];
  const rows = [];
  for (const model of (usage.byModel || []).slice(0, 8)) {
    rows.push(renderUsageTreeRow({
      label: model.label || model.modelName || model.modelId || "Unknown",
      value: model,
      key: `usage:model:${model.key}`,
      state
    }));
  }
  return rows;
}

function renderUsageTreeRow({ label, value, key, state }) {
  const tokens = value?.tokens || {};
  const metaNode = document.createElement("span");
  metaNode.className = "zion-context-usage-meta is-detail";
  metaNode.appendChild(usageStatChip("tok", formatUsageTokens(tokens.total), "tokens"));
  metaNode.appendChild(usageStatChip("cache", formatUsageTokens(getUsageCacheTokens(tokens)), "cache"));
  return renderTreeRow({
    key,
    depth: 1,
    label,
    metaNode,
    title: `${label}: ${Number(value?.calls || 0)} calls · input ${formatUsageTokens(tokens.input)} · output ${formatUsageTokens(tokens.output)} · cache read ${formatUsageTokens(tokens.cacheRead)} · cache write ${formatUsageTokens(tokens.cacheWrite)} · total ${formatUsageTokens(tokens.total)} · ${formatUsageCostText(value?.cost, value?.currency)}`,
    kind: "usage",
    selected: state.selectedKey === key,
    onSelect: state.onSelect,
    secondaryActionIcon: "codicon-copy",
    secondaryActionTitle: t("context.copyUsage", "Copy usage info"),
    onSecondaryAction: () => copyText(`${label}: ${Number(value?.calls || 0)} calls, input ${tokens.input || 0}, output ${tokens.output || 0}, cacheRead ${tokens.cacheRead || 0}, cacheWrite ${tokens.cacheWrite || 0}, total ${tokens.total || 0}, ${formatUsageCostText(value?.cost, value?.currency)}`)
  });
}

function getUsageCacheTokens(tokens) {
  return Number(tokens?.cacheRead || 0) + Number(tokens?.cacheWrite || 0);
}

function usageStatChip(label, value, tone = "") {
  const chip = document.createElement("span");
  chip.className = `zion-context-usage-chip${tone ? ` is-${tone}` : ""}`;
  const name = document.createElement("span");
  name.className = "zion-context-usage-chip-label";
  name.textContent = label;
  const amount = document.createElement("span");
  amount.className = "zion-context-usage-chip-value";
  amount.textContent = String(value ?? "");
  chip.appendChild(name);
  chip.appendChild(amount);
  return chip;
}

function formatUsageTokens(value) {
  const n = Number(value || 0);
  if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function formatUsageCostText(value, currency = "USD", compact = false) {
  if (typeof value !== "number" || !Number.isFinite(value)) return compact ? "n/a" : "cost n/a";
  if (value === 0) return compact ? "0" : `${currency} 0`;
  const text = value < 0.01 ? value.toFixed(4) : value.toFixed(2);
  return compact ? `$${text}` : `${currency} ${text}`;
}

function renderGroup({ key, depth, icon, label, count, meta, metaNode, empty, children, state }) {
  const fragment = document.createDocumentFragment();
  const isExpanded = state.expanded.has(key);
  fragment.appendChild(renderTreeRow({
    key,
    depth,
    icon,
    label,
    meta: meta || String(count),
    metaNode,
    expanded: isExpanded,
    selected: state.selectedKey === key,
    kind: "group",
    onClick: () => state.onToggle(key),
    onSelect: state.onSelect
  }));
  if (!isExpanded) return fragment;
  if (!children.length) {
    fragment.appendChild(renderTreeRow({
      key: `${key}:empty`,
      depth: depth + 1,
      label: empty,
      meta: "",
      kind: "empty",
      selected: state.selectedKey === `${key}:empty`,
      onSelect: state.onSelect
    }));
    return fragment;
  }
  for (const child of children) fragment.appendChild(child);
  return fragment;
}

function renderFileTreeRows(files, state) {
  if (!files.length) return [];
  const model = buildFileTreeModel(files);
  return model.roots.flatMap((node) => renderFileNode(node, 1, state));
}

export function buildFileTreeModel(files) {
  const rawEntries = files.map((item, index) => {
    const fullPath = normalizeTreePath(item.canonicalPath || item.path || item.label || "");
    const parts = splitTreePath(fullPath);
    const sourceId = normalizeFileSourceId(item.sourceId || inferFileSource());
    const deviceKey = item.deviceKey || getFileDeviceKey(sourceId);
    const resourceKey = item.resourceKey || `${item.kind || "file"}:${deviceKey}:${fullPath}`;
    return { item: { ...item, sourceId, deviceKey, resourceKey }, index, fullPath, parts, sourceId, deviceKey, resourceKey };
  }).filter((entry) => entry.fullPath && entry.parts.length);
  const entries = dedupeItems(rawEntries, (entry) => entry.resourceKey);
  const grouped = groupByDevice(entries);
  if (grouped.length > 1) {
    return {
      roots: grouped.map(({ deviceKey, entries: sourceEntries }) => buildDeviceFileRoot(deviceKey, sourceEntries))
    };
  }
  return { roots: buildSourceFileRoots(entries) };
}

function buildDeviceFileRoot(deviceKey, entries) {
  const commonParts = commonDirectoryParts(entries);
  const commonPath = formatTreePath(commonParts, entries);
  const root = createFileTreeRoot(deviceKey, commonParts);
  for (const entry of entries) {
    const relParts = entry.parts.slice(commonParts.length);
    const parts = relParts.length ? relParts : entry.parts.slice(-1);
    insertFileTreeEntry(root, parts, entry, commonParts);
  }
  return {
    kind: "folder",
    name: getFileDeviceLabel(deviceKey, entries),
    fullPath: commonPath,
    key: `device:${deviceKey}`,
    sourceId: preferredFileSourceId(entries),
    count: entries.length,
    meta: compactMiddle(commonPath || "workspace", 54),
    children: finalizeFileTreeChildren(root)
  };
}

function buildSourceFileRoots(entries) {
  const commonParts = commonDirectoryParts(entries);
  const commonPath = formatTreePath(commonParts, entries);
  const root = createFileTreeRoot(entries[0]?.sourceId || "local", commonParts);

  for (const entry of entries) {
    const relParts = entry.parts.slice(commonParts.length);
    const parts = relParts.length ? relParts : entry.parts.slice(-1);
    insertFileTreeEntry(root, parts, entry, commonParts);
  }

  let roots = finalizeFileTreeChildren(root);
  if (commonParts.length && entries.length > 1) {
    const rootName = commonParts[commonParts.length - 1] || "Files";
    roots = [{
      kind: "folder",
      name: rootName,
      fullPath: commonPath,
      key: `folder:${commonPath}`,
      sourceId: preferredFileSourceId(entries),
      count: entries.length,
      meta: formatFileRootMeta(entries, commonPath),
      children: roots
    }];
  }
  return roots;
}

function createFileTreeRoot(sourceId, commonParts) {
  const commonPath = formatTreePath(commonParts, []);
  return { kind: "folder", name: "", fullPath: commonPath, key: `files:root:${sourceId}`, sourceId, childrenMap: new Map(), count: 0 };
}

function preferredFileSourceId(entries) {
  const terminal = entries.find((entry) => entry.sourceId?.startsWith("terminal:"));
  return terminal?.sourceId || entries[0]?.sourceId || "local";
}

function groupByDevice(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const deviceKey = entry.deviceKey || "local";
    if (!groups.has(deviceKey)) groups.set(deviceKey, []);
    groups.get(deviceKey).push(entry);
  }
  return Array.from(groups, ([deviceKey, sourceEntries]) => ({ deviceKey, entries: sourceEntries }));
}

function insertFileTreeEntry(root, parts, entry, commonParts) {
  let node = root;
  node.count += 1;
  for (let i = 0; i < parts.length; i += 1) {
    const name = parts[i] || "Untitled";
    const isLeaf = i === parts.length - 1;
    const fullParts = [...commonParts, ...parts.slice(0, i + 1)];
    const fullPath = formatTreePath(fullParts, [entry]);
    if (isLeaf) {
      if (entry.item?.kind === "folder") {
        const key = `folder:${entry.deviceKey}:${fullPath}`;
        const existing = node.childrenMap.get(key);
        if (existing?.kind === "folder") {
          existing.item = entry.item;
          if (existing.sourceId === "local" && entry.sourceId?.startsWith("terminal:")) existing.sourceId = entry.sourceId;
        } else {
          node.childrenMap.set(key, {
            kind: "folder",
            name,
            fullPath,
            key,
            item: entry.item,
            sourceId: entry.sourceId,
            childrenMap: new Map(),
            count: 0
          });
        }
        continue;
      }
      node.childrenMap.set(`file:${entry.index}:${fullPath}`, {
        kind: "file",
        name,
        fullPath,
        key: entry.resourceKey,
        item: entry.item
      });
      continue;
    }
    const key = `folder:${entry.deviceKey}:${fullPath}`;
    if (!node.childrenMap.has(key)) {
      node.childrenMap.set(key, { kind: "folder", name, fullPath, key, sourceId: entry.sourceId, childrenMap: new Map(), count: 0 });
    }
    node = node.childrenMap.get(key);
    if (node.sourceId === "local" && entry.sourceId?.startsWith("terminal:")) node.sourceId = entry.sourceId;
    node.count += 1;
  }
}

function finalizeFileTreeChildren(node) {
  return Array.from(node.childrenMap.values())
    .map((child) => child.kind === "folder" ? { ...child, children: finalizeFileTreeChildren(child) } : child)
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}

function normalizeTreePath(path) {
  return stripLineSuffix(String(path || "").trim()).replace(/\\/g, "/").replace(/\/+$/, "");
}

function splitTreePath(path) {
  const clean = normalizeTreePath(path);
  return clean.split("/").filter(Boolean);
}

function formatTreePath(parts, entries) {
  const path = (parts || []).filter(Boolean).join("/");
  if (!path) return "";
  const absolute = (entries || []).some((entry) => String(entry?.fullPath || "").startsWith("/"));
  return absolute ? `/${path}` : path;
}

function commonDirectoryParts(entries) {
  if (!entries.length) return [];
  const dirs = entries.map((entry) => entry.parts.slice(0, -1));
  if (!dirs.every((dir) => dir.length)) return [];
  const first = dirs[0];
  let end = first.length;
  for (const dir of dirs.slice(1)) {
    end = Math.min(end, dir.length);
    for (let i = 0; i < end; i += 1) {
      if (dir[i] !== first[i]) {
        end = i;
        break;
      }
    }
  }
  return first.slice(0, end);
}

function formatFileRootMeta(entries, path) {
  const deviceKeys = Array.from(new Set(entries.map((entry) => entry.deviceKey || "local").filter(Boolean)));
  const device = deviceKeys.length === 1 ? getFileDeviceLabel(deviceKeys[0], entries) : `${deviceKeys.length} devices`;
  const compactPath = compactMiddle(path || "", 48);
  return [device, compactPath].filter(Boolean).join(" · ");
}

function getFileDeviceKey(sourceId) {
  return getContextResourceDeviceKey(sourceId, getContextResourceOptions());
}

function getFileDeviceLabel(deviceKey, entries = []) {
  const key = String(deviceKey || "local");
  if (key === "local") return "Local";
  const sample = entries.find((entry) => entry.deviceKey === key) || entries[0] || null;
  if (sample?.sourceId) return getFileSourceLabel(sample.sourceId);
  if (key.startsWith("ssh:")) return `SSH ${key.replace(/^ssh:/, "").replace(/^@/, "").replace(/:22$/, "")}`;
  return "Terminal";
}

function getFileSourceLabel(sourceId) {
  const id = String(sourceId || "local");
  if (id === "local") return "Local";
  const session = getTerminalSessionForSource(id);
  const type = String(session?.type || "").trim();
  const host = String(session?.ssh_host || session?.host || session?.hostname || session?.remote_host || "").trim();
  if (type === "ssh" || host) return host ? `SSH ${host}` : "SSH";
  return "Terminal";
}

function getTerminalSessionForSource(sourceId) {
  const source = String(sourceId || "");
  const sessionId = source === "terminal:active"
    ? String(window.zion?.state?.get?.("terminal.activeSessionId") || "").trim()
    : source.startsWith("terminal:") ? source.slice("terminal:".length) : "";
  const sessions = getTerminalSessions();
  return sessions.find((session) => String(session?.id || "") === sessionId) || null;
}

function getTerminalSessions() {
  try {
    const sessions = window.zion?.state?.get?.("terminal.sessions");
    return Array.isArray(sessions) ? sessions : [];
  } catch {
    return [];
  }
}

function getContextResourceOptions() {
  return {
    terminalSessions: getTerminalSessions(),
    activeSessionId: String(window.zion?.state?.get?.("terminal.activeSessionId") || "").trim()
  };
}

function renderFileNode(node, depth, state) {
  if (node.kind === "file") return [renderFileTreeRow(node.item, node.key, node.name, depth, state)];
  if (state.defaultExpandFolders && !state.expanded.has(node.key)) state.expanded.add(node.key);
  const isExpanded = state.expanded.has(node.key) || state.defaultExpandFolders;
  const folderItem = { path: node.fullPath, sourceId: node.sourceId || node.item?.sourceId || inferFileSource() };
  const rows = [renderTreeRow({
    key: node.key,
    depth,
    icon: isExpanded ? "codicon-folder-opened" : "codicon-folder",
    label: node.name,
    meta: node.meta || (node.count > 1 ? String(node.count) : ""),
    title: node.fullPath,
    expanded: isExpanded,
    selected: state.selectedKey === node.key,
    kind: "folder",
    onClick: () => state.onToggle(node.key),
    onSelect: state.onSelect,
    onContextMenu: (event) => showContextFolderMenu(folderItem, event.clientX, event.clientY),
    actionIcon: "codicon-folder-opened",
    actionTitle: t("context.openInFolder", "Open in Folder"),
    onAction: () => openFileInLocalFolder(folderItem)
  })];
  if (isExpanded) {
    for (const child of node.children) rows.push(...renderFileNode(child, depth + 1, state));
  }
  return rows;
}

function renderFileTreeRow(item, keySuffix, label, depth, state) {
  const key = `file:${keySuffix || `${item.sourceId || ""}:${item.path || item.label || ""}`}`;
  const path = normalizeChangePath(item.path || item.label || "");
  const change = path ? state.changeState?.byPath?.get?.(path) : null;
  return renderTreeRow({
    key,
    depth,
    label: label || displayFileName(item.path || item.label),
    icon: iconForFile(label || item.path || item.label),
    meta: formatChangeMetaText(change),
    metaNode: renderChangeMetaNode(change),
    title: item.path || item.label,
    kind: "file",
    selected: state.selectedKey === key,
    onClick: () => state.onOpenFile?.(item),
    onSelect: state.onSelect,
    actionIcon: "codicon-folder-opened",
    actionTitle: t("context.openInFolder", "Open in Folder"),
    onAction: () => openFileInLocalFolder(item),
    secondaryActionIcon: "codicon-copy",
    secondaryActionTitle: t("context.copyPath", "Copy path"),
    onSecondaryAction: () => copyText(item.path || item.label || "")
  });
}

function renderUrlTreeRow(item, index, state) {
  const key = `url:${item.url || index}`;
  return renderTreeRow({
    key,
    depth: 1,
    label: item.title || item.label || item.url,
    meta: hostFromUrl(item.url),
    title: item.url,
    kind: "url",
    selected: state.selectedKey === key,
    onClick: () => {
      if (!openUrlInInspector(item.url)) {
        try { window.open(item.url, "_blank", "noopener,noreferrer"); } catch {}
      }
    },
    onSelect: state.onSelect,
    actionIcon: "codicon-globe",
    actionTitle: t("context.openUrl", "Preview webpage"),
    onAction: () => {
      if (!openUrlInInspector(item.url)) {
        try { window.open(item.url, "_blank", "noopener,noreferrer"); } catch {}
      }
    },
    secondaryActionIcon: "codicon-copy",
    secondaryActionTitle: t("context.copyUrl", "Copy link"),
    onSecondaryAction: () => copyText(item.url || "")
  });
}

function openUrlInInspector(value) {
  const url = normalizeUrl(value);
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    if (typeof window.zion?.inspector?.open !== "function") return false;
    window.zion.inspector.open({
      id: `web:${stableContextHash(url)}`,
      ownerId: CONTEXT_VIEW_ID,
      title: parsed.host || url,
      path: url,
      displayPath: url,
      url,
      language: "web"
    });
    return true;
  } catch {
    return false;
  }
}

function stableContextHash(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

function renderObsidianTagSection(snapshot, state) {
  const sessionId = String(snapshot?.sessionId || "").trim();
  const rows = renderObsidianTagsRows(snapshot?.obsidian?.tags || [], state, sessionId);
  const ignoredRules = snapshot?.obsidian?.ignoredTagRules || [];
  if (ignoredRules.length) {
    rows.push(renderGroup({
      key: "tags:ignored",
      depth: 1,
      icon: "codicon-eye-closed",
      label: t("context.ignoredTags", "Ignored"),
      count: ignoredRules.length,
      empty: "",
      children: renderIgnoredTagRows(ignoredRules, state, sessionId),
      state
    }));
  }
  return rows;
}

function renderObsidianTagsRows(tags, state, sessionId) {
  return (Array.isArray(tags) ? tags : []).slice(0, 80).map((item, index) => {
    const key = `tag:${item.label || index}`;
    const tagPath = String(item.label || "").replace(/^#/, "");
    return renderTreeRow({
      key,
      depth: 1,
      icon: "codicon-tag",
      label: item.label,
      meta: `L${item.line || 1}`,
      title: `${item.label} · line ${item.line || 1}`,
      kind: "tag",
      selected: state.selectedKey === key,
      onClick: () => jumpToEditorPosition(item.pos),
      onSelect: state.onSelect,
      secondaryActionIcon: "codicon-eye-closed",
      secondaryActionTitle: t("context.ignoreTag", "Ignore tag in this session"),
      onSecondaryAction: () => runContextTagExclusionCommand(
        "zion.sessions.excludeTag",
        {
          sessionId,
          path: tagPath,
          subtree: false
        },
        t("context.tagIgnored", "Ignored #{tag} in this session", { tag: tagPath })
      )
    });
  });
}

function renderIgnoredTagRows(rules, state, sessionId) {
  return (Array.isArray(rules) ? rules : []).slice(0, 80).map((rule, index) => {
    const key = `tag:ignored:${rule.path || index}:${rule.subtree ? "subtree" : "exact"}`;
    const label = `#${rule.path}${rule.subtree ? "/…" : ""}`;
    return renderTreeRow({
      key,
      depth: 2,
      icon: "codicon-eye-closed",
      label,
      meta: rule.matchCount ? String(rule.matchCount) : "",
      title: rule.subtree
        ? t("context.ignoredTagSubtree", "Ignored tag subtree #{tag}", { tag: rule.path })
        : t("context.ignoredTagExact", "Ignored tag #{tag}", { tag: rule.path }),
      kind: "tag-ignored",
      selected: state.selectedKey === key,
      onSelect: state.onSelect,
      actionIcon: "codicon-eye",
      actionTitle: t("context.restoreTag", "Restore tag extraction"),
      onAction: () => runContextTagExclusionCommand(
        "zion.sessions.restoreTag",
        {
          sessionId,
          path: rule.path,
          subtree: rule.subtree === true
        },
        t("context.tagRestored", "Restored #{tag}", { tag: rule.path })
      )
    });
  });
}

function runContextTagExclusionCommand(command, payload, successMessage) {
  try {
    const result = window.zion?.commands?.executeCommand?.(command, payload);
    Promise.resolve(result)
      .then((value) => {
        if (!value?.ok) throw new Error("Tag exclusion command failed");
        try {
          window.zion?.notification?.show?.(successMessage, {
            type: "info",
            duration: 2200
          });
        } catch {}
      })
      .catch(() => {
        try {
          window.zion?.notification?.show?.(
            t("context.tagActionFailed", "Could not update tag extraction"),
            { type: "error", duration: 3000 }
          );
        } catch {}
      });
  } catch {
    try {
      window.zion?.notification?.show?.(
        t("context.tagActionFailed", "Could not update tag extraction"),
        { type: "error", duration: 3000 }
      );
    } catch {}
  }
}

function renderObsidianWikiLinkRows(links, state) {
  return (Array.isArray(links) ? links : []).slice(0, 80).map((item, index) => {
    const key = `wiki:${item.target || index}`;
    return renderTreeRow({
      key,
      depth: 1,
      icon: "codicon-link",
      label: item.label || item.target,
      meta: `L${item.line || 1}`,
      title: `${item.raw || item.target} · line ${item.line || 1}`,
      kind: "wiki",
      selected: state.selectedKey === key,
      onClick: () => jumpToObsidianTarget(item.target, item.pos),
      onSelect: state.onSelect,
      secondaryActionIcon: "codicon-copy",
      secondaryActionTitle: t("context.copyInfo", "Copy info"),
      onSecondaryAction: () => copyText(`[[${item.raw || item.target || ""}]]`)
    });
  });
}

function renderObsidianLocationRows(items, kind, state) {
  return (Array.isArray(items) ? items : []).slice(0, 80).map((item, index) => {
    const key = `${kind}:${item.label || index}`;
    const icon = kind === "heading" ? "codicon-list-tree" : "codicon-symbol-property";
    const meta = kind === "heading" ? `H${item.level || 1} · L${item.line || 1}` : `L${item.line || 1}`;
    return renderTreeRow({
      key,
      depth: 1,
      icon,
      label: item.label,
      meta,
      title: `${item.label} · line ${item.line || 1}`,
      kind,
      selected: state.selectedKey === key,
      onClick: () => jumpToEditorPosition(item.pos),
      onSelect: state.onSelect,
      secondaryActionIcon: "codicon-copy",
      secondaryActionTitle: t("context.copyInfo", "Copy info"),
      onSecondaryAction: () => copyText(kind === "anchor" ? `[[${item.label || ""}]]` : `[[${item.label || ""}]]`)
    });
  });
}

function jumpToEditorPosition(pos) {
  const n = Number(pos);
  if (!Number.isFinite(n) || n < 0) return;
  try {
    const editor = window.zion?.window?.activeEditor;
    const view = editor?.getView?.();
    if (view?.dispatch) {
      const safePos = Math.max(0, Math.min(n, view.state?.doc?.length || n));
      view.dispatch({ selection: { anchor: safePos }, scrollIntoView: true });
      view.focus?.();
      return;
    }
    const text = String(editor?.getValue?.() || "");
    const before = text.slice(0, n);
    const line = before.split(/\r?\n/).length;
    const ch = before.length - Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")) - 1;
    editor?.setCursor?.({ line, ch: Math.max(0, ch) });
    editor?.focus?.();
  } catch {}
}

function jumpToObsidianTarget(target, fallbackPos) {
  try {
    const text = getActiveEditorText();
    const pos = findObsidianTargetPosition(text, target);
    jumpToEditorPosition(pos == null ? fallbackPos : pos);
  } catch {
    jumpToEditorPosition(fallbackPos);
  }
}

function renderBasicTreeRow(item, index, state) {
  const key = `basic:${item.label || index}`;
  return renderTreeRow({
    key,
    depth: 1,
    label: item.label,
    meta: item.value,
    title: `${item.label}: ${item.value}`,
    kind: "basic",
    selected: state.selectedKey === key,
    onSelect: state.onSelect,
    secondaryActionIcon: "codicon-copy",
    secondaryActionTitle: t("context.copyInfo", "Copy info"),
    onSecondaryAction: () => copyText(`${item.label}: ${item.value}`)
  });
}

function renderCommentRows(comments, state) {
  return (Array.isArray(comments) ? comments : []).slice(0, 24).map((item, index) => {
    const key = `comment:${item.id || index}`;
    const anchor = commentAnchorLabel(item);
    const created = formatCompactTime(item.createdAt || item.updatedAt);
    const status = item.resolved ? "resolved" : "";
    const metaText = [anchor, status, created].filter(Boolean).join(" · ");
    return renderTreeRow({
      key,
      depth: 1,
      icon: "codicon-comment-discussion",
      label: compactEnd(item.quote || item.anchorText || "Comment", 88),
      metaNode: renderCommentMetaNode(item, metaText),
      title: [
        item.quote || item.anchorText || "Comment",
        anchor ? `Anchor: ${anchor}` : "",
        created ? `Created: ${created}` : "",
        item.id ? `Thread: ${item.id}` : ""
      ].filter(Boolean).join("\n"),
      kind: "comment",
      selected: state.selectedKey === key,
      onClick: () => {
        try { window.zion?.commands?.executeCommand?.("comments.revealThread", item.id || "", { focus: false }); } catch {}
      },
      onSelect: state.onSelect,
      secondaryActionIcon: "codicon-copy",
      secondaryActionTitle: t("context.copyComment", "Copy comment info"),
      onSecondaryAction: () => copyText(formatCommentCopyText(item))
    });
  });
}

function renderAgentTaskRows(tasks, state) {
  return (Array.isArray(tasks) ? tasks : []).slice(0, 24).map((item, index) => {
    const key = `agent:${item.id || index}`;
    const status = String(item.status || "idle");
    const agent = String(item.agentId || "agent");
    const anchor = agentTaskAnchorLabel(item);
    const policy = agentTaskPolicyLabel(item);
    const metaText = [agent, status, policy, anchor, formatCompactTime(item.updatedAt || item.createdAt)].filter(Boolean).join(" · ");
    return renderTreeRow({
      key,
      depth: 1,
      icon: "codicon-hubot",
      label: compactEnd(item.title || item.anchorText || "Agent Task", 88),
      meta: metaText,
      title: [
        item.title || item.anchorText || "Agent Task",
        `Agent: ${agent}`,
        `Status: ${status}`,
        policy ? `Policy: ${policy}` : "",
        anchor ? `Anchor: ${anchor}` : "",
        item.id ? `Task: ${item.id}` : ""
      ].filter(Boolean).join("\n"),
      kind: "agent",
      selected: state.selectedKey === key,
      onClick: () => {
        try { window.zion?.commands?.executeCommand?.("agents.revealTask", item.id || "", { focus: false }); } catch {}
      },
      onSelect: state.onSelect,
      secondaryActionIcon: "codicon-copy",
      secondaryActionTitle: t("context.copyAgentTask", "Copy agent task info"),
      onSecondaryAction: () => copyText(formatAgentTaskCopyText(item))
    });
  });
}

function renderBiographyEventRows(events, state) {
  return normalizeContextBiographyEvents(events).slice(0, 24).map((event, index) => {
    const key = `biography:${event.id || index}`;
    return renderTreeRow({
      key,
      depth: 1,
      icon: biographyEventIcon(event.kind),
      label: compactEnd(event.summary || "Biography event", 88),
      meta: formatBiographyEventMeta(event),
      title: formatBiographyEventCopyText(event),
      kind: "biography",
      selected: state.selectedKey === key,
      onSelect: state.onSelect,
      secondaryActionIcon: "codicon-copy",
      secondaryActionTitle: t("context.copyBiography", "Copy biography event"),
      onSecondaryAction: () => copyText(formatBiographyEventCopyText(event))
    });
  });
}

function renderMemoryRows(memories, state) {
  return (Array.isArray(memories) ? memories : []).slice(0, 24).map((item, index) => {
    const key = `memory:${item.id || index}`;
    const enabled = item.enabled !== false;
    return renderTreeRow({
      key,
      depth: 1,
      label: compactEnd(item.path || item.title || "Memory", 88),
      meta: enabled ? "on" : "off",
      title: [
        item.title || "Memory",
        `Path: ${item.path || ""}`,
        `Layer: ${item.layer || "long-term"}`,
        `Type: ${item.type || "semantic"}`,
        `Scope: ${item.scope || "project"}`,
        `Provider: ${item.providerId || "local-markdown-files"}`,
        item.tags?.length ? `Tags: ${item.tags.join(", ")}` : "",
        item.id ? `Memory: ${item.id}` : ""
      ].filter(Boolean).join("\n"),
      kind: "memory",
      selected: state.selectedKey === key,
      onClick: () => {
        state.onOpenMemory?.(item);
      },
      onSelect: state.onSelect
    });
  });
}

function getCommentsForSession(sessionId) {
  const sid = String(sessionId || "global");
  try {
    const raw = localStorage.getItem(LS_COMMENTS_THREADS);
    const parsed = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    const comments = list
      .filter((item) => String(item?.sessionId || "global") === sid)
      .sort((a, b) => commentOrder(a) - commentOrder(b) || (Number(a?.createdAt || 0) - Number(b?.createdAt || 0)));
    return comments;
  } catch {
    return [];
  }
}

function getAgentTasksForSession(sessionId) {
  const sid = String(sessionId || "global");
  try {
    const apiTasks = window.zion?.agents?.getTasksForSession?.(sid);
    if (Array.isArray(apiTasks)) return apiTasks;
  } catch {}
  try {
    const raw = localStorage.getItem(LS_AGENT_TASKS);
    const parsed = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    return list
      .filter((item) => String(item?.sessionId || "global") === sid)
      .sort((a, b) => agentTaskOrder(a) - agentTaskOrder(b) || Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0));
  } catch {
    return [];
  }
}

function getMemoryItems() {
  try {
    const apiItems = window.zion?.memory?.listMemories?.();
    if (Array.isArray(apiItems)) return apiItems.filter(Boolean).sort(compareMemoryItems);
  } catch {}
  try {
    const raw = localStorage.getItem(LS_MEMORY_ITEMS);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(Boolean).sort(compareMemoryItems) : [];
  } catch {
    return [];
  }
}

function buildCommentSummary(comments) {
  const safe = Array.isArray(comments) ? comments : [];
  return safe.reduce((acc, item) => {
    acc.total += 1;
    if (item?.resolved) acc.resolved += 1;
    else acc.open += 1;
    if (hasCommentAnchor(item)) acc.anchored += 1;
    else acc.noAnchor += 1;
    return acc;
  }, { total: 0, open: 0, resolved: 0, anchored: 0, noAnchor: 0 });
}

function buildAgentTaskSummary(tasks) {
  const safe = Array.isArray(tasks) ? tasks : [];
  return safe.reduce((acc, item) => {
    acc.total += 1;
    const status = String(item?.status || "idle");
    if (status === "running") acc.running += 1;
    else if (status === "done") acc.done += 1;
    else if (status === "error") acc.error += 1;
    else acc.idle += 1;
    if (hasAgentTaskAnchor(item)) acc.anchored += 1;
    return acc;
  }, { total: 0, running: 0, done: 0, error: 0, idle: 0, anchored: 0 });
}

function buildMemorySummary(memories) {
  const safe = Array.isArray(memories) ? memories : [];
  return safe.reduce((acc, item) => {
    acc.total += 1;
    if (item?.enabled === false) acc.disabled += 1;
    else acc.enabled += 1;
    if (item?.pinned) acc.pinned += 1;
    if (item?.layer === "working") acc.working += 1;
    else acc.longTerm += 1;
    const type = String(item?.type || "semantic");
    acc.types[type] = (acc.types[type] || 0) + 1;
    return acc;
  }, { total: 0, enabled: 0, disabled: 0, pinned: 0, working: 0, longTerm: 0, types: {} });
}

export function normalizeContextBiographyEvents(events) {
  const seen = new Set();
  return (Array.isArray(events) ? events : [])
    .map(normalizeContextBiographyEvent)
    .filter(Boolean)
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    })
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

function normalizeContextBiographyEvent(input, index = 0) {
  const kind = String(input?.kind || "").trim().toLowerCase();
  const summary = compactEnd(input?.summary || "", 180);
  if (!CONTEXT_BIOGRAPHY_KINDS.has(kind) || !summary) return null;
  const at = Number.isFinite(Date.parse(input?.at)) ? new Date(input.at).toISOString() : "";
  const sessionId = String(input?.sessionId || "").trim();
  const runId = String(input?.runId || "").trim();
  const id = String(input?.id || `${sessionId}:${runId}:${index}`).trim();
  return {
    id,
    at,
    kind,
    summary,
    confirmed: input?.confirmed === true,
    project: normalizeContextLabel(input?.project),
    topics: normalizeContextTopics(input?.topics),
    sessionId,
    runId
  };
}

function normalizeContextLabel(value, maxChars = 64) {
  return compactEnd(value || "", maxChars)
    .toLowerCase()
    .replace(/^#?(?:project|topic)\//, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff./-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "");
}

function normalizeContextTopics(value) {
  const source = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return Array.from(new Set(source.map((item) => normalizeContextLabel(item, 48)).filter(Boolean))).slice(0, 4);
}

export function buildBiographyContextSummary(events) {
  const safe = normalizeContextBiographyEvents(events);
  return safe.reduce((acc, event) => {
    acc.total += 1;
    if (event.confirmed) acc.confirmed += 1;
    if (event.project) acc.projects.add(event.project);
    acc.kinds[event.kind] = (acc.kinds[event.kind] || 0) + 1;
    for (const topic of event.topics || []) acc.topics.add(topic);
    return acc;
  }, { total: 0, confirmed: 0, projects: new Set(), topics: new Set(), kinds: {} });
}

function formatCommentSummaryMeta(summary) {
  const total = Number(summary?.total || 0);
  if (!total) return "0";
  const parts = [`${Number(summary?.open || 0)} open`];
  if (summary?.resolved) parts.push(`${Number(summary.resolved)} resolved`);
  if (summary?.noAnchor) parts.push(`${Number(summary.noAnchor)} no anchor`);
  return parts.join(" · ");
}

function formatAgentTaskSummaryMeta(summary) {
  const total = Number(summary?.total || 0);
  if (!total) return "0";
  const parts = [];
  if (summary?.running) parts.push(`${Number(summary.running)} running`);
  if (summary?.done) parts.push(`${Number(summary.done)} done`);
  if (summary?.error) parts.push(`${Number(summary.error)} error`);
  if (!parts.length) parts.push(`${Number(summary?.idle || 0)} idle`);
  return parts.join(" · ");
}

function formatMemorySummaryMeta(summary) {
  const total = Number(summary?.total || 0);
  if (!total) return "0";
  const parts = [`${Number(summary?.working || 0)} working`];
  if (summary?.longTerm) parts.push(`${Number(summary.longTerm)} long-term`);
  if (summary?.disabled) parts.push(`${Number(summary.disabled)} off`);
  return parts.join(" · ");
}

function formatBiographySummaryMeta(summary) {
  const total = Number(summary?.total || 0);
  if (!total) return "0";
  const kinds = Object.entries(summary?.kinds || {})
    .filter(([, count]) => Number(count || 0) > 0)
    .slice(0, 2)
    .map(([kind, count]) => `${Number(count)} ${biographyKindLabel(kind)}`);
  const projects = summary?.projects?.size
    ? t("context.biographyProjects", "{count} projects", { count: summary.projects.size })
    : "";
  return [...kinds, projects].filter(Boolean).join(" · ") || String(total);
}

function biographyKindLabel(kind) {
  const key = String(kind || "");
  return {
    decision: t("context.biographyKind.decision", "decision"),
    milestone: t("context.biographyKind.milestone", "milestone"),
    outcome: t("context.biographyKind.outcome", "outcome"),
    lesson: t("context.biographyKind.lesson", "lesson")
  }[key] || key;
}

function biographyEventIcon(kind) {
  return {
    decision: "codicon-git-pull-request",
    milestone: "codicon-milestone",
    outcome: "codicon-check",
    lesson: "codicon-lightbulb"
  }[String(kind || "")] || "codicon-history";
}

function formatBiographyEventMeta(event) {
  return [
    biographyKindLabel(event?.kind),
    event?.project ? `#${event.project}` : "",
    formatBiographyTime(event?.at)
  ].filter(Boolean).join(" · ");
}

function formatBiographyTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const pad = (item) => String(item).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatBiographyEventCopyText(event) {
  return [
    `[${biographyKindLabel(event?.kind)}] ${event?.summary || ""}`,
    event?.project ? `Project: ${event.project}` : "",
    event?.topics?.length ? `Topics: ${event.topics.join(", ")}` : "",
    `Confirmed: ${event?.confirmed === true}`,
    event?.sessionId ? `Session: ${event.sessionId}` : "",
    event?.runId ? `Run: ${event.runId}` : "",
    event?.at ? `At: ${event.at}` : ""
  ].filter(Boolean).join("\n");
}

function compactCommentSignature(summary, comments) {
  return stableStringify({
    summary,
    comments: (comments || []).slice(0, 32).map((item) => [
      item?.id || "",
      item?.quote || item?.anchorText || "",
      item?.resolved || false,
      item?.createdAt || 0,
      item?.updatedAt || 0,
      item?.startLine ?? item?.lineFrom ?? null,
      item?.endLine ?? item?.lineTo ?? null,
      item?.from ?? null,
      commentRunStatus(item)
    ])
  });
}

function compactMemorySignature(summary, memories) {
  return stableStringify({
    summary,
    memories: (memories || []).slice(0, 32).map((item) => [
      item?.id || "",
      item?.path || "",
      item?.title || "",
      item?.layer || "",
      item?.type || "",
      item?.scope || "",
      item?.enabled !== false,
      !!item?.pinned,
      item?.updatedAt || 0
    ])
  });
}

function compactBiographySignature(summary, events) {
  return stableStringify({
    total: Number(summary?.total || 0),
    confirmed: Number(summary?.confirmed || 0),
    projects: Array.from(summary?.projects || []),
    topics: Array.from(summary?.topics || []),
    kinds: summary?.kinds || {},
    events: (events || []).slice(0, 32).map((event) => [
      event?.id || "",
      event?.at || "",
      event?.kind || "",
      event?.summary || "",
      event?.project || "",
      (event?.topics || []).join(","),
      event?.confirmed === true
    ])
  });
}

function compactAgentTaskSignature(summary, tasks) {
  return stableStringify({
    summary,
    tasks: (tasks || []).slice(0, 32).map((item) => [
      item?.id || "",
      item?.title || item?.anchorText || "",
      item?.agentId || "",
      item?.status || "",
      item?.updatedAt || 0,
      item?.runner?.runner || "",
      item?.runner?.isolation || item?.isolation || "",
      item?.runner?.permissionMode || item?.permissionMode || "",
      item?.lineFrom ?? null,
      item?.lineTo ?? null,
      item?.from ?? null
    ])
  });
}

function commentOrder(item) {
  if (typeof item?.from === "number") return item.from;
  if (typeof item?.startLine === "number") return item.startLine * 1000000;
  if (typeof item?.lineFrom === "number") return item.lineFrom * 1000000;
  return Number.MAX_SAFE_INTEGER;
}

function agentTaskOrder(item) {
  if (typeof item?.from === "number") return item.from;
  if (typeof item?.lineFrom === "number") return item.lineFrom * 1000000;
  return Number.MAX_SAFE_INTEGER;
}

function compareMemoryItems(a, b) {
  return String(a?.path || "").localeCompare(String(b?.path || "")) || Number(b?.updatedAt || b?.createdAt || 0) - Number(a?.updatedAt || a?.createdAt || 0);
}

function hasCommentAnchor(item) {
  return typeof item?.from === "number" || typeof item?.startLine === "number" || typeof item?.lineFrom === "number";
}

function hasAgentTaskAnchor(item) {
  return typeof item?.from === "number" || typeof item?.lineFrom === "number";
}

function commentAnchorLabel(item) {
  if (typeof item?.startLine === "number") return `L${item.startLine + 1}`;
  if (typeof item?.lineFrom === "number") return `L${item.lineFrom + 1}`;
  if (typeof item?.from === "number") return "anchor";
  return "no anchor";
}

function agentTaskAnchorLabel(item) {
  if (typeof item?.lineFrom === "number") {
    const from = Number(item.lineFrom) + 1;
    const to = Number(item.lineTo ?? item.lineFrom) + 1;
    return from === to ? `L${from}` : `L${from}-${to}`;
  }
  if (typeof item?.from === "number") return "anchor";
  return "no anchor";
}

function agentTaskPolicyLabel(item) {
  const runner = item?.runner || {};
  const isolation = runner.isolation || item?.isolation || "";
  const permission = runner.permissionMode || item?.permissionMode || "";
  const running = item?.activeRunId ? "active" : "";
  return [isolation, permission, running].filter(Boolean).join("/");
}

function formatCommentCopyText(item) {
  return [
    `Comment: ${item?.quote || item?.anchorText || ""}`,
    `Anchor: ${commentAnchorLabel(item)}`,
    `Status: ${item?.resolved ? "resolved" : "open"}`,
    `Thread: ${item?.id || ""}`
  ].filter(Boolean).join("\n");
}

function formatAgentTaskCopyText(item) {
  return [
    `Agent Task: ${item?.title || item?.anchorText || ""}`,
    `Agent: ${item?.agentId || ""}`,
    `Status: ${item?.status || "idle"}`,
    `Policy: ${agentTaskPolicyLabel(item)}`,
    `Anchor: ${agentTaskAnchorLabel(item)}`,
    `Task: ${item?.id || ""}`
  ].filter(Boolean).join("\n");
}

function formatMemoryCopyText(item) {
  return [
    `Memory: ${item?.title || ""}`,
    `Path: ${item?.path || ""}`,
    `Layer: ${item?.layer || "long-term"}`,
    `Type: ${item?.type || "semantic"}`,
    `Scope: ${item?.scope || "project"}`,
    `Provider: ${item?.providerId || "local-markdown-files"}`,
    `Enabled: ${item?.enabled !== false}`,
    item?.tags?.length ? `Tags: ${item.tags.join(", ")}` : "",
    item?.content ? `\n${item.content}` : ""
  ].filter(Boolean).join("\n");
}

function renderCommentMetaNode(item, text) {
  const wrap = document.createElement("span");
  wrap.className = "zion-context-comment-meta";
  const run = document.createElement("span");
  const status = commentRunStatus(item);
  run.className = `zion-context-comment-run-dot is-${status}`;
  run.title = commentRunStatusTitle(status);
  wrap.appendChild(run);
  if (text) {
    const label = document.createElement("span");
    label.textContent = text;
    wrap.appendChild(label);
  }
  return wrap;
}

function commentRunStatus(item) {
  try {
    const sid = item?.threadSessionId || (item?.id ? `comment:${item.id}` : "");
    const state = sid ? window.zion?.state?.get?.(`chat.runs.${sid}`) : null;
    if (state?.streaming) return "streaming";
    if (state?.error) return "error";
    if (state?.aborted) return "aborted";
    if (state?.awaiting) return "ready";
  } catch {}
  return "idle";
}

function commentRunStatusTitle(status) {
  if (status === "streaming") return t("context.run.streaming", "Answering");
  if (status === "ready") return t("context.run.ready", "Ready to continue");
  if (status === "error") return t("context.run.error", "Error");
  if (status === "aborted") return t("context.run.aborted", "Stopped");
  return t("context.run.idle", "Not running");
}

function compactEnd(value, max = 88) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
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

function buildTaskSummary(tasks, activeTaskId) {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const summary = safeTasks.reduce((acc, task) => {
    const todos = Array.isArray(task?.todos) ? task.todos : [];
    acc.todos += todos.length;
    acc.done += todos.filter((todo) => normalizeTodoStatus(todo?.status) === "completed").length;
    acc.doing += todos.filter((todo) => normalizeTodoStatus(todo?.status) === "in_progress").length;
    return acc;
  }, { taskCount: safeTasks.length, todos: 0, done: 0, doing: 0, activeName: "" });
  const active = safeTasks.find((task) => task?.id && task.id === activeTaskId) || null;
  summary.activeName = active?.name || "";
  return summary;
}

function filterTasksForSession(tasks, sessionId, activeTodoWrites = null) {
  const sid = String(sessionId || "");
  if (!sid) return [];
  const list = (Array.isArray(tasks) ? tasks : []).filter((task) => String(task?.sessionId || "") === sid);
  if (!activeTodoWrites) return list;
  if (!activeTodoWrites.ids.size && !activeTodoWrites.taskIds.size && !activeTodoWrites.signatures.size) return list;
  return list.filter((task) => {
    const taskId = String(task?.id || "");
    const toolId = String(task?.sourceToolCallId || "");
    const signature = String(task?.todoSignature || "");
    if (taskId && activeTodoWrites.taskIds.has(taskId)) return true;
    if (toolId && activeTodoWrites.ids.has(toolId)) return true;
    if (signature && activeTodoWrites.signatures.has(signature)) return true;
    return false;
  });
}

function getActiveTodoWriteRefs(tools) {
  const refs = { ids: new Set(), taskIds: new Set(), signatures: new Set() };
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isTodoWriteTool(tool)) continue;
    const id = String(tool?.id || tool?.toolCallId || "");
    if (id) refs.ids.add(id);
    const taskId = String(tool?.args?.taskId || "");
    if (taskId) refs.taskIds.add(taskId);
    const todos = normalizeTodoWriteArgs(tool?.args);
    if (todos.length) refs.signatures.add(signatureForTodoWriteArgs(todos));
  }
  return refs;
}

function isTodoWriteTool(tool) {
  const name = String(tool?.name || tool?.tool || tool?.type || "").trim().toLowerCase();
  return name === "todowrite";
}

function normalizeTodoWriteArgs(args) {
  const todos = Array.isArray(args?.todos) ? args.todos : [];
  return todos.map((todo) => ({
    content: String(todo?.content || "").trim(),
    activeForm: String(todo?.activeForm || "").trim()
  })).filter((todo) => todo.content || todo.activeForm);
}

function signatureForTodoWriteArgs(todos) {
  return JSON.stringify((todos || []).map((todo) => [
    String(todo?.content || "").trim(),
    String(todo?.activeForm || "").trim()
  ]));
}

function compactTaskSignature(summary, tasks, activeTaskId) {
  return stableStringify({
    summary,
    activeTaskId,
    tasks: (tasks || []).slice(0, 12).map((task) => [
      task?.id || "",
      task?.name || "",
      task?.sessionId || "",
      task?.sourceWriteSeq || 0,
      task?.updatedAt || 0,
      (task?.todos || []).map((todo) => [todo?.content || "", todo?.status || ""])
    ])
  });
}

function formatTaskSummaryMeta(summary) {
  const taskCount = Number(summary?.taskCount || 0);
  if (!taskCount) return "0";
  return `${taskCount} lists · ${t("context.tasks.done", "{done}/{total} done", { done: Number(summary?.done || 0), total: Number(summary?.todos || 0) })}`;
}

function renderTaskSummaryMetaNode(summary) {
  const wrap = document.createElement("span");
  wrap.className = "zion-context-task-meta is-summary";
  const taskCount = Number(summary?.taskCount || 0);
  wrap.title = [
    t("context.tasks.todoLists", "{count} todo lists", { count: taskCount }),
    t("context.tasks.done", "{done}/{total} done", { done: Number(summary?.done || 0), total: Number(summary?.todos || 0) }),
    t("context.tasks.doing", "{count} doing", { count: Number(summary?.doing || 0) }),
    summary?.activeName ? t("context.tasks.activeWithName", "active {name}", { name: summary.activeName }) : ""
  ].filter(Boolean).join(" · ");
  if (!taskCount) {
    wrap.appendChild(taskMetaPart("0"));
    return wrap;
  }
  wrap.appendChild(taskMetaPart(`${taskCount}l`));
  wrap.appendChild(taskMetaPart(`${Number(summary?.done || 0)}/${Number(summary?.todos || 0)}`, "done"));
  if (summary?.doing) wrap.appendChild(taskMetaPart(t("context.tasks.doing", "{count} doing", { count: summary.doing }), "doing"));
  return wrap;
}

function renderTaskRows(tasks, activeTaskId, state) {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const rows = [];
  const visibleTasks = safeTasks.slice(0, 10);
  const showListHeaders = visibleTasks.length > 1;
  visibleTasks.forEach((task, index) => {
    if (showListHeaders) rows.push(renderTaskListHeaderRow(task, index, activeTaskId, state));
    rows.push(...renderTodoRows(task, index, showListHeaders ? 2 : 1, state));
  });
  return rows;
}

function renderTaskListHeaderRow(task, index, activeTaskId, state) {
  const key = `task-list:${task?.id || index}`;
  const todos = Array.isArray(task?.todos) ? task.todos : [];
  const done = todos.filter((todo) => normalizeTodoStatus(todo?.status) === "completed").length;
  const doing = todos.filter((todo) => normalizeTodoStatus(todo?.status) === "in_progress").length;
  const pending = Math.max(0, todos.length - done - doing);
  const isActiveTask = !!task?.id && task.id === activeTaskId;
  const metaNode = document.createElement("span");
  metaNode.className = "zion-context-task-meta";
  if (isActiveTask) metaNode.appendChild(taskMetaPart(t("context.tasks.active", "active"), "active"));
  metaNode.appendChild(taskMetaPart(`${done}/${todos.length}`, "done"));
  if (doing) metaNode.appendChild(taskMetaPart(t("context.tasks.doing", "{count} doing", { count: doing }), "doing"));
  if (pending) metaNode.appendChild(taskMetaPart(`${pending} todo`, "pending"));
  const label = taskListLabel(task, index);
  return renderTreeRow({
    key,
    depth: 1,
    label,
    metaNode,
    title: `${label} · ${t("context.tasks.done", "{done}/{total} done", { done, total: todos.length })}${doing ? ` · ${t("context.tasks.doing", "{count} doing", { count: doing })}` : ""}${pending ? ` · ${pending} todo` : ""}`,
    kind: "task-list",
    selected: state.selectedKey === key,
    onClick: () => {
      try {
        if (task?.id) window.zion.state?.set?.("todo.activeTaskId", task.id);
      } catch {}
    },
    onSelect: state.onSelect,
    secondaryActionIcon: "codicon-copy",
    secondaryActionTitle: t("context.copyTask", "Copy task info"),
    onSecondaryAction: () => copyText(formatTaskForCopy(task, label))
  });
}

function renderTodoRows(task, taskIndex, depth, state) {
  const todos = Array.isArray(task?.todos) ? task.todos : [];
  return todos.slice(0, 20).map((todo, index) => renderTodoTreeRow(task, taskIndex, todo, index, depth, state));
}

function renderTodoTreeRow(task, taskIndex, todo, index, depth, state) {
  const status = normalizeTodoStatus(todo?.status);
  const key = `todo:${task?.id || taskIndex}:${todo?.id || index}`;
  const label = String(todo?.content || "").trim() || t("context.tasks.emptyTodo", "(empty todo)");
  const activeForm = String(todo?.activeForm || "").trim();
  const metaNode = document.createElement("span");
  metaNode.className = "zion-context-task-meta is-todo";
  metaNode.appendChild(taskMetaPart(todoStatusLabel(status), status));
  return renderTreeRow({
    key,
    depth,
    icon: todoStatusIcon(status),
    label,
    metaNode,
    title: [todoStatusLabel(status), label, activeForm].filter(Boolean).join(" · "),
    kind: `todo is-${status}`,
    selected: state.selectedKey === key,
    onClick: () => state.onSelect?.(key),
    onSelect: state.onSelect,
    secondaryActionIcon: "codicon-copy",
    secondaryActionTitle: t("context.copyTodo", "Copy todo"),
    onSecondaryAction: () => copyText([`[${todoStatusLabel(status)}] ${label}`, activeForm].filter(Boolean).join("\n"))
  });
}

function normalizeTodoStatus(status) {
  return status === "completed" || status === "in_progress" ? status : "pending";
}

function taskListLabel(task, index) {
  const firstTodo = Array.isArray(task?.todos) ? task.todos.find((todo) => String(todo?.content || "").trim()) : null;
  const first = String(firstTodo?.content || "").trim();
  const label = t("context.tasks.list", "Todo List {index}", { index: index + 1 });
  return first ? `${label} · ${first}` : label;
}

function formatTaskForCopy(task, label) {
  const todos = Array.isArray(task?.todos) ? task.todos : [];
  const lines = [label || "Todo List"];
  todos.forEach((todo, index) => {
    const status = todoStatusLabel(normalizeTodoStatus(todo?.status));
    lines.push(`${index + 1}. [${status}] ${todo?.content || ""}`);
  });
  return lines.join("\n");
}

function todoStatusLabel(status) {
  if (status === "completed") return "done";
  if (status === "in_progress") return "doing";
  return "todo";
}

function todoStatusIcon(status) {
  if (status === "completed") return "codicon-check";
  if (status === "in_progress") return "codicon-play";
  return "codicon-circle-large-outline";
}

function taskMetaPart(text, tone = "") {
  const el = document.createElement("span");
  el.className = `zion-context-task-part${tone ? ` is-${tone}` : ""}`;
  el.textContent = text;
  return el;
}

function renderTreeRow({
  key,
  depth,
  icon,
  label,
  meta,
  metaNode,
  title,
  expanded,
  selected,
  kind,
  onClick,
  onSelect,
  onContextMenu,
  actionIcon,
  actionTitle,
  onAction,
  secondaryActionIcon,
  secondaryActionTitle,
  onSecondaryAction
}) {
  const row = document.createElement("div");
  const actionCount = Number(!!(actionIcon && onAction)) + Number(!!(secondaryActionIcon && onSecondaryAction));
  row.className = `zion-context-tree-row is-${kind || "item"}${onClick ? " is-clickable" : ""}${selected ? " is-active" : ""}${actionCount ? ` has-actions has-actions-${actionCount}` : ""}`;
  row.style.setProperty("--depth", String(depth || 0));
  row.setAttribute("role", "treeitem");
  row.dataset.key = key || "";
  if (expanded != null) row.setAttribute("aria-expanded", expanded ? "true" : "false");
  row.setAttribute("aria-selected", selected ? "true" : "false");
  if (title || label) row.title = title || label;
  if (onContextMenu) {
    row.oncontextmenu = (event) => {
      event.preventDefault();
      onSelect?.(key || "");
      onContextMenu(event);
    };
  }

  const main = document.createElement("button");
  main.className = "zion-context-tree-main";
  main.type = "button";
  main.tabIndex = selected ? 0 : -1;
  main.onclick = () => {
    onSelect?.(key || "");
    onClick?.();
  };
  main.onkeydown = (event) => handleTreeRowKeydown(event, row, { key, onClick, onSelect });

  const chevron = createContextIcon(expanded == null ? "" : expanded ? "chevron-down" : "chevron-right", "zion-context-tree-chevron");
  const text = document.createElement("span");
  text.className = "zion-context-tree-label";
  text.textContent = label || "";
  main.appendChild(chevron);
  if (icon) {
    const iconEl = createContextIcon(icon, "zion-context-tree-icon");
    main.appendChild(iconEl);
  }
  main.appendChild(text);
  if (metaNode || meta) {
    const metaEl = document.createElement("span");
    metaEl.className = "zion-context-tree-meta";
    if (metaNode) metaEl.appendChild(metaNode);
    else metaEl.textContent = meta;
    main.appendChild(metaEl);
  }
  row.appendChild(main);
  if (secondaryActionIcon && onSecondaryAction) row.appendChild(iconButton(secondaryActionIcon, secondaryActionTitle || "", onSecondaryAction));
  if (actionIcon && onAction) row.appendChild(iconButton(actionIcon, actionTitle || "", onAction));
  return row;
}

function showContextFolderMenu(item, x, y) {
  const path = item?.path || item?.label || "";
  if (!path) return;
  closeContextFolderMenu();
  const popover = document.createElement("div");
  popover.className = "zion-files-actions-popover zion-files-context-popover";
  popover.appendChild(contextMenuItem(t("context.addFolderToFiles", "Add to Files Panel"), () => {
    closeContextFolderMenu();
    addFolderToFilesPanel(item);
  }));
  popover.appendChild(contextMenuItem(t("context.copyPath", "Copy path"), () => {
    closeContextFolderMenu();
    copyText(path);
  }));
  popover.oncontextmenu = (event) => event.preventDefault();
  document.body.appendChild(popover);
  contextFolderMenuEl = popover;
  positionContextFolderMenu(popover, x, y);
  requestAnimationFrame(() => {
    if (contextFolderMenuEl !== popover) return;
    window.addEventListener("pointerdown", handleContextFolderMenuPointerDown, { capture: true });
    window.addEventListener("keydown", handleContextFolderMenuKeydown, { capture: true });
  });
}

function contextMenuItem(label, action) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "zion-files-menu-item";
  btn.textContent = label;
  btn.onclick = (event) => {
    event.stopPropagation();
    action?.();
  };
  return btn;
}

function positionContextFolderMenu(popover, x, y) {
  const rect = popover.getBoundingClientRect();
  const margin = 6;
  const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin));
  const top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin));
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function closeContextFolderMenu() {
  if (!contextFolderMenuEl) return;
  try { contextFolderMenuEl.remove(); } catch {}
  contextFolderMenuEl = null;
  try { window.removeEventListener("pointerdown", handleContextFolderMenuPointerDown, { capture: true }); } catch {}
  try { window.removeEventListener("keydown", handleContextFolderMenuKeydown, { capture: true }); } catch {}
}

function handleContextFolderMenuPointerDown(event) {
  if (contextFolderMenuEl?.contains?.(event.target)) return;
  closeContextFolderMenu();
}

function handleContextFolderMenuKeydown(event) {
  if (event.key === "Escape") closeContextFolderMenu();
}

function addFolderToFilesPanel(item) {
  const path = item?.path || item?.label || "";
  if (!path) return;
  const payload = {
    path,
    sourceId: item.sourceId || inferFileSource()
  };
  try {
    const ret = window.zion.commands?.executeCommand?.("tools.files.addFolderSource", payload);
    Promise.resolve(ret)
      .then((result) => {
        if (result) window.showToast?.(t("context.addedFolderToFiles", "Added folder to Files panel"));
      })
      .catch((err) => {
        try { console.error("[context.addFolderToFiles] failed", err); } catch {}
      });
  } catch (err) {
    try { console.error("[context.addFolderToFiles] failed", err); } catch {}
  }
}

function openFileInLocalFolder(item) {
  const path = item?.path || item?.label || "";
  if (!path) return;
  const payload = {
    path,
    sourceId: item.sourceId || inferFileSource()
  };
  try { console.info("[context.openInFolder] click", { item, payload }); } catch {}
  try {
    const ret = window.zion.commands?.executeCommand?.("fs.openInFolder", payload);
    Promise.resolve(ret).then((result) => {
      try { console.info("[context.openInFolder] result", result); } catch {}
    }).catch((err) => {
      try { console.error("[context.openInFolder] failed", err); } catch {}
    });
  } catch (err) {
    try { console.error("[context.openInFolder] failed", err); } catch {}
  }
}

function handleTreeRowKeydown(event, row, { key, onClick, onSelect }) {
  const tree = row?.closest?.(".zion-context-tree");
  if (!tree) return;
  const rows = Array.from(tree.querySelectorAll(".zion-context-tree-row[data-key]"));
  const index = rows.indexOf(row);
  const focusRow = (next) => {
    if (!next) return;
    const nextKey = next.dataset?.key || "";
    onSelect?.(nextKey);
    syncSelectedRow(tree.closest(".zion-context-panel") || tree, nextKey);
    requestAnimationFrame(() => {
      try { next.querySelector(".zion-context-tree-main")?.focus?.({ preventScroll: true }); } catch {}
      try { next.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch {}
    });
  };
  if (event.key === "ArrowDown") {
    event.preventDefault();
    focusRow(rows[Math.min(rows.length - 1, index + 1)]);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    focusRow(rows[Math.max(0, index - 1)]);
    return;
  }
  if (event.key === "Home") {
    event.preventDefault();
    focusRow(rows[0]);
    return;
  }
  if (event.key === "End") {
    event.preventDefault();
    focusRow(rows[rows.length - 1]);
    return;
  }
  if (event.key === "ArrowRight" && row.getAttribute("aria-expanded") === "false") {
    event.preventDefault();
    onSelect?.(key || "");
    onClick?.();
    return;
  }
  if (event.key === "ArrowLeft" && row.getAttribute("aria-expanded") === "true") {
    event.preventDefault();
    onSelect?.(key || "");
    onClick?.();
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onSelect?.(key || "");
    onClick?.();
  }
}

function syncSelectedRow(root, selectedKey) {
  try {
    const rows = root.querySelectorAll(".zion-context-tree-row[data-key]");
    let hasSelected = false;
    for (const row of rows) {
      const active = row.dataset.key === selectedKey;
      row.classList.toggle("is-active", active);
      row.setAttribute("aria-selected", active ? "true" : "false");
      const main = row.querySelector(".zion-context-tree-main");
      if (main) main.tabIndex = active ? 0 : -1;
      if (active) hasSelected = true;
    }
    if (!hasSelected && rows[0]) {
      rows[0].classList.add("is-active");
      rows[0].setAttribute("aria-selected", "true");
      const main = rows[0].querySelector(".zion-context-tree-main");
      if (main) main.tabIndex = 0;
    }
  } catch {}
}

function restoreScrollTop(scroll, value) {
  if (!scroll) return;
  const top = Math.max(0, Number(value) || 0);
  scroll.scrollTop = top;
  requestAnimationFrame(() => {
    try { scroll.scrollTop = Math.min(top, Math.max(0, scroll.scrollHeight - scroll.clientHeight)); } catch {}
  });
}

function loadExpandedGroups() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_CONTEXT_EXPANDED) || "null");
    if (Array.isArray(arr) && arr.length) return new Set(arr.filter(Boolean));
  } catch {}
  return new Set(["files", "web", "basics"]);
}

function hasStoredExpandedGroups() {
  try {
    return !!localStorage.getItem(LS_CONTEXT_EXPANDED);
  } catch {
    return false;
  }
}

function saveExpandedGroups(expanded) {
  try {
    localStorage.setItem(LS_CONTEXT_EXPANDED, JSON.stringify(Array.from(expanded || [])));
  } catch {}
}

function copyText(text) {
  const value = String(text || "");
  if (!value) return;
  try {
    navigator.clipboard?.writeText?.(value);
    window.showToast?.(t("context.copied", "Copied to clipboard"));
  } catch {}
}

function hostFromUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function normalizeUrl(url) {
  return String(url || "").trim().replace(/[),.;]+$/, "");
}

function loadUrlTitleCache() {
  try {
    const obj = JSON.parse(localStorage.getItem(LS_CONTEXT_URL_TITLES) || "{}");
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function saveUrlTitleCache(cache) {
  try {
    const entries = Object.entries(cache || {}).slice(-120);
    localStorage.setItem(LS_CONTEXT_URL_TITLES, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function mergeUrlTitleHints(cache, hints) {
  let changed = false;
  for (const [url, title] of Object.entries(hints || {})) {
    if (!url || !title) continue;
    if (cache[url]?.title === title) continue;
    cache[url] = { title, fetchedAt: Date.now(), source: "webfetch" };
    changed = true;
  }
  if (changed) saveUrlTitleCache(cache);
}

function prefetchUrlTitles(urls, cache, pending, scheduleRender) {
  for (const item of urls.slice(0, 12)) {
    const url = item?.url;
    const cached = cache[url] || {};
    const failedRecently = cached.failedAt && Date.now() - Number(cached.failedAt) < 24 * 60 * 60 * 1000;
    if (!url || item?.title || cached.title || failedRecently || pending.has(url)) continue;
    pending.add(url);
    fetchUrlTitle(url)
      .then((title) => {
        if (title) {
          cache[url] = { title, fetchedAt: Date.now() };
          scheduleRender?.();
        } else {
          cache[url] = { failedAt: Date.now() };
        }
        saveUrlTitleCache(cache);
      })
      .catch(() => {
        cache[url] = { failedAt: Date.now() };
        saveUrlTitleCache(cache);
      })
      .finally(() => pending.delete(url));
  }
}

async function fetchUrlTitle(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const resp = await fetch(url, { signal: controller.signal, credentials: "omit" });
    if (!resp.ok) return "";
    const html = await resp.text();
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return normalizeTitle(match?.[1] || "");
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTitle(value) {
  return decodeHtml(String(value || "").replace(/\s+/g, " ").trim()).slice(0, 120);
}

function decodeHtml(value) {
  try {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = value;
    return textarea.value;
  } catch {
    return value;
  }
}

function displayFileName(path) {
  const clean = stripLineSuffix(path).replace(/\\/g, "/");
  return clean.split("/").filter(Boolean).pop() || clean || "Untitled";
}

function cssEscape(value) {
  try {
    return CSS.escape(String(value || ""));
  } catch {
    return String(value || "").replace(/["\\]/g, "\\$&");
  }
}

function isCommentPanelId(panelId) {
  return String(panelId || "").startsWith("comments:");
}

function getCommentSourceSessionId() {
  try {
    const activeThreadId = window.zion?.state?.get?.("comments.activeThreadId") || "";
    if (!activeThreadId) return null;
    const raw = localStorage.getItem(LS_COMMENTS_THREADS);
    const parsed = raw ? JSON.parse(raw) : [];
    const thread = Array.isArray(parsed) ? parsed.find((item) => item?.id === activeThreadId) : null;
    return thread ? String(thread.parentSessionId || thread.sessionId || "") : null;
  } catch {
    return null;
  }
}

function getCurrentSessionId() {
  try {
    const editor = window.zion?.window?.activeEditor;
    if (editor && !isCommentPanelId(editor?.panelId) && editor?.sessionId) {
      return String(editor.sessionId);
    }
    if (editor && isCommentPanelId(editor?.panelId)) {
      const sourceSessionId = getCommentSourceSessionId();
      if (sourceSessionId) {
        return sourceSessionId;
      }
    }
    const panelId = window.zion?.panels?.getActivePanelId?.() || null;
    const panel = (window.zion?.panels?.list?.() || []).find((p) => p?.id === panelId);
    if (panel?.activeTabId && !String(panel.activeTabId).startsWith("comment:")) {
      return panel.activeTabId;
    }
    const fallbackSessionId = getCommentSourceSessionId() || panel?.activeTabId || window.zion?.state?.get?.("sessions.currentId") || null;
    return fallbackSessionId;
  } catch {
    return window.zion?.state?.get?.("sessions.currentId") || null;
  }
}

function getActiveEditorText() {
  try {
    const editor = window.zion?.window?.activeEditor;
    if (editor && isCommentPanelId(editor?.panelId)) return "";
    if (editor?.getValue) return String(editor.getValue() || "");
  } catch {}
  return "";
}

function getContextRefreshSignature() {
  const sessionId = getCurrentSessionId() || "";
  const text = getActiveEditorText();
  const tools = getCurrentTools(sessionId);
  const contextResources = getSessionContextResources(sessionId);
  const textTail = text.length > 6000 ? text.slice(-6000) : text;
  const toolSig = tools.map((tool) => [
    tool?.id || tool?.toolCallId || "",
    tool?.name || "",
    stableStringify(tool?.args),
    stableStringify(tool?.result),
    tool?.ok
  ].join(":")).join("|");
  const resourceSig = contextResources.map((item) => getSessionContextResourceKey(item)).join("|");
  return `${sessionId}:${text.length}:${textTail}:${toolSig}:${resourceSig}`;
}

function stableStringify(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getCurrentTools(sessionId) {
  try {
    if (window.zion?.tools?.getAllToolCalls) return window.zion.tools.getAllToolCalls() || [];
    const ann = window.zion?.commands?.executeCommand?.("zion.chatCards.getSessionAnnotations", sessionId);
    return Array.isArray(ann?.tools) ? ann.tools : [];
  } catch {
    return [];
  }
}

function extractWebFetchUrls(editorText, tools, urlTitleCache = {}, titleHints = {}) {
  const out = [];
  for (const url of extractFetchedUrls(editorText)) {
    out.push(makeUrlItem(url, urlTitleCache, titleHints));
  }
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (isWebFetchTool(tool)) {
      const url = normalizeUrl(tool?.args?.url || tool?.args?.input || "");
      if (url) out.push(makeUrlItem(url, urlTitleCache, titleHints));
    }
    for (const url of extractFetchedUrlsFromTool(tool)) {
      out.push(makeUrlItem(url, urlTitleCache, titleHints));
    }
  }
  return dedupeItems(out, (item) => item.url);
}

function collectWebFetchTitleHints(editorText, tools) {
  return {
    ...extractWebFetchTitlesFromCache(),
    ...extractWebFetchTitles(editorText),
    ...extractWebFetchTitlesFromTools(tools)
  };
}

function extractWebFetchTitles(text) {
  const hints = {};
  const source = String(text || "");
  for (const match of source.matchAll(createFetchedBlockRe())) {
    const url = normalizeUrl(match[1] || match[2]);
    const block = match[3] || "";
    const titleMatch = block.match(/(?:^|\n)\s*Title:\s*([^\n]+)/);
    const title = normalizeTitle(titleMatch?.[1] || "");
    if (url && title) hints[url] = title;
  }
  return hints;
}

function extractFetchedUrls(text) {
  const urls = [];
  for (const match of String(text || "").matchAll(createFetchedBlockRe())) {
    const url = normalizeUrl(match[1] || match[2]);
    if (url) urls.push(url);
  }
  return urls;
}

function extractWebFetchTitlesFromTools(tools) {
  const chunks = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    collectStringLeaves(tool?.result, chunks);
    collectStringLeaves(tool?.output, chunks);
    collectStringLeaves(tool?.content, chunks);
    collectStringLeaves(tool?.text, chunks);
  }
  return extractWebFetchTitles(chunks.join("\n\n"));
}

function extractFetchedUrlsFromTool(tool) {
  const chunks = [];
  collectStringLeaves(tool?.result, chunks);
  collectStringLeaves(tool?.output, chunks);
  collectStringLeaves(tool?.content, chunks);
  collectStringLeaves(tool?.text, chunks);
  return extractFetchedUrls(chunks.join("\n\n"));
}

function createFetchedBlockRe() {
  return /(?:^|\n)\s*#?\s*Fetched:\s*(?:`([^`]+)`|([^\n]+))([\s\S]*?)(?=\n\s*#?\s*Fetched:\s*(?:`|https?:\/\/)|$)/g;
}

function isWebFetchTool(tool) {
  const name = String(tool?.name || tool?.tool || tool?.type || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return name === "webfetch" || name.endsWith("webfetch");
}

function extractWebFetchTitlesFromCache() {
  const hints = {};
  try {
    const cache = window.zion?.state?.get?.("webfetch.cache") || {};
    for (const item of Object.values(cache || {})) {
      Object.assign(hints, extractWebFetchTitles(item?.md || item?.content || item?.text || ""));
    }
  } catch {}
  return hints;
}

function collectStringLeaves(value, out, depth = 0) {
  if (value == null || depth > 4) return;
  if (typeof value === "string") {
    if (value.includes("Fetched:") && value.includes("Title:")) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) collectStringLeaves(v, out, depth + 1);
  }
}

function makeUrlItem(url, urlTitleCache = {}, titleHints = {}) {
  const normalized = normalizeUrl(url);
  const title = titleHints[normalized] || urlTitleCache[normalized]?.title || "";
  return { url: normalized, title, label: title || hostFromUrl(normalized) || compactMiddle(normalized, 46) };
}

function extractFilesFromTools(tools) {
  const out = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isContextFileTool(tool)) continue;
    if (!isSuccessfulFileTool(tool)) continue;
    const args = normalizeToolArgs(tool?.args);
    const path = getToolFilePath(args);
    if (!path) continue;
    const executionContext = tool?.executionContext && typeof tool.executionContext === "object"
      ? tool.executionContext
      : null;
    out.push({
      path: stripLineSuffix(path),
      source: normalizeContextToolName(tool?.name),
      sourceId: executionContext?.sourceId || inferToolFileSource(args) || "local",
      executionContext
    });
  }
  return out;
}

function isContextFileTool(tool) {
  const name = normalizeContextToolName(tool?.name);
  return name === "read" || name === "fsread" || name === "edit" || name === "fsedit" || name === "write" || name === "fswrite";
}

function isSuccessfulFileTool(tool) {
  const ok = inferFileToolOk(tool);
  return ok === true;
}

function inferFileToolOk(tool) {
  const result = tool?.result;
  if (isKnownFileToolFailure(result)) return false;
  if (typeof tool?.ok === "boolean") return tool.ok;
  if (result == null) return null;
  const name = normalizeContextToolName(tool?.name);
  let obj = null;
  if (result && typeof result === "object") obj = result;
  if (!obj && typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === "object") obj = parsed;
    } catch {}
  }
  if (obj && typeof obj.ok === "boolean") return obj.ok;
  if (obj && typeof obj.success === "boolean") return obj.success;
  if ((name === "edit" || name === "fsedit") && obj && typeof obj.replaced === "number") return obj.replaced > 0;

  const head = String(result ?? "").slice(0, 240).toLowerCase().trim();
  if (!head) return true;
  if ((name === "edit" || name === "fsedit") && head.startsWith("edit ok:")) return true;
  if (head.startsWith("read error:")) return false;
  if (head.startsWith("write error:")) return false;
  if (head.startsWith("edit error:")) return false;
  if (head.startsWith("edit failed:")) return false;
  if (head.startsWith("edit blocked:")) return false;
  if (head.startsWith("write failed:")) return false;
  if (head.startsWith("write blocked:")) return false;
  if (head.startsWith("tool \"") && (head.includes(" failed:") || head.includes(" error:"))) return false;
  if (head.startsWith("missing ") || head.startsWith("invalid args")) return false;
  if (head.includes("permission denied") || head.includes("blocked") || head.includes("aborted")) return false;
  return true;
}

function normalizeContextToolName(name) {
  return String(name || "").trim().toLowerCase();
}

function normalizeToolArgs(args) {
  if (args && typeof args === "object") return args;
  if (typeof args !== "string") return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getToolFilePath(args) {
  for (const key of PATH_ARG_KEYS) {
    const value = args?.[key];
    if (typeof value !== "string") continue;
    const path = cleanPath(value);
    if (path && !isUrlLike(path)) return path;
  }
  return "";
}

function iconButton(icon, title, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "zion-context-icon-button";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.appendChild(createContextIcon(icon, ""));
  btn.onclick = onClick;
  return btn;
}

function dedupeItems(items, keyOf) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyOf(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function isUrlLike(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function cleanPath(value) {
  return String(value || "").trim().replace(/[),.;]+$/, "");
}

function stripLineSuffix(value) {
  return String(value || "").replace(/:\d+(?::\d+)?$/, "");
}

function inferToolFileSource(args) {
  const sessionId = String(args?.session_id || args?.sessionId || "").trim();
  return sessionId ? `terminal:${sessionId}` : "";
}

function inferFileSource(sourceIdHint = "") {
  if (sourceIdHint) return sourceIdHint;
  return "local";
}

function normalizeFileSourceId(sourceId) {
  const id = String(sourceId || "local").trim();
  if (id !== "terminal:active") return id || "local";
  const activeId = String(window.zion?.state?.get?.("terminal.activeSessionId") || "").trim();
  return activeId ? `terminal:${activeId}` : id;
}

function shortId(id) {
  const s = String(id || "");
  return s.length > 10 ? `${s.slice(0, 6)}...${s.slice(-4)}` : s;
}

function compactMiddle(value, max) {
  const s = String(value || "");
  if (s.length <= max) return s;
  const head = Math.max(8, Math.floor(max * 0.55));
  const tail = Math.max(6, max - head - 3);
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
