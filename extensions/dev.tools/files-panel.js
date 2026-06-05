import { EditorState, Prec, StateEffect } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { foldGutter, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { tags as cmTags } from "@lezer/highlight";

export const FILES_VIEW_ID = "dev.tools.files";

const I18N_NS = "dev.tools";
const LS_EXPANDED = "zion.devTools.files.expanded";
const LS_SORT = "zion.devTools.files.sort";
const LS_SOURCE = "zion.devTools.files.source";
const LS_EXPLORER_WIDTH = "zion.devTools.files.explorerWidth";
const LS_TREE_CACHE_PREFIX = "zion.devTools.files.treeCache.";
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
const TERMINAL_READ_CHUNK_BYTES = 12 * 1024;
const SORT_OPTIONS = ["name", "modified", "size"];
const PREFETCH_MAX_DIRS_PER_BATCH = 8;
const PREFETCH_MAX_CONCURRENCY = 2;
const PREFETCH_DEPTH = 1;
const TREE_CACHE_MAX_DIRS = 120;

let pendingRevealCommandPayload = null;
const TREE_CACHE_MAX_CHILDREN_PER_DIR = 400;

const IGNORE_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage"
]);

export function registerFilesPanel(ctx) {
  const disposables = [];

  const openCommand = window.zion.commands.registerCommand("tools.openFiles", () => {
    try { window.zion.auxiliaryBar?.setWidth?.(Math.max(360, window.zion.state?.get?.("ui.auxiliaryBar.width") || 0)); } catch {}
    try { window.zion.auxiliaryBar?.activateView?.(FILES_VIEW_ID); } catch {}
  });
  disposables.push(openCommand);

  const addFolderCommand = window.zion.commands.registerCommand("tools.files.addFolder", async () => {
    try { window.zion.auxiliaryBar?.setWidth?.(Math.max(360, window.zion.state?.get?.("ui.auxiliaryBar.width") || 0)); } catch {}
    try { window.zion.auxiliaryBar?.activateView?.(FILES_VIEW_ID); } catch {}
    await window.zion.commands?.executeCommand?.("fs.addFolder");
  });
  disposables.push(addFolderCommand);

  const openFilesPickerCommand = window.zion.commands.registerCommand("tools.files.open", () => {
    try { window.zion.commands?.executeCommand?.("commandPalette.openFilesPicker"); } catch {}
  });
  disposables.push(openFilesPickerCommand);

  const openSourceCommand = window.zion.commands.registerCommand("tools.files.openSource", (nextSourceId) => {
    const resolved = resolveSourceId(nextSourceId);
    saveSourceId(resolved);
    try { window.zion.auxiliaryBar?.setWidth?.(Math.max(360, window.zion.state?.get?.("ui.auxiliaryBar.width") || 0)); } catch {}
    try { window.zion.auxiliaryBar?.activateView?.(FILES_VIEW_ID); } catch {}
    try { window.zion.events?.emit?.("dev.tools.files/sourceChanged", { sourceId: resolved }); } catch {}
  });
  disposables.push(openSourceCommand);

  const revealPathCommand = window.zion.commands.registerCommand("tools.files.revealPath", async (payload = {}) => {
    const path = typeof payload === "string" ? payload : payload?.path;
    const sourceId = typeof payload === "object" ? payload?.sourceId : "";
    const open = typeof payload === "object" ? payload?.open !== false : true;
    try { window.zion.auxiliaryBar?.setWidth?.(Math.max(360, window.zion.state?.get?.("ui.auxiliaryBar.width") || 0)); } catch {}
    try { window.zion.auxiliaryBar?.activateView?.(FILES_VIEW_ID); } catch {}
    try { window.zion.events?.emit?.("dev.tools.files/revealStatus", { message: t("files.revealPreparing", "Preparing project and locating file...") }); } catch {}
    try { window.showToast?.(t("files.revealPreparing", "Preparing project and locating file...")); } catch {}
    const resolved = await ensureRevealSourceForPath(path, sourceId);
    saveSourceId(resolved);
    const revealPayload = { path, sourceId: resolved, open };
    pendingRevealCommandPayload = revealPayload;
    try { window.zion.events?.emit?.("dev.tools.files/revealPath", revealPayload); } catch {}
  });
  disposables.push(revealPathCommand);

  const viewDisposable = window.zion.auxiliaryBar?.registerView?.({
    id: FILES_VIEW_ID,
    pluginId: "dev.tools",
    title: "Files",
    titleKey: "dev.tools.files.title",
    icon: "◇",
    order: 10,
    keepWhenActive: true,
    component: {
      render: (container) => createFilesPanel(container)
    }
  });
  if (viewDisposable) disposables.push(viewDisposable);

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

function createFilesPanel(container) {
  const root = document.createElement("div");
  root.className = "zion-files-panel";
  container.appendChild(root);

  const expanded = loadExpanded();
  const dirCache = new Map();
  const loadingKeys = new Set();
  const loadingRenderTimers = new Map();
  const prefetchingKeys = new Set();
  const prefetchPromises = new Map();
  const prefetchQueue = [];
  const failedKeys = new Map();
  const openFileTabs = new Map();
  const disposables = [];

  let roots = [];
  let selectedKey = "";
  let sortBy = loadSort();
  let sourceId = loadSourceId();
  let disposed = false;
  let renderTimer = 0;
  let rootsLoading = false;
  let rootsError = "";
  let refreshSeq = 0;
  let prefetchSeq = 0;
  let prefetchTimer = 0;
  let activePrefetchCount = 0;
  let activeFileTabId = "";
  let previewCodeView = null;
  let previewObjectUrl = "";
  let explorerWidth = loadExplorerWidth();
  let lastTerminalSessionIds = terminalSessionIdsSignature();
  let lastActiveTerminalSessionId = getActiveTerminalSessionId();
  let revealStatus = "";
  let hydratedFromTreeCache = false;
  let saveTreeCacheTimer = 0;
  let refreshExpandedTimer = 0;
  let contextMenuEl = null;
  let pendingReveal = null;

  const scheduleRender = () => {
    if (disposed) return;
    if (renderTimer) window.cancelAnimationFrame(renderTimer);
    renderTimer = requestAnimationFrame(() => {
      renderTimer = 0;
      render();
    });
  };

  try { disposables.push(window.zion.state.onDidChange("fs.allowed", () => refreshRoots({ keepCache: true }))); } catch {}
  try { disposables.push(window.zion.state.onDidChange("terminal.sessions", () => handleTerminalSessionsChanged())); } catch {}
  try { disposables.push(window.zion.state.onDidChange("terminal.activeSessionId", () => {
    const nextActive = getActiveTerminalSessionId();
    const changed = nextActive !== lastActiveTerminalSessionId;
    lastActiveTerminalSessionId = nextActive;
    if (sourceId === "terminal:active" && changed) refreshRoots({ keepCache: false, preserveSource: true });
    else scheduleRender();
  })); } catch {}
  try { disposables.push(window.zion.events.on("dev.tools.files/sourceChanged", (payload) => {
    const next = resolveSourceId(payload?.sourceId || "local");
    if (next === sourceId) {
      refreshRoots({ keepCache: false, preserveSource: true });
      return;
    }
    sourceId = next;
    selectedKey = "";
    refreshRoots({ keepCache: false, preserveSource: true });
  })); } catch {}
  try { disposables.push(window.zion.events.on("dev.tools.files/revealPath", async (payload) => {
    const rawPath = String(payload?.path || "").trim();
    if (!rawPath) return;
    pendingRevealCommandPayload = null;
    const nextSource = await ensureRevealSourceForPath(rawPath, payload?.sourceId || "");
    revealStatus = t("files.revealLoading", "Loading project and locating file...");
    pendingReveal = {
      path: stripLineSuffix(rawPath),
      sourceId: nextSource,
      open: payload?.open !== false
    };
    sourceId = nextSource;
    selectedKey = "";
    refreshRoots({ keepCache: false, preserveSource: true }).then(() => processPendingReveal());
  })); } catch {}
  try { disposables.push(window.zion.events.on("dev.tools.files/revealStatus", (payload) => {
    revealStatus = String(payload?.message || "").trim();
    scheduleRender();
  })); } catch {}
  try { disposables.push(window.zion.events.on("i18n/changed", scheduleRender)); } catch {}

  setTimeout(() => {
    if (disposed || !pendingRevealCommandPayload) return;
    const payload = pendingRevealCommandPayload;
    try { window.zion.events?.emit?.("dev.tools.files/revealPath", payload); } catch {}
  }, 0);

  hydratedFromTreeCache = hydrateTreeCache();
  refreshRoots({ keepCache: hydratedFromTreeCache, background: hydratedFromTreeCache });

  return {
    dispose() {
      disposed = true;
      if (renderTimer) window.cancelAnimationFrame(renderTimer);
      for (const timer of loadingRenderTimers.values()) window.clearTimeout(timer);
      loadingRenderTimers.clear();
      if (prefetchTimer) window.clearTimeout(prefetchTimer);
      prefetchTimer = 0;
      if (saveTreeCacheTimer) window.clearTimeout(saveTreeCacheTimer);
      saveTreeCacheTimer = 0;
      if (refreshExpandedTimer) window.clearTimeout(refreshExpandedTimer);
      refreshExpandedTimer = 0;
      closeContextMenu();
      prefetchQueue.length = 0;
      prefetchingKeys.clear();
      prefetchPromises.clear();
      disposePreviewResources();
      for (const tab of openFileTabs.values()) disposeFileTabResources(tab);
      openFileTabs.clear();
      for (const d of disposables.splice(0)) {
        try { d?.dispose?.(); } catch {}
      }
      try { root.remove(); } catch {}
    }
  };

  async function refreshRoots(opts = {}) {
    const seq = ++refreshSeq;
    const background = !!opts.background && roots.length > 0;
    rootsLoading = !background;
    rootsError = "";
    sourceId = resolveSourceId(sourceId);
    if (!opts.preserveSource) saveSourceId(sourceId);
    if (!opts.keepCache && !background) {
      dirCache.clear();
      failedKeys.clear();
      resetPrefetch();
    }
    if (!background) scheduleRender();
    try {
      const provider = getProvider(sourceId);
      const nextRoots = await provider.listRoots();
      if (seq !== refreshSeq || disposed) return;
      roots = nextRoots;
      if (selectedKey && !roots.some((item) => isNodeWithinRootKey(selectedKey, item))) {
        selectedKey = "";
      }
      saveTreeCacheSoon();
      scheduleDirectoryPrefetch(roots, PREFETCH_DEPTH);
      refreshExpandedDirectoriesSoon();
      processPendingReveal();
    } catch (e) {
      if (seq !== refreshSeq || disposed) return;
      if (!background) roots = [];
      rootsError = e?.message || String(e || "");    } finally {
      if (seq !== refreshSeq || disposed) return;
      rootsLoading = false;
      scheduleRender();
    }
  }

  function handleTerminalSessionsChanged() {
    const nextIds = terminalSessionIdsSignature();
    const structuralChange = nextIds !== lastTerminalSessionIds;
    lastTerminalSessionIds = nextIds;

    if (!sourceId.startsWith("terminal:")) {
      if (structuralChange) scheduleRender();
      return;
    }

    const concreteSessionId = getSourceConcreteSessionId(sourceId);
    const stillExists = !concreteSessionId || getTerminalSessions().some((session) => String(session?.id || "") === concreteSessionId);
    if (structuralChange || !stillExists) {
      refreshRoots({ keepCache: !structuralChange && stillExists, preserveSource: true });
      return;
    }

    // terminal.executeCommand syncs cwd back into terminal.sessions. That should not
    // reset or repaint the file tree while a directory expansion is in flight.
  }

  function hydrateTreeCache() {
    const snapshot = loadTreeCache(sourceId);
    if (!snapshot?.roots?.length) return false;
    roots = snapshot.roots.map(markCachedNode).filter(Boolean);
    dirCache.clear();
    for (const [key, children] of Object.entries(snapshot.dirs || {})) {
      if (!Array.isArray(children)) continue;
      dirCache.set(key, children.map(markCachedNode).filter(Boolean));
    }
    rootsError = "";
    rootsLoading = false;
    scheduleRender();
    return true;
  }

  function saveTreeCacheSoon() {
    if (disposed) return;
    if (saveTreeCacheTimer) window.clearTimeout(saveTreeCacheTimer);
    saveTreeCacheTimer = window.setTimeout(() => {
      saveTreeCacheTimer = 0;
      saveTreeCache(sourceId, roots, dirCache);
    }, 180);
  }

  function refreshExpandedDirectoriesSoon() {
    if (disposed || refreshExpandedTimer) return;
    refreshExpandedTimer = window.setTimeout(() => {
      refreshExpandedTimer = 0;
      refreshExpandedDirectories();
    }, 80);
  }

  async function refreshExpandedDirectories() {
    const provider = getProvider(sourceId);
    const queue = sortNodes(roots, sortBy).filter((node) => expanded.has(node.key));
    const seen = new Set();
    while (queue.length && !disposed) {
      const node = queue.shift();
      if (!node || node.kind !== "directory" || seen.has(node.key)) continue;
      seen.add(node.key);
      try {
        const children = (await provider.listChildren(node)).filter(Boolean);
        const changed = !sameNodeList(dirCache.get(node.key), children);
        dirCache.set(node.key, children);
        failedKeys.delete(node.key);
        saveTreeCacheSoon();
        if (changed) {
          if (findRowByKey(node.key)) insertDirectoryChildren(node);
          else scheduleRender();
        }
        for (const child of sortNodes(children, sortBy)) {
          if (child.kind === "directory" && expanded.has(child.key)) queue.push(child);
        }
      } catch (e) {
        failedKeys.set(node.key, e?.message || String(e || ""));
        if (findRowByKey(node.key)) insertDirectoryChildren(node);
      }
    }
  }

  function render() {
    const previousScrollTop = root.querySelector(".zion-files-scroll")?.scrollTop || 0;
    const body = document.createElement("div");
    body.className = "zion-files-scroll";
    const mount = () => {
      const workspace = document.createElement("div");
      workspace.className = `zion-files-workspace${openFileTabs.size ? " has-preview" : ""}`;
      const explorer = document.createElement("div");
      explorer.className = "zion-files-explorer";
      if (openFileTabs.size) explorer.style.flexBasis = `${explorerWidth}px`;
      explorer.appendChild(renderSourceBar());
      explorer.appendChild(body);
      workspace.appendChild(explorer);
      disposePreviewResources();
      if (openFileTabs.size) {
        workspace.appendChild(renderResizeHandle(workspace, explorer));
        workspace.appendChild(renderPreviewPane());
      }
      root.replaceChildren(workspace);
    };
    const restoreScroll = () => {
      if (!previousScrollTop) return;
      requestAnimationFrame(() => {
        if (disposed || !body.isConnected) return;
        body.scrollTop = previousScrollTop;
      });
    };

    if (rootsError) {
      body.appendChild(renderEmptyState(
        t("files.errorTitle", "Unable to load files"),
        rootsError,
        [{ label: t("files.retry", "Retry"), action: () => refreshRoots() }]
      ));
      mount();
      restoreScroll();
      return;
    }

    if (rootsLoading && roots.length === 0) {
      body.appendChild(renderEmptyState(t("files.loading", "Loading files..."), "", []));
      mount();
      restoreScroll();
      return;
    }

    if (roots.length === 0) {
      const provider = getProvider(sourceId);
      body.appendChild(renderEmptyState(
        provider.emptyTitle(),
        provider.emptyDescription(),
        provider.emptyActions()
      ));
      mount();
      restoreScroll();
      return;
    }

    const tree = document.createElement("div");
    tree.className = "zion-files-tree";
    tree.setAttribute("role", "tree");
    body.appendChild(tree);

    for (const item of sortNodes(roots, sortBy)) {
      renderNode(tree, item, 0);
    }
    mount();
    restoreScroll();
  }

  function renderPreviewPane() {
    const pane = document.createElement("div");
    pane.className = "zion-files-preview-pane";

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
      item.onauxclick = (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        closeFileTab(tab.id);
      };
      const icon = document.createElement("span");
      icon.className = `zion-files-preview-tab-icon codicon ${iconForFile(tab.title)}`;
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "zion-files-preview-tab-label";
      label.textContent = tab.title;
      const close = document.createElement("span");
      close.className = "zion-files-preview-tab-close codicon codicon-close";
      close.setAttribute("aria-hidden", "true");
      close.title = t("files.close", "Close");
      close.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeFileTab(tab.id);
      };
      item.appendChild(icon);
      item.appendChild(label);
      item.appendChild(close);
      tabs.appendChild(item);
    }
    pane.appendChild(tabs);

    const content = document.createElement("div");
    content.className = "zion-files-preview-content";
    const tab = openFileTabs.get(activeFileTabId) || openFileTabs.values().next().value;
    if (tab) {
      activeFileTabId = tab.id;
      pane.appendChild(renderPreviewHeader(tab));
      renderFileTabContent(content, tab);
    } else {
      content.appendChild(renderEmptyState(t("files.noPreview", "No file open"), "", []));
    }
    pane.appendChild(content);
    scrollActiveFileTabIntoView();
    return pane;
  }

  function renderResizeHandle(workspace, explorer) {
    const handle = document.createElement("div");
    handle.className = "zion-files-split-resizer";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.title = t("files.resizeExplorer", "Resize Explorer");
    handle.onpointerdown = (event) => {
      event.preventDefault();
      const pointerId = event.pointerId;
      try { handle.setPointerCapture(pointerId); } catch {}
      root.classList.add("is-resizing-files");
      const move = (moveEvent) => {
        const rect = workspace.getBoundingClientRect();
        const max = Math.max(220, rect.width - 260);
        const next = Math.max(180, Math.min(max, moveEvent.clientX - rect.left));
        explorerWidth = Math.round(next);
        explorer.style.flexBasis = `${explorerWidth}px`;
      };
      const stop = () => {
        root.classList.remove("is-resizing-files");
        saveExplorerWidth(explorerWidth);
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

  function renderPreviewHeader(tab) {
    const header = document.createElement("div");
    header.className = "zion-files-preview-header";
    const icon = document.createElement("span");
    icon.className = `zion-files-preview-header-icon codicon ${iconForFile(tab.title)}`;
    icon.setAttribute("aria-hidden", "true");
    const title = renderBreadcrumb(tab.displayPath || tab.path || tab.title);
    const meta = document.createElement("div");
    meta.className = "zion-files-preview-meta";
    const parts = [];
    if (typeof tab.size === "number") parts.push(formatBytes(tab.size));
    if (tab.language && tab.language !== "text") parts.push(tab.language);
    meta.textContent = parts.join(" · ");
    header.appendChild(icon);
    header.appendChild(title);
    if (meta.textContent) header.appendChild(meta);
    return header;
  }

  function renderBreadcrumb(path) {
    const wrap = document.createElement("div");
    wrap.className = "zion-files-preview-breadcrumb";
    wrap.title = path;
    const parts = String(path || "").split(/[\\/]+/).filter(Boolean);
    const visible = parts.length ? parts.slice(-4) : [String(path || "")];
    if (parts.length > visible.length) {
      const ellipsis = document.createElement("span");
      ellipsis.className = "zion-files-preview-breadcrumb-segment is-muted";
      ellipsis.textContent = "...";
      wrap.appendChild(ellipsis);
      wrap.appendChild(renderBreadcrumbSeparator());
    }
    visible.forEach((part, index) => {
      const seg = document.createElement("span");
      seg.className = `zion-files-preview-breadcrumb-segment${index === visible.length - 1 ? " is-current" : ""}`;
      seg.textContent = part;
      wrap.appendChild(seg);
      if (index < visible.length - 1) wrap.appendChild(renderBreadcrumbSeparator());
    });
    return wrap;
  }

  function renderBreadcrumbSeparator() {
    const sep = document.createElement("span");
    sep.className = "zion-files-preview-breadcrumb-separator codicon codicon-chevron-right";
    sep.setAttribute("aria-hidden", "true");
    return sep;
  }

  function renderPreviewOnly() {
    const existing = root.querySelector(".zion-files-preview-pane");
    if (!existing) {
      showPreviewPaneIncremental();
      return;
    }
    disposePreviewResources();
    existing.replaceWith(renderPreviewPane());
  }

  function scrollActiveFileTabIntoView() {
    const tabId = activeFileTabId;
    if (!tabId) return;
    requestAnimationFrame(() => {
      if (disposed) return;
      const activeTab = root.querySelector(`.zion-files-preview-tab[data-tab-id="${cssEscape(tabId)}"]`);
      try { activeTab?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); } catch {}
    });
  }

  function showPreviewPaneIncremental() {
    const workspace = root.querySelector(".zion-files-workspace");
    const explorer = root.querySelector(".zion-files-explorer");
    if (!workspace || !explorer) {
      scheduleRender();
      return;
    }
    workspace.classList.add("has-preview");
    explorer.style.flexBasis = `${explorerWidth}px`;
    disposePreviewResources();
    workspace.appendChild(renderResizeHandle(workspace, explorer));
    workspace.appendChild(renderPreviewPane());
  }

  function renderFileTabContent(parent, tab) {
    if (tab.file?.kind === "loading") {
      parent.appendChild(renderPreviewMessage(t("files.opening", "Opening file...")));
      return;
    }
    if (tab.file?.kind === "error") {
      parent.appendChild(renderPreviewMessage(tab.file.message || t("files.openFailed", "Failed to open file")));
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
    const empty = document.createElement("div");
    empty.className = "zion-files-preview-empty";
    empty.textContent = t("files.binaryUnsupported", "Binary preview is not supported yet");
    parent.appendChild(empty);
  }

  function renderPreviewMessage(message) {
    const el = document.createElement("div");
    el.className = "zion-files-preview-empty";
    el.textContent = message;
    return el;
  }

  function closeFileTab(tabId) {
    const tab = openFileTabs.get(tabId);
    if (tab) disposeFileTabResources(tab);
    openFileTabs.delete(tabId);
    if (activeFileTabId === tabId) {
      activeFileTabId = Array.from(openFileTabs.keys()).pop() || "";
    }
    if (openFileTabs.size) renderPreviewOnly();
    else scheduleRender();
  }

  function disposePreviewResources() {
    try { previewCodeView?.destroy?.(); } catch {}
    previewCodeView = null;
    try { if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl); } catch {}
    previewObjectUrl = "";
  }

  function disposeFileTabResources(tab) {
    try { if (tab?.objectUrl) URL.revokeObjectURL(tab.objectUrl); } catch {}
  }

  function renderSourceBar() {
    const header = document.createElement("div");
    header.className = "zion-files-source-bar";
    const source = document.createElement("select");
    source.className = "zion-files-source-select";
    source.title = t("files.source", "Source");
    for (const option of buildSourceOptions()) {
      const opt = document.createElement("option");
      opt.value = option.id;
      opt.textContent = option.label;
      opt.title = option.title || option.label;
      opt.selected = option.id === sourceId;
      source.appendChild(opt);
    }
    source.onchange = () => {
      sourceId = resolveSourceId(source.value || "local");
      saveSourceId(sourceId);
      selectedKey = "";
      refreshRoots({ keepCache: false, preserveSource: true });
    };

    header.appendChild(source);
    if (revealStatus) {
      const status = document.createElement("div");
      status.className = "zion-files-reveal-status";
      const spinner = document.createElement("span");
      spinner.className = "zion-files-reveal-spinner codicon codicon-loading";
      spinner.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.textContent = revealStatus;
      status.appendChild(spinner);
      status.appendChild(text);
      header.appendChild(status);
    }
    return header;
  }

  function renderNode(parent, node, depth) {
    const isDirectory = node.kind === "directory";
    const isExpanded = expanded.has(node.key);
    const isLoading = loadingKeys.has(node.key);
    const error = failedKeys.get(node.key);

    const row = document.createElement("div");
    row.className = `zion-files-row${selectedKey === node.key ? " is-active" : ""}${isDirectory ? " is-directory" : " is-file"}`;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-selected", selectedKey === node.key ? "true" : "false");
    if (isDirectory) row.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    row.tabIndex = 0;
    row.dataset.key = node.key;
    row.dataset.depth = String(depth);
    row.style.setProperty("--depth", String(depth));
    row.title = node.displayPath || node.name;

    const main = document.createElement("button");
    main.type = "button";
    main.className = "zion-files-row-main";
    main.onclick = () => {
      if (node.kind === "file") openFile(node);
      else selectOrToggle(node);
    };
    main.ondblclick = (e) => {
      e.preventDefault();
      if (node.kind === "directory") toggleDirectory(node);
    };

    const chevron = document.createElement("span");
    chevron.className = `zion-files-chevron${isDirectory ? ` codicon ${isExpanded ? "codicon-chevron-down" : "codicon-chevron-right"}` : ""}`;
    chevron.setAttribute("aria-hidden", "true");

    const icon = document.createElement("span");
    icon.className = `zion-files-icon codicon ${isDirectory ? (isExpanded ? "codicon-folder-opened" : "codicon-folder") : iconForFile(node.name)}`;
    icon.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "zion-files-name";
    label.textContent = node.name;

    main.appendChild(chevron);
    main.appendChild(icon);
    main.appendChild(label);

    row.appendChild(main);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      selectedKey = node.key;
      syncActiveRows();
      showContextMenu(node, e.clientX, e.clientY);
    };
    row.onkeydown = (e) => handleRowKey(e, node);
    parent.appendChild(row);

    if (error) {
      const errorRow = document.createElement("div");
      errorRow.className = "zion-files-message-row";
      errorRow.dataset.depth = String(depth + 1);
      errorRow.dataset.parentKey = node.key;
      errorRow.style.setProperty("--depth", String(depth + 1));
      errorRow.textContent = error;
      parent.appendChild(errorRow);
    }

    if (isDirectory && isExpanded) {
      if (isLoading) {
        const loading = document.createElement("div");
        loading.className = "zion-files-message-row";
        loading.dataset.depth = String(depth + 1);
        loading.dataset.parentKey = node.key;
        loading.style.setProperty("--depth", String(depth + 1));
        loading.textContent = t("files.loading", "Loading files...");
        parent.appendChild(loading);
      } else {
        if (!dirCache.has(node.key) && !failedKeys.has(node.key)) {
          ensureDirectoryLoaded(node, { incremental: true });
          const loading = document.createElement("div");
          loading.className = "zion-files-message-row";
          loading.dataset.depth = String(depth + 1);
          loading.dataset.parentKey = node.key;
          loading.style.setProperty("--depth", String(depth + 1));
          loading.textContent = t("files.loading", "Loading files...");
          parent.appendChild(loading);
          return;
        }
        const children = dirCache.get(node.key) || [];
        if (children.length === 0 && dirCache.has(node.key)) {
          const empty = document.createElement("div");
          empty.className = "zion-files-message-row";
          empty.dataset.depth = String(depth + 1);
          empty.dataset.parentKey = node.key;
          empty.style.setProperty("--depth", String(depth + 1));
          empty.textContent = t("files.emptyFolder", "Empty folder");
          parent.appendChild(empty);
        } else {
          for (const child of sortNodes(children, sortBy)) renderNode(parent, child, depth + 1);
        }
      }
    }
  }

  function showContextMenu(node, x, y) {
    closeContextMenu();
    const popover = document.createElement("div");
    popover.className = "zion-files-actions-popover zion-files-context-popover";
    popover.appendChild(renderMenuMeta(node));
    if (node.kind === "file") {
      popover.appendChild(menuItem(t("files.open", "Open Preview"), () => { closeContextMenu(); openFile(node); }));
      popover.appendChild(menuItem(t("files.download", "Download"), () => { closeContextMenu(); downloadFile(node); }));
    } else {
      popover.appendChild(menuItem(t("files.refreshFolder", "Refresh Folder"), () => { closeContextMenu(); refreshDirectory(node); }));
    }
    popover.appendChild(menuItem(t("files.copyPath", "Copy Path"), () => { closeContextMenu(); copyPath(node); }));
    popover.oncontextmenu = (event) => event.preventDefault();
    document.body.appendChild(popover);
    contextMenuEl = popover;
    positionContextMenu(popover, x, y);
    requestAnimationFrame(() => {
      if (contextMenuEl !== popover) return;
      window.addEventListener("pointerdown", handleContextMenuPointerDown, { capture: true });
      window.addEventListener("keydown", handleContextMenuKeydown, { capture: true });
    });
  }

  function positionContextMenu(popover, x, y) {
    const rect = popover.getBoundingClientRect();
    const margin = 6;
    const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function closeContextMenu() {
    window.removeEventListener("pointerdown", handleContextMenuPointerDown, { capture: true });
    window.removeEventListener("keydown", handleContextMenuKeydown, { capture: true });
    try { contextMenuEl?.remove?.(); } catch {}
    contextMenuEl = null;
  }

  function handleContextMenuPointerDown(event) {
    if (contextMenuEl?.contains?.(event.target)) return;
    closeContextMenu();
  }

  function handleContextMenuKeydown(event) {
    if (event.key === "Escape") closeContextMenu();
  }

  function renderMenuMeta(node) {
    const block = document.createElement("div");
    block.className = "zion-files-context-meta";
    block.appendChild(renderMenuMetaRow(t("files.kind", "Kind"), node.kind === "directory" ? t("files.kindFolder", "Folder") : t("files.kindFile", "File")));
    if (node.kind === "file") {
      block.appendChild(renderMenuMetaRow(t("files.size", "Size"), typeof node.size === "number" ? formatBytes(node.size) : "-"));
      block.appendChild(renderMenuMetaRow(t("files.modified", "Modified"), node.modified ? formatDateTime(node.modified) : "-"));
    }
    const divider = document.createElement("div");
    divider.className = "zion-files-menu-divider";
    block.appendChild(divider);
    return block;
  }

  function renderMenuMetaRow(label, value) {
    const row = document.createElement("div");
    row.className = "zion-files-context-meta-row";
    const labelEl = document.createElement("span");
    labelEl.className = "zion-files-context-meta-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.className = "zion-files-context-meta-value";
    valueEl.textContent = value;
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    return row;
  }

  function renderEmptyState(title, description, actions) {
    const empty = document.createElement("div");
    empty.className = "zion-files-empty";
    const titleEl = document.createElement("div");
    titleEl.className = "zion-files-empty-title";
    titleEl.textContent = title;
    empty.appendChild(titleEl);
    if (description) {
      const desc = document.createElement("div");
      desc.className = "zion-files-empty-description";
      desc.textContent = description;
      empty.appendChild(desc);
    }
    if (actions.length) {
      const row = document.createElement("div");
      row.className = "zion-files-empty-actions";
      for (const action of actions) {
        const btn = document.createElement("button");
        btn.className = "zion-files-action";
        btn.type = "button";
        btn.textContent = action.label;
        btn.onclick = action.action;
        row.appendChild(btn);
      }
      empty.appendChild(row);
    }
    return empty;
  }

  function selectOrToggle(node) {
    selectedKey = node.key;
    syncActiveRows();
    if (node.kind === "directory") toggleDirectory(node);
  }

  async function toggleDirectory(node) {
    if (expanded.has(node.key)) {
      expanded.delete(node.key);
      saveExpanded(expanded);
      updateDirectoryRowState(node, false);
      removeRenderedDescendants(node);
      return;
    }
    expanded.add(node.key);
    saveExpanded(expanded);
    updateDirectoryRowState(node, true);
    if (dirCache.has(node.key) || failedKeys.has(node.key)) {
      insertDirectoryChildren(node);
      revalidateDirectory(node);
      return;
    }
    await ensureDirectoryLoaded(node, { incremental: true });
  }

  async function ensureDirectoryLoaded(node, opts = {}) {
    if (node.kind !== "directory" || dirCache.has(node.key) || loadingKeys.has(node.key)) return;
    loadingKeys.add(node.key);
    failedKeys.delete(node.key);
    scheduleLoadingRender(node, !!opts.incremental);
    try {
      const provider = getProvider(node.sourceId || sourceId);
      const children = await loadDirectoryChildren(node, provider);
      dirCache.set(node.key, children.filter(Boolean));
      saveTreeCacheSoon();
      scheduleDirectoryPrefetch(children, PREFETCH_DEPTH);
    } catch (e) {
      failedKeys.set(node.key, e?.message || String(e || ""));
      dirCache.set(node.key, []);
    } finally {
      clearLoadingRender(node.key);
      loadingKeys.delete(node.key);
      if (opts.incremental) insertDirectoryChildren(node);
      else scheduleRender();
    }
  }

  async function revalidateDirectory(node) {
    if (node.kind !== "directory" || loadingKeys.has(node.key)) return;
    loadingKeys.add(node.key);
    failedKeys.delete(node.key);
    try {
      const provider = getProvider(node.sourceId || sourceId);
      const children = (await loadDirectoryChildren(node, provider)).filter(Boolean);
      const changed = !sameNodeList(dirCache.get(node.key), children);
      dirCache.set(node.key, children);
      saveTreeCacheSoon();
      scheduleDirectoryPrefetch(children, PREFETCH_DEPTH);
      if (expanded.has(node.key) && changed) {
        if (findRowByKey(node.key)) insertDirectoryChildren(node);
        else scheduleRender();
      }
    } catch (e) {
      failedKeys.set(node.key, e?.message || String(e || ""));
      if (expanded.has(node.key) && findRowByKey(node.key)) insertDirectoryChildren(node);
    } finally {
      loadingKeys.delete(node.key);
    }
  }

  function scheduleLoadingRender(node, incremental) {
    const key = node.key;
    if (loadingRenderTimers.has(key)) return;
    const timer = window.setTimeout(() => {
      loadingRenderTimers.delete(key);
      if (!loadingKeys.has(key)) return;
      if (incremental) insertDirectoryLoading(node);
      else scheduleRender();
    }, 140);
    loadingRenderTimers.set(key, timer);
  }

  function clearLoadingRender(key) {
    const timer = loadingRenderTimers.get(key);
    if (!timer) return;
    window.clearTimeout(timer);
    loadingRenderTimers.delete(key);
  }

  function getTreeEl() {
    return root.querySelector(".zion-files-tree");
  }

  function findRowByKey(key) {
    const tree = getTreeEl();
    if (!tree) return null;
    for (const row of tree.querySelectorAll(".zion-files-row")) {
      if (row.dataset.key === key) return row;
    }
    return null;
  }

  function rowDepth(row) {
    const n = Number(row?.dataset?.depth);
    return Number.isFinite(n) ? n : 0;
  }

  function syncActiveRows() {
    const tree = getTreeEl();
    if (!tree) return;
    for (const row of tree.querySelectorAll(".zion-files-row")) {
      const active = row.dataset.key === selectedKey;
      row.classList.toggle("is-active", active);
      row.setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  function updateDirectoryRowState(node, isExpanded) {
    const row = findRowByKey(node.key);
    if (!row) return;
    row.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    const chevron = row.querySelector(".zion-files-chevron");
    if (chevron) {
      chevron.classList.add("codicon");
      chevron.classList.toggle("codicon-chevron-right", !isExpanded);
      chevron.classList.toggle("codicon-chevron-down", isExpanded);
    }
    const icon = row.querySelector(".zion-files-icon");
    if (icon) {
      icon.classList.toggle("codicon-folder", !isExpanded);
      icon.classList.toggle("codicon-folder-opened", isExpanded);
    }
  }

  function removeRenderedDescendants(node) {
    const row = findRowByKey(node.key);
    if (!row) return;
    const depth = rowDepth(row);
    let next = row.nextElementSibling;
    while (next) {
      const nextDepth = Number(next.dataset?.depth);
      if (!Number.isFinite(nextDepth) || nextDepth <= depth) break;
      const remove = next;
      next = next.nextElementSibling;
      remove.remove();
    }
  }

  function insertDirectoryLoading(node) {
    if (!expanded.has(node.key)) return;
    const row = findRowByKey(node.key);
    if (!row) return;
    removeRenderedDescendants(node);
    row.after(renderMessageRow(node, t("files.loading", "Loading files...")));
  }

  function insertDirectoryChildren(node) {
    if (!expanded.has(node.key)) return;
    const row = findRowByKey(node.key);
    if (!row) {
      scheduleRender();
      return;
    }
    removeRenderedDescendants(node);
    const fragment = document.createDocumentFragment();
    const error = failedKeys.get(node.key);
    if (error) {
      fragment.appendChild(renderMessageRow(node, error));
    } else {
      const children = dirCache.get(node.key) || [];
      if (children.length === 0 && dirCache.has(node.key)) {
        fragment.appendChild(renderMessageRow(node, t("files.emptyFolder", "Empty folder")));
      } else {
        for (const child of sortNodes(children, sortBy)) renderNode(fragment, child, rowDepth(row) + 1);
      }
    }
    row.after(fragment);
  }

  function renderMessageRow(parentNode, text) {
    const parentRow = findRowByKey(parentNode.key);
    const depth = rowDepth(parentRow) + 1;
    const row = document.createElement("div");
    row.className = "zion-files-message-row";
    row.dataset.depth = String(depth);
    row.dataset.parentKey = parentNode.key;
    row.style.setProperty("--depth", String(depth));
    row.textContent = text;
    return row;
  }

  async function loadDirectoryChildren(node, provider = getProvider(node.sourceId || sourceId)) {
    const prefetchPromise = prefetchPromises.get(node.key);
    if (prefetchPromise) return await prefetchPromise;
    return await provider.listChildren(node);
  }

  function resetPrefetch() {
    prefetchSeq += 1;
    if (prefetchTimer) window.clearTimeout(prefetchTimer);
    prefetchTimer = 0;
    activePrefetchCount = 0;
    prefetchQueue.length = 0;
    prefetchingKeys.clear();
    prefetchPromises.clear();
  }

  function scheduleDirectoryPrefetch(nodes, depth) {
    if (disposed || depth <= 0 || !sourceId.startsWith("terminal:")) return;
    const generation = prefetchSeq;
    const dirs = (Array.isArray(nodes) ? nodes : [])
      .filter((node) => shouldPrefetchDirectory(node))
      .slice(0, PREFETCH_MAX_DIRS_PER_BATCH);
    if (!dirs.length) return;
    for (const node of dirs) {
      prefetchingKeys.add(node.key);
      prefetchQueue.push({ node, depth, generation });
    }
    pumpPrefetchQueueSoon();
  }

  function shouldPrefetchDirectory(node) {
    return node?.kind === "directory"
      && node.provider === "terminal"
      && !dirCache.has(node.key)
      && !loadingKeys.has(node.key)
      && !prefetchingKeys.has(node.key)
      && !failedKeys.has(node.key);
  }

  function pumpPrefetchQueueSoon() {
    if (prefetchTimer || disposed) return;
    prefetchTimer = window.setTimeout(() => {
      prefetchTimer = 0;
      pumpPrefetchQueue();
    }, 220);
  }

  function pumpPrefetchQueue() {
    if (disposed) return;
    while (activePrefetchCount < PREFETCH_MAX_CONCURRENCY && prefetchQueue.length) {
      const task = prefetchQueue.shift();
      if (!task || task.generation !== prefetchSeq || !shouldPrefetchDirectory(task.node)) {
        if (task?.node?.key) prefetchingKeys.delete(task.node.key);
        continue;
      }
      activePrefetchCount += 1;
      runPrefetchTask(task).finally(() => {
        activePrefetchCount = Math.max(0, activePrefetchCount - 1);
        if (prefetchQueue.length) pumpPrefetchQueueSoon();
      });
    }
  }

  async function runPrefetchTask(task) {
    const { node, depth, generation } = task;
    const provider = getProvider(node.sourceId || sourceId);
    const promise = provider.listChildren(node);
    prefetchPromises.set(node.key, promise);
    try {
      const children = (await promise).filter(Boolean);
      if (disposed || generation !== prefetchSeq || dirCache.has(node.key)) return;
      dirCache.set(node.key, children);
      if (depth > 1) scheduleDirectoryPrefetch(children, depth - 1);
    } catch {
      // Background prefetch is opportunistic; surface errors only when the user expands.
    } finally {
      prefetchPromises.delete(node.key);
      prefetchingKeys.delete(node.key);
    }
  }

  async function refreshDirectory(node, details) {
    try { details.open = false; } catch {}
    if (node.kind !== "directory") return;
    dirCache.delete(node.key);
    failedKeys.delete(node.key);
    expanded.add(node.key);
    saveExpanded(expanded);
    updateDirectoryRowState(node, true);
    await ensureDirectoryLoaded(node, { incremental: true });
  }

  async function openFile(node, details) {    try { details.open = false; } catch {}
    selectedKey = node.key;
    syncActiveRows();
    if (node.provider === "local" && !node.handle) {
      window.showToast?.(t("files.refreshingTree", "Refreshing file tree..."));
      refreshExpandedDirectoriesSoon();
      return;
    }
    const tabId = `file:${stableFileTabId(node)}`;
    const existing = openFileTabs.get(tabId);
    if (existing) {
      return refreshOpenFileTab(node, tabId, existing);
    }

    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const baseTab = {
      id: tabId,
      title: node.name,
      path: node.path || node.displayPath || "",
      displayPath: node.displayPath || node.path || node.name,
      language: languageFromFilename(node.name),
      size: typeof node.size === "number" ? node.size : undefined,
      file: { kind: "loading" },
      token
    };
    const hadPreview = !!root.querySelector(".zion-files-preview-pane") || openFileTabs.size > 0;
    openFileTabs.set(tabId, baseTab);
    activeFileTabId = tabId;
    if (hadPreview) renderPreviewOnly();
    else showPreviewPaneIncremental();

    try {
      const provider = getProvider(node.sourceId || sourceId);
      const file = await provider.readFile(node);
      const current = openFileTabs.get(tabId);
      if (!current || current.token !== token) return;
      const tab = {
        ...current,
        size: typeof file?.size === "number" ? file.size : current.size,
        file
      };
      openFileTabs.set(tabId, tab);
      activeFileTabId = tabId;
      renderPreviewOnly();
    } catch (e) {
      const message = e?.message || String(e || t("files.openFailed", "Failed to open file"));
      const current = openFileTabs.get(tabId);
      if (current && current.token === token) {
        openFileTabs.set(tabId, { ...current, file: { kind: "error", message } });
        activeFileTabId = tabId;
        renderPreviewOnly();
      }
      window.showToast?.(message);
    }
  }

  async function refreshOpenFileTab(node, tabId, existing) {
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    openFileTabs.set(tabId, {
      ...existing,
      title: node.name || existing.title,
      path: node.path || node.displayPath || existing.path || "",
      displayPath: node.displayPath || node.path || existing.displayPath || node.name,
      language: languageFromFilename(node.name || existing.title),
      size: typeof node.size === "number" ? node.size : existing.size,
      file: { kind: "loading" },
      token
    });
    activeFileTabId = tabId;
    renderPreviewOnly();
    try {
      const provider = getProvider(node.sourceId || sourceId);
      const file = await provider.readFile(node);
      const current = openFileTabs.get(tabId);
      if (!current || current.token !== token) return;
      openFileTabs.set(tabId, {
        ...current,
        size: typeof file?.size === "number" ? file.size : current.size,
        file
      });
      activeFileTabId = tabId;
      renderPreviewOnly();
    } catch (e) {
      const message = e?.message || String(e || t("files.openFailed", "Failed to open file"));
      const current = openFileTabs.get(tabId);
      if (current && current.token === token) {
        openFileTabs.set(tabId, { ...current, file: { kind: "error", message } });
        activeFileTabId = tabId;
        renderPreviewOnly();
      }
      window.showToast?.(message);
    }
  }

  async function downloadFile(node, details) {
    try { details.open = false; } catch {}
    if (node.kind !== "file") return;
    try {
      const provider = getProvider(node.sourceId || sourceId);
      const file = await provider.downloadFile(node);
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = node.name || file.name || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch {}
      }, 1000);
    } catch (e) {
      window.showToast?.(e?.message || String(e || t("files.downloadFailed", "Failed to download file")));
    }
  }

  async function processPendingReveal() {
    const reveal = pendingReveal;
    if (!reveal?.path || disposed || rootsLoading) return;
    const target = normalizeRevealPath(reveal.path);
    if (!target) return;
    for (const rootNode of roots) {
      const node = await findNodeForReveal(rootNode, target);
      if (!node || pendingReveal !== reveal || disposed) continue;
      pendingReveal = null;
      revealStatus = "";
      selectedKey = node.key;
      expanded.add(node.key);
      saveExpanded(expanded);
      scheduleRender();
      requestAnimationFrame(() => scrollRevealedNode(node.key));
      if (reveal.open && node.kind === "file") openFile(node);
      return;
    }    revealStatus = "";
    window.showToast?.(t("files.revealNotFound", "File not found in current explorer source"));
    scheduleRender();
  }

  async function findNodeForReveal(node, target) {
    if (!node) return null;
    if (nodeMatchesReveal(node, target)) return node;
    if (node.kind !== "directory" || !isRevealPathInside(node, target)) return null;
    expanded.add(node.key);
    saveExpanded(expanded);
    await ensureDirectoryLoaded(node, { incremental: false });
    const children = sortNodes(dirCache.get(node.key) || [], sortBy);
    for (const child of children) {
      const found = await findNodeForReveal(child, target);
      if (found) return found;
    }
    return null;
  }

  function scrollRevealedNode(key) {
    if (!key || disposed) return;
    const row = findRowByKey(key);
    if (!row) return;
    syncActiveRows();
    try { row.scrollIntoView({ block: "center", inline: "nearest" }); } catch {}
    try { row.focus?.({ preventScroll: true }); } catch {}
  }

  function nodeMatchesReveal(node, target) {
    const candidates = [
      node.path,
      node.displayPath,
      buildNodeAbsolutePath(node),
      node.name
    ].map(normalizeRevealPath).filter(Boolean);
    return candidates.some((candidate) => candidate === target);
  }

  function isRevealPathInside(node, target) {
    const candidates = [
      node.path,
      node.displayPath,
      buildNodeAbsolutePath(node),
      node.rootPath
    ].map(normalizeRevealPath).filter(Boolean);
    return candidates.some((candidate) => isSameOrChildPath(target, candidate));
  }

  function buildNodeAbsolutePath(node) {
    const root = String(node?.rootPath || "").replace(/[\\/]+$/, "");
    if (!root) return node?.path || node?.displayPath || "";
    const parts = Array.isArray(node?.segments) ? node.segments : [];
    return parts.length ? `${root}/${parts.join("/")}` : root;
  }

  function handleRowKey(e, node) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (node.kind === "directory") toggleDirectory(node);
      else openFile(node);
      return;
    }
    if ((e.key === "ContextMenu") || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const rect = findRowByKey(node.key)?.getBoundingClientRect?.();
      showContextMenu(node, rect ? rect.left + 24 : 24, rect ? rect.top + 18 : 24);
      return;
    }
    if (e.key === "ArrowRight" && node.kind === "directory" && !expanded.has(node.key)) {
      e.preventDefault();
      toggleDirectory(node);
      return;
    }
    if (e.key === "ArrowLeft" && node.kind === "directory" && expanded.has(node.key)) {
      e.preventDefault();
      expanded.delete(node.key);
      saveExpanded(expanded);
      updateDirectoryRowState(node, false);
      removeRenderedDescendants(node);
    }
  }

}

export function getProvider(sourceId) {
  const source = resolveSourceId(sourceId);
  if (source.startsWith("terminal:")) return createTerminalProvider(source);
  return createLocalProvider();
}

function createLocalProvider() {
  return {
    async listRoots() {
      const entries = await Promise.resolve(window.zion.commands?.executeCommand?.("fs.getEntries"));
      return normalizeRootEntries(Array.isArray(entries) ? entries : []);
    },
    async listChildren(node) {
      if (!node?.handle) throw new Error(t("files.handleUnavailable", "File handle unavailable"));
      const ok = await ensurePermission(node.handle, "read");
      if (!ok) throw new Error(t("files.permissionDenied", "Permission denied"));
      const children = [];
      for await (const [name, handle] of node.handle.entries()) {
        if (shouldIgnoreName(name)) continue;
        children.push(await normalizeChildNode(node, name, handle));
      }
      return children;
    },
    async readFile(node) {
      if (!node?.handle) throw new Error(t("files.handleUnavailable", "File handle unavailable"));
      const ok = await ensurePermission(node.handle, "read");
      if (!ok) throw new Error(t("files.permissionDenied", "Permission denied"));
      const file = await node.handle.getFile();
      if (isImageFile(file, node.name)) return { kind: "image", blob: file };
      if (!isTextLikeFile(file, node.name)) return { kind: "binary", size: file.size };
      if (file.size > MAX_TEXT_PREVIEW_BYTES) throw new Error(t("files.tooLarge", "File is too large to preview"));
      return { kind: "text", content: await file.text(), size: file.size };
    },
    async downloadFile(node) {
      if (!node?.handle) throw new Error(t("files.handleUnavailable", "File handle unavailable"));
      const ok = await ensurePermission(node.handle, "read");
      if (!ok) throw new Error(t("files.permissionDenied", "Permission denied"));
      return await node.handle.getFile();
    },
    emptyTitle() {
      return t("files.emptyTitle", "No folders added");
    },
    emptyDescription() {
      return t("files.emptyDescription", "Add a folder or file from File System Access Manager to browse it here.");
    },
    emptyActions() {
      return [
        { label: t("files.addFolder", "Add Folder"), action: () => window.zion.commands?.executeCommand?.("fs.addFolder") },
        { label: t("files.openManager", "Open Manager"), action: () => window.zion.commands?.executeCommand?.("fs.showManager") }
      ];
    }
  };
}

function createTerminalProvider(sourceId) {
  const requestedSessionId = sourceId === "terminal:active" ? getActiveTerminalSessionId() : sourceId.slice("terminal:".length);
  const session = getTerminalSessions().find((item) => String(item?.id || "") === requestedSessionId) || null;
  const sessionId = String(session?.id || requestedSessionId || "").trim();

  return {
    async listRoots() {
      if (!sessionId) return [];
      const cwd = await getTerminalCwd(sessionId, session);
      if (!cwd) return [];
      const key = terminalNodeKey(sessionId, cwd);
      return [{
        key,
        sourceId,
        provider: "terminal",
        sessionId,
        kind: "directory",
        name: cwd === "/" ? "/" : cwd.split("/").filter(Boolean).pop() || cwd,
        path: cwd,
        displayPath: `${getTerminalSessionLabel(session)}:${cwd}`,
        size: null,
        modified: null
      }];
    },
    async listChildren(node) {
      const data = await runTerminalJson(sessionId, buildTerminalListCommand(node.path));
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      return entries
        .filter((entry) => entry && !shouldIgnoreName(entry.name))
        .map((entry) => normalizeTerminalNode(sourceId, sessionId, entry));
    },
    async readFile(node) {
      return await readTerminalFileChunked(sessionId, node.path);
    },
    async downloadFile(node) {
      const data = await runTerminalJson(sessionId, buildTerminalDownloadCommand(node.path, 10 * 1024 * 1024));
      if (!data?.ok || !data.base64) throw new Error(data?.error || t("files.downloadFailed", "Failed to download file"));
      const blob = base64ToBlob(data.base64, data.mime || "application/octet-stream");
      try { Object.defineProperty(blob, "name", { value: node.name }); } catch {}
      return blob;
    },
    emptyTitle() {
      return t("files.noTerminalTitle", "No terminal session");
    },
    emptyDescription() {
      return t("files.noTerminalDescription", "Create or select a local/SSH terminal session to browse files through it.");
    },
    emptyActions() {
      return [
        { label: t("files.openTerminalManager", "Open Terminal Manager"), action: () => window.zion.commands?.executeCommand?.("terminal.openManager") },
        { label: t("files.refresh", "Refresh"), action: () => window.zion.commands?.executeCommand?.("terminal.refreshSessions") }
      ];
    }
  };
}

function normalizeRootEntries(entries) {
  return entries
    .filter((entry) => entry?.handle && (entry.kind === "directory" || entry.kind === "file"))
    .map((entry) => {
      const name = String(entry.name || entry.handle?.name || "Untitled");
      const key = `root:${entry.id || name}`;
      return {
        key,
        sourceId: "local",
        provider: "local",
        entryId: entry.id || key,
        kind: entry.kind,
        name,
        handle: entry.handle,
        segments: [],
        rootPath: String(entry.path || "").trim(),
        displayPath: String(entry.path || name).trim() || name,
        size: null,
        modified: null
      };
    });
}

async function normalizeChildNode(parent, name, handle) {
  const segments = [...(parent.segments || []), name];
  const key = `${parent.key}/${encodeURIComponent(name)}`;
  const base = {
    key,
    sourceId: parent.sourceId || "local",
    provider: parent.provider || "local",
    entryId: parent.entryId,
    kind: handle.kind,
    name,
    handle,
    segments,
    rootPath: parent.rootPath || "",
    displayPath: buildDisplayPath(parent.rootPath || parent.name, segments),
    size: null,
    modified: null
  };
  if (handle.kind === "file") {
    try {
      const file = await handle.getFile();
      base.size = file.size;
      base.modified = file.lastModified || null;
    } catch {}
  }
  return base;
}

function normalizeTerminalNode(sourceId, sessionId, entry) {
  const path = String(entry.path || "");
  return {
    key: terminalNodeKey(sessionId, path),
    sourceId,
    provider: "terminal",
    sessionId,
    kind: entry.kind === "directory" ? "directory" : "file",
    name: String(entry.name || path.split("/").filter(Boolean).pop() || path || "untitled"),
    path,
    displayPath: path,
    size: typeof entry.size === "number" ? entry.size : null,
    modified: typeof entry.modified === "number" ? entry.modified : null
  };
}

function buildDisplayPath(rootPath, segments) {
  const suffix = segments.join("/");
  const root = String(rootPath || "").replace(/\/+$/, "");
  return suffix ? `${root}/${suffix}` : root;
}

function sortNodes(nodes, sortBy = "name") {
  const arr = nodes.slice();
  arr.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    if (sortBy === "type") {
      const ea = extensionOf(a.name);
      const eb = extensionOf(b.name);
      if (ea !== eb) return ea.localeCompare(eb);
    } else if (sortBy === "modified") {
      const da = Number(a.modified || 0);
      const db = Number(b.modified || 0);
      if (da !== db) return db - da;
    } else if (sortBy === "size") {
      const sa = Number(a.size || 0);
      const sb = Number(b.size || 0);
      if (sa !== sb) return sb - sa;
    }
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base", numeric: true });
  });
  return arr;
}

function treeCacheKey(sourceId) {
  return `${LS_TREE_CACHE_PREFIX}${encodeURIComponent(resolveSourceId(sourceId))}`;
}

function loadTreeCache(sourceId) {
  try {
    const data = JSON.parse(localStorage.getItem(treeCacheKey(sourceId)) || "null");
    if (!data || !Array.isArray(data.roots) || !data.dirs || typeof data.dirs !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

function saveTreeCache(sourceId, roots, dirCache) {
  try {
    const dirs = {};
    let count = 0;
    for (const [key, children] of dirCache.entries()) {
      if (count >= TREE_CACHE_MAX_DIRS) break;
      if (!Array.isArray(children)) continue;
      dirs[key] = children.slice(0, TREE_CACHE_MAX_CHILDREN_PER_DIR).map(serializeTreeNode).filter(Boolean);
      count += 1;
    }
    localStorage.setItem(treeCacheKey(sourceId), JSON.stringify({
      version: 1,
      sourceId: resolveSourceId(sourceId),
      savedAt: Date.now(),
      roots: (Array.isArray(roots) ? roots : []).map(serializeTreeNode).filter(Boolean),
      dirs
    }));
  } catch {}
}

function serializeTreeNode(node) {
  if (!node?.key) return null;
  const out = {
    key: String(node.key),
    sourceId: node.sourceId ? String(node.sourceId) : undefined,
    provider: node.provider ? String(node.provider) : undefined,
    entryId: node.entryId ? String(node.entryId) : undefined,
    sessionId: node.sessionId ? String(node.sessionId) : undefined,
    kind: node.kind === "directory" ? "directory" : "file",
    name: String(node.name || ""),
    path: node.path ? String(node.path) : undefined,
    displayPath: node.displayPath ? String(node.displayPath) : undefined,
    rootPath: node.rootPath ? String(node.rootPath) : undefined,
    segments: Array.isArray(node.segments) ? node.segments.map(String) : undefined,
    size: typeof node.size === "number" ? node.size : null,
    modified: typeof node.modified === "number" ? node.modified : null
  };
  return out;
}

function markCachedNode(node) {
  if (!node?.key || (node.kind !== "directory" && node.kind !== "file")) return null;
  return { ...node, cached: true };
}

function sameNodeList(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const x = left[i] || {};
    const y = right[i] || {};
    if (x.key !== y.key || x.kind !== y.kind || x.name !== y.name) return false;
    if (Number(x.size || 0) !== Number(y.size || 0)) return false;
    if (Number(x.modified || 0) !== Number(y.modified || 0)) return false;
  }
  return true;
}

function menuItem(label, action) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "zion-files-menu-item";
  btn.textContent = label;
  btn.onclick = (e) => {
    e.stopPropagation();
    action();
  };
  return btn;
}

function cssEscape(value) {
  try {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(String(value));
  } catch {}
  return String(value).replace(/["\\]/g, "\\$&");
}

function loadExpanded() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_EXPANDED) || "[]");
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveExpanded(expanded) {
  try { localStorage.setItem(LS_EXPANDED, JSON.stringify(Array.from(expanded).slice(0, 500))); } catch {}
}

function loadSort() {
  try {
    const value = String(localStorage.getItem(LS_SORT) || "name");
    return SORT_OPTIONS.includes(value) ? value : "name";
  } catch {
    return "name";
  }
}

function loadExplorerWidth() {
  try {
    const value = Number(localStorage.getItem(LS_EXPLORER_WIDTH) || "296");
    return Number.isFinite(value) ? Math.max(180, Math.min(520, value)) : 296;
  } catch {
    return 296;
  }
}

function saveExplorerWidth(value) {
  try { localStorage.setItem(LS_EXPLORER_WIDTH, String(Math.round(Number(value) || 296))); } catch {}
}

function loadSourceId() {
  try {
    return resolveSourceId(localStorage.getItem(LS_SOURCE) || "local");
  } catch {
    return "local";
  }
}

function saveSourceId(value) {
  try { localStorage.setItem(LS_SOURCE, resolveSourceId(value)); } catch {}
}

function resolveSourceId(value) {
  const raw = String(value || "local");
  if (raw === "local") return "local";
  if (raw === "terminal:active") return "terminal:active";
  if (raw.startsWith("terminal:")) {
    const id = raw.slice("terminal:".length);
    if (getTerminalSessions().some((session) => String(session?.id || "") === id)) return raw;
    return getActiveTerminalSessionId() ? "terminal:active" : "local";
  }
  return "local";
}

function inferSourceFromPath(path) {
  const raw = String(path || "").trim();
  if (raw.startsWith("/") || raw.startsWith("~/")) return "terminal:active";
  return "local";
}

export async function ensureRevealSourceForPath(path, sourceHint = "") {
  const rawPath = normalizeRevealPath(path);
  const fallback = resolveSourceId(sourceHint || inferSourceFromPath(rawPath));
  if (!rawPath || !isTerminalPath(rawPath)) return fallback;

  let sessions = getTerminalSessions();
  if (!sessions.length) {
    try {
      const refreshed = await window.zion.commands?.executeCommand?.("terminal.refreshSessions");
      if (Array.isArray(refreshed)) sessions = refreshed;
    } catch {}
  }
  const hintSession = getTerminalSessionFromSource(sourceHint || fallback, sessions);
  const matched = findBestTerminalSessionForPath(rawPath, sessions, hintSession);
  if (matched?.id) {    return `terminal:${matched.id}`;
  }

  const created = await createTerminalProjectForPath(rawPath, hintSession);
  if (created?.id) {    return `terminal:${created.id}`;
  }  return fallback;
}

function isTerminalPath(path) {
  const raw = String(path || "").trim();
  return raw.startsWith("/") || raw.startsWith("~/");
}

function getTerminalSessionFromSource(sourceId, sessions = getTerminalSessions()) {
  const source = String(sourceId || "").trim();
  const sessionId = source === "terminal:active"
    ? getActiveTerminalSessionId()
    : source.startsWith("terminal:") ? source.slice("terminal:".length) : "";
  if (!sessionId) return null;
  return sessions.find((session) => String(session?.id || "") === sessionId) || null;
}

function findBestTerminalSessionForPath(path, sessions = getTerminalSessions(), hintSession = null) {
  const normalizedPath = normalizeRevealPath(path);
  const candidates = Array.isArray(sessions) ? sessions : [];
  const sameDevice = hintSession ? candidates.filter((session) => isSameTerminalDevice(session, hintSession)) : candidates;
  return pickBestSessionByCwd(normalizedPath, sameDevice) || (!hintSession ? null : pickBestSessionByCwd(normalizedPath, candidates));
}

function pickBestSessionByCwd(path, sessions) {
  let best = null;
  let bestLength = -1;
  for (const session of sessions || []) {
    const cwd = normalizeRevealPath(session?.cwd || session?.initial_cwd || "");
    if (!cwd || !isSameOrChildPath(path, cwd)) continue;
    if (cwd.length > bestLength) {
      best = session;
      bestLength = cwd.length;
    }
  }
  return best;
}

function isSameTerminalDevice(a, b) {
  if (!a || !b) return false;
  const typeA = String(a?.type || "local").trim() || "local";
  const typeB = String(b?.type || "local").trim() || "local";
  if (typeA !== typeB) return false;
  if (typeA !== "ssh") return true;
  return String(a?.ssh_host || a?.host || "").trim() === String(b?.ssh_host || b?.host || "").trim()
    && String(a?.ssh_user || a?.user || "").trim() === String(b?.ssh_user || b?.user || "").trim()
    && String(a?.ssh_port || a?.port || "22").trim() === String(b?.ssh_port || b?.port || "22").trim();
}

async function createTerminalProjectForPath(path, hintSession = null) {
  const initial_cwd = dirnameForRevealPath(path);
  if (!initial_cwd) return null;
  const payload = buildTerminalCreatePayload(initial_cwd, hintSession);
  try {
    const created = await window.zion.commands?.executeCommand?.("terminal.createSession", payload);
    if (created && typeof created === "object" && created.id) return created;
    return findBestTerminalSessionForPath(path, getTerminalSessions(), hintSession);
  } catch (e) {
    try { window.showToast?.(`Failed to create Files project: ${e?.message || String(e)}`); } catch {}
    return null;
  }
}

function buildTerminalCreatePayload(initial_cwd, hintSession = null) {
  const type = String(hintSession?.type || "local").trim() || "local";
  const payload = { type, initial_cwd };
  if (type === "ssh") {
    const ssh_host = String(hintSession?.ssh_host || hintSession?.host || "").trim();
    const ssh_user = String(hintSession?.ssh_user || hintSession?.user || "").trim();
    const ssh_port = hintSession?.ssh_port || hintSession?.port;
    if (ssh_host) payload.ssh_host = ssh_host;
    if (ssh_user) payload.ssh_user = ssh_user;
    if (ssh_port) payload.ssh_port = Number(ssh_port);
  }
  return payload;
}

function dirnameForRevealPath(path) {
  const raw = normalizeRevealPath(path);
  if (!raw || raw === "/" || raw === "~") return raw || "";
  const slash = raw.lastIndexOf("/");
  if (slash <= 0) return raw.startsWith("~/") ? "~" : "/";
  return raw.slice(0, slash);
}

function stripLineSuffix(path) {
  return String(path || "").trim().replace(/:\d+(?::\d+)?$/, "");
}

function normalizeRevealPath(path) {
  let raw = stripLineSuffix(path).replace(/\\/g, "/").replace(/[),.;]+$/, "").trim();
  if (!raw) return "";
  raw = raw.replace(/\/+/g, "/");
  if (raw.length > 1) raw = raw.replace(/\/+$/, "");
  return raw;
}

function isSameOrChildPath(child, parent) {
  const c = normalizeRevealPath(child);
  const p = normalizeRevealPath(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(`${p}/`);
}

function getSourceConcreteSessionId(value) {
  const raw = String(value || "");
  if (raw === "terminal:active") return getActiveTerminalSessionId();
  if (raw.startsWith("terminal:")) return raw.slice("terminal:".length);
  return "";
}

function terminalSessionIdsSignature() {
  return getTerminalSessions()
    .map((session) => String(session?.id || "").trim())
    .filter(Boolean)
    .sort()
    .join("|");
}

function buildSourceOptions() {
  const options = [{ id: "local", label: t("files.sourceLocal", "Local Grants"), title: t("files.sourceLocal", "Local Grants") }];
  const sessions = getTerminalSessions();
  const activeId = getActiveTerminalSessionId();
  const activeSession = sessions.find((session) => String(session?.id || "") === activeId) || null;
  if (sessions.length) {
    options.push({
      id: "terminal:active",
      label: activeSession
        ? t("files.sourceActiveTerminalProject", "Active: {project}", { project: getTerminalProjectLabel(activeSession) })
        : t("files.sourceActiveTerminal", "Terminal: Active"),
      title: activeSession ? getTerminalSessionTitle(activeSession) : t("files.sourceActiveTerminal", "Terminal: Active")
    });
  }
  for (const session of sessions) {
    const id = String(session?.id || "").trim();
    if (!id) continue;
    options.push({
      id: `terminal:${id}`,
      label: getTerminalSourceLabel(session),
      title: getTerminalSessionTitle(session)
    });
  }
  return options;
}

function getTerminalSessions() {
  try {
    const sessions = window.zion?.state?.get("terminal.sessions");
    return Array.isArray(sessions) ? sessions : [];
  } catch {
    return [];
  }
}

function getActiveTerminalSessionId() {
  try {
    return String(window.zion?.state?.get("terminal.activeSessionId") || "").trim();
  } catch {
    return "";
  }
}

function getTerminalSessionLabel(session) {
  const id = String(session?.id || "").trim();
  const type = String(session?.type || "local").trim();
  const host = String(session?.ssh_host || session?.host || "").trim();
  if (type === "ssh" && host) return `${host} (${id})`;
  return id || type || "terminal";
}

function getTerminalSourceLabel(session) {
  const type = String(session?.type || "local").trim();
  const host = String(session?.ssh_host || session?.host || "").trim();
  const project = getTerminalProjectLabel(session);
  if (type === "ssh") {
    return host ? `SSH ${host} · ${project}` : `SSH · ${project}`;
  }
  return `Local · ${project}`;
}

function getTerminalProjectLabel(session) {
  const cwd = String(session?.cwd || session?.initial_cwd || "").trim();
  const project = basenameFromPath(cwd);
  return project || String(session?.id || "").trim() || "terminal";
}

function getTerminalSessionTitle(session) {
  const id = String(session?.id || "").trim();
  const type = String(session?.type || "local").trim();
  const host = String(session?.ssh_host || session?.host || "").trim();
  const cwd = String(session?.cwd || session?.initial_cwd || "").trim();
  return [type === "ssh" && host ? `SSH ${host}` : type, id, cwd].filter(Boolean).join(" · ");
}

function basenameFromPath(path) {
  const value = String(path || "").replace(/\/+$/, "");
  if (!value) return "";
  if (value === "/") return "/";
  return value.split("/").filter(Boolean).pop() || value;
}

async function getTerminalCwd(sessionId, session) {
  const cwd = String(session?.cwd || "").trim();
  if (cwd) return cwd;
  try {
    const rec = await window.zion.commands?.executeCommand?.("terminal.executeCommand", {
      session_id: sessionId,
      command: "pwd",
      timeout: 8000
    });
    const output = getTerminalOutput(rec).trim().split(/\r?\n/).pop();
    return String(output || "").trim();
  } catch {
    return "";
  }
}

async function runTerminalJson(sessionId, command) {
  if (!sessionId) throw new Error(t("files.noTerminalTitle", "No terminal session"));
  const rec = await window.zion.commands?.executeCommand?.("terminal.executeCommand", {
    session_id: sessionId,
    command,
    timeout: 30000
  });
  if (typeof rec === "string") throw new Error(rec);
  const output = getTerminalOutput(rec);
  const parsed = parseJsonFromOutput(output);
  if (!parsed) throw new Error(output || t("files.terminalJsonFailed", "Terminal command did not return JSON"));
  if (parsed.ok === false) throw new Error(parsed.error || t("files.terminalCommandFailed", "Terminal command failed"));
  return parsed;
}

function getTerminalOutput(rec) {
  if (!rec) return "";
  if (typeof rec === "string") return rec;
  if (typeof rec.output === "string") return rec.output;
  if (typeof rec.stdout === "string") return rec.stdout;
  return "";
}

function parseJsonFromOutput(output) {
  const text = String(output || "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

async function readTerminalFileChunked(sessionId, path) {
  const meta = await runTerminalJson(sessionId, buildTerminalStatCommand(path, MAX_TEXT_PREVIEW_BYTES));
  if (!meta?.ok) throw new Error(meta?.error || t("files.openFailed", "Failed to open file"));
  if (meta.tooLarge) throw new Error(t("files.tooLarge", "File is too large to preview"));
  if (meta.binary) return { kind: "binary", size: meta.size };

  const size = Number(meta.size || 0);
  const chunks = [];
  for (let offset = 0; offset < size; offset += TERMINAL_READ_CHUNK_BYTES) {
    const part = await runTerminalJson(sessionId, buildTerminalReadChunkCommand(path, offset, TERMINAL_READ_CHUNK_BYTES));
    if (!part?.ok || typeof part.base64 !== "string") {
      throw new Error(part?.error || t("files.openFailed", "Failed to open file"));
    }
    chunks.push(part.base64);
  }

  if (meta.image) {
    return {
      kind: "image",
      blob: base64ChunksToBlob(chunks, meta.mime || "application/octet-stream"),
      size
    };
  }

  return {
    kind: "text",
    content: base64ChunksToText(chunks),
    size
  };
}

function terminalNodeKey(sessionId, path) {
  return `terminal:${encodeURIComponent(sessionId)}:${encodeURIComponent(path || "/")}`;
}

function isNodeWithinRootKey(key, root) {
  const value = String(key || "");
  if (!value) return false;
  if (value === root.key || value.startsWith(`${root.key}/`)) return true;
  if (root.provider === "terminal") {
    const prefix = `terminal:${encodeURIComponent(root.sessionId || "")}:`;
    if (!value.startsWith(prefix)) return false;
    const encodedPath = value.slice(prefix.length);
    let path = "";
    try { path = decodeURIComponent(encodedPath); } catch { path = encodedPath; }
    const rootPath = String(root.path || "").replace(/\/+$/, "") || "/";
    return path === rootPath || path.startsWith(rootPath === "/" ? "/" : `${rootPath}/`);
  }
  return false;
}

function buildTerminalListCommand(path) {
  const script = `
import json, os, sys
p = sys.argv[1]
try:
    entries = []
    with os.scandir(p) as it:
        for e in it:
            try:
                st = e.stat(follow_symlinks=False)
                entries.append({
                    "name": e.name,
                    "path": os.path.join(p, e.name),
                    "kind": "directory" if e.is_dir(follow_symlinks=False) else "file",
                    "size": int(st.st_size),
                    "modified": int(st.st_mtime * 1000)
                })
            except Exception:
                pass
    print(json.dumps({"ok": True, "entries": entries}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
`;
  return `python3 -c ${shellQuote(script)} ${shellQuote(path || ".")}`;
}

function buildTerminalStatCommand(path, limit) {
  const script = `
import json, mimetypes, os, sys
p = sys.argv[1]
limit = int(sys.argv[2])
try:
    size = os.path.getsize(p)
    if size > limit:
        print(json.dumps({"ok": True, "tooLarge": True, "size": size}))
        raise SystemExit
    with open(p, "rb") as f:
        head = f.read(4096)
    mime = mimetypes.guess_type(p)[0] or ""
    ext = os.path.splitext(p)[1].lower()
    if mime.startswith("image/") or ext in [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]:
        print(json.dumps({"ok": True, "image": True, "mime": mime or "application/octet-stream", "size": size}))
        raise SystemExit
    if b"\\0" in head:
        print(json.dumps({"ok": True, "binary": True, "size": size}))
        raise SystemExit
    print(json.dumps({"ok": True, "text": True, "mime": mime or "text/plain", "size": size}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
`;
  return `python3 -c ${shellQuote(script)} ${shellQuote(path || ".")} ${Number(limit || MAX_TEXT_PREVIEW_BYTES)}`;
}

function buildTerminalReadChunkCommand(path, offset, length) {
  const script = `
import base64, json, sys
p = sys.argv[1]
offset = int(sys.argv[2])
length = int(sys.argv[3])
try:
    with open(p, "rb") as f:
        f.seek(offset)
        data = f.read(length)
    print(json.dumps({"ok": True, "offset": offset, "bytes": len(data), "base64": base64.b64encode(data).decode("ascii")}))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
`;
  return `python3 -c ${shellQuote(script)} ${shellQuote(path || ".")} ${Number(offset || 0)} ${Number(length || TERMINAL_READ_CHUNK_BYTES)}`;
}

function buildTerminalDownloadCommand(path, limit) {
  const script = `
import base64, json, mimetypes, os, sys
p = sys.argv[1]
limit = int(sys.argv[2])
try:
    size = os.path.getsize(p)
    if size > limit:
        print(json.dumps({"ok": False, "error": "file too large", "size": size}))
        raise SystemExit
    data = open(p, "rb").read()
    print(json.dumps({"ok": True, "mime": mimetypes.guess_type(p)[0] or "application/octet-stream", "base64": base64.b64encode(data).decode("ascii"), "size": size}))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
`;
  return `python3 -c ${shellQuote(script)} ${shellQuote(path || ".")} ${Number(limit || 10485760)}`;
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

function base64ToBlob(base64, mime) {
  const binary = atob(String(base64 || ""));
  const chunks = [];
  for (let i = 0; i < binary.length; i += 8192) {
    const slice = binary.slice(i, i + 8192);
    const arr = new Uint8Array(slice.length);
    for (let j = 0; j < slice.length; j++) arr[j] = slice.charCodeAt(j);
    chunks.push(arr);
  }
  return new Blob(chunks, { type: mime || "application/octet-stream" });
}

function base64ChunksToBlob(chunks, mime) {
  const parts = [];
  for (const chunk of chunks || []) {
    const binary = atob(String(chunk || ""));
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    parts.push(arr);
  }
  return new Blob(parts, { type: mime || "application/octet-stream" });
}

function base64ChunksToText(chunks) {
  const parts = [];
  let total = 0;
  for (const chunk of chunks || []) {
    const binary = atob(String(chunk || ""));
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    parts.push(arr);
    total += arr.length;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(merged);
  } catch {
    let s = "";
    for (const part of parts) {
      for (let i = 0; i < part.length; i++) s += String.fromCharCode(part[i]);
    }
    return s;
  }
}

function shouldIgnoreName(name) {
  const s = String(name || "");
  if (!s) return true;
  if (IGNORE_NAMES.has(s)) return true;
  if (s.endsWith(".log") && s.length > 30) return true;
  return false;
}

async function ensurePermission(handle, mode = "read") {
  try {
    const query = await handle.queryPermission?.({ mode });
    if (!query || query === "granted") return true;
    const request = await handle.requestPermission?.({ mode });
    return request === "granted";
  } catch {
    return true;
  }
}

function formatBytes(size) {
  const n = Number(size || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
function formatDateTime(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch {
    return "";
  }
}

function extensionOf(name) {
  const s = String(name || "");
  const idx = s.lastIndexOf(".");
  return idx >= 0 ? s.slice(idx + 1).toLowerCase() : "";
}

export function languageFromFilename(name) {
  const ext = extensionOf(name);
  const map = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    md: "markdown",
    py: "python",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    css: "css",
    html: "html",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    go: "go",
    rs: "rust",
    java: "java",
    sql: "sql"
  };
  return map[ext] || "text";
}

const filesCodeHighlightStyle = HighlightStyle.define([
  { tag: [cmTags.keyword, cmTags.operatorKeyword], color: "#569cd6" },
  { tag: [cmTags.string, cmTags.special(cmTags.string)], color: "#ce9178" },
  { tag: [cmTags.number, cmTags.bool, cmTags.null], color: "#b5cea8" },
  { tag: [cmTags.comment, cmTags.lineComment, cmTags.blockComment], color: "#6a9955", fontStyle: "italic" },
  { tag: [cmTags.function(cmTags.variableName), cmTags.definition(cmTags.function(cmTags.variableName))], color: "#dcdcaa" },
  { tag: [cmTags.propertyName, cmTags.attributeName], color: "#9cdcfe" },
  { tag: [cmTags.typeName, cmTags.className], color: "#4ec9b0" },
  { tag: [cmTags.tagName, cmTags.angleBracket], color: "#569cd6" },
  { tag: [cmTags.heading, cmTags.heading1, cmTags.heading2, cmTags.heading3, cmTags.heading4, cmTags.heading5, cmTags.heading6], color: "#4ec9b0", fontWeight: "600" },
  { tag: [cmTags.emphasis], fontStyle: "italic", color: "#d7ba7d" },
  { tag: [cmTags.strong], fontWeight: "700", color: "#d7ba7d" },
  { tag: [cmTags.link, cmTags.url], color: "#3794ff", textDecoration: "underline" },
  { tag: [cmTags.monospace], color: "#ce9178" },
  { tag: [cmTags.quote], color: "#608b4e", fontStyle: "italic" },
  { tag: [cmTags.list], color: "#c586c0" },
  { tag: [cmTags.contentSeparator, cmTags.processingInstruction, cmTags.escape], color: "#808080" },
  { tag: [cmTags.punctuation, cmTags.separator], color: "#d4d4d4" }
]);

const filesCodeViewerTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--files-preview-bg, var(--bg))",
    color: "var(--fg)",
    position: "relative"
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--font-mono)"
  },
  ".cm-content, .cm-gutters": {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    lineHeight: "1.55"
  },
  ".cm-content": {
    padding: "6px 0 18px",
    minWidth: "max-content"
  },
  ".cm-line": {
    padding: "0 12px",
    whiteSpace: "pre"
  },
  ".cm-gutters": {
    backgroundColor: "var(--editor-gutter-bg)",
    borderRight: "1px solid var(--editor-gutter-border)",
    color: "var(--editor-gutter-fg)"
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "var(--editor-gutter-active-bg)"
  },
  ".cm-cursor": {
    borderLeftColor: "var(--caret-color)"
  },
  ".cm-panels": {
    backgroundColor: "var(--panel)",
    borderColor: "var(--border)",
    color: "var(--fg)"
  },
  ".cm-panels.cm-panels-top": {
    position: "absolute",
    top: "8px",
    right: "14px",
    left: "auto",
    zIndex: "20",
    maxWidth: "calc(100% - 28px)",
    border: "1px solid var(--border)",
    borderRadius: "3px",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35)",
    overflow: "hidden"
  },
  ".cm-search": {
    display: "flex",
    alignItems: "center",
    gap: "3px",
    minWidth: "408px",
    padding: "4px",
    fontFamily: "var(--font-ui)",
    fontSize: "12px",
    lineHeight: "1",
    backgroundColor: "var(--panel)",
    userSelect: "none"
  },
  ".cm-search input.cm-textfield": {
    width: "220px",
    height: "26px",
    padding: "2px 8px",
    border: "1px solid var(--border)",
    borderRadius: "2px",
    backgroundColor: "var(--bg)",
    color: "var(--fg)",
    outline: "none"
  },
  ".cm-search input.cm-textfield:focus": {
    borderColor: "var(--accent)"
  },
  ".cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    flex: "0 0 24px",
    width: "24px",
    height: "24px",
    minWidth: "24px",
    padding: "0",
    border: "1px solid transparent",
    borderRadius: "2px",
    color: "var(--fg)",
    overflow: "hidden",
    fontSize: "0",
    lineHeight: "0",
    textIndent: "-999px",
    cursor: "pointer"
  },
  ".cm-search label:hover": {
    backgroundColor: "color-mix(in srgb, var(--fg) 8%, transparent)"
  },
  ".cm-search label:has(input:checked)": {
    backgroundColor: "color-mix(in srgb, var(--accent) 16%, transparent)",
    borderColor: "var(--accent)",
    color: "var(--fg)"
  },
  ".cm-search input[type=checkbox]": {
    position: "absolute",
    opacity: "0",
    pointerEvents: "none"
  },
  ".cm-search label:nth-of-type(1)::after": {
    content: '"Aa"',
    position: "absolute",
    inset: "0",
    display: "grid",
    placeItems: "center",
    fontSize: "11px",
    fontWeight: "600",
    lineHeight: "24px",
    textIndent: "0"
  },
  ".cm-search label:nth-of-type(2)::after": {
    content: '".*"',
    position: "absolute",
    inset: "0",
    display: "grid",
    placeItems: "center",
    fontSize: "12px",
    fontWeight: "600",
    lineHeight: "24px",
    textIndent: "0"
  },
  ".cm-search label:nth-of-type(3)::after": {
    content: '"ab"',
    position: "absolute",
    inset: "0",
    display: "grid",
    placeItems: "center",
    fontSize: "11px",
    lineHeight: "24px",
    textDecoration: "underline",
    textIndent: "0"
  },
  ".cm-search button": {
    position: "relative",
    flex: "0 0 24px",
    width: "24px",
    minWidth: "24px",
    height: "24px",
    padding: "0",
    border: "1px solid transparent",
    borderRadius: "2px",
    backgroundColor: "transparent",
    color: "var(--fg)",
    overflow: "hidden",
    fontSize: "0",
    lineHeight: "0",
    textIndent: "-999px"
  },
  ".cm-search button:hover": {
    backgroundColor: "color-mix(in srgb, var(--fg) 8%, transparent)"
  },
  ".cm-search button::before": {
    position: "absolute",
    inset: "0",
    display: "grid",
    placeItems: "center",
    fontSize: "14px",
    lineHeight: "24px",
    textIndent: "0"
  },
  ".cm-search button[name=next]::before": {
    content: '"↓"'
  },
  ".cm-search button[name=prev]::before": {
    content: '"↑"'
  },
  ".cm-search button[name=select]::before": {
    content: '"all"',
    fontSize: "10px",
    fontWeight: "600"
  },
  ".cm-search button[name=close]": {
    marginLeft: "2px",
    padding: "0"
  },
  ".cm-search button[name=close]::before": {
    content: '"×"',
    fontSize: "16px",
    lineHeight: "20px"
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--search-match-bg)"
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "var(--search-current-bg)"
  },
  "&.cm-focused": {
    outline: "none"
  }
});

const filesReadOnlyGuard = EditorState.transactionFilter.of((tr) => tr.docChanged ? [] : tr);
const filesSelectionTheme = Prec.highest(EditorView.theme({
  ".cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--selection-bg) !important"
  },
  "&.cm-focused .cm-selectionLayer .cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--selection-bg) !important"
  },
  ".cm-content ::selection": {
    backgroundColor: "var(--selection-bg) !important",
    color: "inherit"
  }
}));
const filesFindWidgetTheme = Prec.highest(EditorView.theme({
  ".cm-panels.cm-panels-top": {
    background: "var(--panel) !important",
    border: "1px solid var(--border) !important",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35) !important"
  },
  ".cm-search": {
    background: "var(--panel) !important",
    color: "var(--fg) !important"
  },
  ".cm-search input.cm-textfield": {
    appearance: "none",
    WebkitAppearance: "none",
    background: "var(--bg) !important",
    border: "1px solid var(--border) !important",
    color: "var(--fg) !important",
    boxShadow: "none !important"
  },
  ".cm-search input.cm-textfield:focus": {
    borderColor: "var(--accent) !important"
  },
  ".cm-search label, .cm-search button, .cm-search .cm-button": {
    appearance: "none",
    WebkitAppearance: "none",
    background: "transparent !important",
    backgroundImage: "none !important",
    border: "1px solid transparent !important",
    boxShadow: "none !important",
    color: "var(--fg) !important"
  },
  ".cm-search label:hover, .cm-search button:hover, .cm-search .cm-button:hover": {
    background: "color-mix(in srgb, var(--fg) 8%, transparent) !important",
    color: "var(--fg) !important"
  },
  ".cm-search label:has(input:checked)": {
    background: "color-mix(in srgb, var(--accent) 18%, transparent) !important",
    borderColor: "var(--accent) !important",
    color: "var(--fg) !important"
  },
  ".cm-search button:disabled, .cm-search .cm-button:disabled": {
    background: "transparent !important",
    color: "var(--files-muted-fg) !important",
    opacity: "1 !important"
  },
  ".cm-search button:disabled:hover, .cm-search .cm-button:disabled:hover": {
    background: "transparent !important",
    color: "var(--files-muted-fg) !important"
  },
  ".cm-search label::after, .cm-search button::before": {
    color: "inherit !important"
  }
}));

export function createFilesCodeViewer(parent, content, meta) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: content,
      extensions: [
        filesCodeViewerTheme,
        syntaxHighlighting(filesCodeHighlightStyle),
        filesSelectionTheme,
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        rectangularSelection(),
        EditorState.allowMultipleSelections.of(true),
        search({ top: true }),
        highlightSelectionMatches(),
        filesFindWidgetTheme,
        EditorState.readOnly.of(true),
        filesReadOnlyGuard,
        EditorView.contentAttributes.of({
          "aria-readonly": "true",
          spellcheck: "false",
          autocapitalize: "off",
          autocomplete: "off"
        }),
        Prec.highest(keymap.of([...searchKeymap, ...defaultKeymap])),
        initialLanguageExtension(meta)
      ].filter(Boolean)
    })
  });
  loadLanguageExtension(meta).then((extension) => {
    if (!extension) return;
    try { view.dispatch({ effects: StateEffect.appendConfig.of(extension) }); } catch {}
  }).catch(() => {});
  return view;
}

function initialLanguageExtension(meta) {
  const language = String(meta?.language || "").toLowerCase();
  if (language === "json") return json();
  if (language === "markdown") return markdown();
  return null;
}

async function loadLanguageExtension(meta) {
  const language = String(meta?.language || "").toLowerCase();
  if (!language || language === "text" || language === "json" || language === "markdown") return null;
  const filename = String(meta?.title || meta?.path || meta?.displayPath || "");
  const support = languages.find((item) => {
    try {
      if (Array.isArray(item.alias) && item.alias.some((alias) => String(alias).toLowerCase() === language)) return true;
      if (Array.isArray(item.extensions) && item.extensions.includes(extensionOf(filename))) return true;
      return String(item.name || "").toLowerCase() === language;
    } catch {
      return false;
    }
  });
  return support ? await support.load() : null;
}

export function stableFileTabId(node) {
  const raw = `${node.provider || "file"}:${node.sessionId || node.entryId || ""}:${node.path || node.displayPath || node.name || ""}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return `${Math.abs(hash).toString(36)}-${encodeURIComponent(node.name || "file")}`;
}

export function iconForFile(name) {
  const ext = extensionOf(name);
  if (["md", "markdown"].includes(ext)) return "codicon-markdown";
  if (["txt", "log", "csv"].includes(ext)) return "codicon-file-text";
  if (["json", "jsonc"].includes(ext)) return "codicon-json";
  if (["yml", "yaml", "toml", "ini", "env"].includes(ext)) return "codicon-settings";
  if (["js", "jsx", "ts", "tsx", "css", "scss", "html", "xml", "py", "go", "rs", "java", "sql", "sh", "bash", "zsh"].includes(ext)) return "codicon-file-code";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "codicon-file-media";
  if (["zip", "gz", "tar", "tgz", "7z", "rar"].includes(ext)) return "codicon-file-zip";
  if (["lock"].includes(ext) || String(name || "").endsWith("lock")) return "codicon-lock";
  return "codicon-file";
}

function isImageFile(file, name) {
  const type = String(file?.type || "");
  if (type.startsWith("image/")) return true;
  return ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extensionOf(name));
}

function isTextLikeFile(file, name) {
  const type = String(file?.type || "");
  if (type.startsWith("text/")) return true;
  if (["application/json", "application/xml", "application/javascript"].includes(type)) return true;
  return [
    "md", "markdown", "txt", "json", "jsonc", "js", "jsx", "ts", "tsx", "css", "scss", "html", "xml",
    "yml", "yaml", "toml", "ini", "env", "sh", "bash", "zsh", "py", "go", "rs", "java", "c", "cpp",
    "h", "hpp", "sql", "csv", "log"
  ].includes(extensionOf(name));
}

async function copyPath(node, details) {
  try { details.open = false; } catch {}
  const text = node.displayPath || node.name || "";
  try {
    await navigator.clipboard?.writeText?.(text);
    window.showToast?.(t("files.copied", "Path copied"));
  } catch {
    window.showToast?.(text);
  }
}

function t(key, fallback, values) {
  try {
    const translated = window.zion?.i18n?.t?.(`${I18N_NS}.${key}`, values);
    if (translated && translated !== `${I18N_NS}.${key}`) return translated;
  } catch {}
  if (values && typeof values === "object") {
    return String(fallback).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
  }
  return fallback;
}
