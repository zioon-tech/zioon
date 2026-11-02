import { describe, expect, it, vi } from "vitest";
import { EditorCore } from "../src/editor/EditorCore";
import {
  collectUserMessageItemsFromText,
  createChatOverviewRail,
  findAssistantBlockRange,
  jumpToLine
} from "../extensions/dev.langchain-chat/overview-rail.js";
import {
  isConversationViewportFollowing,
  setConversationViewportFollowing
} from "../src/chat/conversation-viewport.js";

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

  it("prefers the completed Run id over a later assistant block", () => {
    const text = [
      "user first",
      "assistant <!-- zion-assistant:id=run-middle --> current answer",
      "user later",
      "assistant <!-- zion-assistant:id=run-later --> later answer"
    ].join("\n");

    expect(findAssistantBlockRange(text, 99, "run-middle")).toEqual({
      headLine: 1,
      endLine: 1,
      lineCount: 4
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

  it("keeps continuation metadata out of user navigation previews", () => {
    const text = [
      "first question",
      "assistant inserted answer",
      "user <!-- zion-continuation:id=run-middle -->",
      "preserved suffix"
    ].join("\n");

    expect(findAssistantBlockRange(text, 1)).toEqual({
      headLine: 1,
      endLine: 1,
      lineCount: 4
    });
    expect(collectUserMessageItemsFromText(text)).toEqual([
      { line: 0, endLine: 0, index: 1, preview: "first question" },
      { line: 3, endLine: 3, index: 2, preview: "preserved suffix" }
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

  it("uses the streaming pending tail instead of the document bottom for latest", async () => {
    const previousZion = window.zion;
    const values = new Map();
    window.zion = {
      state: {
        get: (key) => values.get(key),
        set: (key, value) => values.set(key, value),
        onDidChange: () => ({ dispose() {} })
      },
      events: {
        on: () => ({ dispose() {} })
      },
      panels: {
        list: () => [{
          id: "panel-overview",
          activeTabId: "session-overview"
        }]
      }
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const editor = new EditorCore(
      host,
      [
        "user first",
        "assistant <!-- zion-assistant:id=run-middle --> ",
        "user later",
        "assistant <!-- zion-assistant:id=run-later --> later answer"
      ].join("\n"),
      "panel-overview"
    );
    editor.setSessionId("session-overview");
    window.zion.state.set("chat.runs.session-overview", {
      runId: "run-middle",
      streaming: true
    });

    const pending = document.createElement("span");
    pending.className = "zion-pending-assistant-output";
    pending.dataset.runId = "run-middle";
    const tail = document.createElement("span");
    tail.className = "zion-pending-assistant-tail";
    pending.appendChild(tail);
    editor.view.dom.appendChild(pending);

    Object.defineProperty(editor.view.scrollDOM, "scrollHeight", {
      configurable: true,
      value: 1_000
    });
    Object.defineProperty(editor.view.scrollDOM, "clientHeight", {
      configurable: true,
      value: 200
    });
    Object.defineProperty(editor.view.scrollDOM, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0, bottom: 200 })
    });
    Object.defineProperty(tail, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 350, bottom: 500 })
    });

    const rail = createChatOverviewRail({
      panelId: "panel-overview",
      getView: () => editor.view,
      getSessionId: () => "session-overview",
      addVisualExtension: (extension) =>
        editor.addExternalExtension(extension)
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const latest = editor.view.dom.querySelector(".zion-chat-overview-nav-latest");
      latest.click();

      expect(editor.view.scrollDOM.scrollTop).toBe(348);
      expect(editor.view.scrollDOM.scrollTop).not.toBe(800);

      pending.remove();
      window.zion.state.set("chat.runs.session-overview", {
        runId: "run-middle",
        streaming: false
      });
      window.zion.state.set(
        "chat.assistantBlockId.session-overview",
        "run-middle"
      );
      window.zion.state.set("chat.answerHeadLine.session-overview", 99);
      const lineBlockAt = vi.spyOn(editor.view, "lineBlockAt");
      latest.click();

      expect(lineBlockAt).toHaveBeenCalledWith(
        editor.view.state.doc.line(2).to
      );
    } finally {
      rail.dispose();
      editor.dispose();
      document.body.replaceChildren();
      window.zion = previousZion;
    }
  });

  it("keeps follow enabled after programmatic scroll and restores it from latest", async () => {
    const previousZion = window.zion;
    const values = new Map();
    window.zion = {
      state: {
        get: (key) => values.get(key),
        set: (key, value) => values.set(key, value),
        onDidChange: () => ({ dispose() {} })
      },
      events: {
        on: () => ({ dispose() {} })
      },
      panels: {
        list: () => [{
          id: "panel-follow",
          activeTabId: "session-follow"
        }]
      }
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const editor = new EditorCore(
      host,
      "user question\nassistant <!-- zion-assistant:id=run-follow --> answer",
      "panel-follow"
    );
    editor.setSessionId("session-follow");
    values.set("chat.runs.session-follow", {
      runId: "run-follow",
      streaming: true
    });
    values.set("chat.assistantBlockId.session-follow", "run-follow");
    Object.defineProperty(editor.view.scrollDOM, "scrollHeight", {
      configurable: true,
      value: 1_000
    });
    Object.defineProperty(editor.view.scrollDOM, "clientHeight", {
      configurable: true,
      value: 200
    });

    const rail = createChatOverviewRail({
      panelId: "panel-follow",
      getView: () => editor.view,
      getSessionId: () => "session-follow",
      addVisualExtension: (extension) =>
        editor.addExternalExtension(extension)
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      editor.view.scrollDOM.scrollTop = 100;
      editor.view.scrollDOM.dispatchEvent(new Event("scroll"));
      expect(isConversationViewportFollowing(editor.view, {
        sessionId: "session-follow",
        state: window.zion.state
      })).toBe(true);

      editor.view.scrollDOM.dispatchEvent(new Event("wheel"));
      expect(isConversationViewportFollowing(editor.view, {
        sessionId: "session-follow",
        state: window.zion.state
      })).toBe(false);

      editor.view.dom
        .querySelector(".zion-chat-overview-nav-latest")
        .click();
      editor.view.scrollDOM.__zionProgrammaticScrollUntil = 0;
      editor.view.scrollDOM.dispatchEvent(new Event("scroll"));
      expect(isConversationViewportFollowing(editor.view, {
        sessionId: "session-follow",
        state: window.zion.state
      })).toBe(true);
    } finally {
      rail.dispose();
      editor.dispose();
      document.body.replaceChildren();
      window.zion = previousZion;
    }
  });

  it("restores persistent follow after a double Option tap", async () => {
    const previousZion = window.zion;
    const values = new Map();
    window.zion = {
      state: {
        get: (key) => values.get(key),
        set: (key, value) => values.set(key, value),
        onDidChange: () => ({ dispose() {} })
      },
      events: {
        on: () => ({ dispose() {} })
      },
      panels: {
        list: () => [{
          id: "panel-option-follow",
          activeTabId: "session-option-follow"
        }]
      }
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const editor = new EditorCore(
      host,
      "user question\nassistant <!-- zion-assistant:id=run-option --> answer",
      "panel-option-follow"
    );
    editor.setSessionId("session-option-follow");
    values.set("chat.runs.session-option-follow", {
      runId: "run-option",
      streaming: true
    });
    values.set("chat.assistantBlockId.session-option-follow", "run-option");
    Object.defineProperty(editor.view.scrollDOM, "scrollHeight", {
      configurable: true,
      value: 1_000
    });
    Object.defineProperty(editor.view.scrollDOM, "clientHeight", {
      configurable: true,
      value: 200
    });

    const rail = createChatOverviewRail({
      panelId: "panel-option-follow",
      getView: () => editor.view,
      getSessionId: () => "session-option-follow",
      addVisualExtension: (extension) =>
        editor.addExternalExtension(extension)
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      setConversationViewportFollowing(editor.view, false, {
        sessionId: "session-option-follow",
        state: window.zion.state
      });
      editor.view.contentDOM.focus();
      expect(editor.view.dom.contains(document.activeElement)).toBe(true);
      for (let count = 0; count < 2; count += 1) {
        window.dispatchEvent(new window.KeyboardEvent("keydown", {
          key: "Alt",
          code: "AltLeft"
        }));
        window.dispatchEvent(new window.KeyboardEvent("keyup", {
          key: "Alt",
          code: "AltLeft"
        }));
      }
      editor.view.scrollDOM.__zionProgrammaticScrollUntil = 0;
      editor.view.scrollDOM.dispatchEvent(new Event("scroll"));

      expect(isConversationViewportFollowing(editor.view, {
        sessionId: "session-option-follow",
        state: window.zion.state
      })).toBe(true);
    } finally {
      rail.dispose();
      editor.dispose();
      document.body.replaceChildren();
      window.zion = previousZion;
    }
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
