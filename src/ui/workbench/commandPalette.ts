type CommandMeta = {
  id: string;
  title: string;
  description?: string;
  category?: string;
  pluginId?: string;
  registered: boolean;
  keybindings: Array<{ key: string; when?: string }>;
};

const STYLE_ID = "zion-command-palette-style";
const RECENT_KEY = "zion.commandPalette.recent.v2";

type PaletteItem =
  | {
      kind: "command";
      meta: CommandMeta;
    }
  | {
      kind: "session";
      id: string;
      title: string;
      updatedAt?: number;
      open: boolean;
      path?: string;
    };

function safeText(v: any): string {
  return String(v ?? "");
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
.zion-cmdk-empty{padding:16px;text-align:center;opacity:.7}
  `;
  document.head.appendChild(style);
}

function normalizeKeybindingLabel(key: string): string {
  return safeText(key)
    .replaceAll("Mod-", "⌘/Ctrl ")
    .replaceAll("Shift-", "⇧")
    .replaceAll("Alt-", "⌥/Alt ")
    .replaceAll("Ctrl-", "Ctrl ")
    .trim();
}

function computeScore(q: string, item: CommandMeta): number {
  if (!q) return 0;
  const query = q.toLowerCase();
  const title = (item.title || "").toLowerCase();
  const desc = (item.description || "").toLowerCase();
  const id = item.id.toLowerCase();
  const cat = (item.category || "").toLowerCase();
  const plugin = (item.pluginId || "").toLowerCase();

  if (id === query) return 200;
  if (title === query) return 190;
  if (title.startsWith(query)) return 140;
  if (id.startsWith(query)) return 120;
  if (title.includes(query)) return 100;
  if (desc.includes(query)) return 70;
  if (cat.includes(query) || plugin.includes(query)) return 40;
  return 0;
}

function computeScoreSession(q: string, it: { id: string; title: string }): number {
  if (!q) return 0;
  const query = q.toLowerCase();
  const title = (it.title || "").toLowerCase();
  const id = it.id.toLowerCase();
  if (id === query) return 200;
  if (title === query) return 190;
  if (title.startsWith(query)) return 140;
  if (id.startsWith(query)) return 120;
  if (title.includes(query)) return 100;
  if (id.includes(query)) return 60;
  return 0;
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
      parts.unshift(String(tree?.title || "Sessions").trim() || "Sessions");
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
      .filter(x => !!x.id);
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

function loadManifestMeta(): Map<string, Pick<CommandMeta, "id" | "title" | "description" | "category" | "pluginId">> {
  const out = new Map<string, Pick<CommandMeta, "id" | "title" | "description" | "category" | "pluginId">>();
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
            description,
            category: safeText(c?.category || pluginName),
            pluginId
          });
        }
      }
    }
  } catch {}
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

function buildCommandList(metaById: Map<string, Pick<CommandMeta, "id" | "title" | "description" | "category" | "pluginId">>): CommandMeta[] {
  const index = buildRuntimeIndex();
  const allIds = new Set<string>();
  for (const id of index.keys()) allIds.add(id);
  for (const id of metaById.keys()) allIds.add(id);

  const items: CommandMeta[] = [];
  for (const id of allIds) {
    const info = index.get(id) || { registered: false, keybindings: [] as Array<{ key: string; when?: string }> };
    const meta = metaById.get(id);
    items.push({
      id,
      title: meta?.title || id,
      description: meta?.description || "",
      category: meta?.category || "",
      pluginId: meta?.pluginId || "",
      registered: info.registered,
      keybindings: info.keybindings
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
      title: "命令台：打开/关闭",
      description: "通过 Cmd/Ctrl + K 打开或关闭全局命令台",
      category: "Zion",
      pluginId: "core"
    });
    base.set("commandPalette.open", {
      id: "commandPalette.open",
      title: "命令台：打开",
      description: "打开全局命令台",
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
  input.placeholder = "输入命令…";
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

  const closePalette = () => {
    if (!open) return;
    open = false;
    mask.style.display = "none";
    input.value = "";
    list.innerHTML = "";
    itemEls = [];
    visible = [];
    activeIndex = 0;
    const restore = lastActive;
    lastActive = null;
    try {
      restore?.focus?.();
    } catch {}
  };

  const executeActive = () => {
    const it = visible[activeIndex];
    if (!it) return;
    if (it.kind === "command") {
      const meta = it.meta;
      if (!meta.registered) {
        try {
          window.zion.notification?.show(`命令未注册：${meta.id}`, { type: "warning", duration: 2200 });
        } catch {}
        return;
      }
      try {
        window.zion.commands.executeCommand(meta.id);
        pushRecent(`cmd:${meta.id}`);
      } catch {}
      closePalette();
      return;
    }
    try {
      window.zion.commands.executeCommand("zion.sessions.switch", it.id);
      pushRecent(`ses:${it.id}`);
    } catch {}
    closePalette();
  };

  const render = (query: string) => {
    const raw = safeText(query);
    const isCommandMode = raw.trimStart().startsWith(">");
    const q = isCommandMode ? raw.replace(/^\s*>\s*/, "").trim() : raw.trim();
    const recent = readRecent();

    hint.textContent = isCommandMode ? "↑↓ 选择 · Enter 执行 · Esc 关闭" : "↑↓ 选择 · Enter 打开 · Esc 关闭 · 输入 > 搜命令";
    input.placeholder = isCommandMode ? "输入命令…" : "搜索会话、命令…（输入 > 搜命令）";

    const openSet = loadOpenSessionIds();
    const cmdItems = commands.map(meta => ({ kind: "command" as const, meta }));
    const sesItems = sessions.map(s => ({ kind: "session" as const, id: s.id, title: s.title, updatedAt: s.updatedAt, open: openSet.has(s.id), path: s.path }));

    const candidates: PaletteItem[] = isCommandMode ? cmdItems : [...sesItems, ...cmdItems];
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
        const found = candidates.find(c => (c.kind === "command" ? (kind === "cmd" && c.meta.id === id) : (kind === "ses" && c.id === id)));
        if (!found) continue;
        seen.add(key);
        scored.push({ item: found, score: 0, recentRank: recentRankOf(key) });
      }
      for (const it of candidates) {
        const key = it.kind === "command" ? `cmd:${it.meta.id}` : `ses:${it.id}`;
        if (seen.has(key)) continue;
        scored.push({ item: it, score: 0, recentRank: 9999 });
      }
      scored = scored.slice(0, 160);
    } else {
      for (const it of candidates) {
        if (it.kind === "command") {
          const score = computeScore(q, it.meta);
          if (score <= 0) continue;
          const key = `cmd:${it.meta.id}`;
          scored.push({ item: it, score: score + (recent.includes(key) ? 5 : 0), recentRank: recentRankOf(key) });
        } else {
          const score = computeScoreSession(q, it);
          if (score <= 0) continue;
          const key = `ses:${it.id}`;
          scored.push({ item: it, score: score + (recent.includes(key) ? 5 : 0), recentRank: recentRankOf(key) });
        }
      }
      scored.sort((a, b) => b.score - a.score || a.recentRank - b.recentRank || (a.item.kind === b.item.kind ? (a.item.kind === "command" ? a.item.meta.title.localeCompare(b.item.meta.title) : a.item.title.localeCompare(b.item.title)) : (a.item.kind === "session" ? -1 : 1)));
      scored = scored.slice(0, 240);
    }

    visible = scored.map(x => x.item);
    list.innerHTML = "";
    itemEls = [];

    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "zion-cmdk-empty";
      empty.textContent = isCommandMode ? "没有找到匹配的命令" : "没有找到匹配的项目";
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
      title.textContent = it.kind === "command" ? safeText(it.meta.title || it.meta.id) : safeText(it.title || it.id);

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
      if (it.kind === "session") {
        const badge = document.createElement("div");
        badge.className = "zion-cmdk-badge";
        badge.textContent = it.open ? "打开" : "会话";
        right.appendChild(badge);
      }

      row.appendChild(main);
      row.appendChild(right);

      row.onclick = () => {
        activeIndex = i;
        executeActive();
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
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      executeActive();
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
        else togglePalette();
      } else if (key === "p" || key === "P") {
        e.preventDefault();
        e.stopPropagation();
        window.zion.auxiliaryBar?.toggle();
      }
    },
    true
  );
}
