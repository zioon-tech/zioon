# Scheduled Session Archive Design

## Context

Every agent-type scheduled run currently creates an independent background session at the session tree's current default location. Frequent tasks therefore add many top-level sessions and make the normal conversation list harder to scan.

Scheduled sessions already carry stable metadata:

- `source: "scheduled-task"`
- `scheduledTaskId`
- `scheduledRunId`

The Session Manager already supports creating a session under a supplied `parentId`, reading session metadata, and transforming a session document. It also has internal folder creation and node movement primitives, but no generic command API for background plugins to use without changing visible selection state.

## Goals

- Keep one independent session per scheduled agent run.
- Put scheduled sessions in one real default archive folder.
- Add an editable inline tag to every scheduled session document.
- Fix the tag language when the task is created:
  - `#定时任务` for tasks created under `zh-CN`
  - `#scheduled_tasks` for tasks created under any other locale
- Migrate existing scheduled sessions into the archive folder and add missing tags.
- Keep Scheduler business rules out of Session Manager.
- Preserve user control after the initial migration.

## Non-goals

- Command-only tasks do not create sessions and are unchanged.
- Do not merge multiple runs into one session.
- Do not create one subfolder per task.
- Do not add a virtual or smart folder.
- Do not translate old tags when the application locale changes.
- Do not continuously move a session back after the user manually moves it elsewhere.
- Do not add Scheduler-specific node types or fields to the session tree.

## Ownership Boundary

### Scheduler owns

- The archive folder title and stored folder ID.
- The fixed session tag assigned to each task.
- Scheduled-session discovery.
- Historical migration policy and migration version.
- Retry and idempotency rules.
- Construction of new scheduled-session content.

### Session Manager owns

- Session tree persistence.
- Generic folder creation.
- Generic node lookup and movement.
- Session creation under a supplied parent folder.
- Generic document and metadata reads and writes.
- Refreshing its catalog, tag index, and visible views after mutations.

Session Manager must not inspect `source: "scheduled-task"`, understand scheduled task IDs, choose scheduled tags, or store a scheduled-folder marker.

## Generic Session Commands

Expose the minimum generic command surface needed by Scheduler:

```js
zion.sessions.getTreeSnapshot()
// -> cloned tree or null

zion.sessions.createFolder({
  parentId: "root",
  title: "定时任务"
})
// -> folder id

zion.sessions.moveNode({
  id: sessionId,
  targetFolderId: folderId
})
// -> boolean
```

`createFolder` is a background-safe primitive. It must not change selection, selected folder, inline rename state, open state, or focus. The existing user-facing `zion.sessions.newFolder` command keeps its current UI behavior and may call the same underlying tree primitive.

`moveNode` must refresh the session catalog and currently mounted session-list views after a successful move. Moving an item to its current parent should be treated as a successful no-op.

`getTreeSnapshot` must return a clone so consumers cannot mutate session state by reference.

Existing commands remain the document API:

```js
zion.sessions.getMeta(sessionId)
zion.sessions.getDocAsync(sessionId)
zion.sessions.transformDoc({ id: sessionId, transform })
zion.sessions.new({ parentId, title, content, open, meta })
```

## Scheduler Data

### Task tag

Agent tasks gain a local Scheduler-owned field:

```ts
sessionTag: "定时任务" | "scheduled_tasks"
```

The value does not include `#`. Scheduler creation entry points resolve it before building and persisting a new task:

```text
ui.locale === "zh-CN" -> 定时任务
otherwise             -> scheduled_tasks
```

The pure task builder normalizes an explicit value and preserves an existing value; it does not read UI state directly. Task updates preserve the value. Changing the application language does not rewrite it.

Service reconciliation preserves the local value when a matching local task already exists. A service task first seen on this client receives a value based on the current client locale because the archive and session documents are client-local concerns. The field is not added to the current Scheduler service API payload.

### Archive state

`LocalSchedulerStore` persists Scheduler-owned archive state under a versioned Scheduler key:

```ts
interface ScheduledSessionArchiveState {
  folderId: string | null;
  folderLocale: "zh-CN" | "en-US" | string;
  migrationVersion: number;
}
```

The folder title is chosen when the folder is first created:

- `定时任务` for `zh-CN`
- `Scheduled Tasks` for other locales

The title is not subsequently synchronized with the locale. The folder ID remains valid when the user renames or moves the folder.

When no archive state exists yet, Scheduler first adopts the first root-level folder whose title exactly matches the localized default. Otherwise it creates a new root-level folder. After storing the folder ID, Scheduler never uses the title as identity.

If the stored folder ID no longer points to a folder, Scheduler creates a replacement at the session root and updates its archive state. Deleting the old folder continues to use Session Manager's existing recursive-delete confirmation.

## New Run Flow

Before creating an agent run session, Scheduler:

1. Resolves the task's fixed `sessionTag`, filling and saving it if absent.
2. Resolves the stored archive folder ID against a tree snapshot.
3. Creates a root archive folder through `zion.sessions.createFolder` when needed.
4. Creates the session with `parentId` set to the archive folder ID.

The initial document is:

```text
user <task prompt>

#<fixed session tag>
assistant
```

The tag is part of the persisted session document and is therefore editable. It is not added to the prompt passed to `zion.chat.execute`, so it does not change model behavior.

Session metadata continues to contain the existing scheduled source, task ID, run ID, and run status fields.

If folder resolution fails, the run fails before creating a misplaced session. Scheduler records the run failure through its existing error path.

## Historical Migration

Migration version `1` runs from Scheduler after Session Manager commands and the session catalog are available.

1. Resolve or create the archive folder.
2. Assign and save `sessionTag` for every existing agent task that lacks one, using the locale at migration time.
3. Read IDs from `sessions.catalog`.
4. Read metadata first and keep only sessions with `meta.source === "scheduled-task"`.
5. Resolve each session tag from its `scheduledTaskId`.
6. Use the migration-locale fallback tag when the original task no longer exists.
7. Add the tag only when that exact inline tag is absent.
8. Move the session to the archive folder.
9. Save `migrationVersion: 1` only after all scheduled sessions succeed.

The migration scans metadata before loading documents, so normal session documents are not read. Only scheduled-session documents are transformed.

The document transform is idempotent and inserts the tag immediately before the first assistant role block. It uses the existing inline-tag extraction rules instead of substring matching, preventing false positives from code blocks, headings, or longer tag paths.

If migration is interrupted, the version remains unchanged. The next activation retries it:

- Existing tags are not duplicated.
- Moving a session already in the archive is a no-op.
- Existing task tags are preserved.

After migration version `1` is recorded, Scheduler does not scan or move historical sessions again. A session the user later moves out remains where the user placed it.

## Locale Behavior

- Task created in Chinese, then UI changed to English: future runs still use `#定时任务`.
- Task created in English, then UI changed to Chinese: future runs still use `#scheduled_tasks`.
- Existing untagged task at migration time: receives the current locale's tag once.
- Orphan scheduled session whose task no longer exists: receives the migration locale's fallback tag.
- One archive folder can contain sessions with both tags.

## Failure Handling

- Missing Session Manager commands: defer migration and run creation rather than writing to the wrong folder.
- Missing stored folder: create a replacement and persist its ID.
- Folder creation failure: do not create the scheduled session at root.
- Individual migration failure: do not advance the migration version.
- Duplicate execution: safe because folder lookup, tag insertion, and movement are idempotent.
- Tag-index updates continue through Session Manager's existing document save path.

## Testing

### Scheduler tests

- New Chinese task stores `sessionTag: "定时任务"`.
- New English task stores `sessionTag: "scheduled_tasks"`.
- Updating a task after a locale switch preserves its tag.
- Service reconciliation preserves an existing local tag.
- New agent runs resolve the archive folder and pass its ID as `parentId`.
- Session content contains one fixed tag while `zion.chat.execute` receives the original prompt.
- A deleted archive folder is recreated.
- Folder resolution failure does not create a root session.
- Migration moves all scheduled sessions and ignores normal sessions.
- Migration tags sessions by task and uses the fallback for orphan sessions.
- Re-running an interrupted migration does not duplicate tags.
- Completed migration does not run again.
- Command tasks remain unaffected.

### Session Manager tests

- `getTreeSnapshot` returns a defensive clone.
- `createFolder` creates a folder without changing UI selection, open state, or pending rename.
- `moveNode` moves sessions and refreshes the catalog.
- `moveNode` treats an already-correct parent as a successful no-op.
- Existing interactive folder creation behavior remains unchanged.

## Acceptance Criteria

- After activation, all pre-existing scheduled agent sessions are under one real archive folder and contain the appropriate editable inline tag.
- Every future scheduled agent run creates one independent session directly in that folder.
- Scheduled sessions appear under `#定时任务` or `#scheduled_tasks` in the existing tag tree without a full-session rescan.
- Locale changes do not alter a task's established tag.
- Renaming or moving the archive folder does not break future routing.
- Manually moving an archived session out is respected after the one-time migration.
- Session Manager contains no Scheduler-specific policy or metadata interpretation.
