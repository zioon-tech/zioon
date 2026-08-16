# Sidebar Header Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify Sidebar header actions, use the two-column icon for the shared hide action, and give the sessions tag-tree toggle an unambiguous icon.

**Architecture:** Add an opt-out flag to the shared Sidebar view contract and let Workbench remain the single owner of the hide action. Configure the sessions view to opt out, remove its three-dot action, and use `list-tree` for the tag-column toggle.

**Tech Stack:** TypeScript, JavaScript ES modules, Zion Workbench runtime, Vitest, jsdom

---

### Task 1: Make the shared Sidebar hide action configurable

**Files:**
- Modify: `tests/workbench-sidebar-chrome.test.js`
- Modify: `src/ui/workbench/runtime.ts`
- Modify: `src/types/zion.d.ts`
- Modify: `src/ui/workbench/workbench.ts`

- [ ] **Step 1: Add failing Workbench tests**

Append tests that register a default view and an opt-out view:

```js
it("uses the columns icon for the shared hide action", async () => {
  const host = document.createElement("div");
  host.id = "app";
  host.style.height = "600px";
  document.body.appendChild(host);
  const state = createState();
  bindWorkbenchCore({
    state,
    events: {
      emit: () => {},
      on: () => ({ dispose() {} })
    }
  });
  const wb = initWorkbench(host);
  const view = sideBarRuntime.registerView({
    id: "plugins.hide-action",
    pluginId: "dev.plugins",
    title: "Plugins",
    component: { render: () => {} }
  });

  sideBarRuntime.show();
  sideBarRuntime.activateView("plugins.hide-action");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const hide = document.querySelector('[aria-label="Hide Side Bar"]');
  expect(hide?.querySelector('[data-zion-icon="columns-2"]')).toBeTruthy();
  hide.click();
  expect(sideBarRuntime.isVisible()).toBe(false);

  view.dispose();
  wb.dispose();
  host.remove();
});

it("allows a Sidebar view to omit the shared hide action", async () => {
  const host = document.createElement("div");
  host.id = "app";
  host.style.height = "600px";
  document.body.appendChild(host);
  const state = createState();
  bindWorkbenchCore({
    state,
    events: {
      emit: () => {},
      on: () => ({ dispose() {} })
    }
  });
  const wb = initWorkbench(host);
  const view = sideBarRuntime.registerView({
    id: "sessions.no-hide-action",
    pluginId: "dev.session-manager",
    title: "Sessions",
    showHideAction: false,
    component: { render: () => {} }
  });

  sideBarRuntime.show();
  sideBarRuntime.activateView("sessions.no-hide-action");
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(document.querySelector('[aria-label="Hide Side Bar"]')).toBeNull();

  view.dispose();
  wb.dispose();
  host.remove();
});
```

- [ ] **Step 2: Run the tests and verify failure**

```bash
npm test -- --run tests/workbench-sidebar-chrome.test.js
```

Expected: the icon assertion fails with `x`, and the opt-out assertion fails
because the contract is not implemented.

- [ ] **Step 3: Extend the Sidebar view contract**

Add the same optional property to `SideBarView` in
`src/ui/workbench/runtime.ts` and the public `sideBar.registerView` declaration
in `src/types/zion.d.ts`:

```ts
showHideAction?: boolean;
```

- [ ] **Step 4: Update the shared Workbench action**

In `src/ui/workbench/workbench.ts`, create the shared button with:

```ts
setCodiconOnly(hideBtn, "columns-2");
```

Append it only when the active view has not opted out:

```ts
if (nextView?.showHideAction !== false) {
  headerActions.appendChild(hideBtn);
}
```

- [ ] **Step 5: Run the Workbench tests**

```bash
npm test -- --run tests/workbench-sidebar-chrome.test.js
```

Expected: all tests pass.

### Task 2: Reduce sessions Sidebar actions

**Files:**
- Modify: `extensions/dev.session-manager/main.js`

- [ ] **Step 1: Configure the sessions header**

Add the opt-out flag to the `sessions.list` view:

```js
showHideAction: false,
```

Change the tag split action icon:

```js
icon: "$(list-tree)",
```

Delete the entire `sessions.actions` header action. Keep
`sessions.tagSplit` and `sessions.new` unchanged otherwise.

- [ ] **Step 2: Run adjacent tests and lint**

```bash
npm test -- --run tests/workbench-sidebar-chrome.test.js tests/session-sidebar-header.test.js tests/session-sidebar-tag-split.test.js
npx eslint src/ui/workbench/workbench.ts src/ui/workbench/runtime.ts extensions/dev.session-manager/main.js tests/workbench-sidebar-chrome.test.js
```

Expected: all tests and ESLint pass.

- [ ] **Step 3: Build and verify in the browser**

```bash
npm run build
```

Expected: Vite build succeeds. Restore generated `dist/index.html` hashes.
In the browser, verify the sessions header contains only tag-tree and add
actions, while another plugin Sidebar shows the `columns-2` hide action.

- [ ] **Step 4: Commit**

```bash
git add src/ui/workbench/workbench.ts src/ui/workbench/runtime.ts src/types/zion.d.ts extensions/dev.session-manager/main.js tests/workbench-sidebar-chrome.test.js
git commit -m "refactor(workbench): simplify sidebar header actions"
```
