# Scheduled Session Date Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route scheduled agent sessions into `archive/YYYY/MM/DD`, write matching hierarchical tags, and upgrade archive migration to version `2` while preserving sessions manually moved outside the archive.

**Architecture:** Extend the existing Scheduler-owned `session-archive.js` with pure time-zone/date and tag-rewrite helpers plus a generic date-folder resolver that uses the already exposed Session Manager commands. Scheduler `main.js` serializes folder-path resolution, supplies `scheduledFor` for service runs, and injects the same resolver into migration. Session Manager remains unchanged.

**Tech Stack:** JavaScript ES modules, `Intl.DateTimeFormat`, Zion command/state APIs, localStorage-backed Scheduler state, Vitest with jsdom.

---

## File Map

- Modify `extensions/dev.scheduler/session-archive.js`: date resolution, hierarchical tag rewrite, date folder creation, migration version `2`, and manual-move protection.
- Modify `extensions/dev.scheduler/main.js`: serialized date-path resolution, dated session content, and service `scheduledFor` propagation.
- Modify `tests/scheduler-session-archive.test.js`: pure date/tag/folder tests and migration version `2` coverage.
- Modify `tests/scheduler-plugin.test.js`: run integration expectations for dated folders/tags and service occurrence timestamps.

### Task 1: Pure Date, Tag, and Folder Model

**Files:**
- Modify: `extensions/dev.scheduler/session-archive.js`
- Modify: `tests/scheduler-session-archive.test.js`

- [ ] **Step 1: Write failing date and tag tests**

Add imports and assertions for the new exports:

```js
import {
  archiveDateForTimestamp,
  scheduledSessionTagForDate,
  rewriteScheduledSessionTag
} from "../extensions/dev.scheduler/session-archive.js";

it("resolves calendar dates in the task time zone", () => {
  const timestamp = Date.UTC(2026, 7, 16, 0, 30);
  expect(archiveDateForTimestamp(timestamp, "Asia/Shanghai")).toMatchObject({
    year: "2026",
    month: "08",
    day: "16",
    key: "2026/08/16",
    segments: ["2026", "08", "16"]
  });
  expect(archiveDateForTimestamp(timestamp, "America/Los_Angeles").key)
    .toBe("2026/08/15");
});

it("falls back from an invalid task time zone", () => {
  expect(archiveDateForTimestamp(
    Date.UTC(2026, 0, 2, 12),
    "Invalid/Zone",
    "UTC"
  ).key).toBe("2026/01/02");
});

it("builds and rewrites only generated scheduled tags", () => {
  const date = { key: "2026/08/16", segments: ["2026", "08", "16"] };
  expect(scheduledSessionTagForDate("定时任务", date))
    .toBe("定时任务/2026/08/16");
  expect(rewriteScheduledSessionTag(
    "user Prompt\n\n#定时任务\nassistant Done",
    "定时任务",
    date
  )).toContain("#定时任务/2026/08/16");
  expect(rewriteScheduledSessionTag(
    "user #定时任务/2026/08/15 #定时任务/日报\nassistant Done",
    "定时任务",
    date
  )).toContain("#定时任务/2026/08/16 #定时任务/日报");
});
```

- [ ] **Step 2: Run the archive tests and verify missing-export failures**

Run:

```bash
npx vitest run tests/scheduler-session-archive.test.js
```

Expected: FAIL because the date and rewrite exports do not exist.

- [ ] **Step 3: Implement time-zone date resolution**

Add a resolver that tries configured, local, then UTC zones:

```js
function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function archiveDateForTimestamp(timestamp, timeZone, fallbackTimeZone = localTimeZone()) {
  const value = Number(timestamp);
  const date = new Date(Number.isFinite(value) ? value : Date.now());
  const zones = [...new Set([timeZone, fallbackTimeZone, "UTC"].filter(Boolean).map(String))];
  for (const zone of zones) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(date);
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      const year = String(values.year || "").padStart(4, "0");
      const month = String(values.month || "").padStart(2, "0");
      const day = String(values.day || "").padStart(2, "0");
      if (year && month && day) {
        return { year, month, day, key: `${year}/${month}/${day}`, segments: [year, month, day] };
      }
    } catch {}
  }
  return { year: "1970", month: "01", day: "01", key: "1970/01/01", segments: ["1970", "01", "01"] };
}
```

- [ ] **Step 4: Implement generated tag construction and rewriting**

Use metadata positions rather than raw substring replacement:

```js
export function scheduledSessionTagForDate(baseTag, archiveDate) {
  const base = normalizeSessionTag(baseTag);
  return `${base}/${archiveDate.segments.join("/")}`;
}

export function rewriteScheduledSessionTag(text, baseTag, archiveDate) {
  const source = String(text || "");
  const base = normalizeSessionTag(baseTag);
  const nextTag = scheduledSessionTagForDate(base, archiveDate);
  const nextLabel = `#${nextTag}`;
  const generatedPattern = new RegExp(
    `^#${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|/\\d{4}/\\d{2}/\\d{2}$)`
  );
  const generated = extractObsidianMetadata(source).tags.find((tag) => generatedPattern.test(tag.label));
  if (!generated) return insertScheduledSessionTag(source, nextTag);
  if (generated.label === nextLabel) return source;
  return `${source.slice(0, generated.pos)}${nextLabel}${source.slice(generated.pos + generated.label.length)}`;
}
```

Custom descendants such as `#定时任务/日报` do not match the generated pattern.

- [ ] **Step 5: Write failing date-folder tests**

Extend the fake command fixture so `zion.sessions.createFolder` mutates the in-memory tree. Then assert:

```js
const archiveDate = archiveDateForTimestamp(Date.UTC(2026, 7, 16), "UTC");
await expect(ensureScheduledSessionDateFolder({
  zion: fixture.zion,
  store,
  locale: "zh-CN",
  archiveDate
})).resolves.toBe("folder-16");
expect(fixture.createCalls).toEqual([
  { parentId: "folder-root", title: "2026" },
  { parentId: "folder-2026", title: "08" },
  { parentId: "folder-08", title: "16" }
]);
```

Add a second call and assert no additional folders are created. Add a failure case where one `createFolder` call returns `null` and the resolver returns `null`, not an ancestor ID.

- [ ] **Step 6: Implement date-folder resolution**

Add direct-child lookup and create each missing segment:

```js
function findDirectFolder(parent, title) {
  return (parent?.children || []).find((node) => (
    node?.type === "folder" && String(node.title || "") === String(title)
  )) || null;
}

export async function ensureScheduledSessionDateFolder({
  zion,
  store,
  locale,
  archiveDate,
  ensureFolder = ensureScheduledSessionFolder
} = {}) {
  const rootId = await ensureFolder({ zion, store, locale });
  if (!rootId || !archiveDate?.segments?.length) return null;
  const tree = await zion?.commands?.executeCommand?.("zion.sessions.getTreeSnapshot");
  let parent = findTreeNode(tree, rootId);
  if (parent?.type !== "folder") return null;
  for (const segment of archiveDate.segments) {
    const existing = findDirectFolder(parent, segment);
    if (existing) {
      parent = existing;
      continue;
    }
    const folderId = await zion?.commands?.executeCommand?.(
      "zion.sessions.createFolder",
      { parentId: parent.id, title: segment }
    );
    if (!folderId) return null;
    parent = { id: String(folderId), type: "folder", title: segment, children: [] };
  }
  return String(parent.id);
}
```

- [ ] **Step 7: Run pure archive tests**

Run:

```bash
npx vitest run tests/scheduler-session-archive.test.js
```

Expected: all pure date, tag, existing archive, and folder tests PASS.

- [ ] **Step 8: Commit the date hierarchy model**

```bash
git add extensions/dev.scheduler/session-archive.js tests/scheduler-session-archive.test.js
git commit -m "feat(scheduler): add dated session archive paths"
```

### Task 2: Migration Version 2 and Run Integration

**Files:**
- Modify: `extensions/dev.scheduler/session-archive.js`
- Modify: `extensions/dev.scheduler/main.js`
- Modify: `tests/scheduler-session-archive.test.js`
- Modify: `tests/scheduler-plugin.test.js`

- [ ] **Step 1: Rewrite migration tests for version 2**

Update fixtures to place scheduled sessions under the archive root and assert dated tags and day-folder moves:

```js
store.saveSessionArchiveState({
  folderId: "folder-root",
  folderLocale: "zh-CN",
  migrationVersion: 1
});

await expect(migrateScheduledSessions({
  zion: fixture.zion,
  store,
  locale: "zh-CN",
  now: () => Date.UTC(2026, 7, 16, 12)
})).resolves.toBe(true);

expect(docs["scheduled-1"]).toContain("#scheduled_tasks/2026/08/15");
expect(fixture.moveCalls).toContainEqual({
  id: "scheduled-1",
  targetFolderId: "folder-15"
});
expect(store.getSessionArchiveState().migrationVersion).toBe(2);
```

Add one scheduled session outside `folder-root`; assert its tag is rewritten but no move call is made for it. Keep the interrupted migration test and update its expected version from `1` to `2`.

- [ ] **Step 2: Run migration tests and verify version-2 failures**

Run:

```bash
npx vitest run tests/scheduler-session-archive.test.js
```

Expected: FAIL because migration still stops at version `1`, writes flat tags, and moves every scheduled session.

- [ ] **Step 3: Upgrade migration to version 2**

Set:

```js
export const SESSION_ARCHIVE_MIGRATION_VERSION = 2;
```

Add pure tree membership:

```js
function isTreeDescendant(root, ancestorId, nodeId) {
  const ancestor = findTreeNode(root, ancestorId);
  return Boolean(findTreeNode(ancestor, nodeId));
}
```

Extend `migrateScheduledSessions` parameters:

```js
{
  zion,
  store,
  locale,
  now = () => Date.now(),
  ensureFolder = ensureScheduledSessionFolder,
  ensureDateFolder = ensureScheduledSessionDateFolder
}
```

After resolving the archive root, capture a tree snapshot. For each scheduled session:

```js
const timestamp = Number(
  meta.createdAt
  || meta.scheduledRunCompletedAt
  || meta.updatedAt
  || migrationStartedAt
);
const archiveDate = archiveDateForTimestamp(timestamp, task?.schedule?.timeZone);
const transformed = await zion.commands.executeCommand("zion.sessions.transformDoc", {
  id: sessionId,
  transform: (text) => rewriteScheduledSessionTag(text, sessionTag, archiveDate)
});
if (transformed !== true) return false;

if (isTreeDescendant(initialTree, folderId, sessionId)) {
  const targetFolderId = await ensureDateFolder({
    zion,
    store,
    locale,
    archiveDate,
    ensureFolder
  });
  if (!targetFolderId) return false;
  const moved = await zion.commands.executeCommand("zion.sessions.moveNode", {
    id: sessionId,
    targetFolderId
  });
  if (moved !== true) return false;
}
```

Save version `2` only after all sessions succeed.

- [ ] **Step 4: Write failing plugin integration tests**

Update the existing manual-run assertion:

```js
expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
  parentId: "folder-16",
  content: "user Summarize\n\n#定时任务/2026/08/16\nassistant "
}));
```

Add a service-backed run test whose claimed run contains:

```js
{
  id: "remote-run",
  scheduledFor: Date.UTC(2026, 7, 15, 23, 30),
  task: {
    clientTaskId: "task-remote",
    prompt: "Summarize",
    schedule: { timeZone: "Asia/Shanghai" }
  }
}
```

Assert its session is routed to `2026/08/16`, proving `scheduledFor` is used.

- [ ] **Step 5: Serialize date-folder resolution in Scheduler**

Keep the existing archive-root promise and add one queue:

```js
let archivePathQueue = Promise.resolve();

const resolveArchiveDateFolder = (archiveDate) => {
  const pending = archivePathQueue
    .catch(() => {})
    .then(() => ensureScheduledSessionDateFolder({
      zion: window.zion,
      store,
      locale: currentLocale(),
      archiveDate,
      ensureFolder: resolveArchiveFolder
    }));
  archivePathQueue = pending.then(() => undefined, () => undefined);
  return pending;
};
```

Use the same resolver for migration:

```js
ensureDateFolder: ({ archiveDate }) => resolveArchiveDateFolder(archiveDate)
```

- [ ] **Step 6: Route new runs into dated folders**

Inside `runTask`, after `startedAt`:

```js
const archiveTimestamp = Number(remoteContext?.scheduledFor || startedAt);
const archiveDate = archiveDateForTimestamp(
  archiveTimestamp,
  task.schedule?.timeZone
);
const folderId = await resolveArchiveDateFolder(archiveDate);
if (!folderId) throw new Error("无法准备定时任务日期文件夹");
const datedTag = scheduledSessionTagForDate(task.sessionTag, archiveDate);
```

Build content with `datedTag` and keep `task.prompt` unchanged for `zion.chat.execute`.

When consuming a service claim, pass:

```js
await runTask(task, {
  runId: remoteRun.id,
  scheduledFor: remoteRun.scheduledFor
});
```

- [ ] **Step 7: Run Scheduler integration tests**

Run:

```bash
npx vitest run tests/scheduler-session-archive.test.js tests/scheduler-plugin.test.js tests/scheduler-controller.test.js tests/scheduler-tools.test.js tests/scheduler-service-api.test.js tests/session-tree-commands.test.js tests/session-tag-index.test.js
```

Expected: all tests PASS.

- [ ] **Step 8: Commit migration and run integration**

```bash
git add extensions/dev.scheduler/session-archive.js extensions/dev.scheduler/main.js tests/scheduler-session-archive.test.js tests/scheduler-plugin.test.js
git commit -m "feat(scheduler): organize sessions by run date"
```

### Task 3: Regression Verification

**Files:**
- Verify all modified source and test files.

- [ ] **Step 1: Run focused Session Manager regressions**

```bash
npx vitest run tests/session-tree-commands.test.js tests/session-doc-commands.test.js tests/session-list-renderer.test.js tests/session-sidebar-tag-split.test.js tests/session-tag-index.test.js
```

Expected: all tests PASS.

- [ ] **Step 2: Run the Scheduler suite**

```bash
npx vitest run tests/scheduler.test.js tests/scheduler-controller.test.js tests/scheduler-service-api.test.js tests/scheduler-tools.test.js tests/scheduler-plugin.test.js tests/scheduler-session-archive.test.js tests/programmatic-runner.test.js
```

Expected: all tests PASS.

- [ ] **Step 3: Run ESLint**

```bash
npx eslint extensions/dev.scheduler/session-archive.js extensions/dev.scheduler/main.js
```

Expected: exit code `0`.

- [ ] **Step 4: Review final repository state**

```bash
git diff --check
git status --short
git log -6 --oneline
```

Expected: no whitespace errors; only the pre-existing `dev-dist/sw.js` and `.superpowers/brainstorm/*` changes remain uncommitted.
