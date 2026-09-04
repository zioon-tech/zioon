import * as Y from "yjs";
import {
  continuationBoundaryText
} from "../../src/chat/session-document-format.js";

export const SESSION_DOCUMENT_PROJECTOR_ID =
  "dev.session-manager.chat-document";
export const SESSION_DOCUMENT_TEXT_KEY = "content";

function assistantBlockHeader(runId) {
  const id = String(runId || "")
    .replace(/-->/g, "")
    .replace(/\s+/g, "_");
  return id ? `assistant <!-- zion-assistant:id=${id} --> ` : "";
}

function decodeBase64(value) {
  if (typeof globalThis.Buffer?.from === "function") {
    return new Uint8Array(globalThis.Buffer.from(value, "base64"));
  }
  if (typeof globalThis.atob === "function") {
    return Uint8Array.from(
      globalThis.atob(value),
      (character) => character.charCodeAt(0)
    );
  }
  throw new Error("Base64 decoding is unavailable");
}

export function projectAssistantOutputText(documentText, {
  runId,
  output
} = {}) {
  const header = assistantBlockHeader(runId);
  const answer = String(output || "");
  if (!header || !answer) return String(documentText || "");
  const source = String(documentText || "").replace(/\r/g, "");
  const range = assistantBlockRange(source, runId);
  if (!range?.exists) {
    const separator = source && !source.endsWith("\n") ? "\n" : "";
    return `${source}${separator}${header}${answer}`;
  }
  const current = source.slice(range.answerStart, range.answerEnd);
  if (current === answer) return source;
  return source.slice(0, range.answerStart)
    + (current ? answer : `${range.answerPrefix || ""}${answer}`)
    + source.slice(range.answerEnd);
}

function lineRanges(source) {
  const value = String(source || "");
  const lines = value.split("\n");
  let offset = 0;
  return lines.map((line, index) => {
    const start = offset;
    const end = start + line.length;
    offset = end + (index < lines.length - 1 ? 1 : 0);
    return { line, start, end, next: offset };
  });
}

function assistantBlockRange(source, runId) {
  const header = assistantBlockHeader(runId);
  if (!header) return null;
  const value = String(source || "");
  const ranges = lineRanges(value);
  const startIndex = ranges.findIndex((range) =>
    range.line.startsWith(header)
  );
  if (startIndex < 0) {
    return {
      exists: false,
      header,
      insertAt: value.length
    };
  }
  let endIndex = startIndex + 1;
  while (
    endIndex < ranges.length
    && !/^(system|user|assistant|tool)\s+/.test(ranges[endIndex].line)
  ) {
    endIndex += 1;
  }
  const blockEnd = endIndex < ranges.length
    ? ranges[endIndex].start
    : value.length;
  const answerEnd = blockEnd > 0 && value.charAt(blockEnd - 1) === "\n"
    ? blockEnd - 1
    : blockEnd;
  const headerAnswerStart = ranges[startIndex].start + header.length;
  let answerStart = headerAnswerStart;
  let answerPrefix = "";
  if (!ranges[startIndex].line.slice(header.length)) {
    let answerLineIndex = startIndex + 1;
    while (
      answerLineIndex < endIndex
      && /<!--\s*zion-(?:thinking|tool):id=/.test(ranges[answerLineIndex].line)
    ) {
      answerLineIndex += 1;
    }
    answerStart = answerLineIndex < endIndex
      ? ranges[answerLineIndex].start
      : answerLineIndex > startIndex + 1
        ? answerEnd
        : headerAnswerStart;
    if (
      answerLineIndex >= endIndex
      && answerLineIndex > startIndex + 1
    ) {
      answerPrefix = "\n";
    }
  }
  return {
    exists: true,
    header,
    blockStart: ranges[startIndex].start,
    blockEnd,
    answerStart,
    answerEnd,
    answerPrefix
  };
}

function continuationInsertion(source, boundary, runId) {
  if (boundary >= source.length) return "";
  const suffix = source.slice(boundary);
  if (/^(?:\n)*(?:system|user|assistant|tool)\s+/.test(suffix)) return "";
  const marker = continuationBoundaryText(runId);
  if (!marker) return "";
  return `\n${marker}${source.charAt(boundary) === "\n" ? "" : "\n"}`;
}

function resolveRunAnchor(document, ytext, anchor = {}) {
  const encoded = String(anchor?.encoded || "");
  if (encoded && encoded.length <= 16_384) {
    try {
      const relative = Y.decodeRelativePosition(
        decodeBase64(encoded)
      );
      const absolute = Y.createAbsolutePositionFromRelativePosition(
        relative,
        document
      );
      if (absolute?.type === ytext) return absolute.index;
    } catch {}
  }

  const source = ytext.toString();
  const fallback = anchor?.fallback || {};
  const offset = Number(fallback.offset);
  if (!Number.isFinite(offset) || offset < 0 || offset > source.length) {
    return null;
  }
  const before = String(fallback.before || "");
  const after = String(fallback.after || "");
  if (
    source.slice(Math.max(0, offset - before.length), offset) !== before
    || source.slice(offset, offset + after.length) !== after
  ) {
    return null;
  }
  return offset;
}

export function prepareRunInYText(ytext, {
  runId,
  userContent,
  insertAt
} = {}) {
  const header = assistantBlockHeader(runId);
  const content = String(userContent || "");
  if (!header || !content.trim()) return false;
  const source = ytext.toString();
  const assistant = assistantBlockRange(source, runId);
  const boundary = assistant?.exists
    ? assistant.blockStart
    : insertAt != null && Number.isFinite(Number(insertAt))
      ? Math.max(0, Math.min(source.length, Number(insertAt)))
      : source.length;

  const ranges = lineRanges(source);
  let lastRoleIndex = -1;
  let lastRoleMatch = null;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    if (ranges[index].start >= boundary) continue;
    const match = ranges[index].line.match(/^(system|user|assistant|tool)\s+/);
    if (!match) continue;
    lastRoleIndex = index;
    lastRoleMatch = match;
    break;
  }

  const beforeBoundary = source.slice(0, boundary);
  const continuation = continuationInsertion(source, boundary, runId);
  if (
    lastRoleIndex < 0
    && beforeBoundary.trim()
    && beforeBoundary.trim() === content.trim()
  ) {
    if (assistant?.exists) return false;
    const separator = beforeBoundary.endsWith("\n") ? "" : "\n";
    ytext.insert(boundary, `${separator}${header}${continuation}`);
    return true;
  }

  if (lastRoleIndex >= 0 && lastRoleMatch?.[1] === "user") {
    const contentStart = ranges[lastRoleIndex].start + lastRoleMatch[0].length;
    const existingContent = source.slice(contentStart, boundary);
    if (!existingContent.trim()) {
      if (boundary > contentStart) {
        ytext.delete(contentStart, boundary - contentStart);
      }
      ytext.insert(
        contentStart,
        assistant?.exists
          ? `${content}\n`
          : `${content}\n${header}${continuation}`
      );
      return true;
    }
    if (existingContent.trim() === content.trim()) {
      if (assistant?.exists) return false;
      const separator = beforeBoundary.endsWith("\n") ? "" : "\n";
      ytext.insert(boundary, `${separator}${header}${continuation}`);
      return true;
    }
  }

  const separator = beforeBoundary && !beforeBoundary.endsWith("\n")
    ? "\n"
    : "";
  const insertion = assistant?.exists
    ? `${separator}user ${content}\n`
    : `${separator}user ${content}\n${header}${continuation}`;
  ytext.insert(boundary, insertion);
  return true;
}

export function applyAssistantOutputToYText(ytext, {
  runId,
  output
} = {}) {
  const text = String(output || "");
  const source = ytext.toString();
  const range = assistantBlockRange(source, runId);
  if (!range) return false;
  if (!range.exists) {
    const separator = source && !source.endsWith("\n") ? "\n" : "";
    const insert = `${separator}${range.header}${text}`;
    if (!insert) return false;
    ytext.insert(source.length, insert);
    return true;
  }
  if (!text) return false;
  const current = source.slice(range.answerStart, range.answerEnd);
  if (current === text) return false;
  if (text.startsWith(current)) {
    const delta = text.slice(current.length);
    if (!delta) return false;
    ytext.insert(
      range.answerEnd,
      current ? delta : `${range.answerPrefix || ""}${delta}`
    );
    return true;
  }
  if (range.answerEnd > range.answerStart) {
    ytext.delete(range.answerStart, range.answerEnd - range.answerStart);
  }
  ytext.insert(
    range.answerStart,
    `${range.answerPrefix || ""}${text}`
  );
  return true;
}

export function createSessionDocumentProjector() {
  return Object.freeze({
    id: SESSION_DOCUMENT_PROJECTOR_ID,
    textKey: SESSION_DOCUMENT_TEXT_KEY,
    prepareRun({
      document,
      runId,
      userContent,
      documentAnchor
    } = {}) {
      const ytext = document.getText(SESSION_DOCUMENT_TEXT_KEY);
      return prepareRunInYText(ytext, {
        runId,
        userContent,
        insertAt: resolveRunAnchor(document, ytext, documentAnchor)
      });
    },
    projectRun({
      document,
      runId,
      output
    } = {}) {
      const ytext = document.getText(SESSION_DOCUMENT_TEXT_KEY);
      return applyAssistantOutputToYText(ytext, {
        runId,
        output
      });
    }
  });
}
