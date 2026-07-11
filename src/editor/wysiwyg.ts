import { Facet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import katex from "katex";
import mermaid from "mermaid";
import { encode as encodePlantUML } from "plantuml-encoder";

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
const INLINE_FALLBACK = /(\*\*([^*\n]+)\*\*)|(_([^_\n]+)_)|(`([^`\n]+)`)|(\[([^\]]+)\]\(([^)\n]+)\))|(!\[([^\]]*)\]\(([^)\n]+)\))|(\$([^\$\n]+)\$)|(~~([^~\n]+)~~)/g;
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

/* Helper: Check if line contains tool call or thinking markers (skip WYSIWYG processing) */
const isToolOrThinkingLine = (lineText: string): boolean => {
  return /^\s*调用\s+[^\n<]{1,300}(?:\s*<!--\s*zion-tool:id=[^>\s]+\s*-->)?\s*$/.test(lineText)
    || /^\s*思考\s*<!--\s*zion-thinking:id=[^>\s]+\s*-->\s*$/.test(lineText);
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
          a.href = source.slice(labelEnd + 2, urlEnd);
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

const wysiwygKeepActiveLineRenderedFacet = Facet.define<boolean, boolean>({
  combine(values) {
    return values.length ? values[values.length - 1] !== false : true;
  }
});

function addNestedInlineDecorations(add: AddDecoration, contentStart: number, content: string) {
  const nested = /(`([^`\n]+)`)|(!\[([^\]]*)\]\(([^)\n]+)\))|(\[([^\]]+)\]\(([^)\n]+)\))|(\$([^\$\n]+)\$)/g;
  let m: RegExpExecArray | null;
  while ((m = nested.exec(content)) !== null) {
    const start = contentStart + m.index;
    const end = start + m[0].length;
    if (m[1]) {
      add(start, start + 1, Decoration.mark({ class: "cm-z-hide-syntax" }));
      add(start + 1, end - 1, Decoration.mark({ class: "cm-md-code" }));
      add(end - 1, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
      continue;
    }
    if (m[3]) {
      const alt = m[4] || "";
      const src = m[5] || "";
      add(start, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
      add(start, start, Decoration.widget({ widget: new SimpleImageWidget(alt, src), side: 1 }));
      continue;
    }
    if (m[6]) {
      const label = m[7] || "";
      const url = m[8] || "";
      add(start, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
      add(start, start, Decoration.widget({ widget: new SimpleLinkWidget(label, url), side: 1 }));
      continue;
    }
    if (m[9]) {
      const expr = m[10] || "";
      add(start, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
      add(start, start, Decoration.widget({ widget: new MathWidget(expr, false), side: 1 }));
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

function collectStateBlockMathRanges(state: EditorState): SourceRange[] {
  const ranges: SourceRange[] = [];
  try {
    const tree = syntaxTree(state) as any;
    tree.iterate({
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
  const roleFenceBlocks = collectRoleScopedFenceBlocks(doc);
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

/* App image short link resolver: app://img/<id> -> DataURL from IndexedDB ("dev.paste-image-db"/"images") */
const APP_IMG_PREFIX = "app://img/";
const appImageCache = new Map<string, string>();
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

function openPasteImageDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open("dev.paste-image-db", 1);
      req.onupgradeneeded = (e: any) => {
        const db: IDBDatabase = e.target.result;
        if (!db.objectStoreNames.contains("images")) {
          db.createObjectStore("images", { keyPath: "id" });
        }
      };
      req.onsuccess = (e: any) => resolve(e.target.result as IDBDatabase);
      req.onerror = (e: any) => reject(e.target.error);
    } catch (err) {
      reject(err);
    }
  });
}

async function getDataUrlById(id: string): Promise<string | null> {
  if (!id) return null;
  if (appImageCache.has(id)) return appImageCache.get(id)!;
  const db = await openPasteImageDB();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("images", "readonly");
      const store = tx.objectStore("images");
      const req = store.get(id);
      req.onsuccess = (e: any) => {
        try { db.close(); } catch {}
        const rec = e.target.result as { id: string; dataUrl: string } | undefined;
        if (rec && rec.dataUrl) {
          appImageCache.set(id, rec.dataUrl);
          resolve(rec.dataUrl);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => {
        try { db.close(); } catch {}
        resolve(null);
      };
    } catch {
      try { db.close(); } catch {}
      resolve(null);
    }
  });
}

async function resolveAppImage(src: string): Promise<string | null> {
  if (!src || !src.startsWith(APP_IMG_PREFIX)) return null;
  const id = src.slice(APP_IMG_PREFIX.length);
  try {
    const url = await getDataUrlById(id);
    return url || null;
  } catch {
    return null;
  }
}

/* Widget implementations (small, eq provided for reuse) */

class SimpleLinkWidget extends WidgetType {
  constructor(private label: string, private url: string) { super(); }
  eq(other: SimpleLinkWidget) { return other.label === this.label && other.url === this.url; }
  toDOM() {
    const a = document.createElement("a");
    a.className = "cm-md-link";
    a.href = this.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    appendTableInlineMarkdown(a, this.label);
    a.title = this.url;
    return a;
  }
  ignoreEvent() { return true; }
}

class SimpleImageWidget extends WidgetType {
  constructor(private alt: string, private src: string) { super(); }
  eq(other: SimpleImageWidget) { return other.alt === this.alt && other.src === this.src; }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-img-wrap";
    const cacheKey = `img:${this.src || ""}`;
    applyCachedMinHeight(wrap, cacheKey);

    const mkFallback = () => {
      const fallback = document.createElement("span");
      fallback.className = "cm-md-img-fallback";
      appendTableInlineMarkdown(fallback, this.alt || "[image]");
      return fallback;
    };

    const src = this.src || "";
    // Handle internal short link: app://img/<id>
    if (src.startsWith(APP_IMG_PREFIX)) {
      const ph = mkFallback();
      wrap.appendChild(ph);
      // Async resolve to DataURL and replace placeholder
      resolveAppImage(src).then((url) => {
        if (!url) return;
        try {
          const img = document.createElement("img");
          img.className = "cm-md-img";
          img.alt = this.alt || "";
          img.referrerPolicy = "no-referrer";
          (img as any).loading = "lazy";
          img.src = url;
          img.addEventListener("load", () => {
            requestAnimationFrame(() => {
              updateCachedHeight(wrap, cacheKey);
              applyCachedMinHeight(wrap, cacheKey);
            });
          });
          img.addEventListener("error", () => {
            const fb = mkFallback();
            requestAnimationFrame(() => {
              if (img.parentNode) img.parentNode.replaceChild(fb, img);
            });
          });
          requestAnimationFrame(() => {
            try { wrap.replaceChild(img, ph); } catch {}
          });
        } catch {}
      }).catch(() => {
        // keep fallback if resolve fails
      });
    } else {
      const img = document.createElement("img");
      img.className = "cm-md-img";
      img.alt = this.alt || "";
      img.referrerPolicy = "no-referrer";
      (img as any).loading = "lazy";
      img.src = src;
      img.addEventListener("load", () => {
        requestAnimationFrame(() => {
          updateCachedHeight(wrap, cacheKey);
          applyCachedMinHeight(wrap, cacheKey);
        });
      });
      img.addEventListener("error", () => {
        const fb = mkFallback();
        requestAnimationFrame(() => {
          if (img.parentNode) img.parentNode.replaceChild(fb, img);
        });
      });
      wrap.appendChild(img);
    }

    return wrap;
  }
  ignoreEvent() { return true; }
}

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
  constructor(private checked: boolean, private label: string) { super(); }
  eq(other: TaskWidget) {
    return other.checked === this.checked && other.label === this.label;
  }
  toDOM(view: EditorView) {
    const container = document.createElement("span");
    container.className = "cm-md-task";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!this.checked;
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
    const cellComments = sourceRange
      ? this.commentRanges.filter((item) => item.to > sourceRange.from && item.from < sourceRange.to)
      : [];
    appendTableInlineMarkdownWithComments(content, value, sourceRange, cellComments);
    cell.appendChild(content);
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap cm-md-table-readonly";
    const cacheKey = getTableHeightCacheKey(this.headers, this.aligns, this.rows);
    applyCachedMinHeight(wrap, cacheKey);
    const keepEventInTable = (e: Event) => {
      if (!(e.target instanceof HTMLElement)) return;
      if (e.target.closest(".cm-md-table-btn")) return;
      e.stopPropagation();
    };
    wrap.addEventListener("pointerdown", keepEventInTable);
    wrap.addEventListener("mousedown", keepEventInTable);
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
    toolbar.appendChild(editBtn);

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
function ensureMermaidInit() {
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: getMermaidTheme(),
      logLevel: "error",
      suppressErrors: true
    } as any);
    // Suppress global parse error handler to avoid DOM error notes
    try { (mermaid as any).parseError = () => {}; } catch {}
  } catch {}
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
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-diagram";
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
    toolbar.append(editBtn, copySvgBtn, exportPngBtn, openBtn);
    wrap.appendChild(toolbar);

    const body = document.createElement("div");
    body.className = "cm-md-diagram-body";
    wrap.appendChild(body);

    if (this.lang === "mermaid") {
      let scratch: HTMLDivElement | null = null;
      try {
        ensureMermaidInit();
        const id = "mmd-" + Math.random().toString(36).slice(2);
        // Use an offscreen scratch container to prevent mermaid from appending error text to document.body
        scratch = document.createElement("div");
        scratch.style.position = "fixed";
        scratch.style.left = "-9999px";
        scratch.style.top = "-9999px";
        document.body.appendChild(scratch);
        mermaid.render(id, this.code, scratch).then(({ svg }) => {
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
  const roleFenceBlocks = collectRoleScopedFenceBlocks(doc);

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
    let insideMath = false;
    try {
      tree.iterate({
        enter: (node: any) => {
          const name = node.name || node.type?.name;
          if (name === "BlockMath" && pos >= node.from && pos < node.to) {
            insideMath = true;
          }
        }
      });
    } catch {}
    return insideMath;
  };

  // Track lines processed by fallback scanners to avoid overlap/conflicts
  const processedFallbackLines = new Set<number>();
  try {
    previewTableRanges = view.state.field(tableBlockDecorationsField, false)?.ranges || [];
  } catch {
    previewTableRanges = [];
  }

  // 1) Block-level via syntax tree (only for nodes within viewport)
  try {
    tree.iterate({
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
              add(line.from, markerEnd, Decoration.mark({ class: "cm-z-hide-heading-marker" }));
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
            add(node.from, node.to, Decoration.mark({ class: "cm-z-hide-syntax" }));
            const line = doc.lineAt(node.to);
            const rest = doc.sliceString(node.to, line.to).trimStart();
            add(node.from, node.from, Decoration.widget({ widget: new TaskWidget(checked, rest), side: 1 }));
          }
          return;
        }

        // List bullets / numbers: keep raw on active line; off active line use bullet/number widget
        if (name === "ListMark") {
          const lnNum = doc.lineAt(node.from).number;
          const isActive = activeLines.has(lnNum);
          if (!isActive) {
            const txt = doc.sliceString(node.from, node.to).trim();
            const line = doc.lineAt(node.to);
            let replaceTo = node.to;
            while (replaceTo < line.to && /\s/.test(doc.sliceString(replaceTo, replaceTo + 1))) replaceTo++;
            add(
              node.from,
              replaceTo,
              Decoration.replace({
                widget: new (class extends WidgetType {
                  constructor(private txt: string) { super(); }
                  eq(other: any) { return other.txt === this.txt; }
                  toDOM() {
                    const s = document.createElement("span");
                    s.className = /^[\d]/.test(this.txt) ? "cm-md-ol-num" : "cm-md-ul-bullet";
                    s.textContent = /^[\d]/.test(this.txt) ? `${this.txt.replace(/\./g, "")}.\u00A0` : "•\u00A0";
                    return s;
                  }
                  ignoreEvent() { return true; }
                })(txt),
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
          // For non-active lines hide the leading marker with a marker-preserving class.
          for (let ln = startLn; ln <= endLn; ln++) {
            const l = doc.line(ln);
            const txt = doc.sliceString(l.from, l.to);
            const prefixMatch = /^\s*>+\s*/.exec(txt);
            const markerLen = prefixMatch ? prefixMatch[0].length : 0;

            // Always apply line-level decoration for contiguous background
            add(l.from, l.from, Decoration.line({ class: "cm-md-quote" }));

            if (anyActive && activeLines.has(ln)) {
              // Keep marker visible on active line(s) so user can edit quote prefix normally.
              // Content is already visually styled by the line decoration.
            } else {
              // Hide marker but preserve layout using a dedicated class that doesn't collapse line height.
              if (markerLen > 0) {
                add(l.from, l.from + markerLen, Decoration.mark({ class: "cm-z-hide-marker" }));
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
          if (!isActive) {
            // Hide the original markers (keep mapping stable)
            add(line.from, line.to, Decoration.mark({ class: "cm-z-hide-syntax" }));
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
        add(block.from, block.from + (firstLine.to - firstLine.from) + 1, Decoration.mark({ class: "cm-z-hide-syntax" }));
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
          add(start, start + 2, Decoration.mark({ class: "cm-z-hide-syntax" }));
          add(start + 2, end - 2, Decoration.mark({ class: "cm-md-strong" }));
          addNestedInlineDecorations(add, start + 2, m[2] || "");
          add(end - 2, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
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
          add(start, start + 1, Decoration.mark({ class: "cm-z-hide-syntax" }));
          add(start + 1, end - 1, Decoration.mark({ class: "cm-md-em" }));
          addNestedInlineDecorations(add, start + 1, m[4] || "");
          add(end - 1, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
        }
        continue;
      }
      // inline code (`...`)
      if (m[5]) {
        if (isActive) {
          add(start + 1, end - 1, Decoration.mark({ class: "cm-md-code" }));
        } else {
          add(start, start + 1, Decoration.mark({ class: "cm-z-hide-syntax" }));
          add(start + 1, end - 1, Decoration.mark({ class: "cm-md-code" }));
          add(end - 1, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
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
          add(start, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
          add(start, start, Decoration.widget({ widget: new SimpleLinkWidget(label, url), side: 1 }));
        }
        continue;
      }
      // image (![alt](src))
      if (m[10]) {
        const alt = m[11] || "";
        const src = m[12] || "";
        if (isActive) {
          // active line: keep raw markdown
        } else {
          add(start, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
          add(start, start, Decoration.widget({ widget: new SimpleImageWidget(alt, src), side: 1 }));
        }
        continue;
      }
      // inline math ($...$)
      if (m[13]) {
        const expr = m[14] || "";
        if (isActive) {
          // active line: keep raw markdown (no widget to avoid duplication)
        } else {
          add(start, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
          add(start, start, Decoration.widget({ widget: new MathWidget(expr, false), side: 1 }));
        }
        continue;
      }
      // strikethrough (~~...~~)
      if (m[15]) {
        if (isActive) {
          add(start + 2, end - 2, Decoration.mark({ class: "cm-md-strike" }));
        } else {
          add(start, start + 2, Decoration.mark({ class: "cm-z-hide-syntax" }));
          add(start + 2, end - 2, Decoration.mark({ class: "cm-md-strike" }));
          addNestedInlineDecorations(add, start + 2, m[16] || "");
          add(end - 2, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
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
        add(start, start + 1, Decoration.mark({ class: "cm-z-hide-syntax" }));
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
      add(start, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
      add(start, start, Decoration.widget({ widget: new KbdWidget(m[1] || ""), side: 1 }));
    }

    const footnoteRef = /\[\^([^\]\s]+)\](?!:)/g;
    while ((m = footnoteRef.exec(text)) !== null) {
      const start = vr.from + m.index;
      const end = start + m[0].length;
      if (isInsideFencedCode(start)) continue;
      const line = doc.lineAt(start);
      if (activeLines.has(line.number)) continue;
      if (isToolOrThinkingLine(doc.sliceString(line.from, line.to))) continue;
      add(start, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
      add(start, start, Decoration.widget({ widget: new FootnoteRefWidget(m[1] || ""), side: 1 }));
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
          add(line.from, line.from + markerLen, Decoration.mark({ class: "cm-z-hide-syntax" }));
          add(line.from, line.from, Decoration.widget({ widget: new FootnoteRefWidget(footnoteDefMatch[1] || ""), side: 1 }));
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

          if (!anyActive) {
            // hide all lines and collapse middle lines
            for (let hideLn = ln; hideLn <= endFenceLn; hideLn++) {
              const hline = doc.line(hideLn);
              add(hline.from, hline.to, Decoration.mark({ class: "cm-z-hide-syntax" }));
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

/* ViewPlugin: incremental rebuilds */
const wysiwygPlugin = ViewPlugin.fromClass(class {
  decorations: any;
  expandedDiagrams = new Set<number>();
  rawTables = new Set<number>();

  constructor(view: EditorView) {
    try {
      this.decorations = buildDecorations(view, getSourceRevealLines(view), this.expandedDiagrams, this.rawTables);
    } catch (e) {
      console.error("[wysiwyg] buildDecorations (constructor) error", e);
      this.decorations = Decoration.none;
    }
    this.bindEvents(view);
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

    const readHeadingClick = (ev: MouseEvent | PointerEvent) => {
      const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
      if (pos == null) return null;
      const line = view.state.doc.lineAt(pos);
      const text = view.state.doc.sliceString(line.from, line.to);
      const match = /^([ \t]*#{1,6}[ \t]+)/.exec(text);
      if (!match) return null;
      const markerEnd = line.from + match[1].length;
      return {
        pos,
        line,
        markerEnd,
        markerEndRect: view.coordsAtPos(markerEnd),
        firstCharEndRect: markerEnd < line.to ? view.coordsAtPos(markerEnd + 1) : null
      };
    };
    const onHeadingPointerEvent = (ev: MouseEvent | PointerEvent) => {
      try {
        const hit = readHeadingClick(ev);
        if (!hit) return;
        const keepRendered = view.state.facet(wysiwygKeepActiveLineRenderedFacet);
        const markerEndX = hit.markerEndRect?.left ?? hit.markerEndRect?.right ?? null;
        const firstCharEndX = hit.firstCharEndRect?.left ?? hit.firstCharEndRect?.right ?? null;
        const firstCharMidX = markerEndX != null && firstCharEndX != null ? (markerEndX + firstCharEndX) / 2 : null;
        const isBeforeOrLeftHalfOfFirstChar = hit.pos < hit.markerEnd
          || (hit.pos === hit.markerEnd + 1 && firstCharMidX != null && ev.clientX <= firstCharMidX);
        const shouldNormalize = keepRendered
          && ev.button === 0
          && !ev.shiftKey
          && !ev.metaKey
          && !ev.ctrlKey
          && !ev.altKey
          && isBeforeOrLeftHalfOfFirstChar;
        if (shouldNormalize) {
          ev.preventDefault();
          ev.stopPropagation();
          view.focus();
          view.dispatch({ selection: { anchor: hit.markerEnd } });
          return;
        }
      } catch {}
    };
    view.dom.addEventListener("pointerdown", onHeadingPointerEvent, true);
    view.dom.addEventListener("mousedown", onHeadingPointerEvent, true);
    view.dom.addEventListener("mouseup", onHeadingPointerEvent, true);
    view.dom.addEventListener("click", onHeadingPointerEvent, true);

    const onHeadingKeyDown = (ev: KeyboardEvent) => {
      try {
        if (ev.key !== " " || ev.metaKey || ev.ctrlKey || ev.altKey) return;
        if (!view.state.facet(wysiwygKeepActiveLineRenderedFacet)) return;
        const range = view.state.selection.main;
        if (!range.empty) return;
        const line = view.state.doc.lineAt(range.head);
        const text = view.state.doc.sliceString(line.from, line.to);
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
      } catch {}
    };
    view.dom.addEventListener("keydown", onHeadingKeyDown, true);

    (view as any)._wysiwyg_cleanup = () => {
      try { mo.disconnect(); } catch {}
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      view.dom.removeEventListener("pointerdown", onHeadingPointerEvent, true);
      view.dom.removeEventListener("mousedown", onHeadingPointerEvent, true);
      view.dom.removeEventListener("mouseup", onHeadingPointerEvent, true);
      view.dom.removeEventListener("click", onHeadingPointerEvent, true);
      view.dom.removeEventListener("keydown", onHeadingKeyDown, true);
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
      const activeLines = getSourceRevealLines(update.view);
      try {
        this.decorations = buildDecorations(update.view, activeLines, this.expandedDiagrams, this.rawTables);
      } catch (e) {
        console.error("[wysiwyg] buildDecorations (update) error", e);
        this.decorations = Decoration.none;
      }
    }
  }

  destroy() {
    // cleanup
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

function hasUnfinishedInlineMarkdown(lineText: string): boolean {
  const withoutEscaped = lineText.replace(/\\./g, "");
  const ticks = (withoutEscaped.match(/`/g) || []).length;
  if (ticks % 2 === 1) return true;
  const dollars = (withoutEscaped.match(/\$/g) || []).length;
  if (dollars % 2 === 1) return true;
  if (/!?\[[^\]]*$/.test(withoutEscaped)) return true;
  if (/!?\[[^\]]+\]\([^)]*$/.test(withoutEscaped)) return true;
  const boldDelimiters = (withoutEscaped.match(/\*\*/g) || []).length;
  if (boldDelimiters % 2 === 1) return true;
  const strikeDelimiters = (withoutEscaped.match(/~~/g) || []).length;
  if (strikeDelimiters % 2 === 1) return true;
  return false;
}

function shouldRevealSourceForSelectionLine(view: EditorView, lineNumber: number): boolean {
  const line = view.state.doc.line(lineNumber);
  const text = view.state.doc.sliceString(line.from, line.to);
  const incomplete = isIncompleteMarkdownStructureLine(text);
  const unfinished = hasUnfinishedInlineMarkdown(text);
  const reveal = incomplete || unfinished;
  return reveal;
}

export function getRenderedLineVisibleCursorPos(view: EditorView, lineNumber: number): number | null {
  try {
    if (!view.state.facet(wysiwygKeepActiveLineRenderedFacet)) return null;
    if (shouldRevealSourceForSelectionLine(view, lineNumber)) return null;
    const line = view.state.doc.line(lineNumber);
    const text = view.state.doc.sliceString(line.from, line.to);
    const heading = /^([ \t]*)(#{1,6})([ \t]+)/.exec(text);
    if (heading) {
      const pos = line.from + heading[0].length;
      return pos <= line.to ? pos : line.to;
    }
    return null;
  } catch {
    return null;
  }
}

function getSourceRevealLines(view: EditorView): Set<number> {
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

export function wysiwyg(options: { keepActiveLineRendered?: boolean } = {}): Extension {
  return [
    wysiwygKeepActiveLineRenderedFacet.of(options.keepActiveLineRendered !== false),
    tableBlockDecorationsField,
    wysiwygPlugin
  ];
}
