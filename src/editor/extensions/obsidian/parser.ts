import type { Text } from "@codemirror/state";
import { stripAssistantBlockIdComment } from "../../../chat/restore";

export type ObsidianReferenceKind = "heading" | "block" | "message";

export type ObsidianReference = {
  label: string;
  detail: string;
  apply: string;
  kind: ObsidianReferenceKind;
  line: number;
  pos: number;
};

export type ObsidianTag = {
  label: string;
  line: number;
  pos: number;
};

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const BLOCK_ID_RE = /(?:^|\s)\^([A-Za-z0-9_-]{2,64})(?=\s|$)/g;
const ROLE_RE = /^\s*(system|user|assistant)\s+(.+?)\s*$/;
const TAG_RE = /(^|[\s([{])#([\p{L}\p{N}_/-]+)(?=$|[\s)\]},.;:!?])/gu;

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

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\s+#+\s*$/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

function truncateLabel(text: string): string {
  const clean = stripInlineMarkdown(text).replace(/\s+/g, " ");
  return clean.length > 48 ? `${clean.slice(0, 48)}...` : clean;
}

export function getObsidianReferences(doc: Text): ObsidianReference[] {
  const seen = new Set<string>();
  const refs: ObsidianReference[] = [];

  for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);
    const heading = HEADING_RE.exec(line.text);
    if (heading) {
      const label = stripInlineMarkdown(heading[2] || "");
      const key = `heading:${label}`;
      if (label && !seen.has(key)) {
        seen.add(key);
        refs.push({
          label,
          detail: `H${heading[1].length} · line ${lineNo}`,
          apply: `[[${label}]]`,
          kind: "heading",
          line: lineNo,
          pos: line.from
        });
      }
    }

    const role = ROLE_RE.exec(line.text);
    if (role) {
      const body = role[1] === "assistant" ? stripAssistantBlockIdComment(role[2]) : role[2];
      const label = truncateLabel(`${role[1]}: ${body}`);
      const key = `message:${label}`;
      if (label.length > role[1].length + 3 && !seen.has(key)) {
        seen.add(key);
        refs.push({
          label,
          detail: `${role[1]} · line ${lineNo}`,
          apply: `[[${label}]]`,
          kind: "message",
          line: lineNo,
          pos: line.from
        });
      }
    }

    BLOCK_ID_RE.lastIndex = 0;
    let block: RegExpExecArray | null;
    while ((block = BLOCK_ID_RE.exec(line.text)) !== null) {
      const id = block[1];
      const key = `block:${id}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({
          label: id,
          detail: `block · line ${lineNo}`,
          apply: `[[${id}]]`,
          kind: "block",
          line: lineNo,
          pos: line.from + block.index + block[0].lastIndexOf("^")
        });
      }
    }
  }

  return refs;
}

export function getObsidianTags(doc: Text): ObsidianTag[] {
  const seen = new Set<string>();
  const tags: ObsidianTag[] = [];
  let inFence = false;

  for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
    const line = doc.line(lineNo);
    const wasInFence = inFence;
    if (isFenceLine(line.text)) {
      inFence = !inFence;
      continue;
    }
    if (wasInFence || /^\s{0,3}#{1,6}\s/.test(line.text)) continue;

    TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TAG_RE.exec(line.text)) !== null) {
      const tagStart = match.index + match[1].length;
      if (isInsideInlineCode(line.text, tagStart)) continue;
      const label = `#${match[2]}`;
      if (seen.has(label)) continue;
      seen.add(label);
      tags.push({
        label,
        line: lineNo,
        pos: line.from + tagStart
      });
    }
  }

  return tags;
}

export function findObsidianReferenceTarget(doc: Text, rawTarget: string): number | null {
  const target = rawTarget
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "")
    .split("|")
    .shift()
    ?.trim()
    .replace(/^#/, "")
    .replace(/^\^/, "");

  if (!target) return null;

  const refs = getObsidianReferences(doc);
  const exact = refs.find(ref => ref.label === target);
  if (exact) return exact.pos;

  const lower = target.toLowerCase();
  const fuzzy = refs.find(ref => ref.label.toLowerCase() === lower);
  return fuzzy?.pos ?? null;
}

export function findBiographyEventReference(rawTarget: string): string | null {
  const target = String(rawTarget || "")
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "")
    .split("|")
    .shift()
    ?.trim() || "";
  const match = target.match(/^memory:([^\s|]+)$/i);
  return match?.[1] || null;
}
