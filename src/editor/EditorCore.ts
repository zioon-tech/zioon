import { EditorState, EditorSelection, Compartment, Prec, Transaction, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
  scrollPastEnd,
  type ViewUpdate
} from "@codemirror/view";
import { history, historyKeymap, defaultKeymap, indentWithTab, indentLess, insertNewlineAndIndent } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";
import { indentOnInput } from "@codemirror/language";
import { foldGutter } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { acceptCompletion, completionKeymap } from "@codemirror/autocomplete";
import { getAutocompletionExtension } from "./extensions/autocompletion";
import { getRenderedLineVisibleCursorPos, wysiwyg } from "./wysiwyg";
import { EditorView as CMEditorView } from "@codemirror/view";
import { showMinimap } from "@replit/codemirror-minimap";
import { selectionMatchHighlighter } from "./extensions/selection-match-layer";
import { linkDetector, linkStyles } from "./link-detector";
import { autocompleteTheme } from "./extensions/autocompletion/AutocompleteTheme";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { selectionToolbarExtension } from "./extensions/selection-toolbar";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import { inlineWidgetDecorationsExtension } from "./inlineWidgets";
import { obsidianSyntaxExtension } from "./extensions/obsidian";
import { roleScopedFencedCode } from "./roleScopedMarkdown";
import { imageInsertionExtension } from "./image-transactions";

function selectNextOccurrenceDown(view: EditorView): boolean {
  const { state } = view;
  const main = state.selection.main;

  if (main.empty) {
    const word = state.wordAt(main.head);
    if (!word) return false;
    view.dispatch({ selection: { anchor: word.from, head: word.to }, scrollIntoView: true });
    return true;
  }

  const query = state.sliceDoc(main.from, main.to);
  if (!query) return false;

  const docText = state.doc.toString();
  const ranges = state.selection.ranges;
  const ordered = [...ranges].sort((a, b) => a.from - b.from);
  const startPos = ordered[ordered.length - 1]?.to ?? main.to;
  const existingStarts = new Set(ranges.map(r => r.from));

  let idx = docText.indexOf(query, startPos);
  if (idx === -1) idx = docText.indexOf(query, 0);
  if (idx === -1) return false;

  let guard = 0;
  while (idx !== -1 && existingStarts.has(idx) && guard < 2000) {
    idx = docText.indexOf(query, idx + 1);
    guard++;
  }
  if (idx === -1 || existingStarts.has(idx)) return false;

  const nextRanges = [...ranges, EditorSelection.range(idx, idx + query.length)].sort((a, b) => a.from - b.from);
  const selection = EditorSelection.create(nextRanges, nextRanges.length - 1);
  view.dispatch({ selection, scrollIntoView: true });
  return true;
}

function getDocPositionVisibility(view: EditorView, pos: number, margin = 24) {
  try {
    const scrollDOM = view.scrollDOM;
    const block = view.lineBlockAt(Math.max(0, Math.min(view.state.doc.length, pos)));
    const viewportTop = scrollDOM.scrollTop;
    const viewportBottom = viewportTop + scrollDOM.clientHeight;
    return {
      fullyVisible: block.top >= viewportTop && block.bottom <= viewportBottom,
      comfortablyVisible: block.top >= viewportTop + margin && block.bottom <= viewportBottom - margin,
      blockTop: block.top,
      blockBottom: block.bottom,
      viewportTop,
      viewportBottom
    };
  } catch {
    return null;
  }
}

function forceScrollDocBoundary(view: EditorView, pos: number): void {
  try {
    const scrollDOM = view.scrollDOM;
    const maxTop = Math.max(0, scrollDOM.scrollHeight - scrollDOM.clientHeight);
    const targetTop = pos <= 0 ? 0 : maxTop;
    scrollDOM.scrollTo?.({ top: targetTop, behavior: "auto" });
    scrollDOM.scrollTop = targetTop;
    requestAnimationFrame(() => {
      try {
        scrollDOM.scrollTo?.({ top: targetTop, behavior: "auto" });
        scrollDOM.scrollTop = targetTop;
      } catch {}
    });
  } catch {}
}

function moveSelectionToDocBoundary(view: EditorView, head: number, extend = false): boolean {
  const pos = Math.max(0, Math.min(view.state.doc.length, head));
  const selectionPos = !extend && pos <= 0
    ? Math.max(pos, getRenderedLineVisibleCursorPos(view, 1) ?? pos)
    : pos;
  const main = view.state.selection.main;
  const selection = extend
    ? EditorSelection.create([EditorSelection.range(main.anchor, pos)])
    : EditorSelection.create([EditorSelection.cursor(selectionPos)]);
  const beforeVisibility = getDocPositionVisibility(view, pos);
  const isStartBoundary = pos <= 0;
  view.focus();
  if (beforeVisibility?.fullyVisible) {
    view.dispatch({ selection });
    return true;
  } else {
    view.dispatch({
      selection,
      effects: EditorView.scrollIntoView(pos, {
        y: isStartBoundary ? "start" : "end",
        yMargin: 24
      })
    });
  }
  if (isStartBoundary) forceScrollDocBoundary(view, pos);
  try {
    requestAnimationFrame(() => {
      try {
        const headNow = view.state.selection.main.head;
        if (headNow !== selectionPos) return;
        if (isStartBoundary) forceScrollDocBoundary(view, pos);
        const afterVisibility = getDocPositionVisibility(view, pos);
        if (afterVisibility?.fullyVisible) return;
        view.dispatch({
          effects: EditorView.scrollIntoView(pos, {
            y: isStartBoundary ? "start" : "end",
            yMargin: 24
          })
        });
      } catch {}
    });
  } catch {}
  return true;
}

function cursorDocStartAndScroll(view: EditorView): boolean {
  return moveSelectionToDocBoundary(view, 0, false);
}

function cursorDocEndAndScroll(view: EditorView): boolean {
  return moveSelectionToDocBoundary(view, view.state.doc.length, false);
}

function selectDocStartAndScroll(view: EditorView): boolean {
  return moveSelectionToDocBoundary(view, 0, true);
}

function selectDocEndAndScroll(view: EditorView): boolean {
  return moveSelectionToDocBoundary(view, view.state.doc.length, true);
}

const modDSelectNext = EditorView.domEventHandlers({
  keydown: (event, view) => {
    if (event.defaultPrevented) return false;
    if (!event.metaKey || event.altKey || event.ctrlKey) return false;
    if (event.code !== "KeyD") return false;
    event.preventDefault();
    return selectNextOccurrenceDown(view);
  }
});

function getSelectedTextForClipboard(view: EditorView): string {
  const { state } = view;
  return state.selection.ranges
    .filter(range => !range.empty)
    .map(range => state.sliceDoc(range.from, range.to))
    .join("\n");
}

function writeSystemClipboard(text: string): void {
  if (!text) return;
  try {
    void navigator.clipboard?.writeText?.(text);
    return;
  } catch {}

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  } catch {}
}

const vimVisualYankClipboardSync = EditorView.domEventHandlers({
  keydown: (event, view) => {
    if (event.defaultPrevented) return false;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key !== "y" && event.key !== "Y") return false;

    const cm = getCM(view) as any;
    const vimState = cm?.state?.vim;
    if (!vimState?.visualMode) return false;

    const selectedText = getSelectedTextForClipboard(view);
    if (selectedText) writeSystemClipboard(selectedText);
    return false;
  }
});

function getSelectionHighlightExtensions(enabled: boolean): Extension[] {
  if (!enabled) return [];
  return [selectionMatchHighlighter()];
}

export type CursorPos = { line: number; ch: number };

export type EditorSetValueOptions = {
  source?: "session-load" | "session-seed";
};

export type EditorCoreOptions = {
  lineNumbers?: boolean;
  activeLineHighlight?: boolean;
  folding?: boolean;
};

export type VimOperationalMode = "normal" | "insert" | "replace" | "visual";

let nextEditorCoreSeq = 1;

function createEditorId(panelId: string): string {
  return `${panelId || "editor"}:${nextEditorCoreSeq++}`;
}

type MouseResolvedPosition = {
  pos: number;
  bias: -1 | 1;
};

type VisualRowPosition = {
  pos: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

type VisualRow = {
  top: number;
  bottom: number;
  center: number;
  positions: VisualRowPosition[];
};

function normalizeRect(rect: { left?: number; right?: number; top?: number; bottom?: number; x?: number; y?: number; width?: number; height?: number } | null): VisualRowPosition | null {
  if (!rect) return null;
  const left = Number.isFinite(rect.left) ? rect.left! : rect.x;
  const top = Number.isFinite(rect.top) ? rect.top! : rect.y;
  const right = Number.isFinite(rect.right) ? rect.right! : (Number.isFinite(left) && Number.isFinite(rect.width) ? left! + rect.width! : left);
  const bottom = Number.isFinite(rect.bottom) ? rect.bottom! : (Number.isFinite(top) && Number.isFinite(rect.height) ? top! + rect.height! : top);
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) return null;
  return { pos: 0, left: left!, right: right!, top: top!, bottom: bottom! };
}

function getEventLineStart(view: EditorView, event: MouseEvent, fallbackPos: number): number {
  try {
    const target = event.target instanceof Element ? event.target : null;
    const lineEl = target?.closest(".cm-line");
    if (lineEl && view.contentDOM.contains(lineEl)) {
      return view.state.doc.lineAt(view.posAtDOM(lineEl, 0)).from;
    }
  } catch {}
  return view.state.doc.lineAt(fallbackPos).from;
}

function getCandidateLineStarts(view: EditorView, event: MouseEvent, fallbackPos: number): number[] {
  const starts = new Set<number>();
  const add = (pos: number) => {
    try {
      const line = view.state.doc.lineAt(Math.max(0, Math.min(view.state.doc.length, pos)));
      starts.add(line.from);
      if (line.from > 0) starts.add(view.state.doc.lineAt(line.from - 1).from);
      if (line.to < view.state.doc.length) starts.add(view.state.doc.lineAt(line.to + 1).from);
    } catch {}
  };
  add(fallbackPos);
  add(getEventLineStart(view, event, fallbackPos));
  try {
    const scrollerRect = view.scrollDOM.getBoundingClientRect();
    for (const block of view.viewportLineBlocks) {
      if (block.widget) continue;
      const top = view.documentTop + block.top;
      const bottom = view.documentTop + block.bottom;
      if (bottom < scrollerRect.top - 120 || top > scrollerRect.bottom + 120) continue;
      if (event.clientY >= top - 120 && event.clientY <= bottom + 120) add(block.from);
    }
  } catch {}
  return [...starts];
}

function buildVisualRowsForLine(view: EditorView, lineFrom: number, lineTo: number): VisualRow[] {
  const maxMeasuredLineLength = 2000;
  if (lineTo - lineFrom > maxMeasuredLineLength) return [];
  const rows: VisualRow[] = [];
  for (let pos = lineFrom; pos <= lineTo; pos++) {
    let rect: ReturnType<EditorView["coordsAtPos"]> | null = null;
    try { rect = view.coordsAtPos(pos); } catch {}
    const normalized = normalizeRect(rect);
    if (!normalized) continue;
    normalized.pos = pos;
    const center = (normalized.top + normalized.bottom) / 2;
    const rowTolerance = Math.max(6, Math.min(10, (normalized.bottom - normalized.top) * 0.6));
    let row = rows.find(candidate => Math.abs(candidate.center - center) <= rowTolerance);
    if (!row) {
      row = { top: normalized.top, bottom: normalized.bottom, center, positions: [] };
      rows.push(row);
    }
    row.top = Math.min(row.top, normalized.top);
    row.bottom = Math.max(row.bottom, normalized.bottom);
    row.center = (row.center * row.positions.length + center) / (row.positions.length + 1);
    row.positions.push(normalized);
  }
  rows.sort((a, b) => a.center - b.center);
  for (const row of rows) row.positions.sort((a, b) => a.left - b.left || a.pos - b.pos);
  return rows;
}

function resolveWrappedLineMousePosition(view: EditorView, event: MouseEvent): MouseResolvedPosition | null {
  const basePos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  if (basePos == null) return null;
  const candidateRows: VisualRow[] = [];
  for (const lineFrom of getCandidateLineStarts(view, event, basePos)) {
    const line = view.state.doc.lineAt(lineFrom);
    candidateRows.push(...buildVisualRowsForLine(view, line.from, line.to));
  }
  if (!candidateRows.length) return null;

  const targetRow = candidateRows.reduce((best, row) => {
    const distance = event.clientY < row.top
      ? row.top - event.clientY
      : event.clientY > row.bottom
        ? event.clientY - row.bottom
        : 0;
    const bestDistance = event.clientY < best.top
      ? best.top - event.clientY
      : event.clientY > best.bottom
        ? event.clientY - best.bottom
        : 0;
    return distance < bestDistance || (distance === bestDistance && Math.abs(event.clientY - row.center) < Math.abs(event.clientY - best.center))
      ? row
      : best;
  }, candidateRows[0]);

  const nearest = targetRow.positions.reduce((best, candidate) => {
    const candidateX = (candidate.left + candidate.right) / 2;
    const bestX = (best.left + best.right) / 2;
    return Math.abs(event.clientX - candidateX) < Math.abs(event.clientX - bestX) ? candidate : best;
  }, targetRow.positions[0]);
  const nearestX = (nearest.left + nearest.right) / 2;
  return { pos: nearest.pos, bias: event.clientX >= nearestX ? 1 : -1 };
}

function wrappedLineMouseSelectionFix(): Extension {
  return Prec.highest(EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.button !== 0 || event.detail !== 1) return null;
    const start = resolveWrappedLineMousePosition(view, event);
    if (!start) return null;
    let startPos = start.pos;
    const startBias = start.bias;
    let startSelection = view.state.selection;
    return {
      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        startPos = update.changes.mapPos(startPos);
        startSelection = startSelection.map(update.changes);
      },
      get(curEvent: MouseEvent, extend: boolean, multiple: boolean) {
        const cur = resolveWrappedLineMousePosition(view, curEvent)
          ?? {
            pos: view.posAtCoords({ x: curEvent.clientX, y: curEvent.clientY }, false) ?? startPos,
            bias: startBias
          };
        const range = startPos === cur.pos
          ? EditorSelection.cursor(cur.pos, cur.bias)
          : EditorSelection.range(startPos, cur.pos);
        if (extend) return EditorSelection.create([EditorSelection.range(startSelection.main.anchor, cur.pos)]);
        if (multiple) return startSelection.addRange(range);
        return EditorSelection.create([range]);
      }
    };
  }));
}

export class EditorCore {
  public view: EditorView;
  private keymapComp = new Compartment();
  private historyComp = new Compartment();
  private uiComp = new Compartment();
  private themeComp = new Compartment();
  private mdComp = new Compartment();
  private featuresComp = new Compartment();
  private lineWrapComp = new Compartment();
  private autocompletionComp = new Compartment();
  private externalComp = new Compartment();
  private externalExtensions: Extension[] = [];
  private minimapEnabled = false;
  private minimapComp = new Compartment();
  private selectionHighlightEnabled = true;
  private selectionHighlightComp = new Compartment();
  private vimModeEnabled = false;
  private vimComp = new Compartment();
  private themeMode: "light" | "dark" = "dark";
  private vimOperationalMode: VimOperationalMode = "normal";
  private vimOperationalModeListeners = new Set<(mode: VimOperationalMode) => void>();
  private vimModeChangeTarget: any = null;
  private vimModeChangeHandler: ((payload: any) => void) | null = null;
  private applyingVimOperationalMode = false;

  // runtime flags for feature toggles
  private lineNumbersEnabled = true;
  private activeLineHighlightEnabled = true;
  private autoIndentEnabled = true;
  private syntaxHighlightEnabled = true;
  private foldEnabled = true;
  private lineWrapEnabled = true;
  private wysiwygEnabled = true;
  private wysiwygKeepActiveLineRendered = true;
  private disposed = false;
  private _panelId: string;
  private _editorId: string;
  private _sessionId: string | null = null;
  private windowDisposers: Array<() => void> = [];
  private focusReturnScrollGuard: { until: number; scrollTop: number; scrollLeft: number; reason: string } | null = null;

  constructor(parent: HTMLElement, initialValue = "", panelId = "panel-0", options: EditorCoreOptions = {}) {
    this._panelId = panelId;
    this._editorId = createEditorId(panelId);
    this.lineNumbersEnabled = options.lineNumbers ?? true;
    this.activeLineHighlightEnabled = options.activeLineHighlight ?? true;
    this.foldEnabled = options.folding ?? true;
    parent.setAttribute("data-panel-id", panelId);
    this.view = new EditorView({
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
            drawSelection(),
          Prec.highest(
            keymap.of([
              {
                mac: "Cmd-ArrowUp",
                key: "Mod-Home",
                run: cursorDocStartAndScroll,
                shift: selectDocStartAndScroll,
                preventDefault: true
              },
              {
                mac: "Cmd-ArrowDown",
                key: "Mod-End",
                run: cursorDocEndAndScroll,
                shift: selectDocEndAndScroll,
                preventDefault: true
              },
              {
                key: "Enter",
                run: (view) =>
                  acceptCompletion(view) ||
                  insertNewlineContinueMarkup(view) ||
                  insertNewlineAndIndent(view),
                preventDefault: true
              },
              {
                key: "Tab",
                run: (view) => acceptCompletion(view) || !!indentWithTab.run?.(view),
                preventDefault: true
              }
            ])
          ),
          // features (line numbers, active line gutter/highlight, auto indent, folding) are placed
          // in a dedicated compartment so they can be toggled at runtime.
          this.featuresComp.of(this.buildFeaturesArray()),
          scrollPastEnd(),
            modDSelectNext,
          this.historyComp.of(history()),
          // markdown is put into its own compartment so code-language highlighting can
          // be enabled/disabled at runtime.
          this.mdComp.of(markdown({ codeLanguages: languages, extensions: [roleScopedFencedCode, GFM] })),
          this.autocompletionComp.of(getAutocompletionExtension()),
          this.themeComp.of(oneDark),
          this.uiComp.of(this.buildWysiwygExtension()),
          selectionToolbarExtension(),
          linkDetector,
          linkStyles,
          imageInsertionExtension(),
          obsidianSyntaxExtension(),
          // minimap compartment (can be toggled)
          this.minimapComp.of([]),
          // selection highlight compartment
          this.selectionHighlightComp.of(getSelectionHighlightExtensions(this.selectionHighlightEnabled)),
          // Vim mode is compartmentalized so the editor can switch modes without recreation.
          this.vimComp.of([]),
          inlineWidgetDecorationsExtension(),
          // external visual extensions compartment (extensions can push CM6 ViewPlugins)
          this.externalComp.of(this.externalExtensions),
          this.keymapComp.of(
            keymap.of([
              ...completionKeymap,
              indentWithTab,
              { key: "Shift-Tab", run: indentLess },
              ...defaultKeymap,
              ...historyKeymap
            ])
          ),
          // line wrap compartment
          this.lineWrapComp.of(CMEditorView.lineWrapping),
          wrappedLineMouseSelectionFix(),
          this.createFocusReturnGuardExtension()
        ]
      }),
      parent
    });
    this.applyDomIdentity();
    this.attachFocusReturnWindowListeners();
  }

  private applyDomIdentity(): void {
    try {
      this.view.dom.setAttribute("data-editor-id", this._editorId);
      this.view.dom.setAttribute("data-panel-id", this._panelId);
      if (this._sessionId) {
        this.view.dom.setAttribute("data-session-id", this._sessionId);
      } else {
        this.view.dom.removeAttribute("data-session-id");
      }
    } catch {}
  }

  getEditorId(): string {
    return this._editorId;
  }

  getPanelId(): string {
    return this._panelId;
  }

  setPanelId(panelId: string): void {
    this._panelId = panelId;
    this.applyDomIdentity();
  }

  getSessionId(): string | null {
    return this._sessionId;
  }

  setSessionId(sessionId: string | null): void {
    this._sessionId = sessionId ? String(sessionId) : null;
    this.applyDomIdentity();
  }

  getValue(): string {
    return this.view.state.doc.toString();
  }

  setValue(v: string, opts?: EditorSetValueOptions): void {
    const { state } = this.view;
    const isSessionReplace = opts?.source === "session-load" || opts?.source === "session-seed";
    const annotations = isSessionReplace
      ? [
          Transaction.userEvent.of(opts?.source === "session-seed" ? "zion.sessionSeed" : "zion.sessionLoad"),
          Transaction.addToHistory.of(false)
        ]
      : undefined;
    const tr = state.update({
      changes: { from: 0, to: state.doc.length, insert: v },
      annotations,
      effects: isSessionReplace ? this.historyComp.reconfigure([]) : undefined
    });
    this.view.dispatch(tr);
    if (isSessionReplace) {
      this.view.dispatch({
        effects: this.historyComp.reconfigure(history()),
        annotations: Transaction.addToHistory.of(false)
      });
    }
  }

  replaceSelection(text: string): void {
    const { state } = this.view;
    const ranges = state.selection.ranges;
    const changes = ranges.map(r => ({ from: r.from, to: r.to, insert: text }));
    this.view.dispatch({ changes, selection: { anchor: changes[0].from + text.length } });
  }

  getCursor(): CursorPos {
    const sel = this.view.state.selection.main;
    const pos = sel.head;
    const ln = this.view.state.doc.lineAt(pos);
    return { line: ln.number - 1, ch: pos - ln.from };
    }
  setCursor(pos: CursorPos): void {
    const line = this.view.state.doc.line(pos.line + 1);
    const head = line.from + Math.min(pos.ch, line.length);
    this.view.dispatch({ selection: { anchor: head }, scrollIntoView: true });
  }

  getSelection(): string {
    const sel = this.view.state.selection.main;
    if (sel.empty) return "";
    return this.view.state.sliceDoc(sel.from, sel.to);
  }

  replaceRange(text: string, from: CursorPos, to?: CursorPos): void {
    const doc = this.view.state.doc;
    const fromLine = doc.line(from.line + 1);
    const fromPos = fromLine.from + Math.min(from.ch, fromLine.length);

    let toPos = fromPos;
    if (to) {
      const toLine = doc.line(to.line + 1);
      toPos = toLine.from + Math.min(to.ch, toLine.length);
    }

    this.view.dispatch({
      changes: { from: fromPos, to: toPos, insert: text }
    });
  }

  focus(): void {
    this.view.focus();
  }

  updateKeymap(bindings: { key: string; run: () => boolean; preventDefault?: boolean }[]): void {
    this.view.dispatch({
      effects: this.keymapComp.reconfigure(
        keymap.of([
          ...bindings,
            { key: "Mod-d", run: () => selectNextOccurrenceDown(this.view), preventDefault: true },
          ...completionKeymap,
          indentWithTab,
          { key: "Shift-Tab", run: indentLess },
          ...defaultKeymap,
          ...historyKeymap
        ])
      )
    });
  }

  // Enable/disable WYSIWYG live preview dynamically
  setWysiwygEnabled(enabled: boolean): void {
    if (this.wysiwygEnabled === !!enabled) return;
    this.wysiwygEnabled = !!enabled;
    this.view.dispatch({
      effects: this.uiComp.reconfigure(this.buildWysiwygExtension())
    });
  }

  setWysiwygKeepActiveLineRendered(enabled: boolean): void {
    if (this.wysiwygKeepActiveLineRendered === !!enabled) return;
    this.wysiwygKeepActiveLineRendered = !!enabled;
    this.view.dispatch({
      effects: this.uiComp.reconfigure(this.buildWysiwygExtension())
    });
  }

  private buildWysiwygExtension(): Extension {
    return this.wysiwygEnabled
      ? wysiwyg({ keepActiveLineRendered: this.wysiwygKeepActiveLineRendered })
      : [];
  }

  private createFocusReturnGuardExtension(): Extension {
    let lastScrollTop = -1;
    return EditorView.updateListener.of((update: ViewUpdate) => {
        const scrollChanged = update.view.scrollDOM.scrollTop !== lastScrollTop;
        if (!update.docChanged && !update.selectionSet && !update.viewportChanged && !update.geometryChanged && !scrollChanged) return;
        const guard = this.focusReturnScrollGuard;
        const hasScrollIntoView = update.transactions.some((tr) => tr.scrollIntoView);
        const now = Date.now();
        if (
          guard &&
          now <= guard.until &&
          update.geometryChanged &&
          !update.docChanged &&
          !update.selectionSet &&
          !hasScrollIntoView
        ) {
          const currentTop = update.view.scrollDOM.scrollTop;
          const currentLeft = update.view.scrollDOM.scrollLeft;
          const topDelta = currentTop - guard.scrollTop;
          const leftDelta = currentLeft - guard.scrollLeft;
          if ((topDelta || leftDelta) && Math.abs(topDelta) <= 96 && Math.abs(leftDelta) <= 32) {
            try {
              update.view.scrollDOM.scrollTop = guard.scrollTop;
              update.view.scrollDOM.scrollLeft = guard.scrollLeft;
              lastScrollTop = guard.scrollTop;
            } catch {}
            this.focusReturnScrollGuard = null;
          }
        }
        lastScrollTop = update.view.scrollDOM.scrollTop;
      });
  }

  private attachFocusReturnWindowListeners(): void {
    const record = (eventName: string) => {
      if (eventName === "focus" || eventName === "visibilitychange:visible") {
        this.focusReturnScrollGuard = {
          until: Date.now() + 260,
          scrollTop: this.view.scrollDOM.scrollTop,
          scrollLeft: this.view.scrollDOM.scrollLeft,
          reason: eventName
        };
      }
    };
    const onFocus = () => record("focus");
    const onBlur = () => record("blur");
    const onVisibility = () => record(`visibilitychange:${document.hidden ? "hidden" : "visible"}`);
    try {
      window.addEventListener("focus", onFocus);
      window.addEventListener("blur", onBlur);
      document.addEventListener("visibilitychange", onVisibility);
      this.windowDisposers.push(
        () => window.removeEventListener("focus", onFocus),
        () => window.removeEventListener("blur", onBlur),
        () => document.removeEventListener("visibilitychange", onVisibility)
      );
    } catch {}
  }

  // Theme switcher (light/dark)
  setTheme(theme: "light" | "dark"): void {
    if (this.themeMode === theme) return;
    this.themeMode = theme;
    this.view.dispatch({
      effects: this.themeComp.reconfigure(
        theme === "dark"
          ? oneDark
          : syntaxHighlighting(defaultHighlightStyle, { fallback: true })
      )
    });
  }

  refreshWysiwyg(): void {
    try {
      this.view.dispatch({
        annotations: Transaction.userEvent.of("wysiwyg-refresh")
      });
    } catch {}
  }

  // Helper to rebuild the features array based on current flags
  private buildFeaturesArray() {
    const arr: Extension[] = [];
    if (this.lineNumbersEnabled) {
      arr.push(lineNumbers());
    }
    if (this.activeLineHighlightEnabled) {
      arr.push(highlightActiveLineGutter(), highlightActiveLine());
    }
    if (this.foldEnabled) {
      arr.push(this.createFoldGutter());
    }
    if (this.autoIndentEnabled) {
      arr.push(indentOnInput());
    }
    return arr;
  }

  // Markdown-friendly fold gutter marker
  private createFoldGutter(): Extension {
    return foldGutter({
      markerDOM: (open: boolean) => {
        const span = document.createElement("span");
        span.className = "cm-fold-marker " + (open ? "cm-fold-open" : "cm-fold-closed");
        span.textContent = open ? "▾" : "▸";
        span.setAttribute("aria-hidden", "true");
        return span;
      }
    } as any);
  }

  setLineNumbersEnabled(enabled: boolean): void {
    if (this.lineNumbersEnabled === !!enabled) return;
    this.lineNumbersEnabled = !!enabled;
    this.view.dispatch({
      effects: this.featuresComp.reconfigure(this.buildFeaturesArray())
    });
  }

  setActiveLineHighlightEnabled(enabled: boolean): void {
    if (this.activeLineHighlightEnabled === !!enabled) return;
    this.activeLineHighlightEnabled = !!enabled;
    this.view.dispatch({
      effects: this.featuresComp.reconfigure(this.buildFeaturesArray())
    });
  }

  setAutoIndentEnabled(enabled: boolean): void {
    if (this.autoIndentEnabled === !!enabled) return;
    this.autoIndentEnabled = !!enabled;
    this.view.dispatch({
      effects: this.featuresComp.reconfigure(this.buildFeaturesArray())
    });
  }

  setFoldingEnabled(enabled: boolean): void {
    if (this.foldEnabled === !!enabled) return;
    this.foldEnabled = !!enabled;
    this.view.dispatch({
      effects: this.featuresComp.reconfigure(this.buildFeaturesArray())
    });
  }

  setSyntaxHighlightEnabled(enabled: boolean): void {
    if (this.syntaxHighlightEnabled === !!enabled) return;
    this.syntaxHighlightEnabled = !!enabled;
    // Reconfigure markdown compartment: with or without language-data
    this.view.dispatch({
      effects: this.mdComp.reconfigure(
        this.syntaxHighlightEnabled
          ? markdown({ codeLanguages: languages, extensions: [GFM] })
          : markdown({ extensions: [GFM] })
      )
    });
  }

  setLineWrapEnabled(enabled: boolean): void {
    if (this.lineWrapEnabled === !!enabled) return;
    this.lineWrapEnabled = !!enabled;
    this.view.dispatch({
      effects: this.lineWrapComp.reconfigure(
        this.lineWrapEnabled ? CMEditorView.lineWrapping : []
      )
    });
  }

  // Allow extensions to add CM6 visual extensions (ViewPlugins/Decorations)
  addExternalExtension(ext: Extension): void {
    this.externalExtensions.push(ext);
    this.view.dispatch({
      effects: this.externalComp.reconfigure(this.externalExtensions)
    });
  }

  // Minimap enable/disable
  

  setMinimapEnabled(enabled: boolean): void {
    if (this.minimapEnabled === !!enabled) return;
    this.minimapEnabled = !!enabled;
    this.view.dispatch({
      effects: this.minimapComp.reconfigure(
        this.minimapEnabled
          ? [showMinimap.compute(['doc'], (state) => {
              // Build a single gutter for Search/Replace conflict blocks to avoid horizontal offset
              const doc = state.doc;
              const total = doc.lines;
              const gutter: Record<number, string> = {};
              // Resolve colors from CSS variables with fallbacks (GitHub-like)
              let searchColor = '#f85149';
              let replaceColor = '#2ea043';
              try {
                const root = getComputedStyle(document.documentElement);
                const sc = root.getPropertyValue('--srp-del-diff-bg').trim();
                const rc = root.getPropertyValue('--srp-add-diff-bg').trim();
                if (sc) searchColor = sc;
                if (rc) replaceColor = rc;
              } catch {}

              let ln = 1;
              while (ln <= total) {
                const line = doc.line(ln);
                const text = doc.sliceString(line.from, line.to).trim();
                if (text === '<<<<<<< SEARCH') {
                  // find ======= and >>>>>>> REPLACE
                  let eqLine = -1;
                  let endLine = -1;
                  let i = ln + 1;
                  while (i <= total) {
                    const li = doc.line(i);
                    const ti = doc.sliceString(li.from, li.to).trim();
                    if (ti === '=======' && eqLine === -1) eqLine = i;
                    if (ti === '>>>>>>> REPLACE') { endLine = i; break; }
                    i++;
                  }
                  if (eqLine !== -1 && endLine !== -1) {
                    // Mark Search region: from start marker to the line BEFORE "======="
                    for (let k = ln; k < eqLine; k++) gutter[k] = searchColor;
                    // Mark Replace region: from "=======" line to the end marker
                    for (let k = eqLine; k <= endLine; k++) gutter[k] = replaceColor;
                    ln = endLine + 1;
                    continue;
                  }
                }
                ln++;
              }

              return {
                create: () => {
                  const dom = document.createElement('div');
                  return { dom };
                },
                displayText: 'characters',
                showOverlay: 'mouse-over',
                gutters: [gutter],
                eventHandlers: {
                  click: (e: MouseEvent) => {
                    // 可选：点击 minimap 跳转
                  }
                }
              };
            })]
          : []
      )
    });
  }

  setAutocompletionEnabled(enabled: boolean): void {
    this.view.dispatch({
      effects: this.autocompletionComp.reconfigure(
        getAutocompletionExtension({ includeWordCompletion: !!enabled })
      )
    });
  }

  setSelectionHighlightEnabled(enabled: boolean): void {
    if (this.selectionHighlightEnabled === !!enabled) return;
    this.selectionHighlightEnabled = !!enabled;
    this.view.dispatch({
      effects: this.selectionHighlightComp.reconfigure(
        getSelectionHighlightExtensions(this.selectionHighlightEnabled)
      )
    });
  }

  setVimModeEnabled(enabled: boolean): void {
    if (this.vimModeEnabled === !!enabled) return;
    this.vimModeEnabled = !!enabled;
    this.view.dispatch({
      effects: this.vimComp.reconfigure(
        this.vimModeEnabled
          ? [
              Prec.highest(vimVisualYankClipboardSync),
              Prec.highest(vim({ status: true }))
            ]
          : []
      )
    });
    if (this.vimModeEnabled) {
      this.attachVimModeChangeListener();
    } else {
      this.detachVimModeChangeListener();
      this.setStoredVimOperationalMode("normal", false);
    }
  }

  getVimOperationalMode(): VimOperationalMode {
    return this.vimOperationalMode;
  }

  onVimOperationalModeChange(listener: (mode: VimOperationalMode) => void): { dispose(): void } {
    this.vimOperationalModeListeners.add(listener);
    return { dispose: () => this.vimOperationalModeListeners.delete(listener) };
  }

  setVimOperationalMode(mode: VimOperationalMode, options: { preserveViewState?: boolean } = {}): void {
    const preserved = options.preserveViewState ? {
      scrollTop: this.view.scrollDOM.scrollTop,
      scrollLeft: this.view.scrollDOM.scrollLeft,
      selection: this.view.state.selection
    } : null;
    const restorePreservedViewState = () => {
      if (!preserved) return;
      try {
        if (this.view.state.selection !== preserved.selection) {
          this.view.dispatch({ selection: preserved.selection });
        }
      } catch {}
      try {
        this.view.scrollDOM.scrollTop = preserved.scrollTop;
        this.view.scrollDOM.scrollLeft = preserved.scrollLeft;
      } catch {}
    };
    this.setStoredVimOperationalMode(mode, false);
    if (!this.vimModeEnabled) {
      restorePreservedViewState();
      return;
    }
    const cm = getCM(this.view) as any;
    const vimState = cm?.state?.vim;
    if (!cm || !vimState) {
      restorePreservedViewState();
      return;
    }
    this.attachVimModeChangeListener();
    this.applyingVimOperationalMode = true;
    try {
      if (getVimStateOperationalMode(vimState) === mode) {
        restorePreservedViewState();
        return;
      }
      if (mode === "normal") {
        if (vimState.visualMode) Vim.exitVisualMode(cm, false);
        if (vimState.insertMode) Vim.exitInsertMode(cm, true);
        return;
      }
      if (vimState.visualMode) Vim.exitVisualMode(cm, false);
      if (vimState.insertMode) Vim.exitInsertMode(cm, true);
      Vim.handleKey(cm, mode === "replace" ? "R" : mode === "visual" ? "v" : "i", "zion-vim-sync");
    } catch {
    } finally {
      this.applyingVimOperationalMode = false;
      restorePreservedViewState();
      if (preserved) {
        try { requestAnimationFrame(restorePreservedViewState); } catch {}
      }
    }
  }

  private attachVimModeChangeListener(): void {
    const cm = getCM(this.view) as any;
    if (!cm || this.vimModeChangeTarget === cm) return;
    this.detachVimModeChangeListener();
    this.vimModeChangeTarget = cm;
    this.vimModeChangeHandler = (payload: any) => {
      const mode = normalizeVimOperationalMode(payload?.mode, payload?.subMode);
      this.setStoredVimOperationalMode(mode, !this.applyingVimOperationalMode);
    };
    try { cm.on?.("vim-mode-change", this.vimModeChangeHandler); } catch {}
  }

  private detachVimModeChangeListener(): void {
    try {
      if (this.vimModeChangeTarget && this.vimModeChangeHandler) {
        this.vimModeChangeTarget.off?.("vim-mode-change", this.vimModeChangeHandler);
      }
    } catch {}
    this.vimModeChangeTarget = null;
    this.vimModeChangeHandler = null;
  }

  private setStoredVimOperationalMode(mode: VimOperationalMode, notify: boolean): void {
    const next = normalizeVimOperationalMode(mode);
    if (this.vimOperationalMode === next) return;
    this.vimOperationalMode = next;
    if (!notify) return;
    for (const listener of this.vimOperationalModeListeners) {
      try { listener(next); } catch {}
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.externalExtensions = [];
    for (const dispose of this.windowDisposers.splice(0)) {
      try { dispose(); } catch {}
    }
    this.detachVimModeChangeListener();
    this.vimOperationalModeListeners.clear();
    try {
      this.view.destroy();
    } catch {}
  }
}

function normalizeVimOperationalMode(mode: unknown, subMode?: unknown): VimOperationalMode {
  const raw = String(mode || "").toLowerCase();
  if (raw === "insert") return "insert";
  if (raw === "replace") return "replace";
  if (raw === "visual") return "visual";
  if (String(subMode || "").toLowerCase().includes("visual")) return "visual";
  return "normal";
}

function getVimStateOperationalMode(vimState: any): VimOperationalMode {
  if (vimState?.visualMode) return "visual";
  if (vimState?.insertMode && vimState?.mode === "replace") return "replace";
  if (vimState?.insertMode) return "insert";
  return "normal";
}
