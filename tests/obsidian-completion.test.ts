import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeObsidianTags } from "../src/editor/extensions/obsidian/completion";

const originalZion = window.zion;
let derivedRegistry: unknown;
let sessionDocs: Record<string, string>;

function complete(source: string) {
  const state = EditorState.create({ doc: source });
  return completeObsidianTags(
    new CompletionContext(state, state.doc.length, false)
  );
}

beforeEach(() => {
  derivedRegistry = {};
  sessionDocs = {};
  window.zion = {
    state: {
      get: vi.fn((key: string) => {
        if (key === "sessions.derivedTags") return derivedRegistry;
        if (key === "sessions.catalog") {
          return Object.keys(sessionDocs).map((id) => ({ id }));
        }
        return undefined;
      })
    },
    commands: {
      executeCommand: vi.fn((_id: string, sessionId: string) => (
        sessionDocs[sessionId] || ""
      ))
    }
  } as any;
});

afterEach(() => {
  window.zion = originalZion;
});

describe("obsidian tag completion", () => {
  it("aggregates derived tags across sessions and providers with global deduplication", () => {
    derivedRegistry = {
      biography: {
        id: "biography",
        label: "Biography",
        sessions: {
          s1: [{ path: "project/zion" }, { path: "topic/ui" }],
          s2: [{ path: "#project/zeta" }, { path: "project/zion" }]
        }
      },
      secondary: {
        id: "secondary",
        label: "Secondary",
        sessions: {
          s3: [{ path: "project/zion" }]
        }
      }
    };

    const result = complete("#project/z");
    const derivedOptions = result?.options.filter(
      (option) => option.detail === "Biography 自动标签"
    );

    expect(derivedOptions?.map((option) => option.label)).toEqual([
      "#project/zeta",
      "#project/zion"
    ]);
  });

  it("keeps document-backed completion ahead of a duplicate derived tag", () => {
    sessionDocs = { s1: "notes #project/zion" };
    derivedRegistry = {
      biography: {
        id: "biography",
        label: "Biography",
        sessions: {
          s2: [{ path: "project/zion" }]
        }
      }
    };

    const matches = complete("#project/z")?.options.filter(
      (option) => option.label === "#project/zion"
    );

    expect(matches).toHaveLength(1);
    expect(matches?.[0]?.detail).toBe("已有标签");
  });

  it("reuses the cache until the derived-tag registry reference changes", () => {
    const biography: {
      id: string;
      label: string;
      sessions: Record<string, Array<{ path: string }>>;
    } = {
      id: "biography",
      label: "Biography",
      sessions: {
        s1: [{ path: "topic/ui" }]
      }
    };
    derivedRegistry = { biography };

    const derivedLabels = () => complete("#topic/")?.options
      .filter((option) => option.detail === "Biography 自动标签")
      .map((option) => option.label);

    expect(derivedLabels()).toEqual([
      "#topic/ui"
    ]);

    biography.sessions.s2 = [{ path: "topic/cache" }];
    expect(derivedLabels()).toEqual([
      "#topic/ui"
    ]);

    derivedRegistry = { biography };
    expect(derivedLabels()).toEqual([
      "#topic/cache",
      "#topic/ui"
    ]);
  });

  it("ignores malformed derived state without breaking existing completion", () => {
    sessionDocs = { s1: "notes #existing" };
    derivedRegistry = ["invalid"];

    const options = complete("#ex")?.options || [];
    expect(options.some((option) => (
      option.label === "#existing" && option.detail === "已有标签"
    ))).toBe(true);
    expect(options.some((option) => (
      option.detail === "Biography 自动标签"
    ))).toBe(false);
  });
});
