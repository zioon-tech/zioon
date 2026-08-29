import {
  createPluginDetailModel,
  getPluginOriginInfo,
  getPluginPresentation,
  getPluginStatus,
  renderPluginEditor
} from "./plugin-details.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8765";

const I18N_NS = "dev.plugins";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.plugins": "插件",
    "cmd.show": "显示插件",
    "ui.plugins": "插件",
    "ui.reload": "重新加载插件",
    "ui.refresh": "刷新",
    "ui.reloadAll": "重新加载",
    "ui.search": "搜索插件",
    "ui.advancedTools": "高级工具",
    "ui.installPlugins": "安装插件",
    "ui.installDesc": "支持配置服务地址、搜索可安装插件，或直接拖拽 ZIP 包安装。",
    "ui.saveUrl": "保存 URL",
    "ui.dropZip": "拖拽 ZIP 插件包到此处进行安装",
    "ui.searchQuery": "搜索关键词",
    "ui.listAll": "列出全部",
    "ui.install": "安装",
    "ui.pluginActions": "插件操作",
    "ui.enablePlugin": "启用插件",
    "ui.disablePlugin": "停用插件",
    "ui.reloadPlugin": "重新加载插件",
    "ui.devMode": "开发模式",
    "ui.devDesc": "把本地插件目录映射成可热更新的开发会话，适合调试插件。",
    "ui.startDev": "启动开发",
    "ui.stopDev": "停止开发",
    "ui.statsUnavailable": "查看和切换已安装插件。",
    "ui.stats": "共 {total} 个插件，已启用 {enabled} 个，活跃 {active} 个，异常 {errors} 个。",
    "ui.systemUnavailable": "插件系统不可用",
    "ui.noMatching": "没有匹配的插件",
    "ui.noPlugins": "没有找到插件",
    "ui.managerUnavailable": "PluginManager 不可用",
    "ui.searchFailed": "搜索失败：{message}",
    "ui.searchError": "搜索出错",
    "ui.listFailed": "列表加载失败：{message}",
    "ui.listError": "列表加载出错",
    "pluginName.dev.terminal-enhanced": "增强终端",
    "pluginName.dev.toc": "目录",
    "pluginName.dev.roles": "角色",
    "pluginName.dev.terminal-manager": "终端管理器",
    "pluginName.dev.plugins": "插件管理器",
    "pluginName.dev.mail": "邮件",
    "pluginName.dev.task-panel": "任务面板",
    "pluginName.dev.fs-manager": "文件访问管理",
    "pluginName.dev.skills": "技能",
    "pluginName.dev.context-compression": "上下文压缩",
    "pluginName.dev.tools": "工具",
    "pluginName.dev.session-manager": "会话管理器",
    "pluginName.dev.langchain-chat": "聊天",
    "pluginName.dev.editor-config": "编辑器配置",
    "pluginName.dev.service-baseurl": "服务地址",
    "pluginName.dev.thinking": "思考过程",
    "pluginName.dev.sticky-user-header": "固定用户头部",
    "pluginName.dev.sticky-header": "固定头部",
    "pluginName.dev.slash-commands": "斜杠命令",
    "pluginName.dev.search-replace": "搜索和替换",
    "pluginName.dev.search-replace-plus": "搜索替换增强",
    "pluginName.dev.paste-image": "粘贴图片",
    "pluginName.dev.image-enhanced": "图片增强",
    "pluginName.dev.gutter-actions": "行号栏操作",
    "pluginName.dev.export-editor": "导出编辑器",
    "pluginName.zion.autocompletion": "自动补全",
    "pluginDescription.dev.terminal-enhanced": "提供增强终端面板、会话切换、命令历史和智能辅助能力。",
    "pluginDescription.dev.toc": "生成并展示当前文档目录，支持插入 Markdown 目录。",
    "pluginDescription.dev.roles": "配置角色前缀，并为不同角色的内容块提供高亮。",
    "pluginDescription.dev.terminal-manager": "管理本地和 SSH 终端会话，支持切换、重连和目录更新。",
    "pluginDescription.dev.plugins": "查看、启用、停用、安装和开发调试 Zion 插件。",
    "pluginDescription.dev.mail": "配置 SMTP 邮件发送、默认收件人和会话结束通知。",
    "pluginDescription.dev.task-panel": "管理任务和待办，并支持继续执行未完成任务。",
    "pluginDescription.dev.fs-manager": "管理文件和文件夹访问权限，供工具安全读取和写入。",
    "pluginDescription.dev.skills": "扫描和管理 Agent Skills，并把技能元数据以 user 角色消息注入聊天上下文。",
    "pluginDescription.dev.context-compression": "为 AI 对话提供多策略上下文压缩和统计能力。",
    "pluginDescription.dev.tools": "管理工具解析、开关和来自 AI 响应的工具调用。",
    "pluginDescription.dev.session-manager": "管理会话列表、文件夹、导入导出、克隆和切换。",
    "pluginDescription.dev.langchain-chat": "提供聊天运行、停止、重试和模型配置能力。",
    "pluginDescription.dev.editor-config": "配置编辑器外观、宽度、行号、折行和语法高亮等选项。",
    "pluginDescription.dev.service-baseurl": "在设置中心注册后端服务地址配置项。",
    "pluginDescription.dev.thinking": "控制和展示模型思考过程相关内容。",
    "pluginDescription.dev.sticky-user-header": "滚动时固定当前 user 消息标题，帮助识别当前回答对应的问题。",
    "pluginDescription.dev.sticky-header": "兼容旧固定头部插件 id，并复用固定用户头部能力。",
    "pluginDescription.dev.slash-commands": "注册斜杠命令入口，用于快速触发常用动作。",
    "pluginDescription.dev.search-replace": "在编辑器中提供搜索、替换、跳转和全选匹配能力。",
    "pluginDescription.dev.search-replace-plus": "提供更强的搜索替换批量接受、回滚和 diff 操作。",
    "pluginDescription.dev.paste-image": "处理粘贴图片，并插入为 Markdown 图片。",
    "pluginDescription.dev.image-enhanced": "增强 Markdown 图片预览，提供打开、复制、下载和信息查看等操作。",
    "pluginDescription.dev.gutter-actions": "在编辑器行号栏提供快捷操作入口。",
    "pluginDescription.dev.export-editor": "把当前编辑器内容导出为 PNG 或 PDF。",
    "pluginDescription.zion.autocompletion": "提供编辑器自动补全能力。",
    "msg.enabled": "插件已启用。",
    "msg.disabled": "插件已停用。",
    "msg.toggleFailed": "切换插件失败：{message}",
    "msg.installerUnavailable": "安装器不可用。",
    "msg.managerUnavailable": "插件管理器不可用。",
    "msg.installed": "已安装 {name}。",
    "msg.installFailed": "安装失败：{message}",
    "msg.installError": "安装过程中发生错误，请查看控制台。",
    "msg.enterDevPath": "请输入本地插件目录绝对路径。",
    "msg.hotReloadUnavailable": "Hot reload 不可用",
    "msg.installerDevUnavailable": "Installer 不可用",
    "msg.devInstallFailed": "开发模式安装失败",
    "msg.devStarted": "开发模式已启动。",
    "msg.devStopped": "开发模式已停止。",
    "msg.startDevFailed": "启动开发模式失败：{message}",
    "msg.stopDevFailed": "停止开发模式失败：{message}",
    "msg.devConnected": "开发连接已建立：{url}",
    "msg.devSessionStopped": "开发会话已停止：{id}",
    "msg.devClosed": "开发连接已关闭：{id}",
    "msg.devStartedStatus": "开发会话已启动：{id} ({plugin})",
    "msg.devStartFailedShort": "启动开发模式失败",
    "msg.devStoppedShort": "开发会话已停止。"
  },
  "en-US": {
    "category.plugins": "Plugins",
    "cmd.show": "Show Plugins",
    "ui.plugins": "Plugins",
    "ui.reload": "Reload plugins",
    "ui.refresh": "Refresh",
    "ui.reloadAll": "Reload",
    "ui.search": "Search plugins",
    "ui.advancedTools": "Advanced Tools",
    "ui.installPlugins": "Install Plugins",
    "ui.installDesc": "Configure the service URL, search installable plugins, or drag a ZIP package here.",
    "ui.saveUrl": "Save URL",
    "ui.dropZip": "Drop ZIP plugin package here to install",
    "ui.searchQuery": "Search query",
    "ui.listAll": "List All",
    "ui.install": "Install",
    "ui.pluginActions": "Plugin actions",
    "ui.enablePlugin": "Enable plugin",
    "ui.disablePlugin": "Disable plugin",
    "ui.reloadPlugin": "Reload plugin",
    "ui.devMode": "Development Mode",
    "ui.devDesc": "Map a local plugin directory into a hot-reload development session for debugging plugins.",
    "ui.startDev": "Start Dev",
    "ui.stopDev": "Stop Dev",
    "ui.statsUnavailable": "View and toggle installed plugins.",
    "ui.stats": "{total} plugins, {enabled} enabled, {active} active, {errors} errors.",
    "ui.systemUnavailable": "Plugin system not available",
    "ui.noMatching": "No matching plugins",
    "ui.noPlugins": "No plugins found",
    "ui.managerUnavailable": "PluginManager not available",
    "ui.searchFailed": "Search failed: {message}",
    "ui.searchError": "Search error",
    "ui.listFailed": "List failed: {message}",
    "ui.listError": "List error",
    "pluginName.dev.terminal-enhanced": "Terminal Enhanced",
    "pluginName.dev.toc": "Table of Contents",
    "pluginName.dev.roles": "Roles",
    "pluginName.dev.terminal-manager": "Terminal Manager",
    "pluginName.dev.plugins": "Plugin Manager",
    "pluginName.dev.mail": "Mail",
    "pluginName.dev.task-panel": "Task Panel",
    "pluginName.dev.fs-manager": "File Access Manager",
    "pluginName.dev.skills": "Skills",
    "pluginName.dev.context-compression": "Context Compression",
    "pluginName.dev.tools": "Tools",
    "pluginName.dev.session-manager": "Session Manager",
    "pluginName.dev.langchain-chat": "Chat",
    "pluginName.dev.editor-config": "Editor Config",
    "pluginName.dev.service-baseurl": "Service Base URL",
    "pluginName.dev.thinking": "Thinking",
    "pluginName.dev.sticky-user-header": "Sticky User Header",
    "pluginName.dev.sticky-header": "Sticky Header",
    "pluginName.dev.slash-commands": "Slash Commands",
    "pluginName.dev.search-replace": "Search and Replace",
    "pluginName.dev.search-replace-plus": "Search/Replace Plus",
    "pluginName.dev.paste-image": "Paste Image",
    "pluginName.dev.image-enhanced": "Image Enhanced",
    "pluginName.dev.gutter-actions": "Gutter Actions",
    "pluginName.dev.export-editor": "Export Editor",
    "pluginName.zion.autocompletion": "Autocompletion",
    "pluginDescription.dev.terminal-enhanced": "Enhanced terminal panel with session switching, command history, and smart assistance.",
    "pluginDescription.dev.toc": "Generate and display the current document table of contents, with Markdown TOC insertion.",
    "pluginDescription.dev.roles": "Configure role prefixes and highlight content blocks by role.",
    "pluginDescription.dev.terminal-manager": "Manage local and SSH terminal sessions, including switching, reconnecting, and CWD updates.",
    "pluginDescription.dev.plugins": "View, enable, disable, install, and develop Zion plugins.",
    "pluginDescription.dev.mail": "Configure SMTP sending, default recipients, and run-finished notifications.",
    "pluginDescription.dev.task-panel": "Manage tasks and todos, with continuation support for unfinished work.",
    "pluginDescription.dev.fs-manager": "Manage file and folder access permissions for safe tool read/write operations.",
    "pluginDescription.dev.skills": "Scan and manage Agent Skills, and inject skill metadata into chat context as user messages.",
    "pluginDescription.dev.context-compression": "Provide multi-strategy context compression and statistics for AI conversations.",
    "pluginDescription.dev.tools": "Manage tool parsing, switches, and tool calls from AI assistant responses.",
    "pluginDescription.dev.session-manager": "Manage session lists, folders, import/export, cloning, and switching.",
    "pluginDescription.dev.langchain-chat": "Provide chat run, stop, retry, and model configuration capabilities.",
    "pluginDescription.dev.editor-config": "Configure editor appearance, width, line numbers, wrapping, and syntax highlighting.",
    "pluginDescription.dev.service-baseurl": "Register backend service base URL settings in the Settings Center.",
    "pluginDescription.dev.thinking": "Control and display model thinking-related content.",
    "pluginDescription.dev.sticky-user-header": "Keep the current user message header visible while scrolling to identify the active question.",
    "pluginDescription.dev.sticky-header": "Compatibility plugin for the old sticky header id, reusing sticky user header behavior.",
    "pluginDescription.dev.slash-commands": "Register slash command entries for quickly invoking common actions.",
    "pluginDescription.dev.search-replace": "Provide editor search, replace, navigation, and select-all matches.",
    "pluginDescription.dev.search-replace-plus": "Provide enhanced search/replace batch accept, revert, and diff operations.",
    "pluginDescription.dev.paste-image": "Handle pasted images and insert them as Markdown images.",
    "pluginDescription.dev.image-enhanced": "Enhance Markdown image previews with open, copy, download, and info actions.",
    "pluginDescription.dev.gutter-actions": "Provide quick action entry points in the editor gutter.",
    "pluginDescription.dev.export-editor": "Export the current editor content to PNG or PDF.",
    "pluginDescription.zion.autocompletion": "Provide editor autocompletion capabilities.",
    "msg.enabled": "Plugin enabled.",
    "msg.disabled": "Plugin disabled.",
    "msg.toggleFailed": "Failed to toggle plugin: {message}",
    "msg.installerUnavailable": "Installer not available.",
    "msg.managerUnavailable": "Plugin manager not available.",
    "msg.installed": "Installed {name}.",
    "msg.installFailed": "Install failed: {message}",
    "msg.installError": "An error occurred during installation. Check the console.",
    "msg.enterDevPath": "Enter an absolute path to a local plugin directory.",
    "msg.hotReloadUnavailable": "Hot reload not available",
    "msg.installerDevUnavailable": "Installer not available",
    "msg.devInstallFailed": "Development mode installation failed",
    "msg.devStarted": "Development mode started.",
    "msg.devStopped": "Development mode stopped.",
    "msg.startDevFailed": "Failed to start development mode: {message}",
    "msg.stopDevFailed": "Failed to stop development mode: {message}",
    "msg.devConnected": "Development connection established: {url}",
    "msg.devSessionStopped": "Development session stopped: {id}",
    "msg.devClosed": "Development connection closed: {id}",
    "msg.devStartedStatus": "Development session started: {id} ({plugin})",
    "msg.devStartFailedShort": "Failed to start development mode",
    "msg.devStoppedShort": "Development session stopped."
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

function translateFullKey(key, fallback, values) {
  const fullKey = String(key || "");
  if (!fullKey) return fallback;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

function getManifestMeta(plugin) {
  const manifest = plugin?.manifest || {};
  const zion = manifest?.zion || {};
  return { manifest, zion };
}

function getCurrentLocale() {
  try {
    return window.zion?.i18n?.getLocale?.() || "zh-CN";
  } catch {
    return "zh-CN";
  }
}

function prettifyPluginId(id) {
  return String(id || "")
    .replace(/^dev\./, "")
    .replace(/^zion\./, "")
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getPluginDisplayName(plugin) {
  const id = String(plugin?.id || "");
  const { manifest, zion } = getManifestMeta(plugin);
  const rawName = String(zion.displayName || zion.name || manifest.displayName || plugin?.name || id || "").trim();
  if (zion.presentation?.displayName || manifest.presentation?.displayName) {
    return getPluginPresentation(plugin, { locale: getCurrentLocale() }).name;
  }
  const key = zion.displayNameKey || zion.nameKey || manifest.displayNameKey || manifest.nameKey;
  if (key) return translateFullKey(key, rawName || prettifyPluginId(id));
  const builtin = t(`pluginName.${id}`, "");
  if (builtin) return builtin;
  if (rawName && rawName !== id && !/^dev\./.test(rawName)) return rawName;
  return prettifyPluginId(id) || rawName || id;
}

function getPluginDescription(plugin) {
  const id = String(plugin?.id || "");
  const { manifest, zion } = getManifestMeta(plugin);
  const raw = String(plugin?.description || manifest.description || "").trim();
  if (zion.presentation?.description || manifest.presentation?.description) {
    return getPluginPresentation(plugin, { locale: getCurrentLocale() }).description;
  }
  const key = zion.descriptionKey || manifest.descriptionKey;
  if (key) return translateFullKey(key, raw);
  const builtin = t(`pluginDescription.${id}`, "");
  if (builtin) return builtin;
  if (/^Zion Next Plugin:\s*dev\./i.test(raw)) return "";
  return raw;
}

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === "style" && v && typeof v === "object") {
        Object.assign(el.style, v);
      } else if (k === "className") {
        el.className = String(v);
      } else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v != null) {
        el.setAttribute(k, String(v));
      }
    }
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    if (typeof c === "string") {
      el.appendChild(document.createTextNode(c));
    } else {
      el.appendChild(c);
    }
  }
  return el;
}

function mountPluginsSidebarViewInto(container) {
  const pluginManager = window.zion && window.zion.plugins;
  const pluginInstaller = window.zion && window.zion.pluginInstaller;

  const root = h("div", { className: "zion-plugin-manager" });
  const statsText = h("div", { className: "zion-plugin-manager-summary" });
  root.appendChild(statsText);

  const searchRow = h("div", { className: "zion-plugin-manager-search" });

  const searchInput = h("input", {
    type: "text",
    placeholder: t("ui.search", "Search plugins")
  });
  const filterButton = h("button", {
    className: "zion-plugin-manager-filter",
    type: "button",
    title: "筛选插件",
    "aria-label": "筛选插件"
  }, h("span", { className: "codicon codicon-filter" }));
  searchRow.append(searchInput, filterButton);
  root.appendChild(searchRow);

  const filterMenu = h("div", { className: "zion-plugin-manager-filter-menu" });
  root.appendChild(filterMenu);

  const message = h("div", { className: "zion-plugin-manager-message" });
  root.appendChild(message);

  const list = h("div", { className: "zion-plugin-manager-list" });
  root.appendChild(list);

  const toolsPanel = h("details", { className: "zion-plugin-manager-tools" });

  const toolsSummaryLabel = h("span", {}, t("ui.advancedTools", "高级工具"));
  const toolsSummary = h("summary", { className: "zion-plugin-manager-tools-summary" },
    h("span", { className: "codicon codicon-chevron-right", "aria-hidden": "true" }),
    toolsSummaryLabel
  );

  const toolsContent = h("div", { className: "zion-plugin-manager-tools-content" });
  toolsPanel.appendChild(toolsSummary);
  toolsPanel.appendChild(toolsContent);

  const serviceBox = h("section", { className: "zion-plugin-manager-tools-section" });
  const serviceTitle = h("div", { className: "zion-plugin-manager-tools-title" },
    t("ui.installPlugins", "安装插件")
  );

  const serviceDesc = h("div", { className: "zion-plugin-manager-tools-description" },
    t("ui.installDesc", "支持配置服务地址、搜索可安装插件，或直接拖拽 ZIP 包安装。")
  );

  const urlRow = h("div", { className: "zion-plugin-manager-tools-row" });

  const urlInput = h("input", {
    type: "text",
    placeholder: DEFAULT_BASE_URL,
    className: "zion-plugin-manager-tools-input"
  });

  const saveUrlBtn = h("button", {
    className: "zion-plugin-manager-tools-button",
    type: "button"
  }, t("ui.saveUrl", "Save URL"));

  urlRow.appendChild(urlInput);
  urlRow.appendChild(saveUrlBtn);

  const dropZone = h("div", { className: "zion-plugin-manager-drop-zone" },
    t("ui.dropZip", "拖拽 ZIP 插件包到此处进行安装")
  );

  const actionRow = h("div", { className: "zion-plugin-manager-tools-row is-search" });

  const queryInput = h("input", {
    type: "text",
    placeholder: t("ui.searchQuery", "Search query"),
    className: "zion-plugin-manager-tools-input"
  });

  const searchBtn = h("button", {
    className: "zion-plugin-manager-tools-button is-icon",
    type: "button",
    title: t("ui.search", "Search"),
    "aria-label": t("ui.search", "Search")
  }, h("span", { className: "codicon codicon-search", "aria-hidden": "true" }));

  const listBtn = h("button", {
    className: "zion-plugin-manager-tools-button is-icon",
    type: "button",
    title: t("ui.listAll", "List All"),
    "aria-label": t("ui.listAll", "List All")
  }, h("span", { className: "codicon codicon-list-tree", "aria-hidden": "true" }));

  const resultsList = h("div", { className: "zion-plugin-manager-tools-results" });

  actionRow.appendChild(queryInput);
  actionRow.appendChild(searchBtn);
  actionRow.appendChild(listBtn);

  serviceBox.appendChild(serviceTitle);
  serviceBox.appendChild(serviceDesc);
  serviceBox.appendChild(urlRow);
  serviceBox.appendChild(dropZone);
  serviceBox.appendChild(actionRow);
  serviceBox.appendChild(resultsList);

  const devBox = h("section", { className: "zion-plugin-manager-tools-section" });

  const devTitle = h("div", { className: "zion-plugin-manager-tools-title" },
    t("ui.devMode", "开发模式")
  );

  const devDesc = h("div", { className: "zion-plugin-manager-tools-description" },
    t("ui.devDesc", "把本地插件目录映射成可热更新的开发会话，适合调试插件。")
  );

  const devRow = h("div", { className: "zion-plugin-manager-tools-row is-development" });

  const devPathInput = h("input", {
    type: "text",
    placeholder: "/absolute/path/to/your-plugin",
    className: "zion-plugin-manager-tools-input"
  });

  const devStartBtn = h("button", {
    className: "zion-plugin-manager-tools-button",
    type: "button"
  }, t("ui.startDev", "Start Dev"));

  const devStopBtn = h("button", {
    className: "zion-plugin-manager-tools-button",
    type: "button",
    disabled: true
  }, t("ui.stopDev", "Stop Dev"));

  devRow.appendChild(devPathInput);
  devRow.appendChild(devStartBtn);
  devRow.appendChild(devStopBtn);

  const devStatus = h("div", { className: "zion-plugin-manager-tools-status" });

  devBox.appendChild(devTitle);
  devBox.appendChild(devDesc);
  devBox.appendChild(devRow);
  devBox.appendChild(devStatus);
  toolsContent.appendChild(serviceBox);
  toolsContent.appendChild(devBox);
  root.appendChild(toolsPanel);

  function showMessage(text, tone = "info") {
    const value = String(text || "").trim();
    if (!value) {
      message.className = "zion-plugin-manager-message";
      message.textContent = "";
      return;
    }
    message.className = `zion-plugin-manager-message is-visible${tone === "error" ? " is-error" : ""}`;
    message.textContent = value;
  }

  function renderEmpty(text) {
    list.innerHTML = "";
    list.appendChild(h("div", { className: "zion-plugin-manager-empty" }, text));
  }

  function renderStats() {
    if (!pluginManager || typeof pluginManager.getStats !== "function") {
      statsText.textContent = t("ui.statsUnavailable", "查看和切换已安装插件。");
      return;
    }
    const s = pluginManager.getStats();
    statsText.textContent = t("ui.stats", "共 {total} 个插件，已启用 {enabled} 个，活跃 {active} 个，异常 {errors} 个。", s);
  }

  let selectedPluginId = "";
  let activeFilter = "all";

  const getPluginById = (pluginId) => {
    if (!pluginManager || typeof pluginManager.list !== "function") return null;
    return pluginManager.list().find((candidate) => String(candidate?.id || "") === String(pluginId || "")) || null;
  };

  const isDevelopmentPlugin = (plugin) => {
    try {
      const sessions = window.zion?.state?.get?.("plugins.devSessions") || {};
      if (Object.values(sessions).some((session) => session?.pluginId === plugin?.id)) return true;
      const saved = JSON.parse(localStorage.getItem("zion.plugins.devSessionsInfo") || "{}");
      return !!saved?.[plugin?.id];
    } catch {
      return false;
    }
  };

  const getDisplayOrigin = (plugin) => {
    const source = isDevelopmentPlugin(plugin)
      ? { ...plugin, origin: "dev" }
      : plugin;
    return getPluginOriginInfo(source, getCurrentLocale());
  };

  const matchesFilter = (plugin) => {
    if (activeFilter === "enabled") return !!plugin?.enabled;
    if (activeFilter === "disabled") return !plugin?.enabled;
    if (activeFilter === "error") return plugin?.state === "error" || !!plugin?.error;
    if (activeFilter === "builtin") return getDisplayOrigin(plugin).id === "builtin";
    if (activeFilter === "external") return getDisplayOrigin(plugin).id === "external";
    if (activeFilter === "development") return getDisplayOrigin(plugin).id === "dev";
    return true;
  };

  const filterOptions = [
    ["all", "全部", "All"],
    ["enabled", "启用", "Enabled"],
    ["disabled", "停用", "Disabled"],
    ["error", "异常", "Errors"],
    ["builtin", "内置", "Built in"],
    ["external", "ZIP", "ZIP"],
    ["development", "开发中", "Development"]
  ];

  const renderFilterMenu = () => {
    const locale = getCurrentLocale();
    filterMenu.innerHTML = "";
    for (const [id, zhLabel, enLabel] of filterOptions) {
      const option = h("button", {
        className: `zion-plugin-manager-filter-option${activeFilter === id ? " is-active" : ""}`,
        type: "button"
      }, locale === "en-US" ? enLabel : zhLabel);
      option.onclick = () => {
        activeFilter = id;
        filterButton.classList.toggle("is-active", activeFilter !== "all");
        renderFilterMenu();
        renderList();
      };
      filterMenu.appendChild(option);
    }
  };

  const runPluginCommand = async (command) => {
    if (!command) return;
    try {
      await Promise.resolve(window.zion?.commands?.executeCommand?.(command));
    } catch (error) {
      showMessage(error?.message || String(error), "error");
    }
  };

  const refreshOpenDetails = (pluginId) => {
    const latest = getPluginById(pluginId);
    if (!latest) return;
    const tabId = `file:plugin-detail:${pluginId}`;
    const isOpen = window.zion?.panels?.list?.().some((panel) =>
      panel?.tabs?.some?.((tab) => String(tab?.id || "") === tabId)
    );
    if (isOpen) openPluginEditor(latest, false);
  };

  const togglePlugin = async (plugin, enabled) => {
    if (!pluginManager) return;
    try {
      if (enabled) await pluginManager.enable(String(plugin.id));
      else await pluginManager.disable(String(plugin.id));
      showMessage(enabled ? t("msg.enabled", "插件已启用。") : t("msg.disabled", "插件已停用。"));
      doRefresh();
      refreshOpenDetails(String(plugin.id));
    } catch (error) {
      showMessage(t("msg.toggleFailed", "切换插件失败：{message}", {
        message: error?.message || "未知错误"
      }), "error");
      throw error;
    }
  };

  const reloadPlugin = async (plugin) => {
    try {
      if (typeof pluginManager?.hotReloadFromInfo === "function") {
        await pluginManager.hotReloadFromInfo(plugin, { enabled: !!plugin.enabled });
      } else {
        await Promise.resolve(window.zion?.commands?.executeCommand?.("zion.reloadPlugins"));
      }
      doRefresh();
      refreshOpenDetails(String(plugin.id));
    } catch (error) {
      showMessage(error?.message || String(error), "error");
    }
  };

  const createDetailModel = (plugin) => createPluginDetailModel(plugin, {
    locale: getCurrentLocale(),
    fallbackName: getPluginDisplayName(plugin),
    fallbackDescription: getPluginDescription(plugin),
    runCommand: runPluginCommand,
    onToggle: (enabled) => togglePlugin(plugin, enabled),
    onReload: () => reloadPlugin(plugin)
  });

  const closeRowMenus = (except = null) => {
    list.querySelectorAll(".zion-plugin-manager-row-menu[open]").forEach((menu) => {
      if (menu !== except) menu.open = false;
    });
  };

  const createMenuItem = ({ label, iconName, tone = "", onClick }) => {
    const item = h("button", {
      className: `zion-plugin-manager-row-menu-item${tone ? ` is-${tone}` : ""}`,
      type: "button"
    }, h("span", { className: `codicon codicon-${iconName}`, "aria-hidden": "true" }), h("span", {}, label));
    item.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      item.disabled = true;
      try {
        await onClick?.();
      } finally {
        item.disabled = false;
      }
    };
    return item;
  };

  const createRowActionsMenu = (plugin, presentation) => {
    const menu = h("details", { className: "zion-plugin-manager-row-menu" });
    const summary = h("summary", {
      className: "zion-plugin-manager-row-menu-trigger",
      title: t("ui.pluginActions", "插件操作"),
      "aria-label": `${presentation.name}: ${t("ui.pluginActions", "插件操作")}`
    }, h("span", { className: "codicon codicon-kebab-vertical", "aria-hidden": "true" }));
    const body = h("div", { className: "zion-plugin-manager-row-menu-popover" });
    const isEnabled = !!plugin?.enabled;

    summary.onclick = (event) => {
      event.stopPropagation();
      closeRowMenus(menu);
    };
    summary.onkeydown = (event) => {
      event.stopPropagation();
    };
    menu.onclick = (event) => event.stopPropagation();
    menu.ontoggle = () => {
      if (menu.open) closeRowMenus(menu);
    };

    body.appendChild(createMenuItem({
      label: isEnabled ? t("ui.disablePlugin", "停用插件") : t("ui.enablePlugin", "启用插件"),
      iconName: isEnabled ? "debug-stop" : "play",
      tone: isEnabled ? "danger" : "primary",
      onClick: async () => {
        menu.open = false;
        await togglePlugin(plugin, !isEnabled);
      }
    }));
    body.appendChild(createMenuItem({
      label: t("ui.reloadPlugin", "重新加载插件"),
      iconName: "refresh",
      onClick: async () => {
        menu.open = false;
        await reloadPlugin(plugin);
      }
    }));
    menu.append(summary, body);
    return menu;
  };

  function openPluginEditor(plugin, focus = true) {
    if (!plugin || typeof window.zion?.panels?.openFileTab !== "function") return false;
    const presentation = getPluginPresentation(plugin, {
      locale: getCurrentLocale(),
      fallbackName: getPluginDisplayName(plugin),
      fallbackDescription: getPluginDescription(plugin)
    });
    const result = window.zion.panels.openFileTab({
      id: `file:plugin-detail:${plugin.id}`,
      ownerId: "plugins.manager",
      title: presentation.name,
      path: String(plugin.id),
      displayPath: `plugin://${plugin.id}`,
      language: "plugin",
      meta: { pluginId: plugin.id, icon: presentation.icon },
      focus,
      render: (host) => renderPluginEditor(host, createDetailModel(getPluginById(plugin.id) || plugin))
    });
    if (focus && result !== false) {
      selectedPluginId = String(plugin.id);
      renderList();
    }
    return result;
  }

  function renderList() {
    if (!pluginManager || typeof pluginManager.list !== "function") {
      renderEmpty(t("ui.systemUnavailable", "Plugin system not available"));
      return;
    }

    const q = (searchInput.value || "").trim().toLowerCase();
    const filtered = pluginManager.list()
      .filter(matchesFilter)
      .filter((plugin) => {
        if (!q) return true;
        const id = String(plugin?.id || "").toLowerCase();
        const name = getPluginDisplayName(plugin).toLowerCase();
        const desc = getPluginDescription(plugin).toLowerCase();
        return id.includes(q) || name.includes(q) || desc.includes(q);
      })
      .sort((a, b) => {
        const aError = a?.state === "error" || a?.error ? 0 : 1;
        const bError = b?.state === "error" || b?.error ? 0 : 1;
        return aError - bError || getPluginDisplayName(a).localeCompare(getPluginDisplayName(b), getCurrentLocale());
      });

    list.innerHTML = "";

    if (!filtered.length) {
      renderEmpty(q ? t("ui.noMatching", "No matching plugins") : t("ui.noPlugins", "No plugins found"));
      return;
    }

    for (const plugin of filtered) {
      const presentation = getPluginPresentation(plugin, {
        locale: getCurrentLocale(),
        fallbackName: getPluginDisplayName(plugin),
        fallbackDescription: getPluginDescription(plugin)
      });
      const status = getPluginStatus(plugin, getCurrentLocale());
      const origin = getDisplayOrigin(plugin);
      const row = h("div", {
        className: `zion-plugin-manager-row${selectedPluginId === plugin.id ? " is-selected" : ""}`,
        role: "button",
        tabindex: "0",
        "aria-label": `${presentation.name}: ${origin.label}, ${status.label}`,
        "data-status": status.id,
        "data-origin": origin.id,
        "data-tone": status.tone,
        title: `${origin.title} · ${status.label}`
      });
      row.onclick = () => openPluginEditor(plugin, true);
      row.onkeydown = (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openPluginEditor(plugin, true);
      };

      const icon = h("span", { className: "zion-plugin-manager-row-icon" },
        h("span", { className: `codicon codicon-${presentation.icon}` })
      );
      const copy = h("div", { className: "zion-plugin-manager-row-copy" },
        h("div", { className: "zion-plugin-manager-row-title" },
          h("span", { className: "zion-plugin-manager-row-name" }, presentation.name)
        ),
        h("div", { className: "zion-plugin-manager-row-meta" }, `${origin.shortLabel} · ${plugin.id} · v${plugin.version || "0.0.0"}`),
        h("div", { className: "zion-plugin-manager-row-description" },
          plugin?.error?.message || presentation.description || status.label
        )
      );
      const controls = h("div", { className: "zion-plugin-manager-row-controls" });

      controls.appendChild(createRowActionsMenu(plugin, presentation));
      row.append(icon, copy, controls);
      list.appendChild(row);
    }
  }

  root.addEventListener("click", (event) => {
    if (event.target?.closest?.(".zion-plugin-manager-row-menu")) return;
    closeRowMenus();
  });

  filterButton.onclick = () => {
    filterMenu.classList.toggle("is-open");
    filterButton.classList.toggle("is-active", activeFilter !== "all" || filterMenu.classList.contains("is-open"));
  };
  renderFilterMenu();

  const doRefresh = () => {
    renderStats();
    renderList();
  };

  const readServiceUrl = () => {
    try {
      return localStorage.getItem("zion.pluginServiceUrl") || DEFAULT_BASE_URL;
    } catch {
      return DEFAULT_BASE_URL;
    }
  };

  const setServiceUrl = (value) => {
    const v = String(value || "").trim();
    const next = v || DEFAULT_BASE_URL;
    try {
      localStorage.setItem("zion.pluginServiceUrl", next);
    } catch {}
    try {
      if (pluginInstaller && typeof pluginInstaller.setBaseUrl === "function") {
        pluginInstaller.setBaseUrl(next);
      }
    } catch {}
    return next;
  };

  urlInput.value = readServiceUrl();
  saveUrlBtn.onclick = () => {
    setServiceUrl(urlInput.value);
  };

  dropZone.ondragover = (e) => {
    e.stopPropagation();
    e.preventDefault();
    dropZone.style.background = "rgba(0,0,0,0.08)";
  };
  dropZone.ondragleave = () => {
    dropZone.style.background = "transparent";
  };
  dropZone.ondrop = async (e) => {
    e.stopPropagation();
    e.preventDefault();
    dropZone.style.background = "transparent";
    try {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) return;
      if (!pluginInstaller || typeof pluginInstaller.installFromFile !== "function") {
        showMessage(t("msg.installerUnavailable", "安装器不可用。"), "error");
        return;
      }
      if (!pluginManager || typeof pluginManager.installFromInfo !== "function") {
        showMessage(t("msg.managerUnavailable", "插件管理器不可用。"), "error");
        return;
      }
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f.name.toLowerCase().endsWith(".zip")) continue;
        const ret = await pluginInstaller.installFromFile(f);
        if (ret.success && ret.plugin) {
          await pluginManager.installFromInfo(ret.plugin, { enabled: true });
          doRefresh();
          showMessage(t("msg.installed", "已安装 {name}。", { name: getPluginDisplayName(ret.plugin) }));
        } else {
          showMessage(t("msg.installFailed", "安装失败：{message}", { message: ret.error?.message || "未知错误" }), "error");
        }
      }
    } catch (err) {
      showMessage(t("msg.installError", "安装过程中发生错误，请查看控制台。"), "error");
    }
  };

    searchBtn.onclick = async () => {
    try {
      resultsList.innerHTML = "";
      if (!pluginInstaller || typeof pluginInstaller.searchPlugins !== "function") return;
      const res = await pluginInstaller.searchPlugins(queryInput.value.trim(), 50);
      if (!res.success) {
        resultsList.appendChild(
          h("div", { style: { color: "var(--error)", fontSize: "12px" } }, t("ui.searchFailed", "Search failed: {message}", { message: res.error?.message || "Unknown" }))
        );
        return;
      }
      if (!pluginManager || typeof pluginManager.installFromInfo !== "function") {
        resultsList.appendChild(h("div", { style: { opacity: "0.8", fontSize: "12px" } }, t("ui.managerUnavailable", "PluginManager 不可用")));
        return;
      }
      res.data.forEach((item) => {
        const row = h("div", {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "8px"
          }
        });
        const label = h("div", { style: { fontSize: "12px" } }, `${item.name} (${item.id}) v${item.version}`);
        const installBtn = h("button", {
          style: {
            height: "26px",
            padding: "0 10px",
            borderRadius: "8px",
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--fg)",
            cursor: "pointer",
            fontSize: "12px"
          }
        }, t("ui.install", "Install"));
        installBtn.onclick = async () => {
          const ret = await pluginInstaller.installFromService(item.id);
          if (ret.success && ret.plugin) {
            await pluginManager.installFromInfo(ret.plugin, { enabled: true });
            doRefresh();
            showMessage(t("msg.installed", "已安装 {name}。", { name: getPluginDisplayName(ret.plugin) }));
          } else {
            showMessage(t("msg.installFailed", "安装失败：{message}", { message: ret.error?.message || "未知错误" }), "error");
          }
        };
        row.appendChild(label);
        row.appendChild(installBtn);
        resultsList.appendChild(row);
      });
      if (res.data.length === 0) {
        resultsList.appendChild(h("div", { style: { opacity: "0.8", fontSize: "12px" } }, t("ui.noMatching", "No plugins matched")));
      }
    } catch (e) {
      resultsList.appendChild(h("div", { style: { color: "var(--error)", fontSize: "12px" } }, t("ui.searchError", "Search error")));
    }
  };

  listBtn.onclick = async () => {
    try {
      resultsList.innerHTML = "";
      if (!pluginInstaller || typeof pluginInstaller.listPlugins !== "function") return;
      const res = await pluginInstaller.listPlugins(100, 0);
      if (!res.success) {
        resultsList.appendChild(
          h("div", { style: { color: "var(--error)", fontSize: "12px" } }, t("ui.listFailed", "List failed: {message}", { message: res.error?.message || "Unknown" }))
        );
        return;
      }
      if (!pluginManager || typeof pluginManager.installFromInfo !== "function") {
        resultsList.appendChild(h("div", { style: { opacity: "0.8", fontSize: "12px" } }, t("ui.managerUnavailable", "PluginManager 不可用")));
        return;
      }
      res.data.forEach((item) => {
        const row = h("div", {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "8px"
          }
        });
        const label = h("div", { style: { fontSize: "12px" } }, `${item.name} (${item.id}) v${item.version}`);
        const installBtn = h("button", {
          style: {
            height: "26px",
            padding: "0 10px",
            borderRadius: "8px",
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--fg)",
            cursor: "pointer",
            fontSize: "12px"
          }
        }, t("ui.install", "Install"));
        installBtn.onclick = async () => {
          const ret = await pluginInstaller.installFromService(item.id);
          if (ret.success && ret.plugin) {
            await pluginManager.installFromInfo(ret.plugin, { enabled: true });
            doRefresh();
            showMessage(t("msg.installed", "已安装 {name}。", { name: getPluginDisplayName(ret.plugin) }));
          } else {
            showMessage(t("msg.installFailed", "安装失败：{message}", { message: ret.error?.message || "未知错误" }), "error");
          }
        };
        row.appendChild(label);
        row.appendChild(installBtn);
        resultsList.appendChild(row);
      });
      if (res.data.length === 0) {
        resultsList.appendChild(h("div", { style: { opacity: "0.8", fontSize: "12px" } }, t("ui.noPlugins", "No plugins found")));
      }
    } catch (e) {
      resultsList.appendChild(h("div", { style: { color: "var(--error)", fontSize: "12px" } }, t("ui.listError", "List error")));
    }
  };

  const activeDevSessions = new Map();

  const getServiceBaseUrl = () => readServiceUrl();
  const getPersistedDevSessions = () => {
    if (typeof pluginManager?.listDevSessionRecords === "function") {
      return pluginManager.listDevSessionRecords();
    }
    try {
      return JSON.parse(localStorage.getItem("zion.plugins.devSessionsInfo") || "{}");
    } catch {
      return {};
    }
  };

  const runtimeDevSessions = window.zion.state?.get?.("plugins.devSessions") || {};
  devStopBtn.disabled = Object.keys(runtimeDevSessions).length === 0
    && Object.keys(getPersistedDevSessions()).length === 0;

  const connectWebSocket = (serviceUrl, devId, sourceDir) => {
    const wsUrl = serviceUrl.replace(/^http/, "ws") + `/plugins/dev/ws/${devId}`;
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      devStatus.textContent = t("msg.devConnected", "开发连接已建立：{url}", { url: wsUrl });
    };
    ws.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "dev:change" && msg.devId === devId) {
          const baseUrl = getServiceBaseUrl() + `/plugins/dev/${devId}`;
          if (!pluginInstaller || typeof pluginInstaller.installFromDevBase !== "function") return;
          if (!pluginManager || typeof pluginManager.hotReloadFromInfo !== "function") return;
          const ret = await pluginInstaller.installFromDevBase(baseUrl, devId, { sourceDir });
          if (ret.success && ret.plugin) {
            try {
              await pluginManager.hotReloadFromInfo(ret.plugin, { enabled: true });
            } catch {}
          }
        } else if (msg.type === "dev:stop") {
          devStatus.textContent = t("msg.devSessionStopped", "开发会话已停止：{id}", { id: devId });
        }
      } catch {}
    };
    ws.onclose = () => {
      devStatus.textContent = t("msg.devClosed", "开发连接已关闭：{id}", { id: devId });
    };
    return ws;
  };

  devStartBtn.onclick = async () => {
    const p = devPathInput.value.trim();
    if (!p) {
      showMessage(t("msg.enterDevPath", "请输入本地插件目录绝对路径。"), "error");
      return;
    }
    const serviceUrl = getServiceBaseUrl();
    try {
      if (!pluginManager || typeof pluginManager.installFromInfo !== "function") {
        throw new Error(t("ui.managerUnavailable", "PluginManager 不可用"));
      }
      if (!pluginManager.hotReloadFromInfo) {
        throw new Error(t("msg.hotReloadUnavailable", "Hot reload 不可用"));
      }
      const res = await fetch(`${serviceUrl}/plugins/dev/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p })
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const devId = data?.data?.devId;
      const baseUrlRel = data?.data?.baseUrl;
      const devDir = data?.data?.dir;
      if (!devId || !baseUrlRel) {
        throw new Error("invalid dev start response");
      }
      const baseUrl = serviceUrl + baseUrlRel;

      if (!pluginInstaller || typeof pluginInstaller.installFromDevBase !== "function") {
        throw new Error(t("msg.installerDevUnavailable", "Installer 不可用"));
      }

      const ret = await pluginInstaller.installFromDevBase(baseUrl, devId, { sourceDir: devDir });
      if (ret.success && ret.plugin) {
        await pluginManager.installFromInfo(ret.plugin, { enabled: true });
        devStatus.textContent = t("msg.devStartedStatus", "开发会话已启动：{id} ({plugin})", { id: devId, plugin: ret.plugin.id });
        const ws = connectWebSocket(serviceUrl, devId, devDir);
        activeDevSessions.set(devId, { ws, baseUrl, pluginId: ret.plugin.id, dir: devDir });
        try {
          const sessions = (window.zion.state.get("plugins.devSessions") || {});
          sessions[devId] = { ws, baseUrl, pluginId: ret.plugin.id, dir: devDir };
          window.zion.state.set("plugins.devSessions", sessions);
          if (typeof pluginManager.saveDevSessionRecord === "function") {
            pluginManager.saveDevSessionRecord({
              pluginId: ret.plugin.id,
              devId,
              baseUrl,
              dir: devDir
            });
          } else {
            const savedRaw = localStorage.getItem("zion.plugins.devSessionsInfo") || "{}";
            const saved = JSON.parse(savedRaw);
            saved[ret.plugin.id] = { devId, baseUrl, dir: devDir };
            localStorage.setItem("zion.plugins.devSessionsInfo", JSON.stringify(saved));
          }
        } catch {}
        devStartBtn.disabled = true;
        devStopBtn.disabled = false;
        showMessage(t("msg.devStarted", "开发模式已启动。"));
      } else {
        throw new Error(ret.error?.message || t("msg.devInstallFailed", "开发模式安装失败"));
      }
    } catch (e) {
      devStatus.textContent = t("msg.devStartFailedShort", "启动开发模式失败");
      showMessage(t("msg.startDevFailed", "启动开发模式失败：{message}", { message: e?.message || e }), "error");
    }
  };

  devStopBtn.onclick = async () => {
    const serviceUrl = getServiceBaseUrl();
    try {
      const sessions = window.zion.state.get("plugins.devSessions") || {};
      const sessionsToStop = new Map(activeDevSessions);
      for (const [devId, session] of Object.entries(sessions)) {
        if (!sessionsToStop.has(devId)) sessionsToStop.set(devId, session);
      }
      for (const record of Object.values(getPersistedDevSessions())) {
        if (record?.devId && !sessionsToStop.has(record.devId)) {
          sessionsToStop.set(record.devId, record);
        }
      }

      for (const [devId, sess] of sessionsToStop.entries()) {
        try {
          await fetch(`${serviceUrl}/plugins/dev/stop`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ devId })
          });
          sess?.ws?.close?.();
        } catch {}
        try {
          delete sessions[devId];
          if (typeof pluginManager.removeDevSessionRecord === "function") {
            pluginManager.removeDevSessionRecord({ devId });
          } else {
            const savedRaw = localStorage.getItem("zion.plugins.devSessionsInfo") || "{}";
            const saved = JSON.parse(savedRaw);
            if (sess.pluginId && saved[sess.pluginId]) {
              delete saved[sess.pluginId];
              localStorage.setItem("zion.plugins.devSessionsInfo", JSON.stringify(saved));
            }
          }
        } catch {}
        activeDevSessions.delete(devId);
      }
      window.zion.state.set("plugins.devSessions", sessions);
      devStatus.textContent = t("msg.devStoppedShort", "开发会话已停止。");
      showMessage(t("msg.devStopped", "开发模式已停止。"));
    } catch (e) {
      showMessage(t("msg.stopDevFailed", "停止开发模式失败：{message}", { message: e?.message || e }), "error");
    }
    devStartBtn.disabled = false;
    devStopBtn.disabled = true;
  };

  searchInput.addEventListener("input", () => {
    try {
      renderList();
    } catch {}
  });

  function refreshI18n() {
    searchInput.placeholder = t("ui.search", "Search plugins");
    filterButton.title = getCurrentLocale() === "en-US" ? "Filter plugins" : "筛选插件";
    filterButton.setAttribute("aria-label", filterButton.title);
    renderFilterMenu();
    toolsSummaryLabel.textContent = t("ui.advancedTools", "高级工具");
    serviceTitle.textContent = t("ui.installPlugins", "安装插件");
    serviceDesc.textContent = t("ui.installDesc", "支持配置服务地址、搜索可安装插件，或直接拖拽 ZIP 包安装。");
    saveUrlBtn.textContent = t("ui.saveUrl", "Save URL");
    dropZone.textContent = t("ui.dropZip", "拖拽 ZIP 插件包到此处进行安装");
    queryInput.placeholder = t("ui.searchQuery", "Search query");
    searchBtn.title = t("ui.search", "Search");
    searchBtn.setAttribute("aria-label", searchBtn.title);
    listBtn.title = t("ui.listAll", "List All");
    listBtn.setAttribute("aria-label", listBtn.title);
    devTitle.textContent = t("ui.devMode", "开发模式");
    devDesc.textContent = t("ui.devDesc", "把本地插件目录映射成可热更新的开发会话，适合调试插件。");
    devStartBtn.textContent = t("ui.startDev", "Start Dev");
    devStopBtn.textContent = t("ui.stopDev", "Stop Dev");
    doRefresh();
  }

  container.appendChild(root);
  doRefresh();

  const disposers = [];
  const i18nDisp = window.zion?.events?.on?.("i18n/changed", refreshI18n);
  if (i18nDisp) disposers.push(() => i18nDisp.dispose?.());
  if (pluginManager && typeof pluginManager.on === "function" && typeof pluginManager.off === "function") {
    const events = [
      "installed",
      "uninstalled",
      "enabled",
      "disabled",
      "activated",
      "deactivated",
      "updated",
      "hotReloaded",
      "error"
    ];
    const handler = () => {
      try {
        doRefresh();
      } catch {}
    };
    for (const ev of events) {
      try {
        pluginManager.on(ev, handler);
        disposers.push(() => {
          try {
            pluginManager.off(ev, handler);
          } catch {}
        });
      } catch {}
    }
  }

  return {
    dispose: () => {
      try {
        for (const d of disposers.splice(0)) {
          try {
            d();
          } catch {}
        }
      } catch {}
      try {
        root.remove();
      } catch {}
    }
  };
}

export async function activate(ctx) {
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  try {
    const dispCmd = window.zion.commands.registerCommand("zion.plugins.show", () => {
      try {
        window.zion.activityBar.activateItem("plugins.activity");
      } catch {}
    });
    ctx.subscriptions.push(dispCmd);
  } catch {}

  try {
    const dispItem = window.zion.activityBar.registerItem({
      id: "plugins.activity",
      pluginId: "dev.plugins",
      icon: "$(extensions)",
      tooltip: "Plugins",
      tooltipKey: "dev.plugins.ui.plugins",
      sideBarViewId: "plugins.manager",
      order: 20
    });
    const dispView = window.zion.sideBar.registerView({
      id: "plugins.manager",
      pluginId: "dev.plugins",
      title: "Plugins",
      titleKey: "dev.plugins.ui.plugins",
      icon: "$(extensions)",
      order: 20,
      location: "sidebar",
      headerActions: [
        {
          id: "plugins.reload",
          title: "Reload plugins",
          titleKey: "dev.plugins.ui.reload",
          ariaLabel: "Reload plugins",
          ariaLabelKey: "dev.plugins.ui.reload",
          icon: "$(loading)",
          onClick: () => {
            try {
              window.zion.commands.executeCommand("zion.reloadPlugins");
            } catch {}
          }
        }
      ],
      component: {
        render: (container) => mountPluginsSidebarViewInto(container)
      }
    });
    ctx.subscriptions.push(dispItem, dispView);
  } catch {}
}
