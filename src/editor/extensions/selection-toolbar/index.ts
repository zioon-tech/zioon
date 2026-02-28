import { Extension, EditorSelection, type ChangeSpec } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate, keymap } from "@codemirror/view";

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

function runSelectionAI() {
  try {
    (window as any).zion?.commands?.executeCommand?.("chat.runSelection");
  } catch {}
}

function mkBtn(text: string, title: string, onClick: () => void) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.style.background = "transparent";
  b.style.color = "var(--fg)";
  b.style.border = "none";
  b.style.borderRadius = "8px";
  b.style.padding = "6px 8px";
  b.style.cursor = "pointer";
  b.style.fontSize = "12px";
  b.style.lineHeight = "1";
  b.onmouseenter = () => { b.style.background = "var(--border)"; };
  b.onmouseleave = () => { b.style.background = "transparent"; };
  b.onclick = (e) => {
    try { e.preventDefault(); e.stopPropagation(); } catch {}
    onClick();
  };
  return b;
}

function shouldShowToolbar(view: EditorView): boolean {
  try {
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
  const plugin = ViewPlugin.fromClass(
    class {
      view: EditorView;
      el: HTMLDivElement;
      lastVisible = false;
      raf = 0;

      constructor(view: EditorView) {
        this.view = view;

        const parent = view.dom.parentElement;
        if (parent && getComputedStyle(parent).position === "static") {
          parent.style.position = "relative";
        }

        this.el = document.createElement("div");
        this.el.style.position = "absolute";
        this.el.style.zIndex = "1000";
        this.el.style.display = "none";
        this.el.style.background = "var(--panel)";
        this.el.style.border = "1px solid var(--border)";
        this.el.style.borderRadius = "10px";
        this.el.style.boxShadow = "0 6px 18px rgba(0,0,0,0.22)";
        this.el.style.padding = "4px";
        this.el.style.gap = "2px";
        this.el.style.alignItems = "center";
        this.el.style.whiteSpace = "nowrap";
        this.el.style.userSelect = "none";
        this.el.style.backdropFilter = "blur(6px)";
        this.el.style.pointerEvents = "auto";
        this.el.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
        this.el.style.fontSize = "12px";
        const bold = mkBtn("B", "Bold (⌘B)", () => toggleWrapMarker(this.view, "**"));
        bold.style.fontWeight = "700";
        const italic = mkBtn("I", "Italic (⌘I)", () => toggleWrapMarker(this.view, "*"));
        italic.style.fontStyle = "italic";
        const strike = mkBtn("S", "Strikethrough (⇧⌘X)", () => toggleWrapMarker(this.view, "~~"));
        strike.style.textDecoration = "line-through";
        const sep = document.createElement("span");
        sep.textContent = "·";
        sep.style.opacity = "0.5";
        sep.style.padding = "0 4px";
        const ai = mkBtn("AI", "AI with selection", () => runSelectionAI());
        ai.style.fontWeight = "600";

        this.el.append(bold, italic, strike, sep, ai);
        parent?.appendChild(this.el);

        this.el.onmousedown = (e) => {
          try { e.preventDefault(); e.stopPropagation(); } catch {}
        };
      }

      private scheduleUpdate() {
        if (this.raf) return;
        this.raf = requestAnimationFrame(() => {
          this.raf = 0;
          this.updatePosition();
        });
      }

      private updatePosition() {
        const view = this.view;
        const parent = view.dom.parentElement;
        if (!parent) return;

        const visible = shouldShowToolbar(view);
        this.lastVisible = visible;
        if (!visible) {
          this.el.style.display = "none";
          return;
        }

        const sel = view.state.selection.main;
        const headPos = Math.min(sel.from + Math.floor((sel.to - sel.from) / 2), sel.to);
        const coords = view.coordsAtPos(headPos);
        if (!coords) {
          this.el.style.display = "none";
          return;
        }

        const parentRect = parent.getBoundingClientRect();
        const elRect = this.el.getBoundingClientRect();

        let left = coords.left - parentRect.left - elRect.width / 2;
        const top = coords.top - parentRect.top - elRect.height - 10;

        const minLeft = 8;
        const maxLeft = Math.max(minLeft, parentRect.width - elRect.width - 8);
        left = Math.max(minLeft, Math.min(maxLeft, left));

        const finalTop = Math.max(8, top);
        this.el.style.left = `${Math.round(left)}px`;
        this.el.style.top = `${Math.round(finalTop)}px`;
        this.el.style.display = "flex";
      }

      update(update: ViewUpdate) {
        if (update.selectionSet || update.focusChanged || update.docChanged || update.viewportChanged) {
          this.scheduleUpdate();
        }
      }

      destroy() {
        try { if (this.raf) cancelAnimationFrame(this.raf); } catch {}
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
