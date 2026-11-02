import { describe, expect, it, vi } from "vitest";
import {
  SESSION_DERIVED_TAGS_STATE_KEY,
  collectSessionDerivedTags,
  publishSessionDerivedTagSource,
  removeSessionDerivedTagSource
} from "../extensions/shared/session-derived-tags.js";

function makeState(initial = {}) {
  const values = new Map([[SESSION_DERIVED_TAGS_STATE_KEY, initial]]);
  return {
    get: (key) => values.get(key),
    set: vi.fn((key, value) => values.set(key, value))
  };
}

describe("session derived tag state contract", () => {
  it("publishes a normalized provider without replacing other providers", () => {
    const state = makeState({
      other: { id: "other", label: "Other", readOnly: true, sessions: {} }
    });

    publishSessionDerivedTagSource({ state }, {
      id: "biography",
      label: "Biography",
      readOnly: true,
      sessions: {
        s1: [
          { path: "#project/zion", kind: "project" },
          { path: "project/zion", kind: "project" },
          { path: "topic/ui", kind: "topic" },
          { path: "", kind: "topic" }
        ]
      }
    });

    const registry = state.get(SESSION_DERIVED_TAGS_STATE_KEY);
    expect(Object.keys(registry).sort()).toEqual(["biography", "other"]);
    expect(registry.biography.sessions.s1).toEqual([
      { path: "project/zion", kind: "project" },
      { path: "topic/ui", kind: "topic" }
    ]);
  });

  it("collects tags with provider source metadata", () => {
    const tags = collectSessionDerivedTags({
      biography: {
        id: "biography",
        label: "Biography",
        readOnly: true,
        sessions: {
          s1: [{ path: "project/zion", kind: "project" }]
        }
      }
    }, "s1");

    expect(tags).toEqual([{
      path: "project/zion",
      kind: "project",
      sourceId: "biography",
      sourceLabel: "Biography",
      readOnly: true
    }]);
  });

  it("removes only the requested provider", () => {
    const state = makeState({
      biography: { id: "biography", label: "Biography", readOnly: true, sessions: {} },
      other: { id: "other", label: "Other", readOnly: true, sessions: {} }
    });

    removeSessionDerivedTagSource({ state }, "biography");

    expect(state.get(SESSION_DERIVED_TAGS_STATE_KEY)).toEqual({
      other: { id: "other", label: "Other", readOnly: true, sessions: {} }
    });
  });
});
