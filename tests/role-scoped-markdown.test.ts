import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { roleScopedFencedCode } from "../src/editor/roleScopedMarkdown";

function collectNodes(state: EditorState) {
  const nodes: Array<{ name: string; from: number; to: number }> = [];
  syntaxTree(state).iterate({
    enter(node) {
      nodes.push({ name: node.name, from: node.from, to: node.to });
    }
  });
  return nodes;
}

describe("role-scoped Markdown parsing", () => {
  it("does not pair fenced code markers across role boundaries", () => {
    const source = [
      "user prompt",
      "```js",
      "const value = 1",
      "assistant answer",
      "# assistant heading",
      "```ts",
      "return value",
      "```"
    ].join("\n");
    const state = EditorState.create({
      doc: source,
      extensions: [
        markdown({ extensions: [roleScopedFencedCode, GFM] })
      ]
    });
    const nodes = collectNodes(state);
    const fences = nodes.filter((node) => node.name === "FencedCode");
    const assistantLine = state.doc.line(4);
    const assistantFenceLine = state.doc.line(6);
    const headingLine = state.doc.line(5);

    expect(fences).toHaveLength(2);
    expect(fences[0].to).toBeLessThanOrEqual(assistantLine.from);
    expect(fences[1].from).toBe(assistantFenceLine.from);
    expect(nodes.some((node) =>
      node.name.startsWith("ATXHeading") &&
      node.from >= headingLine.from &&
      node.to <= headingLine.to
    )).toBe(true);
  });

  it("ends inline Markdown paragraphs at role boundaries", () => {
    const source = [
      "user **unfinished",
      "assistant should not close**"
    ].join("\n");
    const state = EditorState.create({
      doc: source,
      extensions: [
        markdown({ extensions: [roleScopedFencedCode, GFM] })
      ]
    });
    const nodes = collectNodes(state);
    const assistantLine = state.doc.line(2);

    expect(nodes.some((node) =>
      node.name === "Emphasis" &&
      node.from < assistantLine.from &&
      node.to > assistantLine.from
    )).toBe(false);
  });
});
