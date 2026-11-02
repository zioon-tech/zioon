import type { Text } from "@codemirror/state";

export type ImageDisplayKind = "inline" | "solo" | "gallery";

export type MarkdownImage = {
  alt: string;
  src: string;
  markdown: string;
  from: number;
  to: number;
  lineFrom: number;
  lineTo: number;
  lineNumber: number;
};

export type MarkdownImageGroup = {
  from: number;
  to: number;
  items: MarkdownImage[];
};

export const STANDALONE_IMAGE_RE = /^\s*!\[([^\]]*)\]\(([^)\n]+)\)\s*$/;

export function parseStandaloneImageLine(
  text: string,
  lineFrom = 0,
  lineNumber = 1
): MarkdownImage | null {
  const match = STANDALONE_IMAGE_RE.exec(text);
  if (!match) return null;
  const markdown = match[0].trim();
  const leadingWhitespace = match[0].indexOf(markdown);
  const from = lineFrom + Math.max(0, leadingWhitespace);
  return {
    alt: match[1] || "",
    src: match[2] || "",
    markdown,
    from,
    to: from + markdown.length,
    lineFrom,
    lineTo: lineFrom + text.length,
    lineNumber
  };
}

export function collectStandaloneImageGroups(
  doc: Text,
  exclude?: (from: number, to: number) => boolean
): MarkdownImageGroup[] {
  const images: MarkdownImage[] = [];
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber++) {
    const line = doc.line(lineNumber);
    if (exclude?.(line.from, line.to)) continue;
    const image = parseStandaloneImageLine(line.text, line.from, lineNumber);
    if (image) images.push(image);
  }

  const groups: MarkdownImageGroup[] = [];
  let current: MarkdownImage[] = [];
  for (const image of images) {
    const previous = current[current.length - 1];
    if (previous && image.lineNumber === previous.lineNumber + 1) {
      current.push(image);
      continue;
    }
    if (current.length) {
      groups.push({
        from: current[0].lineFrom,
        to: current[current.length - 1].lineTo,
        items: current
      });
    }
    current = [image];
  }
  if (current.length) {
    groups.push({
      from: current[0].lineFrom,
      to: current[current.length - 1].lineTo,
      items: current
    });
  }
  return groups;
}

export function getImageInsertTarget(
  doc: Text,
  rawPosition: number,
  imageCount = 1
): { position: number; kind: ImageDisplayKind } {
  const position = Math.max(0, Math.min(rawPosition, doc.length));
  const line = doc.lineAt(position);
  const standalone = parseStandaloneImageLine(line.text, line.from, line.number);
  const previousStandalone = line.number > 1
    ? parseStandaloneImageLine(doc.line(line.number - 1).text)
    : null;
  const nextStandalone = line.number < doc.lines
    ? parseStandaloneImageLine(doc.line(line.number + 1).text)
    : null;

  if (imageCount > 1) {
    return { position: line.text.trim() ? line.to : position, kind: "gallery" };
  }
  if (standalone) return { position: line.to, kind: "gallery" };
  if (!line.text.trim()) {
    return {
      position,
      kind: previousStandalone || nextStandalone ? "gallery" : "solo"
    };
  }
  if (position > line.from && position < line.to) {
    return { position, kind: "inline" };
  }
  return { position, kind: "solo" };
}

export function formatImageInsertion(
  doc: Text,
  from: number,
  to: number,
  markdown: string,
  kind: ImageDisplayKind
): string {
  if (kind === "inline") return markdown;
  const before = from > 0 ? doc.sliceString(from - 1, from) : "";
  const after = to < doc.length ? doc.sliceString(to, to + 1) : "";
  const prefix = from > 0 && before !== "\n" ? "\n" : "";
  const suffix = to < doc.length && after !== "\n" ? "\n" : "";
  return `${prefix}${markdown}${suffix}`;
}
