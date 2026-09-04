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
