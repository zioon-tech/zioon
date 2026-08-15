import { describe, expect, it } from "vitest";
import {
  addCatalogEntry,
  buildTagTree,
  deleteCatalogPaths,
  normalizeTagPath,
  reconcileCatalog,
  renameCatalogPath,
  reorderCatalogEntry,
  sortEntries,
  tagPathMatches
} from "../extensions/dev.session-manager/model/tag-catalog.js";

describe("normalizeTagPath", () => {
  it("strips # and trims", () => {
    expect(normalizeTagPath("#project/zion ")).toBe("project/zion");
    expect(normalizeTagPath("  a / b ")).toBe("a/b");
  });
  it("rejects empties", () => {
    expect(normalizeTagPath("")).toBeNull();
    expect(normalizeTagPath("///")).toBeNull();
    expect(normalizeTagPath(null)).toBeNull();
  });
});

describe("reconcileCatalog", () => {
  it("appends scanned-only tags as ephemeral entries after catalog ones", () => {
    const merged = reconcileCatalog(
      [{ id: "tag:work", path: "work", order: 0, manual: true }],
      ["#alpha", "work"]
    );
    expect(merged.map((e) => e.path)).toEqual(["work", "alpha"]);
    expect(merged.find((e) => e.path === "alpha").manual).toBe(false);
    expect(merged.find((e) => e.path === "work").manual).toBe(true);
  });
});

describe("buildTagTree", () => {
  it("builds hierarchy with implicit parents and session counts", () => {
    const entries = reconcileCatalog([], ["project/zion", "research"]);
    const tree = buildTagTree(entries, [
      ["s1", ["#project/zion"]],
      ["s2", ["#project/zion", "#research"]],
      ["s3", ["#research"]]
    ]);
    const project = tree.rows.find((r) => r.path === "project");
    const zion = tree.rows.find((r) => r.path === "project/zion");
    const research = tree.rows.find((r) => r.path === "research");
    expect(zion.sessionCount).toBe(2);
    expect(research.sessionCount).toBe(2);
    // parent counts sessions using any descendant (s1, s2) — counted once each
    expect(project.sessionCount).toBe(2);
    expect(project.implicit).toBe(true);
    expect(zion.depth).toBe(1);
  });
  it("manual order wins over alphabetical for siblings", () => {
    const entries = [
      { id: "tag:work/b", path: "work/b", order: 0, manual: true },
      { id: "tag:work/a", path: "work/a", order: 1, manual: true }
    ];
    const tree = buildTagTree(entries, []);
    const labels = tree.rows.filter((r) => r.path.startsWith("work/")).map((r) => r.label);
    expect(labels).toEqual(["b", "a"]);
  });
});

describe("addCatalogEntry", () => {
  it("adds with next order and rejects duplicates", () => {
    const { entries, added } = addCatalogEntry([{ id: "tag:a", path: "a", order: 3, manual: true }], "b");
    expect(added).toBe("b");
    expect(entries.find((e) => e.path === "b").order).toBe(4);
    const again = addCatalogEntry(entries, "b");
    expect(again.added).toBeNull();
    expect(again.entries).toHaveLength(entries.length);
  });
  it("promotes ephemeral entry to manual", () => {
    const base = [{ id: "tag:a", path: "a", order: 0, manual: false }];
    const { entries, added } = addCatalogEntry(base, "a");
    expect(added).toBe("a");
    expect(entries.find((e) => e.path === "a").manual).toBe(true);
  });
});

describe("renameCatalogPath", () => {
  it("renames node and descendants, merging into existing target", () => {
    const entries = [
      { id: "tag:old", path: "old", order: 0, manual: true },
      { id: "tag:old/child", path: "old/child", order: 1, manual: true },
      { id: "tag:new", path: "new", order: 2, manual: true }
    ];
    const { entries: next, affected } = renameCatalogPath(entries, "old", "new");
    expect(affected).toBe(2);
    expect(next.some((e) => e.path.startsWith("old"))).toBe(false);
    expect(next.filter((e) => e.path === "new").length).toBe(1);
    expect(next.some((e) => e.path === "new/child")).toBe(true);
  });
  it("rejects renaming into own subtree", () => {
    const entries = [{ id: "tag:a", path: "a", order: 0, manual: true }];
    const { entries: next, affected } = renameCatalogPath(entries, "a", "a/b");
    expect(affected).toBe(0);
    expect(next).toEqual(entries);
  });
});

describe("deleteCatalogPaths", () => {
  it("removes the node and its descendants", () => {
    const entries = [
      { id: "tag:a", path: "a", order: 0, manual: true },
      { id: "tag:a/x", path: "a/x", order: 1, manual: true },
      { id: "tag:b", path: "b", order: 2, manual: true }
    ];
    const { entries: next, removed } = deleteCatalogPaths(entries, ["a"]);
    expect(removed).toEqual(["a"]);
    expect(next.map((e) => e.path)).toEqual(["b"]);
  });
});

describe("reorderCatalogEntry", () => {
  it("moves before the reference within the same parent", () => {
    const entries = ["a", "b", "c"].map((p, i) => ({ id: `tag:${p}`, path: p, order: i, manual: true }));
    const next = reorderCatalogEntry(entries, "c", "a");
    const sorted = sortEntries(next).map((e) => e.path);
    expect(sorted).toEqual(["c", "a", "b"]);
  });
  it("ignores cross-parent reorder", () => {
    const entries = [
      { id: "tag:x", path: "p/x", order: 0, manual: true },
      { id: "tag:y", path: "q/y", order: 1, manual: true }
    ];
    const next = reorderCatalogEntry(entries, "p/x", "q/y");
    expect(next).toEqual(entries);
  });
});

describe("tagPathMatches", () => {
  it("matches exact and descendant paths", () => {
    expect(tagPathMatches("project/zion", "project")).toBe(true);
    expect(tagPathMatches("project", "project")).toBe(true);
    expect(tagPathMatches("projectx", "project")).toBe(false);
  });
});
