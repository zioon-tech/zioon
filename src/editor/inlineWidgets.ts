import { Facet, type EditorState, type Range } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";

export type InlineWidgetDecorationSource = {
  id: string;
  priority?: number;
  buildDecorations: (state: EditorState) => readonly Range<Decoration>[];
};

export const inlineWidgetSourceFacet = Facet.define<InlineWidgetDecorationSource, readonly InlineWidgetDecorationSource[]>({
  combine: (sources) => sources
});


function isInlineWidgetAnchorLine(text: string): boolean {
  return /^\s*调用\s+/.test(text) || /^\s*思考\s*$/.test(text.trim());
}

function buildAnchorLineDecorations(state: EditorState): Range<Decoration>[] {
  const decorations: Range<Decoration>[] = [];
  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo++) {
    const line = state.doc.line(lineNo);
    const text = state.doc.sliceString(line.from, line.to);
    if (!isInlineWidgetAnchorLine(text)) continue;
    decorations.push(Decoration.line({ class: "zion-inline-widget-anchor-row" }).range(line.from));
  }
  return decorations;
}

function buildUnifiedInlineWidgetDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = buildAnchorLineDecorations(state);
  const sources = [...state.facet(inlineWidgetSourceFacet)]
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id.localeCompare(b.id));

  for (const source of sources) {
    try {
      decorations.push(...source.buildDecorations(state));
    } catch {
      // A broken widget source should not take down the whole editor decoration layer.
    }
  }

  return Decoration.set(decorations, true);
}

const inlineWidgetDecorationsPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildUnifiedInlineWidgetDecorations(view.state);
  }

  update(update: ViewUpdate) {
    const hasEffects = update.transactions.some((tr) => tr.effects.length > 0);
    if (!update.docChanged && !hasEffects) return;
    this.decorations = buildUnifiedInlineWidgetDecorations(update.state);
  }
}, {
  decorations: (plugin) => plugin.decorations
});

export function inlineWidgetDecorationsExtension() {
  return inlineWidgetDecorationsPlugin;
}
