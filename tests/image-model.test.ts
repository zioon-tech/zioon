import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  collectStandaloneImageGroups,
  formatImageInsertion,
  getImageInsertTarget,
  parseStandaloneImageLine
} from "../src/editor/image-model";

const doc = (source: string) => Text.of(source.split("\n"));

describe("image document model", () => {
  it("parses standalone image lines without including indentation", () => {
    expect(parseStandaloneImageLine("  ![diagram](app://img/a)  ", 10, 3)).toEqual({
      alt: "diagram",
      src: "app://img/a",
      markdown: "![diagram](app://img/a)",
      from: 12,
      to: 35,
      lineFrom: 10,
      lineTo: 37,
      lineNumber: 3
    });
  });

  it("groups only consecutive standalone image lines", () => {
    const groups = collectStandaloneImageGroups(doc([
      "before",
      "![](app://img/1)",
      "![](app://img/2)",
      "",
      "![](app://img/3)",
      "after"
    ].join("\n")));

    expect(groups.map(group => group.items.map(item => item.src))).toEqual([
      ["app://img/1", "app://img/2"],
      ["app://img/3"]
    ]);
  });

  it("classifies inline, standalone, and gallery insertion targets", () => {
    const source = doc([
      "paragraph text",
      "",
      "![](app://img/1)",
      ""
    ].join("\n"));

    expect(getImageInsertTarget(source, 5, 1).kind).toBe("inline");
    expect(getImageInsertTarget(source, source.line(2).from, 1).kind).toBe("gallery");
    expect(getImageInsertTarget(source, source.line(4).from, 1).kind).toBe("gallery");
    expect(getImageInsertTarget(source, 5, 2)).toEqual({
      position: source.line(1).to,
      kind: "gallery"
    });
  });

  it("adds line boundaries only for block-style insertions", () => {
    const source = doc("beforeafter");
    expect(formatImageInsertion(source, 6, 6, "![](x)", "inline")).toBe("![](x)");
    expect(formatImageInsertion(source, 6, 6, "![](x)", "solo")).toBe("\n![](x)\n");
  });
});
