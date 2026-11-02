const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const BLOCK_ID_RE = /(?:^|\s)\^([A-Za-z0-9_-]{2,64})(?=\s|$)/g;
const WIKI_LINK_RE = /\[\[([^\]\n]{1,120})\]\]/g;
const TAG_RE = /(^|[\s([{])#([\p{L}\p{N}_/-]+)(?=$|[\s)\]},.;:!?])/gu;

function isFenceLine(lineText) {
  return /^\s*`{3,}/.test(lineText) || /^\s*~{3,}/.test(lineText);
}

function isEscapedAt(text, index) {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) count += 1;
  return count % 2 === 1;
}

function isInsideInlineCode(text, pos) {
  let inCode = false;
  for (let i = 0; i < pos; i += 1) {
    if (text[i] === "`" && !isEscapedAt(text, i)) inCode = !inCode;
  }
  return inCode;
}

function stripInlineMarkdown(text) {
  return String(text || "")
    .replace(/\s+#+\s*$/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

function normalizeWikiTarget(text) {
  return String(text || "")
    .split("|")
    .shift()
    .trim()
    .replace(/^#/, "")
    .replace(/^\^/, "");
}

function addUnique(out, seen, key, item) {
  if (!key || seen.has(key)) return;
  seen.add(key);
  out.push(item);
}

export function extractObsidianMetadata(text) {
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  const tags = [];
  const headings = [];
  const anchors = [];
  const wikiLinks = [];
  const seenTags = new Set();
  const seenHeadings = new Set();
  const seenAnchors = new Set();
  const seenWikiLinks = new Set();
  let offset = 0;
    let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    const lineNo = i + 1;
      const wasInFence = inFence;
      const fence = isFenceLine(line);
      if (fence) inFence = !inFence;
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const label = stripInlineMarkdown(heading[2] || "");
      addUnique(headings, seenHeadings, label, {
        label,
        level: heading[1].length,
        line: lineNo,
        pos: offset
      });
    }

      if (!wasInFence && !fence && !/^\s{0,3}#{1,6}\s/.test(line)) {
      TAG_RE.lastIndex = 0;
      let tagMatch;
      while ((tagMatch = TAG_RE.exec(line)) !== null) {
          const tagStart = tagMatch.index + tagMatch[1].length;
          if (isInsideInlineCode(line, tagStart)) continue;
        const label = `#${tagMatch[2]}`;
        addUnique(tags, seenTags, label, {
          label,
          line: lineNo,
            pos: offset + tagStart
        });
      }
    }

    BLOCK_ID_RE.lastIndex = 0;
    let blockMatch;
    while ((blockMatch = BLOCK_ID_RE.exec(line)) !== null) {
      const label = blockMatch[1];
      addUnique(anchors, seenAnchors, label, {
        label,
        line: lineNo,
        pos: offset + blockMatch.index + blockMatch[0].lastIndexOf("^")
      });
    }

    WIKI_LINK_RE.lastIndex = 0;
    let linkMatch;
    while ((linkMatch = WIKI_LINK_RE.exec(line)) !== null) {
      const raw = linkMatch[1] || "";
      const target = normalizeWikiTarget(raw);
      const label = raw.includes("|") ? raw.split("|").pop().trim() : target;
      addUnique(wikiLinks, seenWikiLinks, target, {
        label: label || target,
        target,
        raw,
        line: lineNo,
        pos: offset + linkMatch.index
      });
    }

    offset += line.length + 1;
  }

  return { tags, headings, anchors, wikiLinks };
}

export function findObsidianTargetPosition(text, rawTarget) {
  const target = normalizeWikiTarget(rawTarget);
  if (!target) return null;
  const metadata = extractObsidianMetadata(text);
  const lower = target.toLowerCase();
  const candidates = [...metadata.headings, ...metadata.anchors];
  const exact = candidates.find((item) => item.label === target);
  if (exact) return exact.pos;
  const fuzzy = candidates.find((item) => String(item.label || "").toLowerCase() === lower);
  return typeof fuzzy?.pos === "number" ? fuzzy.pos : null;
}
