import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  reconcileSessionMessagesInYText
} from "../extensions/dev.session-manager/session-document-projector.js";

describe("editable conversation history", () => {
  const history = [
    { role: "user", content: "original question", runId: "r1" },
    { role: "assistant", content: "original answer", runId: "r1" }
  ];

  it.each([
    "user revised question\nassistant <!-- zion-assistant:id=r1 --> revised answer",
    "user original question\nassistant <!-- zion-assistant:id=r1 --> ",
    "user original question\nassistant <!-- zion-assistant:id=r1 --> original answer\nextra note"
  ])("preserves the editable working copy when reconciling execution history: %s", (source) => {
    const document = new Y.Doc();
    const text = document.getText("content");
    text.insert(0, source);
    reconcileSessionMessagesInYText(text, history);
    expect(text.toString()).toBe(source);
    document.destroy();
  });

  it("does not recreate an answer removed from the working copy", () => {
    const document = new Y.Doc();
    const text = document.getText("content");
    text.insert(0, "user revised question");
    expect(reconcileSessionMessagesInYText(text, history)).toBe(false);
    expect(text.toString()).toBe("user revised question");
    document.destroy();
  });
});
