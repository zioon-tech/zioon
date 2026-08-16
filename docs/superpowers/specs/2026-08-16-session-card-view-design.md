# Session Card View Design

## Goal

Add an optional balanced-density card view to the sessions Sidebar while
preserving the existing list view and all current tree interactions.

## Interaction

- The default remains list view.
- A `layout-grid` action in the sessions Sidebar header toggles list/card view.
  It appears before the tag-column action and the shared `columns-2` action.
- The selected mode persists in local storage.
- Folder rows, nesting, drag and drop, multi-selection, context menus, related
  children, and filtering keep their existing behavior.

## Card Content

Each session card shows:

- one-line title;
- up to two lines from the most recent user message;
- up to two session tags, including Biography tags with their automatic-source
  marker;
- a compact relative update time.

The visual treatment follows Zion's dense Workbench style: a single-column
continuous list, 5px card radius, restrained borders, and no nested cards.

## Data Flow

The Sidebar must not read every session document. On each normal autosave, the
session manager extracts a compact preview of the most recent user message and
stores it in the existing session metadata as `lastUserPreview`. Card rendering
reads metadata, the persistent tag index, and `sessions.derivedTags`, all of
which are already memory-backed when the Sidebar is open.

Existing sessions without `lastUserPreview` show no summary until they are next
edited and saved. No startup migration or full-document scan is added.

## Verification

Tests cover last-user extraction, autosave metadata updates, mode persistence,
header toggle wiring, card content, tags, and list-mode compatibility. Browser
verification covers toggling both directions and the card layout with and
without the tag column.
