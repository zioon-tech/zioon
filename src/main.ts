import "katex/dist/katex.min.css";
import { EditorCore } from "./editor/EditorCore";
import { attachEditor } from "./ext/registry";
import type { Disposable } from "./types/zion";

// ---------- 自动保存 / 恢复 ----------
const STORAGE_KEY = 'zion.autosave';

/** 读回上次的内容 */
function loadLastDoc(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

/** 真正写入 localStorage（带简单防抖） */
let saveTimer = 0;
function saveDoc(text: string) {
  if (saveTimer) cancelIdleCallback(saveTimer);
  saveTimer = requestIdleCallback(
    () => {
      try {
        localStorage.setItem(STORAGE_KEY, text);
      } catch {}
    },
    { timeout: 3000 }
  );
}

async function bootstrap() {
  const host = document.getElementById("app")!;
  host.innerHTML = "";

  // Create a container for editor
  const editorContainer = document.createElement("div");
  editorContainer.style.height = "100%";
  host.appendChild(editorContainer);

  // 优先读缓存，没有再给默认
  const cached = loadLastDoc();
  const initialDoc =
    cached.trim() ||
    `# Zion Next (CodeMirror 6)
This is a minimal scaffold to validate:
- CM6 editor core with safe proxy
- Extension registry (commands / keybindings / status bar)
- EventBus & StateBus for plugin interaction

Try: Press Cmd/Ctrl + Shift + D to insert timestamp (from sample extension).
`;

  const core = new EditorCore(editorContainer, initialDoc);
  attachEditor(core);

  // 监听内容变化，自动保存
  core.view.state.field && core.view.state.field; // 保证 view 已初始化
  core.view.dom.addEventListener("input", () => {
    saveDoc(core.getValue());
  });
  // 兼容所有 CM6 变更（如命令/粘贴/撤销等）
  core.view.updateListener = core.view.updateListener || ((update) => {
    if (update.docChanged) {
      saveDoc(core.getValue());
    }
  });

  // Theme init + commands + status
  let currentTheme: "light" | "dark" = (() => {
    try {
      const t = localStorage.getItem("zion.theme") as "light" | "dark" | null;
      return t === "light" || t === "dark" ? t : "dark";
    } catch {
      return "dark";
    }
  })();

  const applyTheme = (t: "light" | "dark") => {
    currentTheme = t;
    try { localStorage.setItem("zion.theme", t); } catch {}
    document.documentElement.setAttribute("data-theme", t);
    core.setTheme(t);
    window.zion.state.set("ui.theme", t);
    // Update/Render status item (same id will replace)
    window.zion.statusBar.registerItem({
      id: "core.theme",
      text: `Theme: ${t === "dark" ? "Dark" : "Light"}`,
      tooltip: "Click to toggle theme",
      onClick: () => window.zion.commands.executeCommand("zion.toggleTheme")
    });
  };

  window.zion.commands.registerCommand("zion.setTheme", (t: "light" | "dark") => applyTheme(t));
  window.zion.commands.registerCommand("zion.toggleTheme", () => applyTheme(currentTheme === "dark" ? "light" : "dark"));
  applyTheme(currentTheme);



  // WYSIWYG init + commands + status
  let wysiwygEnabled: boolean = (() => {
    try {
      const v = localStorage.getItem("zion.wysiwyg");
      if (v === "0" || v === "false") return false;
      if (v === "1" || v === "true") return true;
      return true; // default ON
    } catch {
      return true;
    }
  })();

  const applyWysiwyg = (enabled: boolean) => {
    wysiwygEnabled = enabled;
    try {
      localStorage.setItem("zion.wysiwyg", enabled ? "1" : "0");
    } catch {}
    core.setWysiwygEnabled(enabled);
    window.zion.state.set("ui.wysiwyg", enabled);
    window.zion.statusBar.registerItem({
      id: "core.wysiwyg",
      text: `WYSIWYG: ${enabled ? "On" : "Off"}`,
      tooltip: "Click to toggle WYSIWYG mode",
      onClick: () => window.zion.commands.executeCommand("zion.toggleWysiwyg")
    });
  };

  window.zion.commands.registerCommand("zion.setWysiwyg", (enabled: boolean) => applyWysiwyg(!!enabled));
  window.zion.commands.registerCommand("zion.toggleWysiwyg", () => applyWysiwyg(!wysiwygEnabled));
  applyWysiwyg(wysiwygEnabled);

  // Editor runtime feature toggles (line numbers, active-line highlight, syntax highlight, auto-indent, folding)
  let lineNumbersEnabled: boolean = (() => {
    try {
      const v = localStorage.getItem("zion.lineNumbers");
      if (v === "0" || v === "false") return false;
      if (v === "1" || v === "true") return true;
      return true;
    } catch {
      return true;
    }
  })();

  let activeLineHighlightEnabled: boolean = (() => {
    try {
      const v = localStorage.getItem("zion.activeLineHighlight");
      if (v === "0" || v === "false") return false;
      if (v === "1" || v === "true") return true;
      return true;
    } catch {
      return true;
    }
  })();

  let syntaxHighlightEnabled: boolean = (() => {
    try {
      const v = localStorage.getItem("zion.syntaxHighlight");
      if (v === "0" || v === "false") return false;
      if (v === "1" || v === "true") return true;
      return true;
    } catch {
      return true;
    }
  })();

  let autoIndentEnabled: boolean = (() => {
    try {
      const v = localStorage.getItem("zion.autoIndent");
      if (v === "0" || v === "false") return false;
      if (v === "1" || v === "true") return true;
      return true;
    } catch {
      return true;
    }
  })();

  let foldingEnabled: boolean = (() => {
    try {
      const v = localStorage.getItem("zion.folding");
      if (v === "0" || v === "false") return false;
      if (v === "1" || v === "true") return true;
      return true;
    } catch {
      return true;
    }
  })();

  let lineWrapEnabled: boolean = (() => {
    try {
      const v = localStorage.getItem("zion.lineWrap");
      if (v === "0" || v === "false") return false;
      if (v === "1" || v === "true") return true;
      return true;
    } catch {
      return true;
    }
  })();

  const applyLineNumbers = (enabled: boolean) => {
    lineNumbersEnabled = enabled;
    try { localStorage.setItem("zion.lineNumbers", enabled ? "1" : "0"); } catch {}
    core.setLineNumbersEnabled(enabled);
    window.zion.state.set("ui.lineNumbers", enabled);
  };

  const applyActiveLineHighlight = (enabled: boolean) => {
    activeLineHighlightEnabled = enabled;
    try { localStorage.setItem("zion.activeLineHighlight", enabled ? "1" : "0"); } catch {}
    core.setActiveLineHighlightEnabled(enabled);
    window.zion.state.set("ui.activeLineHighlight", enabled);
  };

  const applySyntaxHighlight = (enabled: boolean) => {
    syntaxHighlightEnabled = enabled;
    try { localStorage.setItem("zion.syntaxHighlight", enabled ? "1" : "0"); } catch {}
    core.setSyntaxHighlightEnabled(enabled);
    window.zion.state.set("ui.syntaxHighlight", enabled);
  };

  const applyAutoIndent = (enabled: boolean) => {
    autoIndentEnabled = enabled;
    try { localStorage.setItem("zion.autoIndent", enabled ? "1" : "0"); } catch {}
    core.setAutoIndentEnabled(enabled);
    window.zion.state.set("ui.autoIndent", enabled);
  };

  const applyFolding = (enabled: boolean) => {
    foldingEnabled = enabled;
    try { localStorage.setItem("zion.folding", enabled ? "1" : "0"); } catch {}
    core.setFoldingEnabled(enabled);
    window.zion.state.set("ui.folding", enabled);
  };

  const applyLineWrap = (enabled: boolean) => {
    lineWrapEnabled = enabled;
    try { localStorage.setItem("zion.lineWrap", enabled ? "1" : "0"); } catch {}
    core.setLineWrapEnabled(enabled);
    window.zion.state.set("ui.lineWrap", enabled);
  };

  // register commands to control these features
  window.zion.commands.registerCommand("zion.setLineNumbers", (v: boolean) => applyLineNumbers(!!v));
  window.zion.commands.registerCommand("zion.toggleLineNumbers", () => applyLineNumbers(!lineNumbersEnabled));
  window.zion.commands.registerCommand("zion.setActiveLineHighlight", (v: boolean) => applyActiveLineHighlight(!!v));
  window.zion.commands.registerCommand("zion.toggleActiveLineHighlight", () => applyActiveLineHighlight(!activeLineHighlightEnabled));
  window.zion.commands.registerCommand("zion.setSyntaxHighlight", (v: boolean) => applySyntaxHighlight(!!v));
  window.zion.commands.registerCommand("zion.toggleSyntaxHighlight", () => applySyntaxHighlight(!syntaxHighlightEnabled));
  window.zion.commands.registerCommand("zion.setAutoIndent", (v: boolean) => applyAutoIndent(!!v));
  window.zion.commands.registerCommand("zion.toggleAutoIndent", () => applyAutoIndent(!autoIndentEnabled));
  window.zion.commands.registerCommand("zion.setFolding", (v: boolean) => applyFolding(!!v));
  window.zion.commands.registerCommand("zion.toggleFolding", () => applyFolding(!foldingEnabled));
  window.zion.commands.registerCommand("zion.setLineWrap", (v: boolean) => applyLineWrap(!!v));
  window.zion.commands.registerCommand("zion.toggleLineWrap", () => applyLineWrap(!lineWrapEnabled));

  // apply current values
  applyLineNumbers(lineNumbersEnabled);
  applyActiveLineHighlight(activeLineHighlightEnabled);
  applySyntaxHighlight(syntaxHighlightEnabled);
  applyAutoIndent(autoIndentEnabled);
  applyFolding(foldingEnabled);
  applyLineWrap(lineWrapEnabled);

  // Auto-load all extensions under /extensions
  await autoLoadExtensions();

  // Status item example (core side)
  window.zion.statusBar.registerItem({
    id: "core.ready",
    text: "● Ready",
    tooltip: "Zion Next is running",
    onClick: () => {
      console.log("Core ready clicked");
    }
  });

  // Simple Extensions panel launcher
  window.zion.statusBar.registerItem({
    id: "core.extensions",
    text: "Extensions",
    tooltip: "Manage extensions (enable/disable)",
    onClick: () => openExtensionsPanel()
  });

  // Core convenience: reload extensions (page reload)
  window.zion.statusBar.registerItem({
    id: "core.reload",
    text: "Reload",
    tooltip: "Reload extensions and page",
    onClick: () => location.reload()
  });

  // Core commands
  window.zion.commands.registerCommand("zion.showExtensions", () => openExtensionsPanel());
  window.zion.commands.registerCommand("zion.reloadExtensions", () => location.reload());

  // Show extension load errors (if any)
  const extErr = (window as any).__ext_errors || 0;
  if (extErr > 0) {
    window.zion.statusBar.registerItem({
      id: "core.extErrors",
      text: `● ExtErr(${extErr})`,
      tooltip: "Some extensions failed to load (check console)"
    });
  }
}

type ExtensionModule = {
  activate: (ctx: { subscriptions: Disposable[] }) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
};

async function loadExtension(manifestPath: string) {
  try {
    const res = await fetch(manifestPath);
    const manifest = await res.json();
    const mainUrl = new URL(manifest.main, new URL(manifestPath, location.href)).href;

    const mod: ExtensionModule = await import(/* @vite-ignore */ mainUrl);
    const context = { subscriptions: [] as Disposable[] };

    if (typeof mod.activate === "function") {
      await mod.activate(context);
      // Store for later (not used in MVP)
      (window as any).__ext_contexts = (window as any).__ext_contexts || [];
      (window as any).__ext_contexts.push({ manifestPath, context, mod });
    }
    console.log("[ext] loaded:", manifest.name || manifestPath);
  } catch (e) {
    console.error("[ext] load error:", manifestPath, e);
  }
}

 // Auto-load all manifests under /extensions/**/extension.json via Vite glob
async function autoLoadExtensions() {
  // Collect all manifest json files at build time (Vite)
  const manifests = import.meta.glob("/extensions/**/extension.json", { eager: true }) as Record<
    string,
    any
  >;

  // Save a catalog for UI panel
  const catalog: { name: string; path: string; version?: string }[] = [];
  const disabledNames: string[] = (() => {
    try {
      const raw = localStorage.getItem("zion.disabledExtensions");
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  })();

  // If glob didn't pick up anything (edge dev cases), fallback to default sample
  const paths = Object.keys(manifests);
  if (paths.length === 0) {
    await loadExtension("/extensions/dev.sample-hello/extension.json");
    return;
  }

  for (const manifestPath of paths) {
    try {
      const manifest = manifests[manifestPath]?.default || manifests[manifestPath];
      if (!manifest || !manifest.main) {
        console.warn("[ext] invalid manifest:", manifestPath);
        continue;
      }
      const name = String(manifest.name || manifestPath);
      const version = String(manifest.version || "");
      catalog.push({ name, path: manifestPath, version: version || undefined });

      if (disabledNames.includes(name)) {
        console.log("[ext] disabled:", name);
        continue;
      }

      // Compute main module url relative to manifest
      const base = manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1);
      const mainRel = String(manifest.main).replace(/^\.\//, "");
      const mainUrl = `${base}${mainRel}`;
      const mod: ExtensionModule = await import(/* @vite-ignore */ mainUrl);
      const context = { subscriptions: [] as Disposable[] };
      if (typeof mod.activate === "function") {
        await mod.activate(context);
        (window as any).__ext_contexts = (window as any).__ext_contexts || [];
        (window as any).__ext_contexts.push({ manifestPath, context, mod, name });
      }
      console.log("[ext] loaded:", name);
    } catch (e) {
      console.error("[ext] auto load error:", manifestPath, e);
      (window as any).__ext_errors = ((window as any).__ext_errors || 0) + 1;
    }
  }

  (window as any).__ext_catalog = catalog;

  // ① 广播「扩展已加载完」
  window.zion.events.emit('extensions:loaded');
}

function openExtensionsPanel() {
  try {
    const existing = document.getElementById("zion-ext-panel");
    if (existing) {
      existing.remove();
    }
    const overlay = document.createElement("div");
    overlay.id = "zion-ext-panel";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.35)";
    overlay.style.zIndex = "99998";
    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.remove();
    };

    const panel = document.createElement("div");
    panel.style.position = "fixed";
    panel.style.right = "20px";
    panel.style.top = "50px";
    panel.style.width = "320px";
    panel.style.maxHeight = "60vh";
    panel.style.overflow = "auto";
    panel.style.background = "var(--panel)";
    panel.style.border = "1px solid var(--border)";
    panel.style.borderRadius = "6px";
    panel.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";
    panel.style.padding = "10px";
    panel.style.zIndex = "99999";
    panel.style.color = "var(--fg)";
    panel.onclick = (e) => e.stopPropagation();

    const title = document.createElement("div");
    title.textContent = "Extensions";
    title.style.fontWeight = "600";
    title.style.marginBottom = "8px";
    panel.appendChild(title);

    const list = document.createElement("div");
    const catalog: { name: string; path: string; version?: string }[] = (window as any).__ext_catalog || [];
    const disabledNames: string[] = (() => {
      try {
        const raw = localStorage.getItem("zion.disabledExtensions");
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    })();

    catalog
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(item => {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.justifyContent = "space-between";
        row.style.padding = "6px 2px";

        const label = document.createElement("span");
        label.textContent = item.version ? `${item.name} v${item.version}` : item.name;
        label.title = item.path;
        label.style.fontSize = "12px";

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = !disabledNames.includes(item.name);
        toggle.onchange = () => {
          const set = new Set(disabledNames);
          if (toggle.checked) {
            set.delete(item.name);
          } else {
            set.add(item.name);
          }
          localStorage.setItem("zion.disabledExtensions", JSON.stringify(Array.from(set)));
          location.reload();
        };

        row.appendChild(label);
        row.appendChild(toggle);
        list.appendChild(row);
      });

    if (catalog.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No extensions found under /extensions";
      empty.style.opacity = "0.8";
      empty.style.fontSize = "12px";
      list.appendChild(empty);
    }

    panel.appendChild(list);

    const footer = document.createElement("div");
    footer.style.marginTop = "10px";
    footer.style.display = "flex";
    footer.style.justifyContent = "space-between";

    const reloadBtn = document.createElement("button");
    reloadBtn.textContent = "Reload";
    reloadBtn.style.background = "var(--border)";
    reloadBtn.style.color = "var(--fg)";
    reloadBtn.style.border = "1px solid var(--accent)";
    reloadBtn.style.borderRadius = "4px";
    reloadBtn.style.padding = "4px 8px";
    reloadBtn.onclick = () => location.reload();

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.style.background = "var(--border)";
    closeBtn.style.color = "var(--fg)";
    closeBtn.style.border = "1px solid var(--accent)";
    closeBtn.style.borderRadius = "4px";
    closeBtn.style.padding = "4px 8px";
    closeBtn.onclick = () => overlay.remove();

    footer.appendChild(reloadBtn);
    footer.appendChild(closeBtn);
    panel.appendChild(footer);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  } catch (e) {
    console.error("openExtensionsPanel error:", e);
  }
}

bootstrap();