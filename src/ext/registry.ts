import { EventBus } from "../core/event-bus";
import { StateBus } from "../core/state-bus";
import type { Disposable, Keybinding, CommandHandler, PasteHandler, MenuItem, MessageContributor, Decorator } from "../types/zion";
import type { EditorCore } from "../editor/EditorCore";
import { EditorProxy } from "../editor/EditorProxy";
import type { EditorProxy as IEditorProxy } from "../types/zion";
import { findNext, findPrevious, selectMatches, replaceNext, replaceAll, SearchQuery } from "@codemirror/search";
// setSearchQuery 实际是一个 StateEffect，不是函数，需要用 editorCore.view.dispatch({ effects: setSearchQuery.of(query) })
import { setSearchQuery as setSearchQueryEffect } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { notificationManager } from "../notification/manager";
import { activityBarRuntime, bindWorkbenchCore, sideBarRuntime } from "../ui/workbench/runtime";

type CommandMap = Map<string, CommandHandler>;

class Registry {
  private commands: CommandMap = new Map();
  private keybindings: Keybinding[] = [];
  private events = new EventBus();
  private state = new StateBus();
  private statusItems = new Map<
    string,
    { id: string; el: HTMLButtonElement; onClick?: () => void; priority: number; pinned: boolean }
  >();
  private statusPinned: Set<string> = new Set();
  private readonly STATUS_PINNED_KEY = 'zion.statusBar.pinned';
  private bottomStatusItems = new Map<
    string,
    { id: string; el: HTMLButtonElement; onClick?: () => void; priority: number; pinned: boolean }
  >();
  private bottomStatusPinned: Set<string> = new Set();
  private readonly BOTTOM_STATUS_PINNED_KEY = 'zion.bottomStatusBar.pinned';
  private editorCore: EditorCore | null = null;

  // paste handlers
  private pasteHandlers: PasteHandler[] = [];
  private pasteAttached = false;

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

  // model providers (placeholder registry for future models integration)
  private modelProviders: { id: string; list: () => any | Promise<any>; resolve: (id: string) => any | Promise<any> }[] = [];

  // Chat Runner (MVP) state
  private activeModel: { providerId: string; modelId: string } | null = null;
  private currentRun: { id: string; timer: number; endPos: number } | null = null;
  private lastPrompt: string | null = null;

  attachEditor(core: EditorCore) {
    this.editorCore = core;
    (window.zion as any).window.activeEditor = new EditorProxy(core);
    this.applyKeymap();
    this.attachPasteListener();
    this.attachContextMenu();
    this.applyDecorators();

    // 加载菜单使用统计
    (this as any).loadMenuUsageStats();

    // Wire CM6 update events to Zion EventBus so plugins can react to input/cursor changes.
    try {
      const ext = EditorView.updateListener.of((update) => {
        try {
          if (!this.editorCore) return;
          if (update.docChanged) {
            this.events.emit("editor.change", { update, view: this.editorCore.view });
          }
          if (update.selectionSet) {
            this.events.emit("editor.cursorActivity", { selection: this.editorCore.view.state.selection, view: this.editorCore.view });
          }
        } catch (e) {
          console.error("[zion] editor update listener error", e);
        }
      });
      this.editorCore.addExternalExtension(ext as any);
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
      this.registerCommand("chat.run", () => {
        return (this as any).__chatRun({});
      });
      this.registerCommand("chat.stop", () => {
        (this as any).__chatStop();
        return true;
      });
      this.registerCommand("chat.retry", () => {
        (this as any).__chatRetry();
        return true;
      });
      // Select active model for later integration (LangChain-ready)
      this.registerCommand("models.selectActive", (m: { providerId: string; modelId: string } | null) => {
        (this as any).__chatSetActiveModel(m);
        return true;
      });
    } catch (e) {
      console.error("[zion] failed to register chat commands", e);
    }

    // Expose minimap control commands bridging to EditorCore
    try {
      this.registerCommand("zion.setMinimap", (enabled: boolean) => {
        if (!this.editorCore) return false;
        try {
          this.editorCore.setMinimapEnabled(!!enabled);
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
        if (!this.editorCore) {
          this.state.set("ui.minimapEnabled", next);
          return next;
        }
        try {
          this.editorCore.setMinimapEnabled(next);
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
        if (!this.editorCore) return false;
        try {
          this.editorCore.setSelectionHighlightEnabled(!!enabled);
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
        if (!this.editorCore) {
          this.state.set("ui.selectionHighlight", next);
          return next;
        }
        try {
          this.editorCore.setSelectionHighlightEnabled(next);
        } catch (e) {
          console.error("[zion] toggleSelectionHighlight error", e);
        }
        this.state.set("ui.selectionHighlight", next);
        return next;
      });
    } catch (e) {
      console.error("[zion] failed to register selection highlight bridge commands", e);
    }
  }

  private attachPasteListener() {
    if (!this.editorCore || this.pasteAttached) return;
    const dom = this.editorCore.view.dom;
    dom.addEventListener("paste", async (e: ClipboardEvent) => {
      try {
        const cd = e.clipboardData;
        const editor: IEditorProxy | null = (window as any).zion?.window?.activeEditor ?? null;
        if (!cd || !editor) return;

        // run handlers by priority (desc)
        const handlers = [...this.pasteHandlers].sort(
          (a, b) => (b.priority ?? 50) - (a.priority ?? 50)
        );
        for (const h of handlers) {
          try {
            const handled = await h.handle({ clipboardData: cd, editor });
            if (handled) {
              e.preventDefault();
              return;
            }
          } catch (err) {
            console.error("[zion] paste handler error:", h.id, err);
          }
        }
      } catch (err) {
        console.error("[zion] paste pipeline error:", err);
      }
    });
    this.pasteAttached = true;
  }

  private attachContextMenu() {
    if (!this.editorCore) return;
    const dom = this.editorCore.view.dom;

    dom.addEventListener("contextmenu", (e: MouseEvent) => {
      const items = this.menus["editor/context"] || [];
      if (items.length === 0) return;
      e.preventDefault();
      this.showEditorContextMenuAt(e.clientX, e.clientY);
    });
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
        when: it.when,
        submenu: hasKids ? kids : undefined,
        order: it.order,
        pinned: it.pinned,
        group: it.group
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

  private buildContextMenuPanel(items: MenuItem[], closeMenu: () => void, menuId: string = "editor/context"): HTMLDivElement {
    const menu = document.createElement("div");
    menu.className = "zion-context-menu";
    menu.setAttribute("role", "menu");
    menu.tabIndex = -1;

    let activeCloser: (() => void) | null = null;

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
      span.textContent = it.title || it.command || "";
      btn.appendChild(span);
      btn.setAttribute("role", "menuitem");

      if (hasKids) {
        btn.setAttribute("aria-haspopup", "menu");
        btn.setAttribute("aria-expanded", "false");
        const submenu = this.buildContextMenuPanel(it.submenu || [], closeMenu, menuId);
        submenu.classList.add("zion-context-submenu");
        submenu.style.position = "fixed";
        submenu.style.display = "none";

        let closeTimer: number | null = null;
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
            this.executeCommand(cmd);
          } finally {
            closeMenu();
          }
        };

        row.addEventListener("mouseenter", open);
        row.addEventListener("mouseleave", scheduleClose);
        submenu.addEventListener("mouseenter", cancelClose);
        submenu.addEventListener("mouseleave", scheduleClose);

        row.appendChild(btn);
        row.appendChild(submenu);
      } else {
        btn.onclick = () => {
          const cmd = it.command;
          if (!cmd) return;
          try {
            this.executeCommand(cmd);
            // 记录点击统计
            const menuKey = `editor/context:${cmd}`;
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
          row.style.opacity = "0.5";
          dragZone.style.cursor = "grabbing";
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", i.toString());
          }
        });

        row.addEventListener("dragend", () => {
          row.style.opacity = "1";
          dragZone.style.cursor = "grab";
        });

        row.addEventListener("dragover", (e: DragEvent) => {
          e.preventDefault();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = "move";
          }
        });

        row.addEventListener("dragenter", (e: DragEvent) => {
          const targetRow = (e.currentTarget as HTMLElement);
          if (!targetRow.querySelector(".zion-drag-zone")) return;
          targetRow.classList.add("is-drop-target");
        });

        row.addEventListener("dragleave", (e: DragEvent) => {
          const targetRow = (e.currentTarget as HTMLElement);
          targetRow.classList.remove("is-drop-target");
        });

        row.addEventListener("drop", (e: DragEvent) => {
          e.preventDefault();
          const targetRow = (e.currentTarget as HTMLElement);
          targetRow.classList.remove("is-drop-target");

          const fromIndex = parseInt(e.dataTransfer?.getData("text/plain") || "-1");
          const toIndex = i;

          if (fromIndex >= 0 && fromIndex !== toIndex && toIndex < pinnedCount) {
            // 交换位置
            const temp = items[fromIndex];
            items.splice(fromIndex, 1);
            items.splice(toIndex, 0, temp);

            // 更新 customOrder
            for (let j = 0; j < pinnedCount; j++) {
              const item = items[j];
              if (item.command) {
                const menuKey = `editor/context:${item.command}`;
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
            this.rebuildMenuItems(menu, items, closeMenu, items);
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
        const menuKey = `editor/context:${cmd}`;
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

        const menuKey = `editor/context:${cmd}`;

        if (!this.menuUsageStats[menuKey]) {
          this.menuUsageStats[menuKey] = {
            clickCount: 0,
            lastClickTime: 0,
            pinned: !!it.pinned || isDefaultPinned
          };
        }

        // 切换置顶状态
        this.menuUsageStats[menuKey].pinned = !this.menuUsageStats[menuKey].pinned;

        // 如果置顶，设置一个合理的order
        if (this.menuUsageStats[menuKey].pinned) {
          this.menuUsageStats[menuKey].customOrder = this.menuUsageStats[menuKey].customOrder ?? 50;
        }

        // 保存到 localStorage
        (this as any).saveMenuUsageStats();

        // 重新渲染菜单
        const sorted = this.sortMenuItems(items, "editor/context");
        menu.innerHTML = "";
        this.rebuildMenuItems(menu, sorted, closeMenu, sorted);
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
  private rebuildMenuItems(menu: HTMLDivElement, items: MenuItem[], closeMenu: () => void, filtered: MenuItem[]): void {
    const isPinnedItem = (item: MenuItem) => {
      const cmd = item.command || "";
      if (!cmd) return false;
      const menuKey = `editor/context:${cmd}`;
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
      span.textContent = it.title || it.command || "";
      btn.appendChild(span);
      btn.setAttribute("role", "menuitem");

      if (hasKids) {
        // ... 子菜单处理逻辑（与之前相同）
        btn.setAttribute("aria-haspopup", "menu");
        btn.setAttribute("aria-expanded", "false");
        const submenu = this.buildContextMenuPanel(it.submenu || [], closeMenu);
        submenu.classList.add("zion-context-submenu");
        submenu.style.position = "fixed";
        submenu.style.display = "none";
        row.appendChild(submenu);
      } else {
        btn.onclick = () => {
          const cmd = it.command;
          if (!cmd) return;
          try {
            this.executeCommand(cmd);
            // 记录点击统计
            const menuKey = `editor/context:${cmd}`;
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
          row.style.opacity = "0.5";
          dragZone.style.cursor = "grabbing";
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", i.toString());
          }
        });

        row.addEventListener("dragend", () => {
          row.style.opacity = "1";
          dragZone.style.cursor = "grab";
        });

        row.addEventListener("dragover", (e: DragEvent) => {
          e.preventDefault();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = "move";
          }
        });

        row.addEventListener("dragenter", (e: DragEvent) => {
          const targetRow = (e.currentTarget as HTMLElement);
          if (!targetRow.querySelector(".zion-drag-zone")) return;
          targetRow.classList.add("is-drop-target");
        });

        row.addEventListener("dragleave", (e: DragEvent) => {
          const targetRow = (e.currentTarget as HTMLElement);
          targetRow.classList.remove("is-drop-target");
        });

        row.addEventListener("drop", (e: DragEvent) => {
          e.preventDefault();
          const targetRow = (e.currentTarget as HTMLElement);
          targetRow.classList.remove("is-drop-target");

          const fromIndex = parseInt(e.dataTransfer?.getData("text/plain") || "-1");
          const toIndex = i;

          if (fromIndex >= 0 && fromIndex !== toIndex && toIndex < pinnedCount) {
            // 交换位置
            const temp = filtered[fromIndex];
            filtered.splice(fromIndex, 1);
            filtered.splice(toIndex, 0, temp);

            // 更新 customOrder
            for (let j = 0; j < pinnedCount; j++) {
              const item = filtered[j];
              if (item.command) {
                const menuKey = `editor/context:${item.command}`;
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
            this.rebuildMenuItems(menu, items, closeMenu, filtered);
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
        const menuKey = `editor/context:${cmd}`;
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

        const menuKey = `editor/context:${cmd}`;

        if (!this.menuUsageStats[menuKey]) {
          this.menuUsageStats[menuKey] = {
            clickCount: 0,
            lastClickTime: 0,
            pinned: !!it.pinned || isDefaultPinned
          };
        }

        // 切换置顶状态
        this.menuUsageStats[menuKey].pinned = !this.menuUsageStats[menuKey].pinned;

        // 如果置顶，设置一个合理的order
        if (this.menuUsageStats[menuKey].pinned) {
          this.menuUsageStats[menuKey].customOrder = this.menuUsageStats[menuKey].customOrder ?? 50;
        }

        // 保存到 localStorage
        (this as any).saveMenuUsageStats();

        // 重新渲染菜单
        const sorted = this.sortMenuItems(filtered, "editor/context");
        menu.innerHTML = "";
        this.rebuildMenuItems(menu, sorted, closeMenu, sorted);
      });

      // 防止置顶按钮触发菜单点击
      pinBtn.addEventListener("mousedown", (e: MouseEvent) => {
        e.stopPropagation();
      });

      row.appendChild(pinBtn);

      menu.appendChild(row);
    }
  }

  private showEditorContextMenuAt(x: number, y: number) {
    if (!this.editorCore) return;
    const dom = this.editorCore.view.dom;
    const items = this.menus["editor/context"] || [];
    if (items.length === 0) return;

    const hasSelection =
      this.editorCore.view.state.selection.main.from !== this.editorCore.view.state.selection.main.to;
    const editorFocus = document.activeElement ? dom.contains(document.activeElement) : false;

    const filtered = this.filterMenuTree(items, { hasSelection, editorFocus });
    if (filtered.length === 0) return;

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

    const menu = this.buildContextMenuPanel(sorted, closeMenu);
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

  private applyDecorators() {
    if (!this.editorCore) return;
    const editor: IEditorProxy | null = (window as any).zion?.window?.activeEditor ?? null;
    if (!editor) return;
    for (const dec of this.decorators) {
      if (this.decoratorDisposables.has(dec.id)) continue;
      try {
        const disp = dec.apply(editor);
        this.decoratorDisposables.set(dec.id, disp);
      } catch (e) {
        console.error("[zion] decorator apply error:", dec.id, e);
      }
    }
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

    // 初始化使用统计
    if (!this.menuUsageStats[menuKey]) {
      this.menuUsageStats[menuKey] = {
        clickCount: 0,
        lastClickTime: 0,
        pinned: item.pinned || false,
        customOrder: item.order,
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
    if (this.editorCore && (window as any).zion?.window?.activeEditor) {
      try {
        const disp = dec.apply(((window as any).zion.window.activeEditor as IEditorProxy));
        this.decoratorDisposables.set(dec.id, disp);
      } catch (e) {
        console.error("[zion] decorator apply error:", dec.id, e);
      }
    }
    return {
      dispose: () => {
        const idx = this.decorators.indexOf(dec);
        if (idx >= 0) this.decorators.splice(idx, 1);
        const d = this.decoratorDisposables.get(dec.id);
        try { d?.dispose?.(); } catch {}
        this.decoratorDisposables.delete(dec.id);
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
      const aDefaultPinnedActive = a.isDefaultPinned && a.pinned;
      const bDefaultPinnedActive = b.isDefaultPinned && b.pinned;

      if (aDefaultPinnedActive && bDefaultPinnedActive) {
        const aIndex = this.DEFAULT_PINNED_COMMANDS.indexOf(a.command);
        const bIndex = this.DEFAULT_PINNED_COMMANDS.indexOf(b.command);
        return aIndex - bIndex;
      }

      if (aDefaultPinnedActive) return -1;
      if (bDefaultPinnedActive) return 1;

      // 用户置顶的命令在前面
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;

      // 都是置顶的，按照自定义order排序
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
  registerModelProvider(provider: { id: string; list: () => any | Promise<any>; resolve: (id: string) => any | Promise<any> }): Disposable {
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

  async runMessageContributors(messages: any[], stage: "pre" | "post" = "pre"): Promise<any[]> {
    const contribs = [...this.messageContribs]
      .filter(c => (c.stage ?? "pre") === stage)
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));

    const ctx = {
      editor: ((window as any).zion?.window?.activeEditor ?? null) as IEditorProxy | null,
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
    this.applyKeymap();
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
    if (!this.editorCore) return;
    const bindings = this.keybindings.map(kb => ({
      key: kb.key,
      run: () => {
        // evaluate simple 'when' conditions
        const dom = this.editorCore!.view.dom;
        const hasSelection =
          this.editorCore!.view.state.selection.main.from !== this.editorCore!.view.state.selection.main.to;
        const editorFocus = dom.contains(document.activeElement);

        // Determine if the custom search panel is visible and focused.
        const searchPanelEl = document.querySelector('.search-replace-panel') as HTMLElement | null;
        const searchReplaceVisible = !!searchPanelEl && searchPanelEl.style.display !== 'none';
        const searchPanelFocused = searchPanelEl ? searchPanelEl.contains(document.activeElement) : false;

        if (kb.when === "hasSelection" && !hasSelection) return false;
        if (kb.when === "editorFocus" && !editorFocus) return false;
        // Only trigger searchReplaceVisible bindings when the search panel currently has focus.
        if (kb.when === "searchReplaceVisible" && !searchPanelFocused) return false;

        this.executeCommand(kb.command);
        return true;
      }
    }));
    this.editorCore.updateKeymap(bindings);
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
    this.loadBottomStatusPinned();
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

  private loadBottomStatusPinned() {
    try {
      const raw = localStorage.getItem(this.BOTTOM_STATUS_PINNED_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          this.bottomStatusPinned = new Set(arr);
        }
      }
    } catch (e) {
      console.error('[registry] load bottom status pinned error:', e);
    }
  }

  private saveBottomStatusPinned() {
    try {
      localStorage.setItem(this.BOTTOM_STATUS_PINNED_KEY, JSON.stringify(Array.from(this.bottomStatusPinned)));
    } catch (e) {
      console.error('[registry] save bottom status pinned error:', e);
    }
  }

  // statusbar
  registerStatusItem(opts: { id: string; text: string; tooltip?: string; onClick?: () => void; priority?: number }): Disposable {
    const bar = document.getElementById("statusbar");
    if (!bar) return { dispose: () => {} };

    const priority = opts.priority ?? 0;
    const pinned = this.statusPinned.has(opts.id);

    const existing = this.statusItems.get(opts.id);
    if (existing) {
      // Update in place without clearing innerHTML to preserve hover state and reduce flicker
      const textSpan = existing.el.querySelector("span:not(.status-pin-btn)");
      if (textSpan) {
        textSpan.textContent = opts.text;
      } else {
        const span = document.createElement("span");
        span.textContent = opts.text;
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
        this.toggleStatusPin(opts.id, bar);
      };

      existing.onClick = opts.onClick;
      existing.pinned = pinned;

      // Remove pin button if exists (migration)
      const pinBtn = existing.el.querySelector(".status-pin-btn");
      if (pinBtn) pinBtn.remove();

      // Update priority and re-sort if changed
      if (existing.priority !== priority) {
        existing.priority = priority;
        this.sortStatusItems(bar);
      } else {
        // Just in case pin state changed via other means
        this.sortStatusItems(bar);
      }

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
    if (pinned) {
      el.classList.add('pinned');
    }
    
    const span = document.createElement("span");
    span.textContent = opts.text;
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
      this.toggleStatusPin(opts.id, bar);
    };
    
    bar.appendChild(el);
    this.statusItems.set(opts.id, { id: opts.id, el, onClick: opts.onClick, priority, pinned });
    this.sortStatusItems(bar);

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

    const priority = opts.priority ?? 0;
    const pinned = this.bottomStatusPinned.has(opts.id);

    const existing = this.bottomStatusItems.get(opts.id);
    if (existing) {
      const textSpan = existing.el.querySelector("span:not(.status-pin-btn)");
      if (textSpan) {
        textSpan.textContent = opts.text;
      } else {
        const span = document.createElement("span");
        span.textContent = opts.text;
        if (existing.el.firstChild) {
          existing.el.insertBefore(span, existing.el.firstChild as any);
        } else {
          existing.el.appendChild(span);
        }
      }

      const tooltipBase = typeof opts.tooltip === "string" ? opts.tooltip : "";
      const tooltip = (tooltipBase ? tooltipBase + "\n" : "") + "Right-click to " + (pinned ? "Unpin" : "Pin");
      existing.el.title = tooltip;

      existing.el.onclick = (e) => { if (opts.onClick) opts.onClick(); };
      existing.el.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleBottomStatusPin(opts.id, bar);
      };

      existing.onClick = opts.onClick;
      existing.pinned = pinned;

      const pinBtn = existing.el.querySelector(".status-pin-btn");
      if (pinBtn) (pinBtn as any).remove();

      if (existing.priority !== priority) {
        existing.priority = priority;
        this.sortBottomStatusItems(bar);
      } else {
        this.sortBottomStatusItems(bar);
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
    el.className = "status-item";
    if (pinned) el.classList.add("pinned");

    const span = document.createElement("span");
    span.textContent = opts.text;
    el.appendChild(span);

    const tooltipBase = typeof opts.tooltip === "string" ? opts.tooltip : "";
    const tooltip = (tooltipBase ? tooltipBase + "\n" : "") + "Right-click to " + (pinned ? "Unpin" : "Pin");
    el.title = tooltip;

    el.onclick = (e) => { if (opts.onClick) opts.onClick(); };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleBottomStatusPin(opts.id, bar);
    };

    bar.appendChild(el);
    this.bottomStatusItems.set(opts.id, { id: opts.id, el, onClick: opts.onClick, priority, pinned });
    this.sortBottomStatusItems(bar);

    return {
      dispose: () => {
        const item = this.bottomStatusItems.get(opts.id);
        if (!item) return;
        item.el.remove();
        this.bottomStatusItems.delete(opts.id);
      }
    };
  }

  private toggleBottomStatusPin(id: string, bar: HTMLElement) {
    const item = this.bottomStatusItems.get(id);
    if (!item) return;

    if (this.bottomStatusPinned.has(id)) {
      this.bottomStatusPinned.delete(id);
      item.pinned = false;
      item.el.classList.remove('pinned');
    } else {
      this.bottomStatusPinned.add(id);
      item.pinned = true;
      item.el.classList.add('pinned');
    }

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

    this.saveBottomStatusPinned();
    this.sortBottomStatusItems(bar);
  }

  private sortBottomStatusItems(bar: HTMLElement) {
    const items = Array.from(this.bottomStatusItems.values());
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.id.localeCompare(b.id);
    });
    items.forEach(item => bar.appendChild(item.el));
  }

  private toggleStatusPin(id: string, bar: HTMLElement) {
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
    this.sortStatusItems(bar);
  }

  private sortStatusItems(bar: HTMLElement) {
    const items = Array.from(this.statusItems.values());
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
        const head = ln.slice(match.length + 1);
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

  // Start a chat run: parse messages, pick latest user (or selection), stream an echo response
  private __chatRun(opts?: { useSelection?: boolean; prompt?: string }): boolean {
    try {
      if (!this.editorCore) return false;
      // Prevent concurrent runs
      if (this.currentRun?.timer) {
        console.warn("[zion] chat already running");
        return false;
      }
      const view = this.editorCore.view;
      const docText = view.state.doc.toString();

      // 1) 优先使用传入的 prompt
      let prompt = (opts?.prompt ?? "").trim();

      // 2) 其次使用选区
      if (!prompt) {
        const sel = view.state.selection.main;
        if (opts?.useSelection && !sel.empty) {
          prompt = view.state.sliceDoc(sel.from, sel.to).trim();
        }
      }

      // 3) 最后回退到文档中最新的 user 区块
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

      // Compose a fake response (MVP); future: stream from selected provider via LangChain
      const response = "Echo: " + prompt;

      // Insert "assistant " block at document end and stream into it
      const state = view.state;
      const docLen = state.doc.length;
      const endsWithNL = docLen === 0 ? true : state.sliceDoc(docLen - 1, docLen) === "\n";
      const head = (endsWithNL ? "" : "\n") + "assistant \n";
      this.editorCore.view.dispatch({ changes: { from: docLen, to: docLen, insert: head } });
      let endPos = docLen + head.length;

      // Mark run state
      const runId = "run_" + Math.random().toString(36).slice(2);
      this.state.set("chat.runId", runId);
      this.state.set("chat.streaming", true);
      this.state.set("chat.error", null);
      this.events.emit("chat/runStarted", { runId, model: this.activeModel });

      // Tokenize response into small chunks and stream
      const chunks: string[] = [];
      const chunkSize = 40;
      for (let i = 0; i < response.length; i += chunkSize) {
        chunks.push(response.slice(i, i + chunkSize));
      }

      let idx = 0;
      const timer = window.setInterval(() => {
        try {
          if (idx < chunks.length) {
            const piece = chunks[idx++];
            this.editorCore!.view.dispatch({ changes: { from: endPos, to: endPos, insert: piece } });
            endPos += piece.length;
            this.events.emit("chat/token", { runId, token: piece });
          } else {
            // finalize with newline
            this.editorCore!.view.dispatch({ changes: { from: endPos, to: endPos, insert: "\n" } });
            window.clearInterval(this.currentRun!.timer);
            const finishedRunId = this.currentRun!.id;
            this.currentRun = null;
            this.state.set("chat.streaming", false);
            this.events.emit("chat/runFinished", { runId: finishedRunId });
          }
        } catch (e) {
          try { window.clearInterval(this.currentRun!.timer); } catch {}
          this.currentRun = null;
          this.state.set("chat.streaming", false);
          this.state.set("chat.error", (e as any)?.message || String(e));
          this.events.emit("chat/runError", { runId, error: e });
        }
      }, 40);

      this.currentRun = { id: runId, timer, endPos };
      return true;
    } catch (e) {
      console.error("[zion] chat.run error", e);
      this.state.set("chat.error", (e as any)?.message || String(e));
      this.state.set("chat.streaming", false);
      return false;
    }
  }

  private __chatStop(): void {
    try {
      if (!this.currentRun) return;
      const runId = this.currentRun.id;
      try { window.clearInterval(this.currentRun.timer); } catch {}
      this.currentRun = null;
      this.state.set("chat.streaming", false);
      this.events.emit("chat/aborted", { runId });
    } catch (e) {
      console.error("[zion] chat.stop error", e);
    }
  }

  private __chatRetry(): void {
    try {
      if (this.currentRun) {
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

// Expose window.zion API
(function expose() {
  const api = {
    commands: {
      registerCommand: (id: string, fn: CommandHandler) => registry.registerCommand(id, fn),
      executeCommand: (id: string, ...args: any) => registry.executeCommand(id, ...args)
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
      registerDecorator: (dec: Decorator) => (registry as any).registerDecorator(dec)
    },
    models: {
      registerProvider: (p: { id: string; list: () => any | Promise<any>; resolve: (id: string) => any | Promise<any> }) =>
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
    window: {
      activeEditor: null as any
    },
    __applyKeymap: () => (registry as any).applyKeymap(),
    __runMessageContributors: (messages: any[], stage: "pre" | "post" = "pre") =>
      (registry as any).runMessageContributors(messages, stage)
  };
  (window as any).zion = api;
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

export function attachEditor(core: EditorCore) {
  (registry as any).attachEditor(core);
}
