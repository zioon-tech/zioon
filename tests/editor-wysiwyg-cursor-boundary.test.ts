import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { getRenderedLineVisibleCursorPos, wysiwyg } from "../src/editor/wysiwyg";

describe("WYSIWYG rendered cursor boundaries", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    try { view?.destroy(); } catch {}
    host?.remove();
    view = null;
    host = null;
  });

  function render(source: string, selection = 0) {
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({
        doc: source,
        selection: { anchor: selection },
        extensions: [markdown(), wysiwyg({ keepActiveLineRendered: true })]
      }),
      parent: host
    });
    return { root: host, view };
  }

  it("keeps rendered content boundaries out of caret-safe marker styling", () => {
    const source = "**bold**";
    const { root, view } = render(source, 2);

    expect(root.querySelector(".cm-z-caret-visible-syntax")).toBeNull();

    view.dispatch({ selection: { anchor: 6 } });

    expect(root.querySelector(".cm-z-caret-visible-syntax")).toBeNull();
  });

  it("keeps hidden paired markdown markers caret-safe only inside marker source", () => {
    const source = "**bold**";
    const { root, view } = render(source, 1);

    expect(root.querySelector(".cm-z-caret-visible-syntax")?.textContent).toBe("**");

    view.dispatch({ selection: { anchor: 7 } });

    const guards = [...root.querySelectorAll(".cm-z-caret-visible-syntax")];
    expect(guards.map((node) => node.textContent)).toContain("**");
  });

  it("does not add caret-safe marker styling for non-empty selections", () => {
    const source = "**bold**";
    const { root, view } = render(source, 4);

    view.dispatch({ selection: { anchor: 0, head: 4 } });

    expect(view.state.selection.main.empty).toBe(false);
    expect(root.querySelector(".cm-z-caret-visible-syntax")).toBeNull();
  });

  it("reveals atomic rendered source while the cursor is inside its source range", () => {
    const source = "[label](https://example.com)\nplain";
    const { root, view } = render(source, source.length);

    expect(root.querySelector("a.cm-md-link")).not.toBeNull();

    view.dispatch({ selection: { anchor: 0 } });

    expect(root.querySelector("a.cm-md-link")).toBeNull();
    expect(root.textContent).toContain("[label](https://example.com)");
  });

  it("maps rendered line start past stacked heading and inline markers", () => {
    const source = "# **Title**";
    const { view } = render(source, source.length);

    expect(getRenderedLineVisibleCursorPos(view, 1)).toBe(source.indexOf("Title"));
  });

  it("maps rendered line start past quote markers", () => {
    const source = "> hello";
    const { view } = render(source, source.length);

    expect(getRenderedLineVisibleCursorPos(view, 1)).toBe(source.indexOf("hello"));
  });

  it("maps rendered line start past stacked quote and inline markers", () => {
    const source = "> **hello**";
    const { view } = render(source, source.length);

    expect(getRenderedLineVisibleCursorPos(view, 1)).toBe(source.indexOf("hello"));
  });

  it("maps rendered line start past list markers", () => {
    const source = "- hello";
    const { view } = render(source, source.length);

    expect(getRenderedLineVisibleCursorPos(view, 1)).toBe(source.indexOf("hello"));
  });

  it("keeps active line rendered when inline code contains markdown delimiters", () => {
    const source = "1. QA uses `self._aclient.responses.create(**kwargs)` and **bold** text";
    const { view } = render(source, source.indexOf("kwargs"));

    expect(getRenderedLineVisibleCursorPos(view, 1)).toBe(source.indexOf("QA"));
  });

  it("does not let intraword underscores hide later inline markdown", () => {
    const source = "1. **超时不重试是刻意设计，且已有开关**：`timeout_retry_times` 默认 0（vlm_client.py:125），而且 parser.py:1829-1832 会从**每个请求的配置**里读 `request_timeout_seconds` / `timeout_retry_times` 覆盖默认值——**不用改代码，请求参数就能治**：比如 `request_timeout_seconds=90, timeout_retry_times=1`。";
    const { root } = render(source, source.length);

    expect([...root.querySelectorAll(".cm-md-strong")].map((node) => node.textContent)).toEqual([
      "超时不重试是刻意设计，且已有开关",
      "每个请求的配置",
      "不用改代码，请求参数就能治"
    ]);
    expect([...root.querySelectorAll(".cm-md-code")].map((node) => node.textContent)).toEqual([
      "timeout_retry_times",
      "request_timeout_seconds",
      "timeout_retry_times",
      "request_timeout_seconds=90, timeout_retry_times=1"
    ]);
  });

  it("keeps list line layout while the list marker is selected", () => {
    const source = "1. **bold** text";
    const { root, view } = render(source, source.length);

    expect(root.querySelector(".cm-line")?.className).toContain("cm-md-list-line");
    expect(root.querySelector(".cm-md-ol-num")?.textContent).toBe("1.\u00a0");

    view.dispatch({ selection: { anchor: 0, head: source.length } });

    expect(root.querySelector(".cm-line")?.className).toContain("cm-md-list-line");
    expect(root.querySelector(".cm-md-ol-num")?.textContent).toBe("1.\u00a0");
    expect(root.querySelector(".cm-md-ol-num")?.className).toContain("cm-md-marker-selected");
  });

  it("moves Home and End to visible rendered content boundaries", () => {
    const source = "**bold**";
    const { view } = render(source, 4);

    view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    expect(view.state.selection.main.head).toBe(2);
    expect(view.state.selection.main.assoc).toBe(1);

    view.dispatch({ selection: { anchor: 4 } });
    view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    expect(view.state.selection.main.head).toBe(6);
    expect(view.state.selection.main.assoc).toBe(-1);
  });

  it("moves command arrows to visible rendered content boundaries", () => {
    const source = "**bold**";
    const { view } = render(source, 4);

    view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true, bubbles: true, cancelable: true }));
    expect(view.state.selection.main.head).toBe(2);
    expect(view.state.selection.main.assoc).toBe(1);

    view.dispatch({ selection: { anchor: 4 } });
    view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true, bubbles: true, cancelable: true }));
    expect(view.state.selection.main.head).toBe(6);
    expect(view.state.selection.main.assoc).toBe(-1);
  });

  it("extends command-arrow selections to visible rendered content boundaries", () => {
    const source = "**bold**";
    const { view } = render(source, 4);

    view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(view.state.selection.main.anchor).toBe(4);
    expect(view.state.selection.main.head).toBe(2);
    expect(view.state.selection.main.empty).toBe(false);

    view.dispatch({ selection: { anchor: 4 } });
    view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(view.state.selection.main.anchor).toBe(4);
    expect(view.state.selection.main.head).toBe(6);
    expect(view.state.selection.main.empty).toBe(false);
  });

  it("skips hidden trailing markers during plain right-arrow motion", () => {
    const source = "**bold**\n## Heading";
    const { view } = render(source, 6);

    view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(view.state.selection.main.head).toBe(source.indexOf("Heading"));
    expect(view.state.selection.main.assoc).toBe(1);
  });

  it("skips hidden leading markers during plain left-arrow motion", () => {
    const source = "**bold**\n## Heading";
    const { view } = render(source, source.indexOf("Heading"));

    view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect(view.state.selection.main.head).toBe(source.indexOf("**\n"));
    expect(view.state.selection.main.assoc).toBe(-1);
  });

  it("moves from physical source line boundaries back to visible rendered boundaries", () => {
    const source = "**bold**";
    const { view } = render(source, source.length);

    view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect(view.state.selection.main.head).toBe(6);
    expect(view.state.selection.main.assoc).toBe(-1);

    view.dispatch({ selection: { anchor: 0 } });
    view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(view.state.selection.main.head).toBe(2);
    expect(view.state.selection.main.assoc).toBe(1);
  });

  it("keeps trailing markdown markers on the same line when pressing Enter at rendered line end", () => {
    const source = "**bold**";
    const { view } = render(source, 6);

    view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(view.state.doc.toString()).toBe("**bold**\n");
  });

  it("keeps leading markdown markers with rendered content when pressing Enter at rendered line start", () => {
    const source = "**bold**";
    const { view } = render(source, 2);

    view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(view.state.doc.toString()).toBe("\n**bold**");
  });
});
