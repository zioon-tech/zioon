# Session Tag Tree Shared Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `全部标签` and `会话` as two sections of the same native Workbench sidebar header whenever the Sessions tag split is active.

**Architecture:** Add an optional lifecycle-managed `headerLeading` slot to `SideBarView`; ordinary views keep the current header behavior. The Sessions plugin renders its leading header through a focused module and exchanges `{ visible, width, nodeCount }` snapshots with the existing sidebar manager. The tag tree becomes content-only, and the negative-margin host-header overlay is removed.

**Tech Stack:** TypeScript Workbench runtime, DOM-based JavaScript extension UI, CSS custom properties, Vitest with jsdom, Vite.

---

## File Map

- Modify `src/ui/workbench/runtime.ts`: declare the reusable `SideBarHeaderLeading` contract on `SideBarView`.
- Modify `src/types/zion.d.ts`: expose the same contract to extensions through `window.zion.sideBar.registerView`.
- Modify `src/ui/workbench/workbench.ts`: create, mount, update, and dispose the leading-header region.
- Modify `src/styles.css`: preserve the ordinary header and add the native two-region header geometry.
- Modify `tests/workbench-sidebar-chrome.test.js`: lock down visibility, width, switching, and disposal.
- Create `extensions/dev.session-manager/ui/sidebar-header.js`: render the Sessions-specific `全部标签` title, count, and add action.
- Modify `extensions/dev.session-manager/ui/sidebar-view.js`: publish header snapshots, require an attached header bridge for split mode, sync divider width, and remove host-header measurement.
- Modify `extensions/dev.session-manager/ui/tag-tree.js`: remove the duplicate internal heading and expose root tag creation.
- Modify `extensions/dev.session-manager/main.js`: register the Sessions leading-header component.
- Modify `extensions/dev.session-manager/styles.css`: style the plugin header content and make the content divider overlay the exact header boundary.
- Modify `tests/session-tag-tree.test.js`: verify the content-only tree and programmatic root creation.
- Create `tests/session-sidebar-header.test.js`: verify the isolated Sessions leading-header renderer.
- Modify `tests/session-sidebar-tag-split.test.js`: verify bridge eligibility, snapshots, drag synchronization, add delegation, and narrow fallback.

### Task 1: Add The Workbench Leading-Header Contract

**Files:**
- Modify: `tests/workbench-sidebar-chrome.test.js`
- Modify: `src/ui/workbench/runtime.ts:17-36`
- Modify: `src/types/zion.d.ts:302-321`
- Modify: `src/ui/workbench/workbench.ts:831-858,2512-2635,2735-2785`
- Modify: `src/styles.css:2948-2969,5457-5480`

- [ ] **Step 1: Write the failing Workbench lifecycle test**

Append these tests to `tests/workbench-sidebar-chrome.test.js`. They must
exercise the public `headerLeading` contract rather than private helper
functions:

```js
it("mounts, updates, and disposes a leading header without remounting the view", async () => {
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
  let leadingContext = null;
  let leadingDisposeCount = 0;
  let viewRenderCount = 0;

  const sessions = sideBarRuntime.registerView({
    id: "sessions.list",
    pluginId: "dev.session-manager",
    title: "Sessions",
    headerLeading: {
      render: (container, context) => {
        leadingContext = context;
        container.textContent = "All Tags";
        return { dispose: () => { leadingDisposeCount += 1; } };
      }
    },
    component: {
      render: () => {
        viewRenderCount += 1;
      }
    }
  });
  const plugins = sideBarRuntime.registerView({
    id: "plugins.manager",
    pluginId: "dev.plugins",
    title: "Plugins",
    component: { render: () => {} }
  });

  sideBarRuntime.show();
  sideBarRuntime.activateView("sessions.list");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const header = document.querySelector(".zion-sidebar-header");
  const leading = header.querySelector(".zion-sidebar-header-leading");
  const title = header.querySelector(".zion-sidebar-title");
  expect(leading.textContent).toBe("All Tags");
  expect(title.textContent).toBe("Sessions");
  expect(header.classList.contains("has-leading")).toBe(false);

  const rendersBeforeHeaderUpdate = viewRenderCount;
  leadingContext.setWidth(180);
  leadingContext.setVisible(true);
  expect(header.classList.contains("has-leading")).toBe(true);
  expect(header.style.getPropertyValue("--zion-sidebar-leading-width")).toBe("180px");
  expect(viewRenderCount).toBe(rendersBeforeHeaderUpdate);

  leadingContext.setVisible(false);
  expect(header.classList.contains("has-leading")).toBe(false);

  sideBarRuntime.activateView("plugins.manager");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(leadingDisposeCount).toBe(1);
  expect(leading.childElementCount).toBe(0);
  expect(header.classList.contains("has-leading")).toBe(false);

  sessions.dispose();
  plugins.dispose();
  wb.dispose();
  host.remove();
});

it("keeps the standard header when a leading renderer fails", async () => {
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
    id: "broken.leading",
    pluginId: "test",
    title: "Still Visible",
    headerLeading: {
      render: () => {
        throw new Error("leading failed");
      }
    },
    component: {
      render: (container) => {
        container.textContent = "content survived";
      }
    }
  });
  sideBarRuntime.show();
  sideBarRuntime.activateView("broken.leading");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const header = document.querySelector(".zion-sidebar-header");
  expect(header.classList.contains("has-leading")).toBe(false);
  expect(header.querySelector(".zion-sidebar-title").textContent).toBe("Still Visible");
  expect(document.querySelector(".zion-sidebar-content").textContent).toContain("content survived");

  view.dispose();
  wb.dispose();
  host.remove();
});
```

- [ ] **Step 2: Run the test and verify the contract is absent**

Run:

```bash
npx vitest run tests/workbench-sidebar-chrome.test.js
```

Expected: FAIL because `headerLeading` is ignored and `.zion-sidebar-header-leading` does not exist.

- [ ] **Step 3: Add the shared TypeScript contract**

Add these types in `src/ui/workbench/runtime.ts` before `SideBarView`:

```ts
export type SideBarHeaderLeadingContext = {
  setVisible(visible: boolean): void;
  setWidth(px: number): void;
};

export type SideBarHeaderLeading = {
  render: (
    container: HTMLElement,
    context: SideBarHeaderLeadingContext
  ) => { dispose?: () => void } | void;
};
```

Add this property to `SideBarView`:

```ts
headerLeading?: SideBarHeaderLeading;
```

Mirror the public extension shape in `src/types/zion.d.ts` inside the
`sideBar.registerView` options:

```ts
headerLeading?: {
  render: (
    container: HTMLElement,
    context: {
      setVisible(visible: boolean): void;
      setWidth(px: number): void;
    }
  ) => { dispose?: () => void } | void;
};
```

- [ ] **Step 4: Build the two-region Workbench header DOM**

Replace the direct title/action children in `src/ui/workbench/workbench.ts`
with stable leading and main regions:

```ts
let mountedHeaderLeadingViewId: string | null = null;
let mountedHeaderLeadingDisposable: { dispose?: () => void } | null = null;

sideBarEl.style.position = "relative";
const header = el("div", "zion-sidebar-header");
const headerLeading = el("div", "zion-sidebar-header-leading");
const headerMain = el("div", "zion-sidebar-header-main");
const headerTitle = el("div", "zion-sidebar-title");
const headerActions = el("div", "zion-sidebar-actions");
const hideBtn = el("button", "zion-sidebar-action");
hideBtn.type = "button";
hideBtn.title = "Hide Side Bar";
hideBtn.setAttribute("aria-label", "Hide Side Bar");
setCodiconOnly(hideBtn, "close");
hideBtn.onclick = () => sideBarRuntime.hide();
headerActions.appendChild(hideBtn);
headerMain.append(headerTitle, headerActions);
header.append(headerLeading, headerMain);
```

Add lifecycle helpers immediately before `unmountView`:

```ts
const resetHeaderLeading = () => {
  header.classList.remove("has-leading");
  header.style.removeProperty("--zion-sidebar-leading-width");
  headerLeading.replaceChildren();
};

const unmountHeaderLeading = () => {
  try {
    mountedHeaderLeadingDisposable?.dispose?.();
  } catch {}
  mountedHeaderLeadingDisposable = null;
  mountedHeaderLeadingViewId = null;
  resetHeaderLeading();
};

const mountHeaderLeading = (viewId: string | null) => {
  if (mountedHeaderLeadingViewId === viewId) return;
  unmountHeaderLeading();
  if (!viewId) return;
  const view = sideBarRuntime.getView(viewId);
  if (!view?.headerLeading) return;
  mountedHeaderLeadingViewId = viewId;
  const isCurrent = () => mountedHeaderLeadingViewId === viewId;
  try {
    const ret = view.headerLeading.render(headerLeading, {
      setVisible: (visible) => {
        if (!isCurrent()) return;
        header.classList.toggle("has-leading", !!visible);
      },
      setWidth: (px) => {
        if (!isCurrent()) return;
        const width = Number(px);
        if (!Number.isFinite(width) || width <= 0) {
          header.style.removeProperty("--zion-sidebar-leading-width");
          return;
        }
        header.style.setProperty("--zion-sidebar-leading-width", `${Math.round(width)}px`);
      }
    });
    mountedHeaderLeadingDisposable = (ret as any) || null;
  } catch {
    unmountHeaderLeading();
  }
};
```

In `renderSideBar`, calculate `nextId` before rendering title/actions, resolve
`nextView`, and mount the header slot before mounting content:

```ts
const nextId = activeViewId && sideBarRuntime.getView(activeViewId)
  ? activeViewId
  : views[0]?.id ?? null;
const nextView = nextId ? sideBarRuntime.getView(nextId) : null;

headerTitle.textContent = translatedTitle(nextView, "Side Bar");
mountHeaderLeading(nextId);
```

Use `nextView?.headerActions` in the existing actions loop. Remove the later
duplicate declaration of `nextId`. In Workbench disposal, call
`unmountHeaderLeading()` before `void unmountView(mountedViewId)`.

- [ ] **Step 5: Add native header geometry while preserving ordinary views**

Update the sidebar header rules in `src/styles.css`:

```css
.zion-sidebar-header {
  display: flex;
  align-items: stretch;
  justify-content: flex-start;
  padding: 8px 10px;
  gap: 0;
  box-sizing: border-box;
}

.zion-sidebar-header-leading {
  display: none;
  min-width: 0;
}

.zion-sidebar-header-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}

.zion-sidebar-header.has-leading {
  padding: 0;
}

.zion-sidebar-header.has-leading .zion-sidebar-header-leading {
  display: flex;
  flex: 0 0 var(--zion-sidebar-leading-width);
  width: var(--zion-sidebar-leading-width);
  min-width: 0;
  box-sizing: border-box;
  border-right: 1px solid var(--surface-border-soft, var(--border));
}

.zion-sidebar-header.has-leading .zion-sidebar-header-main {
  padding: 6px 10px 4px;
  box-sizing: border-box;
}
```

Keep the existing shared `min-height: 36px` Workbench rule. Ensure its
`padding: 6px 10px 4px` applies to `.zion-sidebar-header:not(.has-leading)`
instead of overriding the zero-padding split header:

```css
.zion-sidebar-header:not(.has-leading),
.zion-auxbar-header,
.zion-bottompanel-header {
  padding: 6px 10px 4px;
}
```

- [ ] **Step 6: Run focused Workbench tests**

Run:

```bash
npx vitest run tests/workbench-sidebar-chrome.test.js tests/workbench-resize-keeps-view.test.js tests/workbench-scroll-chain.test.js
```

Expected: all tests PASS, and changing the leading slot does not remount the
sidebar view.

- [ ] **Step 7: Commit the Workbench contract**

```bash
git add src/ui/workbench/runtime.ts src/types/zion.d.ts src/ui/workbench/workbench.ts src/styles.css tests/workbench-sidebar-chrome.test.js
git commit -m "feat(workbench): add sidebar leading header slot"
```

### Task 2: Make The Split Tag Tree Content-Only

**Files:**
- Modify: `tests/session-tag-tree.test.js`
- Modify: `extensions/dev.session-manager/ui/tag-tree.js:46-87,471-489`
- Modify: `extensions/dev.session-manager/styles.css:570-605`

- [ ] **Step 1: Change the tag-tree test to require an external header**

Replace the existing root-create test in `tests/session-tag-tree.test.js` with:

```js
it("renders without a duplicate header and exposes root creation", async () => {
  const { panel, calls } = makePanel();
  const tree = makeRows(
    [{ id: "tag:work", path: "work", order: 0, manual: true }],
    []
  );
  panel.update({ rows: tree.rows, nodeCount: tree.nodeCount, selection: "" });
  document.body.appendChild(panel.el);

  expect(panel.el.querySelector(".zion-sessions-tagtree-header")).toBeNull();
  panel.startCreateRoot();

  const input = panel.el.querySelector(".zion-sessions-tagtree-edit input");
  expect(input).toBeTruthy();
  input.value = "fresh";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await vi.waitFor(() => expect(calls.create).toEqual(["fresh"]));
});
```

- [ ] **Step 2: Run the test and verify the old internal header fails it**

Run:

```bash
npx vitest run tests/session-tag-tree.test.js
```

Expected: FAIL because the internal `.zion-sessions-tagtree-header` exists and
`startCreateRoot` is not exposed.

- [ ] **Step 3: Remove internal header ownership and expose root creation**

Delete the `header`, `title`, `countBadge`, and `addBtn` construction from
`extensions/dev.session-manager/ui/tag-tree.js`. Append only content:

```js
el.appendChild(searchWrap);
el.appendChild(body);
```

Remove both writes to `countBadge.textContent` in `render()`. Add this method to
the returned panel object:

```js
startCreateRoot() {
  startCreate("");
},
```

Keep `nodeCount` in `state` because the manager's data contract still includes
it and the outer header consumes it.

- [ ] **Step 4: Remove obsolete internal-header CSS**

Delete these selectors from `extensions/dev.session-manager/styles.css`:

```css
.zion-sessions-tagtree-header
.zion-sessions-tagtree-title
.zion-sessions-tagtree-add
.zion-sessions-tagtree-add:hover
.zion-sessions-tagtree-header .zion-sessions-tagtree-count
```

Keep `.zion-sessions-tagtree-count` because rows still use it.

- [ ] **Step 5: Run the tag-tree suite**

Run:

```bash
npx vitest run tests/session-tag-tree.test.js tests/session-tag-catalog.test.js tests/session-tag-mutations.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Commit the content-only tree**

```bash
git add extensions/dev.session-manager/ui/tag-tree.js extensions/dev.session-manager/styles.css tests/session-tag-tree.test.js
git commit -m "refactor(sessions): move tag tree heading out of content"
```

### Task 3: Connect Sessions To The Workbench Slot

**Files:**
- Create: `extensions/dev.session-manager/ui/sidebar-header.js`
- Create: `tests/session-sidebar-header.test.js`
- Modify: `tests/session-sidebar-tag-split.test.js`
- Modify: `extensions/dev.session-manager/ui/sidebar-view.js:578-789,1385-1422,1488-1519`
- Modify: `extensions/dev.session-manager/main.js:1-25,1545-1595`
- Modify: `extensions/dev.session-manager/styles.css:851-955`

- [ ] **Step 1: Write the isolated Sessions header test**

Create `tests/session-sidebar-header.test.js`:

```js
import { describe, expect, it, vi } from "vitest";
import { renderSessionsTagHeader } from "../extensions/dev.session-manager/ui/sidebar-header.js";

describe("sessions tag split header", () => {
  it("renders title/count, applies snapshots, delegates add, and detaches", () => {
    const add = vi.fn();
    let sink = null;
    const detach = vi.fn();
    const manager = {
      attachTagSplitHeader: (nextSink) => {
        sink = nextSink;
        nextSink({ visible: false, width: 180, nodeCount: 0 });
        return { dispose: detach };
      },
      createRootTagIfOpen: add
    };
    const context = {
      setVisible: vi.fn(),
      setWidth: vi.fn()
    };
    const container = document.createElement("div");

    const disposable = renderSessionsTagHeader(container, context, {
      manager,
      t: (_key, fallback) => fallback
    });

    expect(container.querySelector(".zion-sessions-header-title").textContent).toBe("All Tags");
    expect(context.setVisible).toHaveBeenLastCalledWith(false);
    expect(context.setWidth).toHaveBeenLastCalledWith(180);

    sink({ visible: true, width: 200, nodeCount: 13 });
    expect(context.setVisible).toHaveBeenLastCalledWith(true);
    expect(context.setWidth).toHaveBeenLastCalledWith(200);
    expect(container.querySelector(".zion-sessions-header-count").textContent).toBe("13");

    container.querySelector(".zion-sessions-header-add").click();
    expect(add).toHaveBeenCalledTimes(1);

    disposable.dispose();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(context.setVisible).toHaveBeenLastCalledWith(false);
  });
});
```

- [ ] **Step 2: Update split tests to express bridge-driven eligibility**

In `tests/session-sidebar-tag-split.test.js`, change `mountAt` so tests attach
the leading-header sink by default:

```js
function mountAt(width, { attachHeader = true } = {}) {
  const widthCalls = [];
  const { manager } = makeManager(widthCalls);
  const headerSnapshots = [];
  const headerDisposable = attachHeader
    ? manager.attachTagSplitHeader((snapshot) => headerSnapshots.push({ ...snapshot }))
    : null;
  const container = document.createElement("div");
  document.body.appendChild(container);
  Object.defineProperty(container, "clientWidth", { value: width, configurable: true });
  const inst = manager.mountInto(container);
  return {
    manager,
    inst,
    container,
    widthCalls,
    headerSnapshots,
    headerDisposable,
    setWidth: (nextWidth) => Object.defineProperty(
      container,
      "clientWidth",
      { value: nextWidth, configurable: true }
    )
  };
}
```

Replace the obsolete host-lift test with these tests:

```js
it("publishes a visible leading header with the tag count and no overlay", () => {
  localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
  const { container, headerSnapshots } = mountAt(500);
  const latest = headerSnapshots.at(-1);
  expect(latest).toMatchObject({ visible: true, width: 180, nodeCount: 3 });
  const splitRow = container.querySelector(".zion-sessions-split-row");
  expect(splitRow.style.marginTop).toBe("");
  expect(splitRow.classList.contains("is-lifted")).toBe(false);
  expect(container.querySelector(".zion-sessions-tagtree-header")).toBeNull();
});

it("falls back to stacked content when the leading-header bridge is absent", () => {
  localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
  const { container } = mountAt(500, { attachHeader: false });
  expect(container.querySelector(".zion-sessions-split-row")).toBeNull();
  expect(container.querySelector(".zion-sessions-tags-panel").style.display).not.toBe("none");
});

it("keeps leading-header and content divider widths synchronized while dragging", () => {
  localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
  const { container, headerSnapshots } = mountAt(500);
  const divider = container.querySelector(".zion-sessions-split-divider");
  divider.dispatchEvent(new MouseEvent("mousedown", { clientX: 100, bubbles: true }));
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 120, bubbles: true }));
  expect(headerSnapshots.at(-1).width).toBe(200);
  expect(container.querySelector(".zion-sessions-tag-column").style.width).toBe("200px");
  expect(divider.style.left).toBe("197px");
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(localStorage.getItem("zion.sessions.sidebar.tagColumnWidth")).toBe("200");
});

it("delegates root creation from the leading header to the mounted tree", () => {
  localStorage.setItem("zion.sessions.sidebar.tagSplit", "1");
  const { manager, container } = mountAt(500);
  manager.createRootTagIfOpen();
  expect(container.querySelector(".zion-sessions-tagtree-edit input")).toBeTruthy();
});
```

Extend the existing narrow fallback test with:

```js
expect(headerSnapshots.at(-1).visible).toBe(false);
```

- [ ] **Step 3: Run the new tests and verify the integration is missing**

Run:

```bash
npx vitest run tests/session-sidebar-header.test.js tests/session-sidebar-tag-split.test.js
```

Expected: FAIL because `sidebar-header.js`, `attachTagSplitHeader`, and
`createRootTagIfOpen` do not exist.

- [ ] **Step 4: Implement the focused Sessions header renderer**

Create `extensions/dev.session-manager/ui/sidebar-header.js`:

```js
function codicon(name, size = 14) {
  try {
    const html = window.zionIcons?.htmlFromCodicon?.(name, "", size);
    if (html) return html;
  } catch {}
  return `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
}

export function renderSessionsTagHeader(container, context, deps) {
  const manager = deps.manager;
  const t = deps.t || ((_key, fallback) => fallback);
  container.classList.add("zion-sessions-header-leading");
  const title = document.createElement("span");
  title.className = "zion-sessions-header-title";
  const count = document.createElement("span");
  count.className = "zion-sessions-header-count";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "zion-sessions-header-add";
  add.innerHTML = codicon("add");

  const refreshText = () => {
    title.textContent = t("tags.title", "All Tags");
    const label = t("tags.addTag", "New tag");
    add.title = label;
    add.setAttribute("aria-label", label);
  };
  refreshText();
  add.onclick = (event) => {
    event.stopPropagation();
    manager.createRootTagIfOpen?.();
  };
  container.replaceChildren(title, count, add);

  const headerDisposable = manager.attachTagSplitHeader((snapshot) => {
    context.setWidth(snapshot.width);
    context.setVisible(snapshot.visible);
    count.textContent = String(snapshot.nodeCount || 0);
  });
  let i18nDisposable = null;
  try {
    i18nDisposable = window.zion?.events?.on?.("i18n/changed", refreshText) || null;
  } catch {}

  return {
    dispose() {
      try { headerDisposable?.dispose?.(); } catch {}
      try { i18nDisposable?.dispose?.(); } catch {}
      context.setVisible(false);
      container.replaceChildren();
      container.classList.remove("zion-sessions-header-leading");
    }
  };
}
```

- [ ] **Step 5: Add the sidebar-manager snapshot bridge**

At manager scope in `extensions/dev.session-manager/ui/sidebar-view.js`, next
to `let current = null`, add:

```js
let tagSplitHeaderSink = null;
let tagSplitHeaderSnapshot = {
  visible: false,
  width: tagColumnWidth,
  nodeCount: 0
};

function publishTagSplitHeader(patch = {}) {
  tagSplitHeaderSnapshot = { ...tagSplitHeaderSnapshot, ...patch };
  try { tagSplitHeaderSink?.({ ...tagSplitHeaderSnapshot }); } catch {}
}

function attachTagSplitHeader(sink) {
  tagSplitHeaderSink = typeof sink === "function" ? sink : null;
  publishTagSplitHeader();
  try { current?.render?.(); } catch {}
  const attached = tagSplitHeaderSink;
  return {
    dispose() {
      if (tagSplitHeaderSink !== attached) return;
      tagSplitHeaderSink = null;
      try { current?.render?.(); } catch {}
    }
  };
}
```

Inside `mountInto`, replace host-header measurement and lift logic with bridge
eligibility:

```js
const applySplitLayout = () => {
  const bodyWidth = container.clientWidth || 0;
  const wantSplit = !!tagSplitHeaderSink
    && tagSplitEnabled
    && bodyWidth >= TAG_SPLIT_BODY_MIN;
  const mode = wantSplit ? "split" : "stacked";
  publishTagSplitHeader({ visible: wantSplit, width: tagColumnWidth });
  if (mode === appliedSplitMode) return;
  appliedSplitMode = mode;
  if (wantSplit) {
    tagsHost.style.display = "none";
    splitRow.append(tagColumn, splitDivider);
    rightColumn.append(listHeader, listWrap, calendarHost);
    splitRow.appendChild(rightColumn);
    container.appendChild(splitRow);
  } else {
    if (splitRow.parentElement === container) container.removeChild(splitRow);
    tagsHost.style.display = "";
    container.append(listWrap, tagsHost, calendarHost);
  }
};
```

Delete `measureHostHeaderLift`, all `is-lifted` class changes, and all
`marginTop` writes.

When creating the split row, make its divider overlay the true column boundary:

```js
splitRow.style.position = "relative";
splitDivider.style.left = `${tagColumnWidth - 3}px`;
```

In `onSplitDragMove`, after updating `tagColumn`, synchronize both boundaries:

```js
splitDivider.style.left = `${tagColumnWidth - 3}px`;
publishTagSplitHeader({ width: tagColumnWidth });
```

In `renderTagTreeIfSplit`, publish the node count from the same tree that is
sent to the panel:

```js
publishTagSplitHeader({ nodeCount: tree.nodeCount, width: tagColumnWidth });
```

On mounted instance disposal, publish `{ visible: false }`. Expose bridge and
creation methods from the manager:

```js
return {
  mountInto,
  refreshIfOpen,
  anchorToCurrentIfOpen,
  revealSessionIfOpen,
  toggleMenuIfOpen,
  toggleTagSplitIfOpen: () => current?.toggleTagSplit?.(),
  isTagSplitEnabled: () => !!current?.isTagSplitEnabled?.(),
  attachTagSplitHeader,
  createRootTagIfOpen: () => current?.createRootTag?.()
};
```

Add `createRootTag: () => tagTreePanel.startCreateRoot()` to the mounted
instance.

- [ ] **Step 6: Register the leading header in the Sessions view**

Import the renderer near the other UI imports in
`extensions/dev.session-manager/main.js`:

```js
import { renderSessionsTagHeader } from "./ui/sidebar-header.js";
```

Add this property to the `sessions.list` view registration before
`headerActions`:

```js
headerLeading: {
  render: (container, context) => renderSessionsTagHeader(container, context, {
    manager: __sidebarViewManager,
    t
  })
},
```

Add the missing localized tooltip text to both language maps:

```js
// zh-CN
"tags.addTag": "新建标签",

// en-US
"tags.addTag": "New tag",
```

- [ ] **Step 7: Style the plugin header and exact divider boundary**

Add to `extensions/dev.session-manager/styles.css`:

```css
.zion-sessions-header-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: color-mix(in srgb, var(--fg) 58%, transparent);
  font-size: 12px;
  font-weight: 600;
}

.zion-sessions-header-count {
  flex: 0 0 auto;
  color: color-mix(in srgb, var(--fg) 42%, transparent);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.zion-sessions-header-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: color-mix(in srgb, var(--fg) 48%, transparent);
  cursor: pointer;
}

.zion-sessions-header-add:hover {
  background: var(--hover-bg);
  color: var(--fg);
}

.zion-sidebar-header-leading.zion-sessions-header-leading {
  align-items: center;
  gap: 6px;
  padding: 6px 8px 4px;
}
```

Change `.zion-sessions-split-divider` so its 7 px hit target is absolute and
does not offset the right column:

```css
.zion-sessions-split-divider {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 7px;
  cursor: col-resize;
  z-index: 5;
}

.zion-sessions-split-divider::before {
  content: "";
  position: absolute;
  left: 3px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--surface-border-soft, color-mix(in srgb, var(--border) 55%, transparent));
  transition: background var(--transition-fast), box-shadow var(--transition-fast);
}
```

Remove the transparent divider override and all `.is-lifted` rules. Keep hover
and dragging accent feedback.

- [ ] **Step 8: Run the focused Sessions tests**

Run:

```bash
npx vitest run tests/session-sidebar-header.test.js tests/session-sidebar-tag-split.test.js tests/session-tag-tree.test.js
```

Expected: all tests PASS.

- [ ] **Step 9: Commit the Sessions integration**

```bash
git add extensions/dev.session-manager/ui/sidebar-header.js extensions/dev.session-manager/ui/sidebar-view.js extensions/dev.session-manager/main.js extensions/dev.session-manager/styles.css tests/session-sidebar-header.test.js tests/session-sidebar-tag-split.test.js
git commit -m "feat(sessions): share native header with tag tree"
```

### Task 4: Full Regression And Runtime Verification

**Files:**
- Verify only; do not stage the pre-existing `dev-dist/sw.js` change or `.superpowers/brainstorm/` artifacts.

- [ ] **Step 1: Run all directly affected tests together**

Run:

```bash
npx vitest run tests/workbench-sidebar-chrome.test.js tests/workbench-resize-keeps-view.test.js tests/workbench-scroll-chain.test.js tests/session-sidebar-header.test.js tests/session-sidebar-tag-split.test.js tests/session-tag-tree.test.js tests/session-tag-catalog.test.js tests/session-tag-mutations.test.js
```

Expected: all tests PASS.

- [ ] **Step 2: Run static checks**

Run:

```bash
npm run lint
```

Expected: exit code 0. If unrelated baseline lint failures exist, record their
exact file/line output and ensure no changed file adds a new failure.

- [ ] **Step 3: Run the full test suite**

Run:

```bash
npm test -- --run
```

Expected: changed-feature tests PASS. Compare any unrelated failures against
the branch baseline instead of modifying unrelated modules.

- [ ] **Step 4: Build the application**

Run:

```bash
npm run build
```

Expected: Vite build exits 0. Inspect `git status --short`; do not stage the
pre-existing `dev-dist/sw.js` change or `.superpowers/brainstorm/`. If the build
updates tracked `dist/` artifacts required by this repository, commit only
those generated files in a separate commit:

```bash
git add dist
git commit -m "build: refresh shared session header assets"
```

- [ ] **Step 5: Start the development server**

Run:

```bash
npm run dev -- --host 127.0.0.1
```

Expected: Vite prints a local URL, normally `http://127.0.0.1:5177/`. Keep the
server running for browser verification.

- [ ] **Step 6: Verify desktop split geometry in the real Workbench**

Use the `TRAE-browseruse` skill against the printed URL:

1. Open the Sessions activity item.
2. Enable the tag split if it is disabled.
3. Set the sidebar to at least 420 px wide.
4. Capture a desktop screenshot at a viewport of at least `1440x900`.
5. Verify `全部标签` and `会话` share the same 36 px header row.
6. Verify the vertical header border and content divider have the same x
   coordinate.
7. Drag the divider and verify both boundaries move together without a frame
   of visible lag.
8. Click the header `+` and verify the root tag editor opens in the tree.

Expected: no duplicate tag heading, no covered `会话` title/actions, and no
vertical jump when split mode toggles.

- [ ] **Step 7: Verify responsive fallback**

In the same browser session:

1. Narrow the sidebar body below 380 px.
2. Capture a screenshot.
3. Verify the leading header disappears.
4. Verify the ordinary full-width `会话` header returns.
5. Verify the stacked tags section remains usable.
6. Widen the sidebar again and verify split/header state restores.

Expected: the preference survives, but visible layout follows available width.

- [ ] **Step 8: Inspect final changes and report**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: only the user's pre-existing `dev-dist/sw.js` change and optional
`.superpowers/brainstorm/` artifact remain uncommitted. Report focused tests,
full-suite status, build status, runtime URL, screenshot findings, and commit
hashes.
