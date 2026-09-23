import * as Y from "yjs";
import {
  continuationBoundaryText
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
    headerAnswerStart,
    answerStart,
    answerEnd,
    answerPrefix
  };
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
        changed = appendAssistantTokenToYText(ytext, {
          runId: id,
          token: delta
        }) || changed;
        projection.turnCharacters[turnKey] =
          Number(projection.turnCharacters[turnKey] || 0) + delta.length;
      }
    } else if (event.type === "message.completed") {
      const content = String(data.content || "");
      if (
        content
        && Number(projection.turnCharacters[turnKey] || 0) === 0
      ) {
        changed = appendAssistantTokenToYText(ytext, {
          runId: id,
          token: content
        }) || changed;
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
      changed = appendCardMarkerToYText(ytext, {
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
        text: String(previousCard?.text || "")
          + (event.type === "reasoning.delta"
            ? String(data.delta || "")
            : ""),
        requiresDocumentAnchor: false,
        status: event.type === "reasoning.completed"
          ? "completed"
          : "running",
        sequence
      }) || changed;
    } else if (event.type === "tool.requested") {
      const callId = String(data.callId || data.id || "");
      const cardId = toolCardId(id, callId);
      changed = appendCardMarkerToYText(ytext, {
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
        changed = appendCardMarkerToYText(ytext, {
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

    projection.lastSequence = sequence;
    projection.lastEventType = String(event.type || "");
    projection.status = projectionStatus(event.type, projection.status);
  }

  projections.set(id, projection);
  return changed;
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
  let changed = false;
  for (const userMessage of source) {
    if (userMessage?.role !== "user" || !userMessage.runId) continue;
    if (!assistantBlockRange(ytext.toString(), userMessage.runId)?.exists) {
      continue;
    }
    const assistantMessage = source.find((message) => (
      message?.role === "assistant"
      && message?.runId === userMessage.runId
    ));
    if (!assistantMessage) continue;
    changed = prepareRunInYText(ytext, {
      runId: userMessage.runId,
      userContent: userMessage.content
    }) || changed;
    changed = applyAssistantOutputToYText(ytext, {
      runId: userMessage.runId,
      output: assistantMessage.content
    }) || changed;
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
