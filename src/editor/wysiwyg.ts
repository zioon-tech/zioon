import { EditorSelection, Facet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { insertNewlineAndIndent } from "@codemirror/commands";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import katex from "katex";
import { encode as encodePlantUML } from "plantuml-encoder";
import {
  collectStandaloneImageGroups,
  formatImageInsertion,
  type ImageDisplayKind,
  type MarkdownImage
} from "./image-model";
import {
  getImageDropTarget,
  hideImageDropIndicator,
  showImageDropIndicator
} from "./image-transactions";
import { resolveImageAsset } from "../media/image-assets";
import { workbenchDocumentForView } from "../runtime/workbench-space";
import { isContinuationBoundaryLine } from "../chat/session-document-format.js";
import { safeMarkdownHref, sanitizePublicSvg } from "./public-content-security";

/**
 * Revised WYSIWYG plugin:
 * - Use syntaxTree.iterate for block-level detection (headers, lists, fenced code, tables, math blocks)
 * - Use single-line regex only inside visibleRanges and skip content inside code fences
 * - All visual changes are Decoration.mark / Decoration.widget / Decoration.line (no replace across line breaks)
 * - Update is incremental: rebuild only when docChanged || viewportChanged || transactions changed
 */

/* Helpers */
const inViewport = (view: EditorView, from: number, to: number) =>
  view.viewport.to >= from && view.viewport.from <= to;

/* Simple inline fallback regex (single-line, limited, executed only in visible ranges) */
const INLINE_FALLBACK = /(\*\*([^*\n]+)\*\*)|((?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_]))|(`([^`\n]+)`)|(\[([^\]]+)\]\(([^)\n]+)\))|(!\[([^\]]*)\]\(([^)\n]+)\))|(\$([^\$\n]+)\$)|(~~([^~\n]+)~~)/g;
const ROLE_HEAD_RE = /^\s*(system|user|assistant|tool)\s+/;
const FENCE_START_RE = /^\s*`{3,}\s*([^\s`]*)?.*$/;
const FENCE_CLOSE_RE = /^\s*`{3,}\s*$/;
const TABLE_SEPARATOR_CELL_RE = /^:?-+:?$/;
const ESCAPABLE_MARKDOWN_RE = /[\\`*_[\]{}()#+\-.!~|>]/;

function isEscapedAt(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashCount++;
  return slashCount % 2 === 1;
}

function isValidInlineMathCandidate(source: string, start: number, end: number): boolean {
  const expr = source.slice(start + 1, end - 1);
  if (!expr.trim()) return false;

  const afterOpen = source[start + 1] || "";
  const beforeClose = source[end - 2] || "";
  if (/\s/.test(afterOpen) || /\s/.test(beforeClose)) return false;

  // Treat "$1800", "$1800刀", and "$1,800.50" as currency in prose,
  // not the start of inline math.
  if (/^\d+(?:[.,]\d+)*(?:\b|$)/.test(expr)) return false;

  return true;
}

/* Helper: Check if line contains tool call or thinking markers (skip WYSIWYG processing) */
const isToolOrThinkingLine = (lineText: string): boolean => {
  return /^\s*调用\s+[^\n<]{1,300}(?:\s*<!--\s*zion-tool:id=[^>\s]+\s*-->)?\s*$/.test(lineText)
    || /^\s*思考\s*<!--\s*zion-thinking:id=[^>\s]+\s*-->\s*$/.test(lineText)
    || isContinuationBoundaryLine(lineText);
};

function isRoleHeadLine(lineText: string): boolean {
  return ROLE_HEAD_RE.test(lineText);
}

function stripOuterTablePipes(s: string): string {
  let t = s.trim();
  if (t.startsWith("|")) t = t.slice(1);
  let slashCount = 0;
  for (let i = t.length - 2; i >= 0 && t[i] === "\\"; i--) slashCount++;
  if (t.endsWith("|") && slashCount % 2 === 0) t = t.slice(0, -1);
  return t;
}

function splitMarkdownTableCells(s: string): string[] {
  const t = stripOuterTablePipes(s);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    const next = t[i + 1];
    if (ch === "\\" && next) {
      cur += next === "|" ? "|" : ch + next;
      i++;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      cur += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

type TableCellSourceRange = { from: number; to: number };
type TableSourceLine = { from: number; to: number; text: string };
type TableCommentRange = { id: string; from: number; to: number; active?: boolean };
type TablePreviewRange = {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  headers: string[];
  aligns: Array<"left" | "center" | "right">;
  rows: string[][];
  sourceLines: TableSourceLine[];
};

type TableVisibleSourceMap = {
  text: string;
  offsets: number[];
};

function getMarkdownTableCellSourceRange(lineText: string, lineFrom: number, cellIndex: number): TableCellSourceRange | null {
  let start = 0;
  let end = lineText.length;
  while (start < end && /\s/.test(lineText[start])) start++;
  while (end > start && /\s/.test(lineText[end - 1])) end--;
  if (lineText[start] === "|") start++;

  let slashCount = 0;
  for (let i = end - 2; i >= start && lineText[i] === "\\"; i--) slashCount++;
  if (end > start && lineText[end - 1] === "|" && slashCount % 2 === 0) end--;

  let inCode = false;
  let cellStart = start;
  let currentIndex = 0;
  for (let i = start; i <= end; i++) {
    const ch = lineText[i];
    const next = lineText[i + 1];
    if (i < end && ch === "\\" && next) {
      i++;
      continue;
    }
    if (i < end && ch === "`") {
      inCode = !inCode;
      continue;
    }
    if (i === end || (ch === "|" && !inCode)) {
      if (currentIndex === cellIndex) {
        let from = cellStart;
        let to = i;
        while (from < to && /\s/.test(lineText[from])) from++;
        while (to > from && /\s/.test(lineText[to - 1])) to--;
        return { from: lineFrom + from, to: lineFrom + to };
      }
      currentIndex++;
      cellStart = i + 1;
    }
  }
  return null;
}

function buildTableCellVisibleSourceMap(source: string): TableVisibleSourceMap {
  const offsets: number[] = [0];
  let text = "";

  const appendVisibleSegment = (visibleFrom: number, visibleTo: number, fullFrom = visibleFrom, fullTo = visibleTo) => {
    if (visibleTo <= visibleFrom) return;
    offsets[offsets.length - 1] = fullFrom;
    for (let i = visibleFrom; i < visibleTo; i++) {
      text += source[i] || "";
      offsets.push(i === visibleTo - 1 ? fullTo : i + 1);
    }
  };

  const appendEscapedChar = (slashIndex: number) => {
    offsets[offsets.length - 1] = slashIndex;
    text += source[slashIndex + 1] || "";
    offsets.push(slashIndex + 2);
  };

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    if (rest.startsWith("<br>") || rest.startsWith("<br/>") || rest.startsWith("<br />")) {
      const len = rest.startsWith("<br />") ? 6 : rest.startsWith("<br/>") ? 5 : 4;
      offsets[offsets.length - 1] = i;
      text += "\n";
      offsets.push(i + len);
      i += len;
      continue;
    }
    if (source[i] === "\\" && i + 1 < source.length) {
      appendEscapedChar(i);
      i += 2;
      continue;
    }
    if (rest.startsWith("`")) {
      const close = source.indexOf("`", i + 1);
      if (close > i + 1) {
        appendVisibleSegment(i + 1, close, i, close + 1);
        i = close + 1;
        continue;
      }
    }
    if (rest.startsWith("**")) {
      const close = source.indexOf("**", i + 2);
      if (close > i + 2) {
        appendVisibleSegment(i + 2, close, i, close + 2);
        i = close + 2;
        continue;
      }
    }
    if (rest.startsWith("~~")) {
      const close = source.indexOf("~~", i + 2);
      if (close > i + 2) {
        appendVisibleSegment(i + 2, close, i, close + 2);
        i = close + 2;
        continue;
      }
    }
    if (rest.startsWith("_")) {
      const close = source.indexOf("_", i + 1);
      const before = i > 0 ? source[i - 1] : "";
      const after = close >= 0 && close + 1 < source.length ? source[close + 1] : "";
      const isWordChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);
      if (close > i + 1 && !isWordChar(before) && !isWordChar(after)) {
        appendVisibleSegment(i + 1, close, i, close + 1);
        i = close + 1;
        continue;
      }
    }
    if (rest.startsWith("[")) {
      const labelEnd = source.indexOf("]", i + 1);
      if (labelEnd > i + 1 && source[labelEnd + 1] === "(") {
        const urlEnd = source.indexOf(")", labelEnd + 2);
        if (urlEnd > labelEnd + 2) {
          appendVisibleSegment(i + 1, labelEnd, i, urlEnd + 1);
          i = urlEnd + 1;
          continue;
        }
      }
    }
    appendVisibleSegment(i, i + 1);
    i++;
  }

  return { text, offsets };
}

function mapTableCellVisibleOffsetToSource(source: string, visibleOffset: number): number {
  const map = buildTableCellVisibleSourceMap(source);
  const index = Math.max(0, Math.min(map.offsets.length - 1, Math.round(visibleOffset)));
  return map.offsets[index] ?? 0;
}

function isMarkdownTableSeparatorRow(s: string): boolean {
  const t = s.trim();
  if (!t.includes("|")) return false;
  const cells = splitMarkdownTableCells(t);
  return cells.length >= 2 && cells.every(cell => TABLE_SEPARATOR_CELL_RE.test(cell.trim()));
}

function isMarkdownTableContentRow(s: string): boolean {
  const t = s.trim();
  if (!t.includes("|")) return false;
  return !isMarkdownTableSeparatorRow(t) && splitMarkdownTableCells(t).length >= 2;
}

function parseMarkdownTableAligns(s: string): Array<"left" | "center" | "right"> {
  const cells = splitMarkdownTableCells(s);
  return cells.map(seg => {
    const left = seg.startsWith(":");
    const right = seg.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  }) as Array<"left" | "center" | "right">;
}

function normalizeTableRows(headers: string[], aligns: Array<"left" | "center" | "right">, rows: string[][]) {
  const colCount = Math.max(headers.length, aligns.length, ...rows.map(row => row.length), 1);
  const normalize = (row: string[]) => Array.from({ length: colCount }, (_, i) => row[i] ?? "");
  return {
    headers: normalize(headers),
    aligns: Array.from({ length: colCount }, (_, i) => aligns[i] || "left") as Array<"left" | "center" | "right">,
    rows: rows.map(normalize)
  };
}

function appendTableInlineMarkdown(parent: HTMLElement, source: string) {
  const appendText = (text: string) => {
    if (text) parent.appendChild(document.createTextNode(text));
  };
  const appendStyled = (tag: "strong" | "em" | "code" | "s", cls: string, text: string) => {
    const el = document.createElement(tag);
    el.className = cls;
    if (tag === "code") {
      el.textContent = text;
    } else {
      appendTableInlineMarkdown(el, text);
    }
    parent.appendChild(el);
  };
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    if (rest.startsWith("<br>") || rest.startsWith("<br/>") || rest.startsWith("<br />")) {
      parent.appendChild(document.createElement("br"));
      i += rest.startsWith("<br />") ? 6 : rest.startsWith("<br/>") ? 5 : 4;
      continue;
    }
    if (source[i] === "\\" && i + 1 < source.length) {
      appendText(source[i + 1]);
      i += 2;
      continue;
    }
    if (rest.startsWith("`")) {
      const close = source.indexOf("`", i + 1);
      if (close > i + 1) {
        appendStyled("code", "cm-md-code", source.slice(i + 1, close));
        i = close + 1;
        continue;
      }
    }
    if (rest.startsWith("**")) {
      const close = source.indexOf("**", i + 2);
      if (close > i + 2) {
        appendStyled("strong", "cm-md-strong", source.slice(i + 2, close));
        i = close + 2;
        continue;
      }
    }
    if (rest.startsWith("~~")) {
      const close = source.indexOf("~~", i + 2);
      if (close > i + 2) {
        appendStyled("s", "cm-md-strike", source.slice(i + 2, close));
        i = close + 2;
        continue;
      }
    }
    if (rest.startsWith("_")) {
      const close = source.indexOf("_", i + 1);
      const before = i > 0 ? source[i - 1] : "";
      const after = close >= 0 && close + 1 < source.length ? source[close + 1] : "";
      const isWordChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);
      if (close > i + 1 && !isWordChar(before) && !isWordChar(after)) {
        appendStyled("em", "cm-md-em", source.slice(i + 1, close));
        i = close + 1;
        continue;
      }
    }
    if (rest.startsWith("[")) {
      const labelEnd = source.indexOf("]", i + 1);
      if (labelEnd > i + 1 && source[labelEnd + 1] === "(") {
        const urlEnd = source.indexOf(")", labelEnd + 2);
        if (urlEnd > labelEnd + 2) {
          const a = document.createElement("a");
          a.className = "cm-md-link cm-md-table-link";
          const href = safeMarkdownHref(source.slice(labelEnd + 2, urlEnd));
          if (href) a.href = href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          appendTableInlineMarkdown(a, source.slice(i + 1, labelEnd));
          parent.appendChild(a);
          i = urlEnd + 1;
          continue;
        }
      }
    }
    appendText(source[i]);
    i++;
  }
}

function getTableCommentRanges(view: EditorView, from: number, to: number): TableCommentRange[] {
  try {
    const ranges = (window as any).__zionCommentAnchorsByView?.get?.(view);
    if (!Array.isArray(ranges)) return [];
    return ranges
      .map((item: any) => ({
        id: String(item?.id || ""),
        from: Number(item?.from),
        to: Number(item?.to),
        active: !!item?.active
      }))
      .filter((item: TableCommentRange) =>
        item.id && Number.isFinite(item.from) && Number.isFinite(item.to) && item.to > from && item.from < to
      )
      .sort((a: TableCommentRange, b: TableCommentRange) => a.from - b.from || a.to - b.to);
  } catch {
    return [];
  }
}

function appendTableInlineMarkdownWithComments(
  parent: HTMLElement,
  source: string,
  sourceRange: TableCellSourceRange | null,
  comments: TableCommentRange[]
) {
  if (!sourceRange || !comments.length) {
    appendTableInlineMarkdown(parent, source);
    return;
  }
  let cursor = 0;
  for (const comment of comments) {
    const start = Math.max(0, Math.min(source.length, comment.from - sourceRange.from));
    const end = Math.max(start, Math.min(source.length, comment.to - sourceRange.from));
    if (end <= cursor) continue;
    if (start > cursor) appendTableInlineMarkdown(parent, source.slice(cursor, start));

    const mark = document.createElement("span");
    mark.className = `zion-comment-range${comment.active ? " is-active" : ""}`;
    mark.dataset.commentId = comment.id;
    mark.title = "打开评论";
    const openComment = (event: Event) => {
      try { event.preventDefault(); event.stopPropagation(); } catch {}
      try { (window as any).zion?.commands?.executeCommand?.("comments.revealThread", comment.id); } catch {}
    };
    mark.addEventListener("click", openComment);
    appendTableInlineMarkdown(mark, source.slice(start, end));
    parent.appendChild(mark);
    cursor = end;
  }
  if (cursor < source.length) appendTableInlineMarkdown(parent, source.slice(cursor));
}

type AddDecoration = (from: number, to: number, dec: Decoration) => void;

const MARKDOWN_LIST_INDENT_PX = 20;

function countIndentColumns(text: string): number {
  let col = 0;
  for (const ch of text) {
    if (ch === "\t") {
      col += 4 - (col % 4);
    } else if (ch === " ") {
      col++;
    }
  }
  return col;
}

function getListDepthFromSyntaxNode(node: any, indentText: string): number {
  try {
    let listCount = 0;
    let parent = node?.node?.parent || null;
    while (parent) {
      const name = parent.name || parent.type?.name;
      if (name === "BulletList" || name === "OrderedList") listCount++;
      parent = parent.parent || null;
    }
    if (listCount > 0) return Math.max(0, listCount - 1);
  } catch {}

  const cols = countIndentColumns(indentText);
  if (cols <= 0) return 0;
  // Common markdown renderers turn both 2-space and 4-space child list
  // indentation into a full visual nesting step.
  return Math.max(1, Math.ceil(cols / 4));
}

function getListMarkerWidthPx(markerText: string): number {
  const markerChars = markerText.trim().length;
  if (!markerChars || !/^\d/.test(markerText.trim())) return MARKDOWN_LIST_INDENT_PX;
  return Math.max(MARKDOWN_LIST_INDENT_PX, Math.min(56, MARKDOWN_LIST_INDENT_PX + Math.max(0, markerChars - 2) * 8));
}

const wysiwygKeepActiveLineRenderedFacet = Facet.define<boolean, boolean>({
  combine(values) {
    return values.length ? values[values.length - 1] !== false : true;
  }
});
type ReaderRenderOptions = {
  publicReadOnly?: boolean;
  imageUrl?: (source: string) => string | null;
};
const readerRenderOptions = Facet.define<ReaderRenderOptions, ReaderRenderOptions>({
  combine: values => values[values.length - 1] || {}
});
const imageUrlForView = (source: string, view: EditorView) => {
  const options = view.state.facet(readerRenderOptions);
  return options.imageUrl ? Promise.resolve(options.imageUrl(source))
    : resolveImageAsset(source, workbenchDocumentForView(view));
};

type RenderedInlineRange = {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
};
type RenderedLineBoundaries = {
  start: number | null;
  end: number | null;
};

function selectionTouchesRange(state: EditorState, from: number, to: number): boolean {
  if (state.facet(readerRenderOptions).publicReadOnly) return false;
  if (from > to) return false;
  for (const range of state.selection.ranges) {
    if (range.empty) {
      const head = range.head;
      if (head >= from && head <= to) return true;
      continue;
    }
    if (range.from < to && range.to > from) return true;
  }
  return false;
}

function collapsedSelectionTouchesRange(state: EditorState, from: number, to: number): boolean {
  if (from > to) return false;
  for (const range of state.selection.ranges) {
    if (!range.empty) continue;
    const head = range.head;
    if (head >= from && head <= to) return true;
  }
  return false;
}

function nonEmptySelectionOverlapsRange(state: EditorState, from: number, to: number): boolean {
  if (from >= to) return false;
  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    if (range.from < to && range.to > from) return true;
  }
  return false;
}

function selectionInsideRange(state: EditorState, from: number, to: number): boolean {
  if (from >= to) return false;
  for (const range of state.selection.ranges) {
    if (!range.empty) continue;
    const head = range.head;
    if (head > from && head < to) return true;
  }
  return false;
}

function hiddenSyntaxClass(state: EditorState, from: number, to: number, baseClass = "cm-z-hide-syntax"): string {
  return selectionInsideRange(state, from, to)
    ? `${baseClass} cm-z-caret-visible-syntax`
    : baseClass;
}

function hiddenSyntaxDecoration(state: EditorState, from: number, to: number, baseClass = "cm-z-hide-syntax"): Decoration {
  return Decoration.mark({ class: hiddenSyntaxClass(state, from, to, baseClass) });
}

function collectRenderedInlineRangesInLine(lineText: string, lineFrom: number, docLength: number): RenderedInlineRange[] {
  const ranges: RenderedInlineRange[] = [];
  INLINE_FALLBACK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_FALLBACK.exec(lineText)) !== null) {
    if (isEscapedAt(lineText, m.index)) continue;
    const from = lineFrom + m.index;
    const to = from + m[0].length;
    if (m[1]) {
      ranges.push({ from, to, contentFrom: from + 2, contentTo: to - 2 });
      continue;
    }
    if (m[3]) {
      const before = from > 0 && m.index > 0 ? lineText[m.index - 1] : "";
      const afterIndex = m.index + m[0].length;
      const after = to < docLength && afterIndex < lineText.length ? lineText[afterIndex] : "";
      const isWordChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);
      if (!isWordChar(before) && !isWordChar(after)) {
        ranges.push({ from, to, contentFrom: from + 1, contentTo: to - 1 });
      }
      continue;
    }
    if (m[5]) {
      ranges.push({ from, to, contentFrom: from + 1, contentTo: to - 1 });
      continue;
    }
    if (m[7]) {
      const label = m[8] || "";
      ranges.push({ from, to, contentFrom: from + 1, contentTo: from + 1 + label.length });
      continue;
    }
    if (m[10]) {
      ranges.push({ from, to, contentFrom: from, contentTo: to });
      continue;
    }
    if (m[13]) {
      if (isValidInlineMathCandidate(lineText, m.index, m.index + m[0].length)) {
        ranges.push({ from, to, contentFrom: from + 1, contentTo: to - 1 });
      }
      continue;
    }
    if (m[15]) {
      ranges.push({ from, to, contentFrom: from + 2, contentTo: to - 2 });
    }
  }
  return ranges;
}

function getRenderedLineBoundaries(view: EditorView, lineNumber: number): RenderedLineBoundaries {
  try {
    if (!view.state.facet(wysiwygKeepActiveLineRenderedFacet)) return { start: null, end: null };
    if (shouldRevealSourceForSelectionLine(view, lineNumber)) return { start: null, end: null };
    const line = view.state.doc.line(lineNumber);
    const text = view.state.doc.sliceString(line.from, line.to);
    if (isToolOrThinkingLine(text)) return { start: null, end: null };

    let visibleStart = line.from;
    let blockPrefixOffset = 0;
    const quotePrefix = /^[ \t]*(?:>[ \t]*)+/.exec(text);
    if (quotePrefix) blockPrefixOffset = quotePrefix[0].length;
    const afterQuote = text.slice(blockPrefixOffset);
    const taskListPrefix = /^([ \t]*)(?:[-+*]|\d+[.)])([ \t]+)\[[ xX]\]([ \t]+)/.exec(afterQuote);
    const listPrefix = /^([ \t]*)(?:[-+*]|\d+[.)])([ \t]+)/.exec(afterQuote);
    if (taskListPrefix) {
      blockPrefixOffset += taskListPrefix[0].length;
    } else if (listPrefix) {
      blockPrefixOffset += listPrefix[0].length;
    }
    const afterList = text.slice(blockPrefixOffset);
    const heading = /^([ \t]*)(#{1,6})([ \t]+)/.exec(afterList);
    if (heading) blockPrefixOffset += heading[0].length;
    visibleStart = line.from + blockPrefixOffset;

    const inlineRanges = collectRenderedInlineRangesInLine(text, line.from, view.state.doc.length);
    let changed = true;
    while (changed) {
      changed = false;
      const range = inlineRanges.find((item) => item.from === visibleStart && item.contentFrom > visibleStart);
      if (range && range.contentFrom <= range.contentTo) {
        visibleStart = range.contentFrom;
        changed = true;
      }
    }

    let visibleEnd = line.to;
    changed = true;
    while (changed) {
      changed = false;
      const range = inlineRanges.find((item) => item.to === visibleEnd && item.contentTo < visibleEnd);
      if (range && range.contentFrom <= range.contentTo) {
        visibleEnd = range.contentTo;
        changed = true;
      }
    }

    return {
      start: visibleStart !== line.from ? visibleStart : null,
      end: visibleEnd !== line.to ? visibleEnd : null
    };
  } catch {
    return { start: null, end: null };
  }
}

function addNestedInlineDecorations(add: AddDecoration, state: EditorState, contentStart: number, content: string) {
  const nested = /(`([^`\n]+)`)|(!\[([^\]]*)\]\(([^)\n]+)\))|(\[([^\]]+)\]\(([^)\n]+)\))|(\$([^\$\n]+)\$)/g;
  let m: RegExpExecArray | null;
  while ((m = nested.exec(content)) !== null) {
    const start = contentStart + m.index;
    const end = start + m[0].length;
    if (m[1]) {
      add(start, start + 1, hiddenSyntaxDecoration(state, start, start + 1));
      add(start + 1, end - 1, Decoration.mark({ class: "cm-md-code" }));
      add(end - 1, end, hiddenSyntaxDecoration(state, end - 1, end));
      continue;
    }
    if (m[3]) {
      const alt = m[4] || "";
      const src = m[5] || "";
      if (!selectionTouchesRange(state, start, end)) {
        add(start, end, hiddenSyntaxDecoration(state, start, end));
        add(start, start, Decoration.widget({
          widget: new SimpleImageWidget(alt, src, "inline", start, end),
          side: 1
        }));
      }
      continue;
    }
    if (m[6]) {
      const label = m[7] || "";
      const url = m[8] || "";
      if (!selectionTouchesRange(state, start, end)) {
        add(start, end, hiddenSyntaxDecoration(state, start, end));
        add(start, start, Decoration.widget({ widget: new SimpleLinkWidget(label, url), side: 1 }));
      }
      continue;
    }
    if (m[9]) {
      const expr = m[10] || "";
      if (!isValidInlineMathCandidate(content, m.index, m.index + m[0].length)) continue;
      if (!selectionTouchesRange(state, start, end)) {
        add(start, end, hiddenSyntaxDecoration(state, start, end));
        add(start, start, Decoration.widget({ widget: new MathWidget(expr, false), side: 1 }));
      }
    }
  }
}

function getRoleBlockRange(doc: EditorView["state"]["doc"], pos: number) {
  const safePos = Math.max(0, Math.min(pos, doc.length));
  const currentLine = doc.lineAt(safePos);
  let startLine = 1;
  for (let ln = currentLine.number; ln >= 1; ln--) {
    const line = doc.line(ln);
    startLine = ln;
    if (isRoleHeadLine(doc.sliceString(line.from, line.to))) break;
  }
  let endLine = doc.lines;
  for (let ln = startLine + 1; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    if (isRoleHeadLine(doc.sliceString(line.from, line.to))) {
      endLine = ln - 1;
      break;
    }
  }
  return {
    from: doc.line(startLine).from,
    to: doc.line(endLine).to,
    startLine,
    endLine
  };
}

type RoleFenceBlock = {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  hasClosingFence: boolean;
  lang: string;
};

function collectRoleScopedFenceBlocks(doc: EditorView["state"]["doc"]): RoleFenceBlock[] {
  const blocks: RoleFenceBlock[] = [];
  let roleStartLine = 1;
  while (roleStartLine <= doc.lines) {
    let roleEndLine = roleStartLine;
    while (roleEndLine < doc.lines) {
      const next = doc.line(roleEndLine + 1);
      if (isRoleHeadLine(doc.sliceString(next.from, next.to))) break;
      roleEndLine++;
    }

    let openStartLine = -1;
    let openLang = "";
    for (let ln = roleStartLine; ln <= roleEndLine; ln++) {
      const line = doc.line(ln);
      const text = doc.sliceString(line.from, line.to).trim();
      if (openStartLine === -1) {
        const match = FENCE_START_RE.exec(text);
        if (match) {
          openStartLine = ln;
          openLang = String(match[1] || "").toLowerCase();
        }
        continue;
      }

      if (FENCE_CLOSE_RE.test(text)) {
        blocks.push({
          from: doc.line(openStartLine).from,
          to: line.to,
          startLine: openStartLine,
          endLine: ln,
          hasClosingFence: true,
          lang: openLang
        });
        openStartLine = -1;
        openLang = "";
      }
    }

    if (openStartLine !== -1) {
      blocks.push({
        from: doc.line(openStartLine).from,
        to: doc.line(roleEndLine).to,
        startLine: openStartLine,
        endLine: roleEndLine,
        hasClosingFence: false,
        lang: openLang
      });
    }

    roleStartLine = roleEndLine + 1;
  }
  return blocks;
}

function canMapRoleFenceBlocks(blocks: RoleFenceBlock[], tr: Transaction): boolean {
  let reusable = true;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (!reusable) return;
    if (/[`\n\r]/.test(inserted.toString())) {
      reusable = false;
      return;
    }

    const oldFromLine = tr.startState.doc.lineAt(fromA);
    const oldToLine = tr.startState.doc.lineAt(toA);
    const newFromLine = tr.state.doc.lineAt(fromB);
    const newToLine = tr.state.doc.lineAt(toB);
    if (oldFromLine.number !== oldToLine.number || newFromLine.number !== newToLine.number) {
      reusable = false;
      return;
    }

    const oldRolePrefix = ROLE_HEAD_RE.exec(oldFromLine.text)?.[0] || "";
    const newRolePrefix = ROLE_HEAD_RE.exec(newFromLine.text)?.[0] || "";
    const oldOffset = fromA - oldFromLine.from;
    const newOffset = fromB - newFromLine.from;
    if (
      (oldRolePrefix && oldOffset < oldRolePrefix.length) ||
      (newRolePrefix && newOffset < newRolePrefix.length)
    ) {
      reusable = false;
      return;
    }

    for (const block of blocks) {
      if (
        oldFromLine.number === block.startLine ||
        (block.hasClosingFence && oldFromLine.number === block.endLine)
      ) {
        reusable = false;
        return;
      }
    }
  });
  return reusable;
}

function mapRoleFenceBlock(block: RoleFenceBlock, tr: Transaction): RoleFenceBlock {
  return {
    ...block,
    from: tr.changes.mapPos(block.from, 1),
    to: tr.changes.mapPos(block.to, block.hasClosingFence ? -1 : 1)
  };
}

const roleFenceBlocksField = StateField.define<RoleFenceBlock[]>({
  create(state) {
    return collectRoleScopedFenceBlocks(state.doc);
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    if (canMapRoleFenceBlocks(value, tr)) {
      return value.map((block) => mapRoleFenceBlock(block, tr));
    }
    return collectRoleScopedFenceBlocks(tr.state.doc);
  }
});

type RoleLineRange = {
  startLine: number;
  endLine: number;
};

function collectRoleLineRanges(doc: EditorView["state"]["doc"]): RoleLineRange[] {
  const ranges: RoleLineRange[] = [];
  let startLine = 1;
  while (startLine <= doc.lines) {
    let endLine = startLine;
    while (endLine < doc.lines) {
      const next = doc.line(endLine + 1);
      if (isRoleHeadLine(doc.sliceString(next.from, next.to))) break;
      endLine++;
    }
    ranges.push({ startLine, endLine });
    startLine = endLine + 1;
  }
  return ranges;
}

function collectMarkdownTableRanges(
  doc: EditorView["state"]["doc"],
  isInsideFencedCode: (pos: number) => boolean
): TablePreviewRange[] {
  const ranges: TablePreviewRange[] = [];
  const roleLineRanges = collectRoleLineRanges(doc);
  let roleLineRangeIndex = 0;
  const getRoleLineRange = (lineNo: number): RoleLineRange => {
    while (roleLineRangeIndex < roleLineRanges.length - 1 && lineNo > roleLineRanges[roleLineRangeIndex].endLine) {
      roleLineRangeIndex++;
    }
    return roleLineRanges[roleLineRangeIndex] || { startLine: 1, endLine: doc.lines };
  };
  let ln = 1;
  while (ln <= doc.lines) {
    const line = doc.line(ln);
    const text = doc.sliceString(line.from, line.to);
    if (isInsideFencedCode(line.from) || isToolOrThinkingLine(text) || !isMarkdownTableContentRow(text)) {
      ln++;
      continue;
    }

    try {
      const roleRange = getRoleLineRange(ln);
      let start = ln;
      while (start > 1) {
        const prev = doc.line(start - 1);
        const prevText = doc.sliceString(prev.from, prev.to);
        if (start - 1 < roleRange.startLine) break;
        if (isInsideFencedCode(prev.from)) break;
        if (!isMarkdownTableContentRow(prevText)) break;
        start--;
      }

      const sepLn = start + 1;
      if (sepLn > doc.lines) {
        ln++;
        continue;
      }

      const headerLine = doc.line(start);
      const headerText = doc.sliceString(headerLine.from, headerLine.to);
      const sepLine = doc.line(sepLn);
      const sepText = doc.sliceString(sepLine.from, sepLine.to);
      if (!isMarkdownTableContentRow(headerText) || !isMarkdownTableSeparatorRow(sepText)) {
        ln++;
        continue;
      }

      const rows: string[][] = [];
      const sourceLines: TableSourceLine[] = [
        { from: headerLine.from, to: headerLine.to, text: headerText },
        { from: sepLine.from, to: sepLine.to, text: sepText }
      ];
      let rowLn = sepLn + 1;
      while (rowLn <= doc.lines) {
        const rowLine = doc.line(rowLn);
        const rowText = doc.sliceString(rowLine.from, rowLine.to);
        if (rowLn > roleRange.endLine) break;
        if (!isMarkdownTableContentRow(rowText) || isInsideFencedCode(rowLine.from)) break;
        rows.push(splitMarkdownTableCells(rowText));
        sourceLines.push({ from: rowLine.from, to: rowLine.to, text: rowText });
        rowLn++;
      }

      ranges.push({
        from: headerLine.from,
        to: doc.line(rowLn - 1).to,
        startLine: start,
        endLine: rowLn - 1,
        headers: splitMarkdownTableCells(headerText),
        aligns: parseMarkdownTableAligns(sepText),
        rows,
        sourceLines
      });
      ln = rowLn;
      continue;
    } catch (err) {
      console.error("[wysiwyg] table range collection error", err);
    }

    ln++;
  }
  return ranges;
}

type SourceRange = { from: number; to: number };

function collectStateBlockMathRanges(state: EditorState, from = 0, to = state.doc.length): SourceRange[] {
  const ranges: SourceRange[] = [];
  try {
    const tree = syntaxTree(state) as any;
    tree.iterate({
      from,
      to,
      enter: (node: any) => {
        const name = node.name || node.type?.name;
        if (name === "BlockMath") {
          ranges.push({ from: node.from, to: node.to });
        }
      }
    });
  } catch {}
  return ranges;
}

function isStateInsideFencedCode(roleFenceBlocks: RoleFenceBlock[], blockMathRanges: SourceRange[], pos: number): boolean {
  for (const block of roleFenceBlocks) {
    if (pos >= block.from && pos <= block.to) return true;
  }
  for (const range of blockMathRanges) {
    if (pos >= range.from && pos < range.to) return true;
  }
  return false;
}

function selectionIntersectsTable(state: EditorState, range: TablePreviewRange): boolean {
  for (const sel of state.selection.ranges) {
    if (sel.empty) {
      if (sel.from >= range.from && sel.from < range.to) return true;
    } else if (sel.from < range.to && sel.to > range.from) {
      return true;
    }
  }
  return false;
}

type TableBlockState = {
  ranges: TablePreviewRange[];
  decorations: ReturnType<typeof Decoration.set>;
  rawTables: Set<number>;
};

const tableRawEditEffect = StateEffect.define<number>();

function buildTableBlockState(state: EditorState): TableBlockState {
  const doc = state.doc;
  const roleFenceBlocks = state.field(roleFenceBlocksField, false) || collectRoleScopedFenceBlocks(doc);
  const blockMathRanges = collectStateBlockMathRanges(state);
  const ranges = collectMarkdownTableRanges(doc, (pos) => isStateInsideFencedCode(roleFenceBlocks, blockMathRanges, pos));
  return buildTableBlockStateFromRanges(state, ranges);
}

function pruneRawTablesForSelection(state: EditorState, ranges: TablePreviewRange[], rawTables: Set<number>): Set<number> {
  if (!rawTables.size) return rawTables;
  const next = new Set<number>();
  for (const range of ranges) {
    if (rawTables.has(range.from) && selectionIntersectsTable(state, range)) {
      next.add(range.from);
    }
  }
  return next;
}

function mapRawTables(rawTables: Set<number>, changes: Transaction["changes"]): Set<number> {
  if (!rawTables.size) return rawTables;
  const next = new Set<number>();
  for (const pos of rawTables) {
    next.add(changes.mapPos(pos, 1));
  }
  return next;
}

function buildTableBlockStateFromRanges(state: EditorState, ranges: TablePreviewRange[], rawTables = new Set<number>()): TableBlockState {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) {
    if (rawTables.has(range.from)) continue;
    builder.add(range.from, range.to, Decoration.replace({
      widget: new TableBlockWidget(range),
      block: true
    }));
  }
  return { ranges, decorations: builder.finish(), rawTables };
}

function mapTableRange(range: TablePreviewRange, changes: Transaction["changes"]): TablePreviewRange {
  return {
    ...range,
    from: changes.mapPos(range.from, 1),
    to: changes.mapPos(range.to, -1),
    sourceLines: range.sourceLines.map(line => ({
      ...line,
      from: changes.mapPos(line.from, 1),
      to: changes.mapPos(line.to, -1)
    }))
  };
}

function canReuseTableRangesOnChange(state: TableBlockState, tr: Transaction): boolean {
  let safe = true;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!safe) return;
    const text = inserted.toString();
    if (/[|\n\r]/.test(text)) {
      safe = false;
      return;
    }
    for (const range of state.ranges) {
      // Edits just outside a table can turn adjacent lines into table rows, so
      // keep a small guard band around known table ranges.
      if (fromA <= range.to + 2 && toA >= range.from - 2) {
        safe = false;
        return;
      }
    }
  });
  return safe;
}

const tableBlockDecorationsField = StateField.define({
  create(state) {
    return buildTableBlockState(state);
  },
  update(value, tr) {
    let rawTables = value.rawTables;
    let rawModeChanged = false;
    for (const effect of tr.effects) {
      if (effect.is(tableRawEditEffect)) {
        if (!rawModeChanged) rawTables = new Set(rawTables);
        rawTables.add(effect.value);
        rawModeChanged = true;
      }
    }
    if (tr.docChanged) {
      rawTables = mapRawTables(rawTables, tr.changes);
      if (canReuseTableRangesOnChange(value, tr)) {
        return buildTableBlockStateFromRanges(tr.state, value.ranges.map(range => mapTableRange(range, tr.changes)), rawTables);
      }
      const next = buildTableBlockState(tr.state);
      return buildTableBlockStateFromRanges(tr.state, next.ranges, pruneRawTablesForSelection(tr.state, next.ranges, rawTables));
    }
    if (tr.selection || rawModeChanged) {
      return buildTableBlockStateFromRanges(tr.state, value.ranges, pruneRawTablesForSelection(tr.state, value.ranges, rawTables));
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});

const wysiwygHeightCache = new Map<string, number>();

function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function applyCachedMinHeight(el: HTMLElement, key: string) {
  const h = wysiwygHeightCache.get(key);
  if (typeof h === "number" && isFinite(h) && h > 0) {
    el.style.minHeight = `${h}px`;
  }
}

function updateCachedHeight(el: HTMLElement, key: string) {
  try {
    const r = el.getBoundingClientRect();
    const h = Math.round(r.height);
    if (isFinite(h) && h > 0) wysiwygHeightCache.set(key, h);
  } catch {}
}

function getCachedEstimatedHeight(key: string, fallback: number) {
  const h = wysiwygHeightCache.get(key);
  return typeof h === "number" && isFinite(h) && h > 0 ? h : fallback;
}

function sanitizeTableCellText(s: string): string {
  return s.replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();
}

function buildMarkdownTableSource(headers: string[], aligns: Array<"left" | "center" | "right">, rows: string[][]) {
  const headerLine = "| " + headers.map(sanitizeTableCellText).join(" | ") + " |";
  const alignToken = (a: "left" | "center" | "right") => {
    if (a === "center") return ":---:";
    if (a === "right") return "---:";
    return ":---";
  };
  const sepLine = "| " + aligns.map(a => alignToken(a)).join(" | ") + " |";
  const rowLines = rows.map(r => "| " + r.map(sanitizeTableCellText).join(" | ") + " |");
  return [headerLine, sepLine, ...rowLines].join("\n");
}

function getTableHeightCacheKey(headers: string[], aligns: Array<"left" | "center" | "right">, rows: string[][]) {
  return `table:${hashString(buildMarkdownTableSource(headers, aligns, rows))}`;
}

function estimateTableHeight(headers: string[], rows: string[][]) {
  const rowCount = Math.max(1, rows.length + 1);
  const cells = [...headers, ...rows.flat()];
  const longestCell = cells.reduce((max, cell) => Math.max(max, cell.length), 0);
  const wrappedLineAllowance = Math.max(0, Math.ceil(longestCell / 28) - 1);
  return Math.max(96, 54 + rowCount * 42 + wrappedLineAllowance * 18);
}

/* Widget implementations (small, eq provided for reuse) */

class SimpleLinkWidget extends WidgetType {
  constructor(private label: string, private url: string) { super(); }
  eq(other: SimpleLinkWidget) { return other.label === this.label && other.url === this.url; }
  toDOM() {
    const a = document.createElement("a");
    a.className = "cm-md-link";
    const href = safeMarkdownHref(this.url);
    if (href) a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    appendTableInlineMarkdown(a, this.label);
    a.title = this.url;
    return a;
  }
  ignoreEvent() { return true; }
}

const IMAGE_DRAG_MIME = "application/x-zion-editor-image";

function setImageSourceMetadata(
  element: HTMLElement,
  image: Pick<MarkdownImage, "alt" | "src" | "markdown" | "from" | "to">
) {
  element.dataset.imageAlt = image.alt;
  element.dataset.imageSrc = image.src;
  element.dataset.imageMarkdown = image.markdown;
  element.dataset.imageFrom = String(image.from);
  element.dataset.imageTo = String(image.to);
}

function makeImageDraggable(
  element: HTMLElement,
  view: EditorView,
  image: Pick<MarkdownImage, "alt" | "src" | "markdown" | "from" | "to">
) {
  if (view.state.readOnly) return;
  element.draggable = true;
  element.addEventListener("dragstart", (event) => {
    try {
      event.dataTransfer?.setData(IMAGE_DRAG_MIME, JSON.stringify({
        markdown: image.markdown,
        from: image.from,
        to: image.to
      }));
      event.dataTransfer?.setData("text/plain", image.markdown);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    } catch {}
    event.stopPropagation();
  });
  element.addEventListener("dragend", () => hideImageDropIndicator(view));
}

function createImageElement(
  image: Pick<MarkdownImage, "alt" | "src" | "markdown" | "from" | "to">,
  kind: ImageDisplayKind,
  wrap: HTMLElement
): HTMLImageElement {
  const img = document.createElement("img");
  img.className = `cm-md-img cm-md-img-${kind}`;
  img.alt = image.alt || "";
  img.referrerPolicy = "no-referrer";
  img.loading = "lazy";
  img.addEventListener("load", () => {
    requestAnimationFrame(() => {
      const cacheKey = `img:${kind}:${image.src || ""}`;
      updateCachedHeight(wrap, cacheKey);
      applyCachedMinHeight(wrap, cacheKey);
    });
  });
  return img;
}

class SimpleImageWidget extends WidgetType {
  constructor(
    private alt: string,
    private src: string,
    private kind: ImageDisplayKind = "inline",
    private from = -1,
    private to = -1
  ) {
    super();
  }

  eq(other: SimpleImageWidget) {
    return other.alt === this.alt
      && other.src === this.src
      && other.kind === this.kind
      && other.from === this.from
      && other.to === this.to;
  }

  toDOM(view: EditorView) {
    const markdown = `![${this.alt}](${this.src})`;
    const image = {
      alt: this.alt,
      src: this.src,
      markdown,
      from: this.from,
      to: this.to
    };
    const wrap = document.createElement("span");
    wrap.className = `cm-md-img-wrap cm-md-img-wrap-${this.kind}`;
    setImageSourceMetadata(wrap, image);
    const cacheKey = `img:${this.kind}:${this.src || ""}`;
    applyCachedMinHeight(wrap, cacheKey);

    const fallback = document.createElement("span");
    fallback.className = "cm-md-img-fallback";
    appendTableInlineMarkdown(fallback, this.alt || "[image]");
    wrap.appendChild(fallback);

    imageUrlForView(this.src || "", view).then((url) => {
      if (!url || !wrap.isConnected) return;
      const img = createImageElement(image, this.kind, wrap);
      setImageSourceMetadata(img, image);
      makeImageDraggable(img, view, image);
      img.addEventListener("error", () => {
        requestAnimationFrame(() => {
          if (!img.parentNode) return;
          const replacement = fallback.cloneNode(true);
          img.parentNode.replaceChild(replacement, img);
        });
      });
      img.src = url;
      requestAnimationFrame(() => {
        try { wrap.replaceChild(img, fallback); } catch {}
      });
    }).catch(() => {});

    return wrap;
  }

  ignoreEvent() { return true; }
}

class ImageGalleryWidget extends WidgetType {
  constructor(private items: MarkdownImage[]) {
    super();
  }

  eq(other: ImageGalleryWidget) {
    return other.items.length === this.items.length
      && other.items.every((item, index) => {
        const current = this.items[index];
        return item.src === current.src
          && item.alt === current.alt
          && item.from === current.from
          && item.to === current.to;
      });
  }

  toDOM(view: EditorView) {
    const root = document.createElement("div");
    root.className = "cm-md-gallery";
    root.dataset.imageCount = String(this.items.length);
    for (const item of this.items) {
      const cell = document.createElement("span");
      cell.className = "cm-md-img-wrap cm-md-gallery-cell";
      setImageSourceMetadata(cell, item);
      const fallback = document.createElement("span");
      fallback.className = "cm-md-img-fallback";
      fallback.textContent = item.alt || "[image]";
      cell.appendChild(fallback);
      makeImageDraggable(cell, view, item);
      imageUrlForView(item.src, view).then((url) => {
        if (!url || !cell.isConnected) return;
        const img = createImageElement(item, "gallery", cell);
        setImageSourceMetadata(img, item);
        img.src = url;
        requestAnimationFrame(() => {
          try { cell.replaceChild(img, fallback); } catch {}
        });
      }).catch(() => {});
      root.appendChild(cell);
    }
    const badge = document.createElement("span");
    badge.className = "cm-md-gallery-badge";
    badge.textContent = `${this.items.length} 张`;
    root.appendChild(badge);
    return root;
  }

  ignoreEvent() { return true; }
}

function collectImageGroups(state: EditorState) {
  const roleBlocks = state.field(roleFenceBlocksField, false) || collectRoleScopedFenceBlocks(state.doc);
  const mathBlocks = collectStateBlockMathRanges(state);
  return collectStandaloneImageGroups(state.doc, (from, to) => {
    if (roleBlocks.some(block => from < block.to && to > block.from)) return true;
    if (mathBlocks.some(block => from < block.to && to > block.from)) return true;
    return isToolOrThinkingLine(state.doc.sliceString(from, to));
  });
}

function selectionIntersectsRange(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some(range =>
    range.empty
      ? range.from >= from && range.from < to
      : range.from < to && range.to > from
  );
}

function buildImageGalleryDecorations(state: EditorState) {
  const keepActiveLineRendered = state.facet(wysiwygKeepActiveLineRenderedFacet);
  const ranges = [];
  for (const group of collectImageGroups(state)) {
    if (group.items.length < 2) continue;
    if (!keepActiveLineRendered && selectionIntersectsRange(state, group.from, group.to)) continue;
    ranges.push(
      Decoration.replace({
        widget: new ImageGalleryWidget(group.items),
        block: true
      }).range(group.from, group.to)
    );
  }
  return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
}

const imageGalleryField = StateField.define({
  create(state) {
    return buildImageGalleryDecorations(state);
  },
  update(value, transaction) {
    const refresh = transaction.annotation(Transaction.userEvent) === "wysiwyg-refresh";
    if (transaction.docChanged || transaction.selection || refresh) {
      return buildImageGalleryDecorations(transaction.state);
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field)
});

const imageInternalDragHandlers = EditorView.domEventHandlers({
  dragover(event, view) {
    const types = [...(event.dataTransfer?.types || [])];
    if (!types.includes(IMAGE_DRAG_MIME)) return false;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    showImageDropIndicator(view, { x: event.clientX, y: event.clientY }, {
      count: 1,
      moving: true
    });
    return true;
  },
  dragleave(event, view) {
    const related = event.relatedTarget;
    if (!(related instanceof Node) || !view.dom.contains(related)) {
      hideImageDropIndicator(view);
    }
    return false;
  },
  drop(event, view) {
    const raw = event.dataTransfer?.getData(IMAGE_DRAG_MIME);
    if (!raw) return false;
    event.preventDefault();
    hideImageDropIndicator(view);
    try {
      const payload = JSON.parse(raw) as { markdown?: string; from?: number; to?: number };
      const markdown = String(payload.markdown || "");
      const from = Number(payload.from);
      const to = Number(payload.to);
      if (!markdown || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) {
        return true;
      }
      if (view.state.sliceDoc(from, to) !== markdown) return true;
      const target = getImageDropTarget(view, { x: event.clientX, y: event.clientY }, 1);
      if (target.position >= from && target.position <= to) return true;
      const insert = formatImageInsertion(
        view.state.doc,
        target.position,
        target.position,
        markdown,
        target.kind
      );
      const changes = view.state.changes([
        { from, to, insert: "" },
        { from: target.position, to: target.position, insert }
      ].sort((left, right) => left.from - right.from));
      view.dispatch({
        changes,
        selection: { anchor: changes.mapPos(target.position, 1) },
        scrollIntoView: true,
        userEvent: "move.image"
      });
    } catch {}
    return true;
  }
});

class SimpleCodeWidget extends WidgetType {
  constructor(private code: string) { super(); }
  eq(other: SimpleCodeWidget) { return other.code === this.code; }
  toDOM() {
    const el = document.createElement("code");
    el.className = "cm-md-code";
    el.textContent = this.code;
    return el;
  }
  ignoreEvent() { return true; }
}

class KbdWidget extends WidgetType {
  constructor(private label: string) { super(); }
  eq(other: KbdWidget) { return other.label === this.label; }
  toDOM() {
    const el = document.createElement("kbd");
    el.className = "cm-md-kbd";
    el.textContent = this.label;
    return el;
  }
  ignoreEvent() { return true; }
}

class FootnoteRefWidget extends WidgetType {
  constructor(private id: string) { super(); }
  eq(other: FootnoteRefWidget) { return other.id === this.id; }
  toDOM() {
    const sup = document.createElement("sup");
    sup.className = "cm-md-footnote-ref";
    sup.textContent = this.id;
    sup.title = `脚注 ${this.id}`;
    return sup;
  }
  ignoreEvent() { return true; }
}

class HeadingWidget extends WidgetType {
  constructor(private text: string, private level: number) { super(); }
  eq(other: HeadingWidget) { return other.text === this.text && other.level === this.level; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-md-heading";
    const lvl = Math.min(6, Math.max(1, this.level));
    span.style.fontSize = `var(--md-h${lvl}-size, 1em)`;
    // Use inner text only; inline parsing left to fallback renderer if needed
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() { return true; }
}

class TaskWidget extends WidgetType {
  constructor(private checked: boolean, private label: string, private selected = false) { super(); }
  eq(other: TaskWidget) {
    return other.checked === this.checked && other.label === this.label && other.selected === this.selected;
  }
  toDOM(view: EditorView) {
    const container = document.createElement("span");
    container.className = this.selected ? "cm-md-task cm-md-marker-selected" : "cm-md-task";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!this.checked;
    checkbox.disabled = view.state.readOnly;
    if (this.label) checkbox.setAttribute("aria-label", `Task: ${this.label}`);
    checkbox.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const pos = view.posAtDOM(container);
        const cur = view.state.doc.sliceString(pos + 1, pos + 2);
        const replacement = /\bx\b/i.test(cur) ? " " : "x";
        view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: replacement } });
      } catch (err) {
        console.error("[wysiwyg] task toggle", err);
      }
    });
    container.appendChild(checkbox);
    return container;
  }
  // Prevent editor from moving cursor when clicking diagram area, so toolbar stays clickable.
  ignoreEvent() { return true; }
}

class MathWidget extends WidgetType {
  constructor(private expr: string, private display: boolean) { super(); }
  eq(other: MathWidget) { return other.expr === this.expr && other.display === this.display; }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.display ? "cm-md-math-block" : "cm-md-math-inline";
    try {
      katex.render(this.expr, el, { throwOnError: false, displayMode: this.display });
    } catch (err) {
      el.textContent = this.expr;
      el.classList.add("cm-md-math-error");
    }
    return el;
  }
  ignoreEvent() { return true; }
}

/**
 * Lightweight read-only table preview.
 *
 * Editing is intentionally kept out of the block widget. A full editable table
 * DOM inside CodeMirror couples cell layout, contentEditable events, and virtual
 * scroll height estimation too tightly, which is the source of the jumpiness in
 * table-heavy documents. Users can switch to Markdown source mode explicitly.
 */
class TableWidget extends WidgetType {
  constructor(
    private view: EditorView,
    private headers: string[],
    private aligns: Array<"left" | "center" | "right">,
    private rows: string[][],
    private sourceLines: TableSourceLine[],
    private commentRanges: TableCommentRange[],
    private sourceFrom: number,
    private onEditSource: () => void
  ) {
    super();
    const normalized = normalizeTableRows(headers, aligns, rows);
    this.headers = normalized.headers;
    this.aligns = normalized.aligns;
    this.rows = normalized.rows;
  }

  get estimatedHeight() {
    return getCachedEstimatedHeight(
      getTableHeightCacheKey(this.headers, this.aligns, this.rows),
      estimateTableHeight(this.headers, this.rows)
    );
  }

  eq(other: TableWidget) {
    const sameHdr = this.headers.join("|") === other.headers.join("|");
    const sameAlign = this.aligns.join(",") === other.aligns.join(",");
    const thisRows = this.rows.map(r => r.join("|")).join("\n");
    const otherRows = other.rows.map(r => r.join("|")).join("\n");
      const thisComments = this.commentRanges.map(r => `${r.id}:${r.from}-${r.to}:${r.active ? 1 : 0}`).join("|");
      const otherComments = other.commentRanges.map(r => `${r.id}:${r.from}-${r.to}:${r.active ? 1 : 0}`).join("|");
    // 列宽不是语义的一部分，不参与 eq 比较
      return sameHdr && sameAlign && thisRows === otherRows && thisComments === otherComments;
  }

  private buildMarkdown(): string {
    return buildMarkdownTableSource(this.headers, this.aligns, this.rows);
  }

  private renderReadOnlyCell(cell: HTMLTableCellElement, value: string, sourceRange: TableCellSourceRange | null) {
    const content = document.createElement("span");
    content.className = "cm-md-table-cell-content";
    if (sourceRange) {
      content.dataset.sourceFrom = String(sourceRange.from);
      content.dataset.sourceTo = String(sourceRange.to);
      content.dataset.sourceText = value;
    }
    const cellComments = sourceRange
      ? this.commentRanges.filter((item) => item.to > sourceRange.from && item.from < sourceRange.to)
      : [];
    appendTableInlineMarkdownWithComments(content, value, sourceRange, cellComments);
    cell.appendChild(content);
  }

  private getSelectionOffsetWithinCell(cell: HTMLElement, node: Node, offset: number): number | null {
    try {
      const range = document.createRange();
      range.selectNodeContents(cell);
      range.setEnd(node, offset);
      const result = range.toString().length;
      range.detach?.();
      return result;
    } catch {
      return null;
    }
  }

  private getSelectedCellContent(node: Node | null, wrap: HTMLElement): HTMLElement | null {
    const el = node instanceof HTMLElement ? node : node?.parentElement;
    const content = el?.closest?.(".cm-md-table-cell-content[data-source-from]") as HTMLElement | null;
    return content && wrap.contains(content) ? content : null;
  }

  private clearSelectionToolbarDomAnchor() {
    try {
      (window as any).zion?.state?.set?.("selectionToolbar.domAnchorRect", null);
      window.dispatchEvent(new Event("selectionToolbar.domAnchorChanged"));
    } catch {}
  }

  private updateSelectionToolbarDomAnchor(wrap: HTMLElement) {
    try {
      const selection = window.getSelection?.();
      if (!selection || selection.isCollapsed || selection.rangeCount <= 0) {
        this.clearSelectionToolbarDomAnchor();
        return;
      }
      const range = selection.getRangeAt(0);
      const startCell = this.getSelectedCellContent(range.startContainer, wrap);
      const endCell = this.getSelectedCellContent(range.endContainer, wrap);
      if (!startCell || !endCell) {
        this.clearSelectionToolbarDomAnchor();
        return;
      }

      const startOffset = this.getSelectionOffsetWithinCell(startCell, range.startContainer, range.startOffset);
      const endOffset = this.getSelectionOffsetWithinCell(endCell, range.endContainer, range.endOffset);
      if (startOffset == null || endOffset == null) {
        this.clearSelectionToolbarDomAnchor();
        return;
      }

      const startSource = String(startCell.dataset.sourceText || "");
      const endSource = String(endCell.dataset.sourceText || "");
      const startFrom = Number(startCell.dataset.sourceFrom);
      const endFrom = Number(endCell.dataset.sourceFrom);
      if (!Number.isFinite(startFrom) || !Number.isFinite(endFrom)) {
        this.clearSelectionToolbarDomAnchor();
        return;
      }

      let from = startFrom + mapTableCellVisibleOffsetToSource(startSource, startOffset);
      let to = endFrom + mapTableCellVisibleOffsetToSource(endSource, endOffset);
      if (to < from) [from, to] = [to, from];
      const selectionText = selection.toString();
      const rect = range.getBoundingClientRect();
      if (to <= from || !selectionText.trim() || rect.width <= 0 || rect.height <= 0) {
        this.clearSelectionToolbarDomAnchor();
        return;
      }

      (window as any).zion?.state?.set?.("selectionToolbar.domAnchorRect", {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        from,
        to,
        selectionText,
        view: this.view,
        ts: Date.now()
      });
      window.dispatchEvent(new Event("selectionToolbar.domAnchorChanged"));
    } catch {
      this.clearSelectionToolbarDomAnchor();
    }
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap cm-md-table-readonly";
    const cacheKey = getTableHeightCacheKey(this.headers, this.aligns, this.rows);
    applyCachedMinHeight(wrap, cacheKey);
    const keepEventInTable = (e: Event) => {
      if (!(e.target instanceof HTMLElement)) return;
      if (e.target.closest(".cm-md-table-btn")) return;
      if (e.type === "pointerdown" || e.type === "mousedown") this.clearSelectionToolbarDomAnchor();
      e.stopPropagation();
    };
    wrap.addEventListener("pointerdown", keepEventInTable);
    wrap.addEventListener("mousedown", keepEventInTable);
    wrap.addEventListener("pointerup", () => {
      window.setTimeout(() => this.updateSelectionToolbarDomAnchor(wrap), 0);
    });
    wrap.addEventListener("click", keepEventInTable);

    const toolbar = document.createElement("div");
    toolbar.className = "cm-md-table-toolbar";
    const stopActionEvent = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const editBtn = document.createElement("button");
    editBtn.className = "cm-md-table-btn";
    editBtn.type = "button";
    editBtn.textContent = "源码";
    editBtn.title = "切换到 Markdown 表格源码编辑";
    editBtn.onpointerdown = stopActionEvent;
    editBtn.onmousedown = stopActionEvent;
    editBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { this.onEditSource(); } catch {}
    };
    if (!this.view.state.readOnly) toolbar.appendChild(editBtn);

    const copyBtn = document.createElement("button");
    copyBtn.className = "cm-md-table-btn";
    copyBtn.type = "button";
    copyBtn.textContent = "复制";
    copyBtn.title = "复制 Markdown 表格";
    copyBtn.onpointerdown = stopActionEvent;
    copyBtn.onmousedown = stopActionEvent;
    copyBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await navigator.clipboard?.writeText?.(this.buildMarkdown());
        copyBtn.textContent = "已复制";
        window.setTimeout(() => { copyBtn.textContent = "复制"; }, 1200);
      } catch {
        copyBtn.textContent = "失败";
        window.setTimeout(() => { copyBtn.textContent = "复制"; }, 1200);
      }
    };
    toolbar.appendChild(copyBtn);
    wrap.appendChild(toolbar);

    const scroller = document.createElement("div");
    scroller.className = "cm-md-table-scroll";

    const table = document.createElement("table");
    table.className = "cm-md-table";

    // THEAD
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    this.headers.forEach((h, i) => {
      const th = document.createElement("th");
      th.style.textAlign = this.aligns[i] || "left";
      const sourceRange = getMarkdownTableCellSourceRange(this.sourceLines[0]?.text || "", this.sourceLines[0]?.from || this.sourceFrom, i);
      this.renderReadOnlyCell(th as HTMLTableCellElement, h, sourceRange);
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    // TBODY
    const tbody = document.createElement("tbody");
    this.rows.forEach((row, ri) => {
      const tr = document.createElement("tr");
      row.forEach((cell, ci) => {
        const td = document.createElement("td");
        td.style.textAlign = this.aligns[ci] || "left";
        const sourceLine = this.sourceLines[ri + 2];
        const sourceRange = sourceLine ? getMarkdownTableCellSourceRange(sourceLine.text, sourceLine.from, ci) : null;
        this.renderReadOnlyCell(td, cell, sourceRange);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    scroller.appendChild(table);
    wrap.appendChild(scroller);
    requestAnimationFrame(() => {
      updateCachedHeight(wrap, cacheKey);
      applyCachedMinHeight(wrap, cacheKey);
    });
    return wrap;
  }

  // 在表格区域内交互不让编辑器改变光标位置
  ignoreEvent() { return true; }
}

class TableBlockWidget extends WidgetType {
  constructor(private range: TablePreviewRange) {
    super();
  }

  get estimatedHeight() {
    return getCachedEstimatedHeight(
      getTableHeightCacheKey(this.range.headers, this.range.aligns, this.range.rows),
      estimateTableHeight(this.range.headers, this.range.rows)
    );
  }

  eq(other: TableBlockWidget) {
    if (this.range.from !== other.range.from || this.range.to !== other.range.to) return false;
    if (this.range.headers.join("|") !== other.range.headers.join("|")) return false;
    if (this.range.aligns.join(",") !== other.range.aligns.join(",")) return false;
    return this.range.rows.map(row => row.join("|")).join("\n") === other.range.rows.map(row => row.join("|")).join("\n");
  }

  toDOM(view: EditorView) {
    const range = this.range;
    const comments = getTableCommentRanges(view, range.from, range.to);
    const table = new TableWidget(
      view,
      range.headers,
      range.aligns,
      range.rows,
      range.sourceLines,
      comments,
      range.from,
      () => {
        try {
          view.dispatch({
            effects: tableRawEditEffect.of(range.from),
            selection: { anchor: range.from },
            scrollIntoView: true
          });
        } catch (e) {
          console.error("[wysiwyg] table raw edit dispatch error", e);
        }
      }
    );
    return table.toDOM();
  }

  ignoreEvent() { return true; }
}

/* Mermaid helpers for theme/init and copy/export */
function getMermaidTheme(): "default" | "dark" {
  const t = document.documentElement.getAttribute("data-theme");
  return t === "light" ? "default" : "dark";
}
async function ensureMermaidInit(publicReadOnly = false) {
  const { default: mermaid } = await import("mermaid");
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: publicReadOnly ? "strict" : "loose",
      ...(publicReadOnly ? { flowchart: { htmlLabels: false }, htmlLabels: false } : {}),
      theme: getMermaidTheme(),
      logLevel: "error",
      suppressErrors: true
    } as any);
    // Suppress global parse error handler to avoid DOM error notes
    try { (mermaid as any).parseError = () => {}; } catch {}
  } catch {}
  return mermaid;
}
async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } finally { ta.remove(); }
  }
}

class CodeBlockToolbarWidget extends WidgetType {
  constructor(private code: string, private lang: string) { super(); }
  eq(other: CodeBlockToolbarWidget) { return other.code === this.code && other.lang === this.lang; }
  toDOM() {
    const toolbar = document.createElement("span");
    toolbar.className = "cm-md-code-toolbar";
    const mkBtn = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.className = "cm-md-code-btn";
      b.textContent = label;
      b.title = title;
      b.type = "button";
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
      return b;
    };
    const code = this.code || "";
    const fenced = `\`\`\`${this.lang || ""}\n${code}\n\`\`\``;
    toolbar.append(
      mkBtn("复制", "复制代码", () => { copyToClipboard(code); }),
      mkBtn("复制围栏", "复制为 Markdown 围栏代码块", () => { copyToClipboard(fenced); })
    );
    return toolbar;
  }
  ignoreEvent() { return true; }
}
function svgToDataUrl(svg: string): string {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
async function svgToPngDataUrl(svg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const bboxMatch = svg.match(/viewBox="([^"]+)"/);
        let width = 0, height = 0;
        if (bboxMatch) {
          const vb = bboxMatch[1].split(/\s+/).map(Number);
          width = Math.max(1, Math.round(vb[2]));
          height = Math.max(1, Math.round(vb[3]));
        } else {
          // fallback size
          width = Math.max(1, Math.round(img.naturalWidth || 800));
          height = Math.max(1, Math.round(img.naturalHeight || 400));
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("no canvas ctx")); return; }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/png"));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error("svg->png load error"));
    img.src = svgToDataUrl(svg);
  });
}
function downloadDataUrl(filename: string, url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

class DiagramWidget extends WidgetType {
  private svgString: string | null = null;

  constructor(private code: string, private lang: "mermaid" | "uml" | "svg", private onToggle: () => void) {
    super();
  }
  eq(other: DiagramWidget) {
    return other.code === this.code && other.lang === this.lang;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-diagram";
    const publicReadOnly = view.state.facet(readerRenderOptions).publicReadOnly;
    const cacheKey = `diagram:${this.lang}:${hashString(this.code || "")}`;
    applyCachedMinHeight(wrap, cacheKey);

    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "cm-md-diagram-toolbar";
    const mkBtn = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.className = "cm-md-diagram-btn";
      b.textContent = label;
      b.title = title;
      b.type = "button";
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
      return b;
    };
    const editBtn = mkBtn("编辑", "切换到源码编辑", () => { try { this.onToggle(); } catch {} });
    const copySvgBtn = mkBtn("复制SVG", "复制为 SVG", async () => {
      if (this.svgString) await copyToClipboard(this.svgString);
    });
    const exportPngBtn = mkBtn("导出PNG", "导出为 PNG 文件", async () => {
      if (!this.svgString) return;
      try {
        const png = await svgToPngDataUrl(this.svgString);
        downloadDataUrl("diagram.png", png);
      } catch {}
    });
    const openBtn = mkBtn("新窗", "在新窗口打开", () => {
      if (!this.svgString) return;
      const w = window.open();
      if (w) {
        try {
          w.document.write(`<html><head><title>Diagram</title></head><body style="margin:0">${this.svgString}</body></html>`);
          w.document.close();
        } catch {}
      }
    });
    if (!view.state.readOnly) toolbar.appendChild(editBtn);
    toolbar.append(copySvgBtn, exportPngBtn);
    if (!publicReadOnly) toolbar.appendChild(openBtn);
    wrap.appendChild(toolbar);

    const body = document.createElement("div");
    body.className = "cm-md-diagram-body";
    wrap.appendChild(body);

    if (this.lang === "mermaid") {
      let scratch: HTMLDivElement | null = null;
      try {
        const id = "mmd-" + Math.random().toString(36).slice(2);
        // Use an offscreen scratch container to prevent mermaid from appending error text to document.body
        scratch = document.createElement("div");
        scratch.style.position = "fixed";
        scratch.style.left = "-9999px";
        scratch.style.top = "-9999px";
        document.body.appendChild(scratch);
        ensureMermaidInit(!!publicReadOnly).then(mermaid => mermaid.render(id, this.code, scratch || undefined)).then(({ svg }) => {
          if (publicReadOnly) {
            const node = sanitizePublicSvg(svg);
            if (!node) return;
            this.svgString = new XMLSerializer().serializeToString(node);
            requestAnimationFrame(() => {
              body.replaceChildren(node);
              updateCachedHeight(wrap, cacheKey);
              applyCachedMinHeight(wrap, cacheKey);
            });
            return;
          }
          // sanitize: remove script tags
          const parser = new DOMParser();
          const doc = parser.parseFromString(svg, "image/svg+xml");
          const scripts = doc.querySelectorAll("script");
          scripts.forEach(s => s.remove());
          this.svgString = new XMLSerializer().serializeToString(doc.documentElement);
          const svgNode = document.importNode(doc.documentElement, true);
          requestAnimationFrame(() => {
            try {
              body.innerHTML = "";
              body.appendChild(svgNode);
              updateCachedHeight(wrap, cacheKey);
              applyCachedMinHeight(wrap, cacheKey);
            } catch {}
          });
        }).catch(() => {
          // swallow errors and avoid leaking scratch node
        }).finally(() => {
          try { scratch?.remove(); } catch {}
        });
      } catch {
        try { scratch?.remove(); } catch {}
      }
    } else if (this.lang === "uml") {
      if (publicReadOnly) {
        body.textContent = this.code.trim();
        body.classList.add("cm-md-codeblock");
        toolbar.remove();
        return wrap;
      }
      try {
        const encoded = encodePlantUML(this.code);
        const server = (window as any).__plantuml_server || "https://www.plantuml.com/plantuml/svg/";
        const img = document.createElement("img");
        img.className = "cm-md-uml";
        img.referrerPolicy = "no-referrer";
        (img as any).loading = "lazy";
        img.src = server + encoded;
        img.addEventListener("load", () => {
          requestAnimationFrame(() => {
            updateCachedHeight(wrap, cacheKey);
            applyCachedMinHeight(wrap, cacheKey);
          });
        });
        img.addEventListener("error", () => { /* keep empty */ });
        body.appendChild(img);
      } catch {}
    } else if (this.lang === "svg") {
      if (publicReadOnly) {
        const node = sanitizePublicSvg(this.code);
        if (node) {
          this.svgString = new XMLSerializer().serializeToString(node);
          body.appendChild(node);
        }
        return wrap;
      }
      try {
        // Sanitize SVG content: remove script tags and other potentially dangerous elements
        const parser = new DOMParser();
        const doc = parser.parseFromString(this.code, "image/svg+xml");
        
        // Remove potentially dangerous elements
        const dangerousTags = ['script', 'object', 'iframe', 'embed', 'link'];
        dangerousTags.forEach(tag => {
          const elements = doc.querySelectorAll(tag);
          elements.forEach(el => el.remove());
        });
        
        // Remove event handlers from all elements
        const allElements = doc.querySelectorAll('*');
        allElements.forEach(el => {
          const attributes = el.attributes;
          for (let i = attributes.length - 1; i >= 0; i--) {
            const attr = attributes[i];
            if (attr.name.startsWith('on')) {
              el.removeAttribute(attr.name);
            }
          }
        });

        this.svgString = new XMLSerializer().serializeToString(doc.documentElement);
        const svgNode = document.importNode(doc.documentElement, true);
        requestAnimationFrame(() => {
          try {
            body.innerHTML = "";
            body.appendChild(svgNode);
            updateCachedHeight(wrap, cacheKey);
            applyCachedMinHeight(wrap, cacheKey);
          } catch {}
        });
      } catch (error) {
        // If parsing fails, show error message
        const errorDiv = document.createElement("div");
        errorDiv.className = "cm-md-svg-error";
        errorDiv.textContent = "SVG 解析错误";
        body.appendChild(errorDiv);
      }
    }

    // Interaction: do not toggle preview on diagram area, so toolbar stays clickable.
    return wrap;
  }
  // Prevent editor from moving cursor when clicking diagram area, so toolbar stays clickable.
  ignoreEvent() { return true; }
}

/* Build decorations using syntax tree for blocks and single-line inline fallback in visibleRanges
   Important: collect all ranges first and sort by position before building DecorationSet,
   otherwise RangeSetBuilder order constraints may cause only the first chunk to render. */
function buildDecorations(view: EditorView, activeLines: Set<number>, expandedDiagrams: Set<number>, rawTables: Set<number>) {
  const doc = view.state.doc;
  const tree = syntaxTree(view.state) as any;
  const roleFenceBlocks = view.state.field(roleFenceBlocksField, false) || collectRoleScopedFenceBlocks(doc);
  const blockMathRanges = collectStateBlockMathRanges(view.state, view.viewport.from, view.viewport.to);

  // Collect then sort to respect RangeSetBuilder ordering
  const pending: { from: number; to: number; dec: Decoration }[] = [];
  let previewTableRanges: TablePreviewRange[] = [];
  const overlapsPreviewTable = (from: number, to: number) => {
    for (const range of previewTableRanges) {
      if (from === to) {
        if (from >= range.from && from < range.to) return true;
      } else if (from < range.to && to > range.from) {
        return true;
      }
    }
    return false;
  };
  const add = (from: number, to: number, dec: Decoration) => {
    if (overlapsPreviewTable(from, to)) return;
    pending.push({ from, to, dec });
  };
  // track processed quote block starts to avoid duplicate processing when syntax tree yields multiple QuoteMark nodes
  const processedQuoteStarts = new Set<number>();

  // Helper: is position inside fenced code or block math
  const isInsideFencedCode = (pos: number) => {
    for (const block of roleFenceBlocks) {
      if (pos >= block.from && pos <= block.to) return true;
    }
    return blockMathRanges.some((range) => pos >= range.from && pos < range.to);
  };

  // Track lines processed by fallback scanners to avoid overlap/conflicts
  const processedFallbackLines = new Set<number>();
  try {
    previewTableRanges = view.state.field(tableBlockDecorationsField, false)?.ranges || [];
  } catch {
    previewTableRanges = [];
  }
  const imageGroups = collectStandaloneImageGroups(doc, (from, to) =>
    isInsideFencedCode(from) || isToolOrThinkingLine(doc.sliceString(from, to))
  );
  const standaloneImageStarts = new Set<number>();
  for (const group of imageGroups) {
    for (const item of group.items) standaloneImageStarts.add(item.from);
    if (group.items.length !== 1) continue;
    const item = group.items[0];
    if (!inViewport(view, item.from, item.to) || activeLines.has(item.lineNumber)) continue;
    if (!selectionTouchesRange(view.state, item.from, item.to)) {
      add(item.from, item.to, hiddenSyntaxDecoration(view.state, item.from, item.to));
      add(item.from, item.from, Decoration.widget({
        widget: new SimpleImageWidget(item.alt, item.src, "solo", item.from, item.to),
        side: 1
      }));
    }
  }

  // 1) Block-level via syntax tree (only for nodes within viewport)
  try {
    tree.iterate({
      from: view.viewport.from,
      to: view.viewport.to,
      enter: (node: any) => {
        const name = node.name || node.type?.name;
        const from = node.from, to = node.to;
        if (!inViewport(view, from, to)) return;

        // Skip tool call and thinking lines - let their own plugins handle rendering
        const line = doc.lineAt(from);
        const lineText = doc.sliceString(line.from, line.to);
        if (isToolOrThinkingLine(lineText)) return;

        // Headers: style content; on active line keep '#' markers visible, off active line hide them
        if (name === "Header" || name === "HeaderMark") {
          const line = doc.lineAt(from);
          const text = doc.sliceString(line.from, line.to);
          const m = /^([ \t]*)(#{1,6})([ \t]*)(.*)$/.exec(text);
          if (m) {
            const level = Math.min(6, m[2].length);
            const markerEnd = line.from + m[1].length + m[2].length + m[3].length;
            const isActive = activeLines.has(line.number);
            if (!isActive) {
              add(line.from, markerEnd, hiddenSyntaxDecoration(view.state, line.from, markerEnd, "cm-z-hide-heading-marker"));
            }
            const cls = `cm-md-heading cm-md-h${level}`;
            add(markerEnd, line.to, Decoration.mark({ class: cls }));
          }
          return;
        }

        // Task list markers: keep raw on active line; off active line use checkbox widget
        if (name === "TaskMarker") {
          const lnNum = doc.lineAt(node.from).number;
          const isActive = activeLines.has(lnNum);
          const markerText = doc.sliceString(node.from, node.to);
          const checked = /\bx\b/i.test(markerText);
          if (!isActive) {
            const selected = nonEmptySelectionOverlapsRange(view.state, node.from, node.to);
            add(node.from, node.to, hiddenSyntaxDecoration(view.state, node.from, node.to));
            const line = doc.lineAt(node.to);
            const rest = doc.sliceString(node.to, line.to).trimStart();
            add(node.from, node.from, Decoration.widget({ widget: new TaskWidget(checked, rest, selected), side: 1 }));
          }
          return;
        }

        // List bullets / numbers: keep raw on active line; off active line use bullet/number widget
        if (name === "ListMark") {
          const lnNum = doc.lineAt(node.from).number;
          const isActive = activeLines.has(lnNum);
          if (!isActive) {
            const markerText = doc.sliceString(node.from, node.to).trim();
            const line = doc.lineAt(node.to);
            let replaceFrom = node.from;
            while (replaceFrom > line.from && /[ \t]/.test(doc.sliceString(replaceFrom - 1, replaceFrom))) {
              replaceFrom--;
            }
            let replaceTo = node.to;
            while (replaceTo < line.to && /\s/.test(doc.sliceString(replaceTo, replaceTo + 1))) replaceTo++;
            const indentText = doc.sliceString(replaceFrom, node.from);
            const depth = getListDepthFromSyntaxNode(node, indentText);
            const markerWidth = getListMarkerWidthPx(markerText);
            const contentIndent = (depth * MARKDOWN_LIST_INDENT_PX) + markerWidth;
            add(
              line.from,
              line.from,
              Decoration.line({
                class: "cm-md-list-line",
                attributes: {
                  style: `--cm-md-list-content-indent: ${contentIndent}px; --cm-md-list-marker-width: ${markerWidth}px;`
                }
              })
            );
            const selected = nonEmptySelectionOverlapsRange(view.state, replaceFrom, replaceTo);
            add(
              replaceFrom,
              replaceTo,
              Decoration.replace({
                widget: new (class extends WidgetType {
                  constructor(private txt: string, private selected: boolean) { super(); }
                  eq(other: any) { return other.txt === this.txt && other.selected === this.selected; }
                  toDOM() {
                    const s = document.createElement("span");
                    s.className = `${/^[\d]/.test(this.txt) ? "cm-md-ol-num" : "cm-md-ul-bullet"}${this.selected ? " cm-md-marker-selected" : ""}`;
                    s.textContent = /^[\d]/.test(this.txt) ? `${this.txt.replace(/\./g, "")}.\u00A0` : "•\u00A0";
                    return s;
                  }
                  ignoreEvent() { return true; }
                })(markerText, selected),
                side: 1
              })
            );
          }
          return;
        }

        // Quote mark: group contiguous quote lines into a single visual block and avoid splitting marker above content
        if (name === "QuoteMark") {
          const line = doc.lineAt(node.from);
          const roleRange = getRoleBlockRange(doc, node.from);
          // Determine contiguous quote block (expand up/down), skip processing if inside fenced code
          const isQuoteLineText = (txt: string) => (/^\s*>/.test(txt));
          let startLn = line.number;
          while (startLn > 1) {
            const prev = doc.line(startLn - 1);
            if (startLn - 1 < roleRange.startLine) break;
            if (isInsideFencedCode(prev.from)) break;
            if (!isQuoteLineText(doc.sliceString(prev.from, prev.to))) break;
            startLn--;
          }
          let endLn = line.number;
          while (endLn < doc.lines) {
            const next = doc.line(endLn + 1);
            if (endLn + 1 > roleRange.endLine) break;
            if (isInsideFencedCode(next.from)) break;
            if (!isQuoteLineText(doc.sliceString(next.from, next.to))) break;
            endLn++;
          }

          const blockStartPos = doc.line(startLn).from;
          // avoid duplicate processing for the same block
          if (processedQuoteStarts.has(blockStartPos)) return;
          processedQuoteStarts.add(blockStartPos);

          // check whether any line within block is active (caret/selection); if so we show markers on active lines
          let anyActive = false;
          for (let ln = startLn; ln <= endLn; ln++) {
            if (activeLines.has(ln)) { anyActive = true; break; }
          }

          // Apply a line decoration to every line so the visual background is contiguous.
          // For rendered lines collapse the source marker and let quote padding own alignment.
          for (let ln = startLn; ln <= endLn; ln++) {
            const l = doc.line(ln);
            const txt = doc.sliceString(l.from, l.to);
            const prefixMatch = /^\s*>+\s*/.exec(txt);
            const markerLen = prefixMatch ? prefixMatch[0].length : 0;

            const positionClass = startLn === endLn
              ? "cm-md-quote-single"
              : ln === startLn
                ? "cm-md-quote-start"
                : ln === endLn
                  ? "cm-md-quote-end"
                  : "cm-md-quote-middle";

            // Always apply line-level decoration for contiguous background.
            add(l.from, l.from, Decoration.line({ class: `cm-md-quote ${positionClass}` }));

            if (anyActive && activeLines.has(ln)) {
              // Keep marker visible on active line(s) so user can edit quote prefix normally.
              // Content is already visually styled by the line decoration.
            } else {
              if (markerLen > 0) {
                add(l.from, l.from + markerLen, hiddenSyntaxDecoration(view.state, l.from, l.from + markerLen, "cm-z-hide-quote-marker"));
              }
            }
          }
          return;
        }

        // Fenced code: handled by role-scoped scanner below so each role matches fences independently
        if (name === "FencedCode" || name === "CodeBlock") {
          return;
        }

        // HorizontalRule (---, ***, ___)
        if (name === "HorizontalRule") {
          const line = doc.lineAt(from);
          const isActive = activeLines.has(line.number);
          if (!isActive && !selectionTouchesRange(view.state, line.from, line.to)) {
            // Hide the original markers (keep mapping stable)
            add(line.from, line.to, hiddenSyntaxDecoration(view.state, line.from, line.to));
            // Apply a line-level class so the line's padding/height can be controlled by CSS
            add(line.from, line.from, Decoration.line({ class: "cm-md-hr-line" }));
          }
          return;
        }

        // Table node: handled by visible-range fallback scanner below

        // Math block: handled by visible-range fallback ($...$) to avoid cross-line replacement issues
      }
    });
  } catch {}

  // 1.5) Role-scoped fenced code blocks: each role matches its own ``` pairs independently.
  // These decorations affect vertical layout (padding, collapsed diagram lines,
  // toolbar anchors), so keep them document-wide instead of viewport-local.
  // Otherwise code blocks entering/leaving the viewport change scrollHeight and
  // can make CodeMirror adjust scrollTop to a different anchor.
  for (const block of roleFenceBlocks) {
    const fromLineNum = block.startLine;
    const toLineNum = block.endLine;
    const firstLine = doc.line(fromLineNum);
    const lastLine = doc.line(toLineNum);
    for (let ln = fromLineNum; ln <= toLineNum; ln++) {
      const l = doc.line(ln);
      add(l.from, l.from, Decoration.line({ class: "cm-md-codeblock" }));
    }
    add(firstLine.from, firstLine.from, Decoration.line({ class: "cm-md-codeblock-fence" }));
    if (block.hasClosingFence) {
      add(lastLine.from, lastLine.from, Decoration.line({ class: "cm-md-codeblock-fence" }));
    }

    let anyActive = false;
    for (let ln = fromLineNum; ln <= toLineNum; ln++) {
      if (activeLines.has(ln)) { anyActive = true; break; }
    }
    if (!anyActive && selectionTouchesRange(view.state, block.from, block.to)) {
      anyActive = true;
    }

    const lang = block.lang;
    const isDiagram = lang === "mermaid" || lang === "plantuml" || lang === "puml" || lang === "svg";
    if (isDiagram && block.hasClosingFence && !anyActive) {
      const contentFrom = firstLine.to;
      const contentTo = lastLine.from;
      const code = doc.sliceString(contentFrom, contentTo);
      const diagramFrom = block.from;
      let diagramType: "mermaid" | "uml" | "svg" = "uml";
      if (lang === "mermaid") {
        diagramType = "mermaid";
      } else if (lang === "svg") {
        diagramType = "svg";
      }
      if (!expandedDiagrams.has(diagramFrom)) {
        add(block.from, block.from + (firstLine.to - firstLine.from) + 1, hiddenSyntaxDecoration(view.state, block.from, block.from + (firstLine.to - firstLine.from) + 1));
        add(
          block.from,
          block.from,
          Decoration.widget({
            widget: new DiagramWidget(code, diagramType, () => {
              if (expandedDiagrams.has(diagramFrom)) {
                expandedDiagrams.delete(diagramFrom);
              } else {
                expandedDiagrams.add(diagramFrom);
              }
              try { view.dispatch({ annotations: Transaction.userEvent.of("wysiwyg-refresh") }); } catch {}
            }),
            side: 1
          })
        );
        for (let ln = fromLineNum + 1; ln <= toLineNum; ln++) {
          const l = doc.line(ln);
          add(l.from, l.from, Decoration.line({ class: "cm-md-diagram-hiddenline" }));
        }
      }
    }
    if (block.hasClosingFence) {
      const contentFrom = firstLine.to;
      const contentTo = lastLine.from;
      const raw = doc.sliceString(contentFrom, contentTo);
      const code = raw.replace(/^\n/, "").replace(/\n$/, "");
      const allowToolbar = !isDiagram || expandedDiagrams.has(block.from) || anyActive;
      if (allowToolbar) {
        add(firstLine.from, firstLine.from, Decoration.line({ class: "cm-md-codeblock-toolbar-anchor" }));
        add(
          firstLine.from,
          firstLine.from,
          Decoration.widget({
            widget: new CodeBlockToolbarWidget(code, lang),
            side: -1
          })
        );
      }
    }
  }

  // 2) Visible-range fallback scanners (inline marks, tables, block math). Skip inside code fences.
  for (const vr of view.visibleRanges) {
    const text = doc.sliceString(vr.from, vr.to);

    // 2.1 inline marks (bold/em/code/link/image/inline-math)
    let m: RegExpExecArray | null;
    INLINE_FALLBACK.lastIndex = 0;
    while ((m = INLINE_FALLBACK.exec(text)) !== null) {
      const start = vr.from + m.index;
      const end = start + m[0].length;
      if (isEscapedAt(text, m.index)) continue;
      if (isInsideFencedCode(start)) continue;
      const lnNum = doc.lineAt(start).number;
      const isActive = activeLines.has(lnNum);

      // Skip tool call and thinking lines
      const line = doc.lineAt(start);
      const lineText = doc.sliceString(line.from, line.to);
      if (isToolOrThinkingLine(lineText)) continue;

      // bold (**...**)
      if (m[1]) {
        if (isActive) {
          // active line: render content style, keep markers visible
          add(start + 2, end - 2, Decoration.mark({ class: "cm-md-strong" }));
        } else {
          add(start, start + 2, hiddenSyntaxDecoration(view.state, start, start + 2));
          add(start + 2, end - 2, Decoration.mark({ class: "cm-md-strong" }));
          addNestedInlineDecorations(add, view.state, start + 2, m[2] || "");
          add(end - 2, end, hiddenSyntaxDecoration(view.state, end - 2, end));
        }
        continue;
      }
      // em (_..._) - only when underscores are not inside a word (CommonMark rule)
      if (m[3]) {
        const before = start > 0 ? doc.sliceString(start - 1, start) : "";
        const after = end < doc.length ? doc.sliceString(end, end + 1) : "";
        const isWordChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);
        const valid = !isWordChar(before) && !isWordChar(after);
        if (!valid) {
          // Ignore intraword underscores like "wind_power_diffusion"
          continue;
        }
        if (isActive) {
          add(start + 1, end - 1, Decoration.mark({ class: "cm-md-em" }));
        } else {
          add(start, start + 1, hiddenSyntaxDecoration(view.state, start, start + 1));
          add(start + 1, end - 1, Decoration.mark({ class: "cm-md-em" }));
          addNestedInlineDecorations(add, view.state, start + 1, m[4] || "");
          add(end - 1, end, hiddenSyntaxDecoration(view.state, end - 1, end));
        }
        continue;
      }
      // inline code (`...`)
      if (m[5]) {
        if (isActive) {
          add(start + 1, end - 1, Decoration.mark({ class: "cm-md-code" }));
        } else {
          add(start, start + 1, hiddenSyntaxDecoration(view.state, start, start + 1));
          add(start + 1, end - 1, Decoration.mark({ class: "cm-md-code" }));
          add(end - 1, end, hiddenSyntaxDecoration(view.state, end - 1, end));
        }
        continue;
      }
      // link ([label](url))
      if (m[7]) {
        const label = m[8] || "";
        const url = m[9] || "";
        if (isActive) {
          // active line: keep raw markdown, optionally style label
          const labelStart = start + 1;
          const labelEnd = labelStart + label.length;
          if (label.length > 0) {
            add(labelStart, labelEnd, Decoration.mark({ class: "cm-md-link" }));
          }
        } else {
          if (!selectionTouchesRange(view.state, start, end)) {
            add(start, end, hiddenSyntaxDecoration(view.state, start, end));
            add(start, start, Decoration.widget({ widget: new SimpleLinkWidget(label, url), side: 1 }));
          } else {
            const labelStart = start + 1;
            const labelEnd = labelStart + label.length;
            if (label.length > 0) {
              add(labelStart, labelEnd, Decoration.mark({ class: "cm-md-link" }));
            }
          }
        }
        continue;
      }
      // image (![alt](src))
      if (m[10]) {
        const alt = m[11] || "";
        const src = m[12] || "";
        if (standaloneImageStarts.has(start)) continue;
        if (isActive) {
          // active line: keep raw markdown
        } else {
          if (!selectionTouchesRange(view.state, start, end)) {
            add(start, end, hiddenSyntaxDecoration(view.state, start, end));
            add(start, start, Decoration.widget({
              widget: new SimpleImageWidget(alt, src, "inline", start, end),
              side: 1
            }));
          }
        }
        continue;
      }
      // inline math ($...$)
      if (m[13]) {
        const expr = m[14] || "";
        if (!isValidInlineMathCandidate(lineText, start - line.from, end - line.from)) continue;
        if (isActive) {
          // active line: keep raw markdown (no widget to avoid duplication)
        } else {
          if (!selectionTouchesRange(view.state, start, end)) {
            add(start, end, hiddenSyntaxDecoration(view.state, start, end));
            add(start, start, Decoration.widget({ widget: new MathWidget(expr, false), side: 1 }));
          }
        }
        continue;
      }
      // strikethrough (~~...~~)
      if (m[15]) {
        if (isActive) {
          add(start + 2, end - 2, Decoration.mark({ class: "cm-md-strike" }));
        } else {
          add(start, start + 2, hiddenSyntaxDecoration(view.state, start, start + 2));
          add(start + 2, end - 2, Decoration.mark({ class: "cm-md-strike" }));
          addNestedInlineDecorations(add, view.state, start + 2, m[16] || "");
          add(end - 2, end, hiddenSyntaxDecoration(view.state, end - 2, end));
        }
        continue;
      }
    }

    const escapedInline = /\\([\\`*_[\]{}()#+\-.!~|>])/g;
    while ((m = escapedInline.exec(text)) !== null) {
      const start = vr.from + m.index;
      if (isInsideFencedCode(start)) continue;
      const line = doc.lineAt(start);
      if (activeLines.has(line.number)) continue;
      if (isToolOrThinkingLine(doc.sliceString(line.from, line.to))) continue;
      if (ESCAPABLE_MARKDOWN_RE.test(m[1] || "")) {
        add(start, start + 1, hiddenSyntaxDecoration(view.state, start, start + 1));
      }
    }

    const kbdInline = /<kbd>([^<\n]+)<\/kbd>/gi;
    while ((m = kbdInline.exec(text)) !== null) {
      const start = vr.from + m.index;
      const end = start + m[0].length;
      if (isInsideFencedCode(start)) continue;
      const line = doc.lineAt(start);
      if (activeLines.has(line.number)) continue;
      if (isToolOrThinkingLine(doc.sliceString(line.from, line.to))) continue;
      if (!selectionTouchesRange(view.state, start, end)) {
        add(start, end, hiddenSyntaxDecoration(view.state, start, end));
        add(start, start, Decoration.widget({ widget: new KbdWidget(m[1] || ""), side: 1 }));
      }
    }

    const footnoteRef = /\[\^([^\]\s]+)\](?!:)/g;
    while ((m = footnoteRef.exec(text)) !== null) {
      const start = vr.from + m.index;
      const end = start + m[0].length;
      if (isInsideFencedCode(start)) continue;
      const line = doc.lineAt(start);
      if (activeLines.has(line.number)) continue;
      if (isToolOrThinkingLine(doc.sliceString(line.from, line.to))) continue;
      if (!selectionTouchesRange(view.state, start, end)) {
        add(start, end, hiddenSyntaxDecoration(view.state, start, end));
        add(start, start, Decoration.widget({ widget: new FootnoteRefWidget(m[1] || ""), side: 1 }));
      }
    }

    // 2.2 line-level fallback decorations that are safe to keep viewport-local.
    const startLine = doc.lineAt(vr.from).number;
    const endLine = doc.lineAt(vr.to).number;
    let ln = startLine;
    while (ln <= endLine) {
      if (processedFallbackLines.has(ln)) { ln++; continue; }
      const line = doc.line(ln);
      const ltxt = doc.sliceString(line.from, line.to);
      if (isInsideFencedCode(line.from)) { ln++; continue; }
      if (isToolOrThinkingLine(ltxt)) { ln++; continue; }

      const footnoteDefMatch = /^\s*\[\^([^\]]+)\]:\s*/.exec(ltxt);
      if (footnoteDefMatch) {
        add(line.from, line.from, Decoration.line({ class: "cm-md-footnote-def-line" }));
        if (!activeLines.has(ln)) {
          const markerLen = footnoteDefMatch[0].length;
          if (!selectionTouchesRange(view.state, line.from, line.from + markerLen)) {
            add(line.from, line.from + markerLen, hiddenSyntaxDecoration(view.state, line.from, line.from + markerLen));
            add(line.from, line.from, Decoration.widget({ widget: new FootnoteRefWidget(footnoteDefMatch[1] || ""), side: 1 }));
          }
        }
        ln++;
        continue;
      }

      if (/^\s*<\/?(details|summary|dl|dt|dd|p)\b/i.test(ltxt)) {
        add(line.from, line.from, Decoration.line({ class: "cm-md-html-line" }));
      }
      ln++;
    }

    // 2.3 block math ($ ... $)
    ln = startLine;
    while (ln <= endLine) {
      if (processedFallbackLines.has(ln)) { ln++; continue; }
      const line = doc.line(ln);
      const t = doc.sliceString(line.from, line.to).trim();
      if (isInsideFencedCode(line.from)) { ln++; continue; }
      // Skip tool call and thinking lines
      if (isToolOrThinkingLine(t)) { ln++; continue; }
      const isFence = /^\$\$\s*$/.test(t);
      if (isFence) {
        const roleRange = getRoleBlockRange(doc, line.from);
        // find closing fence
        let endFenceLn = ln + 1;
        while (endFenceLn <= endLine) { // Restrict math block scan to visible range to avoid massive scans? Usually block math is short.
          // Or allow full scan? Let's stick to endLine to be safe, or allow slight overflow.
          // Ideally we should scan until end of block.
          // But strict block math usually requires closing fence.
          const eline = doc.line(endFenceLn);
          const et = doc.sliceString(eline.from, eline.to).trim();
          if (/^\$\$\s*$/.test(et)) break;
          endFenceLn++;
        }
        
        // If we found the end fence within a reasonable distance (or at least within visible range + lookahead)
        // Here we just use endLine logic for now, or maybe extend slightly?
        // Let's stick to current logic: find closing fence.
        // But if endFenceLn goes beyond endLine?
        // We should probably allow it to go further if needed, but for performance, limit it.
        // Let's change the loop condition to allow scanning a bit further?
        // Actually, just checking up to doc.lines is safer for correctness, but slower.
        // Let's use `doc.lines` but with a sanity check (e.g. max 500 lines).
        
        let foundEnd = false;
        let scanLn = ln + 1;
        while (scanLn <= doc.lines && scanLn <= roleRange.endLine && scanLn < ln + 500) {
             const sline = doc.line(scanLn);
             const st = doc.sliceString(sline.from, sline.to).trim();
             if (/^\$\$\s*$/.test(st)) {
                 endFenceLn = scanLn;
                 foundEnd = true;
                 break;
             }
             scanLn++;
        }

        if (foundEnd) {
          // Mark processed
          for (let k = ln; k <= endFenceLn; k++) processedFallbackLines.add(k);

          const contentFrom = doc.line(ln + 1).from;
          const contentTo = doc.line(endFenceLn - 1).to;
          const expr = contentFrom <= contentTo ? doc.sliceString(contentFrom, contentTo) : "";

          // If any line within the block is active, skip widget for editing
          let anyActive = false;
          for (let n = ln; n <= endFenceLn; n++) {
            if (activeLines.has(n)) { anyActive = true; break; }
          }
          const blockTo = doc.line(endFenceLn).to;
          if (!anyActive && selectionTouchesRange(view.state, line.from, blockTo)) {
            anyActive = true;
          }

          if (!anyActive) {
            // hide all lines and collapse middle lines
            for (let hideLn = ln; hideLn <= endFenceLn; hideLn++) {
              const hline = doc.line(hideLn);
              add(hline.from, hline.to, hiddenSyntaxDecoration(view.state, hline.from, hline.to));
              if (hideLn > ln) {
                add(hline.from, hline.from, Decoration.line({ class: "cm-md-diagram-hiddenline" }));
              }
            }
            // widget at start
            add(line.from, line.from, Decoration.widget({ widget: new MathWidget(expr, true), side: 1 }));
          }

          ln = endFenceLn + 1;
          continue;
        }
      }
      ln++;
    }
  }

  // Build in order
  pending.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    if (a.dec.startSide !== b.dec.startSide) return a.dec.startSide - b.dec.startSide;
    return a.to - b.to;
  });
  const builder = new RangeSetBuilder<Decoration>();
  for (const it of pending) {
    builder.add(it.from, it.to, it.dec);
  }
  return builder.finish();
}

export function canMapWysiwygDecorations(update: ViewUpdate): boolean {
  if (!update.docChanged) return false;
  const oldHeadLine = update.startState.doc.lineAt(update.startState.selection.main.head).number;
  const newHeadLine = update.state.doc.lineAt(update.state.selection.main.head).number;
  if (oldHeadLine !== newHeadLine) return false;

  let safe = true;
  update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (!safe) return;
    const insertedText = inserted.toString();
    const deletedText = update.startState.doc.sliceString(fromA, toA);
    if (insertedText.length + deletedText.length > 64 || /[\n\r]/.test(insertedText + deletedText)) {
      safe = false;
      return;
    }

    const oldFromLine = update.startState.doc.lineAt(fromA);
    const oldToLine = update.startState.doc.lineAt(toA);
    const newFromLine = update.state.doc.lineAt(fromB);
    const newToLine = update.state.doc.lineAt(toB);
    if (oldFromLine.number !== oldToLine.number || newFromLine.number !== newToLine.number) {
      safe = false;
      return;
    }

    const oldRolePrefix = ROLE_HEAD_RE.exec(oldFromLine.text)?.[0] || "";
    const newRolePrefix = ROLE_HEAD_RE.exec(newFromLine.text)?.[0] || "";
    if (
      (oldRolePrefix && fromA - oldFromLine.from < oldRolePrefix.length) ||
      (newRolePrefix && fromB - newFromLine.from < newRolePrefix.length)
    ) {
      safe = false;
      return;
    }

    const oldText = oldFromLine.text;
    const newText = newFromLine.text;
    if (
      /[\\`*_~[\]()!#$|>]/.test(oldText) ||
      /[\\`*_~[\]()!#$|>]/.test(newText) ||
      /^\s*(?:[-+]|(?:\d+[.)]))\s/.test(oldText) ||
      /^\s*(?:[-+]|(?:\d+[.)]))\s/.test(newText)
    ) {
      safe = false;
    }
  });
  return safe;
}

type WysiwygRect = { left: number; right: number; top: number; bottom: number };

function validCaretRect(rect: WysiwygRect | null): WysiwygRect | null {
  if (!rect) return null;
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return null;
  if (rect.bottom <= rect.top) return null;
  return rect;
}

function getRenderedBoundaryCursorRect(view: EditorView): { rect: WysiwygRect; side: "start" | "end"; pos: number } | null {
  try {
    if (!view.hasFocus) return null;
    if (!view.state.facet(wysiwygKeepActiveLineRenderedFacet)) return null;
    const range = view.state.selection.main;
    const line = view.state.doc.lineAt(range.head);
    const boundaries = getRenderedLineBoundaries(view, line.number);
    if (boundaries.start != null && (range.head === boundaries.start || range.head === line.from)) {
      const rect = validCaretRect(view.coordsAtPos(boundaries.start, 1));
      return rect ? { rect, side: "start", pos: boundaries.start } : null;
    }
    if (boundaries.end != null && (range.head === boundaries.end || range.head === line.to)) {
      const visibleCharPos = Math.max(line.from, boundaries.end - 1);
      const rect = validCaretRect(view.coordsAtPos(boundaries.end, -1))
        || validCaretRect(view.coordsAtPos(visibleCharPos, 1));
      return rect ? { rect, side: "end", pos: boundaries.end } : null;
    }
    return null;
  } catch {
    return null;
  }
}

function getRenderedHorizontalMotionTarget(view: EditorView, direction: -1 | 1): { pos: number; assoc: -1 | 1 } | null {
  try {
    if (!view.state.facet(wysiwygKeepActiveLineRenderedFacet)) return null;
    const { state } = view;
    const range = state.selection.main;
    const head = range.head;
    const line = state.doc.lineAt(head);
    const boundaries = getRenderedLineBoundaries(view, line.number);
    const previousVisibleEnd = () => {
      if (line.number <= 1) {
        return boundaries.start != null ? { pos: boundaries.start, assoc: 1 as const } : null;
      }
      const previousLine = state.doc.line(line.number - 1);
      const previousBoundaries = getRenderedLineBoundaries(view, previousLine.number);
      return { pos: previousBoundaries.end ?? previousLine.to, assoc: -1 as const };
    };
    const nextVisibleStart = () => {
      if (line.number >= state.doc.lines) {
        return boundaries.end != null ? { pos: boundaries.end, assoc: -1 as const } : null;
      }
      const nextLine = state.doc.line(line.number + 1);
      const nextBoundaries = getRenderedLineBoundaries(view, nextLine.number);
      return { pos: nextBoundaries.start ?? nextLine.from, assoc: 1 as const };
    };

    if (direction > 0) {
      if (boundaries.start != null && head < boundaries.start) {
        return { pos: boundaries.start, assoc: 1 };
      }
      if (boundaries.end != null && head >= boundaries.end) {
        return nextVisibleStart();
      }
      if (head >= line.to) {
        const target = nextVisibleStart();
        if (target && target.pos !== head) return target;
      }
      return null;
    }

    if (boundaries.end != null && head > boundaries.end) {
      return { pos: boundaries.end, assoc: -1 };
    }
    if (boundaries.start != null && head <= boundaries.start) {
      return previousVisibleEnd();
    }
    if (head <= line.from) {
      const target = previousVisibleEnd();
      if (target && target.pos !== head) return target;
    }
    return null;
  } catch {
    return null;
  }
}

function getRenderedEnterSourcePos(view: EditorView): { pos: number; side: "start" | "end" } | null {
  try {
    if (!view.state.facet(wysiwygKeepActiveLineRenderedFacet)) return null;
    const range = view.state.selection.main;
    if (!range.empty) return null;
    const line = view.state.doc.lineAt(range.head);
    const boundaries = getRenderedLineBoundaries(view, line.number);
    if (boundaries.start != null && range.head === boundaries.start) {
      return { pos: line.from, side: "start" };
    }
    if (boundaries.end != null && range.head === boundaries.end) {
      return { pos: line.to, side: "end" };
    }
    return null;
  } catch {
    return null;
  }
}

/* ViewPlugin: incremental rebuilds */
const wysiwygPlugin = ViewPlugin.fromClass(class {
  decorations: any;
  expandedDiagrams = new Set<number>();
  rawTables = new Set<number>();
  boundaryCursor: HTMLElement | null = null;
  boundaryCursorFrame = 0;

  constructor(view: EditorView) {
    try {
      this.decorations = buildDecorations(view, getSourceRevealLines(view), this.expandedDiagrams, this.rawTables);
    } catch (e) {
      console.error("[wysiwyg] buildDecorations (constructor) error", e);
      this.decorations = Decoration.none;
    }
    this.bindEvents(view);
    this.scheduleBoundaryCursor(view);
  }

  ensureBoundaryCursor(view: EditorView): HTMLElement {
    if (this.boundaryCursor) return this.boundaryCursor;
    const cursor = document.createElement("div");
    cursor.className = "cm-cursor cm-cursor-primary cm-z-boundary-cursor";
    cursor.setAttribute("aria-hidden", "true");
    cursor.style.display = "none";
    view.dom.appendChild(cursor);
    this.boundaryCursor = cursor;
    return cursor;
  }

  hideBoundaryCursor(): void {
    if (this.boundaryCursor) this.boundaryCursor.style.display = "none";
    try {
      delete this.boundaryCursor?.parentElement?.dataset.zionBoundaryCursor;
    } catch {}
  }

  scheduleBoundaryCursor(view: EditorView): void {
    if (this.boundaryCursorFrame) cancelAnimationFrame(this.boundaryCursorFrame);
    this.boundaryCursorFrame = requestAnimationFrame(() => {
      this.boundaryCursorFrame = 0;
      this.updateBoundaryCursor(view);
    });
  }

  updateBoundaryCursor(view: EditorView): void {
    const boundary = getRenderedBoundaryCursorRect(view);
    if (!boundary) {
      this.hideBoundaryCursor();
      return;
    }
    const rootRect = view.dom.getBoundingClientRect();
    const cursor = this.ensureBoundaryCursor(view);
    const height = Math.max(12, boundary.rect.bottom - boundary.rect.top);
    cursor.style.display = "block";
    cursor.style.left = `${boundary.rect.left - rootRect.left}px`;
    cursor.style.top = `${boundary.rect.top - rootRect.top}px`;
    cursor.style.height = `${height}px`;
    cursor.dataset.side = boundary.side;
    cursor.dataset.pos = String(boundary.pos);
    view.dom.dataset.zionBoundaryCursor = "true";
  }

  bindEvents(view: EditorView) {
    // Observe theme attribute to refresh diagrams if theme changes
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes" && (m as any).attributeName === "data-theme") {
          try { view.dispatch({ annotations: Transaction.userEvent.of("wysiwyg-refresh") }); } catch {}
          break;
        }
      }
    });
    try { mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); } catch {}

    // 页面可见性监听：休眠唤醒后强制重建装饰
    let wasHidden = document.hidden;
    const onVisibilityChange = () => {
      const isHidden = document.hidden;
      if (wasHidden && !isHidden) {
        // 页面从休眠中唤醒，强制刷新 WYSIWYG 装饰
        try { view.dispatch({ annotations: Transaction.userEvent.of("wysiwyg-refresh") }); } catch {}
      }
      wasHidden = isHidden;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Window focus 作为备份恢复机制
    const onFocus = () => {
      setTimeout(() => {
        try { view.dispatch({ annotations: Transaction.userEvent.of("wysiwyg-refresh") }); } catch {}
      }, 100);
    };
    window.addEventListener("focus", onFocus);

    const onEditorFocus = () => this.scheduleBoundaryCursor(view);
    const onEditorBlur = () => this.hideBoundaryCursor();
    view.dom.addEventListener("focusin", onEditorFocus, true);
    view.dom.addEventListener("focusout", onEditorBlur, true);

    const readRenderedBoundaryClick = (ev: MouseEvent | PointerEvent) => {
      const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
      if (pos == null) return null;
      const line = view.state.doc.lineAt(pos);
      const boundaries = getRenderedLineBoundaries(view, line.number);
      const start = boundaries.start;
      const end = boundaries.end;
      if (start == null && end == null) return null;
      let target: number | null = null;
      let targetAssoc: -1 | 1 = 1;
      if (start != null) {
        const startRect = view.coordsAtPos(start);
        const firstCharEndRect = start < line.to ? view.coordsAtPos(start + 1) : null;
        const startX = startRect?.left ?? startRect?.right ?? null;
        const firstCharEndX = firstCharEndRect?.left ?? firstCharEndRect?.right ?? null;
        const firstCharMidX = startX != null && firstCharEndX != null ? (startX + firstCharEndX) / 2 : null;
        if (pos < start || (pos === start + 1 && firstCharMidX != null && ev.clientX <= firstCharMidX)) {
          target = start;
          targetAssoc = 1;
        }
      }
      if (target == null && end != null) {
        const endRect = view.coordsAtPos(end);
        const lastCharStartRect = end > line.from ? view.coordsAtPos(end - 1) : null;
        const endX = endRect?.left ?? endRect?.right ?? null;
        const lastCharStartX = lastCharStartRect?.left ?? lastCharStartRect?.right ?? null;
        const lastCharMidX = endX != null && lastCharStartX != null ? (endX + lastCharStartX) / 2 : null;
        if (pos > end || (pos === end - 1 && lastCharMidX != null && ev.clientX >= lastCharMidX)) {
          target = end;
          targetAssoc = -1;
        }
      }
      if (target == null) return null;
      return {
        pos,
        line,
        target,
        targetAssoc
      };
    };
    const onRenderedBoundaryPointerEvent = (ev: MouseEvent | PointerEvent) => {
      try {
        const hit = readRenderedBoundaryClick(ev);
        if (!hit) return;
        const keepRendered = view.state.facet(wysiwygKeepActiveLineRenderedFacet);
        const shouldNormalize = keepRendered
          && ev.button === 0
          && !ev.shiftKey
          && !ev.metaKey
          && !ev.ctrlKey
          && !ev.altKey;
        if (shouldNormalize) {
          ev.preventDefault();
          ev.stopPropagation();
          view.focus();
          view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(hit.target, hit.targetAssoc)]) });
          return;
        }
      } catch {}
    };
    view.dom.addEventListener("pointerdown", onRenderedBoundaryPointerEvent, true);
    view.dom.addEventListener("mousedown", onRenderedBoundaryPointerEvent, true);
    view.dom.addEventListener("mouseup", onRenderedBoundaryPointerEvent, true);
    view.dom.addEventListener("click", onRenderedBoundaryPointerEvent, true);

    const onRenderedBoundaryKeyDown = (ev: KeyboardEvent) => {
      try {
        if (!view.state.facet(wysiwygKeepActiveLineRenderedFacet)) return;
        const range = view.state.selection.main;
        const line = view.state.doc.lineAt(range.head);
        const text = view.state.doc.sliceString(line.from, line.to);
        if (ev.key === "Enter" && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
          const target = getRenderedEnterSourcePos(view);
          if (!target) return;
          ev.preventDefault();
          ev.stopPropagation();
          view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(target.pos, target.side === "start" ? 1 : -1)]) });
          insertNewlineContinueMarkup(view) || insertNewlineAndIndent(view);
          return;
        }
        if (ev.key === " " && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
          if (!range.empty) return;
          const match = /^([ \t]*#{1,6}[ \t]+)/.exec(text);
          if (!match) return;
          const contentStart = line.from + match[1].length;
          if (range.head !== contentStart) return;
          ev.preventDefault();
          ev.stopPropagation();
          view.dispatch({
            changes: { from: range.head, to: range.head, insert: "\u00a0" },
            selection: { anchor: range.head + 1 },
            annotations: Transaction.userEvent.of("input.type")
          });
          return;
        }
        if (!range.empty && !ev.shiftKey) return;
        const plainArrowKey = !ev.metaKey && !ev.ctrlKey && !ev.altKey && (ev.key === "ArrowLeft" || ev.key === "ArrowRight");
        if (plainArrowKey) {
          const target = getRenderedHorizontalMotionTarget(view, ev.key === "ArrowRight" ? 1 : -1);
          if (!target) return;
          ev.preventDefault();
          ev.stopPropagation();
          const nextRange = ev.shiftKey && range.anchor !== target.pos
            ? EditorSelection.range(range.anchor, target.pos)
            : EditorSelection.cursor(target.pos, target.assoc);
          view.dispatch({ selection: EditorSelection.create([nextRange]) });
          return;
        }
        const homeEndKey = ev.key === "Home" || ev.key === "End";
        const commandArrowKey = ev.metaKey && !ev.ctrlKey && !ev.altKey && (ev.key === "ArrowLeft" || ev.key === "ArrowRight");
        if (!homeEndKey && !commandArrowKey) return;
        if (homeEndKey && (ev.metaKey || ev.ctrlKey || ev.altKey)) return;
        const boundaries = getRenderedLineBoundaries(view, line.number);
        const movesToStart = ev.key === "Home" || ev.key === "ArrowLeft";
        const target = movesToStart ? boundaries.start : boundaries.end;
        if (target == null) return;
        const targetAssoc = movesToStart ? 1 : -1;
        if (!ev.shiftKey && range.empty && target === range.head && range.assoc === targetAssoc) return;
        ev.preventDefault();
        ev.stopPropagation();
        const nextRange = ev.shiftKey && range.anchor !== target
          ? EditorSelection.range(range.anchor, target)
          : EditorSelection.cursor(target, targetAssoc);
        view.dispatch({ selection: EditorSelection.create([nextRange]) });
      } catch {}
    };
    view.dom.addEventListener("keydown", onRenderedBoundaryKeyDown, true);

    (view as any)._wysiwyg_cleanup = () => {
      try { mo.disconnect(); } catch {}
      if (this.boundaryCursorFrame) cancelAnimationFrame(this.boundaryCursorFrame);
      this.boundaryCursorFrame = 0;
      this.boundaryCursor?.remove();
      this.boundaryCursor = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      view.dom.removeEventListener("focusin", onEditorFocus, true);
      view.dom.removeEventListener("focusout", onEditorBlur, true);
      view.dom.removeEventListener("pointerdown", onRenderedBoundaryPointerEvent, true);
      view.dom.removeEventListener("mousedown", onRenderedBoundaryPointerEvent, true);
      view.dom.removeEventListener("mouseup", onRenderedBoundaryPointerEvent, true);
      view.dom.removeEventListener("click", onRenderedBoundaryPointerEvent, true);
      view.dom.removeEventListener("keydown", onRenderedBoundaryKeyDown, true);
    };
  }

  update(update: ViewUpdate) {
    const selectionOnly = update.selectionSet && !update.docChanged && !update.viewportChanged;
      let refresh = false;
      if (Array.isArray(update.transactions)) {
        for (const t of update.transactions) {
          try {
            const userEvent = t.annotation(Transaction.userEvent);
            if (userEvent === "wysiwyg-refresh") refresh = true;
          } catch {}
      }
      }
      const needRebuild = update.docChanged || update.viewportChanged || refresh;

    // 当编辑模式下（已展开为原文）且光标离开该代码块时，自动恢复预览
    let collapsed = false;
    if (update.selectionSet && this.expandedDiagrams.size > 0) {
      const toDelete: number[] = [];
      for (const start of this.expandedDiagrams) {
        const rng = getFencedBlockRangeAtPos(update.view, start);
        if (!rng) continue;
        let intersects = false;
        for (const sel of update.view.state.selection.ranges) {
          const sFrom = sel.from;
          const sTo = sel.to;
          // 是否与图块范围相交
          if (!(sTo <= rng.from || sFrom >= rng.to)) { intersects = true; break; }
        }
        if (!intersects) toDelete.push(start);
      }
      if (toDelete.length) {
        toDelete.forEach(p => this.expandedDiagrams.delete(p));
        collapsed = true;
      }
    }
    if (update.selectionSet && this.rawTables.size > 0) {
      const toDelete: number[] = [];
      for (const start of this.rawTables) {
        const rng = getTableBlockRangeAtPos(update.view, start);
        if (!rng) continue;
        let intersects = false;
        for (const sel of update.view.state.selection.ranges) {
          const sFrom = sel.from;
          const sTo = sel.to;
          // A cursor placed at the first table character should keep source mode open.
          if (sel.empty ? (sFrom >= rng.from && sFrom < rng.to) : !(sTo <= rng.from || sFrom >= rng.to)) { intersects = true; break; }
        }
        if (!intersects) toDelete.push(start);
      }
      if (toDelete.length) {
        toDelete.forEach(p => this.rawTables.delete(p));
        collapsed = true;
      }
    }

    if (needRebuild || selectionOnly || collapsed) {
      if (update.docChanged && !refresh && !collapsed && canMapWysiwygDecorations(update)) {
        this.decorations = this.decorations.map(update.changes);
        this.scheduleBoundaryCursor(update.view);
        return;
      }
      const activeLines = getSourceRevealLines(update.view);
      try {
        this.decorations = buildDecorations(update.view, activeLines, this.expandedDiagrams, this.rawTables);
      } catch (e) {
        console.error("[wysiwyg] buildDecorations (update) error", e);
        this.decorations = Decoration.none;
      }
    }
    if (update.selectionSet || update.geometryChanged || update.viewportChanged || update.docChanged) {
      this.scheduleBoundaryCursor(update.view);
    }
  }

  destroy() {
    // cleanup
    this.hideBoundaryCursor();
    try { this.boundaryCursor?.remove(); } catch {}
    try { (this as any)._wysiwyg_cleanup?.(); } catch {}
  }
}, {
  decorations: v => v.decorations
});

/* helper: compute active line numbers set */
function getActiveLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  for (const r of view.state.selection.ranges) {
    const fromLine = view.state.doc.lineAt(r.from).number;
    const toLine = view.state.doc.lineAt(r.to).number;
    for (let n = fromLine; n <= toLine; n++) lines.add(n);
  }
  return lines;
}

function isIncompleteMarkdownStructureLine(lineText: string): boolean {
  const text = lineText.trim();
  return /^(#{1,6}|#{1,6}\s+)$/.test(text)
    || /^([-+*]|\d+[.)])\s*$/.test(text)
    || /^>\s*$/.test(text)
    || /^(- \[[ xX]?\])\s*$/.test(text);
}

function maskClosedInlineCodeSpans(text: string): { text: string; hasUnclosedCodeSpan: boolean; tickCount: number } {
  const chars = Array.from(text);
  const tickCount = chars.filter((ch) => ch === "`").length;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "`") continue;
    let runEnd = i + 1;
    while (runEnd < chars.length && chars[runEnd] === "`") runEnd++;
    const runLength = runEnd - i;
    let closeStart = runEnd;
    let found = false;
    while (closeStart < chars.length) {
      if (chars[closeStart] !== "`") {
        closeStart++;
        continue;
      }
      let closeEnd = closeStart + 1;
      while (closeEnd < chars.length && chars[closeEnd] === "`") closeEnd++;
      if (closeEnd - closeStart === runLength) {
        for (let k = i; k < closeEnd; k++) chars[k] = " ";
        i = closeEnd - 1;
        found = true;
        break;
      }
      closeStart = closeEnd;
    }
    if (!found) return { text: chars.join(""), hasUnclosedCodeSpan: true, tickCount };
  }
  return { text: chars.join(""), hasUnclosedCodeSpan: false, tickCount };
}

function getInlineMarkdownCompletionDiagnostics(lineText: string) {
  const withoutEscaped = lineText.replace(/\\./g, "");
  const codeMasked = maskClosedInlineCodeSpans(withoutEscaped);
  const markdownText = codeMasked.text;
  const hasOpenBracket = /!?\[[^\]]*$/.test(markdownText);
  const hasOpenLinkParen = /!?\[[^\]]+\]\([^)]*$/.test(markdownText);
  const boldDelimiters = (markdownText.match(/\*\*/g) || []).length;
  const strikeDelimiters = (markdownText.match(/~~/g) || []).length;
  return {
    tickCount: codeMasked.tickCount,
    hasOddTicks: codeMasked.tickCount % 2 === 1,
    hasUnclosedCodeSpan: codeMasked.hasUnclosedCodeSpan,
    hasOpenBracket,
    hasOpenLinkParen,
    boldDelimiterCount: boldDelimiters,
    hasOddBoldDelimiters: boldDelimiters % 2 === 1,
    strikeDelimiterCount: strikeDelimiters,
    hasOddStrikeDelimiters: strikeDelimiters % 2 === 1,
    unfinished: codeMasked.hasUnclosedCodeSpan
      || hasOpenBracket
      || hasOpenLinkParen
      || boldDelimiters % 2 === 1
      || strikeDelimiters % 2 === 1
  };
}

function hasUnfinishedInlineMarkdown(lineText: string): boolean {
  return getInlineMarkdownCompletionDiagnostics(lineText).unfinished;
}

function shouldRevealSourceForSelectionLine(view: EditorView, lineNumber: number): boolean {
  const line = view.state.doc.line(lineNumber);
  const text = view.state.doc.sliceString(line.from, line.to);
  const incomplete = isIncompleteMarkdownStructureLine(text);
  const inlineDiagnostics = getInlineMarkdownCompletionDiagnostics(text);
  const unfinished = inlineDiagnostics.unfinished;
  return incomplete || unfinished;
}

export function getRenderedLineVisibleCursorPos(view: EditorView, lineNumber: number): number | null {
  try {
    const boundary = getRenderedLineBoundaries(view, lineNumber);
    return boundary.start;
  } catch {
    return null;
  }
}

function getSourceRevealLines(view: EditorView): Set<number> {
  if (view.state.facet(readerRenderOptions).publicReadOnly) return new Set();
  const activeLines = getActiveLines(view);
  const keepRendered = view.state.facet(wysiwygKeepActiveLineRenderedFacet);
  if (!keepRendered) {
    return activeLines;
  }
  const lines = new Set<number>();
  for (const ln of activeLines) {
    try {
      if (shouldRevealSourceForSelectionLine(view, ln)) lines.add(ln);
    } catch {}
  }
  return lines;
}

/* helper: 根据起始位置查找对应的围栏代码块范围（Mermaid/CodeBlock） */
function getFencedBlockRangeAtPos(view: EditorView, startPos: number): { from: number; to: number } | null {
  try {
    const doc = view.state.doc;
    const blocks = collectRoleScopedFenceBlocks(doc);
    const found = blocks.find(block => block.from === startPos);
    return found ? { from: found.from, to: found.to } : null;
  } catch {
    return null;
  }
}

function getTableBlockRangeAtPos(view: EditorView, startPos: number): { from: number; to: number } | null {
  try {
    const doc = view.state.doc;
    const startLine = doc.lineAt(startPos).number;
    if (startLine >= doc.lines) return null;
    const headerLine = doc.line(startLine);
    const sepLine = doc.line(startLine + 1);
    const headerTxt = doc.sliceString(headerLine.from, headerLine.to);
    const sepTxt = doc.sliceString(sepLine.from, sepLine.to);
    if (!isMarkdownTableContentRow(headerTxt) || !isMarkdownTableSeparatorRow(sepTxt)) return null;
    let rowLn = startLine + 2;
    while (rowLn <= doc.lines) {
      const row = doc.line(rowLn);
      const text = doc.sliceString(row.from, row.to);
      if (!isMarkdownTableContentRow(text)) break;
      rowLn++;
    }
    return { from: headerLine.from, to: doc.line(rowLn - 1).to };
  } catch {
    return null;
  }
}

export function wysiwyg(options: { keepActiveLineRendered?: boolean } & ReaderRenderOptions = {}): Extension {
  return [
    readerRenderOptions.of(options),
    wysiwygKeepActiveLineRenderedFacet.of(options.keepActiveLineRendered !== false),
    roleFenceBlocksField,
    tableBlockDecorationsField,
    imageGalleryField,
    ...(options.publicReadOnly ? [] : [imageInternalDragHandlers]),
    wysiwygPlugin
  ];
}
