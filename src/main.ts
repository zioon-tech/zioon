import "katex/dist/katex.min.css";
import { EditorCore } from "./editor/EditorCore";
import "./pwa-test";
import { attachEditor } from "./ext/registry";
import type { Disposable } from "./types/zion";
import { PluginManager } from "./plugin/manager";
import { HttpPluginInstaller } from "./plugin/http-installer";
import type { PluginInfo } from "./plugin/types";
import { notificationManager } from "./notification/manager";
import { initWorkbench } from "./ui/workbench/workbench";
import { initCommandPalette } from "./ui/workbench/commandPalette";
import { DEFAULT_BASE_URL, initServiceBaseUrlConfig } from "./settings/serviceBaseUrl";

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

function mountCurrentSessionPath(pathEl: HTMLElement) {
  const safeParse = <T,>(raw: string | null, fallback: T): T => {
    if (!raw) return fallback;
    try {
      const v = JSON.parse(raw);
      return (v ?? fallback) as T;
    } catch {
      return fallback;
    }
  };

  const findNodeAndParent = (root: any, id: string) => {
    let found: any = null;
    let parent: any = null;
    const dfs = (node: any, p: any) => {
      if (!node) return;
      if (node.id === id) {
        found = node;
        parent = p;
        return;
      }
      if (node.type === "folder" && Array.isArray(node.children)) {
        for (const ch of node.children) {
          dfs(ch, node);
          if (found) return;
        }
      }
    };
    dfs(root, null);
    return { node: found, parent };
  };

  const computePath = (sessionId: string): string => {
    const treeFromState = window.zion.state.get<any>("sessions.treeMem");
    const tree = treeFromState && treeFromState.type === "folder" ? treeFromState : safeParse<any>(localStorage.getItem("zion.sessions.tree"), null);
    const meta = window.zion.state.get<any>(`sessions.meta.${sessionId}`);
    const sessionTitle = String(meta?.title || "").trim() || sessionId;
    if (!tree) return `Sessions / ${sessionTitle}`;

    const parts: string[] = [sessionTitle];
    let curId: string | null = sessionId;
    let guard = 0;
    while (curId && guard++ < 64) {
      const { parent } = findNodeAndParent(tree, curId);
      if (!parent || parent.type !== "folder") break;
      if (parent.id === "root") break;
      parts.unshift(String(parent.title || "Folder").trim() || "Folder");
      curId = parent.id;
    }

    parts.unshift(String(tree?.title || "Sessions").trim() || "Sessions");

    return parts.join(" / ");
  };

  let metaDisp: Disposable | null = null;
  const bindMeta = (id: string | undefined) => {
    try {
      metaDisp?.dispose();
    } catch {}
    metaDisp = null;
    if (!id) return;
    try {
      metaDisp = window.zion.state.onDidChange(`sessions.meta.${id}`, () => update());
    } catch {}
  };

  const update = () => {
    const id = window.zion.state.get<string>("sessions.currentId");
    if (!id) {
      pathEl.textContent = "";
      pathEl.title = "";
      return;
    }
    const p = computePath(id);
    pathEl.textContent = p;
    pathEl.title = p;
  };

  try {
    pathEl.onclick = () => {
      try {
        window.zion.commands.executeCommand("zion.sessions.toggleSidebar");
      } catch {}
    };
  } catch {}

  try {
    window.zion.state.onDidChange<string>("sessions.currentId", (nv) => {
      bindMeta(nv);
      update();
    });
  } catch {}

  try {
    window.zion.state.onDidChange("sessions.catalog", () => update());
  } catch {}

  try {
    window.zion.state.onDidChange("sessions.treeMem", () => update());
  } catch {}

  bindMeta(window.zion.state.get<string>("sessions.currentId"));
  update();
}

function mountEditorHeaderNewSessionButton(pathEl: HTMLElement) {
  try {
    const headerEl = pathEl.parentElement;
    if (!headerEl) return;

    let btn = headerEl.querySelector<HTMLButtonElement>("button[data-zion-editor-new-session-button='1']");
    const isNew = !btn;
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
    }

    // 使用与 session-manager 插件一致的按钮样式
    btn.className = "zion-editor-header-action is-icon zion-editor-new-session-button";
    btn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    btn.title = "新增会话（同级）";
    btn.setAttribute("aria-label", "新增会话（同级）");
    btn.setAttribute("data-zion-editor-new-session-button", "1");
    
    // 应用与 session-manager 一致的按钮样式
    btn.style.background = "transparent";
    btn.style.color = "var(--fg)";
    btn.style.border = "none";
    btn.style.borderRadius = "6px";
    btn.style.padding = "2px";
    btn.style.cursor = "pointer";
    btn.style.fontSize = "14px";
    btn.style.display = "flex";
    btn.style.alignItems = "center";
    btn.style.justifyContent = "center";
    btn.style.transition = "background 120ms ease";
    btn.style.marginLeft = "2px";
    
    // 鼠标悬停效果
    btn.onmouseenter = () => { btn.style.background = "var(--border)"; };
    btn.onmouseleave = () => { btn.style.background = "transparent"; };
    
    btn.onclick = (e) => {
      try {
        e.stopPropagation();
      } catch {}
      try {
        // 获取当前会话的父级ID
        const curId = window.zion.state.get<string>("sessions.currentId");
        let parentId: string | undefined = undefined;
        
        if (curId) {
          try {
            // 从树结构中找到当前会话的父级
            const tree = window.zion.state.get<any>("sessions.treeMem");
            if (tree && tree.type === "folder") {
              const findNodeAndParent = (root: any, id: string) => {
                let found: any = null;
                let parent: any = null;
                const dfs = (node: any, p: any) => {
                  if (!node) return;
                  if (node.id === id) {
                    found = node;
                    parent = p;
                    return;
                  }
                  if (node.type === "folder" && Array.isArray(node.children)) {
                    for (const ch of node.children) {
                      dfs(ch, node);
                      if (found) return;
                    }
                  }
                };
                dfs(root, null);
                return { node: found, parent };
              };
              
              const { parent } = findNodeAndParent(tree, curId);
              if (parent && parent.type === "folder") {
                parentId = parent.id;
              }
            }
          } catch (err) {
            console.error("[new session button] error finding parent:", err);
          }
        }
        
        // 执行创建新会话命令，指定父级为当前会话的父级
        window.zion.commands.executeCommand("zion.sessions.new", { parentId });
      } catch {}
    };

    if (isNew) {
      // 找到 TOC 按钮
      const tocBtn = headerEl.querySelector<HTMLButtonElement>("button[data-zion-editor-toc-button='1']");
      if (tocBtn && tocBtn.nextSibling) {
        // 如果 TOC 按钮存在且有下一个兄弟，在 TOC 按钮后插入
        headerEl.insertBefore(btn, tocBtn.nextSibling);
      } else {
        // 否则直接在 pathEl 前插入
        headerEl.insertBefore(btn, pathEl);
      }
    }
  } catch {}
}

function mountEditorHeaderTOCButton(pathEl: HTMLElement) {
  try {
    const headerEl = pathEl.parentElement;
    if (!headerEl) return;

    let btn = headerEl.querySelector<HTMLButtonElement>("button[data-zion-editor-toc-button='1']");
    const isNew = !btn;
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
    }

    // 应用与 session-manager 一致的按钮样式
    btn.className = "zion-editor-header-action is-icon zion-editor-toc-button";
    btn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4 6h2v2H4V6zm4 0h12v2H8V6zM4 11h2v2H4v-2zm4 0h12v2H8v-2zM4 16h2v2H4v-2zm4 0h12v2H8v-2z"/></svg>';
    btn.title = "目录";
    btn.setAttribute("aria-label", "目录");
    btn.setAttribute("data-zion-editor-toc-button", "1");
    
    // 应用与其他按钮一致的样式
    btn.style.background = "transparent";
    btn.style.color = "var(--fg)";
    btn.style.border = "none";
    btn.style.borderRadius = "6px";
    btn.style.padding = "2px";
    btn.style.cursor = "pointer";
    btn.style.display = "flex";
    btn.style.alignItems = "center";
    btn.style.justifyContent = "center";
    btn.style.transition = "background 120ms ease";
    
    // 鼠标悬停效果
    btn.onmouseenter = () => { btn.style.background = "var(--border)"; };
    btn.onmouseleave = () => { btn.style.background = "transparent"; };
    
    btn.onclick = (e) => {
      try {
        e.stopPropagation();
      } catch {}
      try {
        window.zion.commands.executeCommand("toc.show");
      } catch {}
    };

    if (isNew) headerEl.insertBefore(btn, pathEl);
  } catch {}
}

async function bootstrap() {
  const host = document.getElementById("app")!;
  host.innerHTML = "";

  const wb = initWorkbench(host);
  const editorContainer = wb.editorHost;
  const editorHeaderPathEl = wb.editorHeaderPathEl;

  // 初始化插件管理器
  const pluginManager = new PluginManager({
    pluginDir: '/plugins',
    logLevel: 'info'
  });

  // 优先读缓存，没有再给默认
  const cached = loadLastDoc();
  const initialDoc =
    cached.trim() ||
    `# Zion Next (CodeMirror 6) - 插件化版本
This is a minimal scaffold to validate:
- CM6 editor core with safe proxy
- Extension registry (commands / keybindings / status bar)
- EventBus & StateBus for plugin interaction
- New plugin system with backward compatibility

Try: Press Cmd/Ctrl + Shift + D to insert timestamp (from sample extension).
`;

  const core = new EditorCore(editorContainer, initialDoc);
  attachEditor(core);
  mountCurrentSessionPath(editorHeaderPathEl);
  mountEditorHeaderTOCButton(editorHeaderPathEl);
  mountEditorHeaderNewSessionButton(editorHeaderPathEl);

  try {
    initServiceBaseUrlConfig();
  } catch {}

  // 监听内容变化，自动保存
  core.view.state.field && core.view.state.field; // 保证 view 已初始化
  core.view.dom.addEventListener("input", () => {
    saveDoc(core.getValue());
  });
  // 兼容所有 CM6 变更（如命令/粘贴/撤销等）
  (core.view as any).updateListener = (core.view as any).updateListener || ((update: any) => {
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
      onClick: () => window.zion.commands.executeCommand("zion.toggleTheme"),
      priority: 80
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
      onClick: () => window.zion.commands.executeCommand("zion.toggleWysiwyg"),
      priority: 79
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

  // Initialize new plugin system
  try {
    await pluginManager.initialize();
    console.log('[PluginManager] 插件系统初始化完成');

    // Expose plugin manager to window.zion
    (window as any).zion.plugins = pluginManager;

    // 监听插件热重载事件并显示通知
    pluginManager.on('hotReloaded', (event: any) => {
      const { plugin, previous, shouldNotify } = event;

      // 只有在应该通知时才显示通知（跳过页面刷新时的通知）
      if (!shouldNotify) {
        return;
      }

      try {
        // 从开发会话信息中获取目录
        const sessions = (window as any).zion.state.get("plugins.devSessions") || {};
        let devInfo = Object.values(sessions).find((s: any) => s?.pluginId === plugin.id) || null;

        // 尝试从 localStorage 获取开发目录信息
        let devDir: string | undefined;
        if (!devInfo) {
          try {
            const saved = JSON.parse(localStorage.getItem("zion.plugins.devSessionsInfo") || "{}");
            devInfo = saved[plugin.id] || null;
          } catch {}
        }

        if (devInfo && typeof devInfo === 'object' && 'dir' in devInfo && devInfo.dir) {
          devDir = String(devInfo.dir);
        }

        // 显示热重载通知
        notificationManager.showPluginHotReload(plugin, devDir);
      } catch (error) {
        console.error('[PluginManager] 显示热重载通知失败:', error);
      }
    });

    // 初始化 HTTP 插件安装器（服务地址可配置）
    const defaultServiceUrl = (() => {
      try {
        return localStorage.getItem('zion.pluginServiceUrl') || DEFAULT_BASE_URL;
      } catch {
        return DEFAULT_BASE_URL;
      }
    })();
    const pluginInstaller = new HttpPluginInstaller({
      baseUrl: defaultServiceUrl,
      timeout: 20000,
      cache: true
    });
    (window as any).zion.pluginInstaller = pluginInstaller;
    
    // Add plugin management commands
    window.zion.commands.registerCommand("zion.showPlugins", () => openPluginsPanel(pluginManager));
    window.zion.commands.registerCommand("zion.reloadPlugins", () => {
      location.reload();
    });

    // 预安装内置插件
    await preinstallBuiltinPlugins(pluginManager);
    
    // 页面刷新后恢复开发会话的WebSocket连接
    await restoreDevSessions(pluginManager, pluginInstaller);
    
  } catch (error) {
    console.error('[PluginManager] 插件系统初始化失败:', error);
  }

  try {
    initCommandPalette();
  } catch {}

  try {
    window.zion.commands.registerCommand("bottomPanel.show", () => window.zion.bottomPanel?.show());
    window.zion.commands.registerCommand("bottomPanel.hide", () => window.zion.bottomPanel?.hide());
    window.zion.commands.registerCommand("bottomPanel.toggle", () => window.zion.bottomPanel?.toggle());
    window.zion.commands.registerCommand("bottomPanel.maximize", () => window.zion.bottomPanel?.maximize());
    window.zion.commands.registerCommand("bottomPanel.restore", () => window.zion.bottomPanel?.restore());
  } catch {}

  try {
    window.zion.bottomPanel?.registerView({
      id: "core.output",
      pluginId: "core",
      title: "Output",
      icon: "📄",
      order: 10,
      keepWhenActive: true,
      maximizable: true,
      component: {
        render: (container: HTMLElement) => {
          const wrap = document.createElement("div");
          wrap.style.padding = "10px";
          wrap.style.fontFamily = "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)";
          wrap.style.fontSize = "12px";
          wrap.style.whiteSpace = "pre-wrap";
          wrap.style.lineHeight = "1.5";
          wrap.textContent =
            "Bottom Panel 已启用。\n\n" +
            "可以：\n" +
            "- 拖拽面板顶部的细条调整高度\n" +
            '- 点左侧 ActivityBar 的 "🧰" 打开/关闭\n' +
            '- Cmd/Ctrl + K 打开命令台，搜索 bottomPanel.toggle\n';
          container.appendChild(wrap);
          return {
            dispose: () => {
              try {
                wrap.remove();
              } catch {}
            }
          };
        }
      }
    });

    window.zion.activityBar?.registerItem({
      id: "core.bottompanel",
      pluginId: "core",
      icon: "🧰",
      tooltip: "Bottom Panel",
      bottomPanelViewId: "core.output",
      order: 90
    });
  } catch {}

  // Status item example (core side)
  window.zion.statusBar.registerItem({
    id: "core.ready",
    text: "● Ready",
    tooltip: "Zion Next is running",
    onClick: () => {
      console.log("Core ready clicked");
    },
    priority: 90
  });

  // Core convenience: reload extensions (page reload)
  window.zion.statusBar.registerItem({
    id: "core.reload",
    text: "Reload",
    tooltip: "Reload extensions and page",
    onClick: () => location.reload(),
    priority: -10
  });

  // Core commands
  window.zion.commands.registerCommand("zion.showPlugins", () => openPluginsPanel(pluginManager));
  window.zion.commands.registerCommand("zion.reloadPlugins", () => location.reload());

  // Show extension load errors (if any)
  const extErr = (window as any).__ext_errors || 0;
  if (extErr > 0) {
    window.zion.statusBar.registerItem({
      id: "core.extErrors",
      text: `● ExtErr(${extErr})`,
      tooltip: "Some extensions failed to load (check console)",
      priority: 100
    });
  }

  // Bottom status bar: 右侧显示行列与字符统计
  try {
    const bar = document.getElementById("bottombar");
    if (bar) {
      let right = document.getElementById("bottombar-right") as HTMLDivElement | null;
      if (!right) {
        right = document.createElement("div");
        right.id = "bottombar-right";
        bar.appendChild(right);
      }

      const mLnCol = document.createElement("span");
      const mBefore = document.createElement("span");
      const mTotal = document.createElement("span");
      right.appendChild(mLnCol);
      right.appendChild(mBefore);
      right.appendChild(mTotal);

      const updateMetrics = () => {
        try {
          const view = core.view;
          const doc = view.state.doc;
          const head = view.state.selection.main.head;
          const line = doc.lineAt(head);
          const ln = line.number;
          const col = head - line.from + 1;
          const before = head;
          const total = doc.length;
          mLnCol.textContent = `Ln ${ln}, Col ${col}`;
          mBefore.textContent = `Before ${before}`;
          mTotal.textContent = `Total ${total}`;
        } catch {}
      };

      updateMetrics();
      (window as any).zion.events.on("editor.cursorActivity", updateMetrics);
      (window as any).zion.events.on("editor.change", updateMetrics);
    }
  } catch (e) {
    console.error("Init bottom status bar metrics error:", e);
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
  const manifests = (import.meta as any).glob("/extensions/**/extension.json", { eager: true }) as Record<
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

/**
 * 打开插件管理面板
 */
function openPluginsPanel(pluginManager: PluginManager) {
  try {
    const existing = document.getElementById("zion-plugins-panel");
    if (existing) {
      existing.remove();
    }

    const overlay = document.createElement("div");
    overlay.id = "zion-plugins-panel";
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
    panel.style.width = "400px";
    panel.style.maxHeight = "70vh";
    panel.style.overflow = "auto";
    panel.style.background = "var(--panel)";
    panel.style.border = "1px solid var(--border)";
    panel.style.borderRadius = "6px";
    panel.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";
    panel.style.padding = "12px";
    panel.style.zIndex = "99999";
    panel.style.color = "var(--fg)";
    panel.onclick = (e) => e.stopPropagation();

    const title = document.createElement("div");
    title.textContent = "Plugin Manager (New System)";
    title.style.fontWeight = "600";
    title.style.marginBottom = "8px";
    title.style.fontSize = "14px";
    panel.appendChild(title);

    // 统计信息
    const stats = pluginManager.getStats();
    const statsDiv = document.createElement("div");
    statsDiv.style.marginBottom = "12px";
    statsDiv.style.fontSize = "12px";
    statsDiv.style.opacity = "0.8";
    statsDiv.innerHTML = `
      Total: ${stats.total} | Enabled: ${stats.enabled} | Active: ${stats.active} | Errors: ${stats.errors}
    `;
    panel.appendChild(statsDiv);

    // 插件列表
    const list = document.createElement("div");
    const plugins = pluginManager.list();
    
    if (plugins.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No plugins found";
      empty.style.opacity = "0.8";
      empty.style.fontSize = "12px";
      empty.style.marginBottom = "10px";
      list.appendChild(empty);
    } else {
      plugins.forEach(plugin => {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.justifyContent = "space-between";
        row.style.padding = "6px 0";
        row.style.borderBottom = "1px solid var(--border)";

        const info = document.createElement("div");
        info.style.flex = "1";
        
        const name = document.createElement("div");
        name.textContent = plugin.name;
        name.style.fontSize = "13px";
        name.style.fontWeight = "500";
        
        const details = document.createElement("div");
        details.style.fontSize = "11px";
        details.style.opacity = "0.7";
        details.textContent = `${plugin.id} v${plugin.version}`;
        
        if (plugin.error) {
          const error = document.createElement("div");
          error.style.fontSize = "10px";
          error.style.color = "var(--error)";
          error.textContent = `Error: ${plugin.error.message}`;
          info.appendChild(error);
        }
        
        info.appendChild(name);
        info.appendChild(details);

        // 显示开发模式目录与基址（如存在）
        try {
          const sessionsState = (window as any).zion?.state?.get("plugins.devSessions") || {};
          let devInfo: any = null;
          for (const k in sessionsState) {
            const s = sessionsState[k];
            if (s && s.pluginId === plugin.id) { devInfo = s; break; }
          }
          if (!devInfo) {
            try {
              const saved = JSON.parse(localStorage.getItem("zion.plugins.devSessionsInfo") || "{}");
              if (saved && saved[plugin.id]) devInfo = saved[plugin.id];
            } catch {}
          }
          if (devInfo && (devInfo.dir || devInfo.baseUrl)) {
            const devLine = document.createElement("div");
            devLine.style.fontSize = "10px";
            devLine.style.opacity = "0.65";
            devLine.style.fontFamily = "var(--font-mono)";
            const dirText = devInfo.dir ? String(devInfo.dir) : "";
            const baseText = devInfo.baseUrl ? ` (${String(devInfo.baseUrl)})` : "";
            devLine.textContent = dirText ? `dev: ${dirText}${baseText}` : `dev:${baseText}`;
            info.appendChild(devLine);
          }
        } catch {}

        const controls = document.createElement("div");
        controls.style.display = "flex";
        controls.style.gap = "8px";
        controls.style.alignItems = "center";

        // 状态指示器
        const status = document.createElement("div");
        status.style.width = "8px";
        status.style.height = "8px";
        status.style.borderRadius = "50%";
        
        if (plugin.state === 'error') {
          status.style.background = "#f85149";
        } else if (plugin.state === 'active') {
          status.style.background = "#2ea043";
        } else if (plugin.enabled) {
          status.style.background = "#d29922";
        } else {
          status.style.background = "#6e7681";
        }
        controls.appendChild(status);

        // 启用/禁用切换
        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = !!plugin.enabled;
        toggle.onchange = async () => {
          try {
            if (toggle.checked) {
              await pluginManager.enable(plugin.id);
            } else {
              await pluginManager.disable(plugin.id);
            }
          } catch (error) {
            console.error(`Failed to ${toggle.checked ? 'enable' : 'disable'} plugin:`, error);
            toggle.checked = !toggle.checked; // 恢复状态
          }
        };
        controls.appendChild(toggle);

        row.appendChild(info);
        row.appendChild(controls);
        list.appendChild(row);
      });
    }

    panel.appendChild(list);

    // ===== HTTP 服务安装区域 =====
    const serviceBox = document.createElement("div");
    serviceBox.style.marginTop = "12px";
    serviceBox.style.padding = "8px";
    serviceBox.style.border = "1px dashed var(--border)";
    serviceBox.style.borderRadius = "6px";

    const serviceTitle = document.createElement("div");
    serviceTitle.textContent = "Install from Service (zion-local-tools)";
    serviceTitle.style.fontWeight = "600";
    serviceTitle.style.marginBottom = "6px";
    serviceTitle.style.fontSize = "12px";
    serviceBox.appendChild(serviceTitle);

    const urlRow = document.createElement("div");
    urlRow.style.display = "flex";
    urlRow.style.gap = "6px";
    urlRow.style.marginBottom = "6px";

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.placeholder = DEFAULT_BASE_URL;
    urlInput.style.flex = "1";
    urlInput.value = (() => {
      try {
        return localStorage.getItem("zion.pluginServiceUrl") || DEFAULT_BASE_URL;
      } catch {
        return DEFAULT_BASE_URL;
      }
    })();
    urlInput.onchange = () => {
      try {
        localStorage.setItem("zion.pluginServiceUrl", urlInput.value.trim());
      } catch {}
      const installer = (window as any).zion.pluginInstaller;
      if (installer && typeof installer.setBaseUrl === "function") installer.setBaseUrl(urlInput.value.trim());
    };

    const saveUrlBtn = document.createElement("button");
    saveUrlBtn.textContent = "Save URL";
    saveUrlBtn.onclick = () => {
      try {
        localStorage.setItem("zion.pluginServiceUrl", urlInput.value.trim());
        const installer = (window as any).zion.pluginInstaller;
        if (installer && typeof installer.setBaseUrl === "function") installer.setBaseUrl(urlInput.value.trim());
        console.log("[plugins] service url set:", urlInput.value.trim());
      } catch {}
    };

    urlRow.appendChild(urlInput);
    urlRow.appendChild(saveUrlBtn);
    serviceBox.appendChild(urlRow);

    // 本地拖拽安装区域
    const dropZone = document.createElement("div");
    dropZone.style.border = "2px dashed var(--border)";
    dropZone.style.borderRadius = "6px";
    dropZone.style.padding = "12px";
    dropZone.style.marginBottom = "8px";
    dropZone.style.textAlign = "center";
    dropZone.style.fontSize = "12px";
    dropZone.style.opacity = "0.85";
    dropZone.textContent = "拖拽 ZIP 插件包到此处进行安装";
    dropZone.ondragover = (e) => {
      e.stopPropagation();
      e.preventDefault();
      dropZone.style.background = "rgba(0,0,0,0.1)";
    };
    dropZone.ondragleave = () => {
      dropZone.style.background = "transparent";
    };
    dropZone.ondrop = async (e) => {
      e.stopPropagation();
      e.preventDefault();
      dropZone.style.background = "transparent";
      try {
        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;
        const installer = (window as any).zion.pluginInstaller;
        if (!installer || typeof installer.installFromFile !== "function") {
          alert("Installer 不可用");
          return;
        }
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          if (!f.name.toLowerCase().endsWith(".zip")) continue;
          const ret = await installer.installFromFile(f);
          if (ret.success && ret.plugin) {
            await pluginManager.installFromInfo(ret.plugin, { enabled: true });
            // 刷新面板以显示新插件
            overlay.remove();
            openPluginsPanel(pluginManager);
          } else {
            alert(`安装失败: ${ret.error?.message || "未知错误"}`);
          }
        }
      } catch (err) {
        console.error("[plugins] local drop install error:", err);
        alert("安装过程中发生错误，请查看控制台");
      }
    };
    serviceBox.appendChild(dropZone);

    const actionRow = document.createElement("div");
    actionRow.style.display = "flex";
    actionRow.style.gap = "6px";

    const queryInput = document.createElement("input");
    queryInput.type = "text";
    queryInput.placeholder = "Search query";
    queryInput.style.flex = "1";

    const searchBtn = document.createElement("button");
    searchBtn.textContent = "Search";
    const resultsList = document.createElement("div");
    resultsList.style.marginTop = "6px";

    searchBtn.onclick = async () => {
      try {
        resultsList.innerHTML = "";
        const installer = (window as any).zion.pluginInstaller;
        if (!installer) return;
        const res = await installer.searchPlugins(queryInput.value.trim(), 50);
        if (!res.success) {
          const err = document.createElement("div");
          err.style.color = "var(--error)";
          err.style.fontSize = "12px";
          err.textContent = `Search failed: ${res.error?.message || 'Unknown'}`;
          resultsList.appendChild(err);
          return;
        }
        res.data.forEach((item: any) => {
          const row = document.createElement("div");
          row.style.display = "flex";
          row.style.justifyContent = "space-between";
          row.style.alignItems = "center";
          row.style.padding = "4px 0";
          const label = document.createElement("div");
          label.textContent = `${item.name} (${item.id}) v${item.version}`;
          label.style.fontSize = "12px";
          const installBtn = document.createElement("button");
          installBtn.textContent = "Install";
          installBtn.onclick = async () => {
            const installer2 = (window as any).zion.pluginInstaller;
            const ret = await installer2.installFromService(item.id);
            if (ret.success && ret.plugin) {
              try {
                await pluginManager.installFromInfo(ret.plugin, { enabled: true });
                overlay.remove();
                openPluginsPanel(pluginManager);
              } catch (e) {
                console.error("[plugins] install error:", e);
              }
            } else {
              alert(`Install failed: ${ret.error?.message || 'Unknown'}`);
            }
          };
          row.appendChild(label);
          row.appendChild(installBtn);
          resultsList.appendChild(row);
        });
        if (res.data.length === 0) {
          const empty = document.createElement("div");
          empty.textContent = "No plugins matched";
          empty.style.opacity = "0.8";
          empty.style.fontSize = "12px";
          resultsList.appendChild(empty);
        }
      } catch (e) {
        console.error("[plugins] search error:", e);
      }
    };

    const listBtn = document.createElement("button");
    listBtn.textContent = "List All";
    listBtn.onclick = async () => {
      try {
        resultsList.innerHTML = "";
        const installer = (window as any).zion.pluginInstaller;
        if (!installer) return;
        const res = await installer.listPlugins(100, 0);
        if (!res.success) {
          const err = document.createElement("div");
          err.style.color = "var(--error)";
          err.style.fontSize = "12px";
          err.textContent = `List failed: ${res.error?.message || 'Unknown'}`;
          resultsList.appendChild(err);
          return;
        }
        res.data.forEach((item: any) => {
          const row = document.createElement("div");
          row.style.display = "flex";
          row.style.justifyContent = "space-between";
          row.style.alignItems = "center";
          row.style.padding = "4px 0";
          const label = document.createElement("div");
          label.textContent = `${item.name} (${item.id}) v${item.version}`;
          label.style.fontSize = "12px";
          const installBtn = document.createElement("button");
          installBtn.textContent = "Install";
          installBtn.onclick = async () => {
            const installer2 = (window as any).zion.pluginInstaller;
            const ret = await installer2.installFromService(item.id);
            if (ret.success && ret.plugin) {
              try {
                await pluginManager.installFromInfo(ret.plugin, { enabled: true });
                overlay.remove();
                openPluginsPanel(pluginManager);
              } catch (e) {
                console.error("[plugins] install error:", e);
              }
            } else {
              alert(`Install failed: ${ret.error?.message || 'Unknown'}`);
            }
          };
          row.appendChild(label);
          row.appendChild(installBtn);
          resultsList.appendChild(row);
        });
        if (res.data.length === 0) {
          const empty = document.createElement("div");
          empty.textContent = "No plugins found";
          empty.style.opacity = "0.8";
          empty.style.fontSize = "12px";
          resultsList.appendChild(empty);
        }
      } catch (e) {
        console.error("[plugins] list error:", e);
      }
    };

    actionRow.appendChild(queryInput);
    actionRow.appendChild(searchBtn);
    actionRow.appendChild(listBtn);
    serviceBox.appendChild(actionRow);
    serviceBox.appendChild(resultsList);

    panel.appendChild(serviceBox);

    // ===== 开发模式（本地目录 → HTTP 映射 → 热重载） =====
    const devBox = document.createElement("div");
    devBox.style.marginTop = "12px";
    devBox.style.padding = "8px";
    devBox.style.border = "1px dashed var(--border)";
    devBox.style.borderRadius = "6px";

    const devTitle = document.createElement("div");
    devTitle.textContent = "Dev Mode (Local Directory → HTTP Mapping)";
    devTitle.style.fontWeight = "600";
    devTitle.style.marginBottom = "6px";
    devTitle.style.fontSize = "12px";
    devBox.appendChild(devTitle);

    const devRow = document.createElement("div");
    devRow.style.display = "flex";
    devRow.style.gap = "6px";
    devRow.style.marginBottom = "6px";

    const devPathInput = document.createElement("input");
    devPathInput.type = "text";
    devPathInput.placeholder = "/absolute/path/to/your-plugin";
    devPathInput.style.flex = "1";

    const devStartBtn = document.createElement("button");
    devStartBtn.textContent = "Start Dev";
    const devStopBtn = document.createElement("button");
    devStopBtn.textContent = "Stop Dev";
    devStopBtn.disabled = true;

    devRow.appendChild(devPathInput);
    devRow.appendChild(devStartBtn);
    devRow.appendChild(devStopBtn);
    devBox.appendChild(devRow);

    const devStatus = document.createElement("div");
    devStatus.style.fontSize = "12px";
    devStatus.style.opacity = "0.85";
    devBox.appendChild(devStatus);

    panel.appendChild(devBox);

    // 维护活跃的开发会话
    const activeDevSessions: Map<string, { ws: WebSocket; baseUrl: string; pluginId: string; dir?: string }> = new Map();

    const getServiceBaseUrl = (): string => {
      try {
        return localStorage.getItem("zion.pluginServiceUrl") || DEFAULT_BASE_URL;
      } catch {
        return DEFAULT_BASE_URL;
      }
    };

    const connectWebSocket = (serviceUrl: string, devId: string) => {
      const wsUrl = serviceUrl.replace(/^http/, "ws") + `/plugins/dev/ws/${devId}`;
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        devStatus.textContent = `Dev websocket connected: ${wsUrl}`;
      };
      ws.onmessage = async (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "dev:change" && msg.devId === devId) {
            // 变更事件：重新读取 manifest 并热重载插件
            const installer = (window as any).zion.pluginInstaller;
            const baseUrl = getServiceBaseUrl() + `/plugins/dev/${devId}`;
            const ret = await installer.installFromDevBase(baseUrl, devId);
            if (ret.success && ret.plugin) {
              // 使用热重载方法（不检查版本变化）
              try {
                await pluginManager.hotReloadFromInfo(ret.plugin, { enabled: true });
              } catch (e) {
                console.error("[plugins] dev hot reload error:", e);
                notificationManager.showHotReloadError(
                  ret.plugin.name,
                  (e as any)?.message || String(e)
                );
              }
            } else {
              console.warn("[plugins] dev install failed:", ret.error?.message);
            }
          } else if (msg.type === "dev:stop") {
            devStatus.textContent = `Dev session stopped: ${devId}`;
          }
        } catch (e) {
          // 非JSON消息或错误
        }
      };
      ws.onclose = () => {
        devStatus.textContent = `Dev websocket closed: ${devId}`;
      };
      return ws;
    };

    devStartBtn.onclick = async () => {
      const p = devPathInput.value.trim();
      if (!p) {
        alert("请输入本地插件目录绝对路径");
        return;
      }
      const serviceUrl = getServiceBaseUrl();
      try {
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

        // 开发模式安装（manifest.json）
        const installer = (window as any).zion.pluginInstaller;
        const ret = await installer.installFromDevBase(baseUrl, devId);
        if (ret.success && ret.plugin) {
          await pluginManager.installFromInfo(ret.plugin, { enabled: true });
          devStatus.textContent = `Dev session started: ${devId} (${ret.plugin.id})`;
          const ws = connectWebSocket(serviceUrl, devId);
          activeDevSessions.set(devId, { ws, baseUrl, pluginId: ret.plugin.id, dir: devDir });
          
          // 显示开发模式启动通知
          notificationManager.showDevModeStarted(ret.plugin.name, devDir);

          // 记录到全局 state 与本地存储（便于页面刷新后仍能显示开发目录信息）
          try {
            const sessions = (window.zion.state.get("plugins.devSessions") || {}) as Record<string, any>;
            sessions[devId] = { ws, baseUrl, pluginId: ret.plugin.id, dir: devDir };
            window.zion.state.set("plugins.devSessions", sessions);

            const savedRaw = localStorage.getItem("zion.plugins.devSessionsInfo") || "{}";
            const saved = JSON.parse(savedRaw);
            saved[ret.plugin.id] = { devId, baseUrl, dir: devDir };
            localStorage.setItem("zion.plugins.devSessionsInfo", JSON.stringify(saved));
          } catch {}

          devStartBtn.disabled = true;
          devStopBtn.disabled = false;
        } else {
          throw new Error(ret.error?.message || "开发模式安装失败");
        }
      } catch (e) {
        console.error("[plugins] dev start error:", e);
        alert(`启动开发模式失败：${(e as any)?.message || e}`);
      }
    };

    devStopBtn.onclick = async () => {
      // 简化：停止所有活跃会话
      const serviceUrl = getServiceBaseUrl();
      try {
        for (const [devId, sess] of activeDevSessions.entries()) {
          try {
            const res = await fetch(`${serviceUrl}/plugins/dev/stop`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ devId })
            });
            sess.ws.close();
          } catch {}
          // 清理运行时会话映射
          try {
            const sessions = (window.zion.state.get("plugins.devSessions") || {}) as Record<string, any>;
            delete sessions[devId];
            window.zion.state.set("plugins.devSessions", sessions);

            // 清理本地存储映射（按 pluginId）
            const savedRaw = localStorage.getItem("zion.plugins.devSessionsInfo") || "{}";
            const saved = JSON.parse(savedRaw);
            if (sess.pluginId && saved[sess.pluginId]) {
              delete saved[sess.pluginId];
              localStorage.setItem("zion.plugins.devSessionsInfo", JSON.stringify(saved));
            }
          } catch {}
          activeDevSessions.delete(devId);
        }
        devStatus.textContent = "Dev sessions stopped.";
        
        // 显示开发模式停止通知
        notificationManager.showDevModeStopped("All plugins");
      } catch (e) {
        console.error("[plugins] dev stop error:", e);
      } finally {
        devStartBtn.disabled = false;
        devStopBtn.disabled = true;
      }
    };

    // 操作按钮
    const footer = document.createElement("div");
    footer.style.marginTop = "12px";
    footer.style.display = "flex";
    footer.style.justifyContent = "space-between";

    const leftButtons = document.createElement("div");
    leftButtons.style.display = "flex";
    leftButtons.style.gap = "8px";

    const reloadBtn = document.createElement("button");
    reloadBtn.textContent = "Reload All";
    reloadBtn.style.background = "var(--border)";
    reloadBtn.style.color = "var(--fg)";
    reloadBtn.style.border = "1px solid var(--accent)";
    reloadBtn.style.borderRadius = "4px";
    reloadBtn.style.padding = "4px 8px";
    reloadBtn.style.fontSize = "12px";
    reloadBtn.onclick = () => location.reload();
    leftButtons.appendChild(reloadBtn);

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.style.background = "var(--border)";
    closeBtn.style.color = "var(--fg)";
    closeBtn.style.border = "1px solid var(--accent)";
    closeBtn.style.borderRadius = "4px";
    closeBtn.style.padding = "4px 8px";
    closeBtn.style.fontSize = "12px";
    closeBtn.onclick = () => overlay.remove();

    footer.appendChild(leftButtons);
    footer.appendChild(closeBtn);
    panel.appendChild(footer);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  } catch (e) {
    console.error("openPluginsPanel error:", e);
  }
}

/**
 * 预安装内置插件
 */
async function preinstallBuiltinPlugins(pluginManager: PluginManager) {
  try {
    console.log('[PluginManager] 开始预安装内置插件...');
    
    // 定义内置插件列表
    const builtinPlugins: PluginInfo[] = [];

    try {
      // 加载 manifest.json（新格式）
      const manifestJsons = (import.meta as any).glob('/extensions/**/manifest.json', { eager: true }) as Record<string, any>;

      const existingIds = new Set(builtinPlugins.map(p => p.id));

      // 处理 manifest.json（新格式）
      for (const [manifestPath, mod] of Object.entries(manifestJsons)) {
        const manifest = (mod as any)?.default || mod;
        const extDir = manifestPath.replace(/\/manifest\.json$/, '');
        const dirName = extDir.split('/').pop() || extDir;

        const zionData = manifest.zion || {};
        const pluginId = zionData.id || manifest.name || `zion.${dirName.replace(/^dev\./, '')}`;
        if (existingIds.has(pluginId)) continue;
        existingIds.add(pluginId);

        const extMain = zionData.main || manifest.main || './main.js';
        const normalizedExtMain = extMain.replace(/^\.\//, '');
        const resolvedMain = normalizedExtMain === 'main.js' ? `internal:${dirName}` : `internal:${dirName}/${normalizedExtMain}`;

        builtinPlugins.push({
          id: pluginId,
          name: zionData.name || manifest.name || dirName,
          version: zionData.version || manifest.version || '0.0.1',
          description: manifest.description,
          author: manifest.author,
          license: manifest.license,
          path: extDir,
          manifest: manifest,
          state: 'installed',
          dependencies: Object.keys(zionData.dependencies || {}),
          peerDependencies: Object.keys(zionData.peerDependencies || {}),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          isLegacy: false,
          enabled: true
        });
      }
    } catch {}

    try {
      const expected = new Set(builtinPlugins.map(p => p.id));
      for (const p of pluginManager.list()) {
        if (!p || expected.has(p.id)) continue;

        const id = String(p.id || '');
        const path = typeof p.path === 'string' ? p.path : '';

        if (id.startsWith('zion.dev.') && path.includes('/extensions/dev.')) {
          try {
            await pluginManager.uninstall(p.id);
          } catch {}
          continue;
        }

        if (!path.startsWith('/extensions/')) continue;
        const dirName = path.split('/').pop() || '';
        if (!dirName) continue;
        const replacementId = `zion.${dirName.replace(/^dev\./, '')}`;
        if (!expected.has(replacementId)) continue;
        if (id === replacementId) continue;
        try {
          await pluginManager.uninstall(p.id);
        } catch {}
      }
    } catch {}

    // 检查并安装每个内置插件
    for (const pluginInfo of builtinPlugins) {
      try {
        console.log(`[PluginManager] 同步内置插件信息: ${pluginInfo.id}`);
        await pluginManager.updateFromInfo(pluginInfo, { enabled: true });
      } catch (error) {
        console.error(`[PluginManager] 安装内置插件失败 ${pluginInfo.id}:`, error);
      }
    }

    console.log('[PluginManager] 内置插件预安装完成');
  } catch (error) {
    console.error('[PluginManager] 预安装内置插件失败:', error);
  }
}

/**
 * 页面刷新后恢复开发会话的WebSocket连接
 */
async function restoreDevSessions(pluginManager: PluginManager, pluginInstaller: any) {
  try {
    console.log('[PluginManager] 尝试恢复开发会话...');
    
    // 从localStorage读取保存的开发会话信息
    const savedRaw = localStorage.getItem("zion.plugins.devSessionsInfo") || "{}";
    const saved = JSON.parse(savedRaw);
    
    if (!saved || Object.keys(saved).length === 0) {
      console.log('[PluginManager] 没有需要恢复的开发会话');
      return;
    }
    
    console.log(`[PluginManager] 发现 ${Object.keys(saved).length} 个开发会话需要恢复`);
    
    const getServiceBaseUrl = (): string => {
      try {
        return localStorage.getItem("zion.pluginServiceUrl") || DEFAULT_BASE_URL;
      } catch {
        return DEFAULT_BASE_URL;
      }
    };
    
    const serviceUrl = getServiceBaseUrl();
    
    // 恢复每个开发会话
    for (const [pluginId, devInfo] of Object.entries(saved)) {
      try {
        const info = devInfo as any;
        const devId = info.devId;
        const baseUrl = info.baseUrl;
        const dir = info.dir;
        
        if (!devId || !baseUrl || !dir) {
          console.warn(`[PluginManager] 无效的开发会话信息: pluginId=${pluginId}`);
          continue;
        }
        
        console.log(`[PluginManager] 恢复开发会话: pluginId=${pluginId}, devId=${devId}`);
        
        // 检查插件是否已安装
        const plugin = pluginManager.list().find(p => p.id === pluginId);
        if (!plugin) {
          console.log(`[PluginManager] 插件 ${pluginId} 未安装，跳过恢复`);
          continue;
        }
        
        // 【修复】先尝试重启开发会话（防止后端重启导致会话丢失）
        try {
          const res = await fetch(`${serviceUrl}/plugins/dev/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: dir })
          });
          
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${await res.text()}`);
          }
          
          const data = await res.json();
          const newDevId = data?.data?.devId;
          const newBaseUrl = serviceUrl + data?.data?.baseUrl;
          
          if (!newDevId || !newBaseUrl) {
            throw new Error("invalid dev start response");
          }
          
          console.log(`[PluginManager] 开发会话已重启: ${pluginId} (oldDevId=${devId} -> newDevId=${newDevId})`);

          // 用新路径更新插件
          const ret = await pluginInstaller.installFromDevBase(newBaseUrl, newDevId);
          if (ret.success && ret.plugin) {
            await pluginManager.hotReloadFromInfo(ret.plugin, { enabled: true, skipNotification: true });
          }
          
          // 更新 localStorage 中的开发会话信息
          saved[pluginId] = { devId: newDevId, baseUrl: newBaseUrl, dir: dir };
          localStorage.setItem("zion.plugins.devSessionsInfo", JSON.stringify(saved));
          
          // 用新 devId 连接 WebSocket
          const wsUrl = serviceUrl.replace(/^http/, "ws") + `/plugins/dev/ws/${newDevId}`;
          const ws = new WebSocket(wsUrl);
          
          ws.onopen = () => {
            console.log(`[PluginManager] 开发会话WebSocket已连接: ${newDevId}`);
          };
          
          ws.onmessage = async (ev) => {
            try {
              const msg = JSON.parse(ev.data);
              if (msg.type === "dev:change" && msg.devId === newDevId) {
                // 变更事件：重新读取 manifest 并热重载插件
                const ret = await pluginInstaller.installFromDevBase(newBaseUrl, newDevId);
                if (ret.success && ret.plugin) {
                  // 使用热重载方法（不检查版本变化）
                  try {
                    await pluginManager.hotReloadFromInfo(ret.plugin, { enabled: true });
                  } catch (e) {
                    console.error("[PluginManager] 开发会话恢复热重载错误:", e);
                  }
                } else {
                  console.warn("[PluginManager] 开发会话恢复安装失败:", ret.error?.message);
                }
              } else if (msg.type === "dev:stop") {
                console.log(`[PluginManager] 开发会话已停止: ${newDevId}`);
                // 清理本地存储
                try {
                  const savedRaw = localStorage.getItem("zion.plugins.devSessionsInfo") || "{}";
                  const saved = JSON.parse(savedRaw);
                  delete saved[pluginId];
                  localStorage.setItem("zion.plugins.devSessionsInfo", JSON.stringify(saved));
                } catch {}
              }
            } catch (e) {
              // 非JSON消息或错误
            }
          };
          
          ws.onclose = () => {
            console.log(`[PluginManager] 开发会话WebSocket已关闭: ${newDevId}`);
          };
          
          ws.onerror = (error) => {
            console.error(`[PluginManager] 开发会话WebSocket错误: ${newDevId}`, error);
          };
          
          // 保存到全局state
          const sessions = (window.zion.state.get("plugins.devSessions") || {}) as Record<string, any>;
          sessions[newDevId] = { ws, baseUrl: newBaseUrl, pluginId, dir };
          window.zion.state.set("plugins.devSessions", sessions);
          
          console.log(`[PluginManager] 开发会话恢复成功: pluginId=${pluginId}, devId=${newDevId}`);
          
        } catch (startError) {
          console.error(`[PluginManager] 重启开发会话失败 ${pluginId}:`, startError);
          // 如果重启失败，清理插件信息，避免后续加载失败
          console.warn(`[PluginManager] 清理失效的开发插件: ${pluginId}`);
          await pluginManager.uninstall(pluginId);
          
          // 从本地存储中删除
          delete saved[pluginId];
          localStorage.setItem("zion.plugins.devSessionsInfo", JSON.stringify(saved));
        }
        
      } catch (error) {
        console.error(`[PluginManager] 恢复开发会话失败 pluginId=${pluginId}:`, error);
      }
    }
    
    console.log('[PluginManager] 开发会话恢复完成');
  } catch (error) {
    console.error('[PluginManager] 恢复开发会话失败:', error);
  }
}


bootstrap();
