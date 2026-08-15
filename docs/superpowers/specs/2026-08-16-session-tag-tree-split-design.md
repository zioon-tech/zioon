# Session Sidebar Tag Tree Split (Redesign)

## Status

Redesign of the 2026-08-15 tag-split concept. Previous layout/interaction rejected;
data-layer direction retained. Implemented in `.worktrees/tag-tree-panel`
(branch `feature/tag-tree-panel`, base `bb0f9ef0`).

## Goal

When the tag collection grows, the horizontal tag strip inside the Sessions
sidebar stops scaling. Add an opt-in internal two-column layout for the
Sessions sidebar:

- Left column: a hierarchical tag tree (full height), with management
  (create / rename / delete / reorder, empty manual tags persist).
- Right column: the existing session list, with the day/heatmap panel at its
  bottom (unchanged behavior).
- Selecting a tag node filters the session list exactly as the existing tag
  strip does (parent node includes descendants).

This is entirely internal to the `dev.session-manager` Sessions view. No
Workbench-level layout changes; other sidebars are unaffected.

## Decisions (approved by user)

1. **Form**: internal left column inside the Sessions sidebar (not a new
   Workbench panel).
2. **Heatmap/day panel**: stays at the bottom of the right column with the
   session list; the left column is 100% tag tree.
3. **Outer width**: enabling split auto-widens the outer sidebar to >= 440 px
   (remembering the pre-split width); disabling restores it. Manual resizes
   during split mode are kept but never overwrite the restore width.

Additional defaults (owner decision, user iterates later):

- Toggle: header quick-action button on the Sessions view
  (`layout-sidebar-left` icon) + command `zion.sessions.toggleTagSplit`.
  Preference persisted in localStorage (`zion.sessions.sidebar.tagSplit`).
- Fallback: if the sidebar body width < 380 px (or medium/mobile workbench
  mode), render the existing stacked layout regardless of preference; restore
  split automatically when width allows.
- Tag data: documents keep Obsidian-style `#parent/child` text. A normalized
  catalog (stable entries, sibling order, manual flag) lives in the existing
  Sessions IndexedDB `kv` store under `sessions.tagCatalog`. Scanned tags not
  present in the catalog are merged in as ephemeral nodes (sorted after
  ordered catalog entries).
- Tag assignment workflow: unchanged (tags are edited as text in documents);
  no new assignment dialog in v1.

## Layout

```text
+------------------------------------------------------------+
| SESSIONS                              [new] [split] [...]   |
+------------------+-----------------------------------------+
| TAGS         [+] | SESSION LIST                            |
| [Search tags...] |                                         |
| v #project     8 |   (existing renderer, existing filters) |
|     zion       5 |                                         |
|     agent      3 |                                         |
|   #research     2 |                                         |
|                  +-----------------------------------------+
|                  | ACTIVITY / heatmap (right column bottom) |
+------------------+-----------------------------------------+
```

- Left column default 180 px, drag-divider persisted, min 140 / max 260.
- Right column min 220 px (divider clamps).
- 1 px separator, no cards/floating surfaces; transparent controls.

## Tag column behavior

- Header: `Tags` label + node count + add button; below it a compact
  case-insensitive search that keeps ancestors of matches visible without
  changing selection or expansion state.
- Row: expand chevron (if children), deterministic color dot, segment name,
  derived session count, hover overflow menu (rename / delete / add child).
- Root rows show `#`; child rows show the last path segment; tooltip has the
  full path.
- Click row: set/clear tag filter (click selected row again clears). Date and
  tag filters AND together as today.
- Empty manual tags persist (count 0). Scanned tags with 0 sessions after
  doc edits disappear (ephemeral).
- Rename rewrites tag occurrences across all session documents (and updates
  open editors + catalog). Delete removes catalog entry and strips tag
  occurrences from documents, with a confirm step stating affected session
  count. Drag reorder within the same parent updates catalog sibling order.
- Keyboard: Up/Down move, Left/Right collapse/expand, Enter applies/clears,
  F2 rename, Escape cancels.

## Persistence & sync

- Catalog entry: `{ id, path, order, manual }`; id = `tag:<path>`.
- Reconcile on sidebar render: catalog paths ∪ scanned paths; children sorted
  by catalog order first, then alphabetically for ephemeral nodes.
- Mutations are optimistic: apply to in-memory catalog, render, then persist
  catalog + rewritten docs via the existing IDB helpers; on failure, revert
  catalog state and log.

## Out of scope (v1)

- Tag assignment dialog / rules; cross-parent drag reparenting; tag merge;
  editable colors; editor `#`-completion from catalog (candidate follow-up).
