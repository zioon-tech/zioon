# Session Card View Design

## Goal

Add an optional balanced-density card view to the sessions Sidebar while
preserving the existing list view and all current tree interactions.

## Interaction

- The default remains list view.
- A `layout-grid` action in the sessions Sidebar header toggles list/card view.
  It appears before the tag-column action and the shared `columns-2` action.
- The card/list and tag-column actions use the shared active-action treatment
  and `aria-pressed`, so their enabled state is visible without opening a menu.
- The selected mode persists in local storage.
- Folder rows, nesting, drag and drop, multi-selection, context menus, related
  children, and filtering keep their existing behavior.

## Card Content

Each session card shows:

- one-line title;
- up to two lines from the document's first meaningful content block;
- up to two session tags, including Biography tags with their automatic-source
  marker;
- a compact relative update time.

The visual treatment follows Zion's dense Workbench style: a single-column
continuous list with low-radius rows, continuous separators, transparent
default backgrounds, and no nested cards.

## Data Flow

The Sidebar must not read every session document. On each normal autosave, the
session manager extracts the first meaningful document block, skips leading
tag-only lines, and stores it in existing session metadata as
`documentPreview`. Card rendering reads metadata, the persistent tag index,
and `sessions.derivedTags`, all of which are already memory-backed when the
Sidebar is open.

Existing sessions without `documentPreview` are backfilled once in an idle
background task after storage synchronization. Sidebar mounting never waits
for that task.

## Verification

Tests cover document-lead extraction, autosave metadata updates, mode
persistence, active header actions, card content, tags, and list-mode
compatibility. Browser verification covers both active states, toggling both
directions, and the card layout with and without the tag column.
