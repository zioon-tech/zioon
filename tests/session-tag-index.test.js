import { describe, expect, it } from "vitest";
import {
  applyTagSubtreeExclusionBulk,
  buildSessionTagExtractionState,
  calculateTagSubtreeExclusionImpact,
  createSessionTagIndex,
  excludeSessionTags,
  extractSessionTagPaths,
  getIndexedSessionTags,
  getRawIndexedSessionTags,
  getSessionTagExclusions,
  isSessionTagExcluded,
  removeSessionTagIndexEntry,
  restoreSessionTagExclusion,
  updateSessionTagIndex,
  validateSessionTagIndex
} from "../extensions/dev.session-manager/model/session-tag-index.js";

describe("session tag index", () => {
  it("extracts normalized unique document tags", () => {
    expect(extractSessionTagPaths([
      "user #project/zion and #topic/ui",
      "assistant repeats #project/zion",
      "```",
      "#ignored/in/fence",
      "```"
    ].join("\n"))).toEqual(["project/zion", "topic/ui"]);
  });

  it("validates persisted entries and drops malformed values", () => {
    expect(validateSessionTagIndex({
      version: 1,
      sessions: {
        s1: {
          hash: "h1",
          tags: ["#alpha", "alpha", "beta/one"],
          exclusions: [
            { path: "#alpha", subtree: false },
            { path: "alpha", subtree: false },
            { path: "beta", subtree: true },
            { path: "", subtree: true },
            null
          ]
        },
        "": { hash: "bad", tags: ["ignored"] },
        s2: "bad"
      }
    })).toEqual({
      version: 1,
      sessions: {
        s1: {
          hash: "h1",
          tags: ["alpha", "beta/one"],
          exclusions: [
            { path: "alpha", subtree: false },
            { path: "beta", subtree: true }
          ]
        }
      }
    });
  });

  it("updates and removes one session without changing other entries", () => {
    const base = updateSessionTagIndex(
      createSessionTagIndex(),
      "s1",
      "hello #alpha",
      "hash-1"
    );
    const withSecond = updateSessionTagIndex(base, "s2", "hello #beta", "hash-2");
    expect(getIndexedSessionTags(withSecond, "s1")).toEqual(["alpha"]);
    expect(getIndexedSessionTags(withSecond, "s2")).toEqual(["beta"]);

    const removed = removeSessionTagIndexEntry(withSecond, "s1");
    expect(getIndexedSessionTags(removed, "s1")).toEqual([]);
    expect(getIndexedSessionTags(removed, "s2")).toEqual(["beta"]);
  });

  it("distinguishes exact exclusions from subtree exclusions", () => {
    expect(isSessionTagExcluded("project", [{ path: "project", subtree: false }])).toBe(true);
    expect(isSessionTagExcluded("project/zion", [{ path: "project", subtree: false }])).toBe(false);
    expect(isSessionTagExcluded("project/zion", [{ path: "project", subtree: true }])).toBe(true);
    expect(isSessionTagExcluded("projector", [{ path: "project", subtree: true }])).toBe(false);
  });

  it("filters visible tags while preserving raw tags and exclusions across re-indexing", () => {
    let index = updateSessionTagIndex(
      createSessionTagIndex(),
      "s1",
      "#project #project/zion #topic/ui",
      "hash-1"
    );
    index = excludeSessionTags(index, "s1", "project", { subtree: true });
    expect(getRawIndexedSessionTags(index, "s1")).toEqual(["project", "project/zion", "topic/ui"]);
    expect(getIndexedSessionTags(index, "s1")).toEqual(["topic/ui"]);
    expect(getSessionTagExclusions(index, "s1")).toEqual([{ path: "project", subtree: true }]);

    index = updateSessionTagIndex(index, "s1", "#project/new #topic/ui", "hash-2");
    expect(getIndexedSessionTags(index, "s1")).toEqual(["topic/ui"]);
    expect(getSessionTagExclusions(index, "s1")).toEqual([{ path: "project", subtree: true }]);
  });

  it("restores only the selected exact or subtree rule", () => {
    let index = updateSessionTagIndex(createSessionTagIndex(), "s1", "#alpha #beta/one", "h");
    index = excludeSessionTags(index, "s1", "alpha", { subtree: false });
    index = excludeSessionTags(index, "s1", "beta", { subtree: true });
    index = restoreSessionTagExclusion(index, "s1", "alpha", { subtree: false });

    expect(getIndexedSessionTags(index, "s1")).toEqual(["alpha"]);
    expect(getSessionTagExclusions(index, "s1")).toEqual([{ path: "beta", subtree: true }]);
  });

  it("calculates and applies bulk subtree impact across matching sessions", () => {
    let index = createSessionTagIndex();
    index = updateSessionTagIndex(index, "s1", "#project #project/zion #other", "1");
    index = updateSessionTagIndex(index, "s2", "#project/zion/ui #other", "2");
    index = updateSessionTagIndex(index, "s3", "#topic/ui", "3");

    expect(calculateTagSubtreeExclusionImpact(index, "project")).toEqual({
      path: "project",
      sessionIds: ["s1", "s2"],
      sessionCount: 2,
      tagCount: 3
    });

    const result = applyTagSubtreeExclusionBulk(index, "project");
    expect(result.impact.sessionCount).toBe(2);
    expect(getIndexedSessionTags(result.index, "s1")).toEqual(["other"]);
    expect(getIndexedSessionTags(result.index, "s2")).toEqual(["other"]);
    expect(getIndexedSessionTags(result.index, "s3")).toEqual(["topic/ui"]);
  });

  it("builds visible and ignored extraction state for one session", () => {
    let index = updateSessionTagIndex(createSessionTagIndex(), "s1", "#alpha #project/zion", "1");
    index = excludeSessionTags(index, "s1", "project", { subtree: true });
    expect(buildSessionTagExtractionState(index, "s1")).toEqual({
      sessionId: "s1",
      rawTags: ["alpha", "project/zion"],
      visibleTags: ["alpha"],
      ignoredTags: ["project/zion"],
      exclusions: [{ path: "project", subtree: true }]
    });
  });
});
