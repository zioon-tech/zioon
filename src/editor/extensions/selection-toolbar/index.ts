import { Extension, EditorSelection, type ChangeSpec } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate, keymap } from "@codemirror/view";

type SelectionToolbarItem = {
  id: string;
  order?: number;
  title?: string;
  label?: string;
  codicon?: string;
  when?: (ctx: SelectionToolbarContext) => boolean;
  run?: (ctx: SelectionToolbarContext & { anchorEl: HTMLElement; event?: Event }) => void;
  render?: (ctx: SelectionToolbarContext & { anchorEl: HTMLElement; event?: Event }) => HTMLElement;
};

type SelectionToolbarContext = {
  view: EditorView;
  selectionText: string;
  from: number;
  to: number;
};

function getSelectionToolbarRegistry(): {
  registerItem: (item: SelectionToolbarItem) => { dispose: () => void };
  list: () => SelectionToolbarItem[];
  onDidChange: (fn: () => void) => { dispose: () => void };
} {
  const z = (window as any).zion || ((window as any).zion = {});
  if (z.__selectionToolbarRegistry) return z.__selectionToolbarRegistry;
  const items = new Map<string, SelectionToolbarItem>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const fn of Array.from(listeners)) {
      try {
        fn();
      } catch {}
    }
  };
  const registry = {
    registerItem(item: SelectionToolbarItem) {
      if (!item?.id) return { dispose: () => {} };
      items.set(item.id, item);
      emit();
      return {
        dispose: () => {
          items.delete(item.id);
          emit();
        }
      };
    },
    list() {
      return Array.from(items.values()).sort((a, b) => {
        const ao = typeof a.order === "number" ? a.order : 50;
        const bo = typeof b.order === "number" ? b.order : 50;
        if (ao !== bo) return ao - bo;
        return String(a.id).localeCompare(String(b.id));
      });
    },
    onDidChange(fn: () => void) {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    }
  };
  z.__selectionToolbarRegistry = registry;
  return registry;
}

function exposeSelectionToolbarApi() {
  const z = (window as any).zion;
  if (!z) return;
  const reg = getSelectionToolbarRegistry();
  if (!z.editor) z.editor = {};
  if (!z.editor.selectionToolbar) z.editor.selectionToolbar = {};
  if (!z.editor.selectionToolbar.registerItem) z.editor.selectionToolbar.registerItem = reg.registerItem;
  if (!z.editor.selectionToolbar.list) z.editor.selectionToolbar.list = reg.list;
  if (!z.editor.selectionToolbar.onDidChange) z.editor.selectionToolbar.onDidChange = reg.onDidChange;
}

function toggleWrapMarker(view: EditorView, marker: string): boolean {
  const state = view.state;
  const markerLen = marker.length;
  const ranges = [...state.selection.ranges].sort((a, b) => b.from - a.from);

  const changes: ChangeSpec[] = [];
  const nextRanges: { anchor: number; head: number }[] = [];

  for (const r of ranges) {
    const from = r.from;
    const to = r.to;

    if (from === to) {
      changes.push({ from, to, insert: marker + marker });
      nextRanges.push({ anchor: from + markerLen, head: from + markerLen });
      continue;
    }

    const beforeFrom = Math.max(0, from - markerLen);
    const afterTo = Math.min(state.doc.length, to + markerLen);
    const hasLeft = beforeFrom < from && state.sliceDoc(beforeFrom, from) === marker;
    const hasRight = afterTo > to && state.sliceDoc(to, afterTo) === marker;

    if (hasLeft && hasRight) {
      changes.push({ from: to, to: afterTo, insert: "" });
      changes.push({ from: beforeFrom, to: from, insert: "" });
      nextRanges.push({ anchor: from - markerLen, head: to - markerLen });
    } else {
      changes.push({ from: to, to, insert: marker });
      changes.push({ from, to: from, insert: marker });
      nextRanges.push({ anchor: from + markerLen, head: to + markerLen });
    }
  }

  if (!changes.length) return false;
  const selection = EditorSelection.create(
    nextRanges.map(r => EditorSelection.range(r.anchor, r.head)),
    Math.max(0, nextRanges.length - 1)
  );
  view.dispatch({ changes, selection, scrollIntoView: true });
  view.focus();
  return true;
}

function runSelectionAI(view: EditorView) {
  try {
    const editor = (window as any).zion?.editor?.getEditorForView?.(view);
    if (editor) {
      (window as any).zion?.commands?.executeCommand?.("chat.runSelection", {
        editor,
        panelId: editor.panelId || null,
        sessionId: editor.sessionId || null
      });
      return;
    }
    (window as any).zion?.commands?.executeCommand?.("chat.runSelection");
  } catch {}
}

function mkBtn(opts: { title: string; onClick: () => void; label?: string; codicon?: string; kind?: "default" | "ai" }) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `zion-selection-toolbar-btn${opts.kind === "ai" ? " is-ai" : ""}`;
  b.title = opts.title;
  b.setAttribute("aria-label", opts.title);
  if (opts.codicon) {
    const icon = document.createElement("span");
    icon.className = `codicon codicon-${opts.codicon}`;
    icon.setAttribute("aria-hidden", "true");
    b.appendChild(icon);
  } else {
    b.textContent = opts.label || "";
  }
  b.onclick = (e) => {
    try { e.preventDefault(); e.stopPropagation(); } catch {}
    opts.onClick();
  };
  return b;
}

function shouldShowToolbar(view: EditorView): boolean {
  try {
    const suppressUntil = Number((window as any).zion?.state?.get?.("selectionToolbar.suppressUntil") || 0);
    if (suppressUntil && Date.now() < suppressUntil) return false;
    if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
    const sel = view.state.selection.main;
    if (sel.empty) return false;
    if (!(view.dom.contains(document.activeElement) || view.hasFocus)) return false;
    const text = view.state.sliceDoc(sel.from, sel.to);
    if (!text || !text.trim()) return false;
    return true;
  } catch {
    return false;
  }
}

export function selectionToolbarExtension(): Extension {
  exposeSelectionToolbarApi();
  const registry = getSelectionToolbarRegistry();
  const plugin = ViewPlugin.fromClass(
    class {
      view: EditorView;
      el: HTMLDivElement;
      lastVisible = false;
      raf = 0;
      showTimer = 0;
      pointerDown = false;
      pointerDownAt: { x: number; y: number } | null = null;
      lastPointerUpAt: { x: number; y: number } | null = null;
      lastPointerDir: "up" | "down" | null = null;
      lastPointerAtMs = 0;
      onPointerDown: ((e: PointerEvent) => void) | null = null;
      onPointerUp: ((e: PointerEvent) => void) | null = null;
      onWindowBlur: (() => void) | null = null;
      regDisp: { dispose: () => void } | null = null;
      buttonsWrap: HTMLDivElement;

      constructor(view: EditorView) {
        this.view = view;

        const parent = view.dom.parentElement;
        if (parent && getComputedStyle(parent).position === "static") {
          parent.style.position = "relative";
        }

        this.el = document.createElement("div");
        this.el.className = "zion-selection-toolbar";

        this.buttonsWrap = document.createElement("div");
        this.buttonsWrap.style.display = "inline-flex";
        this.buttonsWrap.style.alignItems = "center";
        this.buttonsWrap.style.gap = "6px";
        this.el.appendChild(this.buttonsWrap);
        this.renderButtons();
        parent?.appendChild(this.el);

        this.el.onmousedown = (e) => {
          try { e.preventDefault(); e.stopPropagation(); } catch {}
        };

        this.onPointerDown = (e: PointerEvent) => {
          if (e.button !== 0) return;
          this.pointerDown = true;
          this.pointerDownAt = { x: e.clientX, y: e.clientY };
          try { this.el.classList.remove("is-visible"); } catch {}
          try {
            if (this.showTimer) window.clearTimeout(this.showTimer);
            this.showTimer = 0;
          } catch {}
        };
        this.onPointerUp = (e: PointerEvent) => {
          if (!this.pointerDown) return;
          this.pointerDown = false;
          this.lastPointerUpAt = { x: e.clientX, y: e.clientY };
          const fromY = this.pointerDownAt?.y;
          const toY = e.clientY;
          if (typeof fromY === "number" && isFinite(fromY) && typeof toY === "number" && isFinite(toY)) {
            this.lastPointerDir = toY >= fromY ? "down" : "up";
          } else {
            this.lastPointerDir = null;
          }
          this.lastPointerAtMs = Date.now();
          this.pointerDownAt = null;
          this.scheduleUpdate(true);
        };
        this.onWindowBlur = () => {
          try { this.el.classList.remove("is-visible"); } catch {}
          try { this.el.style.visibility = ""; } catch {}
          try {
            if (this.showTimer) window.clearTimeout(this.showTimer);
            this.showTimer = 0;
          } catch {}
        };
        try {
          view.dom.addEventListener("pointerdown", this.onPointerDown, true);
          window.addEventListener("pointerup", this.onPointerUp, true);
          window.addEventListener("pointercancel", this.onPointerUp, true);
          window.addEventListener("blur", this.onWindowBlur, true);
        } catch {}

        try {
          this.regDisp = registry.onDidChange(() => {
            this.renderButtons();
            this.scheduleUpdate(true);
          });
        } catch {}
      }

      private buildCtx(): SelectionToolbarContext | null {
        try {
          const sel = this.view.state.selection.main;
          if (sel.empty) return null;
          const selectionText = this.view.state.sliceDoc(sel.from, sel.to);
          return { view: this.view, selectionText, from: sel.from, to: sel.to };
        } catch {
          return null;
        }
      }

      private renderButtons() {
        const wrap = this.buttonsWrap;
        wrap.innerHTML = "";
        const ctxBase = this.buildCtx();

        const ai = mkBtn({
          title: "AI with selection",
          onClick: () => runSelectionAI(this.view),
          label: "AI"
        });
        const divider = document.createElement("span");
        divider.className = "zion-selection-toolbar-divider";
        const bold = mkBtn({ title: "Bold (⌘B)", onClick: () => toggleWrapMarker(this.view, "**"), codicon: "bold" });
        const italic = mkBtn({ title: "Italic (⌘I)", onClick: () => toggleWrapMarker(this.view, "*"), codicon: "italic" });
        const strike = mkBtn({ title: "Strikethrough (⇧⌘X)", onClick: () => toggleWrapMarker(this.view, "~~"), label: "S" });
        strike.classList.add("is-strike");

        wrap.append(ai, divider, bold, italic, strike);

        const extra = registry.list();
        const effective = ctxBase
          ? extra.filter(it => {
              try {
                return typeof it.when === "function" ? !!it.when(ctxBase) : true;
              } catch {
                return false;
              }
            })
          : [];
        if (!effective.length) return;

        const divider2 = document.createElement("span");
        divider2.className = "zion-selection-toolbar-divider";
        wrap.appendChild(divider2);

        for (const it of effective) {
          const anchor = document.createElement("span");
          anchor.style.display = "inline-flex";
          anchor.style.position = "relative";
          const mkCtx = (event?: Event) => ({ ...(ctxBase as SelectionToolbarContext), anchorEl: anchor as any, event });

          let node: HTMLElement | null = null;
          if (typeof it.render === "function") {
            try {
              node = it.render(mkCtx());
            } catch {
              node = null;
            }
          }
          if (!node) {
            node = mkBtn({
              title: it.title || it.label || it.id,
              label: it.label || "",
              codicon: it.codicon,
              onClick: () => {
                try {
                  it.run?.(mkCtx());
                } catch {}
              }
            });
          } else {
            node.onmousedown = (e) => {
              try { e.preventDefault(); e.stopPropagation(); } catch {}
            };
            node.onclick = (e) => {
              try { e.preventDefault(); e.stopPropagation(); } catch {}
              try { it.run?.(mkCtx(e)); } catch {}
            };
          }

          anchor.appendChild(node);
          wrap.appendChild(anchor);
        }
      }

      private scheduleUpdate(immediate = false) {
        if (this.raf) return;
        this.raf = requestAnimationFrame(() => {
          this.raf = 0;
          if (immediate) this.updatePosition();
          else this.updatePositionDebounced();
        });
      }

      private updatePositionDebounced() {
        try {
          if (this.showTimer) window.clearTimeout(this.showTimer);
          this.showTimer = window.setTimeout(() => {
            this.showTimer = 0;
            this.updatePosition();
          }, 140);
        } catch {
          this.updatePosition();
        }
      }

      private updatePosition() {
        const view = this.view;
        const parent = view.dom.parentElement;
        if (!parent) return;

        if (this.pointerDown) {
          this.el.classList.remove("is-visible");
          this.el.style.visibility = "";
          return;
        }

        const visible = shouldShowToolbar(view);
        this.lastVisible = visible;
        if (!visible) {
          this.el.classList.remove("is-visible");
          this.el.style.visibility = "";
          return;
        }

        this.renderButtons();

        const sel = view.state.selection.main;
        const fromCoords = view.coordsAtPos(sel.from);
        const toCoords = view.coordsAtPos(sel.to);
        const midPos = Math.min(sel.from + Math.floor((sel.to - sel.from) / 2), sel.to);
        const midCoords = view.coordsAtPos(midPos);
        const a = fromCoords || midCoords;
        const b = toCoords || midCoords;
        if (!a || !b) {
          this.el.classList.remove("is-visible");
          this.el.style.visibility = "";
          return;
        }

        const parentRect = parent.getBoundingClientRect();
        const wasVisible = this.el.classList.contains("is-visible");
        if (!wasVisible) {
          this.el.style.visibility = "hidden";
          this.el.classList.add("is-visible");
        }
        const elRect = this.el.getBoundingClientRect();

        const selLeft = Math.min(a.left, b.left);
        const selRight = Math.max(a.right, b.right);
        const selTop = Math.min(a.top, b.top);
        const selBottom = Math.max(a.bottom, b.bottom);
        const centerX = (selLeft + selRight) / 2;

        const margin = 10;
        const topAbove = selTop - elRect.height - margin;
        const topBelow = selBottom + margin;
        const minTop = 8;
        const maxTop = Math.max(minTop, parentRect.height - elRect.height - 8);

        const fits = (globalTop: number) =>
          globalTop >= parentRect.top + minTop && globalTop + elRect.height <= parentRect.bottom - 8;

        const recentPointer = this.lastPointerAtMs && Date.now() - this.lastPointerAtMs < 1200;
        const preferBelow = recentPointer ? this.lastPointerDir === "down" : topAbove < parentRect.top + minTop;

        const preferredTop = preferBelow ? topBelow : topAbove;
        const alternateTop = preferBelow ? topAbove : topBelow;

        let topPx = 0;
        if (fits(preferredTop)) {
          topPx = Math.round(preferredTop - parentRect.top);
        } else if (fits(alternateTop)) {
          topPx = Math.round(alternateTop - parentRect.top);
        } else {
          topPx = Math.max(minTop, Math.min(maxTop, Math.round(preferredTop - parentRect.top)));
        }

        const minLeft = 8;
        const maxLeft = Math.max(minLeft, parentRect.width - elRect.width - 8);
        const anchorX = recentPointer && this.lastPointerUpAt?.x ? this.lastPointerUpAt.x : centerX;
        let left = anchorX - parentRect.left - elRect.width / 2;
        left = Math.max(minLeft, Math.min(maxLeft, Math.round(left)));

        this.el.style.left = `${left}px`;
        this.el.style.top = `${topPx}px`;
        this.el.style.visibility = "";
        this.el.classList.add("is-visible");
      }

      update(update: ViewUpdate) {
        if (update.selectionSet) {
          this.scheduleUpdate(false);
          return;
        }
        if (update.focusChanged || update.docChanged || update.viewportChanged) {
          this.scheduleUpdate(true);
        }
      }

      destroy() {
        try { if (this.raf) cancelAnimationFrame(this.raf); } catch {}
        try { if (this.showTimer) window.clearTimeout(this.showTimer); } catch {}
        try { this.showTimer = 0; } catch {}
        try { this.regDisp?.dispose(); } catch {}
        try {
          if (this.onPointerDown) this.view.dom.removeEventListener("pointerdown", this.onPointerDown, true);
          if (this.onPointerUp) {
            window.removeEventListener("pointerup", this.onPointerUp, true);
            window.removeEventListener("pointercancel", this.onPointerUp, true);
          }
          if (this.onWindowBlur) window.removeEventListener("blur", this.onWindowBlur, true);
        } catch {}
        try { this.el.remove(); } catch {}
      }
    }
  );

  return [
    plugin,
    keymap.of([
      { key: "Mod-b", run: (view) => toggleWrapMarker(view, "**") },
      { key: "Mod-i", run: (view) => toggleWrapMarker(view, "*") },
      { key: "Mod-Shift-x", run: (view) => toggleWrapMarker(view, "~~") }
    ])
  ];
}
