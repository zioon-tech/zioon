# Session Sidebar Tag Split

## Status

Approved for implementation planning on 2026-08-15.

## Goal

Make a growing tag collection manageable without moving tag navigation out of
the Sessions sidebar.

On desktop, the user can switch the Sessions sidebar from its existing stacked
layout to an internal two-column layout:

- The left column contains the tag catalog and the activity heatmap.
- The right column contains the existing session tree.
- Enabling the split automatically widens the outer Workbench sidebar.
- Disabling the split restores the previous outer sidebar width.

This is an opt-in layout mode exposed as a quick action in the Sessions sidebar
header. It is not a new Workbench-level sidebar.

## Approved Product Decisions

- The split is inside the existing Sessions sidebar view.
- The split toggle lives in the Sessions sidebar header.
- Enabling the split automatically widens the outer sidebar.
- The activity heatmap remains in the left internal column.
- Tags support create, rename, delete, and drag-to-reorder.
- Manually created tags remain visible even when no session uses them.
- The first version does not introduce a new workflow for assigning tags to
  sessions.

## Existing Behavior

The current Sessions sidebar renders three vertically stacked regions:

1. The session tree, which owns most of the available height.
2. A tag tree capped at roughly 170 px.
3. An activity heatmap.

Tags are discovered by scanning valid inline Obsidian-style tags in session
documents. A path such as `#project/zion` is expanded into parent and child
nodes, and selecting a parent includes sessions using descendant tags.

This already provides useful filtering, but it has two scaling limits:

- The tag tree competes with the session tree and heatmap for vertical space.
- Scanned tags have no durable identity or ordering, so empty tags and manual
  management cannot be represented.

## Considered Approaches

### 1. Keep the stacked layout and increase the tag panel height

This is the smallest implementation, but it only moves the contention between
the session list and tag list. It becomes less usable as either list grows.

### 2. Add a separate full-screen tag management view

This provides the most room for advanced bulk operations, but separates tag
navigation from the session list and adds unnecessary navigation for routine
filtering.

### 3. Use an internal split with a persistent tag catalog

This is the selected approach. It follows the proven category-tree and content-
list pattern used by Feishu message groups while preserving Zion Next's compact
Workbench interaction model.

The tag catalog borrows Obsidian's hierarchical path semantics: tags remain
represented in documents as `#parent/child`, while the catalog adds durable
identity, empty nodes, and explicit sibling order.

## Layout

### Desktop split mode

```text
+----------------------------------------------------+
| SESSIONS                         [new] [split] [...] |
+-------------------+--------------------------------+
| TAGS          [+] | SESSION TREE                   |
| [Search tags...]  |                                |
|                   |                                |
| v #project      8 | v Workspace                    |
|     zion        5 |     Session A                  |
|     agent       3 |     Session B                  |
|   #research     2 |   Archive                      |
|                   |                                |
|                   |                                |
+-------------------+                                |
| ACTIVITY          |                                |
| [heatmap]         |                                |
+-------------------+--------------------------------+
```

- The tag column defaults to 168 px.
- The tag column has a 140 px minimum and a 240 px maximum.
- The session column has a 220 px minimum.
- A one-pixel separator and narrow drag target divide the columns.
- The divider can be dragged and its position is persisted.
- The tag tree scrolls independently.
- The activity section stays at the bottom of the left column and keeps its
  existing collapse behavior.
- The right column gives its full height to the existing session renderer.
- The design uses continuous separators and transparent controls rather than
  cards or floating surfaces.

### Outer sidebar width

When split mode is enabled:

1. Record the current outer sidebar width as the restore width.
2. If the current width is below 440 px, request a width of 440 px.
3. If the current width is already at least 440 px, preserve it.

When split mode is disabled:

1. Restore the width recorded when split mode was enabled.
2. If no valid restore width exists, use the Workbench's normal persisted
   sidebar width.

Manual resizing while split mode is active remains allowed. The final width is
not used to overwrite the pre-split restore width.

### Compact and mobile behavior

The split preference is desktop-only presentation state, not a different data
mode.

- If the Sessions view becomes narrower than 380 px, it renders the existing
  stacked layout while retaining the split preference.
- Medium and mobile Workbench modes always use the stacked layout.
- Returning to a desktop width restores the internal split automatically.
- No horizontal scrolling is introduced.

## Header Toggle

Add a split-layout icon between the existing New Session and Actions buttons in
the Sessions sidebar header.

- Clicking it toggles the persisted split preference.
- The tooltip changes between `Show tag column` and `Hide tag column`.
- The button uses `aria-pressed` to expose the current state.
- The action is also registered as
  `zion.sessions.toggleTagSplit` for command and keyboard access.
- Toggling does not change the selected session, selected tag, scroll position,
  or expanded tree nodes.

The Workbench header action contract may be extended with an optional dynamic
pressed state. Existing header actions remain unchanged.

## Tag Column

### Header and search

The tag column header contains:

- The label `Tags`.
- The total catalog node count.
- An Add button using the existing icon system.

A compact search input appears below the header.

- Search is case-insensitive.
- Matching nodes remain visible with all ancestors required to show their path.
- Search does not change the selected tag.
- Clearing search restores the previous expansion state.

### Tree rows

Each row contains:

- Expand or collapse control when children exist.
- Existing deterministic color dot.
- Segment name.
- Derived session count.
- An overflow action button shown on hover or keyboard focus.

Root rows display the `#` prefix. Child rows display only their path segment.
The full path is available in the tooltip.

Clicking a row filters the session tree exactly as today:

- Selecting a leaf includes sessions with that exact tag.
- Selecting a parent includes sessions with the parent or any descendant tag.
- Clicking the selected row again clears the tag filter.
- Date and tag filters continue to combine with logical AND.

### Keyboard behavior

- Up and Down move tree focus.
- Left collapses a node or focuses its parent.
- Right expands a node or focuses its first child.
- Enter applies or clears the filter.
- F2 starts rename.
- Escape cancels inline create or rename.
- The overflow menu is reachable by keyboard.

## Tag Management

### Create

- The Add button creates a root tag.
- A node's overflow menu includes `New child tag`.
- Creation uses an inline input in the target position.
- A new tag is written to the catalog immediately and remains visible with a
  count of zero.
- A segment must match `^[\p{L}\p{N}_-]+$` using Unicode-aware validation.
- Sibling segment names must be unique under the same parent.

### Rename

- Rename is available from the overflow menu and F2.
- Renaming a parent changes the computed paths of all descendants.
- All valid occurrences of the old path and descendant paths are rewritten in
  session documents.
- Markdown headings, fenced code, inline code, escaped text, and plain text that
  merely resembles a tag are not changed.
- The selected tag remains selected by stable catalog ID after rename.

Before committing, the confirmation surface shows the number of affected tags,
sessions, and tag occurrences. Renaming an unused tag does not require a
destructive confirmation.

### Delete

- Delete is available from the overflow menu.
- Deleting a leaf removes that catalog node and all valid document occurrences.
- Deleting a parent removes its entire catalog subtree and all document
  occurrences under that path prefix.
- The confirmation names the deleted subtree and shows affected session and
  occurrence counts.
- If the selected tag is deleted, the tag filter is cleared after commit.
- Cancelling makes no changes.

### Reorder

- Dragging a row shows a precise insertion line before or after a sibling.
- The first version only reorders tags within the same parent.
- Dropping across hierarchy levels is rejected without changing the catalog.
- Expansion, selection, and filtering do not change during reorder.
- The new order is persisted after a successful drop.

Moving a tag to a different parent is deliberately excluded because it changes
the tag path and therefore has the same document-wide consequences as rename.

## Data Model

Introduce a durable flat catalog stored under the session database KV key
`tagCatalog.v1`.

```ts
type TagCatalogV1 = {
  version: 1;
  tags: Array<{
    id: string;
    name: string;
    parentId: string | null;
    order: number;
    createdAt: number;
  }>;
};
```

- `id` is stable across rename and reorder.
- `name` is one path segment, not a full `#parent/child` string.
- `parentId` defines hierarchy.
- `order` is interpreted only among siblings.
- Session counts and full paths are derived and are not persisted.

The catalog belongs in IndexedDB because it is user data. Split preference,
column width, collapsed nodes, and search-independent expansion state are UI
preferences and remain in local storage.

The remote session snapshot must include `tagCatalog.v1` so empty tags and
manual ordering survive cross-device synchronization.

## Catalog Reconciliation

Existing documents remain compatible and no one-time migration is required.

On storage initialization:

1. Load `tagCatalog.v1`.
2. Scan indexed session documents for valid tags.
3. Materialize any missing path segments in the catalog.
4. Preserve all catalog entries, including unused entries.
5. Append newly discovered siblings after all existing siblings in
   normalized Unicode code-point order.
6. Persist the reconciled catalog only when it changed.

Document tags therefore remain discoverable, while the catalog becomes the
source of truth for identity, empty nodes, and display order.

After initialization, a document save that introduces a previously unknown tag
triggers incremental reconciliation for that path. This keeps tags created by
typing directly in a session consistent with tags created from the sidebar.
Reconciliation never removes unused catalog entries.

## Editor Completion

The existing Obsidian tag completion reads `sessions.tagCatalogMem` in addition
to tags discovered in session documents.

- Unused catalog tags are offered immediately after creation.
- Completion inserts the computed full path, such as `#project/zion`.
- Catalog order breaks ties after the existing local-session relevance rules.
- Rename and delete refresh completion data only after the catalog mutation
  commits.

This preserves the current document-based tagging workflow without adding a
separate tag-assignment interface.

## Mutation Safety

Tag rename and delete are multi-document operations and must be atomic from the
user's perspective.

### Preparation

1. Flush the active session's pending editor save.
2. Load the latest text for every potentially affected session.
3. Parse all tag occurrences and build replacement edits.
4. Validate the resulting catalog and all resulting documents.
5. Keep the UI unchanged while the operation is prepared.

The shared Obsidian metadata module should expose a new occurrence API that
returns every valid tag token with exact `from` and `to` offsets. The existing
deduplicated metadata API remains unchanged for current consumers.

### Commit

Use one IndexedDB read-write transaction covering the `docs` and `kv` stores:

- Write all changed document records.
- Write the updated `tagCatalog.v1`.
- Abort the transaction if any write fails.

Only after transaction completion:

- Update in-memory documents and catalog state.
- Refresh the active editor if its document changed.
- Refresh the session sidebar once.
- Schedule one remote snapshot.

If preparation or commit fails, the catalog, documents, filter, and visible
tree remain at their previous values and an actionable error message is shown.
The first version does not add a persistent tag-operation undo history.

Create and reorder only change the catalog but use the same optimistic-state
rollback convention as the existing session tree repository.

## Component Boundaries

Keep the feature inside `dev.session-manager`, with focused modules:

- `model/tag-catalog.js`
  - Catalog validation, hierarchy derivation, reconciliation, and sibling
    ordering.
- `storage/tag-catalog.js`
  - KV persistence and atomic multi-document mutations.
- `features/tag-mutations.js`
  - Rename and delete planning using parsed occurrence ranges.
- `ui/tag-tree.js`
  - Search, tree rendering, inline editing, menus, keyboard navigation, and
    drag reorder.
- `ui/sidebar-view.js`
  - Split versus stacked composition, filtering coordination, heatmap
    placement, and scroll preservation.
- `shared/obsidian-metadata.js`
  - Reusable valid-tag occurrence parsing.
- `src/editor/extensions/obsidian/completion.ts`
  - Catalog-backed completion for unused and manually ordered tags.

The existing session list renderer remains responsible for session rows and
does not learn tag-management behavior.

## State and Events

Use one in-memory catalog state value, `sessions.tagCatalogMem`, populated
during session storage initialization.

Catalog persistence emits `sessions/tagCatalogChanged` after commit. The
sidebar listens to that event and rebuilds only the tag tree and current filter
result. Document mutation continues to use the existing document persistence
and session refresh paths.

UI preference keys:

- `zion.sessions.sidebar.tagSplitEnabled`
- `zion.sessions.sidebar.tagColumnWidth`
- `zion.sessions.sidebar.preTagSplitWidth`

The existing selected date, collapsed tag nodes, and heatmap state keys are
retained.

## Styling

- Reuse Workbench theme variables such as `--panel`, `--bg`, `--border`,
  `--fg`, and `--accent`.
- Keep 30 px Workbench header alignment and existing 25-28 px dense row
  heights.
- Use the repository's icon library for split, add, overflow, chevron, rename,
  and delete actions.
- Use low radius, continuous separators, transparent buttons, and restrained
  selected-row backgrounds.
- Do not introduce cards, nested cards, decorative gradients, or standalone
  color surfaces.
- Text must ellipsize without moving counts or row actions.
- Drag indicators must not change row height or column width.

## Error and Empty States

- An empty catalog shows a compact `No tags` row and the Add action remains
  available.
- A search with no matches shows `No matching tags` without replacing the
  catalog state.
- Duplicate or invalid names keep the inline editor open with a local error.
- Persistence failures restore the previous row order or name.
- Delete and rename controls are disabled while their transaction is running.
- Repeated clicks cannot start overlapping catalog mutations.

## Testing

### Unit tests

- Reconcile legacy document tags into an empty catalog.
- Preserve unused catalog tags.
- Derive stable paths and descendant counts.
- Preserve sibling order and append newly discovered tags deterministically.
- Reconcile a tag introduced by a document save without deleting unused tags.
- Reject invalid and duplicate sibling names.
- Reorder siblings without changing hierarchy.
- Parse every valid tag occurrence while excluding headings, code, and escaped
  text.
- Rename a leaf and a parent with descendants.
- Delete a leaf and a subtree.
- Abort all document and catalog writes when one transaction write fails.

### DOM tests

- Header action toggles split mode and updates `aria-pressed`.
- Enabling split widens the Workbench sidebar and disabling restores its prior
  width.
- Narrow and mobile containers fall back to stacked layout without losing the
  preference.
- Tag selection still composes with date filtering.
- Search preserves ancestors and does not mutate expansion state.
- Inline create and rename support commit and cancel.
- Drag reorder persists sibling order and rejects cross-parent drops.
- Tag-tree rerenders preserve session-list and tag-list scroll positions.
- A newly created empty tag appears in editor completion.

### Browser verification

- Compare the running Workbench at desktop widths of 1280 px and 1440 px.
- Verify split mode with short, long, deeply nested, and empty tag catalogs.
- Verify the 380 px fallback and mobile overlay behavior.
- Verify no text, row actions, heatmap controls, or resize targets overlap.
- Verify outer and inner resize interactions remain responsive.
- Verify light and dark themes use existing Zion Next visual tokens.

## Out of Scope

- A new tag-assignment dialog or drag-to-assign sessions.
- Automatic tag rules.
- Tag colors editable by the user.
- Cross-parent drag reparenting.
- Merge tags as a separate operation.
- A full-screen tag administration page.
- Persistent undo history for tag mutations.

These can be added later without changing the split layout or catalog identity
model.

## References

- Feishu message groups:
  https://www.feishu.cn/hc/zh-CN/articles/212254138442
- Feishu custom conversation tags:
  https://www.feishu.cn/hc/zh-CN/articles/452595803899
- Slack customized sidebar sections:
  https://slack.com/help/articles/360043207674
- Obsidian Tag Wrangler:
  https://github.com/pjeby/tag-wrangler
