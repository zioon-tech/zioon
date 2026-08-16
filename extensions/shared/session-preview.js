const ROLE_HEAD_RE = /^\s*(system|user|assistant|tool)(?:\s+|$)/;
const USER_HEAD_RE = /^\s*user(?:\s+|$)/;

function compactPreview(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const limit = Math.max(1, Number(maxLength) || 180);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function extractLastUserMessagePreview(text, maxLength = 180) {
  const lines = String(text || "").split(/\r?\n/);
  const previews = [];
  const firstRoleLine = lines.findIndex((line) => ROLE_HEAD_RE.test(line || ""));

  if (firstRoleLine !== 0) {
    const implicitLines = lines.slice(0, firstRoleLine < 0 ? lines.length : firstRoleLine);
    const implicitPreview = compactPreview(implicitLines.join(" "), maxLength);
    if (implicitPreview) previews.push(implicitPreview);
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (!USER_HEAD_RE.test(lines[index] || "")) continue;
    const block = [String(lines[index] || "").replace(USER_HEAD_RE, "")];
    let end = index;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (ROLE_HEAD_RE.test(lines[cursor] || "")) break;
      block.push(lines[cursor]);
      end = cursor;
    }
    const preview = compactPreview(block.join(" "), maxLength);
    if (preview) previews.push(preview);
    index = end;
  }

  return previews.at(-1) || "";
}
