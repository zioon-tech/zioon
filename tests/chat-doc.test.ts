import { describe, expect, it } from "vitest";
import { appendAssistantToken } from "../src/chat/doc";

function createMockEditor(initial: string) {
  let value = initial;
  return {
    getValue: () => value,
    replaceRange: (text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }) => {
      const lines = value.split("\n");
      const startOffset = lines.slice(0, from.line).reduce((sum, line) => sum + line.length + 1, 0) + from.ch;
      const end = to || from;
      const endOffset = lines.slice(0, end.line).reduce((sum, line) => sum + line.length + 1, 0) + end.ch;
      value = value.slice(0, startOffset) + text + value.slice(endOffset);
    }
  };
}

describe("chat doc streaming", () => {
  it("keeps subsequent assistant text after tool markers to preserve event timing", () => {
    const editor = createMockEditor([
      "user 优化校验",
      "assistant - 最多 3 次重试，指数退避（1s,",
      "调用 write",
      "调用 read",
      ""
    ].join("\n"));

    appendAssistantToken(editor as any, {
      token: " 2s, 4s）",
      startLineHint: 1
    });

    expect(editor.getValue()).toBe([
      "user 优化校验",
      "assistant - 最多 3 次重试，指数退避（1s,",
      "调用 write",
      "调用 read",
      " 2s, 4s）"
    ].join("\n"));
  });
});
