# Scheduled Session Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive every scheduled agent-run session in one Scheduler-owned default folder, add a locale-fixed editable tag, and migrate existing scheduled sessions without coupling Session Manager to Scheduler policy.

**Architecture:** Session Manager exposes three generic, background-safe tree commands from a focused command module. Scheduler stores its own archive folder ID and migration version, assigns a fixed tag to tasks, and coordinates new-session routing plus one-time migration through those generic commands. Pure archive helpers live outside the Scheduler entry point so locale, document rewriting, folder resolution, and migration are directly testable.

**Tech Stack:** JavaScript ES modules, Zion command/state APIs, IndexedDB-backed Session Manager storage, localStorage-backed Scheduler store, Vitest with jsdom.

---

## File Map

- Create `extensions/dev.session-manager/commands/tree-apis.js`: register generic defensive tree-read, silent folder-create, and node-move commands.
- Modify `extensions/dev.session-manager/main.js`: wire tree dependencies into the generic command module.
- Create `tests/session-tree-commands.test.js`: verify command behavior and UI-state isolation.
- Create `extensions/dev.scheduler/session-archive.js`: own locale tags, document construction, archive folder resolution, and one-time migration.
- Modify `extensions/dev.scheduler/store.js`: persist Scheduler archive state.
- Modify `extensions/dev.scheduler/controller.js`: normalize and preserve a task's local `sessionTag`.
- Modify `extensions/dev.scheduler/main.js`: assign tags from locale, run migration, and create new sessions in the archive.
- Modify `extensions/dev.scheduler/scheduler-tools.js`: inject a locale-fixed tag when a tool creates a task.
- Create `tests/scheduler-session-archive.test.js`: unit-test archive helpers and migration.
- Modify `tests/scheduler-controller.test.js`: cover task tag preservation.
- Modify `tests/scheduler-plugin.test.js`: cover new-run archive integration.

### Task 1: Generic Session Tree Commands

**Files:**
- Create: `extensions/dev.session-manager/commands/tree-apis.js`
- Modify: `extensions/dev.session-manager/main.js`
- Create: `tests/session-tree-commands.test.js`

- [ ] **Step 1: Write failing command API tests**

Create a command-registry fixture and assert all three generic contracts:

```js
import { describe, expect, it, vi } from "vitest";
import { registerSessionTreeCommands } from "../extensions/dev.session-manager/commands/tree-apis.js";

it("returns a defensive tree snapshot", () => {
  const tree = { id: "root", type: "folder", children: [] };
  const { commands } = registerFixture({ loadTree: () => tree });
  const snapshot = commands.get("zion.sessions.getTreeSnapshot")();
  snapshot.children.push({ id: "mutated" });
  expect(tree.children).toEqual([]);
});

it("creates a folder without changing UI state", () => {
  const insertFolder = vi.fn(() => "fld-1");
  const { commands, zion } = registerFixture({ insertFolder });
  expect(commands.get("zion.sessions.createFolder")({
    parentId: "root",
    title: "Scheduled Tasks"
  })).toBe("fld-1");
  expect(insertFolder).toHaveBeenCalledWith("root", "Scheduled Tasks");
  expect(zion.state.set).not.toHaveBeenCalled();
});

it("moves a node and refreshes mounted session lists", () => {
  const moveNode = vi.fn(() => true);
  const refresh = vi.fn();
  const { commands, zion } = registerFixture({
    moveNode,
    getIndex: () => [{ id: "s1" }],
    refreshSessionsSidebarViewIfOpen: refresh
  });
  expect(commands.get("zion.sessions.moveNode")({
    id: "s1",
    targetFolderId: "fld-1"
  })).toBe(true);
  expect(zion.state.set).toHaveBeenCalledWith("sessions.catalog", [{ id: "s1" }]);
  expect(refresh).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the new tests and verify the missing module failure**

Run:

```bash
npx vitest run tests/session-tree-commands.test.js
```

Expected: FAIL because `commands/tree-apis.js` does not exist.

- [ ] **Step 3: Implement the generic command module**

Implement a focused registrar:

```js
function clone(value) {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function registerSessionTreeCommands(deps = {}) {
  const disposables = [];
  const findParentId = (root, id, parentId = null) => {
    if (!root) return null;
    if (root.id === id) return parentId;
    for (const child of root.children || []) {
      const found = findParentId(child, id, root.id);
      if (found) return found;
    }
    return null;
  };
  const register = (id, handler) => {
    const disposable = deps.zion?.commands?.registerCommand?.(id, handler);
    if (disposable) disposables.push(disposable);
  };

  register("zion.sessions.getTreeSnapshot", () => clone(deps.loadTree?.() || null));
  register("zion.sessions.createFolder", ({ parentId = "root", title = "New Folder" } = {}) => (
    deps.insertFolder?.(String(parentId || "root"), String(title || "").trim() || "New Folder") || null
  ));
  register("zion.sessions.moveNode", ({ id, targetFolderId } = {}) => {
    const nodeId = String(id || "");
    const folderId = String(targetFolderId || "");
    if (findParentId(deps.loadTree?.(), nodeId) === folderId) return true;
    const moved = deps.moveNode?.(nodeId, folderId) === true;
    if (!moved) return false;
    deps.zion?.state?.set?.("sessions.catalog", deps.getIndex?.() || []);
    deps.refreshSessionsSidebarViewIfOpen?.();
    return true;
  });

  return {
    dispose() {
      for (const disposable of disposables.splice(0)) disposable?.dispose?.();
    }
  };
}
```

- [ ] **Step 4: Wire the registrar into Session Manager activation**

Import `registerSessionTreeCommands` in `extensions/dev.session-manager/main.js`, register it after storage initialization, and push the returned disposable:

```js
const dTreeApis = registerSessionTreeCommands({
  zion: window.zion,
  loadTree,
  insertFolder,
  moveNode,
  getIndex,
  refreshSessionsSidebarViewIfOpen
});
ctx.subscriptions.push(dTreeApis);
```

Keep `zion.sessions.newFolder` unchanged so interactive selection and inline rename behavior do not regress.

- [ ] **Step 5: Run Session Manager command tests**

Run:

```bash
npx vitest run tests/session-tree-commands.test.js tests/session-list-renderer.test.js tests/session-sidebar-tag-split.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Commit the generic API**

```bash
git add extensions/dev.session-manager/commands/tree-apis.js extensions/dev.session-manager/main.js tests/session-tree-commands.test.js
git commit -m "feat(sessions): expose generic tree commands"
```

### Task 2: Scheduler Tag and Archive Model

**Files:**
- Create: `extensions/dev.scheduler/session-archive.js`
- Modify: `extensions/dev.scheduler/store.js`
- Modify: `extensions/dev.scheduler/controller.js`
- Create: `tests/scheduler-session-archive.test.js`
- Modify: `tests/scheduler-controller.test.js`

- [ ] **Step 1: Write failing pure helper and store tests**

Cover locale choice, task preservation, initial document format, idempotent migration transform, and archive state:

```js
expect(sessionTagForLocale("zh-CN")).toBe("定时任务");
expect(sessionTagForLocale("en-US")).toBe("scheduled_tasks");
expect(withSessionTag({ id: "t1" }, "zh-CN").sessionTag).toBe("定时任务");
expect(withSessionTag({ id: "t1", sessionTag: "scheduled_tasks" }, "zh-CN").sessionTag)
  .toBe("scheduled_tasks");
expect(buildScheduledSessionContent("Summarize", "scheduled_tasks"))
  .toBe("user Summarize\n\n#scheduled_tasks\nassistant ");

const once = insertScheduledSessionTag("user Prompt\nassistant Reply\nuser ", "定时任务");
expect(once).toBe("user Prompt\n\n#定时任务\nassistant Reply\nuser ");
expect(insertScheduledSessionTag(once, "定时任务")).toBe(once);

const store = new LocalSchedulerStore();
expect(store.getSessionArchiveState()).toEqual({
  folderId: null,
  folderLocale: "",
  migrationVersion: 0
});
store.saveSessionArchiveState({ folderId: "fld-1", folderLocale: "zh-CN", migrationVersion: 1 });
expect(new LocalSchedulerStore().getSessionArchiveState()).toMatchObject({
  folderId: "fld-1",
  migrationVersion: 1
});
```

Extend the controller normalization test:

```js
const tagged = buildSchedulerTask({
  title: "Daily",
  prompt: "Summarize",
  sessionTag: "定时任务",
  schedule: { kind: "daily", time: "09:00" }
}, null, NOW);
expect(mergeSchedulerTask(tagged, { title: "Daily v2" }, NOW).sessionTag).toBe("定时任务");
```

- [ ] **Step 2: Run tests and verify failures**

Run:

```bash
npx vitest run tests/scheduler-session-archive.test.js tests/scheduler-controller.test.js
```

Expected: FAIL for missing archive helpers/store methods/task field.

- [ ] **Step 3: Implement pure locale and document helpers**

In `session-archive.js`, import `extractObsidianMetadata` and implement:

```js
export const SESSION_ARCHIVE_MIGRATION_VERSION = 1;

export function sessionTagForLocale(locale) {
  return String(locale || "") === "zh-CN" ? "定时任务" : "scheduled_tasks";
}

export function withSessionTag(task, locale) {
  const existing = String(task?.sessionTag || "").replace(/^#/, "").trim();
  return { ...(task || {}), sessionTag: existing || sessionTagForLocale(locale) };
}

export function buildScheduledSessionContent(prompt, sessionTag) {
  return `user ${String(prompt || "")}\n\n#${String(sessionTag || "")}\nassistant `;
}

export function insertScheduledSessionTag(text, sessionTag) {
  const source = String(text || "");
  const label = `#${String(sessionTag || "").replace(/^#/, "").trim()}`;
  if (extractObsidianMetadata(source).tags.some((tag) => tag.label === label)) return source;
  const lines = source.split("\n");
  const assistantIndex = lines.findIndex((line) => /^\s*assistant(?:\s|$)/.test(line));
  const index = assistantIndex < 0 ? lines.length : assistantIndex;
  const insertion = [];
  if (index > 0 && lines[index - 1] !== "") insertion.push("");
  insertion.push(label);
  lines.splice(index, 0, ...insertion);
  return lines.join("\n");
}
```

The helper inserts before the first assistant role line and leaves an existing exact inline tag unchanged.

- [ ] **Step 4: Persist Scheduler archive state**

Add a versioned key and methods in `store.js`:

```js
const SESSION_ARCHIVE_KEY = "zion.scheduler.local.sessionArchive.v1";

getSessionArchiveState() {
  const value = read(SESSION_ARCHIVE_KEY, {});
  return {
    folderId: String(value?.folderId || "") || null,
    folderLocale: String(value?.folderLocale || ""),
    migrationVersion: Math.max(0, Number(value?.migrationVersion) || 0)
  };
}

saveSessionArchiveState(patch = {}) {
  const next = { ...this.getSessionArchiveState(), ...patch };
  write(SESSION_ARCHIVE_KEY, next);
  return next;
}
```

- [ ] **Step 5: Preserve `sessionTag` in the task builder**

Normalize an explicit or existing tag in `buildSchedulerTask`:

```js
const sessionTag = String(input?.sessionTag ?? existing?.sessionTag ?? "")
  .replace(/^#/, "")
  .trim();

// In the existing return object, place the normalized value beside prompt:
prompt: String(input?.prompt ?? existing?.prompt ?? "").trim(),
sessionTag,
command,
```

Do not read `window.zion` in the pure controller.

- [ ] **Step 6: Run helper, store, and controller tests**

Run:

```bash
npx vitest run tests/scheduler-session-archive.test.js tests/scheduler-controller.test.js tests/scheduler-service-api.test.js
```

Expected: all tests PASS and the service payload test confirms `sessionTag` is not sent remotely.

- [ ] **Step 7: Commit the archive model**

```bash
git add extensions/dev.scheduler/session-archive.js extensions/dev.scheduler/store.js extensions/dev.scheduler/controller.js tests/scheduler-session-archive.test.js tests/scheduler-controller.test.js
git commit -m "feat(scheduler): add session archive model"
```

### Task 3: Historical Migration and New-Run Routing

**Files:**
- Modify: `extensions/dev.scheduler/session-archive.js`
- Modify: `extensions/dev.scheduler/main.js`
- Modify: `extensions/dev.scheduler/scheduler-tools.js`
- Modify: `tests/scheduler-session-archive.test.js`
- Modify: `tests/scheduler-plugin.test.js`
- Modify: `tests/scheduler-tools.test.js`

- [ ] **Step 1: Write failing archive resolution and migration tests**

Build a fake Zion command map and test:

```js
const folderId = await ensureScheduledSessionFolder({ zion, store, locale: "zh-CN" });
expect(folderId).toBe("fld-existing"); // adopts exact root title once
expect(store.getSessionArchiveState().folderId).toBe("fld-existing");

store.saveSessionArchiveState({ folderId: "fld-moved" });
expect(await ensureScheduledSessionFolder({ zion, store, locale: "en-US" }))
  .toBe("fld-moved"); // nested/renamed folders remain identified by ID

await migrateScheduledSessions({ zion, store, locale: "zh-CN" });
expect(transformDoc).toHaveBeenCalledFor("scheduled-1");
expect(moveNode).toHaveBeenCalledWith({
  id: "scheduled-1",
  targetFolderId: "fld-existing"
});
expect(transformDoc).not.toHaveBeenCalledFor("normal-1");
expect(store.getSessionArchiveState().migrationVersion).toBe(1);
```

Add failure coverage proving `migrationVersion` remains `0` when a transform or move fails, then rerun successfully and assert no duplicate tag.

- [ ] **Step 2: Run archive tests and verify failures**

Run:

```bash
npx vitest run tests/scheduler-session-archive.test.js
```

Expected: FAIL for missing folder resolution and migration exports.

- [ ] **Step 3: Implement archive folder resolution**

Add recursive node lookup and a resolver:

```js
function findNode(root, id) {
  if (!root || !id) return null;
  if (root.id === id) return root;
  for (const child of root.children || []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export async function ensureScheduledSessionFolder({ zion, store, locale }) {
  const tree = await zion.commands.executeCommand("zion.sessions.getTreeSnapshot");
  if (!tree) return null;
  const state = store.getSessionArchiveState();
  const stored = findNode(tree, state.folderId);
  if (stored?.type === "folder") return stored.id;
  const title = locale === "zh-CN" ? "定时任务" : "Scheduled Tasks";
  const adopted = !state.folderId
    ? (tree.children || []).find((node) => node.type === "folder" && node.title === title)
    : null;
  const folderId = adopted?.id || await zion.commands.executeCommand(
    "zion.sessions.createFolder",
    { parentId: "root", title }
  );
  if (!folderId) return null;
  store.saveSessionArchiveState({ folderId, folderLocale: String(locale || "") });
  return folderId;
}
```

- [ ] **Step 4: Implement idempotent historical migration**

Implement `migrateScheduledSessions` so it:

1. Returns immediately when `migrationVersion >= 1`.
2. Ensures the archive folder.
3. Backfills missing task tags and saves those tasks.
4. Reads IDs from `zion.state.get("sessions.catalog")`.
5. Reads metadata first and filters `source === "scheduled-task"`.
6. Awaits `transformDoc` with `insertScheduledSessionTag`.
7. Awaits generic `moveNode`.
8. Saves migration version only after every item succeeds.

Treat any false/null command result as a failed migration and leave the version unchanged.

- [ ] **Step 5: Add locale-fixed tags to all creation entry points**

In `main.js`, add:

```js
function currentLocale() {
  return String(
    window.zion?.i18n?.getLocale?.()
    || window.zion?.state?.get?.("ui.locale")
    || "zh-CN"
  );
}
```

Pass an existing or newly derived `sessionTag` from `taskFromForm`. Wrap panel saves with `withSessionTag(task, currentLocale())`.

Change `registerSchedulerTool` to accept `getSessionTag` and inject it only for `create`:

```js
const task = buildSchedulerTask({
  ...(args.task || {}),
  sessionTag: getSessionTag()
});
```

Pass `getSessionTag: () => sessionTagForLocale(currentLocale())` from `main.js`. Updates continue to preserve the existing field through `mergeSchedulerTask`.

- [ ] **Step 6: Route new sessions directly into the archive**

At the start of `runTask`, normalize and persist a missing task tag, resolve the archive folder, and fail before session creation when it is unavailable:

```js
const taggedTask = withSessionTag(task, currentLocale());
if (taggedTask.sessionTag !== task.sessionTag) store.saveTask(taggedTask);
const folderId = await ensureScheduledSessionFolder({
  zion: window.zion,
  store,
  locale: currentLocale()
});
if (!folderId) throw new Error("无法准备定时任务会话文件夹");
```

Create the session with:

```js
{
  parentId: folderId,
  content: buildScheduledSessionContent(taggedTask.prompt, taggedTask.sessionTag),
  open: false,
  meta: {
    source: "scheduled-task",
    scheduledTaskId: taggedTask.id,
    scheduledRunId: run.id,
    scheduledRunStatus: "running"
  }
}
```

Continue passing only `taggedTask.prompt` to `zion.chat.execute`.

- [ ] **Step 7: Schedule migration after activation**

Invoke migration once after Scheduler setup and subscribe to `sessions.catalog` changes for deferred retry when Session Manager activates later:

```js
let migrationRunning = false;
const requestMigration = async () => {
  if (disposed || migrationRunning) return;
  migrationRunning = true;
  try {
    await migrateScheduledSessions({
      zion: window.zion,
      store,
      locale: currentLocale()
    });
  } finally {
    migrationRunning = false;
  }
};

void requestMigration();
const migrationSub = window.zion.state?.onDidChange?.("sessions.catalog", requestMigration);
```

Dispose the subscription with the plugin.

- [ ] **Step 8: Update integration tests**

In Scheduler plugin tests, register fake generic tree commands and change the new-run assertion:

```js
expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
  parentId: "fld-scheduled",
  content: "user Summarize\n\n#定时任务\nassistant ",
  open: false
}));
expect(window.zion.chat.execute).toHaveBeenCalledWith(expect.objectContaining({
  prompt: "Summarize",
  sessionId: "session-1"
}));
```

Add tests for English creation, folder failure preventing root creation, and the scheduler tool assigning a fixed tag.

- [ ] **Step 9: Run all Scheduler and Session archive tests**

Run:

```bash
npx vitest run tests/scheduler-session-archive.test.js tests/scheduler-plugin.test.js tests/scheduler-tools.test.js tests/scheduler-controller.test.js tests/session-tree-commands.test.js tests/session-tag-index.test.js
```

Expected: all tests PASS.

- [ ] **Step 10: Commit migration and routing**

```bash
git add extensions/dev.scheduler/session-archive.js extensions/dev.scheduler/main.js extensions/dev.scheduler/scheduler-tools.js tests/scheduler-session-archive.test.js tests/scheduler-plugin.test.js tests/scheduler-tools.test.js
git commit -m "feat(scheduler): archive scheduled sessions"
```

### Task 4: Regression Verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run focused Session Manager regression tests**

```bash
npx vitest run tests/session-tree-commands.test.js tests/session-doc-commands.test.js tests/session-list-renderer.test.js tests/session-sidebar-tag-split.test.js tests/session-tag-index.test.js
```

Expected: all tests PASS.

- [ ] **Step 2: Run the complete Scheduler suite**

```bash
npx vitest run tests/scheduler.test.js tests/scheduler-controller.test.js tests/scheduler-service-api.test.js tests/scheduler-tools.test.js tests/scheduler-plugin.test.js tests/scheduler-session-archive.test.js tests/programmatic-runner.test.js
```

Expected: all tests PASS.

- [ ] **Step 3: Run lint on touched source files**

```bash
npx eslint extensions/dev.session-manager/commands/tree-apis.js extensions/dev.session-manager/main.js extensions/dev.scheduler/session-archive.js extensions/dev.scheduler/store.js extensions/dev.scheduler/controller.js extensions/dev.scheduler/main.js extensions/dev.scheduler/scheduler-tools.js
```

Expected: exit code `0`.

- [ ] **Step 4: Inspect the final diff**

```bash
git diff --check
git status --short
git log -4 --oneline
```

Expected: no whitespace errors; only pre-existing unrelated `dev-dist/sw.js` and `.superpowers/brainstorm/*` changes remain uncommitted.
