# Sidebar Header Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the sessions Sidebar actions as `tag`, `message-square-plus`, and the shared `columns-2` hide action in that order.

**Architecture:** Workbench remains the single owner of the always-present hide action. Remove the unused hide-action opt-out, add the new conversation icon to the shared icon registry, and select semantic icons in the sessions view registration.

**Tech Stack:** TypeScript, JavaScript ES modules, Zion icon registry, Zion Workbench, Vitest, jsdom

---

### Task 1: Keep the shared hide action on every Sidebar

**Files:**
- Modify: `tests/workbench-sidebar-chrome.test.js`
- Modify: `src/ui/workbench/runtime.ts`
- Modify: `src/types/zion.d.ts`
- Modify: `src/ui/workbench/workbench.ts`

- [ ] **Step 1: Update the Workbench test**

Keep the existing shared-action test:

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
  const usesColumnsIcon = !!hide?.querySelector('[data-zion-icon="columns-2"]');
  hide.click();
  const hiddenAfterClick = !sideBarRuntime.isVisible();

  view.dispose();
  wb.dispose();
  host.remove();

  expect(usesColumnsIcon).toBe(true);
  expect(hiddenAfterClick).toBe(true);
});
```

Delete the `showHideAction: false` opt-out test.

- [ ] **Step 2: Remove the unused opt-out contract**

Delete this property from both Sidebar view type declarations:

```ts
showHideAction?: boolean;
```

In Workbench, always append the shared button:

```ts
headerActions.appendChild(hideBtn);
```

- [ ] **Step 3: Run the Workbench tests**

```bash
npm test -- --run tests/workbench-sidebar-chrome.test.js
```

Expected: all tests pass.

### Task 2: Add semantic session action icons

**Files:**
- Modify: `src/ui/icons.ts`
- Modify: `extensions/dev.session-manager/main.js`
- Test: `tests/session-sidebar-header.test.js`

- [ ] **Step 1: Add a failing icon registry test**

Extend `tests/session-sidebar-header.test.js`:

```js
import { hasZionIcon, zionIconName } from "../src/ui/icons";

it("registers the new-session icon", () => {
  expect(hasZionIcon("message-square-plus")).toBe(true);
  expect(zionIconName("message-square-plus")).toBe("message-square-plus");
});
```

- [ ] **Step 2: Run the icon test and verify failure**

```bash
npm test -- --run tests/session-sidebar-header.test.js
```

Expected: `hasZionIcon("message-square-plus")` is false.

- [ ] **Step 3: Register the new icon**

Add the Lucide-style icon path in `src/ui/icons.ts`:

```ts
"message-square-plus": '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4Z"/><path d="M12 7v6M9 10h6"/>',
```

- [ ] **Step 4: Configure the sessions actions**

In `extensions/dev.session-manager/main.js`:

```js
icon: "$(tag)",
```

for `sessions.tagSplit`, and:

```js
icon: "$(message-square-plus)",
```

for `sessions.new`. Delete `showHideAction: false` so Workbench appends the
shared `columns-2` action at the far right.

- [ ] **Step 5: Run verification**

```bash
npm test -- --run tests/workbench-sidebar-chrome.test.js tests/session-sidebar-header.test.js tests/session-sidebar-tag-split.test.js
npx eslint src/ui/icons.ts src/ui/workbench/workbench.ts src/ui/workbench/runtime.ts extensions/dev.session-manager/main.js tests/workbench-sidebar-chrome.test.js tests/session-sidebar-header.test.js
npm run build
```

Expected: tests, ESLint, and build pass. Restore generated `dist/index.html`
hashes, then verify the three icon names and order in the browser.

- [ ] **Step 6: Commit**

```bash
git add src/ui/icons.ts src/ui/workbench/workbench.ts src/ui/workbench/runtime.ts src/types/zion.d.ts extensions/dev.session-manager/main.js tests/workbench-sidebar-chrome.test.js tests/session-sidebar-header.test.js
git commit -m "fix(sessions): refine sidebar action icons"
```
