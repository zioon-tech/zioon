import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { activate as activateComments } from "../extensions/dev.comments/main.js";
import {
  applyInspectorMarkdownCommentRanges,
  getInspectorMarkdownSelection,
  renderInspectorMarkdown
} from "../src/ui/workbench/inspectorContent";
import { initWorkbench } from "../src/ui/workbench/workbench";
import {
  bindWorkbenchCore,
  getInspectorTextSessionId,
  inspectorRuntime
} from "../src/ui/workbench/runtime";

const originalZion = window.zion;
const originalRangeClientRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalRangeBoundingRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
const originalElementFromPoint = Object.getOwnPropertyDescriptor(document, "elementFromPoint");

function bindInspectorState() {
  const values = new Map<string, unknown>();
  bindWorkbenchCore({
    state: {
      get: <T = unknown>(key: string) => values.get(key) as T | undefined,
      set: <T = unknown>(key: string, value: T) => {
        values.set(key, value);
      },
      update: <T = unknown>(key: string, updater: (value: T | undefined) => T) => {
        values.set(key, updater(values.get(key) as T | undefined));
      },
      onDidChange: () => ({ dispose() {} })
    },
    events: {
      emit: () => {},
      on: () => ({ dispose() {} })
    }
  });
}

describe("Inspector comment sources", () => {
  beforeEach(() => {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [new DOMRect(20, 30, 80, 18)]
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(20, 30, 80, 18)
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => document.body
    });
  });

  afterEach(() => {
    for (const item of inspectorRuntime.getItems()) inspectorRuntime.close(item.id);
    document.body.replaceChildren();
    localStorage.removeItem("zion.comments.threads.v1");
    window.zion = originalZion;
    vi.restoreAllMocks();
    if (originalRangeClientRects) Object.defineProperty(Range.prototype, "getClientRects", originalRangeClientRects);
    else delete (Range.prototype as any).getClientRects;
    if (originalRangeBoundingRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRangeBoundingRect);
    else delete (Range.prototype as any).getBoundingClientRect;
    if (originalElementFromPoint) Object.defineProperty(document, "elementFromPoint", originalElementFromPoint);
    else delete (document as any).elementFromPoint;
  });

  it("uses a stable file session independent of the transient item title", () => {
    const first = getInspectorTextSessionId({
      id: "files:preview-1",
      ownerId: "dev.tools.files",
      path: "/workspace/src/main.ts",
      displayPath: "src/main.ts"
    });
    const reopened = getInspectorTextSessionId({
      id: "files:preview-2",
      ownerId: "dev.tools.files",
      path: "/workspace/src/main.ts",
      displayPath: "renamed tab"
    });

    expect(reopened).toBe(first);
    expect(first).toContain("inspector-file:dev.tools.files:");
  });

  it("registers Inspector editors by both item and session and routes reveal requests", () => {
    bindInspectorState();
    inspectorRuntime.open({
      id: "source-file",
      ownerId: "test",
      title: "source.ts",
      path: "/workspace/source.ts",
      file: { kind: "text", content: "const value = 1;" }
    });
    const view = {};
    const editor = {
      sessionId: getInspectorTextSessionId(inspectorRuntime.getActiveItem()!),
      getView: () => view
    };
    const attached = inspectorRuntime.attachTextEditor("source-file", editor);
    const reveal = inspectorRuntime.setTextRevealHandler((itemId, options) => ({ itemId, options }));

    expect(inspectorRuntime.getTextEditor("source-file")).toBe(editor);
    expect(inspectorRuntime.getTextEditor(editor.sessionId)).toBe(editor);
    expect(inspectorRuntime.getTextEditorForView(view)).toBe(editor);
    expect(inspectorRuntime.getTextSource(editor.sessionId)).toMatchObject({
      sessionId: editor.sessionId,
      content: "const value = 1;"
    });
    expect(inspectorRuntime.revealText("source-file", { from: 6, to: 11 })).toEqual({
      itemId: "source-file",
      options: { from: 6, to: 11 }
    });
    expect(inspectorRuntime.revealText(editor.sessionId, { from: 0, to: 5 })).toEqual({
      itemId: "source-file",
      options: { from: 0, to: 5 }
    });

    reveal.dispose();
    attached.dispose();
    expect(inspectorRuntime.getTextEditor("source-file")).toBeNull();
  });

  it("maps a Markdown preview selection back to source character offsets", () => {
    const content = "# Heading\n\nRead the **target text** before commenting.\n";
    const host = document.createElement("div");
    document.body.appendChild(host);
    const article = renderInspectorMarkdown(host, content);
    const target = Array.from(article.querySelectorAll<HTMLElement>(".zion-inspector-markdown-source-text"))
      .find((node) => node.textContent === "target text");
    expect(target?.firstChild).toBeInstanceOf(Text);

    const range = document.createRange();
    range.setStart(target!.firstChild!, 0);
    range.setEnd(target!.firstChild!, "target text".length);
    Object.defineProperty(range, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(10, 20, 80, 18)
    });
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range
    } as unknown as Selection;

    const mapped = getInspectorMarkdownSelection(article, content, selection);

    expect(mapped).toMatchObject({
      from: content.indexOf("target text"),
      to: content.indexOf("target text") + "target text".length,
      selectionText: "target text"
    });
  });

  it("maps stored comment anchors back onto the Markdown preview", () => {
    const content = "# Heading\n\nRead the **target text** before commenting.\n";
    const host = document.createElement("div");
    document.body.appendChild(host);
    const article = renderInspectorMarkdown(host, content);
    const from = content.indexOf("target text");
    const onActivate = vi.fn();

    applyInspectorMarkdownCommentRanges(article, [{
      id: "comment-1",
      from,
      to: from + "target text".length,
      active: true
    }], onActivate);

    const mark = article.querySelector<HTMLElement>(".zion-comment-range[data-comment-id='comment-1']");
    expect(mark?.textContent).toBe("target text");
    expect(mark?.classList.contains("is-active")).toBe(true);
    mark?.click();
    expect(onActivate).toHaveBeenCalledWith("comment-1");
  });

  it("creates Inspector comments under the file session instead of the active chat", async () => {
    let selectionItem: any = null;
    const state = new Map<string, unknown>();
    const disposables = { registerCommand: () => ({ dispose() {} }) };
    const source = "const selectedValue = 42;\n";
    const selectedText = "selectedValue";
    const from = source.indexOf(selectedText);
    const editorState = EditorState.create({ doc: source });
    const view = {
      state: editorState,
      dom: document.createElement("div"),
      dispatch: () => {}
    };
    const editor = {
      panelId: "inspector",
      sessionId: "inspector-file:test:%2Fworkspace%2Fsource.ts",
      sourceKind: "inspector",
      inspectorItemId: "source-file",
      sourcePath: "/workspace/source.ts",
      sourceTitle: "source.ts",
      getView: () => view
    };
    window.zion = {
      commands: disposables,
      state: {
        get: (key: string) => state.get(key),
        set: (key: string, value: unknown) => state.set(key, value),
        onDidChange: () => ({ dispose() {} })
      },
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      },
      editor: {
        getEditorForView: (candidate: unknown) => candidate === view ? editor : null,
        selectionToolbar: {
          registerItem: (item: any) => {
            selectionItem = item;
            return { dispose() {} };
          }
        },
        registerDecorator: () => ({ dispose() {} })
      },
      menus: { register: () => ({ dispose() {} }) },
      auxiliaryBar: {
        activateView: () => {},
        registerView: () => ({ dispose() {} })
      },
      inspector: {
        registerTextEditorDecorator: () => ({ dispose() {} })
      },
      activityBar: { registerItem: () => ({ dispose() {} }) },
      window: { activeEditor: null },
      notification: { show: () => {} }
    } as any;
    const activated = await activateComments({ subscriptions: [] });

    expect(selectionItem).toBeTruthy();
    selectionItem.run({
      view,
      sourceKind: "inspector",
      selectionText: selectedText,
      from,
      to: from + selectedText.length
    });

    const threads = JSON.parse(localStorage.getItem("zion.comments.threads.v1") || "[]");
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      sessionId: editor.sessionId,
      parentSessionId: editor.sessionId,
      panelId: "inspector",
      sourceKind: "inspector",
      sourceItemId: "source-file",
      sourcePath: "/workspace/source.ts",
      anchorText: selectedText
    });

    activated?.dispose?.();
  });

  it("creates Markdown preview comments directly without revealing source", async () => {
    let selectionItem: any = null;
    const revealText = vi.fn();
    const commands = new Map<string, (...args: any[]) => any>();
    window.zion = {
      commands: {
        registerCommand: (id: string, handler: (...args: any[]) => any) => {
          commands.set(id, handler);
          return { dispose: () => commands.delete(id) };
        }
      },
      state: {
        get: () => undefined,
        set: () => {},
        onDidChange: () => ({ dispose() {} })
      },
      events: {
        emit: () => {},
        on: () => ({ dispose() {} })
      },
      editor: {
        selectionToolbar: {
          registerItem: (item: any) => {
            selectionItem = item;
            return { dispose() {} };
          }
        },
        registerDecorator: () => ({ dispose() {} })
      },
      menus: { register: () => ({ dispose() {} }) },
      auxiliaryBar: {
        activateView: () => {},
        registerView: () => ({ dispose() {} })
      },
      inspector: {
        revealText,
        registerTextEditorDecorator: () => ({ dispose() {} })
      },
      activityBar: { registerItem: () => ({ dispose() {} }) },
      window: { activeEditor: null },
      notification: { show: () => {} }
    } as any;
    const activated = await activateComments({ subscriptions: [] });
    const sourceText = "# Notes\n\nComment this rendered phrase.\n";
    const selectionText = "rendered phrase";
    const from = sourceText.indexOf(selectionText);

    selectionItem.run({
      view: null,
      sourceKind: "inspector",
      inspectorItemId: "notes-file",
      sourceSessionId: "inspector-file:test:%2Fworkspace%2Fnotes.md",
      sourcePath: "/workspace/notes.md",
      sourceTitle: "notes.md",
      sourceText,
      selectionText,
      from,
      to: from + selectionText.length
    });

    const threads = JSON.parse(localStorage.getItem("zion.comments.threads.v1") || "[]");
    expect(revealText).not.toHaveBeenCalled();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      sessionId: "inspector-file:test:%2Fworkspace%2Fnotes.md",
      sourceKind: "inspector",
      sourceItemId: "notes-file",
      sourcePath: "/workspace/notes.md",
      anchorText: selectionText,
      from,
      to: from + selectionText.length
    });
    expect(commands.get("comments.getSourceAnchors")?.({
      sessionId: "inspector-file:test:%2Fworkspace%2Fnotes.md",
      sourceText
    })).toEqual([{
      id: threads[0].id,
      from,
      to: from + selectionText.length,
      active: false
    }]);

    activated?.dispose?.();
  });

  it.each([
    ["TypeScript", "source.ts", "typescript", "const selectedValue = 42;", "selectedValue"],
    ["JSON", "config.json", "json", "{\"selectedValue\": 42}", "selectedValue"],
    ["plain text", "notes.txt", "text", "before selected value after", "selected value"]
  ])("shows the comment toolbar for a read-only %s preview", async (_label, title, language, content, selectedText) => {
    bindInspectorState();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    window.zion = {
      editor: {},
      events: { emit: () => {} },
      state: {
        get: () => undefined,
        set: () => {}
      }
    } as any;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const workbench = initWorkbench(host);
    inspectorRuntime.open({
      id: `preview:${title}`,
      ownerId: "test",
      title,
      path: `/workspace/${title}`,
      language,
      file: { kind: "text", content }
    });
    const editor = inspectorRuntime.getTextEditor(`preview:${title}`);
    const view = editor?.getView?.();
    expect(view).toBeTruthy();
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("true");
    expect(view.contentDOM.getAttribute("aria-readonly")).toBe("true");
    const item = window.zion.editor.selectionToolbar!.registerItem({
      id: "comments.create",
      title: "评论",
      label: "评论",
      codicon: "comment-discussion",
      when: (context: any) => context.sourceKind === "inspector"
    });
    const from = content.indexOf(selectedText);

    view.focus();
    view.dispatch({ selection: { anchor: from, head: from + selectedText.length } });
    await new Promise((resolve) => setTimeout(resolve, 180));

    const toolbar = document.querySelector(".zion-inspector-editor-host .zion-selection-toolbar.is-visible");
    const button = toolbar?.querySelector("button");
    expect(toolbar?.querySelector(".zion-selection-toolbar-items")).toBeTruthy();
    expect(button?.className).toBe("zion-selection-toolbar-btn");
    expect(button?.getAttribute("aria-label")).toBe("评论");
    expect(button?.querySelector(".codicon.codicon-comment-discussion")).toBeTruthy();
    expect(button?.querySelector(".zion-icon")).toBeNull();

    item.dispose();
    workbench.dispose();
  });

  it("keeps Markdown preview open when invoking its comment action", async () => {
    bindInspectorState();
    let actionContext: any = null;
    window.zion = {
      editor: {
        selectionToolbar: {
          list: () => [{
            id: "comments.create",
            title: "评论",
            label: "评论",
            codicon: "comment-discussion",
            when: (context: any) => !!context.selectionText,
            run: (context: any) => {
              actionContext = context;
            }
          }],
          onDidChange: () => ({ dispose() {} })
        }
      },
      events: { emit: () => {} }
    } as any;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const workbench = initWorkbench(host);
    const content = "# Notes\n\nSelect this target phrase.\n";
    inspectorRuntime.open({
      id: "markdown-file",
      ownerId: "test",
      title: "notes.md",
      path: "/workspace/notes.md",
      language: "markdown",
      file: { kind: "text", content }
    });
    const target = Array.from(document.querySelectorAll<HTMLElement>(".zion-inspector-markdown-source-text"))
      .find((node) => node.textContent?.includes("target phrase"));
    const text = target?.firstChild;
    expect(text).toBeInstanceOf(Text);
    const start = text!.textContent!.indexOf("target phrase");
    const range = document.createRange();
    range.setStart(text!, start);
    range.setEnd(text!, start + "target phrase".length);
    Object.defineProperty(range, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(30, 40, 90, 18)
    });
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    target!.dispatchEvent(new Event("pointerup", { bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 120));
    const button = document.querySelector<HTMLButtonElement>(".zion-inspector-selection-toolbar button");
    expect(button).toBeTruthy();
    expect(button?.closest(".zion-selection-toolbar-items")).toBeTruthy();
    expect(button?.className).toBe("zion-selection-toolbar-btn");
    expect(button?.querySelector(".codicon.codicon-comment-discussion")).toBeTruthy();
    expect(button?.querySelector(".zion-icon")).toBeNull();
    button!.click();

    expect(actionContext).toMatchObject({
      sourceKind: "inspector",
      inspectorItemId: "markdown-file",
      sourceSessionId: getInspectorTextSessionId(inspectorRuntime.getActiveItem()!),
      sourceText: content,
      selectionText: "target phrase"
    });
    expect(document.querySelector(".zion-inspector-markdown")).toBeTruthy();
    expect(document.querySelector(".zion-inspector-editor-host .cm-editor")).toBeFalsy();

    const previewEditor = inspectorRuntime.revealText("markdown-file", {
      from: content.indexOf("target phrase"),
      to: content.indexOf("target phrase") + "target phrase".length,
      focus: false
    });
    expect(previewEditor?.sourceViewKind).toBe("preview");
    expect(document.querySelector(".zion-inspector-markdown")).toBeTruthy();
    expect(document.querySelector(".zion-inspector-editor-host .cm-editor")).toBeFalsy();

    workbench.dispose();
  });
});
