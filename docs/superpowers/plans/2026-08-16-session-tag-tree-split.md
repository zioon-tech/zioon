# Session Sidebar Tag Tree Split — Implementation Record

Status: implemented on `feature/tag-tree-panel` (base `bb0f9ef0`).
Spec: `docs/superpowers/specs/2026-08-16-session-tag-tree-split-design.md`

## Delivered

- [x] `model/tag-catalog.js` — pure catalog: normalize/validate, reconcile with
  scanned tags, hierarchical tree with per-node session counts, add/rename/
  delete/reorder mutations (order is fractional per-sibling), pinned flag with
  pinned-first sibling sorting + `setCatalogEntryPinned`.
- [x] `features/tag-mutations.js` — inline tag occurrence scanner (skips
  fences/inline code/headings), rename rewrite (incl. descendants), delete
  removal with adjacent-space swallow, impact preview.
- [x] `storage/tag-catalog.js` — catalog persisted in Sessions IDB kv
  (`sessions.tagCatalog`) with validation on load/save.
- [x] `ui/tag-tree.js` — left-column panel: search (ancestors kept), selection
  (optimistic, click-again clears), inline create/rename, delete confirm row
  (leaf vs subtree copy), keyboard nav (arrows/Enter/F2/Escape), overflow
  menu (add child / rename / pin / delete). Three-zone drag & drop
  (before / after / inside à la Flowix): insert-line visuals for before/
  after, highlight for inside, cross-parent reparent through the same
  doc-rewrite path as rename, own-subtree drops rejected, collapsed drop
  targets auto-expand.
- [x] `ui/sidebar-view.js` — split layout mode: left tag column (persisted
  width 140–260, draggable divider), right column keeps session list + day
  panel/heatmap; auto-widen outer sidebar to ≥440 on enable with restore on
  disable; <380 px fallback to stacked layout via ResizeObserver; stacked tag
  strip hidden in split mode. `handleTagPin` (promotes ephemeral entry then
  toggles) and `handleTagReparent` (reuses rename rewrite + selected-tag
  rebase).
- [x] `main.js` — header quick action (`sessions.tagSplit`,
  `$(layout-sidebar-left)`), command `zion.sessions.toggleTagSplit`,
  injected doc read/write (`getAllSessionDocs`/`writeSessionDoc`).

## Tests (all green; repo pre-existing failures unchanged)

- `tests/session-tag-catalog.test.js` (incl. pinned sort/toggle)
- `tests/session-tag-mutations.test.js`
- `tests/session-tag-tree.test.js` (incl. inside-drop reparent, subtree-drop
  rejection, same-parent-only before/after, pin menu, pinned indicator,
  leaf-vs-subtree delete copy)
- `tests/session-sidebar-tag-split.test.js`

## Deferred

- Editor `#`-tag completion sourced from the catalog.
- Settings-panel entry for the split toggle (header button + command cover it).
- Batch delete mode; custom drag ghost (native HTML5 DnD ghost retained).
