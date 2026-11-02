# Biography Working Projects Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `工作项目` tab to the Biography panel that shows `projects/index.md` rows and opens project files in the Markdown Inspector.

**Architecture:** Extend `projects-core.js` with pure Markdown-index parsing and safe path resolution. Keep local-tools reads, view cache, Inspector integration, and DOM rendering in `main.js`; add narrowly scoped Biography styles and plugin integration tests.

**Tech Stack:** JavaScript ES modules, DOM APIs, Zion local-tools/Inspector APIs, CSS, Vitest, Playwright browser verification.

---

## File Structure

- Modify `extensions/dev.identity/projects-core.js`: parse index rows, validate links, resolve legacy rows.
- Modify `tests/identity-projects-core.test.js`: pure parser and path safety tests.
- Modify `extensions/dev.identity/main.js`: load/cache/render work projects and open Markdown documents.
- Modify `extensions/dev.identity/styles.css`: work-project cards and narrow-panel behavior.
- Modify `tests/identity-plugin.test.js`: section, loading, Inspector, and compatibility coverage.

### Task 1: Project Index Parser And Resolver

**Files:**
- Modify: `extensions/dev.identity/projects-core.js`
- Modify: `tests/identity-projects-core.test.js`

- [ ] **Step 1: Add failing pure tests**

```js
it("parses linked and legacy project rows", () => {
  const rows = parseProjectIndex(`| 项目 | 状态 | 优先级 | 下一步 | 更新 |
|---|---|---|---|---|
| [Zion Next](./zion-next/project.md) | active | high | Ship \\| verify | 2026-08-19 |
| Legacy | waiting | medium | 等待反馈 | 2026-08-18 |`);
  expect(rows).toEqual([
    {
      name: "Zion Next",
      status: "active",
      priority: "high",
      nextStep: "Ship | verify",
      updated: "2026-08-19",
      relativePath: "zion-next/project.md"
    },
    {
      name: "Legacy",
      status: "waiting",
      priority: "medium",
      nextStep: "等待反馈",
      updated: "2026-08-18",
      relativePath: ""
    }
  ]);
});

it("rejects unsafe project links and resolves one legacy directory", () => {
  expect(parseProjectIndex("| [Bad](../secret/project.md) | active | | | |")[0].relativePath).toBe("");
  expect(resolveProjectIndexRows(
    [{ name: "Legacy", status: "active", priority: "", nextStep: "", updated: "", relativePath: "" }],
    [{ path: "/memory/projects/legacy", type: "dir" }],
    "/memory/projects"
  )[0].path).toBe("/memory/projects/legacy/project.md");
});
```

- [ ] **Step 2: Run the focused test**

Run: `npx vitest run tests/identity-projects-core.test.js`

Expected: FAIL because `parseProjectIndex` and `resolveProjectIndexRows` are not exported.

- [ ] **Step 3: Implement the pure API**

Add:

```js
export function parseProjectIndex(markdown, options = {}) {
  const limit = Math.min(200, Math.max(0, Number(options.limit) || 200));
  const rows = [];
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const cells = splitProjectTableRow(line);
    if (cells.length < 5 || isProjectTableHeader(cells)) continue;
    const linked = parseProjectLink(cells[0]);
    const name = compactLine(linked.name || cells[0]);
    if (!name) continue;
    rows.push({
      name,
      status: compactLine(cells[1]),
      priority: compactLine(cells[2]),
      nextStep: compactLine(cells[3]),
      updated: compactLine(cells[4]),
      relativePath: safeProjectRelativePath(linked.path)
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

export function resolveProjectIndexRows(rows, entries, projectsRoot) {
  const directories = normalizeProjectDirectories(entries, projectsRoot);
  return rows.map((row) => ({
    ...row,
    path: row.relativePath
      ? `${String(projectsRoot).replace(/\/$/, "")}/${row.relativePath}`
      : resolveLegacyProjectPath(row.name, directories, projectsRoot)
  }));
}
```

Private helpers split escaped table pipes, filter separator/header rows, accept
only relative paths ending in `/project.md`, reject `..`, absolute paths and
backslashes, and resolve a legacy row only when exactly one directory matches.
Update the index scaffold with a linked-row example and require linked project
cells in the maintenance instruction.

- [ ] **Step 4: Run tests and lint**

Run:

```bash
npx vitest run tests/identity-projects-core.test.js
npx eslint extensions/dev.identity/projects-core.js tests/identity-projects-core.test.js
```

Expected: PASS.

### Task 2: Biography Panel And Inspector Integration

**Files:**
- Modify: `extensions/dev.identity/main.js`
- Modify: `tests/identity-plugin.test.js`

- [ ] **Step 1: Add failing integration assertions**

Extend the existing Biography view fixture:

```js
biographyTab("工作项目").click();
await vi.waitFor(() => expect(host.textContent).toContain("完成 M1"));
const projectCard = host.querySelector(".zion-biography-working-project");
expect(projectCard?.textContent).toContain("Zion Next");
projectCard.click();
await vi.waitFor(() => expect(inspectorItem?.title).toBe("Zion Next"));
expect(inspectorItem.path).toBe("/Users/test/.zion-next/memory/projects/zion-next/project.md");

biographyTab("经历项目").click();
expect(host.textContent).toContain("memory-panel");
```

The fetch fixture returns a linked index row, a `/files/entries` directory
listing, project Markdown, and inbox Markdown.

- [ ] **Step 2: Run the focused test**

Run: `npx vitest run tests/identity-plugin.test.js -t "injects profile files"`

Expected: FAIL because the `工作项目` tab is absent.

- [ ] **Step 3: Add read-only local-tools helpers and state**

Add `readLocalDirectoryEntries(path)` beside the current file helpers. It calls:

```js
`${getLocalToolsBase()}/files/entries?path=${encodeURIComponent(path)}&max_depth=1`
```

It normalizes array or newline-string `results` into `{ path, type }[]`.

Inside `renderBiographyView`, add:

```js
let workingProjects = null;
let workingProjectsLoading = false;
let workingProjectsError = "";
let workingProjectsPromise = null;
const openingProjectPaths = new Set();
```

`loadWorkingProjects({ refresh = false })` resolves paths, reads the index,
lists project directories non-fatally, parses/resolves rows, caches
`{ index, rows, paths }`, and rerenders in `finally`.

- [ ] **Step 4: Render the new section and open documents**

Change labels to:

```js
["overview", "概览"],
["timeline", "动态"],
["working-projects", "工作项目"],
["projects", "经历项目"],
["digest", "摘要"],
["profile", "档案"]
```

On tab activation, lazily call `loadWorkingProjects()`.

Render a section intro with a codicon refresh button, project cards, and two
document buttons. Linked cards call an async opener that reads `project.md` and
then calls the existing `openBiographyDocumentInspector`. Index content is
already cached; inbox content is read only when clicked. Errors use
`window.zion.notification.show` and never write files.

- [ ] **Step 5: Run plugin tests and lint**

Run:

```bash
npx vitest run tests/identity-plugin.test.js
npx eslint extensions/dev.identity/main.js tests/identity-plugin.test.js
```

Expected: PASS.

### Task 3: Styling And Visual Verification

**Files:**
- Modify: `extensions/dev.identity/styles.css`
- Test: `tests/plugin-details.test.js`

- [ ] **Step 1: Add scoped styles**

Add `.zion-biography-working-projects`, `.zion-biography-working-project`,
status/priority badge, next-step, metadata, and document-action rules. Reuse
`--biography-border`, `--biography-card-bg`, and `--biography-card-hover`.
Cards use at most 8px radius; next-step text wraps to three lines.

At `max-width: 360px`, keep tabs `flex: 0 0 auto` so six labels scroll instead
of compressing or overlapping.

- [ ] **Step 2: Run all focused verification**

Run:

```bash
npx vitest run tests/identity-projects-core.test.js tests/identity-plugin.test.js tests/plugin-details.test.js
npx eslint extensions/dev.identity/projects-core.js extensions/dev.identity/main.js tests/identity-projects-core.test.js tests/identity-plugin.test.js
npm run build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Verify in the browser**

Use the running `tag-tree-panel` dev server. Initialize fixture project files if
the local profile is empty, then verify at normal panel width and 320px:

- tabs are visible or horizontally scrollable without overlap;
- project metadata wraps without clipping;
- linked cards open Markdown Inspector;
- index and inbox actions open read-only Inspector documents;
- no write request occurs while viewing.

- [ ] **Step 4: Commit only feature hunks**

```bash
git add extensions/dev.identity/projects-core.js extensions/dev.identity/styles.css tests/identity-projects-core.test.js
git add -p extensions/dev.identity/main.js tests/identity-plugin.test.js
git commit -m "feat(identity): add working projects panel"
```
