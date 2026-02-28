import { EditorState, EditorSelection, Compartment, Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
  scrollPastEnd
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
import { wysiwyg } from "./wysiwyg";
import { EditorView as CMEditorView } from "@codemirror/view";
import { showMinimap } from "@replit/codemirror-minimap";
import { highlightSelectionMatches } from "@codemirror/search";
import { linkDetector, linkStyles } from "./link-detector";
import { autocompleteTheme } from "./AutocompleteTheme";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { selectionToolbarExtension } from "./extensions/selection-toolbar";

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

const optionDSelectNext = EditorView.domEventHandlers({
  keydown: (event, view) => {
    if (event.defaultPrevented) return false;
    if (!event.altKey || event.metaKey || event.ctrlKey) return false;
    if (event.code !== "KeyD") return false;
    event.preventDefault();
    return selectNextOccurrenceDown(view);
  }
});

export type CursorPos = { line: number; ch: number };

export class EditorCore {
  public view: EditorView;
  private keymapComp = new Compartment();
  private uiComp = new Compartment();
  private themeComp = new Compartment();
  private mdComp = new Compartment();
  private featuresComp = new Compartment();
  private lineWrapComp = new Compartment();
  private autocompletionComp = new Compartment();
  private externalComp = new Compartment();
  private externalExtensions: Extension[] = [];
  private minimapEnabled = true;
  private minimapComp = new Compartment();
  private selectionHighlightEnabled = true;
  private selectionHighlightComp = new Compartment();

  // runtime flags for feature toggles
  private lineNumbersEnabled = true;
  private activeLineHighlightEnabled = true;
  private autoIndentEnabled = true;
  private syntaxHighlightEnabled = true;
  private foldEnabled = true;
  private lineWrapEnabled = true;

  constructor(parent: HTMLElement, initialValue = "") {
    this.view = new EditorView({
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          Prec.highest(
            keymap.of([
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
          this.featuresComp.of([
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightActiveLine(),
            indentOnInput(),
            this.createFoldGutter()
          ]),
          scrollPastEnd(),
          optionDSelectNext,
          history(),
          // markdown is put into its own compartment so code-language highlighting can
          // be enabled/disabled at runtime.
          this.mdComp.of(markdown({ codeLanguages: languages, extensions: [GFM] })),
          this.autocompletionComp.of(getAutocompletionExtension()),
          this.themeComp.of(oneDark),
          this.uiComp.of(wysiwyg()),
          selectionToolbarExtension(),
          linkDetector,
          linkStyles,
          // minimap compartment (can be toggled)
          this.minimapComp.of([]),
          // selection highlight compartment
          this.selectionHighlightComp.of([]),
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
          this.lineWrapComp.of(CMEditorView.lineWrapping)
        ]
      }),
      parent
    });
  }

  getValue(): string {
    return this.view.state.doc.toString();
  }

  setValue(v: string): void {
    const { state } = this.view;
    const tr = state.update({
      changes: { from: 0, to: state.doc.length, insert: v }
    });
    this.view.dispatch(tr);
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
          { key: "Alt-d", run: () => selectNextOccurrenceDown(this.view), preventDefault: true },
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
    this.view.dispatch({
      effects: this.uiComp.reconfigure(enabled ? wysiwyg() : [])
    });
  }

  // Theme switcher (light/dark)
  setTheme(theme: "light" | "dark"): void {
    this.view.dispatch({
      effects: this.themeComp.reconfigure(
        theme === "dark"
          ? [oneDark, syntaxHighlighting(defaultHighlightStyle, { fallback: true })]
          : syntaxHighlighting(defaultHighlightStyle, { fallback: true })
      )
    });
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
    this.lineNumbersEnabled = !!enabled;
    this.view.dispatch({
      effects: this.featuresComp.reconfigure(this.buildFeaturesArray())
    });
  }

  setActiveLineHighlightEnabled(enabled: boolean): void {
    this.activeLineHighlightEnabled = !!enabled;
    this.view.dispatch({
      effects: this.featuresComp.reconfigure(this.buildFeaturesArray())
    });
  }

  setAutoIndentEnabled(enabled: boolean): void {
    this.autoIndentEnabled = !!enabled;
    this.view.dispatch({
      effects: this.featuresComp.reconfigure(this.buildFeaturesArray())
    });
  }

  setFoldingEnabled(enabled: boolean): void {
    this.foldEnabled = !!enabled;
    this.view.dispatch({
      effects: this.featuresComp.reconfigure(this.buildFeaturesArray())
    });
  }

  setSyntaxHighlightEnabled(enabled: boolean): void {
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
        enabled ? getAutocompletionExtension() : []
      )
    });
  }

  setSelectionHighlightEnabled(enabled: boolean): void {
    this.selectionHighlightEnabled = !!enabled;
    this.view.dispatch({
      effects: this.selectionHighlightComp.reconfigure(
        this.selectionHighlightEnabled ? highlightSelectionMatches() : []
      )
    });
  }
}
