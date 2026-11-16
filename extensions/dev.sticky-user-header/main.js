import { ViewPlugin, EditorView } from "@codemirror/view";

const I18N_NS = "dev.sticky-user-header";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.editor": "编辑器",
    "cmd.toggle": "切换固定用户头部",
    "ui.headerMenu": "固定用户头部"
  },
  "en-US": {
    "category.editor": "Editor",
    "cmd.toggle": "Toggle Sticky Header",
    "ui.headerMenu": "Sticky User Header"
  }
};

function t(key, fallback, values) {
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

const BASE_ROLE_PREFIXES = ["user", "assistant", "system"];

function normalize(list) {
  const out = [];
  const seen = new Set();
  for (const r of list || []) {
    if (typeof r !== "string") continue;
    const rr = r.trim();
    if (!rr || seen.has(rr)) continue;
    seen.add(rr);
    out.push(rr);
  }
  return out;
}

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
  return normalize(out);
}

function getEffectivePrefixes() {
  return normalize([...BASE_ROLE_PREFIXES, ...readCustomPrefixesFromEnv()]);
}

function getRoleForLine(text, prefixes) {
  const t = text || "";
  for (const r of prefixes) {
    if (t.startsWith(r + " ")) return r;
  }
  return null;
}

function buildBlocksFromState(state, prefixes) {
  const doc = state.doc;
  const blocks = [];
  let current = null;
  try {
    if (doc.length > 0) {
      const first = doc.line(1);
      const firstText = doc.sliceString(first.from, first.to);
      const firstRole = getRoleForLine(firstText, prefixes);
      if (!firstRole) {
        current = {
          role: "user",
          from: 1,
          startPos: 1,
          endPos: 1,
          preview: ""
        };
        const t = firstText.trim();
        if (t) current.preview = t.slice(0, 160);
      }
    }
  } catch {}

  for (let pos = 1; pos <= doc.length;) {
    const line = doc.lineAt(pos);
    const text = doc.sliceString(line.from, line.to);
    const roleHere = getRoleForLine(text, prefixes);

    if (roleHere) {
      if (current) {
        blocks.push(current);
        current = null;
      }
      const tokenLen = roleHere.length;
      const contentStart = Math.min(line.to, line.from + tokenLen + 1);
      current = {
        role: roleHere,
        from: contentStart,
        startPos: contentStart,
        endPos: contentStart,
        preview: ""
      };
      const rem = doc.sliceString(contentStart, line.to).trim();
      if (rem) current.preview = rem.slice(0, 160);
    } else if (current) {
      current.endPos = line.to;
      if (!current.preview) {
        const t = doc.sliceString(line.from, line.to).trim();
        if (t) current.preview = t.slice(0, 160);
      }
    }

    pos = line.to + 1;
  }

  if (current) blocks.push(current);
  return { prefixes, blocks, updatedAt: Date.now() };
}

function isEnabled() {
  try {
    const key = "dev.sticky-user-header.enabled";
    const val = localStorage.getItem(key);
    if (val === "true" || val === "1") return true;
    return false;
  } catch {
    return false;
  }
}

function buildIndexForView(view, prefixes) {
  try {
    return buildBlocksFromState(view.state, prefixes);
  } catch {
    return { prefixes, blocks: [], updatedAt: Date.now() };
  }
}

function mapIndexThroughChanges(index, changes) {
  if (!index?.blocks?.length) return index;
  return {
    ...index,
    blocks: index.blocks.map((block) => ({
      ...block,
      from: changes.mapPos(block.from, 1),
      startPos: changes.mapPos(block.startPos, 1),
      endPos: changes.mapPos(block.endPos, -1)
    }))
  };
}

function isLargeDocumentChange(update) {
  let changed = 0;
  update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changed += (toA - fromA) + inserted.length;
  });
  return changed > 512;
}

function findLastIndexLE(blocks, pos) {
  let lo = 0;
  let hi = blocks.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = blocks[mid]?.startPos;
    if (typeof s === "number" && s <= pos) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function findPrevRoleIndex(blocks, startIndex, role) {
  for (let i = startIndex; i >= 0; i--) {
    if (blocks[i]?.role === role) return i;
  }
  return -1;
}

function roleTheme(role) {
  if (role === "assistant") return { fg: "var(--role-assistant-fg)", bg: "var(--role-assistant-bg)", bd: "var(--role-assistant-border)" };
  if (role === "system") return { fg: "var(--role-system-fg)", bg: "var(--role-system-bg)", bd: "var(--role-system-border)" };
  return { fg: "var(--role-user-fg)", bg: "var(--role-user-bg)", bd: "var(--role-user-border)" };
}

function stickyUserHeaderView() {
  const prefixes = getEffectivePrefixes();
  const targetRole = "user";

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
this.view = view;
        this.prefixes = prefixes;
        this.index = buildIndexForView(view, prefixes);
        this.lastKey = "";
        this.lastHeight = 0;
        this.prevScrollerPaddingTop = null;
        this.scrollHandler = this.onScroll.bind(this);
        this.configHandler = () => this.scheduleSync();
        window.addEventListener("zion-sticky-user-header-config-changed", this.configHandler);
        this.resizeHandler = () => this.scheduleSync();
        try {
          window.addEventListener("resize", this.resizeHandler, { passive: true });
        } catch {}
        try {
          this.widthModeSub = window?.zion?.state?.onDidChange?.("ui.editorWidthMode", () => this.scheduleSync());
        } catch {}
        this.syncRaf = null;
        this.indexTimer = 0;

        const root = view.dom;
        this.root = root;
        if (root && root.nodeType === 1) {
          const el = root;
          if (getComputedStyle(el).position === "static") el.style.position = "relative";
        }

        this.ownerId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        try {
          root.dataset.zionStickyUserHeaderOwner = this.ownerId;
        } catch {}

        try {
          root.querySelectorAll(".zion-cm-sticky-user-header").forEach(n => n.remove());
        } catch {}

        // Header Element
        this.headerEl = document.createElement("div");
        this.headerEl.className = "zion-cm-sticky-user-header is-empty";
        this.headerEl.dataset.ownerId = this.ownerId;

        this.contentEl = document.createElement("div");
        this.contentEl.className = "zion-sticky-content";
        this.headerEl.appendChild(this.contentEl);
        
        this.headerEl.addEventListener("click", (e) => {
          const lineEl = e.target?.closest?.("[data-pos]");
          if (!lineEl) return;
          const pos = Number(lineEl.getAttribute("data-pos"));
          if (!Number.isFinite(pos)) return;
          const lineFrom = this.view.state.doc.lineAt(Math.max(0, Math.min(this.view.state.doc.length, pos))).from;
          
          const headerHeight = this.headerEl.offsetHeight || 0;
          this.view.dispatch({ 
            selection: { anchor: lineFrom }, 
            effects: EditorView.scrollIntoView(lineFrom, { y: 'start', yMargin: headerHeight + 10 }) 
          });
          this.view.focus();
        });
        
        root.insertBefore(this.headerEl, root.firstChild);

        if (view.scrollDOM) {
          view.scrollDOM.addEventListener("scroll", this.scrollHandler, { passive: true });
        }
        this.scheduleSync();
      }

      update(update) {
        this.view = update.view;
        if (update.docChanged) {
          if (isLargeDocumentChange(update)) {
            this.index = buildIndexForView(update.view, this.prefixes);
          } else {
            this.index = mapIndexThroughChanges(this.index, update.changes);
            this.scheduleIndexRefresh();
          }
        }
        // viewportChanged is not enough for precise sticky behavior, relying on scroll event
        if (update.docChanged || update.viewportChanged) {
          this.scheduleSync();
        }
      }

      onScroll() {
        this.scheduleSync();
      }

      scheduleIndexRefresh() {
        if (this.indexTimer) window.clearTimeout(this.indexTimer);
        this.indexTimer = window.setTimeout(() => {
          this.indexTimer = 0;
          this.index = buildIndexForView(this.view, this.prefixes);
          this.scheduleSync();
        }, 120);
      }

      scheduleSync() {
        if (this.root?.dataset?.zionStickyUserHeaderOwner !== this.ownerId) return;
        if (this.syncRaf) return;
        this.syncRaf = window.requestAnimationFrame(() => {
          this.syncRaf = null;
          this.sync();
        });
      }

      sync() {
        if (this.root?.dataset?.zionStickyUserHeaderOwner !== this.ownerId) return;
        this.syncLayout();
        if (!isEnabled()) {
          this.headerEl.classList.add("is-empty");
          this.updateHeight(0);
          return;
        }

        // Hide at top to avoid duplication/jump
        const scrollTop = this.view.scrollDOM.scrollTop;
        if (scrollTop < 10) {
          this.headerEl.classList.add("is-empty");
          this.updateHeight(0);
          return;
        }

        const blocks = this.index?.blocks || [];
        // Calculate the exact document position at the top of the visible viewport
        // viewport.from includes buffer, so we use lineBlockAtHeight with scrollTop
        const y = scrollTop;
        const topBlock = this.view.lineBlockAtHeight(y);
        const topPos = topBlock.from;

        const curIdx = blocks.length ? findLastIndexLE(blocks, topPos) : -1;

        let userIdx = -1;
        if (curIdx >= 0) {
          if (blocks[curIdx]?.role === targetRole) userIdx = curIdx;
          else userIdx = findPrevRoleIndex(blocks, curIdx, targetRole);
        }

        // Check if the target user block is still partially visible at top
        // If so, we should NOT show sticky header yet (wait until it scrolls out)
        if (userIdx >= 0) {
          try {
            const uBlock = blocks[userIdx];
            // Use the block's start position to get the line info
            const uLine = this.view.lineBlockAt(uBlock.from);
            // If the bottom of the user line is still below scrollTop (meaning it's visible or below viewport top)
            // we hide the sticky header.
            if (uLine.bottom > scrollTop) {
              this.headerEl.classList.add("is-empty");
              this.updateHeight(0);
              return;
            }
          } catch {}
        }

        const items = [];
        if (userIdx >= 0) {
          const b = blocks[userIdx];
          // If the current top block is the user block itself, and we are viewing its content, sticky it.
          // Or if we are inside a subsequent block (assistant/system), sticky the previous user block.
          items.push({ role: targetRole, preview: String(b?.preview || "").trim(), pos: b?.from });
        }
        if (curIdx >= 0) {
          const b = blocks[curIdx];
          const role = b?.role;
          if (role && role !== targetRole && role !== "system") {
            items.push({ role, preview: String(b?.preview || "").trim(), pos: b?.from });
          }
        }

        const key = items.map(it => `${it.role}:${it.preview}`).join("\n");
        if (key === this.lastKey) return;
        this.lastKey = key;

        this.contentEl.textContent = "";
        if (!items.length) {
          this.headerEl.classList.add("is-empty");
          this.updateHeight(0);
          return;
        }

        for (const it of items) {
          const line = document.createElement("div");
          line.className = "zion-sticky-line";
          line.setAttribute("data-pos", String(Number(it.pos) || 0));

          const rail = document.createElement("span");
          rail.className = `zion-sticky-rail zion-sticky-rail-${it.role}`;

          const badge = document.createElement("span");
          badge.className = "zion-sticky-badge";
          badge.textContent = it.role;
          const theme = roleTheme(it.role);
          badge.style.color = "var(--fg)";
          badge.style.background = theme.bg;

          const text = document.createElement("span");
          text.className = "zion-sticky-text";
          const preview = it.preview || "(empty)";
          text.textContent = preview.length > 140 ? preview.slice(0, 137) + "..." : preview;

          line.appendChild(rail);
          line.appendChild(badge);
          line.appendChild(text);
          this.contentEl.appendChild(line);
        }
        this.headerEl.classList.remove("is-empty");

        requestAnimationFrame(() => {
          const h = this.headerEl.offsetHeight || 0;
          this.updateHeight(h);
        });
      }

      syncLayout() {
        try {
          const root = this.root;
          const header = this.headerEl;
          const scroller = this.view?.scrollDOM || root?.querySelector?.(".cm-scroller");
          const content = root?.querySelector?.(".cm-content");
          if (!root || !header || !this.contentEl || !scroller) return;

          const rootRect = root.getBoundingClientRect();
          let textLeft = 0;
          let textRight = 0;
          if (content) {
            const contentRect = content.getBoundingClientRect();
            const contentStyle = getComputedStyle(content);
            let pl = 0;
            let pr = 0;
            try {
              pl = parseFloat(contentStyle.paddingLeft) || 0;
              pr = parseFloat(contentStyle.paddingRight) || 0;
            } catch {}
            textLeft = contentRect.left + pl;
            textRight = contentRect.right - pr;
          } else {
            const scrollerRect = scroller.getBoundingClientRect();
            const scrollerStyle = getComputedStyle(scroller);
            let paddingLeft = 0;
            let paddingRight = 0;
            try {
              paddingLeft = parseFloat(scrollerStyle.paddingLeft) || 0;
              paddingRight = parseFloat(scrollerStyle.paddingRight) || 0;
            } catch {}

            const clientWidth = Number(scroller.clientWidth) || scrollerRect.width;
            const visibleContentLeft = scrollerRect.left + paddingLeft;
            const visibleContentRight = scrollerRect.left + clientWidth - paddingRight;

            const gutters = root?.querySelector?.(".cm-gutters");
            textLeft = visibleContentLeft;
            if (gutters) {
              const guttersRect = gutters.getBoundingClientRect();
              if (Number.isFinite(guttersRect.right)) textLeft = Math.max(textLeft, guttersRect.right);
            }
            textRight = visibleContentRight;
          }

          const left = Math.round(textLeft - rootRect.left);
          const width = Math.round(Math.max(0, textRight - textLeft));
          let guttersLeft = 0;
          try {
            const gutters = root?.querySelector?.(".cm-gutters");
            if (gutters) {
              const guttersRect = gutters.getBoundingClientRect();
              guttersLeft = Math.round(guttersRect.left - rootRect.left);
            }
          } catch {}

          header.style.left = "0px";
          header.style.right = "0px";
          header.style.width = "auto";

          if (Number.isFinite(left) && Number.isFinite(width) && width > 0) {
            this.contentEl.style.marginLeft = `${Math.max(0, left)}px`;
            this.contentEl.style.width = `${width}px`;
            this.contentEl.style.boxSizing = "border-box";
            try {
              this.contentEl.style.setProperty("--zion-sticky-text-left", `${Math.max(0, left)}px`);
              this.contentEl.style.setProperty("--zion-sticky-gutters-left", `${Math.max(0, guttersLeft)}px`);
            } catch {}
          }




        } catch {}
      }

      updateHeight(h) {
        // We only track height for scrollMargins, NO padding injection anymore
        const nextH = Math.max(0, Math.floor(h));
        if (nextH === this.lastHeight) return;
        this.lastHeight = nextH;
        this.view.requestMeasure();
      }

      destroy() {
        try {
          if (this.configHandler) window.removeEventListener("zion-sticky-user-header-config-changed", this.configHandler);
          if (this.resizeHandler) window.removeEventListener("resize", this.resizeHandler);
          try { this.widthModeSub?.dispose?.(); } catch {}
          if (this.syncRaf) window.cancelAnimationFrame(this.syncRaf);
          if (this.indexTimer) window.clearTimeout(this.indexTimer);
          if (this.view?.scrollDOM && this.scrollHandler) {
            this.view.scrollDOM.removeEventListener("scroll", this.scrollHandler);
          }
        } catch {}
        try {
          if (this.root?.dataset?.zionStickyUserHeaderOwner === this.ownerId) {
            try { delete this.root.dataset.zionStickyUserHeaderOwner; } catch {}
          }
        } catch {}
        try { this.headerEl?.remove?.(); } catch {}
      }
    },
    {
      provide: plugin => EditorView.scrollMargins.of(view => {
        const value = view.plugin(plugin);
        return { top: value?.lastHeight || 0 };
      })
    }
  );
}

export async function activate(ctx) {
  try {
    const dispI18n = window.zion?.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (dispI18n) ctx.subscriptions.push(dispI18n);
  } catch {}
  const disp = window.zion.editor.registerDecorator({
    id: "dev.sticky-user-header.decorator",
    apply(editor) {
      try {
        if (typeof editor.addVisualExtension === "function") {
          editor.addVisualExtension(stickyUserHeaderView());
        }
      } catch (e) {
        console.error("[dev.sticky-user-header] failed to attach:", e);
      }
      return { dispose() {} };
    }
  });
  ctx.subscriptions.push(disp);

  const toggleCmd = window.zion.commands.registerCommand("stickyHeader.toggle", () => {
    const current = isEnabled();
    const next = !current;
    localStorage.setItem("dev.sticky-user-header.enabled", String(next));
    window.dispatchEvent(new CustomEvent("zion-sticky-user-header-config-changed"));
    console.log("[dev.sticky-user-header] Toggled to:", next);
  });
  ctx.subscriptions.push(toggleCmd);

  // Register editor header menu item
  try {
    const reg = window.zion?.__editorHeaderMenuRegistry;
    if (reg?.register) {
      const menuDisp = reg.register({
        id: "dev.sticky-user-header.menu",
        title: t("ui.headerMenu", "Sticky User Header"),
        section: t("category.editor", "Editor"),
        kind: "toggle",
        order: 48,
        getChecked: () => isEnabled(),
        onClick: () => window.zion.commands.executeCommand("stickyHeader.toggle")
      });
      if (menuDisp) ctx.subscriptions.push(menuDisp);
    }
  } catch {}
}
