const PLACEHOLDER_TITLES = new Set(["", "new session", "untitled", "新会话", "未命名会话"]);

export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => part?.type === "text" ? String(part.text || "") : "").filter(Boolean).join("\n");
}

function compactGraphemes(value, max) {
  const chars = Array.from(String(value || ""));
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trim()}…` : chars.join("");
}

function normalizedTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function generatedIdPattern(value) {
  const text = normalizedTitle(value);
  return /^session[_-][0-9a-f]{6,}(?:[_-][0-9a-f]{4,})*$/i.test(text)
    || /^session\s+\d+$/i.test(text)
    || /^session\s+session[_-][0-9a-f]{6,}(?:[_-][0-9a-f]{4,})*$/i.test(text);
}

export function isPlaceholderSessionTitle(title, sessionId = "", metadata = {}) {
  const text = normalizedTitle(title);
  if (PLACEHOLDER_TITLES.has(text.toLowerCase())) return true;
  const id = normalizedTitle(sessionId);
  if (id && text.toLowerCase() === id.toLowerCase()) return true;
  if (metadata?.titleAuto === false) return false;
  if (generatedIdPattern(text)) return true;
  return metadata?.titleAuto === true && /^session\b/i.test(text);
}

function sanitizeTitleCandidate(value) {
  return String(value || "")
    .replace(/^\s*(system|user|assistant|tool)\s+/i, "")
    .replace(/^[\s#>*-]+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^["'“”‘’]+/, "")
    .replace(/["'“”‘’。，、；;：:！？!?]+$/, "")
    .trim();
}

export function deriveSessionTitleFromContent(content, max = 48) {
  const text = contentText(content).replace(/\r/g, "\n");
  const firstLine = text.split(/\n+/).map(sanitizeTitleCandidate).find(Boolean);
  if (!firstLine) return "";
  return compactGraphemes(firstLine, max);
}
