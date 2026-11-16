import { describe, expect, it } from "vitest";
import { captureDocumentInput } from "../src/chat/document-input";

function editor(text: string, line: number, selection?: { from: number; to: number }) {
  return {
    getValue: () => text,
    getCursor: () => ({ line, ch: 0 }),
    getView: () => ({ state: { selection: { main: selection } } })
  };
}

describe("document input snapshots", () => {
  it("captures only the prefix through the trigger line in the middle of history", () => {
    const input = captureDocumentInput(editor("user first\nassistant revised\nuser later", 1));
    expect(input.messages).toEqual([
      { role: "user", content: "first" }, { role: "assistant", content: "revised" }
    ]);
    expect(input.insertionOffset).toBe("user first\nassistant revised".length);
    expect(input.documentText.endsWith("user later")).toBe(true);
  });

  it("captures an exact selection without leaking the surrounding document", () => {
    const text = "user private context\nuser selected request\nassistant not selected";
    const from = text.indexOf("user selected");
    const to = text.indexOf("\nassistant");
    const input = captureDocumentInput(editor(text, 0, { from, to }), { useSelection: true });
    expect(input.messages).toEqual([{ role: "user", content: "selected request" }]);
    expect(input.from).toBe(from);
    expect(input.insertionOffset).toBe(to);
  });

  it("honors an exact selection ending in the middle of a line", () => {
    const input = captureDocumentInput(editor("user first second", 0, { from: 5, to: 10 }), { useSelection: true });
    expect(input.content).toBe("first");
    expect(input.cursor).toEqual({ line: 0, ch: 10 });
  });

  it("keeps captured text, context and annotations independent of later edits", () => {
    let text = "user original";
    const context = [{ role: "system", content: "initial context" }];
    const annotations = { tools: [{ id: "t", args: { path: "first" } }] };
    const input = captureDocumentInput({ ...editor(text, 0), getValue: () => text }, {
      contextMessages: context, annotations, submissionId: "request-1"
    });
    text = "user changed after send";
    context[0].content = "new context";
    annotations.tools[0].args.path = "second";
    expect(input.messages).toEqual([
      { role: "system", content: "initial context" }, { role: "user", content: "original" }
    ]);
    expect(input.annotations).toEqual({ tools: [{ id: "t", args: { path: "first" } }] });
    expect(Object.isFrozen(input.messages[0])).toBe(true);
  });

  it("supports a conversation containing only a revised assistant message", () => {
    const input = captureDocumentInput(editor("assistant edited continuation", 0));
    expect(input.messages).toEqual([{ role: "assistant", content: "edited continuation" }]);
  });

  it("rejects an empty selection instead of submitting unrelated context", () => {
    expect(() => captureDocumentInput(editor("user private context", 0), { useSelection: true }))
      .toThrow("请先选中");
  });

  it("keeps explicit role syntax in fenced examples as message text", () => {
    const text = "user explain\n```text\nassistant example\n```\nquestion";
    expect(captureDocumentInput(editor(text, 4)).messages).toEqual([
      { role: "user", content: "explain\n```text\nassistant example\n```\nquestion" }
    ]);
  });
});
