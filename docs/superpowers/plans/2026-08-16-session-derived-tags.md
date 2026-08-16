# Session Derived Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge Biography project/topic labels into the Sessions tag tree as read-only automatic tags and replace reload-time document scanning with a persistent incremental tag index.

**Architecture:** A shared helper owns the provider-neutral `sessions.derivedTags` state contract. Identity publishes a Biography projection; Session Manager consumes every registered provider and merges it with a compact IndexedDB-backed document tag index.

**Tech Stack:** JavaScript ES modules, Zion StateBus, IndexedDB, Vitest, jsdom

---

### Task 1: Shared Derived-Tag Contract

**Files:**
- Create: `extensions/shared/session-derived-tags.js`
- Test: `tests/session-derived-tags.test.js`

- [ ] Add failing tests for provider validation, per-session deduplication, state publication, and provider removal.
- [ ] Run `npx vitest run tests/session-derived-tags.test.js` and verify the missing module failure.
- [ ] Implement normalization plus `publishSessionDerivedTagSource`, `removeSessionDerivedTagSource`, and `collectSessionDerivedTags`.
- [ ] Re-run the test and verify it passes.

### Task 2: Biography Projection

**Files:**
- Modify: `extensions/dev.identity/identity-core.js`
- Modify: `extensions/dev.identity/main.js`
- Test: `tests/identity-plugin.test.js`

- [ ] Add a failing pure test that maps events to `project/<name>` and `topic/<name>` tags grouped by `sessionId`.
- [ ] Add an activation test proving Identity publishes the `biography` provider and updates it after `identity/biographyChanged`.
- [ ] Implement `buildBiographySessionTagSource` and publish cached/current events without blocking activation.
- [ ] Re-run `tests/identity-plugin.test.js`.

### Task 3: Persistent Document Tag Index

**Files:**
- Create: `extensions/dev.session-manager/model/session-tag-index.js`
- Create: `extensions/dev.session-manager/storage/session-tag-index.js`
- Modify: `extensions/dev.session-manager/main.js`
- Modify: `extensions/dev.session-manager/editor/autosave-plugin.js`
- Modify: `extensions/dev.session-manager/commands/doc-apis.js`
- Test: `tests/session-tag-index.test.js`

- [ ] Add failing tests for index validation, hash matching, one-session updates, deletion, and extraction.
- [ ] Implement the pure index model and IndexedDB KV storage wrapper.
- [ ] Load the compact index at startup; schedule one idle migration when absent or incomplete.
- [ ] Update one index entry from every document write path and remove it when a session is deleted.
- [ ] Re-run the focused tests.

### Task 4: Merge and Render Sources

**Files:**
- Modify: `extensions/dev.session-manager/model/tag-catalog.js`
- Modify: `extensions/dev.session-manager/ui/sidebar-view.js`
- Modify: `extensions/dev.session-manager/ui/tag-tree.js`
- Modify: `extensions/dev.session-manager/styles.css`
- Modify: `extensions/dev.session-manager/main.js`
- Test: `tests/session-tag-catalog.test.js`
- Test: `tests/session-tag-tree.test.js`
- Test: `tests/session-sidebar-tag-split.test.js`

- [ ] Add failing tests for source propagation, automatic marker rendering, filtering, and blocked mutations.
- [ ] Replace synchronous document reads with the document tag index and merge normalized derived providers.
- [ ] Subscribe to `sessions.tagIndex` and `sessions.derivedTags`.
- [ ] Render the compact `自动` marker and source-only context menu for read-only rows.
- [ ] Re-run all focused Session Manager tests.

### Task 5: Verification

- [ ] Run `npx vitest run`.
- [ ] Run ESLint on all changed JavaScript modules.
- [ ] Run `npm run build`.
- [ ] Open the running worktree, verify Biography rows show `自动`, filter sessions correctly, and expose no mutation actions.
- [ ] Confirm a reload mounts the Sessions sidebar from indexed tags without loading every session document.
