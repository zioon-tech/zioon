import { EditorView, ViewPlugin } from "@codemirror/view";

/**
 * Advanced Minimap ViewPlugin (VS Code-like)
 * - Two-layer canvas: background (token-colored density) + foreground (viewport/selection/cursor/matches/diagnostics)
 * - HiDPI aware, short-doc scaling to reduce bottom blank
 * - Click/drag to navigate; viewport hover highlight
 * - Incremental, chunked drawing via requestIdleCallback with dynamic sampling
 * - Theme-aware via CSS variables; listens to data-theme mutation
 * - Optional search/diagnostics integration via window.zion.state:
 *   - searchReplace.search / .caseSensitive / .regexp / .wholeWord
 *   - editor.diagnostics: { from:number, to:number, severity:'error'|'warning' }[]
 */
export function minimapPlugin(opts = {}) {
  const width = Number(opts.width ?? 120);

  const theme = EditorView.theme({
    "&": { position: "relative", paddingRight: `${width + 8}px` }
  });

  const plugin = ViewPlugin.fromClass(class MinimapView {
    constructor(view) {
      this.view = view;
      this.width = width;

      // state
      this.enabled = !!(window?.zion?.state?.get("ui.minimapEnabled") ?? true);
      this.hover = false;
      this.densityDirty = true;
      this._drawing = false;
      this._drawIndex = 1;
      this._idleHandle = null;
      this._scrollTimer = null;
      this._scheduleTimer = null;
      this.scaledHeightCss = 0;
      // cap per-line height in pixels to avoid huge blocks for short documents
      this.maxLineHeight = 4;

      // precomputed caches
      this.searchRegex = null;
      this.searchMatchLines = new Set(); // Set<number>
      this._searchComputeTimer = null;

      // DOM
      this.container = document.createElement("div");
      this.container.className = "cm-minimap";
      Object.assign(this.container.style, {
        position: "absolute",
        right: "0px",
        top: "0px",
        height: "100%",
        width: `${this.width}px`,
        background: "var(--panel)",
        borderLeft: "1px solid var(--border)",
        boxSizing: "border-box",
        zIndex: "10",
        cursor: "pointer",
        overflow: "hidden"
      });

      // layers
      this.densityCanvas = document.createElement("canvas");
      this.overlayCanvas = document.createElement("canvas");
      this.densityCanvas.style.width = "100%";
      this.overlayCanvas.style.width = "100%";
      this.densityCanvas.style.position = "absolute";
      this.densityCanvas.style.left = "0";
      this.densityCanvas.style.top = "0";
      this.overlayCanvas.style.position = "absolute";
      this.overlayCanvas.style.left = "0";
      this.overlayCanvas.style.top = "0";
      this.overlayCanvas.style.pointerEvents = "none";

      this.container.appendChild(this.densityCanvas);
      this.container.appendChild(this.overlayCanvas);

      // resizer handle (left edge) - allows user to resize minimap width
      this.resizer = document.createElement("div");
      Object.assign(this.resizer.style, {
        position: "absolute",
        left: "-6px",
        top: "0",
        width: "6px",
        height: "100%",
        cursor: "col-resize",
        zIndex: "11"
      });
      this.container.appendChild(this.resizer);

      // offscreen buffer for density
      this.offscreen = document.createElement("canvas");

      // mount
      view.dom.appendChild(this.container);

      // ensure editor content has proper right padding to avoid being hidden by minimap
      try {
        if (this.enabled) {
          this.view.dom.style.paddingRight = `${this.width + 8}px`;
        } else {
          this.view.dom.style.paddingRight = "0px";
        }
      } catch {}

      // attach resizer drag behavior
      this.resizer.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        const startX = ev.clientX;
        const startWidth = this.width;
        // disable selection while dragging
        document.body.style.userSelect = "none";
        const onMove = (e) => {
          const dx = startX - e.clientX;
          // allow a reasonable width range
          const nw = Math.max(60, Math.min(600, Math.round(startWidth + dx)));
          this.width = nw;
          this.container.style.width = `${this.width}px`;
          try { localStorage.setItem('zion.minimap.width', String(this.width)); } catch {}
          try { this.view.dom.style.paddingRight = `${this.width + 8}px`; } catch {}
          this.layout();
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          document.body.style.userSelect = "";
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });

      // observers
      this.resizeObserver = new ResizeObserver(() => this.layout());
      this.resizeObserver.observe(view.dom);

      this.onStateDisp = window?.zion?.state?.onDidChange?.("ui.minimapEnabled", (nv) => {
        this.enabled = !!nv;
        this.container.style.display = this.enabled ? "" : "none";
        try {
          if (this.enabled) {
            this.view.dom.style.paddingRight = `${this.width + 8}px`;
            this.densityDirty = true;
            this.scheduleDensityRedraw(0);
            this.drawOverlay();
          } else {
            this.view.dom.style.paddingRight = "0px";
          }
        } catch {}
      });

      this.themeObserver = new MutationObserver(() => {
        if (!this.enabled) return;
        // Force redraw of both density and overlay when theme changes
        this.drawOverlay();
        this.densityDirty = true;
        this.scheduleDensityRedraw(0);
      });
      this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

      // hover effect with improved cursor feedback
      this.container.addEventListener("mouseenter", () => { 
        this.hover = true; 
        this.drawOverlay(); 
      });
      this.container.addEventListener("mouseleave", () => { 
        this.hover = false; 
        this.drawOverlay(); 
      });
      
      // Update cursor based on position over viewport
      this.container.addEventListener("mousemove", (e) => {
        const overlayRect = this.overlayCanvas.getBoundingClientRect();
        const state = this.view.state;
        const fromLine = state.doc.lineAt(this.view.viewport.from).number;
        const toLine = state.doc.lineAt(this.view.viewport.to).number;
        const totalLines = state.doc.lines;
        const maxLinePx = this.maxLineHeight ?? 4;
        const scale = totalLines > 0 ? Math.min(overlayRect.height / totalLines, maxLinePx) : 1;
        const vy = Math.floor((fromLine - 1) * scale);
        const vh = Math.max(6, Math.floor((toLine - fromLine + 1) * scale));
        
        const relativeY = e.clientY - overlayRect.top;
        const isInViewport = relativeY >= vy && relativeY <= vy + vh;
        
        this.container.style.cursor = isInViewport ? "grab" : "pointer";
      });

      // interactions
      this.container.addEventListener("mousedown", (e) => this.onMouseDown(e));

      // watch search state (optional)
      this.onSearchDisp = [];
      const watchSearchKey = (k) => {
        const d = window?.zion?.state?.onDidChange?.(k, () => this.scheduleSearchRecompute()) || null;
        if (d) this.onSearchDisp.push(d);
      };
      ["searchReplace.search","searchReplace.caseSensitive","searchReplace.regexp","searchReplace.wholeWord"].forEach(watchSearchKey);

      // initial
      this.layout();
      this.container.style.display = this.enabled ? "" : "none";
      try {
        if (this.enabled) {
          this.view.dom.style.paddingRight = `${this.width + 8}px`;
          this.scheduleDensityRedraw(0);
          this.scheduleSearchRecompute(0);
          this.drawOverlay();
        } else {
          this.view.dom.style.paddingRight = "0px";
        }
      } catch {}
    }

    // colors and theme tokens (approximate)
    getColors() {
      const cs = getComputedStyle(document.documentElement);
      const fg = (cs.getPropertyValue("--fg") || "#f8f8f2").trim();
      const border = (cs.getPropertyValue("--border") || "#44475a").trim();
      const accent = (cs.getPropertyValue("--accent") || "#6272a4").trim();
      const ok = (cs.getPropertyValue("--ok") || "#50fa7b").trim();
      const panel = (cs.getPropertyValue("--panel") || "#282a36").trim();

      // determine theme (fallback to dark)
      const themeAttr = document.documentElement.getAttribute("data-theme");
      const isLight = themeAttr === "light";

      // choose a subtle shadow color that respects theme:
      // - light theme: very light black tint
      // - dark theme: slightly stronger black tint
      const shadow = isLight ? "rgba(0,0,0,0.06)" : "rgba(0,0,0,0.15)";

      // soften the "other" text density color to avoid dark lines in light theme
      const baseOther = isLight ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.18)";

      // heading color: accent with higher opacity or a lighter variant
      // 亮色主题下 accent 加深，暗色主题 accent 加亮
      const heading = isLight
        ? "rgba(59,130,246,0.55)" // #3b82f6, 55% 透明
        : "rgba(139,233,253,0.38)"; // #8be9fd, 38% 透明

      return {
        // base
        line: border,
        viewport: accent,
        select: accent,
        cursor: fg,
        match: "#f9e076",
        diagError: "#ff5555",
        diagWarn: "#ffb86c",
        // token colors (heuristic)
        tokKeyword: accent,
        tokString: ok,
        tokNumber: "#ffb86c",
        tokComment: border,
        tokOther: baseOther,
        // minimap background
        background: panel,
        // adaptive shadow for hover depth
        shadow,
        // heading highlight
        heading
      };
    }

    getDPR() { return window.devicePixelRatio || 1; }

    getStep(totalLines) {
      if (totalLines > 20000) return 8;
      if (totalLines > 8000) return 4;
      if (totalLines > 2000) return 2;
      return 1;
    }

    // Layout and sizing with HiDPI and short-doc scaling
    layout() {
      const rect = this.view.dom.getBoundingClientRect();
      const dpr = this.getDPR();

      const totalLines = this.view.state.doc.lines;
      const defaultLH = this.view.defaultLineHeight || 16;
      
      // Calculate minimap height: always match editor container height
      // This ensures minimap spans the full editor height regardless of content length
      this.scaledHeightCss = Math.max(24, rect.height);

      this.densityCanvas.style.height = `${this.scaledHeightCss}px`;
      this.overlayCanvas.style.height = `${this.scaledHeightCss}px`;

      const pixelW = Math.max(1, Math.floor(this.width * dpr));
      const pixelH = Math.max(1, Math.floor(this.scaledHeightCss * dpr));

      this.densityCanvas.width = pixelW;
      this.densityCanvas.height = pixelH;
      this.overlayCanvas.width = pixelW;
      this.overlayCanvas.height = pixelH;

      this.densityCtx = this.densityCanvas.getContext("2d");
      this.overlayCtx = this.overlayCanvas.getContext("2d");
      if (this.densityCtx) this.densityCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this.overlayCtx) this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      this.offscreen.width = pixelW;
      this.offscreen.height = pixelH;
      this.offscreenCtx = this.offscreen.getContext("2d");
      if (this.offscreenCtx) this.offscreenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      this.densityDirty = true;
      if (this.enabled) {
        this.scheduleDensityRedraw(0);
        this.drawOverlay();
      }
    }

    update(update) {
      if (!this.enabled) return;
      if (update.docChanged) {
        this.densityDirty = true;
        this.scheduleDensityRedraw(50);
        // search matches depend on content too
        this.scheduleSearchRecompute(120);
      }
      if (update.viewportChanged || update.selectionSet) {
        this.drawOverlay();
        clearTimeout(this._scrollTimer);
        this._scrollTimer = setTimeout(() => {
          if (!this.enabled) return;
          if (this.densityDirty) this.scheduleDensityRedraw(0);
        }, 150);
      }
    }

    // Build a heuristic token color bar for one line
    drawLineBar(ctx, text, y, h, w, colors) {
      if (!text) return;
      // counts by category
      const len = text.length;
      let cKeyword = 0, cString = 0, cNumber = 0, cComment = 0, cOther = 0;

      // detect // or # line comments (heuristic, ignore quoted)
      let commentIdx = -1;
      const hashIdx = text.trimStart().startsWith("#") ? text.indexOf("#") : -1;
      const slashIdx = text.indexOf("//");
      if (hashIdx === 0) commentIdx = 0;
      else if (slashIdx >= 0) commentIdx = slashIdx;

      // string ranges (very naive: "..." or '...' or `...`)
      const stringRanges = [];
      const pushStrings = (quote) => {
        let i = 0;
        while (i < text.length) {
          const s = text.indexOf(quote, i);
          if (s < 0) break;
          let j = s + 1;
          while (j < text.length) {
            const k = text.indexOf(quote, j);
            if (k < 0) { j = text.length; break; }
            if (text[k - 1] !== "\\") { // naive escape check
              stringRanges.push([s, k + 1]);
              i = k + 1;
              break;
            }
            j = k + 1;
          }
          if (j === text.length) { i = j; }
        }
      };
      pushStrings('"'); pushStrings("'"); pushStrings("`");

      // mask helper
      const covered = new Array(len).fill(0); // 1=string,2=comment
      for (const [a,b] of stringRanges) for (let i=a;i<b && i<len;i++) covered[i]=1;
      if (commentIdx >= 0) for (let i=commentIdx;i<len;i++) covered[i]=2;

      // keyword set (common langs)
      const keywords = /\b(abstract|as|assert|async|await|break|case|catch|class|const|continue|def|default|delete|do|elif|else|enum|export|extends|false|final|finally|for|from|function|global|if|implements|import|in|instanceof|interface|is|let|match|namespace|new|null|package|private|protected|public|return|static|struct|super|switch|this|throw|true|try|type|typeof|var|void|while|with|yield)\b/g;

      // numbers
      const numbers = /\b\d+(\.\d+)?\b/g;

      // count categories
      // strings
      for (const [a,b] of stringRanges) cString += Math.max(0, b - a);
      // comments
      if (commentIdx >= 0) cComment += Math.max(0, len - commentIdx);
      // numbers not in string/comment
      {
        let m;
        while ((m = numbers.exec(text)) !== null) {
          const a = m.index, b = a + m[0].length;
          let ok = true;
          for (let i=a;i<b;i++) if (covered[i]) { ok=false; break; }
          if (ok) cNumber += b - a;
        }
      }
      // keywords not in string/comment
      {
        let m;
        while ((m = keywords.exec(text)) !== null) {
          const a = m.index, b = a + m[0].length;
          let ok = true;
          for (let i=a;i<b;i++) if (covered[i]) { ok=false; break; }
          if (ok) cKeyword += b - a;
        }
      }
      // others
      const used = cString + cComment + cNumber + cKeyword;
      cOther = Math.max(0, len - used);

      const total = Math.max(1, cString + cComment + cNumber + cKeyword + cOther);
      // draw stacked horizontal segments across width
      const parts = [
        [cComment, colors.tokComment],
        [cKeyword, colors.tokKeyword],
        [cString,  colors.tokString],
        [cNumber,  colors.tokNumber],
        [cOther,   colors.tokOther]
      ].filter(([n]) => n > 0);

      let x = 0;
      for (const [n, col] of parts) {
        const ww = Math.max(1, Math.round((n / total) * w));
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.7;
        ctx.fillRect(x, y, ww, h);
        x += ww;
      }
      ctx.globalAlpha = 1;
    }

    // Search handling (optional)
    scheduleSearchRecompute(delay = 60) {
      clearTimeout(this._searchComputeTimer);
      this._searchComputeTimer = setTimeout(() => this.recomputeSearch(), delay);
    }
    buildSearchRegex() {
      const q = (window?.zion?.state?.get?.("searchReplace.search") || "").toString();
      if (!q) return null;
      const cs = !!window?.zion?.state?.get?.("searchReplace.caseSensitive");
      const rx = !!window?.zion?.state?.get?.("searchReplace.regexp");
      const ww = !!window?.zion?.state?.get?.("searchReplace.wholeWord");
      const flags = cs ? "g" : "gi";
      let pattern = q;
      if (!rx) {
        pattern = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      if (ww) pattern = `\\b${pattern}\\b`;
      try {
        return new RegExp(pattern, flags);
      } catch {
        return null;
      }
    }
    recomputeSearch() {
      this.searchRegex = this.buildSearchRegex();
      this.searchMatchLines.clear();
      if (!this.searchRegex) { this.drawOverlay(); return; }

      const doc = this.view.state.doc;
      const total = doc.lines;
      const step = this.getStep(total) === 1 ? 1 : 1; // match最好全量
      for (let i=1;i<=total;i+=step) {
        const text = doc.line(i).text;
        this.searchRegex.lastIndex = 0;
        if (this.searchRegex.test(text)) this.searchMatchLines.add(i);
      }
      this.drawOverlay();
    }

    // Idle, chunked density redraw with token colors
    scheduleDensityRedraw(delay = 0) {
      if (!this.enabled || !this.offscreenCtx || !this.densityCtx) return;

      const rIC = window.requestIdleCallback
        ? (cb, opts) => window.requestIdleCallback(cb, opts)
        : (cb) => setTimeout(() => cb({ timeRemaining: () => 0, didTimeout: true }), 0);
      const cIC = window.cancelIdleCallback ? (h) => window.cancelIdleCallback(h) : (h) => clearTimeout(h);

      const start = () => {
        if (!this.densityDirty || this._drawing) return;
        this._drawing = true;
        this._drawIndex = 1;

        const totalLines = this.view.state.doc.lines;
        const cs = this.getColors();
        const w = this.width;
        const hCss = this.scaledHeightCss;
        const maxLinePx = this.maxLineHeight ?? 4;
        const scale = totalLines > 0 ? Math.min(hCss / totalLines, maxLinePx) : 1;
        const step = this.getStep(totalLines);

        // clear with current theme background
        this.offscreenCtx.globalAlpha = 1;
        this.offscreenCtx.fillStyle = cs.background;
        this.offscreenCtx.fillRect(0, 0, w, hCss);

        const chunk = (deadline) => {
          const timeBudget = 50;
          const t0 = performance.now();
          while (this._drawIndex <= totalLines) {
            const i = this._drawIndex;
            const line = this.view.state.doc.line(i);
            const text = line.text;
            const y = Math.floor((i - 1) * scale);
            const lineHeight = Math.max(1, Math.floor(scale));

            if (text) this.drawLineBar(this.offscreenCtx, text, y, lineHeight, w, cs);

            this._drawIndex += step;

            if ((deadline && deadline.timeRemaining && deadline.timeRemaining() < 4) || performance.now() - t0 > timeBudget) {
              this._idleHandle = rIC(chunk, { timeout: 60 });
              return;
            }
          }

          // blit - clear with current theme background first
          this.densityCtx.fillStyle = cs.background;
          this.densityCtx.fillRect(0, 0, w, hCss);
          this.densityCtx.drawImage(this.offscreen, 0, 0, this.offscreen.width, this.offscreen.height, 0, 0, w, hCss);

          this.densityDirty = false;
          this._drawing = false;
          this._idleHandle = null;

          this.drawOverlay();
        };

        this._idleHandle = rIC(chunk, { timeout: 60 });
      };

      if (this._idleHandle) {
        const h = this._idleHandle;
        this._idleHandle = null;
        cIC(h);
        this._drawing = false;
      }

      if (delay > 0) {
        clearTimeout(this._scheduleTimer);
        this._scheduleTimer = setTimeout(start, delay);
      } else {
        start();
      }
    }

    // Overlay drawing: viewport, selections, cursor, search matches, diagnostics
    drawOverlay() {
      if (!this.overlayCtx) return;

      const cs = this.getColors();
      const view = this.view;
      const state = view.state;
      const totalLines = state.doc.lines;

      const w = this.width;
      const hCss = this.scaledHeightCss;
      // Scale factor: map document lines to minimap pixels
      // Cap per-line pixel height so short documents don't produce huge blocks.
      const maxLinePx = this.maxLineHeight ?? 4;
      const scale = totalLines > 0 ? Math.min(hCss / totalLines, maxLinePx) : 1;

      // Clear with transparent background (overlay sits on top of density canvas)
      this.overlayCtx.clearRect(0, 0, w, hCss);

      // --- Highlight markdown headings ---
      try {
        // Use a simple regex to find heading lines: starts with #, up to 6
        const doc = state.doc;
        for (let i = 1; i <= totalLines; i++) {
          const line = doc.line(i);
          const text = line.text;
          if (/^#{1,6}\s+/.test(text)) {
            // Heading line: highlight with heading color and higher opacity
            const y = Math.floor((i - 1) * scale);
            const h = Math.max(2, Math.floor(scale));
            this.overlayCtx.fillStyle = cs.heading;
            this.overlayCtx.globalAlpha = 0.45;
            this.overlayCtx.fillRect(0, y, w, h);
          }
        }
        this.overlayCtx.globalAlpha = 1;
      } catch {}

      // Search matches (per-line tick marks, on the right)
      if (this.searchMatchLines && this.searchMatchLines.size > 0) {
        this.overlayCtx.fillStyle = cs.match;
        this.overlayCtx.globalAlpha = 0.8;
        const tickW = Math.max(2, Math.floor(w * 0.14));
        for (const ln of this.searchMatchLines) {
          const y = Math.floor((ln - 1) * scale);
          const h = Math.max(2, Math.floor(scale));
          this.overlayCtx.fillRect(w - tickW, y, tickW, h);
        }
        this.overlayCtx.globalAlpha = 1;
      }

      // Diagnostics (optional via state: editor.diagnostics)
      try {
        const diags = window?.zion?.state?.get?.("editor.diagnostics") || [];
        if (Array.isArray(diags) && diags.length) {
          const tick = Math.max(2, Math.floor(w * 0.18));
          for (const d of diags) {
            const fromL = state.doc.lineAt(Math.max(0, d.from || 0)).number;
            const toL = state.doc.lineAt(Math.max(0, d.to || d.from || 0)).number;
            const y = Math.floor((fromL - 1) * scale);
            const h = Math.max(2, Math.floor((toL - fromL + 1) * scale));
            this.overlayCtx.fillStyle = d.severity === "warning" ? cs.diagWarn : cs.diagError;
            this.overlayCtx.globalAlpha = 0.9;
            this.overlayCtx.fillRect(w - tick, y, tick, h);
          }
          this.overlayCtx.globalAlpha = 1;
        }
      } catch {}

      // Selections
      const sels = state.selection.ranges;
      if (sels && sels.length) {
        this.overlayCtx.fillStyle = cs.select;
        this.overlayCtx.globalAlpha = 0.18;
        for (const r of sels) {
          const a = Math.min(r.from, r.to);
          const b = Math.max(r.from, r.to);
          if (a === b) continue;
          const fromLine = state.doc.lineAt(a).number;
          const toLine = state.doc.lineAt(b).number;
          const y = Math.floor((fromLine - 1) * scale);
          const h = Math.max(2, Math.floor((toLine - fromLine + 1) * scale));
          this.overlayCtx.fillRect(0, y, w, h);
        }
        this.overlayCtx.globalAlpha = 1;
      }

      // Cursor line
      const head = state.selection.main.head;
      const curLine = state.doc.lineAt(head).number;
      const cy = Math.floor((curLine - 1) * scale);
      const ch = Math.max(1, Math.floor(scale));
      this.overlayCtx.fillStyle = cs.cursor;
      this.overlayCtx.globalAlpha = 0.5;
      this.overlayCtx.fillRect(0, cy, w, Math.min(2, ch));
      this.overlayCtx.globalAlpha = 1;

      // Viewport rectangle with improved visual styling
      const fromLine = state.doc.lineAt(view.viewport.from).number;
      const toLine = state.doc.lineAt(view.viewport.to).number;
      const vy = Math.floor((fromLine - 1) * scale);
      const vh = Math.max(6, Math.floor((toLine - fromLine + 1) * scale));

      // Draw viewport background
      this.overlayCtx.globalAlpha = this.hover ? 0.25 : 0.18;
      this.overlayCtx.fillStyle = cs.viewport;
      this.overlayCtx.fillRect(0, vy, w, vh);
      
      // Draw viewport border
      this.overlayCtx.globalAlpha = this.hover ? 0.8 : 0.6;
      this.overlayCtx.strokeStyle = cs.viewport;
      this.overlayCtx.lineWidth = this.hover ? 2 : 1;
      this.overlayCtx.strokeRect(0.5, vy + 0.5, w - 1, vh - 1);
      
      // Add subtle shadow for depth
      if (this.hover) {
        // use adaptive shadow color from theme-aware palette
        this.overlayCtx.globalAlpha = 1;
        this.overlayCtx.fillStyle = cs.shadow;
        this.overlayCtx.fillRect(2, vy + 2, w, vh);
      }
      
      this.overlayCtx.globalAlpha = 1;
    }

    // Pointer → line mapping with viewport-centering and viewport dragging
    onMouseDown(e) {
      e.preventDefault();

      const overlayRect = this.overlayCanvas.getBoundingClientRect();
      const getViewportLines = () => {
        const s = this.view.state;
        const fromLine = s.doc.lineAt(this.view.viewport.from).number;
        const toLine = s.doc.lineAt(this.view.viewport.to).number;
        return Math.max(1, toLine - fromLine + 1);
      };
      const totalLines = () => this.view.state.doc.lines;

      const toLineAt = (clientY) => {
        const tl = totalLines();
        const hCss = overlayRect.height;
        const vLines = getViewportLines();
        const linePerPx = tl > 0 ? tl / hCss : 1;

        // aim to center viewport at click
        const viewportPx = Math.max(6, vLines / Math.max(1, linePerPx));
        const effectiveH = Math.max(1, hCss - viewportPx);
        let ratio = (clientY - overlayRect.top - viewportPx / 2) / effectiveH;
        if (isNaN(ratio)) ratio = 0;
        ratio = Math.max(0, Math.min(1, ratio));

        const effectiveLines = Math.max(0, tl - vLines);
        let topLine = Math.round(ratio * effectiveLines) + 1;
        if (topLine < 1) topLine = 1;
        if (topLine > tl) topLine = tl;
        return topLine;
      };

      // Check if click is inside viewport rectangle for dragging
      const state = this.view.state;
      const fromLine = state.doc.lineAt(this.view.viewport.from).number;
      const toLine = state.doc.lineAt(this.view.viewport.to).number;
      const maxLinePx = this.maxLineHeight ?? 4;
      const scale = totalLines() > 0 ? Math.min(overlayRect.height / totalLines(), maxLinePx) : 1;
      const vy = Math.floor((fromLine - 1) * scale);
      const vh = Math.max(6, Math.floor((toLine - fromLine + 1) * scale));
      
      const relativeY = e.clientY - overlayRect.top;
      const isInViewport = relativeY >= vy && relativeY <= vy + vh;

      if (isInViewport) {
        // Drag viewport mode
        const startY = e.clientY;
        const startTopLine = fromLine;
        
        const onMove = (ev) => {
          const deltaY = ev.clientY - startY;
          const deltaLines = Math.round(deltaY / scale);
          const newTopLine = Math.max(1, Math.min(totalLines() - getViewportLines() + 1, startTopLine + deltaLines));
          
          if (newTopLine !== startTopLine) {
            const pos = this.view.state.doc.line(newTopLine).from;
            this.view.dispatch({ 
              selection: { anchor: pos },
              scrollIntoView: true
            });
            this.drawOverlay();
          }
        };

        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          this.container.style.cursor = "pointer";
        };

        this.container.style.cursor = "grabbing";
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      } else {
        // Jump to position mode
        const goToClientY = (clientY) => {
          const line = toLineAt(clientY);
          const pos = this.view.state.doc.line(line).from;
          this.view.dispatch({ 
            selection: { anchor: pos },
            scrollIntoView: true
          });
          this.view.focus();
          this.drawOverlay();
        };

        const onMove = (ev) => goToClientY(ev.clientY);
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };

        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        goToClientY(e.clientY);
      }
    }

    destroy() {
      try { this.resizeObserver?.disconnect?.(); } catch {}
      try { this.onStateDisp?.dispose?.(); } catch {}
      try { this.themeObserver?.disconnect?.(); } catch {}
      if (this.onSearchDisp && this.onSearchDisp.length) {
        for (const d of this.onSearchDisp) { try { d.dispose?.(); } catch {} }
      }
      if (this._idleHandle) {
        const cIC = window.cancelIdleCallback ? (h) => window.cancelIdleCallback(h) : (h) => clearTimeout(h);
        try { cIC(this._idleHandle); } catch {}
        this._idleHandle = null;
      }
      try { clearTimeout(this._scrollTimer); } catch {}
      try { clearTimeout(this._scheduleTimer); } catch {}
      try { clearTimeout(this._searchComputeTimer); } catch {}
      try { this.container.remove(); } catch {}
    }
  });

  return [theme, plugin];
}