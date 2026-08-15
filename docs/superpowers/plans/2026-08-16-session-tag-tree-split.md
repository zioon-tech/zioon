# Session Sidebar Tag Tree Split — Implementation Record

Status: implemented on `feature/tag-tree-panel` (base `bb0f9ef0`).
Spec: `docs/superpowers/specs/2026-08-16-session-tag-tree-split-design.md`

## Delivered

- [x] `model/tag-catalog.js` — pure catalog: normalize/validate, reconcile with
  scanned tags, hierarchical tree with per-node session counts, add/rename/
  delete/reorder mutations (order is fractional per-sibling).
- [x] `features/tag-mutations.js` — inline tag occurrence scanner (skips
  fences/inline code/headings), rename rewrite (incl. descendants), delete
  removal with adjacent-space swallow, impact preview.
- [x] `storage/tag-catalog.js` — catalog persisted in Sessions IDB kv
  (`sessions.tagCatalog`) with validation on load/save.
- [x] `ui/tag-tree.js` — left-column panel: search (ancestors kept), selection
  (optimistic, click-again clears), inline create/rename, delete confirm row,
  same-parent drag reorder, keyboard nav (arrows/Enter/F2/Escape), overflow
  menu.
- [x] `ui/sidebar-view.js` — split layout mode: left tag column (persisted
  width 140–260, draggable divider), right column keeps session list + day
  panel/heatmap; auto-widen outer sidebar to ≥440 on enable with restore on
  disable; <380 px fallback to stacked layout via ResizeObserver; stacked tag
  strip hidden in split mode.
- [x] `main.js` — header quick action (`sessions.tagSplit`,
  `$(layout-sidebar-left)`), command `zion.sessions.toggleTagSplit`,
  injected doc read/write (`getAllSessionDocs`/`writeSessionDoc`).

## Tests (all green; repo pre-existing failures unchanged)

- `tests/session-tag-catalog.test.js`
- `tests/session-tag-mutations.test.js`
- `tests/session-tag-tree.test.js`
- `tests/session-sidebar-tag-split.test.js`

## Deferred

- Editor `#`-tag completion sourced from the catalog.
- Settings-panel entry for the split toggle (header button + command cover it).
- Cross-parent drag reparenting, tag merge.
