import { describe, expect, it } from "vitest";
import {
  appendAssistantToken,
  insertAssistantBlock,
  parseMessages
} from "../src/chat/doc";

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
  it("writes a stable assistant id marker and strips it from model messages", () => {
    const editor = createMockEditor("user hello");
    const result = insertAssistantBlock(editor as any, {
      sessionId: "s1",
      assistantBlockId: "run-1",
      cursor: { line: 0, ch: "user hello".length }
    });

    expect(result.anchor).toMatchObject({
      sessionId: "s1",
      assistantBlockId: "run-1",
      headLine: 1
    });
    expect(editor.getValue()).toBe("user hello\nassistant <!-- zion-assistant:id=run-1 --> ");

    appendAssistantToken(editor as any, {
      token: "world",
      anchor: result.anchor
    });
    expect(parseMessages(editor.getValue())).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" }
    ]);
  });

  it("appends by assistant id even when the stored line points at an older answer", () => {
    const editor = createMockEditor([
      "user old",
      "assistant <!-- zion-assistant:id=run-old --> old answer",
      "user new",
      "assistant <!-- zion-assistant:id=run-new --> new answer"
    ].join("\n"));

    const ok = appendAssistantToken(editor as any, {
      token: " token",
      anchor: {
        sessionId: "s1",
        assistantBlockId: "run-new",
        headLine: 1,
        anchorPos: 0
      }
    });

    expect(ok).toBe(true);
    expect(editor.getValue()).toContain("run-old --> old answer");
    expect(editor.getValue()).toContain("run-new --> new answer token");
  });

  it("does not fall back to another assistant when the target id is missing", () => {
    const editor = createMockEditor("user hi\nassistant old answer");
    const ok = appendAssistantToken(editor as any, {
      token: " misplaced",
      anchor: {
        sessionId: "s1",
        assistantBlockId: "missing-run",
        headLine: 1,
        anchorPos: 0
      }
    });

    expect(ok).toBe(false);
    expect(editor.getValue()).toBe("user hi\nassistant old answer");
  });

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

  it("does not steal an existing non-empty user selection while streaming", () => {
    const docText = [
      "user hello",
      "assistant <!-- zion-assistant:id=run-1 --> streaming"
    ].join("\n");
    let dispatched: any = null;
    const editor = {
      getValue: () => docText,
      getView: () => ({
        state: {
          selection: { main: { empty: false, from: 0, to: 4 } },
          doc: {
            lines: 2,
            line: (lineNumber: number) => {
              expect(lineNumber).toBe(2);
              const text = "assistant <!-- zion-assistant:id=run-1 --> streaming";
              return { from: "user hello\n".length, to: docText.length, length: text.length, text };
            }
          }
        },
        dispatch: (spec: any) => {
          dispatched = spec;
        }
      })
    };

    const ok = appendAssistantToken(editor as any, {
      token: " token",
      anchor: { sessionId: "s1", assistantBlockId: "run-1", headLine: 1, anchorPos: "user hello\n".length }
    });

    expect(ok).toBe(true);
    expect(dispatched?.changes).toEqual({
      from: docText.length,
      insert: " token"
    });
    expect(dispatched).not.toHaveProperty("selection");
  });

  it("does not steal selection while a user selection gesture is active", () => {
    const docText = [
      "user hello",
      "assistant <!-- zion-assistant:id=run-1 --> streaming"
    ].join("\n");
    let dispatched: any = null;
    const previousZion = (window as any).zion;
    (window as any).zion = {
      state: {
        get: (key: string) => key === "editor.selectionGestureUntil" ? Date.now() + 1000 : undefined
      }
    };
    const editor = {
      getValue: () => docText,
      getView: () => ({
        state: {
          selection: { main: { empty: true, from: 0, to: 0 } },
          doc: {
            lines: 2,
            line: (lineNumber: number) => {
              expect(lineNumber).toBe(2);
              const text = "assistant <!-- zion-assistant:id=run-1 --> streaming";
              return { from: "user hello\n".length, to: docText.length, length: text.length, text };
            }
          }
        },
        dispatch: (spec: any) => {
          dispatched = spec;
        }
      })
    };

    try {
      const ok = appendAssistantToken(editor as any, {
        token: " token",
        anchor: { sessionId: "s1", assistantBlockId: "run-1", headLine: 1, anchorPos: "user hello\n".length }
      });

      expect(ok).toBe(true);
      expect(dispatched?.changes).toEqual({
        from: docText.length,
        insert: " token"
      });
      expect(dispatched).not.toHaveProperty("selection");
    } finally {
      (window as any).zion = previousZion;
    }
  });

  it("keeps a collapsed cursor outside the streaming assistant without disabling follow mode", () => {
    const docText = [
      "user editing here",
      "assistant <!-- zion-assistant:id=run-1 --> streaming"
    ].join("\n");
    const assistantFrom = "user editing here\n".length;
    const assistantText = "assistant <!-- zion-assistant:id=run-1 --> streaming";
    let dispatched: any = null;
    let followLatest: boolean | undefined = true;
    let getValueCalled = false;
    const previousZion = (window as any).zion;
    (window as any).zion = {
      state: {
        get: (key: string) => key === "chat.followLatest.s1" ? followLatest : undefined,
        set: (key: string, value: boolean) => {
          if (key === "chat.followLatest.s1") followLatest = value;
        }
      }
    };
    const editor = {
      getValue: () => {
        getValueCalled = true;
        return docText;
      },
      getView: () => ({
        state: {
          selection: { main: { empty: true, from: 5, to: 5, head: 5 } },
          doc: {
            lines: 2,
            line: (lineNumber: number) => {
              expect(lineNumber).toBe(2);
              return { from: assistantFrom, to: docText.length, length: assistantText.length, text: assistantText };
            }
          }
        },
        dispatch: (spec: any) => {
          dispatched = spec;
        }
      })
    };

    try {
      const ok = appendAssistantToken(editor as any, {
        token: " token",
        anchor: { sessionId: "s1", assistantBlockId: "run-1", headLine: 1, anchorPos: assistantFrom }
      });

      expect(ok).toBe(true);
      expect(getValueCalled).toBe(false);
      expect(dispatched?.changes).toEqual({ from: docText.length, insert: " token" });
      expect(dispatched).not.toHaveProperty("selection");
      expect(followLatest).toBe(true);
    } finally {
      (window as any).zion = previousZion;
    }
  });
});
