import { extractObsidianMetadata } from "../../shared/obsidian-metadata.js";
import {
  isSessionTagPathExcluded,
  normalizeSessionTagExclusions
} from "../../shared/session-tag-exclusions.js";
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

export function normalizeTagExclusions(rawExclusions) {
  return normalizeSessionTagExclusions(rawExclusions);
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
      tags: normalizeTags(rawEntry.tags),
      exclusions: normalizeTagExclusions(rawEntry.exclusions)
    };
  }
  return { version: SESSION_TAG_INDEX_VERSION, sessions };
}

/** Document hashes and empty entries are local extraction bookkeeping. */
export function sessionTagIndexContentsEqual(before, after) {
  const contents = (index) => Object.entries(validateSessionTagIndex(index).sessions)
    .filter(([, entry]) => entry.tags.length || entry.exclusions.length)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, entry]) => [
      id,
      entry.tags.slice().sort(),
      entry.exclusions.map((rule) => [rule.path, rule.subtree])
        .sort(([a, aSubtree], [b, bSubtree]) => (
          a.localeCompare(b) || Number(aSubtree) - Number(bSubtree)
        ))
    ]);
  return JSON.stringify(contents(before)) === JSON.stringify(contents(after));
}

export function extractSessionTagPaths(text) {
  return normalizeTags(
    extractObsidianMetadata(String(text || "")).tags.map((tag) => tag.label)
  );
}

export function getIndexedSessionTags(index, sessionId) {
  const tags = getRawIndexedSessionTags(index, sessionId);
  const exclusions = getSessionTagExclusions(index, sessionId);
  return tags.filter((tag) => !isSessionTagExcluded(tag, exclusions));
}

export function getRawIndexedSessionTags(index, sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return [];
  const entry = index?.sessions?.[id];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  return normalizeTags(entry.tags);
}

export function getSessionTagExclusions(index, sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return [];
  const entry = index?.sessions?.[id];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  return normalizeTagExclusions(entry.exclusions);
}

export function isSessionTagExcluded(tagPath, exclusions) {
  return isSessionTagPathExcluded(tagPath, exclusions);
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
        tags: extractSessionTagPaths(text),
        exclusions: current.sessions[id]?.exclusions || []
      }
    }
  };
}

export function excludeSessionTags(index, sessionId, path, options = {}) {
  const id = String(sessionId || "").trim();
  const normalizedPath = normalizeTagPath(path);
  const current = validateSessionTagIndex(index);
  if (!id || !normalizedPath || !current.sessions[id]) return current;
  const subtree = options.subtree === true;
  let exclusions = current.sessions[id].exclusions || [];
  const alreadyCovered = exclusions.some((rule) => (
    normalizedPath === rule.path
    || (rule.subtree && normalizedPath.startsWith(`${rule.path}/`))
  ));
  if (alreadyCovered && (!subtree || exclusions.some((rule) => rule.subtree && rule.path === normalizedPath))) {
    return current;
  }
  if (subtree) {
    exclusions = exclusions.filter((rule) => (
      rule.path !== normalizedPath && !rule.path.startsWith(`${normalizedPath}/`)
    ));
  }
  exclusions = normalizeTagExclusions([...exclusions, { path: normalizedPath, subtree }]);
  return {
    ...current,
    sessions: {
      ...current.sessions,
      [id]: {
        ...current.sessions[id],
        exclusions
      }
    }
  };
}

export function restoreSessionTagExclusion(index, sessionId, path, options = {}) {
  const id = String(sessionId || "").trim();
  const normalizedPath = normalizeTagPath(path);
  const current = validateSessionTagIndex(index);
  if (!id || !normalizedPath || !current.sessions[id]) return current;
  const subtree = options.subtree === true;
  const exclusions = (current.sessions[id].exclusions || []).filter((rule) => (
    rule.path !== normalizedPath || rule.subtree !== subtree
  ));
  return {
    ...current,
    sessions: {
      ...current.sessions,
      [id]: {
        ...current.sessions[id],
        exclusions
      }
    }
  };
}

export function buildSessionTagExtractionState(index, sessionId) {
  const id = String(sessionId || "").trim();
  const rawTags = getRawIndexedSessionTags(index, id);
  const exclusions = getSessionTagExclusions(index, id);
  return {
    sessionId: id,
    rawTags,
    visibleTags: rawTags.filter((tag) => !isSessionTagExcluded(tag, exclusions)),
    ignoredTags: rawTags.filter((tag) => isSessionTagExcluded(tag, exclusions)),
    exclusions
  };
}

export function calculateTagSubtreeExclusionImpact(index, path) {
  const normalizedPath = normalizeTagPath(path);
  const sessionIds = [];
  let tagCount = 0;
  if (normalizedPath) {
    const current = validateSessionTagIndex(index);
    for (const sessionId of Object.keys(current.sessions)) {
      const matches = getIndexedSessionTags(current, sessionId).filter((tag) => (
        tag === normalizedPath || tag.startsWith(`${normalizedPath}/`)
      ));
      if (!matches.length) continue;
      sessionIds.push(sessionId);
      tagCount += matches.length;
    }
  }
  return {
    path: normalizedPath,
    sessionIds,
    sessionCount: sessionIds.length,
    tagCount
  };
}

export function applyTagSubtreeExclusionBulk(index, path) {
  const impact = calculateTagSubtreeExclusionImpact(index, path);
  let next = validateSessionTagIndex(index);
  for (const sessionId of impact.sessionIds) {
    next = excludeSessionTags(next, sessionId, impact.path, { subtree: true });
  }
  return { index: next, impact };
}

export function removeSessionTagIndexEntry(index, sessionId) {
  const id = String(sessionId || "").trim();
  const current = validateSessionTagIndex(index);
  if (!id || !Object.prototype.hasOwnProperty.call(current.sessions, id)) return current;
  const sessions = { ...current.sessions };
  delete sessions[id];
  return { ...current, sessions };
}
