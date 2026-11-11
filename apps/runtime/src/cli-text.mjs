import { stripVTControlCharacters } from "node:util";

export function safeText(value) {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

let segmenter;
export const graphemes = (text) => Array.from(
  (segmenter ||= new Intl.Segmenter(undefined, { granularity: "grapheme" })).segment(text),
  (item) => item.segment
);
export function graphemeWidth(ch) {
  const n = ch.codePointAt(0);
  if (ch === "\n" || /^\p{Mark}+$/u.test(ch)) return 0;
  return /\p{Emoji_Presentation}|\p{Regional_Indicator}|\ufe0f|\u20e3/u.test(ch)
    || n >= 0x1100 && (n <= 0x115f || n === 0x2329 || n === 0x232a
      || n >= 0x2e80 && n <= 0xa4cf || n >= 0xac00 && n <= 0xd7a3
      || n >= 0xf900 && n <= 0xfaff || n >= 0xfe10 && n <= 0xfe6f
      || n >= 0xff01 && n <= 0xff60 || n >= 0xffe0 && n <= 0xffe6
      || n >= 0x20000 && n <= 0x3fffd) ? 2 : 1;
}
export function cellWidth(text) {
  return graphemes(safeText(text)).reduce((width, ch) => width + graphemeWidth(ch), 0);
}
export function truncate(text, columns) {
  let result = "", width = 0;
  for (const ch of graphemes(safeText(text).replace(/\n/g, " "))) {
    const next = graphemeWidth(ch);
    if (width + next > columns) return result;
    result += ch; width += next;
  }
  return result;
}
