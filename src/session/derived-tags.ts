export const SESSION_DERIVED_TAGS_STATE_KEY = "sessions.derivedTags";

export type SessionDerivedTag = {
  path: string;
  kind?: string;
};

export type SessionDerivedTagSource = {
  id: string;
  label?: string;
  readOnly?: boolean;
  sessions?: Record<string, Array<string | SessionDerivedTag>>;
};

function normalizePath(value: unknown): string {
  const segments = String(value || "")
    .replace(/^#/, "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!segments.length) return "";
  const path = segments.join("/");
  return path.length <= 200 ? path : "";
}

function normalizeTag(tag: unknown): SessionDerivedTag | null {
  const input = typeof tag === "string" ? { path: tag } : tag;
  if (!input || typeof input !== "object") return null;
  const path = normalizePath((input as any).path);
  if (!path) return null;
  const kind = String((input as any).kind || "").trim();
  return kind ? { path, kind } : { path };
}

export function normalizeSessionDerivedTagSource(source: SessionDerivedTagSource | unknown) {
  if (!source || typeof source !== "object") return null;
  const raw = source as SessionDerivedTagSource;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const label = String(raw.label || id).trim() || id;
  const sessions: Record<string, SessionDerivedTag[]> = {};
  for (const [rawSessionId, rawTags] of Object.entries(raw.sessions || {})) {
    const sessionId = String(rawSessionId || "").trim();
    if (!sessionId || !Array.isArray(rawTags)) continue;
    const seen = new Set<string>();
    const tags: SessionDerivedTag[] = [];
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
    readOnly: raw.readOnly !== false,
    sessions
  };
}

function readRegistry(zion: any) {
  try {
    const value = zion?.state?.get?.(SESSION_DERIVED_TAGS_STATE_KEY);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function publishSessionDerivedTagSource(zion: any, source: SessionDerivedTagSource | unknown): boolean {
  const normalized = normalizeSessionDerivedTagSource(source);
  if (!normalized || typeof zion?.state?.set !== "function") return false;
  zion.state.set(SESSION_DERIVED_TAGS_STATE_KEY, {
    ...readRegistry(zion),
    [normalized.id]: normalized
  });
  try { zion?.events?.emit?.("sessions/derivedTagsChanged", { sourceId: normalized.id }); } catch {}
  return true;
}

export function removeSessionDerivedTagSource(zion: any, sourceId: string): boolean {
  const id = String(sourceId || "").trim();
  if (!id || typeof zion?.state?.set !== "function") return false;
  const current = readRegistry(zion);
  if (!Object.prototype.hasOwnProperty.call(current, id)) return false;
  const next = { ...current };
  delete next[id];
  zion.state.set(SESSION_DERIVED_TAGS_STATE_KEY, next);
  try { zion?.events?.emit?.("sessions/derivedTagsChanged", { sourceId: id, removed: true }); } catch {}
  return true;
}
