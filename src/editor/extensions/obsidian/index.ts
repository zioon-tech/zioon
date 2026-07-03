import type { Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { findObsidianReferenceTarget } from "./parser";

const WIKILINK_RE = /\[\[([^\]\n]{1,120})\]\]/g;
const TAG_RE = /(^|[\s([{])#([\p{L}\p{N}_/-]+)(?=$|[\s)\]},.;:!?])/gu;
const BLOCK_ID_RE = /(?:^|\s)\^([A-Za-z0-9_-]{2,64})(?=\s|$)/g;
const CALLOUT_RE = /^\s*>\s*\[!(note|tip|warning|info|quote|todo|important|question|example|abstract|summary|success|failure|danger|bug)\][^\n]*$/i;

function isFenceLine(lineText: string): boolean {
  return /^\s*`{3,}/.test(lineText) || /^\s*~{3,}/.test(lineText);
}

function isEscapedAt(text: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) count++;
  return count % 2 === 1;
}

function isInsideInlineCode(text: string, pos: number): boolean {
  let inCode = false;
  for (let i = 0; i < pos; i++) {
    if (text[i] === "`" && !isEscapedAt(text, i)) inCode = !inCode;
  }
  return inCode;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const maxVisibleLine = view.state.doc.lineAt(view.visibleRanges[view.visibleRanges.length - 1]?.to ?? 0).number;
  const visibleLines = new Set<number>();

  for (const range of view.visibleRanges) {
    const fromLine = view.state.doc.lineAt(range.from).number;
    const toLine = view.state.doc.lineAt(range.to).number;
    for (let lineNo = fromLine; lineNo <= toLine; lineNo++) visibleLines.add(lineNo);
  }

  let inFence = false;
  for (let lineNo = 1; lineNo <= maxVisibleLine; lineNo++) {
    const line = view.state.doc.line(lineNo);
    const wasInFence = inFence;
      const isFence = isFenceLine(line.text);
      if (isFence) inFence = !inFence;
      if (!visibleLines.has(lineNo) || wasInFence || isFence) continue;

    const marks: Array<{ from: number; to: number; decoration: Decoration }> = [];

    if (CALLOUT_RE.test(line.text)) {
      builder.add(line.from, line.from, Decoration.line({ class: "cm-obsidian-callout-line" }));
      const tokenStart = line.text.indexOf("[!");
      const tokenEnd = line.text.indexOf("]", tokenStart);
      if (tokenStart >= 0 && tokenEnd > tokenStart) {
        marks.push({
          from: line.from + tokenStart,
          to: line.from + tokenEnd + 1,
          decoration: Decoration.mark({ class: "cm-obsidian-callout-token" })
        });
      }
    }

    WIKILINK_RE.lastIndex = 0;
    let wiki: RegExpExecArray | null;
    while ((wiki = WIKILINK_RE.exec(line.text)) !== null) {
      marks.push({
        from: line.from + wiki.index,
        to: line.from + wiki.index + wiki[0].length,
        decoration: Decoration.mark({ class: "cm-obsidian-wikilink" })
      });
    }

    TAG_RE.lastIndex = 0;
    let tag: RegExpExecArray | null;
    while ((tag = TAG_RE.exec(line.text)) !== null) {
      const start = line.from + tag.index + tag[1].length;
        if (isInsideInlineCode(line.text, tag.index + tag[1].length)) continue;
      marks.push({
        from: start,
        to: start + tag[0].length - tag[1].length,
        decoration: Decoration.mark({ class: "cm-obsidian-tag" })
      });
    }

    BLOCK_ID_RE.lastIndex = 0;
    let block: RegExpExecArray | null;
    while ((block = BLOCK_ID_RE.exec(line.text)) !== null) {
      const caretOffset = block[0].lastIndexOf("^");
      const start = line.from + block.index + caretOffset;
      marks.push({
        from: start,
        to: start + block[1].length + 1,
        decoration: Decoration.mark({ class: "cm-obsidian-block-id" })
      });
    }

    marks
      .sort((a, b) => a.from - b.from || a.to - b.to)
      .forEach(mark => builder.add(mark.from, mark.to, mark.decoration));
  }

  return builder.finish();
}

const obsidianDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: value => value.decorations,
    eventHandlers: {
      mousedown: (event, view) => {
        if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return;
        const target = event.target as HTMLElement;
        const link = target.closest(".cm-obsidian-wikilink");
        if (!link) return;

        const raw = link.textContent || "";
        const pos = findObsidianReferenceTarget(view.state.doc, raw);
        if (typeof pos !== "number") return;

        event.preventDefault();
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: "center" })
        });
        view.focus();
      }
    }
  }
);

export function obsidianSyntaxExtension(): Extension {
  return obsidianDecorations;
}
