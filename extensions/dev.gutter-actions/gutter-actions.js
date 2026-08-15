import { gutter, GutterMarker, ViewPlugin, EditorView } from "@codemirror/view";
import { foldService, foldable } from "@codemirror/language";

function t(key, fallback, values) {
  const fullKey = `dev.gutter-actions.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

/**
 * Copy helpers with fallback
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

let menuGuard = null;

function getRolesIndexForView(view) {
  try {
    const fromApi = window?.zion?.roles?.getIndex?.(view);
    if (fromApi && Array.isArray(fromApi.blocks)) return fromApi;
    const state = window?.zion?.state;
    if (!state?.get) return null;
    const dom = view?.dom || null;
    const editorId = dom?.getAttribute?.("data-editor-id") || "";
    const panelId = dom?.getAttribute?.("data-panel-id") || dom?.closest?.("[data-panel-id]")?.getAttribute?.("data-panel-id") || "";
    const sessionId = dom?.getAttribute?.("data-session-id") || dom?.closest?.("[data-session-id]")?.getAttribute?.("data-session-id") || "";
    const keys = [
      editorId ? `roles.index.editor.${editorId}` : "",
      panelId && sessionId ? `roles.index.panelSession.${panelId}.${sessionId}` : "",
      panelId ? `roles.index.panel.${panelId}` : "",
      "roles.index"
    ].filter(Boolean);
    for (const key of keys) {
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
}

function ensureUserPromptBelow(view, line) {
  try {
    const doc = view.state.doc;
    const currentLineNo = line.number;

    if (currentLineNo < doc.lines) {
      const nextLine = doc.line(currentLineNo + 1);
      const t = String(nextLine.text || "");
      const m = /^\s*user\s+/.exec(t);
      if (m) {
        const pos = nextLine.from + m[0].length;
        view.dispatch({
          selection: { anchor: pos },
          scrollIntoView: true
        });
        return true;
      }

      if (t.trim() === "" && !/^\s*(system|user|assistant|tool)\s+/.test(t)) {
        const insert = "user ";
        view.dispatch({
          changes: { from: nextLine.from, to: nextLine.to, insert },
          selection: { anchor: nextLine.from + insert.length },
          scrollIntoView: true
        });
        return true;
      }
    }

    const pos = line.to;
    const insert = "\nuser ";
    view.dispatch({
      changes: { from: pos, insert },
      selection: { anchor: pos + insert.length },
      scrollIntoView: true
    });
    return true;
  } catch {
    return false;
  }
}

function closeExistingMenu() {
  const m = document.getElementById("zion-gutter-menu");
  if (m) {
    try { m.remove(); } catch {}
  }
  document.removeEventListener("click", onDocClickClose, true);
  document.removeEventListener("keydown", onEscClose, true);
  document.removeEventListener("scroll", onScrollClose, true);
  document.removeEventListener("mousemove", onDocMouseMove, true);
  menuGuard = null;
}
function onDocClickClose(ev) {
  const m = document.getElementById("zion-gutter-menu");
  if (!m) return;
  if (!m.contains(ev.target)) {
    closeExistingMenu();
  }
}
function onEscClose(ev) {
  if (ev.key === "Escape") closeExistingMenu();
}
function onScrollClose() {
  closeExistingMenu();
}
function onDocMouseMove(ev) {
  // Close when moving outside the menu before ever entering it,
  // but only after a short grace period and sufficient movement
  const g = menuGuard;
  if (!g || !g.menuEl) return;
  if (!g.monitorMove) return;
  const rect = g.menuEl.getBoundingClientRect();
  const inside = ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
  if (!inside && !g.enteredMenu) {
    const dx = ev.clientX - g.openAt.x;
    const dy = ev.clientY - g.openAt.y;
    const dist2 = dx * dx + dy * dy;
    if (dist2 > (g.moveThreshold || 400)) {
      closeExistingMenu();
    }
  }
}

/**
 * Compute batch info (accept/revert counts) for a given user message line.
 * Returns null if no pending tool actions are found.
 */
function computeBatchInfoForLine(view, doc, userStartLine, isUserLikeLine) {
  if (!isUserLikeLine) return null;
  const sid = window.zion?.state?.get?.("sessions.currentId");
  const ann = sid ? (window.zion?.commands?.executeCommand?.("zion.chatCards.getSessionAnnotations", sid) || {}) : {};
  const list = Array.isArray(ann.tools) ? ann.tools : [];
  const toolActions = ann && typeof ann.toolActions === "object" ? ann.toolActions : {};

  let range = null;
  try {
    const idx = getRolesIndexForView(view);
    const blocks = Array.isArray(idx?.blocks) ? idx.blocks : [];
    const userIndex = blocks.findIndex(b => b && b.role === "user" && b.startLine === userStartLine);
    if (userIndex >= 0) {
      let assistantIndex = -1;
      for (let i = userIndex + 1; i < blocks.length; i++) {
        if (blocks[i]?.role === "assistant") { assistantIndex = i; break; }
        if (blocks[i]?.role === "user") break;
      }
      if (assistantIndex >= 0) range = { from: blocks[assistantIndex].from, to: blocks[assistantIndex].to };
    }
  } catch {}

  const filesSet = new Set();
  let total = 0;
  let acceptCount = 0;
  let revertCount = 0;

  const matchesUser = (it) => it && it.userStartLine === userStartLine;
  const matchesRange = (it) => range && typeof it.from === "number" && it.from >= range.from && it.to <= range.to;
  const isTargetName = (name) => name === "edit" || name === "write" || name === "fsedit" || name === "fswrite";

  const pickAction = (id, fallback) => {
    const v = id != null ? toolActions[String(id)] : null;
    const a = v?.action || fallback;
    return a === "accept" || a === "revert" ? a : null;
  };

  const matchedByUser = list.filter(it => matchesUser(it) && isTargetName(String(it?.name || "")));
  const candidates = matchedByUser.length ? matchedByUser : list.filter(it => matchesRange(it) && isTargetName(String(it?.name || "")));
  for (const it of candidates) {
    total += 1;
    const path = it.args?.path;
    if (typeof path === "string" && path.trim()) filesSet.add(path);
    const action = pickAction(it.id, it.action);
    if (action === "accept") acceptCount += 1;
    if (action === "revert") revertCount += 1;
  }
  if (!total) return null;
  const state = acceptCount === total ? "accepted" : (revertCount === total ? "reverted" : "mixed");
  return { total, acceptCount, revertCount, files: filesSet.size, userStartLine, range, state };
}

function openMenu(view, clientX, clientY, line) {
  closeExistingMenu();
  const doc = view.state.doc;
  const isUserRoleLine = /^\s*user\s+/.test(line.text || "");
  const isRoleHeader = (t) => /^\s*(system|user|assistant|tool)\s+/.test(String(t || ""));
  const findImplicitUserMarkerLine = () => {
    try {
      let firstRoleLine = null;
      for (let i = 1; i <= doc.lines; i++) {
        const ln = doc.line(i);
        if (isRoleHeader(ln.text)) {
          firstRoleLine = i;
          break;
        }
      }
      const limit = firstRoleLine != null ? firstRoleLine : (doc.lines + 1);
      if (limit <= 1) return null;
      for (let i = 1; i < limit; i++) {
        const ln = doc.line(i);
        if (String(ln.text || "").trim()) return i;
      }
      return 1;
    } catch {
      return null;
    }
  };
  const implicitMarkerLine = findImplicitUserMarkerLine();
  const isImplicitUserLine = !isUserRoleLine && implicitMarkerLine != null && line.number === implicitMarkerLine && !isRoleHeader(line.text);
  const isUserLikeLine = isUserRoleLine || isImplicitUserLine;
  const userStartLine = isImplicitUserLine ? 0 : (line.number - 1);
  try {
    window.zion?.state?.set?.("dev.gutterActions.lastContext", {
      lineNumber: line.number,
      userStartLine,
      at: Date.now()
    });
  } catch {}
  const batch = computeBatchInfoForLine(view, doc, userStartLine, isUserLikeLine);

  // Determine foldable range at this line
  const foldRange = (() => {
    // 0) 角色块优先：如果是角色行，使用 roles.index 的整块范围（包含角色行）
    try {
      const idx = getRolesIndexForView(view);
      if (idx && Array.isArray(idx.blocks)) {
        const ln0 = line.number - 1; // roles.index 使用 0-based 行号
        const blk = idx.blocks.find(b => b.startLine === ln0);
        if (blk && typeof blk.to === 'number') {
          const from = line.from;   // 包含角色行
          const to = blk.to;        // 到该角色块结束
          if (to > from) return { from, to };
        }
      }
    } catch {}

    // 1) 优先用语言包显式折叠区间
    try {
      const fr = foldable(view.state, line.from);
      if (fr && fr.to > fr.from) return fr;
    } catch {}

    // 2) 缩进折叠（列表/段落）回退
    try {
      const doc = view.state.doc;
      const baseIndent = line.text.match(/^(\s*)/)[1].length;
      let to = line.to;
      for (let n = line.number; n <= doc.lines; n++) {
        const ln = doc.line(n);
        if (n === line.number) continue;          // 跳过自己
        const indent = ln.text.match(/^(\s*)/)[1].length;
        if (indent <= baseIndent) break;          // 同级或更浅，结束
        to = ln.to;
      }
      if (to > line.to) return { from: line.from, to };
    } catch {}

    // 2) Markdown 回退：支持标题与围栏代码块的折叠（范围包含当前行）
    try {
      const text = doc.sliceString(line.from, line.to);

      // 2.1 围栏代码块（```lang ... ```）
      const fenceOpen = /^`{3,}/.test(text.trim());
      if (fenceOpen) {
        let pos = line.to + 1;
        while (pos <= doc.length) {
          const ln = doc.lineAt(pos);
          const t = doc.sliceString(ln.from, ln.to).trim();
          if (/^`{3,}\s*$/.test(t)) {
            const from = line.from;      // 包含开围栏所在行
            const to = ln.to;            // 包含闭围栏所在行
            if (to > from) return { from, to };
            break;
          }
          pos = ln.to + 1;
        }
      }

      // 2.2 标题块（从当前标题到下一个同级或更高级标题之前，范围包含标题行）
      const hm = /^(#{1,6})\s/.exec(text);
      if (hm) {
        const level = hm[1].length;
        const from = line.from;  // 包含标题行
        let to = doc.length;
        let pos = line.to + 1;
        while (pos <= doc.length) {
          const ln = doc.lineAt(pos);
          const t = doc.sliceString(ln.from, ln.to);
          const nextHm = /^(#{1,6})\s/.exec(t);
          if (nextHm && nextHm[1].length <= level) {
            to = Math.max(from, ln.from - 1);  // 不包含下一个标题行
            break;
          }
          pos = ln.to + 1;
        }
        if (to > from) return { from, to };
      }
    } catch {}

    // 无可折叠范围
    return null;
  })();

  const menu = document.createElement("div");
  menu.id = "zion-gutter-menu";
  menu.className = "zion-gutter-menu";
  menu.style.position = "fixed";
  menu.style.left = `${clientX + 6}px`;
  menu.style.top = `${clientY + 6}px`;
  // accessibility
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Gutter actions");
  menu.tabIndex = -1;

  // Guard state for movement/hover-driven close behavior
  menuGuard = {
    enteredMenu: false,
    monitorMove: false,            // enable after a short grace so moving from dot to menu won't close it
    openAt: { x: clientX, y: clientY },
    menuEl: menu,
    moveThreshold: 400             // ~20px squared distance (20^2)
  };

  // Track entering/leaving the menu; once entered, leaving closes
  menu.addEventListener('mouseenter', () => {
    if (menuGuard) menuGuard.enteredMenu = true;
  });
  menu.addEventListener('mouseleave', () => {
    if (menuGuard && menuGuard.enteredMenu) {
      closeExistingMenu();
    }
  });

  const mkItem = (label, onClick, disabled = false) => {
    const btn = document.createElement("button");
    btn.className = "zion-gutter-menu-item" + (disabled ? " disabled" : "");
    btn.type = "button";
    btn.textContent = label;
    btn.setAttribute("role", "menuitem");
    if (disabled) {
      btn.setAttribute("aria-disabled", "true");
      btn.tabIndex = -1;
    } else {
      btn.tabIndex = 0;
      // 鼠标移入时自动 focus 到该项
      btn.addEventListener("mouseenter", () => {
        try { btn.focus(); } catch {}
      });
    }
    btn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled) return;
      try {
        await onClick();
      } finally {
        closeExistingMenu();
      }
    };
    return btn;
  };

  menu.appendChild(mkItem(t("menu.insertUserBelow", "下一行插入 user"), () => {
    ensureUserPromptBelow(view, line);
    return Promise.resolve(true);
  }, false));

  // 复制当前行
  const copyLine = () => {
    const text = doc.sliceString(line.from, line.to);
    return copyText(text);
  };
  menu.appendChild(mkItem(t("menu.copyLine", "复制当前行"), copyLine, false));

  // 复制折叠块范围（如果有），范围需包含当前行
  const copyFoldBlock = () => {
    if (!foldRange) return Promise.resolve(false);
    const start = Math.min(line.from, foldRange.from);
    const end = Math.max(start, foldRange.to);
    const text = doc.sliceString(start, end);
    return copyText(text);
  };
  menu.appendChild(mkItem(t("menu.copyFoldBlock", "复制折叠块范围"), copyFoldBlock, !foldRange));

  if (batch) {
    const info = t("menu.batchInfo", "涉及 {total} 处变更，{files} 个文件", { total: batch.total, files: batch.files });
    const acceptLabel = t("menu.batchAccept", "批量接受 ({accepted}/{total})", { accepted: batch.acceptCount, total: batch.total });
    const revertLabel = t("menu.batchRevert", "批量回退 ({reverted}/{total})", { reverted: batch.revertCount, total: batch.total });
    const acceptDisabled = batch.state === "accepted";
    const revertDisabled = batch.state === "reverted";
    menu.appendChild(mkItem(acceptLabel, () => {
      try {
        const panelId = view?.dom?.closest?.("[data-panel-id]")?.getAttribute?.("data-panel-id") || null;
        const sessionId = panelId
          ? (window.zion?.panelManager?.getPanel?.(panelId)?.activeTabId
            || window.zion?.panels?.list?.().find((panel) => panel.id === panelId)?.activeTabId
            || null)
          : (window.zion?.state?.get?.("sessions.currentId") || null);
        window.zion?.events?.emit("toolcards/batchAccept", { userStartLine: batch.userStartLine, from: batch.range?.from, to: batch.range?.to, panelId, sessionId });
      } catch {}
      return Promise.resolve(true);
    }, acceptDisabled));
    menu.appendChild(mkItem(revertLabel, () => {
      try {
        const panelId = view?.dom?.closest?.("[data-panel-id]")?.getAttribute?.("data-panel-id") || null;
        const sessionId = panelId
          ? (window.zion?.panelManager?.getPanel?.(panelId)?.activeTabId
            || window.zion?.panels?.list?.().find((panel) => panel.id === panelId)?.activeTabId
            || null)
          : (window.zion?.state?.get?.("sessions.currentId") || null);
        window.zion?.events?.emit("toolcards/batchRevert", { userStartLine: batch.userStartLine, from: batch.range?.from, to: batch.range?.to, panelId, sessionId });
      } catch {}
      return Promise.resolve(true);
    }, revertDisabled));
    try {
      menu.appendChild(mkItem(info, () => Promise.resolve(true), true));
    } catch {}
  }

  document.body.appendChild(menu);

  // keep menu in viewport
  try {
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) menu.style.left = `${Math.max(4, vw - rect.width - 4)}px`;
    if (rect.bottom > vh) menu.style.top = `${Math.max(4, vh - rect.height - 4)}px`;
  } catch {}

  // keyboard handling for menu: ArrowUp/ArrowDown/Enter/Escape
  const onMenuKeyDown = (ev) => {
    const items = Array.from(menu.querySelectorAll('.zion-gutter-menu-item')).filter(i => !i.classList.contains('disabled'));
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement);
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeExistingMenu();
      return;
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      const next = items[(idx + 1) % items.length] || items[0];
      next.focus();
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      const prev = items[(idx - 1 + items.length) % items.length] || items[items.length - 1];
      prev.focus();
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      if (document.activeElement && document.activeElement.classList.contains('zion-gutter-menu-item') && !document.activeElement.classList.contains('disabled')) {
        ev.preventDefault();
        document.activeElement.click();
      }
      return;
    }
  };
  menu.addEventListener('keydown', onMenuKeyDown);

  // focus first enabled item for keyboard users
  setTimeout(() => {
    const first = menu.querySelector('.zion-gutter-menu-item:not(.disabled)');
    try { first && first.focus(); } catch {}
  }, 0);

  // install global closers
  setTimeout(() => {
    document.addEventListener("click", onDocClickClose, true);
    document.addEventListener("keydown", onEscClose, true);
    document.addEventListener("scroll", onScrollClose, true);
    document.addEventListener("mousemove", onDocMouseMove, true);
    // Enable movement guard after a short grace so pointer can travel from dot to menu
    setTimeout(() => { if (menuGuard) menuGuard.monitorMove = true; }, 160);
  }, 0);
}

/**
 * A simple dot marker shown for each line in a custom gutter.
 * The dot is only visible on hover (CSS), clicking opens a small menu.
 */
class DotMarker extends GutterMarker {
  toDOM(view) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "zion-gutter-dot";
    btn.title = t("ui.lineActions", "行操作（Shift-点击：下一行插入 user）");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Determine target line using coords
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return;
      const line = view.state.doc.lineAt(pos);

      if (e.shiftKey) {
        closeExistingMenu();
        ensureUserPromptBelow(view, line);
        try { view.focus(); } catch {}
        return;
      }

      openMenu(view, e.clientX, e.clientY, line);
    });
    return btn;
  }
}

class UserDotMarker extends DotMarker {
  toDOM(view) {
    const btn = super.toDOM(view);
    btn.classList.add("zion-gutter-dot-persistent");
    btn.title = t("ui.userMessage", "User message");
    return btn;
  }
}

const dotMarker = new DotMarker();
const userDotMarker = new UserDotMarker();

// Hover sync plugin: when hovering any gutter (fold/line numbers/etc.), highlight the corresponding
// left custom gutter row to show the dot for that line.
const hoverGutterPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.hoverEl = null;
    this.gutters = view.dom.querySelector(".cm-gutters");
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseLeave = this.onMouseLeave.bind(this);
    if (this.gutters) {
      this.gutters.addEventListener("mousemove", this.onMouseMove);
      this.gutters.addEventListener("mouseleave", this.onMouseLeave);
    }
  }

  setHoverEl(el) {
    if (this.hoverEl === el) return;
    if (this.hoverEl) try { this.hoverEl.classList.remove("zion-hover"); } catch {}
    this.hoverEl = el || null;
    if (this.hoverEl) try { this.hoverEl.classList.add("zion-hover"); } catch {}
  }

  onMouseMove(e) {
    const leftG = this.view.dom.querySelector(".cm-gutter.zion-gutter-left");
    if (!leftG) { this.setHoverEl(null); return; }
    const rect = leftG.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) { this.setHoverEl(null); return; }
    // Probe the left custom gutter row at the current Y via elementFromPoint
    const x = rect.left + rect.width / 2;
    const el = document.elementFromPoint(x, e.clientY);
    if (!el || !leftG.contains(el)) { this.setHoverEl(null); return; }
    const row = el.closest(".cm-gutterElement");
    this.setHoverEl(row);
  }

  onMouseLeave() {
    this.setHoverEl(null);
  }

  update(update) {
    // if the currently marked row gets detached, clear it
    if (this.hoverEl && !document.body.contains(this.hoverEl)) {
      this.hoverEl = null;
    }
  }

  destroy() {
    if (this.gutters) {
      this.gutters.removeEventListener("mousemove", this.onMouseMove);
      this.gutters.removeEventListener("mouseleave", this.onMouseLeave);
    }
    this.setHoverEl(null);
  }
});

// Scrollbar markers for user messages
const scrollbarMarkersPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.container = document.createElement("div");
    this.container.className = "zion-scrollbar-markers";
    // Append to editor dom so it sits on top of scroller or inside the wrapper
    view.dom.appendChild(this.container);
    this.rafId = 0;
    this.updateTimer = 0;
    this.tooltip = null;
    this.updateMarkers();
  }

  update(update) {
    if (update.docChanged) {
      this.scheduleUpdateMarkers();
    } else if ((update.geometryChanged || update.viewportChanged) && !this.updateTimer) {
      this.updateMarkers();
    }
  }

  destroy() {
    this.container.remove();
    this.hideTooltip();
    if (this.rafId) window.cancelAnimationFrame(this.rafId);
    if (this.updateTimer) window.clearTimeout(this.updateTimer);
  }

  hideTooltip() {
    if (this.tooltip) {
      this.tooltip.remove();
      this.tooltip = null;
    }
  }

  showTooltip(content, x, y) {
    this.hideTooltip();
    const tooltip = document.createElement("div");
    tooltip.className = "zion-scrollbar-tooltip";
    tooltip.textContent = content;
    tooltip.style.position = "fixed";
    tooltip.style.top = `${y}px`;
    document.body.appendChild(tooltip);
    this.tooltip = tooltip;
    
    // Position to the left of the scrollbar dynamically
    const rect = tooltip.getBoundingClientRect();
    tooltip.style.left = `${x - rect.width - 12}px`;
    
    // Trigger reflow
    tooltip.offsetHeight;
    tooltip.classList.add("visible");

    // Auto hide on scroll/click, but keep while hovering tooltip
    // We removed the 2s timeout so it stays as long as you hover
    const hide = () => this.hideTooltip();
    
    // Only hide on actual scroll or click outside
    this.view.dom.addEventListener("scroll", hide, { once: true });
    
    // Clicking outside hides it immediately
    const onClick = (e) => {
      if (this.tooltip && !this.tooltip.contains(e.target)) {
        hide();
        document.removeEventListener("click", onClick);
      }
    };
    setTimeout(() => document.addEventListener("click", onClick), 0);
  }

  scheduleUpdateMarkers() {
    if (this.updateTimer) window.clearTimeout(this.updateTimer);
    this.updateTimer = window.setTimeout(() => {
      this.updateTimer = 0;
      this.updateMarkers();
    }, 120);
  }

  updateMarkers() {
    if (this.updateTimer) {
      window.clearTimeout(this.updateTimer);
      this.updateTimer = 0;
    }
    if (this.rafId) window.cancelAnimationFrame(this.rafId);
    this.rafId = window.requestAnimationFrame(() => {
      if (!this.view.dom.contains(this.container)) {
        this.view.dom.appendChild(this.container);
      }
      this.container.innerHTML = "";
      const view = this.view;
      const doc = view.state.doc;
      const totalHeight = view.contentHeight;
      if (totalHeight <= 0) return;

      const lines = doc.lines;
      const fragment = document.createDocumentFragment();
      
      // Store user line info for click/hover handlers
      const userLines = [];
      
      // Iterate all lines to find user messages
      for (let i = 1; i <= lines; i++) {
        const line = doc.line(i);
        // Check for user role pattern
        if (/^\s*user\s+/.test(line.text)) {
          const block = view.lineBlockAt(line.from);
          const top = block.top;
          const pct = (top / totalHeight) * 100;
          
          // Extract preview text (first 50 chars after "user ")
          let previewText = line.text.replace(/^\s*user\s*/, "").trim();
          if (!previewText) {
             // Look ahead up to 5 lines for content
             for (let j = 1; j <= 5 && i + j <= lines; j++) {
               const nextLine = doc.line(i + j);
               const t = nextLine.text.trim();
               if (t) {
                 previewText = t;
                 break;
               }
             }
          }
          const preview = (previewText.slice(0, 50) || "User message") + (previewText.length > 50 ? "..." : "");
          
          const m = document.createElement("div");
          m.className = "zion-scrollbar-marker";
          m.style.top = `${pct}%`;
          m.style.cursor = "pointer";
          m.style.pointerEvents = "auto";
          
          // Store line info for click handler
          m.dataset.lineNumber = i;
          m.dataset.preview = preview;
          
          // Click to jump to line
          m.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const lineNum = parseInt(m.dataset.lineNumber, 10);
            const targetLine = doc.line(lineNum);
            try {
              const pos = targetLine.from;
              let stickyHeight = 0;
              try {
                const sticky = view.dom?.querySelector?.(".zion-cm-sticky-user-header:not(.is-empty)") ||
                  document.querySelector(".zion-cm-sticky-user-header:not(.is-empty)");
                stickyHeight = sticky?.offsetHeight || 0;
              } catch {}
              const yMargin = Math.max(48, (stickyHeight || 0) + 10);
              view.dispatch({
                selection: { anchor: pos },
                effects: EditorView.scrollIntoView(pos, { y: "start", yMargin })
              });
              requestAnimationFrame(() => {
                try {
                  let stickyHeight2 = 0;
                  try {
                    const sticky2 = view.dom?.querySelector?.(".zion-cm-sticky-user-header:not(.is-empty)") ||
                      document.querySelector(".zion-cm-sticky-user-header:not(.is-empty)");
                    stickyHeight2 = sticky2?.offsetHeight || 0;
                  } catch {}
                  const yMargin2 = Math.max(48, (stickyHeight2 || 0) + 10);
                  view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: yMargin2 }) });
                } catch {}
              });
              view.focus();
            } catch {}
          });
          
          // Hover to show preview
          m.addEventListener("mouseenter", (e) => {
            this.showTooltip(m.dataset.preview, e.clientX, e.clientY);
          });
          
          m.addEventListener("mouseleave", () => {
            this.hideTooltip();
          });
          
          fragment.appendChild(m);
        }
      }
      this.container.appendChild(fragment);
    });
  }
});

export function gutterActions() {
  return [
    gutter({
      class: "zion-gutter-left",
      // show a dot on every line, persistent for user lines
      lineMarker: (view, line) => {
        const doc = view.state.doc;
        const lineNo = doc.lineAt(line.from).number;
        // Check text content of the line
        const text = doc.sliceString(line.from, Math.min(line.to, line.from + 100));
        if (/^\s*user\s+/.test(text)) {
          return userDotMarker;
        }
        try {
          const isRoleHeader = (t) => /^\s*(system|user|assistant|tool)\s+/.test(String(t || ""));
          let firstRoleLine = null;
          for (let i = 1; i <= doc.lines; i++) {
            const ln = doc.line(i);
            if (isRoleHeader(ln.text)) {
              firstRoleLine = i;
              break;
            }
          }
          const limit = firstRoleLine != null ? firstRoleLine : (doc.lines + 1);
          if (limit > 1 && !isRoleHeader(text)) {
            let markerLine = null;
            for (let i = 1; i < limit; i++) {
              const ln = doc.line(i);
              if (String(ln.text || "").trim()) { markerLine = i; break; }
            }
            if (markerLine == null) markerLine = 1;
            if (lineNo === markerLine) return userDotMarker;
          }
        } catch {}
        return dotMarker;
      },
      initialSpacer: () => {
        // keep consistent width in empty docs
        const s = document.createElement("div");
        s.style.width = "14px";
        s.style.height = "1em";
        return s;
      }
    }),
    hoverGutterPlugin,
    scrollbarMarkersPlugin
  ];
}
