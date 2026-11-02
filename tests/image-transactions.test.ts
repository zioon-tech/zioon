import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginImageInsertion,
  completeImageInsertion,
  imageInsertionExtension
} from "../src/editor/image-transactions";

describe("image insertion transactions", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    try { view?.destroy(); } catch {}
    host?.remove();
    view = null;
    host = null;
  });

  function createView(source: string) {
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({
        doc: source,
        extensions: [history(), imageInsertionExtension()]
      }),
      parent: host
    });
    return view;
  }

  it("keeps the document unchanged while an image is loading", () => {
    const editor = createView("before");
    beginImageInsertion(editor, { count: 1, position: 6, kind: "solo" });
    expect(editor.state.doc.toString()).toBe("before");
    expect(editor.dom.querySelector(".cm-image-pending")).not.toBeNull();
  });

  it("maps the insertion anchor through concurrent edits", () => {
    const editor = createView("before");
    const operationId = beginImageInsertion(editor, {
      count: 1,
      position: 6,
      kind: "solo"
    });
    editor.dispatch({ changes: { from: 0, insert: "X" } });

    expect(completeImageInsertion(editor, operationId, [{ src: "app://img/a" }])).toBe(true);
    expect(editor.state.doc.toString()).toBe("Xbefore\n![](app://img/a)");
  });

  it("records the completed insertion as one undoable change", () => {
    const editor = createView("before");
    const operationId = beginImageInsertion(editor, {
      count: 2,
      position: 6,
      kind: "gallery"
    });
    completeImageInsertion(editor, operationId, [
      { src: "app://img/a" },
      { src: "app://img/b" }
    ]);

    expect(editor.state.doc.toString()).toBe(
      "before\n![](app://img/a)\n![](app://img/b)"
    );
    expect(undo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe("before");
  });
});
