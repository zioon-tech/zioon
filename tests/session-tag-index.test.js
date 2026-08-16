import { describe, expect, it } from "vitest";
import {
  createSessionTagIndex,
  extractSessionTagPaths,
  getIndexedSessionTags,
  removeSessionTagIndexEntry,
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
        s1: { hash: "h1", tags: ["#alpha", "alpha", "beta/one"] },
        "": { hash: "bad", tags: ["ignored"] },
        s2: "bad"
      }
    })).toEqual({
      version: 1,
      sessions: {
        s1: { hash: "h1", tags: ["alpha", "beta/one"] }
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
});
