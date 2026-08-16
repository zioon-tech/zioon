import { extractObsidianMetadata } from "../../shared/obsidian-metadata.js";
import { normalizeTagPath } from "./tag-catalog.js";

export const SESSION_TAG_INDEX_VERSION = 1;

export function createSessionTagIndex() {
  return { version: SESSION_TAG_INDEX_VERSION, sessions: {} };
}

function normalizeTags(rawTags) {
  const seen = new Set();
  const tags = [];
  for (const rawTag of Array.isArray(rawTags) ? rawTags : []) {
    const path = normalizeTagPath(rawTag);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    tags.push(path);
  }
  return tags;
}

export function validateSessionTagIndex(raw) {
  const sessions = {};
  const input = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw.sessions
    : null;
  for (const [rawSessionId, rawEntry] of Object.entries(input || {})) {
    const sessionId = String(rawSessionId || "").trim();
    if (!sessionId || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    sessions[sessionId] = {
      hash: String(rawEntry.hash || ""),
      tags: normalizeTags(rawEntry.tags)
    };
  }
  return { version: SESSION_TAG_INDEX_VERSION, sessions };
}

export function extractSessionTagPaths(text) {
  return normalizeTags(
    extractObsidianMetadata(String(text || "")).tags.map((tag) => tag.label)
  );
}

export function getIndexedSessionTags(index, sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return [];
  const entry = index?.sessions?.[id];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  return normalizeTags(entry.tags);
}

export function updateSessionTagIndex(index, sessionId, text, hash = "") {
  const id = String(sessionId || "").trim();
  const current = validateSessionTagIndex(index);
  if (!id) return current;
  return {
    ...current,
    sessions: {
      ...current.sessions,
      [id]: {
        hash: String(hash || ""),
        tags: extractSessionTagPaths(text)
      }
    }
  };
}

export function removeSessionTagIndexEntry(index, sessionId) {
  const id = String(sessionId || "").trim();
  const current = validateSessionTagIndex(index);
  if (!id || !Object.prototype.hasOwnProperty.call(current.sessions, id)) return current;
  const sessions = { ...current.sessions };
  delete sessions[id];
  return { ...current, sessions };
}
