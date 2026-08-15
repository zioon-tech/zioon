# Session Sidebar Tag Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, auto-widening two-column Sessions sidebar with a durable hierarchical tag catalog, safe tag management, and catalog-backed editor completion.

**Architecture:** Keep document tags as Obsidian-style `#parent/child` text, but add a normalized catalog in the existing Sessions IndexedDB `kv` store for stable IDs, empty tags, and sibling order. Pure catalog and mutation modules own hierarchy and rewrite logic; a controller coordinates atomic persistence and state publication; a focused tag-tree view owns DOM interaction; the existing sidebar manager only composes tag, activity, and session regions.

**Tech Stack:** TypeScript, JavaScript ES modules, CodeMirror 6, IndexedDB, Vitest with jsdom, Zion Next Workbench runtime and extension APIs.

---

## Scope Check

This is one coherent feature rather than several independent products. The
storage, parser, completion, Workbench chrome, and Sessions UI changes all serve
the same user-visible split tag-management workflow and can be delivered behind
one persisted opt-in toggle.

Do not add tag assignment dialogs, automatic rules, editable colors,
cross-parent drag reparenting, tag merge, or persistent operation history.

## File Structure

### Create

- `extensions/dev.session-manager/model/tag-catalog.js`
  - Pure catalog normalization, validation, hierarchy, reconciliation, create,
    rename, delete, reorder, path derivation, and usage projection.
- `extensions/dev.session-manager/features/tag-mutations.js`
  - Pure rename/delete previews and valid-tag document rewrites.
- `extensions/dev.session-manager/features/tag-catalog-controller.js`
  - Initialization, optimistic catalog operations, mutation locking, atomic
    commit orchestration, state publication, and event emission.
- `extensions/dev.session-manager/storage/tag-catalog.js`
  - Catalog/document repository backed by the existing IndexedDB helpers.
- `extensions/dev.session-manager/storage/snapshot.js`
  - Pure remote snapshot serialization and catalog extraction.
- `extensions/dev.session-manager/ui/tag-tree.js`
  - Searchable accessible tree, inline create/rename, confirmation rows, menus,
    keyboard navigation, and same-parent drag reorder.
- `tests/obsidian-metadata.test.js`
- `tests/session-tag-catalog.test.js`
- `tests/session-tag-mutations.test.js`
- `tests/session-tag-storage.test.js`
- `tests/session-tag-controller.test.js`
- `tests/session-tag-snapshot.test.js`
- `tests/obsidian-tag-completion.test.ts`
- `tests/session-tag-tree.test.js`
- `tests/session-sidebar-tag-split.test.js`

### Modify

- `extensions/shared/obsidian-metadata.js:1-136`
  - Export all valid tag occurrences with exact ranges.
- `extensions/dev.session-manager/storage/idb.js:76-154`
  - Add one multi-store atomic commit helper.
- `extensions/dev.session-manager/commands/doc-apis.js:70-211`
  - Apply already-persisted tag mutations to state, metadata, and open editors
    without writing document records a second time.
- `extensions/dev.session-manager/main.js:1-20, 326-603, 1141-1155, 1515-1571, 1667-1692, 2154-2172`
  - Wire catalog storage/controller, remote snapshots, autosave reconciliation,
    commands, header toggle, and sidebar dependencies.
- `extensions/dev.session-manager/ui/sidebar-view.js:1-318, 383-687, 1040-1074`
  - Replace inline tag-tree ownership with split composition and the extracted
    tag-tree view.
- `extensions/dev.session-manager/styles.css:352-500`
  - Add flat split layout, divider, search, tree action, inline edit,
    confirmation, drag, and responsive styles.
- `extensions/dev.session-manager/manifest.json:55-135`
  - Contribute the split toggle command.
- `src/editor/extensions/obsidian/completion.ts:83-115, 165-228`
  - Include catalog paths, including unused tags, in completion.
- `src/ui/workbench/runtime.ts:646-745`
  - Allow a 440 px sidebar and retain current runtime semantics.
- `src/ui/workbench/workbench.ts:2568-2594`
  - Render sidebar header action active state and `aria-pressed`.
- `src/ext/registry.ts:2388-2396`
  - Expose `sideBar.getWidth()`.
- `src/types/zion.d.ts:302-328`
  - Type `sideBar.getWidth()`.
- `tests/session-doc-commands.test.js`
  - Cover post-commit editor synchronization.
- `tests/workbench-sidebar-chrome.test.js`
  - Cover active header action semantics and 440 px width.

## Task 1: Parse Every Valid Tag Occurrence

**Files:**
- Create: `tests/obsidian-metadata.test.js`
- Modify: `extensions/shared/obsidian-metadata.js:1-136`

- [ ] **Step 1: Write the failing occurrence tests**

Create `tests/obsidian-metadata.test.js`:

```js
import { describe, expect, it } from "vitest";
import {
  extractObsidianMetadata,
  findObsidianTagOccurrences
} from "../extensions/shared/obsidian-metadata.js";

describe("shared obsidian tag metadata", () => {
  it("returns every valid occurrence with exact ranges", () => {
    const source = "user #project/zion and #project/zion\nassistant #todo";
    const occurrences = findObsidianTagOccurrences(source);

    expect(occurrences.map(({ label, line }) => ({ label, line }))).toEqual([
      { label: "#project/zion", line: 1 },
      { label: "#project/zion", line: 1 },
      { label: "#todo", line: 2 }
    ]);
    expect(occurrences.map((item) => source.slice(item.from, item.to))).toEqual([
      "#project/zion",
      "#project/zion",
      "#todo"
    ]);
    expect(extractObsidianMetadata(source).tags.map((item) => item.label)).toEqual([
      "#project/zion",
      "#todo"
    ]);
  });

  it("excludes headings, fenced code, inline code, and escaped tags", () => {
    const source = [
      "# Heading",
      "\\#escaped #outside",
      "`#inline`",
      "```md",
      "#inside",
      "```",
      "(#nested/valid)"
    ].join("\n");

    expect(findObsidianTagOccurrences(source).map((item) => item.label)).toEqual([
      "#outside",
      "#nested/valid"
    ]);
  });

  it("keeps exact offsets across CRLF line endings", () => {
    const source = "first #one\r\nsecond #two";
    const occurrences = findObsidianTagOccurrences(source);
    expect(occurrences.map((item) => source.slice(item.from, item.to))).toEqual([
      "#one",
      "#two"
    ]);
    expect(occurrences[1].from).toBe(source.indexOf("#two"));
  });
});
```

- [ ] **Step 2: Run the test and verify the missing export**

Run:

```bash
npx vitest run tests/obsidian-metadata.test.js
```

Expected: FAIL because `findObsidianTagOccurrences` is not exported.

- [ ] **Step 3: Add the occurrence parser and align deduplicated metadata**

Add this export after `addUnique` in
`extensions/shared/obsidian-metadata.js`:

```js
function lineBreakLengthAt(source, index) {
  if (source.slice(index, index + 2) === "\r\n") return 2;
  return source[index] === "\n" ? 1 : 0;
}

export function findObsidianTagOccurrences(text) {
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  const occurrences = [];
  let offset = 0;
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    const lineNo = i + 1;
    const wasInFence = inFence;
    const fence = isFenceLine(line);
    if (fence) inFence = !inFence;

    if (!wasInFence && !fence && !/^\s{0,3}#{1,6}\s/.test(line)) {
      TAG_RE.lastIndex = 0;
      let match;
      while ((match = TAG_RE.exec(line)) !== null) {
        const tagStart = match.index + match[1].length;
        if (isEscapedAt(line, tagStart) || isInsideInlineCode(line, tagStart)) continue;
        const label = `#${match[2]}`;
        const from = offset + tagStart;
        occurrences.push({
          label,
          path: label.slice(1),
          line: lineNo,
          from,
          to: from + label.length
        });
      }
    }

    offset += line.length + lineBreakLengthAt(source, offset + line.length);
  }

  return occurrences;
}
```

Inside `extractObsidianMetadata`, replace the current tag-start guard with:

```js
const tagStart = tagMatch.index + tagMatch[1].length;
if (isEscapedAt(line, tagStart) || isInsideInlineCode(line, tagStart)) continue;
```

Replace its line-offset increment with the CRLF-aware expression:

```js
offset += line.length + lineBreakLengthAt(source, offset + line.length);
```

- [ ] **Step 4: Run parser tests**

Run:

```bash
npx vitest run tests/obsidian-metadata.test.js tests/obsidian-tags.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the parser contract**

```bash
git add extensions/shared/obsidian-metadata.js tests/obsidian-metadata.test.js
git commit -m "feat(sessions): expose valid tag occurrences"
```

## Task 2: Add the Pure Tag Catalog Model

**Files:**
- Create: `extensions/dev.session-manager/model/tag-catalog.js`
- Create: `tests/session-tag-catalog.test.js`

- [ ] **Step 1: Write failing catalog behavior tests**

Create `tests/session-tag-catalog.test.js`:

```js
import { describe, expect, it } from "vitest";
import {
  createCatalogTag,
  createEmptyTagCatalog,
  deleteCatalogTag,
  getTagPathMap,
  reconcileTagCatalog,
  renameCatalogTag,
  reorderCatalogTag
} from "../extensions/dev.session-manager/model/tag-catalog.js";

const ids = ["tag-1", "tag-2", "tag-3", "tag-4"];

describe("session tag catalog", () => {
  it("reconciles legacy paths and preserves unused tags", () => {
    let cursor = 0;
    let catalog = createEmptyTagCatalog();
    catalog = createCatalogTag(catalog, {
      id: "unused",
      name: "unused",
      parentId: null,
      now: 1
    });

    const result = reconcileTagCatalog(catalog, [
      "#project/zion",
      "#project/agent"
    ], {
      makeId: () => ids[cursor++],
      now: () => 2
    });
    const paths = Array.from(getTagPathMap(result.catalog).values());

    expect(result.changed).toBe(true);
    expect(paths).toEqual(["#unused", "#project", "#project/agent", "#project/zion"]);
  });

  it("keeps stable ids through rename and reorders only siblings", () => {
    let catalog = createEmptyTagCatalog();
    catalog = createCatalogTag(catalog, { id: "a", name: "alpha", parentId: null, now: 1 });
    catalog = createCatalogTag(catalog, { id: "b", name: "beta", parentId: null, now: 2 });
    catalog = createCatalogTag(catalog, { id: "c", name: "child", parentId: "a", now: 3 });

    catalog = renameCatalogTag(catalog, "a", "work");
    expect(getTagPathMap(catalog).get("a")).toBe("#work");
    expect(getTagPathMap(catalog).get("c")).toBe("#work/child");

    catalog = reorderCatalogTag(catalog, { id: "b", beforeId: "a" });
    expect(catalog.tags.filter((tag) => tag.parentId === null).map((tag) => tag.id)).toEqual(["b", "a"]);
    expect(() => reorderCatalogTag(catalog, { id: "c", beforeId: "b" })).toThrow("TAG_CROSS_PARENT_REORDER");
  });

  it("rejects invalid duplicates and deletes a subtree", () => {
    let catalog = createEmptyTagCatalog();
    catalog = createCatalogTag(catalog, { id: "a", name: "project", parentId: null, now: 1 });
    catalog = createCatalogTag(catalog, { id: "b", name: "zion", parentId: "a", now: 2 });

    expect(() => createCatalogTag(catalog, {
      id: "c",
      name: "project",
      parentId: null,
      now: 3
    })).toThrow("TAG_DUPLICATE");
    expect(() => renameCatalogTag(catalog, "a", "bad/name")).toThrow("TAG_INVALID_NAME");

    const deleted = deleteCatalogTag(catalog, "a");
    expect(deleted.deletedIds).toEqual(["a", "b"]);
    expect(deleted.catalog.tags).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and verify the module is missing**

Run:

```bash
npx vitest run tests/session-tag-catalog.test.js
```

Expected: FAIL because `model/tag-catalog.js` does not exist.

- [ ] **Step 3: Implement immutable catalog operations**

Create `extensions/dev.session-manager/model/tag-catalog.js` with these public
contracts and behavior:

```js
export const TAG_CATALOG_KEY = "tagCatalog.v1";
export const TAG_CATALOG_VERSION = 1;
const TAG_NAME_RE = /^[\p{L}\p{N}_-]+$/u;

const cloneCatalog = (catalog) => ({
  version: TAG_CATALOG_VERSION,
  tags: (catalog?.tags || []).map((tag) => ({ ...tag }))
});

const codePointCompare = (a, b) => {
  const left = String(a || "").normalize("NFC");
  const right = String(b || "").normalize("NFC");
  return left < right ? -1 : left > right ? 1 : 0;
};

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

export function createEmptyTagCatalog() {
  return { version: TAG_CATALOG_VERSION, tags: [] };
}

export function normalizeTagCatalog(value) {
  if (!value || value.version !== TAG_CATALOG_VERSION || !Array.isArray(value.tags)) {
    return createEmptyTagCatalog();
  }
  const seen = new Set();
  const tags = [];
  for (const input of value.tags) {
    const id = String(input?.id || "").trim();
    const name = String(input?.name || "").normalize("NFC").trim();
    if (!id || seen.has(id) || !TAG_NAME_RE.test(name)) continue;
    seen.add(id);
    tags.push({
      id,
      name,
      parentId: input?.parentId == null ? null : String(input.parentId),
      order: Number.isFinite(Number(input?.order)) ? Number(input.order) : tags.length,
      createdAt: Number.isFinite(Number(input?.createdAt)) ? Number(input.createdAt) : 0
    });
  }
  const alive = new Set(tags.map((tag) => tag.id));
  for (const tag of tags) {
    if (tag.parentId && !alive.has(tag.parentId)) tag.parentId = null;
  }
  return reindexCatalog({ version: TAG_CATALOG_VERSION, tags });
}

export function reindexCatalog(catalog) {
  const next = cloneCatalog(catalog);
  const groups = new Map();
  for (const tag of next.tags) {
    const key = tag.parentId || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tag);
  }
  for (const siblings of groups.values()) {
    siblings.sort((a, b) => Number(a.order) - Number(b.order) || codePointCompare(a.name, b.name));
    siblings.forEach((tag, index) => { tag.order = index; });
  }
  next.tags.sort((a, b) => {
    const parent = codePointCompare(a.parentId || "", b.parentId || "");
    return parent || Number(a.order) - Number(b.order) || codePointCompare(a.id, b.id);
  });
  return next;
}

export function getTagPathMap(catalog) {
  const tags = normalizeTagCatalog(catalog).tags;
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  const cache = new Map();
  const visit = (id, stack = new Set()) => {
    if (cache.has(id)) return cache.get(id);
    const tag = byId.get(id);
    if (!tag || stack.has(id)) return "";
    const nextStack = new Set(stack);
    nextStack.add(id);
    const parent = tag.parentId ? visit(tag.parentId, nextStack) : "";
    const path = parent ? `${parent}/${tag.name}` : `#${tag.name}`;
    cache.set(id, path);
    return path;
  };
  for (const tag of tags) visit(tag.id);
  return cache;
}

const assertNameAvailable = (catalog, name, parentId, exceptId = null) => {
  const normalized = String(name || "").normalize("NFC").trim();
  if (!TAG_NAME_RE.test(normalized)) fail("TAG_INVALID_NAME");
  const duplicate = catalog.tags.some((tag) =>
    tag.id !== exceptId &&
    (tag.parentId || null) === (parentId || null) &&
    tag.name === normalized
  );
  if (duplicate) fail("TAG_DUPLICATE");
  return normalized;
};

export function createCatalogTag(catalog, input) {
  const next = normalizeTagCatalog(catalog);
  const id = String(input?.id || "").trim();
  if (!id || next.tags.some((tag) => tag.id === id)) fail("TAG_INVALID_ID");
  const parentId = input?.parentId == null ? null : String(input.parentId);
  if (parentId && !next.tags.some((tag) => tag.id === parentId)) fail("TAG_PARENT_NOT_FOUND");
  const name = assertNameAvailable(next, input?.name, parentId);
  const siblings = next.tags.filter((tag) => (tag.parentId || null) === parentId);
  next.tags.push({
    id,
    name,
    parentId,
    order: siblings.length,
    createdAt: Number(input?.now || 0)
  });
  return reindexCatalog(next);
}

export function renameCatalogTag(catalog, id, name) {
  const next = normalizeTagCatalog(catalog);
  const tag = next.tags.find((item) => item.id === id);
  if (!tag) fail("TAG_NOT_FOUND");
  tag.name = assertNameAvailable(next, name, tag.parentId, id);
  return reindexCatalog(next);
}

export function getCatalogDescendantIds(catalog, id) {
  const children = new Map();
  for (const tag of normalizeTagCatalog(catalog).tags) {
    const key = tag.parentId || "";
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(tag.id);
  }
  const out = [];
  const visit = (current) => {
    out.push(current);
    for (const child of children.get(current) || []) visit(child);
  };
  visit(id);
  return out;
}

export function deleteCatalogTag(catalog, id) {
  const next = normalizeTagCatalog(catalog);
  if (!next.tags.some((tag) => tag.id === id)) fail("TAG_NOT_FOUND");
  const deletedIds = getCatalogDescendantIds(next, id);
  const deleted = new Set(deletedIds);
  next.tags = next.tags.filter((tag) => !deleted.has(tag.id));
  return { catalog: reindexCatalog(next), deletedIds };
}

export function reorderCatalogTag(catalog, input) {
  const next = normalizeTagCatalog(catalog);
  const source = next.tags.find((tag) => tag.id === input?.id);
  const before = input?.beforeId == null
    ? null
    : next.tags.find((tag) => tag.id === input.beforeId);
  if (!source || (input?.beforeId != null && !before)) fail("TAG_NOT_FOUND");
  if (before && (before.parentId || null) !== (source.parentId || null)) {
    fail("TAG_CROSS_PARENT_REORDER");
  }
  const siblings = next.tags
    .filter((tag) => (tag.parentId || null) === (source.parentId || null) && tag.id !== source.id)
    .sort((a, b) => a.order - b.order);
  const index = before ? siblings.findIndex((tag) => tag.id === before.id) : siblings.length;
  siblings.splice(index < 0 ? siblings.length : index, 0, source);
  siblings.forEach((tag, order) => { tag.order = order; });
  return reindexCatalog(next);
}

export function reconcileTagCatalog(catalog, labels, deps) {
  let next = normalizeTagCatalog(catalog);
  const before = JSON.stringify(next);
  const paths = Array.from(new Set((labels || [])
    .map((label) => String(label || "").replace(/^#/, "").normalize("NFC").trim())
    .filter(Boolean)))
    .sort(codePointCompare);

  for (const path of paths) {
    let parentId = null;
    for (const name of path.split("/").filter(Boolean)) {
      let tag = next.tags.find((item) =>
        (item.parentId || null) === parentId && item.name === name
      );
      if (!tag) {
        const id = String(deps.makeId());
        next = createCatalogTag(next, {
          id,
          name,
          parentId,
          now: deps.now()
        });
        tag = next.tags.find((item) => item.id === id);
      }
      parentId = tag.id;
    }
  }
  return { catalog: next, changed: JSON.stringify(next) !== before };
}
```

- [ ] **Step 4: Run the catalog tests**

Run:

```bash
npx vitest run tests/session-tag-catalog.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit the catalog model**

```bash
git add extensions/dev.session-manager/model/tag-catalog.js tests/session-tag-catalog.test.js
git commit -m "feat(sessions): add durable tag catalog model"
```

## Task 3: Plan Safe Rename and Delete Mutations

**Files:**
- Create: `extensions/dev.session-manager/features/tag-mutations.js`
- Create: `tests/session-tag-mutations.test.js`

- [ ] **Step 1: Write failing mutation preview tests**

Create `tests/session-tag-mutations.test.js`:

```js
import { describe, expect, it } from "vitest";
import {
  createCatalogTag,
  createEmptyTagCatalog
} from "../extensions/dev.session-manager/model/tag-catalog.js";
import {
  planDeleteTag,
  planRenameTag
} from "../extensions/dev.session-manager/features/tag-mutations.js";

function catalogFixture() {
  let catalog = createEmptyTagCatalog();
  catalog = createCatalogTag(catalog, { id: "project", name: "project", parentId: null, now: 1 });
  catalog = createCatalogTag(catalog, { id: "zion", name: "zion", parentId: "project", now: 2 });
  return catalog;
}

describe("session tag mutations", () => {
  it("renames a parent and every valid descendant occurrence", () => {
    const plan = planRenameTag({
      catalog: catalogFixture(),
      tagId: "project",
      nextName: "work",
      documents: [
        { id: "s1", text: "user #project and #project/zion" },
        { id: "s2", text: "`#project`\\n```\\n#project/zion\\n```" }
      ]
    });

    expect(plan.documents).toEqual([
      { id: "s1", text: "user #work and #work/zion" }
    ]);
    expect(plan.affected).toEqual({ tags: 2, sessions: 1, occurrences: 2 });
  });

  it("deletes a subtree without touching code-like text", () => {
    const plan = planDeleteTag({
      catalog: catalogFixture(),
      tagId: "project",
      documents: [
        { id: "s1", text: "#project #project/zion keep" },
        { id: "s2", text: "`#project/zion` keep" }
      ]
    });

    expect(plan.documents).toEqual([{ id: "s1", text: "  keep" }]);
    expect(plan.catalog.tags).toEqual([]);
    expect(plan.affected).toEqual({ tags: 2, sessions: 1, occurrences: 2 });
  });
});
```

- [ ] **Step 2: Run the tests and verify the module is missing**

Run:

```bash
npx vitest run tests/session-tag-mutations.test.js
```

Expected: FAIL because `features/tag-mutations.js` does not exist.

- [ ] **Step 3: Implement immutable mutation previews**

Create `extensions/dev.session-manager/features/tag-mutations.js`:

```js
import { findObsidianTagOccurrences } from "../../shared/obsidian-metadata.js";
import {
  deleteCatalogTag,
  getCatalogDescendantIds,
  getTagPathMap,
  renameCatalogTag
} from "../model/tag-catalog.js";

function applyEdits(text, edits) {
  let output = String(text || "");
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
    output = `${output.slice(0, edit.from)}${edit.insert}${output.slice(edit.to)}`;
  }
  return output;
}

function rewriteDocuments(documents, replaceLabel) {
  const changed = [];
  let occurrences = 0;
  for (const document of documents || []) {
    const edits = [];
    for (const occurrence of findObsidianTagOccurrences(document?.text)) {
      const insert = replaceLabel(occurrence.label);
      if (insert == null || insert === occurrence.label) continue;
      edits.push({ from: occurrence.from, to: occurrence.to, insert });
    }
    if (!edits.length) continue;
    occurrences += edits.length;
    changed.push({
      id: String(document.id),
      text: applyEdits(document.text, edits)
    });
  }
  return { documents: changed, occurrences };
}

export function planRenameTag(input) {
  const beforePaths = getTagPathMap(input.catalog);
  const affectedIds = getCatalogDescendantIds(input.catalog, input.tagId);
  const catalog = renameCatalogTag(input.catalog, input.tagId, input.nextName);
  const afterPaths = getTagPathMap(catalog);
  const replacements = new Map(affectedIds.map((id) => [
    beforePaths.get(id),
    afterPaths.get(id)
  ]));
  const rewritten = rewriteDocuments(input.documents, (label) =>
    replacements.has(label) ? replacements.get(label) : label
  );
  return {
    kind: "rename",
    tagId: input.tagId,
    catalog,
    documents: rewritten.documents,
    affected: {
      tags: affectedIds.length,
      sessions: rewritten.documents.length,
      occurrences: rewritten.occurrences
    }
  };
}

export function planDeleteTag(input) {
  const beforePaths = getTagPathMap(input.catalog);
  const deleted = deleteCatalogTag(input.catalog, input.tagId);
  const paths = new Set(deleted.deletedIds.map((id) => beforePaths.get(id)));
  const rewritten = rewriteDocuments(input.documents, (label) =>
    paths.has(label) ? "" : label
  );
  return {
    kind: "delete",
    tagId: input.tagId,
    catalog: deleted.catalog,
    documents: rewritten.documents,
    affected: {
      tags: deleted.deletedIds.length,
      sessions: rewritten.documents.length,
      occurrences: rewritten.occurrences
    }
  };
}
```

- [ ] **Step 4: Run parser, catalog, and mutation tests**

Run:

```bash
npx vitest run tests/obsidian-metadata.test.js tests/session-tag-catalog.test.js tests/session-tag-mutations.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit mutation planning**

```bash
git add extensions/dev.session-manager/features/tag-mutations.js tests/session-tag-mutations.test.js
git commit -m "feat(sessions): plan atomic tag mutations"
```

## Task 4: Add Atomic Catalog and Document Persistence

**Files:**
- Modify: `extensions/dev.session-manager/storage/idb.js:76-154`
- Create: `extensions/dev.session-manager/storage/tag-catalog.js`
- Create: `tests/session-tag-storage.test.js`

- [ ] **Step 1: Write failing repository tests with an injected atomic writer**

Create `tests/session-tag-storage.test.js`:

```js
import { describe, expect, it, vi } from "vitest";
import { createTagCatalogRepository } from "../extensions/dev.session-manager/storage/tag-catalog.js";

describe("session tag catalog storage", () => {
  it("loads normalized catalog data and all session documents", async () => {
    const repository = createTagCatalogRepository({
      dbName: "test",
      idbGetKV: vi.fn(async () => ({ version: 1, tags: [] })),
      idbSetKV: vi.fn(async () => true),
      idbGetAll: vi.fn(async () => [
        { id: "s1", text: "#one" },
        { id: "s2", text: "#two" }
      ]),
      idbCommitTagMutation: vi.fn(async () => true)
    });

    await expect(repository.loadCatalog()).resolves.toEqual({ version: 1, tags: [] });
    await expect(repository.loadDocuments()).resolves.toEqual([
      { id: "s1", text: "#one" },
      { id: "s2", text: "#two" }
    ]);
  });

  it("does not report a mutation as committed when the atomic writer rejects", async () => {
    const write = vi.fn(async () => { throw new Error("transaction aborted"); });
    const repository = createTagCatalogRepository({
      dbName: "test",
      idbGetKV: vi.fn(),
      idbSetKV: vi.fn(),
      idbGetAll: vi.fn(),
      idbCommitTagMutation: write
    });
    const mutation = {
      catalog: { version: 1, tags: [] },
      documents: [{ id: "s1", text: "changed" }]
    };

    await expect(repository.commitMutation(mutation)).rejects.toThrow("transaction aborted");
    expect(write).toHaveBeenCalledWith("test", mutation);
  });

  it("aborts both document and catalog writes when the IndexedDB transaction fails", async () => {
    vi.resetModules();
    const persistedDocs = new Map([["s1", { id: "s1", text: "before" }]]);
    const persistedKV = new Map([[
      "tagCatalog.v1",
      { key: "tagCatalog.v1", value: { version: 1, tags: [] } }
    ]]);
    const stagedDocs = new Map();
    const stagedKV = new Map();

    globalThis.indexedDB = {
      open() {
        const request = {};
        const connection = {
          objectStoreNames: { contains: () => true },
          transaction() {
            const tx = {
              error: null,
              oncomplete: null,
              onabort: null,
              onerror: null,
              objectStore(name) {
                return {
                  put(record) {
                    if (name === "docs") stagedDocs.set(record.id, record);
                    if (name === "kv") stagedKV.set(record.key, record);
                    return { onerror: null };
                  }
                };
              },
              abort() {
                tx.error = new Error("forced abort");
                tx.onabort?.();
              }
            };
            queueMicrotask(() => tx.abort());
            return tx;
          },
          close() {}
        };
        queueMicrotask(() => {
          request.result = connection;
          request.onsuccess?.({ target: request });
        });
        return request;
      }
    };

    try {
      const { idbCommitTagMutation } = await import(
        "../extensions/dev.session-manager/storage/idb.js"
      );
      await expect(idbCommitTagMutation("test-atomic", {
        catalog: {
          version: 1,
          tags: [{ id: "a", name: "a", parentId: null, order: 0, createdAt: 1 }]
        },
        documents: [{ id: "s1", text: "after" }]
      })).rejects.toThrow("forced abort");
      expect(persistedDocs.get("s1").text).toBe("before");
      expect(persistedKV.get("tagCatalog.v1").value.tags).toEqual([]);
      expect(stagedDocs.get("s1").text).toBe("after");
      expect(stagedKV.get("tagCatalog.v1").value.tags).toHaveLength(1);
    } finally {
      delete globalThis.indexedDB;
    }
  });
});
```

- [ ] **Step 2: Run the tests and verify the repository is missing**

Run:

```bash
npx vitest run tests/session-tag-storage.test.js
```

Expected: FAIL because `storage/tag-catalog.js` does not exist.

- [ ] **Step 3: Implement the repository and multi-store writer**

Create `extensions/dev.session-manager/storage/tag-catalog.js`:

```js
import {
  TAG_CATALOG_KEY,
  normalizeTagCatalog
} from "../model/tag-catalog.js";

export function createTagCatalogRepository(opts) {
  const dbName = opts.dbName;
  return {
    async loadCatalog() {
      return normalizeTagCatalog(await opts.idbGetKV(dbName, TAG_CATALOG_KEY));
    },
    async saveCatalog(catalog) {
      const normalized = normalizeTagCatalog(catalog);
      await opts.idbSetKV(dbName, TAG_CATALOG_KEY, normalized);
      return normalized;
    },
    async loadDocuments() {
      const records = await opts.idbGetAll(dbName, "docs");
      return records
        .filter((record) => record?.id)
        .map((record) => ({ id: String(record.id), text: String(record.text || "") }));
    },
    async commitMutation(mutation) {
      await opts.idbCommitTagMutation(dbName, {
        catalog: normalizeTagCatalog(mutation.catalog),
        documents: (mutation.documents || []).map((document) => ({
          id: String(document.id),
          text: String(document.text || "")
        }))
      });
      return true;
    }
  };
}
```

Add this export before the KV convenience exports in
`extensions/dev.session-manager/storage/idb.js`:

```js
export async function idbCommitTagMutation(dbName, mutation) {
  return runTx(dbName, (db) => new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const tx = db.transaction(["docs", "kv"], "readwrite");
    const docs = tx.objectStore("docs");
    const kv = tx.objectStore("kv");
    for (const document of mutation?.documents || []) {
      const request = docs.put({
        id: String(document.id),
        text: String(document.text || "")
      });
      request.onerror = () => {
        try { tx.abort(); } catch {}
      };
    }
    const catalogRequest = kv.put({
      key: "tagCatalog.v1",
      value: mutation.catalog
    });
    catalogRequest.onerror = () => {
      try { tx.abort(); } catch {}
    };
    tx.oncomplete = () => settle(resolve, true);
    tx.onabort = () => settle(reject, tx.error || new Error("tag mutation transaction aborted"));
    tx.onerror = () => settle(reject, tx.error || new Error("tag mutation transaction error"));
  }));
}
```

- [ ] **Step 4: Run storage and existing IDB tests**

Run:

```bash
npx vitest run tests/session-tag-storage.test.js tests/session-idb-self-heal.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit atomic persistence**

```bash
git add extensions/dev.session-manager/storage/idb.js extensions/dev.session-manager/storage/tag-catalog.js tests/session-tag-storage.test.js
git commit -m "feat(sessions): persist tag mutations atomically"
```

## Task 5: Add the Catalog Controller

**Files:**
- Create: `extensions/dev.session-manager/features/tag-catalog-controller.js`
- Create: `tests/session-tag-controller.test.js`

- [ ] **Step 1: Write failing controller tests**

Create `tests/session-tag-controller.test.js`:

```js
import { describe, expect, it, vi } from "vitest";
import { createTagCatalogController } from "../extensions/dev.session-manager/features/tag-catalog-controller.js";

function createZion() {
  const state = new Map();
  return {
    state: {
      get: (key) => state.get(key),
      set: (key, value) => state.set(key, value)
    },
    events: { emit: vi.fn() }
  };
}

describe("session tag catalog controller", () => {
  it("initializes from documents and keeps manually created empty tags", async () => {
    const zion = createZion();
    const repository = {
      loadCatalog: vi.fn(async () => ({ version: 1, tags: [] })),
      loadDocuments: vi.fn(async () => [{ id: "s1", text: "#project/zion" }]),
      saveCatalog: vi.fn(async (catalog) => catalog),
      commitMutation: vi.fn(async () => true)
    };
    let seq = 0;
    const controller = createTagCatalogController({
      zion,
      repository,
      makeId: () => `tag-${++seq}`,
      now: () => 1,
      flushPendingSave: () => {},
      applyCommittedDocument: () => {},
      onPersist: () => {}
    });

    await controller.initialize();
    await controller.createTag({ name: "unused", parentId: null });

    expect(controller.getCatalog().tags.map((tag) => tag.name)).toEqual([
      "project",
      "unused",
      "zion"
    ]);
    expect(zion.state.get("sessions.tagCatalogMem")).toEqual(controller.getCatalog());
  });

  it("rolls optimistic create back when persistence fails", async () => {
    const zion = createZion();
    const repository = {
      loadCatalog: vi.fn(async () => ({ version: 1, tags: [] })),
      loadDocuments: vi.fn(async () => []),
      saveCatalog: vi.fn(async () => { throw new Error("disk full"); }),
      commitMutation: vi.fn()
    };
    const controller = createTagCatalogController({
      zion,
      repository,
      makeId: () => "tag-1",
      now: () => 1,
      flushPendingSave: () => {},
      applyCommittedDocument: () => {},
      onPersist: () => {}
    });
    await controller.initialize();

    await expect(controller.createTag({ name: "failed", parentId: null })).rejects.toThrow("disk full");
    expect(controller.getCatalog().tags).toEqual([]);
  });

  it("commits prepared rename once and updates in-memory documents", async () => {
    const zion = createZion();
    const repository = {
      loadCatalog: vi.fn(async () => ({
        version: 1,
        tags: [{ id: "a", name: "project", parentId: null, order: 0, createdAt: 1 }]
      })),
      loadDocuments: vi.fn(async () => [{ id: "s1", text: "#project" }]),
      saveCatalog: vi.fn(async (catalog) => catalog),
      commitMutation: vi.fn(async () => true)
    };
    const applyCommittedDocument = vi.fn();
    const controller = createTagCatalogController({
      zion,
      repository,
      makeId: () => "unused",
      now: () => 1,
      flushPendingSave: vi.fn(),
      applyCommittedDocument,
      onPersist: vi.fn()
    });
    await controller.initialize();

    const plan = await controller.prepareRename({ tagId: "a", nextName: "work" });
    expect(plan.affected.occurrences).toBe(1);
    await controller.commitPreparedMutation(plan);

    expect(repository.commitMutation).toHaveBeenCalledTimes(1);
    expect(applyCommittedDocument).toHaveBeenCalledWith("s1", "#work");
    expect(zion.events.emit).toHaveBeenCalledWith("sessions/tagCatalogChanged", expect.any(Object));
  });
});
```

- [ ] **Step 2: Run the tests and verify the controller is missing**

Run:

```bash
npx vitest run tests/session-tag-controller.test.js
```

Expected: FAIL because `features/tag-catalog-controller.js` does not exist.

- [ ] **Step 3: Implement controller publication, rollback, and locking**

Create `extensions/dev.session-manager/features/tag-catalog-controller.js`:

```js
import { extractObsidianMetadata } from "../../shared/obsidian-metadata.js";
import {
  createCatalogTag,
  createEmptyTagCatalog,
  normalizeTagCatalog,
  reconcileTagCatalog,
  reorderCatalogTag
} from "../model/tag-catalog.js";
import { planDeleteTag, planRenameTag } from "./tag-mutations.js";

export function createTagCatalogController(opts) {
  const zion = opts.zion || window.zion;
  let catalog = createEmptyTagCatalog();
  let busy = false;

  const publish = (next, reason) => {
    catalog = normalizeTagCatalog(next);
    zion.state.set("sessions.tagCatalogMem", catalog);
    zion.events.emit("sessions/tagCatalogChanged", { catalog, reason });
  };

  const persistOptimistic = async (next, reason) => {
    if (busy) throw new Error("TAG_MUTATION_BUSY");
    const previous = catalog;
    busy = true;
    publish(next, reason);
    try {
      await opts.repository.saveCatalog(next);
      opts.onPersist("tagCatalog");
      return catalog;
    } catch (error) {
      publish(previous, "rollback");
      throw error;
    } finally {
      busy = false;
    }
  };

  const loadPreparedDocuments = async () => {
    opts.flushPendingSave();
    return opts.repository.loadDocuments();
  };

  return {
    getCatalog: () => normalizeTagCatalog(catalog),
    isBusy: () => busy,
    async initialize() {
      const stored = await opts.repository.loadCatalog();
      const documents = await opts.repository.loadDocuments();
      const labels = documents.flatMap((document) =>
        extractObsidianMetadata(document.text).tags.map((tag) => tag.label)
      );
      const reconciled = reconcileTagCatalog(stored, labels, {
        makeId: opts.makeId,
        now: opts.now
      });
      catalog = reconciled.catalog;
      if (reconciled.changed) await opts.repository.saveCatalog(catalog);
      publish(catalog, "initialize");
      return catalog;
    },
    async reconcileDocument(id, text) {
      const labels = extractObsidianMetadata(text).tags.map((tag) => tag.label);
      const reconciled = reconcileTagCatalog(catalog, labels, {
        makeId: opts.makeId,
        now: opts.now
      });
      if (!reconciled.changed) return catalog;
      return persistOptimistic(reconciled.catalog, `document:${id}`);
    },
    async createTag(input) {
      const next = createCatalogTag(catalog, {
        id: opts.makeId(),
        name: input.name,
        parentId: input.parentId || null,
        now: opts.now()
      });
      return persistOptimistic(next, "create");
    },
    async reorderTag(input) {
      return persistOptimistic(reorderCatalogTag(catalog, input), "reorder");
    },
    async prepareRename(input) {
      if (busy) throw new Error("TAG_MUTATION_BUSY");
      return planRenameTag({
        catalog,
        tagId: input.tagId,
        nextName: input.nextName,
        documents: await loadPreparedDocuments()
      });
    },
    async prepareDelete(tagId) {
      if (busy) throw new Error("TAG_MUTATION_BUSY");
      return planDeleteTag({
        catalog,
        tagId,
        documents: await loadPreparedDocuments()
      });
    },
    async commitPreparedMutation(plan) {
      if (busy) throw new Error("TAG_MUTATION_BUSY");
      busy = true;
      try {
        await opts.repository.commitMutation(plan);
        catalog = normalizeTagCatalog(plan.catalog);
        publish(catalog, plan.kind);
        for (const document of plan.documents) {
          zion.state.set(`sessions.doc.${document.id}`, document.text);
          await Promise.resolve(opts.applyCommittedDocument(document.id, document.text));
        }
        opts.onPersist("tagCatalog");
        return true;
      } finally {
        busy = false;
      }
    }
  };
}
```

- [ ] **Step 4: Run controller and lower-level tests**

Run:

```bash
npx vitest run tests/session-tag-controller.test.js tests/session-tag-storage.test.js tests/session-tag-mutations.test.js tests/session-tag-catalog.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit controller behavior**

```bash
git add extensions/dev.session-manager/features/tag-catalog-controller.js tests/session-tag-controller.test.js
git commit -m "feat(sessions): coordinate tag catalog changes"
```

## Task 6: Synchronize Atomically Persisted Documents with Open Editors

**Files:**
- Modify: `extensions/dev.session-manager/commands/doc-apis.js:29-211`
- Modify: `tests/session-doc-commands.test.js`

- [ ] **Step 1: Add a failing no-second-write synchronization test**

Append to `tests/session-doc-commands.test.js`:

```js
it("applies an already-persisted tag mutation without writing the document again", async () => {
  const docs = new Map([["s1", "#project"]]);
  const metas = new Map([["s1", { id: "s1", title: "s1", updatedAt: 1 }]]);
  const commands = createCommands();
  const saveDoc = vi.fn((id, text) => docs.set(id, text));
  const dispatch = vi.fn();
  const editor = {
    getValue: () => "#project",
    getView: () => ({
      state: { doc: { toString: () => "#project", length: 8 } },
      dispatch
    })
  };
  const zion = {
    commands,
    state: {
      get: (key) => key === "sessions.currentId" ? "s1" : docs.get(key.replace("sessions.doc.", "")),
      set: (key, value) => {
        if (key.startsWith("sessions.doc.")) docs.set(key.slice("sessions.doc.".length), value);
      }
    },
    panels: {
      list: () => [{ id: "panel-a", activeTabId: "s1", tabs: [{ id: "s1" }] }],
      listEditors: () => [{ panelId: "panel-a", sessionId: "s1" }],
      getEditorBySession: () => editor
    },
    window: { activeEditor: editor }
  };

  registerSessionDocCommands({
    zion,
    loadDoc: (id) => docs.get(id) || "",
    loadMeta: (id) => ({ ...metas.get(id) }),
    saveDoc,
    saveMeta: (id, meta) => metas.set(id, meta),
    now: () => 2,
    hashString: (text) => `hash:${text}`,
    upsertIndexEntry: () => {},
    getIndex: () => [],
    refreshSessionsSidebarViewIfOpen: () => {}
  });

  await commands.executeCommand("zion.sessions.applyPersistedDoc", {
    id: "s1",
    text: "#work"
  });

  expect(saveDoc).not.toHaveBeenCalled();
  expect(docs.get("s1")).toBe("#work");
  expect(dispatch).toHaveBeenCalledWith({
    changes: { from: 1, to: 8, insert: "work" }
  });
  expect(metas.get("s1")).toMatchObject({ size: 5, hash: "hash:#work" });
});
```

Also add `vi` to the existing Vitest import in that file.

- [ ] **Step 2: Run the focused test and verify the command is absent**

Run:

```bash
npx vitest run tests/session-doc-commands.test.js
```

Expected: FAIL because `zion.sessions.applyPersistedDoc` is not registered.

- [ ] **Step 3: Refactor runtime synchronization and register the command**

In `registerSessionDocCommands`, extract the state/editor/meta portion of
`applyDocText`:

```js
const syncDocumentEditors = (id, nextText) => {
  const updatedEditors = new Set();
  try {
    const panelsApi = zion.panels || zion.panelManager;
    const editorEntries = panelsApi?.listEditors?.() || [];
    for (const entry of Array.isArray(editorEntries) ? editorEntries : []) {
      if (entry?.sessionId !== id || !entry?.panelId) continue;
      const editor = panelsApi?.getEditorBySession?.(entry.panelId, id) || null;
      if (!editor || updatedEditors.has(editor)) continue;
      updatedEditors.add(editor);
      dispatchMinimalDocUpdate(editor, nextText);
    }
  } catch {}
  if (updatedEditors.size) return;
  const cur = zion.state.get("sessions.currentId");
  if (cur !== id) return;
  try {
    const activeEditor = zion.window.activeEditor || null;
    const editorSessionId = activeEditor?.getView?.()?.dom?.getAttribute?.("data-session-id")
      || activeEditor?.getSessionId?.()
      || activeEditor?.core?.getSessionId?.()
      || null;
    if (editorSessionId === id) dispatchMinimalDocUpdate(activeEditor, nextText);
  } catch {}
};

const applyDocTextToRuntime = (
  id,
  text,
  { persistDocument = true, notifyDocChanged = true } = {}
) => {
  const nextText = String(text || "");
  if (persistDocument) saveDoc(id, nextText);
  else {
    try { zion.state.set(`sessions.doc.${id}`, nextText); } catch {}
  }
  const meta = loadMeta(id);
  meta.size = nextText.length;
  meta.hash = hashString(nextText);
  saveMeta(id, meta);
  if (notifyDocChanged) {
    try { onDocChanged?.(id, nextText, meta); } catch {}
  }
  syncDocumentEditors(id, nextText);
  return true;
};

const applyDocText = (id, text) =>
  applyDocTextToRuntime(id, text, { persistDocument: true });
```

Register and return this command:

```js
const dApplyPersistedDoc = zion.commands.registerCommand(
  "zion.sessions.applyPersistedDoc",
  ({ id, text } = {}) => {
    if (!id) return false;
    return applyDocTextToRuntime(id, text, {
      persistDocument: false,
      notifyDocChanged: false
    });
  }
);
```

Add `dApplyPersistedDoc` to the returned disposable array.

- [ ] **Step 4: Run document and autosave tests**

Run:

```bash
npx vitest run tests/session-doc-commands.test.js tests/session-autosave-plugin.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit editor synchronization**

```bash
git add extensions/dev.session-manager/commands/doc-apis.js tests/session-doc-commands.test.js
git commit -m "feat(sessions): sync committed tag document edits"
```

## Task 7: Include the Catalog in Remote Snapshots and Main Storage Initialization

**Files:**
- Create: `extensions/dev.session-manager/storage/snapshot.js`
- Create: `tests/session-tag-snapshot.test.js`
- Modify: `extensions/dev.session-manager/main.js:1-20, 326-603, 1141-1148, 1667-1692, 2154-2172`

- [ ] **Step 1: Write failing snapshot tests**

Create `tests/session-tag-snapshot.test.js`:

```js
import { describe, expect, it } from "vitest";
import {
  createSessionSnapshot,
  getSnapshotTagCatalog
} from "../extensions/dev.session-manager/storage/snapshot.js";

describe("session snapshot tag catalog", () => {
  it("round-trips empty tags and manual order", () => {
    const tagCatalog = {
      version: 1,
      tags: [
        { id: "b", name: "beta", parentId: null, order: 0, createdAt: 2 },
        { id: "a", name: "alpha", parentId: null, order: 1, createdAt: 1 }
      ]
    };
    const snapshot = createSessionSnapshot({
      now: 10,
      tree: { id: "root", type: "folder", children: [] },
      index: [],
      docs: [],
      metas: [],
      tagCatalog
    });

    expect(snapshot.version).toBe(2);
    expect(getSnapshotTagCatalog(snapshot)).toEqual(tagCatalog);
    expect(getSnapshotTagCatalog({ version: 1 })).toEqual({ version: 1, tags: [] });
  });
});
```

- [ ] **Step 2: Run the test and verify the snapshot module is missing**

Run:

```bash
npx vitest run tests/session-tag-snapshot.test.js
```

Expected: FAIL because `storage/snapshot.js` does not exist.

- [ ] **Step 3: Add pure snapshot helpers**

Create `extensions/dev.session-manager/storage/snapshot.js`:

```js
import { normalizeTagCatalog } from "../model/tag-catalog.js";

export function createSessionSnapshot(input) {
  return {
    version: 2,
    updatedAt: Number(input.now || 0),
    tree: input.tree || null,
    index: Array.isArray(input.index) ? input.index : [],
    docs: (input.docs || [])
      .filter((item) => item?.id)
      .map((item) => ({ id: String(item.id), text: String(item.text || "") })),
    metas: (input.metas || [])
      .filter((item) => item?.id)
      .map((item) => ({ id: String(item.id), meta: item.meta || {} })),
    tagCatalog: normalizeTagCatalog(input.tagCatalog)
  };
}

export function getSnapshotTagCatalog(snapshot) {
  return normalizeTagCatalog(snapshot?.tagCatalog);
}
```

- [ ] **Step 4: Wire repository, controller, autosave reconciliation, and snapshots**

Update imports in `extensions/dev.session-manager/main.js`:

```js
import {
  openSessionsDB,
  idbCommitTagMutation,
  idbDel,
  idbGet,
  idbGetAll,
  idbGetKV,
  idbSet,
  idbSetKV
} from "./storage/idb.js";
import { createTagCatalogRepository } from "./storage/tag-catalog.js";
import { createTagCatalogController } from "./features/tag-catalog-controller.js";
import { createSessionSnapshot, getSnapshotTagCatalog } from "./storage/snapshot.js";
```

Replace the object construction in `collectSessionSnapshot` with:

```js
return createSessionSnapshot({
  now: now(),
  tree: window.zion?.state?.get("sessions.treeMem") || null,
  index: window.zion?.state?.get("sessions.indexMem") || [],
  docs,
  metas,
  tagCatalog: window.zion?.state?.get("sessions.tagCatalogMem")
});
```

In `hydrateLocalCacheFromRemote`, after writing the index:

```js
const tagCatalog = getSnapshotTagCatalog(snapshot);
await idbSetKV(DB_NAME, "tagCatalog.v1", tagCatalog);
window.zion?.state?.set("sessions.tagCatalogMem", tagCatalog);
```

After `createSessionDocRepo`, construct the repository and controller:

```js
const tagCatalogRepository = createTagCatalogRepository({
  dbName: DB_NAME,
  idbGetKV,
  idbSetKV,
  idbGetAll,
  idbCommitTagMutation
});

const tagCatalogController = createTagCatalogController({
  zion: window.zion,
  repository: tagCatalogRepository,
  makeId: () => `tag_${genId()}`,
  now,
  flushPendingSave: () => {
    const id = window.zion?.state?.get("sessions.currentId");
    if (id) window.zion?.commands?.executeCommand("zion.sessions.flushPendingSave", id);
  },
  applyCommittedDocument: (id, text) =>
    window.zion?.commands?.executeCommand("zion.sessions.applyPersistedDoc", { id, text }),
  onPersist: () => scheduleRemoteSnapshot("tagCatalog")
});
```

Immediately before and after `await syncRemoteStorage()` in
`initSessionsStorage`, initialize the controller so a dirty outbound snapshot
contains the local catalog and a clean inbound snapshot refreshes controller
state:

```js
await tagCatalogController.initialize();
await syncRemoteStorage();
await tagCatalogController.initialize();
scheduleRemoteSnapshot("tagCatalog");
```

Pass `tagCatalogController` into `createSessionsSidebarViewManager`:

```js
const __sidebarViewManager = createSessionsSidebarViewManager({
  zion: window.zion,
  createSessionsListRenderer,
  openAncestors,
  getIndex,
  loadMeta,
  loadDoc,
  tagCatalogController
});
```

In the autosave callback after `maybeUpdateLocalAutoTitle`:

```js
if (meta?.id) {
  void tagCatalogController.reconcileDocument(meta.id, loadDoc(meta.id)).catch((error) => {
    warnStorageIssue("reconcileTagCatalog", error);
  });
}
```

Set `registerSessionDocCommands.onDocChanged` to this exact callback:

```js
onDocChanged: (id, text) => {
  try { maybeUpdateLocalAutoTitle(id); } catch {}
  void tagCatalogController.reconcileDocument(id, text).catch((error) => {
    warnStorageIssue("reconcileTagCatalog", error);
  });
}
```

- [ ] **Step 5: Run storage tests, build, and commit**

Run:

```bash
npx vitest run tests/session-tag-snapshot.test.js tests/session-tag-controller.test.js tests/session-tag-storage.test.js tests/session-doc-commands.test.js
npm run build
```

Expected: all tests PASS and Vite build exits 0.

Commit:

```bash
git add extensions/dev.session-manager/main.js extensions/dev.session-manager/storage/snapshot.js tests/session-tag-snapshot.test.js
git commit -m "feat(sessions): initialize and sync tag catalog"
```

## Task 8: Offer Unused Catalog Tags in Editor Completion

**Files:**
- Create: `tests/obsidian-tag-completion.test.ts`
- Modify: `src/editor/extensions/obsidian/completion.ts:83-115, 165-228`

- [ ] **Step 1: Write failing completion tests**

Create `tests/obsidian-tag-completion.test.ts`:

```ts
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { beforeEach, describe, expect, it } from "vitest";
import { completeObsidianTags } from "../src/editor/extensions/obsidian/completion";

describe("obsidian tag catalog completion", () => {
  beforeEach(() => {
    (window as any).zion = {
      state: {
        get(key: string) {
          if (key === "sessions.tagCatalogMem") {
            return {
              version: 1,
              tags: [
                { id: "project", name: "project", parentId: null, order: 0, createdAt: 1 },
                { id: "zion", name: "zion", parentId: "project", order: 0, createdAt: 2 },
                { id: "unused", name: "unused", parentId: null, order: 1, createdAt: 3 }
              ]
            };
          }
          if (key === "sessions.catalog") return [];
          return null;
        }
      },
      commands: { executeCommand: () => "" }
    };
  });

  it("offers nested and unused catalog paths", () => {
    const state = EditorState.create({ doc: "#pro" });
    const result = completeObsidianTags(new CompletionContext(state, 4, true));
    expect(result?.options.map((option) => option.label)).toContain("#project/zion");
  });

  it("keeps local document tags ahead of catalog tags", () => {
    const state = EditorState.create({ doc: "#unused text\\n#u" });
    const result = completeObsidianTags(new CompletionContext(state, state.doc.length, true));
    expect(result?.options[0].label).toBe("#unused");
    expect(result?.options[0].detail).toContain("当前对话");
  });
});
```

- [ ] **Step 2: Run the test and verify catalog paths are absent**

Run:

```bash
npx vitest run tests/obsidian-tag-completion.test.ts
```

Expected: FAIL because completion only scans documents.

- [ ] **Step 3: Read ordered full paths from catalog state**

Add this helper before `getGlobalSessionTags`:

```ts
function getCatalogTagLabels(): string[] {
  const raw = (window as any)?.zion?.state?.get?.("sessions.tagCatalogMem");
  const tags = Array.isArray(raw?.tags) ? raw.tags : [];
  const byId = new Map(tags.map((tag: any) => [String(tag.id), tag]));
  const cache = new Map<string, string>();
  const pathFor = (id: string, stack = new Set<string>()): string => {
    if (cache.has(id)) return cache.get(id) || "";
    const tag: any = byId.get(id);
    if (!tag || stack.has(id)) return "";
    const nextStack = new Set(stack);
    nextStack.add(id);
    const parent = tag.parentId ? pathFor(String(tag.parentId), nextStack) : "";
    const path = parent ? `${parent}/${tag.name}` : `#${tag.name}`;
    cache.set(id, path);
    return path;
  };
  return [...tags]
    .sort((a: any, b: any) =>
      String(a.parentId || "").localeCompare(String(b.parentId || "")) ||
      Number(a.order || 0) - Number(b.order || 0)
    )
    .map((tag: any) => pathFor(String(tag.id)))
    .filter(Boolean);
}
```

In `completeObsidianTags`, insert catalog options after local tags and before
the global document scan:

```ts
for (const label of getCatalogTagLabels()) {
  if (seen.has(label)) continue;
  if (query && !label.slice(1).toLowerCase().startsWith(query)) continue;
  seen.add(label);
  options.push({
    label,
    detail: "Tag catalog",
    type: "keyword",
    apply: label
  });
  if (options.length >= 50) break;
}
```

- [ ] **Step 4: Run completion and parser tests**

Run:

```bash
npx vitest run tests/obsidian-tag-completion.test.ts tests/obsidian-tags.test.ts tests/obsidian-metadata.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit completion integration**

```bash
git add src/editor/extensions/obsidian/completion.ts tests/obsidian-tag-completion.test.ts
git commit -m "feat(editor): complete tags from session catalog"
```

## Task 9: Support Active Sidebar Actions and 440 px Width

**Files:**
- Modify: `tests/workbench-sidebar-chrome.test.js`
- Modify: `src/ui/workbench/runtime.ts:646-745`
- Modify: `src/ui/workbench/workbench.ts:2568-2594`
- Modify: `src/ext/registry.ts:2388-2396`
- Modify: `src/types/zion.d.ts:302-328`

- [ ] **Step 1: Add failing Workbench chrome tests**

Append to `tests/workbench-sidebar-chrome.test.js`:

```js
it("renders dynamic sidebar action pressed state", async () => {
  const host = document.createElement("div");
  host.style.height = "600px";
  document.body.appendChild(host);
  const state = createState();
  let active = true;
  bindWorkbenchCore({
    state,
    events: { emit: () => {}, on: () => ({ dispose() {} }) }
  });
  const wb = initWorkbench(host);
  const dispView = sideBarRuntime.registerView({
    id: "sessions.list",
    pluginId: "dev.session-manager",
    title: "Sessions",
    headerActions: [{
      id: "split",
      title: "Hide tag column",
      icon: "$(layout-sidebar-left)",
      active: () => active,
      onClick: () => { active = !active; }
    }],
    component: { render: () => {} }
  });
  sideBarRuntime.show();
  sideBarRuntime.activateView("sessions.list");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const button = document.querySelector(".zion-sidebar-action[aria-label='Hide tag column']");
  expect(button?.classList.contains("is-active")).toBe(true);
  expect(button?.getAttribute("aria-pressed")).toBe("true");

  dispView.dispose();
  wb.dispose();
  host.remove();
});

it("accepts the approved 440px split width", () => {
  const state = createState();
  bindWorkbenchCore({
    state,
    events: { emit: () => {}, on: () => ({ dispose() {} }) }
  });
  sideBarRuntime.setWidth(440);
  expect(sideBarRuntime.getWidth()).toBe(440);
});
```

- [ ] **Step 2: Run the test and verify both failures**

Run:

```bash
npx vitest run tests/workbench-sidebar-chrome.test.js
```

Expected: FAIL because active sidebar actions are not rendered and width is
clamped to 420.

- [ ] **Step 3: Render active state and expand the runtime width ceiling**

Change `SideBarRuntime.setWidth`:

```ts
setWidth(px: number): void {
  const w = Math.max(180, Math.min(560, Math.round(px)));
  core?.state.set("ui.sideBar.width", w);
  this.emitter.emit();
}
```

Inside the sidebar header action loop in `workbench.ts`, after setting the aria
label:

```ts
const actionActive = (() => {
  try {
    return typeof a.active === "function" ? !!a.active() : !!a.active;
  } catch {
    return false;
  }
})();
btn.classList.toggle("is-active", actionActive);
btn.setAttribute("aria-pressed", actionActive ? "true" : "false");
```

Expose width in `src/ext/registry.ts`:

```ts
setWidth: (w: number) => sideBarRuntime.setWidth(w),
getWidth: () => sideBarRuntime.getWidth()
```

Add to `src/types/zion.d.ts`:

```ts
setWidth(w: number): void;
getWidth(): number;
```

- [ ] **Step 4: Run Workbench tests**

Run:

```bash
npx vitest run tests/workbench-sidebar-chrome.test.js tests/workbench-runtime.test.js tests/workbench-resize-keeps-view.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Workbench support**

```bash
git add src/ui/workbench/runtime.ts src/ui/workbench/workbench.ts src/ext/registry.ts src/types/zion.d.ts tests/workbench-sidebar-chrome.test.js
git commit -m "feat(workbench): support active wide sidebar actions"
```

## Task 10: Build the Searchable Tag Tree

**Files:**
- Create: `extensions/dev.session-manager/ui/tag-tree.js`
- Create: `tests/session-tag-tree.test.js`

- [ ] **Step 1: Write failing tree interaction tests**

Create `tests/session-tag-tree.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTagTreeView } from "../extensions/dev.session-manager/ui/tag-tree.js";

const catalog = {
  version: 1,
  tags: [
    { id: "project", name: "project", parentId: null, order: 0, createdAt: 1 },
    { id: "zion", name: "zion", parentId: "project", order: 0, createdAt: 2 },
    { id: "research", name: "research", parentId: null, order: 1, createdAt: 3 }
  ]
};

describe("session tag tree view", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps ancestors visible while searching", () => {
    const host = document.createElement("div");
    const view = createTagTreeView({
      host,
      catalog,
      selectedId: null,
      collapsedIds: new Set(),
      counts: new Map([["project", 2], ["zion", 1]]),
      onAction: vi.fn(),
      t: (_key, fallback) => fallback,
      iconHtml: (name) => `<span>${name}</span>`
    });

    const search = host.querySelector(".zion-sessions-tag-search");
    search.value = "zion";
    search.dispatchEvent(new Event("input"));

    expect(Array.from(host.querySelectorAll(".zion-sessions-tag-label")).map((node) => node.textContent)).toEqual([
      "#project",
      "zion"
    ]);
    view.dispose();
  });

  it("emits select, inline rename, and same-parent reorder actions", () => {
    const host = document.createElement("div");
    const onAction = vi.fn();
    createTagTreeView({
      host,
      catalog,
      selectedId: null,
      collapsedIds: new Set(),
      counts: new Map(),
      onAction,
      t: (_key, fallback) => fallback,
      iconHtml: (name) => `<span>${name}</span>`
    });

    const project = host.querySelector("[data-tag-id='project']");
    project.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onAction).toHaveBeenCalledWith({ type: "select", id: "project" });

    project.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    const input = project.querySelector("input");
    input.value = "work";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onAction).toHaveBeenCalledWith({ type: "rename", id: "project", name: "work" });

    const research = host.querySelector("[data-tag-id='research']");
    const values = new Map();
    const transfer = {
      setData: (type, value) => values.set(type, value),
      getData: (type) => values.get(type) || ""
    };
    const dragStart = new Event("dragstart", { bubbles: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: transfer });
    research.dispatchEvent(dragStart);
    const drop = new Event("drop", { bubbles: true });
    Object.defineProperty(drop, "dataTransfer", { value: transfer });
    project.dispatchEvent(drop);
    expect(onAction).toHaveBeenCalledWith({
      type: "reorder",
      id: "research",
      beforeId: "project"
    });
  });

  it("creates an empty root catalog entry through the inline add row", () => {
    const host = document.createElement("div");
    const onAction = vi.fn();
    createTagTreeView({
      host,
      catalog,
      selectedId: null,
      collapsedIds: new Set(),
      counts: new Map(),
      onAction,
      t: (_key, fallback) => fallback,
      iconHtml: (name) => `<span>${name}</span>`
    });

    host.querySelector(".zion-sessions-tag-add")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const input = host.querySelector(".zion-sessions-tag-row.is-creating input");
    input.value = "empty";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onAction).toHaveBeenCalledWith({
      type: "create",
      parentId: null,
      name: "empty"
    });
  });

  it("shows inline confirmation counts for destructive actions", () => {
    const host = document.createElement("div");
    const view = createTagTreeView({
      host,
      catalog,
      selectedId: null,
      collapsedIds: new Set(),
      counts: new Map(),
      onAction: vi.fn(),
      t: (_key, fallback) => fallback,
      iconHtml: (name) => `<span>${name}</span>`
    });

    view.showConfirmation({
      tagId: "project",
      message: "Delete 2 tags in 1 session?",
      confirmLabel: "Delete",
      onConfirm: vi.fn()
    });
    expect(host.querySelector(".zion-sessions-tag-confirm")?.textContent).toContain("Delete 2 tags");
  });
});
```

- [ ] **Step 2: Run the test and verify the view is missing**

Run:

```bash
npx vitest run tests/session-tag-tree.test.js
```

Expected: FAIL because `ui/tag-tree.js` does not exist.

- [ ] **Step 3: Implement the view API and stable row structure**

Create `extensions/dev.session-manager/ui/tag-tree.js` with this public shape:

```js
import { getTagPathMap } from "../model/tag-catalog.js";

export function createTagTreeView(opts) {
  const state = {
    catalog: opts.catalog,
    selectedId: opts.selectedId || null,
    collapsedIds: new Set(opts.collapsedIds || []),
    counts: opts.counts || new Map(),
    query: "",
    creatingRoot: false,
    confirmation: null
  };
  const root = document.createElement("section");
  root.className = "zion-sessions-tag-tree";
  opts.host.replaceChildren(root);

  const emit = (action) => {
    try { opts.onAction(action); } catch {}
  };

  const orderedChildren = (parentId) => state.catalog.tags
    .filter((tag) => (tag.parentId || null) === (parentId || null))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  const descendantsMatch = (id, query) => {
    const tag = state.catalog.tags.find((item) => item.id === id);
    if (!tag) return false;
    if (tag.name.toLowerCase().includes(query)) return true;
    return orderedChildren(id).some((child) => descendantsMatch(child.id, query));
  };

  const findRow = (id) => Array.from(root.querySelectorAll("[data-tag-id]"))
    .find((row) => row.dataset.tagId === id) || null;

  const startInlineEdit = (row, tag, mode) => {
    if (row.querySelector("input")) return;
    const label = row.querySelector(".zion-sessions-tag-label");
    const input = document.createElement("input");
    input.className = "zion-sessions-tag-inline-input";
    input.value = mode === "rename" ? tag.name : "";
    input.setAttribute("aria-label", mode === "rename" ? "Rename tag" : "New child tag");
    label.hidden = true;
    label.before(input);
    const finish = (commit) => {
      const name = input.value.trim();
      input.remove();
      label.hidden = false;
      if (!commit || !name) return;
      emit(mode === "rename"
        ? { type: "rename", id: tag.id, name }
        : { type: "create", parentId: tag.id, name });
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.focus();
    input.select();
  };
```

Add this render function to the module:

```js
  const render = () => {
    const previousScroll = root.querySelector(".zion-sessions-tags-body")?.scrollTop || 0;
    root.replaceChildren();

    const header = document.createElement("div");
    header.className = "zion-sessions-tags-header";
    const title = document.createElement("span");
    title.textContent = opts.t("tags.title", "Tags");
    const count = document.createElement("span");
    count.className = "zion-sessions-tag-total";
    count.textContent = String(state.catalog.tags.length);
    const add = document.createElement("button");
    add.type = "button";
    add.className = "zion-sessions-tag-add";
    add.innerHTML = opts.iconHtml("add", 14);
    add.setAttribute("aria-label", opts.t("tags.add", "New tag"));
    add.onclick = () => {
      state.creatingRoot = true;
      render();
    };
    header.append(title, count, add);

    const search = document.createElement("input");
    search.type = "search";
    search.className = "zion-sessions-tag-search";
    search.placeholder = opts.t("tags.search", "Search tags");
    search.value = state.query;
    search.oninput = () => {
      state.query = search.value.toLowerCase().trim();
      render();
    };

    const body = document.createElement("div");
    body.className = "zion-sessions-tags-body";
    body.setAttribute("role", "tree");
    const paths = getTagPathMap(state.catalog);
    const query = state.query;

    if (state.creatingRoot) {
      const createRow = document.createElement("div");
      createRow.className = "zion-sessions-tag-row is-creating";
      const input = document.createElement("input");
      input.className = "zion-sessions-tag-inline-input";
      input.setAttribute("aria-label", opts.t("tags.add", "New tag"));
      const finish = async (commit) => {
        const name = input.value.trim();
        if (commit && name) {
          try {
            await emit({ type: "create", parentId: null, name });
          } catch {
            return;
          }
        }
        state.creatingRoot = false;
        render();
      };
      input.onkeydown = (event) => {
        event.stopPropagation();
        if (event.key === "Enter") void finish(true);
        if (event.key === "Escape") void finish(false);
      };
      createRow.appendChild(input);
      body.appendChild(createRow);
      requestAnimationFrame(() => input.focus());
    }

    const appendTag = (tag, depth) => {
      if (query && !descendantsMatch(tag.id, query)) return;
      const children = orderedChildren(tag.id);
      const collapsed = !query && state.collapsedIds.has(tag.id);
      const row = document.createElement("div");
      row.className = "zion-sessions-tag-row";
      row.dataset.tagId = tag.id;
      row.draggable = true;
      row.tabIndex = 0;
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(depth + 1));
      row.setAttribute("aria-selected", state.selectedId === tag.id ? "true" : "false");
      if (children.length) row.setAttribute("aria-expanded", collapsed ? "false" : "true");
      if (state.selectedId === tag.id) row.classList.add("is-selected");
      row.style.setProperty("--tag-depth", String(depth));

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "zion-sessions-tag-marker";
      toggle.innerHTML = children.length ? opts.iconHtml(collapsed ? "chevron-right" : "chevron-down", 10) : "";
      toggle.disabled = children.length === 0;
      toggle.onclick = (event) => {
        event.stopPropagation();
        if (collapsed) state.collapsedIds.delete(tag.id);
        else state.collapsedIds.add(tag.id);
        emit({ type: "collapse", id: tag.id, collapsed: !collapsed });
        render();
      };

      const dot = document.createElement("span");
      dot.className = "zion-sessions-tag-dot";
      dot.style.background = opts.colorForTag?.(paths.get(tag.id) || tag.name) || "var(--accent)";
      const label = document.createElement("span");
      label.className = "zion-sessions-tag-label";
      label.textContent = depth === 0 ? `#${tag.name}` : tag.name;
      label.title = paths.get(tag.id) || tag.name;
      const usage = document.createElement("span");
      usage.className = "zion-sessions-tag-count";
      usage.textContent = String(state.counts.get(tag.id) || 0);
      const menu = document.createElement("button");
      menu.type = "button";
      menu.className = "zion-sessions-tag-actions";
      menu.innerHTML = opts.iconHtml("ellipsis", 13);
      menu.setAttribute("aria-label", opts.t("tags.actions", "Tag actions"));
      menu.onclick = (event) => {
        event.stopPropagation();
        emit({ type: "menu", id: tag.id, anchor: menu });
      };

      row.append(toggle, dot, label, usage, menu);
      row.onclick = () => emit({ type: "select", id: tag.id });
      row.onkeydown = (event) => {
        const visibleRows = Array.from(body.querySelectorAll("[data-tag-id]"));
        const currentIndex = visibleRows.indexOf(row);
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const delta = event.key === "ArrowUp" ? -1 : 1;
          visibleRows[Math.max(0, Math.min(visibleRows.length - 1, currentIndex + delta))]?.focus();
          return;
        }
        if (event.key === "Enter") emit({ type: "select", id: tag.id });
        if (event.key === "F2") {
          event.preventDefault();
          startInlineEdit(row, tag, "rename");
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          if (children.length && !collapsed) {
            state.collapsedIds.add(tag.id);
            render();
          } else if (tag.parentId) {
            findRow(tag.parentId)?.focus();
          }
        }
        if (event.key === "ArrowRight" && children.length) {
          event.preventDefault();
          if (collapsed) {
            state.collapsedIds.delete(tag.id);
            render();
          } else {
            findRow(children[0].id)?.focus();
          }
        }
      };
      row.ondragstart = (event) => {
        event.dataTransfer?.setData("application/x-zion-tag-id", tag.id);
        event.dataTransfer?.setData("text/plain", tag.id);
      };
      row.ondragover = (event) => {
        const sourceId = event.dataTransfer?.getData("application/x-zion-tag-id");
        const source = state.catalog.tags.find((item) => item.id === sourceId);
        if (source && (source.parentId || null) === (tag.parentId || null)) {
          event.preventDefault();
          row.classList.add("is-drop-before");
        }
      };
      row.ondragleave = () => row.classList.remove("is-drop-before");
      row.ondrop = (event) => {
        event.preventDefault();
        row.classList.remove("is-drop-before");
        const sourceId = event.dataTransfer?.getData("application/x-zion-tag-id");
        if (sourceId && sourceId !== tag.id) {
          emit({ type: "reorder", id: sourceId, beforeId: tag.id });
        }
      };
      body.appendChild(row);
      if (!collapsed) children.forEach((child) => appendTag(child, depth + 1));
    };

    orderedChildren(null).forEach((tag) => appendTag(tag, 0));
    if (!body.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "zion-sessions-empty-note";
      empty.textContent = query
        ? opts.t("tags.noMatches", "No matching tags")
        : opts.t("tags.empty", "No tags");
      body.appendChild(empty);
    }
    root.append(header, search, body);
    body.scrollTop = previousScroll;

    if (state.confirmation) {
      const target = findRow(state.confirmation.tagId);
      if (target) {
        const confirm = document.createElement("div");
        confirm.className = "zion-sessions-tag-confirm";
        const message = document.createElement("span");
        message.textContent = state.confirmation.message;
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = opts.t("ui.cancel", "Cancel");
        cancel.onclick = () => { state.confirmation = null; render(); };
        const accept = document.createElement("button");
        accept.type = "button";
        accept.className = "danger";
        accept.textContent = state.confirmation.confirmLabel;
        accept.onclick = () => state.confirmation.onConfirm();
        confirm.append(message, cancel, accept);
        target.after(confirm);
      }
    }
  };

  render();
  return {
    render(next = {}) {
      if (next.catalog) state.catalog = next.catalog;
      if ("selectedId" in next) state.selectedId = next.selectedId;
      if (next.counts) state.counts = next.counts;
      render();
    },
    startRootCreate() {
      state.creatingRoot = true;
      render();
    },
    startChildCreate(id) {
      const row = findRow(id);
      const tag = state.catalog.tags.find((item) => item.id === id);
      if (row && tag) startInlineEdit(row, tag, "create");
    },
    startRename(id) {
      const row = findRow(id);
      const tag = state.catalog.tags.find((item) => item.id === id);
      if (row && tag) startInlineEdit(row, tag, "rename");
    },
    showConfirmation(confirmation) {
      state.confirmation = confirmation;
      render();
    },
    dispose() {
      root.remove();
    }
  };
}
```

- [ ] **Step 4: Run tag tree tests**

Run:

```bash
npx vitest run tests/session-tag-tree.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit the reusable tree view**

```bash
git add extensions/dev.session-manager/ui/tag-tree.js tests/session-tag-tree.test.js
git commit -m "feat(sessions): add searchable tag tree view"
```

## Task 11: Compose the Internal Split and Header Toggle

**Files:**
- Create: `tests/session-sidebar-tag-split.test.js`
- Modify: `extensions/dev.session-manager/ui/sidebar-view.js:1-318, 383-687, 1040-1074`
- Modify: `extensions/dev.session-manager/main.js:1141-1155, 1515-1571`
- Modify: `extensions/dev.session-manager/manifest.json:55-135`

- [ ] **Step 1: Write failing split-mode manager tests**

Create `tests/session-sidebar-tag-split.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsSidebarViewManager } from "../extensions/dev.session-manager/ui/sidebar-view.js";

function createManager(width = 240) {
  let sidebarWidth = width;
  const commands = new Map();
  const state = new Map([
    ["ui.responsive.mode", "full"],
    ["sessions.tagCatalogMem", { version: 1, tags: [] }]
  ]);
  const zion = {
    state: {
      get: (key) => state.get(key),
      set: (key, value) => state.set(key, value),
      onDidChange: () => ({ dispose() {} })
    },
    events: { on: () => ({ dispose() {} }) },
    commands: {
      registerCommand: (id, fn) => {
        commands.set(id, fn);
        return { dispose: () => commands.delete(id) };
      },
      executeCommand: (id, arg) => commands.get(id)?.(arg)
    },
    sideBar: {
      getWidth: () => sidebarWidth,
      setWidth: (next) => { sidebarWidth = next; }
    },
    usage: { getRecords: () => [] }
  };
  const controller = {
    getCatalog: () => state.get("sessions.tagCatalogMem"),
    createTag: vi.fn(),
    reorderTag: vi.fn(),
    prepareRename: vi.fn(),
    prepareDelete: vi.fn(),
    commitPreparedMutation: vi.fn()
  };
  const manager = createSessionsSidebarViewManager({
    zion,
    tagCatalogController: controller,
    createSessionsListRenderer: () => Object.assign(() => {}, {
      syncSessionIndex: () => {},
      syncCurrentSession: () => null
    }),
    getIndex: () => [],
    loadMeta: () => ({}),
    loadDoc: () => ""
  });
  return { manager, zion, getWidth: () => sidebarWidth };
}

describe("session sidebar tag split", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
  });

  it("widens to 440 and restores the previous width", () => {
    const { manager, getWidth } = createManager(240);
    expect(manager.toggleTagSplit()).toBe(true);
    expect(getWidth()).toBe(440);
    expect(manager.isTagSplitEnabled()).toBe(true);

    expect(manager.toggleTagSplit()).toBe(false);
    expect(getWidth()).toBe(240);
  });

  it("renders split columns and falls back below 380px", () => {
    const { manager } = createManager(440);
    manager.toggleTagSplit();
    const host = document.createElement("div");
    Object.defineProperty(host, "clientWidth", { value: 440, configurable: true });
    document.body.appendChild(host);
    const mounted = manager.mountInto(host);

    expect(host.querySelector(".zion-sessions-sidebar-shell")?.classList.contains("is-tag-split")).toBe(true);
    Object.defineProperty(host, "clientWidth", { value: 360, configurable: true });
    mounted.applyResponsiveLayout();
    expect(host.querySelector(".zion-sessions-sidebar-shell")?.classList.contains("is-tag-split")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify the manager methods are absent**

Run:

```bash
npx vitest run tests/session-sidebar-tag-split.test.js
```

Expected: FAIL because `toggleTagSplit`, `isTagSplitEnabled`, and split markup do
not exist.

- [ ] **Step 3: Add persisted toggle and width restoration**

At manager scope in `sidebar-view.js`, add:

```js
const LS_TAG_SPLIT_ENABLED = "zion.sessions.sidebar.tagSplitEnabled";
const LS_TAG_COLUMN_WIDTH = "zion.sessions.sidebar.tagColumnWidth";
const LS_PRE_TAG_SPLIT_WIDTH = "zion.sessions.sidebar.preTagSplitWidth";
const TAG_SPLIT_TARGET_WIDTH = 440;
const TAG_SPLIT_BREAKPOINT = 380;

function isTagSplitEnabled() {
  try { return localStorage.getItem(LS_TAG_SPLIT_ENABLED) === "1"; } catch { return false; }
}

function toggleTagSplit() {
  const next = !isTagSplitEnabled();
  const currentWidth = Number(zion?.sideBar?.getWidth?.() || 240);
  const mode = zion?.state?.get?.("ui.responsive.mode");
  const desktopPresentation = mode !== "compact" && mode !== "medium";
  try {
    if (next) {
      localStorage.setItem(LS_PRE_TAG_SPLIT_WIDTH, String(currentWidth));
      localStorage.setItem(LS_TAG_SPLIT_ENABLED, "1");
      const requested = desktopPresentation
        ? Math.max(currentWidth, TAG_SPLIT_TARGET_WIDTH)
        : currentWidth;
      zion?.sideBar?.setWidth?.(requested);
    } else {
      localStorage.removeItem(LS_TAG_SPLIT_ENABLED);
      const restore = Number(localStorage.getItem(LS_PRE_TAG_SPLIT_WIDTH) || "240");
      if (Number.isFinite(restore)) zion?.sideBar?.setWidth?.(restore);
    }
  } catch {}
  current?.applyResponsiveLayout?.();
  current?.render?.();
  return next;
}

function ensureTagSplitWidth() {
  if (!isTagSplitEnabled()) return;
  const mode = zion?.state?.get?.("ui.responsive.mode");
  if (mode === "compact" || mode === "medium") return;
  const currentWidth = Number(zion?.sideBar?.getWidth?.() || 240);
  if (currentWidth < TAG_SPLIT_TARGET_WIDTH) {
    zion?.sideBar?.setWidth?.(TAG_SPLIT_TARGET_WIDTH);
  }
}
```

Call `ensureTagSplitWidth()` when the Sessions view mounts. Return
`toggleTagSplit` and `isTagSplitEnabled` from the manager.

- [ ] **Step 4: Replace stacked ownership with split composition and tag actions**

Import `createTagTreeView` and `getTagPathMap`. In `mountInto`, create:

```js
const shell = document.createElement("div");
shell.className = "zion-sessions-sidebar-shell";
const tagColumn = document.createElement("aside");
tagColumn.className = "zion-sessions-tag-column";
const divider = document.createElement("div");
divider.className = "zion-sessions-tag-divider";
divider.setAttribute("role", "separator");
divider.setAttribute("aria-orientation", "vertical");
const sessionColumn = document.createElement("main");
sessionColumn.className = "zion-sessions-session-column";
const tagsHost = document.createElement("div");
tagsHost.className = "zion-sessions-tags-panel";
const calendarHost = document.createElement("div");
calendarHost.className = "zion-sessions-day-panel";
const listWrap = document.createElement("div");
listWrap.className = "zion-sessions-list";
const list = document.createElement("div");
listWrap.appendChild(list);
tagColumn.append(tagsHost, calendarHost);
sessionColumn.appendChild(listWrap);
shell.append(tagColumn, divider, sessionColumn);
container.appendChild(shell);
```

Implement layout switching without rebuilding the session list:

```js
const applyResponsiveLayout = () => {
  const width = container.clientWidth || container.getBoundingClientRect?.().width || 0;
  const mode = zion?.state?.get?.("ui.responsive.mode");
  const split = isTagSplitEnabled()
    && mode !== "compact"
    && mode !== "medium"
    && width >= TAG_SPLIT_BREAKPOINT;
  shell.classList.toggle("is-tag-split", split);
  if (split) {
    tagColumn.append(tagsHost, calendarHost);
    sessionColumn.appendChild(listWrap);
    shell.append(tagColumn, divider, sessionColumn);
  } else {
    shell.append(listWrap, tagsHost, calendarHost);
  }
};
```

Use the catalog ID as selection state and derive its current path for the
existing filter:

```js
const selectedPath = () =>
  getTagPathMap(opts.tagCatalogController.getCatalog()).get(selectedTagId) || "";
```

Use it in the existing session filter:

```js
const tagFilter = selectedPath();
if (tagFilter && !tagMatchesFilter(getSessionTags(sid), tagFilter)) return false;
```

Build parent-inclusive session counts before rendering the tag tree:

```js
const buildTagCounts = (catalog) => {
  const paths = getTagPathMap(catalog);
  const counts = new Map(catalog.tags.map((tag) => [tag.id, new Set()]));
  for (const session of getSessionIndex()) {
    const labels = new Set(getSessionTags(session.id));
    for (const [id, path] of paths) {
      if (Array.from(labels).some((label) => label === path || label.startsWith(`${path}/`))) {
        counts.get(id).add(String(session.id));
      }
    }
  }
  return new Map(Array.from(counts, ([id, sessions]) => [id, sessions.size]));
};
```

Replace inline tag rendering with `createTagTreeView` and use this action
dispatcher:

```js
const handleTagAction = async (action) => {
  try {
    if (action.type === "select") {
      selectedTagId = selectedTagId === action.id ? null : action.id;
      renderAll();
      return;
    }
    if (action.type === "create") {
      await opts.tagCatalogController.createTag({
        name: action.name,
        parentId: action.parentId || null
      });
      renderAll();
      return;
    }
    if (action.type === "reorder") {
      await opts.tagCatalogController.reorderTag({
        id: action.id,
        beforeId: action.beforeId
      });
      renderAll();
      return;
    }
    if (action.type === "rename") {
      const plan = await opts.tagCatalogController.prepareRename({
        tagId: action.id,
        nextName: action.name
      });
      if (plan.affected.occurrences === 0) {
        await opts.tagCatalogController.commitPreparedMutation(plan);
      } else {
        tagTree.showConfirmation({
          tagId: action.id,
          message: t("tags.renameConfirm", "Rename {tags} tags in {sessions} sessions?", {
            tags: plan.affected.tags,
            sessions: plan.affected.sessions
          }),
          confirmLabel: t("tags.rename", "Rename"),
          onConfirm: async () => {
            await opts.tagCatalogController.commitPreparedMutation(plan);
            renderAll();
          }
        });
      }
      return;
    }
    if (action.type === "delete") {
      const plan = await opts.tagCatalogController.prepareDelete(action.id);
      tagTree.showConfirmation({
        tagId: action.id,
        message: t("tags.deleteConfirm", "Delete {tags} tags from {sessions} sessions?", {
          tags: plan.affected.tags,
          sessions: plan.affected.sessions
        }),
        confirmLabel: t("tags.delete", "Delete"),
        onConfirm: async () => {
          await opts.tagCatalogController.commitPreparedMutation(plan);
          if (!opts.tagCatalogController.getCatalog().tags.some((tag) => tag.id === selectedTagId)) {
            selectedTagId = null;
          }
          renderAll();
        }
      });
      return;
    }
  } catch (error) {
    zion?.notification?.show?.(String(error?.message || error), {
      type: "error",
      duration: 5000,
      dismissible: true
    });
    throw error;
  }
};
```

Create the tag tree with catalog counts and deterministic colors:

```js
const tagTree = createTagTreeView({
  host: tagsHost,
  catalog: opts.tagCatalogController.getCatalog(),
  selectedId: selectedTagId,
  collapsedIds: collapsedTagNodes,
  counts: buildTagCounts(opts.tagCatalogController.getCatalog()),
  onAction: handleTagAction,
  colorForTag: tagDotColor,
  t,
  iconHtml
});
```

Subscribe to catalog and responsive changes:

```js
disposables.push(zion?.state?.onDidChange?.("sessions.tagCatalogMem", () => renderAll()));
disposables.push(zion?.state?.onDidChange?.("ui.responsive.mode", () => applyResponsiveLayout()));
```

Add divider drag with clamped 140-240 px width:

```js
const readTagColumnWidth = () => {
  const value = Number(localStorage.getItem(LS_TAG_COLUMN_WIDTH) || "168");
  return Math.max(140, Math.min(240, Number.isFinite(value) ? value : 168));
};
shell.style.setProperty("--sessions-tag-column-w", `${readTagColumnWidth()}px`);
divider.onmousedown = (event) => {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = readTagColumnWidth();
  divider.classList.add("is-dragging");
  const move = (moveEvent) => {
    const width = Math.max(140, Math.min(240, startWidth + moveEvent.clientX - startX));
    shell.style.setProperty("--sessions-tag-column-w", `${width}px`);
  };
  const up = () => {
    const width = Math.round(tagColumn.getBoundingClientRect().width || readTagColumnWidth());
    localStorage.setItem(LS_TAG_COLUMN_WIDTH, String(Math.max(140, Math.min(240, width))));
    divider.classList.remove("is-dragging");
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
};
```

Preserve separate list/tag scroll positions and refresh the extracted tree
without recreating the session renderer:

```js
let listScrollTop = 0;
let tagScrollTop = 0;
const renderAll = (renderOptions = {}) => {
  listScrollTop = Number(listWrap.scrollTop || listScrollTop);
  tagScrollTop = Number(tagsHost.querySelector(".zion-sessions-tags-body")?.scrollTop || tagScrollTop);
  const catalog = opts.tagCatalogController.getCatalog();
  tagTree.render({
    catalog,
    selectedId: selectedTagId,
    counts: buildTagCounts(catalog)
  });
  renderCalendar();
  innerRender();
  if (renderOptions.preserveListScroll !== false) listWrap.scrollTop = listScrollTop;
  const tagBody = tagsHost.querySelector(".zion-sessions-tags-body");
  if (tagBody) tagBody.scrollTop = tagScrollTop;
};
```

Observe width changes, apply the initial layout, and expose the method required
by the manager test:

```js
const layoutResizeObserver = new ResizeObserver(() => applyResponsiveLayout());
layoutResizeObserver.observe(container);
disposables.push({ dispose: () => layoutResizeObserver.disconnect() });
applyResponsiveLayout();

const mounted = {
  render: renderAll,
  applyResponsiveLayout,
  anchorToCurrent,
  revealSession,
  toggleMenu: () => {
    headerMenu.style.display = headerMenu.style.display === "none" ? "block" : "none";
  },
  dispose: () => {
    for (const disposable of disposables) {
      try { disposable?.dispose?.(); } catch {}
    }
    tagTree.dispose();
  }
};
current = mounted;
return mounted;
```

In `main.js`, add the header action between New and Actions:

```js
{
  id: "sessions.tagSplit",
  get title() {
    return __sidebarViewManager.isTagSplitEnabled()
      ? t("tags.hideColumn", "Hide tag column")
      : t("tags.showColumn", "Show tag column");
  },
  get ariaLabel() {
    return this.title;
  },
  icon: "$(layout-sidebar-left)",
  active: () => __sidebarViewManager.isTagSplitEnabled(),
  onClick: () => window.zion.commands.executeCommand("zion.sessions.toggleTagSplit")
}
```

Register `zion.sessions.toggleTagSplit` during activation and add it to
`manifest.json`:

```js
const dToggleTagSplit = window.zion.commands.registerCommand(
  "zion.sessions.toggleTagSplit",
  () => __sidebarViewManager.toggleTagSplit()
);
ctx.subscriptions.push(dToggleTagSplit);
```

```json
{
  "id": "zion.sessions.toggleTagSplit",
  "title": "Toggle Sessions Tag Column",
  "titleKey": "dev.session-manager.cmd.toggleTagSplit",
  "categoryKey": "dev.session-manager.category.sessions"
}
```

- [ ] **Step 5: Run split, tree, and session list tests and commit**

Run:

```bash
npx vitest run tests/session-sidebar-tag-split.test.js tests/session-tag-tree.test.js tests/session-list-renderer.test.js tests/workbench-sidebar-chrome.test.js
```

Expected: PASS.

Commit:

```bash
git add extensions/dev.session-manager/ui/sidebar-view.js extensions/dev.session-manager/main.js extensions/dev.session-manager/manifest.json tests/session-sidebar-tag-split.test.js
git commit -m "feat(sessions): split tags from session list"
```

## Task 12: Finish Menus, Styling, Localization, and Verification

**Files:**
- Modify: `extensions/dev.session-manager/ui/tag-tree.js`
- Modify: `extensions/dev.session-manager/styles.css:352-500`
- Modify: `extensions/dev.session-manager/main.js:30-255`
- Modify: `tests/session-tag-tree.test.js`

- [ ] **Step 1: Add failing menu and validation recovery tests**

Append to `tests/session-tag-tree.test.js`:

```js
it("routes menu commands and keeps invalid inline edits visible", async () => {
  const host = document.createElement("div");
  const onAction = vi.fn((action) => {
    if (action.type === "rename" && action.name.includes("/")) {
      const error = new Error("TAG_INVALID_NAME");
      error.code = "TAG_INVALID_NAME";
      throw error;
    }
  });
  const view = createTagTreeView({
    host,
    catalog,
    selectedId: null,
    collapsedIds: new Set(),
    counts: new Map(),
    onAction,
    t: (_key, fallback) => fallback,
    iconHtml: (name) => `<span>${name}</span>`
  });

  view.openMenu("project");
  const rename = host.querySelector("[data-tag-command='rename']");
  rename.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const input = host.querySelector("[data-tag-id='project'] input");
  input.value = "bad/name";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(host.querySelector("[data-tag-id='project'] input")).toBeTruthy();
  expect(host.querySelector(".zion-sessions-tag-inline-error")?.textContent).toBe("Invalid tag name");
  view.dispose();
});
```

- [ ] **Step 2: Run the test and verify menu/error recovery is incomplete**

Run:

```bash
npx vitest run tests/session-tag-tree.test.js
```

Expected: FAIL because `openMenu` and inline error persistence are absent.

- [ ] **Step 3: Complete the node menu and inline error states**

Replace `emit` with a promise-returning implementation so inline editors can
stay mounted when an action fails:

```js
const emit = (action) => Promise.resolve().then(() => opts.onAction(action));
```

Replace the `finish` function inside `startInlineEdit` with:

```js
const finish = async (commit) => {
  const name = input.value.trim();
  if (!commit || !name) {
    input.remove();
    label.hidden = false;
    return;
  }
  input.parentElement?.querySelector(".zion-sessions-tag-inline-error")?.remove();
  try {
    await emit(mode === "rename"
      ? { type: "rename", id: tag.id, name }
      : { type: "create", parentId: tag.id, name });
    input.remove();
    label.hidden = false;
  } catch (failure) {
    const error = document.createElement("span");
    error.className = "zion-sessions-tag-inline-error";
    error.textContent = failure?.code === "TAG_DUPLICATE"
      ? opts.t("tags.duplicate", "A sibling tag already uses this name")
      : opts.t("tags.invalid", "Invalid tag name");
    input.after(error);
    input.focus();
    input.select();
  }
};
```

Call it from key handling with `void finish(true)` and `void finish(false)`.

Replace the root-create `finish` function with:

```js
const finish = async (commit) => {
  const name = input.value.trim();
  if (!commit || !name) {
    state.creatingRoot = false;
    render();
    return;
  }
  createRow.querySelector(".zion-sessions-tag-inline-error")?.remove();
  try {
    await emit({ type: "create", parentId: null, name });
    state.creatingRoot = false;
    render();
  } catch (failure) {
    const error = document.createElement("span");
    error.className = "zion-sessions-tag-inline-error";
    error.textContent = failure?.code === "TAG_DUPLICATE"
      ? opts.t("tags.duplicate", "A sibling tag already uses this name")
      : opts.t("tags.invalid", "Invalid tag name");
    input.after(error);
    input.focus();
    input.select();
  }
};
```

Add `openMenu(id)` to `tag-tree.js` with three commands:

```js
const menuCommands = [
  { id: "newChild", label: opts.t("tags.newChild", "New child tag") },
  { id: "rename", label: opts.t("tags.rename", "Rename") },
  { id: "delete", label: opts.t("tags.delete", "Delete"), danger: true }
];
```

Render the menu inside the tag column, anchor it to the row action, and route:

```js
const openMenu = (tagId) => {
  root.querySelector(".zion-sessions-tag-menu")?.remove();
  const row = findRow(tagId);
  if (!row) return;
  const menu = document.createElement("div");
  menu.className = "zion-sessions-tag-menu";
  menu.setAttribute("role", "menu");
  for (const command of menuCommands) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.tagCommand = command.id;
    button.textContent = command.label;
    if (command.danger) button.classList.add("danger");
    button.onclick = () => {
      menu.remove();
      if (command.id === "newChild") api.startChildCreate(tagId);
      if (command.id === "rename") api.startRename(tagId);
      if (command.id === "delete") void emit({ type: "delete", id: tagId });
    };
    menu.appendChild(button);
  }
  row.after(menu);
  menu.querySelector("button")?.focus();
};
```

Change the row overflow handler to:

```js
menu.onclick = (event) => {
  event.stopPropagation();
  openMenu(tag.id);
};
```

Replace the anonymous returned object with the complete `api` object below:

```js
const api = {
  render(next = {}) {
    if (next.catalog) state.catalog = next.catalog;
    if ("selectedId" in next) state.selectedId = next.selectedId;
    if (next.counts) state.counts = next.counts;
    render();
  },
  startRootCreate() {
    state.creatingRoot = true;
    render();
  },
  startChildCreate(id) {
    const row = findRow(id);
    const tag = state.catalog.tags.find((item) => item.id === id);
    if (row && tag) startInlineEdit(row, tag, "create");
  },
  startRename(id) {
    const row = findRow(id);
    const tag = state.catalog.tags.find((item) => item.id === id);
    if (row && tag) startInlineEdit(row, tag, "rename");
  },
  showConfirmation(confirmation) {
    state.confirmation = confirmation;
    render();
  },
  openMenu,
  dispose() {
    root.remove();
  }
};
return api;
```


- [ ] **Step 4: Add flat Workbench styling and all localization keys**

Add these layout rules to `extensions/dev.session-manager/styles.css`:

```css
.zion-sessions-sidebar-shell {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.zion-sessions-sidebar-shell.is-tag-split {
  display: grid;
  grid-template-columns: var(--sessions-tag-column-w, 168px) 5px minmax(220px, 1fr);
}

.zion-sessions-tag-column,
.zion-sessions-session-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.zion-sessions-tag-column {
  border-right: 1px solid var(--surface-border-soft, var(--border));
}

.zion-sessions-tag-divider {
  position: relative;
  width: 5px;
  cursor: col-resize;
  background: transparent;
}

.zion-sessions-tag-divider::after {
  content: "";
  position: absolute;
  inset: 0 2px;
  background: transparent;
}

.zion-sessions-tag-divider:hover::after,
.zion-sessions-tag-divider.is-dragging::after {
  background: var(--accent);
}

.zion-sessions-sidebar-shell:not(.is-tag-split) .zion-sessions-tag-divider,
.zion-sessions-sidebar-shell:not(.is-tag-split) .zion-sessions-tag-column,
.zion-sessions-sidebar-shell:not(.is-tag-split) .zion-sessions-session-column {
  display: contents;
}

.zion-sessions-sidebar-shell.is-tag-split .zion-sessions-tags-panel {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0 !important;
  padding: 7px 8px 4px !important;
  border-top: 0 !important;
  overflow: hidden;
}

.zion-sessions-sidebar-shell.is-tag-split .zion-sessions-day-panel {
  flex: 0 0 auto;
  margin: 0 8px 8px !important;
}

.zion-sessions-sidebar-shell.is-tag-split .zion-sessions-tags-body {
  max-height: none !important;
  min-height: 0;
  overflow: auto;
}

.zion-sessions-tags-header {
  display: flex;
  align-items: center;
  min-height: 24px;
  gap: 6px;
}

.zion-sessions-tag-total {
  color: color-mix(in srgb, var(--fg) 42%, transparent);
  font-size: 10px;
}

.zion-sessions-tag-add,
.zion-sessions-tag-actions {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  padding: 0;
  color: color-mix(in srgb, var(--fg) 56%, transparent);
  background: transparent;
}

.zion-sessions-tag-add:hover,
.zion-sessions-tag-actions:hover {
  color: var(--fg);
  background: var(--hover-bg);
}

.zion-sessions-tag-search,
.zion-sessions-tag-inline-input {
  box-sizing: border-box;
  width: 100%;
  height: 24px;
  border: 1px solid var(--surface-border-soft, var(--border));
  border-radius: 4px;
  padding: 0 7px;
  color: var(--fg);
  background: var(--bg);
  font: inherit;
}

.zion-sessions-tag-row {
  padding-left: calc(5px + var(--tag-depth, 0) * 14px) !important;
}

.zion-sessions-tag-actions {
  opacity: 0;
  flex: 0 0 20px;
}

.zion-sessions-tag-row:hover .zion-sessions-tag-actions,
.zion-sessions-tag-row:focus-within .zion-sessions-tag-actions {
  opacity: 1;
}

.zion-sessions-tag-row.is-drop-before {
  box-shadow: inset 0 1px 0 var(--accent);
}

.zion-sessions-tag-inline-error {
  display: block;
  padding: 2px 6px 4px 30px;
  color: var(--danger);
  font-size: 10px;
}

.zion-sessions-tag-menu {
  display: flex;
  flex-direction: column;
  padding: 3px;
  border-top: 1px solid var(--surface-border-soft, var(--border));
  border-bottom: 1px solid var(--surface-border-soft, var(--border));
  background: var(--panel);
}

.zion-sessions-tag-menu button {
  min-height: 24px;
  border: 0;
  border-radius: 4px;
  padding: 3px 8px;
  color: var(--fg);
  background: transparent;
  text-align: left;
}

.zion-sessions-tag-menu button:hover,
.zion-sessions-tag-menu button:focus-visible {
  background: var(--hover-bg);
}

.zion-sessions-tag-menu button.danger {
  color: var(--danger);
}

.zion-sessions-tag-confirm {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 4px;
  min-height: 26px;
  padding: 2px 4px 2px 20px;
  border-top: 1px solid var(--surface-border-soft, var(--border));
  border-bottom: 1px solid var(--surface-border-soft, var(--border));
  font-size: 10px;
}

.zion-sessions-tag-confirm button {
  height: 20px;
  border: 0;
  border-radius: 4px;
  color: var(--fg);
  background: transparent;
}

.zion-sessions-tag-confirm button:hover {
  background: var(--hover-bg);
}

.zion-sessions-tag-confirm button.danger {
  color: var(--danger);
}
```

Add these exact entries to the Chinese `I18N_MESSAGES` object:

```js
"cmd.toggleTagSplit": "切换标签栏",
"tags.showColumn": "显示标签栏",
"tags.hideColumn": "隐藏标签栏",
"tags.search": "搜索标签",
"tags.add": "新建标签",
"tags.actions": "标签操作",
"tags.newChild": "新建子标签",
"tags.rename": "重命名",
"tags.delete": "删除",
"tags.renameConfirm": "重命名 {tags} 个标签并更新 {sessions} 个会话？",
"tags.deleteConfirm": "删除 {tags} 个标签并更新 {sessions} 个会话？",
"tags.noMatches": "没有匹配的标签",
"tags.invalid": "标签名称无效",
"tags.duplicate": "同级标签名称不能重复"
```

Add these exact entries to the English `I18N_MESSAGES` object:

```js
"cmd.toggleTagSplit": "Toggle tag column",
"tags.showColumn": "Show tag column",
"tags.hideColumn": "Hide tag column",
"tags.search": "Search tags",
"tags.add": "New tag",
"tags.actions": "Tag actions",
"tags.newChild": "New child tag",
"tags.rename": "Rename",
"tags.delete": "Delete",
"tags.renameConfirm": "Rename {tags} tags and update {sessions} sessions?",
"tags.deleteConfirm": "Delete {tags} tags and update {sessions} sessions?",
"tags.noMatches": "No matching tags",
"tags.invalid": "Invalid tag name",
"tags.duplicate": "A sibling tag already uses this name"
```

- [ ] **Step 5: Run the full verification matrix and commit**

Run targeted tests:

```bash
npx vitest run \
  tests/obsidian-metadata.test.js \
  tests/session-tag-catalog.test.js \
  tests/session-tag-mutations.test.js \
  tests/session-tag-storage.test.js \
  tests/session-tag-controller.test.js \
  tests/session-tag-snapshot.test.js \
  tests/obsidian-tag-completion.test.ts \
  tests/session-doc-commands.test.js \
  tests/session-tag-tree.test.js \
  tests/session-sidebar-tag-split.test.js \
  tests/session-list-renderer.test.js \
  tests/workbench-sidebar-chrome.test.js
```

Run the complete automated checks:

```bash
npx vitest run
npm run lint
npm run build
```

Expected: all tests PASS, ESLint exits 0, and Vite build exits 0.

Start the app:

```bash
npm run dev -- --host 127.0.0.1 --port 5173
```

Use browser automation to verify:

1. At 1440x900 and 1280x800, the header toggle widens from 240 px to 440 px.
2. The left column is 168 px, resizes only within 140-240 px, and remembers its
   width.
3. The tag tree and session list scroll independently.
4. The activity heatmap remains at the bottom of the left column.
5. Search retains ancestors; create, rename, delete, and sibling reorder work.
6. Parent rename/delete shows counts and changes valid document tags only.
7. At a Sessions view width below 380 px and in mobile mode, the layout returns
   to the existing vertical stack without horizontal overflow.
8. Light and dark themes have no overlapping text, actions, heatmap controls,
   or drag targets.

Commit:

```bash
git add extensions/dev.session-manager/ui/tag-tree.js extensions/dev.session-manager/styles.css extensions/dev.session-manager/main.js tests/session-tag-tree.test.js
git commit -m "feat(sessions): finish tag split interactions"
```

## Final Acceptance

- Split mode is opt-in and controlled from the Sessions header.
- Enabling at a narrower width requests 440 px; disabling restores the exact
  pre-split width.
- The split preference survives reload and suspends below 380 px or in compact
  Workbench modes.
- Empty manually created tags persist locally and in remote snapshots.
- Existing document tags reconcile into the catalog without deleting unused
  catalog entries.
- Completion includes unused catalog tags.
- Parent selection filters descendant tags and still composes with the date
  filter.
- Rename/delete mutate only valid parsed tags and commit documents plus catalog
  atomically.
- Failed create/reorder operations restore the prior visible catalog.
- Same-parent drag reorder persists; cross-parent drops do nothing.
- Existing session list, autosave, Workbench resize, and responsive tests remain
  green.
