# Flat Filtered Session Results Design

## Context

The Session sidebar currently applies tag and activity-date filters only to session nodes. The list renderer preserves the folder tree and folder expansion state, so a matching session remains invisible when any ancestor folder is collapsed.

Scheduled sessions expose the duplication clearly: selecting `#定时任务/2026/08/16` still requires expanding `定时任务/2026/08/16` in the adjacent session list.

## Goals

- Show matching sessions immediately when a tag or activity-date filter is active.
- Remove redundant folder navigation while filtering.
- Preserve the user's folder expansion and selected-folder state.
- Keep existing row/card interactions, sorting, selection, dragging, menus, and related child items.

## Non-goals

- Do not map tag paths to folder names or IDs.
- Do not mutate `sessions.selectedFolderId`.
- Do not change the persistent folder tree.
- Do not flatten the normal unfiltered list.
- Do not change tag matching semantics.

## Selected Interaction

When any sidebar session filter is active:

- Tag filter: `selectedTag` is non-empty.
- Activity filter: `selectedDay` or `selectedRangeDays` is active.

The right session column switches to a flat result mode:

1. Folder rows are hidden.
2. Every matching session is collected recursively from the full tree.
3. Sessions are sorted with the existing title/updated sort.
4. Rows or cards render at depth zero.
5. Related comments and agent children continue to render below their parent session.
6. The existing header count and filter chip remain visible.

Clearing all filters returns to the normal folder tree. Because flat mode never changes folder-open state or `sessions.selectedFolderId`, the prior tree view returns exactly as the user left it.

## Alternatives Rejected

### Automatically expand matching folders

This keeps the same hierarchy duplicated in both columns, mutates expansion state, and still fails for tags that do not correspond to a folder path.

### Synchronize tag path to folder path

This couples generic tags to folder titles and requires special handling for renamed or moved folders. It would make Scheduler-specific naming assumptions part of Session Manager.

## Component Design

`createSessionsListRenderer` gains one generic option:

```js
getFlatSessionResults: () => boolean
```

The renderer remains unaware of tags and activity filters. `sidebar-view.js` supplies:

```js
getFlatSessionResults: () => Boolean(
  selectedTag || selectedDay || selectedRangeDays
)
```

Inside `list-renderer.js`:

- Extract the existing session-row construction from `renderFolder` into `renderSession(node, rowDepth)`.
- Reuse it for both tree mode and flat mode.
- Add a recursive `collectSessions(root)` helper.
- In flat mode, collect, filter, sort, and call `renderSession(session, 0)`.
- In tree mode, retain the current recursive `renderFolder(root, -1)` behavior.

The root and selection context menus remain mounted in both modes so existing session actions keep working.

## Empty State

If the tree contains sessions but no session matches the active filters, render the existing compact empty area with localized copy:

- Chinese: `没有匹配的会话`
- English: `No matching sessions.`

The filter chip remains available so the user can clear the filter.

## Interaction Details

- Single click continues to open a session.
- Meta/Ctrl and Shift selection use the flat visible order.
- Session drag remains available.
- Dropping is unchanged; no folder drop targets exist while filtering.
- Context menus, delete, rename, export, and status badges are unchanged.
- Card/list mode changes only presentation, not filtering.
- Clearing one of multiple active filters stays in flat mode until all filters are cleared.

## Testing

Add focused list-renderer tests for:

- A matching session under a collapsed folder appears in flat mode.
- Folder rows are absent in flat mode.
- Multiple nested matches are sorted using the existing sort.
- Tree mode remains unchanged when flat mode is false.
- No-match filters show the filtered empty state.
- Clearing the filter restores the existing folder expansion state.
- Row and card modes both render matching sessions.

Add sidebar wiring coverage asserting that tag and activity filters enable flat mode without updating `sessions.selectedFolderId`.

## Acceptance Criteria

- Selecting `#定时任务/2026/08/16` immediately shows all matching sessions.
- No folder expansion is required while a filter is active.
- Folder rows return only after all filters are cleared.
- Previous folder expansion and selected-folder state are preserved.
- Non-Scheduler tags receive the same behavior.
