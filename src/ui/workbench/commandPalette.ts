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
const RECENT_KEY = "zion.commandPalette.recent";

function safeText(v: any): string {
  return String(v ?? "");
}

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeRecent(ids: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, 50)));
  } catch {}
}

function pushRecent(id: string) {
  const cur = readRecent();
  const next = [id, ...cur.filter(x => x !== id)];
  writeRecent(next);
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.zion-cmdk-mask{position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.38);display:none;align-items:flex-start;justify-content:center;padding-top:12vh}
:root[data-theme="light"] .zion-cmdk-mask{background:rgba(0,0,0,.18)}
.zion-cmdk-panel{width:min(680px,calc(100vw - 24px));max-height:min(520px,calc(100vh - 24px));background:var(--panel,var(--bg,#1e1e1e));border:1px solid var(--border,#3c3c3c);border-radius:10px;box-shadow:0 18px 70px rgba(0,0,0,.45);overflow:hidden;font-family:var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif);font-size:12px}
.zion-cmdk-header{display:flex;gap:10px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border,#3c3c3c)}
.zion-cmdk-input{flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--fg,#cccccc);font-size:13px}
.zion-cmdk-hint{flex:0 0 auto;opacity:.65;font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace);font-size:11px;white-space:nowrap}
.zion-cmdk-list{max-height:440px;overflow:auto;padding:6px;scrollbar-color:transparent transparent;scrollbar-width:thin}
.zion-cmdk-list:hover{scrollbar-color:var(--scrollbar-thumb,var(--border,#44475a)) transparent}
.zion-cmdk-list::-webkit-scrollbar{width:10px;height:10px}
.zion-cmdk-list::-webkit-scrollbar-track{background:transparent}
.zion-cmdk-list::-webkit-scrollbar-thumb{background:transparent;border-radius:6px;border:2px solid transparent;background-clip:content-box;transition:background .15s ease}
.zion-cmdk-list:hover::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb,var(--border,#44475a));background-clip:content-box}
.zion-cmdk-item{display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;cursor:pointer;color:var(--fg,#cccccc);transition:background-color .1s ease}
.zion-cmdk-item:hover{background:rgba(98,114,164,.10)}
:root[data-theme="light"] .zion-cmdk-item:hover{background:rgba(59,130,246,.10)}
.zion-cmdk-item.is-active{background:var(--role-user-bg,rgba(98,114,164,.18))}
.zion-cmdk-main{flex:1;min-width:0}
.zion-cmdk-title{font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.zion-cmdk-sub{display:flex;gap:8px;align-items:center;margin-top:2px;opacity:.72}
.zion-cmdk-desc{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
  header.appendChild(hint);

  const list = document.createElement("div");
  list.className = "zion-cmdk-list";

  panel.appendChild(header);
  panel.appendChild(list);
  mask.appendChild(panel);
  document.body.appendChild(mask);

  let open = false;
  let lastActive: HTMLElement | null = null;
  let items: CommandMeta[] = [];
  let visible: CommandMeta[] = [];
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
    if (!it.registered) {
      try {
        window.zion.notification?.show(`命令未注册：${it.id}`, { type: "warning", duration: 2200 });
      } catch {}
      return;
    }
    try {
      window.zion.commands.executeCommand(it.id);
      pushRecent(it.id);
    } catch {}
    closePalette();
  };

  const render = (query: string) => {
    const q = safeText(query).trim();
    const recent = readRecent();

    let next: Array<{ item: CommandMeta; score: number; recentRank: number }> = [];

    if (!q) {
      const seen = new Set<string>();
      for (let i = 0; i < recent.length; i++) {
        const id = recent[i];
        const it = items.find(x => x.id === id);
        if (!it) continue;
        seen.add(id);
        next.push({ item: it, score: 0, recentRank: i });
      }
      for (const it of items) {
        if (seen.has(it.id)) continue;
        next.push({ item: it, score: 0, recentRank: 9999 });
      }
      next = next.slice(0, 120);
    } else {
      for (const it of items) {
        const score = computeScore(q, it);
        if (score <= 0) continue;
        const rr = recent.indexOf(it.id);
        next.push({ item: it, score: score + (rr >= 0 ? 5 : 0), recentRank: rr >= 0 ? rr : 9999 });
      }
      next.sort((a, b) => b.score - a.score || a.recentRank - b.recentRank || a.item.title.localeCompare(b.item.title));
      next = next.slice(0, 200);
    }

    visible = next.map(x => x.item);
    list.innerHTML = "";
    itemEls = [];

    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "zion-cmdk-empty";
      empty.textContent = "没有找到匹配的命令";
      list.appendChild(empty);
      return;
    }

    for (let i = 0; i < visible.length; i++) {
      const it = visible[i];
      const row = document.createElement("div");
      row.className = "zion-cmdk-item";
      row.dataset.index = String(i);

      const main = document.createElement("div");
      main.className = "zion-cmdk-main";

      const title = document.createElement("div");
      title.className = "zion-cmdk-title";
      title.textContent = safeText(it.title || it.id);

      const sub = document.createElement("div");
      sub.className = "zion-cmdk-sub";

      const desc = document.createElement("div");
      desc.className = "zion-cmdk-desc";
      desc.textContent = safeText(it.description || "");

      const id = document.createElement("div");
      id.className = "zion-cmdk-id";
      id.textContent = it.id;

      if (it.description) sub.appendChild(desc);
      sub.appendChild(id);

      main.appendChild(title);
      main.appendChild(sub);

      const right = document.createElement("div");
      right.className = "zion-cmdk-right";

      if (it.keybindings && it.keybindings.length) {
        const kb = document.createElement("div");
        kb.className = "zion-cmdk-kbd";
        kb.textContent = normalizeKeybindingLabel(it.keybindings[0].key);
        right.appendChild(kb);
      }

      if (!it.registered) {
        const badge = document.createElement("div");
        badge.className = "zion-cmdk-badge";
        badge.textContent = "未注册";
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
    items = buildCommandList(metaById);
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
      if (!isMod || e.shiftKey || e.altKey) return;
      if (key !== "k" && key !== "K") return;
      e.preventDefault();
      e.stopPropagation();
      togglePalette();
    },
    true
  );
}
