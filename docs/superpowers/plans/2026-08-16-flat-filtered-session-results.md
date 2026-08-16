# Flat Filtered Session Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render tag- and date-filtered sidebar sessions as a flat result list without changing the persistent folder tree or selected folder.

**Architecture:** Add a generic `getFlatSessionResults` option to the shared list renderer. When enabled, project the loaded tree into a shallow root containing every recursive session node, then reuse the existing filter, sort, row/card, selection, menu, and drag rendering paths. The sidebar enables the option whenever a tag or activity-date filter is active.

**Tech Stack:** JavaScript ES modules, DOM APIs, Vitest with jsdom.

---

## File Map

- Modify `extensions/dev.session-manager/ui/list-renderer.js`: collect recursive sessions, project a flat root, and show a filtered empty state.
- Modify `extensions/dev.session-manager/ui/sidebar-view.js`: enable flat mode for active tag/date filters.
- Modify `extensions/dev.session-manager/main.js`: add localized no-match copy.
- Modify `tests/session-list-renderer.test.js`: verify collapsed nested matches render without folders.
- Modify `tests/session-sidebar-tag-split.test.js`: verify sidebar flat-mode wiring.

### Task 1: Flat List Projection

**Files:**
- Modify: `tests/session-list-renderer.test.js`
- Modify: `extensions/dev.session-manager/ui/list-renderer.js`

- [ ] **Step 1: Add a failing nested-session test**

Create a tree with a closed nested folder and pass:

```js
getSessionFilter: () => (node) => node.id === "nested-match",
getFlatSessionResults: () => true
```

Assert:

```js
expect(listEl.querySelector('[data-session-id="nested-match"]')).toBeTruthy();
expect(listEl.querySelector(".zion-session-row.is-folder")).toBeNull();
expect(listEl.querySelector('[data-session-id="other"]')).toBeNull();
expect(setFolderOpen).not.toHaveBeenCalledWith("folder-a", true);
```

- [ ] **Step 2: Run the focused test**

```bash
npx vitest run tests/session-list-renderer.test.js
```

Expected: FAIL because `getFlatSessionResults` is not implemented.

- [ ] **Step 3: Add recursive session collection**

In `list-renderer.js`:

```js
function collectSessionNodes(root, result = []) {
  if (!root) return result;
  if (root.type === "session") result.push(root);
  for (const child of root.children || []) collectSessionNodes(child, result);
  return result;
}
```

Accept the new factory option:

```js
getFlatSessionResults,
```

Project the tree inside `render`:

```js
const sourceTree = loadTree() || ensureInitialTree();
const flatSessionResults = !!getFlatSessionResults?.();
const tree = flatSessionResults && sourceTree
  ? { ...sourceTree, children: collectSessionNodes(sourceTree) }
  : sourceTree;
```

The existing `renderFolder(root, -1)` path then renders every matching session at depth zero and no folder row.

- [ ] **Step 4: Add filtered empty-state coverage**

Render flat mode with a filter that matches no session and assert:

```js
expect(listEl.textContent).toContain("No matching sessions.");
```

Add the renderer behavior after `renderFolder`:

```js
if (flatSessionResults && visibleOrder.length === 0) {
  const empty = document.createElement("div");
  empty.className = "zion-sessions-filter-empty";
  empty.textContent = t("ui.noMatchingSessions", "No matching sessions.");
  empty.style.opacity = "0.8";
  empty.style.fontSize = "12px";
  empty.style.padding = "8px 4px";
  listEl.appendChild(empty);
}
```

- [ ] **Step 5: Run list-renderer tests**

```bash
npx vitest run tests/session-list-renderer.test.js
```

Expected: PASS.

### Task 2: Sidebar Wiring and Localization

**Files:**
- Modify: `tests/session-sidebar-tag-split.test.js`
- Modify: `extensions/dev.session-manager/ui/sidebar-view.js`
- Modify: `extensions/dev.session-manager/main.js`

- [ ] **Step 1: Capture and test flat-mode wiring**

In the split-sidebar test fixture, capture the options passed to `createSessionsListRenderer`. Select a tag row, then assert:

```js
expect(captured.at(-1).getFlatSessionResults()).toBe(true);
expect(zion.state.set).not.toHaveBeenCalledWith(
  "sessions.selectedFolderId",
  expect.anything()
);
```

Clear the selected tag and assert `getFlatSessionResults()` returns false.

- [ ] **Step 2: Wire sidebar filter state**

Pass this option when creating the renderer:

```js
getFlatSessionResults: () => Boolean(
  selectedTag || selectedDay || selectedRangeDays
),
```

No folder or state mutation is added.

- [ ] **Step 3: Add localized empty-state strings**

Add:

```js
// zh-CN
"ui.noMatchingSessions": "没有匹配的会话",

// en-US
"ui.noMatchingSessions": "No matching sessions.",
```

- [ ] **Step 4: Run sidebar and list tests**

```bash
npx vitest run tests/session-list-renderer.test.js tests/session-sidebar-tag-split.test.js
```

Expected: PASS.

- [ ] **Step 5: Run regressions and lint**

```bash
npx vitest run tests/session-list-renderer.test.js tests/session-sidebar-tag-split.test.js tests/session-tree-commands.test.js tests/session-tag-index.test.js
npx eslint extensions/dev.session-manager/ui/list-renderer.js extensions/dev.session-manager/ui/sidebar-view.js extensions/dev.session-manager/main.js
git diff --check
```

Expected: all tests pass, ESLint exits `0`, and no whitespace errors are reported.

- [ ] **Step 6: Commit**

```bash
git add extensions/dev.session-manager/ui/list-renderer.js extensions/dev.session-manager/ui/sidebar-view.js extensions/dev.session-manager/main.js tests/session-list-renderer.test.js tests/session-sidebar-tag-split.test.js
git commit -m "feat(sessions): flatten filtered sidebar results"
```
