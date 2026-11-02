import { validateArgs } from "./schema.mjs";

const statusNames = { succeeded: "已完成", queued: "排队中", running: "运行中", failed: "失败", denied: "权限拒绝",
  approval_required: "等待审批", offline: "设备离线", cancelled: "已取消", unknown_outcome: "结果待确认" };
const riskNames = { read: "只读", write: "写入", execute: "进程", external: "外部操作" };
const platformName = value => ({ darwin: "macOS", linux: "Linux", win32: "Windows", android: "Android", wsl: "WSL" })[value] || value || "未知";
const pretty = value => typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);
const when = value => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未提供";
const el = (tag, className, content) => {
  const node = document.createElement(tag); if (className) node.className = className;
  if (content !== undefined) node.textContent = String(content); return node;
};
const iconPaths = {
  server: "M3 3h18v7H3z M3 14h18v7H3z M7 6.5h.01 M7 17.5h.01",
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  folder: "M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3z",
  file: "M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6",
  bolt: "M13 2 4 14h7l-1 8 10-13h-7z",
  activity: "M2 12h5l3-9 4 18 3-9h5",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
  arrow: "M5 12h14 M13 6l6 6-6 6", refresh: "M20 7V3l-4 4 M20 7a8 8 0 1 0 0 10",
  close: "m6 6 12 12 M6 18 18 6", search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6",
  chevron: "m9 5 7 7-7 7", external: "M13 3h8v8 M21 3 10 14 M10 3H3v18h18v-7",
  play: "m8 4 12 8-12 8z", check: "m4 12 5 5L20 6",
  copy: "M9 9h12v12H9z M15 9V3H3v12h6", maximize: "M9 3H3v6 M15 3h6v6 M3 15v6h6 M21 15v6h-6"
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", iconPaths[name] || iconPaths.server);
  svg.append(path); return svg;
}
function button(label, handler, className = "as-button", glyph) {
  const node = el("button", className); node.type = "button";
  if (glyph) node.append(icon(glyph)); node.append(el("span", "", label)); node.onclick = handler; return node;
}
function link(label, href) {
  const node = el("a", "as-link", label);
  try { const url = new URL(href); if (url.protocol === "https:") { node.href = url.href; node.target = "_blank"; node.rel = "noopener noreferrer"; } } catch {}
  node.append(icon("external")); return node;
}
function badge(label, kind = "") { return el("span", `as-badge ${kind}`, label); }
function sectionTitle(title, subtitle) {
  const head = el("div", "as-section-heading"); head.append(el("h2", "", title));
  if (subtitle) head.append(el("p", "as-muted", subtitle)); return head;
}
function toolRisk(tool, device) {
  if (tool.annotations?.readOnlyHint === true) return "read";
  const risk = device?.capability?.tools?.find(t => t.name === tool.name)?.risk;
  return risk && risk !== "read" ? risk : "external";
}
function argsSchema(tool) { return tool?.inputSchema?.properties?.args || tool?.inputSchema || {}; }
function fieldsSchema(tool) {
  const schema = argsSchema(tool); return schema.anyOf?.[0] || schema.oneOf?.[0] || schema;
}
export function mountStudio(container, adapter, options = {}) {
  let disposed = false, generation = 0, refreshing = false, activeRequests = 0, panelKey = "", fileGeneration = 0;
  let state = { connected: false, devices: [], tools: [], tasks: [], links: {}, ...options.initialState };
  let selectedId = state.selectedNodeId || "", tab = "overview", query = "", filter = "all", toolQuery = "", chosenTool = "";
  let selectedTask = null, fileState = { rootId: "", path: ".", entries: [], loading: false, content: null };
  const drafts = new Map(), controllers = new Set();
  const root = el("div", "adc-studio"), header = el("header", "as-topbar"), shell = el("div", "as-shell");
  const rail = el("aside", "as-rail"), main = el("main", "as-main"), inspector = el("aside", "as-inspector");
  const mainHeader = el("div", "as-device-header"), tabs = el("nav", "as-tabs"), content = el("div", "as-content");
  const notice = el("div", "as-notice"), list = el("div", "as-devices"), footer = el("footer", "as-rail-footer");
  const modalLayer = el("div", "as-modal-layer"); modalLayer.hidden = true;
  root.append(header, notice, shell, modalLayer); shell.append(rail, main, inspector); main.append(mainHeader, tabs, content);
  root.setAttribute("data-compact", options.compact ? "true" : "false"); inspector.hidden = true; notice.hidden = true;
  container.replaceChildren(root);
  const railTitle = el("div", "as-rail-heading"); railTitle.append(el("strong", "", "设备"), el("span", "as-count"));
  const searchWrap = el("label", "as-search"); searchWrap.append(icon("search"));
  const search = el("input"); search.placeholder = "搜索设备"; search.setAttribute("aria-label", "搜索设备");
  searchWrap.append(search); search.oninput = () => { query = search.value; renderDevices(); };
  const filters = el("div", "as-filters");
  for (const [value, label] of [["all", "全部"], ["online", "在线"], ["offline", "离线"]]) {
    const node = button(label, () => { filter = value; renderDevices(); }, "as-filter"); node.dataset.filter = value; filters.append(node);
  }
  rail.append(railTitle, searchWrap, filters, list, footer);
  const selected = () => state.devices.find(device => device.nodeId === selectedId);
  const deviceTools = () => state.tools.filter(tool => {
    const targets = tool.inputSchema?.properties?.target?.properties?.nodeId?.enum;
    return targets ? targets.includes(selectedId) : (selected()?.capability?.tools || []).some(item => item.name === tool.name);
  });
  function notify(message, error = false) { if (disposed) return; notice.hidden = !message; notice.textContent = message || ""; notice.dataset.error = String(error); }
  async function request(operation) {
    const controller = new AbortController(); controllers.add(controller); activeRequests++;
    try { return await operation(controller.signal); }
    finally { controllers.delete(controller); activeRequests--; }
  }
  function fail(error) { if (!disposed && error.name !== "AbortError") notify(error.message || String(error), true); }
  function merge(next) {
    if (next.unavailable && state.devices.length) next = { ...next, devices: state.devices, tools: state.tools };
    const localTasks = state.tasks || [];
    state = { ...state, ...next, tasks: [...(next.tasks || []), ...localTasks.filter(task => !(next.tasks || []).some(t => t.invocationId === task.invocationId))].slice(0, 80) };
    if (!state.connected) { state.devices = []; state.tools = []; }
    if (!state.devices.some(device => device.nodeId === selectedId)) {
      selectedId = state.devices.find(device => device.nodeId === state.selectedNodeId)?.nodeId
        || state.devices.find(device => device.online)?.nodeId || state.devices[0]?.nodeId || "";
      panelKey = "";
    }
    if (selectedTask) selectedTask = state.tasks.find(task => task.invocationId === selectedTask.invocationId) || selectedTask;
    renderChrome(); renderMain(); renderInspector();
    if (next.message) notify(next.message, true); else if (!activeRequests) notify("");
  }
  async function refresh() {
    if (refreshing || disposed) return;
    refreshing = true; root.dataset.refreshing = "true"; const seq = ++generation;
    try { const next = await request(signal => adapter.status(signal)); if (!disposed && seq === generation) merge(next); }
    catch (error) { fail(error); }
    finally { refreshing = false; root.dataset.refreshing = "false"; }
  }
  async function connect() {
    try {
      const value = await request(signal => adapter.connect(signal));
      if (value?.authorizeUrl) {
        const destination = new URL(value.authorizeUrl);
        if (destination.origin !== "https://adc.zioon.tech" || destination.pathname !== "/api/auth/oauth2/authorize") throw new Error("ADC 登录地址无效。");
        window.location.assign(destination.href);
      } else await refresh();
    } catch (error) { fail(error); }
  }
  function selectDevice(device, propagate = true) {
    if (device.nodeId === selectedId) return;
    selectedId = device.nodeId; chosenTool = ""; panelKey = ""; fileGeneration++;
    fileState = { rootId: "", path: ".", entries: [], loading: false, content: null };
    renderChrome(); renderMain();
    if (propagate) {
      options.onSelect?.(device.nodeId);
      if (adapter.select) void request(signal => adapter.select(device.nodeId, signal)).catch(fail);
    }
  }
  function changeTab(value) {
    if (options.compact && options.onOpenTab) { options.onOpenTab(value); return; }
    tab = value; panelKey = ""; renderMain(); renderChrome();
  }
  function renderDevices() {
    railTitle.lastChild.textContent = String(state.devices.length);
    filters.querySelectorAll("button").forEach(node => node.setAttribute("aria-pressed", String(node.dataset.filter === filter)));
    const values = state.devices.filter(device => (filter === "all" || Boolean(device.online) === (filter === "online"))
      && `${device.label} ${device.nodeId} ${platformName(device.platform)}`.toLowerCase().includes(query.toLowerCase()));
    list.replaceChildren();
    for (const device of values) {
      const node = button("", () => selectDevice(device), "as-device");
      node.setAttribute("aria-pressed", String(device.nodeId === selectedId)); node.title = device.nodeId;
      node.replaceChildren(); const machine = el("div", "as-machine-icon"); machine.append(icon("server"));
      const labels = el("div", "as-device-label"); labels.append(el("strong", "", device.label), el("small", "as-muted", platformName(device.platform)));
      const dot = el("span", `as-dot ${device.online ? "online" : ""}`); dot.title = device.online ? "在线" : "离线";
      node.append(machine, labels, dot); list.append(node);
    }
    if (!values.length) list.append(el("p", "as-empty-small", state.connected ? "没有符合条件的设备" : "连接后显示授权设备"));
  }
  function renderChrome() {
    header.replaceChildren();
    const brand = el("div", "as-brand"); const mark = el("span", "as-mark"); mark.append(icon("server"));
    brand.append(mark, el("strong", "", "ADC Studio"), badge("测试副本", "neutral"));
    const actions = el("div", "as-top-actions");
    const live = el("span", "as-live"); live.append(el("span", `as-dot ${state.connected && !state.unavailable ? "online" : ""}`),
      document.createTextNode(adapter.mode === "fixture" ? "交互演示" : state.connected ? "ADC 已连接" : "待连接"));
    actions.append(live, button("任务", () => changeTab("activity"), "as-button subtle", "activity"),
      button("刷新", refresh, "as-button subtle as-refresh", "refresh"));
    if (options.onMaximize) actions.append(button("展开", options.onMaximize, "as-button subtle", "maximize"));
    if (options.compact && options.onOpen) actions.append(button("打开工作台", options.onOpen, "as-button primary", "arrow"));
    header.append(brand, actions);
    footer.replaceChildren();
    const identity = el("div", "as-identity"); identity.append(el("span", "as-avatar", (state.access || "A").slice(0, 1).toUpperCase()),
      el("div", "", state.access || "独立 ADC 授权")); footer.append(identity);
    footer.append(el("p", "as-muted as-scope", adapter.mode === "live" ? "本机 ADC · las-dev-ops · 只读预览"
      : adapter.mode === "fixture" ? "模拟数据 · 操作仅影响此页面" : "当前 Zioon 账户的 ADC 连接"));
    footer.append(button("连接与授权", () => changeTab("settings"), "as-button subtle", "settings"));
    if (options.compact && !state.connected) footer.append(button("连接 ADC", connect, "as-button primary", "arrow"));
    renderDevices();
    const device = selected(); mainHeader.replaceChildren(); tabs.replaceChildren();
    if (device) {
      const title = el("div", "as-device-title"); title.append(el("span", "as-eyebrow", "设备工作台"), el("h1", "", device.label));
      const info = el("div", "as-device-meta"); info.append(badge(device.online ? "在线" : "离线", device.online ? "good" : "neutral"),
        el("span", "", platformName(device.platform)), el("span", "as-muted", `Connector ${device.capability?.nodeVersion || "未知"}`));
      title.append(info); const action = button("浏览文件", () => changeTab("files"), "as-button primary", "folder");
      mainHeader.append(title, action);
    } else mainHeader.append(el("h1", "", "连接你的设备"), button("连接 ADC", connect, "as-button primary", "arrow"));
    for (const [value, label, glyph] of [["overview", "概览", "grid"], ["files", "文件", "folder"], ["tools", "工具", "bolt"], ["activity", "任务", "activity"], ["settings", "连接", "settings"]]) {
      const node = button(label, () => changeTab(value), "as-tab", glyph);
      node.setAttribute("aria-selected", String(tab === value)); node.setAttribute("role", "tab"); tabs.append(node);
    }
    tabs.setAttribute("role", "tablist");
  }
  function renderMain() {
    if (tab === "tools" && !deviceTools().some(tool => tool.name === chosenTool)) chosenTool = deviceTools()[0]?.name || "";
    const key = JSON.stringify([selectedId, tab, chosenTool, tab === "tools" ? deviceTools() : null, state.connected]);
    if (key === panelKey && !["overview", "activity", "settings"].includes(tab)) return;
    panelKey = key; content.replaceChildren();
    if (tab === "settings") return renderSettings();
    if (tab === "activity") return renderActivity();
    if (!selected()) {
      const empty = el("div", "as-welcome"); empty.append(icon("server"), el("h2", "", "从一台设备开始"),
        el("p", "as-muted", "连接 ADC 后，在这里浏览授权目录、运行工具并查看任务结果。"),
        button("连接 ADC", connect, "as-button primary", "arrow")); content.append(empty); return;
    }
    if (tab === "overview") renderOverview();
    if (tab === "files") renderFiles();
    if (tab === "tools") renderTools();
  }
  function detailRow(parent, name, value, mono = false) {
    const row = el("div", "as-detail-row"); row.append(el("span", "as-muted", name), el("span", mono ? "as-mono" : "", value)); parent.append(row);
  }
  function renderOverview() {
    const device = selected(), tools = deviceTools(), roots = device.roots || [];
    content.append(sectionTitle("设备概况", "当前连接可见的资源与能力。"));
    const stats = el("div", "as-stats");
    for (const [value, label] of [[roots.length, "授权目录"], [tools.length, "可用工具"], [state.tasks.filter(task => task.nodeId === selectedId).length, "本连接任务"]]) {
      const stat = el("div", "as-stat"); stat.append(el("strong", "", value), el("span", "as-muted", label)); stats.append(stat);
    }
    content.append(stats);
    const overview = el("div", "as-overview-columns"), directories = el("section"), capabilities = el("section");
    directories.append(sectionTitle("授权目录"));
    for (const item of roots) {
      const row = button("", () => { fileState.rootId = item.rootId; changeTab("files"); }, "as-root-row");
      row.replaceChildren(icon("folder"), el("div", "", item.path || item.label || item.rootId), badge(item.writable ? "可写" : "只读", "neutral"), icon("chevron"));
      directories.append(row);
    }
    if (!roots.length) directories.append(el("p", "as-muted", "该设备没有授权文件目录。"));
    directories.append(link("管理设备与目录", state.links.devices));
    capabilities.append(sectionTitle("工具能力"));
    for (const tool of tools.slice(0, 6)) {
      const row = button("", () => { chosenTool = tool.name; changeTab("tools"); }, "as-capability-row");
      row.replaceChildren(el("span", "as-mono", tool.name), badge(riskNames[toolRisk(tool, device)] || "外部操作", "neutral"), icon("chevron")); capabilities.append(row);
    }
    capabilities.append(button(`查看全部 ${tools.length} 个工具`, () => changeTab("tools"), "as-button subtle", "arrow"));
    overview.append(directories, capabilities); content.append(overview);
    const details = el("section", "as-details"); details.append(sectionTitle("连接信息"));
    detailRow(details, "设备 ID", device.nodeId, true); detailRow(details, "最近心跳", when(device.lastSeenAt));
    detailRow(details, "能力更新时间", when(device.capability?.advertisedAt)); detailRow(details, "当前授权", state.access || "未提供");
    content.append(details);
    const recent = state.tasks.filter(task => task.nodeId === selectedId).slice(0, 3);
    if (recent.length) { content.append(sectionTitle("最近任务")); recent.forEach(task => content.append(taskRow(task))); }
  }
  function renderFiles() {
    const roots = selected().roots || [];
    content.append(sectionTitle("文件", "浏览当前设备的授权目录，点击文本文件查看内容。"));
    if (!roots.length) { content.append(el("p", "as-muted", "该设备未授权目录，请前往 ADC 管理页配置。")); return; }
    if (!roots.some(root => root.rootId === fileState.rootId)) fileState.rootId = roots[0].rootId;
    const toolbar = el("div", "as-file-toolbar"), select = el("select", "as-input"), path = el("input", "as-input as-mono");
    select.setAttribute("aria-label", "授权目录");
    roots.forEach(root => { const option = el("option", "", root.path || root.label || root.rootId); option.value = root.rootId; select.append(option); });
    select.value = fileState.rootId; select.onchange = () => { fileState.rootId = select.value; fileState.path = "."; path.value = "."; void loadDirectory(); };
    path.value = fileState.path; path.setAttribute("aria-label", "相对目录路径"); path.placeholder = "相对于授权目录的路径";
    path.oninput = () => { fileState.path = path.value; };
    path.onkeydown = event => { if (event.key === "Enter") void loadDirectory(); };
    toolbar.append(select, path, button("打开", () => loadDirectory(), "as-button", "arrow"),
      button("搜索文件", () => { chosenTool = "file.search"; changeTab("tools"); }, "as-button subtle", "search"));
    const results = el("div", "as-file-results"); results.dataset.region = "files";
    content.append(toolbar, results); renderFileResults();
    if (!fileState.entries.length && !fileState.content && !fileState.loading) void loadDirectory();
  }
  function relativePath(path) {
    const normalized = String(path || ".").replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) throw new Error("请输入授权目录内的相对路径。");
    return normalized.replace(/^\.\/|\/+$/g, "") || ".";
  }
  async function loadDirectory() {
    const device = selected(), seq = ++fileGeneration; if (!device) return;
    try {
      const path = relativePath(fileState.path), rootId = fileState.rootId;
      fileState = { ...fileState, path, loading: true, content: null, error: null }; renderFileResults();
      const result = await invokeTool("file.list", { rootId, path: path === "." ? "" : path, glob: "*", maxEntries: 600 }, device.nodeId, false);
      if (disposed || seq !== fileGeneration || selectedId !== device.nodeId) return;
      if (result.status !== "succeeded") throw new Error(result.error?.message || statusNames[result.status] || "列举文件失败。");
      const entries = result.output?.entries || [];
      fileState = { ...fileState, loading: false, entries, truncated: result.output?.truncated, content: null }; renderFileResults();
    } catch (error) {
      if (seq === fileGeneration) { fileState = { ...fileState, loading: false, error: error.message }; renderFileResults(); }
    }
  }
  function renderFileResults() {
    const target = content.querySelector('[data-region="files"]'); if (!target || tab !== "files") return;
    const pathInput = content.querySelector('[aria-label="相对目录路径"]');
    if (pathInput && document.activeElement !== pathInput) pathInput.value = fileState.path;
    target.replaceChildren(); const crumbs = el("nav", "as-breadcrumbs");
    function navigate(path) {
      fileState = { ...fileState, path, entries: [], content: null, error: null, loading: false };
      panelKey = ""; renderMain();
    }
    crumbs.append(button("根目录", () => navigate("."), "as-button subtle", "folder"));
    const segments = fileState.path === "." ? [] : fileState.path.split("/");
    segments.forEach((part, i) => crumbs.append(icon("chevron"), button(part, () => {
      navigate(segments.slice(0, i + 1).join("/"));
    }, "as-button subtle")));
    target.append(crumbs);
    if (fileState.loading) { target.append(el("div", "as-loading", "正在读取设备目录…")); return; }
    if (fileState.error) { target.append(el("p", "as-inline-error", fileState.error), button("重新读取", loadDirectory)); return; }
    if (fileState.content !== null) {
      const heading = el("div", "as-file-preview-heading"); heading.append(el("strong", "as-mono", fileState.fileName),
        badge(fileState.readTruncated ? "内容已截断" : `${fileState.bytes ?? "—"} 字节`, "neutral"),
        button("返回目录", () => { fileState.content = null; renderFileResults(); }, "as-button subtle", "close"));
      const pre = el("pre", "as-file-preview", fileState.content); pre.setAttribute("tabindex", "0"); target.append(heading, pre); return;
    }
    const table = el("div", "as-file-table"), seen = new Map();
    for (const raw of fileState.entries) {
      const value = typeof raw === "string" ? raw : raw.name || raw.path || "";
      const first = value.replace(/^\.\//, "").split("/")[0]; if (!first) continue;
      const directory = value.includes("/") || raw.type === "directory" || raw.isDirectory === true;
      if (!seen.has(first) || directory) seen.set(first, { name: first, directory, size: raw.size });
    }
    const heading = el("div", "as-file-table-header"); heading.append(el("span", "", "名称"), el("span", "", "类型"), el("span", "", "操作")); table.append(heading);
    [...seen.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)).forEach(item => {
      const row = button("", async () => {
        const path = `${fileState.path === "." ? "" : `${fileState.path}/`}${item.name}`;
        if (item.directory) { fileState.path = path; fileState.entries = []; panelKey = ""; renderMain(); return; }
        const nodeId = selectedId, seq = ++fileGeneration;
        try {
          const result = await invokeTool("file.read", { rootId: fileState.rootId, path, maxBytes: 65536 }, nodeId, false);
          if (disposed || seq !== fileGeneration || nodeId !== selectedId) return;
          if (result.status !== "succeeded") throw new Error(result.error?.message || "读取未完成，请查看任务。");
          fileState = { ...fileState, content: result.output?.content ?? pretty(result.output), fileName: item.name,
            bytes: result.output?.bytes, readTruncated: result.output?.truncated }; renderFileResults();
        } catch (error) { fail(error); }
      }, "as-file-row");
      const name = el("span", "as-file-name"); name.append(icon(item.directory ? "folder" : "file"), document.createTextNode(item.name));
      row.replaceChildren(name, el("span", "as-muted", item.directory ? "文件夹" : "文件"), el("span", "as-muted", item.directory ? "打开" : "读取")); table.append(row);
    });
    if (!seen.size) table.append(el("p", "as-empty-small", "目录为空"));
    target.append(table);
    if (fileState.truncated) target.append(el("p", "as-muted", "设备返回的目录列表已截断。部分条目可能尚未显示，可输入子目录路径继续浏览。"));
  }
  function renderTools() {
    const tools = deviceTools(); if (!tools.some(tool => tool.name === chosenTool)) chosenTool = tools[0]?.name || "";
    content.append(sectionTitle("工具", "参数来自 ADC 当前授权和设备提供的实时 schema。"));
    if (!tools.length) { content.append(el("p", "as-muted", "此设备没有可调用的工具。")); return; }
    const workspace = el("div", "as-tools-workspace"), picker = el("div", "as-tool-picker"), editor = el("div", "as-tool-editor");
    const search = el("input", "as-input"); search.placeholder = "搜索工具"; search.value = toolQuery; search.setAttribute("aria-label", "搜索工具");
    const toolList = el("div");
    function populate() {
      toolList.replaceChildren();
      tools.filter(tool => `${tool.name} ${tool.title || ""}`.toLowerCase().includes(toolQuery.toLowerCase())).forEach(tool => {
        const node = button("", () => { chosenTool = tool.name; panelKey = ""; renderMain(); }, "as-tool-item");
        node.replaceChildren(el("strong", "as-mono", tool.name), badge(riskNames[toolRisk(tool, selected())] || "外部操作", "neutral"));
        node.setAttribute("aria-pressed", String(tool.name === chosenTool)); toolList.append(node);
      });
    }
    search.oninput = () => { toolQuery = search.value; populate(); }; populate(); picker.append(search, toolList);
    workspace.append(picker, editor); content.append(workspace);
    const tool = tools.find(tool => tool.name === chosenTool), schema = fieldsSchema(tool), risk = toolRisk(tool, selected());
    editor.append(el("h3", "as-mono", tool.name), el("p", "as-muted as-tool-description", tool.description || tool.title || "设备工具"),
      badge(riskNames[risk] || "外部操作", risk === "read" ? "good" : "neutral"));
    const draftKey = `${selectedId}:${tool.name}`;
    let draft = drafts.get(draftKey);
    if (!draft) {
      const value = {};
      for (const [key, prop] of Object.entries(schema.properties || {})) {
        if (tool.name === "file.read" && key === "maxBytes") value[key] = Math.min(prop.default || 65536, 65536);
        else if (prop.default !== undefined) value[key] = prop.default;
        else if (key === "rootId") value[key] = selected().roots?.[0]?.rootId || "";
        else if (schema.required?.includes(key)) value[key] = prop.type === "string" ? "" : prop.type === "object" ? {} : prop.type === "array" ? [] : prop.type === "boolean" ? false : 0;
      }
      draft = { value, jsonMode: !schema.properties, json: pretty(value), idempotencyKey: null }; drafts.set(draftKey, draft);
    }
    const mode = el("div", "as-form-mode"), form = el("div", "as-form-fields"), errors = el("div", "as-form-errors");
    errors.setAttribute("role", "alert");
    const toggle = button(draft.jsonMode ? "切换为表单" : "编辑 JSON", () => {
      draft.jsonMode = !draft.jsonMode; if (draft.jsonMode) draft.json = pretty(draft.value);
      renderFields(); toggle.lastChild.textContent = draft.jsonMode ? "切换为表单" : "编辑 JSON";
    }, "as-button subtle");
    mode.append(el("strong", "", "参数"), toggle); editor.append(mode, form, errors);
    function changed() { draft.idempotencyKey = null; errors.textContent = ""; }
    function renderFields() {
      form.replaceChildren();
      if (draft.jsonMode) {
        const input = el("textarea", "as-json as-input"); input.value = draft.json; input.spellcheck = false;
        input.setAttribute("aria-label", "工具参数 JSON");
        input.oninput = () => { draft.json = input.value; changed(); try { draft.value = JSON.parse(input.value); } catch {} };
        form.append(input); return;
      }
      for (const [key, prop] of Object.entries(schema.properties || {})) {
        const label = el("label", "as-field"), required = schema.required?.includes(key);
        label.append(el("span", "as-field-label", `${key}${required ? " *" : ""}`));
        let input;
        if (prop.enum || key === "rootId") {
          input = el("select", "as-input");
          const values = prop.enum || selected().roots?.map(root => root.rootId) || [];
          if (!required) { const empty = el("option", "", "不设置"); empty.value = ""; input.append(empty); }
          values.forEach(value => { const option = el("option", "", value); option.value = String(value); input.append(option); });
        } else if (prop.type === "boolean") { input = el("input", "as-checkbox"); input.type = "checkbox"; input.checked = draft.value[key] === true; }
        else if (["object", "array"].includes(prop.type)) { input = el("textarea", "as-input as-mono"); input.value = draft.value[key] === undefined ? "" : pretty(draft.value[key]); }
        else { input = el("input", "as-input"); input.type = ["number", "integer"].includes(prop.type) ? "number" : "text";
          if (prop.minimum !== undefined) input.min = prop.minimum; if (prop.maximum !== undefined) input.max = prop.maximum;
          if (prop.type === "integer") input.step = "1"; }
        input.setAttribute("aria-label", key);
        if (input.type !== "checkbox" && input.tagName !== "TEXTAREA") input.value = draft.value[key] ?? "";
        input.oninput = () => {
          changed(); const value = input.type === "checkbox" ? input.checked : input.value;
          if (value === "" && !required) { delete draft.value[key]; return; }
          try { draft.value[key] = input.type === "number" ? Number(value) : ["object", "array"].includes(prop.type) ? JSON.parse(value) : prop.enum ? prop.enum.find(v => String(v) === value) ?? value : value; }
          catch { draft.value[key] = value; }
        };
        label.append(input); if (prop.description) label.append(el("small", "as-muted", prop.description)); form.append(label);
      }
      if (!Object.keys(schema.properties || {}).length) form.append(el("p", "as-muted", "此工具不需要参数。"));
    }
    renderFields();
    const controls = el("div", "as-execution-controls");
    const run = button(risk === "read" ? "运行只读工具" : "检查并执行", async () => {
      try {
        const args = draft.jsonMode ? JSON.parse(draft.json) : draft.value;
        const validation = validateArgs(argsSchema(tool), args); if (validation.length) { errors.textContent = validation.join("\n"); return; }
        if (risk !== "read") {
          const accepted = await confirmOperation("执行设备工具", [
            ["设备", selected().label], ["工具", tool.name], ["操作", riskNames[risk] || "外部操作"], ["参数", pretty(args)]
          ]); if (!accepted) return;
        }
        if (!draft.idempotencyKey) draft.idempotencyKey = `studio-${crypto.randomUUID()}`;
        run.disabled = true; run.lastChild.textContent = "正在提交…";
        const result = await invokeTool(tool.name, cloneArgs(args), selectedId, risk !== "read", draft.idempotencyKey);
        selectedTask = state.tasks.find(task => task.invocationId === result.invocationId) || result; renderInspector();
      } catch (error) { errors.textContent = error.message; }
      finally { if (!disposed) { run.disabled = false; run.lastChild.textContent = risk === "read" ? "运行只读工具" : "检查并执行"; } }
    }, "as-button primary", "play");
    run.disabled = !selected().online || (adapter.readOnly && risk !== "read");
    controls.append(run, el("small", "as-muted", !selected().online ? "设备离线，无法提交"
      : adapter.readOnly && risk !== "read" ? "此预览连接只开放读取" : "结果和回执显示在任务详情"));
    editor.append(controls);
    const schemaView = el("details", "as-schema"); schemaView.append(el("summary", "", "查看完整 inputSchema"), el("pre", "as-code", pretty(argsSchema(tool)))); editor.append(schemaView);
  }
  function cloneArgs(args) { return JSON.parse(JSON.stringify(args)); }
  async function invokeTool(tool, args, nodeId, confirmed, idempotencyKey) {
    const result = await request(signal => adapter.invoke({ tool, args, nodeId, confirmed, idempotencyKey }, signal));
    if (disposed) return result;
    const task = { ...result, tool, nodeId, arguments: args, createdAt: result.createdAt || new Date().toISOString() };
    state.tasks = [task, ...state.tasks.filter(item => item.invocationId !== task.invocationId)].slice(0, 80);
    if (tab === "activity") renderActivity(true); return task;
  }
  function taskRow(task) {
    const row = button("", () => { selectedTask = task; renderInspector(); }, "as-task-row");
    row.replaceChildren();
    const title = el("div", "as-task-name"); title.append(icon("activity"), el("div", "", task.tool || "ADC 调用"));
    const device = state.devices.find(item => item.nodeId === task.nodeId);
    row.append(title, el("span", "as-muted", device?.label || "当前连接"), badge(statusNames[task.status] || task.status,
      task.status === "succeeded" ? "good" : ["failed", "denied", "unknown_outcome"].includes(task.status) ? "bad" : "neutral"), el("span", "as-muted", when(task.createdAt)));
    return row;
  }
  function renderActivity(clear = false) {
    if (clear) content.replaceChildren();
    content.append(sectionTitle("任务记录", "保留当前连接的调用、输出和设备回执。"));
    if (!state.tasks.length) { content.append(el("div", "as-empty-small", "还没有任务。浏览文件或运行工具后，结果会保存在这里。")); return; }
    const rows = el("div", "as-task-table"); state.tasks.forEach(task => rows.append(taskRow(task))); content.append(rows);
  }
  function renderSettings() {
    content.append(sectionTitle("连接与授权", adapter.sharedConnection
      ? "使用当前账户已有的 ADC 连接，授权变更会同时影响 ADC 面板。"
      : "ADC Studio 使用独立授权，权限由 ADC 账户与设备共同决定。"));
    const details = el("div", "as-details");
    detailRow(details, "连接状态", state.unavailable ? "连接暂不可用" : state.connected ? "已连接" : "未连接");
    detailRow(details, "服务", state.origin || "https://adc.zioon.tech"); detailRow(details, "授权名称", state.access || "未授权");
    detailRow(details, "数据来源", adapter.mode === "fixture" ? "模拟数据" : adapter.mode === "live" ? "本机 ADC CLI · las-dev-ops（只读）" : "当前 Zioon 账户 OAuth");
    detailRow(details, "最近更新", when(state.refreshedAt)); if (state.expiresAt) detailRow(details, "授权有效期", when(state.expiresAt));
    content.append(details);
    const controls = el("div", "as-settings-actions");
    if (adapter.mode === "runtime") {
      controls.append(button(state.connected ? "重新连接" : "连接 ADC", connect, "as-button primary", "arrow"));
      if (state.connected) controls.append(button("断开连接", async () => {
        if (!await confirmOperation("断开 ADC Studio", [["当前授权", state.access || "ADC"], ["影响", adapter.sharedConnection
          ? "将断开当前账户的 ADC 连接，同时影响 ADC 面板并清除该连接的任务记录。"
          : "此插件将清除自己的连接与任务记录。"]])) return;
        try { await request(signal => adapter.disconnect(signal)); state = { connected: false, devices: [], tools: [], tasks: [], links: state.links }; selectedId = ""; selectedTask = null; panelKey = ""; await refresh(); }
        catch (error) { fail(error); }
      }));
    }
    controls.append(link("管理设备", state.links.devices), link("授权设置", state.links.access), link("查看审批", state.links.approvals)); content.append(controls);
    if (options.onModeChange) {
      content.append(sectionTitle("预览方式"));
      const modes = el("div", "as-settings-actions");
      modes.append(button("真实 ADC · 只读", () => options.onModeChange("live"), "as-button"), button("交互演示 · 模拟数据", () => options.onModeChange("fixture"), "as-button"));
      content.append(modes);
    }
  }
  function renderInspector() {
    inspector.hidden = !selectedTask; inspector.replaceChildren(); if (!selectedTask) return;
    const task = selectedTask, head = el("div", "as-inspector-heading");
    head.append(el("strong", "", "任务详情"), button("关闭", () => { selectedTask = null; renderInspector(); }, "as-button subtle", "close"));
    inspector.append(head, el("h3", "as-mono", task.tool || "ADC 调用"), badge(statusNames[task.status] || task.status, task.status === "succeeded" ? "good" : "neutral"));
    const details = el("div", "as-inspector-details"); detailRow(details, "Invocation", task.invocationId, true);
    if (task.jobId) detailRow(details, "Job", task.jobId, true);
    if (task.runId) detailRow(details, "Runtime Run", task.runId, true);
    detailRow(details, "时间", when(task.createdAt)); if (task.receipt) detailRow(details, "设备耗时", `${task.receipt.durationMs} ms`);
    inspector.append(details);
    if (task.error) inspector.append(el("p", "as-inline-error", task.error.message || pretty(task.error)));
    if (task.status === "unknown_outcome") inspector.append(el("p", "as-muted", "执行结果尚未确认。请查询原任务，确认实际结果后再提交新操作。"));
    const controls = el("div", "as-inspector-controls");
    controls.append(button("查询原任务", async () => {
      try {
        const result = await request(signal => adapter.task(task, signal));
        if (disposed) return;
        selectedTask = { ...task, ...result }; if (result.status === "succeeded") delete selectedTask.error;
        state.tasks = state.tasks.map(item => item.invocationId === task.invocationId ? selectedTask : item); renderInspector();
      } catch (error) { fail(error); }
    }, "as-button", "refresh"));
    if (["running", "queued", "approval_required"].includes(task.status) && task.jobId && !adapter.readOnly) controls.append(button("取消任务", async () => {
      if (!await confirmOperation("取消此任务", [["工具", task.tool || "ADC"], ["Job", task.jobId]])) return;
      try { const result = await request(signal => adapter.cancel(task, signal)); if (!disposed) { selectedTask = { ...task, ...result }; renderInspector(); } } catch (error) { fail(error); }
    }));
    if (task.status === "approval_required") controls.append(link("前往 ADC 审批", state.links.approvals));
    inspector.append(controls);
    for (const [name, value] of [["输出", task.output], ["设备回执", task.receipt], ["提交参数", task.arguments]]) {
      if (value === undefined) continue;
      const block = el("details", "as-result-block"); block.open = name === "输出";
      block.append(el("summary", "", name), el("pre", "as-code", pretty(value))); inspector.append(block);
    }
    if (task.status === "succeeded" && !task.receipt) inspector.append(el("p", "as-muted", "此调用未返回设备回执。"));
    inspector.append(button("复制结果", async () => {
      try { await navigator.clipboard.writeText(pretty(task)); notify("已复制任务结果"); } catch { notify("复制失败，可选中结果文本复制。", true); }
    }, "as-button subtle", "copy"));
  }
  let resolveModal;
  function confirmOperation(title, details) {
    if (resolveModal) resolveModal(false);
    modalLayer.replaceChildren(); modalLayer.hidden = false;
    const modal = el("div", "as-modal"); modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-label", title);
    modal.append(el("h2", "", title)); const body = el("div", "as-confirm-details"); details.forEach(([key, value]) => detailRow(body, key, value, key === "参数")); modal.append(body);
    const actions = el("div", "as-modal-actions");
    function finish(accepted) { modalLayer.hidden = true; resolveModal?.(accepted); resolveModal = null; }
    actions.append(button("返回", () => finish(false)), button("确认操作", () => finish(true), "as-button primary", "check")); modal.append(actions); modalLayer.append(modal);
    const previous = document.activeElement;
    const close = event => {
      if (event.key === "Escape") finish(false);
      if (event.key === "Tab") {
        const buttons = [...modal.querySelectorAll("button")], first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    modal.onkeydown = close; actions.firstChild.focus();
    return new Promise(resolve => { resolveModal = value => { resolve(value); previous?.focus?.(); }; });
  }
  const timer = setInterval(() => { if (!document.hidden && !activeRequests && modalLayer.hidden) void refresh(); }, 15000);
  const focused = () => { if (!activeRequests) void refresh(); }; window.addEventListener("focus", focused);
  renderChrome(); renderMain(); void refresh();
  return {
    refresh, getState: () => state, showTab: value => changeTab(value),
    selectNode(nodeId) { const device = state.devices.find(item => item.nodeId === nodeId); if (device) selectDevice(device, false); },
    dispose() { disposed = true; generation++; fileGeneration++; clearInterval(timer); window.removeEventListener("focus", focused);
      controllers.forEach(controller => controller.abort()); resolveModal?.(false); adapter.dispose?.(); root.remove(); }
  };
}
