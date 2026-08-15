import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorCore } from "../src/editor/EditorCore";
import {
  canScrollCommentEditorInDirection,
  focusThreadUserPrompt,
  getCommentSummaryInsertionBoundary,
  handleCommentEditorBoundaryKeydown,
  insertCommentSummariesIntoMessages,
  isCommentPanelUserScrollActive,
  mapStoredCommentAnchor,
  moveCommentEditorToBoundary,
  resolveCommentSessionId,
  resolveStoredRangeAnchor,
  runCommentEditorCommand,
  shouldDetachCommentTailFollow,
  shouldContainCommentEditorWheel
} from "../extensions/dev.comments/main.js";
import { applyRoleNavigationSelection } from "../extensions/dev.roles/roles.js";

const originalZion = window.zion;

function setScrollMetrics(element, { scrollHeight, clientHeight }) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: scrollHeight
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: clientHeight
  });
}

describe("comment editor interactions", () => {
  const editors = [];

  afterEach(() => {
    for (const editor of editors.splice(0)) editor.dispose();
    document.body.replaceChildren();
    localStorage.removeItem("zion.comments.threads.v1");
    window.zion = originalZion;
    vi.unstubAllGlobals();
  });

  it("moves to the document boundary without moving the outer comment list", () => {
    const list = document.createElement("div");
    list.className = "zion-comments-list";
    const host = document.createElement("div");
    list.appendChild(host);
    document.body.appendChild(list);

    const editor = new EditorCore(host, "user first\nassistant second\nuser third");
    editors.push(editor);
    setScrollMetrics(editor.view.scrollDOM, { scrollHeight: 900, clientHeight: 240 });
    list.scrollTop = 137;
    editor.view.scrollDOM.scrollTop = 48;
    editor.view.dispatch({ selection: { anchor: 4 } });

    expect(moveCommentEditorToBoundary(editor.view, true, false)).toBe(true);
    expect(editor.view.state.selection.main.head).toBe(editor.view.state.doc.length);
    expect(editor.view.scrollDOM.scrollTop).toBe(660);
    expect(list.scrollTop).toBe(137);

    expect(moveCommentEditorToBoundary(editor.view, false, false)).toBe(true);
    expect(editor.view.state.selection.main.head).toBe(0);
    expect(editor.view.scrollDOM.scrollTop).toBe(0);
    expect(list.scrollTop).toBe(137);
  });

  it("preserves the selection anchor for shifted boundary jumps", () => {
    const list = document.createElement("div");
    list.className = "zion-comments-list";
    const host = document.createElement("div");
    list.appendChild(host);
    document.body.appendChild(list);

    const editor = new EditorCore(host, "user first\nassistant second");
    editors.push(editor);
    setScrollMetrics(editor.view.scrollDOM, { scrollHeight: 600, clientHeight: 200 });
    editor.view.dispatch({ selection: { anchor: 5 } });

    moveCommentEditorToBoundary(editor.view, true, true);

    expect(editor.view.state.selection.main.anchor).toBe(5);
    expect(editor.view.state.selection.main.head).toBe(editor.view.state.doc.length);
  });

  it("captures Cmd+Arrow before native handling and keeps the outer list fixed", () => {
    const list = document.createElement("div");
    list.className = "zion-comments-list";
    const host = document.createElement("div");
    list.appendChild(host);
    document.body.appendChild(list);

    const editor = new EditorCore(host, "user first\nassistant second\nuser third");
    editors.push(editor);
    setScrollMetrics(editor.view.scrollDOM, { scrollHeight: 900, clientHeight: 240 });
    list.scrollTop = 220;
    const event = {
      key: "ArrowDown",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn()
    };

    expect(handleCommentEditorBoundaryKeydown(event, editor.view)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(editor.view.state.selection.main.head).toBe(editor.view.state.doc.length);
    expect(editor.view.scrollDOM.scrollTop).toBe(660);
    expect(list.scrollTop).toBe(220);

    expect(handleCommentEditorBoundaryKeydown({ ...event, key: "ArrowLeft" }, editor.view)).toBe(false);
  });

  it("keeps Option+Arrow role navigation inside the comment editor", () => {
    const list = document.createElement("div");
    list.className = "zion-comments-list";
    const host = document.createElement("div");
    list.appendChild(host);
    document.body.appendChild(list);

    const editor = new EditorCore(host, "user first\nassistant second\nuser third");
    editors.push(editor);
    setScrollMetrics(editor.view.scrollDOM, { scrollHeight: 900, clientHeight: 240 });
    vi.spyOn(editor.view, "lineBlockAt").mockReturnValue({
      from: 0,
      length: 10,
      top: 760,
      bottom: 780,
      height: 20,
      type: 0
    });
    list.scrollTop = 220;
    const target = editor.view.state.doc.line(3).from;

    expect(applyRoleNavigationSelection(editor.view, { anchor: target }, target)).toBe(true);
    expect(editor.view.state.selection.main.head).toBe(target);
    expect(editor.view.scrollDOM.scrollTop).toBe(660);
    expect(list.scrollTop).toBe(220);
  });

  it("keeps comment-specific Option+Arrow commands from scrolling the outer list", () => {
    const list = document.createElement("div");
    list.className = "zion-comments-list";
    const host = document.createElement("div");
    list.appendChild(host);
    document.body.appendChild(list);

    const editor = new EditorCore(host, "user first\nassistant second");
    editors.push(editor);
    list.scrollTop = 160;

    expect(runCommentEditorCommand(editor.view, (view) => {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      list.scrollTop = 480;
      return true;
    })).toBe(true);
    expect(editor.view.state.selection.main.head).toBe(editor.view.state.doc.length);
    expect(list.scrollTop).toBe(160);
  });

  it("contains editor-owned wheel gestures at editor boundaries", () => {
    const scroller = {
      scrollHeight: 800,
      clientHeight: 200,
      scrollTop: 0
    };

    expect(canScrollCommentEditorInDirection(scroller, -40)).toBe(false);
    expect(canScrollCommentEditorInDirection(scroller, 40)).toBe(true);
    expect(shouldContainCommentEditorWheel(scroller, -40)).toBe(true);
    expect(shouldContainCommentEditorWheel(scroller, 40)).toBe(false);

    scroller.scrollTop = 600;
    expect(canScrollCommentEditorInDirection(scroller, 40)).toBe(false);
    expect(canScrollCommentEditorInDirection(scroller, -40)).toBe(true);
    expect(shouldContainCommentEditorWheel(scroller, 40)).toBe(true);
    expect(shouldContainCommentEditorWheel(scroller, -40)).toBe(false);

    scroller.scrollHeight = 200;
    expect(shouldContainCommentEditorWheel(scroller, 40)).toBe(true);
    expect(shouldContainCommentEditorWheel(scroller, 40, true)).toBe(false);
  });

  it("defers automatic panel scrolling while a panel gesture is active", () => {
    const list = document.createElement("div");
    list.__zionUserScrollIntentUntil = 1500;

    expect(isCommentPanelUserScrollActive(list, 1499)).toBe(true);
    expect(isCommentPanelUserScrollActive(list, 1501)).toBe(false);
    expect(isCommentPanelUserScrollActive(null, 1499)).toBe(false);
  });

  it("detaches answer tail-follow only for direct comment-editor scrolling", () => {
    expect(shouldDetachCommentTailFollow("comment-thread-scroll")).toBe(true);
    expect(shouldDetachCommentTailFollow("comment-panel-scroll")).toBe(false);
    expect(shouldDetachCommentTailFollow("comment-panel-wheel")).toBe(false);
    expect(shouldDetachCommentTailFollow("source-viewport-scroll")).toBe(false);
  });

  it("prepares a new comment editor for immediate typing", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    const editor = new EditorCore(host, "");
    editors.push(editor);

    expect(focusThreadUserPrompt(editor.view, { forceFocus: true, schedule: false })).toBe(true);
    expect(editor.view.state.doc.toString()).toBe("user ");
    expect(editor.view.state.selection.main.head).toBe("user ".length);

    focusThreadUserPrompt(editor.view, { forceFocus: true, schedule: false });
    expect(editor.view.state.doc.toString()).toBe("user ");
  });

  it("keeps summaries after assistant tool results", () => {
    const messages = [
      { role: "user", content: "inspect files" },
      {
        role: "assistant",
        content: "I will inspect them",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "list", arguments: "{}" } }]
      },
      { role: "tool", tool_call_id: "call-1", content: "a.ts" },
      { role: "assistant", content: "found one file" }
    ];

    expect(getCommentSummaryInsertionBoundary(messages, 1)).toBe(2);
  });

  it("inserts a comment summary below the matching message and its tool result", () => {
    window.zion = {
      state: {
        get(key) {
          return key === "sessions.currentId" ? "summary-session" : undefined;
        }
      }
    };

    const source = [
      "user inspect files",
      "assistant I will inspect them",
      "assistant found one file"
    ].join("\n");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const editor = new EditorCore(host, source);
    editors.push(editor);
    const anchorText = "I will inspect them";
    const from = source.indexOf(anchorText);
    localStorage.setItem("zion.comments.threads.v1", JSON.stringify([{
      id: "thread-tool",
      sessionId: "summary-session",
      anchorKind: "range",
      from,
      to: from + anchorText.length,
      anchorText,
      summary: "The tool result belongs to this comment."
    }]));
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });

    const messages = [
      { role: "user", content: "inspect files" },
      {
        role: "assistant",
        content: "I will inspect them",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "list", arguments: "{}" } }]
      },
      { role: "tool", tool_call_id: "call-1", content: "a.ts" },
      { role: "assistant", content: "found one file" }
    ];
    const result = insertCommentSummariesIntoMessages(messages, {
      panelId: "panel-summary",
      getView: () => editor.view
    });

    expect(result.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "assistant"
    ]);
    expect(result[3].content).toContain("评论总结：The tool result belongs to this comment.");
  });

  it("uses the scratch editor session instead of the active main panel session", () => {
    const zion = {
      panels: {
        getActivePanelId: () => "panel-main",
        list: () => [{ id: "panel-main", activeTabId: "main-session" }]
      },
      state: {
        get: () => "main-session"
      }
    };

    expect(resolveCommentSessionId({
      panelId: "agents:task-1",
      sessionId: "agent-task:task-1"
    }, zion)).toBe("agent-task:task-1");
  });

  it("relocates a persisted range whose saved coordinates were polluted", () => {
    const doc = "user intro\nassistant target quote\n";
    const expectedFrom = doc.indexOf("target quote");

    expect(resolveStoredRangeAnchor(doc, {
      from: 5,
      to: 10,
      anchorText: "target quote"
    })).toEqual({
      from: expectedFrom,
      to: expectedFrom + "target quote".length,
      relocated: true
    });
  });

  it("marks a range anchor as lost when its complete source text is deleted", () => {
    const text = "before target after";
    const before = EditorState.create({ doc: text });
    const from = text.indexOf("target");
    const transaction = before.update({
      changes: { from, to: from + "target".length, insert: "" }
    });

    expect(mapStoredCommentAnchor({
      from,
      to: from + "target".length,
      anchorKind: "range",
      anchorText: "target"
    }, transaction.changes, before.doc, transaction.state.doc)).toMatchObject({
      from,
      to: from,
      anchorKind: "lost"
    });
  });
});
