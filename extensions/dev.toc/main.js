/**
 * dev.toc - Markdown Table of Contents extension
 * Features:
 * - Command: toc.show -> open TOC overlay with clickable headings
 * - Command: toc.insert -> insert Markdown TOC list at cursor
 * - Keybinding: Mod-Shift-T -> open TOC
 * - StatusBar button "TOC"
 * - Editor context menu item "Table of Contents"
 */
import { syntaxTree } from "@codemirror/language";
import { ViewPlugin } from "@codemirror/view";

export async function activate(ctx) {
  // Inject TOC scrollbar hiding style (WebKit + Firefox + IE) to hide vertical scrollbar in TOC area
  try {
    if (!document.getElementById('zion-toc-scrollbar-style')) {
      const style = document.createElement('style');
      style.id = 'zion-toc-scrollbar-style';
      style.textContent = `
#zion-toc-sidepanel, #zion-toc-list, #zion-toc-panel { -ms-overflow-style: none; scrollbar-width: none; }
#zion-toc-sidepanel::-webkit-scrollbar, #zion-toc-list::-webkit-scrollbar, #zion-toc-panel::-webkit-scrollbar { display: none; width: 0; height: 0; }
      `;
      document.head.appendChild(style);
    }
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

  // Fallback: parse headings from raw text (line-by-line)
  const parseHeadingsFromText = (text) => {
    const lines = text.split(/\r?\n/);
    const headings = [];
    const re = /^(#{1,6})\s+(.+)\s*$/;
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const level = m[1].length;
      const title = cleanTitle(m[2].trim());
      headings.push({ level, title, line: i });
    }
    return headings;
  };

  // Preferred: parse headings from CodeMirror syntax tree when editor view is available.
  // Returns {level, title, line} with line being 0-based (compatible with EditorProxy.setCursor).
  const parseHeadingsFromView = (view) => {
    const headings = [];
    try {
      const tree = syntaxTree(view.state);
      const doc = view.state.doc;
      const re = /^(#{1,6})\s+(.+)\s*$/;
      tree.iterate({
        enter: (node) => {
          const name = node.name || node.type?.name;
          if (!name) return;
          // match heading node names conservatively (common markdown grammars use "Header" / "Heading")
          if (name === "Header" || /heading/i.test(name)) {
            try {
              const line = doc.lineAt(node.from);
              const text = doc.sliceString(line.from, line.to);
              const m = re.exec(text);
              if (m) {
                const level = m[1].length;
                const title = cleanTitle(m[2].trim());
                // convert to 0-based line index for EditorProxy compatibility
                headings.push({ level, title, line: line.number - 1 });
              }
            } catch {}
          }
        }
      });
    } catch {}
    return headings;
  };

  // Parse role blocks (fallback when roles.index is unavailable)
  const BASE_ROLE_PREFIXES = ["user", "assistant", "system"];
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
    const headings = [];
    try {
      const tree = syntaxTree(view.state);
      const doc = view.state.doc;
      const re = /^(#{1,6})\s+(.+)\s*$/;
      tree.iterate({
        enter: (node) => {
          const name = node.name || node.type?.name;
          if (!name) return;
          if (name === "Header" || /heading/i.test(name)) {
            if (node.from < from || node.from > to) return;
            try {
              const line = doc.lineAt(node.from);
              const text = doc.sliceString(line.from, line.to);
              const m = re.exec(text);
              if (m) {
                const level = m[1].length;
                const title = cleanTitle(m[2].trim());
                headings.push({ level, title, line: line.number - 1 });
              }
            } catch {}
          }
        }
      });
    } catch {}
    return headings;
  };

  // 文本解析：限定行范围（返回绝对行号）
  const parseHeadingsFromTextInLines = (text, startLine, endLine) => {
    const lines = text.split(/\r?\n/);
    const headings = [];
    const re = /^(#{1,6})\s+(.+)\s*$/;
    const s = Math.max(0, startLine || 0);
    const e = Math.min(lines.length - 1, endLine == null ? s : endLine);
    for (let i = s; i <= e; i++) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const level = m[1].length;
      const title = cleanTitle(m[2].trim());
      headings.push({ level, title, line: i });
    }
    return headings;
  };

  const slugify = (s) => {
    // GitHub-like simple slug: lowercase, trim, spaces to '-', remove most punctuations
    return s
      .trim()
      .toLowerCase()
      .replace(/[\s]+/g, "-")
      .replace(/[^a-z0-9\u4e00-\u9fa5\-\_]/g, ""); // keep CJK basic, ascii, -, _
  };

  // 根据当前光标位置计算应高亮的目录项（标题与块）
  const computeActiveTOCAtCursor = (viewParam) => {
    try {
      const ed = window?.zion?.window?.activeEditor;
      if (!ed) return;

      const groupMode = !!window?.zion?.state?.get?.('toc.groupByRole');
      const docText = ed.getValue?.() || "";

      let currentLine = 0;
      let pos = 0;
      if (viewParam && viewParam.state) {
        const vstate = viewParam.state;
        pos = vstate.selection.main.head;
        currentLine = vstate.doc.lineAt(pos).number - 1;
      } else {
        try {
          const cur = ed.getCursor?.();
          if (cur && typeof cur.line === "number") currentLine = cur.line;
        } catch {}
      }

      let activeHeadingId = null;
      let activeBlockId = null;

      if (groupMode) {
        const idx = window?.zion?.state?.get?.('roles.index');
        let curBlock = null;

        // 优先使用字符范围定位块
        if (viewParam && Array.isArray(idx?.blocks)) {
          for (const b of idx.blocks) {
            if (typeof b.from === "number" && typeof b.to === "number") {
              if (pos >= b.from && pos <= b.to) {
                curBlock = b;
                break;
              }
            }
          }
        }

        // 退化为行范围定位块
        if (!curBlock) {
          const blocks = Array.isArray(idx?.blocks) && typeof idx.blocks[0]?.startLine === "number"
            ? idx.blocks
            : parseRoleBlocksFromText(docText);
          for (const b of blocks) {
            const s = b.startLine ?? 0;
            const e = b.endLine ?? s;
            if (currentLine >= s && currentLine <= e) {
              curBlock = b;
              break;
            }
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
        const prevH = window?.zion?.state?.get?.('toc.activeHeadingId');
        if (prevH !== activeHeadingId) window.zion.state.set('toc.activeHeadingId', activeHeadingId || null);
      } catch {}
      try {
        const prevB = window?.zion?.state?.get?.('toc.activeBlockId');
        if (prevB !== activeBlockId) window.zion.state.set('toc.activeBlockId', activeBlockId || null);
      } catch {}
    } catch {}
  };

  // Scroll helper: set cursor and scroll so the target line appears near the top of the viewport.
  // - ed: the editor abstraction (window.zion.window.activeEditor)
  // - maybeView: underlying CodeMirror view when available (ed.core.view)
  // - line: 0-based line number
  // - topOffset: pixels to keep between top of viewport and the target line (default 48)
  const scrollLineIntoViewTop = (ed, maybeView, line, topOffset = 48) => {
    try {
      // Set cursor and focus first (best-effort)
      try { ed.setCursor({ line, ch: 0 }); } catch {}
      try { ed.focus(); } catch {}

      if (maybeView && maybeView.coordsAtPos) {
        try {
          // Convert line to a document position
          const pos = maybeView.state.doc.line(line + 1).from;
          const coords = maybeView.coordsAtPos(pos);
          if (!coords) return;

          // Determine scroll container (CodeMirror exposes scrollDOM)
          const scroller = maybeView.scrollDOM || maybeView.dom || document.scrollingElement || document.documentElement;
          const scrollerRect = scroller.getBoundingClientRect ? scroller.getBoundingClientRect() : { top: 0 };
          const currentScrollTop = scroller.scrollTop || 0;

          // coords.top is viewport-relative; compute desired scrollTop on scroller
          const targetScrollTop = currentScrollTop + (coords.top - scrollerRect.top) - topOffset;

          if (typeof scroller.scrollTo === 'function') {
            try { scroller.scrollTo({ top: targetScrollTop, left: 0, behavior: 'smooth' }); } catch { scroller.scrollTop = targetScrollTop; }
          } else {
            scroller.scrollTop = targetScrollTop;
          }
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
  let tocUI = {
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
    originalNextSibling: null
  };
  // collapsed state set for headings: keep ids of collapsed nodes so updates can preserve UI state
  const tocState = {
    collapsed: new Set(),
    allCollapsibleIds: new Set()
  };
  let sidePanelOpen = false;
  let sideOverlayMode = false;
  const debouncedUpdate = debounce(() => updateTOCList(), 120);

  const syncToggleAllBtn = () => {
    try {
      const btn = tocUI?.toggleAllBtn;
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

  const syncGroupBtnUI = () => {
    try {
      const groupBtn = tocUI?.groupBtn;
      if (!groupBtn) return;
      const on = !!window?.zion?.state?.get?.('toc.groupByRole');
      groupBtn.style.opacity = on ? "1" : "0.7";
      groupBtn.style.background = on ? "var(--ext-toc-hover, var(--border))" : "transparent";
      groupBtn.style.color = on ? "var(--ext-toc-active-fg, var(--accent))" : "var(--ext-toc-fg, var(--fg))";
      groupBtn.title = on ? "按角色分组：开" : "按角色分组：关";
    } catch {}
  };

  // Layout the side panel to sit flush left of the editor content while keeping the whole group centered.
  // New logic: decide overlay by a simple threshold derived from width mode, not from current measured editor width.
  // This avoids false overlays in "full"/"wide" and keeps inline layout on typical laptop screens.
  const applySideLayout = () => {
    try {
      if (!tocUI.wrapper || !tocUI.panel || !tocUI.editorEl) return;
      const wrapper = tocUI.wrapper;
      const edEl = tocUI.editorEl;
      const scroller = tocUI.scrollerEl || edEl;

      // Ensure wrapper is a flex row centered as a group (panel + editor)
      wrapper.style.display = "flex";
      wrapper.style.alignItems = "stretch";
      wrapper.style.justifyContent = "center";
      wrapper.style.position = "relative";

      // Ensure the panel has a stable flex-basis/width
      let basis = tocUI.panel.offsetWidth || 240;
      if (basis <= 0) basis = 240;
      basis = Math.max(220, Math.min(480, basis));
      tocUI.panel.style.flex = `0 0 ${basis}px`;
      tocUI.panel.style.width = `${basis}px`;
      // Ensure panel maintains flex column layout for sticky toolbar
      tocUI.panel.style.display = 'flex';
      tocUI.panel.style.flexDirection = 'column';

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
        // Overlay: panel floats; editor keeps its own width/margins (from width mode)
        sideOverlayMode = true;
        tocUI.panel.style.position = "absolute";
        tocUI.panel.style.left = "0";
        tocUI.panel.style.top = "0";
        tocUI.panel.style.bottom = "0";
        tocUI.panel.style.height = "100%";
        tocUI.panel.style.zIndex = "2";

        edEl.style.flex = "1 1 auto";
        // restore previous editor inline width if any; otherwise let width-mode rules apply
        edEl.style.width = tocUI.prevEditorWidth || "";
        if (scroller) {
          scroller.style.marginLeft = tocUI.prevScrollerMarginLeft || "";
          scroller.style.marginRight = tocUI.prevScrollerMarginRight || "";
        }
      } else {
        // Inline: panel sits left, editor takes remaining space; remove auto margins for proper side-by-side centering
        sideOverlayMode = false;
        tocUI.panel.style.position = "relative";
        tocUI.panel.style.left = "";
        tocUI.panel.style.top = "";
        tocUI.panel.style.bottom = "";
        tocUI.panel.style.height = "100%";
        tocUI.panel.style.zIndex = "";

        if (scroller) {
          scroller.style.marginLeft = "0";
          scroller.style.marginRight = "0";
        }
        edEl.style.flex = "1 1 auto";
        edEl.style.width = "";
      }
    } catch {}
  };

  const updateTOCList = () => {
    try {
      const ed = window.zion.window.activeEditor;
      if (!ed || !tocUI.panel) return;
      const maybeView = (ed && ed.core && ed.core.view) ? ed.core.view : null;

      let list = tocUI.panel.querySelector('#zion-toc-list');
      if (!list) {
        list = document.createElement('div');
        list.id = 'zion-toc-list';
        // Prevent horizontal scrolling and ensure it fits the panel
        list.style.flex = '1';
        list.style.overflowY = 'auto';
        list.style.overflowX = 'hidden';
        list.style.minHeight = '0';
        list.style.maxWidth = '100%';
        list.style.boxSizing = 'border-box';
        tocUI.panel.appendChild(list);
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
          row.style.padding = "4px 8px";
          row.style.gap = "6px";
          row.style.cursor = "pointer";
          // indentation by semantic level (offset inside role block when grouped)
          row.style.paddingLeft = `${(item.level - 1 + baseLevelOffset) * 12}px`;

          // Always create left column for consistent spacing
          const leftCol = document.createElement("div");
          leftCol.style.display = "flex";
          leftCol.style.alignItems = "center";
          leftCol.style.justifyContent = "center";
          leftCol.style.flex = "0 0 24px";
          leftCol.style.width = "24px";
          
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
            chevronBtn.style.width = '24px';
            chevronBtn.style.height = '24px';
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
              debouncedUpdate();
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
          label.style.fontSize = "12px";
          label.style.whiteSpace = "nowrap";
          label.style.textOverflow = "ellipsis";
          label.style.overflow = "hidden";
          label.style.marginLeft = "0";
          row.appendChild(label);
          // Active heading highlight (cursor-based)
          try {
            const activeId = window?.zion?.state?.get?.('toc.activeHeadingId');
            if (activeId && activeId === item.id) {
              label.style.fontWeight = "600";
              label.style.color = "var(--ext-toc-active-fg, var(--accent))";
            }
          } catch {}

          row.onclick = () => {
            try {
              window?.zion?.state?.set?.('toc.activeHeadingId', item.id);
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
          empty.textContent = "No headings found (use #, ##, ### ...)";
          empty.style.opacity = "0.8";
          empty.style.fontSize = "12px";
          empty.style.padding = "8px";
          list.appendChild(empty);
        } else {
          const roots = buildTree(headings);
          indexTree(roots);
          renderNodes(list, roots);
        }
      } else {
        // group by role blocks
        const idx = window?.zion?.state?.get?.('roles.index');
        const blocks = Array.isArray(idx?.blocks) ? idx.blocks : parseRoleBlocksFromText(ed.getValue());
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
            row.style.padding = "4px 8px";
            row.style.gap = "6px";
            row.style.cursor = "pointer";

            // chevron or spacer
            // Always create left column for consistent spacing
            const leftCol = document.createElement("div");
            leftCol.style.display = "flex";
            leftCol.style.alignItems = "center";
            leftCol.style.justifyContent = "center";
            leftCol.style.flex = "0 0 24px";
            leftCol.style.width = "24px";
            
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
              chevronBtn.style.width = '24px';
              chevronBtn.style.height = '24px';
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
                debouncedUpdate();
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
            const roleColors = { user: '#4caf50', assistant: '#2196f3', system: '#9e9e9e' };
            const dotColor = roleColors[b.role?.toLowerCase()] || roleColors.user;
            label.innerHTML = `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${dotColor};margin-right:6px;flex-shrink:0;opacity:0.6;"></span>${(b.preview || '').trim() || '(empty)'}`;
            label.style.fontSize = "12px";
            label.style.whiteSpace = "nowrap";
            label.style.textOverflow = "ellipsis";
            label.style.overflow = "hidden";
            label.style.marginLeft = "0";
            label.style.display = "flex";
            label.style.alignItems = "center";
            // Add tooltip to show role name on hover
            label.title = `${b.role || 'unknown'}: ${(b.preview || '').trim() || '(empty)'}`;
            // Show tooltip only on hover, prevent it from showing on screen readers (optional)
            // label.setAttribute('aria-label', `${b.role} role block`);



            try {
              const activeBlockId = window?.zion?.state?.get?.('toc.activeBlockId');
              const activeHeadingId = window?.zion?.state?.get?.('toc.activeHeadingId');
              if (activeBlockId && activeBlockId === blockId && !activeHeadingId) {
                label.style.fontWeight = "600";
                label.style.color = "var(--ext-toc-active-fg, var(--accent))";
              }
            } catch {}

            row.appendChild(label);

            row.onclick = () => {
              try {
                window?.zion?.state?.set?.('toc.activeHeadingId', null);
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

      syncToggleAllBtn();
    } catch {}
  };

  const openSideTOC = () => {
    const ed = window.zion.window.activeEditor;
    const maybeView = (ed && ed.core && ed.core.view) ? ed.core.view : null;
    if (!ed) return showOverlayTOC();
    if (!tocUI.wrapper || !tocUI.panel || !tocUI.editorEl) {
      // UI not ready (editor DOM not found) -> fallback to overlay
      return showOverlayTOC();
    }
    // Show panel
    tocUI.panel.style.display = "block";

    // Backup current styles to restore when closing
    const scroller = tocUI.scrollerEl || tocUI.editorEl;
    if (tocUI.wrapper) {
      tocUI.prevWrapperJustifyContent = tocUI.wrapper.style.justifyContent || "";
    }
    if (tocUI.editorEl) {
      tocUI.prevEditorFlex = tocUI.editorEl.style.flex || "";
      tocUI.prevEditorWidth = tocUI.editorEl.style.width || "";
    }
    if (scroller) {
      tocUI.prevScrollerMarginLeft = scroller.style.marginLeft || "";
      tocUI.prevScrollerMarginRight = scroller.style.marginRight || "";
    }

    // Apply centered layout with panel snug to the editor content
    applySideLayout();

    // Sync active heading/block based on current cursor, then build list
    try { computeActiveTOCAtCursor(maybeView); } catch {}

    // Build list
    updateTOCList();
    sidePanelOpen = true;
  };

  const closeSideTOC = () => {
    if (!tocUI.wrapper || !tocUI.panel || !tocUI.editorEl) return;
    tocUI.panel.style.display = "none";
    // Restore wrapper layout
    if (tocUI.wrapper) {
      tocUI.wrapper.style.display = "block";
      tocUI.wrapper.style.justifyContent = tocUI.prevWrapperJustifyContent || "";
    }
    // Restore editor element sizing
    if (tocUI.editorEl) {
      tocUI.editorEl.style.flex = tocUI.prevEditorFlex || "";
      tocUI.editorEl.style.width = tocUI.prevEditorWidth || "";
    }
    // Restore scroller margins
    const scroller = tocUI.scrollerEl || tocUI.editorEl;
    if (scroller) {
      scroller.style.marginLeft = tocUI.prevScrollerMarginLeft || "";
      scroller.style.marginRight = tocUI.prevScrollerMarginRight || "";
      tocUI.prevScrollerMarginLeft = "";
      tocUI.prevScrollerMarginRight = "";
    }
    sidePanelOpen = false;
  };

  const toggleSideTOC = () => {
    if (sidePanelOpen) closeSideTOC();
    else openSideTOC();
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
    panel.style.zIndex = "99999";
    panel.onclick = (e) => e.stopPropagation();

    const title = document.createElement("div");
    title.textContent = "Contents";
    title.style.fontWeight = "600";
    title.style.marginBottom = "8px";
    panel.appendChild(title);

    const list = document.createElement("div");
    // Constrain list to avoid horizontal scrolling
    list.style.overflowY = "auto";
    list.style.overflowX = "hidden";
    list.style.maxWidth = "100%";
    if (headings.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No headings found (use #, ##, ### ...)";
      empty.style.opacity = "0.8";
      empty.style.fontSize = "12px";
      list.appendChild(empty);
    } else {
      headings.forEach(h => {
        const row = document.createElement("div");
        row.className = "toc-row";
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.padding = "4px 2px";
        row.style.cursor = "pointer";
        // indent by level (still set inline for per-item indentation)
        row.style.paddingLeft = `${(h.level - 1) * 12}px`;

        const bullet = document.createElement("span");
        bullet.className = "toc-bullet";
        bullet.textContent = "•";

        const label = document.createElement("span");
        label.className = "toc-label";
        label.textContent = h.title;
        label.style.fontSize = "12px";
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
    insertBtn.textContent = "Insert TOC Here";
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
    closeBtn.textContent = "Close";
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
    const idx = window?.zion?.state?.get?.('roles.index');
    const blocks = Array.isArray(idx?.blocks) ? idx.blocks : parseRoleBlocksFromText(ed.getValue());
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
  const d1 = window.zion.commands.registerCommand("toc.show", () => toggleSideTOC());
  const d2 = window.zion.commands.registerCommand("toc.insert", () => insertMarkdownTOC());
  ctx.subscriptions.push(d1, d2);

  // keybinding
  const d3 = window.zion.keybindings.register({
    command: "toc.show",
    key: "Mod-Shift-t",
    when: "editorFocus"
  });
  ctx.subscriptions.push(d3);

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
      try { window.zion.state.set('toc.activeHeadingId', null); } catch {}
      try { window.zion.state.set('toc.activeBlockId', null); } catch {}
      try { localStorage.setItem('zion.toc.groupByRole', next ? '1' : '0'); } catch {}
      if (sidePanelOpen) {
        try {
          const maybeView = window?.zion?.window?.activeEditor?.core?.view || null;
          computeActiveTOCAtCursor(maybeView);
        } catch {}
        debouncedUpdate();
      }
    } catch {}
  });
  ctx.subscriptions.push(dToggle);

  // Register slash commands
  const dSlash1 = window.zion.slash?.registerCommand?.({
    id: "toc.show",
    trigger: ["toc", "table-of-contents"],
    title: "显示目录",
    description: "打开文档目录侧边栏",
    category: "navigation",
    icon: "📑",
    priority: 100,
    execute: () => {
      window.zion.commands.executeCommand("toc.show");
    }
  });

  const dSlash2 = window.zion.slash?.registerCommand?.({
    id: "toc.insert",
    trigger: ["insert-toc", "toc-insert"],
    title: "插入目录",
    description: "在光标位置插入 Markdown 目录",
    category: "markdown",
    icon: "📋",
    priority: 90,
    execute: () => {
      window.zion.commands.executeCommand("toc.insert");
    }
  });

  const dSlash3 = window.zion.slash?.registerCommand?.({
    id: "toc.toggleGroupByRole",
    trigger: ["toc-group", "group-toc"],
    title: "切换目录分组",
    description: "按角色分组显示目录",
    category: "navigation",
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

  // status bar button
  const d4 = window.zion.statusBar.registerItem({
    id: "dev.toc",
    text: "TOC",
    tooltip: "Show Table of Contents",
    onClick: () => window.zion.commands.executeCommand("toc.show")
  });
  ctx.subscriptions.push(d4);

  // Decorator: mount floating button (top-left) and left side TOC panel (flex with editor)
  const d5 = window.zion.editor.registerDecorator({
    id: "dev.toc.ui",
    apply(editor) {
      try {
        // Find CM6 editor root
        const edEl = document.querySelector(".cm-editor");
        if (!edEl) return { dispose() {} };

        // Build UI once
        if (!tocUI.wrapper) {
          const originalParent = edEl.parentElement;
          const originalNextSibling = edEl.nextSibling;

          const wrapper = document.createElement("div");
          wrapper.id = "zion-toc-wrapper";
          wrapper.style.position = "relative";
          wrapper.style.width = "100%";
          wrapper.style.height = "100%";
          wrapper.style.display = "block";

          // Insert wrapper before editor and move editor inside it
          originalParent.insertBefore(wrapper, edEl);
          wrapper.appendChild(edEl);

          // Left side panel
          const panel = document.createElement("div");
          panel.id = "zion-toc-sidepanel";
          panel.style.display = "none";
          panel.style.flex = "0 0 240px";
          panel.style.width = "240px";
          panel.style.minWidth = "220px";
          panel.style.maxWidth = "480px";
          panel.style.height = "100%";
          // Prevent horizontal scrolling in the TOC side panel; allow only vertical scrolling
          panel.style.display = "flex";
          panel.style.flexDirection = "column";
          panel.style.background = "var(--ext-toc-bg, var(--bg))";
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
          const minWidth = 220;
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

          // Insert panel before editor element (so it sits on the left in flex)
          wrapper.insertBefore(panel, edEl);

          // Button toolbar (right-aligned, icons only)
          const toolbar = document.createElement("div");
          toolbar.style.display = "flex";
          toolbar.style.alignItems = "center";
          toolbar.style.gap = "6px";
          toolbar.style.padding = "8px 0px 8px 35px";
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
          tocUI.groupBtn = groupBtn;
          groupBtn.onclick = () => window.zion.commands.executeCommand("toc.toggleGroupByRole");
          toolbar.appendChild(groupBtn);
          syncGroupBtnUI();

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
              updateTOCList();
            } catch {}
          };
          toolbar.appendChild(toggleAllBtn);

          tocUI.toggleAllBtn = toggleAllBtn;
          syncToggleAllBtn();

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
            closeSideTOC();
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
          list.id = "zion-toc-list";
          list.style.flex = "1";
          list.style.overflowY = "auto";
          list.style.overflowX = "hidden";
          list.style.minHeight = "0";
          list.style.maxWidth = "100%";
          list.style.boxSizing = "border-box";
          panel.appendChild(list);

          // Save refs
          tocUI.wrapper = wrapper;
          tocUI.panel = panel;
          tocUI.button = null;
          tocUI.editorEl = edEl;
          tocUI.scrollerEl = edEl.querySelector(".cm-scroller") || edEl;
          tocUI.prevScrollerMarginLeft = "";
          tocUI.originalParent = originalParent;
          tocUI.originalNextSibling = originalNextSibling;
        }
      } catch {}

      // Sync TOC with document updates
      editor.addVisualExtension(ViewPlugin.fromClass(class {
        update(u) {
          try {
            computeActiveTOCAtCursor(u?.view);
          } catch {}
          if (sidePanelOpen && tocUI.panel && (u.docChanged || u.viewportChanged || u.selectionSet)) {
            debouncedUpdate();
          }
        }
      }));

      // Keep editor scroller left-aligned when width mode changes while TOC is open
      const widthModeSub = window.zion.state.onDidChange("ui.editorWidthMode", () => {
        if (sidePanelOpen) {
          applySideLayout();
        }
      });
      // 监听分组模式状态变化以同步按钮样式与列表
      const groupModeSub = window.zion.state.onDidChange("toc.groupByRole", () => {
        try {
          try { syncGroupBtnUI(); } catch {}
          if (sidePanelOpen) debouncedUpdate();
        } catch {}
      });
      // 点击子目录时的高亮状态变化，触发列表重绘
      const activeHeadingSub = window.zion.state.onDidChange("toc.activeHeadingId", () => {
        try {
          if (sidePanelOpen) debouncedUpdate();
        } catch {}
      });
      // 当前块（角色）高亮状态变化，触发列表重绘
      const activeBlockSub = window.zion.state.onDidChange("toc.activeBlockId", () => {
        try {
          if (sidePanelOpen) debouncedUpdate();
        } catch {}
      });

      const onResize = () => {
        if (sidePanelOpen) applySideLayout();
      };
      window.addEventListener("resize", onResize);

      // Open TOC side panel by default
      try { if (!sidePanelOpen) openSideTOC(); } catch {}

      // Return Disposable to cleanup on extension deactivate/reload
      return {
        dispose() {
          try {
            // Close panel if open and restore editor DOM
            closeSideTOC();
            if (tocUI.button) tocUI.button.remove();
            if (tocUI.panel) tocUI.panel.remove();
            if (tocUI.originalParent && tocUI.editorEl) {
              tocUI.originalParent.insertBefore(tocUI.editorEl, tocUI.originalNextSibling || null);
            }
            if (tocUI.wrapper) tocUI.wrapper.remove();

            // Dispose subscriptions
            try { widthModeSub?.dispose?.(); } catch {}
            try { groupModeSub?.dispose?.(); } catch {}
            try { activeHeadingSub?.dispose?.(); } catch {}
            try { activeBlockSub?.dispose?.(); } catch {}
            try { window.removeEventListener("resize", onResize); } catch {}

            // Reset refs
            tocUI.wrapper = null;
            tocUI.panel = null;
            tocUI.button = null;
            tocUI.editorEl = null;
            tocUI.scrollerEl = null;
            tocUI.prevScrollerMarginLeft = "";
            tocUI.prevScrollerMarginRight = "";
            tocUI.prevWrapperJustifyContent = "";
            tocUI.prevEditorFlex = "";
            tocUI.prevEditorWidth = "";
            tocUI.originalParent = null;
            tocUI.originalNextSibling = null;
            sidePanelOpen = false;
          } catch {}
        }
      };
    }
  });
  ctx.subscriptions.push(d5);

  // context menu item registered via contributes.menus in manifest,
  // but we ensure command exists even if menus are filtered.
}

export function deactivate() {}
