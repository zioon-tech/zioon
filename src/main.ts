import "katex/dist/katex.min.css";
import { EditorCore } from "./editor/EditorCore";
import "./pwa-test";
import { attachEditor, detachEditor, setActiveEditorPanel } from "./ext/registry";
import type { Disposable } from "./types/zion";
import { PluginManager } from "./plugin/manager";
import { HttpPluginInstaller } from "./plugin/http-installer";
import type { PluginInfo } from "./plugin/types";
import { notificationManager } from "./notification/manager";
import { initWorkbench } from "./ui/workbench/workbench";
import { initCommandPalette } from "./ui/workbench/commandPalette";
import { DEFAULT_BASE_URL, initServiceBaseUrlConfig } from "./settings/serviceBaseUrl";
import { PanelManager, SessionSync, createPanelDomShell } from "./panel";


// ---------- 自动保存 / 恢复 ----------
const STORAGE_KEY = 'zion.autosave';
const PANEL_WORKSPACE_STORAGE_KEY = "zion.panelWorkspace.v1";

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

function loadPanelWorkspaceSnapshot(): any | null {
  try {
    const raw = localStorage.getItem(PANEL_WORKSPACE_STORAGE_KEY) || "";
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

let panelWorkspaceSaveTimer = 0;
function savePanelWorkspaceSnapshot(snapshot: any) {
  if (panelWorkspaceSaveTimer) cancelIdleCallback(panelWorkspaceSaveTimer);
  panelWorkspaceSaveTimer = requestIdleCallback(
    () => {
      try {
        localStorage.setItem(PANEL_WORKSPACE_STORAGE_KEY, JSON.stringify(snapshot));
      } catch {}
    },
    { timeout: 3000 }
  );
}

function getPanelActiveSessionId(panelId?: string | null): string | null {
  if (!panelId) return null;
  try {
    return window.zion?.panels?.list?.().find((panel) => panel.id === panelId)?.activeTabId || null;
  } catch {
    return null;
  }
}

function revealTabInStrip(stripEl?: HTMLElement | null, tabEl?: HTMLElement | null): void {
  if (!stripEl || !tabEl) return;
  const viewLeft = stripEl.scrollLeft;
  const viewRight = viewLeft + stripEl.clientWidth;
  const tabLeft = tabEl.offsetLeft;
  const tabRight = tabLeft + tabEl.offsetWidth;
  if (tabLeft < viewLeft) {
    stripEl.scrollLeft = Math.max(0, tabLeft);
    return;
  }
  if (tabRight > viewRight) {
    stripEl.scrollLeft = Math.max(0, tabRight - stripEl.clientWidth);
  }
}

type PanelTabDragState = {
  sourcePanelId: string;
  tabId: string;
};

const PANEL_TAB_DND_MIME = "application/x-zion-panel-tab";
let panelTabDragState: PanelTabDragState | null = null;
type PanelDropSide = "center" | "left" | "right" | "up" | "down";
let panelDropPreviewEl: HTMLDivElement | null = null;
let panelDropPreviewLabelEl: HTMLDivElement | null = null;

function ensurePanelDropPreview() {
  if (!panelDropPreviewEl) {
    panelDropPreviewEl = document.createElement("div");
    panelDropPreviewEl.className = "zion-panel-drop-preview";
    document.body.appendChild(panelDropPreviewEl);
  }
  if (!panelDropPreviewLabelEl) {
    panelDropPreviewLabelEl = document.createElement("div");
    panelDropPreviewLabelEl.className = "zion-panel-drop-preview-label";
    document.body.appendChild(panelDropPreviewLabelEl);
  }
  return { previewEl: panelDropPreviewEl, labelEl: panelDropPreviewLabelEl };
}

function hidePanelDropPreview() {
  if (panelDropPreviewEl) panelDropPreviewEl.classList.remove("show");
  if (panelDropPreviewLabelEl) panelDropPreviewLabelEl.classList.remove("show");
}

function getPanelDropSideFromPoint(rect: DOMRect, clientX: number, clientY: number): PanelDropSide {
  const edgeX = Math.max(56, Math.min(96, rect.width * 0.24));
  const edgeY = Math.max(56, Math.min(96, rect.height * 0.24));
  const distLeft = clientX - rect.left;
  const distRight = rect.right - clientX;
  const distTop = clientY - rect.top;
  const distBottom = rect.bottom - clientY;
  const minDist = Math.min(distLeft, distRight, distTop, distBottom);
  if (minDist > Math.min(edgeX, edgeY)) return "center";
  if (minDist === distLeft && distLeft <= edgeX) return "left";
  if (minDist === distRight && distRight <= edgeX) return "right";
  if (minDist === distTop && distTop <= edgeY) return "up";
  if (minDist === distBottom && distBottom <= edgeY) return "down";
  return "center";
}

function showPanelDropPreview(rect: DOMRect, side: PanelDropSide) {
  const { previewEl, labelEl } = ensurePanelDropPreview();
  let left = rect.left;
  let top = rect.top;
  let width = rect.width;
  let height = rect.height;
  if (side === "left") width = rect.width / 2;
  else if (side === "right") {
    width = rect.width / 2;
    left = rect.left + rect.width / 2;
  } else if (side === "up") height = rect.height / 2;
  else if (side === "down") {
    height = rect.height / 2;
    top = rect.top + rect.height / 2;
  }
  previewEl.style.left = `${left}px`;
  previewEl.style.top = `${top}px`;
  previewEl.style.width = `${Math.max(0, width)}px`;
  previewEl.style.height = `${Math.max(0, height)}px`;
  previewEl.classList.add("show");

  const labels: Record<PanelDropSide, string> = {
    center: "放入当前 panel",
    left: "在左侧新建 panel",
    right: "在右侧新建 panel",
    up: "在上方新建 panel",
    down: "在下方新建 panel"
  };
  labelEl.textContent = labels[side];
  labelEl.style.left = `${rect.left + rect.width / 2}px`;
  labelEl.style.top = `${rect.top + 12}px`;
  labelEl.classList.add("show");
}

function mountCurrentSessionPath(pathEl: HTMLElement, panelId?: string | null) {
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
  const resolveSessionId = () => {
    if (panelId) {
      return getPanelActiveSessionId(panelId) || null;
    }
    return window.zion.state.get<string>("sessions.currentId") || null;
  };
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
    const id = resolveSessionId();
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
      if (panelId && window.zion?.panels?.getActivePanelId?.() !== panelId) return;
      bindMeta(nv);
      update();
    });
  } catch {}

  try {
    window.zion.events.on("panel/tabActivated", (payload: any) => {
      if (panelId && payload?.panelId !== panelId) return;
      const id = payload?.sessionId || payload?.tabId || resolveSessionId();
      if (id) {
        bindMeta(id);
        update();
      }
    });
  } catch {}

  try {
    window.zion.state.onDidChange("sessions.catalog", () => update());
  } catch {}

  try {
    window.zion.state.onDidChange("sessions.treeMem", () => update());
  } catch {}

  bindMeta(resolveSessionId() || undefined);
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
    btn.innerHTML = '<span class="codicon codicon-add" aria-hidden="true"></span>';
    btn.title = "新增会话（同级）";
    btn.setAttribute("aria-label", "新增会话（同级）");
    btn.setAttribute("data-zion-editor-new-session-button", "1");
    
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
    btn.innerHTML = '<span class="codicon codicon-list-tree" aria-hidden="true"></span>';
    btn.title = "目录";
    btn.setAttribute("aria-label", "目录");
    btn.setAttribute("data-zion-editor-toc-button", "1");
    
    btn.onclick = (e) => {
      try {
        e.stopPropagation();
      } catch {}
      try {
        const panelId = pathEl.closest("[data-panel-id]")?.getAttribute("data-panel-id") || null;
        if (panelId) {
          try { window.zion?.panels?.focus?.(panelId); } catch {}
        }
        window.zion.commands.executeCommand("toc.show");
      } catch {}
    };

    if (isNew) headerEl.insertBefore(btn, pathEl);
  } catch {}
}

function mountEditorSessionTabsBar(containerEl: HTMLElement) {
  try {
    const existing = containerEl.querySelector<HTMLElement>("[data-zion-editor-session-tabs='1']");
    const existingNewBtn = containerEl.querySelector<HTMLButtonElement>("button[data-zion-editor-tabs-new-session-button='1']");
    const existingDropdownBtn = containerEl.querySelector<HTMLButtonElement>("button[data-zion-editor-tabs-dropdown-button='1']");
    if (existing && existingNewBtn && existingDropdownBtn) return;

    const STORAGE_KEY = "zion.ui.editorSessionTabs";

    const safeParse = <T,>(raw: string | null, fallback: T): T => {
      if (!raw) return fallback;
      try {
        const v = JSON.parse(raw);
        return (v ?? fallback) as T;
      } catch {
        return fallback;
      }
    };

    const normalizeIds = (ids: unknown): string[] => {
      const arr = Array.isArray(ids) ? ids : [];
      const out: string[] = [];
      const seen = new Set<string>();
      for (const it of arr) {
        const s = String(it ?? "").trim();
        if (!s) continue;
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
      return out;
    };

    const loadOpenIds = (): string[] => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = safeParse<any>(raw, null);
        if (Array.isArray(parsed)) return normalizeIds(parsed);
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.ids)) return normalizeIds(parsed.ids);
        return [];
      } catch {
        return [];
      }
    };

    const persistOpenIds = (ids: string[]) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
      } catch {}
    };

    let openIds = loadOpenIds();

    // 验证 openIds 中的会话是否仍然存在于会话目录中
    const validateOpenIds = (): string[] => {
      try {
        const catalog = window.zion.state.get<any[]>("sessions.catalog") || [];
        // 如果 catalog 还没有加载，暂时返回当前的 openIds
        if (!catalog || catalog.length === 0) {
          return openIds;
        }
        const validIds = new Set(catalog.map((s: any) => s.id).filter(Boolean));
        const valid = openIds.filter(id => validIds.has(id));
        // 如果有无效的 ID 被移除，持久化更新后的列表
        if (valid.length !== openIds.length) {
          openIds = valid;
          persistOpenIds(openIds);
        }
        return valid;
      } catch {
        return openIds;
      }
    };

    // 初始加载时验证 - 可能会在 catalog 加载前执行，所以暂时保留所有 ID
    const initialCatalog = window.zion.state.get<any[]>("sessions.catalog");
    if (initialCatalog && initialCatalog.length > 0) {
      openIds = validateOpenIds();
    }

    const getParentIdForNewSession = (): string | undefined => {
      try {
        const curId = window.zion.state.get<string>("sessions.currentId");
        if (!curId) return undefined;
        const tree = window.zion.state.get<any>("sessions.treeMem");
        if (!tree || tree.type !== "folder") return undefined;
        let found: any = null;
        let parent: any = null;
        const dfs = (node: any, p: any) => {
          if (!node || found) return;
          if (node.id === curId) {
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
        dfs(tree, null);
        if (parent && parent.type === "folder") return parent.id;
        return undefined;
      } catch {
        return undefined;
      }
    };

    let newBtn = existingNewBtn;
    if (!newBtn) {
      newBtn = document.createElement("button");
      newBtn.type = "button";
      newBtn.className = "zion-editor-header-action is-icon zion-editor-tabs-new-session-button";
      newBtn.innerHTML = '<span class="codicon codicon-add" aria-hidden="true"></span>';
      newBtn.title = "新增会话（同级）";
      newBtn.setAttribute("aria-label", "新增会话（同级）");
      newBtn.setAttribute("data-zion-editor-tabs-new-session-button", "1");
      newBtn.onclick = (e) => {
        try {
          e.stopPropagation();
          e.preventDefault();
        } catch {}
        try {
          const parentId = getParentIdForNewSession();
          window.zion.commands.executeCommand("zion.sessions.new", { parentId });
        } catch {}
      };
      containerEl.insertBefore(newBtn, containerEl.firstChild);
    }

    try {
      const oldBtn = document.querySelector<HTMLButtonElement>("button[data-zion-editor-new-session-button='1']");
      oldBtn?.remove?.();
    } catch {}

    const tabsEl = existing || document.createElement("div");
    if (!existing) {
      tabsEl.className = "zion-editor-session-tabs";
      tabsEl.setAttribute("data-zion-editor-session-tabs", "1");
      tabsEl.setAttribute("role", "tablist");
      containerEl.appendChild(tabsEl);
    }

    let dropdownBtn = existingDropdownBtn;
    let dropdownMenu: HTMLDivElement | null = null;
    const ensureDropdownMenu = () => {
      if (dropdownMenu && dropdownMenu.isConnected) return dropdownMenu;
      dropdownMenu = document.createElement("div");
      dropdownMenu.className = "zion-editor-tabs-menu";
      document.body.appendChild(dropdownMenu);
      return dropdownMenu;
    };
    const hideDropdownMenu = () => {
      if (!dropdownMenu) return;
      dropdownMenu.classList.remove("show");
      dropdownMenu.innerHTML = "";
    };
    const isDropdownOpen = () => !!dropdownMenu?.classList.contains("show");

    const showDropdownMenu = () => {
      const menu = ensureDropdownMenu();
      if (!dropdownBtn) return;
      menu.innerHTML = "";
      const rect = dropdownBtn.getBoundingClientRect();
      const gap = 6;
      const top = Math.min(window.innerHeight - 10, rect.bottom + gap);
      const left = Math.max(10, Math.min(window.innerWidth - 10, rect.right));
      menu.style.top = `${top}px`;
      menu.style.left = `${left}px`;
      menu.style.right = "auto";
      menu.style.transform = "translateX(-100%)";

      const activeId = window.zion.state.get<string>("sessions.currentId") ?? null;
      if (openIds.length === 0) {
        const empty = document.createElement("div");
        empty.className = "zion-editor-tabs-menu-empty";
        empty.textContent = "暂无打开的标签页";
        menu.appendChild(empty);
      } else {
        for (const id of openIds) {
          const item = document.createElement("div");
          item.className = "zion-editor-tabs-menu-item";
          if (activeId === id) item.classList.add("is-active");

          const label = document.createElement("div");
          label.className = "zion-editor-tabs-menu-item-label";
          const title = getTitleForSession(id);
          label.textContent = title;
          label.title = title;

          const actions = document.createElement("div");
          actions.className = "zion-editor-tabs-menu-item-actions";

          const close = document.createElement("button");
          close.type = "button";
          close.className = "zion-editor-tabs-menu-item-close";
          close.title = "关闭";
          close.setAttribute("aria-label", "关闭标签页");
          close.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';
          close.onpointerdown = (e) => {
            try {
              e.stopPropagation();
            } catch {}
          };
          close.onmousedown = (e) => {
            try {
              e.stopPropagation();
            } catch {}
          };
          close.onclick = (e) => {
            try {
              e.stopPropagation();
              e.preventDefault();
            } catch {}
            closeTab(id);
            requestRender();
            requestAnimationFrame(() => {
              try {
                if (openIds.length === 0) hideDropdownMenu();
                else showDropdownMenu();
              } catch {}
            });
          };

          actions.appendChild(close);
          item.appendChild(label);
          item.appendChild(actions);
          item.onclick = () => {
            hideDropdownMenu();
            activateTab(id);
          };
          menu.appendChild(item);
        }
      }

      menu.classList.add("show");
    };

    if (!dropdownBtn) {
      dropdownBtn = document.createElement("button");
      dropdownBtn.type = "button";
      dropdownBtn.className = "zion-editor-header-action is-icon zion-editor-tabs-dropdown-button";
      dropdownBtn.innerHTML = '<span class="codicon codicon-chevron-down" aria-hidden="true"></span>';
      dropdownBtn.title = "查看所有标签页";
      dropdownBtn.setAttribute("aria-label", "查看所有标签页");
      dropdownBtn.setAttribute("data-zion-editor-tabs-dropdown-button", "1");
      dropdownBtn.onclick = (e) => {
        try {
          e.stopPropagation();
          e.preventDefault();
        } catch {}
        if (isDropdownOpen()) hideDropdownMenu();
        else showDropdownMenu();
      };
      containerEl.appendChild(dropdownBtn);
    }

    try {
      window.addEventListener("resize", hideDropdownMenu);
      window.addEventListener(
        "scroll",
        (e) => {
          const t = (e as any)?.target as any;
          if (dropdownMenu && (t === dropdownMenu || dropdownMenu.contains(t))) return;
          hideDropdownMenu();
        },
        true
      );
      window.addEventListener("keydown", (e) => {
        const ev = e as KeyboardEvent;
        if (ev.key === "Escape") hideDropdownMenu();
      });
      window.addEventListener("mousedown", (e) => {
        const t = e.target as any;
        if (dropdownBtn && (dropdownBtn === t || dropdownBtn.contains(t))) return;
        if (dropdownMenu && (dropdownMenu === t || dropdownMenu.contains(t))) return;
        hideDropdownMenu();
      });
    } catch {}

    const metaDisposables = new Map<string, Disposable>();
    const runDisposables = new Map<string, Disposable>();
    const tabNodes = new Map<string, HTMLElement>();
    const tabStatusNodes = new Map<string, HTMLElement>();
    const tabTitleNodes = new Map<string, HTMLElement>();
    let draggingId: string | null = null;
    let dropTargetId: string | null = null;
    let dropPosition: "before" | "after" | null = null;
    let lastDragEndAt = 0;

    let lastBroadcastOpenKey = "";
    let lastBroadcastActiveId: string | null = null;
    let lastDomOrderKey = "";

    let rafPending = false;
    const requestRender = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        render();
      });
    };

    const clearDropIndicators = () => {
      if (!dropTargetId) return;
      const el = tabNodes.get(dropTargetId);
      if (el) {
        el.classList.remove("is-drop-before");
        el.classList.remove("is-drop-after");
      }
      dropTargetId = null;
      dropPosition = null;
    };

    const reorderTabs = (fromId: string, toId: string, pos: "before" | "after") => {
      if (!fromId || !toId) return;
      if (fromId === toId) return;
      const next = openIds.filter(x => x !== fromId);
      const idx = next.indexOf(toId);
      if (idx === -1) return;
      const insertIdx = pos === "before" ? idx : idx + 1;
      next.splice(insertIdx, 0, fromId);
      openIds = next;
      persistOpenIds(openIds);
      render();
    };

    try {
      tabsEl.addEventListener(
        "wheel",
        (e) => {
          const ev = e as WheelEvent;
          if (!tabsEl) return;
          const canScroll = tabsEl.scrollWidth > tabsEl.clientWidth + 1;
          if (!canScroll) return;
          const dx = ev.deltaX || 0;
          const dy = ev.deltaY || 0;
          const delta = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
          if (!delta) return;
          const prev = tabsEl.scrollLeft;
          tabsEl.scrollLeft = prev + delta;
          const moved = Math.abs(tabsEl.scrollLeft - prev) > 0.5;
          if (moved) {
            try {
              ev.preventDefault();
              ev.stopPropagation();
            } catch {}
          }
        },
        { passive: false } as any
      );
    } catch {}

    const getTitleForSession = (id: string): string => {
      try {
        const meta = window.zion.state.get<any>(`sessions.meta.${id}`);
        const t = String(meta?.title || "").trim();
        return t || id;
      } catch {
        return id;
      }
    };

    let suppressEnsureActiveId: string | null = null;
    let suppressEnsureActiveUntil = 0;
    const suppressEnsureActiveOnce = (id: string) => {
      suppressEnsureActiveId = id;
      suppressEnsureActiveUntil = Date.now() + 1500;
    };
    const isEnsureActiveSuppressed = (id: string | null) => {
      if (!id) return false;
      if (suppressEnsureActiveId !== id) return false;
      if (Date.now() > suppressEnsureActiveUntil) {
        suppressEnsureActiveId = null;
        suppressEnsureActiveUntil = 0;
        return false;
      }
      return true;
    };

    const ensureActiveInTabs = (activeId: string | null) => {
      if (!activeId) return;
      if (isEnsureActiveSuppressed(activeId)) return;
      if (!openIds.includes(activeId)) {
        openIds = [...openIds, activeId];
        persistOpenIds(openIds);
      }
    };

    const closeTab = (id: string) => {
      const idx = openIds.indexOf(id);
      if (idx === -1) return;
      if (openIds.length <= 1) return;
      const nextOpen = openIds.filter(x => x !== id);
      const activeId = window.zion.state.get<string>("sessions.currentId") ?? null;
      const isClosingActive = activeId === id;
      const nextId = isClosingActive
        ? (nextOpen[Math.min(idx, nextOpen.length - 1)] || nextOpen[nextOpen.length - 1] || null)
        : null;
      openIds = nextOpen;
      persistOpenIds(openIds);
      if (isClosingActive) {
        suppressEnsureActiveOnce(id);
        if (nextId) {
          try {
            window.zion.commands.executeCommand("zion.sessions.switch", nextId);
          } catch {}
        }
      }
      requestRender();
    };

    const activateTab = (id: string) => {
      try {
        window.zion.commands.executeCommand("zion.sessions.switch", id);
      } catch {}
    };

    const syncMetaWatchers = () => {
      const keep = new Set(openIds);
      for (const [id, disp] of Array.from(metaDisposables.entries())) {
        if (!keep.has(id)) {
          try {
            disp.dispose();
          } catch {}
          metaDisposables.delete(id);
        }
      }
      for (const id of openIds) {
        if (metaDisposables.has(id)) continue;
        try {
          const d = window.zion.state.onDidChange<any>(`sessions.meta.${id}`, (nv, ov) => {
            const nt = String(nv?.title || "").trim();
            const ot = String(ov?.title || "").trim();
            if (nt !== ot) requestRender();
          });
          metaDisposables.set(id, d);
        } catch {}
      }
    };
    const syncRunWatchers = () => {
      const keep = new Set(openIds);
      for (const [id, disp] of Array.from(runDisposables.entries())) {
        if (!keep.has(id)) {
          try {
            disp.dispose();
          } catch {}
          runDisposables.delete(id);
        }
      }
      for (const id of openIds) {
        if (runDisposables.has(id)) continue;
        try {
          const d = window.zion.state.onDidChange(`chat.runs.${id}`, () => requestRender());
          runDisposables.set(id, d);
        } catch {}
      }
    };

    const getRunBadge = (id: string): "streaming" | "awaiting" | "aborted" | null => {
      try {
        const rs = window.zion.state.get<any>(`chat.runs.${id}`) || null;
        if (!rs) return null;
        if (rs.streaming) return "streaming";
        if (rs.awaiting) return "awaiting";
        if (rs.aborted) return "aborted";
        return null;
      } catch {
        return null;
      }
    };

    const render = () => {
      const activeId = window.zion.state.get<string>("sessions.currentId") ?? null;

      // 每次渲染时都验证 openIds，清理已删除的会话
      validateOpenIds();
      // 使用验证后的 openIds（validateOpenIds 已经更新了 openIds）

      // 如果当前激活的会话不在有效列表中，尝试切换到第一个有效的标签页
      if (activeId && !openIds.includes(activeId) && openIds.length > 0) {
        try {
          window.zion.commands.executeCommand("zion.sessions.switch", openIds[0]);
        } catch {}
        return; // 等待下次渲染
      }

      // 如果没有有效的标签页但当前会话为空，创建新会话
      if (openIds.length === 0 && !activeId) {
        try {
          window.zion.commands.executeCommand("zion.sessions.new");
        } catch {}
        return;
      }

      ensureActiveInTabs(activeId);
      syncMetaWatchers();
      syncRunWatchers();
      const openKey = openIds.join("|");
      try {
        if (openKey !== lastBroadcastOpenKey) {
          lastBroadcastOpenKey = openKey;
          window.zion.state.set("ui.editorTabs.openSessionIds", [...openIds]);
        }
        if (activeId !== lastBroadcastActiveId) {
          lastBroadcastActiveId = activeId;
          window.zion.state.set("ui.editorTabs.activeSessionId", activeId);
        }
      } catch {}
      try {
        (window.zion.window as any).activeSessionId = activeId;
        (window.zion.window as any).getActiveSessionId = () => window.zion.state.get<string>("sessions.currentId") ?? null;
      } catch {}
      const keep = new Set(openIds);
      for (const [id, el] of Array.from(tabNodes.entries())) {
        if (!keep.has(id)) {
          try {
            el.remove();
          } catch {}
          tabNodes.delete(id);
          tabStatusNodes.delete(id);
          tabTitleNodes.delete(id);
        }
      }

      for (const id of openIds) {
        let tabEl = tabNodes.get(id);
        let statusEl = tabStatusNodes.get(id);
        let titleEl = tabTitleNodes.get(id);
        if (!tabEl || !tabEl.isConnected) {
          tabEl = document.createElement("div");
          tabEl.className = "zion-editor-session-tab";
          tabEl.setAttribute("role", "tab");
          tabEl.setAttribute("tabindex", "0");
          tabEl.setAttribute("data-session-id", id);
          tabEl.setAttribute("draggable", "true");

          statusEl = document.createElement("span");
          statusEl.className = "zion-editor-session-tab-status";
          statusEl.setAttribute("aria-hidden", "true");

          titleEl = document.createElement("span");
          titleEl.className = "zion-editor-session-tab-title";

          const closeBtn = document.createElement("button");
          closeBtn.type = "button";
          closeBtn.className = "zion-editor-session-tab-close";
          closeBtn.setAttribute("draggable", "false");
          closeBtn.setAttribute("aria-label", "关闭标签页");
          closeBtn.title = "关闭";
          closeBtn.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';
          closeBtn.onclick = (e) => {
            try {
              e.stopPropagation();
              e.preventDefault();
            } catch {}
            closeTab(id);
          };
          closeBtn.ondragstart = (e) => {
            try {
              e.preventDefault();
              e.stopPropagation();
            } catch {}
            return false;
          };

          tabEl.onclick = () => {
            if (draggingId || Date.now() - lastDragEndAt < 150) return;
            const curActive = window.zion.state.get<string>("sessions.currentId") ?? null;
            if (curActive === id) return;
            activateTab(id);
          };
          tabEl.onauxclick = (e) => {
            try {
              if ((e as any).button === 1) {
                e.preventDefault();
                closeTab(id);
              }
            } catch {}
          };
          tabEl.onkeydown = (e) => {
            const ev = e as KeyboardEvent;
            if (ev.key === "Enter" || ev.key === " ") {
              try {
                ev.preventDefault();
              } catch {}
              const curActive = window.zion.state.get<string>("sessions.currentId") ?? null;
              if (curActive !== id) activateTab(id);
            }
            if (ev.key === "Backspace" || ev.key === "Delete") {
              try {
                ev.preventDefault();
              } catch {}
              closeTab(id);
            }
          };

          tabEl.ondragstart = (e) => {
            const ev = e as DragEvent;
            draggingId = id;
            try {
              tabEl!.classList.add("is-dragging");
            } catch {}
            try {
              ev.dataTransfer?.setData("text/plain", id);
              if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
            } catch {}
          };
          tabEl.ondragend = () => {
            lastDragEndAt = Date.now();
            try {
              tabEl!.classList.remove("is-dragging");
            } catch {}
            draggingId = null;
            clearDropIndicators();
          };
          tabEl.ondragover = (e) => {
            const ev = e as DragEvent;
            if (!draggingId || draggingId === id) return;
            try {
              ev.preventDefault();
            } catch {}
            let pos: "before" | "after" = "after";
            try {
              const rect = tabEl!.getBoundingClientRect();
              pos = ev.clientX < rect.left + rect.width / 2 ? "before" : "after";
            } catch {}
            if (dropTargetId !== id) {
              clearDropIndicators();
              dropTargetId = id;
            }
            if (dropPosition !== pos) {
              dropPosition = pos;
              tabEl!.classList.toggle("is-drop-before", pos === "before");
              tabEl!.classList.toggle("is-drop-after", pos === "after");
            }
          };
          tabEl.ondragleave = () => {
            if (dropTargetId === id) {
              try {
                tabEl!.classList.remove("is-drop-before");
                tabEl!.classList.remove("is-drop-after");
              } catch {}
              dropTargetId = null;
              dropPosition = null;
            }
          };
          tabEl.ondrop = (e) => {
            const ev = e as DragEvent;
            try {
              ev.preventDefault();
              ev.stopPropagation();
            } catch {}
            const src = draggingId || (() => {
              try {
                return ev.dataTransfer?.getData("text/plain") || "";
              } catch {
                return "";
              }
            })();
            const pos = dropPosition || "after";
            clearDropIndicators();
            if (src) reorderTabs(src, id, pos);
          };

          tabEl.appendChild(statusEl);
          tabEl.appendChild(titleEl);
          tabEl.appendChild(closeBtn);

          tabNodes.set(id, tabEl);
          tabStatusNodes.set(id, statusEl);
          tabTitleNodes.set(id, titleEl);
        }

        tabEl.classList.toggle("is-active", activeId === id);
        const badge = getRunBadge(id);
        tabEl.classList.toggle("is-streaming", badge === "streaming");
        tabEl.classList.toggle("is-awaiting", badge === "awaiting");
        tabEl.classList.toggle("is-aborted", badge === "aborted");
        if (statusEl) {
          statusEl.style.display = badge ? "inline-block" : "none";
        }

        const title = getTitleForSession(id);
        if (titleEl && titleEl.textContent !== title) titleEl.textContent = title;
        if (tabEl.title !== title) tabEl.title = title;

        if (tabEl.parentElement !== tabsEl) {
          tabsEl.appendChild(tabEl);
        }
      }
      if (openKey !== lastDomOrderKey) {
        lastDomOrderKey = openKey;
        for (const id of openIds) {
          const el = tabNodes.get(id);
          if (el) tabsEl.appendChild(el);
        }
      }

      try {
        if (isDropdownOpen()) showDropdownMenu();
      } catch {}

      try {
        if (activeId) {
          const activeEl = tabNodes.get(activeId) || tabsEl.querySelector<HTMLElement>(".zion-editor-session-tab.is-active");
          revealTabInStrip(tabsEl, activeEl);
        }
      } catch {}
    };

    try {
      window.zion.commands.registerCommand("zion.editorTabs.closeActiveSession", () => {
        const activeId = window.zion.state.get<string>("sessions.currentId") ?? null;
        if (!activeId) return false;
        closeTab(activeId);
        return true;
      });
      window.zion.commands.registerCommand("zion.editorTabs.nextSessionTab", () => {
        const activeId = window.zion.state.get<string>("sessions.currentId") ?? null;
        if (!activeId) return false;
        const idx = openIds.indexOf(activeId);
        if (idx === -1 || openIds.length <= 1) return false;
        const nextId = openIds[(idx + 1) % openIds.length];
        activateTab(nextId);
        return true;
      });
      window.zion.commands.registerCommand("zion.editorTabs.prevSessionTab", () => {
        const activeId = window.zion.state.get<string>("sessions.currentId") ?? null;
        if (!activeId) return false;
        const idx = openIds.indexOf(activeId);
        if (idx === -1 || openIds.length <= 1) return false;
        const nextId = openIds[(idx - 1 + openIds.length) % openIds.length];
        activateTab(nextId);
        return true;
      });
    } catch {}

    try {
      window.zion.keybindings.register({ command: "zion.sessions.new", key: "Mod-t", when: "editorFocus" });
      window.zion.keybindings.register({ command: "zion.editorTabs.closeActiveSession", key: "Mod-w", when: "editorFocus" });
      window.zion.keybindings.register({ command: "zion.editorTabs.prevSessionTab", key: "Mod-Shift-,", when: "editorFocus" });
      window.zion.keybindings.register({ command: "zion.editorTabs.nextSessionTab", key: "Mod-Shift-.", when: "editorFocus" });
    } catch {}

    try {
      window.zion.state.onDidChange<string>("sessions.currentId", (nv) => {
        const next = nv ?? null;
        if (suppressEnsureActiveId && next !== suppressEnsureActiveId) {
          suppressEnsureActiveId = null;
          suppressEnsureActiveUntil = 0;
        }
        ensureActiveInTabs(next);
        requestRender();
      });
    } catch {}

    try {
      window.zion.state.onDidChange("sessions.catalog", () => {
        // 当会话目录变化时（如删除/新增会话），验证并清理无效的 openIds
        validateOpenIds();
        requestRender();
      });
    } catch {}

    try {
      // 监听树结构变化，确保在会话被删除时也能及时清理标签页
      window.zion.state.onDidChange("sessions.treeMem", () => {
        validateOpenIds();
        requestRender();
      });
    } catch {}

    render();
  } catch {}
}

type EditorHeaderMenuItem = {
  id: string;
  title?: string;
  section?: string;
  order?: number;
  kind?: "action" | "toggle" | "separator";
  command?: string;
  args?: any[];
  onClick?: () => void;
  getChecked?: () => boolean;
};

function getEditorHeaderMenuRegistry() {
  const z = window.zion as any;
  if (z.__editorHeaderMenuRegistry) return z.__editorHeaderMenuRegistry as {
    register: (item: EditorHeaderMenuItem) => Disposable;
    list: () => EditorHeaderMenuItem[];
  };

  const items = new Map<string, EditorHeaderMenuItem>();
  const registry = {
    register(item: EditorHeaderMenuItem): Disposable {
      if (!item || !item.id) return { dispose() {} };
      items.set(item.id, item);
      return { dispose() { items.delete(item.id); } };
    },
    list(): EditorHeaderMenuItem[] {
      return Array.from(items.values()).sort((a, b) => {
        const ao = typeof a.order === "number" ? a.order : 50;
        const bo = typeof b.order === "number" ? b.order : 50;
        if (ao !== bo) return ao - bo;
        return String(a.id).localeCompare(String(b.id));
      });
    }
  };
  z.__editorHeaderMenuRegistry = registry;
  return registry;
}

function mountEditorHeaderSettingsMenu(pathEl: HTMLElement) {
  try {
    const headerEl = pathEl.parentElement;
    if (!headerEl) return;

    const registry = getEditorHeaderMenuRegistry();

    let btn = headerEl.querySelector<HTMLButtonElement>("button[data-zion-editor-settings-menu-button='1']");
    const isNew = !btn;
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
    }

    btn.className = "zion-editor-header-action is-icon zion-editor-settings-menu-button";
    btn.innerHTML = '<span class="codicon codicon-ellipsis" aria-hidden="true"></span>';
    btn.title = "设置";
    btn.setAttribute("aria-label", "设置");
    btn.setAttribute("data-zion-editor-settings-menu-button", "1");
    btn.style.marginRight = "0";

    let menuEl: HTMLDivElement | null = null;
    let cleanup: (() => void) | null = null;
    let collapsedSections: Record<string, boolean> = {};
    const COLLAPSE_KEY = "zion.editorHeaderMenu.collapsedSections";

    const closeMenu = () => {
      try { cleanup?.(); } catch {}
      cleanup = null;
      try { menuEl?.remove(); } catch {}
      menuEl = null;
    };

    const loadCollapsed = () => {
      try {
        const raw = localStorage.getItem(COLLAPSE_KEY);
        if (!raw) return;
        const v = JSON.parse(raw);
        if (v && typeof v === "object") collapsedSections = v;
      } catch {}
    };

    const persistCollapsed = () => {
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedSections)); } catch {}
    };

    const positionMenu = () => {
      if (!menuEl) return;
      const r = btn!.getBoundingClientRect();
      const mw = menuEl.offsetWidth || 200;
      const mh = menuEl.offsetHeight || 120;
      const pad = 8;
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      let left = Math.round(r.right - mw);
      let top = Math.round(r.bottom + 6);
      left = Math.max(pad, Math.min(left, Math.max(pad, vw - mw - pad)));
      if (top + mh + pad > vh) {
        const above = Math.round(r.top - 6 - mh);
        if (above >= pad) top = above;
      }
      top = Math.max(pad, Math.min(top, Math.max(pad, vh - mh - pad)));
      menuEl.style.left = `${left}px`;
      menuEl.style.top = `${top}px`;
    };

    const renderMenu = () => {
      if (!menuEl) return;
      menuEl.innerHTML = "";
      const items = registry.list();
      if (items.length === 0) {
        const row = document.createElement("div");
        row.className = "zion-context-menu-row";
        const it = document.createElement("button");
        it.className = "zion-context-menu-item";
        it.type = "button";
        it.textContent = "暂无设置项";
        it.style.opacity = "0.7";
        it.style.cursor = "default";
        row.appendChild(it);
        menuEl.appendChild(row);
        return;
      }

      const filtered = items.filter(it => it && it.kind !== "separator");

      const groups = new Map<string, EditorHeaderMenuItem[]>();
      for (const it of filtered) {
        const sec = String(it.section || "Other").trim() || "Other";
        if (!groups.has(sec)) groups.set(sec, []);
        groups.get(sec)!.push(it);
      }

      const sectionOrderHint = ["Editor", "Layout", "Chat", "Export", "Other"];
      const sections = Array.from(groups.keys()).sort((a, b) => {
        const ai = sectionOrderHint.indexOf(a);
        const bi = sectionOrderHint.indexOf(b);
        if (ai !== -1 || bi !== -1) {
          if (ai === -1) return 1;
          if (bi === -1) return -1;
          return ai - bi;
        }
        return a.localeCompare(b);
      });

      for (const sec of sections) {
        const secItems = (groups.get(sec) || []).slice().sort((a, b) => {
          const ao = typeof a.order === "number" ? a.order : 50;
          const bo = typeof b.order === "number" ? b.order : 50;
          if (ao !== bo) return ao - bo;
          return String(a.id).localeCompare(String(b.id));
        });

        const collapsed = !!collapsedSections[sec];
        const secRow = document.createElement("div");
        secRow.className = "zion-context-menu-row";
        const secBtn = document.createElement("button");
        secBtn.className = "zion-context-menu-item zion-editor-header-menu-section";
        secBtn.type = "button";
        secBtn.title = sec;
        secBtn.innerHTML = `<span class="zion-editor-header-menu-section-content"><span class="zion-editor-header-menu-chevron codicon ${collapsed ? "codicon-chevron-right" : "codicon-chevron-down"}" aria-hidden="true"></span><span class="zion-editor-header-menu-section-title">${sec}</span></span>`;
        secBtn.onclick = (e) => {
          try { e.stopPropagation(); } catch {}
          collapsedSections[sec] = !collapsed;
          persistCollapsed();
          try { renderMenu(); positionMenu(); } catch {}
        };
        secRow.appendChild(secBtn);
        menuEl.appendChild(secRow);

        if (collapsed) continue;

        for (const item of secItems) {
          const checked = item.kind === "toggle" ? !!item.getChecked?.() : false;

          const row = document.createElement("div");
          row.className = "zion-context-menu-row";
          const it = document.createElement("button");
          it.className = "zion-context-menu-item zion-editor-header-menu-item";
          it.type = "button";

          const label = String(item.title || item.id);
          it.title = label;
          const boxClass =
            item.kind === "toggle"
              ? `is-toggle${checked ? " is-checked" : ""}`
              : "is-placeholder";
          it.innerHTML = `<span class="zion-editor-header-menu-item-content"><span class="zion-editor-header-menu-item-left"><span class="zion-editor-header-menu-item-title">${label}</span></span><span class="zion-editor-header-menu-item-state ${boxClass}"><span class="codicon codicon-check" aria-hidden="true"></span></span></span>`;

          it.onclick = (e) => {
            try { e.stopPropagation(); } catch {}
            try {
              if (typeof item.onClick === "function") item.onClick();
              else if (item.command) window.zion.commands.executeCommand(item.command, ...(Array.isArray(item.args) ? item.args : []));
            } catch {}
            try { renderMenu(); positionMenu(); } catch {}
          };
          row.appendChild(it);
          menuEl.appendChild(row);
        }
      }
    };

    const openMenu = () => {
      if (menuEl) return;
      loadCollapsed();
      const menu = document.createElement("div");
      menu.className = "zion-context-menu zion-editor-header-menu";
      menu.style.position = "fixed";
      menu.style.zIndex = "99999";
      menu.style.maxWidth = "280px";
      menu.style.width = "min(280px, calc(100vw - 16px))";
      menu.style.maxHeight = "70vh";
      menu.style.overflowY = "auto";
      document.body.appendChild(menu);
      menuEl = menu;
      renderMenu();
      positionMenu();

      const escHandler = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") closeMenu();
      };
      const clickAway = (ev: MouseEvent) => {
        try {
          const t = ev.target as Node | null;
          if (!t) return closeMenu();
          if (menuEl && menuEl.contains(t)) return;
          if (btn && btn.contains(t)) return;
          closeMenu();
        } catch {
          closeMenu();
        }
      };
      const resizeHandler = () => {
        try { renderMenu(); positionMenu(); } catch {}
      };

      document.addEventListener("keydown", escHandler);
      document.addEventListener("mousedown", clickAway, true);
      window.addEventListener("resize", resizeHandler, { passive: true });

      cleanup = () => {
        document.removeEventListener("keydown", escHandler);
        document.removeEventListener("mousedown", clickAway, true);
        window.removeEventListener("resize", resizeHandler as any);
      };
    };

    btn.onclick = (e) => {
      try { e.stopPropagation(); } catch {}
      if (menuEl) closeMenu();
      else openMenu();
    };

    if (isNew) {
      headerEl.appendChild(btn);
    }
  } catch {}
}

function mountEditorHeaderSessionRenameButton(pathEl: HTMLElement) {
  try {
    const headerEl = pathEl.parentElement;
    if (!headerEl) return;

    let btn = headerEl.querySelector<HTMLButtonElement>("button[data-zion-editor-session-rename-button='1']");
    const isNew = !btn;
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
    }

    btn.className = "zion-editor-header-action is-icon zion-editor-session-rename-button";
    btn.innerHTML = '<span class="codicon codicon-edit" aria-hidden="true"></span>';
    btn.title = "重命名会话";
    btn.setAttribute("aria-label", "重命名会话");
    btn.setAttribute("data-zion-editor-session-rename-button", "1");

    let menuEl: HTMLDivElement | null = null;
    let cleanup: (() => void) | null = null;

    const closeMenu = () => {
      try { cleanup?.(); } catch {}
      cleanup = null;
      try { menuEl?.remove(); } catch {}
      menuEl = null;
    };

    const positionMenu = () => {
      if (!menuEl) return;
      const r = btn!.getBoundingClientRect();
      const mw = menuEl.offsetWidth || 200;
      const mh = menuEl.offsetHeight || 120;
      const pad = 8;
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      let left = Math.round(r.right - mw);
      let top = Math.round(r.bottom + 6);
      left = Math.max(pad, Math.min(left, Math.max(pad, vw - mw - pad)));
      if (top + mh + pad > vh) {
        const above = Math.round(r.top - 6 - mh);
        if (above >= pad) top = above;
      }
      top = Math.max(pad, Math.min(top, Math.max(pad, vh - mh - pad)));
      menuEl.style.left = `${left}px`;
      menuEl.style.top = `${top}px`;
    };

    const openMenu = () => {
      if (menuEl) return;
      const menu = document.createElement("div");
      menu.className = "zion-context-menu zion-editor-header-session-menu";
      menu.style.position = "fixed";
      menu.style.zIndex = "99999";
      menu.style.minWidth = "180px";
      document.body.appendChild(menu);
      menuEl = menu;

      const addItem = (label: string, onClick: () => void) => {
        const row = document.createElement("div");
        row.className = "zion-context-menu-row";
        const it = document.createElement("button");
        it.className = "zion-context-menu-item";
        it.type = "button";
        it.textContent = label;
        it.onclick = (e) => {
          try { e.stopPropagation(); } catch {}
          try { onClick(); } catch {}
          closeMenu();
        };
        row.appendChild(it);
        menu.appendChild(row);
      };

      addItem("Rename…", () => {
        try { window.zion.commands.executeCommand("zion.sessions.rename"); } catch {}
      });
      addItem("Auto Rename (AI)", () => {
        try { window.zion.commands.executeCommand("zion.sessions.autoRename"); } catch {}
      });

      positionMenu();

      const escHandler = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") closeMenu();
      };
      const clickAway = (ev: MouseEvent) => {
        try {
          const t = ev.target as any;
          if (!t) return closeMenu();
          if (menuEl && menuEl.contains(t)) return;
          if (btn && (btn === t || btn.contains(t))) return;
          closeMenu();
        } catch {
          closeMenu();
        }
      };
      const resizeHandler = () => {
        try { positionMenu(); } catch {}
      };

      document.addEventListener("keydown", escHandler);
      document.addEventListener("mousedown", clickAway, true);
      window.addEventListener("resize", resizeHandler, { passive: true });

      cleanup = () => {
        document.removeEventListener("keydown", escHandler);
        document.removeEventListener("mousedown", clickAway, true);
        window.removeEventListener("resize", resizeHandler as any);
      };
    };

    btn.onclick = (e) => {
      try {
        e.stopPropagation();
        e.preventDefault();
      } catch {}
      if (menuEl) closeMenu();
      else openMenu();
    };

    if (isNew) {
      headerEl.appendChild(btn);
    }
  } catch {}
}

function mountPanelHeaderRunStopButton(pathEl: HTMLElement, panelId: string, getEditor: () => any) {
  try {
    const headerEl = pathEl.parentElement;
    if (!headerEl) return;

    let btn = headerEl.querySelector<HTMLButtonElement>("button[data-zion-core-runstop-button='1']");
    const isNew = !btn;
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
    }

    btn.className = "zion-editor-header-action is-icon zion-editor-chat-runstop-button";
    btn.setAttribute("data-zion-core-runstop-button", "1");
    btn.setAttribute("data-panel-id", panelId);
    btn.setAttribute("aria-label", "Run/Stop");

    const update = () => {
      try {
        const targetSessionId = window.zion?.panels?.list?.().find((p) => p.id === panelId)?.activeTabId
          || window.zion?.state?.get?.("sessions.currentId");
        const streaming = !!window.zion?.chat?.isStreaming?.(targetSessionId || undefined);
        btn!.innerHTML = `<span class="codicon ${streaming ? "codicon-debug-stop" : "codicon-play"}" aria-hidden="true"></span>`;
        btn!.title = streaming ? "Stop (Esc)" : "Run (Mod-Enter)";
        try { btn!.classList.toggle("is-stop", streaming); } catch {}
      } catch {}
    };

    btn.onclick = (e) => {
      try { e.stopPropagation(); } catch {}
      try { window.zion?.panels?.focus?.(panelId); } catch {}
      try {
        const targetSessionId = window.zion?.panels?.list?.().find((p) => p.id === panelId)?.activeTabId
          || window.zion?.state?.get?.("sessions.currentId");
        const streaming = !!window.zion?.chat?.isStreaming?.(targetSessionId || undefined);
        if (streaming) {
          window.zion.chat?.stop?.(targetSessionId || undefined);
          return;
        }
        const ed = getEditor?.() || window.zion?.window?.activeEditor;
        const sel = String(ed?.getSelection?.() || "");
        window.zion.chat?.run?.({
          sessionId: targetSessionId || undefined,
          editor: ed || null,
          useSelection: !!sel.trim()
        });
      } catch {}
    };

    update();

    if (isNew) {
      const settingsBtn = headerEl.querySelector<HTMLButtonElement>("button[data-zion-editor-settings-menu-button='1']");
      if (settingsBtn) headerEl.insertBefore(btn, settingsBtn);
      else headerEl.appendChild(btn);
    }

    try {
      window.zion.state.onDidChange("chat.streaming", update);
      window.zion.state.onDidChange("sessions.currentId", update);
      window.zion.events.on("panel/tabActivated", (payload: any) => {
        if (payload?.panelId === panelId) update();
      });
    } catch {}
  } catch {}
}

function mountPanelSessionTabsBar(containerEl: HTMLElement, panelId: string, panelManager: PanelManager) {
  try {
    let newBtn = containerEl.querySelector<HTMLButtonElement>("button[data-zion-panel-tabs-new-session-button='1']");
    let dropdownBtn = containerEl.querySelector<HTMLButtonElement>("button[data-zion-panel-tabs-dropdown-button='1']");
    let viewport = containerEl.querySelector<HTMLElement>("[data-zion-panel-session-tabs-viewport='1']");
    let root = containerEl.querySelector<HTMLElement>("[data-zion-panel-session-tabs='1']");
    if (!newBtn) {
      newBtn = document.createElement("button");
      newBtn.type = "button";
      newBtn.className = "zion-editor-header-action is-icon zion-editor-tabs-new-session-button";
      newBtn.innerHTML = '<span class="codicon codicon-add" aria-hidden="true"></span>';
      newBtn.title = "新增会话";
      newBtn.setAttribute("aria-label", "新增会话");
      newBtn.setAttribute("data-zion-panel-tabs-new-session-button", "1");
      newBtn.onclick = (e) => {
        try {
          e.stopPropagation();
          e.preventDefault();
        } catch {}
        try { window.zion.panels?.focus?.(panelId); } catch {}
        try { window.zion.commands.executeCommand("zion.sessions.new"); } catch {}
      };
      containerEl.insertBefore(newBtn, containerEl.firstChild);
    }
    if (!root) {
      root = document.createElement("div");
      root.className = "zion-editor-session-tabs";
      root.setAttribute("data-zion-panel-session-tabs", "1");
    }
    if (!viewport) {
      viewport = document.createElement("div");
      viewport.className = "zion-panel-session-tabs-viewport";
      viewport.setAttribute("data-zion-panel-session-tabs-viewport", "1");
      containerEl.appendChild(viewport);
    }
    if (root.parentElement !== viewport) {
      try { viewport.appendChild(root); } catch {}
    }

    let dropdownMenu: HTMLDivElement | null = null;
    const ensureDropdownMenu = () => {
      if (dropdownMenu && dropdownMenu.isConnected) return dropdownMenu;
      dropdownMenu = document.createElement("div");
      dropdownMenu.className = "zion-editor-tabs-menu";
      document.body.appendChild(dropdownMenu);
      return dropdownMenu;
    };
    const hideDropdownMenu = () => {
      if (!dropdownMenu) return;
      dropdownMenu.classList.remove("show");
      dropdownMenu.innerHTML = "";
    };
    const isDropdownOpen = () => !!dropdownMenu?.classList.contains("show");

    if (!dropdownBtn) {
      dropdownBtn = document.createElement("button");
      dropdownBtn.type = "button";
      dropdownBtn.className = "zion-editor-header-action is-icon zion-editor-tabs-dropdown-button";
      dropdownBtn.innerHTML = '<span class="codicon codicon-chevron-down" aria-hidden="true"></span>';
      dropdownBtn.title = "查看当前面板标签页";
      dropdownBtn.setAttribute("aria-label", "查看当前面板标签页");
      dropdownBtn.setAttribute("data-zion-panel-tabs-dropdown-button", "1");
      dropdownBtn.onclick = (e) => {
        try {
          e.stopPropagation();
          e.preventDefault();
        } catch {}
        if (isDropdownOpen()) hideDropdownMenu();
        else showDropdownMenu();
      };
      containerEl.appendChild(dropdownBtn);
    }

    const getTitle = (sessionId: string) => {
      const meta = window.zion.state.get<any>(`sessions.meta.${sessionId}`);
      return String(meta?.title || "").trim() || sessionId;
    };
    const getTabStatus = (sessionId: string): "streaming" | "awaiting" | "failed" | "aborted" | null => {
      try {
        const rs = window.zion.state.get<any>(`chat.runs.${sessionId}`) || null;
        if (!rs) return null;
        if (rs.streaming) return "streaming";
        if (rs.awaiting) return "awaiting";
        if (rs.error) return "failed";
        if (rs.aborted) return "aborted";
        return null;
      } catch {
        return null;
      }
    };
    const getTabStatusText = (sessionId: string) => {
      const status = getTabStatus(sessionId);
      switch (status) {
        case "streaming": return "对话中";
        case "awaiting": return "待查看";
        case "failed": return "失败";
        case "aborted": return "已停止";
        default: return "";
      }
    };
    const syncWatchers = () => {
      const panel = panelManager.getPanel(panelId);
      const tabIds = new Set((panel?.tabs || []).map((tab) => tab.id));
      for (const [id, disp] of Array.from(metaDisposables.entries())) {
        if (!tabIds.has(id)) {
          try { disp.dispose(); } catch {}
          metaDisposables.delete(id);
        }
      }
      for (const [id, disp] of Array.from(runDisposables.entries())) {
        if (!tabIds.has(id)) {
          try { disp.dispose(); } catch {}
          runDisposables.delete(id);
        }
      }
      for (const id of tabIds) {
        if (!metaDisposables.has(id)) {
          try {
            metaDisposables.set(
              id,
              window.zion.state.onDidChange<any>(`sessions.meta.${id}`, (nv, ov) => {
                const nt = String(nv?.title || "").trim();
                const ot = String(ov?.title || "").trim();
                if (nt !== ot) render();
              })
            );
          } catch {}
        }
        if (!runDisposables.has(id)) {
          try {
            runDisposables.set(id, window.zion.state.onDidChange(`chat.runs.${id}`, () => render()));
          } catch {}
        }
      }
    };
    const showDropdownMenu = () => {
      const panel = panelManager.getPanel(panelId);
      if (!panel || !dropdownBtn) return;
      const menu = ensureDropdownMenu();
      menu.innerHTML = "";
      const rect = dropdownBtn.getBoundingClientRect();
      const gap = 6;
      const top = Math.min(window.innerHeight - 10, rect.bottom + gap);
      const left = Math.max(10, Math.min(window.innerWidth - 10, rect.right));
      menu.style.top = `${top}px`;
      menu.style.left = `${left}px`;
      menu.style.right = "auto";
      menu.style.transform = "translateX(-100%)";

      if (panel.tabs.length === 0) {
        const empty = document.createElement("div");
        empty.className = "zion-editor-tabs-menu-empty";
        empty.textContent = "当前面板暂无标签页";
        menu.appendChild(empty);
      } else {
        for (const tab of panel.tabs) {
          const item = document.createElement("div");
          item.className = "zion-editor-tabs-menu-item";
          if (panel.activeTabId === tab.id) item.classList.add("is-active");

          const status = getTabStatus(tab.id);
          const statusEl = document.createElement("span");
          statusEl.className = "zion-editor-tabs-menu-item-status";
          if (status) statusEl.dataset.status = status;

          const label = document.createElement("div");
          label.className = "zion-editor-tabs-menu-item-label";
          const title = getTitle(tab.id);
          label.textContent = title;
          label.title = title;

          const meta = document.createElement("div");
          meta.className = "zion-editor-tabs-menu-item-meta";
          meta.textContent = getTabStatusText(tab.id) || (panel.activeTabId === tab.id ? "当前" : "");

          const actions = document.createElement("div");
          actions.className = "zion-editor-tabs-menu-item-actions";
          const close = document.createElement("button");
          close.type = "button";
          close.className = "zion-editor-tabs-menu-item-close";
          close.title = "关闭";
          close.setAttribute("aria-label", "关闭标签页");
          close.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';
          close.onclick = (e) => {
            try {
              e.stopPropagation();
              e.preventDefault();
            } catch {}
            closeTabInPanel(panelId, tab.id);
            render();
            requestAnimationFrame(() => {
              try {
                const latest = panelManager.getPanel(panelId);
                if (!latest?.tabs?.length) hideDropdownMenu();
                else showDropdownMenu();
              } catch {}
            });
          };
          actions.appendChild(close);

          item.appendChild(statusEl);
          item.appendChild(label);
          item.appendChild(meta);
          item.appendChild(actions);
          item.onclick = () => {
            hideDropdownMenu();
            focusAndActivatePanelTab(panelId, tab.id);
          };
          menu.appendChild(item);
        }
      }
      menu.classList.add("show");
    };

    const metaDisposables = new Map<string, Disposable>();
    const runDisposables = new Map<string, Disposable>();
    let dropTargetId: string | null = null;
    let dropPosition: "before" | "after" | null = null;
    let panelDropSide: PanelDropSide | null = null;
    let lastDragEndAt = 0;

    const emitTabsChanged = (changedPanelId: string) => {
      try { window.zion.events.emit("panel/tabsChanged", { panelId: changedPanelId }); } catch {}
    };
    const syncActivePanelTabsState = (changedPanelId: string) => {
      if (window.zion?.panels?.getActivePanelId?.() !== changedPanelId) return;
      const panel = panelManager.getPanel(changedPanelId);
      if (!panel) return;
      try {
        window.zion.state.set("ui.editorTabs.openSessionIds", panel.tabs.map((tab) => tab.id));
        window.zion.state.set("ui.editorTabs.activeSessionId", panel.activeTabId || null);
      } catch {}
    };
    const closeTabInPanel = (targetPanelId: string, targetTabId: string | null) => {
      if (!targetTabId) return false;
      const current = panelManager.getPanel(targetPanelId);
      if (!current) return false;
      const idx = current.tabs.findIndex((item) => item.id === targetTabId);
      if (idx === -1) return false;
      if (current.tabs.length <= 1) {
        if (panelManager.listPanels().length <= 1) return false;
        panelManager.closePanel(targetPanelId);
        return true;
      }
      const nextTabs = current.tabs.filter((item) => item.id !== targetTabId);
      const wasActive = current.activeTabId === targetTabId;
      current.tabs = nextTabs;
      if (wasActive) {
        const nextId = nextTabs[Math.min(idx, nextTabs.length - 1)]?.id || nextTabs[nextTabs.length - 1]?.id || null;
        current.activeTabId = nextId;
        if (nextId) {
          panelManager.activateTab(targetPanelId, nextId);
          try {
            window.zion.commands.executeCommand("zion.sessions.switch", { id: nextId, panelId: targetPanelId });
          } catch {}
        }
      }
      emitTabsChanged(targetPanelId);
      syncActivePanelTabsState(targetPanelId);
      return true;
    };
    const clearDropIndicators = () => {
      if (!root) return;
      root.classList.remove("is-drop-target");
      hidePanelDropPreview();
      try {
        root.querySelectorAll(".zion-editor-session-tab.is-drop-before, .zion-editor-session-tab.is-drop-after").forEach((node) => {
          node.classList.remove("is-drop-before");
          node.classList.remove("is-drop-after");
        });
      } catch {}
      dropTargetId = null;
      dropPosition = null;
      panelDropSide = null;
    };
    const readDragState = (ev?: DragEvent | null): PanelTabDragState | null => {
      if (panelTabDragState) return panelTabDragState;
      try {
        const raw = ev?.dataTransfer?.getData(PANEL_TAB_DND_MIME) || "";
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const sourcePanelId = String(parsed?.sourcePanelId || "").trim();
        const tabId = String(parsed?.tabId || "").trim();
        if (!sourcePanelId || !tabId) return null;
        return { sourcePanelId, tabId };
      } catch {
        return null;
      }
    };
    const focusAndActivatePanelTab = (targetPanelId: string, sessionId: string | null) => {
      if (!sessionId) return false;
      try { window.zion.panels?.focus?.(targetPanelId); } catch {}
      panelManager.activateTab(targetPanelId, sessionId);
      syncActivePanelTabsState(targetPanelId);
      emitTabsChanged(targetPanelId);
      try {
        window.zion.commands.executeCommand("zion.sessions.switch", { id: sessionId, panelId: targetPanelId });
      } catch {}
      return true;
    };
    const moveTabBetweenPanels = (
      sourcePanelId: string,
      tabId: string,
      targetPanelId: string,
      targetTabId: string | null,
      position: "before" | "after"
    ) => {
      const sourcePanel = panelManager.getPanel(sourcePanelId);
      const targetPanel = panelManager.getPanel(targetPanelId);
      if (!sourcePanel || !targetPanel) return;
      const fromIndex = sourcePanel.tabs.findIndex((tab) => tab.id === tabId);
      if (fromIndex === -1) return;

      if (sourcePanelId === targetPanelId) {
        if (!targetTabId || targetTabId === tabId) return;
        const nextTabs = sourcePanel.tabs.filter((tab) => tab.id !== tabId);
        const targetIndex = nextTabs.findIndex((tab) => tab.id === targetTabId);
        if (targetIndex === -1) return;
        const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
        nextTabs.splice(insertIndex, 0, sourcePanel.tabs[fromIndex]);
        sourcePanel.tabs = nextTabs;
        emitTabsChanged(sourcePanelId);
        syncActivePanelTabsState(sourcePanelId);
        return;
      }

      const movingTab = sourcePanel.tabs[fromIndex];
      const targetTabs = targetPanel.tabs.filter((tab) => tab.id !== tabId);
      let insertIndex = targetTabs.length;
      if (targetTabId) {
        const targetIndex = targetTabs.findIndex((tab) => tab.id === targetTabId);
        if (targetIndex !== -1) insertIndex = position === "before" ? targetIndex : targetIndex + 1;
      }
      insertIndex = Math.max(0, Math.min(insertIndex, targetTabs.length));
      targetTabs.splice(insertIndex, 0, movingTab);
      targetPanel.tabs = targetTabs;
      targetPanel.activeTabId = tabId;
      emitTabsChanged(targetPanelId);

      if (sourcePanel.tabs.length <= 1) {
        if (panelManager.listPanels().length > 1) {
          panelManager.closePanel(sourcePanelId);
        } else {
          sourcePanel.tabs = [];
          sourcePanel.activeTabId = null;
          emitTabsChanged(sourcePanelId);
          syncActivePanelTabsState(sourcePanelId);
        }
      } else {
        const nextTabs = sourcePanel.tabs.filter((tab) => tab.id !== tabId);
        sourcePanel.tabs = nextTabs;
        let nextSourceId: string | null = null;
        if (sourcePanel.activeTabId === tabId) {
          nextSourceId = nextTabs[Math.min(fromIndex, nextTabs.length - 1)]?.id || nextTabs[nextTabs.length - 1]?.id || null;
          sourcePanel.activeTabId = nextSourceId;
          if (nextSourceId) {
            panelManager.activateTab(sourcePanelId, nextSourceId);
            try {
              window.zion.commands.executeCommand("zion.sessions.switch", { id: nextSourceId, panelId: sourcePanelId });
            } catch {}
          }
        }
        emitTabsChanged(sourcePanelId);
        syncActivePanelTabsState(sourcePanelId);
      }

      focusAndActivatePanelTab(targetPanelId, tabId);
    };
    const performPanelDrop = (
      drag: PanelTabDragState,
      targetPanelId: string,
      side: PanelDropSide,
      targetTabId: string | null = null,
      position: "before" | "after" = "after"
    ) => {
      if (side === "center") {
        moveTabBetweenPanels(drag.sourcePanelId, drag.tabId, targetPanelId, targetTabId, position);
        return;
      }
      const created = panelManager.splitPanelAt(targetPanelId, side, { seedFromSource: false });
      const createdPanelId = created?.id || null;
      if (!createdPanelId) return;
      moveTabBetweenPanels(drag.sourcePanelId, drag.tabId, createdPanelId, null, "after");
    };

    const panelRootEl = panelManager.getPanel(panelId)?.rootEl || null;
    if (panelRootEl && !panelRootEl.dataset.zionPanelSplitDropBound) {
      panelRootEl.dataset.zionPanelSplitDropBound = "1";
      panelRootEl.ondragover = (e) => {
        const ev = e as DragEvent;
        const drag = readDragState(ev);
        if (!drag) return;
        const target = ev.target as HTMLElement | null;
        if (target && panelRootEl.querySelector("[data-zion-panel-session-tabs='1']")?.contains(target)) return;
        try {
          ev.preventDefault();
          if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
        } catch {}
        const rect = panelRootEl.getBoundingClientRect();
        const side = getPanelDropSideFromPoint(rect, ev.clientX, ev.clientY);
        panelDropSide = side;
        showPanelDropPreview(rect, side);
        root?.classList.remove("is-drop-target");
      };
      panelRootEl.ondragleave = (e) => {
        const next = e.relatedTarget as Node | null;
        if (next && panelRootEl.contains(next)) return;
        clearDropIndicators();
      };
      panelRootEl.ondrop = (e) => {
        const ev = e as DragEvent;
        const target = ev.target as HTMLElement | null;
        if (target && panelRootEl.querySelector("[data-zion-panel-session-tabs='1']")?.contains(target)) return;
        try {
          ev.preventDefault();
          ev.stopPropagation();
        } catch {}
        const drag = readDragState(ev);
        const side = panelDropSide || "center";
        clearDropIndicators();
        if (!drag) return;
        performPanelDrop(drag, panelId, side);
      };
    }

    root.ondragover = (e) => {
      const ev = e as DragEvent;
      const drag = readDragState(ev);
      if (!drag) return;
      const targetTabEl = (ev.target as HTMLElement | null)?.closest?.(".zion-editor-session-tab");
      if (targetTabEl) {
        root!.classList.remove("is-drop-target");
        return;
      }
      try {
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      } catch {}
      clearDropIndicators();
      root!.classList.add("is-drop-target");
    };
    root.ondragleave = (e) => {
      const next = e.relatedTarget as Node | null;
      if (next && root?.contains(next)) return;
      clearDropIndicators();
    };
    root.ondrop = (e) => {
      const ev = e as DragEvent;
      const targetTabEl = (ev.target as HTMLElement | null)?.closest?.(".zion-editor-session-tab");
      if (targetTabEl) return;
      try {
        ev.preventDefault();
        ev.stopPropagation();
      } catch {}
      const drag = readDragState(ev);
      clearDropIndicators();
      if (!drag) return;
      performPanelDrop(drag, panelId, "center");
    };
    root.onwheel = (e) => {
      const ev = e as WheelEvent;
      if (!root) return;
      if (root.scrollWidth <= root.clientWidth + 1) return;
      if (ev.ctrlKey) return;
      const horizontalGesture = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) + 0.5;
      if (horizontalGesture) return;
      const scale = ev.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : ev.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? root.clientWidth
          : 1;
      const delta = ev.deltaY * scale * 2.2;
      if (Math.abs(delta) < 1) return;
      try { ev.preventDefault(); } catch {}
      try {
        root.scrollBy({ left: delta, behavior: "auto" });
      } catch {
        root.scrollLeft += delta;
      }
    };

    try {
      if (!containerEl.dataset.zionPanelTabsDropdownBound) {
        containerEl.dataset.zionPanelTabsDropdownBound = "1";
        window.addEventListener("resize", hideDropdownMenu);
        window.addEventListener(
          "scroll",
          (e) => {
            const t = (e as any)?.target as any;
            if (dropdownMenu && (t === dropdownMenu || dropdownMenu.contains(t))) return;
            hideDropdownMenu();
          },
          true
        );
        window.addEventListener("keydown", (e) => {
          const ev = e as KeyboardEvent;
          if (ev.key === "Escape") hideDropdownMenu();
        });
        window.addEventListener("mousedown", (e) => {
          const t = e.target as any;
          if (dropdownBtn && (dropdownBtn === t || dropdownBtn.contains(t))) return;
          if (dropdownMenu && (dropdownMenu === t || dropdownMenu.contains(t))) return;
          hideDropdownMenu();
        });
      }
    } catch {}

    const render = (opts?: { revealActiveTab?: boolean }) => {
      const panel = panelManager.getPanel(panelId);
      if (!panel || !root) return;
      const shouldRevealActiveTab = !!opts?.revealActiveTab;
      syncWatchers();
      root.innerHTML = "";
      if (dropdownBtn) {
        dropdownBtn.style.display = panel.tabs.length > 0 ? "" : "none";
        dropdownBtn.title = `查看当前面板标签页 (${panel.tabs.length})`;
      }
      for (const tab of panel.tabs) {
        const tabEl = document.createElement("div");
        tabEl.className = "zion-editor-session-tab";
        if (tab.id === panel.activeTabId) tabEl.classList.add("is-active");
        tabEl.setAttribute("role", "tab");
        tabEl.setAttribute("tabindex", "0");
        tabEl.setAttribute("data-session-id", tab.id);
        tabEl.setAttribute("draggable", "true");

        const titleEl = document.createElement("span");
        titleEl.className = "zion-editor-session-tab-title";
        titleEl.textContent = getTitle(tab.id);
        const status = getTabStatus(tab.id);
        const statusText = getTabStatusText(tab.id);
        titleEl.title = statusText ? `${getTitle(tab.id)} · ${statusText}` : getTitle(tab.id);

        const statusEl = document.createElement("span");
        statusEl.className = "zion-editor-session-tab-status";
        statusEl.setAttribute("aria-hidden", "true");
        statusEl.style.display = status ? "inline-block" : "none";
        if (statusText) statusEl.title = statusText;

        tabEl.classList.toggle("is-streaming", status === "streaming");
        tabEl.classList.toggle("is-awaiting", status === "awaiting");
        tabEl.classList.toggle("is-failed", status === "failed");
        tabEl.classList.toggle("is-aborted", status === "aborted");

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "zion-editor-session-tab-close";
        closeBtn.setAttribute("draggable", "false");
        closeBtn.setAttribute("aria-label", "关闭标签页");
        closeBtn.title = "关闭";
        closeBtn.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';
        closeBtn.onclick = (e) => {
          try {
            e.stopPropagation();
            e.preventDefault();
          } catch {}
          closeTabInPanel(panelId, tab.id);
        };
        closeBtn.ondragstart = (e) => {
          try {
            e.preventDefault();
            e.stopPropagation();
          } catch {}
          return false;
        };

        tabEl.onclick = () => {
          if (panelTabDragState || Date.now() - lastDragEndAt < 150) return;
          focusAndActivatePanelTab(panelId, tab.id);
        };
        tabEl.ondragstart = (e) => {
          const ev = e as DragEvent;
          panelTabDragState = { sourcePanelId: panelId, tabId: tab.id };
          try {
            tabEl.classList.add("is-dragging");
            ev.dataTransfer?.setData(PANEL_TAB_DND_MIME, JSON.stringify(panelTabDragState));
            ev.dataTransfer?.setData("text/plain", tab.id);
            if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
          } catch {}
        };
        tabEl.ondragend = () => {
          lastDragEndAt = Date.now();
          panelTabDragState = null;
          try { tabEl.classList.remove("is-dragging"); } catch {}
          clearDropIndicators();
        };
        tabEl.ondragover = (e) => {
          const ev = e as DragEvent;
          const drag = readDragState(ev);
          if (!drag || (drag.sourcePanelId === panelId && drag.tabId === tab.id)) return;
          try {
            ev.preventDefault();
            if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
          } catch {}
          root.classList.remove("is-drop-target");
          const rect = tabEl.getBoundingClientRect();
          const pos: "before" | "after" = ev.clientX < rect.left + rect.width / 2 ? "before" : "after";
          if (dropTargetId !== tab.id || dropPosition !== pos) {
            clearDropIndicators();
            dropTargetId = tab.id;
            dropPosition = pos;
            tabEl.classList.toggle("is-drop-before", pos === "before");
            tabEl.classList.toggle("is-drop-after", pos === "after");
          }
        };
        tabEl.ondragleave = (e) => {
          const next = e.relatedTarget as Node | null;
          if (next && tabEl.contains(next)) return;
          if (dropTargetId === tab.id) clearDropIndicators();
        };
        tabEl.ondrop = (e) => {
          const ev = e as DragEvent;
          try {
            ev.preventDefault();
            ev.stopPropagation();
          } catch {}
          const drag = readDragState(ev);
          const pos = dropPosition || "after";
          clearDropIndicators();
          if (!drag) return;
          performPanelDrop(drag, panelId, "center", tab.id, pos);
        };

        tabEl.appendChild(statusEl);
        tabEl.appendChild(titleEl);
        tabEl.appendChild(closeBtn);
        root.appendChild(tabEl);
      }
      requestAnimationFrame(() => {
        try {
          if (shouldRevealActiveTab) {
            const viewportEl = containerEl.querySelector<HTMLElement>("[data-zion-panel-session-tabs-viewport='1']");
            const activeTabEl = root?.querySelector<HTMLElement>(".zion-editor-session-tab.is-active");
            if (viewportEl && activeTabEl) {
              const viewRect = viewportEl.getBoundingClientRect();
              const tabRect = activeTabEl.getBoundingClientRect();
              const needsReveal = tabRect.left < viewRect.left || tabRect.right > viewRect.right;
              if (needsReveal) {
                revealTabInStrip(root, activeTabEl);
              }
            }
          }
        } catch {}
        try {
          const viewportEl = containerEl.querySelector<HTMLElement>("[data-zion-panel-session-tabs-viewport='1']");
          if (viewportEl) {
            const xScrollable = root.scrollWidth > root.clientWidth + 1;
            viewportEl.classList.toggle("is-x-scroll", xScrollable);
          }
        } catch {}
        // #region debug-point panel-tabs-vertical-centering
        try {
          const viewportEl =
            containerEl.querySelector<HTMLElement>("[data-zion-panel-session-tabs-viewport='1']") ||
            containerEl.querySelector<HTMLElement>("[data-zion-editor-session-tabs-viewport='1']");
          const tabsBarEl = containerEl.closest(".zion-editor-tabsbar") as HTMLElement | null;
          const rootEl = root as HTMLElement;
          const getNum = (v: string | null) => {
            const n = v ? Number(String(v).replace("px", "").trim()) : NaN;
            return Number.isFinite(n) ? n : null;
          };
          const cssScrollbar = getComputedStyle(document.documentElement).getPropertyValue("--ui-scrollbar-size") || null;
          const rootCS = getComputedStyle(rootEl);
          const vpCS = viewportEl ? getComputedStyle(viewportEl) : null;
          const rRect = rootEl.getBoundingClientRect();
          const vRect = viewportEl ? viewportEl.getBoundingClientRect() : null;
          const bRect = tabsBarEl ? tabsBarEl.getBoundingClientRect() : null;
          fetch("http://127.0.0.1:7777/event", {
            method: "POST",
            body: JSON.stringify({
              sessionId: "panel-tabs-vertical-centering",
              runId: "pre-fix",
              hypothesisId: "measure-layout",
              location: "src/main.ts:mountPanelSessionTabsBar:render:raf",
              msg: "[DEBUG] panel tabs layout metrics",
              data: {
                panelId,
                tabCount: panel.tabs.length,
                hasHorizontalOverflow: rootEl.scrollWidth > rootEl.clientWidth + 1,
                cssScrollbarSize: cssScrollbar ? cssScrollbar.trim() : null,
                cssScrollbarSizeNum: getNum(cssScrollbar),
                tabsBar: bRect
                  ? { h: bRect.height, top: bRect.top, bottom: bRect.bottom }
                  : null,
                viewport: viewportEl && vRect
                  ? {
                      h: vRect.height,
                      top: vRect.top,
                      bottom: vRect.bottom,
                      clientH: viewportEl.clientHeight,
                      offsetH: viewportEl.offsetHeight,
                      paddingTop: vpCS ? vpCS.paddingTop : null,
                      paddingBottom: vpCS ? vpCS.paddingBottom : null,
                      overflow: vpCS ? `${vpCS.overflowX}/${vpCS.overflowY}` : null
                    }
                  : null,
                root: {
                  h: rRect.height,
                  top: rRect.top,
                  bottom: rRect.bottom,
                  clientH: rootEl.clientHeight,
                  offsetH: rootEl.offsetHeight,
                  scrollH: rootEl.scrollHeight,
                  scrollW: rootEl.scrollWidth,
                  clientW: rootEl.clientWidth,
                  paddingTop: rootCS.paddingTop,
                  paddingBottom: rootCS.paddingBottom,
                  boxSizing: rootCS.boxSizing,
                  alignItems: rootCS.alignItems,
                  lineHeight: rootCS.lineHeight
                }
              },
              ts: Date.now()
            })
          }).catch(() => {});
        } catch {}
        // #endregion
        try {
          if (isDropdownOpen()) showDropdownMenu();
        } catch {}
      });
    };

    render();
    try {
      window.zion.events.on("panel/tabActivated", (payload: any) => {
        if (payload?.panelId === panelId) render({ revealActiveTab: true });
      });
      window.zion.events.on("panel/tabsChanged", (payload: any) => {
        if (payload?.panelId === panelId) render({ revealActiveTab: true });
      });
      window.zion.state.onDidChange("sessions.catalog", render);
      window.zion.state.onDidChange("sessions.currentId", () => {
        if (window.zion?.panels?.getActivePanelId?.() === panelId) render();
      });
    } catch {}
  } catch {}
}

async function bootstrap() {
  const host = document.getElementById("app")!;
  host.innerHTML = "";

  // Measure native scrollbar thickness (0 on overlay-scrollbar systems).
  // We use this to keep tab content vertically centered even when a horizontal
  // scrollbar would otherwise consume layout height.
  try {
    const probe = document.createElement("div");
    probe.style.position = "absolute";
    probe.style.top = "-9999px";
    probe.style.left = "-9999px";
    probe.style.width = "120px";
    probe.style.height = "120px";
    probe.style.overflow = "scroll";
    document.body.appendChild(probe);
    const sbw = probe.offsetWidth - probe.clientWidth;
    const sbh = probe.offsetHeight - probe.clientHeight;
    probe.remove();
    const size = Math.max(0, Math.max(sbw, sbh));
    document.documentElement.style.setProperty("--ui-scrollbar-size", `${size}px`);
  } catch {}

  const wb = initWorkbench(host);
  const editorContainer = wb.editorHost;
  const editorHeaderPathEl = wb.editorHeaderPathEl;
  const editorTabsBarEl = wb.editorTabsBarEl;
  const editorHeaderEl = editorHeaderPathEl.parentElement as HTMLElement;
  const editorAreaEl = editorContainer.parentElement as HTMLElement;

  const panelsHost = document.createElement("div");
  panelsHost.className = "zion-panels-root";
  const primaryPanelRoot = document.createElement("div");
  primaryPanelRoot.className = "zion-panel";
  primaryPanelRoot.dataset.panelId = "panel-0";
  primaryPanelRoot.appendChild(editorTabsBarEl);
  primaryPanelRoot.appendChild(editorHeaderEl);
  primaryPanelRoot.appendChild(editorContainer);
  panelsHost.appendChild(primaryPanelRoot);
  editorAreaEl.appendChild(panelsHost);

  const initialSessionId = window.zion.state.get<string>("sessions.currentId") || null;
  const panelCores = new Map<string, EditorCore>();
  const panelManager = new PanelManager({
    host: panelsHost,
    initialPanel: {
      id: "panel-0",
      tabs: initialSessionId ? [{ id: initialSessionId, title: initialSessionId, isDirty: false }] : [],
      activeTabId: initialSessionId,
      editor: null,
      rootEl: primaryPanelRoot,
      tabsBarEl: editorTabsBarEl,
      headerEl: editorHeaderEl,
      pathEl: editorHeaderPathEl,
      editorHostEl: editorContainer
    },
    createPanelDom: createPanelDomShell,
    emit: (event, payload) => {
      try { window.zion.events.emit(event, payload); } catch {}
    }
  });

  window.zion.panels = {
    getActivePanelId: () => panelManager.getActivePanelId(),
    list: () => panelManager.listPanels().map((panel) => ({ id: panel.id, activeTabId: panel.activeTabId })),
    findAtSide: (side: "left" | "right" | "up" | "down", panelId?: string) => panelManager.findPanelAtSide(panelId, side),
    ensureAtSide: (side: "left" | "right" | "up" | "down", panelId?: string) => {
      const existing = panelManager.findPanelAtSide(panelId, side);
      return existing || panelManager.splitPanelAt(panelId, side)?.id || null;
    },
    openSession: (panelId: string, sessionId: string, opts?: { focus?: boolean }) => openSessionInPanel(panelId, sessionId, opts),
    split: (direction: "horizontal" | "vertical", panelId?: string) => panelManager.splitPanel(panelId, direction)?.id || null,
    splitAt: (side: "left" | "right" | "up" | "down", panelId?: string) => panelManager.splitPanelAt(panelId, side)?.id || null,
    focus: (panelId: string) => panelManager.focusPanel(panelId),
    close: (panelId?: string) => panelManager.closePanel(panelId),
    getEditor: (panelId: string) => panelManager.getEditor(panelId)
  };
  (window.zion as any).panelManager = panelManager;
  const sessionSync = new SessionSync({
    events: window.zion.events,
    getActivePanelId: () => panelManager.getActivePanelId(),
    listPanels: () => panelManager.listPanels().map((panel) => ({ id: panel.id, activeTabId: panel.activeTabId })),
    getEditor: (panelId: string) => panelManager.getEditor(panelId)
  });

  // 初始化插件管理器
  const pluginManager = new PluginManager({
    pluginDir: '/plugins',
    logLevel: 'info'
  });

  // 优先读缓存，没有再给默认
  const cached = loadLastDoc();
  const savedPanelWorkspace = loadPanelWorkspaceSnapshot();
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

  const core = new EditorCore(editorContainer, initialDoc, "panel-0");
  panelCores.set("panel-0", core);
  const initialProxy = attachEditor(core, "panel-0");
  panelManager.setPanelEditor("panel-0", initialProxy);
  setActiveEditorPanel("panel-0");
  let suspendSessionCurrentSync = false;
  const panelScrollPersistDisposers = new Map<string, () => void>();
  panelManager.on("panel/focusChanged", ({ panelId }) => {
    setActiveEditorPanel(panelId);
  });
  const syncLegacyEditorTabsState = (panelId: string | null) => {
    if (!panelId) return;
    const panel = panelManager.getPanel(panelId);
    if (!panel) return;
    try {
      window.zion.state.set("ui.editorTabs.openSessionIds", panel.tabs.map((tab) => tab.id));
      window.zion.state.set("ui.editorTabs.activeSessionId", panel.activeTabId || null);
    } catch {}
  };
  const getActivePanelTabContext = () => {
    const panelId = panelManager.getActivePanelId();
    if (!panelId) return null;
    const panel = panelManager.getPanel(panelId);
    if (!panel) return null;
    const activeTabId = panel.activeTabId || panel.tabs[0]?.id || null;
    return { panelId, panel, activeTabId };
  };
  const openSessionInPanel = (panelId: string, sessionId: string | null, opts?: { focus?: boolean }) => {
    if (!sessionId) return false;
    const panel = panelManager.getPanel(panelId);
    if (!panel) return false;
    const exists = panel.tabs.some((tab) => tab.id === sessionId);
    if (!exists) {
      panel.tabs = [...panel.tabs, { id: sessionId, title: sessionId, isDirty: false }];
    }
    if (opts?.focus !== false) {
      try { panelManager.focusPanel(panelId); } catch {}
    }
    return activatePanelSession(panelId, sessionId);
  };
  const activatePanelSession = (panelId: string, sessionId: string | null) => {
    if (!sessionId) return false;
    panelManager.activateTab(panelId, sessionId);
    syncLegacyEditorTabsState(panelId);
    try {
      window.zion.commands.executeCommand("zion.sessions.switch", { id: sessionId, panelId });
    } catch {}
    return true;
  };
  const restoreSplitViewportFromSource = (sourceEditor: any, targetEditor: any) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        const sourceView = sourceEditor?.getView?.();
        const targetView = targetEditor?.getView?.();
        if (!sourceView || !targetView) return;
        const mainSel = sourceView.state?.selection?.main;
        if (mainSel && typeof mainSel.anchor === "number" && typeof mainSel.head === "number") {
          targetView.dispatch({ selection: { anchor: mainSel.anchor, head: mainSel.head } });
        }
        const sourceScroller = sourceView.scrollDOM;
        const targetScroller = targetView.scrollDOM;
        if (sourceScroller && targetScroller) {
          targetScroller.scrollTop = Math.max(0, sourceScroller.scrollTop || 0);
          targetScroller.scrollLeft = Math.max(0, sourceScroller.scrollLeft || 0);
        }
      } catch {}
    }));
  };
  const capturePanelViewStates = () => {
    const out: Record<string, { scrollTop: number; scrollLeft: number; selectionAnchor: number; selectionHead: number }> = {};
    try {
      for (const panel of panelManager.listPanels()) {
        const view = panelManager.getEditor(panel.id)?.getView?.();
        const scrollDOM = view?.scrollDOM;
        const sel = view?.state?.selection?.main;
        if (!view?.state?.doc || !scrollDOM || !sel) continue;
        out[panel.id] = {
          scrollTop: typeof scrollDOM.scrollTop === "number" ? scrollDOM.scrollTop : 0,
          scrollLeft: typeof scrollDOM.scrollLeft === "number" ? scrollDOM.scrollLeft : 0,
          selectionAnchor: typeof sel.anchor === "number" ? sel.anchor : 0,
          selectionHead: typeof sel.head === "number" ? sel.head : 0
        };
      }
    } catch {}
    return out;
  };
  const restorePanelViewState = (panelId: string, viewState: any) => {
    try {
      const view = panelManager.getEditor(panelId)?.getView?.();
      if (!view?.state?.doc) return;
      const docLen = view.state.doc.length;
      const anchor =
        typeof viewState?.selectionAnchor === "number"
          ? Math.max(0, Math.min(docLen, viewState.selectionAnchor))
          : null;
      const head =
        typeof viewState?.selectionHead === "number"
          ? Math.max(0, Math.min(docLen, viewState.selectionHead))
          : anchor;
      if (anchor != null && head != null) {
        view.dispatch({ selection: { anchor, head } });
      }
      if (view.scrollDOM) {
        view.scrollDOM.scrollTop = Math.max(0, Number(viewState?.scrollTop) || 0);
        view.scrollDOM.scrollLeft = Math.max(0, Number(viewState?.scrollLeft) || 0);
      }
    } catch {}
  };
  const buildPanelWorkspaceSnapshot = () => ({
    version: 1,
    savedAt: Date.now(),
    manager: panelManager.snapshotState(),
    viewStates: capturePanelViewStates()
  });
  const schedulePanelWorkspacePersist = () => {
    try { savePanelWorkspaceSnapshot(buildPanelWorkspaceSnapshot()); } catch {}
  };
  const attachPanelScrollPersistence = (panelId: string) => {
    try { panelScrollPersistDisposers.get(panelId)?.(); } catch {}
    panelScrollPersistDisposers.delete(panelId);
    requestAnimationFrame(() => {
      try {
        const scrollDOM = panelManager.getEditor(panelId)?.getView?.()?.scrollDOM;
        if (!scrollDOM) return;
        const onScroll = () => schedulePanelWorkspacePersist();
        scrollDOM.addEventListener("scroll", onScroll, { passive: true });
        panelScrollPersistDisposers.set(panelId, () => {
          try { scrollDOM.removeEventListener("scroll", onScroll); } catch {}
        });
      } catch {}
    });
  };
  const restorePanelWorkspaceWhenReady = (attempt = 0) => {
    if (!savedPanelWorkspace?.manager) return;
    const commands = window.zion?.commands?.list?.() || [];
    if (!commands.includes("zion.sessions.switch")) {
      if (attempt >= 80) return;
      window.setTimeout(() => restorePanelWorkspaceWhenReady(attempt + 1), 125);
      return;
    }
    suspendSessionCurrentSync = true;
    const restored = panelManager.restoreState(savedPanelWorkspace.manager);
    if (!restored) {
      suspendSessionCurrentSync = false;
      return;
    }
    for (const panel of panelManager.listPanels()) {
      try { window.zion.events.emit("panel/tabsChanged", { panelId: panel.id }); } catch {}
    }
    const runRestore = async () => {
      try {
        for (const panel of panelManager.listPanels()) {
          if (!panel.activeTabId) continue;
          await Promise.resolve(
            window.zion.commands.executeCommand("zion.sessions.switch", {
              id: panel.activeTabId,
              panelId: panel.id,
              writeUrl: false,
              pushUrl: false
            })
          );
        }
        const finalActivePanelId =
          typeof savedPanelWorkspace?.manager?.activePanelId === "string"
            ? savedPanelWorkspace.manager.activePanelId
            : panelManager.getActivePanelId();
        const finalPanel = finalActivePanelId ? panelManager.getPanel(finalActivePanelId) : null;
        if (finalActivePanelId && finalPanel?.activeTabId) {
          await Promise.resolve(
            window.zion.commands.executeCommand("zion.sessions.switch", {
              id: finalPanel.activeTabId,
              panelId: finalActivePanelId,
              writeUrl: false,
              pushUrl: false
            })
          );
        }
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try {
            const viewStates = savedPanelWorkspace?.viewStates || {};
            for (const panel of panelManager.listPanels()) {
              restorePanelViewState(panel.id, viewStates[panel.id]);
            }
            if (finalActivePanelId) {
              panelManager.focusPanel(finalActivePanelId);
              setActiveEditorPanel(finalActivePanelId);
              syncLegacyEditorTabsState(finalActivePanelId);
              try { panelManager.getEditor(finalActivePanelId)?.focus?.(); } catch {}
            }
          } finally {
            suspendSessionCurrentSync = false;
            schedulePanelWorkspacePersist();
          }
        }));
      } catch {
        suspendSessionCurrentSync = false;
      }
    };
    void runRestore();
  };
  const closePanelSessionTab = (panelId: string, tabId: string | null) => {
    if (!tabId) return false;
    const panel = panelManager.getPanel(panelId);
    if (!panel) return false;
    const idx = panel.tabs.findIndex((tab) => tab.id === tabId);
    if (idx === -1) return false;
    if (panel.tabs.length <= 1) {
      if (panelManager.listPanels().length <= 1) return false;
      panelManager.closePanel(panelId);
      const nextPanelId = panelManager.getActivePanelId();
      if (!nextPanelId) return true;
      syncLegacyEditorTabsState(nextPanelId);
      const nextPanel = panelManager.getPanel(nextPanelId);
      return activatePanelSession(nextPanelId, nextPanel?.activeTabId || nextPanel?.tabs[0]?.id || null) || true;
    }
    const nextTabs = panel.tabs.filter((tab) => tab.id !== tabId);
    const wasActive = panel.activeTabId === tabId;
    panel.tabs = nextTabs;
    const nextId = wasActive
      ? (nextTabs[Math.min(idx, nextTabs.length - 1)]?.id || nextTabs[nextTabs.length - 1]?.id || null)
      : (panel.activeTabId || nextTabs[0]?.id || null);
    panel.activeTabId = nextId;
    syncLegacyEditorTabsState(panelId);
    try { window.zion.events.emit("panel/tabsChanged", { panelId }); } catch {}
    return !wasActive || !nextId ? true : activatePanelSession(panelId, nextId);
  };
  try {
    window.zion.commands.registerCommand("zion.editorTabs.closeActiveSession", () => {
      const ctx = getActivePanelTabContext();
      if (!ctx?.activeTabId) return false;
      return closePanelSessionTab(ctx.panelId, ctx.activeTabId);
    });
    window.zion.commands.registerCommand("zion.editorTabs.nextSessionTab", () => {
      const ctx = getActivePanelTabContext();
      if (!ctx?.activeTabId) return false;
      const { panelId, panel, activeTabId } = ctx;
      if (panel.tabs.length <= 1) return false;
      const idx = panel.tabs.findIndex((tab) => tab.id === activeTabId);
      if (idx === -1) return false;
      const nextId = panel.tabs[(idx + 1) % panel.tabs.length]?.id || null;
      if (!nextId) return false;
      return activatePanelSession(panelId, nextId);
    });
    window.zion.commands.registerCommand("zion.editorTabs.prevSessionTab", () => {
      const ctx = getActivePanelTabContext();
      if (!ctx?.activeTabId) return false;
      const { panelId, panel, activeTabId } = ctx;
      if (panel.tabs.length <= 1) return false;
      const idx = panel.tabs.findIndex((tab) => tab.id === activeTabId);
      if (idx === -1) return false;
      const nextId = panel.tabs[(idx - 1 + panel.tabs.length) % panel.tabs.length]?.id || null;
      if (!nextId) return false;
      return activatePanelSession(panelId, nextId);
    });
  } catch {}
  try {
    window.zion.state.onDidChange<string>("sessions.currentId", (sessionId) => {
      if (suspendSessionCurrentSync) return;
      const activePanelId = panelManager.getActivePanelId();
      if (!activePanelId) return;
      const panel = panelManager.getPanel(activePanelId);
      if (!panel || !sessionId) return;
      const exists = panel.tabs.some((tab) => tab.id === sessionId);
      if (!exists) {
        panel.tabs = [...panel.tabs, { id: sessionId, title: sessionId, isDirty: false }];
      }
      panelManager.activateTab(activePanelId, sessionId);
      syncLegacyEditorTabsState(activePanelId);
      schedulePanelWorkspacePersist();
    });
  } catch {}
  panelManager.on("panel/created", ({ panelId, sourcePanelId, seedFromSource }) => {
    const panel = panelManager.getPanel(panelId);
    if (!panel) return;
    try {
      panel.editorHostEl.innerHTML = "";
    } catch {}
    const sourceEditor = sourcePanelId ? panelManager.getEditor(sourcePanelId) : null;
    const sourceSessionId = sourcePanelId ? panelManager.getPanel(sourcePanelId)?.activeTabId || null : null;
    const seedText = sourceEditor?.getValue?.() || core.getValue();
    const nextCore = new EditorCore(panel.editorHostEl, seedText, panelId);
    panelCores.set(panelId, nextCore);
    const nextProxy = attachEditor(nextCore, panelId);
    panelManager.setPanelEditor(panelId, nextProxy);
    try { applyEditorPreferences(nextCore); } catch {}
    const activeSessionId = seedFromSource === false
      ? null
      : (sourceSessionId || window.zion.state.get<string>("sessions.currentId") || null);
    if (activeSessionId) {
      panel.tabs = [{ id: activeSessionId, title: activeSessionId, isDirty: false }];
      panel.activeTabId = activeSessionId;
      panelManager.activateTab(panelId, activeSessionId);
    }
    mountCurrentSessionPath(panel.pathEl, panelId);
    mountPanelSessionTabsBar(panel.tabsBarEl, panelId, panelManager);
    mountEditorHeaderTOCButton(panel.pathEl);
    mountEditorHeaderSessionRenameButton(panel.pathEl);
    mountEditorHeaderSettingsMenu(panel.pathEl);
    mountPanelHeaderRunStopButton(panel.pathEl, panelId, () => panelManager.getEditor(panelId));
    attachPanelScrollPersistence(panelId);
    if (activeSessionId) {
      requestAnimationFrame(() => {
        try {
          const ann = (window.zion?.state?.get(`sessions.annotations.${activeSessionId}`) || {}) as any;
          const meta = window.zion?.commands?.executeCommand?.("zion.sessions.getMeta", activeSessionId) as any;
          const metaAnn = (meta?.annotations || {}) as any;
          const pendingTools = window.zion?.state?.get(`sessions.pendingRestore.tools.${activeSessionId}`);
          const pendingThinking = window.zion?.state?.get(`sessions.pendingRestore.thinking.${activeSessionId}`);
          const tools = Array.isArray(ann.tools) && ann.tools.length
            ? ann.tools
            : (Array.isArray(metaAnn.tools) && metaAnn.tools.length
              ? metaAnn.tools
              : (Array.isArray(pendingTools) ? pendingTools : []));
          const thinking = Array.isArray(ann.thinking) && ann.thinking.length
            ? ann.thinking
            : (Array.isArray(metaAnn.thinking) && metaAnn.thinking.length
              ? metaAnn.thinking
              : (Array.isArray(pendingThinking) ? pendingThinking : []));
          if (tools.length) {
            try { window.zion?.state?.set(`sessions.pendingRestore.tools.${activeSessionId}`, tools); } catch {}
            try { window.zion?.events?.emit("toolcards/restore", { items: tools, panelId }); } catch {}
          }
          if (thinking.length) {
            try { window.zion?.state?.set(`sessions.pendingRestore.thinking.${activeSessionId}`, thinking); } catch {}
            try { window.zion?.events?.emit("thinking/restore", { items: thinking, panelId }); } catch {}
          }
        } catch {}
      });
    }
    try { nextProxy.focus(); } catch {}
    try { restoreSplitViewportFromSource(sourceEditor, nextProxy); } catch {}
    schedulePanelWorkspacePersist();
  });
  panelManager.on("panel/closed", ({ panelId }) => {
    const closingCore = panelCores.get(panelId);
    try { panelScrollPersistDisposers.get(panelId)?.(); } catch {}
    panelScrollPersistDisposers.delete(panelId);
    try { detachEditor(panelId); } catch {}
    try { closingCore?.dispose?.(); } catch {}
    panelCores.delete(panelId);
    const nextActive = panelManager.getActivePanelId();
    setActiveEditorPanel(nextActive);
    schedulePanelWorkspacePersist();
  });
  attachPanelScrollPersistence("panel-0");
  panelManager.on("panel/layoutChanged", () => schedulePanelWorkspacePersist());
  panelManager.on("panel/tabActivated", () => schedulePanelWorkspacePersist());
  panelManager.on("panel/focusChanged", () => schedulePanelWorkspacePersist());
  try {
    window.zion.events.on("panel/tabsChanged", () => schedulePanelWorkspacePersist());
    window.zion.events.on("editor.cursorActivity", () => schedulePanelWorkspacePersist());
  } catch {}
  try {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) schedulePanelWorkspacePersist();
    });
    window.addEventListener("pagehide", () => schedulePanelWorkspacePersist(), { passive: true });
  } catch {}
  try {
    window.addEventListener("beforeunload", () => sessionSync.dispose(), { once: true });
  } catch {}
  mountCurrentSessionPath(editorHeaderPathEl, "panel-0");
  mountPanelSessionTabsBar(editorTabsBarEl, "panel-0", panelManager);
  mountEditorHeaderTOCButton(editorHeaderPathEl);
  mountEditorHeaderSessionRenameButton(editorHeaderPathEl);
  mountEditorHeaderSettingsMenu(editorHeaderPathEl);
  mountPanelHeaderRunStopButton(editorHeaderPathEl, "panel-0", () => panelManager.getEditor("panel-0"));
  restorePanelWorkspaceWhenReady();

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
    try { core.setTheme(t); } catch {}
    try {
      for (const [panelId, targetCore] of panelCores.entries()) {
        if (panelId === "panel-0" || targetCore === core) continue;
        try { targetCore.setTheme(t); } catch {}
      }
    } catch {}
    window.zion.state.set("ui.theme", t);
    try {
      const ensureMeta = () => {
        let meta = document.querySelector('meta[name="theme-color"]');
        if (!meta) {
          meta = document.createElement("meta");
          meta.setAttribute("name", "theme-color");
          document.head.appendChild(meta);
        }
        return meta;
      };
      const updateThemeColor = () => {
        try {
          const meta = ensureMeta();
          const cs = getComputedStyle(document.documentElement);
          const panel = String(cs.getPropertyValue("--panel") || "").trim();
          const fallback = t === "light" ? "#ffffff" : "#282a36";
          meta.setAttribute("content", panel || fallback);
        } catch {}
      };
      updateThemeColor();
      requestAnimationFrame(updateThemeColor);
    } catch {}
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
  window.zion.commands.registerCommand("zion.panels.splitHorizontal", () => panelManager.splitPanel(undefined, "horizontal"));
  window.zion.commands.registerCommand("zion.panels.splitVertical", () => panelManager.splitPanel(undefined, "vertical"));
  window.zion.commands.registerCommand("zion.panels.closeActive", () => panelManager.closePanel());
  const focusPanelInDirection = (direction: "left" | "right" | "up" | "down") => {
    const activeId = panelManager.getActivePanelId();
    if (!activeId) return false;
    const activePanel = panelManager.getPanel(activeId);
    if (!activePanel) return false;
    const activeRect = activePanel.rootEl.getBoundingClientRect();
    const activeCx = activeRect.left + activeRect.width / 2;
    const activeCy = activeRect.top + activeRect.height / 2;
    const strictGapTolerance = 8;
    const candidates = panelManager.listPanels().flatMap((panel) => {
      if (panel.id === activeId) return [];
      const rect = panel.rootEl.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const overlapX = Math.max(0, Math.min(activeRect.right, rect.right) - Math.max(activeRect.left, rect.left));
      const overlapY = Math.max(0, Math.min(activeRect.bottom, rect.bottom) - Math.max(activeRect.top, rect.top));
      let strict = false;
      let primary = 0;
      let secondary = 0;
      let aligned = 0;
      if (direction === "left") {
        if (rect.right <= activeRect.left + strictGapTolerance && overlapY > 0) {
          strict = true;
          primary = Math.max(0, activeRect.left - rect.right);
        } else if (cx < activeCx - 1) {
          primary = activeCx - cx;
        } else {
          return [];
        }
        secondary = Math.abs(cy - activeCy);
        aligned = overlapY;
      } else if (direction === "right") {
        if (rect.left >= activeRect.right - strictGapTolerance && overlapY > 0) {
          strict = true;
          primary = Math.max(0, rect.left - activeRect.right);
        } else if (cx > activeCx + 1) {
          primary = cx - activeCx;
        } else {
          return [];
        }
        secondary = Math.abs(cy - activeCy);
        aligned = overlapY;
      } else if (direction === "up") {
        if (rect.bottom <= activeRect.top + strictGapTolerance && overlapX > 0) {
          strict = true;
          primary = Math.max(0, activeRect.top - rect.bottom);
        } else if (cy < activeCy - 1) {
          primary = activeCy - cy;
        } else {
          return [];
        }
        secondary = Math.abs(cx - activeCx);
        aligned = overlapX;
      } else {
        if (rect.top >= activeRect.bottom - strictGapTolerance && overlapX > 0) {
          strict = true;
          primary = Math.max(0, rect.top - activeRect.bottom);
        } else if (cy > activeCy + 1) {
          primary = cy - activeCy;
        } else {
          return [];
        }
        secondary = Math.abs(cx - activeCx);
        aligned = overlapX;
      }
      const misalignedPenalty = strict ? 0 : aligned > 0 ? 500000 : 1000000;
      const score = misalignedPenalty + primary * 10000 + secondary - aligned;
      return [{ id: panel.id, score, strict }];
    });
    const strictCandidates = candidates.filter((item) => item.strict);
    const pool = strictCandidates.length ? strictCandidates : candidates;
    let best: { id: string; score: number } | null = null;
    for (const candidate of pool) {
      if (!best || candidate.score < best.score) best = candidate;
    }
    if (!best) return false;
    panelManager.focusPanel(best.id);
    try { panelManager.getEditor(best.id)?.focus?.(); } catch {}
    return true;
  };
  const focusPanelByIndex = (index: number) => {
    const panels = panelManager.listPanels();
    const target = panels[Math.max(0, Math.min(index, panels.length - 1))];
    if (target) panelManager.focusPanel(target.id);
  };
  window.zion.commands.registerCommand("zion.panels.focusPanel1", () => focusPanelByIndex(0));
  window.zion.commands.registerCommand("zion.panels.focusPanel2", () => focusPanelByIndex(1));
  window.zion.commands.registerCommand("zion.panels.focusPanel3", () => focusPanelByIndex(2));
  window.zion.commands.registerCommand("zion.panels.focusLeft", () => focusPanelInDirection("left"));
  window.zion.commands.registerCommand("zion.panels.focusRight", () => focusPanelInDirection("right"));
  window.zion.commands.registerCommand("zion.panels.focusUp", () => focusPanelInDirection("up"));
  window.zion.commands.registerCommand("zion.panels.focusDown", () => focusPanelInDirection("down"));
  window.zion.commands.registerCommand("zion.panels.focusNext", () => {
    const panels = panelManager.listPanels();
    if (panels.length <= 1) return;
    const activeId = panelManager.getActivePanelId();
    const idx = panels.findIndex(p => p.id === activeId);
    const next = panels[(idx + 1) % panels.length];
    if (next) panelManager.focusPanel(next.id);
  });
  window.zion.commands.registerCommand("zion.panels.focusPrev", () => {
    const panels = panelManager.listPanels();
    if (panels.length <= 1) return;
    const activeId = panelManager.getActivePanelId();
    const idx = panels.findIndex(p => p.id === activeId);
    const prev = panels[(idx - 1 + panels.length) % panels.length];
    if (prev) panelManager.focusPanel(prev.id);
  });

  try {
    window.zion.keybindings.register({ command: "zion.panels.splitHorizontal", key: "Mod-\\", when: "editorFocus" });
    window.zion.keybindings.register({ command: "zion.panels.splitVertical", key: "Mod-Shift-\\", when: "editorFocus" });
    window.zion.keybindings.register({ command: "zion.panels.closeActive", key: "Mod-Alt-w", when: "editorFocus" });
    window.zion.keybindings.register({ command: "zion.panels.focusPanel1", key: "Mod-Alt-1", when: "editorFocus" });
    window.zion.keybindings.register({ command: "zion.panels.focusPanel2", key: "Mod-Alt-2", when: "editorFocus" });
    window.zion.keybindings.register({ command: "zion.panels.focusPanel3", key: "Mod-Alt-3", when: "editorFocus" });
    window.zion.keybindings.register({ command: "zion.panels.focusLeft", key: "Mod-Alt-ArrowLeft", when: "editorFocus" });
    window.zion.keybindings.register({ command: "zion.panels.focusRight", key: "Mod-Alt-ArrowRight", when: "editorFocus" });
    window.zion.keybindings.register({ command: "zion.panels.focusUp", key: "Mod-Alt-ArrowUp", when: "editorFocus" });
    window.zion.keybindings.register({ command: "zion.panels.focusDown", key: "Mod-Alt-ArrowDown", when: "editorFocus" });
    window.zion.keybindings.register({ command: "zion.panels.focusNext", key: "Mod-Alt-ArrowRight", when: "editorFocus" });
    window.zion.keybindings.register({ command: "zion.panels.focusPrev", key: "Mod-Alt-ArrowLeft", when: "editorFocus" });
  } catch {}

  try {
    const isEditorShortcutContext = (ev: KeyboardEvent) => {
      if (!window.zion?.window?.activeEditor) return false;
      const target = ev.target as HTMLElement | null;
      const appEl = document.getElementById("app");
      const inCodeMirror = !!target?.closest?.(".cm-editor");
      if (inCodeMirror) return true;
      const tag = String(target?.tagName || "").toUpperCase();
      const isPlainInput =
        !!target &&
        !inCodeMirror &&
        (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!target.isContentEditable);
      if (isPlainInput) return false;
      if (!target || target === document.body || target === document.documentElement) return true;
      if (target.closest?.(".zion-panel")) return true;
      return !!appEl && appEl.contains(target);
    };
    const handleEditorShortcut = (ev: KeyboardEvent, command: string) => {
      ev.preventDefault();
      ev.stopPropagation();
      try { (ev as any).stopImmediatePropagation?.(); } catch {}
      try { window.zion.commands.executeCommand(command); } catch {}
    };
    const onGlobalEditorShortcut = (e: Event) => {
      const ev = e as KeyboardEvent;
      if (ev.defaultPrevented || !isEditorShortcutContext(ev)) return;
      const mod = ev.metaKey || ev.ctrlKey;
      if (!mod) return;
      const key = String(ev.key || "").toLowerCase();
      const code = String(ev.code || "");
      if (!ev.altKey && !ev.shiftKey && (key === "t" || code === "KeyT")) return handleEditorShortcut(ev, "zion.sessions.new");
      if (!ev.altKey && !ev.shiftKey && (key === "w" || code === "KeyW")) return handleEditorShortcut(ev, "zion.editorTabs.closeActiveSession");
      if (!ev.altKey && ev.shiftKey && (code === "Comma" || key === "<")) return handleEditorShortcut(ev, "zion.editorTabs.prevSessionTab");
      if (!ev.altKey && ev.shiftKey && (code === "Period" || key === ">")) return handleEditorShortcut(ev, "zion.editorTabs.nextSessionTab");
      if (ev.altKey && !ev.shiftKey && code === "ArrowLeft") return handleEditorShortcut(ev, "zion.panels.focusLeft");
      if (ev.altKey && !ev.shiftKey && code === "ArrowRight") return handleEditorShortcut(ev, "zion.panels.focusRight");
      if (ev.altKey && !ev.shiftKey && code === "ArrowUp") return handleEditorShortcut(ev, "zion.panels.focusUp");
      if (ev.altKey && !ev.shiftKey && code === "ArrowDown") return handleEditorShortcut(ev, "zion.panels.focusDown");
      if (!ev.altKey && !ev.shiftKey && code === "Backslash") return handleEditorShortcut(ev, "zion.panels.splitHorizontal");
      if (!ev.altKey && ev.shiftKey && code === "Backslash") return handleEditorShortcut(ev, "zion.panels.splitVertical");
      if (ev.altKey && !ev.shiftKey && (key === "w" || code === "KeyW")) return handleEditorShortcut(ev, "zion.panels.closeActive");
      if (ev.altKey && !ev.shiftKey && (key === "1" || code === "Digit1")) return handleEditorShortcut(ev, "zion.panels.focusPanel1");
      if (ev.altKey && !ev.shiftKey && (key === "2" || code === "Digit2")) return handleEditorShortcut(ev, "zion.panels.focusPanel2");
      if (ev.altKey && !ev.shiftKey && (key === "3" || code === "Digit3")) return handleEditorShortcut(ev, "zion.panels.focusPanel3");
    };
    window.addEventListener("keydown", onGlobalEditorShortcut, true);
    document.addEventListener("keydown", onGlobalEditorShortcut, true);
  } catch {}

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
    forEachPanelCore((targetCore) => targetCore.setWysiwygEnabled(enabled));
    window.zion.state.set("ui.wysiwyg", enabled);
  };

  window.zion.commands.registerCommand("zion.setWysiwyg", (enabled: boolean) => applyWysiwyg(!!enabled));
  window.zion.commands.registerCommand("zion.toggleWysiwyg", () => applyWysiwyg(!wysiwygEnabled));
  applyWysiwyg(wysiwygEnabled);
  try {
    const reg = getEditorHeaderMenuRegistry();
    reg.register({
      id: "core.wysiwyg.headerMenu",
      title: "WYSIWYG",
      section: "Editor",
      order: 16,
      kind: "toggle",
      getChecked: () => !!window.zion.state.get("ui.wysiwyg"),
      onClick: () => window.zion.commands.executeCommand("zion.toggleWysiwyg")
    });
  } catch {}

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

  function forEachPanelCore(fn: (targetCore: EditorCore) => void) {
    try { fn(core); } catch {}
    try {
      for (const [panelId, targetCore] of panelCores.entries()) {
        if (panelId === "panel-0" || targetCore === core) continue;
        try { fn(targetCore); } catch {}
      }
    } catch {}
  }

  const applyLineNumbers = (enabled: boolean) => {
    lineNumbersEnabled = enabled;
    try { localStorage.setItem("zion.lineNumbers", enabled ? "1" : "0"); } catch {}
    forEachPanelCore((targetCore) => targetCore.setLineNumbersEnabled(enabled));
    window.zion.state.set("ui.lineNumbers", enabled);
  };

  const applyActiveLineHighlight = (enabled: boolean) => {
    activeLineHighlightEnabled = enabled;
    try { localStorage.setItem("zion.activeLineHighlight", enabled ? "1" : "0"); } catch {}
    forEachPanelCore((targetCore) => targetCore.setActiveLineHighlightEnabled(enabled));
    window.zion.state.set("ui.activeLineHighlight", enabled);
  };

  const applySyntaxHighlight = (enabled: boolean) => {
    syntaxHighlightEnabled = enabled;
    try { localStorage.setItem("zion.syntaxHighlight", enabled ? "1" : "0"); } catch {}
    forEachPanelCore((targetCore) => targetCore.setSyntaxHighlightEnabled(enabled));
    window.zion.state.set("ui.syntaxHighlight", enabled);
  };

  const applyAutoIndent = (enabled: boolean) => {
    autoIndentEnabled = enabled;
    try { localStorage.setItem("zion.autoIndent", enabled ? "1" : "0"); } catch {}
    forEachPanelCore((targetCore) => targetCore.setAutoIndentEnabled(enabled));
    window.zion.state.set("ui.autoIndent", enabled);
  };

  const applyFolding = (enabled: boolean) => {
    foldingEnabled = enabled;
    try { localStorage.setItem("zion.folding", enabled ? "1" : "0"); } catch {}
    forEachPanelCore((targetCore) => targetCore.setFoldingEnabled(enabled));
    window.zion.state.set("ui.folding", enabled);
  };

  const applyLineWrap = (enabled: boolean) => {
    lineWrapEnabled = enabled;
    try { localStorage.setItem("zion.lineWrap", enabled ? "1" : "0"); } catch {}
    forEachPanelCore((targetCore) => targetCore.setLineWrapEnabled(enabled));
    window.zion.state.set("ui.lineWrap", enabled);
  };

  function applyEditorPreferences(targetCore: EditorCore) {
    targetCore.setTheme(currentTheme);
    targetCore.setWysiwygEnabled(wysiwygEnabled);
    targetCore.setLineNumbersEnabled(lineNumbersEnabled);
    targetCore.setActiveLineHighlightEnabled(activeLineHighlightEnabled);
    targetCore.setSyntaxHighlightEnabled(syntaxHighlightEnabled);
    targetCore.setAutoIndentEnabled(autoIndentEnabled);
    targetCore.setFoldingEnabled(foldingEnabled);
    targetCore.setLineWrapEnabled(lineWrapEnabled);
    targetCore.setMinimapEnabled(!!window.zion.state.get("ui.minimapEnabled"));
    targetCore.setSelectionHighlightEnabled(!!window.zion.state.get("ui.selectionHighlight"));
  }

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
            "- 点击顶部右侧按钮打开/关闭\n" +
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

  } catch {}

  try {
    window.zion.commands.registerCommand("auxiliaryBar.show", () => window.zion.auxiliaryBar?.show());
    window.zion.commands.registerCommand("auxiliaryBar.hide", () => window.zion.auxiliaryBar?.hide());
    window.zion.commands.registerCommand("auxiliaryBar.toggle", () => window.zion.auxiliaryBar?.toggle());
  } catch {}

  try {
    window.zion.auxiliaryBar?.registerView({
      id: "core.context",
      pluginId: "core",
      title: "Context",
      icon: "🧩",
      order: 10,
      component: {
        render: (container: HTMLElement) => {
          const wrap = document.createElement("div");
          wrap.style.padding = "10px";
          wrap.style.fontSize = "12px";
          wrap.style.whiteSpace = "pre-wrap";
          wrap.style.lineHeight = "1.5";
          wrap.textContent =
            "Auxiliary Bar 已启用。\n\n" +
            "可以：\n" +
            "- 点击顶部右侧按钮打开/关闭\n" +
            "- 拖拽右侧边栏左侧的细条调整宽度\n" +
            "- Cmd/Ctrl + K 打开命令台，搜索 auxiliaryBar.toggle\n";
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

  } catch {}

  try {
    const focusFirstFocusable = (root: Element | null): boolean => {
      if (!root) return false;
      const candidates = Array.from(
        root.querySelectorAll<HTMLElement>(
          'textarea, input, select, button, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
        )
      );
      for (const el of candidates) {
        try {
          const disabled = (el as any).disabled;
          if (disabled) continue;
          const r = el.getBoundingClientRect();
          if (!r || r.width <= 0 || r.height <= 0) continue;
          el.focus();
          if (document.activeElement === el) return true;
        } catch {}
      }
      try {
        const h = root as HTMLElement;
        if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1");
        h.focus();
        return document.activeElement === h;
      } catch {}
      return false;
    };

    const focusWithRetry = (selector: string) => {
      let tries = 0;
      const tick = () => {
        tries += 1;
        const root = document.querySelector(selector);
        if (focusFirstFocusable(root)) return;
        if (tries < 12) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    window.zion.statusBar.registerItem({
      id: "core.bottompanel.toggle",
      text: "$(layout-panel)",
      tooltip: "Toggle Bottom Panel",
      onClick: () => {
        const st = window.zion.state;
        const wasVisible = !!st?.get?.("ui.bottomPanel.visible");
        window.zion.bottomPanel?.toggle();
        if (!wasVisible) focusWithRetry(".zion-bottompanel");
      },
      priority: 95,
      align: "right"
    });
    window.zion.statusBar.registerItem({
      id: "core.auxbar.toggle",
      text: "$(layout-sidebar-right)",
      tooltip: "Toggle Auxiliary Bar",
      onClick: () => {
        const st = window.zion.state;
        const wasVisible = !!st?.get?.("ui.auxiliaryBar.visible");
        window.zion.auxiliaryBar?.toggle();
        if (!wasVisible) focusWithRetry(".zion-auxbar");
      },
      priority: 94,
      align: "right"
    });
  } catch {}

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
      mLnCol.className = "bottombar-metric bottombar-metric-lncol";
      mBefore.className = "bottombar-metric bottombar-metric-before";
      mTotal.className = "bottombar-metric bottombar-metric-total";
      right.appendChild(mLnCol);
      right.appendChild(mBefore);
      right.appendChild(mTotal);

      let maxLnDigits = 1;
      let maxColDigits = 1;
      let maxPosDigits = 1;
      let maxTotalDigits = 1;

      const getMetricsView = () => {
        try {
          const activePanelId = window.zion?.panels?.getActivePanelId?.();
          if (activePanelId) {
            const panelEditor = window.zion?.panels?.getEditor?.(activePanelId);
            const panelView = panelEditor?.getView?.();
            if (panelView?.state?.doc) return panelView;
          }
        } catch {}
        try {
          return core.view;
        } catch {}
        return null;
      };

      const updateMetrics = () => {
        try {
          const view = getMetricsView();
          if (!view?.state?.doc) return;
          const doc = view.state.doc;
          const head = view.state.selection.main.head;
          const line = doc.lineAt(head);
          const ln = line.number;
          const col = head - line.from + 1;
          const before = head;
          const total = doc.length;

          maxLnDigits = Math.max(maxLnDigits, String(doc.lines).length, String(ln).length);
          maxColDigits = Math.max(maxColDigits, String(col).length);
          maxPosDigits = Math.max(maxPosDigits, String(before).length);
          maxTotalDigits = Math.max(maxTotalDigits, String(total).length);

          const lnStr = String(ln).padStart(maxLnDigits, " ");
          const colStr = String(col).padStart(maxColDigits, " ");
          const beforeStr = String(before).padStart(maxPosDigits, " ");
          const totalStr = String(total).padStart(maxTotalDigits, " ");

          mLnCol.textContent = `Ln ${lnStr}, Col ${colStr}`;
          mBefore.textContent = `Before ${beforeStr}`;
          mTotal.textContent = `Total ${totalStr}`;
        } catch {}
      };

      updateMetrics();
      (window as any).zion.events.on("editor.cursorActivity", updateMetrics);
      (window as any).zion.events.on("editor.change", updateMetrics);
      (window as any).zion.events.on("panel/focusChanged", updateMetrics);
      (window as any).zion.events.on("panel/tabActivated", updateMetrics);
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
