import { createFilesCodeViewer, ensureRevealSourceForPath, getProvider, iconForFile, languageFromFilename, stableFileTabId } from "./files-panel.js";
import { formatCompactChangeCount, formatChangeSummary, getCurrentSessionChangeState, normalizeChangePath } from "./session-change-state.js";

export const CONTEXT_VIEW_ID = "dev.tools.context";

const I18N_NS = "dev.tools";
const PATH_ARG_KEYS = new Set(["path", "file", "filename", "file_path", "target_file", "absolute_path", "relative_path"]);
const LS_CONTEXT_EXPANDED = "zion.devTools.context.expanded";
const LS_CONTEXT_URL_TITLES = "zion.devTools.context.urlTitles";
const LS_CONTEXT_EXPLORER_WIDTH = "zion.devTools.context.explorerWidth";
const LS_COMMENTS_THREADS = "zion.comments.threads.v1";
const LS_AGENT_TASKS = "zion.agents.tasks.v1";

function t(key, fallback, values) {
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

export function registerContextPanel(ctx) {
  const disposables = [];

  const openCommand = window.zion.commands.registerCommand("tools.openContext", () => {
    try { window.zion.auxiliaryBar?.setWidth?.(Math.max(340, window.zion.state?.get?.("ui.auxiliaryBar.width") || 0)); } catch {}
    try { window.zion.auxiliaryBar?.activateView?.(CONTEXT_VIEW_ID); } catch {}
  });
  disposables.push(openCommand);

  const viewDisposable = window.zion.auxiliaryBar?.registerView?.({
    id: CONTEXT_VIEW_ID,
    pluginId: "dev.tools",
    title: "Context",
    titleKey: "dev.tools.context.title",
    icon: "@",
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
  let activeFileTabId = "";
  let previewCodeView = null;
  let previewObjectUrl = "";
  let explorerWidth = loadContextExplorerWidth();
  const expanded = loadExpandedGroups();
  const urlTitleCache = loadUrlTitleCache();
  const pendingTitleFetches = new Set();
  const openFileTabs = new Map();

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
  watchState("terminal.sessions");
  watchState("terminal.activeSessionId");
  watchState("chat.includeTerminalContext");
  watchState("todo.tasks");
  watchState("todo.activeTaskId");
  watchState("todo.list");
  try { disposables.push(window.zion.events?.on?.("chat/annotationsChanged", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("toolcards/toolsUpdated", scheduleContextRefresh)); } catch {}
  try { disposables.push(window.zion.events?.on?.("chat/toolCall", scheduleContextRefresh)); } catch {}
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
  try { disposables.push(window.zion.events?.on?.("i18n/changed", () => { lastRenderedSignature = ""; scheduleRender(); })); } catch {}
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
  const pollTimer = setInterval(() => {
    const signature = getContextRefreshSignature();
    if (signature === lastRefreshSignature) return;
    lastRefreshSignature = signature;
    scheduleRender();
  }, 700);
  disposables.push({ dispose: () => clearInterval(pollTimer) });

  render();

  return {
    dispose() {
      disposed = true;
      if (renderTimer) window.cancelAnimationFrame(renderTimer);
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
    const snapshot = buildContextSnapshot(urlTitleCache);
    const changeState = getCurrentSessionChangeState();
    prefetchUrlTitles(snapshot.urls, urlTitleCache, pendingTitleFetches, scheduleRender);
    const renderSignature = getSnapshotRenderSignature(snapshot, expanded, changeState);
    const hasPreviewPane = !!root.querySelector(".zion-context-preview-pane");
    if (renderSignature === lastRenderedSignature && previousScroll && hasPreviewPane === (openFileTabs.size > 0)) {
      syncSelectedRow(root, selectedKey);
      return;
    }
    lastRenderedSignature = renderSignature;
    const workspace = document.createElement("div");
    workspace.className = `zion-context-workspace${openFileTabs.size ? " has-preview" : ""}`;
    const scroll = document.createElement("div");
    scroll.className = "zion-context-scroll";
    if (openFileTabs.size) scroll.style.flexBasis = `${explorerWidth}px`;
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
      onOpenFile: openContextFilePreview
    }));
    workspace.appendChild(scroll);
    if (openFileTabs.size) {
      disposePreviewResources();
      workspace.appendChild(renderContextResizeHandle(workspace, scroll));
      workspace.appendChild(renderContextPreviewPane());
    }

    root.replaceChildren(workspace);
    restoreScrollTop(scroll, preservedScrollTop);
    if (!selectedKey || !root.querySelector(`.zion-context-tree-row[data-key="${cssEscape(selectedKey)}"]`)) {
      const firstRow = root.querySelector(".zion-context-tree-row[data-key]");
      selectedKey = firstRow?.dataset?.key || "";
    }
    syncSelectedRow(root, selectedKey);
  }

  async function openContextFilePreview(item) {
    const path = item?.path || item?.label || "";
    if (!path) return;
    const name = displayFileName(path);
    const sourceHint = item.sourceId || inferFileSource();
    const provisionalTabId = `file:pending:${sourceHint}:${path}`;
    const existing = openFileTabs.get(provisionalTabId);
    if (existing) {      activeFileTabId = provisionalTabId;
      renderPreviewOnly();
      return;
    }
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    openFileTabs.set(provisionalTabId, {
      id: provisionalTabId,
      title: name,
      path,
      displayPath: path,
      language: languageFromFilename(name),
      file: { kind: "loading" },
      sourceId: sourceHint,
      token
    });
    activeFileTabId = provisionalTabId;
    renderPreviewOnly();

    let tabId = provisionalTabId;
    try {
      const sourceId = await ensureRevealSourceForPath(path, sourceHint);
      const node = createContextFileNode(path, sourceId, name);
      const resolvedTabId = `file:${stableFileTabId(node)}`;
      const current = openFileTabs.get(provisionalTabId);
      if (!current || current.token !== token) return;
      if (resolvedTabId !== provisionalTabId) {
        openFileTabs.delete(provisionalTabId);
        const resolvedExisting = openFileTabs.get(resolvedTabId);
        if (resolvedExisting) {          activeFileTabId = resolvedTabId;
          renderPreviewOnly();
          return;
        }
      }
      tabId = resolvedTabId;
      openFileTabs.set(tabId, {
        ...current,
        id: tabId,
        sourceId,
        file: { kind: "loading" }
      });
      activeFileTabId = tabId;
      renderPreviewOnly();
      const file = await getProvider(sourceId).readFile(node);
      const latest = openFileTabs.get(tabId);
      if (!latest || latest.token !== token) return;
      openFileTabs.set(tabId, {
        ...latest,
        size: typeof file?.size === "number" ? file.size : latest.size,
        file
      });
      activeFileTabId = tabId;
      renderPreviewOnly();
    } catch (e) {      const current = openFileTabs.get(tabId) || openFileTabs.get(provisionalTabId);
      if (!current || current.token !== token) return;
      openFileTabs.set(current.id || tabId, {
        ...current,
        file: { kind: "error", message: e?.message || String(e || "Failed to open file") }
      });
      activeFileTabId = current.id || tabId;
      renderPreviewOnly();
    }
  }

  function createContextFileNode(path, sourceId, name = displayFileName(path)) {
    return {
      key: `context:${sourceId}:${path}`,
      sourceId,
      provider: sourceId.startsWith("terminal:") ? "terminal" : "local",
      kind: "file",
      name,
      path,
      displayPath: path
    };
  }

  function renderPreviewOnly() {
    const existing = root.querySelector(".zion-context-preview-pane");
    if (!openFileTabs.size) {
      if (existing) {
        disposePreviewResources();
        existing.remove();
      }
      root.querySelector(".zion-context-workspace")?.classList.remove("has-preview");
      return;
    }
    if (existing) {
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
        explorerWidth = Math.round(next);
        explorer.style.flexBasis = `${explorerWidth}px`;
      };
      const stop = () => {
        root.classList.remove("is-resizing-context");
        saveContextExplorerWidth(explorerWidth);
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
        activeFileTabId = tab.id;
        renderPreviewOnly();
      };
      const icon = document.createElement("span");
      icon.className = `zion-files-preview-tab-icon codicon ${iconForFile(tab.title)}`;
      const label = document.createElement("span");
      label.className = "zion-files-preview-tab-label";
      label.textContent = tab.title;
      const close = document.createElement("span");
      close.className = "zion-files-preview-tab-close codicon codicon-close";
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
      pane.appendChild(renderContextPreviewHeader(tab));
      const content = document.createElement("div");
      content.className = "zion-files-preview-content";
      renderContextFileTabContent(content, tab);
      pane.appendChild(content);
    }
    return pane;
  }

  function renderContextPreviewHeader(tab) {
    const header = document.createElement("div");
    header.className = "zion-files-preview-header";
    const icon = document.createElement("span");
    icon.className = `zion-files-preview-header-icon codicon ${iconForFile(tab.title)}`;
    const title = document.createElement("div");
    title.className = "zion-files-preview-breadcrumb";
    title.title = tab.displayPath || tab.path || tab.title;
    title.textContent = compactMiddle(tab.displayPath || tab.path || tab.title, 72);
    const meta = document.createElement("div");
    meta.className = "zion-files-preview-meta";
    meta.textContent = [typeof tab.size === "number" ? formatBytes(tab.size) : "", tab.language && tab.language !== "text" ? tab.language : ""].filter(Boolean).join(" · ");
    header.appendChild(icon);
    header.appendChild(title);
    if (meta.textContent) header.appendChild(meta);
    return header;
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
      const codeHost = document.createElement("div");
      codeHost.className = "zion-files-preview-code-host";
      parent.appendChild(codeHost);
      previewCodeView = createFilesCodeViewer(codeHost, String(tab.file.content || ""), tab);
      return;
    }
    parent.appendChild(renderContextPreviewMessage("Binary preview is not supported yet"));
  }

  function renderContextPreviewMessage(message) {
    const el = document.createElement("div");
    el.className = "zion-files-preview-empty";
    el.textContent = message;
    return el;
  }

  function closeContextFileTab(tabId) {
    openFileTabs.delete(tabId);
    if (activeFileTabId === tabId) activeFileTabId = Array.from(openFileTabs.keys()).pop() || "";
    renderPreviewOnly();
  }

  function disposePreviewResources() {
    try { previewCodeView?.destroy?.(); } catch {}
    previewCodeView = null;
    if (previewObjectUrl) {
      try { URL.revokeObjectURL(previewObjectUrl); } catch {}
      previewObjectUrl = "";
    }
  }
}

function buildContextSnapshot(urlTitleCache = {}) {
  const sessionId = getCurrentSessionId();
  const editorText = getActiveEditorText();
  const tools = getCurrentTools(sessionId);
  const urlTitleHints = collectWebFetchTitleHints(editorText, tools);
  mergeUrlTitleHints(urlTitleCache, urlTitleHints);
  const files = dedupeItems(extractFilesFromTools(tools), (item) => `${item.sourceId || ""}:${item.path || item.label}`);
  const urls = extractWebFetchUrls(editorText, tools, urlTitleCache, urlTitleHints);
  const terminalSessions = Array.isArray(window.zion?.state?.get?.("terminal.sessions")) ? window.zion.state.get("terminal.sessions") : [];
  const activeTerminalId = window.zion?.state?.get?.("terminal.activeSessionId") || "";
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
  const basics = [
    { label: t("context.session", "Session"), value: sessionId ? shortId(sessionId) : t("context.noSession", "No open session") },
    { label: t("context.terminalContext", "Terminal Context"), value: includeTerminal ? t("context.terminalInjected", "Injected into chat") : t("context.terminalNotInjected", "Not injected into chat") },
    { label: t("context.terminalSessions", "Terminal Sessions"), value: `${t("context.count", "{count}", { count: terminalSessions.length })}${activeTerminalId ? ` · ${t("context.terminalActive", "active {id}", { id: shortId(activeTerminalId) })}` : ""}` },
    { label: t("context.toolArtifacts", "Tool Artifacts"), value: t("context.itemCount", "{count}", { count: tools.length }) }
  ];
  return { sessionId, files, urls, basics, usage, tasks, activeTaskId, taskSummary, comments, commentSummary, agentTasks, agentSummary };
}

function getSnapshotRenderSignature(snapshot, expanded, changeState) {
  return stableStringify({
    files: (snapshot.files || []).map((item) => [item.path || "", item.sourceId || "", item.source || ""]),
    urls: (snapshot.urls || []).map((item) => [item.url || "", item.title || "", item.label || ""]),
    basics: (snapshot.basics || []).map((item) => [item.label || "", item.value || ""]),
    usage: compactUsageSignature(snapshot.usage),
    tasks: compactTaskSignature(snapshot.taskSummary, snapshot.tasks, snapshot.activeTaskId),
    comments: compactCommentSignature(snapshot.commentSummary, snapshot.comments),
    agents: compactAgentTaskSignature(snapshot.agentSummary, snapshot.agentTasks),
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

function buildFileTreeModel(files) {
  const rawEntries = files.map((item, index) => {
    const fullPath = normalizeTreePath(item.path || item.label || "");
    const parts = splitTreePath(fullPath);
    const sourceId = normalizeFileSourceId(item.sourceId || inferFileSource());
    const deviceKey = getFileDeviceKey(sourceId);
    return { item: { ...item, sourceId }, index, fullPath, parts, sourceId, deviceKey };
  }).filter((entry) => entry.fullPath && entry.parts.length);
  const entries = dedupeItems(rawEntries, (entry) => `${entry.deviceKey}:${entry.fullPath}`);
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
      count: entries.length,
      meta: formatFileRootMeta(entries, commonPath),
      children: roots
    }];
  }
  return roots;
}

function createFileTreeRoot(sourceId, commonParts) {
  const commonPath = formatTreePath(commonParts, []);
  return { kind: "folder", name: "", fullPath: commonPath, key: `files:root:${sourceId}`, childrenMap: new Map(), count: 0 };
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
      node.childrenMap.set(`file:${entry.index}:${fullPath}`, {
        kind: "file",
        name,
        fullPath,
        key: `${entry.item.sourceId || ""}:${entry.fullPath || fullPath}`,
        item: entry.item
      });
      continue;
    }
    const key = `folder:${entry.sourceId}:${fullPath}`;
    if (!node.childrenMap.has(key)) {
      node.childrenMap.set(key, { kind: "folder", name, fullPath, key, childrenMap: new Map(), count: 0 });
    }
    node = node.childrenMap.get(key);
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
  const id = String(sourceId || "local");
  if (id === "local") return "local";
  const session = getTerminalSessionForSource(id);
  const type = String(session?.type || "").trim().toLowerCase();
  const host = String(session?.ssh_host || session?.host || session?.hostname || session?.remote_host || "").trim();
  const user = String(session?.ssh_user || session?.user || session?.username || "").trim();
  const port = String(session?.ssh_port || session?.port || "").trim();
  if (type === "ssh" || host) return `ssh:${user}@${host}:${port || "22"}`;
  return `terminal:${String(session?.type || "local").trim() || "local"}`;
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

function renderFileNode(node, depth, state) {
  if (node.kind === "file") return [renderFileTreeRow(node.item, node.key, node.name, depth, state)];
  if (state.defaultExpandFolders && !state.expanded.has(node.key)) state.expanded.add(node.key);
  const isExpanded = state.expanded.has(node.key) || state.defaultExpandFolders;
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
    onSelect: state.onSelect
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
    actionTitle: t("context.openInFiles", "Reveal and open in Files"),
    onAction: () => openFileInExplorer(item, { open: true }),
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
      try { window.open(item.url, "_blank", "noopener,noreferrer"); } catch {}
    },
    onSelect: state.onSelect,
    actionIcon: "codicon-link-external",
    actionTitle: t("context.openUrl", "Open webpage"),
    onAction: () => {
      try { window.open(item.url, "_blank", "noopener,noreferrer"); } catch {}
    },
    secondaryActionIcon: "codicon-copy",
    secondaryActionTitle: t("context.copyUrl", "Copy link"),
    onSecondaryAction: () => copyText(item.url || "")
  });
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

function getCommentsForSession(sessionId) {
  const sid = String(sessionId || "global");
  try {
    const raw = localStorage.getItem(LS_COMMENTS_THREADS);
    const parsed = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    return list
      .filter((item) => String(item?.sessionId || "global") === sid)
      .sort((a, b) => commentOrder(a) - commentOrder(b) || (Number(a?.createdAt || 0) - Number(b?.createdAt || 0)));
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

  const main = document.createElement("button");
  main.className = "zion-context-tree-main";
  main.type = "button";
  main.tabIndex = selected ? 0 : -1;
  main.onclick = () => {
    onSelect?.(key || "");
    onClick?.();
  };
  main.onkeydown = (event) => handleTreeRowKeydown(event, row, { key, onClick, onSelect });

  const chevron = document.createElement("span");
  chevron.className = `zion-context-tree-chevron codicon ${expanded == null ? "" : expanded ? "codicon-chevron-down" : "codicon-chevron-right"}`;
  chevron.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "zion-context-tree-label";
  text.textContent = label || "";
  main.appendChild(chevron);
  if (icon) {
    const iconEl = document.createElement("span");
    iconEl.className = `zion-context-tree-icon codicon ${icon}`;
    iconEl.setAttribute("aria-hidden", "true");
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

function openFileInExplorer(item, options = {}) {
  const path = item?.path || item?.label || "";
  if (!path) return;
  try {
    window.showToast?.(t("context.openingFiles", "Opening Files and locating file..."));
    window.zion.commands?.executeCommand?.("tools.files.revealPath", {
      path,
      sourceId: item.sourceId || inferFileSource(),
      open: options.open !== false
    });
  } catch {}
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

function loadContextExplorerWidth() {
  try {
    const n = Number(localStorage.getItem(LS_CONTEXT_EXPLORER_WIDTH) || "");
    return Number.isFinite(n) && n >= 160 ? n : 300;
  } catch {
    return 300;
  }
}

function saveContextExplorerWidth(width) {
  try {
    localStorage.setItem(LS_CONTEXT_EXPLORER_WIDTH, String(Math.round(Number(width) || 300)));
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

function getCurrentSessionId() {
  try {
    const panelId = window.zion?.panels?.getActivePanelId?.() || null;
    const panel = (window.zion?.panels?.list?.() || []).find((p) => p?.id === panelId);
    return panel?.activeTabId || window.zion?.state?.get?.("sessions.currentId") || null;
  } catch {
    return window.zion?.state?.get?.("sessions.currentId") || null;
  }
}

function getActiveEditorText() {
  try {
    const editor = window.zion?.window?.activeEditor;
    if (editor?.getValue) return String(editor.getValue() || "");
  } catch {}
  return "";
}

function getContextRefreshSignature() {
  const sessionId = getCurrentSessionId() || "";
  const text = getActiveEditorText();
  const tools = getCurrentTools(sessionId);
  const textTail = text.length > 6000 ? text.slice(-6000) : text;
  const toolSig = tools.map((tool) => [
    tool?.id || tool?.toolCallId || "",
    tool?.name || "",
    stableStringify(tool?.args),
    stableStringify(tool?.result),
    tool?.ok
  ].join(":")).join("|");
  return `${sessionId}:${text.length}:${textTail}:${toolSig}`;
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
    out.push({
      path: stripLineSuffix(path),
      source: normalizeContextToolName(tool?.name),
      sourceId: inferToolFileSource(args) || "local"
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
  if (typeof tool?.ok === "boolean") return tool.ok;
  const result = tool?.result;
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
  const span = document.createElement("span");
  span.className = `codicon ${icon}`;
  btn.appendChild(span);
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
