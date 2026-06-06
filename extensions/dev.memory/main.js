import { getEditorCore } from "../dev.tools/editor-core.js";
import { createFilesCodeEditor, createFilesCodeViewer, createFilesMarkdownPreview, iconForFile, isMarkdownTab, languageFromFilename, shouldShowMarkdownPreview } from "../dev.tools/files-panel.js";

const VIEW_ID = "dev.memory.panel";
const STORAGE_KEY = "zion.memory.items.v1";
const ACTIVE_KEY = "memory.activeId";
const EXPANDED_KEY = "zion.memory.explorer.expanded";
const SETTINGS_KEY = "zion.memory.settings.v1";
const CHANGED_EVENT = "memory/changed";
const ACTIVE_CHANGED_EVENT = "memory/activeChanged";
const I18N_NS = "dev.memory";
const DEFAULT_MEMORY_ROOT = "~/zion-next/memory";

const I18N_MESSAGES = {
  "zh-CN": {
    "title": "Memory",
    "cmd.openPanel": "打开 Memory",
    "cmd.create": "创建 Memory",
    "cmd.rememberSelection": "记住选区",
    "memory.emptyTitle": "还没有 Memory",
    "memory.emptyDescription": "点击 New 添加项目规则、偏好、架构事实或调试经验。",
    "memory.new": "New",
    "memory.save": "保存",
    "memory.delete": "删除",
    "memory.include": "提供给模型",
    "memory.disable": "从上下文移除",
    "memory.pin": "固定",
    "memory.unpin": "取消固定",
    "memory.search": "搜索 memory...",
    "memory.providers": "Providers",
    "memory.providerLocal": "Local Markdown Files",
    "memory.context": "Context",
    "memory.root": "Root",
    "memory.pathPlaceholder": "long-term/semantic/topic.md",
    "memory.titlePlaceholder": "Memory 标题",
    "memory.bodyPlaceholder": "写下模型以后应该记住的事实、偏好或流程...",
    "memory.tagsPlaceholder": "tags, comma separated",
    "memory.stats": "{working} working · {longTerm} long-term",
    "memory.enabled": "已启用",
    "memory.disabled": "未启用",
    "layer.working": "Working",
    "layer.long-term": "Long-term",
    "type.semantic": "Semantic",
    "type.episodic": "Episodic",
    "type.procedural": "Procedural",
    "type.preference": "Preference",
    "scope.user": "User",
    "scope.project": "Project",
    "scope.workspace": "Workspace",
    "scope.agent": "Agent",
    "design.summary": "Working memory 常驻注入上下文；Long-term memory 通过 Explorer 和 memoryManage 渐进检索。",
    "design.files": "默认 workspace 是 ~/zion-next/memory，Memory 先专注本地 Markdown 文件树。"
  },
  "en-US": {
    "title": "Memory",
    "cmd.openPanel": "Open Memory",
    "cmd.create": "Create Memory",
    "cmd.rememberSelection": "Remember Selection",
    "memory.emptyTitle": "No memories yet",
    "memory.emptyDescription": "Click New to add project rules, preferences, architecture facts, or debugging lessons.",
    "memory.new": "New",
    "memory.save": "Save",
    "memory.delete": "Delete",
    "memory.include": "Include in model context",
    "memory.disable": "Disable in context",
    "memory.pin": "Pin",
    "memory.unpin": "Unpin",
    "memory.search": "Search memory...",
    "memory.providers": "Providers",
    "memory.providerLocal": "Local Markdown Files",
    "memory.context": "Context",
    "memory.root": "Root",
    "memory.pathPlaceholder": "long-term/semantic/topic.md",
    "memory.titlePlaceholder": "Memory title",
    "memory.bodyPlaceholder": "Write facts, preferences, or workflows the model should remember...",
    "memory.tagsPlaceholder": "tags, comma separated",
    "memory.stats": "{working} working · {longTerm} long-term",
    "memory.enabled": "Enabled",
    "memory.disabled": "Disabled",
    "layer.working": "Working",
    "layer.long-term": "Long-term",
    "type.semantic": "Semantic",
    "type.episodic": "Episodic",
    "type.procedural": "Procedural",
    "type.preference": "Preference",
    "scope.user": "User",
    "scope.project": "Project",
    "scope.workspace": "Workspace",
    "scope.agent": "Agent",
    "design.summary": "Working memory is always injected. Long-term memory is browsed and retrieved progressively through the Explorer and memoryManage.",
    "design.files": "The default workspace is ~/zion-next/memory. Memory is focused on the local Markdown file tree for now."
  }
};

const MEMORY_TYPES = ["semantic", "episodic", "procedural", "preference"];
const MEMORY_SCOPES = ["project", "workspace", "user", "agent"];
const MEMORY_LAYERS = ["working", "long-term"];
const providerRegistry = new Map();

function t(key, fallback, values) {
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  let out = fallback;
  if (values && out) {
    for (const [k, v] of Object.entries(values)) out = out.replace(`{${k}}`, String(v));
  }
  return out;
}

function now() {
  return Date.now();
}

function uid() {
  return `mem_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function compactText(value, max = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function slugify(value, fallback = "memory") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function normalizeMemoryPath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .trim() || "long-term/semantic/memory.md";
}

function defaultMemoryPath({ title, type, layer, id } = {}) {
  const name = slugify(title, "memory");
  if (layer === "working") return `working/${name}.md`;
  return `long-term/${type || "semantic"}/${name}-${String(id || uid()).slice(-6)}.md`;
}

function loadExpandedFolders() {
  const parsed = readJson(EXPANDED_KEY, ["working", "long-term"]);
  return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
}

function saveExpandedFolders(expanded) {
  writeJson(EXPANDED_KEY, Array.from(expanded || []).sort());
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function normalizeMemory(item = {}) {
  const id = String(item.id || uid());
  const createdAt = Number(item.createdAt || now());
  const title = String(item.title || "Untitled Memory");
  const type = MEMORY_TYPES.includes(item.type) ? item.type : "semantic";
  const layer = MEMORY_LAYERS.includes(item.layer) ? item.layer : (String(item.path || "").startsWith("working/") ? "working" : "long-term");
  const path = normalizeMemoryPath(item.path || defaultMemoryPath({ title, type, layer, id }));
  return {
    id,
    providerId: String(item.providerId || "local-markdown-files"),
    title,
    content: String(item.content || ""),
    type,
    layer,
    path,
    scope: MEMORY_SCOPES.includes(item.scope) ? item.scope : "project",
    tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag).trim()).filter(Boolean) : parseTags(item.tags),
    enabled: item.enabled !== false,
    pinned: !!item.pinned,
    confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.8))),
    source: String(item.source || ""),
    createdAt,
    updatedAt: Number(item.updatedAt || createdAt)
  };
}

function parseTags(value) {
  return String(value || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function readMemories() {
  const parsed = readJson(STORAGE_KEY, []);
  return Array.isArray(parsed) ? parsed.filter(Boolean).map(normalizeMemory).sort(compareMemories) : [];
}

function writeMemories(list, opts = {}) {
  const safe = Array.isArray(list) ? list.map(normalizeMemory) : [];
  writeJson(STORAGE_KEY, safe);
  syncState(safe);
  if (!opts.silent) emitChanged();
}

function compareMemories(a, b) {
  return String(a.path || "").localeCompare(String(b.path || "")) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
}

function syncState(list = readMemories()) {
  try { window.zion?.state?.set?.("memory.items", list); } catch {}
}

function emitChanged() {
  try { window.zion?.events?.emit?.(CHANGED_EVENT, { items: readMemories() }); } catch {}
  try { window.dispatchEvent(new CustomEvent("zion:memory-changed")); } catch {}
}

function getActiveMemoryId() {
  try { return localStorage.getItem(ACTIVE_KEY) || ""; } catch { return ""; }
}

function setActiveMemory(id, options = {}) {
  const value = String(id || "");
  try { localStorage.setItem(ACTIVE_KEY, value); } catch {}
  try { window.zion?.state?.set?.("memory.activeId", value); } catch {}
  if (options.silent) return;
  try { window.zion?.events?.emit?.(ACTIVE_CHANGED_EVENT, { id: value }); } catch {}
  try { window.dispatchEvent(new CustomEvent("zion:memory-active-changed", { detail: { id: value } })); } catch {}
}

function getSettings() {
  return {
    autoInject: true,
    memoryRootPath: DEFAULT_MEMORY_ROOT,
    maxContextChars: 4000,
    autoInjectLayer: "working",
    includePinnedLongTerm: false,
    ...(readJson(SETTINGS_KEY, {}) || {})
  };
}

function saveSettings(patch) {
  const next = { ...getSettings(), ...(patch || {}) };
  writeJson(SETTINGS_KEY, next);
  emitChanged();
  return next;
}

function createMemory(input = {}) {
  const id = uid();
  const type = input.type || "semantic";
  const layer = input.layer || "long-term";
  const title = input.title || "New Memory";
  const item = normalizeMemory({
    id,
    title,
    content: input.content || "",
    type,
    layer,
    path: input.path || defaultMemoryPath({ title, type, layer, id }),
    scope: input.scope || "project",
    tags: input.tags || [],
    enabled: input.enabled !== false,
    pinned: !!input.pinned,
    source: input.source || "",
    providerId: input.providerId || "local-markdown-files"
  });
  const list = readMemories();
  list.unshift(item);
  writeMemories(list);
  setActiveMemory(item.id);
  return item;
}

function updateMemory(id, patch = {}, opts = {}) {
  const list = readMemories();
  const idx = list.findIndex((item) => item.id === id);
  if (idx < 0) return null;
  const next = normalizeMemory({ ...list[idx], ...patch, updatedAt: now() });
  list[idx] = next;
  writeMemories(list, opts);
  return next;
}

function deleteMemory(id) {
  const list = readMemories().filter((item) => item.id !== id);
  writeMemories(list);
  if (getActiveMemoryId() === id) setActiveMemory(list[0]?.id || "");
}

function searchMemories(query = "", opts = {}) {
  const text = String(query || "").trim().toLowerCase();
  const includeDisabled = !!opts.includeDisabled;
  const layer = String(opts.layer || "").trim();
  return readMemories().filter((item) => {
    if (!includeDisabled && item.enabled === false) return false;
    if (layer && item.layer !== layer) return false;
    if (!text) return true;
    return [
      item.path,
      item.title,
      item.content,
      item.type,
      item.layer,
      item.scope,
      ...(item.tags || [])
    ].join("\n").toLowerCase().includes(text);
  });
}

function extractLatestUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (item?.role !== "user") continue;
    const content = item.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => part?.text || part?.content || "").join("\n");
  }
  return "";
}

function scoreMemory(item, query) {
  let score = 0;
  if (item.pinned) score += 40;
  if (item.enabled) score += 10;
  score += Math.floor((item.confidence || 0) * 10);
  const q = String(query || "").toLowerCase();
  if (!q) return score;
  const hay = `${item.title}\n${item.tags?.join(" ")}\n${item.content}`.toLowerCase();
  for (const token of q.split(/[^a-z0-9_\-\u4e00-\u9fa5]+/i).filter((x) => x.length > 2).slice(0, 32)) {
    if (hay.includes(token)) score += item.title.toLowerCase().includes(token) ? 8 : 3;
  }
  return score;
}

function selectMemoriesForContext(query = "", opts = {}) {
  const settings = getSettings();
  const maxItems = Number(opts.maxItems || 12);
  const layer = String(opts.layer || settings.autoInjectLayer || "working");
  return readMemories()
    .filter((item) => item.enabled !== false)
    .filter((item) => item.layer === layer || (!!settings.includePinnedLongTerm && item.pinned))
    .map((item) => ({ item, score: scoreMemory(item, query) }))
    .sort((a, b) => b.score - a.score || compareMemories(a.item, b.item))
    .slice(0, maxItems)
    .map((entry) => entry.item);
}

function buildMemoryContext(query = "", opts = {}) {
  const settings = getSettings();
  const items = selectMemoriesForContext(query, opts);
  const maxChars = Math.max(800, Number(opts.maxChars || settings.maxContextChars || 5000));
  const parts = [
    "## Zion Working Memory",
    `Root: ${settings.memoryRootPath || DEFAULT_MEMORY_ROOT}`,
    "The following notes are working memory and are intentionally kept in the model context. Long-term memory lives under the same root and should be retrieved on demand with memoryManage search/read."
  ];
  for (const item of items) {
    const tags = item.tags?.length ? ` tags=${item.tags.join(",")}` : "";
    parts.push(`\n### ${item.title}\n- path: ${item.path}\n- id: ${item.id}\n- type: ${item.type}; scope: ${item.scope}; layer: ${item.layer}; provider: ${item.providerId}${tags}\n${item.content.trim()}`);
  }
  let text = parts.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 32)}\n\n[Memory truncated]`;
  return { text, items, maxChars };
}

function registerDefaultProviders() {
  registerProvider({
    id: "local-markdown-files",
    label: t("memory.providerLocal", "Local Markdown Files"),
    kind: "local",
    writable: true,
    description: `Built-in Markdown file workspace rooted at ${DEFAULT_MEMORY_ROOT}. Stored in browser localStorage until a real file provider is attached.`,
    capabilities: ["list", "tree", "read", "search", "create", "update", "delete", "context"]
  });
}

function registerProvider(provider = {}) {
  const id = String(provider.id || "").trim();
  if (!id) return { dispose() {} };
  const normalized = {
    id,
    label: String(provider.label || id),
    kind: String(provider.kind || "external"),
    writable: !!provider.writable,
    disabled: !!provider.disabled,
    description: String(provider.description || ""),
    capabilities: Array.isArray(provider.capabilities) ? provider.capabilities.map(String) : [],
    list: provider.list,
    search: provider.search,
    read: provider.read,
    write: provider.write,
    delete: provider.delete
  };
  providerRegistry.set(id, normalized);
  emitChanged();
  return {
    dispose() {
      if (providerRegistry.get(id) === normalized) {
        providerRegistry.delete(id);
        emitChanged();
      }
    }
  };
}

function listProviders() {
  return Array.from(providerRegistry.values()).sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled) || a.label.localeCompare(b.label));
}

function exportMarkdown(items = readMemories()) {
  return (Array.isArray(items) ? items : []).map((item) => [
    `# ${item.title}`,
    "",
    `<!-- zion-memory id=${item.id} path="${item.path}" layer=${item.layer} type=${item.type} scope=${item.scope} provider=${item.providerId} enabled=${item.enabled} pinned=${item.pinned} tags="${(item.tags || []).join(",")}" -->`,
    "",
    item.content || ""
  ].join("\n")).join("\n\n---\n\n");
}

function importMarkdown(markdown, opts = {}) {
  const title = opts.title || firstHeading(markdown) || "Imported Memory";
  return createMemory({
    title,
    content: String(markdown || "").trim(),
    type: opts.type || "semantic",
    layer: opts.layer || "long-term",
    path: opts.path,
    scope: opts.scope || "project",
    tags: opts.tags || ["imported"],
    source: opts.source || "markdown-import"
  });
}

function firstHeading(markdown) {
  const line = String(markdown || "").split(/\r?\n/).find((item) => /^#\s+/.test(item));
  return line ? line.replace(/^#\s+/, "").trim() : "";
}

function openMemoryPanel() {
  try { window.zion?.auxiliaryBar?.setWidth?.(Math.max(760, window.zion.state?.get?.("ui.auxiliaryBar.width") || 0)); } catch {}
  try { window.zion?.auxiliaryBar?.activateView?.(VIEW_ID); } catch {}
}

function rememberSelection() {
  const editor = window.zion?.window?.activeEditor;
  const view = editor?.getView?.();
  const sel = view?.state?.selection?.main;
  if (!view || !sel || sel.from === sel.to) return createMemory({ title: "New Memory" });
  const text = view.state.sliceDoc(sel.from, sel.to);
  const item = createMemory({
    title: compactText(text, 48) || "Selection Memory",
    content: text,
    type: "semantic",
    scope: "project",
    tags: ["selection"],
    source: "selection"
  });
  openMemoryPanel();
  return item;
}

function buildMemoryTree(items) {
  const root = { kind: "directory", key: "", name: getSettings().memoryRootPath || DEFAULT_MEMORY_ROOT, path: "", children: new Map(), items: [] };
  for (const item of Array.isArray(items) ? items : []) {
    const parts = normalizeMemoryPath(item.path).split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      if (isFile) {
        const file = { kind: "file", key: `file:${item.id}`, name: part, path, item };
        node.items.push(file);
      } else {
        const key = `dir:${path}`;
        if (!node.children.has(part)) node.children.set(part, { kind: "directory", key, name: part, path, children: new Map(), items: [] });
        node = node.children.get(part);
      }
    }
  }
  return root;
}

function flattenMemoryTree(node, expanded, depth = 0, out = []) {
  const folders = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
  const files = node.items.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const folder of folders) {
    out.push({ ...folder, depth });
    if (expanded.has(folder.path)) flattenMemoryTree(folder, expanded, depth + 1, out);
  }
  for (const file of files) out.push({ ...file, depth });
  return out;
}

function memoryDisplayPath(item) {
  const root = getSettings().memoryRootPath || DEFAULT_MEMORY_ROOT;
  return `${root.replace(/\/$/, "")}/${normalizeMemoryPath(item?.path)}`;
}

function memoryFileName(item) {
  const parts = normalizeMemoryPath(item?.path).split("/").filter(Boolean);
  return parts[parts.length - 1] || item?.title || "memory.md";
}

function renderMemoryPanel(container) {
  const root = document.createElement("div");
  root.className = "zion-memory-panel";
  container.appendChild(root);
  let disposed = false;
  let renderTimer = 0;
  let memoryEditorView = null;
  let memoryEditorItemId = "";
  let memoryEditorSaveTimer = 0;
  let memoryEditorDirty = false;
  let memoryObjectUrl = "";
  const editorCore = getEditorCore();
  const openMemoryTabs = editorCore.tabs;
  let activeMemoryTabId = editorCore.getActiveTabId();
  let explorerWidth = editorCore.getExplorerWidth();
  const expanded = loadExpandedFolders();
  const disposables = [];

  const scheduleRender = () => {
    if (disposed) return;
    if (renderTimer) window.cancelAnimationFrame(renderTimer);
    renderTimer = window.requestAnimationFrame(() => {
      renderTimer = 0;
      render();
    });
  };

  try { disposables.push(window.zion?.events?.on?.(CHANGED_EVENT, scheduleRender)); } catch {}
  try { disposables.push(window.zion?.events?.on?.(ACTIVE_CHANGED_EVENT, ({ id } = {}) => openMemoryById(id))); } catch {}
  try { disposables.push(window.zion?.events?.on?.("i18n/changed", scheduleRender)); } catch {}
  disposables.push(editorCore.subscribe(() => {
    activeMemoryTabId = editorCore.getActiveTabId();
    explorerWidth = editorCore.getExplorerWidth();
    scheduleRender();
  }));
  try {
    const onChanged = () => scheduleRender();
    window.addEventListener("zion:memory-changed", onChanged);
    disposables.push({ dispose: () => window.removeEventListener("zion:memory-changed", onChanged) });
  } catch {}
  try {
    const onActiveChanged = (event) => openMemoryById(event?.detail?.id);
    window.addEventListener("zion:memory-active-changed", onActiveChanged);
    disposables.push({ dispose: () => window.removeEventListener("zion:memory-active-changed", onActiveChanged) });
  } catch {}

  render();

  return {
    dispose() {
      disposed = true;
      if (renderTimer) window.cancelAnimationFrame(renderTimer);
      disposeMemoryEditor(true);
      for (const d of disposables.splice(0)) {
        try { d?.dispose?.(); } catch {}
      }
      try { root.remove(); } catch {}
    }
  };

  function render() {
    disposeMemoryEditor(true);
    const all = readMemories();
    syncOpenMemoryTabs(all);
    ensureActiveMemoryTab(all);
    const activeTab = resolveEditorTab(editorCore.getActiveTab() || openMemoryTabs.values().next().value || null);
    const activeMemory = activeTab?.kind === "memory" ? activeTab.memory : null;
    const body = document.createElement("div");
    body.className = "zion-memory-body";
    const list = renderList(all, activeMemory?.id || "");
    list.style.flexBasis = `${explorerWidth}px`;
    body.appendChild(list);
    body.appendChild(renderResizeHandle(body, list));
    body.appendChild(renderDetail(activeTab));
    root.replaceChildren(body);
  }

  function disposeMemoryEditor(flush = false) {
    if (memoryEditorSaveTimer) {
      window.clearTimeout(memoryEditorSaveTimer);
      memoryEditorSaveTimer = 0;
    }
    if (flush && memoryEditorDirty && memoryEditorView && memoryEditorItemId) {
      try { updateMemory(memoryEditorItemId, { content: memoryEditorView.state.doc.toString() }, { silent: true }); } catch {}
    }
    try { memoryEditorView?.destroy?.(); } catch {}
    try { if (memoryObjectUrl) URL.revokeObjectURL(memoryObjectUrl); } catch {}
    memoryEditorView = null;
    memoryEditorItemId = "";
    memoryEditorDirty = false;
    memoryObjectUrl = "";
  }

  function syncOpenMemoryTabs(items) {
    const ids = new Set((Array.isArray(items) ? items : []).map((item) => item.id));
    for (const tab of Array.from(openMemoryTabs.values())) {
      if (tab.kind === "memory" && !ids.has(tab.memoryId)) editorCore.closeTab(tab.id, { reason: "memory-sync" });
    }
    if (activeMemoryTabId && !openMemoryTabs.has(activeMemoryTabId)) {
      activeMemoryTabId = editorCore.getActiveTabId();
    }
  }

  function ensureActiveMemoryTab(items) {
    if (openMemoryTabs.size) return;
    const activeId = getActiveMemoryId();
    if (!activeId) return;
    const item = (Array.isArray(items) ? items : []).find((entry) => entry.id === activeId);
    if (!item) return;
    openMemoryTab(item);
  }

  function openMemoryById(id) {
    const item = readMemories().find((entry) => entry.id === id);
    if (!item) return;
    openMemoryTab(item);
    scheduleRender();
  }

  function openMemoryTab(item) {
    if (!item?.id) return;
    const tabId = `memory:${item.id}`;
    editorCore.openTab({
      id: tabId,
      kind: "memory",
      memoryId: item.id,
      title: memoryFileName(item),
      path: item.path || item.title || "memory.md",
      displayPath: memoryDisplayPath(item),
      language: languageFromFilename(item.path || "memory.md"),
      size: typeof item.content === "string" ? item.content.length : 0
    });
    activeMemoryTabId = editorCore.getActiveTabId();
    setActiveMemory(item.id, { silent: true });
  }

  function closeMemoryTab(id) {
    const raw = String(id || "");
    const tabId = openMemoryTabs.has(raw) ? raw : `memory:${raw}`;
    if (tabId === activeMemoryTabId) disposeMemoryEditor(true);
    editorCore.closeTab(tabId);
    activeMemoryTabId = editorCore.getActiveTabId();
    const activeTab = resolveEditorTab(editorCore.getActiveTab());
    if (activeTab?.kind === "memory") setActiveMemory(activeTab.memoryId, { silent: true });
    else setActiveMemory("", { silent: true });
    scheduleRender();
  }

  function renderResizeHandle(workspace, explorer) {
    const handle = document.createElement("div");
    handle.className = "zion-memory-split-resizer";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.title = "Resize Memory Explorer";
    handle.onpointerdown = (event) => {
      event.preventDefault();
      const pointerId = event.pointerId;
      try { handle.setPointerCapture(pointerId); } catch {}
      root.classList.add("is-resizing-memory");
      const move = (moveEvent) => {
        const rect = workspace.getBoundingClientRect();
        const max = Math.max(220, rect.width - 280);
        const next = Math.max(180, Math.min(max, moveEvent.clientX - rect.left));
        explorerWidth = editorCore.setExplorerWidth(next, { silent: true });
        explorer.style.flexBasis = `${explorerWidth}px`;
      };
      const stop = () => {
        root.classList.remove("is-resizing-memory");
        editorCore.notify("resize");
        try { handle.releasePointerCapture(pointerId); } catch {}
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
    };
    return handle;
  }

  function renderList(items, activeId) {
    const wrap = document.createElement("div");
    wrap.className = "zion-memory-list-wrap zion-files-explorer";
    const toolbar = document.createElement("div");
    toolbar.className = "zion-memory-list-toolbar";
    const spacer = document.createElement("div");
    spacer.className = "zion-memory-list-title";
    spacer.textContent = "Memory";
    const add = iconButton("add", () => {
      const item = createMemory({ title: "New Memory", content: "", type: "semantic", layer: "long-term", scope: "project" });
      openMemoryTab(item);
      scheduleRender();
    }, t("memory.new", "New"));
    toolbar.appendChild(spacer);
    toolbar.appendChild(add);
    wrap.appendChild(toolbar);
    const list = document.createElement("div");
    list.className = "zion-files-scroll zion-memory-files-scroll";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "zion-memory-empty";
      empty.innerHTML = `<b>${escapeHtml(t("memory.emptyTitle", "No memories yet"))}</b><span>${escapeHtml(t("memory.emptyDescription", ""))}</span>`;
      list.appendChild(empty);
      wrap.appendChild(list);
      return wrap;
    }
    const tree = document.createElement("div");
    tree.className = "zion-files-tree";
    tree.setAttribute("role", "tree");
    const rows = flattenMemoryTree(buildMemoryTree(items), expanded);
    for (const node of rows) {
      if (node.kind === "directory") {
        const row = document.createElement("div");
        row.className = "zion-files-row is-directory";
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-expanded", expanded.has(node.path) ? "true" : "false");
        row.dataset.depth = String(node.depth);
        row.style.setProperty("--depth", String(node.depth));
        row.title = node.path;
        const main = document.createElement("button");
        main.type = "button";
        main.className = "zion-files-row-main";
        main.onclick = () => {
          if (expanded.has(node.path)) expanded.delete(node.path);
          else expanded.add(node.path);
          saveExpandedFolders(expanded);
          scheduleRender();
        };
        main.innerHTML = [
          `<span class="zion-files-chevron codicon ${expanded.has(node.path) ? "codicon-chevron-down" : "codicon-chevron-right"}" aria-hidden="true"></span>`,
          `<span class="zion-files-icon codicon ${expanded.has(node.path) ? "codicon-folder-opened" : "codicon-folder"}" aria-hidden="true"></span>`,
          `<span class="zion-files-name">${escapeHtml(node.name)}</span>`
        ].join("");
        row.appendChild(main);
        tree.appendChild(row);
        continue;
      }
      const item = node.item;
      const row = document.createElement("div");
      row.className = `zion-files-row is-file${item.id === activeId ? " is-active" : ""}${item.enabled === false ? " is-disabled" : ""}`;
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-selected", item.id === activeId ? "true" : "false");
      row.dataset.depth = String(node.depth);
      row.style.setProperty("--depth", String(node.depth));
      row.title = memoryDisplayPath(item);
      const main = document.createElement("button");
      main.type = "button";
      main.className = "zion-files-row-main";
      main.onclick = () => {
        openMemoryTab(item);
        scheduleRender();
      };
      main.innerHTML = [
        `<span class="zion-files-chevron" aria-hidden="true"></span>`,
        `<span class="zion-files-icon codicon ${iconForFile(node.name || item.path)}" aria-hidden="true"></span>`,
        `<span class="zion-files-name">${escapeHtml(node.name || item.title || item.id)}</span>`
      ].join("");
      row.appendChild(main);
      tree.appendChild(row);
    }
    list.appendChild(tree);
    wrap.appendChild(list);
    return wrap;
  }

  function renderDetail(tab) {
    const detail = document.createElement("div");
    detail.className = "zion-memory-detail zion-files-preview-pane";
    if (openMemoryTabs.size) detail.appendChild(renderMemoryTabs());
    if (!tab) {
      detail.appendChild(renderMemoryEmptyEditor());
      return detail;
    }

    detail.appendChild(renderEditorPreviewHeader(tab));
    const editorHost = document.createElement("div");
    editorHost.className = "zion-memory-code-editor zion-files-preview-content";
    const codeHost = document.createElement("div");
    codeHost.className = "zion-files-preview-code-host";
    editorHost.appendChild(codeHost);
    if (tab.kind === "memory") {
      const item = tab.memory;
      if (shouldShowMarkdownPreview(tab)) {
        createFilesMarkdownPreview(codeHost, item.content || "");
        detail.appendChild(editorHost);
        detail.appendChild(renderMemoryDetails(item));
        return detail;
      }
      memoryEditorItemId = item.id;
      memoryEditorView = createFilesCodeEditor(codeHost, item.content || "", {
        title: item.path || item.title,
        path: item.path,
        displayPath: memoryDisplayPath(item),
        language: languageFromFilename(item.path || `${item.title}.md`),
        size: item.content?.length || 0
      }, (value) => {
        memoryEditorDirty = true;
        if (memoryEditorSaveTimer) window.clearTimeout(memoryEditorSaveTimer);
        memoryEditorSaveTimer = window.setTimeout(() => {
          memoryEditorSaveTimer = 0;
          memoryEditorDirty = false;
          updateMemory(item.id, { content: value }, { silent: true });
        }, 250);
      });
      codeHost.addEventListener("focusout", () => {
        if (memoryEditorSaveTimer) {
          window.clearTimeout(memoryEditorSaveTimer);
          memoryEditorSaveTimer = 0;
        }
        memoryEditorDirty = false;
        updateMemory(item.id, { content: memoryEditorView?.state?.doc?.toString?.() || "" });
      });
      detail.appendChild(editorHost);
      detail.appendChild(renderMemoryDetails(item));
      return detail;
    }

    if (tab.file?.kind === "text") {
      if (shouldShowMarkdownPreview(tab)) createFilesMarkdownPreview(codeHost, String(tab.file.content || ""));
      else memoryEditorView = createFilesCodeViewer(codeHost, String(tab.file.content || ""), tab);
    } else if (tab.file?.kind === "image" && tab.file.blob instanceof Blob) {
      const img = document.createElement("img");
      img.className = "zion-files-preview-image";
      memoryObjectUrl = URL.createObjectURL(tab.file.blob);
      img.src = memoryObjectUrl;
      img.alt = tab.title;
      codeHost.replaceChildren(img);
    } else {
      const empty = document.createElement("div");
      empty.className = "zion-files-preview-empty";
      if (tab.file?.kind === "loading") empty.textContent = "Opening file...";
      else if (tab.file?.kind === "error") empty.textContent = tab.file.message || "Failed to open file";
      else empty.textContent = "Binary preview is not supported yet";
      codeHost.replaceChildren(empty);
    }
    detail.appendChild(editorHost);
    return detail;
  }

  function resolveEditorTab(tab) {
    if (!tab) return null;
    if (tab.kind !== "memory") return tab;
    const item = readMemories().find((entry) => entry.id === tab.memoryId);
    if (!item) return null;
    return {
      ...tab,
      title: memoryFileName(item),
      path: item.path || item.title || "memory.md",
      displayPath: memoryDisplayPath(item),
      language: languageFromFilename(item.path || "memory.md"),
      size: typeof item.content === "string" ? item.content.length : 0,
      memory: item,
      file: { kind: "memory-text", content: item.content || "" }
    };
  }

  function renderEditorPreviewHeader(tab) {
    if (tab.kind === "memory") return renderMemoryPreviewHeader(tab.memory);
    const header = document.createElement("div");
    header.className = "zion-files-preview-header";
    const icon = document.createElement("span");
    icon.className = `zion-files-preview-header-icon codicon ${iconForFile(tab.title || tab.path)}`;
    icon.setAttribute("aria-hidden", "true");
    const breadcrumb = document.createElement("div");
    breadcrumb.className = "zion-files-preview-breadcrumb";
    breadcrumb.title = tab.displayPath || tab.path || tab.title;
    const parts = String(tab.displayPath || tab.path || tab.title || "").split(/[\\/]+/).filter(Boolean).slice(-4);
    parts.forEach((part, index) => {
      const seg = document.createElement("span");
      seg.className = `zion-files-preview-breadcrumb-segment${index === parts.length - 1 ? " is-current" : ""}`;
      seg.textContent = part;
      breadcrumb.appendChild(seg);
      if (index < parts.length - 1) {
        const sep = document.createElement("span");
        sep.className = "zion-files-preview-breadcrumb-separator codicon codicon-chevron-right";
        sep.setAttribute("aria-hidden", "true");
        breadcrumb.appendChild(sep);
      }
    });
    const meta = document.createElement("div");
    meta.className = "zion-files-preview-meta";
    meta.textContent = [typeof tab.size === "number" ? `${tab.size} B` : "", tab.language && tab.language !== "text" ? tab.language : ""].filter(Boolean).join(" · ");
    header.appendChild(icon);
    header.appendChild(breadcrumb);
    if (meta.textContent) header.appendChild(meta);
    if (isMarkdownTab(tab)) header.appendChild(renderMarkdownPreviewToggle(tab));
    return header;
  }

  function renderMarkdownPreviewToggle(tab) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `zion-files-preview-mode-button${shouldShowMarkdownPreview(tab) ? " is-active" : ""}`;
    button.title = shouldShowMarkdownPreview(tab) ? "Disable Markdown preview" : "Preview Markdown";
    const icon = document.createElement("span");
    icon.className = "codicon codicon-eye";
    icon.setAttribute("aria-hidden", "true");
    button.appendChild(icon);
    button.onclick = () => {
      editorCore.updateTab(tab.id, { markdownPreview: !shouldShowMarkdownPreview(tab) }, { reason: "markdown-preview" });
    };
    return button;
  }

  function renderMemoryTabs() {
    const tabs = document.createElement("div");
    tabs.className = "zion-files-preview-tabs";
    for (const rawTab of openMemoryTabs.values()) {
      const tab = resolveEditorTab(rawTab);
      if (!tab) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `zion-files-preview-tab${tab.id === activeMemoryTabId ? " is-active" : ""}`;
      button.title = tab.displayPath || tab.path || tab.title;
      button.dataset.tabId = tab.id;
      button.onclick = () => {
        activeMemoryTabId = editorCore.setActiveTab(tab.id);
        if (tab.kind === "memory") setActiveMemory(tab.memoryId, { silent: true });
        scheduleRender();
      };
      button.onauxclick = (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        closeMemoryTab(tab.id);
      };
      const icon = document.createElement("span");
      icon.className = `zion-files-preview-tab-icon codicon ${tab.kind === "memory" ? "codicon-database" : iconForFile(tab.title || tab.path)}`;
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "zion-files-preview-tab-label";
      label.textContent = tab.title || memoryFileName(tab.memory);
      const close = document.createElement("span");
      close.className = "zion-files-preview-tab-close codicon codicon-close";
      close.setAttribute("aria-hidden", "true");
      close.title = "Close";
      close.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeMemoryTab(tab.id);
      };
      button.appendChild(icon);
      button.appendChild(label);
      button.appendChild(close);
      tabs.appendChild(button);
    }
    return tabs;
  }

  function renderMemoryEmptyEditor() {
    const empty = document.createElement("div");
    empty.className = "zion-memory-editor-empty";
    empty.innerHTML = `<b>${escapeHtml(t("memory.emptyTitle", "No memories yet"))}</b><span>${escapeHtml(t("memory.emptyDescription", ""))}</span>`;
    return empty;
  }

  function renderMemoryPreviewHeader(item) {
    const header = document.createElement("div");
    header.className = "zion-files-preview-header";
    const icon = document.createElement("span");
    icon.className = `zion-files-preview-header-icon codicon ${iconForFile(item.path || item.title)}`;
    icon.setAttribute("aria-hidden", "true");
    const breadcrumb = document.createElement("div");
    breadcrumb.className = "zion-files-preview-breadcrumb";
    breadcrumb.title = memoryDisplayPath(item);
    const parts = normalizeMemoryPath(item.path).split("/").filter(Boolean).slice(-4);
    parts.forEach((part, index) => {
      const seg = document.createElement("span");
      seg.className = `zion-files-preview-breadcrumb-segment${index === parts.length - 1 ? " is-current" : ""}`;
      seg.textContent = part;
      breadcrumb.appendChild(seg);
      if (index < parts.length - 1) {
        const sep = document.createElement("span");
        sep.className = "zion-files-preview-breadcrumb-separator codicon codicon-chevron-right";
        sep.setAttribute("aria-hidden", "true");
        breadcrumb.appendChild(sep);
      }
    });
    const meta = document.createElement("div");
    meta.className = "zion-files-preview-meta";
    meta.textContent = [providerLabel(item.providerId), item.layer, item.type].filter(Boolean).join(" · ");
    const actions = document.createElement("div");
    actions.className = "zion-memory-preview-actions";
    actions.appendChild(iconButton(item.enabled === false ? "eye" : "check", () => {
      updateMemory(item.id, { enabled: item.enabled === false });
      scheduleRender();
    }, item.enabled === false ? t("memory.include", "Include in model context") : t("memory.disable", "Disable in context"), item.enabled === false ? "" : "primary"));
    actions.appendChild(iconButton("pin", () => {
      updateMemory(item.id, { pinned: !item.pinned });
      scheduleRender();
    }, item.pinned ? t("memory.unpin", "Unpin") : t("memory.pin", "Pin"), item.pinned ? "primary" : ""));
    header.appendChild(icon);
    header.appendChild(breadcrumb);
    header.appendChild(meta);
    if (isMarkdownTab({ path: item.path, title: item.title, language: "markdown", markdownPreview: editorCore.getTab(`memory:${item.id}`)?.markdownPreview })) {
      header.appendChild(renderMarkdownPreviewToggle(editorCore.getTab(`memory:${item.id}`) || { id: `memory:${item.id}`, path: item.path, title: item.title, language: "markdown" }));
    }
    header.appendChild(actions);
    return header;
  }

  function renderMemoryDetails(item) {
    const details = document.createElement("details");
    details.className = "zion-memory-details";
    const summary = document.createElement("summary");
    summary.className = "zion-memory-details-summary";
    const label = document.createElement("span");
    label.className = "zion-memory-details-label";
    label.textContent = "Memory Details";
    const chips = document.createElement("span");
    chips.className = "zion-memory-details-chips";
    const tagValues = (item.tags || []).filter(Boolean).slice(0, 6);
    if (tagValues.length) {
      for (const value of tagValues) chips.appendChild(memoryChip(value));
    } else {
      chips.appendChild(memoryChip("No tags", "empty"));
    }
    summary.appendChild(label);
    summary.appendChild(chips);
    details.appendChild(summary);

    const actions = document.createElement("div");
    actions.className = "zion-memory-details-actions";
    actions.appendChild(iconButton(item.enabled === false ? "eye" : "check", () => {
      updateMemory(item.id, { enabled: item.enabled === false });
      scheduleRender();
    }, item.enabled === false ? t("memory.include", "Include in model context") : t("memory.disable", "Disable in context"), item.enabled === false ? "" : "primary"));
    actions.appendChild(iconButton("pin", () => {
      updateMemory(item.id, { pinned: !item.pinned });
      scheduleRender();
    }, item.pinned ? t("memory.unpin", "Unpin") : t("memory.pin", "Pin"), item.pinned ? "primary" : ""));
    actions.appendChild(iconButton("trash", () => {
      closeMemoryTab(item.id);
      deleteMemory(item.id);
      scheduleRender();
    }, t("memory.delete", "Delete"), "danger"));
    details.appendChild(actions);

    const form = document.createElement("div");
    form.className = "zion-memory-details-form";
    const title = document.createElement("input");
    title.className = "zion-memory-title-input";
    title.placeholder = t("memory.titlePlaceholder", "Memory title");
    title.value = item.title;
    title.onchange = () => updateMemory(item.id, { title: title.value });
    const row = document.createElement("div");
    row.className = "zion-memory-field-row";
    row.appendChild(selectField(item.layer, MEMORY_LAYERS, (value) => updateMemory(item.id, { layer: value, path: defaultMemoryPath({ title: item.title, type: item.type, layer: value, id: item.id }) }), (value) => t(`layer.${value}`, value)));
    row.appendChild(selectField(item.type, MEMORY_TYPES, (value) => updateMemory(item.id, { type: value }), (value) => t(`type.${value}`, value)));
    row.appendChild(selectField(item.scope, MEMORY_SCOPES, (value) => updateMemory(item.id, { scope: value }), (value) => t(`scope.${value}`, value)));
    const path = document.createElement("input");
    path.className = "zion-memory-path-input";
    path.placeholder = t("memory.pathPlaceholder", "long-term/semantic/topic.md");
    path.value = item.path;
    path.onchange = () => updateMemory(item.id, { path: normalizeMemoryPath(path.value), layer: normalizeMemoryPath(path.value).startsWith("working/") ? "working" : item.layer });
    const tags = document.createElement("input");
    tags.className = "zion-memory-tags-input";
    tags.placeholder = t("memory.tagsPlaceholder", "tags, comma separated");
    tags.value = (item.tags || []).join(", ");
    tags.onchange = () => updateMemory(item.id, { tags: parseTags(tags.value) });
    form.appendChild(title);
    form.appendChild(row);
    form.appendChild(path);
    form.appendChild(tags);
    details.appendChild(form);

    const context = document.createElement("pre");
    context.className = "zion-memory-details-context";
    context.textContent = buildMemoryContext(item.title, { maxItems: 4, maxChars: 2400 }).text;
    details.appendChild(context);
    return details;
  }

  function memoryChip(label, tone = "") {
    const chip = document.createElement("span");
    chip.className = `zion-memory-chip${tone ? ` ${tone}` : ""}`;
    chip.textContent = label;
    return chip;
  }

}

function providerLabel(providerId) {
  return providerRegistry.get(providerId)?.label || providerId || "Provider";
}

function selectField(value, options, onChange, labelOf = (x) => x) {
  const select = document.createElement("select");
  select.value = value;
  select.innerHTML = options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(labelOf(option))}</option>`).join("");
  select.onchange = () => onChange(select.value);
  return select;
}

function iconButton(icon, onClick, title = "", tone = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `zion-memory-action${tone ? ` ${tone}` : ""}`;
  button.innerHTML = iconSvg(icon);
  button.title = title || icon;
  button.setAttribute("aria-label", title || icon);
  button.onclick = (event) => {
    try { onClick?.(event); } catch (err) { console.error("[memory] action failed", err); }
  };
  return button;
}

function iconSvg(name) {
  const paths = {
    add: `<path d="M12 5v14"></path><path d="M5 12h14"></path>`,
    check: `<path d="M20 6 9 17l-5-5"></path>`,
    edit: `<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>`,
    eye: `<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"></path><path d="M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"></path>`,
    more: `<path d="M12 6h.01"></path><path d="M12 12h.01"></path><path d="M12 18h.01"></path>`,
    pin: `<path d="m15 4 5 5-4 1-4 7-2-2 7-4 1-4-5-5z"></path><path d="m9 15-5 5"></path>`,
    trash: `<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M6 6l1 14h10l1-14"></path><path d="M10 11v5"></path><path d="M14 11v5"></path>`
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.check}</svg>`;
}

function installMemoryApi() {
  window.zion = window.zion || {};
  const api = {
    registerProvider,
    listProviders,
    listMemories: readMemories,
    getMemory: (id) => readMemories().find((item) => item.id === id) || null,
    getMemoryByPath: (path) => {
      const normalized = normalizeMemoryPath(path);
      return readMemories().find((item) => item.path === normalized) || null;
    },
    getRootPath: () => getSettings().memoryRootPath || DEFAULT_MEMORY_ROOT,
    createMemory,
    updateMemory,
    deleteMemory,
    search: searchMemories,
    buildContext: buildMemoryContext,
    importMarkdown,
    exportMarkdown,
    getSettings,
    saveSettings,
    setActiveMemory,
    openMemory: (id) => {
      setActiveMemory(id);
      openMemoryPanel();
    },
    getActiveMemory: () => readMemories().find((item) => item.id === getActiveMemoryId()) || null
  };
  const previous = window.zion.memory;
  window.zion.memory = api;
  syncState();
  return {
    dispose() {
      try {
        if (window.zion.memory === api) {
          if (previous) window.zion.memory = previous;
          else delete window.zion.memory;
        }
      } catch {}
    }
  };
}

function registerMessageContributor(disposables) {
  const disp = window.zion?.messages?.registerContributor?.({
    id: "dev.memory.context",
    order: 80,
    stage: "pre",
    contribute: async (messages) => {
      const settings = getSettings();
      if (settings.autoInject === false) return messages;
      const query = extractLatestUserText(messages);
      const context = buildMemoryContext(query);
      if (!context.items.length) return messages;
      return [
        { role: "system", content: context.text },
        ...messages
      ];
    }
  });
  if (disp) disposables.push(disp);
}

function registerMemoryTool(disposables) {
  const tool = {
    type: "function",
    function: {
      name: "memoryManage",
      description: "管理 Zion Memory：列出、搜索、创建、更新、删除、选择、构建注入上下文，以及查看可接入的 memory providers。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "tree", "read", "search", "create", "update", "delete", "select", "build_context", "providers", "open_panel", "settings"]
          },
          id: { type: "string" },
          path: { type: "string" },
          query: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          layer: { type: "string", enum: MEMORY_LAYERS },
          type: { type: "string", enum: MEMORY_TYPES },
          scope: { type: "string", enum: MEMORY_SCOPES },
          tags: { type: "array", items: { type: "string" } },
          enabled: { type: "boolean" },
          pinned: { type: "boolean" },
          max_items: { type: "number" }
        },
        required: ["action"]
      }
    }
  };
  const tools = window.zion?.state?.get("chat.tools") || [];
  if (!tools.some((item) => item?.function?.name === "memoryManage")) {
    window.zion?.state?.set("chat.tools", [...tools, tool]);
  }
  const handlers = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };
  handlers.memoryManage = async (args = {}) => {
    const action = String(args.action || "");
    if (action === "list") return JSON.stringify(readMemories().filter((item) => !args.layer || item.layer === args.layer), null, 2);
    if (action === "tree") return JSON.stringify({ root: getSettings().memoryRootPath || DEFAULT_MEMORY_ROOT, items: readMemories().map((item) => ({ id: item.id, path: item.path, layer: item.layer, title: item.title, enabled: item.enabled })) }, null, 2);
    if (action === "read") {
      const id = String(args.id || "");
      const path = normalizeMemoryPath(args.path || "");
      const item = readMemories().find((entry) => (id && entry.id === id) || (path && entry.path === path));
      return JSON.stringify(item || null, null, 2);
    }
    if (action === "search") return JSON.stringify(searchMemories(args.query || "", { layer: args.layer || "", includeDisabled: !!args.include_disabled }), null, 2);
    if (action === "create") return JSON.stringify(createMemory(args), null, 2);
    if (action === "update") {
      if (!args.id) return "Missing id";
      return JSON.stringify(updateMemory(args.id, args), null, 2);
    }
    if (action === "delete") {
      if (!args.id) return "Missing id";
      deleteMemory(args.id);
      return JSON.stringify({ deleted: args.id }, null, 2);
    }
    if (action === "select") {
      if (!args.id) return "Missing id";
      setActiveMemory(args.id);
      openMemoryPanel();
      return JSON.stringify({ selected: args.id }, null, 2);
    }
    if (action === "build_context") {
      return JSON.stringify(buildMemoryContext(args.query || "", { maxItems: args.max_items || 8 }), null, 2);
    }
    if (action === "providers") return JSON.stringify(listProviders(), null, 2);
    if (action === "settings") {
      if (Object.keys(args).some((key) => !["action"].includes(key))) return JSON.stringify(saveSettings(args), null, 2);
      return JSON.stringify(getSettings(), null, 2);
    }
    if (action === "open_panel") {
      openMemoryPanel();
      return JSON.stringify({ opened: true }, null, 2);
    }
    return `Unknown action: ${action}`;
  };
  window.zion?.state?.set("chat.toolHandlers", handlers);
  try {
    const names = (window.zion?.state?.get("chat.tools") || []).map((item) => item?.function?.name).filter(Boolean);
    window.zion?.state?.set("chat.toolsKnownNames", names);
    const enabled = window.zion?.state?.get("chat.enabledTools");
    if (!Array.isArray(enabled) || enabled.length === 0) {
      window.zion?.state?.set("chat.enabledTools", names);
    } else if (!enabled.includes("memoryManage")) {
      window.zion?.state?.set("chat.enabledTools", [...enabled, "memoryManage"]);
    }
  } catch {}
  disposables.push({
    dispose() {
      try {
        const nextTools = (window.zion?.state?.get("chat.tools") || []).filter((item) => item?.function?.name !== "memoryManage");
        window.zion?.state?.set("chat.tools", nextTools);
        const current = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };
        if (current.memoryManage === handlers.memoryManage) {
          delete current.memoryManage;
          window.zion?.state?.set("chat.toolHandlers", current);
        }
      } catch {}
    }
  });
}

function injectStyles() {
  if (document.getElementById("zion-memory-style")) return;
  const style = document.createElement("style");
  style.id = "zion-memory-style";
  style.textContent = `
.zion-memory-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; color: var(--fg); background: linear-gradient(180deg, color-mix(in srgb, var(--panel-bg) 96%, var(--bg, #000)) 0%, var(--panel-bg) 100%); }
.zion-memory-body { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; flex-direction: row; overflow: hidden; }
.zion-memory-list-wrap { flex: 0 0 280px; min-width: 180px; min-height: 0; display: flex; flex-direction: column; border-bottom: 0; }
.zion-memory-split-resizer { flex: 0 0 4px; width: 4px; cursor: col-resize; background: color-mix(in srgb, var(--border) 54%, transparent); position: relative; z-index: 2; }
.zion-memory-split-resizer::after { content: ""; position: absolute; inset: 0 -3px; background: transparent; }
.zion-memory-split-resizer:hover, .zion-memory-panel.is-resizing-memory .zion-memory-split-resizer { background: var(--accent); }
.zion-memory-panel.is-resizing-memory, .zion-memory-panel.is-resizing-memory * { cursor: col-resize !important; user-select: none !important; }
.zion-memory-list-toolbar { flex: 0 0 auto; height: 30px; display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 6px 4px 10px; border-bottom: 1px solid color-mix(in srgb, var(--border) 54%, transparent); }
.zion-memory-list-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: color-mix(in srgb, var(--fg) 62%, transparent); font: 11px/1.4 var(--font-sans); font-weight: 600; }
.zion-memory-title-input, .zion-memory-path-input, .zion-memory-tags-input, .zion-memory-field-row select { min-width: 0; border: 1px solid color-mix(in srgb, var(--border) 76%, transparent); border-radius: 6px; background: transparent; color: var(--fg); font: 11px/1.4 var(--font-sans); padding: 4px 6px; }
.zion-memory-empty { padding: 20px 12px; color: color-mix(in srgb, var(--fg) 58%, transparent); font-size: 12px; line-height: 1.6; }
.zion-memory-empty b { display: block; margin-bottom: 4px; color: color-mix(in srgb, var(--fg) 78%, transparent); font-weight: 650; }
.zion-memory-detail { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; padding: 0; }
.zion-memory-action { width: 26px; height: 22px; padding: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--fg); opacity: 0.7; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.zion-memory-action:hover { opacity: 1; background: rgba(255, 255, 255, 0.06); border-color: rgba(255, 255, 255, 0.10); }
.zion-memory-action svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.zion-memory-action.primary { color: var(--fg); }
.zion-memory-action.danger { color: #ef4444; }
.zion-memory-action.danger:hover { background: rgba(239, 68, 68, 0.16); border-color: rgba(239, 68, 68, 0.35); }
.zion-memory-code-editor { flex: 1 1 auto; min-height: 0; overflow: hidden; background: var(--files-preview-bg, transparent); }
.zion-memory-details { flex: 0 0 auto; max-height: 42%; overflow: auto; border-top: 1px solid color-mix(in srgb, var(--border) 64%, transparent); color: color-mix(in srgb, var(--fg) 64%, transparent); font-size: 11px; background: var(--files-preview-bg, transparent); }
.zion-memory-details > summary { cursor: pointer; padding: 5px 8px 5px 10px; color: color-mix(in srgb, var(--fg) 68%, transparent); user-select: none; }
.zion-memory-preview-actions { flex: 0 0 auto; margin-left: auto; display: inline-flex; align-items: center; gap: 2px; }
.zion-memory-details-summary { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; gap: 8px; min-height: 26px; }
.zion-memory-details-summary::-webkit-details-marker { display: none; }
.zion-memory-details-summary::before { content: "›"; display: inline-block; color: color-mix(in srgb, var(--fg) 46%, transparent); font-size: 14px; line-height: 1; transition: transform 120ms ease; }
.zion-memory-details[open] > .zion-memory-details-summary::before { transform: rotate(90deg); }
.zion-memory-details-label { color: color-mix(in srgb, var(--fg) 72%, transparent); font-weight: 600; }
.zion-memory-details-chips { min-width: 0; display: flex; align-items: center; gap: 4px; overflow: hidden; }
.zion-memory-chip { flex: 0 1 auto; min-width: 0; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 6px; border: 1px solid color-mix(in srgb, var(--border) 58%, transparent); border-radius: 999px; color: color-mix(in srgb, var(--fg) 62%, transparent); background: color-mix(in srgb, var(--fg) 4%, transparent); font: 10.5px/1.45 var(--font-sans); }
.zion-memory-chip.empty { color: color-mix(in srgb, var(--fg) 38%, transparent); border-style: dashed; background: transparent; }
.zion-memory-details-actions { display: flex; align-items: center; gap: 3px; padding: 0 8px 6px; }
.zion-memory-details-form { display: flex; flex-direction: column; gap: 6px; padding: 0 8px 8px; }
.zion-memory-field-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
.zion-memory-details-context { max-height: 160px; overflow: auto; margin: 0; padding: 6px 10px 10px; color: color-mix(in srgb, var(--fg) 58%, transparent); font: 10.5px/1.45 var(--font-mono, monospace); white-space: pre-wrap; border-top: 1px solid color-mix(in srgb, var(--border) 46%, transparent); }
.zion-memory-editor-empty { flex: 1 1 auto; display: grid; place-content: center; gap: 4px; padding: 24px; color: color-mix(in srgb, var(--fg) 58%, transparent); font-size: 12px; text-align: center; }
.zion-memory-editor-empty b { color: color-mix(in srgb, var(--fg) 78%, transparent); }
:root[data-theme="light"] .zion-memory-action:hover, :root[data-theme="light"] .zion-memory-action.primary:hover { background: rgba(0, 0, 0, 0.04); border-color: rgba(0, 0, 0, 0.08); }
:root[data-theme="light"] .zion-memory-action.danger { color: #dc2626; }
`;
  document.head.appendChild(style);
}

export async function activate(ctx) {
  injectStyles();
  const disposables = [];
  try {
    const disp = window.zion?.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) disposables.push(disp);
  } catch {}
  registerDefaultProviders();
  disposables.push(installMemoryApi());
  try { disposables.push(window.zion.commands.registerCommand("memory.openPanel", openMemoryPanel)); } catch {}
  try { disposables.push(window.zion.commands.registerCommand("memory.create", () => { const item = createMemory(); openMemoryPanel(); return item; })); } catch {}
  try { disposables.push(window.zion.commands.registerCommand("memory.rememberSelection", rememberSelection)); } catch {}
  registerMessageContributor(disposables);
  registerMemoryTool(disposables);
  try {
    const view = window.zion.auxiliaryBar?.registerView?.({
      id: VIEW_ID,
      pluginId: "dev.memory",
      title: t("title", "Memory"),
      titleKey: "dev.memory.title",
      icon: "$(database)",
      order: 6,
      keepWhenActive: true,
      component: { render: renderMemoryPanel }
    });
    if (view) disposables.push(view);
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
