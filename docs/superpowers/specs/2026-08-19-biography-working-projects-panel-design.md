# Biography Working Projects Panel Design

## Goal

Add a visible, read-only entry for M1 project working memory to the existing
Biography auxiliary panel. Users can scan current project state and open a
project's `project.md` in the Inspector without editing or creating project
files from the panel.

## Information Architecture

The section tabs become:

```text
概览 / 动态 / 工作项目 / 经历项目 / 摘要 / 档案
```

- **工作项目** reads `~/.zion-next/memory/projects/` and represents current
  work state.
- **经历项目** is the existing Biography event aggregation and represents
  historical evidence.

The two labels must remain distinct. The existing `projects` section keeps its
internal identifier and is relabeled `经历项目`; the new section uses
`working-projects`.

## Project Index Contract

`projects/index.md` remains a compact Markdown table:

```markdown
| 项目 | 状态 | 优先级 | 下一步 | 更新 |
|---|---|---|---|---|
| [Zion Next](./zion-next/project.md) | active | high | 完成 M1 | 2026-08-19 |
```

The first cell should be a relative Markdown link to the project's front-door
file. `projects-core.js` must update the empty scaffold and maintenance
instructions to establish this format for future model writes.

For compatibility, the panel also accepts plain-text first cells:

```markdown
| Zion Next | active | high | 完成 M1 | 2026-08-19 |
```

For a plain-text row, the panel first matches a project directory from a
one-level `/files/entries` listing by exact directory basename, then by a
case-insensitive slug comparison. If no unambiguous directory exists, the row
is still displayed but cannot open a project file.

The parser:

- ignores headings, block quotes, blank lines, the header row, and separator
  rows;
- accepts escaped Markdown table pipes;
- requires a non-empty project name;
- returns `name`, `status`, `priority`, `nextStep`, `updated`, and optional
  `relativePath`;
- rejects linked paths that are absolute, contain `..`, or do not end in
  `/project.md`;
- caps display at 200 rows.

## Loading And State

Opening **工作项目** starts one read-only load:

1. Resolve the existing Identity profile paths.
2. Read `projects/index.md`.
3. List direct children under `projects/` using `/files/entries?max_depth=1`.
4. Parse the index and resolve each row to a safe `project.md` path.
5. Read no project file until the user clicks a project.

The panel caches the result while the view is mounted. A refresh icon in the
**工作项目** section header clears and reloads only the working-project cache;
it does not reload Biography events or profile documents. Failure to list
directories is non-fatal: linked index rows still work, while unresolved legacy
rows remain visible.

Loading, index-read errors, empty indexes, and unresolved project paths have
separate states:

- loading: `正在读取工作项目…`;
- missing or empty index: `还没有工作项目`;
- load failure: `读取工作项目失败：<message>`;
- unresolved row: visible with a muted `未定位项目档案` label and disabled open
  affordance.

No state writes or automatic initialization occur from this view.

## Working Project View

The section starts with a compact intro:

- title: `当前工作状态`;
- hint: `来自 projects/index.md；点击项目可在 Inspector 中查看项目档案。`
- action: a refresh icon button with tooltip and accessible label
  `刷新工作项目`.

Each project is an individual flat card containing:

- project name;
- status badge;
- priority badge when present;
- next step, wrapping to at most three lines;
- update date;
- a chevron when the project path is resolvable.

Cards are keyboard accessible buttons only when resolvable. Unresolved cards
are non-interactive articles. Status colors are restrained and semantic:
`active`, `waiting`, `done`, and `archived`; unknown statuses use neutral
styling.

Below the project list are two compact document actions:

- `项目索引` opens `projects/index.md` in the Markdown Inspector;
- `杂思收件箱` reads and opens `projects/inbox.md` in the Markdown Inspector.

These are read-only actions. Missing files show an error notification and do
not create them.

## Inspector Behavior

Clicking a resolved project:

1. Reads the selected `project.md`.
2. Opens the existing Markdown document Inspector with:
   - title: the index project name;
   - display path relative to `~/.zion-next/memory/`;
   - a copy-content action;
   - no edit, write, or delete action.

While a click read is in progress, that project card is disabled and shows a
small loading state. Read failures leave the card in place and show a failure
notification.

## Component Boundaries

### `projects-core.js`

Add pure helpers for:

- parsing project-index Markdown;
- validating safe relative project links;
- resolving legacy plain-text rows against listed directories.

These helpers have no DOM, filesystem, or browser dependencies.

### `main.js`

Own:

- `/files/entries` and `/files/read` calls;
- loading/cache state for the new section;
- DOM rendering;
- Inspector and notification integration.

### `styles.css`

Add working-project list, status badge, metadata, and document-action styles.
Reuse Biography panel variables and existing 8px-or-smaller radii. The tab row
continues to scroll horizontally on narrow screens; six tab labels must never
overlap.

## Testing

Pure tests cover:

- linked and plain-text table rows;
- escaped pipes;
- malformed and unsafe links;
- header/separator filtering;
- legacy directory resolution and ambiguity;
- 200-row limit.

Plugin tests cover:

- the new tab labels;
- lazy loading of index and directory entries;
- project cards and metadata;
- opening a linked project in the Inspector;
- opening index and inbox documents;
- unresolved rows remaining visible and non-interactive;
- loading, empty, and read-error states;
- the section refresh action and cache invalidation;
- unchanged Biography project filtering under `经历项目`.

Browser verification covers the panel at standard desktop width and a narrow
320px panel width, including tab scrolling, project-card text wrapping, and
Inspector opening.

## Non-Goals

- Editing project files in the Biography panel.
- Creating projects or running `identity.initialize`.
- Scheduler heartbeats, reminders, notifications, or autonomous execution.
- Parsing arbitrary Markdown documents or supporting nested project indexes.
- Replacing the existing Biography project aggregation.
