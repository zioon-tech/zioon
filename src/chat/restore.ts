export type RestoreAnchor = {
  from: number;
  to: number;
  occupied?: boolean;
  [key: string]: any;
};

export type RestoreItem = {
  id?: string | null;
  from?: number | null;
  to?: number | null;
  [key: string]: any;
};

const ROLE_HEADER_RE = /^(system|user|assistant|tool)\s+/;
const ASSISTANT_ID_COMMENT_RE = /^\s*assistant\s+<!--\s*zion-assistant:id=([^>\s]+)\s*-->/;
const LEADING_ASSISTANT_ID_COMMENT_RE = /^\s*<!--\s*zion-assistant:id=[^>\s]+\s*-->\s*/;
const CARD_ID_COMMENT_RE = /\s*<!--\s*zion-(?:thinking|tool):id=[^>\s]+\s*-->\s*$/;
const CARD_MARKER_RE = /^(?:思考(?:\s*<!--\s*zion-thinking:id=[^>\s]+\s*-->)?|调用 [^\n<]{1,300}(?:\s*<!--\s*zion-tool:id=[^>\s]+\s*-->)?)$/;
const CARD_MARKER_TAIL_RE = /(?:^|\n)(?:思考(?:\s*<!--\s*zion-thinking:id=[^>\s]+\s*-->)?|调用 [^\n<]{1,300}(?:\s*<!--\s*zion-tool:id=[^>\s]+\s*-->)?)\n+$/;

export function sanitizeCardMarkerId(id: string | null | undefined): string {
  return String(id || "").replace(/-->/g, "").replace(/[\r\n\t ]+/g, "_").trim();
}

export function assistantBlockHeaderText(id: string | null | undefined): string {
  const safeId = sanitizeCardMarkerId(id);
  return safeId ? `assistant <!-- zion-assistant:id=${safeId} --> ` : "assistant ";
}

export function getAssistantBlockIdFromHeader(text: string): string | null {
  const line = String(text || "");
  const match = line.match(ASSISTANT_ID_COMMENT_RE);
  return match?.[1] ? String(match[1]) : null;
}

export function stripAssistantBlockIdComment(text: string): string {
  return String(text || "").replace(LEADING_ASSISTANT_ID_COMMENT_RE, "");
}

export function thinkingMarkerText(id: string | null | undefined): string {
  const safeId = sanitizeCardMarkerId(id);
  return safeId ? `思考 <!-- zion-thinking:id=${safeId} -->` : "思考";
}

export function toolMarkerText(name: string | null | undefined, id: string | null | undefined): string {
  const safeId = sanitizeCardMarkerId(id);
  const safeName = String(name || "tool").trim() || "tool";
  return safeId ? `调用 ${safeName} <!-- zion-tool:id=${safeId} -->` : `调用 ${safeName}`;
}

export function stripCardMarkerIdComment(text: string): string {
  return String(text || "").replace(CARD_ID_COMMENT_RE, "").trim();
}

function splitLines(text: string) {
  return String(text || "").replace(/\r/g, "").split("\n");
}

function findLineIndexAtPos(lines: string[], pos: number) {
  const target = Math.max(0, Number.isFinite(pos) ? pos : 0);
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = cursor + lines[i].length;
    if (target <= lineEnd) return i;
    cursor = lineEnd + 1;
  }
  return Math.max(0, lines.length - 1);
}

function lineEndOffset(lines: string[], lineIndex: number) {
  let cursor = 0;
  for (let i = 0; i < lineIndex; i++) cursor += lines[i].length + 1;
  return cursor + (lines[lineIndex]?.length || 0);
}

function findAssistantHeadIndexFromLine(lines: string[], hintLine?: number | null): number {
  if (typeof hintLine !== "number" || !Number.isFinite(hintLine)) return -1;
  const start = Math.max(0, Math.min(lines.length - 1, Math.floor(hintLine)));
  for (let i = start; i < lines.length; i++) {
    const match = lines[i].match(ROLE_HEADER_RE);
    if (match && match[1] === "assistant") return i;
    if (match) break;
  }
  for (let i = start - 1; i >= 0; i--) {
    const match = lines[i].match(ROLE_HEADER_RE);
    if (match && match[1] === "assistant") return i;
    if (match) break;
  }
  return -1;
}

function findAssistantHeadIndexById(lines: string[], assistantBlockId: string | null | undefined): number {
  const expectedId = sanitizeCardMarkerId(assistantBlockId);
  if (!expectedId) return -1;
  let foundIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (getAssistantBlockIdFromHeader(lines[i]) !== expectedId) continue;
    if (foundIndex >= 0) return -1;
    foundIndex = i;
  }
  return foundIndex;
}

function findAssistantBlockEndOffsetFromHead(lines: string[], headIdx: number): number | null {
  if (headIdx < 0 || headIdx >= lines.length) return null;
  let endIdx = headIdx;
  for (let i = headIdx + 1; i < lines.length; i++) {
    if (ROLE_HEADER_RE.test(lines[i])) break;
    endIdx = i;
  }
  return lineEndOffset(lines, endIdx);
}

export function findAssistantBlockEndOffsetById(
  docText: string,
  assistantBlockId: string | null | undefined
): number | null {
  const text = String(docText || "").replace(/\r/g, "");
  const lines = splitLines(text);
  return findAssistantBlockEndOffsetFromHead(lines, findAssistantHeadIndexById(lines, assistantBlockId));
}

export function findAssistantBlockIdAtOffset(
  docText: string,
  offset: number | null | undefined
): string | null {
  const text = String(docText || "").replace(/\r/g, "");
  const lines = splitLines(text);
  if (!lines.length) return null;
  const lineIndex = findLineIndexAtPos(lines, Number(offset || 0));
  for (let i = lineIndex; i >= 0; i--) {
    const match = lines[i].match(ROLE_HEADER_RE);
    if (!match) continue;
    if (match[1] !== "assistant") return null;
    const id = getAssistantBlockIdFromHeader(lines[i]);
    if (!id) return null;
    let occurrences = 0;
    for (const line of lines) {
      if (getAssistantBlockIdFromHeader(line) === id) occurrences += 1;
      if (occurrences > 1) return null;
    }
    return id;
  }
  return null;
}

export function findAssistantBlockEndOffset(docText: string, hintPos?: number | null): number {
  const text = String(docText || "").replace(/\r/g, "");
  const lines = splitLines(text);
  if (!lines.length) return 0;
  const hintLine = typeof hintPos === "number" ? findLineIndexAtPos(lines, hintPos) : (lines.length - 1);
  let headIdx = -1;
  for (let i = hintLine; i >= 0; i--) {
    const match = lines[i].match(ROLE_HEADER_RE);
    if (match && match[1] === "assistant") {
      headIdx = i;
      break;
    }
  }
  if (headIdx < 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = lines[i].match(ROLE_HEADER_RE);
      if (match && match[1] === "assistant") {
        headIdx = i;
        break;
      }
    }
  }
  if (headIdx < 0) return text.length;
  return findAssistantBlockEndOffsetFromHead(lines, headIdx) ?? text.length;
}

export function findAssistantBlockEndOffsetByLine(docText: string, hintLine?: number | null, fallbackHintPos?: number | null): number {
  const text = String(docText || "").replace(/\r/g, "");
  const lines = splitLines(text);
  if (!lines.length) return 0;
  const headIdx = findAssistantHeadIndexFromLine(lines, hintLine);
  if (headIdx < 0) return findAssistantBlockEndOffset(text, fallbackHintPos);
  return findAssistantBlockEndOffsetFromHead(lines, headIdx) ?? text.length;
}

function buildAssistantMarkerInsertionPlan(args: {
  docText: string;
  markerText: string;
  insertPos: number;
  trailingNewlines?: number;
}) {
  const docText = String(args.docText || "").replace(/\r/g, "");
  const markerText = String(args.markerText || "");
  const trailingNewlines = Math.max(0, Number(args.trailingNewlines ?? 1));
  const insertPos = Math.max(0, Math.min(docText.length, args.insertPos));
  let replaceFrom = insertPos;
  let replaceTo = insertPos;
  let prefix = "";
  const beforeInsert = docText.slice(0, insertPos);

  // Consecutive card markers should render as adjacent rows, not separated by a blank line.
  // Collapse "思考\n\n调用 xxx" to "思考\n调用 xxx" while streaming.
  const shouldCollapseCardGap = CARD_MARKER_RE.test(markerText);
  const cardTail = shouldCollapseCardGap ? beforeInsert.match(CARD_MARKER_TAIL_RE) : null;
  if (cardTail) {
    const trailingBreaks = cardTail[0].match(/\n+$/)?.[0] || "";
    replaceFrom = insertPos - trailingBreaks.length;
    replaceTo = insertPos;
    prefix = "\n";
  } else {
    const prevChar = insertPos > 0 ? docText.slice(insertPos - 1, insertPos) : "";
    prefix = prevChar === "\n" || insertPos === 0 ? "" : "\n";
  }
  const suffix = "\n".repeat(trailingNewlines);
  const insertText = `${prefix}${markerText}${suffix}`;
  const markerFrom = replaceFrom + prefix.length;
  const markerTo = markerFrom + markerText.length;
  return {
    insertPos,
    replaceFrom,
    replaceTo,
    insertText,
    markerFrom,
    markerTo
  };
}

export function planAssistantMarkerInsertion(args: {
  docText: string;
  markerText: string;
  hintPos?: number | null;
  hintLine?: number | null;
  trailingNewlines?: number;
}) {
  const docText = String(args?.docText || "").replace(/\r/g, "");
  const insertPos = typeof args?.hintLine === "number" && Number.isFinite(args.hintLine)
    ? findAssistantBlockEndOffsetByLine(docText, args.hintLine, args?.hintPos)
    : findAssistantBlockEndOffset(docText, args?.hintPos);
  return buildAssistantMarkerInsertionPlan({
    docText,
    markerText: args?.markerText,
    insertPos,
    trailingNewlines: args?.trailingNewlines
  });
}

export function planAssistantMarkerInsertionById(args: {
  docText: string;
  assistantBlockId: string | null | undefined;
  markerText: string;
  trailingNewlines?: number;
}) {
  const docText = String(args?.docText || "").replace(/\r/g, "");
  const insertPos = findAssistantBlockEndOffsetById(docText, args?.assistantBlockId);
  if (insertPos == null) return null;
  return buildAssistantMarkerInsertionPlan({
    docText,
    markerText: args?.markerText,
    insertPos,
    trailingNewlines: args?.trailingNewlines
  });
}

export function buildRegexAnchors<T extends RestoreAnchor = RestoreAnchor>(
  docText: string,
  regex: RegExp,
  mapMatch: (match: RegExpExecArray) => T | null | undefined
): T[] {
  const text = String(docText || "");
  const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  const anchors: T[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const next = mapMatch(match);
    if (next) anchors.push({ occupied: false, ...next });
  }
  return anchors;
}

export function filterDeletedItems<T extends RestoreItem>(items: T[], deletedIds: Iterable<string>): T[] {
  const deleted = new Set(Array.from(deletedIds || []).map((id) => String(id)));
  return (Array.isArray(items) ? items : []).filter((item) => !deleted.has(String(item?.id || "")));
}

export function mergeItemsFromAnchors<T extends RestoreItem, A extends RestoreAnchor>(args: {
  items?: T[] | null;
  anchors?: A[] | null;
  deletedIds?: Iterable<string> | null;
  createItem: (anchor: A) => T | null | undefined;
}): { items: T[]; synthesized: T[] } {
  const items = Array.isArray(args.items) ? args.items.slice() : [];
  const known = new Set(items.map((item) => String(item?.id || "")).filter(Boolean));
  const deleted = new Set(Array.from(args.deletedIds || []).map((id) => String(id)));
  const synthesized: T[] = [];
  for (const anchor of Array.isArray(args.anchors) ? args.anchors : []) {
    const next = args.createItem(anchor);
    if (next == null) continue;
    const id = String(next.id || "");
    if (!id || known.has(id) || deleted.has(id)) continue;
    items.push(next);
    known.add(id);
    synthesized.push(next);
  }
  return { items, synthesized };
}

export function reconcileMountedItems<T extends RestoreItem, M = any>(args: {
  items: T[];
  existingItems?: Map<string, M> | null;
  canUseMounted?: (item: T, mounted: M) => boolean;
  onMounted: (item: T, mounted: M) => void;
}): Set<string> {
  const processedIds = new Set<string>();
  const items = Array.isArray(args.items) ? args.items : [];
  const existingItems = args.existingItems || new Map<string, M>();
  for (const item of items) {
    const id = String(item?.id || "");
    if (!id) continue;
    const mounted = existingItems.get(id);
    if (!mounted) continue;
    if (args.canUseMounted && !args.canUseMounted(item, mounted)) continue;
    processedIds.add(id);
    args.onMounted(item, mounted);
  }
  return processedIds;
}

export function reconcileExactAnchors<T extends RestoreItem, A extends RestoreAnchor>(args: {
  items: T[];
  processedIds?: Set<string>;
  anchors: A[];
  isExactMatch: (item: T, anchor: A) => boolean;
  onMatch: (item: T, anchor: A) => void;
}): Set<string> {
  const processedIds = args.processedIds || new Set<string>();
  const items = Array.isArray(args.items) ? args.items : [];
  const anchors = Array.isArray(args.anchors) ? args.anchors : [];
  for (const item of items) {
    const id = String(item?.id || "");
    if (!id || processedIds.has(id)) continue;
    const anchor = anchors.find((candidate) => !candidate.occupied && args.isExactMatch(item, candidate));
    if (!anchor) continue;
    anchor.occupied = true;
    processedIds.add(id);
    args.onMatch(item, anchor);
  }
  return processedIds;
}

export function reconcileNearestAnchors<T extends RestoreItem, A extends RestoreAnchor>(args: {
  items: T[];
  processedIds?: Set<string>;
  anchors: A[];
  canUseAnchor?: (item: T, anchor: A) => boolean;
  distance?: (item: T, anchor: A) => number;
  onMatch: (item: T, anchor: A) => void;
}): Set<string> {
  const processedIds = args.processedIds || new Set<string>();
  const items = Array.isArray(args.items) ? args.items : [];
  const anchors = Array.isArray(args.anchors) ? args.anchors : [];
  const canUseAnchor = typeof args.canUseAnchor === "function" ? args.canUseAnchor : () => true;
  const distance = typeof args.distance === "function"
    ? args.distance
    : (item: T, anchor: A) => Math.abs(anchor.from - Number(item?.from || 0));
  for (const item of items) {
    const id = String(item?.id || "");
    if (!id || processedIds.has(id)) continue;
    let bestAnchor: A | null = null;
    let minDistance = Infinity;
    for (const anchor of anchors) {
      if (anchor.occupied) continue;
      if (!canUseAnchor(item, anchor)) continue;
      const dist = distance(item, anchor);
      if (dist < minDistance) {
        minDistance = dist;
        bestAnchor = anchor;
      }
    }
    if (!bestAnchor) continue;
    bestAnchor.occupied = true;
    processedIds.add(id);
    args.onMatch(item, bestAnchor);
  }
  return processedIds;
}
