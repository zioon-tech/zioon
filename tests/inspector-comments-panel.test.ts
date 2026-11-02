import { EditorState } from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activate as activateComments } from "../extensions/dev.comments/main.js";

const originalZion = window.zion;

describe("Inspector comments panel anchors", () => {
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.removeItem("zion.comments.threads.v1");
    window.zion = originalZion;
  });

  it("does not mark a Markdown preview comment as lost", async () => {
    const sourceText = "# Daily report\n\nThe selected preview text is still anchored.\n";
    const selectionText = "selected preview text";
    const from = sourceText.indexOf(selectionText);
    const sessionId = "inspector-file:test:%2Fworkspace%2Freport.md";
    localStorage.setItem("zion.comments.threads.v1", JSON.stringify([{
      id: "markdown-comment",
      sessionId,
      parentSessionId: sessionId,
      threadSessionId: "comment:markdown-comment",
      panelId: "inspector",
      sourceKind: "inspector",
      sourceItemId: "report-file",
      sourcePath: "/workspace/report.md",
      sourceTitle: "report.md",
      anchorKind: "range",
      from,
      to: from + selectionText.length,
      startLine: 2,
      endLine: 2,
      anchorText: selectionText,
      quote: selectionText,
      resolved: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }]));

    const state = new Map<string, unknown>();
    const commands = new Map<string, (...args: any[]) => any>();
    const eventHandlers = new Map<string, Set<(payload: any) => void>>();
    let commentsView: any = null;
    const emit = (topic: string, payload?: any) => {
      for (const handler of eventHandlers.get(topic) || []) handler(payload);
    };
    window.zion = {
      commands: {
        registerCommand: (id: string, handler: (...args: any[]) => any) => {
          commands.set(id, handler);
          return { dispose: () => commands.delete(id) };
        },
        executeCommand: (id: string, ...args: any[]) => commands.get(id)?.(...args)
      },
      state: {
        get: (key: string) => state.get(key),
        set: (key: string, value: unknown) => {
          state.set(key, value);
        },
        onDidChange: () => ({ dispose() {} })
      },
      events: {
        emit,
        on: (topic: string, handler: (payload: any) => void) => {
          const handlers = eventHandlers.get(topic) || new Set();
          handlers.add(handler);
          eventHandlers.set(topic, handlers);
          return { dispose: () => handlers.delete(handler) };
        }
      },
      editor: {
        selectionToolbar: { registerItem: () => ({ dispose() {} }) },
        registerDecorator: () => ({ dispose() {} })
      },
      menus: { register: () => ({ dispose() {} }) },
      auxiliaryBar: {
        activateView: () => {},
        registerView: (view: any) => {
          commentsView = view;
          return { dispose() {} };
        }
      },
      inspector: {
        getTextEditor: () => null,
        getTextSource: () => ({
          sessionId,
          content: sourceText,
          item: {
            id: "report-file",
            title: "report.md",
            path: "/workspace/report.md"
          }
        }),
        registerTextEditorDecorator: () => ({ dispose() {} })
      },
      activityBar: { registerItem: () => ({ dispose() {} }) },
      panels: { list: () => [] },
      chat: { isStreaming: () => false },
      window: { activeEditor: null },
      notification: { show: () => {} }
    } as any;

    const activated = await activateComments({ subscriptions: [] });
    emit("ui/inspectorTextSourceActivated", {
      itemId: "report-file",
      sessionId,
      editor: null
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const rendered = commentsView.component.render(host);

    const row = host.querySelector(".zion-comments-row[data-thread-id='markdown-comment']");
    expect(row).toBeTruthy();
    expect(row?.classList.contains("is-orphan")).toBe(false);
    expect(row?.querySelector(".zion-comments-state-badge.is-lost")).toBeNull();

    rendered?.dispose?.();
    activated?.dispose?.();
  });

  it("synchronizes Markdown preview and comments panel scrolling in both directions", async () => {
    const sourceText = Array.from({ length: 80 }, (_, index) => `Line ${index + 1}`).join("\n");
    const selectionText = "Line 40";
    const from = sourceText.indexOf(selectionText);
    const sessionId = "inspector-file:test:%2Fworkspace%2Flong-report.md";
    localStorage.setItem("zion.comments.threads.v1", JSON.stringify([{
      id: "scroll-comment",
      sessionId,
      parentSessionId: sessionId,
      threadSessionId: "comment:scroll-comment",
      panelId: "inspector",
      sourceKind: "inspector",
      sourceItemId: "long-report-file",
      sourcePath: "/workspace/long-report.md",
      sourceTitle: "long-report.md",
      anchorKind: "range",
      from,
      to: from + selectionText.length,
      startLine: 39,
      endLine: 39,
      anchorText: selectionText,
      quote: selectionText,
      resolved: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }]));

    const sourceScroller = document.createElement("div");
    Object.defineProperties(sourceScroller, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 300 }
    });
    sourceScroller.getBoundingClientRect = () => new DOMRect(0, 0, 500, 300);
    const sourceState = EditorState.create({ doc: sourceText });
    const sourceView = {
      state: sourceState,
      scrollDOM: sourceScroller,
      viewport: { from: 0, to: sourceText.length },
      lineBlockAt: () => ({ top: 500, bottom: 520, height: 20 }),
      coordsAtPos: () => new DOMRect(20, 160, 60, 20),
      dispatch: (spec: any) => {
        if (spec?.scrollIntoView) sourceScroller.scrollTop = 434;
      },
      focus: () => {}
    };
    const sourceEditor = {
      panelId: "inspector",
      sessionId,
      sourceKind: "inspector",
      sourceViewKind: "preview",
      inspectorItemId: "long-report-file",
      getView: () => sourceView
    };
    const state = new Map<string, unknown>();
    const commands = new Map<string, (...args: any[]) => any>();
    const eventHandlers = new Map<string, Set<(payload: any) => void>>();
    const revealText = vi.fn();
    let commentsView: any = null;
    const emit = (topic: string, payload?: any) => {
      for (const handler of eventHandlers.get(topic) || []) handler(payload);
    };
    window.zion = {
      commands: {
        registerCommand: (id: string, handler: (...args: any[]) => any) => {
          commands.set(id, handler);
          return { dispose: () => commands.delete(id) };
        },
        executeCommand: (id: string, ...args: any[]) => commands.get(id)?.(...args)
      },
      state: {
        get: (key: string) => state.get(key),
        set: (key: string, value: unknown) => state.set(key, value),
        onDidChange: () => ({ dispose() {} })
      },
      events: {
        emit,
        on: (topic: string, handler: (payload: any) => void) => {
          const handlers = eventHandlers.get(topic) || new Set();
          handlers.add(handler);
          eventHandlers.set(topic, handlers);
          return { dispose: () => handlers.delete(handler) };
        }
      },
      editor: {
        selectionToolbar: { registerItem: () => ({ dispose() {} }) },
        registerDecorator: () => ({ dispose() {} })
      },
      menus: { register: () => ({ dispose() {} }) },
      auxiliaryBar: {
        activateView: () => {},
        registerView: (view: any) => {
          commentsView = view;
          return { dispose() {} };
        }
      },
      inspector: {
        getTextEditor: () => sourceEditor,
        revealText,
        getTextSource: () => ({
          sessionId,
          content: sourceText,
          item: {
            id: "long-report-file",
            title: "long-report.md",
            path: "/workspace/long-report.md"
          }
        }),
        registerTextEditorDecorator: () => ({ dispose() {} })
      },
      activityBar: { registerItem: () => ({ dispose() {} }) },
      panels: { list: () => [] },
      chat: { isStreaming: () => false },
      window: { activeEditor: null },
      notification: { show: () => {} }
    } as any;

    const activated = await activateComments({ subscriptions: [] });
    emit("ui/inspectorTextSourceActivated", {
      itemId: "long-report-file",
      sessionId,
      editor: sourceEditor
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const rendered = commentsView.component.render(host);
    const list = host.querySelector<HTMLElement>(".zion-comments-list")!;
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 300 }
    });

    sourceScroller.scrollTop = 140;
    window.dispatchEvent(new CustomEvent("zion:comments-viewport-changed", {
      detail: { panelId: "inspector", sessionId }
    }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(list.scrollTop).toBe(140);

    await new Promise((resolve) => setTimeout(resolve, 200));
    list.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 60 }));
    list.scrollTop = 200;
    list.dispatchEvent(new Event("scroll"));
    expect(sourceScroller.scrollTop).toBe(200);

    const row = list.querySelector<HTMLElement>(".zion-comments-row[data-thread-id='scroll-comment']")!;
    row.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(revealText).not.toHaveBeenCalled();
    expect(sourceScroller.scrollTop).toBe(434);

    rendered?.dispose?.();
    activated?.dispose?.();
  });
});
