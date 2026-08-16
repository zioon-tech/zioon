const ROLE_HEAD_RE = /^\s*(system|user|assistant|tool)(?:\s+|$)/;
const TAGS_ONLY_RE = /^(?:#[^\s#]+)(?:\s+#[^\s#]+)*$/;

function compactPreview(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const limit = Math.max(1, Number(maxLength) || 180);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function extractDocumentLeadPreview(text, maxLength = 180) {
  const lines = String(text || "").split(/\r?\n/);
  const previewLines = [];
  let activeRole = null;
  let started = false;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = String(lines[index] || "");
    const roleMatch = rawLine.match(ROLE_HEAD_RE);
    if (roleMatch) {
      if (started) break;
      activeRole = roleMatch[1];
      if (activeRole !== "user") continue;
      const head = rawLine.slice(roleMatch[0].length).trim();
      if (head && !TAGS_ONLY_RE.test(head)) {
        previewLines.push(head);
        started = true;
      }
      continue;
    }
    if (activeRole && activeRole !== "user") continue;

    const line = rawLine.trim();
    if (!line) {
      if (started) break;
      continue;
    }
    if (TAGS_ONLY_RE.test(line)) continue;
    previewLines.push(line);
    started = true;
  }

  return compactPreview(previewLines.join(" "), maxLength);
}
