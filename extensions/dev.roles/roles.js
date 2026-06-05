import { Prec, RangeSetBuilder } from "@codemirror/state";
import { Decoration, ViewPlugin, keymap, gutter, GutterMarker } from "@codemirror/view";
import { foldService } from "@codemirror/language";

/**
 * Roles plugin (standalone, used by dev.roles extension):
 * - Detect lines starting with "user ", "assistant ", "system "
 * - Style the role token at line start with a capsule tag
 * - Apply a special background to configurable block roles (default: "user")
 * - Independent of WYSIWYG: always active
 */

// 默认内置角色
const BASE_ROLE_PREFIXES = ["user", "assistant", "system"];

/**
 * 从环境读取自定义角色前缀：
 * - window.zion.config.roles.prefixes: 数组
 * - localStorage: 'zion.roles.prefixes' 或 'dev.roles.prefixes'，内容为 JSON 数组
 */
function readCustomPrefixesFromEnv() {
  const out = [];
  try {
    const cfg = window?.zion?.config?.roles?.prefixes;
    if (Array.isArray(cfg)) out.push(...cfg);
  } catch {}
  try {
    const raw = localStorage.getItem("zion.roles.prefixes") || localStorage.getItem("dev.roles.prefixes");
    if (raw) {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) out.push(...j);
    }
  } catch {}
  return normalizePrefixes(out);
}

/**
 * 从环境读取需要块级高亮的角色列表：
 * - window.zion.config.roles.highlightBlockRoles: 数组
 * - localStorage: 'zion.roles.highlightBlockRoles' 或 'dev.roles.highlightBlockRoles'，内容为 JSON 数组
 */
function readHighlightBlockRolesFromEnv() {
  const out = [];
  try {
    const cfg = window?.zion?.config?.roles?.highlightBlockRoles;
    if (Array.isArray(cfg)) out.push(...cfg);
  } catch {}
  try {
    const raw = localStorage.getItem("zion.roles.highlightBlockRoles") || localStorage.getItem("dev.roles.highlightBlockRoles");
    if (raw) {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) out.push(...j);
    }
  } catch {}
  return normalizePrefixes(out);
}

/** 规范化 + 去重 */
function normalizePrefixes(list) {
  const out = [];
  const seen = new Set();
  for (const r of list || []) {
    if (typeof r === "string") {
      const rr = r.trim();
      if (rr && !seen.has(rr)) {
        seen.add(rr);
        out.push(rr);
      }
    }
  }
  return out;
}

/** 计算有效角色前缀：内置 + 传入 + 环境 */
function getEffectivePrefixes(opts) {
  const extra = Array.isArray(opts?.prefixes) ? opts.prefixes : [];
  return normalizePrefixes([...BASE_ROLE_PREFIXES, ...extra, ...readCustomPrefixesFromEnv()]);
}

/** 计算需要块级高亮的角色（默认 ["user"]，可被配置覆盖） */
function getHighlightBlockRoles(opts) {
  const fromEnv = readHighlightBlockRolesFromEnv();
  let list = Array.isArray(opts?.highlightBlockRoles) ? opts.highlightBlockRoles : fromEnv;
  list = Array.isArray(list) && list.length ? list : ["user"];
  return normalizePrefixes(list);
}

/** @param {string} text @param {string[]} prefixes */
function getRoleForLine(text, prefixes) {
  const t = text || "";
  for (const r of prefixes) {
    if (t.startsWith(r + " ")) return r;
  }
  return null;
}

/** @param {string} role */
function tokenClass(role) {
  // 根据 TOC 插件中的颜色方案返回对应的类名
  // user: '#4caf50' (绿色), assistant: '#2196f3' (蓝色), system: '#9e9e9e' (灰色)
  if (role === 'assistant') return "cm-role-token-assistant";
  if (role === 'system') return "cm-role-token-system";
  return "cm-role-token-user"; // 默认为 user
}

function blockClass(role) {
  const r = typeof role === "string" ? role : "";
  const safe = r.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || "user";
  return `cm-role-block cm-role-block-${safe}`;
}

const ROLES_NAV_FLASH_EVENT = "zion:roles-nav-flash";

function flashRoleNavLine(view, lineIndex) {
  if (!view || typeof lineIndex !== "number" || lineIndex < 0) return;
  try {
    window.dispatchEvent(new CustomEvent(ROLES_NAV_FLASH_EVENT, {
      detail: { view, lineIndex }
    }));
  } catch {}
}

/** @param {import('@codemirror/view').EditorView} view @param {string[]} prefixes @param {string[]} highlightBlockRoles @param {RegExp|null} atRegex */
function buildDecorations(view, prefixes, highlightBlockRoles, atRegex, flashLineIndex = null, flashSerial = 0) {
  const doc = view.state.doc;
  const builder = new RangeSetBuilder();

  /** @type {string|null} */
  let currentRole = null;

  // 性能优化：仅遍历当前视口范围内的行，避免对整个文档进行全量扫描
  let pos = Math.max(1, view.viewport.from);
  const endPos = view.viewport.to;

  try {
    const startLine0 = doc.lineAt(pos).number - 1;
    const idx = window?.zion?.state?.get?.("roles.index");
    const blocks = Array.isArray(idx?.blocks) ? idx.blocks : null;
    const idxPrefixes = Array.isArray(idx?.prefixes) ? idx.prefixes : null;
    if (blocks && idxPrefixes && idxPrefixes.join("\n") === prefixes.join("\n")) {
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (!b) continue;
        const s = typeof b.startLine === "number" ? b.startLine : null;
        const e = typeof b.endLine === "number" ? b.endLine : null;
        if (s == null || e == null) continue;
        if (startLine0 >= s && startLine0 <= e) {
          currentRole = typeof b.role === "string" ? b.role : null;
          break;
        }
      }
    } else {
      let scanPos = doc.lineAt(pos).from;
      for (let k = 0; k < 200 && scanPos > 1; k++) {
        const prevLine = doc.lineAt(Math.max(1, scanPos - 1));
        const prevText = doc.sliceString(prevLine.from, prevLine.to);
        const r = getRoleForLine(prevText, prefixes);
        if (r) {
          currentRole = r;
          break;
        }
        scanPos = prevLine.from;
      }
    }
  } catch {}

  while (pos <= endPos) {
    const line = doc.lineAt(pos);
    const text = doc.sliceString(line.from, line.to);
    const roleHere = getRoleForLine(text, prefixes);

    if (roleHere) {
      // 开启新块
      currentRole = roleHere;
    }

    const inBlock = !!(currentRole && highlightBlockRoles.includes(currentRole));
    const shouldStart = !!(roleHere && inBlock);
    let shouldEnd = false;
    if (inBlock) {
      const nextPos = line.to + 1;
      if (nextPos > doc.length) {
        shouldEnd = true;
      } else if (nextPos <= endPos) {
        try {
          const nextLine = doc.lineAt(nextPos);
          const nextText = doc.sliceString(nextLine.from, nextLine.to);
          const nextRole = getRoleForLine(nextText, prefixes);
          if (nextRole) shouldEnd = true;
        } catch {}
      }
    }

    // 同一位置先添加 line，再添加 mark，避免 RangeSetBuilder 顺序问题
    if (inBlock) {
      let cls = blockClass(currentRole);
      if (shouldStart) cls += " cm-role-block-start";
      if (shouldEnd) cls += " cm-role-block-end";
      if (line.number - 1 === flashLineIndex) {
        cls += ` cm-role-nav-flash cm-role-nav-flash-${flashSerial % 2 ? "b" : "a"}`;
      }
      builder.add(line.from, line.from, Decoration.line({ class: cls }));
    }

    if (roleHere) {
      // 标记角色前缀为胶囊样式（仅角色词本身，不包含空格）
      // 行首角色 token 额外加 cm-role-token-head
      const tokenLen = roleHere.length;
      builder.add(
        line.from,
        line.from + tokenLen,
        Decoration.mark({ class: tokenClass(roleHere) + " cm-role-token-head" })
      );
    }

    // 如果提供了 @role 正则，则在当前行内查找所有内联 @role 并标记（支持自定义前缀）
    if (atRegex) {
      atRegex.lastIndex = 0;
      let m;
      while ((m = atRegex.exec(text)) !== null) {
        // m[0] 包含整个匹配，比如 "@user"
        const full = m[0];
        const roleName = full.slice(1); // 去掉 '@'
        // double-check roleName 在前缀列表中（防止意外匹配）
        if (prefixes.includes(roleName)) {
          const from = line.from + m.index;
          const to = from + full.length;
          // 内联 @role 只加角色 token class，不加 head
          builder.add(from, to, Decoration.mark({ class: tokenClass(roleName) }));
        }
        // 为了避免无限循环（但使用全局正则已正常前进），继续下一次
      }
    }

    pos = line.to + 1;
  }

  return builder.finish();
}

/** Build roles index (blocks ranges) for other extensions via StateBus */
function buildRolesIndexFromState(state, prefixes) {
  try {
    const doc = state.doc;
    const blocks = [];
    let current = null;
    let firstRoleLine0 = null;
    let firstRoleFrom = null;

    for (let pos = 1; pos <= doc.length;) {
      const line = doc.lineAt(pos);
      const text = doc.sliceString(line.from, line.to);
      const roleHere = getRoleForLine(text, prefixes);

      if (roleHere) {
        if (firstRoleLine0 == null) {
          firstRoleLine0 = line.number - 1;
          firstRoleFrom = line.from;
        }
        // finish previous block
        if (current) {
          current.to = doc.lineAt(current.endPos).to;
          current.endLine = doc.lineAt(current.endPos).number - 1;
          blocks.push(current);
          current = null;
        }
        const tokenLen = roleHere.length;
        const contentStart = Math.min(line.to, line.from + tokenLen + 1); // skip "role "
        current = {
          role: roleHere,
          startLine: line.number - 1,
          from: contentStart,
          startPos: contentStart,
          endPos: contentStart,
          preview: ''
        };
        const rem = doc.sliceString(contentStart, line.to).trim();
        if (rem) current.preview = rem.slice(0, 160);
      } else if (current) {
        // extend current block
        current.endPos = line.to;
        if (!current.preview) {
          const t = doc.sliceString(line.from, line.to).trim();
          if (t) current.preview = t.slice(0, 160);
        }
      }

      pos = line.to + 1;
    }

    if (!blocks.length && !current) {
      const only = doc.toString().trim();
      if (only) {
        blocks.push({
          role: "user",
          startLine: 0,
          from: 0,
          startPos: 0,
          endPos: doc.length,
          to: doc.length,
          endLine: doc.lines - 1,
          preview: only.slice(0, 160),
          implicit: true
        });
      }
    } else if (firstRoleLine0 != null && firstRoleLine0 > 0 && typeof firstRoleFrom === "number" && firstRoleFrom > 0) {
      const headText = doc.sliceString(0, firstRoleFrom).trim();
      if (headText) {
        const preview = (() => {
          for (let i = 1; i <= doc.lines; i++) {
            const ln = doc.line(i);
            if (ln.to >= firstRoleFrom) break;
            const t = ln.text.trim();
            if (t) return t.slice(0, 160);
          }
          return headText.slice(0, 160);
        })();
        blocks.unshift({
          role: "user",
          startLine: 0,
          from: 0,
          startPos: 0,
          endPos: Math.max(0, firstRoleFrom - 1),
          to: Math.max(0, firstRoleFrom - 1),
          endLine: Math.max(0, firstRoleLine0 - 1),
          preview,
          implicit: true
        });
      }
    }

    if (current) {
      current.to = doc.lineAt(current.endPos).to;
      current.endLine = doc.lineAt(current.endPos).number - 1;
      blocks.push(current);
    }

    const index = { prefixes, blocks, updatedAt: Date.now() };
    window?.zion?.state?.set?.('roles.index', index);
    return index;
  } catch {
    return null;
  }
}

class RoleRailMarker extends GutterMarker {
  constructor(role) {
    super();
    this.role = role;
  }
  toDOM() {
    const div = document.createElement("div");
    div.className = `zion-role-rail zion-role-rail-${this.role}`;
    return div;
  }
}

const userRailMarker = new RoleRailMarker("user");

function rolesRailGutter(prefixes, highlightBlockRoles) {
  return gutter({
    class: "zion-gutter-role-rail",
    lineMarker: (view, line) => {
      try {
        const lineNo = view.state.doc.lineAt(line.from).number - 1;
        const idx = window?.zion?.state?.get?.("roles.index");
        const blocks = Array.isArray(idx?.blocks) ? idx.blocks : null;
        if (blocks) {
          for (let i = blocks.length - 1; i >= 0; i--) {
            const b = blocks[i];
            if (!b) continue;
            const s = typeof b.startLine === "number" ? b.startLine : null;
            const e = typeof b.endLine === "number" ? b.endLine : null;
            if (s == null || e == null) continue;
            if (lineNo >= s && lineNo <= e) {
              if (b.role === "user") return userRailMarker;
              break;
            }
          }
          return null;
        }
        let scanPos = line.from;
        let currentRole = null;
        for (let k = 0; k < 800 && scanPos > 1; k++) {
          const prevLine = view.state.doc.lineAt(Math.max(1, scanPos - 1));
          const r = getRoleForLine(prevLine.text, prefixes);
          if (r) { currentRole = r; break; }
          scanPos = prevLine.from;
        }
        if (!currentRole) currentRole = "user";
        if (currentRole === "user") return userRailMarker;
      } catch {}
      return null;
    }
  });
}

function rolesView(opts = {}) {
  const prefixes = getEffectivePrefixes(opts);
  const highlightBlockRoles = getHighlightBlockRoles(opts);

  // 构建一次用于查找内联 @role 的正则，避免在每次更新时重复构造
  const makeAtRegex = (prs) => {
    if (!Array.isArray(prs) || prs.length === 0) return null;
    // 对前缀做转义后用非捕获分组构造正则，例如 /@(?:user|assistant)\b/g
    const esc = prs.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`@(?:${esc.join("|")})\\b`, "g");
  };
  const atRegex = makeAtRegex(prefixes);

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.flashLineIndex = null;
        this.flashSerial = 0;
        this.flashTimer = 0;
        this.onFlash = (event) => {
          const detail = event?.detail || {};
          if (detail.view !== this.view) return;
          if (typeof detail.lineIndex !== "number" || detail.lineIndex < 0) return;
          this.flashLineIndex = detail.lineIndex;
          this.flashSerial += 1;
          if (this.flashTimer) window.clearTimeout(this.flashTimer);
          this.decorations = buildDecorations(this.view, prefixes, highlightBlockRoles, atRegex, this.flashLineIndex, this.flashSerial);
          try {
            this.view.dispatch({});
          } catch {}
          this.flashTimer = window.setTimeout(() => {
            this.flashLineIndex = null;
            this.decorations = buildDecorations(this.view, prefixes, highlightBlockRoles, atRegex, null, this.flashSerial);
            try {
              this.view.dispatch({});
            } catch {}
          }, 900);
        };
        try { window.addEventListener(ROLES_NAV_FLASH_EVENT, this.onFlash); } catch {}
        this.decorations = buildDecorations(view, prefixes, highlightBlockRoles, atRegex, this.flashLineIndex, this.flashSerial);
        try { buildRolesIndexFromState(view.state, prefixes); } catch {}
      }
      update(update) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, prefixes, highlightBlockRoles, atRegex, this.flashLineIndex, this.flashSerial);
        }
        if (update.docChanged) {
          try { buildRolesIndexFromState(update.view.state, prefixes); } catch {}
        }
      }
      destroy() {
        try { window.removeEventListener(ROLES_NAV_FLASH_EVENT, this.onFlash); } catch {}
        if (this.flashTimer) {
          try { window.clearTimeout(this.flashTimer); } catch {}
          this.flashTimer = 0;
        }
      }
    },
    {
      decorations: v => v.decorations
    }
  );
}

/**
 * 可选参数：
 * - prefixes: string[] 额外角色前缀（与内置 + 环境来源合并）
 * - highlightBlockRoles: string[] 需要块级背景的角色（默认 ["user"]）
 */
export function roles(opts = {}) {
  const prefixes = getEffectivePrefixes(opts);

  const isMacLike = (() => {
    try {
      const p = String(globalThis?.navigator?.platform || "");
      const ua = String(globalThis?.navigator?.userAgent || "");
      return /Mac|iPhone|iPad|iPod/i.test(p) || /Mac\s*OS\s*X|Macintosh|iPhone|iPad|iPod/i.test(ua);
    } catch {
      return false;
    }
  })();

  const jumpToPos = (view, pos, flashLineIndex = null) => {
    const p = Math.max(0, Math.min(view.state.doc.length, pos));
    view.dispatch({
      selection: { anchor: p },
      scrollIntoView: true
    });
    if (typeof flashLineIndex === "number") flashRoleNavLine(view, flashLineIndex);
    return true;
  };

  const getRolesBlocksFromIndex = () => {
    const idx = window?.zion?.state?.get?.("roles.index");
    if (!idx || !Array.isArray(idx.blocks) || !Array.isArray(idx.prefixes)) return null;
    if (idx.prefixes.join("\n") !== prefixes.join("\n")) return null;
    return idx.blocks.filter(b => b && b.role === "user");
  };

  const computeNav = (view, blocks) => {
    const head = view.state.selection.main.head;
    const curLine0 = view.state.doc.lineAt(head).number - 1;

    let nextIndex = blocks.findIndex(b => typeof b?.startLine === "number" && b.startLine > curLine0);
    if (nextIndex === -1) nextIndex = blocks.length;
    const prevIndex = nextIndex - 1;

    const inside =
      prevIndex >= 0 &&
      typeof blocks[prevIndex]?.startLine === "number" &&
      typeof blocks[prevIndex]?.endLine === "number" &&
      curLine0 >= blocks[prevIndex].startLine &&
      curLine0 <= blocks[prevIndex].endLine;

    const currentIndex = inside ? prevIndex : null;
    const currentStartLine = inside ? blocks[currentIndex].startLine : null;
    return { curLine0, nextIndex, prevIndex, inside, currentIndex, currentStartLine };
  };

  const setSelectionToPos = (view, pos, flashLineIndex = null) => {
    const p = Math.max(0, Math.min(view.state.doc.length, pos));
    const main = view.state.selection.main;
    view.dispatch({
      selection: { anchor: main.anchor, head: p },
      scrollIntoView: true
    });
    if (typeof flashLineIndex === "number") flashRoleNavLine(view, flashLineIndex);
    return true;
  };

  const jumpToPrevRole = (view) => {
    const blocks = getRolesBlocksFromIndex();
    if (!blocks || blocks.length === 0) return jumpToPos(view, 0);
    const nav = computeNav(view, blocks);

    if (nav.inside && nav.curLine0 !== nav.currentStartLine) {
      return jumpToPos(view, view.state.doc.line(nav.currentStartLine + 1).from, nav.currentStartLine);
    }

    const targetIndex = nav.inside ? nav.currentIndex - 1 : nav.prevIndex;
    if (targetIndex < 0) return jumpToPos(view, 0);
    const line0 = blocks[targetIndex].startLine;
    return jumpToPos(view, view.state.doc.line(line0 + 1).from, line0);
  };

  const selectToPrevRole = (view) => {
    const blocks = getRolesBlocksFromIndex();
    if (!blocks || blocks.length === 0) return setSelectionToPos(view, 0);
    const nav = computeNav(view, blocks);

    if (nav.inside && nav.curLine0 !== nav.currentStartLine) {
      return setSelectionToPos(view, view.state.doc.line(nav.currentStartLine + 1).from, nav.currentStartLine);
    }

    const targetIndex = nav.inside ? nav.currentIndex - 1 : nav.prevIndex;
    if (targetIndex < 0) return setSelectionToPos(view, 0);
    const line0 = blocks[targetIndex].startLine;
    return setSelectionToPos(view, view.state.doc.line(line0 + 1).from, line0);
  };

  const jumpToNextRole = (view) => {
    const blocks = getRolesBlocksFromIndex();
    if (!blocks || blocks.length === 0) return jumpToPos(view, view.state.doc.length);
    const nav = computeNav(view, blocks);

    if (nav.nextIndex >= blocks.length) {
      return jumpToPos(view, view.state.doc.length);
    }

    if (nav.inside && nav.curLine0 !== nav.currentStartLine) {
      return jumpToPos(view, view.state.doc.line(nav.currentStartLine + 1).from, nav.currentStartLine);
    }

    const targetIndex = nav.nextIndex;
    if (targetIndex >= blocks.length) return jumpToPos(view, view.state.doc.length);
    const line0 = blocks[targetIndex].startLine;
    return jumpToPos(view, view.state.doc.line(line0 + 1).from, line0);
  };

  const selectToNextRole = (view) => {
    const blocks = getRolesBlocksFromIndex();
    if (!blocks || blocks.length === 0) return setSelectionToPos(view, view.state.doc.length);
    const nav = computeNav(view, blocks);

    if (nav.nextIndex >= blocks.length) {
      return setSelectionToPos(view, view.state.doc.length);
    }

    if (nav.inside && nav.curLine0 !== nav.currentStartLine) {
      return setSelectionToPos(view, view.state.doc.line(nav.currentStartLine + 1).from, nav.currentStartLine);
    }

    const targetIndex = nav.nextIndex;
    if (targetIndex >= blocks.length) return setSelectionToPos(view, view.state.doc.length);
    const line0 = blocks[targetIndex].startLine;
    return setSelectionToPos(view, view.state.doc.line(line0 + 1).from, line0);
  };

  const navBindings = [];

  if (isMacLike) {
    navBindings.push(
      { key: "Alt-ArrowUp", run: jumpToPrevRole },
      { key: "Alt-ArrowDown", run: jumpToNextRole },
      { key: "Alt-Shift-ArrowUp", run: selectToPrevRole },
      { key: "Alt-Shift-ArrowDown", run: selectToNextRole }
    );
  } else {
    navBindings.push(
      { key: "Mod-ArrowUp", run: jumpToPrevRole },
      { key: "Mod-ArrowDown", run: jumpToNextRole },
      { key: "Mod-Shift-ArrowUp", run: selectToPrevRole },
      { key: "Mod-Shift-ArrowDown", run: selectToNextRole }
    );
  }

  const navKeymap = Prec.highest(keymap.of(navBindings));

  // 自定义折叠：当行首是角色前缀时，折叠该行后的区块直到下一个角色行（或文档末尾）
  const foldExt = foldService.of((state, start) => {
    try {
      const doc = state.doc;
      const line = doc.lineAt(start);
      const text = doc.sliceString(line.from, line.to);
      const roleHere = getRoleForLine(text, prefixes);
      if (!roleHere) return null;

      // 从该行行尾开始折叠
      const from = line.to;
      let to = doc.length;

      // 查找下一个角色行的起始位置
      let pos = line.to + 1;
      while (pos <= doc.length) {
        const ln = doc.lineAt(pos);
        const t = doc.sliceString(ln.from, ln.to);
        const nextRole = getRoleForLine(t, prefixes);
        if (nextRole) {
          // 折叠到下一角色行的前一位置，保留下一角色行可见
          to = Math.max(from, ln.from - 1);
          break;
        }
        pos = ln.to + 1;
      }

      // 若没有内容可折叠则返回 null
      if (to <= from) return null;
      return { from, to };
    } catch {
      return null;
    }
  });

  return [rolesView(opts), rolesRailGutter(prefixes, getHighlightBlockRoles(opts)), navKeymap, foldExt];
}
