import { describe, expect, it } from "vitest";
import { extractDocumentLeadPreview } from "../extensions/shared/session-preview.js";

describe("session preview", () => {
  it("uses the first explicit user block", () => {
    expect(extractDocumentLeadPreview([
      "system system instructions",
      "user first question",
      "assistant first answer",
      "user latest question",
      "with a second line",
      "assistant latest answer"
    ].join("\n"))).toBe("first question");
  });

  it("skips leading tag-only lines", () => {
    expect(extractDocumentLeadPreview([
      "#project/zion #topic/ui",
      "",
      "Please review the sidebar.",
      "Keep the layout dense.",
      "",
      "assistant Done."
    ].join("\n"))).toBe("Please review the sidebar. Keep the layout dense.");
  });

  it("uses implicit opening content as a user message", () => {
    expect(extractDocumentLeadPreview([
      "Please review the sidebar.",
      "assistant Done."
    ].join("\n"))).toBe("Please review the sidebar.");
  });

  it("compacts whitespace and truncates long previews", () => {
    expect(extractDocumentLeadPreview(
      "user   one   two   three",
      12
    )).toBe("one two thr…");
  });

  it("returns an empty string when no user content exists", () => {
    expect(extractDocumentLeadPreview("assistant answer only")).toBe("");
  });
});
