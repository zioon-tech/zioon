import type { BlockContext, Element, Line, MarkdownConfig } from "@lezer/markdown";

const ROLE_HEAD_RE = /^\s*(system|user|assistant|tool)\s+/;

function findFenceEnd(line: Line): number {
  if (line.next !== 96 && line.next !== 126) return -1;
  let pos = line.pos + 1;
  while (pos < line.text.length && line.text.charCodeAt(pos) === line.next) pos++;
  if (pos < line.pos + 3) return -1;
  if (line.next === 96) {
    for (let index = pos; index < line.text.length; index++) {
      if (line.text.charCodeAt(index) === 96) return -1;
    }
  }
  return pos;
}

function skipSpaceBack(text: string, from: number, to: number): number {
  while (from > to && /\s/.test(text[from - 1] || "")) from--;
  return from;
}

function addLineMarkers(target: Element[], line: Line): void {
  const markers = (line as any).markers;
  if (Array.isArray(markers)) target.push(...markers);
}

export const roleScopedFencedCode: MarkdownConfig = {
  remove: ["FencedCode"],
  parseBlock: [
    {
      name: "RoleBoundary",
      before: "LinkReference",
      endLeaf(_cx, line) {
        return ROLE_HEAD_RE.test(line.text);
      }
    },
    {
      name: "RoleScopedFencedCode",
      before: "Blockquote",
      endLeaf(_cx, line) {
        return findFenceEnd(line) >= 0;
      },
      parse(cx: BlockContext, line: Line) {
        const fenceEnd = findFenceEnd(line);
        if (fenceEnd < 0) return false;

        const from = cx.lineStart + line.pos;
        const fenceChar = line.next;
        const fenceLength = fenceEnd - line.pos;
        const infoFrom = line.skipSpace(fenceEnd);
        const infoTo = skipSpaceBack(line.text, line.text.length, infoFrom);
        const children: Element[] = [
          cx.elt("CodeMark", from, from + fenceLength)
        ];
        if (infoFrom < infoTo) {
          children.push(cx.elt("CodeInfo", cx.lineStart + infoFrom, cx.lineStart + infoTo));
        }

        let blockEnd = cx.lineStart + line.text.length;
        for (
          let first = true;
          cx.nextLine() && (line as any).depth >= (cx as any).stack.length;
          first = false
        ) {
          if (ROLE_HEAD_RE.test(line.text)) {
            blockEnd = cx.prevLineEnd();
            break;
          }

          let pos = line.pos;
          if (line.indent - line.baseIndent < 4) {
            while (pos < line.text.length && line.text.charCodeAt(pos) === fenceChar) pos++;
          }
          if (pos - line.pos >= fenceLength && line.skipSpace(pos) === line.text.length) {
            addLineMarkers(children, line);
            children.push(cx.elt("CodeMark", cx.lineStart + line.pos, cx.lineStart + pos));
            cx.nextLine();
            blockEnd = cx.prevLineEnd();
            break;
          }

          if (!first) {
            children.push(cx.elt("CodeText", cx.lineStart - 1, cx.lineStart));
          }
          addLineMarkers(children, line);
          const textFrom = cx.lineStart + line.basePos;
          const textTo = cx.lineStart + line.text.length;
          if (textFrom < textTo) children.push(cx.elt("CodeText", textFrom, textTo));
          blockEnd = textTo;
        }

        cx.addElement(cx.elt("FencedCode", from, Math.max(from, blockEnd), children));
        return true;
      }
    }
  ]
};
