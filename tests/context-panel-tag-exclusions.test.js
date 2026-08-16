import { describe, expect, it } from "vitest";
import {
  normalizeSessionTagExclusionPath,
  partitionSessionExtractedTags
} from "../extensions/shared/session-tag-exclusions.js";

describe("Context Panel tag exclusions", () => {
  const tags = [
    { label: "project", line: 1 },
    { label: "project/zion", line: 2 },
    { label: "projector", line: 3 },
    { label: "topic/ui", line: 4 }
  ];

  it("normalizes the displayed hash prefix before command payloads", () => {
    expect(normalizeSessionTagExclusionPath("#project/zion")).toBe("project/zion");
  });

  it("partitions live extracted tags with exact and subtree rules", () => {
    const result = partitionSessionExtractedTags(tags, [
      { path: "project", subtree: true },
      { path: "topic/ui", subtree: false }
    ]);

    expect(result.visible.map((tag) => tag.label)).toEqual(["projector"]);
    expect(result.ignoredRules).toEqual([
      expect.objectContaining({
        path: "project",
        subtree: true,
        matchCount: 2
      }),
      expect.objectContaining({
        path: "topic/ui",
        subtree: false,
        matchCount: 1
      })
    ]);
  });

  it("keeps orphaned rules available for restoration", () => {
    const result = partitionSessionExtractedTags(tags, [
      { path: "removed", subtree: false }
    ]);
    expect(result.visible).toHaveLength(4);
    expect(result.ignoredRules).toEqual([{
      path: "removed",
      subtree: false,
      matchCount: 0,
      matchedTags: []
    }]);
  });
});
