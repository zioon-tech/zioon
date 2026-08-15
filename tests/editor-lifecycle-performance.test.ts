import { afterEach, describe, expect, it } from "vitest";
import { EditorCore } from "../src/editor/EditorCore";
import { attachEditor, detachEditor } from "../src/ext/registry";

const cores: EditorCore[] = [];

afterEach(() => {
  for (const core of cores.splice(0)) {
    try { core.dispose(); } catch {}
  }
  document.body.innerHTML = "";
});

describe("editor lifecycle performance", () => {
  it("builds comment-style editors without disabled gutter features", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const core = new EditorCore(host, "user hello", "comments:lightweight", {
      lineNumbers: false,
      activeLineHighlight: false,
      folding: false
    });
    cores.push(core);

    expect(core.view.dom.querySelector(".cm-lineNumbers")).toBeNull();
    expect(core.view.dom.querySelector(".cm-foldGutter")).toBeNull();
    expect(core.view.dom.querySelector(".cm-activeLine")).toBeNull();
  });

  it("drops every proxy for a detached panel", () => {
    const panelId = "panel-registry-lifecycle";
    const firstHost = document.createElement("div");
    const secondHost = document.createElement("div");
    document.body.append(firstHost, secondHost);
    const firstCore = new EditorCore(firstHost, "first", panelId);
    const secondCore = new EditorCore(secondHost, "second", panelId);
    cores.push(firstCore, secondCore);

    const firstProxy = attachEditor(firstCore, panelId);
    const secondProxy = attachEditor(secondCore, panelId);
    expect(firstProxy).not.toBe(secondProxy);

    detachEditor(panelId);

    expect(attachEditor(firstCore, panelId)).not.toBe(firstProxy);
    expect(attachEditor(secondCore, panelId)).not.toBe(secondProxy);
    detachEditor(panelId);
  });
});
