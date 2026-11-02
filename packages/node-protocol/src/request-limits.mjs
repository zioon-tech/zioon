const BYTE_UNITS = Object.freeze({
  b: 1,
  byte: 1,
  bytes: 1,
  k: 1024,
  kb: 1000,
  kib: 1024,
  m: 1024 * 1024,
  mb: 1000 * 1000,
  mib: 1024 * 1024,
  g: 1024 * 1024 * 1024,
  gb: 1000 * 1000 * 1000,
  gib: 1024 * 1024 * 1024
});

export function parseByteSize(value, {
  fallback,
  label = "byte size",
  min = 1,
  max = 256 * 1024 * 1024
} = {}) {
  if (value == null || String(value).trim() === "") {
    if (fallback == null) throw new Error(`${label} is required`);
    return parseByteSize(fallback, { label, min, max });
  }
  const source = String(value).trim();
  const match = source.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/);
  if (!match) throw new Error(`${label} is invalid: ${source}`);
  const number = Number(match[1]);
  const unit = (match[2] || "b").toLowerCase();
  const multiplier = BYTE_UNITS[unit];
  if (!Number.isFinite(number) || !multiplier) {
    throw new Error(`${label} is invalid: ${source}`);
  }
  const bytes = Math.floor(number * multiplier);
  if (!Number.isSafeInteger(bytes) || bytes < min || bytes > max) {
    throw new Error(`${label} must be between ${formatByteSize(min)} and ${formatByteSize(max)}`);
  }
  return bytes;
}

export function formatByteSize(value) {
  const bytes = Math.max(0, Number(value) || 0);
  const mib = 1024 * 1024;
  const kib = 1024;
  if (bytes >= mib) {
    const amount = bytes / mib;
    return `${Number.isInteger(amount) ? amount : amount.toFixed(1)} MiB`;
  }
  if (bytes >= kib) {
    const amount = bytes / kib;
    return `${Number.isInteger(amount) ? amount : amount.toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

export function requestBodyLimitError(prefix, maxRequestBytes) {
  const limit = formatByteSize(maxRequestBytes);
  const error = new Error(`${prefix} exceeds ${limit}`);
  error.statusCode = 413;
  error.code = "request_body_limit_exceeded";
  error.limitBytes = maxRequestBytes;
  error.limit = limit;
  error.hints = [
    "Reduce the request payload before retrying.",
    "For long conversations, create a handoff summary or compression snapshot.",
    "For large files, use file upload, plugin data files, or chunked transfer instead of one JSON request."
  ];
  return error;
}
