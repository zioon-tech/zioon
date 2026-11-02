import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inlineWidgetDecorationsExtension,
  inlineWidgetSourceFacet
} from "../src/editor/inlineWidgets";
import { canMapWysiwygDecorations, wysiwyg } from "../src/editor/wysiwyg";

describe("editor long-document update paths", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    try { view?.destroy(); } catch {}
    host?.remove();
    view = null;
    host = null;
  });

  it("maps card decorations for ordinary typing instead of rebuilding every source", () => {
    const refresh = StateEffect.define<void>();
    const scannedDocumentSizes: number[] = [];
    const buildDecorations = vi.fn((state: EditorState) => {
      state.doc.toString();
      scannedDocumentSizes.push(state.doc.length);
      return [];
    });
    const history = Array.from({ length: 4_000 }, (_, index) => `assistant history ${index}`);
    const state = EditorState.create({
      doc: [
        ...history,
        "assistant response",
        "调用 read <!-- zion-tool:id=tool-1 -->",
        "user keep typing here"
      ].join("\n"),
      extensions: [
        inlineWidgetSourceFacet.of({
          id: "test",
          buildDecorations,
          requiresRebuild: (transaction) =>
            transaction.effects.some((effect) => effect.is(refresh))
        }),
        inlineWidgetDecorationsExtension()
      ]
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({ state, parent: host });

    expect(buildDecorations).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 25; index++) {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "!" }
      });
    }
    expect(buildDecorations).toHaveBeenCalledTimes(1);
    expect(scannedDocumentSizes).toHaveLength(1);

    view.dispatch({ effects: refresh.of() });
    expect(buildDecorations).toHaveBeenCalledTimes(2);

    const anchor = view.state.doc.toString().indexOf("调用 read");
    view.dispatch({
      changes: { from: anchor, to: anchor + 2, insert: "调用" }
    });
    expect(buildDecorations).toHaveBeenCalledTimes(3);
  });

  it("maps WYSIWYG decorations for plain typing transactions that scroll into view", () => {
    let canMap = false;
    const state = EditorState.create({
      doc: [
        "user plain text",
        "assistant previous response"
      ].join("\n"),
      selection: { anchor: "user plain text".length },
      extensions: [
        markdown(),
        wysiwyg(),
        ViewPlugin.fromClass(class {
          update(update) {
            canMap = canMapWysiwygDecorations(update);
          }
        })
      ]
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({ state, parent: host });

    view.dispatch({
      changes: { from: view.state.selection.main.head, insert: "a" },
      selection: { anchor: view.state.selection.main.head + 1 },
      scrollIntoView: true
    });

    expect(canMap).toBe(true);
  });
});
