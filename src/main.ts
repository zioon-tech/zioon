import "katex/dist/katex.min.css";
// Vite: eagerly bundle extension CSS (extracted from src/styles.css)
import.meta.glob(["/extensions/**/styles.css", "!/extensions/dev.identity/styles.css"], { eager: true });
import { EditorCore, type VimOperationalMode } from "./editor/EditorCore";
import "./pwa-test";
import { attachEditor, detachEditor, listAttachedEditorCores, setActiveEditorPanel } from "./ext/registry";
import type { Disposable } from "./types/zion";
import { PluginManager } from "./plugin/manager";
import { HttpPluginInstaller } from "./plugin/http-installer";
import type { PluginInfo } from "./plugin/types";
import { notificationManager } from "./notification/manager";
import { initWorkbench } from "./ui/workbench/workbench";
import { initCommandPalette } from "./ui/workbench/commandPalette";
import { installZionIcons, zionIconHtml } from "./ui/icons";
import { reconcileKeyedElements } from "./ui/keyed-elements";
import { createRunLogViewDefinition } from "./ui/run-log-view";
import { DEFAULT_BASE_URL, initServiceBaseUrlConfig } from "./settings/serviceBaseUrl";
import { PanelManager, SessionSync, createPanelDomShell } from "./panel";
import { createChatAnnotationsApi } from "./chat/annotations";
import { parseMessages } from "./chat/doc";
import { SessionRuntime } from "./session/runtime";
import { publishSessionDerivedTagSource, removeSessionDerivedTagSource } from "./session/derived-tags";
import { createThemeManager } from "./theme/themeManager";
import { createI18nManager } from "./i18n/i18nManager";
import { EditorState, Prec, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { foldGutter, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { selectionMatchHighlighter } from "./editor/extensions/selection-match-layer";
import { tags as cmTags } from "@lezer/highlight";

installZionIcons();

// ---------- 自动保存 / 恢复 ----------
const STORAGE_KEY = 'zion.autosave';
const PANEL_WORKSPACE_STORAGE_KEY = "zion.panelWorkspace.v1";
const EDITOR_PATH_RENAME_FALLBACK_KEY = "__fallback__";
const EXTERNALIZED_BUILTIN_PLUGIN_IDS = new Set<string>([
  "dev.identity"
]);
const editorPathInlineRenameHandlers = new Map<string, (opts?: any) => boolean>();

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

function clearPersistedActiveSession() {
  try { localStorage.removeItem("zion.sessions.lastActiveId"); } catch {}
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("zionSession");
    url.searchParams.delete("session");
    window.history.replaceState({ ...(window.history.state || {}), zionSessionId: null }, "", url.toString());
  } catch {}
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

function savePanelWorkspaceSnapshotNow(snapshot: any) {
  if (panelWorkspaceSaveTimer) {
    try { cancelIdleCallback(panelWorkspaceSaveTimer); } catch {}
    panelWorkspaceSaveTimer = 0;
  }
  try {
    localStorage.setItem(PANEL_WORKSPACE_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {}
}

function isEmptyPanelWorkspaceSnapshot(snapshot: any): boolean {
  const panels = Array.isArray(snapshot?.manager?.panels) ? snapshot.manager.panels : null;
  return !!panels && panels.length > 0 && panels.every((panel: any) => !Array.isArray(panel?.tabs) || panel.tabs.length === 0);
}


function getPanelActiveSessionId(panelId?: string | null): string | null {
  if (!panelId) return null;
  try {
    const id = window.zion?.panels?.list?.().find((panel) => panel.id === panelId)?.activeTabId || null;
    return isFilePanelTabId(id) ? null : id;
  } catch {
    return null;
  }
}

function isFilePanelTabId(id?: string | null): boolean {
  return typeof id === "string" && id.startsWith("file:");
}

function languageFromFilename(name?: string | null): string {
  const ext = String(name || "").toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    md: "markdown",
    py: "python",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    css: "css",
    html: "html",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    rb: "ruby",
    php: "php",
    sql: "sql"
  };
  return map[ext] || "text";
}

function createChangesLikeHighlightStyle(dark: boolean): HighlightStyle {
  const colors = dark
    ? {
        keyword: "#ff7b72",
        string: "#a5d6ff",
        number: "#79c0ff",
        comment: "#8b949e",
        functionName: "#d2a8ff",
        property: "#79c0ff",
        typeName: "#ffa657",
        tag: "#7ee787",
        punctuation: "var(--muted-fg, rgba(127,127,127,0.9))"
      }
    : {
        keyword: "#cf222e",
        string: "#0a3069",
        number: "#0550ae",
        comment: "#6e7781",
        functionName: "#8250df",
        property: "#0550ae",
        typeName: "#953800",
        tag: "#116329",
        punctuation: "var(--muted-fg, rgba(127,127,127,0.9))"
      };
  return HighlightStyle.define([
    { tag: cmTags.keyword, color: colors.keyword },
    { tag: [cmTags.string, cmTags.special(cmTags.string)], color: colors.string },
    { tag: [cmTags.number, cmTags.bool, cmTags.null], color: colors.number },
    { tag: cmTags.comment, color: colors.comment, fontStyle: "italic" },
    { tag: [cmTags.function(cmTags.variableName), cmTags.function(cmTags.propertyName)], color: colors.functionName },
    { tag: cmTags.propertyName, color: colors.property },
    { tag: [cmTags.typeName, cmTags.className], color: colors.typeName },
    { tag: cmTags.tagName, color: colors.tag },
    { tag: [cmTags.punctuation, cmTags.bracket, cmTags.operator], color: colors.punctuation }
  ]);
}

function createFileCodeViewer(parent: HTMLElement, content: string, meta: any): EditorView {
  const filename = String(meta?.title || meta?.path || meta?.displayPath || "");
  const languageName = String(meta?.language || languageFromFilename(filename) || "text");
  const dark = document.documentElement.getAttribute("data-theme") !== "light";
  const view = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        foldGutter(),
        selectionMatchHighlighter(),
        EditorView.lineWrapping,
        Prec.high(keymap.of(defaultKeymap)),
        syntaxHighlighting(createChangesLikeHighlightStyle(dark), { fallback: true }),
        EditorView.theme({
          "&": {
            height: "100%",
            backgroundColor: "var(--editor-bg)"
          },
          ".cm-scroller": {
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            lineHeight: "1.5"
          },
          ".cm-content": {
            padding: "0"
          },
          ".cm-line": {
            padding: "2px 12px 2px 7px"
          },
          ".cm-gutters": {
            backgroundColor: "var(--editor-bg)",
            borderRight: "0"
          },
          ".cm-lineNumbers .cm-gutterElement": {
            padding: "2px 6px 2px 2px",
            color: "var(--muted-fg, rgba(127,127,127,0.9))"
          },
          ".cm-foldGutter .cm-gutterElement": {
            padding: "2px 4px",
            color: "var(--muted-fg, rgba(127,127,127,0.9))"
          },
          ".cm-activeLine": {
            backgroundColor: "color-mix(in srgb, var(--accent) 8%, transparent)"
          },
          ".cm-activeLineGutter": {
            backgroundColor: "color-mix(in srgb, var(--accent) 8%, transparent)"
          }
        }),
        ...initialFileLanguageExtensions(languageName, filename)
      ]
    }),
    parent
  });
  void loadCodeMirrorLanguage(languageName, filename).then((extension) => {
    if (!extension) return;
    try {
      view.dispatch({ effects: StateEffect.appendConfig.of(extension) });
    } catch {}
  });
  return view;
}

function initialFileLanguageExtensions(languageName: string, filename: string): Extension[] {
  const lang = languageName.toLowerCase();
  const name = filename.toLowerCase();
  if (lang === "json" || name.endsWith(".json")) return [json()];
  if (lang === "markdown" || name.endsWith(".md") || name.endsWith(".markdown")) return [markdown({ codeLanguages: languages })];
  return [];
}

async function loadCodeMirrorLanguage(languageName: string, filename: string): Promise<Extension | null> {
  if (initialFileLanguageExtensions(languageName, filename).length) return null;
  const lang = languageName.toLowerCase();
  const desc = languages.find((item: any) => {
    try {
      return item?.matchFilename?.(filename)
        || item?.alias?.some?.((alias: string) => alias.toLowerCase() === lang)
        || String(item?.name || "").toLowerCase() === lang;
    } catch {
      return false;
    }
  }) as any;
  if (!desc?.load) return null;
  try {
    return await desc.load();
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
const panelTabVisitHistory = new Map<string, string[]>();
type PanelDropSide = "center" | "left" | "right" | "up" | "down";
let panelDropPreviewEl: HTMLDivElement | null = null;
let panelDropPreviewLabelEl: HTMLDivElement | null = null;

function notePanelTabVisit(panelId: string | null | undefined, tabId: string | null | undefined) {
  if (!panelId || !tabId) return;
  const prev = panelTabVisitHistory.get(panelId) || [];
  panelTabVisitHistory.set(panelId, [tabId, ...prev.filter((id) => id !== tabId)].slice(0, 32));
}

function pickPreviousVisitedPanelTab(
  panelId: string,
  removedTabId: string,
  remainingTabs: Array<{ id: string }>,
  fallbackIndex: number
): string | null {
  const remainingIds = new Set(remainingTabs.map((tab) => tab.id));
  const history = panelTabVisitHistory.get(panelId) || [];
  const fromHistory = history.find((id) => id !== removedTabId && remainingIds.has(id));
  if (fromHistory) return fromHistory;
  return remainingTabs[Math.min(fallbackIndex, remainingTabs.length - 1)]?.id || remainingTabs[remainingTabs.length - 1]?.id || null;
}

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
  const headerEl = pathEl.parentElement as HTMLElement | null;
  const setSessionActionsVisible = (visible: boolean) => {
    if (!headerEl) return;
    const selectors = [
      "button[data-zion-editor-toc-button='1']",
      "button[data-zion-editor-session-rename-button='1']",
      "button[data-zion-editor-split-menu-button='1']",
      "button[data-zion-core-runstop-button='1']",
      "button[data-zion-editor-settings-menu-button='1']"
    ].join(",");
    for (const el of Array.from(headerEl.querySelectorAll<HTMLElement>(selectors))) {
      el.style.display = visible ? "" : "none";
      try { el.setAttribute("aria-hidden", visible ? "false" : "true"); } catch {}
    }
  };

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
    if (!tree) return sessionTitle;

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

    return parts.join(" / ");
  };

  const computeTitle = (sessionId: string): string => {
    const meta = window.zion.state.get<any>(`sessions.meta.${sessionId}`);
    return String(meta?.title || "").trim() || sessionId;
  };

  const computeFilePath = (tabId: string): string => {
    const meta = window.zion.state.get<any>(`files.openTabs.${tabId}`) || null;
    return String(meta?.path || meta?.displayPath || meta?.title || tabId).trim() || tabId;
  };

  const resolveActiveTabId = () => {
    if (panelId) {
      try {
        return window.zion?.panels?.list?.().find((panel) => panel.id === panelId)?.activeTabId || null;
      } catch {
        return null;
      }
    }
    return window.zion.state.get<string>("sessions.currentId") || null;
  };

  let metaDisp: Disposable | null = null;
  let inlineRenaming = false;
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
    if (inlineRenaming) return;
    const activeTabId = resolveActiveTabId();
    if (isFilePanelTabId(activeTabId)) {
      setSessionActionsVisible(true);
      const p = computeFilePath(activeTabId || "");
      pathEl.textContent = p;
      pathEl.title = p;
      return;
    }
    const id = resolveSessionId();
    if (!id) {
      setSessionActionsVisible(false);
      pathEl.textContent = "";
      pathEl.title = "";
      return;
    }
    setSessionActionsVisible(true);
    const p = computePath(id);
    pathEl.textContent = p;
    pathEl.title = p;
  };

  const startInlineRename = () => {
    if (isFilePanelTabId(resolveActiveTabId())) return false;
    const id = resolveSessionId();
    if (!id || inlineRenaming) return false;
    inlineRenaming = true;
    const originalTitle = computeTitle(id);
    pathEl.classList.add("is-renaming");
    pathEl.title = "Enter 保存，Esc 取消";
    pathEl.textContent = "";

    const form = document.createElement("form");
    form.className = "zion-editor-session-path-rename";
    const input = document.createElement("input");
    input.className = "zion-editor-session-path-rename-input";
    input.type = "text";
    input.value = originalTitle;
    input.placeholder = "Session title";
    input.setAttribute("aria-label", "重命名会话");
    form.appendChild(input);
    pathEl.appendChild(form);

    let done = false;
    const finish = async (commit: boolean) => {
      if (done) return;
      done = true;
      const nextTitle = input.value.trim();
      inlineRenaming = false;
      pathEl.classList.remove("is-renaming");
      if (commit && nextTitle && nextTitle !== originalTitle) {
        try {
          await Promise.resolve(window.zion.commands.executeCommand("zion.sessions.rename", { id, title: nextTitle, panelId: panelId || null }));
        } catch {}
      }
      update();
    };

    form.onsubmit = (ev) => {
      ev.preventDefault();
      void finish(true);
    };
    input.onkeydown = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        void finish(false);
      }
    };
    input.onblur = () => {
      void finish(true);
    };

    requestAnimationFrame(() => {
      try {
        input.focus();
        input.select();
      } catch {}
    });
    return true;
  };

  try {
    editorPathInlineRenameHandlers.set(panelId || EDITOR_PATH_RENAME_FALLBACK_KEY, startInlineRename);
  } catch {}

  try {
    pathEl.onclick = () => {
      if (inlineRenaming) return;
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
      if (isFilePanelTabId(id)) {
        bindMeta(undefined);
        update();
      } else if (id) {
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
  requestAnimationFrame(update);
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
    btn.innerHTML = zionIconHtml("message-circle-plus");
    btn.title = "新增会话（同级）";
    btn.setAttribute("aria-label", "新增会话（同级）");
    btn.setAttribute("data-zion-editor-new-session-button", "1");
    
    btn.onclick = (e) => {
      try {
        e.stopPropagation();
      } catch {}
      try {
        // 获取当前会话的父级ID
        const panelId = window.zion.panels?.getActivePanelId?.() || undefined;
        const curId = panelId
          ? getPanelActiveSessionId(panelId)
          : window.zion.state.get<string>("sessions.currentId");
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
        window.zion.commands.executeCommand("zion.sessions.new", { parentId, panelId });
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
    btn.innerHTML = zionIconHtml("list-tree");
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
    const getOwningPanelId = (): string | null => {
      try {
        return containerEl.closest("[data-panel-id]")?.getAttribute("data-panel-id") || null;
      } catch {
        return null;
      }
    };

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
        const panelId = getOwningPanelId() || window.zion.panels?.getActivePanelId?.() || undefined;
        const curId = panelId
          ? getPanelActiveSessionId(panelId)
          : window.zion.state.get<string>("sessions.currentId");
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
      newBtn.innerHTML = zionIconHtml("message-circle-plus");
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
          const panelId = getOwningPanelId() || window.zion.panels?.getActivePanelId?.() || undefined;
          window.zion.commands.executeCommand("zion.sessions.new", { parentId, panelId });
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
          close.innerHTML = zionIconHtml("x");
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
      dropdownBtn.innerHTML = zionIconHtml("chevron-down");
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
          if (!t || t === window || t === document || t === document.documentElement || t === document.body) return;
          if (dropdownMenu && (t === dropdownMenu || dropdownMenu.contains(t))) return;
          if (t?.closest?.(".cm-scroller, .cm-editor, .zion-editor-host, .zion-panel")) return;
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
            const panelId = getOwningPanelId();
            window.zion.commands.executeCommand(
              "zion.sessions.switch",
              panelId ? { id: nextId, panelId, previousSessionId: id } : nextId
            );
          } catch {}
        } else {
          try { window.zion.state.set("sessions.currentId", null); } catch {}
        }
      }
      requestRender();
    };

    const activateTab = (id: string) => {
      try {
        const panelId = getOwningPanelId();
        if (panelId && getPanelActiveSessionId(panelId) === id) {
          try { window.zion?.panels?.focus?.(panelId); } catch {}
          try { window.zion?.panels?.openSession?.(panelId, id, { focus: true, forceReload: true }); } catch {}
          return;
        }
        if (panelId && typeof window.zion?.panels?.openSession === "function") {
          window.zion.panels.openSession(panelId, id, { focus: true });
        } else {
          window.zion.commands.executeCommand("zion.sessions.switch", id);
        }
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
          closeBtn.innerHTML = zionIconHtml("x");
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

function exposeEditorHeaderMenuApi() {
  try {
    const registry = getEditorHeaderMenuRegistry();
    (window.zion as any).editorHeaderMenu = {
      register: (item: EditorHeaderMenuItem) => registry.register(item),
      list: () => registry.list()
    };
  } catch {}
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
    btn.innerHTML = zionIconHtml("more-horizontal");
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
        secBtn.innerHTML = `<span class="zion-editor-header-menu-section-content">${zionIconHtml(collapsed ? "chevron-right" : "chevron-down", "zion-editor-header-menu-chevron zion-icon-sm")}<span class="zion-editor-header-menu-section-title">${sec}</span></span>`;
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
          it.innerHTML = `<span class="zion-editor-header-menu-item-content"><span class="zion-editor-header-menu-item-left"><span class="zion-editor-header-menu-item-title">${label}</span></span><span class="zion-editor-header-menu-item-state ${boxClass}">${zionIconHtml("check", "zion-icon-sm")}</span></span>`;

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

function mountEditorHeaderSessionRenameButton(pathEl: HTMLElement, panelId?: string | null) {
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
    btn.innerHTML = zionIconHtml("pencil");
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

      const resolveHeaderSessionId = () => {
        if (panelId) return getPanelActiveSessionId(panelId) || null;
        return window.zion.state.get<string>("sessions.currentId") || null;
      };

      addItem("Rename…", () => {
        try {
          const id = resolveHeaderSessionId();
          window.zion.commands.executeCommand("zion.sessions.renameInline", { id, panelId: panelId || null });
        } catch {}
      });
      addItem("Auto Rename (AI)", () => {
        try {
          const id = resolveHeaderSessionId();
          window.zion.commands.executeCommand("zion.sessions.autoRename", { id, panelId: panelId || null });
        } catch {}
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

function mountEditorHeaderSplitMenuButton(pathEl: HTMLElement) {
  try {
    const headerEl = pathEl.parentElement;
    if (!headerEl) return;

    let btn = headerEl.querySelector<HTMLButtonElement>("button[data-zion-editor-split-menu-button='1']");
    const isNew = !btn;
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
    }

    btn.className = "zion-editor-header-action is-icon zion-editor-split-menu-button";
    btn.innerHTML = zionIconHtml("columns-2");
    btn.title = "分屏";
    btn.setAttribute("aria-label", "分屏");
    btn.setAttribute("data-zion-editor-split-menu-button", "1");

    let menuEl: HTMLDivElement | null = null;
    let cleanup: (() => void) | null = null;

    const resolvePanelId = () => {
      try {
        return pathEl.closest("[data-panel-id]")?.getAttribute("data-panel-id")
          || window.zion?.panels?.getActivePanelId?.()
          || "panel-0";
      } catch {
        return "panel-0";
      }
    };

    const closeMenu = () => {
      try { cleanup?.(); } catch {}
      cleanup = null;
      try { menuEl?.remove(); } catch {}
      menuEl = null;
    };

    const positionMenu = () => {
      if (!menuEl) return;
      const r = btn!.getBoundingClientRect();
      const mw = menuEl.offsetWidth || 180;
      const mh = menuEl.offsetHeight || 96;
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

    const split = (direction: "horizontal" | "vertical") => {
      const panelId = resolvePanelId();
      try { window.zion?.panels?.focus?.(panelId); } catch {}
      try { window.zion?.panels?.split?.(direction, panelId); } catch {}
    };

    const openMenu = () => {
      if (menuEl) return;
      const menu = document.createElement("div");
      menu.className = "zion-context-menu zion-editor-header-session-menu zion-editor-header-split-menu";
      menu.style.position = "fixed";
      menu.style.zIndex = "99999";
      menu.style.minWidth = "180px";
      document.body.appendChild(menu);
      menuEl = menu;

      const addItem = (label: string, title: string, onClick: () => void) => {
        const row = document.createElement("div");
        row.className = "zion-context-menu-row";
        const it = document.createElement("button");
        it.className = "zion-context-menu-item";
        it.type = "button";
        it.textContent = label;
        it.title = title;
        it.onclick = (e) => {
          try { e.stopPropagation(); } catch {}
          try { onClick(); } catch {}
          closeMenu();
        };
        row.appendChild(it);
        menu.appendChild(row);
      };

      addItem("向右分屏", "在右侧打开当前会话的新分屏", () => split("horizontal"));
      addItem("向下分屏", "在下方打开当前会话的新分屏", () => split("vertical"));

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
      const settingsBtn = headerEl.querySelector<HTMLButtonElement>("button[data-zion-editor-settings-menu-button='1']");
      if (settingsBtn) headerEl.insertBefore(btn, settingsBtn);
      else headerEl.appendChild(btn);
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
        btn!.innerHTML = zionIconHtml(streaming ? "square" : "play");
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
          panelId,
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

function mountPanelSessionTabsBar(
  containerEl: HTMLElement,
  panelId: string,
  panelManager: PanelManager,
  opts?: { onTabRemovedFromPanel?: (panelId: string, tabId: string) => void }
) {
  try {
    const lifecycleController = new AbortController();
    const lifecycleSignal = lifecycleController.signal;
    const lifecycleDisposables: Disposable[] = [];
    let newBtn = containerEl.querySelector<HTMLButtonElement>("button[data-zion-panel-tabs-new-session-button='1']");
    let dropdownBtn = containerEl.querySelector<HTMLButtonElement>("button[data-zion-panel-tabs-dropdown-button='1']");
    let viewport = containerEl.querySelector<HTMLElement>("[data-zion-panel-session-tabs-viewport='1']");
    let root = containerEl.querySelector<HTMLElement>("[data-zion-panel-session-tabs='1']");
    let scrollbar = containerEl.querySelector<HTMLElement>("[data-zion-panel-session-tabs-scrollbar='1']");
    let scrollbarThumb = containerEl.querySelector<HTMLElement>("[data-zion-panel-session-tabs-scrollbar-thumb='1']");
    if (!newBtn) {
      newBtn = document.createElement("button");
      newBtn.type = "button";
      newBtn.className = "zion-editor-header-action is-icon zion-editor-tabs-new-session-button";
      newBtn.innerHTML = zionIconHtml("message-circle-plus");
      newBtn.title = "新增会话";
      newBtn.setAttribute("aria-label", "新增会话");
      newBtn.setAttribute("data-zion-panel-tabs-new-session-button", "1");
      newBtn.onclick = (e) => {
        try {
          e.stopPropagation();
          e.preventDefault();
        } catch {}
        try { window.zion.panels?.focus?.(panelId); } catch {}
        try { window.zion.commands.executeCommand("zion.sessions.new", { panelId }); } catch {}
      };
      containerEl.insertBefore(newBtn, containerEl.firstChild);
    }
    if (!root) {
      root = document.createElement("div");
      root.className = "zion-editor-session-tabs";
      root.setAttribute("data-zion-panel-session-tabs", "1");
    }
    root.setAttribute("role", "tablist");
    root.setAttribute("aria-label", "当前面板标签页");
    if (!viewport) {
      viewport = document.createElement("div");
      viewport.className = "zion-panel-session-tabs-viewport";
      viewport.setAttribute("data-zion-panel-session-tabs-viewport", "1");
      containerEl.appendChild(viewport);
    }
    if (root.parentElement !== viewport) {
      try { viewport.appendChild(root); } catch {}
    }
    if (!scrollbar) {
      scrollbar = document.createElement("div");
      scrollbar.className = "zion-panel-session-tabs-scrollbar";
      scrollbar.setAttribute("data-zion-panel-session-tabs-scrollbar", "1");
      scrollbarThumb = document.createElement("div");
      scrollbarThumb.className = "zion-panel-session-tabs-scrollbar-thumb";
      scrollbarThumb.setAttribute("data-zion-panel-session-tabs-scrollbar-thumb", "1");
      scrollbar.appendChild(scrollbarThumb);
    } else if (!scrollbarThumb) {
      scrollbarThumb = document.createElement("div");
      scrollbarThumb.className = "zion-panel-session-tabs-scrollbar-thumb";
      scrollbarThumb.setAttribute("data-zion-panel-session-tabs-scrollbar-thumb", "1");
      scrollbar.appendChild(scrollbarThumb);
    }
    if (scrollbar.parentElement !== viewport) {
      try { viewport.appendChild(scrollbar); } catch {}
    }

    let dropdownMenu: HTMLDivElement | null = null;
    let dropdownHighlightedIndex = -1;
    const ensureDropdownMenu = () => {
      if (dropdownMenu && dropdownMenu.isConnected) return dropdownMenu;
      dropdownMenu = document.createElement("div");
      dropdownMenu.className = "zion-editor-tabs-menu";
      dropdownMenu.setAttribute("role", "listbox");
      dropdownMenu.setAttribute("aria-label", "当前面板标签页");
      document.body.appendChild(dropdownMenu);
      return dropdownMenu;
    };
    const hideDropdownMenu = () => {
      if (!dropdownMenu) return;
      dropdownMenu.classList.remove("show");
      dropdownMenu.innerHTML = "";
      dropdownHighlightedIndex = -1;
      try { dropdownBtn?.classList.remove("is-active"); } catch {}
    };
    const isDropdownOpen = () => !!dropdownMenu?.classList.contains("show");
    const isPanelTabsShortcutTarget = (target: EventTarget | null) => {
      try {
        const node = target as Node | null;
        if (!node) return false;
        if (dropdownMenu?.contains(node)) return true;
        if (dropdownBtn?.contains(node)) return true;
        if (containerEl.contains(node)) return true;
        const panelRoot = panelManager.getPanel(panelId)?.rootEl || null;
        return !!panelRoot?.contains(node);
      } catch {
        return false;
      }
    };
    const getDropdownItems = () => {
      if (!dropdownMenu) return [] as HTMLElement[];
      return Array.from(dropdownMenu.querySelectorAll<HTMLElement>(".zion-editor-tabs-menu-item[data-session-id]"));
    };
    const setDropdownHighlightedIndex = (index: number, opts?: { scroll?: boolean }) => {
      const items = getDropdownItems();
      if (!items.length) {
        dropdownHighlightedIndex = -1;
        return;
      }
      const next = ((index % items.length) + items.length) % items.length;
      dropdownHighlightedIndex = next;
      items.forEach((item, i) => {
        const selected = i === next;
        item.classList.toggle("is-keyboard-selected", selected);
        item.setAttribute("aria-selected", selected ? "true" : "false");
      });
      if (opts?.scroll !== false) {
        try { items[next].scrollIntoView({ block: "nearest" }); } catch {}
      }
    };
    const getActiveDropdownIndex = () => {
      const panel = panelManager.getPanel(panelId);
      if (!panel) return 0;
      const idx = panel.tabs.findIndex((tab) => tab.id === panel.activeTabId);
      return idx >= 0 ? idx : 0;
    };
    const moveDropdownHighlight = (delta: number) => {
      const items = getDropdownItems();
      if (!items.length) return;
      const start = dropdownHighlightedIndex >= 0 ? dropdownHighlightedIndex : getActiveDropdownIndex();
      setDropdownHighlightedIndex(start + delta);
    };
    const activateHighlightedDropdownItem = () => {
      const items = getDropdownItems();
      if (!items.length) return false;
      const idx = dropdownHighlightedIndex >= 0 ? dropdownHighlightedIndex : getActiveDropdownIndex();
      const item = items[Math.max(0, Math.min(items.length - 1, idx))];
          const tabId = item?.dataset.sessionId || "";
          if (!tabId) return false;
      hideDropdownMenu();
      focusAndActivatePanelTab(panelId, tabId);
      return true;
    };

    if (!dropdownBtn) {
      dropdownBtn = document.createElement("button");
      dropdownBtn.type = "button";
      dropdownBtn.className = "zion-editor-header-action is-icon zion-editor-tabs-dropdown-button";
      dropdownBtn.innerHTML = zionIconHtml("chevron-down");
      dropdownBtn.title = "查看当前面板标签页 (Option+Tab)";
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

    const isFileTab = (tabOrId: any) => isFilePanelTabId(typeof tabOrId === "string" ? tabOrId : tabOrId?.id) || tabOrId?.kind === "file";
    const getTabMeta = (tabOrId: any) => {
      if (typeof tabOrId !== "string") return tabOrId?.meta || null;
      return window.zion.state.get<any>(`files.openTabs.${tabOrId}`) || null;
    };
    const getTitle = (tabOrId: any) => {
      if (isFileTab(tabOrId)) {
        const meta = getTabMeta(tabOrId);
        return String(meta?.title || (typeof tabOrId === "string" ? tabOrId : tabOrId?.title) || "").trim() || "File";
      }
      const sessionId = typeof tabOrId === "string" ? tabOrId : tabOrId?.id;
      const meta = window.zion.state.get<any>(`sessions.meta.${sessionId}`);
      return String(meta?.title || "").trim() || sessionId;
    };
    const getTabStatus = (tabOrId: any): "streaming" | "awaiting" | "failed" | "aborted" | null => {
      try {
        if (isFileTab(tabOrId)) return null;
        const sessionId = typeof tabOrId === "string" ? tabOrId : tabOrId?.id;
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
    const getTabStatusText = (tabOrId: any) => {
      if (isFileTab(tabOrId)) return "文件";
      const status = getTabStatus(tabOrId);
      switch (status) {
        case "streaming": return "对话中";
        case "awaiting": return "待查看";
        case "failed": return "失败";
        case "aborted": return "已停止";
        default: return "";
      }
    };
    let scheduleRender: () => void = () => {};
    const syncWatchers = () => {
      const panel = panelManager.getPanel(panelId);
      const sessionTabIds = new Set((panel?.tabs || []).filter((tab: any) => !isFileTab(tab)).map((tab) => tab.id));
      for (const [id, disp] of Array.from(metaDisposables.entries())) {
        if (!sessionTabIds.has(id)) {
          try { disp.dispose(); } catch {}
          metaDisposables.delete(id);
        }
      }
      for (const [id, disp] of Array.from(runDisposables.entries())) {
        if (!sessionTabIds.has(id)) {
          try { disp.dispose(); } catch {}
          runDisposables.delete(id);
        }
      }
      for (const id of sessionTabIds) {
        if (!metaDisposables.has(id)) {
          try {
            metaDisposables.set(
              id,
              window.zion.state.onDidChange<any>(`sessions.meta.${id}`, (nv, ov) => {
                const nt = String(nv?.title || "").trim();
                const ot = String(ov?.title || "").trim();
                if (nt !== ot) scheduleRender();
              })
            );
          } catch {}
        }
        if (!runDisposables.has(id)) {
          try {
            runDisposables.set(id, window.zion.state.onDidChange(`chat.runs.${id}`, scheduleRender));
          } catch {}
        }
      }
    };
    const showDropdownMenu = (opts?: { highlightIndex?: number; preserveHighlight?: boolean }) => {
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
          item.setAttribute("role", "option");
          item.setAttribute("aria-selected", "false");
          item.setAttribute("data-session-id", tab.id);

          const status = getTabStatus(tab);
          const statusEl = document.createElement("span");
          statusEl.className = "zion-editor-tabs-menu-item-status";
          if (status) statusEl.dataset.status = status;

          const label = document.createElement("div");
          label.className = "zion-editor-tabs-menu-item-label";
          const title = getTitle(tab);
          label.textContent = title;
          label.title = title;

          const meta = document.createElement("div");
          meta.className = "zion-editor-tabs-menu-item-meta";
          meta.textContent = getTabStatusText(tab) || (panel.activeTabId === tab.id ? "当前" : "");

          const actions = document.createElement("div");
          actions.className = "zion-editor-tabs-menu-item-actions";
          const close = document.createElement("button");
          close.type = "button";
          close.className = "zion-editor-tabs-menu-item-close";
          close.title = "关闭";
          close.setAttribute("aria-label", "关闭标签页");
          close.innerHTML = zionIconHtml("x");
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
      const hint = document.createElement("div");
      hint.className = "zion-editor-tabs-menu-hint";
      hint.textContent = "⌥Tab 选择 · ↑↓ 移动 · Enter 打开 · Esc 关闭";
      menu.appendChild(hint);
      menu.classList.add("show");
      dropdownBtn.classList.add("is-active");
      if (panel.tabs.length > 0) {
        const nextHighlight = typeof opts?.highlightIndex === "number"
          ? opts.highlightIndex
          : opts?.preserveHighlight && dropdownHighlightedIndex >= 0
            ? dropdownHighlightedIndex
            : getActiveDropdownIndex();
        setDropdownHighlightedIndex(nextHighlight, { scroll: true });
      }
    };

    const metaDisposables = new Map<string, Disposable>();
    const runDisposables = new Map<string, Disposable>();
    let dropTargetId: string | null = null;
    let dropPosition: "before" | "after" | null = null;
    let panelDropSide: PanelDropSide | null = null;
    let lastDragEndAt = 0;
    let tabStripScrollLeft = 0;
    let lastTabClickAt = 0;
    let lastTabClickSessionId: string | null = null;
    let ignoreClickActivatedTabId: string | null = null;
    let ignoreClickActivatedAt = 0;
    type PanelTabElementEntry = {
      element: HTMLElement;
      status: HTMLSpanElement;
      title: HTMLSpanElement;
      close: HTMLButtonElement;
    };
    const tabElements = new Map<string, PanelTabElementEntry>();
    const prefetchedTabIds = new Set<string>();
    const updateViewportScrollState = () => {
      try {
        if (!viewport || !root) return;
        const scrollerWidth = viewport.clientWidth || root.clientWidth || 0;
        const scrollWidth = root.scrollWidth || 0;
        const maxScrollLeft = Math.max(0, scrollWidth - scrollerWidth);
        const canScroll = maxScrollLeft > 1;
        tabStripScrollLeft = canScroll
          ? Math.max(0, Math.min(maxScrollLeft, tabStripScrollLeft))
          : 0;
        const thumbWidth = canScroll && scrollWidth > 0 && scrollerWidth > 0
          ? Math.max(24, Math.min(scrollerWidth, (scrollerWidth / scrollWidth) * scrollerWidth))
          : 0;
        const thumbLeft = canScroll && scrollerWidth > thumbWidth
          ? (tabStripScrollLeft / maxScrollLeft) * (scrollerWidth - thumbWidth)
          : 0;
        viewport.dataset.scrollable = canScroll ? "1" : "0";
        viewport.dataset.canScrollLeft = canScroll && tabStripScrollLeft > 1 ? "1" : "0";
        viewport.dataset.canScrollRight = canScroll && tabStripScrollLeft < maxScrollLeft - 1 ? "1" : "0";
        root.style.transform = tabStripScrollLeft ? `translateX(${-tabStripScrollLeft}px)` : "";
        if (scrollbarThumb) {
          scrollbarThumb.style.width = `${Math.max(0, thumbWidth)}px`;
          scrollbarThumb.style.transform = `translateX(${Math.max(0, thumbLeft)}px)`;
        }
      } catch {}
    };
    const setTabStripScrollLeft = (next: number) => {
      try {
        if (!viewport || !root) return;
        const maxScrollLeft = Math.max(0, (root.scrollWidth || 0) - (viewport.clientWidth || 0));
        tabStripScrollLeft = Math.max(0, Math.min(maxScrollLeft, next));
        updateViewportScrollState();
      } catch {}
    };
    const updateTabDensity = () => {
      try {
        if (!root || !viewport) return;
        const count = root.querySelectorAll(".zion-editor-session-tab").length;
        const width = viewport.clientWidth || viewport.getBoundingClientRect().width || 0;
        const avg = count > 0 ? width / count : width;
        const density = avg < 82 ? "crowded" : avg < 132 ? "compact" : "comfortable";
        root.dataset.density = density;
        root.dataset.tabCount = String(count);
      } catch {}
    };

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
        if (panelManager.listPanels().length > 1) {
          panelManager.closePanel(targetPanelId);
          return true;
        }
        current.tabs = [];
        current.activeTabId = null;
        try { opts?.onTabRemovedFromPanel?.(targetPanelId, targetTabId); } catch {}
        try { panelManager.activateTab(targetPanelId, null); } catch {}
        try { window.zion.state.set("sessions.currentId", null); } catch {}
        clearPersistedActiveSession();
        emitTabsChanged(targetPanelId);
        syncActivePanelTabsState(targetPanelId);
        savePanelWorkspaceSnapshotNow({
          version: 1,
          savedAt: Date.now(),
          manager: panelManager.snapshotState(),
          viewStates: {}
        });
        return true;
      }
      const nextTabs = current.tabs.filter((item) => item.id !== targetTabId);
      const wasActive = current.activeTabId === targetTabId;
      const nextId = wasActive
        ? pickPreviousVisitedPanelTab(targetPanelId, targetTabId, nextTabs, idx)
        : null;
      current.tabs = nextTabs;
      try { opts?.onTabRemovedFromPanel?.(targetPanelId, targetTabId); } catch {}
      if (wasActive) {
        if (nextId) {
          focusAndActivatePanelTab(targetPanelId, nextId, { focus: true, forceReload: true });
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
    const focusAndActivatePanelTab = (
      targetPanelId: string,
      tabId: string | null,
      opts?: { focus?: boolean; forceReload?: boolean }
    ) => {
      if (!tabId) return false;
      try {
        if (isFilePanelTabId(tabId)) {
          return (window.zion.panels as any)?.openTab?.(targetPanelId, tabId, {
            focus: opts?.focus !== false
          }) !== false;
        }
        return window.zion.panels?.openSession?.(targetPanelId, tabId, {
          focus: opts?.focus !== false,
          forceReload: !!opts?.forceReload
        }) !== false;
      } catch {
        return false;
      }
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
      emitTabsChanged(targetPanelId);

      if (sourcePanel.tabs.length <= 1) {
        if (panelManager.listPanels().length > 1) {
          panelManager.closePanel(sourcePanelId);
        } else {
          try { opts?.onTabRemovedFromPanel?.(sourcePanelId, tabId); } catch {}
          sourcePanel.tabs = [];
          sourcePanel.activeTabId = null;
          emitTabsChanged(sourcePanelId);
          syncActivePanelTabsState(sourcePanelId);
        }
      } else {
        const nextTabs = sourcePanel.tabs.filter((tab) => tab.id !== tabId);
        const wasSourceActive = sourcePanel.activeTabId === tabId;
        const nextSourceId = wasSourceActive
          ? pickPreviousVisitedPanelTab(sourcePanelId, tabId, nextTabs, fromIndex)
          : null;
        sourcePanel.tabs = nextTabs;
        try { opts?.onTabRemovedFromPanel?.(sourcePanelId, tabId); } catch {}
        if (wasSourceActive) {
          if (nextSourceId) {
            try {
              window.zion.panels?.openSession?.(sourcePanelId, nextSourceId, { focus: false, forceReload: true });
            } catch {}
          }
        }
        emitTabsChanged(sourcePanelId);
        syncActivePanelTabsState(sourcePanelId);
      }

      focusAndActivatePanelTab(targetPanelId, tabId, { focus: true, forceReload: true });
    };
    const finishPanelTabDrag = () => {
      lastDragEndAt = Date.now();
      panelTabDragState = null;
      try {
        document.querySelectorAll(".zion-editor-session-tab.is-dragging").forEach((node) => {
          node.classList.remove("is-dragging");
        });
      } catch {}
    };
    const performPanelDrop = (
      drag: PanelTabDragState,
      targetPanelId: string,
      side: PanelDropSide,
      targetTabId: string | null = null,
      position: "before" | "after" = "after"
    ) => {
      try {
        if (side === "center") {
          moveTabBetweenPanels(drag.sourcePanelId, drag.tabId, targetPanelId, targetTabId, position);
          return;
        }
        const created = panelManager.splitPanelAt(targetPanelId, side, { seedFromSource: false });
        const createdPanelId = created?.id || null;
        if (!createdPanelId) return;
        moveTabBetweenPanels(drag.sourcePanelId, drag.tabId, createdPanelId, null, "after");
      } finally {
        finishPanelTabDrag();
      }
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

    const getEventTabElement = (target: EventTarget | null): HTMLElement | null => {
      const tabEl = (target as HTMLElement | null)?.closest?.<HTMLElement>(".zion-editor-session-tab") || null;
      return tabEl && root?.contains(tabEl) ? tabEl : null;
    };
    const getEventTabId = (target: EventTarget | null) => getEventTabElement(target)?.dataset.sessionId || "";
    root.onpointerover = (e) => {
      const tabEl = getEventTabElement(e.target);
      const tabId = tabEl?.dataset.sessionId || "";
      if (!tabEl || !tabId || prefetchedTabIds.has(tabId)) return;
      const related = e.relatedTarget as Node | null;
      if (related && tabEl.contains(related)) return;
      const tab = panelManager.getPanel(panelId)?.tabs.find((item) => item.id === tabId);
      if (!tab || isFileTab(tab)) return;
      prefetchedTabIds.add(tabId);
      try {
        if (typeof window.zion.state.get<string>(`sessions.doc.${tabId}`) === "string") return;
        void Promise.resolve(
          window.zion.commands.executeCommand("zion.sessions.getDocAsync", tabId)
        ).catch(() => {});
      } catch {}
    };
    root.onmousedown = (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("button")) return;
      const tabId = getEventTabId(target);
      if (!tabId || e.button !== 0 || panelTabDragState || Date.now() - lastDragEndAt < 150) return;
      if (panelManager.getActivePanelId?.() === panelId) return;
      try { e.stopPropagation(); } catch {}
      ignoreClickActivatedTabId = tabId;
      ignoreClickActivatedAt = Date.now();
      focusAndActivatePanelTab(panelId, tabId);
    };
    root.onclick = (e) => {
      const target = e.target as HTMLElement | null;
      const tabId = getEventTabId(target);
      if (!tabId) return;
      if (target?.closest?.(".zion-editor-session-tab-close")) {
        try {
          e.preventDefault();
          e.stopPropagation();
        } catch {}
        closeTabInPanel(panelId, tabId);
        return;
      }
      if (panelTabDragState || Date.now() - lastDragEndAt < 150) return;
      if (ignoreClickActivatedTabId === tabId && Date.now() - ignoreClickActivatedAt < 500) {
        ignoreClickActivatedTabId = null;
        return;
      }
      const now = Date.now();
      const isManualDoubleClick = lastTabClickSessionId === tabId && now - lastTabClickAt <= 320;
      lastTabClickSessionId = tabId;
      lastTabClickAt = now;
      if (isManualDoubleClick) {
        try { panelManager.focusPanel(panelId); } catch {}
        try { panelManager.togglePanelMaximized(panelId); } catch {}
        return;
      }
      focusAndActivatePanelTab(panelId, tabId);
    };
    root.ondblclick = (e) => {
      if (!getEventTabElement(e.target)) return;
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch {}
    };
    root.onauxclick = (e) => {
      if (e.button !== 1) return;
      const tabId = getEventTabId(e.target);
      if (!tabId) return;
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch {}
      closeTabInPanel(panelId, tabId);
    };
    root.oncontextmenu = (e) => {
      const tabId = getEventTabId(e.target);
      if (!tabId) return;
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch {}
      const panel = panelManager.getPanel(panelId);
      showDropdownMenu({ highlightIndex: panel?.tabs.findIndex((item) => item.id === tabId) ?? 0 });
    };
    root.onkeydown = (e) => {
      const ev = e as KeyboardEvent;
      const target = ev.target as HTMLElement | null;
      if (target?.closest?.(".zion-editor-session-tab-close")) return;
      const tabId = getEventTabId(ev.target);
      if (!tabId) return;
      const panel = panelManager.getPanel(panelId);
      const tabIndex = panel?.tabs.findIndex((tab) => tab.id === tabId) ?? -1;
      if (
        panel
        && tabIndex >= 0
        && (ev.key === "ArrowLeft" || ev.key === "ArrowRight" || ev.key === "Home" || ev.key === "End")
      ) {
        try { ev.preventDefault(); } catch {}
        const nextIndex = ev.key === "Home"
          ? 0
          : ev.key === "End"
            ? panel.tabs.length - 1
            : (tabIndex + (ev.key === "ArrowRight" ? 1 : -1) + panel.tabs.length) % panel.tabs.length;
        const nextId = panel.tabs[nextIndex]?.id || "";
        if (!nextId) return;
        try { tabElements.get(nextId)?.element.focus({ preventScroll: true }); } catch {}
        focusAndActivatePanelTab(panelId, nextId);
      } else if (ev.key === "Enter" || ev.key === " ") {
        try { ev.preventDefault(); } catch {}
        focusAndActivatePanelTab(panelId, tabId);
      } else if (ev.key === "Backspace" || ev.key === "Delete") {
        try { ev.preventDefault(); } catch {}
        closeTabInPanel(panelId, tabId);
      }
    };
    root.ondragstart = (e) => {
      const ev = e as DragEvent;
      const target = ev.target as HTMLElement | null;
      if (target?.closest?.("button")) {
        try { ev.preventDefault(); } catch {}
        return;
      }
      const tabEl = getEventTabElement(target);
      const tabId = tabEl?.dataset.sessionId || "";
      if (!tabEl || !tabId) return;
      panelTabDragState = { sourcePanelId: panelId, tabId };
      try {
        tabEl.classList.add("is-dragging");
        ev.dataTransfer?.setData(PANEL_TAB_DND_MIME, JSON.stringify(panelTabDragState));
        ev.dataTransfer?.setData("text/plain", tabId);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
      } catch {}
    };
    root.ondragend = (e) => {
      try { getEventTabElement(e.target)?.classList.remove("is-dragging"); } catch {}
      finishPanelTabDrag();
      clearDropIndicators();
    };
    root.ondragover = (e) => {
      const ev = e as DragEvent;
      const drag = readDragState(ev);
      if (!drag) return;
      const targetTabEl = getEventTabElement(ev.target);
      const targetTabId = targetTabEl?.dataset.sessionId || "";
      if (targetTabEl && targetTabId) {
        if (drag.sourcePanelId === panelId && drag.tabId === targetTabId) return;
        try {
          ev.preventDefault();
          if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
        } catch {}
        root!.classList.remove("is-drop-target");
        const rect = targetTabEl.getBoundingClientRect();
        const pos: "before" | "after" = ev.clientX < rect.left + rect.width / 2 ? "before" : "after";
        if (dropTargetId !== targetTabId || dropPosition !== pos) {
          clearDropIndicators();
          dropTargetId = targetTabId;
          dropPosition = pos;
          targetTabEl.classList.toggle("is-drop-before", pos === "before");
          targetTabEl.classList.toggle("is-drop-after", pos === "after");
        }
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
      const targetTabId = getEventTabId(ev.target);
      try {
        ev.preventDefault();
        ev.stopPropagation();
      } catch {}
      const drag = readDragState(ev);
      const pos = dropPosition || "after";
      clearDropIndicators();
      if (!drag) return;
      performPanelDrop(drag, panelId, "center", targetTabId || null, pos);
    };
    try {
      if (viewport && !viewport.dataset.zionPanelTabsWheelBound) {
        viewport.dataset.zionPanelTabsWheelBound = "1";
        viewport.addEventListener(
          "wheel",
          (e) => {
            const ev = e as WheelEvent;
            if (!viewport || !root) return;
            const dx = ev.deltaX || 0;
            const dy = ev.deltaY || 0;
            const delta = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
            if (!delta) return;
            try {
              ev.preventDefault();
              ev.stopPropagation();
            } catch {}
            const canScroll = root.scrollWidth > viewport.clientWidth + 1;
            if (!canScroll) return;
            const prev = tabStripScrollLeft;
            setTabStripScrollLeft(prev + delta);
            const moved = Math.abs(tabStripScrollLeft - prev) > 0.5;
            if (moved) {
              updateViewportScrollState();
            }
          },
          { passive: false, signal: lifecycleSignal }
        );
        const jumpToScrollbarPoint = (clientX: number) => {
          if (!viewport || !root || !scrollbarThumb) return;
          const maxScrollLeft = Math.max(0, root.scrollWidth - viewport.clientWidth);
          if (maxScrollLeft <= 1) return;
          const rect = viewport.getBoundingClientRect();
          const thumbWidth = scrollbarThumb.getBoundingClientRect().width || 24;
          const maxThumbLeft = Math.max(1, rect.width - thumbWidth);
          const nextThumbLeft = Math.max(0, Math.min(maxThumbLeft, clientX - rect.left - thumbWidth / 2));
          setTabStripScrollLeft((nextThumbLeft / maxThumbLeft) * maxScrollLeft);
        };
        let isDraggingScrollbar = false;
        let dragStartX = 0;
        let dragStartScrollLeft = 0;
        const moveScrollbarDrag = (ev: PointerEvent) => {
          if (!isDraggingScrollbar || !viewport || !root || !scrollbarThumb) return;
          const maxScrollLeft = Math.max(0, root.scrollWidth - viewport.clientWidth);
          if (maxScrollLeft <= 1) return;
          const trackWidth = viewport.getBoundingClientRect().width || 0;
          const thumbWidth = scrollbarThumb.getBoundingClientRect().width || 24;
          const maxThumbLeft = Math.max(1, trackWidth - thumbWidth);
          setTabStripScrollLeft(dragStartScrollLeft + ((ev.clientX - dragStartX) / maxThumbLeft) * maxScrollLeft);
        };
        const endScrollbarDrag = () => {
          isDraggingScrollbar = false;
          try { document.body.classList.remove("is-dragging-panel-tabs-scrollbar"); } catch {}
        };
        scrollbar?.addEventListener("pointerdown", (e) => {
          const ev = e as PointerEvent;
          try {
            ev.preventDefault();
            ev.stopPropagation();
          } catch {}
          jumpToScrollbarPoint(ev.clientX);
          if (!viewport || !root || root.scrollWidth <= viewport.clientWidth + 1) return;
          isDraggingScrollbar = true;
          dragStartX = ev.clientX;
          dragStartScrollLeft = tabStripScrollLeft;
          try { document.body.classList.add("is-dragging-panel-tabs-scrollbar"); } catch {}
        }, { signal: lifecycleSignal });
        window.addEventListener("pointermove", (e) => moveScrollbarDrag(e as PointerEvent), { signal: lifecycleSignal });
        window.addEventListener("pointerup", endScrollbarDrag, { signal: lifecycleSignal });
        window.addEventListener("pointercancel", endScrollbarDrag, { signal: lifecycleSignal });
      }
    } catch {}
    try {
      if (!containerEl.dataset.zionPanelTabsDropdownBound) {
        containerEl.dataset.zionPanelTabsDropdownBound = "1";
        window.addEventListener("resize", hideDropdownMenu, { signal: lifecycleSignal });
        window.addEventListener("resize", updateTabDensity, { signal: lifecycleSignal });
        window.addEventListener("resize", updateViewportScrollState, { signal: lifecycleSignal });
        window.addEventListener(
          "scroll",
          (e) => {
            const t = (e as any)?.target as any;
            if (!t || t === window || t === document || t === document.documentElement || t === document.body) return;
            if (dropdownMenu && (t === dropdownMenu || dropdownMenu.contains(t))) return;
            if (t?.closest?.(".cm-scroller, .cm-editor, .zion-editor-host, .zion-panel")) return;
            hideDropdownMenu();
          },
          { capture: true, signal: lifecycleSignal }
        );
        window.addEventListener("keydown", (e) => {
          const ev = e as KeyboardEvent;
          const isActivePanel = window.zion?.panels?.getActivePanelId?.() === panelId;
          const isOptionTab = ev.key === "Tab" && ev.altKey && !ev.ctrlKey && !ev.metaKey;
          if (isOptionTab && isActivePanel) {
            try {
              ev.preventDefault();
              ev.stopPropagation();
            } catch {}
            const panel = panelManager.getPanel(panelId);
            if (!panel?.tabs?.length) return;
            if (!isDropdownOpen()) {
              showDropdownMenu({ highlightIndex: getActiveDropdownIndex() });
            } else {
              moveDropdownHighlight(ev.shiftKey ? -1 : 1);
            }
            return;
          }
          if (!isDropdownOpen()) return;
          if (!isPanelTabsShortcutTarget(ev.target)) return;
          if (ev.key === "Escape") {
            try {
              ev.preventDefault();
              ev.stopPropagation();
            } catch {}
            hideDropdownMenu();
            return;
          }
          if (!isActivePanel) return;
          if (ev.key === "ArrowDown" || ev.key === "ArrowRight") {
            try {
              ev.preventDefault();
              ev.stopPropagation();
            } catch {}
            moveDropdownHighlight(1);
            return;
          }
          if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") {
            try {
              ev.preventDefault();
              ev.stopPropagation();
            } catch {}
            moveDropdownHighlight(-1);
            return;
          }
          if (ev.key === "Home") {
            try {
              ev.preventDefault();
              ev.stopPropagation();
            } catch {}
            setDropdownHighlightedIndex(0);
            return;
          }
          if (ev.key === "End") {
            try {
              ev.preventDefault();
              ev.stopPropagation();
            } catch {}
            setDropdownHighlightedIndex(getDropdownItems().length - 1);
            return;
          }
          if (ev.key === "Enter") {
            try {
              ev.preventDefault();
              ev.stopPropagation();
            } catch {}
            activateHighlightedDropdownItem();
          }
        }, { capture: true, signal: lifecycleSignal });
        window.addEventListener("mousedown", (e) => {
          const t = e.target as any;
          if (dropdownBtn && (dropdownBtn === t || dropdownBtn.contains(t))) return;
          if (dropdownMenu && (dropdownMenu === t || dropdownMenu.contains(t))) return;
          hideDropdownMenu();
        }, { signal: lifecycleSignal });
      }
    } catch {}
    try {
      const anyContainer = containerEl as any;
      anyContainer.__zionPanelTabsResizeObserver?.disconnect?.();
      const ro = new ResizeObserver(() => {
        updateTabDensity();
        updateViewportScrollState();
      });
      ro.observe(containerEl);
      ro.observe(root);
      anyContainer.__zionPanelTabsResizeObserver = ro;
    } catch {}

    const render = (opts?: { revealActiveTab?: boolean }) => {
      const panel = panelManager.getPanel(panelId);
      if (!panel || !root) return;
      if (renderFrame) {
        cancelAnimationFrame(renderFrame);
        renderFrame = 0;
      }
      const shouldRevealActiveTab = !!opts?.revealActiveTab;
      const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const focusedTabEl = focusedElement && root.contains(focusedElement)
        ? focusedElement.closest<HTMLElement>(".zion-editor-session-tab")
        : null;
      const focusedTabId = focusedTabEl?.dataset.sessionId || "";
      const focusedCloseButton = !!focusedElement?.closest?.(".zion-editor-session-tab-close");
      syncWatchers();
      if (dropdownBtn) {
        dropdownBtn.style.display = panel.tabs.length > 0 ? "" : "none";
        dropdownBtn.title = `查看当前面板标签页 (${panel.tabs.length}) · Option+Tab`;
      }
      reconcileKeyedElements({
        container: root,
        items: panel.tabs,
        entries: tabElements,
        getKey: (tab) => tab.id,
        create: (_tab, key) => {
          const element = document.createElement("div");
          element.className = "zion-editor-session-tab";
          element.setAttribute("role", "tab");
          element.setAttribute("tabindex", "0");
          element.setAttribute("data-session-id", key);
          element.setAttribute("draggable", "true");

          const status = document.createElement("span");
          status.className = "zion-editor-session-tab-status";
          status.setAttribute("aria-hidden", "true");

          const title = document.createElement("span");
          title.className = "zion-editor-session-tab-title";

          const close = document.createElement("button");
          close.type = "button";
          close.className = "zion-editor-session-tab-close";
          close.setAttribute("draggable", "false");
          close.setAttribute("aria-label", "关闭标签页");
          close.title = "关闭";
          close.innerHTML = zionIconHtml("x");

          element.append(status, title, close);
          return { element, status, title, close };
        },
        update: (entry, tab, key) => {
          const active = key === panel.activeTabId;
          const fileTab = isFileTab(tab);
          const status = getTabStatus(tab);
          const statusText = getTabStatusText(tab);
          const title = getTitle(tab);
          entry.element.classList.toggle("is-active", active);
          entry.element.classList.toggle("is-file-tab", fileTab);
          entry.element.classList.toggle("is-streaming", status === "streaming");
          entry.element.classList.toggle("is-awaiting", status === "awaiting");
          entry.element.classList.toggle("is-failed", status === "failed");
          entry.element.classList.toggle("is-aborted", status === "aborted");
          entry.element.setAttribute("aria-selected", active ? "true" : "false");
          entry.element.tabIndex = active || (!panel.activeTabId && panel.tabs[0]?.id === key) ? 0 : -1;
          entry.close.tabIndex = active ? 0 : -1;
          entry.element.dataset.tabKind = fileTab ? "file" : "session";
          entry.element.title = statusText ? `${title} · ${statusText}` : title;
          if (entry.title.textContent !== title) entry.title.textContent = title;
          entry.title.title = entry.element.title;
          entry.status.style.display = status ? "inline-block" : "none";
          if (statusText) entry.status.title = statusText;
          else entry.status.removeAttribute("title");
        }
      });
      const liveTabIds = new Set(panel.tabs.map((tab) => tab.id));
      for (const id of Array.from(prefetchedTabIds)) {
        if (!liveTabIds.has(id)) prefetchedTabIds.delete(id);
      }
      if (focusedTabId && focusedElement && document.activeElement !== focusedElement) {
        const entry = tabElements.get(focusedTabId);
        const activeEntry = panel.activeTabId ? tabElements.get(panel.activeTabId) : null;
        const focusTarget = entry
          ? (focusedCloseButton ? entry.close : entry.element)
          : activeEntry?.element;
        try { focusTarget?.focus({ preventScroll: true }); } catch {}
      }
      updateTabDensity();
      requestAnimationFrame(() => {
        updateTabDensity();
        updateViewportScrollState();
        try {
          if (shouldRevealActiveTab) {
            const activeTabEl = root?.querySelector<HTMLElement>(".zion-editor-session-tab.is-active");
            if (viewport && activeTabEl) {
              const viewRect = viewport.getBoundingClientRect();
              const tabRect = activeTabEl.getBoundingClientRect();
              const needsReveal = tabRect.left < viewRect.left || tabRect.right > viewRect.right;
              if (needsReveal) {
                const tabLeft = activeTabEl.offsetLeft;
                const tabRight = tabLeft + activeTabEl.offsetWidth;
                const viewLeft = tabStripScrollLeft;
                const viewRight = viewLeft + viewport.clientWidth;
                if (tabLeft < viewLeft) setTabStripScrollLeft(tabLeft);
                else if (tabRight > viewRight) setTabStripScrollLeft(tabRight - viewport.clientWidth);
              }
            }
          }
        } catch {}
        try {
          if (isDropdownOpen()) showDropdownMenu({ preserveHighlight: true });
        } catch {}
      });
    };

    let renderFrame = 0;
    scheduleRender = () => {
      if (renderFrame) return;
      renderFrame = requestAnimationFrame(() => {
        renderFrame = 0;
        render();
      });
    };

    const syncActiveTabState = (revealActiveTab = false) => {
      const panel = panelManager.getPanel(panelId);
      if (!panel || !root) return;
      for (const [tabId, entry] of tabElements) {
        const active = tabId === panel.activeTabId;
        entry.element.classList.toggle("is-active", active);
        entry.element.setAttribute("aria-selected", active ? "true" : "false");
        entry.element.tabIndex = active || (!panel.activeTabId && panel.tabs[0]?.id === tabId) ? 0 : -1;
        entry.close.tabIndex = active ? 0 : -1;
      }
      if (isDropdownOpen()) showDropdownMenu({ preserveHighlight: true });
      if (!revealActiveTab) return;
      requestAnimationFrame(() => {
        updateViewportScrollState();
        const activeTabEl = panel.activeTabId ? tabElements.get(panel.activeTabId)?.element : null;
        if (!viewport || !activeTabEl) return;
        const tabLeft = activeTabEl.offsetLeft;
        const tabRight = tabLeft + activeTabEl.offsetWidth;
        const viewLeft = tabStripScrollLeft;
        const viewRight = viewLeft + viewport.clientWidth;
        if (tabLeft < viewLeft) setTabStripScrollLeft(tabLeft);
        else if (tabRight > viewRight) setTabStripScrollLeft(tabRight - viewport.clientWidth);
      });
    };

    render({ revealActiveTab: true });
    try {
      lifecycleDisposables.push(window.zion.events.on("panel/tabActivated", (payload: any) => {
        if (payload?.panelId === panelId) syncActiveTabState(true);
      }));
      lifecycleDisposables.push(window.zion.events.on("panel/tabsChanged", (payload: any) => {
        if (payload?.panelId === panelId) render({ revealActiveTab: true });
      }));
      lifecycleDisposables.push(window.zion.events.on("panel/layoutChanged", (payload: any) => {
        if (payload?.activePanelId === panelId) render({ revealActiveTab: true });
      }));
      lifecycleDisposables.push(window.zion.state.onDidChange("sessions.catalog", scheduleRender));
      lifecycleDisposables.push(window.zion.state.onDidChange("sessions.currentId", () => {
        if (window.zion?.panels?.getActivePanelId?.() === panelId) syncActiveTabState();
      }));
    } catch {}
    let disposed = false;
    const disposeTabsBar = () => {
      if (disposed) return;
      disposed = true;
      lifecycleController.abort();
      if (renderFrame) cancelAnimationFrame(renderFrame);
      try { (containerEl as any).__zionPanelTabsResizeObserver?.disconnect?.(); } catch {}
      for (const disposable of metaDisposables.values()) {
        try { disposable.dispose(); } catch {}
      }
      for (const disposable of runDisposables.values()) {
        try { disposable.dispose(); } catch {}
      }
      metaDisposables.clear();
      runDisposables.clear();
      for (const disposable of lifecycleDisposables.splice(0)) {
        try { disposable.dispose(); } catch {}
      }
      try { dropdownMenu?.remove(); } catch {}
      dropdownMenu = null;
      tabElements.clear();
      prefetchedTabIds.clear();
      root!.onclick = null;
      root!.onmousedown = null;
      root!.onpointerover = null;
      root!.onkeydown = null;
      root!.onauxclick = null;
      root!.oncontextmenu = null;
      root!.ondblclick = null;
      root!.ondragstart = null;
      root!.ondragend = null;
      root!.ondragover = null;
      root!.ondragleave = null;
      root!.ondrop = null;
    };
    lifecycleDisposables.push(panelManager.on("panel/closed", ({ panelId: closedPanelId }) => {
      if (closedPanelId === panelId) disposeTabsBar();
    }));
  } catch {}
}

async function bootstrap() {
  const host = document.getElementById("app")!;
  host.innerHTML = "";

  const wb = initWorkbench(host);
  const editorContainer = wb.editorHost;
  const editorHeaderPathEl = wb.editorHeaderPathEl;
  const editorTabsBarEl = wb.editorTabsBarEl;
  const editorHeaderEl = editorHeaderPathEl.parentElement as HTMLElement;
  const editorAreaEl = editorContainer.parentElement as HTMLElement;
  exposeEditorHeaderMenuApi();

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

  const savedPanelWorkspace = loadPanelWorkspaceSnapshot();
  const shouldStartEmpty = isEmptyPanelWorkspaceSnapshot(savedPanelWorkspace);
  if (shouldStartEmpty) {
    clearPersistedActiveSession();
    try { window.zion.state.set("sessions.currentId", null); } catch {}
  }
  try { window.zion.state.set("sessions.startEmpty", shouldStartEmpty); } catch {}
  const initialSessionId = shouldStartEmpty ? null : (window.zion.state.get<string>("sessions.currentId") || null);
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
    getMaximizedPanelId: () => panelManager.getMaximizedPanelId(),
    isMaximized: (panelId?: string) => panelManager.isPanelMaximized(panelId),
    list: () => panelManager.listPanels().map((panel) => ({
      id: panel.id,
      activeTabId: panel.activeTabId,
      tabs: panel.tabs.map((tab: any) => ({ id: tab.id, kind: tab.kind || "session" }))
    })),
    findAtSide: (side: "left" | "right" | "up" | "down", panelId?: string) => panelManager.findPanelAtSide(panelId, side),
    ensureAtSide: (side: "left" | "right" | "up" | "down", panelId?: string) => {
      const existing = panelManager.findPanelAtSide(panelId, side);
      return existing || panelManager.splitPanelAt(panelId, side)?.id || null;
    },
    openSession: (panelId: string, sessionId: string, opts?: { focus?: boolean; forceReload?: boolean }) => openSessionInPanel(panelId, sessionId, opts),
    openTab: (panelId: string, tabId: string, opts?: { focus?: boolean }) => {
      if (isFilePanelTabId(tabId)) return activateFileTab(panelId, tabId, opts);
      return openSessionInPanel(panelId, tabId, opts as any);
    },
    openFileTab: (args: any) => {
      if (args?.target === "inspector") {
        return (window.zion as any).inspector?.open?.({
          id: String(args?.id || `file:${Date.now().toString(36)}`),
          ownerId: String(args?.ownerId || "core"),
          title: String(args?.title || args?.name || "File"),
          path: args?.path,
          displayPath: args?.displayPath,
          language: args?.language,
          file: args?.file
        }) || "";
      }
      const panelId = String(args?.panelId || panelManager.getActivePanelId() || "panel-0");
      return openFileTabInPanel(panelId, args);
    },
    split: (direction: "horizontal" | "vertical", panelId?: string) => panelManager.splitPanel(panelId, direction)?.id || null,
    splitAt: (side: "left" | "right" | "up" | "down", panelId?: string) => panelManager.splitPanelAt(panelId, side)?.id || null,
    focus: (panelId: string) => panelManager.focusPanel(panelId),
    close: (panelId?: string) => panelManager.closePanel(panelId),
    maximize: (panelId?: string) => panelManager.maximizePanel(panelId),
    restore: () => panelManager.restorePanelLayout(),
    toggleMaximize: (panelId?: string) => panelManager.togglePanelMaximized(panelId),
    getEditor: (panelId: string) => panelManager.getEditor(panelId),
    getEditorBySession: (panelId: string, sessionId: string) => {
      const slotEditor = panelEditorSlots.get(panelId)?.get(sessionId)?.proxy || null;
      if (slotEditor) return slotEditor;
      const panel = panelManager.getPanel(panelId);
      return panel?.activeTabId === sessionId ? panelManager.getEditor(panelId) : null;
    },
    listEditors: (panelId?: string) => {
      const entries: Array<{ panelId: string; sessionId: string; editorId: string | null; active: boolean }> = [];
      const pushPanel = (pid: string) => {
        const panel = panelManager.getPanel(pid);
        const activeTabId = panel?.activeTabId || null;
        const panelTabIds = new Set((panel?.tabs || []).map((tab: any) => tab.id));
        for (const slot of panelEditorSlots.get(pid)?.values?.() || []) {
          if (panelTabIds.size > 0 && !panelTabIds.has(slot.sessionId)) continue;
          entries.push({
            panelId: pid,
            sessionId: slot.sessionId,
            editorId: slot.proxy?.editorId || null,
            active: activeTabId === slot.sessionId
          });
        }
      };
      if (panelId) pushPanel(panelId);
      else for (const panel of panelManager.listPanels()) pushPanel(panel.id);
      return entries;
    }
  };
  (window.zion as any).panelManager = panelManager;
  const sessionSync = new SessionSync({
    events: window.zion.events,
    getActivePanelId: () => panelManager.getActivePanelId(),
    listPanels: () => panelManager.listPanels().map((panel) => ({ id: panel.id, activeTabId: panel.activeTabId })),
    getEditor: (panelId: string) => panelManager.getEditor(panelId)
  });
  const chatAnnotations = createChatAnnotationsApi({
    state: window.zion.state,
    events: window.zion.events,
    commands: window.zion.commands,
    getSessionMeta: (sessionId: string) => window.zion?.commands?.executeCommand?.("zion.sessions.getMeta", sessionId),
    getActivePanelId: () => panelManager.getActivePanelId()
  });
  (window.zion as any).chatCards = chatAnnotations;
  let activateCachedEditorSlot: (panelId: string, sessionId: string, reuseAttachedProxy?: boolean) => boolean = () => false;
  let ensureEditorSlotForSession: (panelId: string, sessionId: string, seedText?: string) => any = () => null;
  const sessionRuntime = new SessionRuntime({
    getActivePanelId: () => panelManager.getActivePanelId(),
    getPanel: (panelId: string) => panelManager.getPanel(panelId) as any,
    listPanels: () => panelManager.listPanels() as any,
    getEditor: (panelId: string) => panelManager.getEditor(panelId),
    getActiveEditor: () => window.zion.window.activeEditor,
    getGlobalSessionId: () => window.zion.state.get<string>("sessions.currentId") || null,
    focusPanel: (panelId: string) => panelManager.focusPanel(panelId),
    activatePanelTab: (panelId: string, sessionId: string) => panelManager.activateTab(panelId, sessionId),
      restorePanelSession: (panelId: string, sessionId: string) => activateCachedEditorSlot(panelId, sessionId),
    syncLegacyEditorTabsState: (panelId: string) => syncLegacyEditorTabsState(panelId),
    switchSessionDocument: ({ id, panelId, previousSessionId, skipPersistPrevious }) => {
      if (!skipPersistPrevious && previousSessionId) {
        try { window.zion.commands.executeCommand("zion.sessions.flushPendingSave", previousSessionId); } catch {}
      }
      const cachedSlot = panelId ? panelEditorSlots.get(panelId)?.get(id) || null : null;
      if (panelId && cachedSlot?.loaded && activateCachedEditorSlot(panelId, id)) {
        const currentSessionId = window.zion.state.get<string>("sessions.currentId") || null;
        if (currentSessionId !== id) {
          try { window.zion.state.set("sessions.currentId", id); } catch {}
        }
        return true;
      }
      const runDocumentSwitch = () => {
        if (panelId) {
          let seedText = "";
          try {
            const prefetched = window.zion.state.get<string>(`sessions.doc.${id}`);
            if (typeof prefetched === "string") seedText = prefetched;
          } catch {}
          ensureEditorSlotForSession(panelId, id, seedText);
        }
        const result = window.zion.commands.executeCommand("zion.sessions.switch", {
          id,
          panelId,
          previousSessionId,
          skipPersistPrevious: panelId ? true : skipPersistPrevious,
          __fromPanelRuntime: true
        });
        if (!panelId) return result;
        return Promise.resolve(result).then((ok) => {
          const slot = panelEditorSlots.get(panelId)?.get(id) || null;
          if (slot && ok !== false) slot.loaded = true;
          return ok;
        });
      };
      if (panelId && !cachedSlot && typeof requestAnimationFrame === "function") {
        const panel = panelManager.getPanel(panelId);
        try { panel?.editorHostEl?.setAttribute("aria-busy", "true"); } catch {}
        return new Promise((resolve) => {
          requestAnimationFrame(() => {
            setTimeout(() => {
              if (panelManager.getPanel(panelId)?.activeTabId !== id) {
                try { panel?.editorHostEl?.removeAttribute("aria-busy"); } catch {}
                resolve(true);
                return;
              }
              Promise.resolve(runDocumentSwitch()).then(resolve).finally(() => {
                try { panel?.editorHostEl?.removeAttribute("aria-busy"); } catch {}
              });
            }, 0);
          });
        });
      }
      return runDocumentSwitch();
    },
    emit: (topic, payload) => {
      try { window.zion.events.emit(topic, payload); } catch {}
    }
  });
  (window.zion as any).sessions = {
    ...((window.zion as any).sessions || {}),
    runtime: sessionRuntime,
    resolveContext: (opts?: any) => sessionRuntime.resolveContext(opts || {}),
    getPanelSessionId: (panelId: string) => sessionRuntime.getPanelSessionId(panelId),
    isEditorShowingSession: (editor: any, sessionId: string) => sessionRuntime.isEditorShowingSession(editor, sessionId),
    parseMessages: (docText: string) => parseMessages(docText),
    getDocument: async (sessionId: string, opts?: { flush?: boolean }) => {
      const id = String(sessionId || "").trim();
      if (!id) return "";
      if (opts?.flush) {
        try { await Promise.resolve(window.zion.commands.executeCommand("zion.sessions.flushPendingSave", id)); } catch {}
      }
      try {
        const asyncDoc = await Promise.resolve(window.zion.commands.executeCommand("zion.sessions.getDocAsync", id));
        if (typeof asyncDoc === "string") return asyncDoc;
      } catch {}
      try {
        const doc = window.zion.commands.executeCommand("zion.sessions.getDoc", id);
        if (typeof doc === "string") return doc;
      } catch {}
      try {
        const cachedDoc = window.zion.state.get<string>(`sessions.doc.${id}`);
        if (typeof cachedDoc === "string") return cachedDoc;
      } catch {}
      try {
        const activeEditor = window.zion.window.activeEditor || null;
        const activeSessionId = activeEditor?.getSessionId?.()
          || activeEditor?.sessionId
          || activeEditor?.core?.getSessionId?.()
          || null;
        if (activeSessionId === id && typeof activeEditor?.getValue === "function") return activeEditor.getValue();
      } catch {}
      return "";
    },
    getMessages: async (sessionId: string, opts?: { flush?: boolean }) => {
      const docText = await (window.zion as any).sessions.getDocument(sessionId, opts);
      return parseMessages(docText);
    },
    publishDerivedTagSource: (source: any) => publishSessionDerivedTagSource(window.zion, source),
    removeDerivedTagSource: (sourceId: string) => removeSessionDerivedTagSource(window.zion, sourceId)
  };

  // 初始化插件管理器
  const pluginManager = new PluginManager({
    pluginDir: '/plugins',
    logLevel: 'info'
  });

  // 优先读缓存；没有会话时保持空编辑器，避免启动时闪过硬编码示例内容。
  const cached = savedPanelWorkspace?.manager ? "" : loadLastDoc();
  const initialDoc = cached || "";

  const core = new EditorCore(editorContainer, initialDoc, "panel-0");
  try { core.setSessionId(initialSessionId); } catch {}
  panelCores.set("panel-0", core);
  const initialProxy = attachEditor(core, "panel-0");
  try { initialProxy?.setSessionId?.(initialSessionId); } catch {}
  panelManager.setPanelEditor("panel-0", initialProxy);
  setActiveEditorPanel("panel-0");
  let suspendSessionCurrentSync = false;
  let restoringPanelWorkspace = false;
  const panelScrollPersistDisposers = new Map<string, () => void>();
  type EditorSlot = {
    panelId: string;
    sessionId: string;
    core: EditorCore;
    proxy: any;
    hostEl: HTMLElement;
    loaded: boolean;
  };
  type FilePanelSlot = {
    panelId: string;
    tabId: string;
    hostEl: HTMLElement;
    objectUrl?: string;
    codeView?: EditorView;
    customDispose?: () => void;
  };
  const panelEditorSlots = new Map<string, Map<string, EditorSlot>>();
  const panelFileSlots = new Map<string, Map<string, FilePanelSlot>>();
  const createEditorSlotHost = (panelId: string, sessionId: string) => {
    const hostEl = document.createElement("div");
    hostEl.className = "zion-editor-slot";
    hostEl.dataset.panelId = panelId;
    hostEl.dataset.sessionId = sessionId;
    hostEl.style.width = "100%";
    hostEl.style.height = "100%";
    hostEl.style.minHeight = "0";
    hostEl.style.display = "none";
    return hostEl;
  };
  const getPanelSlots = (panelId: string) => {
    let slots = panelEditorSlots.get(panelId);
    if (!slots) {
      slots = new Map<string, EditorSlot>();
      panelEditorSlots.set(panelId, slots);
    }
    return slots;
  };
  const getPanelFileSlots = (panelId: string) => {
    let slots = panelFileSlots.get(panelId);
    if (!slots) {
      slots = new Map<string, FilePanelSlot>();
      panelFileSlots.set(panelId, slots);
    }
    return slots;
  };
  const showOnlyEditorSlot = (panelId: string, sessionId: string) => {
    try { panelManager.getPanel(panelId)?.rootEl.classList.remove("is-empty-session"); } catch {}
    const slots = getPanelSlots(panelId);
    for (const [sid, slot] of slots.entries()) {
      slot.hostEl.style.display = sid === sessionId ? "" : "none";
    }
    for (const slot of getPanelFileSlots(panelId).values()) {
      slot.hostEl.style.display = "none";
    }
  };
  const disposeFileSlot = (panelId: string, tabId: string) => {
    const slot = panelFileSlots.get(panelId)?.get(tabId) || null;
    if (!slot) return;
    try { slot.customDispose?.(); } catch {}
    try { slot.codeView?.destroy(); } catch {}
    try { if (slot.objectUrl) URL.revokeObjectURL(slot.objectUrl); } catch {}
    try { slot.hostEl.remove(); } catch {}
    panelFileSlots.get(panelId)?.delete(tabId);
    try { window.zion.state.set(`files.openTabs.${tabId}`, null); } catch {}
  };
  const showOnlyFileSlot = (panelId: string, tabId: string) => {
    try { panelManager.getPanel(panelId)?.rootEl.classList.remove("is-empty-session"); } catch {}
    for (const slot of getPanelSlots(panelId).values()) {
      slot.hostEl.style.display = "none";
    }
    for (const [id, slot] of getPanelFileSlots(panelId).entries()) {
      slot.hostEl.style.display = id === tabId ? "" : "none";
    }
    panelManager.setPanelEditor(panelId, null);
    panelCores.delete(panelId);
    try { setActiveEditorPanel(panelId); } catch {}
  };
  const renderFileSlotContent = (
    hostEl: HTMLElement,
    file: any,
    meta: any,
    existingUrl?: string,
    customRender?: (container: HTMLElement, context: { meta: any }) => void | { dispose?: () => void }
  ) => {
    try { if (existingUrl) URL.revokeObjectURL(existingUrl); } catch {}
    hostEl.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "zion-file-tab-viewer";

    let objectUrl = "";
    let codeView: EditorView | undefined;
    let customDispose: (() => void) | undefined;
    if (typeof customRender === "function") {
      wrap.classList.add("is-custom");
      const customHost = document.createElement("div");
      customHost.className = "zion-file-tab-custom-host";
      wrap.appendChild(customHost);
      const result = customRender(customHost, { meta });
      customDispose = result?.dispose;
    } else if (file?.kind === "image" && file.blob instanceof Blob) {
      objectUrl = URL.createObjectURL(file.blob);
      const stage = document.createElement("div");
      stage.className = "zion-file-tab-image-stage";
      const img = document.createElement("img");
      img.className = "zion-file-tab-image";
      img.src = objectUrl;
      img.alt = String(meta?.title || "image");
      stage.appendChild(img);
      wrap.appendChild(stage);
    } else if (file?.kind === "text") {
      const codeHost = document.createElement("div");
      codeHost.className = "zion-file-tab-code-host";
      wrap.appendChild(codeHost);
      codeView = createFileCodeViewer(codeHost, String(file?.content || ""), meta);
    } else {
      const empty = document.createElement("div");
      empty.className = "zion-file-tab-empty";
      empty.textContent = "Binary preview is not supported yet.";
      wrap.appendChild(empty);
    }
    hostEl.appendChild(wrap);
    return { objectUrl, codeView, customDispose };
  };
  const activateFileTab = (panelId: string, tabId: string, opts?: { focus?: boolean }) => {
    const panel = panelManager.getPanel(panelId);
    if (!panel || !panel.tabs.some((tab) => tab.id === tabId)) return false;
    showOnlyFileSlot(panelId, tabId);
    panelManager.activateTab(panelId, tabId);
    syncLegacyEditorTabsState(panelId);
    try { window.zion.events.emit("panel/tabsChanged", { panelId }); } catch {}
    if (opts?.focus !== false) {
      try { panelManager.focusPanel(panelId); } catch {}
      try { panelFileSlots.get(panelId)?.get(tabId)?.hostEl.focus(); } catch {}
    }
    return true;
  };
  const openFileTabInPanel = (panelId: string, args: any) => {
    const panel = panelManager.getPanel(panelId);
    if (!panel) return false;
    const tabId = String(args?.id || `file:${Date.now().toString(36)}`).trim();
    const title = String(args?.title || args?.name || "File").trim() || "File";
    const meta = {
      ...(args?.meta || {}),
      title,
      path: args?.path || args?.meta?.path || "",
      displayPath: args?.displayPath || args?.meta?.displayPath || args?.path || "",
      language: args?.language || args?.meta?.language || languageFromFilename(title)
    };
    let slot = getPanelFileSlots(panelId).get(tabId) || null;
    if (!slot) {
      const hostEl = document.createElement("div");
      hostEl.className = "zion-file-tab-slot";
      hostEl.dataset.panelId = panelId;
      hostEl.dataset.tabId = tabId;
      hostEl.tabIndex = 0;
      hostEl.style.display = "none";
      panel.editorHostEl.appendChild(hostEl);
      slot = { panelId, tabId, hostEl };
      getPanelFileSlots(panelId).set(tabId, slot);
    }
    try { slot.customDispose?.(); } catch {}
    try { slot.codeView?.destroy(); } catch {}
    slot.codeView = undefined;
    slot.customDispose = undefined;
    const rendered = renderFileSlotContent(
      slot.hostEl,
      args?.file || { kind: "binary" },
      meta,
      slot.objectUrl,
      args?.render
    );
    slot.objectUrl = rendered.objectUrl;
    slot.codeView = rendered.codeView;
    slot.customDispose = rendered.customDispose;
    try { window.zion.state.set(`files.openTabs.${tabId}`, meta); } catch {}
    const existingIndex = panel.tabs.findIndex((tab) => tab.id === tabId);
    const nextTab = { id: tabId, title, isDirty: false, kind: "file" as const, meta };
    if (existingIndex >= 0) panel.tabs[existingIndex] = nextTab;
    else panel.tabs = [...panel.tabs, nextTab];
    return activateFileTab(panelId, tabId, { focus: args?.focus === true });
  };
  try {
    window.zion.events.on("ui/inspectorOpenInEditor", ({ item } = {}) => {
      if (!item || item.file?.kind === "loading") return false;
      const panelId = String(panelManager.getActivePanelId() || "panel-0");
      return openFileTabInPanel(panelId, {
        id: `file:inspector:${String(item.id || Date.now())}`,
        title: item.title,
        path: item.path,
        displayPath: item.displayPath,
        language: item.language,
        file: item.file,
        focus: true
      });
    });
  } catch {}
  const registerEditorSlot = (panelId: string, sessionId: string, slotCore: EditorCore, proxy: any, hostEl?: HTMLElement, loaded = false) => {
    const panel = panelManager.getPanel(panelId);
    const slotHost = hostEl || createEditorSlotHost(panelId, sessionId);
    try {
      if (!hostEl) {
        panel?.editorHostEl?.appendChild(slotHost);
        if (!slotHost.contains(slotCore.view.dom)) slotHost.appendChild(slotCore.view.dom);
      } else if (!slotHost.contains(slotCore.view.dom)) {
        slotHost.appendChild(slotCore.view.dom);
      }
    } catch {}
    try { slotCore.setSessionId(sessionId); } catch {}
    try { proxy?.setSessionId?.(sessionId); } catch {}
    const slot: EditorSlot = { panelId, sessionId, core: slotCore, proxy, hostEl: slotHost, loaded };
    getPanelSlots(panelId).set(sessionId, slot);
    return slot;
  };
  if (initialSessionId) {
    const initialHost = createEditorSlotHost("panel-0", initialSessionId);
    try {
      editorContainer.appendChild(initialHost);
      initialHost.appendChild(core.view.dom);
    } catch {}
    registerEditorSlot("panel-0", initialSessionId, core, initialProxy, initialHost, true);
    showOnlyEditorSlot("panel-0", initialSessionId);
  }
  activateCachedEditorSlot = (panelId: string, sessionId: string, reuseAttachedProxy = false) => {
    const slot = panelEditorSlots.get(panelId)?.get(sessionId) || null;
    if (!slot) {
      return false;
    }
    const proxy = reuseAttachedProxy ? slot.proxy : attachEditor(slot.core, panelId);
    try { proxy?.setSessionId?.(sessionId); } catch {}
    slot.proxy = proxy;
    panelManager.setPanelEditor(panelId, proxy);
    panelCores.set(panelId, slot.core);
    showOnlyEditorSlot(panelId, sessionId);
    if (panelManager.getPanel(panelId)?.activeTabId !== sessionId) {
      try { panelManager.activateTab(panelId, sessionId); } catch {}
    }
    try { setActiveEditorPanel(panelId); } catch {}
    return true;
  };
  ensureEditorSlotForSession = (panelId: string, sessionId: string, seedText = "") => {
    const existing = panelEditorSlots.get(panelId)?.get(sessionId) || null;
    if (existing) {
      activateCachedEditorSlot(panelId, sessionId);
      return existing;
    }
    const panel = panelManager.getPanel(panelId);
    if (!panel) return null;
    const slots = getPanelSlots(panelId);
    if (slots.size === 0) {
      const staleCore = panelCores.get(panelId);
      try { staleCore?.dispose?.(); } catch {}
      try { panel.editorHostEl.innerHTML = ""; } catch {}
    }
    const hostEl = createEditorSlotHost(panelId, sessionId);
    panel.editorHostEl.appendChild(hostEl);
    const slotCore = new EditorCore(hostEl, "", panelId);
    const proxy = attachEditor(slotCore, panelId);
    const slot = registerEditorSlot(panelId, sessionId, slotCore, proxy, hostEl, false);
    if (seedText) slotCore.setValue(seedText, { source: "session-seed" });
    activateCachedEditorSlot(panelId, sessionId, true);
    return slot;
  };
  const disposeEditorSlotForSession = (panelId: string, sessionId: string) => {
    const slot = panelEditorSlots.get(panelId)?.get(sessionId) || null;
    if (!slot) return;
    try { slot.core.dispose(); } catch {}
    try { slot.hostEl.remove(); } catch {}
    panelEditorSlots.get(panelId)?.delete(sessionId);
  };
  const showPanelEmptyState = (panelId: string) => {
    const panel = panelManager.getPanel(panelId);
    if (!panel || panel.tabs.length > 0) return;
    try { panel.rootEl.classList.add("is-empty-session"); } catch {}
    try { panelCores.get(panelId)?.dispose?.(); } catch {}
    try { detachEditor(panelId); } catch {}
    try { panel.editorHostEl.innerHTML = ""; } catch {}
    const empty = document.createElement("div");
    empty.className = "zion-panel-empty";
    empty.innerHTML = `
      <div class="zion-panel-empty-content">
        <div class="zion-panel-empty-title">暂无打开的会话</div>
        <div class="zion-panel-empty-hint">双击创建会话</div>
        <div class="zion-panel-empty-hint">Cmd+T 创建会话</div>
        <div class="zion-panel-empty-hint">Cmd+Enter 运行聊天</div>
      </div>
    `;
    empty.ondblclick = (e) => {
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch {}
      try { window.zion.commands.executeCommand("zion.sessions.new", { panelId }); } catch {}
    };
    panel.editorHostEl.appendChild(empty);
    panelManager.setPanelEditor(panelId, null);
    panelCores.delete(panelId);
    try { setActiveEditorPanel(panelId); } catch {}
  };
  if (!initialSessionId) showPanelEmptyState("panel-0");
  const syncPanelSessionToCurrent = (panelId: string | null): string | null => {
    const activeTabId = panelId ? panelManager.getPanel(panelId)?.activeTabId || null : null;
    if (isFilePanelTabId(activeTabId)) return null;
    if (activeTabId && window.zion.state.get<string>("sessions.currentId") !== activeTabId) {
      try { window.zion.state.set("sessions.currentId", activeTabId); } catch {}
    }
    return activeTabId;
  };
  const requestPanelSessionReveal = (panelId: string | null, reason: string) => {
    const sessionId = syncPanelSessionToCurrent(panelId);
    if (!sessionId) return;
    try {
      window.zion.events.emit("sessions/revealRequested", {
        sessionId,
        panelId,
        reason
      });
    } catch {}
  };
  const bindPanelEditorReveal = (panelId: string) => {
    const panel = panelManager.getPanel(panelId);
    const hostEl = panel?.editorHostEl as (HTMLElement & { dataset: DOMStringMap }) | undefined;
    if (!hostEl || hostEl.dataset.sessionRevealBound === "true") return;
    hostEl.dataset.sessionRevealBound = "true";
    hostEl.addEventListener("mousedown", () => syncPanelSessionToCurrent(panelId), true);
    hostEl.addEventListener("focusin", () => syncPanelSessionToCurrent(panelId), true);
  };
  for (const panel of panelManager.listPanels()) bindPanelEditorReveal(panel.id);
  panelManager.on("panel/created", ({ panelId }) => bindPanelEditorReveal(panelId));
  panelManager.on("panel/focusChanged", ({ panelId }) => {
    setActiveEditorPanel(panelId);
    syncPanelSessionToCurrent(panelId);
  });
  panelManager.on("panel/tabActivated", ({ panelId, tabId, sessionId }: any) => {
    notePanelTabVisit(panelId, sessionId || tabId || null);
  });
  if (initialSessionId) notePanelTabVisit("panel-0", initialSessionId);
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
  const openSessionInPanel = (panelId: string, sessionId: string | null, opts?: { focus?: boolean; forceReload?: boolean }) => {
    return sessionRuntime.openPanelSession(panelId, sessionId, opts);
  };
  const activatePanelSession = (panelId: string, sessionId: string | null) => {
    if (isFilePanelTabId(sessionId)) return activateFileTab(panelId, sessionId as string);
    return sessionRuntime.switchPanelSession(panelId, sessionId);
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
  const persistPanelWorkspaceNow = () => {
    try { savePanelWorkspaceSnapshotNow(buildPanelWorkspaceSnapshot()); } catch {}
  };
  const reloadWindowPreservingWorkspace = async () => {
    persistPanelWorkspaceNow();
    try { window.zion?.state?.set("sessions.reloadPreparing", true); } catch {}
    try {
      const commands = window.zion?.commands;
      const available = commands?.list?.() || [];
      if (available.includes("zion.sessions.prepareForReload")) {
        const prepared = await Promise.resolve(
          commands.executeCommand("zion.sessions.prepareForReload")
        );
        if (prepared !== true) {
          try { window.zion?.state?.set("sessions.reloadPreparing", false); } catch {}
          notificationManager.show("会话尚未完成保存，已取消重新加载。", {
            type: "warning",
            duration: 3000
          });
          return false;
        }
      }
    } catch (error) {
      try { window.zion?.state?.set("sessions.reloadPreparing", false); } catch {}
      console.error("[zion] failed to prepare session storage for reload", error);
      notificationManager.show("会话尚未完成保存，已取消重新加载。", {
        type: "warning",
        duration: 3000
      });
      return false;
    }
    try {
      window.zion?.state?.set("sessions.reloadPreparing", false);
      window.zion?.state?.set("sessions.intentionalReload", true);
    } catch {}
    requestAnimationFrame(() => location.reload());
    return true;
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
    restoringPanelWorkspace = true;
    const restored = panelManager.restoreState(savedPanelWorkspace.manager);
    if (!restored) {
      suspendSessionCurrentSync = false;
      restoringPanelWorkspace = false;
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
              skipPersistPrevious: true,
              forceReload: true,
              writeUrl: false,
              pushUrl: false
            })
          );
        }
        for (const panel of panelManager.listPanels()) {
          if (!panel.activeTabId && panel.tabs.length === 0) showPanelEmptyState(panel.id);
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
              skipPersistPrevious: true,
              forceReload: true,
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
            restoringPanelWorkspace = false;
            schedulePanelWorkspacePersist();
          }
        }));
      } catch {
        suspendSessionCurrentSync = false;
        restoringPanelWorkspace = false;
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
      disposeEditorSlotForSession(panelId, tabId);
      disposeFileSlot(panelId, tabId);
      if (panelManager.listPanels().length <= 1) {
        panel.tabs = [];
        panel.activeTabId = null;
        try { panelManager.activateTab(panelId, null); } catch {}
        try { window.zion.state.set("sessions.currentId", null); } catch {}
        clearPersistedActiveSession();
        showPanelEmptyState(panelId);
        syncLegacyEditorTabsState(panelId);
        try { window.zion.events.emit("panel/tabsChanged", { panelId }); } catch {}
        savePanelWorkspaceSnapshotNow(buildPanelWorkspaceSnapshot());
        return true;
      }
      panelManager.closePanel(panelId);
      const nextPanelId = panelManager.getActivePanelId();
      if (!nextPanelId) return true;
      syncLegacyEditorTabsState(nextPanelId);
      const nextPanel = panelManager.getPanel(nextPanelId);
      return activatePanelSession(nextPanelId, nextPanel?.activeTabId || nextPanel?.tabs[0]?.id || null) || true;
    }
    const nextTabs = panel.tabs.filter((tab) => tab.id !== tabId);
    const wasActive = panel.activeTabId === tabId;
    const closingSlot = panelEditorSlots.get(panelId)?.get(tabId) || null;
    if (closingSlot) {
      try { closingSlot.core.dispose(); } catch {}
      try { closingSlot.hostEl.remove(); } catch {}
      panelEditorSlots.get(panelId)?.delete(tabId);
    }
    disposeFileSlot(panelId, tabId);
    panel.tabs = nextTabs;
    const nextId = wasActive
      ? pickPreviousVisitedPanelTab(panelId, tabId, nextTabs, idx)
      : (panel.activeTabId || nextTabs[0]?.id || null);
    syncLegacyEditorTabsState(panelId);
    try { window.zion.events.emit("panel/tabsChanged", { panelId }); } catch {}
    if (!wasActive || !nextId) return true;
    activatePanelSession(panelId, nextId);
    return true;
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
      if (panelManager.listPanels().length > 1) return;
      const activePanelId = panelManager.getActivePanelId();
      if (!activePanelId) return;
      const panel = panelManager.getPanel(activePanelId);
      if (!panel || !sessionId) return;
      if (isFilePanelTabId(panel.activeTabId)) return;
      const exists = panel.tabs.some((tab) => tab.id === sessionId);
      if (!exists) {
        panel.tabs = [...panel.tabs, { id: sessionId, title: sessionId, isDirty: false }];
          try { window.zion.events.emit("panel/tabsChanged", { panelId: activePanelId, sessionId }); } catch {}
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
    if (sourcePanelId && sourceSessionId) {
      try {
        window.zion.commands.executeCommand("zion.chatCards.snapshotSession", {
          panelId: sourcePanelId,
          sessionId: sourceSessionId
        });
      } catch {}
    }
    const seedText = restoringPanelWorkspace || seedFromSource === false
      ? ""
      : (sourceEditor?.getValue?.() || core.getValue());
    const activeSessionId = panel.activeTabId || (seedFromSource === false
      ? null
      : (sourceSessionId || window.zion.state.get<string>("sessions.currentId") || null));
    const slotHost = activeSessionId ? createEditorSlotHost(panelId, activeSessionId) : null;
    try {
      if (slotHost) panel.editorHostEl.appendChild(slotHost);
    } catch {}
    const editorInitialText = activeSessionId && seedText ? "" : seedText;
    const nextCore = new EditorCore(slotHost || panel.editorHostEl, editorInitialText, panelId);
    panelCores.set(panelId, nextCore);
    const nextProxy = attachEditor(nextCore, panelId);
    panelManager.setPanelEditor(panelId, nextProxy);
    try { applyEditorPreferences(nextCore); } catch {}
    try { nextProxy?.setSessionId?.(activeSessionId); } catch {}
    if (seedText !== editorInitialText) {
      try { nextCore.setValue(seedText, { source: "session-load" }); } catch {}
    }
    if (activeSessionId) {
      registerEditorSlot(panelId, activeSessionId, nextCore, nextProxy, slotHost || undefined, seedFromSource !== false);
      if (!restoringPanelWorkspace) {
        panel.tabs = [{ id: activeSessionId, title: activeSessionId, isDirty: false }];
        panel.activeTabId = activeSessionId;
      }
      if (!restoringPanelWorkspace) {
        try {
          window.zion?.commands?.executeCommand?.("zion.chatCards.restoreSession", {
            sessionId: activeSessionId,
            panelId,
            clearFirst: false
          });
        } catch {}
      }
      showOnlyEditorSlot(panelId, activeSessionId);
      panelManager.activateTab(panelId, activeSessionId);
    }
    mountCurrentSessionPath(panel.pathEl, panelId);
    mountPanelSessionTabsBar(panel.tabsBarEl, panelId, panelManager, {
      onTabRemovedFromPanel: (pid, tabId) => {
        disposeEditorSlotForSession(pid, tabId);
        disposeFileSlot(pid, tabId);
        showPanelEmptyState(pid);
      }
    });
    mountEditorHeaderTOCButton(panel.pathEl);
    mountEditorHeaderSessionRenameButton(panel.pathEl, panelId);
    mountEditorHeaderSplitMenuButton(panel.pathEl);
    mountEditorHeaderSettingsMenu(panel.pathEl);
    mountPanelHeaderRunStopButton(panel.pathEl, panelId, () => panelManager.getEditor(panelId));
    attachPanelScrollPersistence(panelId);
    try { nextProxy.focus(); } catch {}
    try { restoreSplitViewportFromSource(sourceEditor, nextProxy); } catch {}
    schedulePanelWorkspacePersist();
  });
  panelManager.on("panel/closed", ({ panelId }) => {
    const closingCore = panelCores.get(panelId);
    const closingSlots = panelEditorSlots.get(panelId);
    if (closingSlots) {
      for (const slot of closingSlots.values()) {
        try { slot.core.dispose(); } catch {}
        try { slot.hostEl.remove(); } catch {}
      }
      panelEditorSlots.delete(panelId);
    }
    const closingFileSlots = panelFileSlots.get(panelId);
    if (closingFileSlots) {
      for (const slot of closingFileSlots.values()) {
        try { slot.codeView?.destroy(); } catch {}
        try { if (slot.objectUrl) URL.revokeObjectURL(slot.objectUrl); } catch {}
        try { slot.hostEl.remove(); } catch {}
        try { window.zion.state.set(`files.openTabs.${slot.tabId}`, null); } catch {}
      }
      panelFileSlots.delete(panelId);
    }
    try { panelScrollPersistDisposers.get(panelId)?.(); } catch {}
    panelScrollPersistDisposers.delete(panelId);
    try { detachEditor(panelId); } catch {}
    try { closingCore?.dispose?.(); } catch {}
    panelCores.delete(panelId);
    editorPathInlineRenameHandlers.delete(panelId);
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
  const installInactivePanelFocusReturnScrollGuard = () => {
    try {
      const proto = Element.prototype as any;
      if (proto.__zionInactivePanelFocusReturnScrollGuard) return;
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
      if (!descriptor?.get || !descriptor?.set) return;
      proto.__zionInactivePanelFocusReturnScrollGuard = true;
      let focusReturnUntil = 0;
      let lastPointerPanelId = "";
      let lastPointerAt = 0;
      const markFocusReturn = () => { focusReturnUntil = Date.now() + 320; };
      const panelIdOf = (el: Element | null | undefined) => {
        try { return el?.closest?.("[data-panel-id]")?.getAttribute?.("data-panel-id") || ""; } catch { return ""; }
      };
      document.addEventListener("pointerdown", (ev) => {
        const target = ev.target as Element | null;
        lastPointerPanelId = panelIdOf(target);
        lastPointerAt = Date.now();
      }, true);
      window.addEventListener("focus", markFocusReturn, true);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) markFocusReturn();
      }, true);
      const nativeScrollTo = (proto as any).scrollTo;
      if (typeof nativeScrollTo === "function") {
        Object.defineProperty(proto, "scrollTo", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: function guardedScrollTo(this: Element, ...args: any[]) {
            return nativeScrollTo.apply(this, args);
          }
        });
      }
      Object.defineProperty(Element.prototype, "scrollTop", {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: function guardedScrollTopGetter(this: Element) {
          return descriptor.get?.call(this);
        },
        set: function guardedScrollTopSetter(this: Element, value: number) {
          try {
            const el = this as HTMLElement;
              const before = Number(descriptor.get?.call(this) || 0);
            const panelId = panelIdOf(el);
            const activePanelId = panelManager.getActivePanelId?.() || "";
            const focusedPanelId = panelIdOf(document.activeElement as Element | null);
            const isRecentPointerPanel = panelId && panelId === lastPointerPanelId && Date.now() - lastPointerAt < 700;
            const isInactiveEditorScroller =
              Date.now() <= focusReturnUntil &&
              el.classList?.contains("cm-scroller") &&
              panelId &&
              panelId !== activePanelId &&
              panelId !== focusedPanelId &&
              !isRecentPointerPanel;
            if (isInactiveEditorScroller) {
              if (Math.round(before) !== Math.round(Number(value) || 0)) return;
            }
          } catch {}
          descriptor.set?.call(this, value);
        }
      });
    } catch {}
  };
  installInactivePanelFocusReturnScrollGuard();
  try {
    window.addEventListener("beforeunload", () => sessionSync.dispose(), { once: true });
  } catch {}
  mountCurrentSessionPath(editorHeaderPathEl, "panel-0");
  mountPanelSessionTabsBar(editorTabsBarEl, "panel-0", panelManager, {
    onTabRemovedFromPanel: (pid, tabId) => {
      disposeEditorSlotForSession(pid, tabId);
      disposeFileSlot(pid, tabId);
      showPanelEmptyState(pid);
    }
  });
  mountEditorHeaderTOCButton(editorHeaderPathEl);
  mountEditorHeaderSessionRenameButton(editorHeaderPathEl, "panel-0");
  mountEditorHeaderSplitMenuButton(editorHeaderPathEl);
  mountEditorHeaderSettingsMenu(editorHeaderPathEl);
  mountPanelHeaderRunStopButton(editorHeaderPathEl, "panel-0", () => panelManager.getEditor("panel-0"));
  restorePanelWorkspaceWhenReady();

  try {
    initServiceBaseUrlConfig();
  } catch {}

  try {
    (window as any).zion.commands.registerCommand("settings.open", () => {
      try { (window as any).zion.settings.open(); } catch {}
    });
    (window as any).zion.commands.registerCommand("zion.settings.show", () => {
      try { (window as any).zion.settings.open(); } catch {}
    });
    (window as any).zion.commands.registerCommand(
      "zion.reloadWindow",
      () => reloadWindowPreservingWorkspace()
    );
  } catch (e) {
    console.warn("[zion] failed to register settings commands", e);
  }

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

  // Locale init + commands + plugin API
  const i18nManager = createI18nManager();
  i18nManager.init();

  // Theme init + commands + status + settings
  const themeManager = createThemeManager({
    getEditorCores: () => panelCores.values()
  });
  themeManager.init();
  window.zion.commands.registerCommand("zion.panels.splitHorizontal", () => panelManager.splitPanel(undefined, "horizontal"));
  window.zion.commands.registerCommand("zion.panels.splitVertical", () => panelManager.splitPanel(undefined, "vertical"));
  window.zion.commands.registerCommand("zion.panels.newSessionOnRight", async () => {
    const sourcePanelId = panelManager.getActivePanelId();
    if (!sourcePanelId) return false;
    const created = panelManager.splitPanelAt(sourcePanelId, "right", { seedFromSource: false });
    const panelId = created?.id || null;
    if (!panelId) return false;
    try { panelManager.focusPanel(panelId); } catch {}
    try {
      await Promise.resolve(window.zion.commands.executeCommand("zion.sessions.new", { panelId, focus: true }));
      return true;
    } catch {
      return false;
    }
  });
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
  window.zion.commands.registerCommand("zion.sessions.renameInline", (opts?: any) => {
    const panelId = opts?.panelId || panelManager.getActivePanelId?.() || null;
    const handler = (panelId && editorPathInlineRenameHandlers.get(panelId)) || editorPathInlineRenameHandlers.get(EDITOR_PATH_RENAME_FALLBACK_KEY);
    if (handler?.(opts)) return true;
    try {
      return !!window.zion.commands.executeCommand("zion.sessions.rename", opts || {});
    } catch {
      return false;
    }
  });

  const PANEL_FOCUS_HIGHLIGHT_KEY = "zion.panelFocusHighlight";
  let panelFocusHighlightEnabled = (() => {
    try {
      return localStorage.getItem(PANEL_FOCUS_HIGHLIGHT_KEY) !== "false";
    } catch {
      return true;
    }
  })();
  const applyPanelFocusHighlight = (enabled: boolean) => {
    panelFocusHighlightEnabled = !!enabled;
    try { localStorage.setItem(PANEL_FOCUS_HIGHLIGHT_KEY, panelFocusHighlightEnabled ? "true" : "false"); } catch {}
    try {
      document.documentElement.setAttribute(
        "data-panel-focus-highlight",
        panelFocusHighlightEnabled ? "enabled" : "disabled"
      );
    } catch {}
    try { window.zion.state.set("ui.panelFocusHighlight", panelFocusHighlightEnabled); } catch {}
    return panelFocusHighlightEnabled;
  };
  applyPanelFocusHighlight(panelFocusHighlightEnabled);
  window.zion.commands.registerCommand("zion.panels.setFocusHighlight", (enabled: boolean) => applyPanelFocusHighlight(!!enabled));
  window.zion.commands.registerCommand("zion.panels.toggleFocusHighlight", () => applyPanelFocusHighlight(!panelFocusHighlightEnabled));

  try {
    (window as any).zion.settings.registerPage({
      id: "workspace.panels",
      title: "Panels",
      category: "workspace",
      order: 30,
      keywords: ["panel", "editor", "focus", "highlight", "split"],
      sections: [
        {
          id: "workspace.panels.appearance",
          title: "Appearance",
          settings: [
            {
              id: "workspace.panels.focusHighlight",
              label: "Highlight focused editor",
              description: "Show a subtle border and glow around the currently focused editor when multiple panels are open.",
              kind: "boolean",
              scope: "workspace",
              defaultValue: true,
              getValue: () => panelFocusHighlightEnabled,
              setValue: (value: unknown) => applyPanelFocusHighlight(!!value)
            }
          ]
        }
      ]
    });
  } catch (e) {
    console.warn("[zion] failed to register panel settings", e);
  }

  try {
    window.zion.keybindings.register({ command: "zion.panels.splitHorizontal", key: "Mod-\\", when: "editorFocus" });
    window.zion.keybindings.register({ command: "zion.panels.splitVertical", key: "Mod-Shift-\\", when: "editorFocus" });
    window.zion.keybindings.register({ command: "zion.panels.newSessionOnRight", key: "Mod-Shift-t", when: "editorFocus" });
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
      const key = String(ev.key || "").toLowerCase();
      const code = String(ev.code || "");
      if (ev.altKey && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && (code === "KeyV" || key === "v" || key === "◊")) {
        return handleEditorShortcut(ev, "zion.toggleVimMode");
      }
      const mod = ev.metaKey || ev.ctrlKey;
      if (!mod) return;
      if (!ev.altKey && !ev.shiftKey && (key === "r" || code === "KeyR")) return handleEditorShortcut(ev, "zion.sessions.autoRename");
      if (!ev.altKey && ev.shiftKey && (key === "r" || code === "KeyR")) return handleEditorShortcut(ev, "zion.sessions.renameInline");
      if (!ev.altKey && !ev.shiftKey && (key === "t" || code === "KeyT")) return handleEditorShortcut(ev, "zion.sessions.new");
      if (!ev.altKey && ev.shiftKey && (key === "t" || code === "KeyT")) return handleEditorShortcut(ev, "zion.panels.newSessionOnRight");
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
  let wysiwygKeepActiveLineRendered: boolean = (() => {
    try {
      const v = localStorage.getItem("zion.wysiwyg.keepActiveLineRendered");
      if (v === "0" || v === "false") return false;
      if (v === "1" || v === "true") return true;
      return true; // default ON: focusing a line keeps rendered Markdown.
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
  const applyWysiwygKeepActiveLineRendered = (enabled: boolean) => {
    wysiwygKeepActiveLineRendered = enabled;
    try {
      localStorage.setItem("zion.wysiwyg.keepActiveLineRendered", enabled ? "1" : "0");
    } catch {}
    forEachPanelCore((targetCore) => targetCore.setWysiwygKeepActiveLineRendered(enabled));
    window.zion.state.set("ui.wysiwyg.keepActiveLineRendered", enabled);
  };

  window.zion.commands.registerCommand("zion.setWysiwyg", (enabled: boolean) => applyWysiwyg(!!enabled));
  window.zion.commands.registerCommand("zion.toggleWysiwyg", () => applyWysiwyg(!wysiwygEnabled));
  window.zion.commands.registerCommand("zion.setWysiwygKeepActiveLineRendered", (enabled: boolean) => applyWysiwygKeepActiveLineRendered(!!enabled));
  window.zion.commands.registerCommand("zion.toggleWysiwygKeepActiveLineRendered", () => applyWysiwygKeepActiveLineRendered(!wysiwygKeepActiveLineRendered));
  applyWysiwyg(wysiwygEnabled);
  applyWysiwygKeepActiveLineRendered(wysiwygKeepActiveLineRendered);
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
    reg.register({
      id: "core.wysiwyg.keepActiveLineRendered.headerMenu",
      title: "Keep Focused Line Rendered",
      section: "Editor",
      order: 16.1,
      kind: "toggle",
      getChecked: () => !!window.zion.state.get("ui.wysiwyg.keepActiveLineRendered"),
      onClick: () => window.zion.commands.executeCommand("zion.toggleWysiwygKeepActiveLineRendered")
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

  let vimModeEnabled: boolean = (() => {
    try {
      const v = localStorage.getItem("zion.vimMode");
      if (v === "0" || v === "false") return false;
      if (v === "1" || v === "true") return true;
      return false;
    } catch {
      return false;
    }
  })();
  let vimOperationalMode: VimOperationalMode = "normal";
  const vimOperationalModeDisposers = new WeakMap<EditorCore, Disposable>();
  let applyingGlobalVimOperationalMode = false;

  type EditorFontFamilyPreset = "system-sans" | "system-mono" | "serif" | "custom";
  const EDITOR_FONT_FAMILY_PRESETS = new Set<EditorFontFamilyPreset>(["system-sans", "system-mono", "serif", "custom"]);
  const EDITOR_APPEARANCE_DEFAULTS = {
    fontFamilyPreset: "system-sans" as EditorFontFamilyPreset,
    customFontFamily: "",
    fontSize: 13,
    lineHeight: 1.6,
    textColor: ""
  };

  const readStoredString = (key: string, fallback: string) => {
    try {
      const value = localStorage.getItem(key);
      return value == null ? fallback : value;
    } catch {
      return fallback;
    }
  };

  const parseNumberPreference = (value: unknown, fallback: number, min: number, max: number) => {
    const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  const sanitizeFontFamily = (value: unknown) => {
    const raw = String(value ?? "").trim().slice(0, 180);
    if (!raw || /[;{}<>]/.test(raw) || /[\r\n]/.test(raw)) return "";
    return raw;
  };

  const normalizeOptionalColor = (value: unknown) => String(value ?? "").trim().slice(0, 80);

  const validateOptionalColor = (value: unknown) => {
    const color = normalizeOptionalColor(value);
    if (!color) return null;
    try {
      if (CSS.supports?.("color", color)) return null;
    } catch {}
    return "请输入有效的 CSS 颜色，例如 #d1d5db、rgb(209 213 219)；留空则跟随主题。";
  };

  const validateFontFamily = (value: unknown) => {
    const raw = String(value ?? "");
    if (!raw.trim()) return null;
    if (raw.length > 180 || /[;{}<>]/.test(raw) || /[\r\n]/.test(raw)) {
      return "字体名称只能包含字体族列表，不能包含 CSS 语句或换行。";
    }
    return null;
  };

  const validateNumberRange = (value: unknown, min: number, max: number, unitLabel: string) => {
    const n = Number(String(value ?? "").trim());
    if (!Number.isFinite(n)) return `请输入有效数字。`;
    if (n < min || n > max) return `请输入 ${min} 到 ${max} ${unitLabel}之间的数值。`;
    return null;
  };

  const normalizeFontFamilyPreset = (value: unknown): EditorFontFamilyPreset => {
    const raw = String(value ?? "");
    return EDITOR_FONT_FAMILY_PRESETS.has(raw as EditorFontFamilyPreset)
      ? raw as EditorFontFamilyPreset
      : EDITOR_APPEARANCE_DEFAULTS.fontFamilyPreset;
  };

  let editorFontFamilyPreset = normalizeFontFamilyPreset(readStoredString("zion.editor.fontFamilyPreset", EDITOR_APPEARANCE_DEFAULTS.fontFamilyPreset));
  let editorCustomFontFamily = sanitizeFontFamily(readStoredString("zion.editor.customFontFamily", EDITOR_APPEARANCE_DEFAULTS.customFontFamily));
  let editorFontSize = parseNumberPreference(readStoredString("zion.editor.fontSize", String(EDITOR_APPEARANCE_DEFAULTS.fontSize)), EDITOR_APPEARANCE_DEFAULTS.fontSize, 10, 24);
  let editorLineHeight = parseNumberPreference(readStoredString("zion.editor.lineHeight", String(EDITOR_APPEARANCE_DEFAULTS.lineHeight)), EDITOR_APPEARANCE_DEFAULTS.lineHeight, 1.2, 2.4);
  let editorTextColor = normalizeOptionalColor(readStoredString("zion.editor.textColor", EDITOR_APPEARANCE_DEFAULTS.textColor));

  const getEditorFontFamilyCss = () => {
    if (editorFontFamilyPreset === "system-mono") return "var(--font-mono)";
    if (editorFontFamilyPreset === "serif") return "Georgia, 'Times New Roman', 'Noto Serif SC', 'Songti SC', serif";
    if (editorFontFamilyPreset === "custom") return editorCustomFontFamily || "var(--font-sans)";
    return "var(--font-sans)";
  };

  const applyEditorAppearancePreferences = () => {
    const root = document.documentElement;
    root.style.setProperty("--editor-content-font-family", getEditorFontFamilyCss());
    root.style.setProperty("--editor-content-font-size", `${editorFontSize}px`);
    root.style.setProperty("--editor-content-line-height", String(editorLineHeight));
    if (editorTextColor) root.style.setProperty("--editor-text-fg", editorTextColor);
    else root.style.removeProperty("--editor-text-fg");
    try {
      window.zion.state.set("ui.editorAppearance", {
        fontFamilyPreset: editorFontFamilyPreset,
        customFontFamily: editorCustomFontFamily,
        fontSize: editorFontSize,
        lineHeight: editorLineHeight,
        textColor: editorTextColor
      });
    } catch {}
  };

  const setEditorFontFamilyPreset = (value: unknown) => {
    editorFontFamilyPreset = normalizeFontFamilyPreset(value);
    try { localStorage.setItem("zion.editor.fontFamilyPreset", editorFontFamilyPreset); } catch {}
    applyEditorAppearancePreferences();
  };

  const setEditorCustomFontFamily = (value: unknown) => {
    editorCustomFontFamily = sanitizeFontFamily(value);
    try { localStorage.setItem("zion.editor.customFontFamily", editorCustomFontFamily); } catch {}
    applyEditorAppearancePreferences();
  };

  const setEditorFontSize = (value: unknown) => {
    editorFontSize = parseNumberPreference(value, EDITOR_APPEARANCE_DEFAULTS.fontSize, 10, 24);
    try { localStorage.setItem("zion.editor.fontSize", String(editorFontSize)); } catch {}
    applyEditorAppearancePreferences();
  };

  const setEditorLineHeight = (value: unknown) => {
    editorLineHeight = parseNumberPreference(value, EDITOR_APPEARANCE_DEFAULTS.lineHeight, 1.2, 2.4);
    try { localStorage.setItem("zion.editor.lineHeight", String(editorLineHeight)); } catch {}
    applyEditorAppearancePreferences();
  };

  const setEditorTextColor = (value: unknown) => {
    editorTextColor = normalizeOptionalColor(value);
    try { localStorage.setItem("zion.editor.textColor", editorTextColor); } catch {}
    applyEditorAppearancePreferences();
  };

  const resetEditorAppearanceSetting = (key: "fontFamilyPreset" | "customFontFamily" | "fontSize" | "lineHeight" | "textColor") => {
    if (key === "fontFamilyPreset") {
      editorFontFamilyPreset = EDITOR_APPEARANCE_DEFAULTS.fontFamilyPreset;
      try { localStorage.removeItem("zion.editor.fontFamilyPreset"); } catch {}
    } else if (key === "customFontFamily") {
      editorCustomFontFamily = EDITOR_APPEARANCE_DEFAULTS.customFontFamily;
      try { localStorage.removeItem("zion.editor.customFontFamily"); } catch {}
    } else if (key === "fontSize") {
      editorFontSize = EDITOR_APPEARANCE_DEFAULTS.fontSize;
      try { localStorage.removeItem("zion.editor.fontSize"); } catch {}
    } else if (key === "lineHeight") {
      editorLineHeight = EDITOR_APPEARANCE_DEFAULTS.lineHeight;
      try { localStorage.removeItem("zion.editor.lineHeight"); } catch {}
    } else {
      editorTextColor = EDITOR_APPEARANCE_DEFAULTS.textColor;
      try { localStorage.removeItem("zion.editor.textColor"); } catch {}
    }
    applyEditorAppearancePreferences();
  };

  function forEachPanelCore(fn: (targetCore: EditorCore) => void) {
    try { fn(core); } catch {}
    try {
      for (const [panelId, targetCore] of panelCores.entries()) {
        if (panelId === "panel-0" || targetCore === core) continue;
        try { fn(targetCore); } catch {}
      }
    } catch {}
  }

  function forEachAttachedEditorCore(fn: (targetCore: EditorCore) => void) {
    const seen = new Set<EditorCore>();
    const visit = (targetCore: EditorCore | null | undefined) => {
      if (!targetCore || seen.has(targetCore)) return;
      seen.add(targetCore);
      try { fn(targetCore); } catch {}
    };
    try { visit(core); } catch {}
    try {
      for (const targetCore of panelCores.values()) visit(targetCore);
    } catch {}
    try {
      for (const targetCore of listAttachedEditorCores()) visit(targetCore);
    } catch {}
  }

  function isFocusedEditorCore(targetCore: EditorCore | null | undefined): boolean {
    try {
      const active = document.activeElement;
      return !!active && !!targetCore?.view?.dom?.contains?.(active);
    } catch {
      return false;
    }
  }

  function applyVimOperationalModeToAll(mode: VimOperationalMode) {
    if (!vimModeEnabled) return;
    applyingGlobalVimOperationalMode = true;
    try {
      forEachAttachedEditorCore((targetCore) => {
        targetCore.setVimOperationalMode(mode, { preserveViewState: !isFocusedEditorCore(targetCore) });
      });
    } finally {
      applyingGlobalVimOperationalMode = false;
    }
  }

  function registerVimOperationalModeSync(targetCore: EditorCore | null | undefined) {
    if (!targetCore || vimOperationalModeDisposers.has(targetCore)) return;
    try {
      vimOperationalModeDisposers.set(targetCore, targetCore.onVimOperationalModeChange((mode) => {
        if (applyingGlobalVimOperationalMode || !vimModeEnabled) return;
        vimOperationalMode = mode;
        try { window.zion.state.set("ui.editor.vimOperationalMode", mode); } catch {}
        applyVimOperationalModeToAll(mode);
      }));
    } catch {}
  }

  function registerAllVimOperationalModeSync() {
    forEachAttachedEditorCore(registerVimOperationalModeSync);
  }

  const applyLineNumbers = (enabled: boolean) => {
    lineNumbersEnabled = enabled;
    try { localStorage.setItem("zion.lineNumbers", enabled ? "1" : "0"); } catch {}
      forEachAttachedEditorCore((targetCore) => targetCore.setLineNumbersEnabled(enabled));
    window.zion.state.set("ui.lineNumbers", enabled);
  };

  const applyActiveLineHighlight = (enabled: boolean) => {
    activeLineHighlightEnabled = enabled;
    try { localStorage.setItem("zion.activeLineHighlight", enabled ? "1" : "0"); } catch {}
      forEachAttachedEditorCore((targetCore) => targetCore.setActiveLineHighlightEnabled(enabled));
    window.zion.state.set("ui.activeLineHighlight", enabled);
  };

  const applySyntaxHighlight = (enabled: boolean) => {
    syntaxHighlightEnabled = enabled;
    try { localStorage.setItem("zion.syntaxHighlight", enabled ? "1" : "0"); } catch {}
      forEachAttachedEditorCore((targetCore) => targetCore.setSyntaxHighlightEnabled(enabled));
    window.zion.state.set("ui.syntaxHighlight", enabled);
  };

  const applyAutoIndent = (enabled: boolean) => {
    autoIndentEnabled = enabled;
    try { localStorage.setItem("zion.autoIndent", enabled ? "1" : "0"); } catch {}
      forEachAttachedEditorCore((targetCore) => targetCore.setAutoIndentEnabled(enabled));
    window.zion.state.set("ui.autoIndent", enabled);
  };

  const applyFolding = (enabled: boolean) => {
    foldingEnabled = enabled;
    try { localStorage.setItem("zion.folding", enabled ? "1" : "0"); } catch {}
      forEachAttachedEditorCore((targetCore) => targetCore.setFoldingEnabled(enabled));
    window.zion.state.set("ui.folding", enabled);
  };

  const applyLineWrap = (enabled: boolean) => {
    lineWrapEnabled = enabled;
    try { localStorage.setItem("zion.lineWrap", enabled ? "1" : "0"); } catch {}
      forEachAttachedEditorCore((targetCore) => targetCore.setLineWrapEnabled(enabled));
    window.zion.state.set("ui.lineWrap", enabled);
  };

  const applyVimMode = (enabled: boolean) => {
    vimModeEnabled = enabled;
    try { localStorage.setItem("zion.vimMode", enabled ? "1" : "0"); } catch {}
    forEachAttachedEditorCore((targetCore) => {
      registerVimOperationalModeSync(targetCore);
      targetCore.setVimModeEnabled(enabled);
      if (enabled) targetCore.setVimOperationalMode(vimOperationalMode, { preserveViewState: !isFocusedEditorCore(targetCore) });
    });
    window.zion.state.set("ui.editor.vimMode", enabled);
    window.zion.state.set("ui.editor.vimOperationalMode", enabled ? vimOperationalMode : "normal");
  };

  function applyEditorPreferences(targetCore: EditorCore) {
    targetCore.setTheme(themeManager.getResolvedTheme());
    targetCore.setWysiwygEnabled(wysiwygEnabled);
    targetCore.setWysiwygKeepActiveLineRendered(wysiwygKeepActiveLineRendered);
    targetCore.setLineNumbersEnabled(lineNumbersEnabled);
    targetCore.setActiveLineHighlightEnabled(activeLineHighlightEnabled);
    targetCore.setSyntaxHighlightEnabled(syntaxHighlightEnabled);
    targetCore.setAutoIndentEnabled(autoIndentEnabled);
    targetCore.setFoldingEnabled(foldingEnabled);
    targetCore.setLineWrapEnabled(lineWrapEnabled);
    targetCore.setMinimapEnabled(!!window.zion.state.get("ui.minimapEnabled"));
    targetCore.setSelectionHighlightEnabled(!!window.zion.state.get("ui.selectionHighlight"));
    targetCore.setVimModeEnabled(vimModeEnabled);
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
  window.zion.commands.registerCommand("zion.setVimMode", (v: boolean) => applyVimMode(!!v));
  window.zion.commands.registerCommand("zion.toggleVimMode", () => applyVimMode(!vimModeEnabled));
  window.zion.commands.registerCommand("zion.editorAppearance.apply", () => applyEditorAppearancePreferences());
  try {
    window.zion.events.on("editor/attached", (payload: any) => {
      const targetCore = payload?.core;
      if (!targetCore) return;
      registerVimOperationalModeSync(targetCore);
        applyEditorPreferences(targetCore);
      targetCore.setVimModeEnabled(vimModeEnabled);
      if (vimModeEnabled) targetCore.setVimOperationalMode(vimOperationalMode, { preserveViewState: !isFocusedEditorCore(targetCore) });
    });
  } catch {}

  // apply current values
  applyEditorAppearancePreferences();
  applyLineNumbers(lineNumbersEnabled);
  applyActiveLineHighlight(activeLineHighlightEnabled);
  applySyntaxHighlight(syntaxHighlightEnabled);
  applyAutoIndent(autoIndentEnabled);
  applyFolding(foldingEnabled);
  applyLineWrap(lineWrapEnabled);
  registerAllVimOperationalModeSync();
  applyVimMode(vimModeEnabled);

  try {
    window.zion.keybindings.register({ command: "zion.toggleVimMode", key: "Alt-Shift-v", when: "editorFocus" });
  } catch {}
  try {
    const reg = getEditorHeaderMenuRegistry();
    reg.register({
      id: "core.vimMode.headerMenu",
      title: "Vim Mode",
      section: "Editor",
      order: 17,
      kind: "toggle",
      getChecked: () => !!window.zion.state.get("ui.editor.vimMode"),
      onClick: () => window.zion.commands.executeCommand("zion.toggleVimMode")
    });
  } catch {}

  try {
    (window as any).zion.settings.registerPage({
      id: "editor.appearance",
      title: "Editor Appearance",
      category: "editor",
      order: 10,
      keywords: ["editor", "appearance", "font", "color", "typography", "编辑器", "字体", "颜色"],
      sections: [
        {
          id: "editor.appearance.typography",
          title: "Typography",
          description: "默认跟随主题；这些设置只覆盖编辑器正文区域。",
          settings: [
            {
              id: "editor.appearance.fontFamilyPreset",
              label: "字体族",
              description: "选择编辑器正文使用的字体族。默认使用系统无衬线字体，适合 Markdown 阅读和编辑。",
              kind: "select",
              scope: "application",
              defaultValue: EDITOR_APPEARANCE_DEFAULTS.fontFamilyPreset,
              enumOptions: [
                { label: "系统无衬线（默认）", value: "system-sans" },
                { label: "系统等宽", value: "system-mono" },
                { label: "衬线", value: "serif" },
                { label: "自定义字体族", value: "custom" }
              ],
              getValue: () => editorFontFamilyPreset,
              setValue: setEditorFontFamilyPreset,
              reset: () => resetEditorAppearanceSetting("fontFamilyPreset")
            },
            {
              id: "editor.appearance.customFontFamily",
              label: "自定义字体族",
              description: "当字体族选择“自定义”时生效，例如 \"LXGW WenKai\", \"PingFang SC\", sans-serif。",
              kind: "string",
              scope: "application",
              controlLayout: "wide",
              defaultValue: EDITOR_APPEARANCE_DEFAULTS.customFontFamily,
              placeholder: "\"LXGW WenKai\", \"PingFang SC\", sans-serif",
              getValue: () => editorCustomFontFamily,
              setValue: setEditorCustomFontFamily,
              validate: validateFontFamily,
              reset: () => resetEditorAppearanceSetting("customFontFamily")
            },
            {
              id: "editor.appearance.fontSize",
              label: "字号",
              description: "编辑器正文基础字号，单位 px。",
              kind: "number",
              inputMode: "decimal",
              scope: "application",
              defaultValue: EDITOR_APPEARANCE_DEFAULTS.fontSize,
              getValue: () => editorFontSize,
              setValue: setEditorFontSize,
              validate: (value: unknown) => validateNumberRange(value, 10, 24, "px "),
              reset: () => resetEditorAppearanceSetting("fontSize")
            },
            {
              id: "editor.appearance.lineHeight",
              label: "行高",
              description: "编辑器正文行高倍率。Markdown 阅读编辑建议保持在 1.5 到 1.8 之间。",
              kind: "number",
              inputMode: "decimal",
              scope: "application",
              defaultValue: EDITOR_APPEARANCE_DEFAULTS.lineHeight,
              getValue: () => editorLineHeight,
              setValue: setEditorLineHeight,
              validate: (value: unknown) => validateNumberRange(value, 1.2, 2.4, ""),
              reset: () => resetEditorAppearanceSetting("lineHeight")
            }
          ]
        },
        {
          id: "editor.appearance.colors",
          title: "Colors",
          description: "颜色默认跟随当前主题；只有填写自定义值时才覆盖主题。",
          settings: [
            {
              id: "editor.appearance.textColor",
              label: "正文颜色",
              description: "留空则跟随主题正文色。支持 CSS 颜色值，例如 #d1d5db 或 rgb(209 213 219)。",
              kind: "string",
              scope: "application",
              defaultValue: EDITOR_APPEARANCE_DEFAULTS.textColor,
              placeholder: "留空跟随主题",
              getValue: () => editorTextColor,
              setValue: setEditorTextColor,
              validate: validateOptionalColor,
              reset: () => resetEditorAppearanceSetting("textColor")
            }
          ]
        }
      ]
    });
  } catch (e) {
    console.warn("[zion] failed to register editor appearance settings", e);
  }

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
    window.zion.commands.registerCommand(
      "zion.reloadPlugins",
      () => reloadWindowPreservingWorkspace()
    );

    // 预安装内置插件
    await preinstallBuiltinPlugins(pluginManager);

    // 同步已经外迁到 ~/.zion-next/plugins 的内置插件。
    await syncExternalizedBuiltinPlugins(pluginManager, pluginInstaller);
    
    // 页面刷新后恢复开发会话的WebSocket连接
    await restoreDevSessions(pluginManager, pluginInstaller);
    
  } catch (error) {
    console.error('[PluginManager] 插件系统初始化失败:', error);
  }

  try {
    initCommandPalette();
  } catch {}

  try {
    document.querySelectorAll('[data-zion-status-id="chat.usage.today"]').forEach((el) => el.remove());
  } catch {}

  try {
    window.zion.commands.registerCommand("bottomPanel.show", () => window.zion.bottomPanel?.show());
    window.zion.commands.registerCommand("bottomPanel.hide", () => window.zion.bottomPanel?.hide());
    window.zion.commands.registerCommand("bottomPanel.toggle", () => window.zion.bottomPanel?.toggle());
    window.zion.commands.registerCommand("bottomPanel.maximize", () => window.zion.bottomPanel?.maximize());
    window.zion.commands.registerCommand("bottomPanel.restore", () => window.zion.bottomPanel?.restore());
  } catch {}

  try {
    const runLogView = createRunLogViewDefinition(window.zion);
    window.zion.bottomPanel?.registerView(runLogView);
    window.zion.activityBar?.registerItem({
      id: "core.run-log.activity",
      pluginId: "core",
      icon: runLogView.icon,
      tooltip: runLogView.title,
      bottomPanelViewId: runLogView.id,
      order: 80
    });
  } catch {}

  try {
    window.zion.commands.registerCommand("auxiliaryBar.show", () => window.zion.auxiliaryBar?.show());
    window.zion.commands.registerCommand("auxiliaryBar.hide", () => window.zion.auxiliaryBar?.hide());
    window.zion.commands.registerCommand("auxiliaryBar.toggle", () => window.zion.auxiliaryBar?.toggle());
    window.zion.commands.registerCommand("inspector.show", () => window.zion.inspector?.show());
    window.zion.commands.registerCommand("inspector.hide", () => window.zion.inspector?.hide());
    window.zion.commands.registerCommand("inspector.toggle", () => {
      if (window.zion.inspector?.isVisible()) window.zion.inspector.hide();
      else window.zion.inspector?.show();
    });
  } catch {}

  try {
    try { document.getElementById("bottombar-layout-controls")?.remove(); } catch {}
    const layoutActions = [
      {
        id: "core.bottompanel.toggle",
        icon: "$(layout-panel)",
        label: "切换底部面板",
        onClick: () => {
          window.zion.commands?.executeCommand?.("bottomPanel.toggle");
        }
      },
      {
        id: "core.inspector.toggle",
        icon: "$(preview)",
        label: "切换查看区",
        onClick: () => {
          window.zion.commands?.executeCommand?.("inspector.toggle");
        }
      },
      {
        id: "core.auxbar.toggle",
        icon: "$(layout-sidebar-right)",
        label: "切换辅助栏",
        onClick: () => {
          window.zion.commands?.executeCommand?.("auxiliaryBar.toggle");
        }
      }
    ];
    const syncEditorLayoutControlClearance = (
      group: HTMLElement,
      editorTarget: HTMLElement | null
    ) => {
      const tabBars = Array.from(
        editorTarget?.querySelectorAll<HTMLElement>(".zion-editor-tabsbar") || []
      );
      for (const tabBar of tabBars) {
        tabBar.classList.remove("is-layout-controls-overlapped");
      }
      if (!editorTarget || group.parentElement !== editorTarget) return;
      const groupRect = group.getBoundingClientRect();
      if (groupRect.width <= 0 || groupRect.height <= 0) return;
      for (const tabBar of tabBars) {
        const rect = tabBar.getBoundingClientRect();
        const overlaps = rect.right > groupRect.left
          && rect.left < groupRect.right
          && rect.bottom > groupRect.top
          && rect.top < groupRect.bottom;
        tabBar.classList.toggle("is-layout-controls-overlapped", overlaps);
      }
    };
    const ensureEditorLayoutControls = () => {
      let group = document.getElementById("zion-editor-layout-controls");
      if (!group) {
        group = document.createElement("div");
        group.id = "zion-editor-layout-controls";
        group.className = "zion-workbench-layout-controls";
      }
      const auxVisible = !!window.zion.state.get("ui.auxiliaryBar.visible");
      const inspectorVisible = !!window.zion.state.get("ui.inspector.visible");
      const bottomVisible = !!window.zion.state.get("ui.bottomPanel.visible");
      const editorTarget = document.querySelector<HTMLElement>(".zion-editor");
      const placement = auxVisible ? "auxbar" : inspectorVisible ? "inspector" : "editor";
      const target = auxVisible
        ? document.querySelector<HTMLElement>(".zion-auxbar-actions")
        : inspectorVisible
          ? document.querySelector<HTMLElement>(".zion-inspector-tabs-viewport")
          : editorTarget;
      if (!target) return;
      if (group.parentElement !== target) target.appendChild(group);
      group.dataset.placement = placement;
      for (const action of layoutActions) {
        let btn = group.querySelector<HTMLButtonElement>(`button[data-zion-layout-id="${action.id}"]`);
        if (!btn) {
          btn = document.createElement("button");
          btn.type = "button";
          btn.className = "zion-workbench-layout-button";
          btn.setAttribute("data-zion-layout-id", action.id);
        }
        group.appendChild(btn);
        btn.title = action.label;
        btn.setAttribute("aria-label", action.label);
        btn.innerHTML = zionIconHtml(String(action.icon || "").replace(/^\$\(([^)]+)\)$/, "$1"));
        btn.disabled = false;
        const active = action.id === "core.bottompanel.toggle"
          ? bottomVisible
          : action.id === "core.auxbar.toggle"
            ? auxVisible
            : inspectorVisible;
        btn.classList.toggle("is-active", active);
        btn.onpointerdown = (e) => {
          e.preventDefault();
          e.stopPropagation();
        };
        btn.onmousedown = (e) => {
          e.preventDefault();
          e.stopPropagation();
        };
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          action.onClick();
          scheduleEditorLayoutControls();
        };
      }
      syncEditorLayoutControlClearance(group, editorTarget);
    };
    const scheduleEditorLayoutControls = () => requestAnimationFrame(() => ensureEditorLayoutControls());
    scheduleEditorLayoutControls();
    let layoutControlsScrollFrame = 0;
    document.querySelector(".zion-panels-root")?.addEventListener("scroll", () => {
      if (layoutControlsScrollFrame) return;
      layoutControlsScrollFrame = requestAnimationFrame(() => {
        layoutControlsScrollFrame = 0;
        const group = document.getElementById("zion-editor-layout-controls");
        const editorTarget = document.querySelector<HTMLElement>(".zion-editor");
        if (group instanceof HTMLElement) {
          syncEditorLayoutControlClearance(group, editorTarget);
        }
      });
    }, { passive: true });
    panelManager.on("panel/layoutChanged", scheduleEditorLayoutControls);
    panelManager.on("panel/closed", scheduleEditorLayoutControls);
    panelManager.on("panel/focusChanged", scheduleEditorLayoutControls);
    window.zion.state.onDidChange("ui.auxiliaryBar.visible", scheduleEditorLayoutControls);
    window.zion.state.onDidChange("ui.inspector.visible", scheduleEditorLayoutControls);
    window.zion.state.onDidChange("ui.bottomPanel.visible", scheduleEditorLayoutControls);
    window.addEventListener("resize", scheduleEditorLayoutControls);
    (window.zion as any).editorHeaderMenu?.register?.({
      id: "core.bottompanel.toggle",
      title: "切换底部面板",
      section: "Layout",
      order: 20,
      onClick: () => {
        window.zion.bottomPanel?.toggle();
      }
    });
    (window.zion as any).editorHeaderMenu?.register?.({
      id: "core.auxbar.toggle",
      title: "切换右侧辅助栏",
      section: "Layout",
      order: 30,
      onClick: () => {
        window.zion.auxiliaryBar?.toggle();
      }
    });
  } catch {}

  // Core commands
  window.zion.commands.registerCommand("zion.showPlugins", () => openPluginsPanel(pluginManager));
  window.zion.commands.registerCommand("zion.reloadPlugins", () => reloadWindowPreservingWorkspace());

  // Show extension load errors (if any)
  const extErr = (window as any).__ext_errors || 0;
  if (extErr > 0) {
    notificationManager.show(`Some extensions failed to load (${extErr}). Check console for details.`, {
      type: "warning",
      duration: 0,
      dismissible: true
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

      let metrics = document.getElementById("bottombar-metrics") as HTMLDivElement | null;
      if (!metrics) {
        metrics = document.createElement("div");
        metrics.id = "bottombar-metrics";
      }
      const terminal = right.querySelector("[data-zion-bottombar-terminal]");
      const status = document.getElementById("bottombar-status") || document.getElementById("bottombar-left");
      const metricsAnchor =
        terminal && terminal.parentElement === right
          ? terminal
          : status && status.parentElement === right
            ? status
            : null;
      if (metrics.parentElement !== right || metrics.nextElementSibling !== metricsAnchor) {
        right.insertBefore(metrics, metricsAnchor);
      }

      const ensureMetric = (className: string) => {
        let metric = metrics!.querySelector(`.${className}`) as HTMLSpanElement | null;
        if (!metric) {
          metric = document.createElement("span");
          metric.className = `bottombar-metric ${className}`;
          metrics!.appendChild(metric);
        }
        return metric;
      };

      const mLnCol = ensureMetric("bottombar-metric-lncol");
      const mBefore = ensureMetric("bottombar-metric-before");
      const mTotal = ensureMetric("bottombar-metric-total");

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

          const locale = String((window as any).zion?.i18n?.getLocale?.() || (window as any).zion?.state?.get?.("ui.locale") || "");
          const isEn = locale.startsWith("en");
          mLnCol.textContent = isEn ? `Ln ${ln}, Col ${col}` : `行 ${ln}, 列 ${col}`;
          mBefore.textContent = isEn ? `Before ${before}` : `之前 ${before}`;
          mTotal.textContent = isEn ? `Total ${total}` : `总计 ${total}`;
        } catch {}
      };

      updateMetrics();
      (window as any).zion.events.on("editor.cursorActivity", updateMetrics);
      (window as any).zion.events.on("editor.change", updateMetrics);
      (window as any).zion.events.on("panel/focusChanged", updateMetrics);
      (window as any).zion.events.on("panel/tabActivated", updateMetrics);
      (window as any).zion.events.on("i18n/changed", updateMetrics);
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

    const connectWebSocket = (serviceUrl: string, devId: string, sourceDir?: string) => {
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
            const ret = await installer.installFromDevBase(baseUrl, devId, { sourceDir });
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
        const ret = await installer.installFromDevBase(baseUrl, devId, { sourceDir: devDir });
        if (ret.success && ret.plugin) {
          await pluginManager.installFromInfo(ret.plugin, { enabled: true });
          devStatus.textContent = `Dev session started: ${devId} (${ret.plugin.id})`;
          const ws = connectWebSocket(serviceUrl, devId, devDir);
          activeDevSessions.set(devId, { ws, baseUrl, pluginId: ret.plugin.id, dir: devDir });
          
          // 显示开发模式启动通知
          notificationManager.showDevModeStarted(ret.plugin.name, devDir);

          // 记录到全局 state 与本地存储（便于页面刷新后仍能显示开发目录信息）
          try {
            const sessions = (window.zion.state.get("plugins.devSessions") || {}) as Record<string, any>;
            sessions[devId] = { ws, baseUrl, pluginId: ret.plugin.id, dir: devDir };
            window.zion.state.set("plugins.devSessions", sessions);
            pluginManager.saveDevSessionRecord({
              pluginId: ret.plugin.id,
              devId,
              baseUrl,
              dir: devDir
            });
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
            pluginManager.removeDevSessionRecord({ devId });
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
    reloadBtn.onclick = () => { void reloadWindowPreservingWorkspace(); };
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

async function syncExternalizedBuiltinPlugins(pluginManager: PluginManager, pluginInstaller: HttpPluginInstaller) {
  for (const pluginId of EXTERNALIZED_BUILTIN_PLUGIN_IDS) {
    try {
      const existing = pluginManager.get(pluginId);
      if (existing && pluginManager.getPluginOrigin(existing) === "dev") {
        console.log(`[PluginManager] 跳过外迁插件同步，保留开发版本: ${pluginId}`);
        continue;
      }

      const ret = await pluginInstaller.installFromService(pluginId);
      if (!ret.success || !ret.plugin) {
        console.warn(`[PluginManager] 外迁插件同步失败: ${pluginId}`, ret.error?.message || "unknown error");
        continue;
      }

      const enabled = pluginManager.getEnabledPreference(pluginId) ?? true;
      await pluginManager.installFromInfo(ret.plugin, { enabled });
      console.log(`[PluginManager] 已同步外迁插件: ${pluginId}@${ret.plugin.version}`);
    } catch (error) {
      console.warn(`[PluginManager] 外迁插件同步异常: ${pluginId}`, error);
    }
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
      const manifestJsons = (import.meta as any).glob([
        '/extensions/**/manifest.json',
        '!/extensions/dev.identity/manifest.json'
      ], { eager: true }) as Record<string, any>;

      const existingIds = new Set(builtinPlugins.map(p => p.id));

      // 处理 manifest.json（新格式）
      for (const [manifestPath, mod] of Object.entries(manifestJsons)) {
        const manifest = (mod as any)?.default || mod;
        const extDir = manifestPath.replace(/\/manifest\.json$/, '');
        const dirName = extDir.split('/').pop() || extDir;

        const zionData = manifest.zion || {};
        const pluginId = zionData.id || manifest.name || `zion.${dirName.replace(/^dev\./, '')}`;
        if (EXTERNALIZED_BUILTIN_PLUGIN_IDS.has(pluginId)) {
          console.log(`[PluginManager] 跳过已外迁内置插件: ${pluginId}`);
          continue;
        }
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
          origin: 'builtin',
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
        const existing = pluginManager.get(pluginInfo.id);
        if (existing && pluginManager.getPluginOrigin(existing) !== 'builtin') {
          console.log(`[PluginManager] 跳过内置插件 ${pluginInfo.id}，保留 ${pluginManager.getPluginOrigin(existing)} 版本`);
          continue;
        }
        console.log(`[PluginManager] 同步内置插件信息: ${pluginInfo.id}`);
        const enabled = pluginManager.getEnabledPreference(pluginInfo.id) ?? true;
        await pluginManager.updateFromInfo(pluginInfo, { enabled });
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
// 开发会话恢复重试：app 启动竞态时本地服务可能暂不可达，稍后自动重试而不是放弃
let devSessionsRestoreRetryTimer: ReturnType<typeof setTimeout> | null = null;
let devSessionsRestoreRetryCount = 0;
const DEV_SESSIONS_RESTORE_MAX_RETRY = 10;

function scheduleDevSessionsRestoreRetry(pluginManager: PluginManager, pluginInstaller: any) {
  if (devSessionsRestoreRetryTimer) return;
  if (devSessionsRestoreRetryCount >= DEV_SESSIONS_RESTORE_MAX_RETRY) {
    console.warn('[PluginManager] 开发会话恢复重试次数用尽，放弃（刷新页面可再次触发）');
    return;
  }
  devSessionsRestoreRetryCount++;
  console.log(`[PluginManager] 将在 3 秒后重试开发会话恢复（第 ${devSessionsRestoreRetryCount}/${DEV_SESSIONS_RESTORE_MAX_RETRY} 次）`);
  devSessionsRestoreRetryTimer = setTimeout(async () => {
    devSessionsRestoreRetryTimer = null;
    await restoreDevSessions(pluginManager, pluginInstaller);
  }, 3000);
}

async function restoreDevSessions(pluginManager: PluginManager, pluginInstaller: any) {
  try {
    console.log('[PluginManager] 尝试恢复开发会话...');

    const getServiceBaseUrl = (): string => {
      try {
        return localStorage.getItem("zion.pluginServiceUrl") || DEFAULT_BASE_URL;
      } catch {
        return DEFAULT_BASE_URL;
      }
    };

    const serviceUrl = getServiceBaseUrl();
    let restoredCount = 0;
    let failedCount = 0;
    let hadUnreachable = false;

    const wireDevSession = (pluginId: string, devId: string, baseUrl: string, dir: string) => {
      const wsUrl = serviceUrl.replace(/^http/, "ws") + `/plugins/dev/ws/${devId}`;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log(`[PluginManager] 开发会话WebSocket已连接: ${devId}`);
      };

      ws.onmessage = async (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "dev:change" && msg.devId === devId) {
            const update = await pluginInstaller.installFromDevBase(baseUrl, devId, { sourceDir: dir });
            if (update.success && update.plugin) {
              await pluginManager.hotReloadFromInfo(update.plugin, { enabled: true });
            } else {
              console.warn("[PluginManager] 开发会话恢复安装失败:", update.error?.message);
            }
          } else if (msg.type === "dev:stop") {
            pluginManager.removeDevSessionRecord({ devId });
          }
        } catch (error) {
          console.error("[PluginManager] 开发会话恢复热重载错误:", error);
        }
      };

      ws.onclose = () => {
        console.log(`[PluginManager] 开发会话WebSocket已关闭: ${devId}`);
      };

      ws.onerror = () => {
        console.error(`[PluginManager] 开发会话WebSocket错误: ${devId}`);
      };

      const sessions = (window.zion.state.get("plugins.devSessions") || {}) as Record<string, any>;
      sessions[devId] = { ws, baseUrl, pluginId, dir };
      window.zion.state.set("plugins.devSessions", sessions);
    };

    // 启动（或复用，服务端幂等）一个开发会话
    const reviveDevSession = async (dir: string): Promise<{ devId: string; baseUrl: string }> => {
      const res = await fetch(`${serviceUrl}/plugins/dev/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: dir })
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      const data = await res.json();
      const devId = String(data?.data?.devId || '').trim();
      const baseUrlPath = String(data?.data?.baseUrl || '').trim();
      if (!devId || !baseUrlPath) {
        throw new Error("invalid dev start response");
      }
      const baseUrl = /^https?:\/\//i.test(baseUrlPath)
        ? baseUrlPath
        : `${serviceUrl.replace(/\/$/, '')}/${baseUrlPath.replace(/^\//, '')}`;
      return { devId, baseUrl };
    };

    // 完整恢复一个会话目录：start + install + 记录 + WebSocket
    const restoreOne = async (dir: string, hintPluginId?: string): Promise<{ pluginId: string } | null> => {
      const started = await reviveDevSession(dir);
      const ret = await pluginInstaller.installFromDevBase(started.baseUrl, started.devId, { sourceDir: dir });
      if (!ret.success || !ret.plugin) {
        throw new Error(ret.error?.message || "开发插件安装失败");
      }
      await pluginManager.hotReloadFromInfo(ret.plugin, { enabled: true, skipNotification: true });
      if (hintPluginId && hintPluginId !== ret.plugin.id) {
        pluginManager.removeDevSessionRecord({ pluginId: hintPluginId });
      }
      pluginManager.saveDevSessionRecord({
        pluginId: ret.plugin.id,
        devId: started.devId,
        baseUrl: started.baseUrl,
        dir
      });
      wireDevSession(ret.plugin.id, started.devId, started.baseUrl, dir);
      return { pluginId: ret.plugin.id };
    };

    // ---- 阶段一：服务端注册表合并恢复（自愈本地记录丢失/被清理）----
    try {
      const listRes = await fetch(`${serviceUrl}/plugins/dev/list`);
      if (listRes.ok) {
        const listData = await listRes.json();
        const serverSessions: any[] = listData?.data?.sessions || [];
        const records = pluginManager.listDevSessionRecords();
        const knownDirs = new Set(Object.values(records).map((r: any) => String(r?.dir || '').trim()).filter(Boolean));
        console.log(`[PluginManager] 服务端开发会话注册表: ${serverSessions.length} 条`);
        for (const s of serverSessions) {
          if (!s?.devId || !s?.dir) continue;
          if (s.dirExists === false) continue; // 目录已删除，服务端会自行清理注册表
          if (knownDirs.has(String(s.dir).trim())) continue; // 本地已有记录，走阶段二
          try {
            const r = await restoreOne(String(s.dir));
            restoredCount += 1;
            console.log(`[PluginManager] 从服务端注册表恢复开发插件: ${r?.pluginId} (dir=${s.dir})`);
          } catch (e) {
            console.warn(`[PluginManager] 注册表恢复单个会话失败 (dir=${s.dir}):`, e);
          }
        }
      }
    } catch (e) {
      console.warn('[PluginManager] 拉取服务端开发会话注册表失败（本地服务可能未就绪）:', e);
    }

    // ---- 阶段二：按本地记录恢复 ----
    const saved = pluginManager.listDevSessionRecords();

    if (Object.keys(saved).length === 0) {
      console.log('[PluginManager] 没有需要恢复的开发会话');
      if (!hadUnreachable) devSessionsRestoreRetryCount = 0;
      return;
    }
    
    console.log(`[PluginManager] 发现 ${Object.keys(saved).length} 个开发会话需要恢复`);
    
    // 恢复每个开发会话
    for (const [pluginId, devInfo] of Object.entries(saved)) {
      try {
        const devId = devInfo.devId;
        const dir = devInfo.dir;
        
        if (!devId || !dir) {
          console.warn(`[PluginManager] 无效的开发会话信息: pluginId=${pluginId}`);
          failedCount += 1;
          continue;
        }
        
        console.log(`[PluginManager] 恢复开发会话: pluginId=${pluginId}, devId=${devId}`);

        const r = await restoreOne(dir, pluginId);
        const restoredPluginId = r?.pluginId || pluginId;

        // 清理旧 devId 的 WebSocket 登记与记录
        const sessions = (window.zion.state.get("plugins.devSessions") || {}) as Record<string, any>;
        const newDevId = pluginManager.listDevSessionRecords()[restoredPluginId]?.devId;
        if (newDevId && newDevId !== devId) {
          try { sessions[devId]?.ws?.close?.(); } catch {}
          delete sessions[devId];
          pluginManager.removeDevSessionRecord({ devId });
        }

        restoredCount += 1;
        console.log(`[PluginManager] 开发会话恢复成功: pluginId=${restoredPluginId}`);
      } catch (error: any) {
        const errMsg = String(error?.message || error || "");
        const isDefinitiveFailure = /^HTTP 4\d\d/.test(errMsg); // 目录不存在等明确失效
        if (isDefinitiveFailure) {
          failedCount += 1;
          console.warn(`[PluginManager] 开发会话明确失效，清理记录: ${pluginId}`);
          pluginManager.removeDevSessionRecord({ pluginId });
        } else {
          // 本地服务暂不可达（app/服务启动竞态）：保留记录，稍后重试
          hadUnreachable = true;
          console.warn(`[PluginManager] 本地服务暂不可达，保留开发会话 ${pluginId} 等待重试`);
        }
      }
    }
    
    if (hadUnreachable) {
      scheduleDevSessionsRestoreRetry(pluginManager, pluginInstaller);
    } else {
      devSessionsRestoreRetryCount = 0;
    }

    console.log(`[PluginManager] 开发会话恢复完成: restored=${restoredCount}, failed=${failedCount}`);
  } catch (error) {
    console.error('[PluginManager] 恢复开发会话失败:', error);
  }
}


bootstrap();
