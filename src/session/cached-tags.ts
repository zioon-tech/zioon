import { extractObsidianMetadata } from "../../extensions/shared/obsidian-metadata.js";
import { getIndexedSessionTags } from "../../extensions/dev.session-manager/model/session-tag-index.js";
import { isSessionTagPathExcluded } from "../../extensions/shared/session-tag-exclusions.js";

type State = { get(key: string): any };
const cached = new Map<string, { text: string; tags: string[] }>();

/** Presentation must never cause a read of an unopened document. */
export function cachedSessionTags(state: State | undefined, sessionId: string): string[] {
  if (!state || !sessionId) return [];
  const index = state.get("sessions.tagIndex");
  const text = state.get(`sessions.doc.${sessionId}`);
  if (typeof text !== "string") {
    return getIndexedSessionTags(index, sessionId).map((tag: string) => `#${tag}`);
  }
  let entry = cached.get(sessionId);
  if (!entry || entry.text !== text) {
    entry = { text, tags: [...new Set<string>(
      extractObsidianMetadata(text).tags.map((tag: { label: string }) => tag.label)
    )] };
    cached.delete(sessionId);
    cached.set(sessionId, entry);
    while (cached.size > 4) cached.delete(cached.keys().next().value!);
  }
  const exclusions = index?.sessions?.[sessionId]?.exclusions || [];
  return entry.tags.filter(tag => !isSessionTagPathExcluded(tag, exclusions));
}
