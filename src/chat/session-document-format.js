const CONTINUATION_BOUNDARY_RE =
  /^\s*user\s+<!--\s*zion-continuation:id=([^>\s]+)\s*-->\s*$/;

function sanitizeMarkerId(value) {
  return String(value || "")
    .replace(/-->/g, "")
    .replace(/[\r\n\t ]+/g, "_")
    .trim();
}

export function continuationBoundaryText(runId) {
  const id = sanitizeMarkerId(runId);
  return id ? `user <!-- zion-continuation:id=${id} -->` : "";
}

export function getContinuationBoundaryId(line) {
  const match = String(line || "").match(CONTINUATION_BOUNDARY_RE);
  return match?.[1] ? String(match[1]) : null;
}

export function isContinuationBoundaryLine(line) {
  return getContinuationBoundaryId(line) != null;
}

// Shared lexical boundary for text roles and widget markers. Quoted examples
// inside fenced code are content, even when they look like a message header.
export function conversationLineRanges(text) {
  let fence = null;
  let offset = 0;
  return String(text || "").split("\n").map((line) => {
    const start = offset;
    offset += line.length + 1;
    const inFence = fence !== null;
    const body = inFence ? line : line.replace(/^(system|user|assistant|tool)\s+/, "");
    const marker = body.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (fence && marker[1][0] === fence[0]
        && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = null;
      } else if (!fence && !(marker[1][0] === "`" && marker[2].includes("`"))) {
        fence = marker[1];
      }
    }
    return {
      line, start, end: start + line.length, next: offset,
      literal: inFence || (!!marker && body === line)
    };
  });
}

// A new user turn must remain outside any unfinished Markdown code fence.
export function appendUserMessageText(source, content) {
  let fence = null;
  for (const line of String(source || "").split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    const marker = match[1];
    if (!fence) {
      if (marker[0] === "`" && match[2].includes("`")) continue;
      fence = marker;
    } else if (marker[0] === fence[0] && marker.length >= fence.length && !match[2].trim()) {
      fence = null;
    }
  }
  const separator = source && !String(source).endsWith("\n") ? "\n" : "";
  return `${separator}${fence ? `${fence}\n` : ""}user ${content}`;
}
