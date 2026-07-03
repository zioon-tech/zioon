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

  it("does not steal an existing non-empty user selection while streaming", () => {
    const docText = [
      "user hello",
      "assistant streaming"
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
              return { from: "user hello\n".length, length: "assistant streaming".length };
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
      anchor: { sessionId: "s1", headLine: 1, anchorPos: "user hello\n".length }
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
      "assistant streaming"
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
              return { from: "user hello\n".length, length: "assistant streaming".length };
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
        anchor: { sessionId: "s1", headLine: 1, anchorPos: "user hello\n".length }
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
});
