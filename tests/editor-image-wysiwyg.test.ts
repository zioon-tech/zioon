import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { wysiwyg } from "../src/editor/wysiwyg";

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

describe("WYSIWYG image rendering", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    try { view?.destroy(); } catch {}
    host?.remove();
    view = null;
    host = null;
  });

  function render(source: string, keepActiveLineRendered = true, selection = 0) {
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({
        doc: source,
        selection: { anchor: selection },
        extensions: [markdown(), wysiwyg({ keepActiveLineRendered })]
      }),
      parent: host
    });
    return host;
  }

  it("renders inline, standalone, and consecutive images with distinct density", () => {
    const source = [
      `text ![inline](${PIXEL}) text`,
      "",
      `![solo](${PIXEL})`,
      "",
      `![](${PIXEL})`,
      `![](${PIXEL})`
    ].join("\n");
    const root = render(source);

    expect(root.querySelector(".cm-md-img-wrap-inline")).not.toBeNull();
    expect(root.querySelector(".cm-md-img-wrap-solo")).not.toBeNull();
    expect(root.querySelectorAll(".cm-md-gallery")).toHaveLength(1);
    expect(root.querySelectorAll(".cm-md-gallery-cell")).toHaveLength(2);
  });

  it("reveals grouped source when active-line rendering is disabled", () => {
    const source = [
      "before",
      `![](${PIXEL})`,
      `![](${PIXEL})`
    ].join("\n");
    const selection = source.indexOf("![");
    const root = render(source, false, selection);

    expect(root.querySelector(".cm-md-gallery")).toBeNull();
    expect(root.textContent).toContain("data:image/gif");
  });
});
