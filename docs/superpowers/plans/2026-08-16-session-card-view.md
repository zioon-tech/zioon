# Session Card View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent balanced-density card mode to the sessions Sidebar without scanning session documents during Sidebar rendering.

**Architecture:** A shared pure helper extracts the first meaningful document block during autosave and stores it in session metadata, with idle background backfill for existing sessions. The Sidebar view manager owns the persisted list/card mode and passes card data callbacks into the existing list renderer, while Workbench renders stateful header actions consistently.

**Tech Stack:** JavaScript ES modules, Zion StateBus, IndexedDB-backed session metadata, Vitest, jsdom, CSS

---

### Task 1: Persist the document lead preview

**Files:**
- Create: `extensions/shared/session-preview.js`
- Modify: `extensions/dev.session-manager/editor/autosave-plugin.js`
- Test: `tests/session-preview.test.js`
- Test: `tests/session-autosave-plugin.test.js`

- [ ] Write tests covering implicit user text, leading tag-only lines, role
  blocks, and whitespace compaction.
- [ ] Implement `extractDocumentLeadPreview(text, maxLength)`.
- [ ] Set `meta.documentPreview` before every metadata save in autosave commit.
- [ ] Backfill missing previews in an idle task after storage synchronization.
- [ ] Run:

```bash
npm test -- --run tests/session-preview.test.js tests/session-autosave-plugin.test.js
```

### Task 2: Add persisted Sidebar view mode

**Files:**
- Modify: `extensions/dev.session-manager/ui/sidebar-view.js`
- Modify: `extensions/dev.session-manager/main.js`
- Modify: `src/ui/icons.ts`
- Test: `tests/session-sidebar-tag-split.test.js`
- Test: `tests/session-sidebar-header.test.js`

- [ ] Add a `list`/`card` mode stored at
  `zion.sessions.sidebar.viewMode`, defaulting to `list`.
- [ ] Expose `toggleSessionViewModeIfOpen()` and
  `getSessionViewMode()` from the Sidebar view manager.
- [ ] Register a `zion.sessions.toggleViewMode` command and a
  `layout-grid` header action before `sessions.tagSplit`.
- [ ] Mark both mode and tag actions active through `headerAction.active`, and
  teach Workbench to update `is-active` and `aria-pressed` after clicks.
- [ ] Pass `getViewMode` and `getSessionTagRecords` to the list renderer.
- [ ] Run:

```bash
npm test -- --run tests/session-sidebar-tag-split.test.js tests/session-sidebar-header.test.js
```

### Task 3: Render balanced session cards

**Files:**
- Modify: `extensions/dev.session-manager/ui/list-renderer.js`
- Modify: `extensions/dev.session-manager/styles.css`
- Test: `tests/session-list-renderer.test.js`

- [ ] Toggle the list's `is-card-view` class from `getViewMode()`.
- [ ] In card mode, append summary and metadata rows to session rows only.
- [ ] Render at most two unique tags and mark automatic tags.
- [ ] Render a compact relative update time.
- [ ] Keep list mode DOM and existing row handlers compatible.
- [ ] Run:

```bash
npm test -- --run tests/session-list-renderer.test.js tests/session-sidebar-tag-split.test.js
```

### Task 4: Verify and commit

- [ ] Run focused tests and ESLint:

```bash
npm test -- --run tests/session-preview.test.js tests/session-autosave-plugin.test.js tests/session-list-renderer.test.js tests/session-sidebar-tag-split.test.js tests/session-sidebar-header.test.js tests/workbench-sidebar-chrome.test.js
npx eslint extensions/shared/session-preview.js extensions/dev.session-manager/editor/autosave-plugin.js extensions/dev.session-manager/ui/sidebar-view.js extensions/dev.session-manager/ui/list-renderer.js extensions/dev.session-manager/main.js src/ui/icons.ts
```

- [ ] Run `npm run build`, restore generated `dist/index.html`, and verify both
  view modes in the browser.
- [ ] Commit:

```bash
git add extensions/shared/session-preview.js extensions/dev.session-manager/editor/autosave-plugin.js extensions/dev.session-manager/ui/sidebar-view.js extensions/dev.session-manager/ui/list-renderer.js extensions/dev.session-manager/styles.css extensions/dev.session-manager/main.js src/ui/icons.ts tests/session-preview.test.js tests/session-autosave-plugin.test.js tests/session-list-renderer.test.js tests/session-sidebar-tag-split.test.js tests/session-sidebar-header.test.js docs/superpowers/plans/2026-08-16-session-card-view.md
git commit -m "feat(sessions): add card view"
```
