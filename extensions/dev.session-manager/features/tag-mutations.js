// Pure document tag mutations: occurrence scanning and text rewrites for
// rename / delete operations. Inline Obsidian-style tags only (same rules as
// extensions/shared/obsidian-metadata.js: skip fences, inline code, headings).

const TAG_RE = /(^|[\s([{])#([\p{L}\p{N}_/-]+)(?=$|[\s)\]},.;:!?])/gu;

function isFenceLine(lineText) {
  return /^\s*`{3,}/.test(lineText) || /^\s*~{3,}/.test(lineText);
}

function isEscapedAt(text, index) {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) count += 1;
  return count % 2 === 1;
}

function isInsideInlineCode(line, pos) {
  let inCode = false;
  for (let i = 0; i < pos; i += 1) {
    if (line[i] === "`" && !isEscapedAt(line, i)) inCode = !inCode;
  }
  return inCode;
}

function normalizePath(raw) {
  const trimmed = String(raw || "").replace(/^#/, "").trim();
  return trimmed || null;
}

// Returns every inline tag occurrence with absolute ranges, newest first is
// NOT guaranteed — order follows document order. No dedupe: a tag appearing
// twice yields two occurrences.
export function findTagOccurrences(text) {
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  const occurrences = [];
  let offset = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    const wasInFence = inFence;
    const fence = isFenceLine(line);
    if (fence) inFence = !inFence;
    if (!wasInFence && !fence && !/^\s{0,3}#{1,6}\s/.test(line)) {
      TAG_RE.lastIndex = 0;
      let match;
      while ((match = TAG_RE.exec(line)) !== null) {
        const start = match.index + match[1].length;
        if (isInsideInlineCode(line, start)) continue;
        occurrences.push({
          start: offset + start,
          end: offset + start + match[0].length - match[1].length,
          label: `#${match[2]}`,
          path: match[2]
        });
      }
    }
    offset += line.length + 1;
  }
  return occurrences;
}

function occurrenceMatches(occurrence, path) {
  const target = normalizePath(path);
  if (!target) return false;
  return occurrence.path === target || occurrence.path.startsWith(`${target}/`);
}

// renames: [{ from, to }] — occurrences matching `from` (or descendants)
// become `to`-rooted tags. removals: [path] — matching occurrences deleted.
export function rewriteDocTags(text, { renames = [], removals = [] } = {}) {
  const source = String(text || "");
  const occurrences = findTagOccurrences(source);
  const edits = [];
  for (const occurrence of occurrences) {
    const rename = renames.find((item) => occurrenceMatches(occurrence, item.from));
    if (rename) {
      const to = normalizePath(rename.to);
      if (!to) continue;
      const replacement = `#${to}${occurrence.path.slice(normalizePath(rename.from).length)}`;
      if (replacement !== occurrence.label) {
        edits.push({ start: occurrence.start, end: occurrence.end, text: replacement });
      }
      continue;
    }
    if (removals.some((path) => occurrenceMatches(occurrence, path))) {
      // Swallow one adjacent space (prefer trailing) so we do not leave
      // double spaces or dangling " #tag" prefixes behind.
      let { start, end } = occurrence;
      if (source[end] === " ") end += 1;
      else if (start > 0 && source[start - 1] === " " && source[start - 2] !== " ") start -= 1;
      edits.push({ start, end, text: "" });
    }
  }
  if (!edits.length) return { text: source, changed: false, edits: 0 };
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    out += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  out += source.slice(cursor);
  return { text: out, changed: true, edits: edits.length };
}

// docs: [{ id, text }] — impact preview for confirm dialogs.
export function previewTagImpact(docs, path) {
  const target = normalizePath(path);
  const affected = [];
  let occurrences = 0;
  for (const doc of Array.isArray(docs) ? docs : []) {
    const id = String(doc?.id || "");
    const text = String(doc?.text || "");
    if (!id) continue;
    const count = findTagOccurrences(text).filter((occurrence) => occurrenceMatches(occurrence, target)).length;
    if (count > 0) {
      affected.push(id);
      occurrences += count;
    }
  }
  return { sessions: affected, occurrences };
}
