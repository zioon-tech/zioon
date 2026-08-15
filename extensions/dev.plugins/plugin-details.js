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

function createToggle(plugin, onToggle) {
  const label = element("label", "zion-plugin-detail-toggle");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!plugin?.enabled;
  const visual = element("span", "zion-plugin-detail-toggle-visual");
  input.onchange = async () => {
    input.disabled = true;
    try {
      await onToggle?.(input.checked);
    } catch {
      input.checked = !input.checked;
    } finally {
      input.disabled = false;
    }
  };
  label.append(input, visual);
  return label;
}

function createSummaryHeader(model) {
  const { plugin, presentation, locale } = model;
  const status = getPluginStatus(plugin, locale);
  const header = element("header", "zion-plugin-detail-summary");
  const pluginIcon = element("div", "zion-plugin-detail-icon");
  pluginIcon.appendChild(icon(presentation.icon));
  const copy = element("div", "zion-plugin-detail-summary-copy");
  const title = element("div", "zion-plugin-detail-title");
  title.appendChild(document.createTextNode(presentation.name));
  title.appendChild(element("span", `zion-plugin-detail-status is-${status.tone}`, status.label));
  copy.appendChild(title);
  copy.appendChild(element("div", "zion-plugin-detail-meta", `${plugin.id} · v${plugin.version || "0.0.0"} · ${presentation.categoryLabel}`));
  header.append(pluginIcon, copy);
  return header;
}

function renderOverview(container, model) {
  const { plugin, presentation, contributions, locale } = model;
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
    [locale === "en-US" ? "Status" : "状态", getPluginStatus(plugin, locale).label],
    [locale === "en-US" ? "Author" : "作者", plugin.author || plugin.manifest?.author || "Zion Developer"],
    [locale === "en-US" ? "License" : "许可", plugin.license || plugin.manifest?.license || "未声明"],
    [locale === "en-US" ? "Source" : "来源", String(plugin.path || "").includes("/extensions/") ? (locale === "en-US" ? "Built in" : "内置") : (locale === "en-US" ? "Installed" : "已安装")],
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

  const toggleRow = element("div", "zion-plugin-detail-setting-row is-bordered");
  const copy = element("div");
  copy.appendChild(element("strong", "", model.locale === "en-US" ? "Enable plugin" : "启用插件"));
  copy.appendChild(element("p", "", model.locale === "en-US" ? "The preference persists across reloads." : "该偏好会持久化，重新加载后不会被覆盖。"));
  toggleRow.append(copy, createToggle(model.plugin, model.onToggle));
  section.appendChild(toggleRow);
  container.appendChild(section);
}

function renderLogs(container, model) {
  const section = element("section", "zion-plugin-detail-page-section");
  appendSectionTitle(section, model.locale === "en-US" ? "Runtime diagnostics" : "运行诊断");
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
  if (model.presentation.entrypoints[0]) {
    const entry = model.presentation.entrypoints[0];
    actions.appendChild(button(entry.title, entry.icon, () => model.runCommand?.(entry.command), true));
  }
  actions.appendChild(button(model.locale === "en-US" ? "Reload" : "重新加载", "refresh", model.onReload));
  actions.appendChild(createToggle(model.plugin, model.onToggle));
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
