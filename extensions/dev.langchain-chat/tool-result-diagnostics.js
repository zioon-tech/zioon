function compactLine(value, max = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function parseMaybeJson(value) {
  if (value && typeof value === "object") return value;
  const text = String(value ?? "").trim();
  if (!text || !/^[\[{]/.test(text)) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function numberFrom(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function firstMeaningfulLine(...values) {
  for (const value of values) {
    const text = String(value || "").replace(/\r/g, "").trim();
    if (!text) continue;
    const line = text.split("\n").map((part) => part.trim()).find(Boolean);
    if (line) return compactLine(line);
  }
  return "";
}

function errorFromText(result) {
  const text = String(result ?? "").trim();
  if (!text) return "";
  const head = text.slice(0, 800);
  const lower = head.toLowerCase();
  const prefixMatch = lower.match(/^(http\s+\d{3}:|bash error:|tool "[^"]+" (?:failed|error):|read error:|write error:|edit error:|webfetch error:|websearch error:|localsearch error:|glob error:|grep error:|tree error:|unknown tool:|invalid args|missing\s+)/);
  if (prefixMatch) return compactLine(head);
  const explicitPatterns = [
    /error reading ssh protocol banner/i,
    /blocked_by_sandbox/i,
    /command blocked by sandbox/i,
    /permission denied/i,
    /connection timed out/i,
    /operation timed out/i,
    /command timed out/i,
    /timeout expired/i
  ];
  for (const pattern of explicitPatterns) {
    const match = head.match(pattern);
    if (match) return compactLine(match[0]);
  }
  return "";
}

export function inferToolResultError(toolName, result, inferredOk = null) {
  const obj = parseMaybeJson(result);
  const textError = errorFromText(result);
  if (obj) {
    const error = firstMeaningfulLine(obj.error, obj.stderr, obj.user_message, obj.message);
    const exitCode = numberFrom(obj.exit_code ?? obj.exitCode);
    const status = String(obj.status || "").toLowerCase();
    const explicitSuccess = obj.ok === true
      || obj.success === true
      || ["ok", "success", "succeeded", "done", "completed"].includes(status)
      || exitCode === 0;
    const timedOut = obj.timeout === true
      || obj.timed_out === true
      || obj.timedOut === true
      || /((^|[\s_-])timeout|timed[\s_-]*out)/.test(String(obj.error || obj.stderr || obj.message || "").toLowerCase());
    const blocked = obj.sandbox_blocked === true
      || /blocked_by_sandbox|command blocked by sandbox/i.test(String(obj.error || obj.user_message || ""));
    const explicitFailure = obj.ok === false
      || obj.success === false
      || blocked
      || timedOut
      || ["error", "failed", "failure", "timeout", "timed_out", "denied", "blocked"].includes(status)
      || (exitCode != null && exitCode !== 0);

    if (explicitFailure) {
      if (/error reading ssh protocol banner/i.test(String(obj.stderr || obj.error || ""))) {
        return "Error reading SSH protocol banner";
      }
      if (blocked) return error || "Command blocked by sandbox";
      if (timedOut) return error || "Tool execution timed out";
      if (error) return exitCode != null && exitCode !== 0 ? `${error} (exit ${exitCode})` : error;
      if (exitCode != null && exitCode !== 0) return `${toolName || "Tool"} exited with code ${exitCode}`;
      return `${toolName || "Tool"} reported failure`;
    }
    if (explicitSuccess) return "";
  }
  if (textError) return textError;
  if (inferredOk === false) return `${toolName || "Tool"} reported failure`;
  return "";
}
