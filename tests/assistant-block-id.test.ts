import { Text } from "@codemirror/state";
import { afterEach, describe, expect, it } from "vitest";
import { roles } from "../extensions/dev.roles/roles.js";
import { EditorCore } from "../src/editor/EditorCore";
import { getObsidianReferences } from "../src/editor/extensions/obsidian/parser";

describe("assistant block identity", () => {
  let core: EditorCore | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    try { core?.view.destroy(); } catch {}
    host?.remove();
    core = null;
    host = null;
  });

  it("keeps the id in the document but hides it from the rendered role header", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    core = new EditorCore(
      host,
      "assistant <!-- zion-assistant:id=run-1 --> visible answer"
    );
    core.addExternalExtension(roles());

    expect(core.view.state.doc.toString()).toContain("zion-assistant:id=run-1");
    expect(core.view.contentDOM.textContent).toContain("visible answer");
    expect(core.view.contentDOM.textContent).not.toContain("zion-assistant");
  });

  it("excludes the id from Obsidian message reference labels", () => {
    const references = getObsidianReferences(Text.of([
      "assistant <!-- zion-assistant:id=run-1 --> visible answer"
    ]));

    expect(references).toEqual([
      expect.objectContaining({
        label: "assistant: visible answer",
        kind: "message"
      })
    ]);
  });
});
