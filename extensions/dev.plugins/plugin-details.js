const CATEGORY_LABELS = {
  ai: { "zh-CN": "AI 能力", "en-US": "AI" },
  editor: { "zh-CN": "编辑器", "en-US": "Editor" },
  integration: { "zh-CN": "集成", "en-US": "Integration" },
  productivity: { "zh-CN": "效率", "en-US": "Productivity" },
  system: { "zh-CN": "系统", "en-US": "System" },
  workspace: { "zh-CN": "工作区", "en-US": "Workspace" }
};

const CONTRIBUTION_LABELS = {
  commands: { "zh-CN": "命令", "en-US": "Commands" },
  keybindings: { "zh-CN": "快捷键", "en-US": "Keybindings" },
  menus: { "zh-CN": "菜单", "en-US": "Menus" },
  views: { "zh-CN": "视图", "en-US": "Views" },
  themes: { "zh-CN": "主题", "en-US": "Themes" },
  styles: { "zh-CN": "样式", "en-US": "Styles" },
  skills: { "zh-CN": "Skills", "en-US": "Skills" },
  languages: { "zh-CN": "语言", "en-US": "Languages" }
};

const CONTRIBUTION_ICONS = {
  commands: "terminal",
  keybindings: "keyboard",
  menus: "list-flat",
  views: "layout",
  themes: "symbol-color",
  styles: "symbol-color",
  skills: "sparkle",
  languages: "code"
};

export function localizePluginValue(value, locale = "zh-CN", fallback = "") {
  if (typeof value === "string") return value.trim() || fallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const resolved = value[locale] ?? value["zh-CN"] ?? value["en-US"] ?? Object.values(value)[0];
  return typeof resolved === "string" && resolved.trim() ? resolved.trim() : fallback;
}

function localizeList(value, locale) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (!value || typeof value !== "object") return [];
  const resolved = value[locale] ?? value["zh-CN"] ?? value["en-US"] ?? Object.values(value)[0];
  return Array.isArray(resolved) ? resolved.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function prettifyPluginId(id) {
  return String(id || "")
    .replace(/^(dev|zion)\./, "")
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getPluginPresentation(plugin, options = {}) {
  const locale = options.locale || "zh-CN";
  const manifest = plugin?.manifest || {};
  const zion = manifest?.zion || {};
  const raw = zion.presentation || manifest.presentation || {};
  const id = String(plugin?.id || zion.id || manifest.name || "");
  const fallbackName = String(
    options.fallbackName
      || zion.displayName
      || zion.name
      || manifest.displayName
      || plugin?.name
      || prettifyPluginId(id)
      || id
  ).trim();
  const fallbackDescription = String(
    options.fallbackDescription || plugin?.description || manifest.description || ""
  ).trim();

  return {
    id,
    name: localizePluginValue(raw.displayName, locale, fallbackName),
    description: localizePluginValue(raw.description, locale, fallbackDescription),
    icon: String(raw.icon || "extensions").replace(/[^a-z0-9-]/gi, "") || "extensions",
    category: String(raw.category || "system"),
    categoryLabel: localizePluginValue(CATEGORY_LABELS[raw.category], locale, String(raw.category || "system")),
    features: localizeList(raw.features, locale),
    permissions: (Array.isArray(raw.permissions) ? raw.permissions : []).map((permission) => ({
      id: String(permission?.id || ""),
      label: localizePluginValue(permission?.label, locale, String(permission?.id || "")),
      description: localizePluginValue(permission?.description, locale, "")
    })).filter((permission) => permission.id && permission.label),
    dataLocations: (Array.isArray(raw.dataLocations) ? raw.dataLocations : []).map((location) => ({
      label: localizePluginValue(location?.label, locale, ""),
      path: String(location?.path || "")
    })).filter((location) => location.path),
    entrypoints: (Array.isArray(raw.entrypoints) ? raw.entrypoints : []).map((entrypoint) => ({
      title: localizePluginValue(entrypoint?.title, locale, String(entrypoint?.command || "")),
      command: String(entrypoint?.command || ""),
      icon: String(entrypoint?.icon || "open-preview").replace(/[^a-z0-9-]/gi, "") || "open-preview"
    })).filter((entrypoint) => entrypoint.command)
  };
}

export function getPluginContributions(plugin, locale = "zh-CN") {
  const contributes = plugin?.manifest?.zion?.contributes || {};
  return Object.entries(CONTRIBUTION_LABELS).flatMap(([kind, labels]) => {
    const items = Array.isArray(contributes[kind]) ? contributes[kind] : [];
    if (!items.length) return [];
    return [{
      kind,
      label: localizePluginValue(labels, locale, kind),
      icon: CONTRIBUTION_ICONS[kind] || "symbol-misc",
      count: items.length,
      items
    }];
  });
}

export function getPluginStatus(plugin, locale = "zh-CN") {
  const zh = locale !== "en-US";
  // #region debug-point A:workbench-plugin-state
  if (globalThis.__zionDebugPluginActivationState === true) void fetch("http://127.0.0.1:7777/event", { method: "POST", body: JSON.stringify({ sessionId: "plugin-activation-state", runId: globalThis.__zionDebugPluginActivationRunId || "pre-fix", hypothesisId: "A", location: "dev.plugins:plugin-details:getPluginStatus", msg: "[DEBUG] Workbench plugin state classified", data: { id: String(plugin?.id || ""), state: String(plugin?.state || ""), enabled: plugin?.enabled !== false, hasError: Boolean(plugin?.error), hasWorkbenchEntry: Boolean(plugin?.contract?.entries?.workbench || plugin?.manifest?.zion?.entries?.ui || plugin?.manifest?.zion?.main), hasRuntimeEntry: Boolean(plugin?.contract?.entries?.runtime || plugin?.manifest?.zion?.entries?.runtime), contributionKinds: Object.keys(plugin?.manifest?.zion?.contributes || {}) }, ts: Date.now() }) }).catch(() => {});
  // #endregion
  if (plugin?.state === "error" || plugin?.error) {
    return { id: "error", label: zh ? "激活失败" : "Activation failed", tone: "error" };
  }
  if (!plugin?.enabled || plugin?.state === "disabled") {
    return { id: "disabled", label: zh ? "已停用" : "Disabled", tone: "muted" };
  }
  if (plugin?.state === "active") {
    return { id: "active", label: zh ? "运行中" : "Running", tone: "success" };
  }
  if (plugin?.state === "activating" || plugin?.state === "deactivating") {
    return { id: "pending", label: zh ? "正在切换" : "Updating", tone: "warning" };
  }
  return { id: "enabled", label: zh ? "等待激活" : "Enabled", tone: "warning" };
}

function pluginHostEntries(plugin) {
  const contractEntries = plugin?.contract?.entries || {};
  const zion = plugin?.manifest?.zion || {};
  const entries = zion.entries || {};
  return {
    workbench: Boolean(
      contractEntries.workbench
      || contractEntries.renderer
      || entries.workbench
      || entries.renderer
      || entries.ui
      || zion.main
      || plugin?.manifest?.main
    ),
    runtime: Boolean(contractEntries.runtime || entries.runtime)
  };
}

function runtimeHostStatus(runtimePlugin, locale) {
  const zh = locale !== "en-US";
  const status = String(runtimePlugin?.status || "");
  if (status === "active") {
    return { id: "active", label: zh ? "运行中" : "Running", tone: "success" };
  }
  if (status === "failed") {
    return { id: "error", label: zh ? "激活失败" : "Activation failed", tone: "error" };
  }
  if (status === "stopped") {
    return { id: "stopped", label: zh ? "已停止" : "Stopped", tone: "muted" };
  }
  return { id: "unavailable", label: zh ? "未连接" : "Unavailable", tone: "warning" };
}

export function getPluginHostStatus(plugin, runtimePlugin = null, locale = "zh-CN") {
  const zh = locale !== "en-US";
  const entries = pluginHostEntries(plugin);
  const workbench = entries.workbench ? getPluginStatus(plugin, locale) : null;
  const runtime = entries.runtime ? runtimeHostStatus(runtimePlugin, locale) : null;
  const active = [workbench, runtime].some((status) => status?.id === "active");
  const failed = [workbench, runtime].some((status) => status?.id === "error");
  const labels = [
    ...(workbench ? [`Workbench ${workbench.label}`] : []),
    ...(runtime ? [`Runtime ${runtime.label}`] : [])
  ];
  return {
    id: active && failed ? "partial" : failed ? "error" : active ? "active" : "pending",
    label: labels.join(zh ? " · " : " · ") || (zh ? "未声明宿主" : "No host declared"),
    tone: active && failed ? "warning" : failed ? "error" : active ? "success" : "warning",
    workbench: { applicable: entries.workbench, ...(workbench || {}) },
    runtime: { applicable: entries.runtime, ...(runtime || {}) }
  };
}

export function getPluginOriginInfo(plugin, locale = "zh-CN") {
  const zh = locale !== "en-US";
  const explicit = String(plugin?.origin || "").trim();
  const path = String(plugin?.path || "").trim();
  const manifest = plugin?.manifest || {};
  const main = String(manifest?.zion?.main || manifest?.main || "").trim();
  const hasDevMarker = !!plugin?.sourceDir
    || !!plugin?.devId
    || /\/plugins\/dev\//.test(path)
    || /\/plugins\/dev\//.test(main);
  const id = explicit === "builtin" || explicit === "dev" || explicit === "external"
    ? explicit
    : hasDevMarker
      ? "dev"
      : path.startsWith("/extensions/") || main.startsWith("internal:")
        ? "builtin"
        : "external";
  const detail = id === "dev"
    ? String(plugin?.sourceDir || path || main || "").trim()
    : String(path || main || "").trim();
  if (id === "builtin") {
    return {
      id,
      shortLabel: zh ? "内置" : "Built-in",
      label: zh ? "内置插件" : "Built-in plugin",
      title: zh ? "随应用内置加载" : "Bundled with the app",
      detail
    };
  }
  if (id === "dev") {
    return {
      id,
      shortLabel: zh ? "热更" : "Dev",
      label: zh ? "开发热更新" : "Hot-reload dev",
      title: detail
        ? (zh ? `开发热更新：${detail}` : `Hot-reload dev: ${detail}`)
        : (zh ? "开发热更新插件" : "Hot-reload development plugin"),
      detail
    };
  }
  return {
    id: "external",
    shortLabel: "ZIP",
    label: zh ? "ZIP/外部安装" : "ZIP/external install",
    title: detail
      ? (zh ? `ZIP/外部安装：${detail}` : `ZIP/external install: ${detail}`)
      : (zh ? "ZIP 或外部分发包安装" : "Installed from a ZIP or external package"),
    detail
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function icon(name, className = "") {
  const node = element("span", `codicon codicon-${String(name || "extensions").replace(/[^a-z0-9-]/gi, "")}${className ? ` ${className}` : ""}`);
  node.setAttribute("aria-hidden", "true");
  return node;
}

function button(label, iconName, onClick, primary = false) {
  const node = element("button", `zion-plugin-detail-button${primary ? " is-primary" : ""}`);
  node.type = "button";
  if (iconName) node.appendChild(icon(iconName));
  node.appendChild(document.createTextNode(label));
  node.onclick = onClick;
  return node;
}

function appendEmpty(container, text) {
  container.appendChild(element("div", "zion-plugin-detail-empty", text));
}

function appendSectionTitle(container, title, description = "") {
  const head = element("div", "zion-plugin-detail-section-head");
  head.appendChild(element("h3", "", title));
  if (description) head.appendChild(element("p", "", description));
  container.appendChild(head);
}

function appendFeatures(container, features) {
  if (!features.length) return appendEmpty(container, "该插件尚未声明功能摘要。");
  const list = element("ul", "zion-plugin-detail-feature-list");
  for (const feature of features) {
    const item = element("li");
    item.appendChild(icon("check", "zion-plugin-detail-feature-icon"));
    item.appendChild(document.createTextNode(feature));
    list.appendChild(item);
  }
  container.appendChild(list);
}

function appendContributions(container, contributions) {
  if (!contributions.length) return appendEmpty(container, "manifest 未声明可发现的贡献点。");
  const list = element("div", "zion-plugin-detail-contributions");
  for (const contribution of contributions) {
    const row = element("div", "zion-plugin-detail-contribution");
    row.appendChild(icon(contribution.icon, "zion-plugin-detail-contribution-icon"));
    row.appendChild(element("span", "zion-plugin-detail-contribution-label", contribution.label));
    const itemTitles = contribution.items
      .map((item) => typeof item === "string" ? item : item?.title || item?.id || item?.command || "")
      .filter(Boolean);
    row.appendChild(element("span", "zion-plugin-detail-contribution-summary", itemTitles.join("、")));
    row.appendChild(element("span", "zion-plugin-detail-contribution-count", contribution.count));
    list.appendChild(row);
  }
  container.appendChild(list);
}

function appendPermissions(container, permissions, locale) {
  if (!permissions.length) {
    return appendEmpty(container, locale === "en-US"
      ? "No sensitive permissions are declared."
      : "未声明敏感权限。");
  }
  const list = element("div", "zion-plugin-detail-permissions");
  for (const permission of permissions) {
    const row = element("div", "zion-plugin-detail-permission");
    row.appendChild(icon("shield", "zion-plugin-detail-permission-icon"));
    const copy = element("div");
    copy.appendChild(element("strong", "", permission.label));
    if (permission.description) copy.appendChild(element("p", "", permission.description));
    row.appendChild(copy);
    list.appendChild(row);
  }
  container.appendChild(list);
}

function appendDataLocations(container, locations) {
  if (!locations.length) return appendEmpty(container, "未声明独立的数据存储位置。");
  const list = element("div", "zion-plugin-detail-data-list");
  for (const location of locations) {
    const row = element("div", "zion-plugin-detail-data-row");
    row.appendChild(element("span", "", location.label || "数据"));
    row.appendChild(element("code", "", location.path));
    list.appendChild(row);
  }
  container.appendChild(list);
}

function appendError(container, plugin) {
  if (!plugin?.error?.message) return;
  const error = element("div", "zion-plugin-detail-error");
  error.appendChild(icon("error"));
  const copy = element("div");
  copy.appendChild(element("strong", "", "插件激活失败"));
  copy.appendChild(element("p", "", plugin.error.message));
  error.appendChild(copy);
  container.appendChild(error);
}

function createEnableAction(plugin, onToggle, locale, compact = false) {
  const enabled = !!plugin?.enabled;
  const node = element("button", `zion-plugin-detail-button${enabled ? " is-danger" : " is-primary"}${compact ? " is-compact" : ""}`);
  node.type = "button";
  node.appendChild(icon(enabled ? "debug-stop" : "play"));
  node.appendChild(document.createTextNode(enabled
    ? (locale === "en-US" ? "Disable" : "停用插件")
    : (locale === "en-US" ? "Enable" : "启用插件")));
  node.onclick = async () => {
    node.disabled = true;
    try {
      await onToggle?.(!enabled);
    } finally {
      node.disabled = false;
    }
  };
  return node;
}

function createSummaryHeader(model) {
  const { plugin, presentation, locale } = model;
  const status = getPluginHostStatus(plugin, model.runtimePlugin, locale);
  const origin = getPluginOriginInfo(plugin, locale);
  const header = element("header", "zion-plugin-detail-summary");
  const pluginIcon = element("div", "zion-plugin-detail-icon");
  pluginIcon.appendChild(icon(presentation.icon));
  const copy = element("div", "zion-plugin-detail-summary-copy");
  const title = element("div", "zion-plugin-detail-title");
  title.appendChild(document.createTextNode(presentation.name));
  title.appendChild(element("span", `zion-plugin-detail-status is-${status.tone}`, status.label));
  copy.appendChild(title);
  copy.appendChild(element("div", "zion-plugin-detail-meta", `${plugin.id} · v${plugin.version || "0.0.0"} · ${presentation.categoryLabel} · ${origin.label}`));
  header.append(pluginIcon, copy);
  return header;
}

function renderOverview(container, model) {
  const { plugin, presentation, contributions, locale } = model;
  const origin = getPluginOriginInfo(plugin, locale);
  const layout = element("div", "zion-plugin-detail-overview");
  const main = element("main", "zion-plugin-detail-main");
  appendError(main, plugin);

  const intro = element("section", "zion-plugin-detail-section");
  appendSectionTitle(intro, locale === "en-US" ? "About" : "插件说明");
  intro.appendChild(element("p", "zion-plugin-detail-description", presentation.description || "暂无插件说明。"));
  main.appendChild(intro);

  const features = element("section", "zion-plugin-detail-section");
  appendSectionTitle(features, locale === "en-US" ? "What it provides" : "主要功能");
  appendFeatures(features, presentation.features);
  main.appendChild(features);

  const contributes = element("section", "zion-plugin-detail-section");
  appendSectionTitle(contributes, locale === "en-US" ? "Contributions" : "提供的能力");
  appendContributions(contributes, contributions);
  main.appendChild(contributes);

  const aside = element("aside", "zion-plugin-detail-properties");
  appendSectionTitle(aside, locale === "en-US" ? "Plugin information" : "插件信息");
  const fields = [
    [locale === "en-US" ? "Host status" : "宿主状态", getPluginHostStatus(plugin, model.runtimePlugin, locale).label],
    [locale === "en-US" ? "Author" : "作者", plugin.author || plugin.manifest?.author || "Zion Developer"],
    [locale === "en-US" ? "License" : "许可", plugin.license || plugin.manifest?.license || "未声明"],
    [locale === "en-US" ? "Source" : "来源", origin.label],
    [locale === "en-US" ? "Path" : "路径", origin.detail || (locale === "en-US" ? "Unknown" : "未知")],
    [locale === "en-US" ? "Activation" : "激活事件", (plugin.manifest?.zion?.activationEvents || []).join("、") || (locale === "en-US" ? "On demand" : "按需")]
  ];
  for (const [label, value] of fields) {
    const row = element("div", "zion-plugin-detail-property");
    row.appendChild(element("span", "", label));
    row.appendChild(element("strong", "", value));
    aside.appendChild(row);
  }
  layout.append(main, aside);
  container.appendChild(layout);
}

function renderCapabilities(container, model) {
  const section = element("section", "zion-plugin-detail-page-section");
  appendSectionTitle(section, model.locale === "en-US" ? "Declared capabilities" : "已声明能力", model.locale === "en-US"
    ? "Generated from the plugin manifest to avoid duplicated documentation."
    : "以下内容从插件 manifest 自动生成，避免页面与实现重复维护。");
  appendContributions(section, model.contributions);
  const features = element("div", "zion-plugin-detail-subsection");
  appendSectionTitle(features, model.locale === "en-US" ? "Feature summary" : "功能摘要");
  appendFeatures(features, model.presentation.features);
  section.appendChild(features);
  container.appendChild(section);
}

function renderSettings(container, model) {
  const section = element("section", "zion-plugin-detail-page-section");
  appendSectionTitle(section, model.locale === "en-US" ? "Access and storage" : "访问与存储");
  appendPermissions(section, model.presentation.permissions, model.locale);
  const data = element("div", "zion-plugin-detail-subsection");
  appendSectionTitle(data, model.locale === "en-US" ? "Data locations" : "数据位置");
  appendDataLocations(data, model.presentation.dataLocations);
  section.appendChild(data);

  const hostStatus = getPluginHostStatus(model.plugin, model.runtimePlugin, model.locale);
  const toggleRow = element("div", "zion-plugin-detail-setting-row is-bordered");
  const copy = element("div");
  if (hostStatus.workbench.applicable) {
    copy.appendChild(element("strong", "", model.plugin?.enabled
      ? (model.locale === "en-US" ? "Workbench plugin is enabled" : "Workbench 插件已启用")
      : (model.locale === "en-US" ? "Workbench plugin is disabled" : "Workbench 插件已停用")));
    copy.appendChild(element("p", "", model.locale === "en-US"
      ? "This setting controls the browser host and persists across reloads."
      : "该设置控制浏览器宿主，并会跨重新加载持久化。"));
    toggleRow.append(copy, createEnableAction(model.plugin, model.onToggle, model.locale));
  } else {
    copy.appendChild(element("strong", "", model.locale === "en-US"
      ? "Runtime-managed plugin"
      : "Runtime 托管插件"));
    copy.appendChild(element("p", "", model.locale === "en-US"
      ? "This plugin has no Workbench entry and is managed by the Runtime configuration."
      : "该插件没有 Workbench 入口，由 Runtime 配置管理。"));
    toggleRow.append(copy);
  }
  section.appendChild(toggleRow);
  container.appendChild(section);
}

function renderLogs(container, model) {
  const section = element("section", "zion-plugin-detail-page-section");
  appendSectionTitle(section, model.locale === "en-US" ? "Host diagnostics" : "宿主诊断");
  if (model.plugin?.error) {
    appendError(section, model.plugin);
    if (model.plugin.error.stack) section.appendChild(element("pre", "zion-plugin-detail-log", model.plugin.error.stack));
  } else {
    const empty = element("div", "zion-plugin-detail-log-empty");
    empty.appendChild(icon("check"));
    empty.appendChild(element("strong", "", model.locale === "en-US" ? "No plugin errors" : "当前没有插件错误"));
    empty.appendChild(element("p", "", model.locale === "en-US" ? "Runtime errors will appear here." : "插件激活或运行异常会显示在此处。"));
    section.appendChild(empty);
  }
  container.appendChild(section);
}

function renderEditorContent(container, model) {
  container.classList.add("zion-plugin-detail-editor");
  const hero = createSummaryHeader(model);
  const actions = element("div", "zion-plugin-detail-hero-actions");
  const hostStatus = getPluginHostStatus(model.plugin, model.runtimePlugin, model.locale);
  if (model.presentation.entrypoints[0]) {
    const entry = model.presentation.entrypoints[0];
    actions.appendChild(button(entry.title, entry.icon, () => model.runCommand?.(entry.command), true));
  }
  if (hostStatus.workbench.applicable) {
    actions.appendChild(createEnableAction(model.plugin, model.onToggle, model.locale, true));
    actions.appendChild(button(model.locale === "en-US" ? "Reload" : "重新加载", "refresh", model.onReload));
  }
  hero.appendChild(actions);
  container.appendChild(hero);

  const tabs = element("div", "zion-plugin-detail-tabs");
  const page = element("div", "zion-plugin-detail-page");
  const definitions = [
    ["overview", model.locale === "en-US" ? "Overview" : "概览", renderOverview],
    ["capabilities", model.locale === "en-US" ? "Capabilities" : "能力", renderCapabilities],
    ["settings", model.locale === "en-US" ? "Settings" : "设置", renderSettings],
    ["logs", model.locale === "en-US" ? "Logs" : "日志", renderLogs]
  ];
  let active = "overview";
  const renderPage = () => {
    page.innerHTML = "";
    const definition = definitions.find(([id]) => id === active) || definitions[0];
    definition[2](page, model);
    for (const tab of tabs.querySelectorAll(".zion-plugin-detail-tab")) {
      tab.classList.toggle("is-active", tab.dataset.tab === active);
      tab.setAttribute("aria-selected", tab.dataset.tab === active ? "true" : "false");
    }
  };
  for (const [id, label] of definitions) {
    const tab = element("button", "zion-plugin-detail-tab", label);
    tab.type = "button";
    tab.dataset.tab = id;
    tab.setAttribute("role", "tab");
    tab.onclick = () => {
      active = id;
      renderPage();
    };
    tabs.appendChild(tab);
  }
  container.append(tabs, page);
  renderPage();
}

export function createPluginDetailModel(plugin, options = {}) {
  const locale = options.locale || "zh-CN";
  const presentation = getPluginPresentation(plugin, {
    locale,
    fallbackName: options.fallbackName,
    fallbackDescription: options.fallbackDescription
  });
  return {
    ...options,
    plugin,
    locale,
    presentation,
    contributions: getPluginContributions(plugin, locale)
  };
}

export function renderPluginEditor(container, model) {
  renderEditorContent(container, model);
}
