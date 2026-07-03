/**
 * dev.toc - Markdown Table of Contents extension
 * Features:
 * - Command: toc.show -> open TOC overlay with clickable headings
 * - Command: toc.insert -> insert Markdown TOC list at cursor
 * - StatusBar button "TOC"
 * - Editor context menu item "Table of Contents"
 */
import { ViewPlugin } from "@codemirror/view";

let extensionCtx = null;
const I18N_NS = "dev.toc";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.toc": "目录",
    "cmd.show": "显示目录",
    "cmd.insert": "插入目录 (Markdown)",
    "cmd.toggleGroupByRole": "切换目录按角色分组",
    "menu.contents": "目录",
    "menu.groupByRole": "目录：按角色分组",
    "ui.contents": "目录",
    "ui.empty": "未找到标题 (使用 #、##、### ...)",
    "ui.insertHere": "在此插入目录",
    "ui.close": "关闭",
    "slash.show.description": "显示文档目录",
    "slash.insert.description": "在当前位置插入 Markdown 目录",
    "slash.group.description": "切换目录是否按角色分组"
  },
  "en-US": {
    "category.toc": "TOC",
    "cmd.show": "Show TOC",
    "cmd.insert": "Insert TOC (Markdown)",
    "cmd.toggleGroupByRole": "Toggle TOC Group by Role",
    "menu.contents": "Contents",
    "menu.groupByRole": "TOC: Group by Role",
    "ui.contents": "Contents",
    "ui.empty": "No headings found (use #, ##, ### ...)",
    "ui.insertHere": "Insert TOC Here",
    "ui.close": "Close",
    "slash.show.description": "Show document table of contents",
    "slash.insert.description": "Insert Markdown TOC at current position",
    "slash.group.description": "Toggle whether TOC groups by role"
  }
};

function t(key, fallback) {
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

export async function activate(ctx) {
  extensionCtx = ctx;
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}
  // Helper: strip markdown formatting from title text
  const cleanTitle = (title) => {
    // Remove bold/italic/strikethrough: **text**, _text_, ~~text~~
    return title
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/_(.*?)_/g, '$1')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/`(.*?)`/g, '$1'); // also remove inline code formatting
  };

  const parseHeadingsFromLines = (lines, startLine = 0, endLine = lines.length - 1) => {
    const headings = [];
    const re = /^(#{1,6})\s+(.+)\s*$/;
    const fenceRe = /^\s*(```+|~~~+)/;
    const start = Math.max(0, startLine || 0);
    const end = Math.min(lines.length - 1, endLine == null ? lines.length - 1 : endLine);
    let inFence = false;
    let fenceToken = "";
    for (let i = start; i <= end; i++) {
      const line = String(lines[i] ?? "");
      const fenceMatch = fenceRe.exec(line);
      if (fenceMatch) {
        const token = fenceMatch[1] || "";
        if (!inFence) {
          inFence = true;
          fenceToken = token[0];
        } else if (!fenceToken || token[0] === fenceToken) {
          inFence = false;
          fenceToken = "";
        }
        continue;
      }
      if (inFence) continue;
      const m = re.exec(line);
      if (!m) continue;
      headings.push({ level: m[1].length, title: cleanTitle(m[2].trim()), line: i });
    }
    return headings;
  };

  // Fallback: parse headings from raw text (line-by-line)
  const parseHeadingsFromText = (text) => {
    const lines = String(text || "").split(/\r?\n/);
    return parseHeadingsFromLines(lines);
  };

  // Preferred: parse headings from CodeMirror syntax tree when editor view is available.
  // Returns {level, title, line} with line being 0-based (compatible with EditorProxy.setCursor).
  const parseHeadingsFromView = (view) => {
    try {
      const text = view?.state?.doc?.toString?.() || "";
      return parseHeadingsFromText(text);
    } catch {}
    return [];
  };

  // Parse role blocks (fallback when roles.index is unavailable)
  const BASE_ROLE_PREFIXES = ["user", "assistant", "system"];

  const getLeadingPreviewFromText = (text) => {
    try {
      const lines = String(text || "").split(/\r?\n/);
      for (const l of lines) {
        const t = String(l || "").trim();
        if (t) return t.slice(0, 160);
      }
      return "";
    } catch {
      return "";
    }
  };

  const ensureLeadingUserBlock = (blocks, docText, maybeView) => {
    try {
      if (!Array.isArray(blocks) || blocks.length === 0) {
        const preview = getLeadingPreviewFromText(docText);
        if (!preview) return blocks;
        return [{ role: "user", startLine: 0, endLine: 0, preview }];
      }

      const first = blocks[0] || {};
      let firstStartLine = typeof first.startLine === "number" ? first.startLine : null;
      if (firstStartLine == null && maybeView && typeof first.from === "number") {
        try { firstStartLine = maybeView.state.doc.lineAt(first.from).number - 1; } catch {}
      }
      if (typeof firstStartLine !== "number" || firstStartLine <= 0) return blocks;

      const preview = getLeadingPreviewFromText(docText);
      const lead = {
        role: "user",
        startLine: 0,
        endLine: Math.max(0, firstStartLine - 1),
        preview
      };
      if (maybeView && typeof first.from === "number") {
        lead.from = 0;
        lead.to = Math.max(0, first.from - 1);
      }
      return [lead, ...blocks];
    } catch {
      return blocks;
    }
  };

  const parseRoleBlocksFromText = (text, prefixes = BASE_ROLE_PREFIXES) => {
    const lines = text.split(/\r?\n/);
    const blocks = [];
    let current = null;
    const isRoleLine = (t) => {
      for (const r of prefixes) {
        if (t.startsWith(r + " ")) return r;
      }
      return null;
    };
    try {
      const first = lines[0] ?? "";
      if (!isRoleLine(first)) {
        const tt = first.trim();
        current = {
          role: "user",
          startLine: 0,
          endLine: 0,
          preview: tt ? tt.slice(0, 160) : ""
        };
      }
    } catch {}
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i];
      const roleHere = isRoleLine(t);
      if (roleHere) {
        if (current) {
          current.endLine = i - 1;
          blocks.push(current);
          current = null;
        }
        const tokenLen = roleHere.length;
        const after = t.slice(tokenLen + 1).trim();
        current = {
          role: roleHere,
          startLine: i,
          endLine: i,
          preview: after ? after.slice(0, 160) : ""
        };
      } else if (current) {
        current.endLine = i;
        if (!current.preview) {
          const tt = t.trim();
          if (tt) current.preview = tt.slice(0, 160);
        }
      }
    }
    if (current) blocks.push(current);
    return blocks;
  };

  // 在 CM6 视图内解析指定字符范围内的标题（返回绝对行号）
  const parseHeadingsFromViewInRange = (view, from, to) => {
    try {
      const doc = view.state.doc;
      const startLine = doc.lineAt(Math.max(0, from)).number - 1;
      const endLine = doc.lineAt(Math.max(0, to)).number - 1;
      return parseHeadingsFromLines(doc.toString().split(/\r?\n/), startLine, endLine);
    } catch {}
    return [];
  };

  // 文本解析：限定行范围（返回绝对行号）
  const parseHeadingsFromTextInLines = (text, startLine, endLine) => {
    const lines = String(text || "").split(/\r?\n/);
    return parseHeadingsFromLines(lines, startLine, endLine);
  };

  const slugify = (s) => {
    // GitHub-like simple slug: lowercase, trim, spaces to '-', remove most punctuations
    return s
      .trim()
      .toLowerCase()
      .replace(/[\s]+/g, "-")
      .replace(/[^a-z0-9\u4e00-\u9fa5\-\_]/g, ""); // keep CJK basic, ascii, -, _
  };

  const ACTIVE_TOC_MODE_KEY = 'toc.activeMode';
  const getRolePrefixes = () => {
    try {
      const extras = [];
      try {
        const cfg = window?.zion?.config?.roles?.prefixes;
        if (Array.isArray(cfg)) extras.push(...cfg);
      } catch {}
      try {
        const raw = localStorage.getItem("zion.roles.prefixes") || localStorage.getItem("dev.roles.prefixes");
        const parsed = raw ? JSON.parse(raw) : null;
        if (Array.isArray(parsed)) extras.push(...parsed);
      } catch {}
      return Array.from(new Set([...BASE_ROLE_PREFIXES, ...extras.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)]));
    } catch {
      return [...BASE_ROLE_PREFIXES];
    }
  };
  const getSessionIdFromEditor = (ed) => {
    try {
      const panelId = getPanelIdFromEditor(ed);
      if (panelId) {
        const fromPanelManager = window?.zion?.panelManager?.getPanel?.(panelId)?.activeTabId;
        if (fromPanelManager) return String(fromPanelManager);
        const fromPanelsApi = window?.zion?.panels?.list?.()?.find?.((panel) => panel.id === panelId)?.activeTabId;
        if (fromPanelsApi) return String(fromPanelsApi);
      }
    } catch {}
    try {
      const sid = window?.zion?.state?.get?.("sessions.currentId");
      return sid ? String(sid) : null;
    } catch {
      return null;
    }
  };
  const getScopedStateKey = (baseKey, target) => {
    try {
      const panelId = typeof target === "string"
        ? target
        : (target?.panelId || getBoundPanelId(target) || getPanelIdFromEditor(target) || null);
      return panelId ? `${baseKey}.${panelId}` : baseKey;
    } catch {
      return baseKey;
    }
  };
  const getActiveHeadingStateKey = (target) => getScopedStateKey("toc.activeHeadingId", target);
  const getActiveBlockStateKey = (target) => getScopedStateKey("toc.activeBlockId", target);
  const getRoleIndexForEditor = (ed, maybeView) => {
    try {
      const fromApi = window?.zion?.roles?.getIndex?.(maybeView || ed);
      if (fromApi && Array.isArray(fromApi.blocks)) return fromApi;
      const state = window?.zion?.state;
      if (!state?.get) return null;
      const dom = maybeView?.dom || getEditorEl(ed);
      const editorId = ed?.editorId || ed?.core?.getEditorId?.() || dom?.getAttribute?.("data-editor-id") || "";
      const panelId = getPanelIdFromEditor(ed) || dom?.getAttribute?.("data-panel-id") || dom?.closest?.("[data-panel-id]")?.getAttribute?.("data-panel-id") || "";
      const sessionId = ed?.sessionId || ed?.core?.getSessionId?.() || dom?.getAttribute?.("data-session-id") || dom?.closest?.("[data-session-id]")?.getAttribute?.("data-session-id") || "";
      const candidates = [
        editorId ? `roles.index.editor.${editorId}` : "",
        panelId && sessionId ? `roles.index.panelSession.${panelId}.${sessionId}` : "",
        panelId ? `roles.index.panel.${panelId}` : "",
        "roles.index"
      ].filter(Boolean);
      for (const key of candidates) {
        const idx = state.get(key);
        if (!idx || !Array.isArray(idx.blocks)) continue;
        const scope = idx.scope || {};
        if (key === "roles.index") {
          if (editorId && scope.editorId && scope.editorId !== editorId) continue;
          if (panelId && scope.panelId && scope.panelId !== panelId) continue;
          if (sessionId && scope.sessionId && scope.sessionId !== sessionId) continue;
        }
        return idx;
      }
    } catch {}
    return null;
  };
  const getRoleBlocksForEditor = (ed, maybeView) => {
    try {
      const text = String(ed?.getValue?.() || "");
      const idx = getRoleIndexForEditor(ed, maybeView);
      if (idx?.blocks?.length) return idx.blocks;
      const blocks = parseRoleBlocksFromText(text, getRolePrefixes());
      return ensureLeadingUserBlock(blocks, text, maybeView);
    } catch {
      return [];
    }
  };

  // 根据给定行/位置计算应高亮的目录项（标题与块）
  const computeActiveTOCAtCursor = (viewParam, opts = {}) => {
    try {
      const ed = opts?.editor || window?.zion?.window?.activeEditor;
      if (!ed) return;

      const groupMode = !!window?.zion?.state?.get?.('toc.groupByRole');
      const docText = ed.getValue?.() || "";

      let currentLine = 0;
      let pos = 0;
      if (viewParam && viewParam.state) {
        const vstate = viewParam.state;
        pos = typeof opts.pos === "number" ? opts.pos : vstate.selection.main.head;
        if (typeof opts.line === "number") {
          currentLine = opts.line;
        } else {
          currentLine = vstate.doc.lineAt(pos).number - 1;
        }
      } else {
        try {
          const cur = ed.getCursor?.();
          if (cur && typeof cur.line === "number") currentLine = cur.line;
        } catch {}
      }

      let activeHeadingId = null;
      let activeBlockId = null;

      if (groupMode) {
        let curBlock = null;
        const blocks = getRoleBlocksForEditor(ed, viewParam);
        for (const b of blocks) {
          const s = b.startLine ?? 0;
          const e = b.endLine ?? s;
          if (currentLine >= s && currentLine <= e) {
            curBlock = b;
            break;
          }
        }

        if (curBlock) {
          // 计算块的起始行（优先使用 startLine；如无则由 from 推算）
          let blockStartLine = curBlock.startLine;
          if (blockStartLine == null && viewParam && typeof curBlock.from === "number") {
            try {
              blockStartLine = viewParam.state.doc.lineAt(curBlock.from).number - 1;
            } catch {}
          }
          if (blockStartLine == null) blockStartLine = 0;

          // 解析该块内的标题
          let hs = [];
          if (viewParam && typeof curBlock.from === "number" && typeof curBlock.to === "number") {
            hs = parseHeadingsFromViewInRange(viewParam, curBlock.from, curBlock.to);
          } else {
            const s = curBlock.startLine ?? blockStartLine ?? 0;
            const e = curBlock.endLine ?? s;
            hs = parseHeadingsFromTextInLines(docText, s, e);
          }
          // 选择当前光标所在位置之前的最近标题
          const candidate = hs.filter(h => h.line <= currentLine).sort((a, b) => a.line - b.line).pop();

          activeBlockId = `role::${(curBlock.role || '').toLowerCase()}::${blockStartLine}`;
          if (candidate) {
            activeHeadingId = `${slugify(candidate.title)}::L${candidate.level}::${candidate.line}::B${blockStartLine}`;
          }
        } else {
          // 没有块信息时退化为全局标题
          const hs = viewParam ? parseHeadingsFromView(viewParam) : parseHeadingsFromText(docText);
          const candidate = hs.filter(h => h.line <= currentLine).sort((a, b) => a.line - b.line).pop();
          if (candidate) {
            activeHeadingId = `${slugify(candidate.title)}::L${candidate.level}::${candidate.line}`;
          }
        }
      } else {
        // 非分组：直接解析全文标题
        const hs = viewParam ? parseHeadingsFromView(viewParam) : parseHeadingsFromText(docText);
        const candidate = hs.filter(h => h.line <= currentLine).sort((a, b) => a.line - b.line).pop();
        if (candidate) {
          activeHeadingId = `${slugify(candidate.title)}::L${candidate.level}::${candidate.line}`;
        }
      }

      // 更新状态（避免不必要的 set）
      try {
        const key = getActiveHeadingStateKey(ed);
        const prevH = window?.zion?.state?.get?.(key);
        if (prevH !== activeHeadingId) window.zion.state.set(key, activeHeadingId || null);
      } catch {}
      try {
        const key = getActiveBlockStateKey(ed);
        const prevB = window?.zion?.state?.get?.(key);
        if (prevB !== activeBlockId) window.zion.state.set(key, activeBlockId || null);
      } catch {}

      try {
        const prevM = window?.zion?.state?.get?.(ACTIVE_TOC_MODE_KEY);
        if (prevM !== opts?.mode) window.zion.state.set(ACTIVE_TOC_MODE_KEY, opts?.mode || null);
      } catch {}
    } catch {}
  };

  const activeMeasurePending = new WeakMap();

  const scheduleComputeActiveTOCByVisibility = (viewParam, editorParam = null) => {
    try {
      if (!viewParam || !viewParam.state) return;
      if (activeMeasurePending.get(viewParam)) return;
      activeMeasurePending.set(viewParam, true);

      if (typeof viewParam.requestMeasure !== 'function') {
        activeMeasurePending.set(viewParam, false);
        computeActiveTOCAtCursor(viewParam, { mode: 'cursor', editor: editorParam });
        return;
      }

      viewParam.requestMeasure({
        read(view) {
          try {
            const scroller = view.scrollDOM;
            const doc = view.state.doc;
            const cursorPos = view.state.selection.main.head;
            const cursorLine = doc.lineAt(cursorPos).number - 1;

            const topY = scroller.scrollTop;
            const bottomY = scroller.scrollTop + scroller.clientHeight;
            const topBlock = view.lineBlockAtHeight(topY);
            const bottomBlock = view.lineBlockAtHeight(bottomY);
            const topLine = doc.lineAt(topBlock.from).number - 1;
            const bottomLine = doc.lineAt(bottomBlock.from).number - 1;

            const inView = cursorLine >= topLine && cursorLine <= bottomLine;
            const usedLine = inView ? cursorLine : topLine;
            const usedPos = inView ? cursorPos : doc.line(usedLine + 1).from;
            return { usedLine, usedPos, mode: inView ? 'cursor' : 'viewport' };
          } catch {
            return { usedLine: null, usedPos: null, mode: 'cursor' };
          }
        },
        write(data, _view) {
          try {
            const d = data || {};
            if (typeof d.usedLine === 'number' && typeof d.usedPos === 'number') {
              computeActiveTOCAtCursor(viewParam, { line: d.usedLine, pos: d.usedPos, mode: d.mode, editor: editorParam });
            } else {
              computeActiveTOCAtCursor(viewParam, { mode: 'cursor', editor: editorParam });
            }
          } catch {}
          activeMeasurePending.set(viewParam, false);
        }
      });
    } catch {
      try { activeMeasurePending.set(viewParam, false); } catch {}
    }
  };

  // Scroll helper: set cursor and scroll so the target line appears near the top of the viewport.
  // - ed: the editor abstraction (window.zion.window.activeEditor)
  // - maybeView: underlying CodeMirror view when available (ed.core.view)
  // - line: 0-based line number
  // - topOffset: pixels to keep between top of viewport and the target line (default 48)
  const scrollLineIntoViewTop = (ed, maybeView, line, topOffset = 48) => {
    try {
      if (maybeView && typeof maybeView.lineBlockAt === "function") {
        try {
          let stickyHeight = 0;
          try {
            const root = maybeView.dom;
            const sticky = root?.querySelector?.(".zion-cm-sticky-user-header:not(.is-empty)") ||
              document.querySelector(".zion-cm-sticky-user-header:not(.is-empty)");
            stickyHeight = sticky?.offsetHeight || 0;
          } catch {}
          const effectiveTopOffset = Math.max(topOffset || 0, (stickyHeight || 0) + 10);

          // Convert line to a document position
          const targetLine = maybeView.state.doc.line(line + 1);
          const pos = targetLine.from;
          const lineText = maybeView.state.doc.sliceString(targetLine.from, targetLine.to);
          const heading = /^([ \t]*#{1,6}[ \t]+)/.exec(lineText);
          const cursorPos = heading ? Math.min(targetLine.from + heading[1].length, targetLine.to) : pos;
          try {
            maybeView.dispatch({ selection: { anchor: cursorPos } });
            maybeView.focus();
          } catch {
            try { ed.setCursor({ line, ch: 0 }); } catch {}
            try { ed.focus(); } catch {}
          }

          const block = maybeView.lineBlockAt(pos);
          if (!block) return;

          // Determine scroll container (CodeMirror exposes scrollDOM)
          const scroller = maybeView.scrollDOM || maybeView.dom || document.scrollingElement || document.documentElement;

          // Use CodeMirror document coordinates instead of viewport coords, so large
          // documents and in-flight smooth scrolling do not skew the target.
          const targetScrollTop = Math.max(0, Number(block.top || 0) - effectiveTopOffset);

          const applyScroll = () => {
            scroller.scrollTop = targetScrollTop;
            try {
              if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: targetScrollTop, left: 0, behavior: 'auto' });
            } catch {}
          };
          applyScroll();
          try {
            requestAnimationFrame(() => {
              applyScroll();
              requestAnimationFrame(() => {
                applyScroll();
              });
            });
          } catch {}
        } catch {}
      } else {
        // Fallback: if the editor abstraction provides a scroll API, try it (best-effort)
        try {
          if (typeof ed.scrollToLine === 'function') {
            try { ed.scrollToLine(line); } catch {}
          }
        } catch {}
      }
    } catch {}
  };

  // --- Side panel TOC (Feishu-like) ---
  // Keep UI refs to build a left side panel that flexes with editor (no overlap)
  function debounce(fn, wait = 120) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }
  const createTOCUI = () => ({
    instanceKey: null,
    wrapper: null,
    panel: null,
    button: null,
    groupBtn: null,
    toggleAllBtn: null,
    editorEl: null,
    scrollerEl: null,
    prevScrollerMarginLeft: "",
    prevScrollerMarginRight: "",
    prevWrapperJustifyContent: "",
    prevEditorFlex: "",
    prevEditorWidth: "",
    originalParent: null,
    originalNextSibling: null,
    panelId: null,
    open: false,
    overlay: false,
    collapsedMode: "auto",
    resizeObserver: null,
    editor: null,
    debouncedUpdate: null
  });
  let tocUI = createTOCUI();
  const tocInstances = new Map();
  const TOC_COLLAPSED_MODE_KEY = "zion.toc.collapsedMode";
  // collapsed state set for headings: keep ids of collapsed nodes so updates can preserve UI state
  const tocState = {
    collapsed: new Set(),
    allCollapsibleIds: new Set(),
    generatingBlockIdBySession: new Map(), // sessionId -> 当前正在生成的块ID
    lastGeneratedBlockIdBySession: new Map() // sessionId -> 上一次生成的块ID
  };
  const getPanelIdFromEditor = (ed) => {
    try { return ed?.panelId || getEditorEl(ed)?.closest?.("[data-panel-id]")?.getAttribute?.("data-panel-id") || null; } catch { return null; }
  };
  const getTOCInstanceKey = (ed) => {
    try {
      const editorId = ed?.editorId || ed?.core?.getEditorId?.() || getEditorEl(ed)?.dataset?.editorId || null;
      if (editorId) return `editor:${editorId}`;
      const panelId = getPanelIdFromEditor(ed);
      const sessionId = ed?.sessionId || ed?.core?.getSessionId?.() || getEditorEl(ed)?.closest?.("[data-session-id]")?.getAttribute?.("data-session-id") || null;
      if (panelId && sessionId) return `panel:${panelId}:session:${sessionId}`;
      return panelId ? `panel:${panelId}` : null;
    } catch {
      return null;
    }
  };
  const getTOCUIForEditor = (ed) => {
    const key = getTOCInstanceKey(ed);
    return key ? (tocInstances.get(key) || null) : null;
  };
  const getBoundPanelId = (ui = tocUI) => {
    try { return ui?.panelId || ui?.editorEl?.closest?.("[data-panel-id]")?.getAttribute?.("data-panel-id") || null; } catch { return null; }
  };
  const forEachOpenTOCUI = (fn) => {
    for (const ui of tocInstances.values()) {
      if (!ui?.open) continue;
      try { fn(ui); } catch {}
    }
  };

  const getEditorEl = (ed) => {
    try { return ed?.getView?.()?.dom || ed?.core?.view?.dom || null; } catch { return null; }
  };

  const createTOCWrapper = () => {
    const wrapper = document.createElement("div");
    wrapper.className = "zion-toc-layout";
    wrapper.style.position = "relative";
    wrapper.style.width = "100%";
    wrapper.style.height = "100%";
    wrapper.style.display = "flex";
    wrapper.style.minWidth = "0";
    wrapper.style.minHeight = "0";
    return wrapper;
  };

  const bindTOCUIToEditor = (ed) => {
    try {
      const ui = getTOCUIForEditor(ed);
      const edEl = getEditorEl(ed);
      if (!edEl || !ui?.panel) return false;
      if (!ui.wrapper || ui.editorEl !== edEl || !ui.wrapper.contains(edEl)) return false;
      tocUI = ui;
      return true;
    } catch {
      return false;
    }
  };

  // Helper: 根据会话ID获取对应的TOC块ID
  const getTOCBlockIdForSession = (sessionId) => {
    try {
      const answerHeadLine = window?.zion?.state?.get?.(`chat.answerHeadLine.${sessionId}`);
      if (typeof answerHeadLine === 'number') {
        return `role::assistant::${answerHeadLine}`;
      }
    } catch {}
    return null;
  };
  const getGeneratingBlockIdForEditor = (ed) => {
    try {
      const sid = getSessionIdFromEditor(ed);
      return sid ? (tocState.generatingBlockIdBySession.get(sid) || null) : null;
    } catch {
      return null;
    }
  };
  const getLastGeneratedBlockIdForEditor = (ed) => {
    try {
      const sid = getSessionIdFromEditor(ed);
      return sid ? (tocState.lastGeneratedBlockIdBySession.get(sid) || null) : null;
    } catch {
      return null;
    }
  };

  // 监听大模型回答开始/结束事件
  try {
    const onRunStarted = ({ sessionId }) => {
      const blockId = getTOCBlockIdForSession(sessionId);
      const sid = sessionId ? String(sessionId) : "";
      if (!sid) return;
      if (blockId) tocState.generatingBlockIdBySession.set(sid, blockId);
      else tocState.generatingBlockIdBySession.delete(sid);
      tocState.lastGeneratedBlockIdBySession.delete(sid);
      forEachOpenTOCUI((ui) => ui.debouncedUpdate?.());
    };

    const onRunFinished = ({ sessionId }) => {
      const sid = sessionId ? String(sessionId) : "";
      if (!sid) return;
      const generatingBlockId = tocState.generatingBlockIdBySession.get(sid) || getTOCBlockIdForSession(sid);
      if (generatingBlockId) tocState.lastGeneratedBlockIdBySession.set(sid, generatingBlockId);
      tocState.generatingBlockIdBySession.delete(sid);
      forEachOpenTOCUI((ui) => ui.debouncedUpdate?.());
    };

    window.zion.events.on("chat/runStarted", onRunStarted);
    window.zion.events.on("chat/runFinished", onRunFinished);
    // 记录订阅以便清理
    const chatEventsCleanup = () => {
      try {
        window.zion.events.off("chat/runStarted", onRunStarted);
        window.zion.events.off("chat/runFinished", onRunFinished);
      } catch {}
    };
    // 将清理函数存储在 ctx 上，用于 deactivate 时调用
    ctx.chatEventsCleanup = chatEventsCleanup;
  } catch {}

  const syncToggleAllBtn = (ui = tocUI) => {
    try {
      const btn = ui?.toggleAllBtn;
      if (!btn) return;
      const total = tocState.allCollapsibleIds.size;
      let allCollapsed = total > 0;
      if (allCollapsed) {
        for (const id of tocState.allCollapsibleIds) {
          if (!tocState.collapsed.has(id)) { allCollapsed = false; break; }
        }
      }
      if (allCollapsed) {
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 5l-5 5h10l-5-5zm0 14l5-5H7l5 5z"/></svg>';
        btn.setAttribute('aria-label', '展开全部');
        btn.title = '展开全部';
      } else {
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="currentColor" d="M7 14l5 5 5-5H7zm0-4h10L12 5 7 10z"/></svg>';
        btn.setAttribute('aria-label', '折叠全部');
        btn.title = '折叠全部';
      }
    } catch {}
  };

  const syncGroupBtnUI = (ui = tocUI) => {
    try {
      const groupBtn = ui?.groupBtn;
      if (!groupBtn) return;
      const on = !!window?.zion?.state?.get?.('toc.groupByRole');
      groupBtn.style.opacity = on ? "1" : "0.7";
      groupBtn.style.background = on ? "var(--ext-toc-hover, var(--border))" : "transparent";
      groupBtn.style.color = on ? "var(--ext-toc-active-fg, var(--accent))" : "var(--ext-toc-fg, var(--fg))";
      groupBtn.title = on ? "按角色分组：开" : "按角色分组：关";
    } catch {}
  };
  const getTOCCollapsedMode = () => {
    try {
      const raw = localStorage.getItem(TOC_COLLAPSED_MODE_KEY);
      return raw === "manual-collapsed" ? "manual-collapsed" : "auto";
    } catch {
      return "auto";
    }
  };
  const setTOCCollapsedMode = (mode) => {
    const next = mode === "manual-collapsed" ? "manual-collapsed" : "auto";
    try { localStorage.setItem(TOC_COLLAPSED_MODE_KEY, next); } catch {}
    try {
      for (const ui of tocInstances.values()) {
        if (ui) ui.collapsedMode = next;
      }
    } catch {}
  };
  const shouldAutoOpenSideTOC = (ui = tocUI) => {
    try {
      if (!ui?.wrapper) return false;
      if (ui.collapsedMode === "manual-collapsed") return false;
      const t = document?.documentElement?.dataset?.zionDeviceType;
      if (t === "mobile") return false;
      if (window.innerWidth < 768) return false;
      const available = ui.wrapper.clientWidth || window.innerWidth;
      return available >= 880;
    } catch {
      return false;
    }
  };
  const syncSideTOCVisibility = (ui = tocUI) => {
    try {
      if (!ui?.wrapper || !ui?.panel || !ui?.editor) return;
      if (!ui.wrapper.isConnected || !ui.panel.isConnected || !ui.editorEl?.isConnected) {
        try { document.getElementById("zion-toc-panel")?.remove?.(); } catch {}
        return;
      }
      if (shouldAutoOpenSideTOC(ui)) openSideTOC(ui.editor, { fallbackToOverlay: false });
      else closeSideTOC(ui);
    } catch {}
  };
  const observeTOCContainerResize = (ui = tocUI, onResize) => {
    try {
      ui?.resizeObserver?.disconnect?.();
    } catch {}
    try {
      const ResizeObserverCtor = typeof window !== "undefined" ? window.ResizeObserver : null;
      if (typeof ResizeObserverCtor !== "function" || !ui?.wrapper) return;
      const observer = new ResizeObserverCtor(() => {
        try { onResize?.(); } catch {}
      });
      observer.observe(ui.wrapper.parentElement || ui.wrapper);
      ui.resizeObserver = observer;
    } catch {
      ui.resizeObserver = null;
    }
  };

  // Layout TOC as a simple left sidebar beside the editor pane.
  // Do not mutate CodeMirror's internal centering/margin behavior; only size the two top-level panes.
  const applySideLayout = (ui = tocUI) => {
    try {
      if (!ui?.wrapper || !ui?.panel || !ui?.editorEl) return;
      const wrapper = ui.wrapper;
      const edEl = ui.editorEl;

      wrapper.style.display = "flex";
      wrapper.style.flexDirection = "row";
      wrapper.style.flexWrap = "nowrap";
      wrapper.style.alignItems = "stretch";
      wrapper.style.justifyContent = "flex-start";
      wrapper.style.position = "relative";

      // Ensure the panel has a stable flex-basis/width
      let basis = ui.panel.offsetWidth || 240;
      if (basis <= 0) basis = 240;
      basis = Math.max(220, Math.min(480, basis));
      ui.panel.style.flex = `0 0 ${basis}px`;
      ui.panel.style.width = `${basis}px`;
      // Ensure panel maintains flex column layout for sticky toolbar
      ui.panel.style.display = 'flex';
      ui.panel.style.flexDirection = 'column';

      const available = wrapper.clientWidth || window.innerWidth;

      // Read width mode to set a minimal comfortable editor width for inline layout
      let widthMode = "standard";
      try {
        const wm = window?.zion?.state?.get?.("ui.editorWidthMode");
        if (wm === "full" || wm === "wide" || wm === "standard") widthMode = wm;
      } catch {}

      // Minimal editor width threshold by mode (content + paddings)
      // standard ~ 720, wide ~ 960, full falls back to standard threshold (we let flex shrink)
      const minEditor = widthMode === "standard" ? 560 : widthMode === "wide" ? 760 : 520;

      // Decide overlay only when viewport is too narrow to fit panel + minimal editor comfortably
      const shouldOverlay = available < (basis + minEditor + 16);

      if (shouldOverlay) {
        // Overlay: panel floats above the left side; editor pane keeps full width.
        ui.overlay = true;
        edEl.style.setProperty("--zion-toc-inline-width", "0px");
        ui.panel.style.position = "absolute";
        ui.panel.style.left = "0";
        ui.panel.style.top = "0";
        ui.panel.style.bottom = "0";
        ui.panel.style.height = "100%";
        ui.panel.style.zIndex = "120";

        edEl.style.flex = "1 1 auto";
        edEl.style.width = ui.prevEditorWidth || "";
      } else {
        // Inline: panel sits left, editor pane fills the rest.
        ui.overlay = false;
        edEl.style.setProperty("--zion-toc-inline-width", `${basis}px`);
        ui.panel.style.position = "relative";
        ui.panel.style.left = "";
        ui.panel.style.top = "";
        ui.panel.style.bottom = "";
        ui.panel.style.height = "100%";
        ui.panel.style.zIndex = "";
        edEl.style.flex = "1 1 auto";
        edEl.style.width = "";
      }
    } catch {}
  };

  const updateTOCList = (ui = tocUI) => {
    try {
      const ed = ui?.editor || window.zion.window.activeEditor;
      if (!ed || !ui?.panel) return;
      const maybeView = (ed && ed.core && ed.core.view) ? ed.core.view : null;
      const activeHeadingStateKey = getActiveHeadingStateKey(ui);
      const activeBlockStateKey = getActiveBlockStateKey(ui);
      const generatingBlockId = getGeneratingBlockIdForEditor(ed);
      const lastGeneratedBlockId = getLastGeneratedBlockIdForEditor(ed);

      let list = ui.panel.querySelector('.zion-toc-list');
      if (!list) {
        list = document.createElement('div');
        list.className = 'zion-toc-list';
        // Prevent horizontal scrolling and ensure it fits the panel
        list.style.flex = '1';
        list.style.fontFamily = 'var(--font-sans)';
        list.style.fontSize = '13px';
        list.style.lineHeight = '1.5';
        list.style.overflowY = 'auto';
        list.style.overflowX = 'hidden';
        list.style.minHeight = '0';
        list.style.maxWidth = '100%';
        list.style.boxSizing = 'border-box';
        ui.panel.appendChild(list);
      }
      list.innerHTML = '';

      try { tocState.allCollapsibleIds.clear(); } catch { tocState.allCollapsibleIds = new Set(); }

      const indexTree = (nodes) => {
        try {
          if (!nodes || nodes.length === 0) return;
          nodes.forEach(n => {
            if (!n || !n.id) return;
            if (n.children && n.children.length > 0) {
              tocState.allCollapsibleIds.add(n.id);
              indexTree(n.children);
            }
          });
        } catch {}
      };

      // Build hierarchical tree from flat headings (stack-based)
      const buildTree = (headings, blockStartLineForId = null) => {
        const roots = [];
        const stack = [];
        headings.forEach(h => {
          const id = blockStartLineForId == null
            ? `${slugify(h.title)}::L${h.level}::${h.line}`
            : `${slugify(h.title)}::L${h.level}::${h.line}::B${blockStartLineForId}`;
          const node = Object.assign({}, h, { id, children: [] });
          while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
          if (stack.length === 0) {
            roots.push(node);
          } else {
            stack[stack.length - 1].children.push(node);
          }
          stack.push(node);
        });
        return roots;
      };

      // recursive renderer (keeps collapsible behavior)
      const renderNodes = (parentEl, nodes, baseLevelOffset = 0) => {
        nodes.forEach(item => {
          const row = document.createElement("div");
          row.className = "toc-row";
          try {
            row.dataset.tocId = item.id;
            row.dataset.tocKind = 'heading';
          } catch {}
          row.style.display = "flex";
          row.style.alignItems = "center";
          row.style.padding = "5px 4px";
          row.style.gap = "4px";
          row.style.cursor = "pointer";
          // indentation by semantic level (offset inside role block when grouped)
          row.style.paddingLeft = `${(item.level - 1 + baseLevelOffset) * 10}px`;

          // Always create left column for consistent spacing
          const leftCol = document.createElement("div");
          leftCol.style.display = "flex";
          leftCol.style.alignItems = "center";
          leftCol.style.justifyContent = "center";
          leftCol.style.flex = "0 0 12px";
          leftCol.style.width = "12px";
          
          if (item.children && item.children.length > 0) {
            const isCollapsed = tocState.collapsed.has(item.id);
            const chevronBtn = document.createElement("button");
            chevronBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>';
            chevronBtn.querySelector('svg').style.transform = isCollapsed ? 'rotate(180deg)' : 'rotate(90deg)';
            chevronBtn.querySelector('svg').style.color = "var(--ext-toc-fg, var(--fg))";
            chevronBtn.querySelector('svg').style.fill = "var(--ext-toc-fg, var(--fg))";
            chevronBtn.setAttribute('aria-label', isCollapsed ? '展开子目录' : '收起子目录');
            chevronBtn.title = isCollapsed ? '展开' : '收起';
            chevronBtn.style.background = 'transparent';
            chevronBtn.style.border = 'none';
            chevronBtn.style.width = '16px';
            chevronBtn.style.height = '18px';
            chevronBtn.style.padding = '0';
            chevronBtn.style.cursor = 'pointer';
            chevronBtn.style.display = 'inline-flex';
            chevronBtn.style.alignItems = 'center';
            chevronBtn.style.justifyContent = 'center';
            chevronBtn.style.opacity = '0'; // Hidden by default
            chevronBtn.style.transition = 'opacity 120ms ease';
            chevronBtn.onclick = (e) => {
              e.stopPropagation();
              if (tocState.collapsed.has(item.id)) tocState.collapsed.delete(item.id);
              else tocState.collapsed.add(item.id);
              ui.debouncedUpdate?.();
            };
            
            // Show chevron on row hover
            row.addEventListener('mouseenter', () => {
              chevronBtn.style.opacity = '1';
            });
            row.addEventListener('mouseleave', () => {
              chevronBtn.style.opacity = '0';
            });
            
            leftCol.appendChild(chevronBtn);
          }
          row.appendChild(leftCol);

          const label = document.createElement("span");
          label.className = "toc-label";
          label.textContent = item.title;
          label.style.fontSize = "13px";
          label.style.lineHeight = "1.5";
          label.style.letterSpacing = "0";
          label.style.whiteSpace = "nowrap";
          label.style.textOverflow = "ellipsis";
          label.style.overflow = "hidden";
          label.style.marginLeft = "0";
          row.appendChild(label);
          // Active heading highlight (cursor-based)
          try {
            const activeId = window?.zion?.state?.get?.(activeHeadingStateKey);
            if (activeId && activeId === item.id) {
              label.style.fontWeight = "600";
              label.style.color = "var(--ext-toc-active-fg, var(--accent))";
            }
          } catch {}

          row.onclick = () => {
            try {
              window?.zion?.state?.set?.(activeHeadingStateKey, item.id);
              window?.zion?.state?.set?.(activeBlockStateKey, null);
              const maybeView = (ed && ed.core && ed.core.view) ? ed.core.view : null;
              scrollLineIntoViewTop(ed, maybeView, item.line, 48);
            } catch {}
          };

          parentEl.appendChild(row);

          // render children if not collapsed (preserve base offset)
            if (item.children && item.children.length > 0 && !tocState.collapsed.has(item.id)) {
              renderNodes(parentEl, item.children, baseLevelOffset);
            }
        });
      };

      // decide mode
      const groupMode = !!window?.zion?.state?.get?.('toc.groupByRole');

      if (!groupMode) {
        const headings = maybeView ? parseHeadingsFromView(maybeView) : parseHeadingsFromText(ed.getValue());
        if (headings.length === 0) {
          const empty = document.createElement("div");
          empty.textContent = t("ui.empty", "No headings found (use #, ##, ### ...)");
          empty.style.opacity = "0.8";
          empty.style.fontSize = "13px";
          empty.style.padding = "8px 10px";
          list.appendChild(empty);
        } else {
          const roots = buildTree(headings);
          indexTree(roots);
          renderNodes(list, roots);
        }
      } else {
        // group by role blocks
        const blocks = getRoleBlocksForEditor(ed, maybeView);
        if (!blocks || blocks.length === 0) {
          // fallback to flat headings
          const headings = maybeView ? parseHeadingsFromView(maybeView) : parseHeadingsFromText(ed.getValue());
          const roots = buildTree(headings);
          indexTree(roots);
          renderNodes(list, roots);
        } else {
          blocks.forEach((b) => {
            let blockStartLine = b?.startLine;
            if (blockStartLine == null && maybeView && typeof b?.from === 'number') {
              try { blockStartLine = maybeView.state.doc.lineAt(b.from).number - 1; } catch {}
            }
            if (blockStartLine == null) blockStartLine = 0;

            // headings within this block
            let hs = [];
            if (maybeView && typeof b.from === 'number' && typeof b.to === 'number') {
              hs = parseHeadingsFromViewInRange(maybeView, b.from, b.to);
            } else {
              const s = typeof b?.startLine === 'number' ? b.startLine : blockStartLine;
              const e = typeof b?.endLine === 'number' ? b.endLine : s;
              hs = parseHeadingsFromTextInLines(ed.getValue(), s, e);
            }
            const roots = buildTree(hs, blockStartLine);

            const blockId = `role::${(b?.role || '').toLowerCase()}::${blockStartLine}`;
            if (roots.length > 0) tocState.allCollapsibleIds.add(blockId);
            indexTree(roots);

            // block row as top-level
            const row = document.createElement("div");
            row.className = "toc-row";
            try {
              row.dataset.tocId = blockId;
              row.dataset.tocKind = 'block';
            } catch {}
            row.style.display = "flex";
            row.style.alignItems = "center";
            row.style.padding = "6px 4px";
            row.style.gap = "4px";
            row.style.cursor = "pointer";

            // chevron or spacer
            // Always create left column for consistent spacing
            const leftCol = document.createElement("div");
            leftCol.style.display = "flex";
            leftCol.style.alignItems = "center";
            leftCol.style.justifyContent = "center";
            leftCol.style.flex = "0 0 12px";
            leftCol.style.width = "12px";
            
            if (roots.length > 0) {
              const isCollapsed = tocState.collapsed.has(blockId);
              const chevronBtn = document.createElement("button");
              chevronBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>';
              chevronBtn.querySelector('svg').style.transform = isCollapsed ? 'rotate(180deg)' : 'rotate(90deg)';
              chevronBtn.querySelector('svg').style.color = "var(--ext-toc-fg, var(--fg))";
              chevronBtn.querySelector('svg').style.fill = "var(--ext-toc-fg, var(--fg))";
              chevronBtn.setAttribute('aria-label', isCollapsed ? '展开块内目录' : '收起块内目录');
              chevronBtn.title = isCollapsed ? '展开' : '收起';
              chevronBtn.style.background = 'transparent';
              chevronBtn.style.border = 'none';
              chevronBtn.style.width = '16px';
              chevronBtn.style.height = '18px';
              chevronBtn.style.padding = '0';
              chevronBtn.style.cursor = 'pointer';
              chevronBtn.style.display = 'inline-flex';
              chevronBtn.style.alignItems = 'center';
              chevronBtn.style.justifyContent = 'center';
              chevronBtn.style.opacity = '0'; // Hidden by default
              chevronBtn.style.transition = 'opacity 120ms ease';
              chevronBtn.onclick = (e) => {
                e.stopPropagation();
                if (tocState.collapsed.has(blockId)) tocState.collapsed.delete(blockId);
                else tocState.collapsed.add(blockId);
                ui.debouncedUpdate?.();
              };
              
              // Show chevron on row hover
              row.addEventListener('mouseenter', () => {
                chevronBtn.style.opacity = '1';
              });
              row.addEventListener('mouseleave', () => {
                chevronBtn.style.opacity = '0';
              });
              
              leftCol.appendChild(chevronBtn);
            }
            row.appendChild(leftCol);

            const label = document.createElement("span");
            label.className = "toc-label";
            // Use color dot to mark role (方案4) - more subtle
            const roleColors = {
              user: 'var(--ext-toc-role-user, var(--role-user-fg, #4caf50))',
              assistant: 'var(--ext-toc-role-assistant, var(--role-assistant-fg, #2196f3))',
              system: 'var(--ext-toc-role-system, var(--role-system-fg, #9e9e9e))'
            };
            const dotColor = roleColors[b.role?.toLowerCase()] || roleColors.user;
            // 判断是否是正在生成的块
            const isGenerating = generatingBlockId === blockId;
            const isLastGenerated = lastGeneratedBlockId === blockId;

            // 创建小圆点容器，给它留出空间
            const dotContainer = document.createElement("span");
            dotContainer.style.display = "inline-flex";
            dotContainer.style.alignItems = "center";
            dotContainer.style.justifyContent = "center";
            dotContainer.style.width = "12px";
            dotContainer.style.height = "16px";
            dotContainer.style.flexShrink = "0";
            dotContainer.style.marginRight = "5px";

            if (isLastGenerated) {
              // 持久化指示器 - 使用 SVG 图标代替字符
              const indicator = document.createElement("span");
              indicator.style.display = "flex";
              indicator.style.alignItems = "center";
              indicator.style.justifyContent = "center";
              indicator.style.width = "14px";
              indicator.style.height = "14px";
              indicator.style.color = "var(--ext-toc-active-fg, var(--accent))";
              indicator.title = "New answer here";
              // 使用一个实心圆点带外圈的图标，或者一个漂亮的箭头
              // 这里选用一个向左的箭头，或者一个定位图标。
              // 考虑到 "new answer"，使用一个小圆点带光晕效果的 SVG 可能更好，或者简单的 Left Arrow Icon
              // 试用 Right Arrow
              indicator.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';
              dotContainer.appendChild(indicator);
            } else {
              const dot = document.createElement("span");
              dot.style.display = "inline-block";
              dot.style.width = "6px";
              dot.style.height = "6px";
              dot.style.borderRadius = "50%";
              dot.style.background = dotColor;
              dot.style.opacity = isGenerating ? "0.8" : "0.6";
              dot.style.transition = "opacity 120ms ease";
              if (isGenerating) {
                dot.style.animation = "toc-pulse 1.5s ease-in-out infinite";
              }
              dotContainer.appendChild(dot);
            }

            const textSpan = document.createElement("span");
            textSpan.textContent = (b.preview || '').trim() || '(empty)';
            textSpan.style.fontSize = "13px";
            textSpan.style.lineHeight = "1.5";
            textSpan.style.letterSpacing = "0";
            textSpan.style.whiteSpace = "nowrap";
            textSpan.style.textOverflow = "ellipsis";
            textSpan.style.overflow = "hidden";
            textSpan.style.flex = "1";

            label.appendChild(dotContainer);
            label.appendChild(textSpan);
            label.style.marginLeft = "0";
            label.style.display = "flex";
            label.style.alignItems = "center";
            label.style.justifyContent = "flex-start"; // 确保从左侧开始布局
            // Add tooltip to show role name on hover
            label.title = `${b.role || 'unknown'}: ${(b.preview || '').trim() || '(empty)'}`;

            // 生成中的块有额外样式
            if (isGenerating) {
              label.style.color = "var(--ext-toc-active-fg, var(--accent))";
              label.style.fontWeight = "500";
            }

            try {
              const activeBlockId = window?.zion?.state?.get?.(activeBlockStateKey);
              const activeHeadingId = window?.zion?.state?.get?.(activeHeadingStateKey);
              // 活跃块的高亮（生成中状态优先级更高）
              if (activeBlockId && activeBlockId === blockId && !activeHeadingId && !isGenerating) {
                label.style.fontWeight = "600";
                label.style.color = "var(--ext-toc-active-fg, var(--accent))";
              }
            } catch {}

            row.appendChild(label);

            row.onclick = () => {
              // Clear persistent indicator on click
              const sid = getSessionIdFromEditor(ed);
              if (sid && tocState.lastGeneratedBlockIdBySession.get(sid) === blockId) {
                tocState.lastGeneratedBlockIdBySession.delete(sid);
                setTimeout(() => ui.debouncedUpdate?.(), 0);
              }
              try {
                window?.zion?.state?.set?.(activeHeadingStateKey, null);
                window?.zion?.state?.set?.(activeBlockStateKey, blockId);
                const maybeView = (ed && ed.core && ed.core.view) ? ed.core.view : null;
                scrollLineIntoViewTop(ed, maybeView, blockStartLine, 48);
              } catch {}
            };


            list.appendChild(row);

            // render this block's headings if not collapsed
            if (roots.length > 0 && !tocState.collapsed.has(blockId)) {
              renderNodes(list, roots, 1);
            }
          });
        }
      }

      syncToggleAllBtn(ui);

      try {
        const activeHeadingId = window?.zion?.state?.get?.(activeHeadingStateKey);
        const activeBlockId = window?.zion?.state?.get?.(activeBlockStateKey);
        const activeId = activeHeadingId || activeBlockId;
        if (activeId) {
          requestAnimationFrame(() => {
            try {
              const id = String(activeId).replace(/"/g, '\\"');
              const el = list.querySelector(`[data-toc-id="${id}"]`);
              if (!el) return;

              const listRect = list.getBoundingClientRect();
              const elRect = el.getBoundingClientRect();
              const topSafe = listRect.top + listRect.height * 0.25;
              const bottomSafe = listRect.bottom - listRect.height * 0.25;
              const isOutOfSafeZone = elRect.top < topSafe || elRect.bottom > bottomSafe;
              if (!isOutOfSafeZone) return;

              const elTop = (elRect.top - listRect.top) + list.scrollTop;
              const targetTop = elTop - list.clientHeight * 0.35;
              const maxTop = Math.max(0, list.scrollHeight - list.clientHeight);
              const nextTop = Math.max(0, Math.min(maxTop, targetTop));
              try {
                list.scrollTo({ top: nextTop, left: 0, behavior: 'auto' });
              } catch {
                list.scrollTop = nextTop;
              }
            } catch {}
          });
        }
      } catch {}
    } catch {}
  };

  const openSideTOC = (ed = window.zion.window.activeEditor, opts = {}) => {
    const allowOverlayFallback = opts?.fallbackToOverlay !== false;
    const maybeView = (ed && ed.core && ed.core.view) ? ed.core.view : null;
    const ui = getTOCUIForEditor(ed);
    if (!ed) return allowOverlayFallback ? showOverlayTOC() : undefined;
    try {
      const t = document?.documentElement?.dataset?.zionDeviceType;
      if (t === "mobile") return allowOverlayFallback ? showOverlayTOC() : undefined;
    } catch {}
    try {
      if (window.innerWidth < 768) return allowOverlayFallback ? showOverlayTOC() : undefined;
    } catch {}
    if (!bindTOCUIToEditor(ed) || !ui?.wrapper || !ui?.panel || !ui?.editorEl || !ui.wrapper.isConnected || !ui.editorEl.isConnected) {
      // UI not ready (editor DOM not found) -> fallback to overlay
      return allowOverlayFallback ? showOverlayTOC() : undefined;
    }
    tocUI = ui;
    // Show panel
    ui.panel.style.display = "block";

    // Backup current styles to restore when closing
    if (ui.wrapper) {
      ui.prevWrapperJustifyContent = ui.wrapper.style.justifyContent || "";
    }
    if (ui.editorEl) {
      ui.prevEditorFlex = ui.editorEl.style.flex || "";
      ui.prevEditorWidth = ui.editorEl.style.width || "";
    }

    // Apply a simple left-sidebar layout.
    applySideLayout(ui);

    // Sync active heading/block based on visible content (cursor-in-view prefers cursor)
    try {
      if (maybeView) scheduleComputeActiveTOCByVisibility(maybeView, ed);
      else computeActiveTOCAtCursor(null, { mode: 'cursor', editor: ed });
    } catch {}

    // Build list
    updateTOCList(ui);
    ui.open = true;
  };

  const closeSideTOC = (ui = tocUI) => {
    if (!ui?.wrapper || !ui?.panel || !ui?.editorEl) return;
    ui.panel.style.display = "none";
    ui.overlay = false;
    // Restore wrapper layout
    if (ui.wrapper) {
      ui.wrapper.style.display = "flex";
      ui.wrapper.style.justifyContent = ui.prevWrapperJustifyContent || "";
    }
    // Restore editor element sizing
    if (ui.editorEl) {
      ui.editorEl.style.flex = ui.prevEditorFlex || "";
      ui.editorEl.style.width = ui.prevEditorWidth || "";
      ui.editorEl.style.removeProperty("--zion-toc-inline-width");
    }
    ui.prevScrollerMarginLeft = "";
    ui.prevScrollerMarginRight = "";
    ui.open = false;
  };

  const toggleSideTOC = () => {
    const ed = window.zion.window.activeEditor;
    const ui = getTOCUIForEditor(ed);
    try {
      const t = document?.documentElement?.dataset?.zionDeviceType;
      if (t === "mobile") {
        try { closeSideTOC(ui); } catch {}
        try {
          const exist = document.getElementById("zion-toc-panel");
          if (exist) { exist.remove(); return; }
        } catch {}
        return showOverlayTOC();
      }
    } catch {}
    try {
      if (window.innerWidth < 768) {
        try { closeSideTOC(ui); } catch {}
        try {
          const exist = document.getElementById("zion-toc-panel");
          if (exist) { exist.remove(); return; }
        } catch {}
        return showOverlayTOC();
      }
    } catch {}
    if (ui?.open) {
      setTOCCollapsedMode("manual-collapsed");
      closeSideTOC(ui);
    } else {
      setTOCCollapsedMode("auto");
      openSideTOC(ed);
    }
  };

  const showOverlayTOC = () => {
    const ed = window.zion.window.activeEditor;
    if (!ed) return;
    // Prefer CodeMirror syntax-tree based parsing when we can reach the underlying view
    const maybeView = (ed && ed.core && ed.core.view) ? ed.core.view : null;
    const headings = maybeView ? parseHeadingsFromView(maybeView) : parseHeadingsFromText(ed.getValue());

    // Remove existing if any
    const exist = document.getElementById("zion-toc-panel");
    if (exist) exist.remove();

    const overlay = document.createElement("div");
    overlay.id = "zion-toc-panel";
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
    panel.style.width = "360px";
    panel.style.maxHeight = "65vh";
    // Prevent horizontal scrolling in overlay panel; allow vertical scroll if needed
    panel.style.overflowY = "auto";
    panel.style.overflowX = "hidden";
    // Theming: allow extension-specific override with fallback to global theme
    panel.style.background = "var(--ext-toc-bg, var(--panel))";
    panel.style.border = "1px solid var(--ext-toc-border, var(--border))";
    panel.style.borderRadius = "6px";
    panel.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";
    panel.style.padding = "10px";
    panel.style.fontFamily = "var(--font-sans)";
    panel.style.fontSize = "13px";
    panel.style.lineHeight = "1.5";
    panel.style.zIndex = "99999";
    panel.onclick = (e) => e.stopPropagation();

    const title = document.createElement("div");
    title.textContent = t("ui.contents", "Contents");
    title.style.fontWeight = "600";
    title.style.marginBottom = "8px";
    panel.appendChild(title);

    const list = document.createElement("div");
    // Constrain list to avoid horizontal scrolling
    list.style.fontFamily = "var(--font-sans)";
    list.style.fontSize = "13px";
    list.style.lineHeight = "1.5";
    list.style.overflowY = "auto";
    list.style.overflowX = "hidden";
    list.style.maxWidth = "100%";
    if (headings.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = t("ui.empty", "No headings found (use #, ##, ### ...)");
      empty.style.opacity = "0.8";
      empty.style.fontSize = "13px";
      list.appendChild(empty);
    } else {
      headings.forEach(h => {
        const row = document.createElement("div");
        row.className = "toc-row";
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.padding = "5px 4px";
        row.style.gap = "4px";
        row.style.cursor = "pointer";
        // indent by level (still set inline for per-item indentation)
        row.style.paddingLeft = `${(h.level - 1) * 10}px`;

        const bullet = document.createElement("span");
        bullet.className = "toc-bullet";
        bullet.textContent = "•";

        const label = document.createElement("span");
        label.className = "toc-label";
        label.textContent = h.title;
        label.style.fontSize = "13px";
        label.style.lineHeight = "1.5";
        label.style.letterSpacing = "0";
        label.style.whiteSpace = "nowrap";
        label.style.textOverflow = "ellipsis";
        label.style.overflow = "hidden";

        row.appendChild(bullet);
        row.appendChild(label);

        row.onclick = () => {
          try {
            const maybeView = (ed && ed.core && ed.core.view) ? ed.core.view : null;
            scrollLineIntoViewTop(ed, maybeView, h.line, 48);
          } finally {
            overlay.remove();
          }
        };

        list.appendChild(row);
      });
    }

    panel.appendChild(list);

    const footer = document.createElement("div");
    footer.style.marginTop = "10px";
    footer.style.display = "flex";
    footer.style.justifyContent = "space-between";

    const insertBtn = document.createElement("button");
    insertBtn.textContent = t("ui.insertHere", "Insert TOC Here");
    insertBtn.style.background = "var(--ext-toc-btn-bg, var(--panel))";
    insertBtn.style.color = "var(--ext-toc-fg, var(--fg))";
    insertBtn.style.border = "1px solid var(--ext-toc-accent, var(--accent))";
    insertBtn.style.borderRadius = "4px";
    insertBtn.style.padding = "4px 8px";
    insertBtn.onclick = () => {
      window.zion.commands.executeCommand("toc.insert");
      overlay.remove();
    };

    const closeBtn = document.createElement("button");
    closeBtn.textContent = t("ui.close", "Close");
    closeBtn.style.background = "var(--ext-toc-btn-bg, var(--panel))";
    closeBtn.style.color = "var(--ext-toc-fg, var(--fg))";
    closeBtn.style.border = "1px solid var(--ext-toc-accent, var(--accent))";
    closeBtn.style.borderRadius = "4px";
    closeBtn.style.padding = "4px 8px";
    closeBtn.onclick = () => overlay.remove();

    footer.appendChild(insertBtn);
    footer.appendChild(closeBtn);
    panel.appendChild(footer);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  };

  const teardownTOCLayout = (ui) => {
    try {
      closeSideTOC(ui);
      if (ui?.panel) ui.panel.remove();
      if (ui?.originalParent && ui?.editorEl) {
        ui.originalParent.insertBefore(ui.editorEl, ui.originalNextSibling || null);
      }
      if (ui?.wrapper) ui.wrapper.remove();
    } catch {}
    try {
      ui.wrapper = null;
      ui.panel = null;
      ui.button = null;
      ui.editorEl = null;
      ui.scrollerEl = null;
      ui.prevScrollerMarginLeft = "";
      ui.prevScrollerMarginRight = "";
      ui.prevWrapperJustifyContent = "";
      ui.prevEditorFlex = "";
      ui.prevEditorWidth = "";
      ui.originalParent = null;
      ui.originalNextSibling = null;
      ui.open = false;
      ui.overlay = false;
    } catch {}
  };

  // Build TOC text according to current group mode (Grp).
  // Returns a markdown string (including <!-- TOC start --> / <!-- TOC end -->) suitable for copy/insert.
  const buildTOCText = (ed) => {
    if (!ed) return "<!-- TOC: no headings found -->\n";
    const groupMode = !!window?.zion?.state?.get?.('toc.groupByRole');
    const maybeView = (ed && ed.core && ed.core.view) ? ed.core.view : null;
    // helper: flat TOC
    const buildFlat = () => {
      const headings = maybeView ? parseHeadingsFromView(maybeView) : parseHeadingsFromText(ed.getValue());
      if (!headings || headings.length === 0) return "<!-- TOC: no headings found -->\n";
      const lines = headings.map(h => {
        const indent = "  ".repeat(Math.max(0, h.level - 1));
        const s = slugify(h.title);
        return `${indent}- [${h.title}](#${s})`;
      });
      return ["<!-- TOC start -->", ...lines, "<!-- TOC end -->"].join("\n") + "\n";
    };

    if (!groupMode) {
      return buildFlat();
    }

    // Group mode: build by role blocks
    const blocks = getRoleBlocksForEditor(ed, maybeView);
    if (!blocks || blocks.length === 0) {
      // fallback to flat if no blocks found
      return buildFlat();
    }

    const out = ["<!-- TOC start -->"];
    const docText = ed.getValue();
    for (const b of blocks) {
      const roleLabel = `${b.role}: ${((b.preview || "").trim()) || "(empty)"}`;
      // top-level bullet for block
      out.push(`- ${roleLabel}`);
      // headings inside block
      let hs = [];
      if (maybeView && typeof b.from === "number" && typeof b.to === "number") {
        hs = parseHeadingsFromViewInRange(maybeView, b.from, b.to);
      } else {
        const sLine = typeof b.startLine === "number" ? b.startLine : 0;
        const eLine = typeof b.endLine === "number" ? b.endLine : sLine;
        hs = parseHeadingsFromTextInLines(docText, sLine, eLine);
      }
      if (hs && hs.length > 0) {
        for (const h of hs) {
          // one extra indentation level for block content
          const indent = "  ".repeat(Math.max(0, (h.level - 1) + 1));
          const s = slugify(h.title);
          out.push(`${indent}- [${h.title}](#${s})`);
        }
      }
    }
    out.push("<!-- TOC end -->");
    return out.join("\n") + "\n";
  };

  const insertMarkdownTOC = () => {
    const ed = window.zion.window.activeEditor;
    if (!ed) return;
    const tocText = buildTOCText(ed);
    ed.replaceSelection(tocText);
  };

  // commands
  const d1 = window.zion.commands.registerCommand("toc.show", () => {
    return toggleSideTOC();
  });
  const d2 = window.zion.commands.registerCommand("toc.insert", () => insertMarkdownTOC());
  ctx.subscriptions.push(d1, d2);

  // 初始化分组开关状态（localStorage -> state）
  try {
    const saved = localStorage.getItem('zion.toc.groupByRole');
    const initial = saved === '1' || saved === 'true';
    window.zion.state.set('toc.groupByRole', !!initial);
  } catch {}

  // 切换分组模式命令
  const dToggle = window.zion.commands.registerCommand("toc.toggleGroupByRole", () => {
    try {
      const cur = !!window.zion.state.get('toc.groupByRole');
      const next = !cur;
      window.zion.state.set('toc.groupByRole', next);
      // 切换分组模式时清空高亮状态，防止残留
      forEachOpenTOCUI((ui) => {
        try { window.zion.state.set(getActiveHeadingStateKey(ui), null); } catch {}
        try { window.zion.state.set(getActiveBlockStateKey(ui), null); } catch {}
      });
      try { localStorage.setItem('zion.toc.groupByRole', next ? '1' : '0'); } catch {}
      forEachOpenTOCUI((ui) => {
        try {
          const maybeView = ui?.editor?.core?.view || null;
          computeActiveTOCAtCursor(maybeView, { editor: ui?.editor || null });
        } catch {}
        ui.debouncedUpdate?.();
      });
    } catch {}
  });
  ctx.subscriptions.push(dToggle);

  // Register slash commands
  const dSlash1 = window.zion.slash?.registerCommand?.({
    id: "toc.show",
    trigger: ["toc", "table-of-contents"],
    title: t("cmd.show", "显示目录"),
    description: t("slash.show.description", "打开文档目录侧边栏"),
    category: t("category.toc", "目录"),
    icon: "📑",
    priority: 100,
    execute: () => {
      window.zion.commands.executeCommand("toc.show");
    }
  });

  const dSlash2 = window.zion.slash?.registerCommand?.({
    id: "toc.insert",
    trigger: ["insert-toc", "toc-insert"],
    title: t("cmd.insert", "插入目录"),
    description: t("slash.insert.description", "在光标位置插入 Markdown 目录"),
    category: t("category.toc", "目录"),
    icon: "📋",
    priority: 90,
    execute: () => {
      window.zion.commands.executeCommand("toc.insert");
    }
  });

  const dSlash3 = window.zion.slash?.registerCommand?.({
    id: "toc.toggleGroupByRole",
    trigger: ["toc-group", "group-toc"],
    title: t("cmd.toggleGroupByRole", "切换目录分组"),
    description: t("slash.group.description", "按角色分组显示目录"),
    category: t("category.toc", "目录"),
    icon: "📑",
    priority: 80,
    execute: () => {
      window.zion.commands.executeCommand("toc.toggleGroupByRole");
    }
  });

  if (dSlash1) ctx.subscriptions.push(dSlash1);
  if (dSlash2) ctx.subscriptions.push(dSlash2);
  if (dSlash3) ctx.subscriptions.push(dSlash3);

  // 分组模式快捷键
  const dKBGroup = window.zion.keybindings.register({
    command: "toc.toggleGroupByRole",
    key: "Mod-Shift-g",
    when: "editorFocus"
  });
  ctx.subscriptions.push(dKBGroup);

  // Decorator: mount floating button (top-left) and left side TOC panel (flex with editor)
  const d5 = window.zion.editor.registerDecorator({
    id: "dev.toc.ui",
    apply(editor) {
      let ui = null;
      try {
        const panelId = getPanelIdFromEditor(editor);
        const instanceKey = getTOCInstanceKey(editor);
        const edEl = getEditorEl(editor);
        if (!edEl) return { dispose() {} };
        ui = instanceKey ? tocInstances.get(instanceKey) : null;
        if (!ui) {
          ui = createTOCUI();
          ui.instanceKey = instanceKey || null;
          ui.panelId = panelId || null;
          ui.collapsedMode = getTOCCollapsedMode();
          ui.editor = editor;
          ui.debouncedUpdate = debounce(() => updateTOCList(ui), 120);
          if (instanceKey) tocInstances.set(instanceKey, ui);
        } else {
          ui.collapsedMode = getTOCCollapsedMode();
          ui.editor = editor;
        }
        tocUI = ui;

        const needsRebuild = !ui.wrapper || ui.editorEl !== edEl || !ui.wrapper.contains(edEl);
        if (needsRebuild && ui.wrapper) {
          teardownTOCLayout(ui);
        }

        // Build UI once per actual editor DOM
        if (!ui.wrapper) {
          const originalParent = edEl.parentElement;
          const originalNextSibling = edEl.nextSibling;

          const wrapper = createTOCWrapper();
          // Insert a simple layout at the editor-slot level: TOC on the left, real editor on the right.
          originalParent.insertBefore(wrapper, edEl);
          wrapper.appendChild(edEl);

          // Left side panel
          const panel = document.createElement("div");
          panel.className = "zion-toc-sidepanel";
          panel.style.display = "none";
          panel.style.flex = "0 0 268px";
          panel.style.width = "268px";
          panel.style.minWidth = "240px";
          panel.style.maxWidth = "480px";
          panel.style.height = "100%";
          // Prevent horizontal scrolling in the TOC side panel; allow only vertical scrolling
          panel.style.display = "none";
          panel.style.flexDirection = "column";
          panel.style.background = "var(--ext-toc-bg, var(--editor-bg, var(--bg)))";
          // remove right border to avoid visual divider
          panel.style.borderRight = "none";
          // panel.style.boxShadow = "2px 0 8px rgba(0,0,0,0.15)";

          // 拖拽右侧边框调整宽度
          const resizer = document.createElement("div");
          resizer.style.position = "absolute";
          resizer.style.top = "0";
          resizer.style.right = "-3px";
          resizer.style.width = "6px";
          resizer.style.height = "100%";
          resizer.style.cursor = "ew-resize";
          resizer.style.zIndex = "10";
          resizer.style.userSelect = "none";
          resizer.style.background = "transparent";
          panel.style.position = "relative";
          panel.appendChild(resizer);

          let isResizing = false;
          let startX = 0;
          let startWidth = 0;
          const minWidth = 240;
          const maxWidth = 480;

          resizer.addEventListener("mousedown", (e) => {
            isResizing = true;
            startX = e.clientX;
            startWidth = panel.offsetWidth;
            document.body.style.cursor = "ew-resize";
            document.body.style.userSelect = "none";
            e.preventDefault();
          });

          window.addEventListener("mousemove", (e) => {
            if (!isResizing) return;
            const dx = e.clientX - startX;
            let newWidth = startWidth + dx;
            if (newWidth < minWidth) newWidth = minWidth;
            if (newWidth > maxWidth) newWidth = maxWidth;
            panel.style.flex = `0 0 ${newWidth}px`;
            panel.style.width = `${newWidth}px`;
          });

          window.addEventListener("mouseup", () => {
            if (isResizing) {
              isResizing = false;
              document.body.style.cursor = "";
              document.body.style.userSelect = "";
            }
          });

          // Insert panel before the real editor so TOC never becomes part of CodeMirror's DOM.
          wrapper.insertBefore(panel, edEl);

          // Button toolbar (right-aligned, icons only)
          const toolbar = document.createElement("div");
          toolbar.style.display = "flex";
          toolbar.style.alignItems = "center";
          toolbar.style.gap = "8px";
          toolbar.style.padding = "10px 8px 8px";
          toolbar.style.justifyContent = "flex-start";
          toolbar.style.flexShrink = "0";
          toolbar.style.flexGrow = "0";
          // ensure toolbar spans full width and align buttons to the right
          toolbar.style.width = "100%";

          // 分组模式切换按钮
          const groupBtn = document.createElement("button");
          groupBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm2 4v-2H3v2h2zM3 9h2V7H3v2zm12 12h2v-2h-2v2zm4-18H9v2h10v10h2V3zm-2 14h-2v2h2v-2zm-4 4h-2v2h2v-2zM9 17h2v-2H9v2zm0-4h2v-2H9v2zm0-4h2V7H9v2zm4 8h2v-2h-2v2zm0-8h2V7h-2v2zm4 4h2v-2h-2v2zm0-4h2V7h-2v2z"/></svg>';
          groupBtn.setAttribute('aria-label', '按角色分组 TOC');
          groupBtn.title = "按角色分组 TOC";
          // Use the same base visual style as other toolbar buttons (icon-only, no border/background)
          groupBtn.style.background = "transparent";
          groupBtn.style.color = "var(--ext-toc-fg, var(--fg))";
          groupBtn.style.border = "none";
          groupBtn.style.borderRadius = "4px";
          groupBtn.style.padding = "4px";
          groupBtn.style.fontSize = "12px";
          groupBtn.style.cursor = "pointer";
          groupBtn.style.opacity = "0.7";
          groupBtn.style.transition = "opacity 120ms ease";
          ui.groupBtn = groupBtn;
          groupBtn.onclick = () => window.zion.commands.executeCommand("toc.toggleGroupByRole");
          toolbar.appendChild(groupBtn);
          syncGroupBtnUI(ui);

          const toggleAllBtn = document.createElement("button");
          toggleAllBtn.setAttribute('aria-label', '折叠全部');
          toggleAllBtn.title = "折叠全部";
          toggleAllBtn.style.background = "transparent";
          toggleAllBtn.style.color = "var(--ext-toc-fg, var(--fg))";
          toggleAllBtn.style.border = "none";
          toggleAllBtn.style.borderRadius = "4px";
          toggleAllBtn.style.padding = "4px";
          toggleAllBtn.style.fontSize = "12px";
          toggleAllBtn.style.cursor = "pointer";
          toggleAllBtn.style.opacity = "0.7";
          toggleAllBtn.style.transition = "opacity 120ms ease";
          toggleAllBtn.onclick = () => {
            try {
              const total = tocState.allCollapsibleIds.size;
              let allCollapsed = total > 0;
              if (allCollapsed) {
                for (const id of tocState.allCollapsibleIds) {
                  if (!tocState.collapsed.has(id)) { allCollapsed = false; break; }
                }
              }
              if (allCollapsed) {
                tocState.collapsed.clear();
              } else {
                tocState.collapsed.clear();
                for (const id of tocState.allCollapsibleIds) tocState.collapsed.add(id);
              }
              updateTOCList(ui);
            } catch {}
          };
          toolbar.appendChild(toggleAllBtn);

          ui.toggleAllBtn = toggleAllBtn;
          syncToggleAllBtn(ui);

          // 复制按钮（内联 clipboard SVG）
          const copyBtn = document.createElement("button");
          copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
          copyBtn.setAttribute('aria-label', '复制 TOC 到剪贴板');
          copyBtn.title = "复制 TOC 到剪贴板";
          copyBtn.style.background = "transparent";
          copyBtn.style.color = "var(--ext-toc-fg, var(--fg))";
          copyBtn.style.border = "none";
          copyBtn.style.borderRadius = "4px";
          copyBtn.style.padding = "4px";
          copyBtn.style.fontSize = "12px";
          copyBtn.style.cursor = "pointer";
          copyBtn.style.opacity = "0.7";
          copyBtn.style.transition = "opacity 120ms ease";
          copyBtn.onclick = () => {
            const ed = window.zion.window.activeEditor;
            if (!ed) return;
            try {
              const text = buildTOCText(ed);
              navigator.clipboard.writeText(text);
            } catch (e) {
              // best-effort: fallback to simple flat TOC
              try {
                const maybeView = (ed && ed.core && ed.core.view) ? ed.core.view : null;
                const headings = maybeView ? parseHeadingsFromView(maybeView) : parseHeadingsFromText(ed.getValue());
                if (!headings || headings.length === 0) navigator.clipboard.writeText("<!-- TOC: no headings found -->\n");
                else {
                  const lines = headings.map(h => {
                    const indent = "  ".repeat(Math.max(0, h.level - 1));
                    const s = slugify(h.title);
                    return `${indent}- [${h.title}](#${s})`;
                  });
                  const tocBlock = ["<!-- TOC start -->", ...lines, "<!-- TOC end -->"].join("\n") + "\n";
                  navigator.clipboard.writeText(tocBlock);
                }
              } catch {}
            }
          };
          toolbar.appendChild(copyBtn);

          // 插入按钮（内联 plus SVG）
          const insertBtn = document.createElement("button");
          insertBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="currentColor" d="M19 13H13v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
          insertBtn.setAttribute('aria-label', '插入 TOC 到光标处');
          insertBtn.title = "插入 TOC 到光标处";
          insertBtn.style.background = "transparent";
          insertBtn.style.color = "var(--ext-toc-fg, var(--fg))";
          insertBtn.style.border = "none";
          insertBtn.style.borderRadius = "4px";
          insertBtn.style.padding = "4px";
          insertBtn.style.fontSize = "12px";
          insertBtn.style.cursor = "pointer";
          insertBtn.style.opacity = "0.7";
          insertBtn.style.transition = "opacity 120ms ease";
          insertBtn.onclick = () => {
            window.zion.commands.executeCommand("toc.insert");
          };
          toolbar.appendChild(insertBtn);

          // 收起按钮（使用内联 chevron-left SVG）
          const collapseBtn = document.createElement("button");
          collapseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>';
          collapseBtn.setAttribute('aria-label', '收起目录');
          collapseBtn.title = "收起目录";
          collapseBtn.style.background = "transparent";
          collapseBtn.style.color = "var(--ext-toc-fg, var(--fg))";
          collapseBtn.style.border = "none";
          collapseBtn.style.borderRadius = "4px";
          collapseBtn.style.padding = "4px";
          collapseBtn.style.fontSize = "12px";
          collapseBtn.style.cursor = "pointer";
          collapseBtn.style.opacity = "0.7";
          collapseBtn.style.transition = "opacity 120ms ease";
          collapseBtn.onclick = () => {
            setTOCCollapsedMode("manual-collapsed");
            closeSideTOC(ui);
          };
          toolbar.appendChild(collapseBtn);

          // Add hover effects for all buttons
          const buttons = [groupBtn, toggleAllBtn, copyBtn, insertBtn, collapseBtn];
          buttons.forEach(btn => {
            btn.addEventListener('mouseenter', () => {
              btn.style.opacity = '1';
            });
            btn.addEventListener('mouseleave', () => {
              // For group button, keep higher opacity when active
              if (btn === groupBtn && !!window?.zion?.state?.get?.('toc.groupByRole')) {
                btn.style.opacity = '1';
              } else {
                btn.style.opacity = '0.7';
              }
            });
          });

          panel.appendChild(toolbar);

          const list = document.createElement("div");
          list.className = "zion-toc-list";
          list.style.flex = "1";
          list.style.overflowY = "auto";
          list.style.overflowX = "hidden";
          list.style.minHeight = "0";
          list.style.maxWidth = "100%";
          list.style.boxSizing = "border-box";
          panel.appendChild(list);

          // Save refs
          ui.wrapper = wrapper;
          ui.panel = panel;
          ui.button = null;
          ui.editorEl = edEl;
          ui.scrollerEl = edEl.querySelector(".cm-scroller") || edEl;
          ui.prevScrollerMarginLeft = "";
          ui.originalParent = originalParent;
          ui.originalNextSibling = originalNextSibling;
        }
      } catch {}

      // Sync TOC active item with viewport/cursor
      editor.addVisualExtension(ViewPlugin.fromClass(class {
        constructor(view) {
          this.view = view;
          this.scrollHandler = () => {
            try { scheduleComputeActiveTOCByVisibility(this.view, editor); } catch {}
          };
          try {
            view.scrollDOM?.addEventListener?.('scroll', this.scrollHandler, { passive: true });
          } catch {}
          try { scheduleComputeActiveTOCByVisibility(view, editor); } catch {}
        }
        update(u) {
          this.view = u.view;
          try {
            if (u.docChanged || u.viewportChanged || u.selectionSet) {
              scheduleComputeActiveTOCByVisibility(u.view, editor);
            }
          } catch {}
          if (ui.open && ui.panel && (u.docChanged || u.viewportChanged || u.selectionSet)) {
            ui.debouncedUpdate?.();
          }
        }
        destroy() {
          try { this.view?.scrollDOM?.removeEventListener?.('scroll', this.scrollHandler); } catch {}
        }
      }));

      // Keep editor scroller left-aligned when width mode changes while TOC is open
      const widthModeSub = window.zion.state.onDidChange("ui.editorWidthMode", () => {
        if (ui.open) {
          applySideLayout(ui);
        }
      });
      // 监听分组模式状态变化以同步按钮样式与列表
      const groupModeSub = window.zion.state.onDidChange("toc.groupByRole", () => {
        try {
          try { syncGroupBtnUI(ui); } catch {}
          if (ui.open) ui.debouncedUpdate?.();
        } catch {}
      });
      const activeHeadingKey = getActiveHeadingStateKey(ui);
      const activeBlockKey = getActiveBlockStateKey(ui);
      // 点击子目录时的高亮状态变化，触发列表重绘
      const activeHeadingSub = window.zion.state.onDidChange(activeHeadingKey, () => {
        try {
          if (ui.open) ui.debouncedUpdate?.();
        } catch {}
      });
      // 当前块（角色）高亮状态变化，触发列表重绘
      const activeBlockSub = window.zion.state.onDidChange(activeBlockKey, () => {
        try {
          if (ui.open) ui.debouncedUpdate?.();
        } catch {}
      });

      const onResize = () => {
        try {
          const t = document?.documentElement?.dataset?.zionDeviceType;
          if (t === "mobile" || window.innerWidth < 768) {
            try { closeSideTOC(ui); } catch {}
            try { document.getElementById("zion-toc-panel")?.remove?.(); } catch {}
            return;
          }
        } catch {
          // ignore
        }
        syncSideTOCVisibility(ui);
        if (!ui.open) return;
        applySideLayout(ui);
        try {
          if (ui.overlay) closeSideTOC(ui);
        } catch {}
      };
      window.addEventListener("resize", onResize);
      observeTOCContainerResize(ui, onResize);

      // Open TOC side panel by default when auto mode is active and width is sufficient.
      try {
        syncSideTOCVisibility(ui);
      } catch {
        try {
          syncSideTOCVisibility(ui);
        } catch {}
      }

      // Return Disposable to cleanup on extension deactivate/reload
      return {
        dispose() {
          try {
            // Close panel if open and restore editor DOM
            teardownTOCLayout(ui);

            // Dispose subscriptions
            try { widthModeSub?.dispose?.(); } catch {}
            try { groupModeSub?.dispose?.(); } catch {}
            try { activeHeadingSub?.dispose?.(); } catch {}
            try { activeBlockSub?.dispose?.(); } catch {}
            try { ui.resizeObserver?.disconnect?.(); } catch {}
            try { window.removeEventListener("resize", onResize); } catch {}
            ui.resizeObserver = null;
            if (ui.instanceKey) tocInstances.delete(ui.instanceKey);
          } catch {}
        }
      };
    }
  });
  ctx.subscriptions.push(d5);

  // context menu item registered via contributes.menus in manifest,
  // but we ensure command exists even if menus are filtered.
}

export function deactivate() {
  // 清理事件监听
  try {
    if (extensionCtx && extensionCtx.chatEventsCleanup) {
      extensionCtx.chatEventsCleanup();
    }
  } catch {}
}
