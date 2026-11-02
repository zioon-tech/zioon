# Sidebar Header Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep only semantic tag and hide actions in the sessions Sidebar, and move the new-session affordance to the editor tab bar using Lucide's `message-circle-plus`.

**Architecture:** Workbench continues to append its shared `columns-2` hide action. The sessions view contributes only its `tag` toggle. The shared icon registry stores the selected Lucide path, and each editor tab-bar renderer uses it for the existing new-session command.

**Tech Stack:** TypeScript, JavaScript ES modules, Zion icon registry, Zion Workbench, Vitest, jsdom

---

### Task 1: Finalize sessions Sidebar actions

**Files:**
- Modify: `extensions/dev.session-manager/main.js`

- [ ] Remove `showHideAction: false`.
- [ ] Change `sessions.tagSplit` to `icon: "$(tag)"`.
- [ ] Delete the `sessions.new` header action.

### Task 2: Move the semantic new-session icon to editor tabs

**Files:**
- Modify: `src/ui/icons.ts`
- Modify: `src/main.ts`
- Test: `tests/session-sidebar-header.test.js`

- [ ] Register Lucide's `message-circle-plus` SVG paths:

```ts
"message-circle-plus": '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/><path d="M8 12h8M12 8v8"/>',
```

- [ ] Replace `zionIconHtml("plus")` on all editor new-session buttons with:

```ts
zionIconHtml("message-circle-plus")
```

- [ ] Verify the icon registry:

```js
expect(hasZionIcon("message-circle-plus")).toBe(true);
expect(zionIconName("message-circle-plus")).toBe("message-circle-plus");
```

### Task 3: Verify and commit

- [ ] Run focused tests:

```bash
npm test -- --run tests/session-sidebar-header.test.js tests/workbench-sidebar-chrome.test.js tests/session-sidebar-tag-split.test.js
```

- [ ] Run ESLint and build:

```bash
npx eslint src/main.ts src/ui/icons.ts extensions/dev.session-manager/main.js tests/session-sidebar-header.test.js
npm run build
```

- [ ] Browser-check the final icon order and commit:

```bash
git add docs/superpowers/specs/2026-08-16-sidebar-header-actions-design.md docs/superpowers/plans/2026-08-16-sidebar-header-actions.md extensions/dev.session-manager/main.js src/main.ts src/ui/icons.ts tests/session-sidebar-header.test.js
git commit -m "fix(sessions): move new session icon to editor tabs"
```
