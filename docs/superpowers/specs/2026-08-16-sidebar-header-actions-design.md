# Sidebar Header Actions Design

## Goal

Reduce Sidebar header chrome and make each icon match its action.

## Behavior

- Workbench keeps a shared hide-Sidebar action for views that use the default
  chrome, but changes its icon from `x` to `columns-2`.
- Sidebar views can opt out of the shared hide action through
  `showHideAction: false`; the default remains enabled.
- The sessions view opts out of the shared hide action.
- The sessions view removes its three-dot actions menu.
- The sessions view keeps its new-session action.
- The sessions tag-column toggle changes from `columns-2` to `list-tree`.

The shared hide action keeps its current click behavior, tooltip, and accessible
name. No plugin implements a duplicate hide action.

## Architecture

Add the optional `showHideAction` property to the Sidebar view contract in the
runtime and public Zion type declarations. Workbench conditionally appends its
shared hide button based on the active view. The sessions plugin configures the
property and trims its own header actions.

## Verification

Tests cover the default shared hide action, its `columns-2` icon, session-style
opt-out, and the reduced sessions header action configuration. Browser
verification checks sessions and another plugin Sidebar.
