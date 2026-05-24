import { matchSorter, rankings } from "match-sorter";

type CommandMeta = {
  id: string;
  title: string;
  titleKey?: string;
  description?: string;
  descriptionKey?: string;
  category?: string;
  categoryKey?: string;
  pluginId?: string;
  registered: boolean;
  keybindings: Array<{ key: string; when?: string }>;
  searchText?: string[];
};

type CommandMetaContribution = Pick<CommandMeta, "id" | "title" | "titleKey" | "description" | "descriptionKey" | "category" | "categoryKey" | "pluginId" | "searchText">;

const STYLE_ID = "zion-command-palette-style";
const RECENT_KEY = "zion.commandPalette.recent.v2";

type PaletteItem =
  | {
      kind: "command";
      meta: CommandMeta;
    }
  | {
      kind: "action";
      id: string;
      title: string;
      description?: string;
      badge?: string;
      keywords?: string[];
      run: () => void | Promise<void>;
    }
  | {
      kind: "session";
      id: string;
      title: string;
      updatedAt?: number;
      open: boolean;
      path?: string;
    };

const THEME_OPTIONS = [
  {
    id: "system",
    title: "System",
    description: "跟随系统外观自动切换 Light / Dark",
    keywords: ["theme", "appearance", "system", "auto", "跟随系统"]
  },
  {
    id: "dark",
    title: "Dark",
    description: "Zion Next 默认深色主题",
    keywords: ["theme", "appearance", "dark", "默认深色"]
  },
  {
    id: "light",
    title: "Light",
    description: "Zion Next 默认浅色主题",
    keywords: ["theme", "appearance", "light", "浅色"]
  },
  {
    id: "visual-studio-dark",
    title: "深色 (Visual Studio)",
    description: "参考 VS Code Visual Studio Dark 的深色主题",
    keywords: ["theme", "appearance", "dark", "visual studio", "vscode", "vs dark"]
  }
] as const;

const LANGUAGE_OPTIONS = [
  {
    id: "zh-CN",
    title: "简体中文",
    description: "默认界面语言",
    keywords: ["language", "locale", "中文", "简体中文", "chinese"]
  },
  {
    id: "en-US",
    title: "English",
    description: "English interface language",
    keywords: ["language", "locale", "english", "英文"]
  }
] as const;

const BUILTIN_COMMAND_META: Record<string, Partial<CommandMeta>> = {
  "findNext": { title: "查找：下一个匹配项", description: "跳转到下一个搜索结果", category: "编辑器", pluginId: "core" },
  "findPrev": { title: "查找：上一个匹配项", description: "跳转到上一个搜索结果", category: "编辑器", pluginId: "core" },
  "replaceNext": { title: "查找：替换当前匹配项", description: "替换当前搜索匹配项", category: "编辑器", pluginId: "core" },
  "replaceAll": { title: "查找：全部替换", description: "替换所有搜索匹配项", category: "编辑器", pluginId: "core" },
  "selectMatches": { title: "查找：选择所有匹配项", description: "选择所有搜索匹配项", category: "编辑器", pluginId: "core" },
  "settings.open": { title: "设置：打开设置", description: "打开 Zion Next 设置面板", category: "Zion", pluginId: "core" },

  "chat.toggleAutoInsertUserPrompt": { title: "聊天：切换自动插入用户提示", description: "切换用户提示是否自动插入到编辑器", category: "聊天", pluginId: "dev.langchain-chat" },
  "chat.toggleAutoFocusUserPrompt": { title: "聊天：切换自动聚焦用户提示", description: "切换运行后是否自动聚焦用户提示", category: "聊天", pluginId: "dev.langchain-chat" },
  "chat.toggleRunFinishedSound": { title: "聊天：切换完成提示音", description: "切换对话完成后的提示音", category: "聊天", pluginId: "dev.langchain-chat" },
  "models.openSwitcher": { title: "模型：打开模型切换器", description: "打开模型选择列表", category: "模型", pluginId: "dev.langchain-chat" },
  "models.closeSwitcher": { title: "模型：关闭模型切换器", description: "关闭模型选择列表", category: "模型", pluginId: "dev.langchain-chat" },
  "models.selectNextModel": { title: "模型：选择下一个模型", description: "切换到下一个可用模型", category: "模型", pluginId: "dev.langchain-chat" },
  "models.selectPrevModel": { title: "模型：选择上一个模型", description: "切换到上一个可用模型", category: "模型", pluginId: "dev.langchain-chat" },

  "compression.strategy.progressive": { title: "压缩：使用渐进策略", description: "使用 Progressive 策略压缩当前对话", category: "压缩", pluginId: "dev.context-compression" },
  "compression.preview": { title: "压缩：打开预览", description: "打开上下文压缩预览面板", category: "压缩", pluginId: "dev.context-compression" },
  "compression.preview.compute": { title: "压缩：计算预览", description: "计算当前对话的上下文压缩预览", category: "压缩", pluginId: "dev.context-compression" },
  "compression.apply": { title: "压缩：应用压缩", description: "对当前对话应用上下文压缩", category: "压缩", pluginId: "dev.context-compression" },
  "compression.panel": { title: "压缩：打开面板", description: "打开上下文压缩面板", category: "压缩", pluginId: "dev.context-compression" },
  "compression.tool.view": { title: "压缩：查看工具结果", description: "查看压缩上下文中的工具调用结果", category: "压缩", pluginId: "dev.context-compression" },
  "compression.versions.list": { title: "压缩：列出历史版本", description: "列出当前会话的压缩历史版本", category: "压缩", pluginId: "dev.context-compression" },
  "compression.versions.clear": { title: "压缩：清空历史版本", description: "清空当前会话的压缩历史版本", category: "压缩", pluginId: "dev.context-compression" },

  "dev.editor.toggleUserRoleBlockBackground": { title: "编辑器：切换用户块背景", description: "切换 user 角色块背景显示", category: "编辑器", pluginId: "dev.editor-config" },
  "dev.editor.toggleIncludeToolHistory": { title: "编辑器：切换包含工具历史", description: "切换是否在上下文中包含工具调用历史", category: "编辑器", pluginId: "dev.editor-config" },
  "dev.editor.toggleIncludeThinkingHistory": { title: "编辑器：切换包含思考历史", description: "切换是否在上下文中包含 thinking 历史", category: "编辑器", pluginId: "dev.editor-config" },
  "dev.editor.cycleToolCallsReasoningContentMode": { title: "编辑器：切换工具推理内容模式", description: "循环切换工具调用 reasoning_content 显示模式", category: "编辑器", pluginId: "dev.editor-config" },
  "dev.editor.toggleMinimap": { title: "编辑器：切换缩略图", description: "显示或隐藏编辑器 minimap", category: "编辑器", pluginId: "dev.editor-config" },

  "dev.gutter-actions.batchAccept": { title: "行号操作：批量接受", description: "批量接受当前可处理的变更", category: "编辑器", pluginId: "dev.gutter-actions" },
  "dev.gutter-actions.batchRevert": { title: "行号操作：批量回退", description: "批量回退当前可处理的变更", category: "编辑器", pluginId: "dev.gutter-actions" },

  "roles.setUser": { title: "角色：设置为用户", description: "将当前行角色设置为 user", category: "角色", pluginId: "dev.roles" },
  "roles.setAssistant": { title: "角色：设置为助手", description: "将当前行角色设置为 assistant", category: "角色", pluginId: "dev.roles" },
  "roles.setSystem": { title: "角色：设置为系统", description: "将当前行角色设置为 system", category: "角色", pluginId: "dev.roles" },
  "roles.toggle": { title: "角色：切换角色显示", description: "显示或隐藏角色标记", category: "角色", pluginId: "dev.roles" },
  "roles.configure": { title: "角色：配置角色", description: "打开角色配置", category: "角色", pluginId: "dev.roles" },
  "roles.toggleUser": { title: "角色：切换用户角色", description: "切换当前行的 user 角色标记", category: "角色", pluginId: "dev.roles" },
  "roles.insertUserBelow": { title: "角色：在下方插入用户", description: "在当前行下方插入 user 角色块", category: "角色", pluginId: "dev.roles" },
  "roles.insertAssistantBelow": { title: "角色：在下方插入助手", description: "在当前行下方插入 assistant 角色块", category: "角色", pluginId: "dev.roles" },
  "roles.insertSystemBelow": { title: "角色：在下方插入系统", description: "在当前行下方插入 system 角色块", category: "角色", pluginId: "dev.roles" },

  "terminal.openHistory": { title: "终端：打开历史", description: "打开终端历史记录", category: "终端", pluginId: "dev.terminal-enhanced" },
  "terminal.openAuxPanel": { title: "终端：打开右侧面板", description: "在右侧辅助栏打开终端面板", category: "终端", pluginId: "dev.terminal-enhanced" },
  "terminal.openManager": { title: "终端：打开管理器", description: "打开终端会话管理器", category: "终端", pluginId: "dev.terminal-manager" },
  "terminal.closeManager": { title: "终端：关闭管理器", description: "关闭终端会话管理器", category: "终端", pluginId: "dev.terminal-manager" },
  "terminal.refreshSessions": { title: "终端：刷新会话", description: "刷新终端会话列表", category: "终端", pluginId: "dev.terminal-manager" },
  "terminal.setActiveSession1": { title: "终端：切换到会话 1", description: "切换到第 1 个终端会话", category: "终端", pluginId: "dev.terminal-enhanced" },
  "terminal.setActiveSession2": { title: "终端：切换到会话 2", description: "切换到第 2 个终端会话", category: "终端", pluginId: "dev.terminal-enhanced" },
  "terminal.setActiveSession3": { title: "终端：切换到会话 3", description: "切换到第 3 个终端会话", category: "终端", pluginId: "dev.terminal-enhanced" },
  "terminal.setActiveSession4": { title: "终端：切换到会话 4", description: "切换到第 4 个终端会话", category: "终端", pluginId: "dev.terminal-enhanced" },
  "terminal.setActiveSession5": { title: "终端：切换到会话 5", description: "切换到第 5 个终端会话", category: "终端", pluginId: "dev.terminal-enhanced" },
  "terminal.setActiveSession6": { title: "终端：切换到会话 6", description: "切换到第 6 个终端会话", category: "终端", pluginId: "dev.terminal-enhanced" },
  "terminal.setActiveSession7": { title: "终端：切换到会话 7", description: "切换到第 7 个终端会话", category: "终端", pluginId: "dev.terminal-enhanced" },
  "terminal.setActiveSession8": { title: "终端：切换到会话 8", description: "切换到第 8 个终端会话", category: "终端", pluginId: "dev.terminal-enhanced" },
  "terminal.setActiveSession9": { title: "终端：切换到会话 9", description: "切换到第 9 个终端会话", category: "终端", pluginId: "dev.terminal-enhanced" }
};

const HIDDEN_RUNTIME_COMMANDS = [
  "chat.setRunFinishedSoundEnabled",
  "models.listProviders",
  "models.listModels",
  "models.selectModel",
  "models.selectActive",
  "setSearchQuery",
  "compression.settings.save",
  "compression.settings.load",
  "compression.versions.restore",
  "compression.versions.delete",
  "dev.editor.setUserRoleBlockBackground",
  "dev.editor.setIncludeToolHistory",
  "dev.editor.setIncludeThinkingHistory",
  "dev.editor.setToolCallsReasoningContentMode",
  "roles.setRole",
  "terminal.createSession",
  "terminal.closeSession",
  "terminal.setActiveSession",
  "terminal.setSessionCwd",
  "terminal.reactivateSession"
];

function isHiddenRuntimeCommand(id: string): boolean {
  if (HIDDEN_RUNTIME_COMMANDS.includes(id)) return true;
  return id.startsWith("models.setDefaultModel.") || id.startsWith("chat.runDefaultWithModel.");
}

function safeText(v: any): string {
  return String(v ?? "");
}

function t(key: string | undefined, fallback = ""): string {
  if (!key) return fallback;
  try {
    const translated = (window as any).zion?.i18n?.t?.(key);
    if (translated && translated !== key) return translated;
  } catch {}
  return fallback || key;
}

function uniqueTexts(values: Array<unknown>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = safeText(value).trim();
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

function splitIdentifier(value: string): string {
  return safeText(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._:/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tVariants(key: string | undefined, fallback = ""): string[] {
  const variants: string[] = [];
  if (key) {
    try {
      const all = (window as any).zion?.i18n?.getMessageVariants?.(key);
      if (Array.isArray(all)) variants.push(...all);
    } catch {}
    variants.push(t(key, fallback));
    variants.push(key);
  }
  variants.push(fallback);
  return uniqueTexts(variants);
}

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(String).filter(Boolean);
  } catch {
    return [];
  }
}

function writeRecent(ids: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, 50)));
  } catch {}
}

function pushRecent(key: string) {
  const cur = readRecent();
  const next = [key, ...cur.filter(x => x !== key)];
  writeRecent(next);
}

function pushRecentSessionId(sessionId: any) {
  const sid = safeText(sessionId).trim();
  if (!sid) return;
  pushRecent(`ses:${sid}`);
}

function pruneRecent(valid: { sessions: Set<string>; commands: Set<string> }) {
  const cur = readRecent();
  if (!cur.length) return;
  const next: string[] = [];
  const seen = new Set<string>();
  for (const key of cur) {
    if (!key || seen.has(key)) continue;
    const m = /^(\w+):(.*)$/.exec(key);
    const kind = m?.[1];
    const id = m?.[2];
    if (!kind || !id) continue;
    if (kind === "ses" && !valid.sessions.has(id)) continue;
    if (kind === "cmd" && !valid.commands.has(id)) continue;
    seen.add(key);
    next.push(key);
  }
  if (next.length !== cur.length) writeRecent(next);
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.zion-cmdk-mask{position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.38);display:none;align-items:flex-start;justify-content:center;padding-top:12vh}
:root[data-theme="light"] .zion-cmdk-mask{background:rgba(0,0,0,.18)}
.zion-cmdk-panel{width:min(680px,calc(100vw - 24px));max-height:min(520px,calc(100vh - 24px));background:var(--panel,var(--bg,#1e1e1e));border:1px solid var(--border,#3c3c3c);border-radius:10px;box-shadow:0 18px 70px rgba(0,0,0,.45);overflow:hidden;font-family:var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif);font-size:12px;display:flex;flex-direction:column}
.zion-cmdk-header{display:flex;gap:10px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border,#3c3c3c)}
.zion-cmdk-input{flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--fg,#cccccc);font-size:13px}
.zion-cmdk-hint{flex:0 0 auto;opacity:.65;font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace);font-size:11px;white-space:nowrap}
.zion-cmdk-footer{display:flex;align-items:center;justify-content:flex-end;padding:8px 12px;border-top:1px solid var(--border,#3c3c3c)}
.zion-cmdk-list{flex:1;min-height:0;overflow:auto;padding:6px;scrollbar-color:transparent transparent;scrollbar-width:thin}
.zion-cmdk-list:hover{scrollbar-color:var(--scrollbar-thumb,var(--border,#44475a)) transparent}
.zion-cmdk-list::-webkit-scrollbar{width:10px;height:10px}
.zion-cmdk-list::-webkit-scrollbar-track{background:transparent}
.zion-cmdk-list::-webkit-scrollbar-thumb{background:transparent;border-radius:6px;border:2px solid transparent;background-clip:content-box;transition:background .15s ease}
.zion-cmdk-list:hover::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb,var(--border,#44475a));background-clip:content-box}
.zion-cmdk-item{display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;cursor:pointer;color:var(--fg,#cccccc);transition:background-color .1s ease}
.zion-cmdk-item.has-path{align-items:flex-start}
.zion-cmdk-item:hover{background:rgba(98,114,164,.10)}
:root[data-theme="light"] .zion-cmdk-item:hover{background:rgba(59,130,246,.10)}
.zion-cmdk-item.is-active{background:var(--role-user-bg,rgba(98,114,164,.18))}
.zion-cmdk-main{flex:1;min-width:0}
.zion-cmdk-title{font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.zion-cmdk-sub{display:flex;gap:8px;align-items:center;margin-top:2px;opacity:.72}
.zion-cmdk-desc{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.zion-cmdk-path{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:2px;font-size:11px}
.zion-cmdk-path-left{opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.zion-cmdk-path-right{flex:0 0 auto;opacity:.55;white-space:nowrap;margin-left:auto}
.zion-cmdk-id{opacity:.7;font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace);font-size:11px;white-space:nowrap}
.zion-cmdk-right{flex:0 0 auto;display:flex;gap:8px;align-items:center}
.zion-cmdk-kbd{padding:2px 6px;border:1px solid var(--border,#3c3c3c);border-radius:6px;opacity:.9;font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace);font-size:11px}
.zion-cmdk-badge{padding:2px 6px;border:1px solid var(--border,#3c3c3c);border-radius:999px;opacity:.7;font-size:11px}
.zion-cmdk-badge[data-status="streaming"]{opacity:1;border-color:color-mix(in srgb,var(--accent,#6272a4) 55%,transparent);color:var(--accent,#6272a4);background:color-mix(in srgb,var(--accent,#6272a4) 12%,transparent)}
.zion-cmdk-badge[data-status="awaiting"]{opacity:1;border-color:color-mix(in srgb,var(--ok,#4caf50) 55%,transparent);color:var(--ok,#4caf50);background:color-mix(in srgb,var(--ok,#4caf50) 12%,transparent)}
.zion-cmdk-badge[data-status="failed"]{opacity:1;border-color:rgba(255,107,107,.55);color:#ff6b6b;background:rgba(255,107,107,.10)}
.zion-cmdk-badge[data-status="aborted"]{opacity:1;border-color:color-mix(in srgb,var(--fg,#ccc) 30%,transparent);color:color-mix(in srgb,var(--fg,#ccc) 70%,transparent);background:color-mix(in srgb,var(--fg,#ccc) 8%,transparent)}
.zion-cmdk-empty{padding:16px;text-align:center;opacity:.7}
  `;
  document.head.appendChild(style);
}

function getSessionStatusBadge(sessionId: string): { status: "streaming" | "awaiting" | "failed" | "aborted"; label: string } | null {
  try {
    const rs = (window as any)?.zion?.state?.get?.(`chat.runs.${sessionId}`) || null;
    if (!rs) return null;
    if (rs.streaming) return { status: "streaming", label: "对话中" };
    if (rs.awaiting) return { status: "awaiting", label: "待查看" };
    if (rs.error) return { status: "failed", label: "失败" };
    if (rs.aborted) return { status: "aborted", label: "已停止" };
    return null;
  } catch {
    return null;
  }
}

function normalizeKeybindingLabel(key: string): string {
  return safeText(key)
    .replaceAll("Mod-", "⌘/Ctrl ")
    .replaceAll("Shift-", "⇧")
    .replaceAll("Alt-", "⌥/Alt ")
    .replaceAll("Ctrl-", "Ctrl ")
    .trim();
}

function getItemSearchText(item: PaletteItem): string {
  if (item.kind === "command") {
    const meta = item.meta;
    return uniqueTexts([
      meta.title,
      meta.id,
      splitIdentifier(meta.id),
      meta.description,
      meta.category,
      meta.pluginId,
      splitIdentifier(meta.pluginId || ""),
      ...(meta.searchText || [])
    ]).join(" ");
  }
  if (item.kind === "action") {
    return uniqueTexts([
      item.title,
      item.id,
      splitIdentifier(item.id),
      item.description,
      ...(item.keywords || [])
    ]).join(" ");
  }
  return uniqueTexts([
    item.title,
    item.id,
    item.path
  ]).join(" ");
}

function sortItemsForSearch(candidates: PaletteItem[], recentRankOf: (key: string) => number): PaletteItem[] {
  const itemKey = (it: PaletteItem) => it.kind === "command" ? `cmd:${it.meta.id}` : (it.kind === "action" ? `cmd:${it.id}` : `ses:${it.id}`);
  const itemTitle = (it: PaletteItem) => it.kind === "command" ? it.meta.title : it.title;
  return candidates.slice().sort((a, b) => {
    const ra = recentRankOf(itemKey(a));
    const rb = recentRankOf(itemKey(b));
    if (ra !== rb) return ra - rb;
    if (a.kind !== b.kind) return a.kind === "session" ? -1 : 1;
    return safeText(itemTitle(a)).localeCompare(safeText(itemTitle(b)));
  });
}

function searchItems(q: string, candidates: PaletteItem[], recentRankOf: (key: string) => number): Array<{ item: PaletteItem; score: number; recentRank: number }> {
  const rows = sortItemsForSearch(candidates, recentRankOf).map((item) => ({
    item,
    text: getItemSearchText(item)
  }));
  const matches = matchSorter(rows, q, {
    keys: ["text"],
    threshold: rankings.MATCHES
  });
  return matches.map((row, index) => {
    const item = row.item;
    const key = item.kind === "command" ? `cmd:${item.meta.id}` : (item.kind === "action" ? `cmd:${item.id}` : `ses:${item.id}`);
    return {
      item,
      score: matches.length - index,
      recentRank: recentRankOf(key)
    };
  });
}

function fmtRelTime(ts?: number): string {
  if (!ts || !isFinite(ts)) return "";
  const d = Date.now() - ts;
  const s = Math.max(0, Math.floor(d / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const dd = Math.floor(h / 24);
  return `${dd}d`;
}

function loadSessionsFromState(): Array<{ id: string; title: string; updatedAt?: number; path?: string }> {
  try {
    const raw = (window as any).zion?.state?.get?.("sessions.catalog");
    if (!Array.isArray(raw)) return [];

    // Build tree for path computation
    const treeFromState = (window as any).zion?.state?.get?.("sessions.treeMem");
    const tree = treeFromState && treeFromState.type === "folder" ? treeFromState : (() => {
      try { const v = JSON.parse(localStorage.getItem("zion.sessions.tree") || "null"); return v ?? null; } catch { return null; }
    })();

    const treeSessionIds = new Set<string>();
    if (tree) {
      const dfsIds = (node: any) => {
        if (!node) return;
        if (node.type === "session") {
          const id = safeText(node.id).trim();
          if (id) treeSessionIds.add(id);
          return;
        }
        if (node.type === "folder" && Array.isArray(node.children)) {
          for (const ch of node.children) dfsIds(ch);
        }
      };
      dfsIds(tree);
    }
    const hasTreeIds = treeSessionIds.size > 0;

    const computeSessionPath = (sessionId: string, sessionTitle: string): string => {
      if (!tree) return sessionTitle;
      const parts: string[] = [sessionTitle];
      let curId: string | null = sessionId;
      let guard = 0;
      while (curId && guard++ < 64) {
        let found: any = null;
        let parent: any = null;
        const dfs = (node: any, p: any) => {
          if (!node || found) return;
          if (node.id === curId) { found = node; parent = p; return; }
          if (node.type === "folder" && Array.isArray(node.children)) {
            for (const ch of node.children) { dfs(ch, node); if (found) return; }
          }
        };
        dfs(tree, null);
        if (!parent || parent.type !== "folder") break;
        if (parent.id === "root") break;
        parts.unshift(String(parent.title || "Folder").trim() || "Folder");
        curId = parent.id;
      }
      return parts.join(" / ");
    };

    return raw
      .map((x: any) => {
        const id = safeText(x?.id || "");
        const title = safeText(x?.title || x?.id || "");
        return {
          id,
          title,
          updatedAt: typeof x?.updatedAt === "number" ? x.updatedAt : undefined,
          path: id ? computeSessionPath(id, title) : undefined
        };
      })
      .filter(x => {
        if (!x.id) return false;
        // Prefer tree membership as the source of truth for "exists".
        if (hasTreeIds) return treeSessionIds.has(x.id);
        // Fallback: ignore sessions with missing meta (usually deleted).
        try {
          const meta = (window as any).zion?.state?.get?.(`sessions.meta.${x.id}`);
          if (!meta) return false;
        } catch {}
        return true;
      });
  } catch {
    return [];
  }
}

function loadOpenSessionIds(): Set<string> {
  try {
    const arr = (window as any).zion?.state?.get?.("ui.editorTabs.openSessionIds");
    if (Array.isArray(arr)) return new Set(arr.map(String));
  } catch {}
  return new Set();
}

function loadManifestMeta(): Map<string, CommandMetaContribution> {
  const out = new Map<string, CommandMetaContribution>();
  try {
    const manifests = (import.meta as any).glob("/extensions/**/manifest.json", { eager: true }) as Record<string, any>;
    for (const mod of Object.values(manifests)) {
      const manifest = mod?.default || mod;
      const pluginId = safeText(manifest?.zion?.id || "");
      const pluginName = safeText(manifest?.zion?.name || pluginId);
      const commands = manifest?.zion?.contributes?.commands;
      if (!Array.isArray(commands)) continue;
      for (const c of commands) {
        const id = safeText(c?.id || "");
        if (!id) continue;
        const title = safeText(c?.title || id);
        const description = safeText(c?.description || "");
        if (!out.has(id)) {
          out.set(id, {
            id,
            title,
            titleKey: safeText(c?.titleKey || ""),
            description,
            descriptionKey: safeText(c?.descriptionKey || ""),
            category: safeText(c?.category || pluginName),
            categoryKey: safeText(c?.categoryKey || ""),
            pluginId
          });
        }
      }
    }
  } catch {}
  for (const [id, meta] of Object.entries(BUILTIN_COMMAND_META)) {
    out.set(id, {
      id,
      title: safeText(meta.title || id),
      titleKey: safeText(meta.titleKey || ""),
      description: safeText(meta.description || ""),
      descriptionKey: safeText(meta.descriptionKey || ""),
      category: safeText(meta.category || "Zion"),
      categoryKey: safeText(meta.categoryKey || ""),
      pluginId: safeText(meta.pluginId || "core"),
      searchText: Array.isArray(meta.searchText) ? meta.searchText : []
    });
  }
  return out;
}

function buildRuntimeIndex(): Map<string, { registered: boolean; keybindings: Array<{ key: string; when?: string }> }> {
  const registeredIds = new Set<string>();
  try {
    for (const id of window.zion.commands.list()) registeredIds.add(id);
  } catch {}

  const kbMap = new Map<string, Array<{ key: string; when?: string }>>();
  try {
    const all = window.zion.keybindings.list();
    for (const kb of all) {
      if (!kb?.command || !kb?.key) continue;
      const arr = kbMap.get(kb.command) || [];
      arr.push({ key: kb.key, when: kb.when });
      kbMap.set(kb.command, arr);
    }
  } catch {}

  const out = new Map<string, { registered: boolean; keybindings: Array<{ key: string; when?: string }> }>();
  for (const id of registeredIds) {
    out.set(id, { registered: true, keybindings: kbMap.get(id) || [] });
  }
  for (const [id, arr] of kbMap.entries()) {
    if (!out.has(id)) out.set(id, { registered: registeredIds.has(id), keybindings: arr });
  }
  return out;
}

function buildCommandList(metaById: Map<string, CommandMetaContribution>): CommandMeta[] {
  const index = buildRuntimeIndex();
  const allIds = new Set<string>();
  for (const id of index.keys()) allIds.add(id);
  for (const id of metaById.keys()) allIds.add(id);

  const items: CommandMeta[] = [];
  for (const id of allIds) {
    if (isHiddenRuntimeCommand(id)) continue;
    const info = index.get(id) || { registered: false, keybindings: [] as Array<{ key: string; when?: string }> };
    const meta = metaById.get(id);
    const title = t(meta?.titleKey, meta?.title || id);
    const description = t(meta?.descriptionKey, meta?.description || "");
    const category = t(meta?.categoryKey, meta?.category || "");
    items.push({
      id,
      title,
      titleKey: meta?.titleKey,
      description,
      descriptionKey: meta?.descriptionKey,
      category,
      categoryKey: meta?.categoryKey,
      pluginId: meta?.pluginId || "",
      registered: info.registered,
      keybindings: info.keybindings,
      searchText: uniqueTexts([
        ...tVariants(meta?.titleKey, meta?.title || id),
        ...tVariants(meta?.descriptionKey, meta?.description || ""),
        ...tVariants(meta?.categoryKey, meta?.category || ""),
        meta?.title,
        meta?.description,
        meta?.category,
        id,
        splitIdentifier(id),
        meta?.pluginId,
        splitIdentifier(meta?.pluginId || ""),
        ...(meta?.searchText || [])
      ])
    });
  }
  items.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return items;
}

let initialized = false;

export function initCommandPalette() {
  if (initialized) return;
  initialized = true;

  injectStyles();

  const metaById = (() => {
    const base = loadManifestMeta();
    base.set("commandPalette.toggle", {
      id: "commandPalette.toggle",
      title: "会话面板：打开/关闭",
      description: "通过 Cmd/Ctrl + K 打开或关闭会话面板（默认显示近期会话）",
      category: "Zion",
      pluginId: "core"
    });
    base.set("commandPalette.open", {
      id: "commandPalette.open",
      title: "会话面板：打开",
      description: "打开会话面板（默认显示近期会话）",
      category: "Zion",
      pluginId: "core"
    });
    base.set("commandPalette.close", {
      id: "commandPalette.close",
      title: "命令台：关闭",
      description: "关闭全局命令台",
      category: "Zion",
      pluginId: "core"
    });
    base.set("zion.setTheme", {
      id: "zion.setTheme",
      title: "主题：选择主题",
      description: "打开主题列表并切换 Zion Next 的外观主题",
      category: "Appearance",
      pluginId: "core"
    });
    base.set("zion.theme.setSelection", {
      id: "zion.theme.setSelection",
      title: "主题：选择主题",
      description: "打开主题列表并切换 Zion Next 的外观主题",
      category: "Appearance",
      pluginId: "core"
    });
    base.set("zion.toggleTheme", {
      id: "zion.toggleTheme",
      title: "主题：快速切换",
      description: "切换 Light 和当前深色主题；在命令面板中会打开主题列表",
      category: "Appearance",
      pluginId: "core"
    });
    base.set("zion.setLanguage", {
      id: "zion.setLanguage",
      title: "语言：选择语言",
      description: "打开语言列表并切换 Zion Next 的界面语言",
      category: "Appearance",
      pluginId: "core"
    });
    base.set("zion.i18n.setLocale", {
      id: "zion.i18n.setLocale",
      title: "语言：选择语言",
      description: "打开语言列表并切换 Zion Next 的界面语言",
      category: "Appearance",
      pluginId: "core"
    });
    base.set("zion.toggleLanguage", {
      id: "zion.toggleLanguage",
      title: "语言：切换中文/英文",
      description: "在简体中文和 English 之间快速切换",
      category: "Appearance",
      pluginId: "core"
    });
    base.set("zion.reloadWindow", {
      id: "zion.reloadWindow",
      title: "窗口：刷新页面",
      description: "重新加载 Zion Next 页面，替代浏览器默认的 Cmd/Ctrl + R",
      category: "Zion",
      pluginId: "core"
    });
    base.set("bottomPanel.toggle", {
      id: "bottomPanel.toggle",
      title: "底部面板：打开/关闭",
      description: "打开或关闭底部面板",
      category: "Zion",
      pluginId: "core"
    });
    base.set("bottomPanel.show", {
      id: "bottomPanel.show",
      title: "底部面板：打开",
      description: "打开底部面板",
      category: "Zion",
      pluginId: "core"
    });
    base.set("bottomPanel.hide", {
      id: "bottomPanel.hide",
      title: "底部面板：关闭",
      description: "关闭底部面板",
      category: "Zion",
      pluginId: "core"
    });
    base.set("bottomPanel.maximize", {
      id: "bottomPanel.maximize",
      title: "底部面板：最大化",
      description: "最大化底部面板",
      category: "Zion",
      pluginId: "core"
    });
    base.set("bottomPanel.restore", {
      id: "bottomPanel.restore",
      title: "底部面板：恢复",
      description: "恢复底部面板高度",
      category: "Zion",
      pluginId: "core"
    });
    base.set("auxiliaryBar.toggle", {
      id: "auxiliaryBar.toggle",
      title: "右侧边栏：打开/关闭",
      description: "打开或关闭右侧辅助边栏 (Cmd/Ctrl + P)",
      category: "Zion",
      pluginId: "core"
    });
    base.set("auxiliaryBar.show", {
      id: "auxiliaryBar.show",
      title: "右侧边栏：打开",
      description: "打开右侧辅助边栏",
      category: "Zion",
      pluginId: "core"
    });
    base.set("auxiliaryBar.hide", {
      id: "auxiliaryBar.hide",
      title: "右侧边栏：关闭",
      description: "关闭右侧辅助边栏",
      category: "Zion",
      pluginId: "core"
    });
    return base;
  })();

  const mask = document.createElement("div");
  mask.className = "zion-cmdk-mask";

  const panel = document.createElement("div");
  panel.className = "zion-cmdk-panel";

  const header = document.createElement("div");
  header.className = "zion-cmdk-header";

  const input = document.createElement("input");
  input.className = "zion-cmdk-input";
  input.type = "text";
  input.placeholder = "搜索会话…";
  input.autocomplete = "off";
  input.spellcheck = false;

  const hint = document.createElement("div");
  hint.className = "zion-cmdk-hint";
  hint.textContent = "↑↓ 选择 · Enter 执行 · Esc 关闭";

  header.appendChild(input);
  const footer = document.createElement("div");
  footer.className = "zion-cmdk-footer";
  footer.appendChild(hint);

  const list = document.createElement("div");
  list.className = "zion-cmdk-list";

  panel.appendChild(header);
  panel.appendChild(list);
  panel.appendChild(footer);
  mask.appendChild(panel);
  document.body.appendChild(mask);

  let open = false;
  let lastActive: HTMLElement | null = null;
  let commands: CommandMeta[] = [];
  let sessions: Array<{ id: string; title: string; updatedAt?: number; path?: string }> = [];
  let visible: PaletteItem[] = [];
  let activeIndex = 0;
  let itemEls: HTMLElement[] = [];
  let lastMouseMoveAt = 0;
  let currentSubmenu: { id: string; title: string; placeholder: string; emptyText: string; items: PaletteItem[] } | null = null;

  const buildModelActionItems = async (): Promise<PaletteItem[]> => {
    try {
      await Promise.resolve(window.zion?.commands?.executeCommand?.("models.listModels"));
    } catch {}
    const catalog = (window as any).zion?.state?.get?.("models.catalog") || [];
    const active = (window as any).zion?.state?.get?.("chat.activeModel") || null;
    const items = (Array.isArray(catalog) ? catalog : []).map((m: any) => {
      const providerId = safeText(m?.providerId || "");
      const modelId = safeText(m?.id || "");
      const label = safeText(m?.label || modelId || "Unknown Model");
      const spec = `${providerId}:${modelId}`;
      const isActive = providerId === active?.providerId && modelId === active?.modelId;
      return {
        kind: "action" as const,
        id: `models.selectModel:${spec}`,
        title: `${isActive ? "✓ " : ""}${label}`,
        description: `${providerId}:${modelId}${m?.requiresConfig ? " · needs config" : ""}`,
        badge: isActive ? "当前" : (providerId || "模型"),
        keywords: [providerId, modelId, label],
        run: () => {
          window.zion?.commands?.executeCommand?.("models.selectModel", spec);
        }
      };
    });
    items.sort((a, b) => {
      const ta = safeText(a.title).toLowerCase();
      const tb = safeText(b.title).toLowerCase();
      if (ta !== tb) return ta.localeCompare(tb);
      return safeText(a.description).localeCompare(safeText(b.description));
    });
    return items;
  };

  const buildThemeActionItems = (): PaletteItem[] => {
    const current = safeText(
      (window as any).zion?.theme?.getSelection?.() ||
      (window as any).zion?.state?.get?.("ui.themePreference") ||
      (window as any).zion?.state?.get?.("ui.theme") ||
      "system"
    );
    return THEME_OPTIONS.map(theme => {
      const isActive = theme.id === current;
      return {
        kind: "action" as const,
        id: `theme.select:${theme.id}`,
        title: `${isActive ? "✓ " : ""}${theme.title}`,
        description: theme.description,
        badge: isActive ? "当前" : "主题",
        keywords: [...theme.keywords],
        run: () => {
          const zion = (window as any).zion;
          if (zion?.theme?.setSelection) {
            zion.theme.setSelection(theme.id);
            return;
          }
          zion?.commands?.executeCommand?.("zion.setTheme", theme.id);
        }
      };
    });
  };

  const buildLanguageActionItems = (): PaletteItem[] => {
    const current = safeText(
      (window as any).zion?.i18n?.getLocale?.() ||
      (window as any).zion?.state?.get?.("ui.locale") ||
      "zh-CN"
    );
    return LANGUAGE_OPTIONS.map(locale => {
      const isActive = locale.id === current;
      return {
        kind: "action" as const,
        id: `language.select:${locale.id}`,
        title: `${isActive ? "✓ " : ""}${locale.title}`,
        description: locale.description,
        badge: isActive ? "当前" : "语言",
        keywords: [...locale.keywords],
        run: () => {
          const zion = (window as any).zion;
          if (zion?.i18n?.setLocale) {
            zion.i18n.setLocale(locale.id);
            return;
          }
          zion?.commands?.executeCommand?.("zion.setLanguage", locale.id);
        }
      };
    });
  };

  const openSubmenu = async (commandId: string) => {
    if (commandId === "models.selectModel" || commandId === "models.openSwitcher") {
      const items = await buildModelActionItems();
      currentSubmenu = {
        id: "models",
        title: "选择模型",
        placeholder: "搜索模型…",
        emptyText: "没有找到匹配的模型",
        items
      };
      input.value = "";
      render("");
      try {
        input.focus();
        input.setSelectionRange(0, 0);
      } catch {}
      return true;
    }
    if (commandId === "zion.setTheme" || commandId === "zion.theme.setSelection" || commandId === "zion.toggleTheme") {
      currentSubmenu = {
        id: "themes",
        title: "选择主题",
        placeholder: "搜索主题…",
        emptyText: "没有找到匹配的主题",
        items: buildThemeActionItems()
      };
      input.value = "";
      render("");
      try {
        input.focus();
        input.setSelectionRange(0, 0);
      } catch {}
      return true;
    }
    if (commandId === "zion.setLanguage" || commandId === "zion.i18n.setLocale" || commandId === "zion.toggleLanguage") {
      currentSubmenu = {
        id: "languages",
        title: "选择语言",
        placeholder: "搜索语言…",
        emptyText: "没有找到匹配的语言",
        items: buildLanguageActionItems()
      };
      input.value = "";
      render("");
      try {
        input.focus();
        input.setSelectionRange(0, 0);
      } catch {}
      return true;
    }
    return false;
  };

  const leaveSubmenu = () => {
    if (!currentSubmenu) return false;
    currentSubmenu = null;
    input.value = ">";
    render(input.value);
    try {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } catch {}
    return true;
  };

  const setActiveIndex = (idx: number) => {
    if (!itemEls.length) return;
    const next = Math.max(0, Math.min(idx, itemEls.length - 1));
    const prevEl = itemEls[activeIndex];
    const nextEl = itemEls[next];
    if (prevEl && prevEl !== nextEl) prevEl.classList.remove("is-active");
    if (nextEl) {
      nextEl.classList.add("is-active");
      try {
        nextEl.scrollIntoView({ block: "nearest" });
      } catch {}
    }
    activeIndex = next;
  };

  const closePalette = (opts?: { restoreFocus?: boolean }) => {
    if (!open) return;
    open = false;
    mask.style.display = "none";
    input.value = "";
    list.innerHTML = "";
    itemEls = [];
    visible = [];
    activeIndex = 0;
    currentSubmenu = null;
    const restore = lastActive;
    lastActive = null;
    if (opts?.restoreFocus === false) return;
    try {
      restore?.focus?.();
    } catch {}
  };

  const focusActiveEditorPanel = () => {
    requestAnimationFrame(() => {
      try {
        const panelId = window.zion?.panels?.getActivePanelId?.() || null;
        if (panelId) {
          try { window.zion.panels?.focus?.(panelId); } catch {}
          const panelEditor = window.zion.panels?.getEditor?.(panelId);
          if (panelEditor?.focus) {
            panelEditor.focus();
            return;
          }
        }
        window.zion.window.activeEditor?.focus?.();
      } catch {}
    });
  };

  const executeActive = async () => {
    const it = visible[activeIndex];
    if (!it) return;
    if (it.kind === "action") {
      try {
        await Promise.resolve(it.run());
        pushRecent(`cmd:${it.id}`);
      } catch {}
      closePalette();
      return;
    }
    if (it.kind === "command") {
      const meta = it.meta;
      if (!meta.registered) {
        try {
          window.zion.notification?.show(`命令未注册：${meta.id}`, { type: "warning", duration: 2200 });
        } catch {}
        return;
      }
      if (await openSubmenu(meta.id)) return;
      try {
        window.zion.commands.executeCommand(meta.id);
        pushRecent(`cmd:${meta.id}`);
      } catch {}
      closePalette();
      return;
    }
    try {
      await Promise.resolve(window.zion.commands.executeCommand("zion.sessions.switch", it.id));
      pushRecent(`ses:${it.id}`);
    } catch {}
    closePalette({ restoreFocus: false });
    focusActiveEditorPanel();
  };

  const render = (query: string) => {
    const raw = safeText(query);
    const inSubmenu = !!currentSubmenu;
    const isCommandMode = inSubmenu || raw.trimStart().startsWith(">");
    const q = inSubmenu ? raw.trim() : (isCommandMode ? raw.replace(/^\s*>\s*/, "").trim() : raw.trim());
    const recent = readRecent();

    hint.textContent = inSubmenu
      ? "↑↓ 选择 · Enter 执行 · Backspace 返回 · Esc 关闭"
      : (isCommandMode ? "↑↓ 选择 · Enter 执行命令 · Esc 关闭" : "↑↓ 选择 · Enter 打开会话 · Esc 关闭");
    input.placeholder = inSubmenu ? currentSubmenu?.placeholder || "搜索…" : (isCommandMode ? "输入命令…" : "搜索会话…");

    const openSet = loadOpenSessionIds();
    const cmdItems = commands.map(meta => ({ kind: "command" as const, meta }));
    const sesItems = sessions.map(s => ({ kind: "session" as const, id: s.id, title: s.title, updatedAt: s.updatedAt, open: openSet.has(s.id), path: s.path }));

    const candidates: PaletteItem[] = inSubmenu ? (currentSubmenu?.items || []) : (isCommandMode ? cmdItems : sesItems);
    let scored: Array<{ item: PaletteItem; score: number; recentRank: number }> = [];

    const recentRankOf = (key: string) => {
      const idx = recent.indexOf(key);
      return idx >= 0 ? idx : 9999;
    };

    if (!q) {
      const seen = new Set<string>();
      // Split recent into sessions and commands so sessions always appear first
      const recentSesKeys = recent.filter(k => k.startsWith("ses:"));
      const recentCmdKeys = recent.filter(k => k.startsWith("cmd:"));
      for (const key of [...recentSesKeys, ...recentCmdKeys]) {
        if (seen.has(key)) continue;
        const m = /^(\w+):(.*)$/.exec(key);
        const kind = m?.[1];
        const id = m?.[2];
        if (!kind || !id) continue;
        const found = candidates.find(c => {
          if (c.kind === "command") return kind === "cmd" && c.meta.id === id;
          if (c.kind === "session") return kind === "ses" && c.id === id;
          return kind === "cmd" && c.id === id;
        });
        if (!found) continue;
        seen.add(key);
        scored.push({ item: found, score: 0, recentRank: recentRankOf(key) });
      }
      for (const it of candidates) {
        const key = it.kind === "command" ? `cmd:${it.meta.id}` : (it.kind === "action" ? `cmd:${it.id}` : `ses:${it.id}`);
        if (seen.has(key)) continue;
        scored.push({ item: it, score: 0, recentRank: 9999 });
      }
      scored = scored.slice(0, 160);
    } else {
      scored = searchItems(q, candidates, recentRankOf);
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.recentRank !== b.recentRank) return a.recentRank - b.recentRank;
        if (a.item.kind !== b.item.kind) return a.item.kind === "session" ? -1 : 1;
        if (a.item.kind === "command" && b.item.kind === "command") {
          return a.item.meta.title.localeCompare(b.item.meta.title);
        }
        if (a.item.kind === "action" && b.item.kind === "action") {
          return a.item.title.localeCompare(b.item.title);
        }
        if (a.item.kind === "session" && b.item.kind === "session") {
          return a.item.title.localeCompare(b.item.title);
        }
        return 0;
      });
      scored = scored.slice(0, 240);
    }

    visible = scored.map(x => x.item);
    list.innerHTML = "";
    itemEls = [];

    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "zion-cmdk-empty";
      empty.textContent = inSubmenu ? (currentSubmenu?.emptyText || "没有找到匹配项") : (isCommandMode ? "没有找到匹配的命令" : "没有找到匹配的会话");
      list.appendChild(empty);
      return;
    }

    for (let i = 0; i < visible.length; i++) {
      const it = visible[i];
      const row = document.createElement("div");
      row.className = "zion-cmdk-item";
      row.dataset.index = String(i);

      if (it.kind === "session" && it.path) row.classList.add("has-path");

      const main = document.createElement("div");
      main.className = "zion-cmdk-main";

      const title = document.createElement("div");
      title.className = "zion-cmdk-title";
      title.textContent = it.kind === "command"
        ? safeText(it.meta.title || it.meta.id)
        : safeText(it.title || it.id);

      const sub = document.createElement("div");
      sub.className = "zion-cmdk-sub";

      if (it.kind === "command") {
        const desc = document.createElement("div");
        desc.className = "zion-cmdk-desc";
        desc.textContent = safeText(it.meta.description || "");
        const id = document.createElement("div");
        id.className = "zion-cmdk-id";
        id.textContent = it.meta.id;
        if (desc.textContent) sub.appendChild(desc);
        sub.appendChild(id);
        main.appendChild(title);
        main.appendChild(sub);
      } else if (it.kind === "action") {
        const desc = document.createElement("div");
        desc.className = "zion-cmdk-desc";
        desc.textContent = safeText(it.description || "");
        const id = document.createElement("div");
        id.className = "zion-cmdk-id";
        id.textContent = it.id;
        if (desc.textContent) sub.appendChild(desc);
        sub.appendChild(id);
        main.appendChild(title);
        main.appendChild(sub);
      } else {
        main.appendChild(title);
        // path row: left=path, right=status+time+id
        const pathRow = document.createElement("div");
        pathRow.className = "zion-cmdk-path";
        const pathLeft = document.createElement("span");
        pathLeft.className = "zion-cmdk-path-left";
        pathLeft.textContent = it.path || "";
        const pathRight = document.createElement("span");
        pathRight.className = "zion-cmdk-path-right";
        pathRight.textContent = (it.open ? "已打开的会话" : "会话") + (it.updatedAt ? ` · ${fmtRelTime(it.updatedAt)} ago` : "") + ` · ${it.id}`;
        pathLeft.title = it.path || "";
        pathRight.title = pathRight.textContent;
        pathRow.appendChild(pathLeft);
        pathRow.appendChild(pathRight);
        main.appendChild(pathRow);
      }

      const right = document.createElement("div");
      right.className = "zion-cmdk-right";

      if (it.kind === "command" && it.meta.keybindings && it.meta.keybindings.length) {
        const kb = document.createElement("div");
        kb.className = "zion-cmdk-kbd";
        kb.textContent = normalizeKeybindingLabel(it.meta.keybindings[0].key);
        right.appendChild(kb);
      }

      if (it.kind === "command" && !it.meta.registered) {
        const badge = document.createElement("div");
        badge.className = "zion-cmdk-badge";
        badge.textContent = "未注册";
        right.appendChild(badge);
      }
      if (it.kind === "action" && it.badge) {
        const badge = document.createElement("div");
        badge.className = "zion-cmdk-badge";
        badge.textContent = it.badge;
        right.appendChild(badge);
      }
      if (it.kind === "session") {
        const st = getSessionStatusBadge(it.id);
        if (st) {
          const badge = document.createElement("div");
          badge.className = "zion-cmdk-badge";
          badge.dataset.status = st.status;
          badge.textContent = st.label;
          badge.title = st.label;
          right.appendChild(badge);
        }
        const badge = document.createElement("div");
        badge.className = "zion-cmdk-badge";
        badge.textContent = it.open ? "打开" : "会话";
        right.appendChild(badge);
      }

      row.appendChild(main);
      row.appendChild(right);

      row.onclick = () => {
        activeIndex = i;
        void executeActive();
      };

      row.onmouseenter = () => {
        if (Date.now() - lastMouseMoveAt < 120) setActiveIndex(i);
      };

      itemEls.push(row);
      list.appendChild(row);
    }

    activeIndex = 0;
    setActiveIndex(0);
  };

  const openPalette = () => {
    if (open) return;
    open = true;
    lastActive = (document.activeElement as any) || null;
    commands = buildCommandList(metaById);
    sessions = loadSessionsFromState();
    try {
      pruneRecent({
        sessions: new Set(sessions.map(s => s.id)),
        commands: new Set(commands.map(c => c.id))
      });
    } catch {}
    mask.style.display = "flex";
    input.value = "";
    render("");
    setTimeout(() => {
      try {
        input.focus();
        input.select();
      } catch {}
    }, 0);
  };

  const togglePalette = () => {
    if (open) closePalette();
    else openPalette();
  };

  const openCommandMode = () => {
    if (!open) openPalette();
    currentSubmenu = null;
    input.value = ">";
    render(input.value);
    setTimeout(() => {
      try {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      } catch {}
    }, 0);
  };

  const openGlobalMode = () => {
    if (open) {
      input.value = "";
      render("");
      setTimeout(() => {
        try {
          input.focus();
          input.select();
        } catch {}
      }, 0);
      return;
    }
    openPalette();
  };

  try {
    window.zion.commands.registerCommand("commandPalette.toggle", () => togglePalette());
    window.zion.commands.registerCommand("commandPalette.open", () => openPalette());
    window.zion.commands.registerCommand("commandPalette.close", () => closePalette());
  } catch {}

  try {
    let lastRecentSessionId = safeText(window.zion?.state?.get?.("sessions.currentId")).trim() || "";
    let recentSessionTimer = 0;
    if (lastRecentSessionId) pushRecentSessionId(lastRecentSessionId);
    window.zion.state.onDidChange("sessions.currentId", (nv) => {
      const sid = safeText(nv).trim();
      if (!sid || sid === lastRecentSessionId) return;
      lastRecentSessionId = sid;
      if (recentSessionTimer) window.clearTimeout(recentSessionTimer);
      // Debounce slightly so restore/switch chains only persist the final active session.
      recentSessionTimer = window.setTimeout(() => {
        try { pushRecentSessionId(sid); } catch {}
      }, 120);
    });
  } catch {}

  // If the palette is open, keep session status badges fresh.
  try {
    const rerenderIfOpen = () => {
      if (!open) return;
      try { render(input.value); } catch {}
    };
    const refreshI18nIfOpen = () => {
      if (!open) return;
      try { commands = buildCommandList(metaById); } catch {}
      try { render(input.value); } catch {}
    };
    window.zion.events.on("chat/runStarted", rerenderIfOpen);
    window.zion.events.on("chat/runFinished", rerenderIfOpen);
    window.zion.events.on("chat/runError", rerenderIfOpen);
    window.zion.events.on("chat/aborted", rerenderIfOpen);
    window.zion.events.on("i18n/changed", refreshI18nIfOpen);
  } catch {}

  mask.addEventListener("mousedown", (e) => {
    if (e.target === mask) closePalette();
  });

  mask.addEventListener("mousemove", (e) => {
    if (!open) return;
    lastMouseMoveAt = Date.now();
    const t = e.target as any;
    const el = t?.closest ? t.closest(".zion-cmdk-item") : null;
    if (!el) return;
    const idx = Number(el.dataset?.index);
    if (Number.isFinite(idx)) setActiveIndex(idx);
  });

  input.addEventListener("input", () => {
    if (!open) return;
    render(input.value);
  });

  input.addEventListener("keydown", (e) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePalette();
      return;
    }
    if (e.key === "Backspace" && currentSubmenu && !input.value) {
      e.preventDefault();
      e.stopPropagation();
      leaveSubmenu();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void executeActive();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(activeIndex + 1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(activeIndex - 1);
      return;
    }
  });

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.defaultPrevented || e.isComposing) return;
      const key = e.key;
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod || e.altKey) return;
      if (key === "k" || key === "K") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) openCommandMode();
        else openGlobalMode();
      } else if (key === "p" || key === "P") {
        e.preventDefault();
        e.stopPropagation();
        window.zion.auxiliaryBar?.toggle();
      }
    },
    true
  );
}
