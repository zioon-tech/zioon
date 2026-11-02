export const SESSION_DERIVED_TAGS_STATE_KEY = "sessions.derivedTags";

function normalizePath(value) {
  const segments = String(value || "")
    .replace(/^#/, "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!segments.length) return "";
  const path = segments.join("/");
  return path.length <= 200 ? path : "";
}

function normalizeTag(tag) {
  const input = typeof tag === "string" ? { path: tag } : tag;
  if (!input || typeof input !== "object") return null;
  const path = normalizePath(input.path);
  if (!path) return null;
  const kind = String(input.kind || "").trim();
  return kind ? { path, kind } : { path };
}

export function normalizeSessionDerivedTagSource(source) {
  if (!source || typeof source !== "object") return null;
  const id = String(source.id || "").trim();
  if (!id) return null;
  const label = String(source.label || id).trim() || id;
  const sessions = {};
  for (const [rawSessionId, rawTags] of Object.entries(source.sessions || {})) {
    const sessionId = String(rawSessionId || "").trim();
    if (!sessionId || !Array.isArray(rawTags)) continue;
    const seen = new Set();
    const tags = [];
    for (const rawTag of rawTags) {
      const tag = normalizeTag(rawTag);
      if (!tag) continue;
      const key = `${tag.path}\u0000${tag.kind || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
    }
    if (tags.length) sessions[sessionId] = tags;
  }
  return {
    id,
    label,
    readOnly: source.readOnly !== false,
    sessions
  };
}

function readRegistry(zion) {
  try {
    const value = zion?.state?.get?.(SESSION_DERIVED_TAGS_STATE_KEY);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function publishSessionDerivedTagSource(zion, source) {
  const normalized = normalizeSessionDerivedTagSource(source);
  if (!normalized || typeof zion?.state?.set !== "function") return false;
  zion.state.set(SESSION_DERIVED_TAGS_STATE_KEY, {
    ...readRegistry(zion),
    [normalized.id]: normalized
  });
  return true;
}

export function removeSessionDerivedTagSource(zion, sourceId) {
  const id = String(sourceId || "").trim();
  if (!id || typeof zion?.state?.set !== "function") return false;
  const current = readRegistry(zion);
  if (!Object.prototype.hasOwnProperty.call(current, id)) return false;
  const next = { ...current };
  delete next[id];
  zion.state.set(SESSION_DERIVED_TAGS_STATE_KEY, next);
  return true;
}

export function collectSessionDerivedTags(registry, sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid || !registry || typeof registry !== "object") return [];
  const out = [];
  for (const rawSource of Object.values(registry)) {
    if (!rawSource || typeof rawSource !== "object") continue;
    const sourceId = String(rawSource.id || "").trim();
    if (!sourceId) continue;
    const sourceLabel = String(rawSource.label || sourceId).trim() || sourceId;
    for (const rawTag of rawSource.sessions?.[sid] || []) {
      const tag = normalizeTag(rawTag);
      if (!tag) continue;
      out.push({
        ...tag,
        sourceId,
        sourceLabel,
        readOnly: rawSource.readOnly !== false
      });
    }
  }
  return out;
}
