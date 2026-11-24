import { Facet, type EditorState, type Range, type Transaction } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { isCardMarkerLine } from "../chat/card-markers";

export type InlineWidgetDecorationSource = {
  id: string;
  priority?: number;
  buildDecorations: (state: EditorState) => readonly Range<Decoration>[];
  requiresRebuild?: (transaction: Transaction) => boolean;
};

export const inlineWidgetSourceFacet = Facet.define<InlineWidgetDecorationSource, readonly InlineWidgetDecorationSource[]>({
  combine: (sources) => sources
});


function isInlineWidgetAnchorLine(text: string): boolean {
  return isCardMarkerLine(text);
}

const CARD_MARKER_ID_COMMENT_RE = /<!--\s*zion-(?:thinking|tool):id=[^>\s]+\s*-->/g;

function buildAnchorLineDecorations(state: EditorState): Range<Decoration>[] {
  const decorations: Range<Decoration>[] = [];
  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo++) {
    const line = state.doc.line(lineNo);
    const text = state.doc.sliceString(line.from, line.to);
    if (!isInlineWidgetAnchorLine(text)) continue;
    decorations.push(Decoration.line({ class: "zion-inline-widget-anchor-row" }).range(line.from));
      let match: RegExpExecArray | null;
      const re = new RegExp(CARD_MARKER_ID_COMMENT_RE.source, "g");
      while ((match = re.exec(text)) !== null) {
        decorations.push(Decoration.mark({
          attributes: {
            class: "zion-card-marker-id-comment",
            style: "display: none;"
          }
        }).range(line.from + match.index, line.from + match.index + match[0].length));
      }
  }
  return decorations;
}

function buildUnifiedInlineWidgetDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = buildAnchorLineDecorations(state);
  const sources = getSortedSources(state);

  for (const source of sources) {
    try {
      decorations.push(...source.buildDecorations(state));
    } catch {
      // A broken widget source should not take down the whole editor decoration layer.
    }
  }

  return Decoration.set(decorations, true);
}

function getSortedSources(state: EditorState): InlineWidgetDecorationSource[] {
  return [...state.facet(inlineWidgetSourceFacet)]
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id.localeCompare(b.id));
}

function lineRangeContainsAnchor(state: EditorState, from: number, to: number): boolean {
  const doc = state.doc;
  const safeFrom = Math.max(0, Math.min(doc.length, from));
  const safeTo = Math.max(safeFrom, Math.min(doc.length, to));
  const fromLine = doc.lineAt(safeFrom).number;
  const toLine = doc.lineAt(safeTo).number;
  for (let lineNo = fromLine; lineNo <= toLine; lineNo++) {
    if (isInlineWidgetAnchorLine(doc.line(lineNo).text)) return true;
  }
  return false;
}

function changesTouchInlineWidgetAnchor(update: ViewUpdate): boolean {
  let touchesAnchor = false;
  update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (touchesAnchor) return;
    touchesAnchor =
      lineRangeContainsAnchor(update.startState, fromA, toA) ||
      lineRangeContainsAnchor(update.state, fromB, toB);
  });
  return touchesAnchor;
}

function sourcesChanged(update: ViewUpdate): boolean {
  const before = getSortedSources(update.startState);
  const after = getSortedSources(update.state);
  return before.length !== after.length || before.some((source, index) => source !== after[index]);
}

function sourceRequiresRebuild(update: ViewUpdate): boolean {
  const sources = getSortedSources(update.state);
  return update.transactions.some((transaction) =>
    sources.some((source) => {
      try {
        return source.requiresRebuild
          ? source.requiresRebuild(transaction) === true
          : transaction.effects.length > 0;
      } catch {
        return true;
      }
    })
  );
}

const inlineWidgetDecorationsPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildUnifiedInlineWidgetDecorations(view.state);
  }

  update(update: ViewUpdate) {
    const rebuildForSource = sourcesChanged(update) || sourceRequiresRebuild(update);
    if (update.docChanged && !rebuildForSource && !changesTouchInlineWidgetAnchor(update)) {
      this.decorations = this.decorations.map(update.changes);
      return;
    }
    if (!update.docChanged && !rebuildForSource) return;
    this.decorations = buildUnifiedInlineWidgetDecorations(update.state);
  }
}, {
  decorations: (plugin) => plugin.decorations
});

export function inlineWidgetDecorationsExtension() {
  return inlineWidgetDecorationsPlugin;
}
