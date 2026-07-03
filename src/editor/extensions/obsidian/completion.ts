import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { getObsidianReferences, getObsidianTags } from "./parser";

const TAG_RE = /(^|[\s([{])#([\p{L}\p{N}_/-]+)(?=$|[\s)\]},.;:!?])/gu;

type TagOption = {
  label: string;
  detail: string;
  type: "keyword";
  apply: string;
};

const sessionTagCache = new Map<string, { signature: string; tags: string[] }>();

function isFenceLine(lineText: string): boolean {
  return /^\s*`{3,}/.test(lineText) || /^\s*~{3,}/.test(lineText);
}

function isEscapedAt(text: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) count++;
  return count % 2 === 1;
}

function isInsideInlineCode(text: string, pos: number): boolean {
  let inCode = false;
  for (let i = 0; i < pos; i++) {
    if (text[i] === "`" && !isEscapedAt(text, i)) inCode = !inCode;
  }
  return inCode;
}

function isLineInsideFence(doc: CompletionContext["state"]["doc"], targetLine: number): boolean {
  let inFence = false;
  for (let lineNo = 1; lineNo <= targetLine; lineNo++) {
    const text = doc.line(lineNo).text;
    const wasInFence = inFence;
    if (isFenceLine(text)) {
      if (lineNo === targetLine) return true;
      inFence = !inFence;
      continue;
    }
    if (lineNo === targetLine) return wasInFence;
  }
  return false;
}

function hashText(text: string): string {
  let h = 2166136261;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${s.length}:${h >>> 0}`;
}

function extractTagsFromText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let inFence = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const wasInFence = inFence;
    if (isFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (wasInFence || /^\s{0,3}#{1,6}\s/.test(line)) continue;
    TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TAG_RE.exec(line)) !== null) {
      const tagStart = match.index + match[1].length;
      if (isInsideInlineCode(line, tagStart)) continue;
      const label = `#${match[2]}`;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

function getGlobalSessionTags(): string[] {
  const zion = (window as any)?.zion;
  const sessions = (() => {
    try {
      const raw = zion?.state?.get?.("sessions.catalog");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  })();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const session of sessions) {
    const id = String(session?.id || "").trim();
    if (!id) continue;
    let doc = "";
    try {
      doc = String(zion?.commands?.executeCommand?.("zion.sessions.getDoc", id) || "");
    } catch {
      doc = "";
    }
    const signature = hashText(doc);
    const cached = sessionTagCache.get(id);
    const tags = cached?.signature === signature ? cached.tags : extractTagsFromText(doc);
    if (cached?.signature !== signature) sessionTagCache.set(id, { signature, tags });
    for (const tag of tags) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export function completeObsidianWikiLinks(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/\[\[[^\]\n]{0,80}$/);
  if (!before) return null;
  if (!context.explicit && before.text.length < 2) return null;

  const rawQuery = before.text.slice(2).trim();
  const query = rawQuery.toLowerCase();
  const options = getObsidianReferences(context.state.doc)
    .filter(ref => !query || ref.label.toLowerCase().includes(query))
    .slice(0, 30)
    .map(ref => ({
      label: ref.label,
      detail: ref.detail,
      type: ref.kind === "heading" ? "section" : ref.kind === "block" ? "constant" : "text",
      apply: `${ref.label}]]`
    }));

  if (!options.length) {
    const label = rawQuery || "关键约束";
    options.push(
      {
        label: `新建引用：${label}`,
        detail: "wiki link",
        type: "text",
        apply: `${label}]]`
      },
      {
        label: "关键约束",
        detail: "常用引用",
        type: "text",
        apply: "关键约束]]"
      },
      {
        label: "上次方案",
        detail: "常用引用",
        type: "text",
        apply: "上次方案]]"
      }
    );
  }

  return {
    from: before.from + 2,
    options,
    validFor: /^[^\]\n]{0,80}$/
  };
}

export function completeObsidianTags(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = context.matchBefore(/(?:^|[\s([{])#[\p{L}\p{N}_/-]*$/u);
  if (!before) return null;
  if (/^\s{0,3}#{1,6}\s/.test(line.text)) return null;
  if (isLineInsideFence(context.state.doc, line.number)) return null;

  const prefixOffset = before.text.lastIndexOf("#");
  if (prefixOffset < 0) return null;

  const from = before.from + prefixOffset;
  const query = before.text.slice(prefixOffset + 1).toLowerCase();
  const localTags = getObsidianTags(context.state.doc);
  const seen = new Set<string>();
  const options: TagOption[] = [];
  for (const tag of localTags) {
    if (query && !tag.label.slice(1).toLowerCase().startsWith(query)) continue;
    seen.add(tag.label);
    options.push({
      label: tag.label,
      detail: `当前对话 · line ${tag.line}`,
      type: "keyword",
      apply: tag.label
    });
  }
  for (const label of getGlobalSessionTags()) {
    if (seen.has(label)) continue;
    if (query && !label.slice(1).toLowerCase().startsWith(query)) continue;
    seen.add(label);
    options.push({
      label,
      detail: "已有标签",
      type: "keyword",
      apply: label
    });
    if (options.length >= 50) break;
  }

  if (!options.length && !context.explicit) return null;

  return {
    from,
    options: options.length ? options : [
      {
        label: "#todo",
        detail: "tag",
        type: "keyword",
        apply: "#todo"
      },
      {
        label: "#结论",
        detail: "tag",
        type: "keyword",
        apply: "#结论"
      },
      {
        label: "#待确认",
        detail: "tag",
        type: "keyword",
        apply: "#待确认"
      }
    ],
    validFor: /^#[\p{L}\p{N}_/-]*$/u
  };
}
