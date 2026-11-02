# Scheduled Session Date Hierarchy Design

## Context

The first scheduled-session archive implementation creates one real Scheduler-owned root folder and routes every scheduled agent session into it. It also writes one locale-fixed editable tag:

- Chinese task: `#定时任务`
- Other task locale: `#scheduled_tasks`

This removes scheduled sessions from the normal root list, but a frequently running Scheduler still produces too many siblings inside the archive. The archive needs a date-first hierarchy without moving Scheduler policy into Session Manager.

This document extends `2026-08-16-scheduled-session-archive-design.md`. Its migration version is `2`.

## Goals

- Organize scheduled sessions by run date under the existing archive root.
- Make date filtering available through the existing hierarchical tag tree.
- Use the task schedule time zone for calendar boundaries.
- Upgrade sessions migrated by archive version `1`.
- Preserve sessions that the user manually moved outside the archive root.
- Keep all date and migration policy inside Scheduler.

## Non-goals

- Do not group folders by task name.
- Do not create task-specific tags.
- Do not add new Session Manager commands or scheduled node metadata.
- Do not rename the archive root when the locale changes.
- Do not automatically delete empty year, month, or day folders.
- Do not continuously reorganize sessions after migration version `2` completes.

## User-visible Structure

The folder hierarchy is date-first and uses zero-padded numeric segments:

```text
定时任务/
  2026/
    08/
      16/
        定时任务 · Daily report · 2026/8/16 09:00
```

The tag uses the same hierarchy:

```text
#定时任务/2026/08/16
#scheduled_tasks/2026/08/16
```

The existing tag tree therefore exposes four useful scopes without adding UI:

- `定时任务`: every Chinese-tagged scheduled session
- `定时任务/2026`: one year
- `定时任务/2026/08`: one month
- `定时任务/2026/08/16`: one day

Tasks keep their existing fixed base tag. Switching the UI locale does not change the base or historical path.

## Ownership Boundary

### Scheduler owns

- Selecting the archive timestamp.
- Resolving the task time zone.
- Converting a timestamp to `YYYY/MM/DD`.
- Ensuring the three date folders under the archive root.
- Constructing and rewriting generated date tags.
- Migration version `2` and manual-move protection.
- Serializing concurrent folder-path creation.

### Session Manager owns

- The existing generic tree snapshot command.
- The existing generic background folder creation command.
- The existing generic node movement command.
- Document transforms, metadata reads, persistence, catalog refresh, and tag indexing.

Session Manager remains unaware of dates, Scheduler metadata, migration versions, and generated tags.

## Date Resolution

Scheduler adds a pure date resolver:

```ts
interface ArchiveDate {
  year: string;   // "2026"
  month: string;  // "08"
  day: string;    // "16"
  key: string;    // "2026/08/16"
  segments: [string, string, string];
}
```

The resolver uses `Intl.DateTimeFormat(...).formatToParts()` with the requested IANA time zone. Numeric parts are normalized to a four-digit year and two-digit month/day.

Time-zone precedence:

1. `task.schedule.timeZone`
2. Browser local time zone from `Intl.DateTimeFormat().resolvedOptions().timeZone`
3. `UTC` if neither is available or the configured zone is invalid

Run timestamp precedence:

1. Service-backed occurrence: `remoteRun.scheduledFor`
2. Local scheduled or manual run: `startedAt`

Historical timestamp precedence:

1. Session `meta.createdAt`
2. `meta.scheduledRunCompletedAt`
3. `meta.updatedAt`
4. Migration start time as the final fallback

The date represents the task's calendar date, not the browser's current date.

## Folder Path Resolution

The existing archive root ID remains stored in `ScheduledSessionArchiveState.folderId`.

For each run, Scheduler:

1. Resolves or recreates the archive root using the existing version `1` behavior.
2. Loads one current tree snapshot.
3. Finds an exact folder child named `YYYY` under the archive root, or creates it.
4. Finds an exact folder child named `MM` under the year folder, or creates it.
5. Finds an exact folder child named `DD` under the month folder, or creates it.
6. Uses the day folder ID as the new session's `parentId`.

Date child folders do not need persistent IDs. Folder titles are the path identity under their direct parent.

Scheduler keeps one in-memory date-path resolution queue. Each queued operation reads a fresh tree snapshot, reuses existing direct children, and creates only missing segments before the next operation starts. Folder resolution is short and happens before model execution, so serializing this step has negligible run latency while preventing duplicate shared year or month folders across concurrent runs for different dates.

If the day folder was deleted, a later run for that date recreates the missing path. If any folder creation fails, the run fails before creating a session in the wrong parent.

## Tag Construction

New session content contains only the dated tag:

```text
user <task prompt>

#<fixed base tag>/<YYYY>/<MM>/<DD>
assistant
```

The tag remains persisted and editable but is not included in the prompt passed to `zion.chat.execute`.

Scheduler recognizes only tags it generated:

- Exact base: `#定时任务` or `#scheduled_tasks`
- Dated path: the same base followed by `/YYYY/MM/DD`

During migration:

- An exact base tag is replaced with the computed dated tag.
- A different generated dated path is corrected to the computed dated tag.
- If neither generated form exists, the dated tag is inserted.
- Custom descendants such as `#定时任务/日报` are not rewritten.

The rewrite is idempotent and continues to use the shared Obsidian metadata parser so code spans, fenced blocks, and headings are not mistaken for tags.

## New Run Flow

Before creating an agent session, Scheduler:

1. Ensures the task has its locale-fixed base `sessionTag`.
2. Captures `startedAt`.
3. Selects the archive timestamp from `scheduledFor` or `startedAt`.
4. Resolves `ArchiveDate` in the task time zone.
5. Resolves the archive day folder.
6. Builds the dated inline tag.
7. Creates the session directly under the day folder.

Service claim handling passes `scheduledFor` into `runTask` through `remoteContext`. Command-only tasks remain unchanged and create neither folders nor sessions.

## Migration Version 2

Migration version `2` runs once when version `1` or lower is stored.

1. Resolve the archive root.
2. Capture one tree snapshot before moving sessions.
3. Read the flat session catalog.
4. Read metadata first and retain only `meta.source === "scheduled-task"`.
5. Resolve the original task, fixed base tag, task time zone, and historical timestamp.
6. Compute the dated tag and rewrite the generated tag in the document.
7. Determine whether the session was originally a descendant of the archive root in the captured tree.
8. If it was inside the archive, ensure its day folder and move it there.
9. If it was outside the archive, leave its folder location unchanged.
10. Save `migrationVersion: 2` only after every document transform and required move succeeds.

This rule preserves the version `1` user-control contract:

- A session still managed inside the archive is reorganized by date.
- A session manually moved outside the archive is not pulled back.
- Both sessions receive the dated tag for consistent tag filtering.

If migration is interrupted, rerunning it is safe:

- Correct dated tags are unchanged.
- Partially created date folders are reused.
- Sessions already in the correct day folder produce a move no-op.
- The original tree snapshot is recomputed on the retry.

## Failure Handling

- Invalid task time zone: retry date resolution with the browser local zone, then UTC.
- Missing Session Manager commands: leave migration version unchanged and defer.
- Missing archive root: recreate it using existing behavior.
- Date folder creation failure: fail the run or migration item without falling back to a higher-level folder.
- Document transform or move failure: do not advance migration version.
- Duplicate activation or concurrent runs: serialize date-path resolution against fresh tree snapshots.

## Testing

### Pure date and tag tests

- Zero-pad month and day.
- Resolve the same timestamp to different dates across time zones.
- Fall back safely from an invalid configured time zone.
- Build Chinese and English dated tags.
- Replace exact base tags.
- Correct generated dated tags.
- Preserve custom descendant tags and code examples.
- Keep repeated rewrites idempotent.

### Folder tests

- Reuse existing `YYYY/MM/DD` folders.
- Create only missing path segments.
- Recreate a deleted day folder.
- Prevent duplicate shared year/month folders across concurrent requests for different dates.
- Fail instead of returning the archive root when a segment cannot be created.

### Run integration tests

- Pass the day folder as `parentId`.
- Use `scheduledFor` for a service-backed run.
- Use `startedAt` for a manual run.
- Pass only the original task prompt to chat execution.
- Leave command tasks unchanged.

### Migration tests

- Upgrade version `1` sessions into date folders.
- Use each task's configured time zone.
- Rewrite old flat tags.
- Correct a partially migrated dated tag.
- Move sessions that started under the archive root.
- Preserve the folder location of sessions outside the archive.
- Leave version below `2` after a failed transform or move.
- Complete an interrupted migration without duplicate folders or tags.

## Acceptance Criteria

- New scheduled agent sessions are created under `archive/YYYY/MM/DD`.
- Their only generated scheduled tag is `#<base>/YYYY/MM/DD`.
- Year, month, and day ancestors appear through the existing tag tree.
- Date boundaries follow the task schedule time zone.
- Existing version `1` archived sessions are reorganized by date.
- Sessions manually moved outside the archive remain outside it.
- Concurrent same-day runs do not create duplicate folders.
- Session Manager contains no Scheduler-specific date or migration policy.
