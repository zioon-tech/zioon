import { describe, expect, it } from "vitest";
import { findTagOccurrences, previewTagImpact, rewriteDocTags } from "../extensions/dev.session-manager/features/tag-mutations.js";

describe("findTagOccurrences", () => {
  it("finds inline tags with ranges", () => {
    const text = "hello #alpha note\ntail #project/zion end";
    const occurrences = findTagOccurrences(text);
    expect(occurrences.map((o) => o.path)).toEqual(["alpha", "project/zion"]);
    for (const occurrence of occurrences) {
      expect(text.slice(occurrence.start, occurrence.end)).toBe(`#${occurrence.path}`);
    }
  });
  it("returns every occurrence without dedupe", () => {
    const occurrences = findTagOccurrences("x #dup y #dup");
    expect(occurrences).toHaveLength(2);
  });
  it("skips code fences, inline code, and headings", () => {
    const text = "# Heading #not-a-tag\n```\n#fenced\n```\ninline `#coded` done\nreal #kept";
    const paths = findTagOccurrences(text).map((o) => o.path);
    expect(paths).toEqual(["kept"]);
  });
});

describe("rewriteDocTags", () => {
  it("renames a tag and its descendants in place", () => {
    const text = "#old body #old/child tail";
    const result = rewriteDocTags(text, { renames: [{ from: "old", to: "new" }] });
    expect(result.text).toBe("#new body #new/child tail");
    expect(result.changed).toBe(true);
  });
  it("does not touch similar prefixes", () => {
    const text = "#old #oldstuff";
    const result = rewriteDocTags(text, { renames: [{ from: "old", to: "new" }] });
    expect(result.text).toBe("#new #oldstuff");
  });
  it("removes tags and swallows one adjacent space", () => {
    const result = rewriteDocTags("keep #drop this", { removals: ["drop"] });
    expect(result.text).toBe("keep this");
    const lead = rewriteDocTags("keep word #drop", { removals: ["drop"] });
    expect(lead.text).toBe("keep word");
  });
  it("returns unchanged for non-matching docs", () => {
    const result = rewriteDocTags("#alpha", { renames: [{ from: "beta", to: "gamma" }] });
    expect(result.changed).toBe(false);
    expect(result.text).toBe("#alpha");
  });
});

describe("previewTagImpact", () => {
  it("counts affected sessions and occurrences", () => {
    const docs = [
      { id: "s1", text: "#a" },
      { id: "s2", text: "#b #b" },
      { id: "s3", text: "#c" }
    ];
    const impact = previewTagImpact(docs, "b");
    expect(impact.sessions).toEqual(["s2"]);
    expect(impact.occurrences).toBe(2);
  });
});
