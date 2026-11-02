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
