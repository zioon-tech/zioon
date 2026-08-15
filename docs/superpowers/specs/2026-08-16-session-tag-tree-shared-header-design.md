# Session Tag Tree Shared Header

## Status

Approved on 2026-08-16. This document refines the header integration in
`2026-08-16-session-tag-tree-split-design.md`. It supersedes that document's
assumption that the split requires no Workbench-level change.

## Goal

When the Sessions sidebar is actually rendered in two-column mode, its top
header must also be two columns:

- Left: `全部标签`, tag count, and the add-tag action.
- Right: `会话` and the existing Sessions header actions.

Both sections use the existing Workbench sidebar-header height and typography.
The vertical separator starts at the top header and continues through the
content. When split mode is inactive or cannot fit, the sidebar returns to the
normal single `会话` header.

## Rejected Approaches

1. Giving the plugin the entire header would duplicate Workbench behavior such
   as title translation, actions, and the hide button.
2. Pulling the content upward with a negative margin is structurally fragile.
   The Workbench always keeps a tabs element between its header and content,
   and an overlay can obscure native title/actions.
3. Moving host DOM nodes from plugin code would couple the extension to private
   Workbench markup and lifecycle.

## Workbench Contract

Extend `SideBarView` with an optional leading-header component:

```ts
headerLeading?: {
  render(
    container: HTMLElement,
    context: {
      setVisible(visible: boolean): void;
      setWidth(px: number): void;
    }
  ): { dispose?: () => void } | void;
};
```

The Workbench sidebar header contains two owned regions:

```text
.zion-sidebar-header
  .zion-sidebar-header-leading
  .zion-sidebar-header-main
    .zion-sidebar-title
    .zion-sidebar-actions
```

Workbench remains responsible for the right-side title, registered actions,
and hide action. It mounts the active view's leading component before mounting
that view's content, then disposes the component when the active view changes.
`setVisible(false)` restores the standard single-region header without
changing header height. `setWidth(px)` updates a scoped CSS custom property;
Workbench clamps invalid values and leaves the right region at
`minmax(0, 1fr)`.

Views without `headerLeading` retain the current DOM behavior and appearance.

## Sessions Integration

The Sessions view registers `headerLeading`. Its renderer creates the title,
live node count, and add button using the existing localization and icon
helpers.

The sidebar manager publishes a small header snapshot whenever split layout,
tag data, or divider width changes:

```ts
{
  visible: appliedSplitMode === "split",
  width: tagColumnWidth,
  nodeCount: number
}
```

The header renderer attaches a bridge to the sidebar manager and applies each
snapshot through the Workbench context. Split layout is eligible only while
that bridge is attached. Clicking the add button calls the mounted tag tree's
root-create operation through the bridge. The tag tree exposes that operation
as a method; persistence and validation remain owned by the existing tag-tree
manager.

The split tag tree no longer renders its internal title/count/add row. Search
is the first row inside the left content column. The stacked tags section is
unchanged.

## Geometry

- Header height: unchanged Workbench `.zion-sidebar-header` height.
- Leading-header width: exactly the persisted `tagColumnWidth`.
- Separator: one visible 1 px line at the same x-coordinate in header and
  content, with a 7 px transparent drag hit target in content.
- Right side: retains the Workbench title and all existing actions.
- Narrow fallback: if body width is below `TAG_SPLIT_BODY_MIN`, leading header
  is hidden and the standard stacked Sessions layout is rendered.
- Resizing: divider drag updates the content column and leading-header width in
  the same animation frame; only the final width is persisted.

No negative margin, z-index overlay, host-header measurement, or private DOM
query is used.

## Lifecycle And Failure Handling

- Header-leading state is scoped to the active view and disposed on view
  switch or plugin disposal.
- Attaching or detaching the header bridge immediately recomputes the applied
  layout. A missing or failed bridge therefore produces stacked content.
- A split preference does not imply a visible leading header; visibility
  follows the applied responsive layout.
- If the leading component fails to render, Workbench keeps the standard
  single header. Sessions falls back to stacked content rather than showing a
  split whose header cannot align.
- Header updates are idempotent so sidebar rerenders and resize notifications
  do not duplicate controls or listeners.

## Verification

1. Workbench tests cover an ordinary view, a view with a visible leading
   header, dynamic width/visibility changes, view switching, and disposal.
2. Sessions split tests cover the visible header snapshot, node-count updates,
   divider-width synchronization, add-tag delegation, and narrow fallback.
3. Existing session tag filtering, persistence, and stacked-layout tests
   remain green.
4. Desktop screenshots verify that `全部标签` and `会话` share one top row and
   that the header/content separator is continuous. A narrow screenshot
   verifies restoration of the ordinary `会话` header.

## Out Of Scope

- General multi-row or fully custom sidebar headers.
- Changes to Auxiliary Bar or Bottom Panel headers.
- Changes to tag data, filtering, or persistence.
