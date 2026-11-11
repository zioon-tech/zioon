import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { safeText, cellWidth, graphemes, graphemeWidth } from "./cli-text.mjs";

const options = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] };
const paint = (text, styles, color) => color && styles.length
  ? `\x1b[${styles.map((code) => color === "light" ? ({ 36: 34, 2: 90 }[code] || code) : code).join(";")}m${text}\x1b[0m` : text;
const span = (text, styles = []) => ({ text: safeText(text), styles });
const plain = (spans) => spans.map((item) => item.text).join("");

function inline(nodes = [], styles = []) {
  return nodes.flatMap((node) => {
    switch (node.type) {
      case "strong": return inline(node.children, [...styles, 1]);
      case "emphasis": return inline(node.children, [...styles, 3]);
      case "delete": return inline(node.children, [...styles, 9]);
      case "inlineCode": return [span(node.value, [...styles, 36])];
      case "break": return [span("\n", styles)];
      case "link": {
        const label = inline(node.children, [...styles, 4]);
        const url = safeText(node.url || "");
        return plain(label) === url ? label : [...label, span(` (${url})`, [2])];
      }
      case "image": return [span(`[${node.alt || "image"}] (${node.url || ""})`, styles)];
      case "linkReference": return inline(node.children, styles);
      case "imageReference": return [span(node.alt || "image", styles)];
      default: return node.children ? inline(node.children, styles) : [span(node.value || "", styles)];
    }
  });
}

// Wrap visible cells, not JS string lengths or ANSI byte lengths. Merge adjacent
// styled characters before emitting escapes to keep terminal traffic small.
function wrap(spans, width, color) {
  width = Math.max(2, width);
  const lines = [];
  let fragments = [], used = 0;
  const finish = () => {
    lines.push(fragments.map((item) => paint(item.text, item.styles, color)).join(""));
    fragments = []; used = 0;
  };
  for (const item of spans) {
    for (const ch of graphemes(item.text.replace(/\t/g, "    "))) {
      if (ch === "\n") { finish(); continue; }
      const size = graphemeWidth(ch);
      if (used + size > width) finish();
      const previous = fragments.at(-1);
      if (previous && previous.styles === item.styles) previous.text += ch;
      else fragments.push({ text: ch, styles: item.styles });
      used += size;
    }
  }
  if (fragments.length || !lines.length) finish();
  return lines;
}

function tableRows(node, width, color) {
  const header = node.children[0]?.children || [];
  const count = header.length;
  if (!count) return [];
  const cells = node.children.map((row) => row.children.map((cell) => inline(cell.children)));
  // On very narrow terminals use labelled records, preserving every cell.
  if (width < count * 9 + 1) {
    if (cells.length === 1) return wrap(inline(header.flatMap((cell) => cell.children), [1]), width, color);
    return cells.slice(1).flatMap((row, index) => [
      paint(`  ${index + 1}.`, [2], color),
      ...header.flatMap((_, col) => wrap([
        ...inline(header[col].children, [1]), span(": "), ...(row[col] || [])
      ], width - 2, color).map((line) => `  ${line}`)),
      ""
    ]);
  }
  const available = width - count * 3 - 1;
  const desired = header.map((_, col) => Math.max(4, ...cells.map((row) => cellWidth(plain(row[col] || [])))));
  const widths = desired.map(() => Math.floor(available / count));
  // Give unused space from short columns to long ones.
  for (let col = 0; col < count; col++) widths[col] = Math.min(widths[col], desired[col]);
  let spare = available - widths.reduce((a, b) => a + b, 0);
  while (spare > 0) {
    const col = widths.reduce((best, value, index) => desired[index] - value > desired[best] - widths[best] ? index : best, 0);
    if (widths[col] >= desired[col]) break;
    widths[col]++; spare--;
  }
  const border = (left, middle, right) => paint(
    left + widths.map((size) => "─".repeat(size + 2)).join(middle) + right, [2], color
  );
  const rows = [border("┌", "┬", "┐")];
  cells.forEach((row, index) => {
    const wrapped = widths.map((size, col) => wrap(
      index ? row[col] || [] : inline(header[col].children, [1]), size, color
    ));
    const height = Math.max(...wrapped.map((lines) => lines.length));
    for (let line = 0; line < height; line++) {
      rows.push("│ " + widths.map((size, col) => {
        const value = wrapped[col][line] || "";
        const padding = Math.max(0, size - cellWidth(value));
        const alignment = node.align?.[col];
        const left = alignment === "right" ? padding : alignment === "center" ? Math.floor(padding / 2) : 0;
        return " ".repeat(left) + value + " ".repeat(padding - left);
      }).join(" │ ") + " │");
    }
    if (!index) rows.push(border("├", "┼", "┤"));
  });
  rows.push(border("└", "┴", "┘"));
  return rows;
}

function renderNodes(nodes, width, color) {
  const rows = [];
  const separate = () => { if (rows.length && rows.at(-1) !== "") rows.push(""); };
  for (const node of nodes) {
    separate();
    switch (node.type) {
      case "heading":
        rows.push(...wrap(inline(node.children, [1]), width, color)); break;
      case "paragraph":
        rows.push(...wrap(inline(node.children), width, color)); break;
      case "table":
        rows.push(...tableRows(node, width, color)); break;
      case "code": {
        rows.push(paint(`  ${node.lang || "code"}`, [2], color));
        rows.push(...wrap([span(node.value)], width - 4, color).map((line) => `  │ ${line}`));
        break;
      }
      case "blockquote":
        rows.push(...renderNodes(node.children, width - 2, color).map((line) => `│ ${line}`)); break;
      case "list":
        node.children.forEach((item, index) => {
          const marker = item.checked !== null && item.checked !== undefined
            ? item.checked ? "☑ " : "☐ " : node.ordered ? `${(node.start || 1) + index}. ` : "• ";
          const indent = " ".repeat(cellWidth(marker));
          const lines = renderNodes(item.children, width - cellWidth(marker), color);
          rows.push(...lines.map((line, lineIndex) => (lineIndex ? indent : marker) + line));
          if (node.spread && index < node.children.length - 1) rows.push("");
        });
        break;
      case "thematicBreak": rows.push(paint("─".repeat(Math.min(width, 48)), [2], color)); break;
      case "definition": break;
      default:
        rows.push(...(node.children ? renderNodes(node.children, width, color) : wrap([span(node.value || "")], width, color)));
    }
  }
  return rows;
}

export function renderTerminalMarkdown(text, { width = 80, color = true } = {}) {
  return renderNodes(fromMarkdown(safeText(text), options).children, Math.max(8, width), color);
}

// Only the current Markdown block is mutable. Completed blocks go straight into
// native scrollback. Tokens may split anywhere, including within ** or fences.
export function createMarkdownStream(output, theme) {
  const color = theme.color && (theme.light ? "light" : true);
  let pending = "", timer = null, previewRows = 0, lastPreview = "", deferred = false, listening = false;
  let previewWidths = [];
  const width = () => Math.max(8, (output.columns || 80) - 1);
  const erase = () => {
    if (!previewRows) return;
    const columns = Math.max(1, output.columns || 80);
    const physicalRows = previewWidths.reduce((sum, size) => sum + Math.max(1, Math.ceil(size / columns)), 0);
    output.write(`\r${physicalRows > 1 ? `\x1b[${physicalRows - 1}A` : ""}\x1b[J`);
    previewRows = 0; previewWidths = []; lastPreview = "";
  };
  const commit = (nodes) => {
    const rows = renderNodes(nodes, width(), color);
    if (rows.length) output.write(rows.join("\n") + "\n\n");
  };
  const draw = () => {
    clearTimeout(timer); timer = null;
    if (!pending) return;
    // Keep a pathological single block from stalling the UI on every token.
    // It is still rendered in full when completed, rather than truncating content.
    if (pending.length > 64 * 1024) { deferred = true; return; }
    const tree = fromMarkdown(safeText(pending), options);
    if (tree.children.length > 1) {
      const stable = tree.children.slice(0, -1);
      const offset = tree.children.at(-1).position.start.offset;
      erase(); commit(stable); pending = safeText(pending).slice(offset);
      tree.children = tree.children.slice(-1);
    }
    const rows = renderNodes(tree.children, width(), color);
    const visible = rows.slice(-Math.max(1, (output.rows || 24) - 2));
    const text = visible.join("\n");
    if (text === lastPreview) return;
    erase();
    if (text) {
      output.write(text); previewRows = visible.length; previewWidths = visible.map(cellWidth); lastPreview = text;
    }
  };
  const resize = () => {
    // The terminal may have reflowed the live rows already. Finish them at the
    // new width on the next render; committed scrollback remains terminal-owned.
    erase(); draw();
  };
  return {
    write(text) {
      if (!listening) { output.on?.("resize", resize); listening = true; }
      pending += String(text || "");
      if (!timer && !deferred) timer = setTimeout(draw, 32);
    },
    flush: draw,
    end() {
      clearTimeout(timer); timer = null;
      erase();
      if (pending) commit(fromMarkdown(safeText(pending), options).children);
      pending = ""; deferred = false;
      // end() also serves as a block boundary around tool output, so allow reuse.
      output.removeListener?.("resize", resize);
      listening = false;
    }
  };
}
