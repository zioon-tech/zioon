import { type Extension } from "@codemirror/state";
import { EditorView, layer, RectangleMarker, type LayerMarker } from "@codemirror/view";
import { SearchCursor } from "@codemirror/search";

/**
 * Occurrence highlight rendered as a draw layer instead of inline `.cm-selectionMatch`
 * mark decorations. The built-in `highlightSelectionMatches()` injects spans into the
 * rendered text, which splits text nodes and causes inline-code width jumps and CJK
 * line-wrap shifts. Painting rectangles in a separate layer (the same technique
 * `drawSelection()` uses) keeps the text DOM untouched, so it never reflows.
 *
 * Match semantics mirror the default `highlightSelectionMatches()` config
 * (minSelectionLength 1, maxMatches 100, wholeWords false): highlight every
 * occurrence of the current non-empty single selection outside the selection itself.
 */

const MIN_SELECTION_LENGTH = 1;
const MAX_SELECTION_LENGTH = 200;
const MAX_MATCHES = 100;

function getMatchRanges(view: EditorView): Array<{ from: number; to: number }> {
  const { state } = view;
  const sel = state.selection;
  if (sel.ranges.length > 1) return [];

  const range = sel.main;
  if (range.empty) return [];

  const len = range.to - range.from;
  if (len < MIN_SELECTION_LENGTH || len > MAX_SELECTION_LENGTH) return [];

  const query = state.sliceDoc(range.from, range.to);
  if (!query || !query.trim()) return [];

  const matches: Array<{ from: number; to: number }> = [];

  for (const part of view.visibleRanges) {
    const cursor = new SearchCursor(state.doc, query, part.from, part.to);
    while (!cursor.next().done) {
      const { from, to } = cursor.value;
      if (from >= range.to || to <= range.from) {
        matches.push({ from, to });
        if (matches.length > MAX_MATCHES) return [];
      }
    }
  }
  return matches;
}

const selectionMatchLayer = layer({
  above: false,
  class: "cm-selectionMatchLayer",
  update(update) {
    return update.selectionSet || update.docChanged || update.viewportChanged;
  },
  markers(view) {
    const markers: LayerMarker[] = [];
    for (const { from, to } of getMatchRanges(view)) {
      const range = { from, to, empty: false, anchor: from, head: to } as any;
      markers.push(...RectangleMarker.forRange(view, "cm-selectionMatch", range));
    }
    return markers;
  }
});

const selectionMatchTheme = EditorView.theme({
  ".cm-selectionMatchLayer .cm-selectionMatch": {
    backgroundColor: "var(--selection-match-bg)",
    borderRadius: "2px"
  }
});

export function selectionMatchHighlighter(): Extension {
  return [selectionMatchLayer, selectionMatchTheme];
}
