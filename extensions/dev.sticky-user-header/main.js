import { ViewPlugin, EditorView } from "@codemirror/view";

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
    // Default to true if not set
    if (val === "false") return false;
    return true;
  } catch {
    return true;
  }
}

function tryGetRolesIndex(prefixes) {
  try {
    const idx = window?.zion?.state?.get?.("roles.index");
    if (!idx || !Array.isArray(idx.blocks) || !Array.isArray(idx.prefixes)) return null;
    if (idx.prefixes.join("\n") !== prefixes.join("\n")) return null;
    return idx;
  } catch {
    return null;
  }
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

function ensureStyle() {
  const id = "dev-sticky-user-header-style";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
.zion-cm-sticky-user-header{position:absolute;top:0;left:0;right:0;z-index:95;background:var(--bg);border-bottom:none;padding:6px 16px;color:var(--fg);font-family:var(--font-sans);font-size:13px;box-shadow:0 1px 2px 0 rgba(0,0,0,0.05);clip-path:inset(0 0 -10px 0);opacity:0.98}
.zion-cm-sticky-user-header{display:flex;flex-direction:column;gap:4px}
.zion-cm-sticky-user-header.is-empty{display:none}
.zion-cm-sticky-user-header .zion-sticky-line{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer}
.zion-cm-sticky-user-header .zion-sticky-badge{display:inline-block;flex:0 0 auto;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600;border:1px solid transparent}
.zion-cm-sticky-user-header .zion-sticky-text{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  `;
  document.head.appendChild(style);
}

function stickyUserHeaderView() {
  const prefixes = getEffectivePrefixes();
  const targetRole = "user";

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        ensureStyle();
        this.view = view;
        this.prefixes = prefixes;
        this.index = tryGetRolesIndex(prefixes) || buildBlocksFromState(view.state, prefixes);
        this.lastKey = "";
        this.lastHeight = 0;
        this.prevScrollerPaddingTop = null;
        this.scrollHandler = this.onScroll.bind(this);
        this.configHandler = () => this.sync();
        window.addEventListener("zion-sticky-user-header-config-changed", this.configHandler);

        const root = view.dom;
        if (root && root.nodeType === 1) {
          const el = root;
          if (getComputedStyle(el).position === "static") el.style.position = "relative";
        }

        this.headerEl = document.createElement("div");
        this.headerEl.className = "zion-cm-sticky-user-header is-empty";
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
        this.sync();
      }

      update(update) {
        this.view = update.view;
        if (update.docChanged) {
          this.index = tryGetRolesIndex(this.prefixes) || buildBlocksFromState(update.view.state, this.prefixes);
        }
        // viewportChanged is not enough for precise sticky behavior, relying on scroll event
        if (update.docChanged || update.viewportChanged) {
          this.sync();
        }
      }

      onScroll() {
        if (this.scrollRaf) window.cancelAnimationFrame(this.scrollRaf);
        this.scrollRaf = window.requestAnimationFrame(() => {
          this.scrollRaf = null;
          this.sync();
        });
      }

      sync() {
        if (!isEnabled()) {
          this.headerEl.classList.add("is-empty");
          this.applyHeight(0);
          return;
        }

        const blocks = this.index?.blocks || [];
        // Calculate the exact document position at the top of the visible viewport
        // viewport.from includes buffer, so we use lineBlockAtHeight with scrollTop
        const scrollTop = this.view.scrollDOM.scrollTop;
        const topBlock = this.view.lineBlockAtHeight(scrollTop);
        const topPos = topBlock.from;

        const curIdx = blocks.length ? findLastIndexLE(blocks, topPos) : -1;

        let userIdx = -1;
        if (curIdx >= 0) {
          if (blocks[curIdx]?.role === targetRole) userIdx = curIdx;
          else userIdx = findPrevRoleIndex(blocks, curIdx, targetRole);
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

        this.headerEl.textContent = "";
        if (!items.length) {
          this.headerEl.classList.add("is-empty");
          this.applyHeight(0);
          return;
        }

        for (const it of items) {
          const line = document.createElement("div");
          line.className = "zion-sticky-line";
          line.setAttribute("data-pos", String(Number(it.pos) || 0));

          const badge = document.createElement("span");
          badge.className = "zion-sticky-badge";
          badge.textContent = it.role;
          const theme = roleTheme(it.role);
          badge.style.color = theme.fg;
          badge.style.background = theme.bg;
          badge.style.borderColor = theme.bd;

          const text = document.createElement("span");
          text.className = "zion-sticky-text";
          const preview = it.preview || "(empty)";
          text.textContent = preview.length > 140 ? preview.slice(0, 137) + "..." : preview;

          line.appendChild(badge);
          line.appendChild(text);
          this.headerEl.appendChild(line);
        }
        this.headerEl.classList.remove("is-empty");

        requestAnimationFrame(() => {
          const h = this.headerEl.offsetHeight || 0;
          this.applyHeight(h);
        });
      }

      applyHeight(h) {
        const scroller = this.view.scrollDOM;
        if (!scroller) return;
        if (this.prevScrollerPaddingTop == null) this.prevScrollerPaddingTop = scroller.style.paddingTop || "";

        const nextH = Math.max(0, Math.floor(h));
        if (nextH === this.lastHeight) return;
        this.lastHeight = nextH;
        scroller.style.paddingTop = nextH ? `${nextH}px` : this.prevScrollerPaddingTop;
      }

      destroy() {
        try {
          if (this.configHandler) window.removeEventListener("zion-sticky-user-header-config-changed", this.configHandler);
          if (this.scrollRaf) window.cancelAnimationFrame(this.scrollRaf);
          if (this.view?.scrollDOM && this.scrollHandler) {
            this.view.scrollDOM.removeEventListener("scroll", this.scrollHandler);
          }
          const scroller = this.view.scrollDOM;
          if (scroller && typeof this.prevScrollerPaddingTop === "string") {
            scroller.style.paddingTop = this.prevScrollerPaddingTop;
          }
        } catch {}
        try { this.headerEl?.remove?.(); } catch {}
      }
    }
  );
}

export async function activate(ctx) {
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
}
