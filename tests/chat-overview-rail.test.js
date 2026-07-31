import { describe, expect, it, vi } from "vitest";
import { EditorCore } from "../src/editor/EditorCore";
import {
  collectUserMessageItemsFromText,
  findAssistantBlockRange,
  jumpToLine
} from "../extensions/dev.langchain-chat/overview-rail.js";

describe("chat overview rail", () => {
  it("finds the active assistant block from the preferred head line", () => {
    const text = [
      "user 你好",
      "assistant 第一行",
      "第二行",
      "",
      "user 下一条"
    ].join("\n");

    expect(findAssistantBlockRange(text, 1)).toEqual({
      headLine: 1,
      endLine: 3,
      lineCount: 5
    });
  });

  it("falls back to the latest assistant block when the preferred line is stale", () => {
    const text = [
      "user A",
      "assistant 老回答",
      "",
      "user B",
      "assistant 新回答",
      "补充一行"
    ].join("\n");

    expect(findAssistantBlockRange(text, 99)).toEqual({
      headLine: 4,
      endLine: 5,
      lineCount: 6
    });
  });

  it("returns null when the document has no assistant block", () => {
    expect(findAssistantBlockRange("user only", 0)).toBeNull();
  });

  it("collects user message previews for the hover history list", () => {
    const text = [
      "system context",
      "user 第一条问题",
      "补充一行",
      "assistant 回答",
      "user 第二条问题"
    ].join("\n");

    expect(collectUserMessageItemsFromText(text)).toEqual([
      { line: 1, endLine: 2, index: 1, preview: "第一条问题 补充一行" },
      { line: 4, endLine: 4, index: 2, preview: "第二条问题" }
    ]);
  });

  it("treats leading unmarked content as an implicit user message", () => {
    const text = [
      "帮我总结这个文件",
      "重点看异常情况",
      "assistant 好的",
      "user 再补充一个问题"
    ].join("\n");

    expect(collectUserMessageItemsFromText(text)).toEqual([
      { line: 0, endLine: 1, index: 1, preview: "帮我总结这个文件 重点看异常情况" },
      { line: 3, endLine: 3, index: 2, preview: "再补充一个问题" }
    ]);
  });

  it("treats an unmarked document as one implicit user message", () => {
    const text = [
      "这是一段没有 role 标记的会话开头",
      "",
      "仍然属于 user 消息"
    ].join("\n");

    expect(collectUserMessageItemsFromText(text)).toEqual([
      { line: 0, endLine: 2, index: 1, preview: "这是一段没有 role 标记的会话开头 仍然属于 user 消息" }
    ]);
  });

  it("keeps the full user block range when the preview is truncated", () => {
    const longLine = "很长的补充内容".repeat(20);
    const text = [
      "user 开始",
      longLine,
      "仍然属于同一个 user 块",
      "assistant 回答"
    ].join("\n");

    const [item] = collectUserMessageItemsFromText(text);
    expect(item.endLine).toBe(2);
    expect(item.preview.endsWith("…")).toBe(true);
  });

  it("jumps inside a comment editor without scrolling the outer comments list", () => {
    const list = document.createElement("div");
    list.className = "zion-comments-list";
    const row = document.createElement("div");
    row.className = "zion-comments-row";
    row.dataset.threadId = "thread-nav";
    const host = document.createElement("div");
    row.appendChild(host);
    list.appendChild(row);
    document.body.appendChild(list);

    const editor = new EditorCore(host, [
      "user first",
      "assistant answer",
      "user second",
      "assistant another answer",
      "user final"
    ].join("\n"));
    Object.defineProperty(editor.view.scrollDOM, "scrollHeight", {
      configurable: true,
      value: 900
    });
    Object.defineProperty(editor.view.scrollDOM, "clientHeight", {
      configurable: true,
      value: 200
    });
    vi.spyOn(editor.view, "lineBlockAt").mockReturnValue({
      from: 0,
      length: 10,
      top: 800,
      bottom: 820,
      height: 20,
      type: 0
    });
    list.scrollTop = 143;

    expect(jumpToLine(editor.view, 4)).toBe(true);
    expect(editor.view.state.selection.main.head).toBe(editor.view.state.doc.line(5).from);
    expect(editor.view.scrollDOM.scrollTop).toBe(700);
    expect(list.scrollTop).toBe(143);

    editor.dispose();
    document.body.replaceChildren();
  });
});
