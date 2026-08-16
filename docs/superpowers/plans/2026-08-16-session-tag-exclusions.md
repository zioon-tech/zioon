# Session Tag Exclusions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, reversible suppression for falsely extracted session document tags from the Sessions tag tree and Context Panel.

**Architecture:** Extend the existing `sessions.tagIndex` entry with normalized exact/subtree exclusion rules. Session Manager remains the persistence owner and exposes public commands; the sidebar reads the filtered index and Context Panel invokes commands while subscribing to the same state.

**Tech Stack:** JavaScript ES modules, Zion StateBus and command registry, IndexedDB KV storage, Vitest, jsdom

---

### Task 1: Tag Exclusion Model

**Files:**
- Modify: `extensions/dev.session-manager/model/session-tag-index.js`
- Test: `tests/session-tag-index.test.js`

- [ ] Add tests proving exact rules do not match descendants, subtree rules do, malformed and duplicate rules normalize, and `updateSessionTagIndex` preserves rules.
- [ ] Run `npx vitest run tests/session-tag-index.test.js`; expect failures for missing exclusion APIs.
- [ ] Add `normalizeTagExclusions`, `isSessionTagExcluded`, `getRawIndexedSessionTags`, `getSessionTagExclusions`, `excludeSessionTags`, `restoreSessionTagExclusion`, and filter `getIndexedSessionTags`.
- [ ] Re-run the focused test; expect all assertions to pass.
- [ ] Commit the model change.

### Task 2: Session Manager Commands and Persistence

**Files:**
- Modify: `extensions/dev.session-manager/main.js`
- Test: `tests/session-tag-exclusion-commands.test.js`

- [ ] Add command tests for `zion.sessions.getTagExtractionState`, `zion.sessions.excludeTag`, `zion.sessions.restoreTag`, and `zion.sessions.excludeTagSubtreeBulk`.
- [ ] Implement a single mutation helper that publishes `sessions.tagIndex`, queues IndexedDB persistence, refreshes the sidebar, and returns a structured result.
- [ ] Register commands with normalized payloads. Bulk exclusion must calculate affected session and concrete tag counts before mutation and only mutate document-index matches.
- [ ] Run command and index tests; expect all to pass.
- [ ] Commit the command layer.

### Task 3: Sessions Tag Tree Bulk Confirmation

**Files:**
- Modify: `extensions/dev.session-manager/model/tag-catalog.js`
- Modify: `extensions/dev.session-manager/ui/sidebar-view.js`
- Modify: `extensions/dev.session-manager/ui/tag-tree.js`
- Modify: `extensions/dev.session-manager/main.js`
- Modify: `extensions/dev.session-manager/styles.css`
- Test: `tests/session-tag-catalog.test.js`
- Test: `tests/session-tag-tree.test.js`
- Test: `tests/session-sidebar-tag-split.test.js`

- [ ] Extend source metadata so each row identifies whether it has document-backed matches independently of Biography sources.
- [ ] Add tag-tree tests that open the context menu, choose bulk ignore, render an inline confirmation with affected session/tag counts, cancel without mutation, and confirm once.
- [ ] Inject `getIgnoreImpact` and `onIgnoreSubtree` callbacks through `sidebar-view.js`; hide the action on Biography-only rows.
- [ ] Add Chinese and English strings and restrained confirmation styling consistent with the existing delete confirmation row.
- [ ] Run the three focused UI suites; expect all to pass.
- [ ] Commit the sidebar interaction.

### Task 4: Context Panel Ignore and Restore

**Files:**
- Modify: `extensions/dev.tools/context-panel.js`
- Modify: `extensions/dev.tools/main.js`
- Modify: `extensions/dev.tools/styles.css`
- Test: `tests/context-panel-tag-exclusions.test.js`

- [ ] Export or isolate a pure snapshot partition helper and test visible tags versus ignored exact/subtree matches.
- [ ] Subscribe Context Panel to `sessions.tagIndex`, obtain exclusion state through `zion.sessions.getTagExtractionState`, and include it in the render signature.
- [ ] Change visible tag rows to use a close icon for exact ignore while preserving click-to-source.
- [ ] Render an `Ignored` subgroup with restore buttons and invoke `zion.sessions.restoreTag` using the stored rule.
- [ ] Add localized notifications for ignore, restore, and failure.
- [ ] Run Context Panel and focused session tests; expect all to pass.
- [ ] Commit the Context Panel interaction.

### Task 5: Verification

- [ ] Run `npx vitest run tests/session-tag-index.test.js tests/session-tag-exclusion-commands.test.js tests/session-tag-catalog.test.js tests/session-tag-tree.test.js tests/session-sidebar-tag-split.test.js tests/context-panel-tag-exclusions.test.js`.
- [ ] Run ESLint on every changed JavaScript module.
- [ ] Run `npm run build`.
- [ ] In the running worktree, ignore one current-session tag from Context Panel, restore it, bulk-ignore a parent path from the tag tree, verify the displayed impact, and reload to confirm persistence.
- [ ] Commit any verification fixes and leave unrelated worktree files untouched.
