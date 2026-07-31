import "./styles.css";
import { createElement } from "react";
import { installToolCallCards } from "./tool-calls.js";
import { installToolSwitcher } from "./tool-switcher.js";
import { registerChangesPanel } from "./changes-panel.js";
import { registerFilesPanel } from "./files-panel.js";
import { registerContextPanel } from "./context-panel.js";
import { getCurrentSessionChangeState, getSessionChangeState } from "./session-change-state.js";
import { ToolsSettingsPage, buildToolRows } from "./ToolsSettingsPage.jsx";

const I18N_NS = "dev.tools";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.tools": "工具",
    "cmd.parseFromContent": "从内容解析工具",
    "settings.title": "工具",
    "settings.description": "启用工具与工具入口",
    "settings.section": "工具",
    "settings.manager": "工具",
    "cmd.openChanges": "打开变更面板",
    "cmd.openFiles": "打开文件面板",
    "cmd.openContext": "打开上下文面板",
    "cmd.openFilesPicker": "文件：打开...",
    "cmd.openFilesPicker.description": "选择本地文件夹或打开某个终端会话的当前目录",
    "status.tools": "工具：{count}",
    "status.tooltip": "管理已启用工具",
    "switcher.title": "选择工具",
    "switcher.search": "搜索工具...",
    "switcher.footer": "Enter：切换 • Esc：关闭 • ↑↓：导航",
    "switcher.parameters": "参数",
    "switcher.noDescription": "无描述",
    "switcher.none": "（无）",
    "switcher.noTools": "未找到工具",
    "switcher.preview": "预览",
    "switcher.previewTitle": "预览工具详情",
    "call.title": "调用 {name}",
    "call.status": "工具调用状态：{label}",
    "call.revert": "回退",
    "call.accept": "接受",
    "call.revertEdit": "回退编辑操作",
    "call.acceptEdit": "接受编辑操作",
    "call.revertWrite": "回退写入操作",
    "call.acceptWrite": "接受写入操作",
    "call.remove": "移除该工具记录",
    "call.inlineTitle": "调用 {name}（点击展开/收起）",
    "call.inlineTitleWithSummary": "调用 {name}：{summary}（点击展开/收起）",
    "call.inlineAria": "调用 {name}（点击展开或收起工具调用卡片）",
    "call.toggle": "展开/收起工具调用卡片",
    "call.openInContext": "在 Context 中打开",
    "call.patchTruncated": "patch 过长，已截断显示前 {count} 行",
    "files.title": "文件",
    "files.stats": "{dirs} 个文件夹 · {files} 个文件",
    "files.source": "来源",
    "files.sourceLocal": "本地授权",
    "files.sourceActiveTerminal": "终端：当前",
    "files.sourceActiveTerminalProject": "当前：{project}",
    "files.sort": "排序",
    "files.sortLabel": "排序：{sort}",
    "files.sortName": "名称",
    "files.sortModified": "修改时间",
    "files.sortSize": "大小",
    "files.refresh": "刷新",
    "files.addFolder": "添加文件夹",
    "files.openManager": "打开管理器",
    "files.more": "更多操作",
    "files.moreActions": "更多操作",
    "files.open": "打开预览",
    "files.openInFolder": "在文件夹中打开",
    "files.preview": "预览",
    "files.download": "下载",
    "files.downloadFailed": "下载文件失败",
    "files.refreshFolder": "刷新文件夹",
    "files.copyPath": "复制路径",
    "files.copied": "路径已复制",
    "files.kind": "类型",
    "files.kindFile": "文件",
    "files.kindFolder": "文件夹",
    "files.size": "大小",
    "files.modified": "修改时间",
    "files.emptyTitle": "还没有添加文件夹",
    "files.emptyDescription": "从文件系统访问管理器添加文件夹或文件后，可以在这里浏览。",
    "files.noTerminalTitle": "没有终端会话",
    "files.noTerminalDescription": "创建或选择本地/SSH 终端会话后，可以通过它浏览文件。",
    "files.openTerminalManager": "打开终端管理器",
    "files.terminalJsonFailed": "终端命令没有返回 JSON",
    "files.terminalCommandFailed": "终端命令执行失败",
    "files.emptyFolder": "空文件夹",
    "files.loading": "正在加载文件...",
    "files.errorTitle": "无法加载文件",
    "files.retry": "重试",
    "files.permissionDenied": "没有访问权限",
    "files.binaryUnsupported": "暂不支持二进制预览",
    "files.tooLarge": "文件太大，暂不预览",
      "files.previewTruncated": "文件较大，仅以只读方式展示前 {size} KB。",
    "files.openFailed": "打开文件失败",
    "files.openSubmenu": "打开文件",
    "files.openSubmenuPlaceholder": "搜索本地文件夹或终端会话...",
    "files.openSubmenuEmpty": "没有找到匹配的入口",
    "context.title": "上下文",
    "context.resizeExplorer": "调整上下文浏览区宽度",
    "context.close": "关闭",
    "context.files": "文件",
    "context.webPages": "网页",
    "context.tasks": "任务",
    "context.comments": "评论",
    "context.agents": "Agents",
    "context.tags": "标签",
    "context.links": "引用",
    "context.headings": "标题",
    "context.anchors": "锚点",
    "context.modelUsage": "模型消耗",
    "context.basics": "基础信息",
    "context.noSession": "暂无打开的会话",
    "context.session": "会话",
    "context.terminalContext": "终端上下文",
    "context.terminalInjected": "会注入聊天",
    "context.terminalNotInjected": "未注入聊天",
    "context.terminalSessions": "终端会话",
    "context.terminalActive": "active {id}",
    "context.count": "{count} 个",
    "context.toolArtifacts": "工具产物",
    "context.itemCount": "{count} 条",
    "context.emptyFiles": "当前会话里还没有识别到文件路径。",
    "context.emptyWeb": "当前会话里还没有识别到网页链接。",
    "context.emptyTasks": "当前会话还没有 todo。",
    "context.emptyComments": "当前会话还没有评论。",
    "context.emptyAgents": "当前会话还没有 Agent Task。",
    "context.emptyTags": "当前会话还没有标签。",
    "context.emptyLinks": "当前会话还没有 wiki 引用。",
    "context.emptyHeadings": "当前会话还没有 Markdown 标题。",
    "context.emptyAnchors": "当前会话还没有块锚点。",
    "context.emptyUsage": "当前会话还没有可统计的模型消耗。",
    "context.emptyBasics": "暂无基础上下文信息。",
    "context.copyUsage": "复制消耗信息",
    "context.openInFiles": "在文件面板里定位并打开",
    "context.addFolderToFiles": "添加到文件面板",
    "context.addedFolderToFiles": "已添加到文件面板",
    "context.openInFolder": "在文件夹中打开",
    "context.copyPath": "复制路径",
    "context.openUrl": "打开网页",
    "context.copyUrl": "复制链接",
    "context.copyInfo": "复制信息",
    "context.copyComment": "复制评论信息",
    "context.copyAgentTask": "复制 Agent Task 信息",
    "context.copyTask": "复制任务信息",
    "context.copyTodo": "复制 todo",
    "context.openingFiles": "正在打开文件面板并定位文件...",
    "context.copied": "已复制到剪贴板",
    "context.run.streaming": "回答中",
    "context.run.ready": "可继续对话",
    "context.run.error": "出错",
    "context.run.aborted": "已停止",
    "context.run.idle": "未运行",
    "context.usage.files": "{count} files",
    "context.usage.modelCalls": "{count} model calls",
    "context.usage.input": "input {count}",
    "context.usage.output": "output {count}",
    "context.usage.cacheRead": "cache read {count}",
    "context.usage.cacheWrite": "cache write {count}",
    "context.tasks.todoLists": "{count} todo lists",
    "context.tasks.done": "完成 {done}/{total}",
    "context.tasks.doing": "进行中 {count}",
    "context.tasks.active": "当前",
    "context.tasks.activeWithName": "当前 {name}",
    "context.tasks.list": "Todo 列表 {index}",
    "context.tasks.emptyTodo": "（空 todo）",
    "changes.title": "变更",
    "changes.empty": "当前会话还没有文件修改。当 edit、write 或 apply_patch 工具产生文件产物时，会在这里展示 diff。",
    "changes.files": "{count} files",
    "changes.wrap": "换行",
    "changes.wrapLongLines": "自动换行长行",
    "changes.scrollLongLines": "横向滚动长行",
    "changes.expand": "展开",
    "changes.collapse": "折叠",
    "changes.expandAll": "展开全部文件",
    "changes.collapseAll": "折叠全部文件",
    "changes.refresh": "刷新",
    "changes.new": "新增",
    "changes.deleted": "删除",
    "changes.fileActions": "文件操作",
    "changes.copyPath": "复制路径",
    "changes.copyDiff": "复制 Diff",
    "changes.accept": "接受",
    "changes.revert": "回退",
    "changes.pathCopied": "路径已复制",
    "changes.diffCopied": "diff 已复制",
    "changes.copied": "已复制",
    "changes.copyFailed": "复制失败"
  },
  "en-US": {
    "category.tools": "Tools",
    "cmd.parseFromContent": "Parse Tools From Content",
    "settings.title": "Tools",
    "settings.description": "Enable tools and tool entry points",
    "settings.section": "Tools",
    "settings.manager": "Tools",
    "cmd.openChanges": "Open Changes",
    "cmd.openFiles": "Open Files",
    "cmd.openContext": "Open Context",
    "cmd.openFilesPicker": "Files: Open...",
    "cmd.openFilesPicker.description": "Choose a local folder or open the current directory of a terminal session",
    "status.tools": "Tools: {count}",
    "status.tooltip": "Manage enabled tools",
    "switcher.title": "Select Tools",
    "switcher.search": "Search tools...",
    "switcher.footer": "Enter: toggle • Esc: close • ↑↓: navigate",
    "switcher.parameters": "Parameters",
    "switcher.noDescription": "No description",
    "switcher.none": "(none)",
    "switcher.noTools": "No tools found",
    "switcher.preview": "Preview",
    "switcher.previewTitle": "Preview tool details",
    "call.title": "Call {name}",
    "call.status": "Tool call status: {label}",
    "call.revert": "Revert",
    "call.accept": "Accept",
    "call.revertEdit": "Revert edit operation",
    "call.acceptEdit": "Accept edit operation",
    "call.revertWrite": "Revert write operation",
    "call.acceptWrite": "Accept write operation",
    "call.remove": "Remove this tool record",
    "call.inlineTitle": "Call {name} (click to expand/collapse)",
    "call.inlineTitleWithSummary": "Call {name}: {summary} (click to expand/collapse)",
    "call.inlineAria": "Call {name} (click to expand or collapse tool call card)",
    "call.toggle": "Expand/collapse tool call card",
    "call.openInContext": "Open in Context",
    "call.patchTruncated": "Patch is too long; showing the first {count} lines",
    "files.title": "Files",
    "files.stats": "{dirs} folders · {files} files",
    "files.source": "Source",
    "files.sourceLocal": "Local Grants",
    "files.sourceActiveTerminal": "Terminal: Active",
    "files.sourceActiveTerminalProject": "Active: {project}",
    "files.sort": "Sort",
    "files.sortLabel": "Sort: {sort}",
    "files.sortName": "Name",
    "files.sortModified": "Modified",
    "files.sortSize": "Size",
    "files.refresh": "Refresh",
    "files.addFolder": "Add Folder",
    "files.openManager": "Open Manager",
    "files.more": "More actions",
    "files.moreActions": "More actions",
    "files.open": "Open Preview",
    "files.openInFolder": "Open in Folder",
    "files.preview": "Preview",
    "files.download": "Download",
    "files.downloadFailed": "Failed to download file",
    "files.refreshFolder": "Refresh Folder",
    "files.copyPath": "Copy Path",
    "files.copied": "Path copied",
    "files.kind": "Kind",
    "files.kindFile": "File",
    "files.kindFolder": "Folder",
    "files.size": "Size",
    "files.modified": "Modified",
    "files.emptyTitle": "No folders added",
    "files.emptyDescription": "Add a folder or file from File System Access Manager to browse it here.",
    "files.noTerminalTitle": "No terminal session",
    "files.noTerminalDescription": "Create or select a local/SSH terminal session to browse files through it.",
    "files.openTerminalManager": "Open Terminal Manager",
    "files.terminalJsonFailed": "Terminal command did not return JSON",
    "files.terminalCommandFailed": "Terminal command failed",
    "files.emptyFolder": "Empty folder",
    "files.loading": "Loading files...",
    "files.errorTitle": "Unable to load files",
    "files.retry": "Retry",
    "files.permissionDenied": "Permission denied",
    "files.binaryUnsupported": "Binary preview is not supported yet",
    "files.tooLarge": "File is too large to preview",
      "files.previewTruncated": "Large file: showing the first {size} KB as read-only.",
    "files.openFailed": "Failed to open file",
    "files.openSubmenu": "Open Files",
    "files.openSubmenuPlaceholder": "Search local folders or terminal sessions...",
    "files.openSubmenuEmpty": "No matching entries",
    "context.title": "Context",
    "context.resizeExplorer": "Resize Context Explorer",
    "context.close": "Close",
    "context.files": "Files",
    "context.webPages": "Web Pages",
    "context.tasks": "Tasks",
    "context.comments": "Comments",
    "context.agents": "Agents",
    "context.tags": "Tags",
    "context.links": "Links",
    "context.headings": "Headings",
    "context.anchors": "Anchors",
    "context.modelUsage": "Model Usage",
    "context.basics": "Basics",
    "context.noSession": "No open session",
    "context.session": "Session",
    "context.terminalContext": "Terminal Context",
    "context.terminalInjected": "Injected into chat",
    "context.terminalNotInjected": "Not injected into chat",
    "context.terminalSessions": "Terminal Sessions",
    "context.terminalActive": "active {id}",
    "context.count": "{count}",
    "context.toolArtifacts": "Tool Artifacts",
    "context.itemCount": "{count}",
    "context.emptyFiles": "No file paths detected in the current session.",
    "context.emptyWeb": "No web links detected in the current session.",
    "context.emptyTasks": "No todos in the current session.",
    "context.emptyComments": "No comments in the current session.",
    "context.emptyAgents": "No agent tasks in the current session.",
    "context.emptyTags": "No tags in the current session.",
    "context.emptyLinks": "No wiki links in the current session.",
    "context.emptyHeadings": "No Markdown headings in the current session.",
    "context.emptyAnchors": "No block anchors in the current session.",
    "context.emptyUsage": "No model usage available for the current session.",
    "context.emptyBasics": "No basic context information.",
    "context.copyUsage": "Copy usage info",
    "context.openInFiles": "Reveal and open in Files",
    "context.addFolderToFiles": "Add to Files Panel",
    "context.addedFolderToFiles": "Added folder to Files panel",
    "context.openInFolder": "Open in Folder",
    "context.copyPath": "Copy path",
    "context.openUrl": "Open webpage",
    "context.copyUrl": "Copy link",
    "context.copyInfo": "Copy info",
    "context.copyComment": "Copy comment info",
    "context.copyAgentTask": "Copy agent task info",
    "context.copyTask": "Copy task info",
    "context.copyTodo": "Copy todo",
    "context.openingFiles": "Opening Files and locating file...",
    "context.copied": "Copied to clipboard",
    "context.run.streaming": "Answering",
    "context.run.ready": "Ready to continue",
    "context.run.error": "Error",
    "context.run.aborted": "Stopped",
    "context.run.idle": "Not running",
    "context.usage.files": "{count} files",
    "context.usage.modelCalls": "{count} model calls",
    "context.usage.input": "input {count}",
    "context.usage.output": "output {count}",
    "context.usage.cacheRead": "cache read {count}",
    "context.usage.cacheWrite": "cache write {count}",
    "context.tasks.todoLists": "{count} todo lists",
    "context.tasks.done": "{done}/{total} done",
    "context.tasks.doing": "{count} doing",
    "context.tasks.active": "active {name}",
    "context.tasks.activeWithName": "active {name}",
    "context.tasks.list": "Todo List {index}",
    "context.tasks.emptyTodo": "(empty todo)",
    "changes.title": "Changes",
    "changes.empty": "No file changes in the current session yet. Diffs from edit, write, or apply_patch tools will appear here.",
    "changes.files": "{count} files",
    "changes.wrap": "Wrap",
    "changes.wrapLongLines": "Wrap long lines",
    "changes.scrollLongLines": "Scroll long lines",
    "changes.expand": "Expand",
    "changes.collapse": "Collapse",
    "changes.expandAll": "Expand all files",
    "changes.collapseAll": "Collapse all files",
    "changes.refresh": "Refresh",
    "changes.new": "New",
    "changes.deleted": "Deleted",
    "changes.fileActions": "File actions",
    "changes.copyPath": "Copy Path",
    "changes.copyDiff": "Copy Diff",
    "changes.accept": "Accept",
    "changes.revert": "Revert",
    "changes.pathCopied": "Path copied",
    "changes.diffCopied": "Diff copied",
    "changes.copied": "Copied",
    "changes.copyFailed": "Copy failed"
  }
};

function t(key, fallback, values) {
  try {
    const translated = window.zion?.i18n?.t?.(`${I18N_NS}.${key}`, values);
    if (translated && translated !== `${I18N_NS}.${key}`) return translated;
  } catch {}
  return fallback;
}

function getSessionAnnotations(sessionId) {
  try {
    return window.zion?.commands?.executeCommand?.("zion.chatCards.getSessionAnnotations", sessionId) || {};
  } catch {
    return {};
  }
}

function updateSessionAnnotations(sessionId, updater) {
  try {
    return window.zion?.commands?.executeCommand?.("zion.chatCards.updateSessionAnnotations", { sessionId, updater }) || {};
  } catch {
    return {};
  }
}

export async function activate(ctx) {
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  // 注册默认工具与处理器
  registerDefaultTools();

  try {
    registerContextPanel(ctx);
  } catch (e) {
    console.warn("[dev.tools] register context panel failed", e);
  }

  // 右侧 Changes 面板：集中查看当前会话的 edit/write/apply_patch 文件产物
  try {
    registerChangesPanel(ctx);
  } catch (e) {
    console.warn("[dev.tools] register changes panel failed", e);
  }

  try {
    registerFilesPanel(ctx);
  } catch (e) {
    console.warn("[dev.tools] register files panel failed", e);
  }

  // 提供“从文档解析工具定义”的命令
  const dispParse = window.zion.commands.registerCommand("tools.parseFromContent", (content) => {
    const s = typeof content === "string" ? content : "";
    return parseToolsFromDocument(s);
  });
  ctx.subscriptions.push(dispParse);

  // 暴露工具调用查询 API
  // 提供给其他插件（如 tool-preview）查询工具调用信息
  window.zion.tools = {
    /**
     * 获取指定 ID 的工具调用信息
     * @param {string} toolId - 工具调用 ID
     * @returns {object|null} 工具调用对象 { id, name, args, result, expanded, from, to } 或 null
     */
    getToolCall(toolId) {
      if (!toolId) return null;
      const sid = window.zion?.state?.get("sessions.currentId");
      if (!sid) return null;

      const ann = getSessionAnnotations(sid);
      const tools = ann.tools || [];
      return tools.find(t => t.id === toolId) || null;
    },

    /**
     * 获取当前会话的所有工具调用
     * @returns {Array} 工具调用列表
     */
    getAllToolCalls() {
      const sid = window.zion?.state?.get("sessions.currentId");
      if (!sid) return [];

      const ann = getSessionAnnotations(sid);
      return ann.tools || [];
    },

    /**
     * 查找符合条件的工具调用
     * @param {Function} predicate - 过滤函数，接收一个工具调用对象，返回 boolean
     * @returns {Array} 符合条件的工具调用列表
     */
    findToolCalls(predicate) {
      const tools = this.getAllToolCalls();
      return tools.filter(predicate);
    },

    getSessionChangeState(sessionId) {
      return getSessionChangeState(sessionId);
    },

    getCurrentSessionChangeState() {
      return getCurrentSessionChangeState();
    }
  };

  // 注入工具调用卡片（ViewPlugin）
  const dispDec = window.zion.editor.registerDecorator({
    id: "dev.tools.tool-cards",
    apply(editor) {
      editor.addVisualExtension(installToolCallCards());
      return { dispose() {} };
    }
  });
  ctx.subscriptions.push(dispDec);

  // 工具切换器面板（搜索/键盘导航/Enter 切换/Esc 关闭）
  let toolSwitcher = null;
  const dispSwitcher = window.zion.editor.registerDecorator({
    id: "dev.tools.switcher",
    apply(editor) {
      if (String(editor?.panelId || "").startsWith("comments:")) return { dispose() {} };
      toolSwitcher = installToolSwitcher();
      return { dispose() { toolSwitcher?.dispose?.(); toolSwitcher = null; } };
    }
  });
  ctx.subscriptions.push(dispSwitcher);

  // 打开/关闭工具切换器命令
  const dispOpen = window.zion.commands.registerCommand("tools.openSwitcher", async () => {
    ensureEnabledTools();
    toolSwitcher?.open?.();
  });
  const dispClose = window.zion.commands.registerCommand("tools.closeSwitcher", () => {
    toolSwitcher?.close?.();
  });
  ctx.subscriptions.push(dispOpen, dispClose);

  // 状态栏按钮：Tools
  let toolsBtnDisp = null;
  const updateToolsBtn = () => {
    const all = window.zion.state.get("chat.tools") || [];
    const enabled = window.zion.state.get("chat.enabledTools");
    const enabledNames = Array.isArray(enabled) ? enabled : all.map(t => t?.function?.name).filter(Boolean);
    const n = enabledNames.filter(Boolean).length;
    toolsBtnDisp?.dispose?.();
    toolsBtnDisp = window.zion.bottomStatusBar?.registerItem?.({
      id: "dev.tools.button",
      text: t("status.tools", "Tools: {count}", { count: n }),
      tooltip: `${t("status.tooltip", "Manage enabled tools")} (Search / ↑↓ / PgUp/PgDn / Home/End / Enter / Esc)`,
      priority: 70,
      onClick: () => window.zion.commands.executeCommand("tools.openSwitcher")
    }) || window.zion.editorHeaderMenu?.register?.({
      id: "dev.tools.button",
      title: t("status.tools", "Tools: {count}", { count: n }),
      section: "Chat",
      order: 20,
      onClick: () => window.zion.commands.executeCommand("tools.openSwitcher")
    }) || window.zion.statusBar.registerItem({
      id: "dev.tools.button",
      text: t("status.tools", "Tools: {count}", { count: n }),
      tooltip: `${t("status.tooltip", "Manage enabled tools")} (Search / ↑↓ / PgUp/PgDn / Home/End / Enter / Esc)`,
      onClick: () => window.zion.commands.executeCommand("tools.openSwitcher")
    });
  };

  // ② 在「扩展全部加载完」后统一初始化启用列表（支持持久化）
  const off = window.zion.events.on('extensions:loaded', () => {
    try {
      const all = window.zion.state.get("chat.tools") || [];
      const names = all.map(t => t?.function?.name).filter(Boolean);

      // 从 localStorage 读取持久化的启用列表与用户是否自定义过
      let persisted = [];
      try { persisted = JSON.parse(localStorage.getItem("zion.enabledTools") || "[]"); } catch {}
      const userCustomizedStored = localStorage.getItem("zion.enabledTools.userCustomized") === "1";

      const filtered = Array.isArray(persisted) ? persisted.filter(n => names.includes(n)) : [];
      let finalEnabled = filtered;

      const userCustomized = userCustomizedStored || filtered.length < names.length;
      try { localStorage.setItem("zion.enabledTools.userCustomized", userCustomized ? "1" : "0"); } catch {}

      if (!Array.isArray(persisted) || persisted.length === 0) {
        // 首次或无持久化：默认全开，并记录为“未自定义”
        finalEnabled = names.slice();
        try { localStorage.setItem("zion.enabledTools.userCustomized", "0"); } catch {}
      } else if (!userCustomized) {
        // 用户未自定义过：自动把新增工具也打开
        finalEnabled = Array.from(new Set([...filtered, ...names]));
      }

      window.zion.state.set("chat.enabledTools", finalEnabled);
      window.zion.state.set("chat.toolsKnownNames", names.slice());
    } catch {}
  });
  ctx.subscriptions.push({ dispose: () => off.dispose?.() });

  updateToolsBtn();

  // 持久化启用列表到 localStorage，并在每次变更时更新状态按钮
  const persistEnabledTools = () => {
    try {
      const enabled = window.zion.state.get("chat.enabledTools");
      const enabledArr = Array.isArray(enabled) ? enabled.filter(Boolean) : [];
      const names = (window.zion.state.get("chat.tools") || []).map(t => t?.function?.name).filter(Boolean);

      let prev = [];
      try { prev = JSON.parse(localStorage.getItem("zion.enabledTools") || "[]"); } catch {}
      const prevArr = Array.isArray(prev) ? prev.filter(Boolean) : [];
      const keepUnknown = prevArr.filter(n => !names.includes(n));
      const merged = Array.from(new Set([...keepUnknown, ...enabledArr]));
      localStorage.setItem("zion.enabledTools", JSON.stringify(merged));

      const prevCustomized = localStorage.getItem("zion.enabledTools.userCustomized") === "1";
      const customizedNow = enabledArr.length < names.length;
      localStorage.setItem("zion.enabledTools.userCustomized", (prevCustomized || customizedNow) ? "1" : "0");
    } catch {}
  };

  const getToolRows = () => {
    ensureEnabledTools();
    const rawTools = window.zion.state.get("chat.tools") || [];
    const enabled = window.zion.state.get("chat.enabledTools");
    const names = rawTools.map((tool) => tool?.function?.name).filter(Boolean);
    const enabledNames = Array.isArray(enabled) ? enabled.filter((name) => names.includes(name)) : names;
    return buildToolRows(rawTools, enabledNames);
  };
  const setEnabledTools = async (value) => {
    const rawTools = window.zion.state.get("chat.tools") || [];
    const names = rawTools.map((tool) => tool?.function?.name).filter(Boolean);
    const next = Array.isArray(value) ? value.map(String).filter((name) => names.includes(name)) : [];
    window.zion.state.set("chat.enabledTools", next);
    window.zion.state.set("chat.toolsKnownNames", names);
    persistEnabledTools();
  };

  try {
    window.zion.settings.registerPage({
      id: "tools.preferences",
      pluginId: "dev.tools",
      category: "workspace",
      title: "Tools",
      titleKey: "dev.tools.settings.title",
      description: "启用工具与工具入口",
      descriptionKey: "dev.tools.settings.description",
      order: 38,
      sections: [
        {
          id: "tools.preferences.page",
          title: "Tools",
          titleKey: "dev.tools.settings.section",
          settings: [
            {
              id: "tools.preferences.manager",
              kind: "custom",
              label: "Tools",
              labelKey: "dev.tools.settings.manager",
              renderCustom: () =>
                createElement(ToolsSettingsPage, {
                  getTools: getToolRows,
                  setEnabledTools,
                  openSwitcher: () => window.zion.commands.executeCommand("tools.openSwitcher")
                })
            }
          ]
        }
      ]
    });
  } catch (e) {
    console.error("[dev.tools] register settings page failed", e);
  }

  ctx.subscriptions.push(
    window.zion.state.onDidChange("chat.tools", () => { ensureEnabledTools(); updateToolsBtn(); }),
    window.zion.state.onDidChange("chat.enabledTools", () => { persistEnabledTools(); updateToolsBtn(); }),
    window.zion.events.on("i18n/changed", updateToolsBtn)
  );

}

/**
 * 解析工具定义（从文档或状态），返回 OpenAI Function schema 数组
 */
function parseToolsFromDocument(content) {
  const tools = [];
  const lines = content.split("\n");
  let cur = null;
  for (const line of lines) {
    const head = line.match(/^tools?:\s*([a-zA-Z0-9_]+)\s*(.*)$/);
    if (head) {
      if (cur) tools.push(cur);
      cur = {
        type: "function",
        function: {
          name: head[1],
          description: head[2] || "",
          parameters: { type: "object", properties: {}, required: [] }
        }
      };
      continue;
    }
    if (cur) {
      const pm = line.match(/^\s*-\s+([a-zA-Z0-9_]+)\s*\((string|number|boolean|object|array)\)\s*:?\s*(.*)$/);
      if (pm) {
        cur.function.parameters.properties[pm[1]] = {
          type: pm[2],
          description: pm[3] || ""
        };
        continue;
      }
      const rm = line.match(/^\s*required:\s*(.+)$/);
      if (rm) {
        cur.function.parameters.required = rm[1].split(",").map(s => s.trim()).filter(Boolean);
        continue;
      }
      // 工具定义结束（遇到非缩进行）
      if (line.trim() && !/^\s/.test(line)) {
        tools.push(cur);
        cur = null;
      }
    }
  }
  if (cur) tools.push(cur);

  // 合并状态总线预注册工具
  const regTools = window.zion?.state?.get("chat.tools") || [];
  const merged = [...regTools, ...tools];

  // 依据启用列表过滤（chat.enabledTools），未设置则默认全启用
  const enabledNames = window.zion?.state?.get("chat.enabledTools");
  const set = Array.isArray(enabledNames) ? new Set(enabledNames) : null;
  const filtered = set ? merged.filter(t => t?.function?.name && set.has(t.function.name)) : merged;

  return filtered.length > 0 ? filtered : null;
}

/**
 * 确保 chat.enabledTools 与 chat.tools 同步
 * @param {boolean} forceAll  是否强制开启全部（忽略用户之前的手动关闭）
 */
function ensureEnabledTools(forceAll = false) {
  try {
    const all = window.zion?.state?.get("chat.tools") || [];
    const names = all.map(t => t?.function?.name).filter(Boolean);

    let cur = window.zion?.state?.get("chat.enabledTools") || [];
    let known = window.zion?.state?.get("chat.toolsKnownNames");
    let persisted = [];
    try { persisted = JSON.parse(localStorage.getItem("zion.enabledTools") || "[]"); } catch {}
    const persistedArr = Array.isArray(persisted) ? persisted.filter(Boolean) : [];
    const userCustomized = (() => {
      try { return localStorage.getItem("zion.enabledTools.userCustomized") === "1"; } catch { return false; }
    })();

    const isInitialized = Array.isArray(known) && known.length > 0;

    if (persistedArr.length > 0 && !forceAll) {
      const filtered = persistedArr.filter(n => names.includes(n));
      const next = userCustomized ? filtered : Array.from(new Set([...filtered, ...names]));
      window.zion?.state?.set("chat.enabledTools", next);
      window.zion?.state?.set("chat.toolsKnownNames", names.slice());
      return;
    }

    if (forceAll || !isInitialized) {
      window.zion?.state?.set("chat.enabledTools", names.slice());
      window.zion?.state?.set("chat.toolsKnownNames", names.slice());
      try { localStorage.setItem("zion.enabledTools.userCustomized", "0"); } catch {}
      return;
    }

    // 清理已不存在的工具
    const filtered = Array.isArray(cur) ? cur.filter(n => names.includes(n)) : [];

    if (userCustomized) {
      // 尊重用户选择：不自动开启新增工具
      window.zion?.state?.set("chat.enabledTools", filtered);
      window.zion?.state?.set("chat.toolsKnownNames", names.slice());
      return;
    }

    // 用户未自定义：自动开启新增工具
    const knownSet = new Set(Array.isArray(known) ? known : []);
    const newlyAdded = names.filter(n => !knownSet.has(n));
    const next = Array.from(new Set([...filtered, ...newlyAdded]));
    window.zion?.state?.set("chat.enabledTools", next);
    window.zion?.state?.set("chat.toolsKnownNames", names.slice());
  } catch {}
}

/**
 * 注册默认工具与处理器（仅在缺失时补充）
 */
function registerDefaultTools() {
  try {
    const defaultTools = [
      // TodoWrite: 结构化待办列表
      {
        type: "function",
        function: {
          name: "todoWrite",
          description: "Create or update a structured todo list for the current session",
          parameters: {
            type: "object",
            properties: {
              todos: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    content: { type: "string", minLength: 1 },
                    status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                    activeForm: { type: "string", minLength: 1 }
                  },
                  required: ["content", "status", "activeForm"],
                  additionalProperties: false
                },
                description: "The updated todo list"
              }
            },
            required: ["todos"],
            additionalProperties: false
          }
        }
      },
      // WebFetch: 抓取网页并转为markdown文本
      {
        type: "function",
        function: {
          name: "webFetch",
          description: "Fetch a URL and convert HTML to markdown-like text",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", format: "uri", description: "The URL to fetch content from" },
              prompt: { type: "string", description: "What to extract or summarize from the page (informational)" }
            },
            required: ["url", "prompt"],
            additionalProperties: false
          }
        }
      },
      // WebSearch: 简易网页搜索（DuckDuckGo代理）
      {
        type: "function",
        function: {
          name: "webSearch",
          description: "Search the web and return a list of relevant results",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 2, description: "The search query to use" },
              allowed_domains: { type: "array", items: { type: "string" }, description: "Only include results from these domains (optional)" },
              blocked_domains: { type: "array", items: { type: "string" }, description: "Exclude results from these domains (optional)" }
            },
            required: ["query"],
            additionalProperties: false
          }
        }
      },
      // LocalSearch: 本地超快搜索服务（通过 HTTP 调用本地 Python 服务）
      {
        type: "function",
        function: {
          name: "localSearch",
          description: "Fast local search via external Python service. Configure base URL in localStorage 'zion.localSearch.baseUrl' or state 'localSearch.baseUrl'.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1, description: "Search query" },
              top_k: { type: "number", description: "Max results to return (default 10)" },
              allowed_domains: { type: "array", items: { type: "string" }, description: "Only include results from these domains (optional)" },
              blocked_domains: { type: "array", items: { type: "string" }, description: "Exclude results from these domains (optional)" }
            },
            required: ["query"],
            additionalProperties: false
          }
        }
      },
      // Glob: Fast file pattern matching
      {
        type: "function",
        function: {
          name: "glob",
          description: "Fast file pattern matching. Returns matching file paths sorted by modification time.",
          parameters: {
            type: "object",
            properties: {
              pattern: { type: "string", description: "Glob pattern (e.g., **/*.js)" },
              path: { type: "string", description: "Directory to search (optional, default cwd)" },
              session_id: { type: "string", description: "Optional terminal session ID (local/ssh)" }
            },
            required: ["pattern"],
            additionalProperties: false
          }
        }
      },
      // Grep: ripgrep powered content search
      {
        type: "function",
        function: {
          name: "grep",
          description: "Powerful content search via local Python service (ripgrep-backed).",
          parameters: {
            type: "object",
            properties: {
              pattern: { type: "string", description: "Regex pattern to search" },
              path: { type: "string", description: "File or directory to search (default cwd)" },
              glob: { type: "array", items: { type: "string" }, description: "Glob filters (e.g., *.js, **/*.tsx)" },
              output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Output mode (default files_with_matches)" },
              B: { type: "number", description: "Lines to show before each match (content mode)" },
              A: { type: "number", description: "Lines to show after each match (content mode)" },
              C: { type: "number", description: "Lines to show before/after each match (content mode)" },
              n: { type: "boolean", description: "Show line numbers (content mode, default true)" },
              i: { type: "boolean", description: "Case insensitive (default false)" },
              type: { type: "string", description: "File type hint (rg --type js/py/rust...)" },
              head_limit: { type: "number", description: "Limit output to first N lines/entries" },
              offset: { type: "number", description: "Skip first N lines/entries" },
              multiline: { type: "boolean", description: "Enable multiline search (rg -U --multiline --multiline-dotall)" },
              session_id: { type: "string", description: "Optional terminal session ID (local/ssh)" }
            },
            required: ["pattern"],
            additionalProperties: false
          }
        }
      },
      // Read: read file content (local or session-aware)
      {
        type: "function",
        function: {
          name: "read",
            description: "Read a file's content (supports local or SSH session via local tools service). If multiple terminal sessions exist, especially with SSH or different working directories, prefer passing the correct session_id explicitly instead of relying on the current active session.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path to read" },
              offset: { type: "number", description: "Start line (1-based, optional)" },
              limit: { type: "number", description: "Number of lines to read (optional)" },
                session_id: { type: "string", description: "Optional terminal session ID (local/ssh). Strongly recommended when multiple sessions, SSH sessions, or different cwd values are present." }
            },
            required: ["path"],
            additionalProperties: false
          }
        }
      },
      // Write: overwrite a file (local or session-aware)
      {
        type: "function",
        function: {
          name: "write",
            description: "Write content to a file (supports local or SSH session via local tools service). If multiple terminal sessions exist, especially with SSH or different working directories, prefer passing the correct session_id explicitly instead of relying on the current active session.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path to write" },
              content: { type: "string", description: "Content to write" },
              prompt: { type: "string", description: "Short summary of what is being written (<=100 chars)" },
                session_id: { type: "string", description: "Optional terminal session ID (local/ssh). Strongly recommended when multiple sessions, SSH sessions, or different cwd values are present." }
            },
            required: ["path", "content"],
            additionalProperties: false
          }
        }
      },
      // Edit: exact string replacement in a file (local or session-aware)
      {
        type: "function",
        function: {
          name: "edit",
            description: "Edit a file by exact string replacement (supports local or SSH session via local tools service). If multiple terminal sessions exist, especially with SSH or different working directories, prefer passing the correct session_id explicitly instead of relying on the current active session.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path to edit" },
              old_string: { type: "string", description: "Exact string to replace" },
              new_string: { type: "string", description: "Replacement string" },
              replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
              prompt: { type: "string", description: "Short summary of what is being edited (<=100 chars)" },
                session_id: { type: "string", description: "Optional terminal session ID (local/ssh). Strongly recommended when multiple sessions, SSH sessions, or different cwd values are present." }
            },
            required: ["path", "old_string", "new_string"],
            additionalProperties: false
          }
        }
      },
      // ViewToolResult: view original tool result by tool_call_id
      {
        type: "function",
        function: {
          name: "viewToolResult",
          description: "View the original tool output by tool_call_id from the current session annotations.",
          parameters: {
            type: "object",
            properties: {
              tool_call_id: { type: "string", description: "The tool_call_id to view" }
            },
            required: ["tool_call_id"],
            additionalProperties: false
          }
        }
      },
      // Tree: directory tree (local or session-aware)
      {
        type: "function",
        function: {
          name: "tree",
          description: "Get directory tree structure (supports local or SSH session via local tools service).",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Directory path" },
              max_depth: { type: "number", description: "Maximum traversal depth (default 1)" },
              session_id: { type: "string", description: "Optional terminal session ID (local/ssh)" }
            },
            required: ["path"],
            additionalProperties: false
          }
        }
      },
      // Bash: execute local shell command via Python service
      {
        type: "function",
        function: {
          name: "Bash",
            description: "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures. When multiple terminal sessions exist, always prefer the correct session_id that matches the intended machine and cwd instead of assuming the current active session is right.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use the LS tool to verify the parent directory exists and is the correct location\n   - For example, before running \"mkdir foo/bar\", first use LS to check that \"foo\" exists and is the intended parent directory\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes (e.g., cd \"path with spaces/file.txt\")\n   - Examples of proper quoting:\n     - cd \"/Users/name/My Documents\" (correct)\n     - cd /Users/name/My Documents (incorrect - will fail)\n     - python \"/path/with spaces/script.py\" (correct)\n     - python /path/with spaces/script.py (incorrect - will fail)\n   - After ensuring proper quoting, execute the command.\n   - Capture the output of the command.\n\nUsage notes:\n  - The command argument is required.\n  - You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes).\n  - It is very helpful if you write a clear, concise description of what this command does in 5-10 words.\n  - If the output exceeds 30000 characters, output will be truncated before being returned to you.\n  - VERY IMPORTANT: Avoid using search commands like `find` and `grep`. Instead use Grep, Glob.\n  - When issuing multiple commands, use ';' or '&&'. DO NOT use newlines (except inside quoted strings).\n  - Prefer absolute paths over 'cd' unless the user requests it explicitly.",
          parameters: {
            type: "object",
            properties: {
              command: {
                type: "string",
                description: "The command to execute"
              },
              timeout: {
                type: "number",
                description: "Optional timeout in milliseconds (max 600000)"
              },
              description: {
                type: "string",
                description: "Clear, concise description of what this command does in 5-10 words"
              },
              dangerouslyDisableSandbox: {
                type: "boolean",
                description: "Set this to true to dangerously override sandbox mode and run commands without sandboxing."
              },
              session_id: {
                type: "string",
                  description: "Optional terminal session ID to execute within (see terminalManage). Strongly recommended when multiple sessions, SSH sessions, or different cwd values are present."
              }
            },
            required: ["command"],
            additionalProperties: false
          }
        }
      },
      // ToolsManage: 管理工具启用状态与查询
      {
        type: "function",
        function: {
          name: "toolsManage",
          description: "工具管理（list/get/enable/disable/set_enabled/sync）。list 显示全部工具及启用状态；enable/disable/set_enabled 控制 chat.enabledTools。",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["list","get","enable","disable","set_enabled","sync"], description: "操作类型" },
              name: { type: "string", description: "工具名称（get/enable/disable时可用）" },
              names: { type: "array", items: { type: "string" }, description: "工具名称数组（enable/disable/set_enabled时可用）" }
            },
            required: ["action"],
            additionalProperties: false
          }
        }
      },
      // PluginsManage: 管理插件（开发模式/安装/启用/禁用/卸载/列表）
      {
        type: "function",
        function: {
          name: "pluginsManage",
          description: "Manage plugins via Zion Next and local tools service: startDev/stopDev/list/installFromService/enable/disable/uninstall/setServiceUrl.",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["startDev","stopDev","list","installFromService","enable","disable","uninstall","setServiceUrl"], description: "Operation" },
              path: { type: "string", description: "Local plugin directory (for startDev)" },
              plugin_id: { type: "string", description: "Plugin ID (for install/enable/disable/uninstall)" },
              devId: { type: "string", description: "Dev session ID (for stopDev)" },
              serviceUrl: { type: "string", description: "Override local tools service base URL (default from localStorage zion.pluginServiceUrl)" }
            },
            required: ["action"],
            additionalProperties: false
          }
        }
      },
    ];

    // 合并到 chat.tools（避免重复）
    const existing = window.zion?.state?.get("chat.tools") || [];
    const existNames = new Set(existing.map(t => t?.function?.name).filter(Boolean));
    const merged = existing.slice();
    for (const t of defaultTools) {
      const nm = t?.function?.name;
      if (nm && !existNames.has(nm)) merged.push(t);
    }
    window.zion.state.set("chat.tools", merged);

    // 为示例工具补充处理器（若未自定义）
    const handlers = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };


    // WebFetch
    if (!handlers.webFetch) {
      handlers.webFetch = async (args) => {
        const raw = String(args?.url || "").trim();
        if (!raw) return "Missing url";
        const url = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
        const cache = window.zion?.state?.get("webfetch.cache") || {};
        const now = Date.now();
        const ttl = 15 * 60 * 1000; // 15 min
        try {
          // 清理过期缓存
          Object.keys(cache).forEach(k => {
            const it = cache[k];
            if (!it?.ts || now - it.ts > ttl) delete cache[k];
          });
          // 命中缓存
          if (cache[url] && now - cache[url].ts < ttl) {
            return cache[url].md.slice(0, 12000);
          }

          // 通过 r.jinaai.cn 代理抓取，规避浏览器 CORS
          const proxied = `https://r.jinaai.cn/${url}`;
          const res = await fetch(proxied, { redirect: "follow" });
          if (!res.ok) return `HTTP ${res.status}: ${await res.text().catch(() => "")}`;
          const text = await res.text();

          // 合成 markdown-like 文本（带标题与来源）
          const header = `# Fetched: ${url}\n\n`;
          const cleaned = String(text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
          let md = header + cleaned;

          // 缓存并返回（限制长度）
          cache[url] = { ts: now, md };
          window.zion.state.set("webfetch.cache", cache);
          return md.slice(0, 12000);
        } catch (e) {
          return `WebFetch error: ${e?.message || String(e)}`;
        }
      };
    }
    // WebSearch
    if (!handlers.webSearch) {
      handlers.webSearch = async (args) => {
        const query = String(args?.query || "").trim();
        if (!query) return "Missing query";
        const allowed = Array.isArray(args?.allowed_domains) ? args.allowed_domains.map(d => String(d).toLowerCase()) : [];
        const blocked = Array.isArray(args?.blocked_domains) ? args.blocked_domains.map(d => String(d).toLowerCase()) : [];
        try {
          // 使用 DuckDuckGo lite 版，经 r.jinaai.cn 代理规避 CORS
          const searchUrl = `https://r.jinaai.cn/http://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
          const res = await fetch(searchUrl);
          if (!res.ok) return `HTTP ${res.status}: ${await res.text().catch(() => "")}`;
          const txt = await res.text();

          // 1) 优先从 markdown 中提取 [title](url) 形式（r.jinaai.cn 常返回为 markdown/纯文本）
          const mdLinks = Array.from(txt.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g))
            .map(m => ({ title: (m[1] || "").trim(), url: m[2] }))
            // 过滤掉指向搜索页自身的链接
            .filter(it => it.title && it.url && !/duckduckgo\.com\/.*\?q=/i.test(it.url));

          // 2) 如果 markdown 提取过少，回退解析 HTML 的 <a href="http...">title</a>
          let raw = mdLinks.slice();
          if (raw.length < 3) {
            try {
              const doc = new DOMParser().parseFromString(txt, "text/html");
              doc.querySelectorAll('a[href^="http"]').forEach(a => {
                const href = a.getAttribute("href") || "";
                const title = (a.textContent || "").trim();
                if (href && title && !/duckduckgo\.com\/.*\?q=/i.test(href)) {
                  raw.push({ title, url: href });
                }
              });
            } catch { /* ignore parse fallback errors */ }
          }

          // 3) 去重与域名过滤
          const seen = new Set();
          const results = [];
          for (const it of raw) {
            if (!it?.url || !it?.title) continue;
            if (seen.has(it.url)) continue;
            seen.add(it.url);
            let host = "";
            try { host = new URL(it.url).hostname.toLowerCase(); } catch {}
            if (blocked.length && host && blocked.some(b => host.includes(b))) continue;
            if (allowed.length && host && !allowed.some(a => host.includes(a))) continue;
            // 再次防御性过滤掉搜索页本身
            if (/duckduckgo\.com\/.*\?q=/i.test(it.url)) continue;

            results.push(it);
            if (results.length >= 8) break;
          }

          return JSON.stringify({ query, results }, null, 2);
        } catch (e) {
          return `WebSearch error: ${e?.message || String(e)}`;
        }
      };
    }

    // LocalSearch (external Python service)
    if (!handlers.localSearch) {
      handlers.localSearch = async (args) => {
        const query = String(args?.query || "").trim();
        if (!query) return "Missing query";
        const topK = typeof args?.top_k === "number" && args.top_k > 0 ? Math.min(args.top_k, 50) : 10;
        const allowed = Array.isArray(args?.allowed_domains) ? args.allowed_domains.map(d => String(d).toLowerCase()) : [];
        const blocked = Array.isArray(args?.blocked_domains) ? args.blocked_domains.map(d => String(d).toLowerCase()) : [];

        const readBase = () => {
          const st = window.zion?.state?.get("localSearch.baseUrl");
          if (typeof st === "string" && st.trim()) return st.trim();
          try {
            const s = localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        let url = `${base.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&k=${topK}`;
        // pass domain filters to server (it also filters)
        try {
          allowed.forEach(d => { url += `&allowed_domains=${encodeURIComponent(d)}`; });
          blocked.forEach(d => { url += `&blocked_domains=${encodeURIComponent(d)}`; });
        } catch {}

        // cache
        const cache = window.zion?.state?.get("localSearch.cache") || {};
        const key = `${base}|${query}|${topK}|${allowed.join(",")}|${blocked.join(",")}`;
        const now = Date.now();
        const ttl = 10 * 60 * 1000; // 10 min
        try {
          Object.keys(cache).forEach(k => {
            const it = cache[k];
            if (!it?.ts || now - it.ts > ttl) delete cache[k];
          });
        } catch {}
        if (cache[key] && now - cache[key].ts < ttl) {
          return JSON.stringify(cache[key].data, null, 2);
        }

        try {
          const res = await fetch(url, { method: "GET" });
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return `HTTP ${res.status}: ${txt}`;
          }
          const data = await res.json().catch(() => null);
          let results = [];

          if (data && Array.isArray(data.results)) {
            results = data.results.map((it) => ({
              title: String(it.title || it.name || "").trim(),
              url: String(it.url || it.link || "").trim(),
              snippet: String(it.snippet || it.summary || it.description || "").trim()
            })).filter(r => r.title && r.url);
          } else if (Array.isArray(data)) {
            results = data.map((it) => ({
              title: String(it.title || it.name || "").trim(),
              url: String(it.url || it.link || "").trim(),
              snippet: String(it.snippet || it.summary || it.description || "").trim()
            })).filter(r => r.title && r.url);
          } else {
            // Fallback: attempt text links [title](url)
            const text = typeof data === "string" ? data : await res.text().catch(() => "");
            const mdLinks = Array.from(String(text).matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g))
              .map(m => ({ title: (m[1] || "").trim(), url: m[2], snippet: "" }));
            results = mdLinks;
          }

          // domain filters
          const filtered = results.filter(it => {
            let host = "";
            try { host = new URL(it.url).hostname.toLowerCase(); } catch {}
            if (blocked.length && host && blocked.some(b => host.includes(b))) return false;
            if (allowed.length && host && !allowed.some(a => host.includes(a))) return false;
            return true;
          }).slice(0, topK);

          const out = { query, results: filtered };
          cache[key] = { ts: now, data: out };
          window.zion?.state?.set("localSearch.cache", cache);
          return JSON.stringify(out, null, 2);
        } catch (e) {
          return `LocalSearch error: ${e?.message || String(e)}`;
        }
      };
    }

    // Glob (local/remote via local tools service, session-aware)
    if (!handlers.glob) {
      handlers.glob = async (args) => {
        const pattern = String(args?.pattern || "").trim();
        const path = String(args?.path || "").trim();
        const sessionId = String(args?.session_id || "").trim();
        if (!pattern) return "Missing pattern";

        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        let url = `${base.replace(/\/$/, "")}/files/glob?pattern=${encodeURIComponent(pattern)}`;
        if (path) url += `&path=${encodeURIComponent(path)}`;
        if (sessionId) url += `&session_id=${encodeURIComponent(sessionId)}`;

        try {
          const res = await fetch(url, { method: "GET" });
          if (!res.ok) return `HTTP ${res.status}: ${await res.text().catch(() => "")}`;
          const data = await res.json().catch(() => null);
          const results = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
          return JSON.stringify({ pattern, path: path || undefined, session_id: sessionId || undefined, results }, null, 2);
        } catch (e) {
          return `Glob error: ${e?.message || String(e)}`;
        }
      };
    }

    // Grep (local/remote via local tools service, ripgrep-backed)
    if (!handlers.grep) {
      handlers.grep = async (args) => {
        const pattern = String(args?.pattern || "").trim();
        if (!pattern) return "Missing pattern";
        const path = String(args?.path || "").trim();
        const sessionId = String(args?.session_id || "").trim();
        const outputMode = String(args?.output_mode || "files_with_matches");
        const B = typeof args?.B === "number" ? args.B : undefined;
        const A = typeof args?.A === "number" ? args.A : undefined;
        const C = typeof args?.C === "number" ? args?.C : undefined;
        const n = args?.n === undefined ? true : !!args?.n;
        const i = !!args?.i;
        const type = typeof args?.type === "string" ? String(args.type).trim() : "";
        const headLimit = typeof args?.head_limit === "number" ? args.head_limit : undefined;
        const offset = typeof args?.offset === "number" ? args.offset : undefined;
        const multiline = !!args?.multiline;

        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        let url = `${base.replace(/\/$/, "")}/files/grep?pattern=${encodeURIComponent(pattern)}&output_mode=${encodeURIComponent(outputMode)}`;
        if (path) url += `&path=${encodeURIComponent(path)}`;
        const glb = Array.isArray(args?.glob) ? args.glob : (typeof args?.glob === "string" && args?.glob.trim() ? [args.glob] : []);
        const defaultExcludes = ["!**/node_modules/**","!**/.git/**","!**/dist/**","!**/build/**","!**/.next/**","!**/.cache/**","!**/.venv/**","!**/venv/**","!**/target/**","!**/out/**","!**/coverage/**","!**/.tox/**","!**/.pytest_cache/**","!**/.idea/**","!**/.vscode/**","!**/tmp/**"];
        const mergedGlobs = (glb && glb.length > 0) ? Array.from(new Set([...glb, ...defaultExcludes])) : defaultExcludes;
        try {
          mergedGlobs.forEach(g => { url += `&glob=${encodeURIComponent(String(g))}`; });
        } catch {}
        if (B != null) url += `&B=${B}`;
        if (A != null) url += `&A=${A}`;
        if (C != null) url += `&C=${C}`;
        if (n != null) url += `&n=${n ? "true" : "false"}`;
        if (i) url += `&i=true`;
        if (type) url += `&type=${encodeURIComponent(type)}`;
        if (headLimit != null) url += `&head_limit=${headLimit}`;
        if (offset != null) url += `&offset=${offset}`;
        if (multiline) url += `&multiline=true`;
        if (sessionId) url += `&session_id=${encodeURIComponent(sessionId)}`;

        try {
          const res = await fetch(url, { method: "GET" });
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return `HTTP ${res.status}: ${txt}`;
          }
          const data = await res.json().catch(() => null);
          const results = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
          return JSON.stringify({ pattern, path: path || undefined, session_id: sessionId || undefined, output_mode: outputMode, results }, null, 2);
        } catch (e) {
          return `Grep error: ${e?.message || String(e)}`;
        }
      };
    }

    // Read (local tools service, session-aware)
    if (!handlers.read) {
      handlers.read = async (args) => {
        const path = String(args?.path || args?.file_path || "").trim();
        const sessionId = String(args?.session_id || "").trim();
        const offset = typeof args?.offset === "number" ? args.offset : undefined;
        const limit = typeof args?.limit === "number" ? args.limit : undefined;
        if (!path) return "Missing path";

        const getFpStore = () => {
          const v = window.zion?.state?.get("localTools.fileFingerprints");
          return v && typeof v === "object" ? v : {};
        };
        const setFpStore = (next) => {
          try {
            window.zion?.state?.set("localTools.fileFingerprints", next);
          } catch {}
        };
        const sha256Hex = async (text) => {
          try {
            const TextEncoderCtor = globalThis?.TextEncoder;
            if (!TextEncoderCtor) throw new Error("TextEncoder not available");
            const enc = new TextEncoderCtor();
            const buf = await crypto.subtle.digest("SHA-256", enc.encode(String(text)));
            const bytes = new Uint8Array(buf);
            let out = "";
            for (const b of bytes) out += b.toString(16).padStart(2, "0");
            return out;
          } catch {
            return `len:${String(text || "").length}`;
          }
        };

        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        let url = `${base.replace(/\/$/, "")}/files/read?path=${encodeURIComponent(path)}`;
        if (offset != null) url += `&offset=${offset}`;
        if (limit != null) url += `&limit=${limit}`;
        if (sessionId) url += `&session_id=${encodeURIComponent(sessionId)}`;

        try {
          const res = await fetch(url, { method: "GET" });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return `HTTP ${res.status}: ${txt || data?.error || "read failed"}`;
          }
          const content = typeof data?.content === "string" ? data.content : "";

          // Add line numbers (custom style: "   1 | content")
          const lines = content.split("\n");
          const startLine = (typeof offset === "number" && offset > 0) ? offset : 1;
          const endLine = startLine + lines.length - 1;

          const header = `// File: ${path} (${startLine}-${endLine})\n`;
          const numberedContent = lines.map((line, i) => {
            const num = String(startLine + i).padStart(6, " ");
            return `${num} | ${line}`;
          }).join("\n");

          const complete = offset == null && limit == null;
          const fp = getFpStore();
          fp[path] = complete
            ? { complete: true, hash: await sha256Hex(content), at: Date.now() }
            : { complete: false, hash: null, at: Date.now(), offset, limit };
          setFpStore(fp);
          return header + numberedContent;
        } catch (e) {
          return `Read error: ${e?.message || String(e)}`;
        }
      };
    }

    // Write (local tools service, session-aware)
    if (!handlers.write) {
      handlers.write = async (args, meta) => {
        const path = String(args?.path || args?.file_path || "").trim();
        const content = String(args?.content ?? "");
        const prompt = typeof args?.prompt === "string" ? args.prompt : undefined;
        const sessionId = String(args?.session_id || "").trim();
        if (!path) return "Missing path";
        const chatSessionId = String(meta?.sessionId || "").trim() || window.zion?.state?.get("sessions.currentId");
        const toolCallId = String(meta?.toolCallId || args?.tool_call_id || args?.toolCallId || "").trim() || undefined;

        const getFpStore = () => {
          const v = window.zion?.state?.get("localTools.fileFingerprints");
          return v && typeof v === "object" ? v : {};
        };
        const setFpStore = (next) => {
          try {
            window.zion?.state?.set("localTools.fileFingerprints", next);
          } catch {}
        };
        const sha256Hex = async (text) => {
          try {
            const TextEncoderCtor = globalThis?.TextEncoder;
            if (!TextEncoderCtor) throw new Error("TextEncoder not available");
            const enc = new TextEncoderCtor();
            const buf = await crypto.subtle.digest("SHA-256", enc.encode(String(text)));
            const bytes = new Uint8Array(buf);
            let out = "";
            for (const b of bytes) out += b.toString(16).padStart(2, "0");
            return out;
          } catch {
            return `len:${String(text || "").length}`;
          }
        };
        const readCurrent = async (base) => {
          let u = `${base.replace(/\/$/, "")}/files/read?path=${encodeURIComponent(path)}`;
          if (sessionId) u += `&session_id=${encodeURIComponent(sessionId)}`;
          const res = await fetch(u, { method: "GET" });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status}: ${txt || data?.error || "read failed"}`);
          }
          if (data && data.error) {
            throw new Error(String(data.error));
          }
          return typeof data?.content === "string" ? data.content : "";
        };

        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        const url = `${base.replace(/\/$/, "")}/files/write`;
        try {
          let beforeContent = null;
          let beforeExists = null;
          let beforeHash = null;
          let beforeSize = null;
          let beforeError = null;
          try {
            const cur = await readCurrent(base);
            beforeContent = cur;
            beforeExists = true;
            beforeHash = await sha256Hex(cur);
            beforeSize = cur.length;
          } catch (e) {
            beforeError = e?.message || String(e);
            if (/no such file|not found|enoent/i.test(String(beforeError || ""))) {
              beforeExists = false;
            }
          }
          const fp = getFpStore();
          // const prev = fp[path];
          // // 新文件（未读取过）：允许直接写入
          // if (!prev) {
          //   // 先尝试读取当前文件内容（如果存在）来检测冲突
          //   try {
          //     const cur = await readCurrent(base);
          //     // 如果文件已存在，说明需要提示用户先读取
          //     return "Write blocked: file exists but has not been read yet. Please read the file first (use read) to avoid accidental overwrites.";
          //   } catch (e) {
          //     // 文件不存在（新文件），允许写入
          //   }
          // }
          // // 已读取过但不完整：要求完整读取
          // if (prev && !prev.complete) return "Write blocked: you must read the full file first (read without offset/limit).";
          // // 已读取过且完整：检查文件是否被外部修改
          // if (prev && prev.complete && typeof prev.hash === "string" && prev.hash) {
          //   const cur = await readCurrent(base);
          //   const curHash = await sha256Hex(cur);
          //   if (curHash !== prev.hash) {
          //     return "Write blocked: file changed since last read (likely edited in editor). Please read again.";
          //   }
          // }

          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path, content, session_id: sessionId || undefined })
          });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            if (chatSessionId) {
              const entry = {
                toolCallId,
                path,
                prompt,
                beforeContent,
                beforeExists,
                beforeHash,
                beforeSize,
                beforeError,
                ok: false,
                error: txt || data?.error || "write failed",
                at: Date.now()
              };
              updateSessionAnnotations(chatSessionId, (prev) => {
                const list = Array.isArray(prev.writeHistory) ? prev.writeHistory : [];
                return { ...prev, writeHistory: [...list, entry] };
              });
            }
            return `HTTP ${res.status}: ${txt || data?.error || "write failed"}`;
          }

          // fp[path] = { complete: true, hash: await sha256Hex(content), at: Date.now() };
          // setFpStore(fp);
          if (chatSessionId) {
            const entry = {
              toolCallId,
              path,
              prompt,
              beforeContent,
              beforeExists,
              beforeHash,
              beforeSize,
              beforeError,
              afterContent: content,
              afterHash: await sha256Hex(content),
              afterSize: content.length,
              ok: true,
              at: Date.now()
            };
            updateSessionAnnotations(chatSessionId, (prev) => {
              const list = Array.isArray(prev.writeHistory) ? prev.writeHistory : [];
              return { ...prev, writeHistory: [...list, entry] };
            });
          }
          const out = { ...(data || {}), path, prompt };
          return JSON.stringify(out, null, 2);
        } catch (e) {
          return `Write error: ${e?.message || String(e)}`;
        }
      };
    }

    // Edit (local tools service, session-aware)
    if (!handlers.edit) {
      handlers.edit = async (args) => {
        const path = String(args?.path || args?.file_path || "").trim();
        const old_string = String(args?.old_string ?? "");
        const new_string = String(args?.new_string ?? "");
        const replace_all = !!args?.replace_all;
        const prompt = typeof args?.prompt === "string" ? args.prompt : undefined;
        const sessionId = String(args?.session_id || "").trim();
        if (!path) return "Missing path";
        if (!old_string) return "Missing old_string";

        const getFpStore = () => {
          const v = window.zion?.state?.get("localTools.fileFingerprints");
          return v && typeof v === "object" ? v : {};
        };
        const setFpStore = (next) => {
          try {
            window.zion?.state?.set("localTools.fileFingerprints", next);
          } catch {}
        };
        const sha256Hex = async (text) => {
          try {
            const TextEncoderCtor = globalThis?.TextEncoder;
            if (!TextEncoderCtor) throw new Error("TextEncoder not available");
            const enc = new TextEncoderCtor();
            const buf = await crypto.subtle.digest("SHA-256", enc.encode(String(text)));
            const bytes = new Uint8Array(buf);
            let out = "";
            for (const b of bytes) out += b.toString(16).padStart(2, "0");
            return out;
          } catch {
            return `len:${String(text || "").length}`;
          }
        };
        const readCurrent = async (base) => {
          let u = `${base.replace(/\/$/, "")}/files/read?path=${encodeURIComponent(path)}`;
          if (sessionId) u += `&session_id=${encodeURIComponent(sessionId)}`;
          const res = await fetch(u, { method: "GET" });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status}: ${txt || data?.error || "read failed"}`);
          }
          return typeof data?.content === "string" ? data.content : "";
        };

        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        const url = `${base.replace(/\/$/, "")}/files/edit`;
        try {
          // const fp = getFpStore();
          // const prev = fp[path];
          // // 新文件（未读取过）：不允许编辑（文件不存在）
          // if (!prev) {
          //   try {
          //     await readCurrent(base);
          //     // 如果能读取到，说明文件存在但未读取过
          //     return "Edit blocked: file exists but has not been read yet. Please read the file first (use read).";
          //   } catch (e) {
          //     // 文件不存在，不允许编辑
          //     return "Edit blocked: file does not exist. Use 'write' to create new files.";
          //   }
          // }
          // // 已读取过但不完整：要求完整读取
          // if (prev && !prev.complete) return "Edit blocked: you must read the full file first (read without offset/limit).";
          // // 已读取过且完整：检查文件是否被外部修改
          // if (prev && prev.complete && typeof prev.hash === "string" && prev.hash) {
          //   const cur = await readCurrent(base);
          //   const curHash = await sha256Hex(cur);
          //   if (curHash !== prev.hash) {
          //     return "Edit blocked: file changed since last read (likely edited in editor). Please read again.";
          //   }
          // }

          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path, old_string, new_string, replace_all, session_id: sessionId || undefined })
          });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return `HTTP ${res.status}: ${txt || data?.error || "edit failed"}`;
          }

          // try {
          //   const updated = await readCurrent(base);
          //   fp[path] = { complete: true, hash: await sha256Hex(updated), at: Date.now() };
          //   setFpStore(fp);
          // } catch {}
          const out = { ...(data || {}), path, old_string, new_string, replace_all, prompt };
          return JSON.stringify(out, null, 2);
        } catch (e) {
          return `Edit error: ${e?.message || String(e)}`;
        }
      };
    }

    // Tree (local tools service, session-aware)
    if (!handlers.tree) {
      handlers.tree = async (args) => {
        const path = String(args?.path || "").trim();
        const depth = typeof args?.max_depth === "number" ? args.max_depth : 1;
        const sessionId = String(args?.session_id || "").trim();
        if (!path) return "Missing path";

        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        let url = `${base.replace(/\/$/, "")}/files/entries?path=${encodeURIComponent(path)}&max_depth=${depth}`;
        if (sessionId) url += `&session_id=${encodeURIComponent(sessionId)}`;

        try {
          const res = await fetch(url, { method: "GET" });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return `HTTP ${res.status}: ${txt || data?.error || "tree failed"}`;
          }
          // 直接返回 tree 的文本结果
          const results = typeof data?.results === "string" ? data.results : "";
          return results;
        } catch (e) {
          return `Tree error: ${e?.message || String(e)}`;
        }
      };
    }

    // ViewToolResult: return original tool result by id
    if (!handlers.viewToolResult) {
      handlers.viewToolResult = async (args) => {
        const toolId = String(args?.tool_call_id || args?.id || "").trim();
        if (!toolId) return "Missing tool_call_id";
        try {
          const sid = window.zion?.state?.get("sessions.currentId");
          if (!sid) return "No session";
          const ann = getSessionAnnotations(sid);
          const items = Array.isArray(ann.tools) ? ann.tools : [];
          const it = items.find(x => String(x.id) === toolId);
          if (!it) return "Not found";
          return String(it.result ?? "");
        } catch (e) {
          return `ViewToolResult error: ${e?.message || String(e)}`;
        }
      };
    }
    // Bash (local tools) with session support
    if (!handlers.Bash) {
      handlers.Bash = async (args) => {
        const command = String(args?.command || "").trim();
        if (!command) return "Missing command";
        const timeout = typeof args?.timeout === "number" ? Math.min(Math.max(args.timeout, 1), 600000) : undefined;
        const sessionId = String(args?.session_id || "").trim();
        const dangerouslyDisableSandbox = !!args?.dangerouslyDisableSandbox;

        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        const baseClean = base.replace(/\/$/, "");

        try {
          // 如果带有 session_id，则调用 sessions/{id}/exec
          if (sessionId) {
            const urlSess = `${baseClean}/sessions/${encodeURIComponent(sessionId)}/exec`;
            const res = await fetch(urlSess, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ command, timeout, dangerouslyDisableSandbox })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
              const txt = typeof data === "string" ? data : (await res.text().catch(() => ""));
              return `HTTP ${res.status}: ${txt}`;
            }
            if (!data) return "Empty response";
            // sandbox blocked message unify
            if (data.error && typeof data.error === 'string' && data.error.includes('blocked_by_sandbox')) {
              const patternMatch = data.error.match(/pattern[:\s]+(.+)$/);
              const matchedPattern = patternMatch ? patternMatch[1].trim() : 'unknown pattern';
              const errorMsg = `Command blocked by sandbox security rules.\n` +
                              `Reason: The command contains "${matchedPattern}" which matches a restricted pattern.\n` +
                              `Command: ${command}\n` +
                              `Session: ${sessionId}\n` +
                              `\nTo bypass this restriction, you can:\n` +
                              `1. Use a different path that doesn't contain restricted keywords\n` +
                              `2. Add "dangerouslyDisableSandbox": true to the command arguments\n` +
                              `3. Configure the local service to allow dangerous commands (ZION_ALLOW_DANGEROUS=1)`;
              return JSON.stringify({
                command,
                session_id: sessionId,
                ok: false,
                error: data.error,
                sandbox_blocked: true,
                user_message: errorMsg,
                sandbox: data.sandbox || true,
                cwd: typeof data.cwd === "string" ? data.cwd : undefined
              }, null, 2);
            }
            const out = {
              command,
              session_id: sessionId,
              exit_code: typeof data.exit_code === "number" ? data.exit_code : undefined,
              timeout_ms: typeof data.timeout_ms === "number" ? data.timeout_ms : undefined,
              duration_ms: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
              stdout: String(data.stdout ?? ""),
              stderr: String(data.stderr ?? ""),
              ok: !!data.ok,
              truncated: !!data.truncated,
              ...(data.error ? { error: data.error } : {}),
              ...(data.sandbox !== undefined ? { sandbox: data.sandbox } : {}),
              ...(typeof data.cwd === "string" ? { cwd: data.cwd } : {})
            };
            return JSON.stringify(out, null, 2);
          }

          // 否则走原 /bash
          const url = `${baseClean}/bash`;
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command, timeout, dangerouslyDisableSandbox })
          });
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return `HTTP ${res.status}: ${txt}`;
          }
          const data = await res.json().catch(() => null);
          if (!data) return "Empty response";

          if (data.error && typeof data.error === 'string' && data.error.includes('blocked_by_sandbox')) {
            const patternMatch = data.error.match(/pattern[:\s]+(.+)$/);
            const matchedPattern = patternMatch ? patternMatch[1].trim() : 'unknown pattern';
            const errorMsg = `Command blocked by sandbox security rules.\n` +
                            `Reason: The command contains "${matchedPattern}" which matches a restricted pattern.\n` +
                            `Command: ${command}\n` +
                            `\nTo bypass this restriction, you can:\n` +
                            `1. Use a different path that doesn't contain restricted keywords\n` +
                            `2. Add "dangerouslyDisableSandbox": true to the command arguments\n` +
                            `3. Configure the local service to allow dangerous commands (ZION_ALLOW_DANGEROUS=1)`;
            return JSON.stringify({
              command,
              ok: false,
              error: data.error,
              sandbox_blocked: true,
              user_message: errorMsg,
              sandbox: data.sandbox || true,
              cwd: typeof data.cwd === "string" ? data.cwd : undefined
            }, null, 2);
          }

          const out = {
            command,
            exit_code: typeof data.exit_code === "number" ? data.exit_code : undefined,
            timeout_ms: typeof data.timeout_ms === "number" ? data.timeout_ms : undefined,
            duration_ms: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
            stdout: String(data.stdout ?? ""),
            stderr: String(data.stderr ?? ""),
            ok: !!data.ok,
            truncated: !!data.truncated,
            ...(data.error ? { error: data.error } : {}),
            ...(data.sandbox !== undefined ? { sandbox: data.sandbox } : {}),
            ...(typeof data.cwd === "string" ? { cwd: data.cwd } : {})
          };
          return JSON.stringify(out, null, 2);
        } catch (e) {
          return `Bash error: ${e?.message || String(e)}`;
        }
      };
    }

    // ToolsManage: 管理工具启用状态与查询
    if (!handlers.toolsManage) {
      handlers.toolsManage = async (args) => {
        try {
          const action = String(args?.action || "").trim();
          const regTools = window.zion?.state?.get("chat.tools") || [];
          const allNames = regTools.map(t => t?.function?.name).filter(Boolean);
          const enabled = window.zion?.state?.get("chat.enabledTools");
          const enabledSet = new Set(Array.isArray(enabled) ? enabled : allNames);

          const uniqNamesFromArgs = () => {
            let arr = [];
            const n1 = typeof args?.name === "string" ? [String(args.name).trim()] : [];
            const n2 = Array.isArray(args?.names) ? args.names.map(s => String(s).trim()) : [];
            arr = [...n1, ...n2].filter(Boolean);
            return Array.from(new Set(arr));
          };

          if (action === "list") {
            const out = regTools.map(t => ({
              name: t?.function?.name,
              description: t?.function?.description || "",
              enabled: enabledSet.has(t?.function?.name)
            })).filter(it => it.name);
            return JSON.stringify({ tools: out, enabled: Array.from(enabledSet) }, null, 2);
          }

          if (action === "get") {
            const nm = String(args?.name || "").trim();
            if (!nm) return "Missing name";
            const item = regTools.find(t => t?.function?.name === nm);
            if (!item) return `Tool not found: ${nm}`;
            return JSON.stringify(item.function || item, null, 2);
          }

          if (action === "enable") {
            const toEnable = uniqNamesFromArgs().filter(n => allNames.includes(n));
            if (toEnable.length === 0) return "No valid tool names to enable";
            toEnable.forEach(n => enabledSet.add(n));
            window.zion?.state?.set("chat.enabledTools", Array.from(enabledSet));
            // 更新已知列表，防止被自动清理
            window.zion?.state?.set("chat.toolsKnownNames", allNames);
            return JSON.stringify({ enabled: Array.from(enabledSet) }, null, 2);
          }

          if (action === "disable") {
            const toDisable = uniqNamesFromArgs().filter(n => allNames.includes(n));
            if (toDisable.length === 0) return "No valid tool names to disable";
            toDisable.forEach(n => enabledSet.delete(n));
            window.zion?.state?.set("chat.enabledTools", Array.from(enabledSet));
            window.zion?.state?.set("chat.toolsKnownNames", allNames);
            return JSON.stringify({ enabled: Array.from(enabledSet) }, null, 2);
          }

          if (action === "set_enabled") {
            const list = Array.isArray(args?.names) ? args.names.map(s => String(s).trim()).filter(Boolean) : [];
            const inter = list.filter(n => allNames.includes(n));
            window.zion?.state?.set("chat.enabledTools", inter);
            window.zion?.state?.set("chat.toolsKnownNames", allNames);
            return JSON.stringify({ enabled: inter }, null, 2);
          }

          if (action === "sync") {
            try { ensureEnabledTools(); } catch {}
            const cur = window.zion?.state?.get("chat.enabledTools") || [];
            return JSON.stringify({ enabled: cur }, null, 2);
          }

          return "Unknown action";
        } catch (e) {
          return `toolsManage error: ${e?.message || String(e)}`;
        }
      };
    }

    // 移除 terminalManage 处理器（迁移到 dev.terminal-manager 扩展中）

    // PluginsManage: 管理插件（开发模式/安装/启用/禁用/卸载/列表）
    if (!handlers.pluginsManage) {
      handlers.pluginsManage = async (args) => {
        try {
          const action = String(args?.action || "").trim();
          const pm = (window.zion || {}).plugins;
          const installer = (window.zion || {}).pluginInstaller;

          const readServiceUrl = () => {
            try { return (localStorage.getItem("zion.pluginServiceUrl") || "http://127.0.0.1:8765").replace(/\/$/, ""); }
            catch { return "http://127.0.0.1:8765"; }
          };

          const ensurePM = () => {
            if (!pm) throw new Error("PluginManager not ready");
            if (!installer) throw new Error("PluginInstaller not ready");
          };

          const connectDevWS = (serviceBase, devId, baseUrlAbs, pluginId) => {
            try {
              const wsUrl = serviceBase.replace(/^http/, "ws") + `/plugins/dev/ws/${devId}`;
              const ws = new WebSocket(wsUrl);
              ws.onmessage = async (ev) => {
                try {
                  const msg = JSON.parse(ev.data);
                  if (msg?.type === "dev:change" && msg?.devId === devId) {
                    const ret = await installer.installFromDevBase(baseUrlAbs, devId);
                    if (ret.success && ret.plugin) {
                      try {
                        // 使用热重载方法（不检查版本变化）
                        await pm.hotReloadFromInfo(ret.plugin, { enabled: true });
                      } catch (e) {
                        console.warn("[pluginsManage] dev hot reload failed:", e);
                      }
                    }
                  }
                } catch {}
              };
              ws.onopen = () => { /* optional log */ };
              ws.onclose = () => { /* optional log */ };

              const sessions = window.zion.state.get("plugins.devSessions") || {};
              sessions[devId] = { ws, baseUrl: baseUrlAbs, pluginId };
              window.zion.state.set("plugins.devSessions", sessions);
            } catch (e) { /* ignore ws error */ }
          };

          if (action === "setServiceUrl") {
            const url = String(args?.serviceUrl || "").trim();
            if (!url) return "Missing serviceUrl";
            try {
              localStorage.setItem("zion.pluginServiceUrl", url);
              if (installer?.setBaseUrl) installer.setBaseUrl(url);
            } catch {}
            return JSON.stringify({ ok: true, serviceUrl: url });
          }

          if (action === "list") {
            ensurePM();
            // Gather dev sessions mapping (runtime + persisted)
            const sessionsState = window.zion?.state?.get("plugins.devSessions") || {};
            let persisted = {};
            try { persisted = JSON.parse(localStorage.getItem("zion.plugins.devSessionsInfo") || "{}"); } catch {}
            const items = pm.list().map(p => {
              const run = Object.values(sessionsState).find((s) => s && s.pluginId === p.id) || null;
              const saved = persisted[p.id] || null;
              const devDir = (run && run.dir) || (saved && saved.dir) || undefined;
              const devBaseUrl = (run && run.baseUrl) || (saved && saved.baseUrl) || undefined;
              return {
                id: p.id,
                name: p.name,
                version: p.version,
                enabled: !!p.enabled,
                state: p.state,
                devDir,
                devBaseUrl
              };
            });
            return JSON.stringify({ plugins: items }, null, 2);
          }

          if (action === "installFromService") {
            ensurePM();
            const pluginId = String(args?.plugin_id || "").trim();
            if (!pluginId) return "Missing plugin_id";
            const ret = await installer.installFromService(pluginId);
            if (!ret.success || !ret.plugin) return `Install failed: ${ret.error?.message || "Unknown"}`;
            await pm.installFromInfo(ret.plugin, { enabled: true });
            return JSON.stringify({ ok: true, installed: ret.plugin.id }, null, 2);
          }

          if (action === "enable") {
            ensurePM();
            const pluginId = String(args?.plugin_id || "").trim();
            if (!pluginId) return "Missing plugin_id";
            await pm.enable(pluginId);
            return JSON.stringify({ ok: true, enabled: pluginId }, null, 2);
          }

          if (action === "disable") {
            ensurePM();
            const pluginId = String(args?.plugin_id || "").trim();
            if (!pluginId) return "Missing plugin_id";
            await pm.disable(pluginId);
            return JSON.stringify({ ok: true, disabled: pluginId }, null, 2);
          }

          if (action === "uninstall") {
            ensurePM();
            const pluginId = String(args?.plugin_id || "").trim();
            if (!pluginId) return "Missing plugin_id";
            await pm.uninstall(pluginId);
            return JSON.stringify({ ok: true, uninstalled: pluginId }, null, 2);
          }

          if (action === "startDev") {
            ensurePM();
            const path = String(args?.path || "").trim();
            const serviceUrl = String(args?.serviceUrl || "") || readServiceUrl();
            if (!path) return "Missing path";

            const res = await fetch(`${serviceUrl}/plugins/dev/start`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path })
            });
            if (!res.ok) {
              const txt = await res.text().catch(() => "");
              return `HTTP ${res.status}: ${txt || "dev start failed"}`;
            }
            const data = await res.json().catch(() => null);
            const devId = data?.data?.devId;
            const baseUrlRel = data?.data?.baseUrl;
            if (!devId || !baseUrlRel) return "Invalid dev start response";

            const baseAbs = serviceUrl.replace(/\/$/, "") + baseUrlRel;
            const ret = await installer.installFromDevBase(baseAbs, devId);
            if (!ret.success || !ret.plugin) return `Install failed: ${ret.error?.message || "Unknown"}`;
            await pm.installFromInfo(ret.plugin, { enabled: true });

            connectDevWS(serviceUrl, devId, baseAbs, ret.plugin.id);

            return JSON.stringify({ ok: true, devId, plugin: ret.plugin.id, baseUrl: baseAbs }, null, 2);
          }

          if (action === "stopDev") {
            const devId = String(args?.devId || "").trim();
            const serviceUrl = String(args?.serviceUrl || "") || readServiceUrl();
            const sessions = window.zion.state.get("plugins.devSessions") || {};
            const stopOne = async (id) => {
              try {
                await fetch(`${serviceUrl}/plugins/dev/stop`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ devId: id })
                }).catch(() => {});
              } catch {}
              try { sessions[id]?.ws?.close?.(); } catch {}
              delete sessions[id];
            };

            if (devId) {
              await stopOne(devId);
            } else {
              const ids = Object.keys(sessions);
              for (const id of ids) { await stopOne(id); }
            }
            window.zion.state.set("plugins.devSessions", sessions);
            return JSON.stringify({ ok: true, stopped: devId || "all" }, null, 2);
          }

          return "Unknown action";
        } catch (e) {
          return `pluginsManage error: ${e?.message || String(e)}`;
        }
      };
    }

    // 包装工具处理器：自动注入 terminal 上下文
    const wrappedHandlers = wrapHandlersWithTerminalContext(handlers);
    window.zion.state.set("chat.toolHandlers", wrappedHandlers);

    // 同步启用列表（默认启用全部；新增/移除时更新）
    try { ensureEnabledTools(); } catch {}
  } catch (e) {
    console.warn("[dev.tools] registerDefaultTools failed", e);
  }
}

/**
 * 包装工具处理器：自动注入当前 active terminal 的 session_id
 * 
 * 设计原则：
 * 1. 插件间依赖最小：只读取状态，不依赖具体实现
 * 2. 向后兼容：用户仍可显式传递 session_id 来覆盖
 * 3. 集中管理：便于维护和扩展
 */
function wrapHandlersWithTerminalContext(handlers) {
  // 需要自动注入 session_id 的工具列表
  const terminalAwareTools = [
    'tree',      // 目录树
    'read',      // 读取文件
    'write',     // 写入文件
    'edit',      // 编辑文件
    'glob',      // 文件模式匹配
    'grep',      // 内容搜索
    'Bash'       // Shell 命令
  ];
  
  for (const toolName of terminalAwareTools) {
    if (handlers[toolName]) {
      const originalHandler = handlers[toolName];
      
      // 创建包装后的处理器
      handlers[toolName] = async function(args, ...rest) {
        try {
          // 如果用户没有显式传递 session_id，则自动从 terminal.activeSessionId 获取
          // 注意：只在 args 不存在或为 undefined 时自动注入
          // 如果用户显式传递了 null 或空字符串，则视为用户意图不使用 session
          if (args && args.session_id === undefined) {
            const activeSessionId = window.zion?.state?.get("terminal.activeSessionId");
            if (activeSessionId) {
              // 创建新的 args 对象，避免修改原参数
              args = { ...args, session_id: activeSessionId };
            }
          }
          
          // 调用原始处理器
          return originalHandler(args, ...rest);
        } catch (e) {
          console.error(`[dev.tools] Wrapped handler for ${toolName} failed:`, e);
          throw e;
        }
      };
      
      // 保持原始处理器的引用（便于调试）
      handlers[toolName].originalHandler = originalHandler;
    }
  }
  
  return handlers;
}
