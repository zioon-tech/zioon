// Shared "widget history" reconstruction.
//
// The chat document only stores lightweight stub lines for thinking/tool cards
// (e.g. `思考 <!-- zion-thinking:id=... -->`, `调用 read <!-- zion-tool:id=... -->`).
// `parseMessages` strips those stubs, so the real reasoning text and tool
// call/result payloads live separately in the session annotations
// (`zion.chatCards`). Before sending history to the LLM we re-inject that
// content into the proper OpenAI-style shape:
//   - thinking  -> assistant.reasoning_content (preserved models) or a plain
//                  `{ role: "assistant", content }` message
//   - tool      -> `{ role: "assistant", tool_calls: [...] }` immediately
//                  followed by `{ role: "tool", tool_call_id, content }`
//
// The main editor and the comments extension share this logic so the two
// context builders never drift apart.

const THINKING_STUB_RE = /^(思考|Thinking)\s*<!--\s*zion-thinking:id=[^>\s]+\s*-->\s*$/i;
const TOOL_STUB_RE = /^(?:调用|Call)\s+[^\n<]+(?:\s*<!--\s*zion-tool:id=[^>\s]+\s*-->)?\s*$/i;

export const DEFAULT_REASONING_CONTENT_PLACEHOLDER = "[reasoning omitted]";

export type WidgetAnchor = { from: number; to: number; name?: string };
export type WidgetAnchorIndex = { tools: Map<string, WidgetAnchor>; thinking: Map<string, WidgetAnchor> };

export type WidgetHistoryAnnotations = {
  tools?: Array<Record<string, unknown>>;
  thinking?: Array<Record<string, unknown>>;
  deletedToolIds?: unknown[];
  deletedThinkingIds?: unknown[];
};

export type WidgetHistoryOptions = {
  includeToolHistory?: boolean;
  includeThinkingHistory?: boolean;
  preservedThinking?: boolean;
  forceReasoning?: boolean;
  reasoningPlaceholder?: string;
};

type RoleRange = { role: string; from: number; to: number; hasContent: boolean };
type Unit = { pos: number; kind: "tool" | "thinking"; data: any };

// Recover each stub's character position from the doc text, so annotation
// items (which may carry a stale `from`) can be re-anchored to the current doc.
export function buildChatWidgetAnchorIndex(text: string): WidgetAnchorIndex {
  const tools = new Map<string, WidgetAnchor>();
  const thinking = new Map<string, WidgetAnchor>();
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  let pos = 0;
  for (const line of lines) {
    const toolMatch = line.match(/(?:调用|Call)\s+([^\n<]+?)\s*<!--\s*zion-tool:id=([^>\s]+)\s*-->/i);
    if (toolMatch) {
      const startInLine = Math.max(0, toolMatch.index || 0);
      const id = String(toolMatch[2] || "");
      if (id) {
        tools.set(id, {
          from: pos + startInLine,
          to: pos + startInLine + toolMatch[0].length,
          name: String(toolMatch[1] || "").trim()
        });
      }
    }
    const thinkingMatch = line.match(/(?:思考|Thinking)\s*<!--\s*zion-thinking:id=([^>\s]+)\s*-->/i);
    if (thinkingMatch) {
      const startInLine = Math.max(0, thinkingMatch.index || 0);
      const id = String(thinkingMatch[1] || "");
      if (id) {
        thinking.set(id, {
          from: pos + startInLine,
          to: pos + startInLine + thinkingMatch[0].length
        });
      }
    }
    pos += line.length + 1;
  }
  return { tools, thinking };
}

export function resolveChatWidgetPosition<T extends Record<string, unknown>>(
  item: T,
  anchorMap: Map<string, WidgetAnchor>
): T {
  const id = String((item as any)?.id || "");
  const anchor = id ? anchorMap?.get?.(id) : null;
  const from = typeof anchor?.from === "number"
    ? anchor.from
    : (typeof (item as any)?.from === "number" ? (item as any).from : null);
  const to = typeof anchor?.to === "number"
    ? anchor.to
    : (typeof (item as any)?.to === "number" ? (item as any).to : null);
  if (from == null) return item;
  return { ...item, from, ...(to == null ? {} : { to }) } as T;
}

function stripLeadingOmitted(value: unknown): string {
  const raw = String(value || "");
  const trimmedStart = raw.replace(/^\s+/, "");
  const lower = trimmedStart.toLowerCase();
  const candidates = ["[reasoning omitted]", "reasoning_omitted", "reasoning omitted", "[reasoning_omitted]"];
  for (const c of candidates) {
    if (lower.startsWith(c)) return trimmedStart.slice(c.length).replace(/^\s+/, "");
  }
  return raw;
}

// Locate the role ranges within `text`, skipping widget stub lines, so we can
// map an annotation position back to the assistant block it belongs to.
function buildRoleRanges(text: string): RoleRange[] {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const ranges: RoleRange[] = [];
  let pos = 0;
  let startPos = 0;
  let currentRole = "user";
  let hasContent = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (THINKING_STUB_RE.test(trimmed) || TOOL_STUB_RE.test(trimmed)) {
      pos += line.length + 1;
      continue;
    }
    const m = line.match(/^(system|user|assistant)\s+(.*)$/);
    if (m) {
      const body = m[2].trim();
      if (THINKING_STUB_RE.test(body) || TOOL_STUB_RE.test(body)) {
        pos += line.length + 1;
        continue;
      }
      if (pos > startPos) ranges.push({ role: currentRole, from: startPos, to: pos, hasContent });
      currentRole = m[1];
      startPos = pos;
      hasContent = !!m[2].trim();
      pos += line.length + 1;
      continue;
    }
    hasContent = true;
    pos += line.length + 1;
  }
  if (pos > startPos) ranges.push({ role: currentRole, from: startPos, to: pos, hasContent });
  return ranges;
}

function buildAssistantTextSegments(text: string, range: RoleRange, units: Unit[]): string[] {
  if (!units.length) return [];
  const sortedUnits = units.slice().sort((a, b) => (a.pos || 0) - (b.pos || 0));
  const segments: string[] = [];
  let unitIndex = 0;
  let textLines: string[] = [];
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  let pos = 0;

  const flush = () => {
    const content = textLines.join("\n").trim();
    segments.push(content);
    textLines = [];
  };

  for (const line of lines) {
    const lineFrom = pos;
    const lineTo = pos + line.length;
    const nextPos = lineTo + 1;
    pos = nextPos;
    if (nextPos <= range.from) continue;
    if (lineFrom >= range.to) break;

    const trimmed = line.trim();
    const roleMatch = line.match(/^(system|user|assistant)\s+(.*)$/);
    const lineIsWidget = THINKING_STUB_RE.test(trimmed)
      || TOOL_STUB_RE.test(trimmed)
      || (!!roleMatch && (THINKING_STUB_RE.test(roleMatch[2].trim()) || TOOL_STUB_RE.test(roleMatch[2].trim())));

    if (lineIsWidget) {
      while (unitIndex < sortedUnits.length && sortedUnits[unitIndex].pos >= lineFrom && sortedUnits[unitIndex].pos < nextPos) {
        flush();
        unitIndex += 1;
      }
      continue;
    }

    if (roleMatch) {
      if (roleMatch[1] !== "assistant") continue;
      const body = roleMatch[2];
      if (body.trim()) textLines.push(body);
      continue;
    }

    textLines.push(line);
  }

  while (unitIndex < sortedUnits.length) {
    flush();
    unitIndex += 1;
  }
  flush();
  return segments;
}

function assistantTextMessage(base: any, content: string, opts: { includeReasoning?: boolean } = {}): any | null {
  const text = String(content || "").trim();
  if (!text) return null;
  const msg = { ...(base || {}), role: "assistant", content: text };
  delete (msg as any).tool_calls;
  delete (msg as any).tool_call_id;
  if (opts.includeReasoning === false) delete (msg as any).reasoning_content;
  return msg;
}

function widgetMessagesForUnit(unit: Unit, options: {
  forceReasoning: boolean;
  reasoningPlaceholder: string;
  includeThinkingMessage?: boolean;
}): any[] {
  if (unit.kind === "thinking") {
    if (options.includeThinkingMessage === false) return [];
    return [{ role: "assistant", content: unit.data.content }];
  }
  const tc = {
    id: unit.data.id,
    type: "function",
    function: { name: unit.data.name, arguments: JSON.stringify(unit.data.args || {}) }
  };
  const aMsg: any = { role: "assistant", tool_calls: [tc] };
  if (options.forceReasoning) aMsg.reasoning_content = options.reasoningPlaceholder;
  return [
    aMsg,
    { role: "tool", tool_call_id: unit.data.id, content: unit.data.result }
  ];
}

/**
 * Re-inject persisted thinking/tool annotations into a parsed message list.
 *
 * Contract: `messages` must contain assistant messages that correspond, in
 * order, to the assistant role-ranges found in `docText` (i.e. the messages are
 * the result of parsing `docText`, optionally with non-assistant messages
 * prepended). Returns a new array; the input is not mutated.
 */
export function reconstructWidgetHistoryMessages(
  messages: any[],
  docText: string,
  annotations: WidgetHistoryAnnotations | null | undefined,
  options: WidgetHistoryOptions = {}
): any[] {
  if (!Array.isArray(messages)) return messages;
  const includeToolHistory = options.includeToolHistory !== false;
  const includeThinkingHistory = options.includeThinkingHistory !== false;
  if (!includeToolHistory && !includeThinkingHistory) return messages;

  const ann = annotations || {};
  const preservedThinking = !!options.preservedThinking;
  const forceReasoning = !!options.forceReasoning;
  const reasoningPlaceholder = options.reasoningPlaceholder || DEFAULT_REASONING_CONTENT_PLACEHOLDER;

  const limitPos = String(docText || "").length;
  const widgetAnchors = buildChatWidgetAnchorIndex(docText);

  const itemsToolsRaw = Array.isArray(ann.tools) ? ann.tools : [];
  const deleted = new Set((Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds : []).map(String));
  const itemsTools = itemsToolsRaw
    .map((it) => resolveChatWidgetPosition(it, widgetAnchors.tools))
    .filter((it: any) => it && it.id && !deleted.has(String(it.id)))
    .filter((it: any) => typeof it.from === "number" && it.from >= 0 && it.from < limitPos)
    .filter((it: any) => it.name && it.args && it.result != null)
    .sort((a: any, b: any) => (a.from || 0) - (b.from || 0));

  const itemsThinkingRaw = Array.isArray(ann.thinking) ? ann.thinking : [];
  const deletedThinking = new Set((Array.isArray(ann.deletedThinkingIds) ? ann.deletedThinkingIds : []).map(String));
  const itemsThinking = itemsThinkingRaw
    .map((it) => resolveChatWidgetPosition(it, widgetAnchors.thinking))
    .filter((it: any) => it && it.id && !deletedThinking.has(String(it.id)))
    .filter((it: any) => typeof it.from === "number" && it.from >= 0 && it.from < limitPos)
    .filter((it: any) => typeof it.text === "string" && it.text.trim().length > 0)
    .sort((a: any, b: any) => (a.from || 0) - (b.from || 0));

  if (!itemsTools.length && !itemsThinking.length) return messages;

  const roleRanges = buildRoleRanges(docText);
  const assistantRanges = roleRanges.filter((r) => r.role === "assistant");
  const docMessageRanges = roleRanges.filter((r) => r.hasContent);
  const docMsgIdxs = messages
    .map((_, index) => index)
    .slice(Math.max(0, messages.length - docMessageRanges.length));
  const rangeMsgIdx = new Map<RoleRange, number>();
  docMessageRanges.forEach((range, index) => {
    const msgIdx = docMsgIdxs[index];
    if (typeof msgIdx === "number") rangeMsgIdx.set(range, msgIdx);
  });

  const findPreviousDocMessageIndex = (range: RoleRange): number | null => {
    let found: number | null = null;
    for (const candidate of docMessageRanges) {
      if (candidate.to > range.from) break;
      const idx = rangeMsgIdx.get(candidate);
      if (typeof idx === "number") found = idx;
    }
    return found;
  };

  const findNextDocMessageIndex = (range: RoleRange): number | null => {
    for (const candidate of docMessageRanges) {
      if (candidate.from < range.to) continue;
      const idx = rangeMsgIdx.get(candidate);
      if (typeof idx === "number") return idx;
    }
    return null;
  };

  const findAssistantIndexForPos = (p: number): number => {
    for (let i = 0; i < assistantRanges.length; i++) {
      const r = assistantRanges[i];
      if (p >= r.from && p < r.to) return i;
    }
    let fallback = -1;
    for (let i = 0; i < assistantRanges.length; i++) {
      if (assistantRanges[i].to <= p) fallback = i;
    }
    return fallback;
  };

  const groups = new Map<number, Unit[]>();

  if (includeToolHistory) {
    for (const it of itemsTools as any[]) {
      const idx = findAssistantIndexForPos(it.from);
      if (idx < 0) continue;
      const arr = groups.get(idx) || [];
      arr.push({ pos: it.from, kind: "tool", data: { id: it.id, name: it.name, args: it.args, result: String(it.result) } });
      groups.set(idx, arr);
    }
  }
  if (includeThinkingHistory) {
    for (const it of itemsThinking as any[]) {
      const idx = findAssistantIndexForPos(it.from);
      if (idx < 0) continue;
      const arr = groups.get(idx) || [];
      arr.push({ pos: it.from, kind: "thinking", data: { content: String(it.text || "") } });
      groups.set(idx, arr);
    }
  }

  if (groups.size === 0) return messages;

  const msgs = messages.slice();
  const sortedIdxs = Array.from(groups.keys()).sort((a, b) => a - b);
  let offset = 0;
  for (const rangeIndex of sortedIdxs) {
    const range = assistantRanges[rangeIndex] || null;
    if (!range) continue;
    const originalMsgIdx = rangeMsgIdx.get(range);
    const idx = typeof originalMsgIdx === "number" ? originalMsgIdx + offset : -1;
    const units = (groups.get(rangeIndex) || []).slice().sort((a, b) => (a.pos || 0) - (b.pos || 0));
    let base = idx >= 0 ? msgs[idx] : { role: "assistant", content: "" };
    if (preservedThinking) {
      for (const unit of units) {
        if (unit.kind === "thinking") {
          if (base && base.role === "assistant") {
            const prev = stripLeadingOmitted(typeof base.reasoning_content === "string" ? base.reasoning_content : "");
            const next = String(unit.data.content || "");
            base = { ...base, reasoning_content: prev ? `${prev}\n\n${next}` : next };
            if (idx >= 0) msgs[idx] = base;
          }
        }
      }
    }

    const segments = range ? buildAssistantTextSegments(docText, range, units) : [];
    if (range && segments.length === units.length + 1) {
      const replacement: any[] = [];
      let usedReasoning = false;
      const first = assistantTextMessage(base, segments[0], { includeReasoning: !usedReasoning });
      if (first) replacement.push(first);
      if (first && typeof first.reasoning_content === "string") usedReasoning = true;
      for (let i = 0; i < units.length; i += 1) {
        replacement.push(...widgetMessagesForUnit(units[i], {
          forceReasoning,
          reasoningPlaceholder,
          includeThinkingMessage: !preservedThinking
        }));
        const textMsg = assistantTextMessage(base, segments[i + 1], { includeReasoning: !usedReasoning });
        if (textMsg) replacement.push(textMsg);
        if (textMsg && typeof textMsg.reasoning_content === "string") usedReasoning = true;
      }
      if (idx >= 0) {
        msgs.splice(idx, 1, ...replacement);
        offset += replacement.length - 1;
      } else {
        const prevIdx = findPreviousDocMessageIndex(range);
        const nextIdx = findNextDocMessageIndex(range);
        const insertAt = (typeof prevIdx === "number"
          ? prevIdx + 1
          : (typeof nextIdx === "number" ? nextIdx : messages.length)) + offset;
        msgs.splice(insertAt, 0, ...replacement);
        offset += replacement.length;
      }
      continue;
    }

    let localInserted = 0;
    const fallbackInsertAt = idx >= 0
      ? null
      : ((typeof findPreviousDocMessageIndex(range) === "number"
        ? findPreviousDocMessageIndex(range)! + 1
        : (findNextDocMessageIndex(range) ?? messages.length)) + offset);
    for (const unit of units) {
      const insert = widgetMessagesForUnit(unit, {
        forceReasoning,
        reasoningPlaceholder,
        includeThinkingMessage: !preservedThinking
      });
      if (!insert.length) continue;
      const insertAt = idx >= 0
        ? idx + 1 + localInserted
        : (fallbackInsertAt ?? messages.length) + localInserted;
      msgs.splice(insertAt, 0, ...insert);
      localInserted += insert.length;
      offset += insert.length;
    }
  }
  return msgs;
}
