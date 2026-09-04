import { settingsRegistry } from "../settings/registry";
import { open as openSettingsPanel, close as closeSettingsPanel } from "../settings/SettingsPanel";
import { EventBus } from "../core/event-bus";
import { StateBus } from "../core/state-bus";
import type { Disposable, Keybinding, CommandHandler, PasteHandler, MenuItem, MessageContributor, Decorator } from "../types/zion";
import { createRunLedger } from "../core/run-ledger";
import {
  authorizeToolCall,
  filterToolsForPolicy,
  normalizeCapabilityPolicy
} from "../core/run-policy";
import type { EditorCore } from "../editor/EditorCore";
import { EditorProxy } from "../editor/EditorProxy";
import type { EditorProxy as IEditorProxy } from "../types/zion";
import { findNext, findPrevious, selectMatches, replaceNext, replaceAll, SearchQuery } from "@codemirror/search";
// setSearchQuery 实际是一个 StateEffect，不是函数，需要用 editorCore.view.dispatch({ effects: setSearchQuery.of(query) })
import { setSearchQuery as setSearchQueryEffect } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { notificationManager } from "../notification/manager";
import {
  activityBarRuntime,
  auxiliaryBarRuntime,
  bindWorkbenchCore,
  bottomPanelRuntime,
  inspectorRuntime,
  responsiveRuntime,
  sideBarRuntime
} from "../ui/workbench/runtime";
import { createChatUsageStore } from "../chat/usage";
import {
  assistantBlockHeaderText,
  stripAssistantBlockIdComment
} from "../chat/restore";
import { createZionIcon, hasZionIcon, zionIconName } from "../ui/icons";
import {
  beginImageInsertion,
  cancelImageInsertion,
  completeImageInsertion,
  failImageInsertion,
  hideImageDropIndicator,
  showImageDropIndicator
} from "../editor/image-transactions";
import {
  getImageAssetMetadata,
  isImageAssetUri,
  putImageAsset,
  readImageAssetDataUrl,
  resolveImageAsset
} from "../media/image-assets";

type CommandMap = Map<string, CommandHandler>;

class Registry {
  private commands: CommandMap = new Map();
  private keybindings: Keybinding[] = [];
  private events = new EventBus();
  private state = new StateBus();
  private statusItems = new Map<
    string,
    { id: string; el: HTMLButtonElement; onClick?: () => void; priority: number; pinned: boolean; align: "left" | "right" }
  >();
  private statusItemMinWidth = new Map<string, number>();
  private statusPinned: Set<string> = new Set();
  private readonly STATUS_PINNED_KEY = 'zion.statusBar.pinned';
  private bottomStatusItems = new Map<
    string,
    { id: string; el: HTMLButtonElement; onClick?: () => void; priority: number }
  >();
  private editorCore: EditorCore | null = null;
  private editorCores = new Map<string, EditorCore>();
  private editorProxies = new Map<string, EditorProxy>();
  private editorProxiesByEditorId = new Map<string, EditorProxy>();
  private activePanelId: string | null = null;
  private updateListenerAttached = new Set<string>();

  // paste handlers
  private pasteHandlers: PasteHandler[] = [];
  private pasteAttached = new Set<string>();

  // menus
  private menus: Record<string, MenuItem[]> = Object.create(null);
  private contextMenuEl: HTMLDivElement | null = null;

  // 菜单项使用统计
  private menuUsageStats: Record<string, {
    clickCount: number;
    lastClickTime: number;
    pinned: boolean;
    customOrder?: number;
    groupId?: string;
  }> = Object.create(null);

  // 默认置顶的菜单项命令
  private readonly DEFAULT_PINNED_COMMANDS = [
    'chat.run',
    'chat.stop',
    'chat.retry',
    'models.openSwitcher'
  ];

  // message contributors
  private messageContribs: MessageContributor[] = [];

  // decorators
  private decorators: Decorator[] = [];
  private decoratorDisposables = new Map<string, Disposable>();
  private contextMenuAttached = new Set<string>();

  // model providers (placeholder registry for future models integration)
  private modelProviders: { id: string; list: () => any | Promise<any>; resolve: (id: string) => any | Promise<any> }[] = [];

  // Chat Runner (MVP) state
  private activeModel: { providerId: string; modelId: string } | null = null;
  private currentRuns: Map<string, { id: string; timer: number; endPos: number }> = new Map();
  private lastPrompt: string | null = null;

  attachEditor(core: EditorCore, panelId = "panel-0") {
    const editorKey = core.getEditorId?.() || panelId;
    this.editorCores.set(panelId, core);
    let proxy = this.editorProxiesByEditorId.get(editorKey);
    if (!proxy) {
      proxy = new EditorProxy(core, panelId);
      this.editorProxiesByEditorId.set(editorKey, proxy);
    } else {
      proxy.setCore(core);
      proxy.setPanelId(panelId);
    }
    this.editorProxies.set(panelId, proxy);

    if (!this.activePanelId) {
      this.activePanelId = panelId;
    }
    this.syncActiveEditor();
    this.applyKeymap();
    this.attachPasteListener(panelId);
    this.attachContextMenu(panelId);
    this.applyDecorators(panelId);
    try { this.events.emit("editor/attached", { panelId, editorId: editorKey, editor: proxy, core }); } catch {}

    // 加载菜单使用统计
    (this as any).loadMenuUsageStats();

    // Wire CM6 update events to Zion EventBus so plugins can react to input/cursor changes.
    if (!this.updateListenerAttached.has(editorKey)) try {
      const ext = EditorView.updateListener.of((update) => {
        try {
          const active = this.getActiveEditorCore();
          if (update.docChanged) {
            this.events.emit("editor.change", { update, view: core.view, panelId });
          }
          if (!active || active !== core) return;
          if (update.selectionSet) {
            this.events.emit("editor.cursorActivity", { selection: active.view.state.selection, view: active.view });
          }
        } catch (e) {
          console.error("[zion] editor update listener error", e);
        }
      });
      core.addExternalExtension(ext as any);
      this.updateListenerAttached.add(editorKey);
    } catch (e) {
      console.error("[zion] failed to attach editor update listener", e);
    }
    // Bridge CM6 search/replace commands into the zion command namespace.
    // This allows extensions to call window.zion.commands.executeCommand('findNext') etc.
    try {
      this.registerCommand("findNext", () => {
        if (!this.editorCore) return false;
        try {
          return findNext(this.editorCore.view as any);
        } catch (e) {
          console.error("[zion] findNext error", e);
          return false;
        }
      });

      this.registerCommand("findPrev", () => {
        if (!this.editorCore) return false;
        try {
          return findPrevious(this.editorCore.view as any);
        } catch (e) {
          console.error("[zion] findPrev error", e);
          return false;
        }
      });

      this.registerCommand("selectMatches", () => {
        if (!this.editorCore) return false;
        try {
          return selectMatches(this.editorCore.view as any);
        } catch (e) {
          console.error("[zion] selectMatches error", e);
          return false;
        }
      });

      this.registerCommand("replaceNext", () => {
        if (!this.editorCore) return false;
        try {
          return replaceNext(this.editorCore.view as any);
        } catch (e) {
          console.error("[zion] replaceNext error", e);
          return false;
        }
      });

      this.registerCommand("replaceAll", () => {
        if (!this.editorCore) return false;
        try {
          return replaceAll(this.editorCore.view as any);
        } catch (e) {
          console.error("[zion] replaceAll error", e);
          return false;
        }
      });

      // Push a SearchQuery into CM6 so find/replace won't open the default panel
      this.registerCommand("setSearchQuery", (opts: { search: string; replace?: string; caseSensitive?: boolean; regexp?: boolean; wholeWord?: boolean }) => {
        if (!this.editorCore) return false;
        try {
          const q = new SearchQuery({
            search: opts.search ?? "",
            replace: opts.replace ?? "",
            caseSensitive: !!opts.caseSensitive,
            regexp: !!opts.regexp,
            wholeWord: !!opts.wholeWord
          });
          this.editorCore.view.dispatch({
            effects: setSearchQueryEffect.of(q)
          });
          return true;
        } catch (e) {
          console.error("[zion] setSearchQuery error", e);
          return false;
        }
      });
    } catch (e) {
      console.error("[zion] failed to register CM6 search bridge commands", e);
    }

    // Register chat commands (MVP runner)
    try {
      if (!this.commands.has("chat.run")) {
        this.registerCommand("chat.run", () => {
          return (this as any).__chatRun({});
        });
      }
      if (!this.commands.has("chat.stop")) {
        this.registerCommand("chat.stop", () => {
          (this as any).__chatStop();
          return true;
        });
      }
      if (!this.commands.has("chat.retry")) {
        this.registerCommand("chat.retry", () => {
          (this as any).__chatRetry();
          return true;
        });
      }
      // Select active model for later integration (LangChain-ready)
      if (!this.commands.has("models.selectActive")) {
        this.registerCommand("models.selectActive", (m: { providerId: string; modelId: string } | null) => {
          (this as any).__chatSetActiveModel(m);
          return true;
        });
      }
    } catch (e) {
      console.error("[zion] failed to register chat commands", e);
    }

    // Expose minimap control commands bridging to EditorCore
    try {
      this.registerCommand("zion.setMinimap", (enabled: boolean) => {
        const hasAny = !!this.editorCore || this.editorCores.size > 0;
        if (!hasAny) return false;
        try {
          this.forEachEditorCore((core) => core.setMinimapEnabled(!!enabled));
          this.state.set("ui.minimapEnabled", !!enabled);
          return true;
        } catch (e) {
          console.error("[zion] setMinimap error", e);
          return false;
        }
      });
      this.registerCommand("zion.toggleMinimap", () => {
        const cur = !!this.state.get("ui.minimapEnabled");
        const next = !cur;
        const hasAny = !!this.editorCore || this.editorCores.size > 0;
        if (!hasAny) {
          this.state.set("ui.minimapEnabled", next);
          return next;
        }
        try {
          this.forEachEditorCore((core) => core.setMinimapEnabled(next));
        } catch (e) {
          console.error("[zion] toggleMinimap error", e);
        }
        this.state.set("ui.minimapEnabled", next);
        return next;
      });
    } catch (e) {
      console.error("[zion] failed to register minimap bridge commands", e);
    }

    // Selection highlight bridge
    try {
      this.registerCommand("zion.setSelectionHighlight", (enabled: boolean) => {
        const hasAny = !!this.editorCore || this.editorCores.size > 0;
        if (!hasAny) return false;
        try {
          this.forEachEditorCore((core) => core.setSelectionHighlightEnabled(!!enabled));
          this.state.set("ui.selectionHighlight", !!enabled);
          return true;
        } catch (e) {
          console.error("[zion] setSelectionHighlight error", e);
          return false;
        }
      });
      this.registerCommand("zion.toggleSelectionHighlight", () => {
        const cur = !!this.state.get("ui.selectionHighlight");
        const next = !cur;
        const hasAny = !!this.editorCore || this.editorCores.size > 0;
        if (!hasAny) {
          this.state.set("ui.selectionHighlight", next);
          return next;
        }
        try {
          this.forEachEditorCore((core) => core.setSelectionHighlightEnabled(next));
        } catch (e) {
          console.error("[zion] toggleSelectionHighlight error", e);
        }
        this.state.set("ui.selectionHighlight", next);
        return next;
      });
    } catch (e) {
      console.error("[zion] failed to register selection highlight bridge commands", e);
    }
    return proxy;
  }

  setActivePanel(panelId: string | null) {
    this.activePanelId = panelId;
    this.syncActiveEditor();
  }

  private getActiveEditorCore(): EditorCore | null {
    if (this.activePanelId && this.editorCores.has(this.activePanelId)) {
      return this.editorCores.get(this.activePanelId) || null;
    }
    return this.editorCore;
  }

  private forEachEditorCore(fn: (core: EditorCore) => void) {
    const seen = new Set<EditorCore>();
    try {
      for (const core of this.editorCores.values()) {
        if (!core || seen.has(core)) continue;
        seen.add(core);
        try { fn(core); } catch {}
      }
    } catch {}
    if (this.editorCore && !seen.has(this.editorCore)) {
      try { fn(this.editorCore); } catch {}
    }
  }

  listAttachedEditorCores(): EditorCore[] {
    const out: EditorCore[] = [];
    this.forEachEditorCore((core) => out.push(core));
    return out;
  }

  private getActiveEditorProxy(): EditorProxy | null {
    if (this.activePanelId && this.editorProxies.has(this.activePanelId)) {
      return this.editorProxies.get(this.activePanelId) || null;
    }
    return null;
  }

  private getEditorProxyForView(view: EditorView | null | undefined): EditorProxy | null {
    if (!view) return null;
    for (const proxy of this.editorProxies.values()) {
      try {
        if (proxy.getView?.() === view) return proxy;
      } catch {}
    }
    return null;
  }

  detachEditor(panelId: string) {
    const proxy = this.editorProxies.get(panelId) || null;
    const editorKeys = new Set<string>([panelId]);
    for (const [editorKey, attachedProxy] of Array.from(this.editorProxiesByEditorId.entries())) {
      if (attachedProxy?.panelId !== panelId) continue;
      editorKeys.add(editorKey);
      this.editorProxiesByEditorId.delete(editorKey);
    }
    this.editorCores.delete(panelId);
    this.editorProxies.delete(panelId);
    for (const editorKey of editorKeys) {
      this.updateListenerAttached.delete(editorKey);
      this.pasteAttached.delete(editorKey);
      this.contextMenuAttached.delete(editorKey);
    }
    for (const [key, disp] of Array.from(this.decoratorDisposables.entries())) {
      if (!Array.from(editorKeys).some((editorKey) => key.endsWith(`:${editorKey}`))) continue;
      try { disp?.dispose?.(); } catch {}
      this.decoratorDisposables.delete(key);
    }
    if (this.activePanelId === panelId) {
      this.activePanelId = this.editorCores.keys().next().value || null;
    }
    this.syncActiveEditor();
    this.applyKeymap();
    return proxy;
  }

  private syncActiveEditor() {
    this.editorCore = this.getActiveEditorCore();
  }

  private attachPasteListener(panelId: string) {
    const core = this.editorCores.get(panelId);
    const editorKey = core?.getEditorId?.() || panelId;
    if (!core || this.pasteAttached.has(editorKey)) return;
    const dom = core.view.dom;
    dom.addEventListener("paste", async (e: ClipboardEvent) => {
      try {
        const cd = e.clipboardData;
        const editor: IEditorProxy | null = this.editorProxies.get(panelId) || null;
        if (!cd || !editor) return;

        // run handlers by priority (desc)
        const handlers = [...this.pasteHandlers].sort(
          (a, b) => (b.priority ?? 50) - (a.priority ?? 50)
        );
        for (const h of handlers) {
          const context = { clipboardData: cd, editor };
          let claim: unknown = undefined;
          if (typeof h.claim === "function") {
            try {
              claim = h.claim(context);
            } catch (err) {
              console.error("[zion] paste handler claim error:", h.id, err);
              continue;
            }
            if (claim === false || claim == null) continue;
            e.preventDefault();
          }
          try {
            const handled = await h.handle({ ...context, claim });
            if (handled) {
              e.preventDefault();
              return;
            }
            if (claim !== undefined) return;
          } catch (err) {
            console.error("[zion] paste handler error:", h.id, err);
            if (claim !== undefined) return;
          }
        }
      } catch (err) {
        console.error("[zion] paste pipeline error:", err);
      }
    });
    this.pasteAttached.add(editorKey);
  }

  private attachContextMenu(panelId: string) {
    const core = this.editorCores.get(panelId);
    const editorKey = core?.getEditorId?.() || panelId;
    if (!core || this.contextMenuAttached.has(editorKey)) return;
    const dom = core.view.dom;

    dom.addEventListener("contextmenu", (e: MouseEvent) => {
      const items = this.menus["editor/context"] || [];
      if (items.length === 0) return;
      e.preventDefault();
      this.showEditorContextMenuAt(e.clientX, e.clientY, panelId);
    });
    this.contextMenuAttached.add(editorKey);
  }

  private shouldShowMenuItem(it: MenuItem, ctx: { hasSelection: boolean; editorFocus: boolean }): boolean {
    if (!it.when) return true;
    if (it.when === "hasSelection") return ctx.hasSelection;
    if (it.when === "editorFocus") return ctx.editorFocus;
    return true;
  }

  private filterMenuTree(items: MenuItem[], ctx: { hasSelection: boolean; editorFocus: boolean }): MenuItem[] {
    const out: MenuItem[] = [];
    for (const it of items) {
      if (!this.shouldShowMenuItem(it, ctx)) continue;
      const kids = Array.isArray(it.submenu) ? this.filterMenuTree(it.submenu, ctx) : undefined;
      const hasKids = !!kids && kids.length > 0;
      const hasCmd = typeof it.command === "string" && it.command.trim().length > 0;
      if (!hasCmd && !hasKids) continue;
      // 确保没有子菜单的菜单项不会有 submenu 属性
      out.push({
        command: it.command,
        title: it.title,
          subtitle: it.subtitle,
        when: it.when,
        submenu: hasKids ? kids : undefined,
        order: it.order,
        pinned: it.pinned,
        group: it.group,
        dynamicTitle: it.dynamicTitle
      });
    }
    return out;
  }

  private positionMenuInViewport(el: HTMLElement, x: number, y: number) {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nx = rect.right > vw ? Math.max(4, vw - rect.width - 4) : x;
    const ny = rect.bottom > vh ? Math.max(4, vh - rect.height - 4) : y;
    el.style.left = `${nx}px`;
    el.style.top = `${ny}px`;
  }

  private buildContextMenuPanel(items: MenuItem[], closeMenu: () => void, menuId: string = "editor/context", ctx?: { panelId?: string | null; editor?: IEditorProxy | null; sessionId?: string | null }): HTMLDivElement {
    const menu = document.createElement("div");
      menu.className = "zion-context-menu zion-editor-context-menu";
    menu.setAttribute("role", "menu");
    menu.tabIndex = -1;

    let activeCloser: (() => void) | null = null;
    let activeDropTarget: HTMLElement | null = null;

    items = this.sortMenuItems(items, menuId);

    const isPinnedItem = (item: MenuItem) => {
      const cmd = item.command || "";
      if (!cmd) return false;
      const menuKey = `${menuId}:${cmd}`;
      const stats = this.menuUsageStats[menuKey];
      if (typeof stats?.pinned === "boolean") return stats.pinned;
      return !!item.pinned || this.DEFAULT_PINNED_COMMANDS.includes(cmd);
    };

    let pinnedCount = 0;
    for (const it of items) {
      if (!isPinnedItem(it)) break;
      pinnedCount++;
    }

    const dragAreaSeparator =
      pinnedCount > 0 && pinnedCount < items.length ? document.createElement("div") : null;
    if (dragAreaSeparator) {
      dragAreaSeparator.className = "zion-drag-area-separator";
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];

      if (dragAreaSeparator && i === pinnedCount) {
        menu.appendChild(dragAreaSeparator);
      }

      const row = document.createElement("div");
      const hasKids = !!it.submenu && Array.isArray(it.submenu) && it.submenu.length > 0;
      row.className = hasKids ? "zion-context-menu-row has-submenu" : "zion-context-menu-row";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "zion-context-menu-item";
      const span = document.createElement("span");
        let title = it.title || it.command || "";
      // 支持动态标题
      if (typeof it.dynamicTitle === "function") {
        try {
          const dt = it.dynamicTitle();
            if (dt !== null) title = dt;
        } catch {}
      }
        span.className = "zion-context-menu-label";
        const primary = document.createElement("span");
        primary.className = "zion-context-menu-label-primary";
        primary.textContent = title;
        span.appendChild(primary);
        if (it.subtitle) {
          const secondary = document.createElement("span");
          secondary.className = "zion-context-menu-label-secondary";
          secondary.textContent = it.subtitle;
          span.appendChild(secondary);
        }
        span.title = [title, it.subtitle].filter(Boolean).join(" · ");
      btn.appendChild(span);
      btn.setAttribute("role", "menuitem");

      if (hasKids) {
        btn.setAttribute("aria-haspopup", "menu");
        btn.setAttribute("aria-expanded", "false");
        const submenuId = `${menuId}:${it.command || 'submenu'}`;
        const submenu = this.buildContextMenuPanel(it.submenu || [], closeMenu, submenuId, ctx);
        submenu.classList.add("zion-context-submenu");
        submenu.style.position = "fixed";
        submenu.style.display = "none";
        (submenu as any).dataset.menuId = submenuId;

        let closeTimer: number | null = null;
        let openTimer: number | null = null;

        const cancelClose = () => {
          if (closeTimer !== null) {
            clearTimeout(closeTimer);
            closeTimer = null;
          }
        };

        const doClose = () => {
          cancelClose();
          btn.setAttribute("aria-expanded", "false");
          submenu.style.display = "none";
          if (activeCloser === doClose) activeCloser = null;
        };

        const scheduleClose = () => {
          cancelClose();
          closeTimer = window.setTimeout(() => {
            doClose();
          }, 240);
        };

        const open = () => {
          cancelClose();

          if (activeCloser && activeCloser !== doClose) {
            try {
              activeCloser();
            } catch {}
          }
          activeCloser = doClose;

          btn.setAttribute("aria-expanded", "true");
          submenu.style.display = "block";
          const r = row.getBoundingClientRect();
          const gap = 2;
          let sx = r.right + gap;
          let sy = r.top - 4;
          submenu.style.left = `${sx}px`;
          submenu.style.top = `${sy}px`;

          const rect = submenu.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          if (rect.right > vw) {
            sx = Math.max(4, r.left - rect.width - gap);
          }
          if (rect.bottom > vh) {
            sy = Math.max(4, vh - rect.height - 4);
          }
          if (sy < 4) sy = 4;
          submenu.style.left = `${sx}px`;
          submenu.style.top = `${sy}px`;
        };

        btn.onclick = (e) => {
          e.stopPropagation();
          const cmd = it.command;
          if (!cmd) return;
          try {
            if (ctx?.panelId || ctx?.editor || ctx?.sessionId) this.executeCommand(cmd, { panelId: ctx?.panelId || null, editor: ctx?.editor || null, sessionId: ctx?.sessionId || null });
            else this.executeCommand(cmd);
          } finally {
            closeMenu();
          }
        };

        row.addEventListener("mouseenter", () => {
          if (openTimer !== null) clearTimeout(openTimer);
          openTimer = window.setTimeout(open, 150);
        });
        row.addEventListener("mouseleave", () => {
          if (openTimer !== null) {
            clearTimeout(openTimer);
            openTimer = null;
          }
          scheduleClose();
        });
        submenu.addEventListener("mouseenter", cancelClose);
        submenu.addEventListener("mouseleave", scheduleClose);

        row.appendChild(btn);
        row.appendChild(submenu);
      } else {
        btn.onclick = () => {
          const cmd = it.command;
          if (!cmd) return;
          try {
            if (ctx?.panelId || ctx?.editor || ctx?.sessionId) this.executeCommand(cmd, { panelId: ctx?.panelId || null, editor: ctx?.editor || null, sessionId: ctx?.sessionId || null });
            else this.executeCommand(cmd);
            // 记录点击统计
            const menuKey = `${menuId}:${cmd}`;
            if (this.menuUsageStats[menuKey]) {
              this.menuUsageStats[menuKey].clickCount++;
              this.menuUsageStats[menuKey].lastClickTime = Date.now();
              // 保存统计信息
              (this as any).saveMenuUsageStats();
            }
          } finally {
            closeMenu();
          }
        };
        row.appendChild(btn);
      }

      // 添加拖拽手柄（仅对置顶区域）
      const isPinned = isPinnedItem(it);
      if (isPinned) {
        row.classList.add("has-drag-zone");

        // 创建左侧拖拽区域
        const dragZone = document.createElement("div");
        dragZone.className = "zion-drag-zone";

        // 添加拖拽图标
        const dragIcon = document.createElement("div");
        dragIcon.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="3" cy="2" r="1.5" fill="currentColor"/>
            <circle cx="9" cy="2" r="1.5" fill="currentColor"/>
            <circle cx="3" cy="6" r="1.5" fill="currentColor"/>
            <circle cx="9" cy="6" r="1.5" fill="currentColor"/>
            <circle cx="3" cy="10" r="1.5" fill="currentColor"/>
            <circle cx="9" cy="10" r="1.5" fill="currentColor"/>
          </svg>
        `;
        dragZone.appendChild(dragIcon);

        // 拖拽事件
        row.setAttribute("draggable", "true");
        row.dataset.menuIndex = String(i);
        row.dataset.command = it.command || '';

        // 防止点击按钮时触发拖拽
        btn.addEventListener("mousedown", () => {
          row.setAttribute("draggable", "false");
        });
        btn.addEventListener("mouseup", () => {
          row.setAttribute("draggable", "true");
        });

        row.addEventListener("dragstart", (e: DragEvent) => {
          e.stopPropagation();
          row.classList.add("is-dragging");
          dragZone.style.cursor = "grabbing";
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            const dragToken = it.command ? `cmd:${it.command}` : `idx:${i}`;
            e.dataTransfer.setData("text/plain", dragToken);
            // 创建自定义拖拽图像，避免浏览器默认的半透明效果
            const dragImage = row.cloneNode(true) as HTMLElement;
            dragImage.style.position = "absolute";
            dragImage.style.top = "-1000px";
            dragImage.style.left = "-1000px";
            dragImage.style.opacity = "1";
            dragImage.style.pointerEvents = "none";
            dragImage.classList.remove("is-dragging");
            document.body.appendChild(dragImage);
            e.dataTransfer.setDragImage(dragImage, 0, 0);
            // 延迟移除，确保拖拽图像已被使用
            setTimeout(() => dragImage.remove(), 0);
          }
        });

        row.addEventListener("dragend", () => {
          row.classList.remove("is-dragging");
          dragZone.style.cursor = "grab";
          if (activeDropTarget) {
            activeDropTarget.classList.remove("is-drop-target", "drop-before", "drop-after");
            activeDropTarget = null;
          }
        });

        row.addEventListener("dragover", (e: DragEvent) => {
          e.preventDefault();
          const targetRow = e.currentTarget as HTMLElement;
          const rect = targetRow.getBoundingClientRect();
          const before = e.clientY < rect.top + rect.height / 2;
          targetRow.classList.add("is-drop-target");
          targetRow.classList.toggle("drop-before", before);
          targetRow.classList.toggle("drop-after", !before);
          if (activeDropTarget && activeDropTarget !== targetRow) {
            activeDropTarget.classList.remove("is-drop-target", "drop-before", "drop-after");
          }
          activeDropTarget = targetRow;
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = "move";
          }
        });

        row.addEventListener("dragenter", (e: DragEvent) => {
          const targetRow = (e.currentTarget as HTMLElement);
          if (!targetRow.querySelector(".zion-drag-zone")) return;
          if (activeDropTarget && activeDropTarget !== targetRow) {
            activeDropTarget.classList.remove("is-drop-target", "drop-before", "drop-after");
          }
          activeDropTarget = targetRow;
          targetRow.classList.add("is-drop-target");
        });

        row.addEventListener("dragleave", (e: DragEvent) => {
          const targetRow = (e.currentTarget as HTMLElement);
          const rt = (e as any).relatedTarget as Node | null;
          if (rt && targetRow.contains(rt)) return;
          targetRow.classList.remove("is-drop-target", "drop-before", "drop-after");
          if (activeDropTarget === targetRow) activeDropTarget = null;
        });

        row.addEventListener("drop", (e: DragEvent) => {
          e.stopPropagation();
          e.preventDefault();
          const targetRow = (e.currentTarget as HTMLElement);
          const dropAfter = targetRow.classList.contains("drop-after");
          targetRow.classList.remove("is-drop-target", "drop-before", "drop-after");
          if (activeDropTarget === targetRow) activeDropTarget = null;

          const dragToken = e.dataTransfer?.getData("text/plain") || "";
          let fromIndex = -1;
          if (dragToken.startsWith("cmd:")) {
            const fromCommand = dragToken.slice(4);
            fromIndex = items.findIndex(item => item.command === fromCommand);
          } else if (dragToken.startsWith("idx:")) {
            fromIndex = parseInt(dragToken.slice(4));
          } else {
            fromIndex = items.findIndex(item => item.command === dragToken);
          }
          const toIndex = i;
          let insertIndex = toIndex + (dropAfter ? 1 : 0);
          if (insertIndex > pinnedCount) insertIndex = pinnedCount;

          if (
            fromIndex >= 0 &&
            fromIndex < pinnedCount &&
            fromIndex !== toIndex &&
            toIndex < pinnedCount &&
            isPinnedItem(items[fromIndex])
          ) {
            const moved = items[fromIndex];
            items.splice(fromIndex, 1);
            if (fromIndex < insertIndex) insertIndex--;
            items.splice(insertIndex, 0, moved);

            // 更新 customOrder
            for (let j = 0; j < pinnedCount; j++) {
              const item = items[j];
              if (item.command) {
                const menuKey = `${menuId}:${item.command}`;
                if (this.menuUsageStats[menuKey]) {
                  this.menuUsageStats[menuKey].customOrder = j * 10;
                  this.menuUsageStats[menuKey].pinned = true;
                }
              }
            }

            // 保存到 localStorage
            (this as any).saveMenuUsageStats();

            // 重新渲染菜单
            menu.innerHTML = "";
            this.rebuildMenuItems(menu, items, closeMenu, items, menuId);
          }
        });

        row.insertBefore(dragZone, btn);
      }

      // 为每个菜单项添加置顶/取消置顶按钮
      const pinBtn = document.createElement("button");
      pinBtn.className = "zion-pin-button";
      pinBtn.type = "button";

      const cmd = it.command || "";
      const isDefaultPinned = this.DEFAULT_PINNED_COMMANDS.includes(cmd);
      const canTogglePin = cmd.trim().length > 0;

      // 更新置顶按钮状态
      const updatePinButtonState = () => {
        if (!canTogglePin) return;
        const menuKey = `${menuId}:${cmd}`;
        const stats = this.menuUsageStats[menuKey];
        const currentPinned = typeof stats?.pinned === "boolean" ? stats.pinned : !!it.pinned || isDefaultPinned;

        if (currentPinned) {
          pinBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6l1 1 1-1v-6h5v-2l-2-2z"/>
            </svg>
          `;
          pinBtn.style.color = "var(--accent, #007acc)";
        } else {
          pinBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6l1 1 1-1v-6h5v-2l-2-2z" fill="none" stroke="currentColor" stroke-width="2"/>
            </svg>
          `;
          pinBtn.style.color = "var(--fg, #333)";
        }
      };

      updatePinButtonState();

      // 鼠标悬停时显示置顶按钮
      row.addEventListener("mouseenter", () => {
        pinBtn.style.opacity = canTogglePin ? "1" : "0";
      });
      row.addEventListener("mouseleave", () => {
        pinBtn.style.opacity = "0";
      });

      // 置顶/取消置顶点击事件
      pinBtn.addEventListener("click", (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();

        if (!canTogglePin) {
          return;
        }

        const menuKey = `${menuId}:${cmd}`;

        if (!this.menuUsageStats[menuKey]) {
          this.menuUsageStats[menuKey] = {
            clickCount: 0,
            lastClickTime: 0,
            pinned: !!it.pinned || isDefaultPinned
          };
        }

        // 切换置顶状态
        this.menuUsageStats[menuKey].pinned = !this.menuUsageStats[menuKey].pinned;

        // 如果置顶，计算一个合适的 order（放在现有置顶项的最后）
        if (this.menuUsageStats[menuKey].pinned) {
          // 找出当前所有置顶项的最大 customOrder
          let maxOrder = -1;
          for (const key in this.menuUsageStats) {
            const stats = this.menuUsageStats[key];
            if (stats.pinned && typeof stats.customOrder === 'number') {
              maxOrder = Math.max(maxOrder, stats.customOrder);
            }
          }
          // 新置顶项放在最后
          this.menuUsageStats[menuKey].customOrder = maxOrder + 10;
        }

        // 保存到 localStorage
        (this as any).saveMenuUsageStats();

        // 重新渲染菜单
        const sorted = this.sortMenuItems(items, menuId);
        menu.innerHTML = "";
        this.rebuildMenuItems(menu, sorted, closeMenu, sorted, menuId, ctx);
      });

      // 防止置顶按钮触发菜单点击
      pinBtn.addEventListener("mousedown", (e: MouseEvent) => {
        e.stopPropagation();
      });

      row.appendChild(pinBtn);

      menu.appendChild(row);
    }

    return menu;
  }

  // 重新构建菜单项（用于拖拽后刷新）
  private rebuildMenuItems(menu: HTMLDivElement, items: MenuItem[], closeMenu: () => void, filtered: MenuItem[], menuId: string = "editor/context", ctx?: { panelId?: string | null; editor?: IEditorProxy | null; sessionId?: string | null }): void {
    const isPinnedItem = (item: MenuItem) => {
      const cmd = item.command || "";
      if (!cmd) return false;
      const menuKey = `${menuId}:${cmd}`;
      const stats = this.menuUsageStats[menuKey];
      if (typeof stats?.pinned === "boolean") return stats.pinned;
      return !!item.pinned || this.DEFAULT_PINNED_COMMANDS.includes(cmd);
    };

    let pinnedCount = 0;
    for (const it of filtered) {
      if (!isPinnedItem(it)) break;
      pinnedCount++;
    }

    const dragAreaSeparator =
      pinnedCount > 0 && pinnedCount < filtered.length ? document.createElement("div") : null;
    if (dragAreaSeparator) {
      dragAreaSeparator.className = "zion-drag-area-separator";
    }
    let activeDropTarget: HTMLElement | null = null;

    for (let i = 0; i < filtered.length; i++) {
      const it = filtered[i];

      if (dragAreaSeparator && i === pinnedCount) {
        menu.appendChild(dragAreaSeparator);
      }

      const row = document.createElement("div");
      const hasKids = !!it.submenu && Array.isArray(it.submenu) && it.submenu.length > 0;
      row.className = hasKids ? "zion-context-menu-row has-submenu" : "zion-context-menu-row";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "zion-context-menu-item";
      const span = document.createElement("span");
        let title = it.title || it.command || "";
      // 支持动态标题
      if (typeof it.dynamicTitle === "function") {
        try {
          const dt = it.dynamicTitle();
            if (dt !== null) title = dt;
        } catch {}
      }
        span.className = "zion-context-menu-label";
        const primary = document.createElement("span");
        primary.className = "zion-context-menu-label-primary";
        primary.textContent = title;
        span.appendChild(primary);
        if (it.subtitle) {
          const secondary = document.createElement("span");
          secondary.className = "zion-context-menu-label-secondary";
          secondary.textContent = it.subtitle;
          span.appendChild(secondary);
        }
        span.title = [title, it.subtitle].filter(Boolean).join(" · ");
      btn.appendChild(span);
      btn.setAttribute("role", "menuitem");

      if (hasKids) {
        // 为二级菜单生成唯一的 menuId，避免与一级菜单的 menuKey 冲突
        const subMenuId = `${menuId}:${it.command || 'submenu'}`;
        const submenu = this.buildContextMenuPanel(it.submenu || [], closeMenu, subMenuId, ctx);
        submenu.classList.add("zion-context-submenu");
        submenu.style.position = "fixed";
        submenu.style.display = "none";
        (submenu as any).dataset.menuId = subMenuId;
        row.appendChild(submenu);
      } else {
        btn.onclick = () => {
          const cmd = it.command;
          if (!cmd) return;
          try {
            if (ctx?.panelId || ctx?.editor || ctx?.sessionId) this.executeCommand(cmd, { panelId: ctx?.panelId || null, editor: ctx?.editor || null, sessionId: ctx?.sessionId || null });
            else this.executeCommand(cmd);
            // 记录点击统计
            const menuKey = `${menuId}:${cmd}`;
            if (this.menuUsageStats[menuKey]) {
              this.menuUsageStats[menuKey].clickCount++;
              this.menuUsageStats[menuKey].lastClickTime = Date.now();
              // 保存统计信息
              (this as any).saveMenuUsageStats();
            }
          } finally {
            closeMenu();
          }
        };
      }

      row.appendChild(btn);

      // 添加拖拽手柄（仅对置顶区域）
      const isPinned = isPinnedItem(it);
      if (isPinned) {
        row.classList.add("has-drag-zone");

        // 创建左侧拖拽区域
        const dragZone = document.createElement("div");
        dragZone.className = "zion-drag-zone";

        // 添加拖拽图标
        const dragIcon = document.createElement("div");
        dragIcon.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="3" cy="2" r="1.5" fill="currentColor"/>
            <circle cx="9" cy="2" r="1.5" fill="currentColor"/>
            <circle cx="3" cy="6" r="1.5" fill="currentColor"/>
            <circle cx="9" cy="6" r="1.5" fill="currentColor"/>
            <circle cx="3" cy="10" r="1.5" fill="currentColor"/>
            <circle cx="9" cy="10" r="1.5" fill="currentColor"/>
          </svg>
        `;
        dragZone.appendChild(dragIcon);

        // 拖拽事件
        row.setAttribute("draggable", "true");
        row.dataset.menuIndex = String(i);
        row.dataset.command = it.command || '';

        // 防止点击按钮时触发拖拽
        btn.addEventListener("mousedown", () => {
          row.setAttribute("draggable", "false");
        });
        btn.addEventListener("mouseup", () => {
          row.setAttribute("draggable", "true");
        });

        row.addEventListener("dragstart", (e: DragEvent) => {
          e.stopPropagation();
          row.classList.add("is-dragging");
          dragZone.style.cursor = "grabbing";
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            const dragToken = it.command ? `cmd:${it.command}` : `idx:${i}`;
            e.dataTransfer.setData("text/plain", dragToken);
            // 创建自定义拖拽图像，避免浏览器默认的半透明效果
            const dragImage = row.cloneNode(true) as HTMLElement;
            dragImage.style.position = "absolute";
            dragImage.style.top = "-1000px";
            dragImage.style.left = "-1000px";
            dragImage.style.opacity = "1";
            dragImage.style.pointerEvents = "none";
            dragImage.classList.remove("is-dragging");
            document.body.appendChild(dragImage);
            e.dataTransfer.setDragImage(dragImage, 0, 0);
            // 延迟移除，确保拖拽图像已被使用
            setTimeout(() => dragImage.remove(), 0);
          }
        });

        row.addEventListener("dragend", () => {
          row.classList.remove("is-dragging");
          dragZone.style.cursor = "grab";
          if (activeDropTarget) {
            activeDropTarget.classList.remove("is-drop-target", "drop-before", "drop-after");
            activeDropTarget = null;
          }
        });

        row.addEventListener("dragover", (e: DragEvent) => {
          e.preventDefault();
          const targetRow = e.currentTarget as HTMLElement;
          const rect = targetRow.getBoundingClientRect();
          const before = e.clientY < rect.top + rect.height / 2;
          targetRow.classList.add("is-drop-target");
          targetRow.classList.toggle("drop-before", before);
          targetRow.classList.toggle("drop-after", !before);
          if (activeDropTarget && activeDropTarget !== targetRow) {
            activeDropTarget.classList.remove("is-drop-target", "drop-before", "drop-after");
          }
          activeDropTarget = targetRow;
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = "move";
          }
        });

        row.addEventListener("dragenter", (e: DragEvent) => {
          const targetRow = (e.currentTarget as HTMLElement);
          if (!targetRow.querySelector(".zion-drag-zone")) return;
          if (activeDropTarget && activeDropTarget !== targetRow) {
            activeDropTarget.classList.remove("is-drop-target", "drop-before", "drop-after");
          }
          activeDropTarget = targetRow;
          targetRow.classList.add("is-drop-target");
        });

        row.addEventListener("dragleave", (e: DragEvent) => {
          const targetRow = (e.currentTarget as HTMLElement);
          const rt = (e as any).relatedTarget as Node | null;
          if (rt && targetRow.contains(rt)) return;
          targetRow.classList.remove("is-drop-target", "drop-before", "drop-after");
          if (activeDropTarget === targetRow) activeDropTarget = null;
        });

        row.addEventListener("drop", (e: DragEvent) => {
          e.stopPropagation();
          e.preventDefault();
          const targetRow = (e.currentTarget as HTMLElement);
          const dropAfter = targetRow.classList.contains("drop-after");
          targetRow.classList.remove("is-drop-target", "drop-before", "drop-after");
          if (activeDropTarget === targetRow) activeDropTarget = null;

          const dragToken = e.dataTransfer?.getData("text/plain") || "";
          let fromIndex = -1;
          if (dragToken.startsWith("cmd:")) {
            const fromCommand = dragToken.slice(4);
            fromIndex = filtered.findIndex(item => item.command === fromCommand);
          } else if (dragToken.startsWith("idx:")) {
            fromIndex = parseInt(dragToken.slice(4));
          } else {
            fromIndex = filtered.findIndex(item => item.command === dragToken);
          }
          const toIndex = i;
          let insertIndex = toIndex + (dropAfter ? 1 : 0);
          if (insertIndex > pinnedCount) insertIndex = pinnedCount;

          if (
            fromIndex >= 0 &&
            fromIndex < pinnedCount &&
            fromIndex !== toIndex &&
            toIndex < pinnedCount &&
            isPinnedItem(filtered[fromIndex])
          ) {
            const moved = filtered[fromIndex];
            filtered.splice(fromIndex, 1);
            if (fromIndex < insertIndex) insertIndex--;
            filtered.splice(insertIndex, 0, moved);

            // 更新 customOrder
            for (let j = 0; j < pinnedCount; j++) {
              const item = filtered[j];
              if (item.command) {
                const menuKey = `${menuId}:${item.command}`;
                if (this.menuUsageStats[menuKey]) {
                  this.menuUsageStats[menuKey].customOrder = j * 10;
                  this.menuUsageStats[menuKey].pinned = true;
                }
              }
            }

            // 保存到 localStorage
            (this as any).saveMenuUsageStats();

            // 重新渲染菜单
            menu.innerHTML = "";
            this.rebuildMenuItems(menu, items, closeMenu, filtered, menuId);
          }
        });

        row.insertBefore(dragZone, btn);
      }

      // 为每个菜单项添加置顶/取消置顶按钮
      const pinBtn = document.createElement("button");
      pinBtn.className = "zion-pin-button";
      pinBtn.type = "button";

      const cmd = it.command || "";
      const isDefaultPinned = this.DEFAULT_PINNED_COMMANDS.includes(cmd);
      const canTogglePin = cmd.trim().length > 0;

      // 更新置顶按钮状态
      const updatePinButtonState = () => {
        if (!canTogglePin) return;
        const menuKey = `${menuId}:${cmd}`;
        const stats = this.menuUsageStats[menuKey];
        const currentPinned = typeof stats?.pinned === "boolean" ? stats.pinned : !!it.pinned || isDefaultPinned;

        if (currentPinned) {
          pinBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6l1 1 1-1v-6h5v-2l-2-2z"/>
            </svg>
          `;
          pinBtn.style.color = "var(--accent, #007acc)";
        } else {
          pinBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6l1 1 1-1v-6h5v-2l-2-2z" fill="none" stroke="currentColor" stroke-width="2"/>
            </svg>
          `;
          pinBtn.style.color = "var(--fg, #333)";
        }
      };

      updatePinButtonState();

      // 鼠标悬停时显示置顶按钮
      row.addEventListener("mouseenter", () => {
        pinBtn.style.opacity = canTogglePin ? "1" : "0";
      });
      row.addEventListener("mouseleave", () => {
        pinBtn.style.opacity = "0";
      });

      // 置顶/取消置顶点击事件
      pinBtn.addEventListener("click", (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();

        if (!canTogglePin) {
          return;
        }

        const menuKey = `${menuId}:${cmd}`;

        if (!this.menuUsageStats[menuKey]) {
          this.menuUsageStats[menuKey] = {
            clickCount: 0,
            lastClickTime: 0,
            pinned: !!it.pinned || isDefaultPinned
          };
        }

        // 切换置顶状态
        this.menuUsageStats[menuKey].pinned = !this.menuUsageStats[menuKey].pinned;

        // 如果置顶，计算一个合适的 order（放在现有置顶项的最后）
        if (this.menuUsageStats[menuKey].pinned) {
          // 找出当前所有置顶项的最大 customOrder
          let maxOrder = -1;
          for (const key in this.menuUsageStats) {
            const stats = this.menuUsageStats[key];
            if (stats.pinned && typeof stats.customOrder === 'number') {
              maxOrder = Math.max(maxOrder, stats.customOrder);
            }
          }
          // 新置顶项放在最后
          this.menuUsageStats[menuKey].customOrder = maxOrder + 10;
        }

        // 保存到 localStorage
        (this as any).saveMenuUsageStats();

        // 重新渲染菜单
        const sorted = this.sortMenuItems(filtered, menuId);
        menu.innerHTML = "";
        this.rebuildMenuItems(menu, sorted, closeMenu, sorted, menuId);
      });

      // 防止置顶按钮触发菜单点击
      pinBtn.addEventListener("mousedown", (e: MouseEvent) => {
        e.stopPropagation();
      });

      row.appendChild(pinBtn);

      menu.appendChild(row);
    }
  }

  private showEditorContextMenuAt(x: number, y: number, panelId?: string) {
    const targetPanelId = panelId && this.editorCores.has(panelId) ? panelId : this.activePanelId;
    const active = targetPanelId ? (this.editorCores.get(targetPanelId) || null) : this.getActiveEditorCore();
    if (!active) return;
    const dom = active.view.dom;
    const items = this.menus["editor/context"] || [];
    if (items.length === 0) return;

    const hasSelection =
      active.view.state.selection.main.from !== active.view.state.selection.main.to;
    const editorFocus = document.activeElement ? dom.contains(document.activeElement) : false;

    const filtered = this.filterMenuTree(items, { hasSelection, editorFocus });
    if (filtered.length === 0) return;
    const targetEditor = targetPanelId ? (this.editorProxies.get(targetPanelId) || null) : this.getActiveEditorProxy();
    const targetSessionId = targetEditor?.sessionId || active.getSessionId?.() || null;

    // 应用排序
    const sorted = this.sortMenuItems(filtered, "editor/context");

    if (this.contextMenuEl) {
      try {
        this.contextMenuEl.remove();
      } catch {}
      this.contextMenuEl = null;
    }

    const escHandler = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") closeMenu();
    };

    const closeMenu = () => {
      if (this.contextMenuEl && this.contextMenuEl.parentNode) {
        this.contextMenuEl.parentNode.removeChild(this.contextMenuEl);
      }
      this.contextMenuEl = null;
      document.removeEventListener("click", closeMenu);
      document.removeEventListener("keydown", escHandler);
    };

    const menu = this.buildContextMenuPanel(sorted, closeMenu, "editor/context", {
      panelId: targetPanelId || null,
      editor: targetEditor as unknown as IEditorProxy | null,
      sessionId: targetSessionId
    });
    menu.style.position = "fixed";
    menu.style.zIndex = "99999";

    document.body.appendChild(menu);
    this.contextMenuEl = menu;

    this.positionMenuInViewport(menu, x, y);
    document.addEventListener("click", closeMenu, { once: true });
    document.addEventListener("keydown", escHandler);
  }

  private showMenuAt(menuId: string, x: number, y: number) {
    if (!this.editorCore) {
      console.warn("[zion] showMenuAt: editor not attached");
      return;
    }
    if (menuId !== "editor/context") {
      console.warn("[zion] showMenuAt: unsupported menuId", menuId);
      return;
    }
    this.showEditorContextMenuAt(x, y);
  }

  private applyDecorators(panelId?: string) {
    const targetPanelIds = panelId ? [panelId] : [...this.editorProxies.keys()];
    for (const pid of targetPanelIds) {
      const editor = this.editorProxies.get(pid) || null;
      if (!editor) continue;
      const editorKey = editor.editorId || pid;
      for (const dec of this.decorators) {
        const key = `${dec.id}:${editorKey}`;
        if (this.decoratorDisposables.has(key)) continue;
        try {
          const disp = dec.apply(editor as unknown as IEditorProxy);
          this.decoratorDisposables.set(key, disp);
        } catch (e) {
          console.error("[zion] decorator apply error:", dec.id, e);
        }
      }
    }
  }

  private stabilizeItemWidth(store: Map<string, number>, id: string, el: HTMLElement) {
    requestAnimationFrame(() => {
      try {
        const w = Math.ceil(el.getBoundingClientRect().width || 0);
        const prev = store.get(id) || 0;
        const next = Math.max(prev, w);
        if (next > 0) {
          store.set(id, next);
          (el as any).style.minWidth = `${next}px`;
        }
      } catch {}
    });
  }

  registerPasteHandler(handler: PasteHandler): Disposable {
    this.pasteHandlers.push(handler);
    // no need to sort now; sort on dispatch
    return {
      dispose: () => {
        const idx = this.pasteHandlers.indexOf(handler);
        if (idx >= 0) this.pasteHandlers.splice(idx, 1);
      }
    };
  }

  registerMenu(menuId: string, item: MenuItem): Disposable {
    if (!this.menus[menuId]) this.menus[menuId] = [];
    this.menus[menuId].push(item);

    // 生成菜单项的唯一键（基于 menuId 和 command）
    const menuKey = `${menuId}:${item.command || ''}`;
    const cmd = item.command || '';
    const isDefaultPinned = this.DEFAULT_PINNED_COMMANDS.includes(cmd);

    // 初始化使用统计
    if (!this.menuUsageStats[menuKey]) {
      // 计算初始 customOrder
      let initialOrder = item.order;
      if (initialOrder === undefined && isDefaultPinned) {
        // 默认置顶的命令按照 DEFAULT_PINNED_COMMANDS 中的顺序设置 order
        const defaultIndex = this.DEFAULT_PINNED_COMMANDS.indexOf(cmd);
        initialOrder = defaultIndex * 10;
      }

      this.menuUsageStats[menuKey] = {
        clickCount: 0,
        lastClickTime: 0,
        pinned: item.pinned || isDefaultPinned,
        customOrder: initialOrder,
        groupId: item.group
      };
    } else {
      // 更新现有统计信息
      if (item.pinned !== undefined) {
        this.menuUsageStats[menuKey].pinned = item.pinned;
      }
      if (item.order !== undefined) {
        this.menuUsageStats[menuKey].customOrder = item.order;
      }
      if (item.group !== undefined) {
        this.menuUsageStats[menuKey].groupId = item.group;
      }
    }

    return {
      dispose: () => {
        const arr = this.menus[menuId];
        if (!arr) return;
        const idx = arr.indexOf(item);
        if (idx >= 0) arr.splice(idx, 1);
        // 删除统计信息
        delete this.menuUsageStats[menuKey];
      }
    };
  }

  registerDecorator(dec: Decorator): Disposable {
    this.decorators.push(dec);
    // if editor already attached, apply immediately
    this.applyDecorators();
    return {
      dispose: () => {
        const idx = this.decorators.indexOf(dec);
        if (idx >= 0) this.decorators.splice(idx, 1);
        for (const [key, disp] of Array.from(this.decoratorDisposables.entries())) {
          if (!key.startsWith(`${dec.id}:`)) continue;
          try { disp?.dispose?.(); } catch {}
          this.decoratorDisposables.delete(key);
        }
      }
    };
  }

  registerMessageContributor(contrib: MessageContributor): Disposable {
    this.messageContribs.push(contrib);
    return {
      dispose: () => {
        const i = this.messageContribs.indexOf(contrib);
        if (i >= 0) this.messageContribs.splice(i, 1);
      }
    };
  }

  // 对菜单项进行排序
  private sortMenuItems(items: MenuItem[], menuId: string): MenuItem[] {
    const itemsWithStats = items.map((item, index) => {
      const cmd = item.command || "";
      const menuKey = `${menuId}:${cmd}`;

      const isDefaultPinned = this.DEFAULT_PINNED_COMMANDS.includes(cmd);
      const stats = this.menuUsageStats[menuKey] || {
        clickCount: 0,
        lastClickTime: 0,
        pinned: undefined,
        customOrder: item.order,
        groupId: item.group
      };

      const pinned =
        typeof (stats as any).pinned === "boolean" ? (stats as any).pinned : !!item.pinned || isDefaultPinned;

      return {
        ...item,
        ...stats,
        pinned,
        isDefaultPinned,
        originalIndex: index
      };
    });

    // 排序函数
    const compare = (a: any, b: any) => {
      // 置顶的命令在前面
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;

      // 都是置顶的，统一按照 customOrder 排序
      if (a.pinned && b.pinned) {
        const aOrder = a.customOrder ?? 50;
        const bOrder = b.customOrder ?? 50;
        if (aOrder !== bOrder) return aOrder - bOrder;
      }

      // 都没有置顶，按照自定义order排序
      const aOrder = a.customOrder ?? 50;
      const bOrder = b.customOrder ?? 50;
      if (aOrder !== bOrder) return aOrder - bOrder;

      // 最后按照原始索引排序
      return a.originalIndex - b.originalIndex;
    };

    return itemsWithStats.sort(compare).map(({ clickCount, lastClickTime, isDefaultPinned, originalIndex, ...item }) => item);
  }

  // models: provider registry (placeholder)
  registerModelProvider(provider: {
    id: string;
    list: () => any | Promise<any>;
    resolve: (id: string) => any | Promise<any>;
    checkAvailability?: (options?: { modelIds?: string[]; force?: boolean }) => any | Promise<any>;
  }): Disposable {
    this.modelProviders.push(provider);
    return {
      dispose: () => {
        const i = this.modelProviders.indexOf(provider);
        if (i >= 0) this.modelProviders.splice(i, 1);
      }
    };
  }
  listModelProviders(): string[] {
    return this.modelProviders.map(p => p.id);
  }
  getModelProvider(id: string) {
    return this.modelProviders.find(p => p.id === id) || null;
  }

  async runMessageContributors(messages: any[], stage: "pre" | "post" = "pre", runCtx: any = {}): Promise<any[]> {
    const excludedContributorIds = new Set(
      Array.isArray(runCtx?.excludedContributorIds)
        ? runCtx.excludedContributorIds.map(String)
        : []
    );
    const contribs = [...this.messageContribs]
      .filter(c => (c.stage ?? "pre") === stage)
      .filter(c => !excludedContributorIds.has(String(c.id || "")))
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));

    const ctx = {
      editor: (runCtx?.editor ?? (window as any).zion?.window?.activeEditor ?? null) as IEditorProxy | null,
      sessionId: runCtx?.sessionId ?? null,
      panelId: runCtx?.panelId ?? null,
      requestSource: runCtx?.requestSource ?? null,
      runId: runCtx?.runId ?? null,
      state: {
        get: <T,>(key: string) => this.state.get<T>(key),
        set: <T,>(key: string, v: T) => this.state.set<T>(key, v)
      },
      events: {
        emit: (topic: string, payload?: any) => this.events.emit(topic, payload),
        on: (topic: string, h: (p: any) => void) => this.events.on(topic, h)
      }
    };

    let out = messages;
    for (const c of contribs) {
      try {
        // eslint-disable-next-line no-await-in-loop
        out = await c.contribute(out, ctx);
      } catch (e) {
        console.error("[zion] message contributor error:", c.id, e);
      }
    }
    return out;
  }

  registerCommand(id: string, fn: CommandHandler): Disposable {
    if (this.commands.has(id)) {
      console.warn("[zion] overwrite command", id);
    }
    this.commands.set(id, fn);
    return { dispose: () => this.commands.delete(id) };
  }

  listCommands(): string[] {
    return Array.from(this.commands.keys());
  }

  executeCommand<T = any>(id: string, ...args: any[]): T | undefined {
    const fn = this.commands.get(id);
    if (!fn) {
      console.warn("[zion] command not found:", id);
      return undefined;
    }
    try {
      return fn(...args) as T;
    } catch (e) {
      console.error("[zion] command error:", id, e);
      return undefined;
    }
  }

  registerKeybinding(binding: Keybinding): Disposable {
    this.keybindings.push(binding);
    try {
      this.applyKeymap();
    } catch (error) {
      const idx = this.keybindings.indexOf(binding);
      if (idx >= 0) this.keybindings.splice(idx, 1);
      try { this.applyKeymap(); } catch {}
      console.error("[registry] register keybinding failed:", binding, error);
      throw error;
    }
    return {
      dispose: () => {
        const idx = this.keybindings.indexOf(binding);
        if (idx >= 0) {
          this.keybindings.splice(idx, 1);
          this.applyKeymap();
        }
      }
    };
  }

  listKeybindings(): Keybinding[] {
    return [...this.keybindings];
  }

  private applyKeymap() {
    const bindings = this.keybindings.map(kb => ({
      key: kb.key,
      run: () => {
        // evaluate simple 'when' conditions
        const active = this.getActiveEditorCore();
        if (!active) return false;
        const dom = active.view.dom;
        const hasSelection =
          active.view.state.selection.main.from !== active.view.state.selection.main.to;
        const editorFocus = dom.contains(document.activeElement);

        // Determine if the custom search panel is visible and focused.
        const searchPanelEl = document.querySelector('.search-replace-panel') as HTMLElement | null;
        const searchReplaceVisible = !!searchPanelEl && searchPanelEl.style.display !== 'none';
        const searchPanelFocused = searchPanelEl ? searchPanelEl.contains(document.activeElement) : false;

        if (kb.when === "hasSelection" && !hasSelection) return false;
        if (kb.when === "editorFocus" && !editorFocus) return false;
        // Only trigger searchReplaceVisible bindings when the search panel currently has focus.
        if (kb.when === "searchReplaceVisible" && !searchPanelFocused) return false;

        const result = this.executeCommand(kb.command);
        try {
          if (localStorage.getItem("zion.debug.keybindings") === "1") {
            console.debug("[zion:keybinding]", {
              key: kb.key,
              command: kb.command,
              when: kb.when || "",
              editorFocus,
              hasSelection,
              result
            });
          }
        } catch {}
        return true;
      }
    }));
    for (const core of this.editorCores.values()) {
      core.updateKeymap(bindings);
    }
  }

  // events
  on(topic: string, handler: (payload: any) => void): Disposable {
    return this.events.on(topic, handler);
  }
  emit(topic: string, payload?: any): void {
    this.events.emit(topic, payload);
  }

  // state
  getState<T>(key: string): T | undefined {
    return this.state.get<T>(key);
  }
  setState<T>(key: string, value: T): void {
    this.state.set<T>(key, value);
  }
  updateState<T>(key: string, updater: (oldVal: T | undefined) => T): void {
    this.state.update<T>(key, updater);
  }
  onStateChange<T>(
    key: string,
    handler: (nv: T | undefined, ov: T | undefined) => void
  ): Disposable {
    return this.state.onDidChange<T>(key, handler);
  }

  constructor() {
    this.loadStatusPinned();
  }

  private loadStatusPinned() {
    try {
      const raw = localStorage.getItem(this.STATUS_PINNED_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          this.statusPinned = new Set(arr);
        }
      }
    } catch (e) {
      console.error('[registry] load status pinned error:', e);
    }
  }

  private saveStatusPinned() {
    try {
      localStorage.setItem(this.STATUS_PINNED_KEY, JSON.stringify(Array.from(this.statusPinned)));
    } catch (e) {
      console.error('[registry] save status pinned error:', e);
    }
  }

  // statusbar
  private renderStatusText(target: HTMLElement, text: string) {
    target.textContent = "";
    target.className = "";

    const value = String(text ?? "");
    const iconOnly = value.match(/^\$\(([^)]+)\)$/);
    if (iconOnly) {
      target.appendChild(createZionIcon(zionIconName(iconOnly[1])));
      return;
    }

    const inlineIcon = value.match(/^\$\(([^)]+)\)\s*(.*)$/);
    if (inlineIcon) {
      target.appendChild(createZionIcon(zionIconName(inlineIcon[1])));
      const label = String(inlineIcon[2] || "").trim();
      if (label) {
        const labelSpan = document.createElement("span");
        labelSpan.className = "status-item-label";
        labelSpan.textContent = label;
        target.appendChild(labelSpan);
      }
      return;
    }

    if (hasZionIcon(value)) {
      target.appendChild(createZionIcon(zionIconName(value)));
      return;
    }

    target.textContent = value;
  }

  registerStatusItem(opts: { id: string; text: string; tooltip?: string; onClick?: () => void; priority?: number; align?: "left" | "right" }): Disposable {
    const bar = document.getElementById("statusbar");
    if (!bar) return { dispose: () => {} };
    const left = document.getElementById("statusbar-left") ?? bar;
    const right = document.getElementById("statusbar-right") ?? bar;
    const align = opts.align ?? "left";
    const target = align === "right" ? right : left;

    const priority = opts.priority ?? 0;
    const pinned = this.statusPinned.has(opts.id);

    const existing = this.statusItems.get(opts.id);
    if (existing) {
      existing.el.setAttribute("data-zion-status-id", opts.id);
      // Update in place without clearing innerHTML to preserve hover state and reduce flicker
      const textSpan = existing.el.querySelector("span:not(.status-pin-btn)");
      if (textSpan) {
        this.renderStatusText(textSpan as HTMLElement, opts.text);
      } else {
        const span = document.createElement("span");
        this.renderStatusText(span, opts.text);
        if (existing.el.firstChild) {
          existing.el.insertBefore(span, existing.el.firstChild);
        } else {
          existing.el.appendChild(span);
        }
      }
      
      const tooltipBase = typeof opts.tooltip === "string" ? opts.tooltip : "";
      const tooltip = (tooltipBase ? tooltipBase + "\n" : "") + "Right-click to " + (pinned ? "Unpin" : "Pin");
      existing.el.title = tooltip;
      
      // Re-bind click
      existing.el.onclick = (e) => {
        if (opts.onClick) opts.onClick();
      };
      existing.el.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleStatusPin(opts.id);
      };

      existing.onClick = opts.onClick;
      existing.pinned = pinned;
      const prevAlign = existing.align;
      existing.align = align;
      if (prevAlign !== align) {
        target.appendChild(existing.el);
        const prevBar = prevAlign === "right" ? right : left;
        this.sortStatusItems(prevBar, prevAlign);
      }

      // Remove pin button if exists (migration)
      const pinBtn = existing.el.querySelector(".status-pin-btn");
      if (pinBtn) pinBtn.remove();

      // Update priority and re-sort if changed
      if (existing.priority !== priority) {
        existing.priority = priority;
        this.sortStatusItems(target, align);
      } else {
        this.sortStatusItems(target, align);
      }
      this.stabilizeItemWidth(this.statusItemMinWidth, opts.id, existing.el);

      return {
        dispose: () => {
          const item = this.statusItems.get(opts.id);
          if (!item) return;
          item.el.remove();
          this.statusItems.delete(opts.id);
        }
      };
    }

    const el = document.createElement("button");
    el.className = "status-item";
    el.setAttribute("data-zion-status-id", opts.id);
    if (pinned) {
      el.classList.add('pinned');
    }
    
    const span = document.createElement("span");
    this.renderStatusText(span, opts.text);
    el.appendChild(span);

    // No dedicated pin button - use Context Menu
    
    const tooltipBase = typeof opts.tooltip === "string" ? opts.tooltip : "";
    const tooltip = (tooltipBase ? tooltipBase + "\n" : "") + "Right-click to " + (pinned ? "Unpin" : "Pin");
    el.title = tooltip;
    
    el.onclick = (e) => {
      if (opts.onClick) opts.onClick();
    };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleStatusPin(opts.id);
    };
    
    target.appendChild(el);
    this.statusItems.set(opts.id, { id: opts.id, el, onClick: opts.onClick, priority, pinned, align });
    this.sortStatusItems(target, align);
    this.stabilizeItemWidth(this.statusItemMinWidth, opts.id, el);

    return {
      dispose: () => {
        const item = this.statusItems.get(opts.id);
        if (!item) return;
        item.el.remove();
        this.statusItems.delete(opts.id);
      }
    };
  }

  // bottombar
  registerBottomStatusItem(opts: { id: string; text: string; tooltip?: string; onClick?: () => void; priority?: number }): Disposable {
    const bar = document.getElementById("bottombar");
    if (!bar) return { dispose: () => {} };
    const target = this.getBottomStatusContainer(bar);

    const priority = opts.priority ?? 0;
    const existing = this.bottomStatusItems.get(opts.id);
    if (existing) {
      existing.el.classList.add("bottombar-status-item");
      existing.el.classList.remove("pinned");
      existing.el.setAttribute("data-zion-status-id", opts.id);
      const textSpan = existing.el.querySelector("span:not(.status-pin-btn)");
      if (textSpan) {
        this.renderStatusText(textSpan as HTMLElement, opts.text);
      } else {
        const span = document.createElement("span");
        this.renderStatusText(span, opts.text);
        if (existing.el.firstChild) {
          existing.el.insertBefore(span, existing.el.firstChild as any);
        } else {
          existing.el.appendChild(span);
        }
      }

      existing.el.title = typeof opts.tooltip === "string" ? opts.tooltip : "";
      existing.el.style.minWidth = "";

      existing.el.onclick = (e) => { if (opts.onClick) opts.onClick(); };
      existing.el.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };

      existing.onClick = opts.onClick;

      const pinBtn = existing.el.querySelector(".status-pin-btn");
      if (pinBtn) (pinBtn as any).remove();

      if (existing.priority !== priority) {
        existing.priority = priority;
        this.sortBottomStatusItems(target);
      } else {
        this.sortBottomStatusItems(target);
      }

      return {
        dispose: () => {
          const item = this.bottomStatusItems.get(opts.id);
          if (!item) return;
          item.el.remove();
          this.bottomStatusItems.delete(opts.id);
        }
      };
    }

    const el = document.createElement("button");
    el.className = "status-item bottombar-status-item";
    el.setAttribute("data-zion-status-id", opts.id);

    const span = document.createElement("span");
    this.renderStatusText(span, opts.text);
    el.appendChild(span);

    el.title = typeof opts.tooltip === "string" ? opts.tooltip : "";

    el.onclick = (e) => { if (opts.onClick) opts.onClick(); };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };

    target.appendChild(el);
    this.bottomStatusItems.set(opts.id, { id: opts.id, el, onClick: opts.onClick, priority });
    this.sortBottomStatusItems(target);

    return {
      dispose: () => {
        const item = this.bottomStatusItems.get(opts.id);
        if (!item) return;
        item.el.remove();
        this.bottomStatusItems.delete(opts.id);
      }
    };
  }

  private getBottomStatusContainer(bar: HTMLElement): HTMLElement {
    let right = document.getElementById("bottombar-right");
    if (!right) {
      right = document.createElement("div");
      right.id = "bottombar-right";
      bar.appendChild(right);
    }
    let status = document.getElementById("bottombar-status") || document.getElementById("bottombar-left");
    if (!status) {
      status = document.createElement("div");
      status.id = "bottombar-status";
    } else {
      status.id = "bottombar-status";
    }
    const terminal = right.querySelector("[data-zion-bottombar-terminal]");
    const metrics = document.getElementById("bottombar-metrics");
    const expectedPrev =
      terminal && terminal.parentElement === right
        ? terminal
        : metrics && metrics.parentElement === right
          ? metrics
          : null;
    const anchor = expectedPrev ? expectedPrev.nextSibling : right.firstChild;
    if (status.parentElement !== right || status.previousElementSibling !== expectedPrev) {
      right.insertBefore(status, anchor);
    }
    return status;
  }

  private sortBottomStatusItems(container: HTMLElement) {
    const items = Array.from(this.bottomStatusItems.values());
    items.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.id.localeCompare(b.id);
    });
    items.forEach(item => container.appendChild(item.el));
  }

  private getStatusBarContainer(align: "left" | "right"): HTMLElement | null {
    const bar = document.getElementById("statusbar");
    if (!bar) return null;
    const left = document.getElementById("statusbar-left") ?? bar;
    const right = document.getElementById("statusbar-right") ?? bar;
    return align === "right" ? right : left;
  }

  private toggleStatusPin(id: string) {
    const item = this.statusItems.get(id);
    if (!item) return;

    if (this.statusPinned.has(id)) {
      this.statusPinned.delete(id);
      item.pinned = false;
      item.el.classList.remove('pinned');
    } else {
      this.statusPinned.add(id);
      item.pinned = true;
      item.el.classList.add('pinned');
    }
    
    // Update tooltip
    // Need to reconstruct the original tooltip base
    // We don't store the raw tooltipBase in 'item', so let's try to extract it or just keep it simple
    // Actually, 'item' object in map has what properties? { id, el, onClick, priority, pinned }
    // It doesn't have the original text/tooltip.
    // But since we are toggling, we can just flip the last line of the title if it matches our pattern.
    
    const currentTitle = item.el.title || "";
    const suffixPin = "\nRight-click to Pin";
    const suffixUnpin = "\nRight-click to Unpin";
    
    if (item.pinned) {
        if (currentTitle.endsWith(suffixPin)) {
            item.el.title = currentTitle.slice(0, -suffixPin.length) + suffixUnpin;
        } else if (!currentTitle.endsWith(suffixUnpin)) {
            item.el.title = currentTitle + suffixUnpin;
        }
    } else {
        if (currentTitle.endsWith(suffixUnpin)) {
            item.el.title = currentTitle.slice(0, -suffixUnpin.length) + suffixPin;
        } else if (!currentTitle.endsWith(suffixPin)) {
            item.el.title = currentTitle + suffixPin;
        }
    }

    this.saveStatusPinned();
    const container = this.getStatusBarContainer(item.align);
    if (container) this.sortStatusItems(container, item.align);
  }

  private sortStatusItems(bar: HTMLElement, align: "left" | "right") {
    const items = Array.from(this.statusItems.values()).filter(it => it.align === align);
    // Sort logic:
    // 1. Pinned items first
    // 2. Then by Priority (descending)
    // 3. Then by ID (ascending)
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.id.localeCompare(b.id);
    });
    // Re-append to DOM in order (appendChild moves existing nodes)
    items.forEach(item => bar.appendChild(item.el));
  }
  // ===== Chat Runner helpers (MVP, simulated streaming) =====

  // Read role prefixes from env/localStorage, fallback to defaults
  private __readRolePrefixes(): string[] {
    const base = ["user", "assistant", "system"];
    const out: string[] = [];
    try {
      const cfg = (window as any)?.zion?.config?.roles?.prefixes;
      if (Array.isArray(cfg)) out.push(...cfg);
    } catch {}
    try {
      const raw = localStorage.getItem("zion.roles.prefixes") || localStorage.getItem("dev.roles.prefixes");
      if (raw) {
        const j = JSON.parse(raw);
        if (Array.isArray(j)) out.push(...j);
      }
    } catch {}
    // normalize + dedupe
    const seen = new Set<string>();
    const result = [...base, ...out]
      .map(s => (typeof s === "string" ? s.trim() : ""))
      .filter(Boolean)
      .filter(s => !seen.has(s) && seen.add(s));
    return result;
  }

  // Convert document into role messages based on "role " line starts
  private __parseRoleMessages(text: string): { role: "user" | "assistant" | "system"; content: string }[] {
    const prefixes = this.__readRolePrefixes();
    const lines = (text || "").split(/\r?\n/);
    const out: { role: "user" | "assistant" | "system"; content: string }[] = [];
    let curRole: "user" | "assistant" | "system" | null = null;
    let buf: string[] = [];

    const flush = () => {
      if (curRole != null) {
        out.push({ role: curRole, content: buf.join("\n").trimEnd() });
      }
      curRole = null;
      buf = [];
    };

    for (const ln of lines) {
      const match = prefixes.find(p => ln.startsWith(p + " "));
      if (match) {
        flush();
        const role = (match as any) as "user" | "assistant" | "system";
        curRole = role;
        // skip the "role " marker on the head line; content starts after it
        const rawHead = ln.slice(match.length + 1);
        const head = role === "assistant" ? stripAssistantBlockIdComment(rawHead) : rawHead;
        buf.push(head);
      } else {
        buf.push(ln);
      }
    }
    flush();
    return out;
  }

  // Exposed via window.zion.chat.setActiveModel/getActiveModel
  private __chatSetActiveModel(m: { providerId: string; modelId: string } | null) {
    this.activeModel = m || null;
    this.state.set("chat.activeModel", this.activeModel);
  }
  private __chatGetActiveModel(): { providerId: string; modelId: string } | null {
    return this.activeModel;
  }
  private __syncGlobalStreaming(): void {
    let any = false;
    for (const [, run] of this.currentRuns) {
      if (run.timer) { any = true; break; }
    }
    this.state.set("chat.streaming", any);
  }

  // Start a chat run: parse messages, pick latest user (or selection), stream an echo response
  private __chatRun(opts?: { useSelection?: boolean; prompt?: string }): boolean {
    try {
      if (!this.editorCore) return false;
      const sessionId: string = this.state.get("sessions.currentId") || "__default__";
      if (this.currentRuns.has(sessionId)) {
        console.warn("[zion] chat already running for session", sessionId);
        return false;
      }
      const view = this.editorCore.view;
      const docText = view.state.doc.toString();

      let prompt = (opts?.prompt ?? "").trim();

      if (!prompt) {
        const sel = view.state.selection.main;
        if (opts?.useSelection && !sel.empty) {
          prompt = view.state.sliceDoc(sel.from, sel.to).trim();
        }
      }

      if (!prompt) {
        const msgs = this.__parseRoleMessages(docText);
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "user") {
            prompt = (msgs[i].content || "").trim();
            if (prompt) break;
          }
        }
      }

      if (!prompt) {
        console.warn("[zion] chat.run: no user content to run");
        return false;
      }
      this.lastPrompt = prompt;

      const response = "Echo: " + prompt;

      const runId = "run_" + Math.random().toString(36).slice(2);
      const state = view.state;
      const docLen = state.doc.length;
      const endsWithNL = docLen === 0 ? true : state.sliceDoc(docLen - 1, docLen) === "\n";
      const head = (endsWithNL ? "" : "\n") + `${assistantBlockHeaderText(runId)}\n`;
      this.editorCore.view.dispatch({ changes: { from: docLen, to: docLen, insert: head } });
      let endPos = docLen + head.length;

      this.state.set("chat.runId", runId);
      this.state.set("chat.error", null);
      this.events.emit("chat/runStarted", {
        runId,
        assistantBlockId: runId,
        model: this.activeModel,
        sessionId
      });

      const chunks: string[] = [];
      const chunkSize = 40;
      for (let i = 0; i < response.length; i += chunkSize) {
        chunks.push(response.slice(i, i + chunkSize));
      }

      let idx = 0;
      const timer = window.setInterval(() => {
        try {
          const run = this.currentRuns.get(sessionId);
          if (!run || run.id !== runId) {
            window.clearInterval(timer);
            return;
          }
          if (idx < chunks.length) {
            const piece = chunks[idx++];
            this.editorCore!.view.dispatch({ changes: { from: endPos, to: endPos, insert: piece } });
            endPos += piece.length;
            run.endPos = endPos;
            this.events.emit("chat/token", { runId, token: piece });
          } else {
            this.editorCore!.view.dispatch({ changes: { from: endPos, to: endPos, insert: "\n" } });
            window.clearInterval(run.timer);
            const finishedRunId = run.id;
            if (this.currentRuns.get(sessionId)?.id === runId) {
              this.currentRuns.delete(sessionId);
            }
            this.__syncGlobalStreaming();
            this.events.emit("chat/runFinished", { runId: finishedRunId, sessionId });
          }
        } catch (e) {
          const run = this.currentRuns.get(sessionId);
          if (run?.id === runId) {
            try { window.clearInterval(run.timer); } catch {}
            this.currentRuns.delete(sessionId);
          }
          this.__syncGlobalStreaming();
          if (run?.id !== runId) return;
          this.state.set("chat.error", (e as any)?.message || String(e));
          this.events.emit("chat/runError", { runId, error: e, sessionId });
        }
      }, 40);

      this.currentRuns.set(sessionId, { id: runId, timer, endPos });
      this.__syncGlobalStreaming();
      return true;
    } catch (e) {
      console.error("[zion] chat.run error", e);
      this.state.set("chat.error", (e as any)?.message || String(e));
      this.__syncGlobalStreaming();
      return false;
    }
  }

  private __chatStop(): void {
    try {
      const sessionId: string = this.state.get("sessions.currentId") || "__default__";
      const run = this.currentRuns.get(sessionId);
      if (!run) return;
      const runId = run.id;
      try { window.clearInterval(run.timer); } catch {}
      this.currentRuns.delete(sessionId);
      this.__syncGlobalStreaming();
      this.events.emit("chat/aborted", { runId, sessionId });
    } catch (e) {
      console.error("[zion] chat.stop error", e);
    }
  }

  private __chatRetry(): void {
    try {
      if (this.currentRuns.size > 0) {
        console.warn("[zion] chat is running; stop first");
        return;
      }
      if (!this.lastPrompt || !this.editorCore) return;
      // Re-run using last prompt; inject as selection-free run
      (this as any).__chatRun({});
    } catch (e) {
      console.error("[zion] chat.retry error", e);
    }
  }
}

const registry = new Registry();
const chatUsageStore = createChatUsageStore();
const runLedger = createRunLedger({
  emit: (topic, payload) => registry.emit(topic, payload)
});
try { runLedger.reconcileActiveRuns([], "startup"); } catch {}

// Expose window.zion API
(function expose() {
  const api = {
    commands: {
      registerCommand: (id: string, fn: CommandHandler) => registry.registerCommand(id, fn),
      executeCommand: (id: string, ...args: any) => registry.executeCommand(id, ...args),
      list: () => registry.listCommands()
    },
    keybindings: {
      register: (kb: Keybinding) => registry.registerKeybinding(kb),
      list: () => registry.listKeybindings()
    },
    menus: {
      register: (menuId: string, item: MenuItem) => (registry as any).registerMenu(menuId, item),
      show: (menuId: string, x: number, y: number) => {
        (registry as any).showMenuAt(menuId, x, y);
      }
    },
    messages: {
      registerContributor: (c: MessageContributor) => (registry as any).registerMessageContributor(c)
    },
    events: {
      emit: (topic: string, payload?: any) => registry.emit(topic, payload),
      on: (topic: string, handler: (payload: any) => void) => registry.on(topic, handler)
    },
    state: {
      get: <T,>(key: string) => registry.getState<T>(key),
      set: <T,>(key: string, v: T) => registry.setState<T>(key, v),
      update: <T,>(key: string, u: (ov: T | undefined) => T) => registry.updateState<T>(key, u),
      onDidChange: <T,>(key: string, h: (nv: T | undefined, ov: T | undefined) => void) =>
        registry.onStateChange<T>(key, h)
    },
    statusBar: {
      registerItem: (opts: { id: string; text: string; tooltip?: string; onClick?: () => void; priority?: number }) =>
        registry.registerStatusItem(opts)
    },
    bottomStatusBar: {
      registerItem: (opts: { id: string; text: string; tooltip?: string; onClick?: () => void; priority?: number }) =>
        (registry as any).registerBottomStatusItem(opts)
    },
    editor: {
      registerPasteHandler: (handler: PasteHandler) => registry.registerPasteHandler(handler),
      registerDecorator: (dec: Decorator) => (registry as any).registerDecorator(dec),
      attachEditor: (core: EditorCore, panelId?: string) => (registry as any).attachEditor(core, panelId),
      detachEditor: (panelId: string) => (registry as any).detachEditor(panelId),
      listAttachedEditorCores: () => (registry as any).listAttachedEditorCores(),
      getEditorForView: (view: EditorView) =>
        (registry as any).getEditorProxyForView(view) || inspectorRuntime.getTextEditorForView(view),
      images: {
        begin: (editor: IEditorProxy, options: any) => {
          const view = editor?.getView?.() as EditorView | undefined;
          if (!view) throw new Error("Editor view is unavailable");
          return beginImageInsertion(view, options);
        },
        complete: (editor: IEditorProxy, operationId: string, images: any[]) => {
          const view = editor?.getView?.() as EditorView | undefined;
          return view ? completeImageInsertion(view, operationId, images) : false;
        },
        fail: (editor: IEditorProxy, operationId: string, message?: string) => {
          const view = editor?.getView?.() as EditorView | undefined;
          return view ? failImageInsertion(view, operationId, message) : false;
        },
        cancel: (editor: IEditorProxy, operationId: string) => {
          const view = editor?.getView?.() as EditorView | undefined;
          return view ? cancelImageInsertion(view, operationId) : false;
        },
        showDropTarget: (
          editor: IEditorProxy,
          point: { x: number; y: number },
          options?: { count?: number; moving?: boolean }
        ) => {
          const view = editor?.getView?.() as EditorView | undefined;
          return view ? showImageDropIndicator(view, point, options) : null;
        },
        hideDropTarget: (editor: IEditorProxy) => {
          const view = editor?.getView?.() as EditorView | undefined;
          if (view) hideImageDropIndicator(view);
        }
      }
    },
    media: {
      isImageAssetUri,
      putImage: putImageAsset,
      resolveImage: resolveImageAsset,
      readImageDataUrl: readImageAssetDataUrl,
      getImageMetadata: getImageAssetMetadata
    },
    models: {
      registerProvider: (p: {
        id: string;
        list: () => any | Promise<any>;
        resolve: (id: string) => any | Promise<any>;
        checkAvailability?: (options?: { modelIds?: string[]; force?: boolean }) => any | Promise<any>;
      }) =>
        (registry as any).registerModelProvider(p),
      listProviders: () => (registry as any).listModelProviders(),
      getProvider: (id: string) => (registry as any).getModelProvider(id)
    },
    chat: {
      run: (opts?: { useSelection?: boolean }) => (registry as any).__chatRun(opts || {}),
      stop: () => (registry as any).__chatStop(),
      retry: () => (registry as any).__chatRetry(),
      setActiveModel: (m: { providerId: string; modelId: string } | null) => (registry as any).__chatSetActiveModel(m),
      getActiveModel: () => (registry as any).__chatGetActiveModel()
    },

    styles: {
      register: (id: string, css: string): Disposable => {
        const existing = document.getElementById('zion-style-' + id);
        if (existing) existing.remove();
        const style = document.createElement('style');
        style.id = 'zion-style-' + id;
        style.textContent = css;
        document.head.appendChild(style);
        return {
          dispose: () => { const el = document.getElementById('zion-style-' + id); if (el) el.remove(); }
        };
      },
      get: (id: string) => {
        try { const el = document.getElementById('zion-style-' + id); return el?.textContent || undefined; } catch { return undefined; }
      },
      list: () => Array.from(document.querySelectorAll('style[id^="zion-style-"]')).map(function(el) { return el.id.replace('zion-style-', ''); })
    },
    runs: runLedger,
    policies: {
      normalizeCapabilityPolicy,
      authorizeToolCall,
      filterToolsForPolicy
    },
    usage: chatUsageStore,
    notification: {
      show: (message: string, options?: {
        type?: 'info' | 'success' | 'warning' | 'error';
        duration?: number;
        dismissible?: boolean;
        actions?: Array<{ label: string; handler: () => void }>;
      }) => notificationManager.show(message, options)
    },
    activityBar: {
      registerItem: (opts: any) => activityBarRuntime.registerItem(opts),
      activateItem: (id: string) => activityBarRuntime.activateItem(id),
      getItems: () => activityBarRuntime.getItems(),
      show: () => activityBarRuntime.show(),
      hide: () => activityBarRuntime.hide(),
      toggle: () => activityBarRuntime.toggle()
    },
    sideBar: {
      registerView: (opts: any) => sideBarRuntime.registerView(opts),
      activateView: (id: string) => sideBarRuntime.activateView(id),
      getViews: () => sideBarRuntime.getViews(),
      show: () => sideBarRuntime.show(),
      hide: () => sideBarRuntime.hide(),
      toggle: () => sideBarRuntime.toggle(),
      setWidth: (w: number) => sideBarRuntime.setWidth(w)
    },
    auxiliaryBar: {
      registerView: (opts: any) => auxiliaryBarRuntime.registerView(opts),
      activateView: (id: string) => auxiliaryBarRuntime.activateView(id),
      closeView: (id: string) => auxiliaryBarRuntime.closeView(id),
      getViews: () => auxiliaryBarRuntime.getViews(),
      show: () => auxiliaryBarRuntime.show(),
      hide: () => auxiliaryBarRuntime.hide(),
      toggle: () => auxiliaryBarRuntime.toggle(),
      setWidth: (w: number) => auxiliaryBarRuntime.setWidth(w),
      requestTemporaryWidth: (ownerId: string, w: number) => auxiliaryBarRuntime.requestTemporaryWidth(ownerId, w),
      releaseTemporaryWidth: (ownerId: string) => auxiliaryBarRuntime.releaseTemporaryWidth(ownerId)
    },
    inspector: {
      registerRenderer: (renderer: any) => inspectorRuntime.registerRenderer(renderer),
      registerTextEditorDecorator: (decorator: any) => inspectorRuntime.registerTextEditorDecorator(decorator),
      open: (item: any) => inspectorRuntime.open(item),
      update: (id: string, patch: any) => inspectorRuntime.update(id, patch),
      close: (id: string) => inspectorRuntime.close(id),
      clearOwner: (ownerId: string) => inspectorRuntime.clearOwner(ownerId),
      activate: (id: string) => inspectorRuntime.activate(id),
      show: () => inspectorRuntime.show(),
      hide: () => inspectorRuntime.hide(),
      isVisible: () => inspectorRuntime.isVisible(),
      getItems: () => inspectorRuntime.getItems(),
      getActiveItemId: () => inspectorRuntime.getActiveItemId(),
      getTextEditor: (itemIdOrSessionId?: string) => inspectorRuntime.getTextEditor(itemIdOrSessionId),
      getTextSource: (itemIdOrSessionId?: string) => inspectorRuntime.getTextSource(itemIdOrSessionId),
      revealText: (itemId: string, options?: any) => inspectorRuntime.revealText(itemId, options),
      setWidth: (width: number) => inspectorRuntime.setWidth(width)
    },
    bottomPanel: {
      registerView: (opts: any) => bottomPanelRuntime.registerView(opts),
      activateView: (id: string) => bottomPanelRuntime.activateView(id),
      closeView: (id: string) => bottomPanelRuntime.closeView(id),
      getViews: () => bottomPanelRuntime.getViews(),
      getActiveViewId: () => bottomPanelRuntime.getActiveViewId(),
      getLastOpenedViewId: () => bottomPanelRuntime.getLastOpenedViewId(),
      show: () => bottomPanelRuntime.show(),
      hide: () => bottomPanelRuntime.hide(),
      toggle: () => bottomPanelRuntime.toggle(),
      setHeight: (h: number) => bottomPanelRuntime.setHeight(h),
      maximize: () => bottomPanelRuntime.maximize(),
      restore: () => bottomPanelRuntime.restore()
    },
    responsive: {
      getCurrentDeviceType: () => responsiveRuntime.getCurrentDeviceType(),
      getCurrentMode: () => responsiveRuntime.getCurrentMode(),
      getScreenWidth: () => responsiveRuntime.getScreenWidth(),
      getScreenHeight: () => responsiveRuntime.getScreenHeight(),
      isMobile: () => responsiveRuntime.isMobile(),
      isTablet: () => responsiveRuntime.isTablet(),
      isDesktop: () => responsiveRuntime.isDesktop(),
      onDidChangeDeviceType: (fn: any) => responsiveRuntime.onDidChangeDeviceType(fn),
      onDidChangeMode: (fn: any) => responsiveRuntime.onDidChangeMode(fn),
      setMode: (mode: any) => responsiveRuntime.setMode(mode)
    },
    settings: {
      registerPage: (page: any) => settingsRegistry.registerPage(page),
      registerItem: (item: any) => settingsRegistry.registerItem(item),
      open: () => openSettingsPanel(),
      close: () => closeSettingsPanel()
    },
    window: {
      activeEditor: null as any
    },
    __applyKeymap: () => (registry as any).applyKeymap(),
    __runMessageContributors: (messages: any[], stage: "pre" | "post" = "pre", ctx?: any) =>
      (registry as any).runMessageContributors(messages, stage, ctx)
  };
  (window as any).zion = api;
  try {
    Object.defineProperty((window as any).zion.window, "activeEditor", {
      configurable: true,
      enumerable: true,
      get() {
        return (registry as any).getActiveEditorProxy();
      }
    });
  } catch {}
  try {
    bindWorkbenchCore({ state: api.state as any, events: api.events as any });
  } catch {}
})();

// ============ 菜单使用统计的辅助方法 ============

// 保存菜单使用统计到 localStorage
(registry as any).saveMenuUsageStats = function() {
  try {
    localStorage.setItem('zion.menuUsageStats', JSON.stringify((registry as any).menuUsageStats || {}));
  } catch (e) {
    console.error('[zion] 保存菜单使用统计失败', e);
  }
};

// 加载菜单使用统计从 localStorage
(registry as any).loadMenuUsageStats = function() {
  try {
    const raw = localStorage.getItem('zion.menuUsageStats');
    if (raw) {
      (registry as any).menuUsageStats = JSON.parse(raw) || {};
    }
  } catch (e) {
    console.warn('[zion] 加载菜单使用统计失败', e);
  }
};

// 加载统计
(registry as any).loadMenuUsageStats();

export function attachEditor(core: EditorCore, panelId?: string) {
  return (registry as any).attachEditor(core, panelId);
}

export function setActiveEditorPanel(panelId: string | null) {
  (registry as any).setActivePanel(panelId);
}

export function detachEditor(panelId: string) {
  return (registry as any).detachEditor(panelId);
}

export function listAttachedEditorCores() {
  return (registry as any).listAttachedEditorCores();
}
