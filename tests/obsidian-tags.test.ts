import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { getObsidianTags } from "../src/editor/extensions/obsidian/parser";

function labels(source: string): string[] {
  return getObsidianTags(Text.of(source.split("\n"))).map((tag) => tag.label);
}

describe("obsidian tags", () => {
  it("keeps longer tags distinct from existing prefix tags", () => {
    expect(labels("#asdf and #asdfasf")).toEqual(["#asdf", "#asdfasf"]);
  });

  it("ignores tags inside inline and fenced code", () => {
    expect(labels([
      "#outside",
      "`#inline` and `code #inline2 `",
      "```ts",
      "#inside",
      "const value = '#inside2';",
      "```",
      "after #after"
    ].join("\n"))).toEqual(["#outside", "#after"]);
  });
});
