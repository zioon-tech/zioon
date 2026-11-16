import * as Y from "yjs";
import {
  continuationBoundaryText,
  appendUserMessageText,
  conversationLineRanges
} from "../../src/chat/session-document-format.js";

export const SESSION_DOCUMENT_PROJECTOR_ID =
  "dev.session-manager.chat-document";
export const SESSION_DOCUMENT_TEXT_KEY = "content";
export const SESSION_DOCUMENT_CARDS_KEY = "cards";
export const SESSION_DOCUMENT_RUN_PROJECTION_KEY = "runProjection";

function assistantBlockHeader(runId) {
  const id = String(runId || "")
    .replace(/-->/g, "")
    .replace(/\s+/g, "_");
  return id ? `assistant <!-- zion-assistant:id=${id} --> ` : "";
}

const CARD_MARKER_LINE_RE = /<!--\s*zion-(?:thinking|tool):id=/;

function markdownBlockPrefix(text) {
  const firstLine = String(text || "").split("\n", 1)[0];
  return /^\s{0,3}(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|\x60{3}|~~~|(?:[-*_]\s*){3,}$|\|)/.test(firstLine)
    ? "\n"
    : "";
}

function hasInterleavedCardContent(source, range) {
  const body = source.slice(range.headerAnswerStart, range.answerEnd);
  if (!CARD_MARKER_LINE_RE.test(body)) return false;
  return body.split("\n").some((line) =>
    line.trim() && !CARD_MARKER_LINE_RE.test(line)
  );
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
    return source + separator + header + markdownBlockPrefix(answer) + answer;
  }
  const current = source.slice(range.answerStart, range.answerEnd);
  if (current === answer) return source;
  if (hasInterleavedCardContent(source, range)) return source;
  return source.slice(0, range.answerStart)
    + (current ? answer : (range.answerPrefix || markdownBlockPrefix(answer)) + answer)
    + source.slice(range.answerEnd);
}

export function appendAssistantTokenToYText(ytext, {
  runId,
  token
} = {}) {
  const text = String(token || "");
  if (!text) return false;
  const source = ytext.toString();
  const range = assistantBlockRange(source, runId);
  if (!range) return false;
  if (!range.exists) {
    const separator = source && !source.endsWith("\n") ? "\n" : "";
    ytext.insert(
      source.length,
      separator + range.header + markdownBlockPrefix(text) + text
    );
    return true;
  }

  const current = source.slice(range.answerStart, range.answerEnd);
  let insertAt = range.answerEnd;
  let insert = text;
  if (!current) {
    insert = (range.answerPrefix || markdownBlockPrefix(text)) + text;
  } else if (CARD_MARKER_LINE_RE.test(current.slice(current.lastIndexOf("\n") + 1))) {
    insert = "\n" + text;
  } else if (
    range.answerStart === range.headerAnswerStart
    && markdownBlockPrefix(current + text)
  ) {
    ytext.insert(range.headerAnswerStart, "\n");
    insertAt += 1;
  }
  ytext.insert(insertAt, insert);
  return true;
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
  const ranges = conversationLineRanges(value);
  const startIndex = ranges.findIndex((range) =>
    !range.literal && range.line.startsWith(header)
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
    && (ranges[endIndex].literal || !/^(system|user|assistant|tool)\s+/.test(ranges[endIndex].line))
  ) {
    endIndex += 1;
  }
  const blockEnd = endIndex < ranges.length
    ? ranges[endIndex].start
    : value.length;
  const answerEnd = endIndex < ranges.length
    && blockEnd > 0 && value.charAt(blockEnd - 1) === "\n"
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
    headerAnswerStart,
    answerStart,
    answerEnd,
    answerPrefix
  };
}

export function findUserPromptAfterAssistantBlock(documentText, runId) {
  const source = String(documentText || "");
  const range = assistantBlockRange(source, runId);
  if (!range?.exists) return null;
  const prompt = source.slice(range.blockEnd).match(/^user[ \t]*(?=\n|$)/);
  return prompt ? range.blockEnd + prompt[0].length : null;
}

function markerSafeId(value) {
  return String(value || "")
    .replace(/-->/g, "")
    .replace(/[\r\n\t ]+/g, "_")
    .trim();
}

function toolCardId(runId, callId) {
  const rid = String(runId || "").trim();
  const cid = String(callId || "").trim();
  if (!cid) return "";
  return rid
    ? `tool:${encodeURIComponent(rid)}:${encodeURIComponent(cid)}`
    : cid;
}

function reasoningCardId(runId, event, projection) {
  const segment = String(
    event?.data?.reasoningSegmentId
    || event?.data?.turn
    || event?.data?.stepIndex
    || ""
  ).trim();
  if (segment) return `thinking:${markerSafeId(runId)}:${markerSafeId(segment)}`;
  return `thinking:${markerSafeId(runId)}:${
    Math.max(1, Number(projection.reasoningCount || 0) + 1)
  }`;
}

function appendCardMarkerToYText(ytext, {
  runId,
  markerId,
  kind,
  name
} = {}) {
  const safeId = markerSafeId(markerId);
  if (!safeId) return false;
  let source = ytext.toString();
  const markerComment = `<!-- zion-${kind}:id=${safeId} -->`;
  if (source.includes(markerComment)) return false;

  let range = assistantBlockRange(source, runId);
  if (!range?.exists) {
    const separator = source && !source.endsWith("\n") ? "\n" : "";
    ytext.insert(source.length, separator + assistantBlockHeader(runId));
    source = ytext.toString();
    range = assistantBlockRange(source, runId);
  }
  if (!range?.exists) return false;

  const marker = kind === "tool"
    ? `调用 ${String(name || "tool").trim() || "tool"} ${markerComment}`
    : `思考 ${markerComment}`;
  ytext.insert(range.answerEnd, `\n${marker}`);
  return true;
}

function setDocumentCard(document, id, patch) {
  if (!id) return false;
  const cards = document.getMap(SESSION_DOCUMENT_CARDS_KEY);
  const previous = cards.get(id);
  const current = previous && typeof previous === "object" ? previous : {};
  const next = { ...current, ...patch, id };
  if (JSON.stringify(current) === JSON.stringify(next)) return false;
  cards.set(id, next);
  return true;
}

function projectionStatus(eventType, current) {
  if (eventType === "run.completed") return "completed";
  if (eventType === "run.failed") return "failed";
  if (eventType === "run.aborted") return "aborted";
  if (eventType === "run.waiting") return "waiting";
  return current || "running";
}

export function projectRunEventsToYDocument(document, {
  runId,
  events = [],
  includeReasoning = true
} = {}) {
  const id = String(runId || "");
  if (!id || !Array.isArray(events) || !events.length) return false;
  const ytext = document.getText(SESSION_DOCUMENT_TEXT_KEY);
  const projections = document.getMap(
    SESSION_DOCUMENT_RUN_PROJECTION_KEY
  );
  let projection = projections.get(id);
  projection = projection && typeof projection === "object"
    ? { ...projection }
    : {
        schemaVersion: 1,
        runId: id,
        lastSequence: 0,
        status: "running",
        turnCharacters: {},
        reasoningIds: {},
        reasoningCount: 0
      };
  projection.turnCharacters = {
    ...(projection.turnCharacters || {})
  };
  projection.reasoningIds = {
    ...(projection.reasoningIds || {})
  };
  let finalRange;
  let finalBody = String(projection.projectedBody || "");
  let modelOutput = String(projection.projectedModelOutput || "");
  const finalMode = projection.mode === "final";
  const snapshotMode = finalMode || projection.mode === "live";
  const terminal = events.some(event =>
    ["run.completed", "run.failed", "run.aborted", "run.waiting"].includes(event.type));
  if (projection.detached) return false;
  if (!snapshotMode && typeof projection.projectedBlock === "string") {
    const source = ytext.toString();
    const range = assistantBlockRange(source, id);
    if (!range?.exists || source.slice(range.blockStart, range.answerEnd) !== projection.projectedBlock) {
      projections.set(id, { ...projection, detached: true, status: "detached" });
      return false;
    }
  }
  if (snapshotMode) {
    if (projection.committed && projection.status !== "waiting") return false;
    if (finalMode && !terminal) return false;
    if (projection.pendingAnchor) {
      prepareSnapshotRun(document, { runId: id, documentAnchor: projection.pendingAnchor, mode: projection.mode });
      projection = { ...projections.get(id) };
    }
    const source = ytext.toString();
    const range = assistantBlockRange(source, id);
    finalRange = range;
    const matches = conversationLineRanges(source).filter(line =>
      !line.literal && line.line.startsWith(assistantBlockHeader(id)));
    if ((!projection.pendingAnchor || terminal) && (!range?.exists || matches.length !== 1
      || source.slice(range.blockStart, range.answerEnd) !== projection.projectedBlock)) {
      projections.set(id, { ...projection, detached: true, status: "detached" });
      return false;
    }
  }
  const appendOutput = (token) => {
    if (!snapshotMode) return appendAssistantTokenToYText(ytext, { runId: id, token });
    finalBody += token;
    modelOutput += token;
    return !!token;
  };
  const appendMarker = ({ markerId, kind, name }) => {
    if (!snapshotMode) return appendCardMarkerToYText(ytext, { runId: id, markerId, kind, name });
    const marker = `<!-- zion-${kind}:id=${markerSafeId(markerId)} -->`;
    if (finalBody.includes(marker)) return false;
    const separator = finalBody.endsWith("\n") ? "" : "\n";
    finalBody += `${separator}${kind === "tool" ? `调用 ${name || "tool"}` : "思考"} ${marker}\n`;
    return true;
  };
  let changed = false;

  for (const event of events) {
    if (!event || String(event.runId || id) !== id) continue;
    const sequence = Number(event.sequence) > 0
      ? Number(event.sequence)
      : Number(projection.lastSequence || 0) + 1;
    if (sequence <= Number(projection.lastSequence || 0)) continue;
    const data = event.data && typeof event.data === "object"
      ? event.data
      : {};
    const turnKey = String(data.turn ?? data.stepIndex ?? 0);

    if (event.type === "message.delta") {
      const delta = String(data.delta || "");
      if (delta) {
        changed = appendOutput(delta) || changed;
        projection.turnCharacters[turnKey] =
          Number(projection.turnCharacters[turnKey] || 0) + delta.length;
      }
    } else if (event.type === "message.completed") {
      const content = String(data.content || "");
      if (
        content
        && Number(projection.turnCharacters[turnKey] || 0) === 0
      ) {
        changed = appendOutput(content) || changed;
        projection.turnCharacters[turnKey] = content.length;
      }
    } else if (
      includeReasoning
      && (
        event.type === "reasoning.started"
        || event.type === "reasoning.delta"
        || event.type === "reasoning.completed"
      )
    ) {
      const segmentKey = String(
        data.reasoningSegmentId
        || (turnKey !== "0" ? `${id}:step:${turnKey}` : id)
      );
      let cardId = projection.reasoningIds[segmentKey];
      if (!cardId) {
        cardId = reasoningCardId(id, event, projection);
        projection.reasoningIds[segmentKey] = cardId;
        projection.reasoningCount =
          Math.max(0, Number(projection.reasoningCount || 0)) + 1;
      }
      changed = appendMarker({
        runId: id,
        markerId: cardId,
        kind: "thinking"
      }) || changed;
      const previousCard = document
        .getMap(SESSION_DOCUMENT_CARDS_KEY)
        .get(cardId);
      changed = setDocumentCard(document, cardId, {
        kind: "thinking",
        runId: id,
        segmentKey,
        assistantBlockId: id,
        text: event.type === "reasoning.completed" && typeof data.content === "string"
          ? data.content
          : String(previousCard?.text || "")
            + (event.type === "reasoning.delta" ? String(data.delta || "") : ""),
        requiresDocumentAnchor: false,
        status: event.type === "reasoning.completed"
          ? "completed"
          : "running",
        sequence
      }) || changed;
    } else if (event.type === "tool.requested") {
      const callId = String(data.callId || data.id || "");
      const cardId = toolCardId(id, callId);
      changed = appendMarker({
        runId: id,
        markerId: cardId,
        kind: "tool",
        name: data.name
      }) || changed;
      changed = setDocumentCard(document, cardId, {
        kind: "tool",
        toolCallId: callId,
        runId: id,
        name: String(data.name || "tool"),
        args: data.arguments ?? data.args ?? {},
        result: null,
        ok: null,
        assistantBlockId: id,
        requiresDocumentAnchor: false,
        status: "running",
        sequence
      }) || changed;
    } else if (
      event.type === "tool.completed"
      || event.type === "tool.denied"
    ) {
      const callId = String(data.callId || data.id || "");
      const cardId = toolCardId(id, callId);
      const previousCard = document
        .getMap(SESSION_DOCUMENT_CARDS_KEY)
        .get(cardId);
      if (!previousCard) {
        changed = appendMarker({
          runId: id,
          markerId: cardId,
          kind: "tool",
          name: data.name
        }) || changed;
      }
      changed = setDocumentCard(document, cardId, {
        kind: "tool",
        toolCallId: callId,
        runId: id,
        name: String(data.name || previousCard?.name || "tool"),
        args: data.arguments ?? data.args ?? previousCard?.args ?? {},
        result: data.result ?? data.error ?? data.reason ?? "",
        ok: event.type === "tool.completed"
          && data.ok !== false
          && !data.error,
        artifactIds: Array.isArray(data.artifactIds)
          ? data.artifactIds
          : previousCard?.artifactIds || [],
        assistantBlockId: id,
        requiresDocumentAnchor: false,
        status: event.type === "tool.denied" ? "denied" : "completed",
        sequence
      }) || changed;
    }

    if (snapshotMode && ["run.completed", "run.failed", "run.aborted", "run.waiting"].includes(event.type)
      && typeof data.output === "string" && data.output.startsWith(modelOutput)) {
      appendOutput(data.output.slice(modelOutput.length));
    }
    projection.lastSequence = sequence;
    projection.lastEventType = String(event.type || "");
    projection.status = projectionStatus(event.type, projection.status);
  }

  projections.set(id, projection);
  if (snapshotMode && !projection.pendingAnchor) {
    // Keep unfinished fences from swallowing the untouched suffix. Replace only
    // changed bytes, preserving CodeMirror selections and existing card widgets.
    const hasSuffix = finalRange.blockEnd < ytext.length;
    const closed = hasSuffix ? finalBody + appendUserMessageText(finalBody, "").replace(/user $/, "") : finalBody;
    const rendered = markdownBlockPrefix(closed) + closed.replace(/\n$/, hasSuffix ? "" : "\n");
    replaceProjectedBody(ytext, finalRange.headerAnswerStart, finalRange.answerEnd, rendered);
    // The next input belongs directly after the completed answer. Keep it durable
    // so background completion/reconnect follows the same rule as the open UI.
    if (projection.status === "completed" && projection.appendUserPrompt) {
      const source = ytext.toString();
      const range = assistantBlockRange(source, id);
      if (range?.answerEnd === finalRange.headerAnswerStart + rendered.length) {
        const suffix = source.slice(range.blockEnd);
        const nextRole = conversationLineRanges(suffix).find((line, index) =>
          index > 0 && !line.literal && /^(system|user|assistant|tool)(?:\s|$)/.test(line.line));
        const hasEmptyInput = /^user[ \t]*(?:\n|$)/.test(suffix)
          && !suffix.slice(4, nextRole?.start ?? suffix.length).trim();
        if (!hasEmptyInput) {
          ytext.insert(range.blockEnd,
            appendUserMessageText(source.slice(0, range.blockEnd), "") + (suffix ? "\n" : ""));
          changed = true;
        }
      }
    }
    const source = ytext.toString();
    const range = assistantBlockRange(source, id);
    projections.set(id, {
      ...projection, committed: terminal,
      projectedBody: finalBody,
      projectedModelOutput: modelOutput,
      projectedBlock: range ? source.slice(range.blockStart, range.answerEnd) : "",
      projectedOutput: range ? source.slice(range.answerStart, range.answerEnd) : ""
    });
  } else if (snapshotMode) {
    projections.set(id, { ...projection, projectedBody: finalBody, projectedModelOutput: modelOutput });
  } else {
    const source = ytext.toString();
    const range = assistantBlockRange(source, id);
    if (range?.exists) projections.set(id, {
      ...projection,
      projectedBlock: source.slice(range.blockStart, range.answerEnd),
      projectedOutput: source.slice(range.answerStart, range.answerEnd)
    });
  }
  return changed;
}

function replaceProjectedBody(ytext, from, to, next) {
  const current = ytext.toString().slice(from, to);
  let prefix = 0;
  while (prefix < current.length && prefix < next.length && current[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < current.length - prefix && suffix < next.length - prefix
    && current[current.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  const removed = current.length - prefix - suffix;
  if (removed) ytext.delete(from + prefix, removed);
  const inserted = next.slice(prefix, next.length - suffix);
  if (inserted) ytext.insert(from + prefix, inserted);
}

// Snapshot submission does not reconstruct user text from Runtime history.
// Its only initial mutation is an owned, empty answer at the captured anchor.
function prepareSnapshotRun(document, { runId, documentAnchor, mode = "final", appendUserPrompt = false } = {}) {
  const projections = document.getMap(SESSION_DOCUMENT_RUN_PROJECTION_KEY);
  const previous = projections.get(runId);
  if (previous && (previous.detached || !previous.pendingAnchor)) return false;
  const ytext = document.getText(SESSION_DOCUMENT_TEXT_KEY);
  const offset = resolveRunAnchor(document, ytext, documentAnchor);
  const base = { schemaVersion: 1, runId, lastSequence: 0,
    turnCharacters: {}, reasoningIds: {}, reasoningCount: 0, status: "running",
    appendUserPrompt, ...previous, mode };
  if (offset == null) {
    projections.set(runId, { ...base, pendingAnchor: documentAnchor || {} });
    return false;
  }
  const source = ytext.toString();
  // Close a partially selected code fence so the new role is structural, then
  // restore the fence around the untouched suffix.
  let fence = null;
  for (const line of conversationLineRanges(source.slice(0, offset))) {
    const body = line.line.replace(/^(system|user|assistant|tool)\s+/, "");
    const match = body.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    if (fence && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null;
    else if (!fence) fence = match[1];
  }
  const header = assistantBlockHeader(runId);
  const prefix = `${offset && source[offset - 1] !== "\n" ? "\n" : ""}${fence ? `${fence}\n` : ""}`;
  const suffix = source.slice(offset);
  const continuation = continuationInsertion(source, offset, runId);
  ytext.insert(offset, `${prefix}${header}${continuation}${fence && suffix ? `\n${fence}\n` : ""}`);
  projections.set(runId, { ...base, pendingAnchor: null, projectedBlock: header, projectedOutput: "" });
  return true;
}

function continuationInsertion(source, boundary, runId) {
  if (boundary >= source.length) return "";
  const suffix = source.slice(boundary);
  if (/^(?:system|user|assistant|tool)\s+/.test(suffix)) return "\n";
  if (/^\n(?:system|user|assistant|tool)\s+/.test(suffix)) return "";
  // Preserve extra blank lines in the untouched suffix behind a structural
  // boundary, rather than making them part of the owned assistant placeholder.
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
      if (absolute?.type === ytext) {
        if (anchor.guard) {
          const guard = Y.createAbsolutePositionFromRelativePosition(
            Y.decodeRelativePosition(decodeBase64(anchor.guard)), document
          );
          if (guard?.type !== ytext || absolute.index - guard.index !== 1) return null;
        }
        return absolute.index;
      }
    } catch {}
    // An unresolved relative position belongs to a not-yet-received or deleted
    // CRDT item. An unrelated substring is never an adequate replacement.
    return null;
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
  insertAt,
  forceNewUser = false
} = {}) {
  const header = assistantBlockHeader(runId);
  const content = String(userContent || "");
  if (!header || !content.trim()) return false;
  const source = ytext.toString();
  const assistant = assistantBlockRange(source, runId);
  if (forceNewUser) {
    if (assistant?.exists) return false;
    ytext.insert(source.length, `${appendUserMessageText(source, content)}\n${header}`);
    return true;
  }
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
    const insert = separator + range.header + markdownBlockPrefix(text) + text;
    if (!insert) return false;
    ytext.insert(source.length, insert);
    return true;
  }
  if (!text) return false;
  const current = source.slice(range.answerStart, range.answerEnd);
  if (current === text) return false;
  if (hasInterleavedCardContent(source, range)) return false;
  if (text.startsWith(current)) {
    const delta = text.slice(current.length);
    if (!delta) return false;
    ytext.insert(
      range.answerEnd,
      current ? delta : (range.answerPrefix || markdownBlockPrefix(text)) + delta
    );
    return true;
  }
  if (range.answerEnd > range.answerStart) {
    ytext.delete(range.answerStart, range.answerEnd - range.answerStart);
  }
  ytext.insert(
    range.answerStart,
    (range.answerPrefix || markdownBlockPrefix(text)) + text
  );
  return true;
}

export function reconcileSessionMessagesInYText(ytext, messages = []) {
  const source = Array.isArray(messages) ? messages : [];
  const projections = ytext.doc?.getMap(SESSION_DOCUMENT_RUN_PROJECTION_KEY);
  let changed = false;
  for (const userMessage of source) {
    if (userMessage?.role !== "user" || !userMessage.runId) continue;
    const projection = projections?.get(userMessage.runId);
    const text = ytext.toString();
    const range = assistantBlockRange(text, userMessage.runId);
    // The editable document is a working copy, not the execution ledger.
    // Only repair an output whose last projected bytes are still intact.
    // Legacy documents have no ownership baseline and must be preserved.
    if (!range?.exists || typeof projection?.projectedOutput !== "string"
      || projection.detached === true || ["final", "live"].includes(projection.mode)
      || text.slice(range.answerStart, range.answerEnd) !== projection.projectedOutput) continue;
    const assistantMessage = source.find((message) => (
      message?.role === "assistant"
      && message?.runId === userMessage.runId
    ));
    if (!assistantMessage) continue;
    changed = applyAssistantOutputToYText(ytext, {
      runId: userMessage.runId,
      output: assistantMessage.content
    }) || changed;
    const updated = ytext.toString();
    const updatedRange = assistantBlockRange(updated, userMessage.runId);
    if (updatedRange?.exists) projections.set(userMessage.runId, {
      ...projection,
      projectedOutput: updated.slice(updatedRange.answerStart, updatedRange.answerEnd)
    });
  }
  return changed;
}

export function createSessionDocumentProjector() {
  return Object.freeze({
    id: SESSION_DOCUMENT_PROJECTOR_ID,
    textKey: SESSION_DOCUMENT_TEXT_KEY,
    prepareRun({
      document,
      runId,
      userContent,
      documentAnchor,
      forceNewUser,
      appendUserPrompt,
      mode
    } = {}) {
      if (["final", "live"].includes(mode) && forceNewUser) {
        if (document.getMap(SESSION_DOCUMENT_RUN_PROJECTION_KEY).has(runId)) return false;
        const text = document.getText(SESSION_DOCUMENT_TEXT_KEY);
        text.insert(text.length, appendUserMessageText(text.toString(), String(userContent || "")));
        const source = text.toString();
        documentAnchor = { fallback: { offset: source.length, before: source.slice(-64), after: "" } };
      }
      if (["final", "live"].includes(mode)) return prepareSnapshotRun(document, { runId, documentAnchor, mode, appendUserPrompt });
      const ytext = document.getText(SESSION_DOCUMENT_TEXT_KEY);
      const changed = prepareRunInYText(ytext, {
        runId,
        userContent,
        forceNewUser,
        insertAt: resolveRunAnchor(document, ytext, documentAnchor)
      });
      const projections = document.getMap(SESSION_DOCUMENT_RUN_PROJECTION_KEY);
      const source = ytext.toString();
      const range = assistantBlockRange(source, runId);
      if (changed && range?.exists && !projections.has(runId)) projections.set(runId, {
        runId, lastSequence: 0,
        projectedBlock: source.slice(range.blockStart, range.answerEnd),
        projectedOutput: source.slice(range.answerStart, range.answerEnd)
      });
      return changed;
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
    },
    projectEvents({
      document,
      runId,
      events,
      includeReasoning
    } = {}) {
      return projectRunEventsToYDocument(document, {
        runId,
        events,
        includeReasoning
      });
    },
    reconcileTranscript({
      document,
      messages
    } = {}) {
      return reconcileSessionMessagesInYText(
        document.getText(SESSION_DOCUMENT_TEXT_KEY),
        messages
      );
    }
  });
}
