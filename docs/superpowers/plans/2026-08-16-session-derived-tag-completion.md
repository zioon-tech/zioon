# Session Derived Tag Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add globally deduplicated Biography and other derived session tags to the editor's `#tag` completion popup without rescanning sessions on each keystroke.

**Architecture:** Extend the existing Obsidian completion source with a derived-tag aggregator that reads `sessions.derivedTags` from StateBus. Cache the normalized completion entries by top-level registry object identity, then merge them after current-document and document-backed global tags so existing candidates retain precedence.

**Tech Stack:** TypeScript, CodeMirror 6 autocomplete, Zion StateBus, Vitest, jsdom

---

### Task 1: Merge cached derived tags into editor completion

**Files:**
- Create: `tests/obsidian-completion.test.ts`
- Modify: `src/editor/extensions/obsidian/completion.ts:6-115`
- Modify: `src/editor/extensions/obsidian/completion.ts:165-228`

- [ ] **Step 1: Write the failing completion tests**

Create `tests/obsidian-completion.test.ts`:

```ts
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

    expect(result?.options.map((option) => option.label)).toEqual([
      "#project/zeta",
      "#project/zion"
    ]);
    expect(result?.options.map((option) => option.detail)).toEqual([
      "Biography 自动标签",
      "Biography 自动标签"
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

    expect(complete("#topic/")?.options.map((option) => option.label)).toEqual([
      "#topic/ui"
    ]);

    biography.sessions.s2 = [{ path: "topic/cache" }];
    expect(complete("#topic/")?.options.map((option) => option.label)).toEqual([
      "#topic/ui"
    ]);

    derivedRegistry = { biography };
    expect(complete("#topic/")?.options.map((option) => option.label)).toEqual([
      "#topic/cache",
      "#topic/ui"
    ]);
  });

  it("ignores malformed derived state without breaking existing completion", () => {
    sessionDocs = { s1: "notes #existing" };
    derivedRegistry = ["invalid"];

    expect(complete("#ex")?.options.map((option) => option.label)).toEqual([
      "#existing"
    ]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm test -- --run tests/obsidian-completion.test.ts
```

Expected: the three derived-tag assertions fail because
`completeObsidianTags()` only reads current-document and document-backed tags.

- [ ] **Step 3: Add the reference-cached derived-tag aggregator**

In `src/editor/extensions/obsidian/completion.ts`, add the derived option type,
cache sentinel, path normalizer, and aggregator after `sessionTagCache`:

```ts
type DerivedTagOption = {
  label: string;
  detail: string;
};

const EMPTY_DERIVED_REGISTRY = Symbol("empty-derived-registry");
let derivedTagRegistryRef: unknown = EMPTY_DERIVED_REGISTRY;
let derivedTagOptionsCache: DerivedTagOption[] = [];

function normalizeDerivedTagLabel(rawPath: unknown): string {
  const segments = String(rawPath || "")
    .replace(/^#/, "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!segments.length) return "";
  const path = segments.join("/");
  return path.length <= 200 ? `#${path}` : "";
}

function getGlobalDerivedTags(): DerivedTagOption[] {
  const registry = (() => {
    try {
      return (window as any)?.zion?.state?.get?.("sessions.derivedTags");
    } catch {
      return undefined;
    }
  })();

  if (registry === derivedTagRegistryRef) return derivedTagOptionsCache;
  derivedTagRegistryRef = registry;

  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    derivedTagOptionsCache = [];
    return derivedTagOptionsCache;
  }

  const seen = new Set<string>();
  const options: DerivedTagOption[] = [];
  for (const rawSource of Object.values(registry as Record<string, any>)) {
    if (!rawSource || typeof rawSource !== "object") continue;
    const sourceLabel = String(
      rawSource.label || rawSource.id || "Derived"
    ).trim() || "Derived";
    const sessions = rawSource.sessions;
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
      continue;
    }

    for (const rawTags of Object.values(sessions)) {
      if (!Array.isArray(rawTags)) continue;
      for (const rawTag of rawTags) {
        const rawPath = typeof rawTag === "string" ? rawTag : rawTag?.path;
        const label = normalizeDerivedTagLabel(rawPath);
        if (!label || seen.has(label)) continue;
        seen.add(label);
        options.push({
          label,
          detail: `${sourceLabel} 自动标签`
        });
      }
    }
  }

  derivedTagOptionsCache = options.sort((a, b) => (
    a.label.localeCompare(b.label)
  ));
  return derivedTagOptionsCache;
}
```

After the existing `getGlobalSessionTags()` loop in
`completeObsidianTags()`, merge derived options while preserving source
precedence and the 50-option cap:

```ts
  for (const derived of getGlobalDerivedTags()) {
    if (options.length >= 50) break;
    if (seen.has(derived.label)) continue;
    if (query && !derived.label.slice(1).toLowerCase().startsWith(query)) {
      continue;
    }
    seen.add(derived.label);
    options.push({
      label: derived.label,
      detail: derived.detail,
      type: "keyword",
      apply: derived.label
    });
  }
```

- [ ] **Step 4: Run focused and adjacent tests**

Run:

```bash
npm test -- --run tests/obsidian-completion.test.ts tests/obsidian-tags.test.ts tests/session-derived-tags.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Run static verification and build**

Run:

```bash
npx eslint src/editor/extensions/obsidian/completion.ts tests/obsidian-completion.test.ts
npm run build
```

Expected: ESLint exits successfully and Vite completes the production build.
Restore only generated `dist/index.html` afterward if its asset hashes change.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/editor/extensions/obsidian/completion.ts tests/obsidian-completion.test.ts
git commit -m "feat(editor): complete derived session tags"
```
