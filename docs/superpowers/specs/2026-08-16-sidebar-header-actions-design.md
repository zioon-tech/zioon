# Sidebar Header Actions Design

## Goal

Reduce Sidebar header chrome and make each icon match its action.

## Behavior

- Workbench keeps a shared hide-Sidebar action for every Sidebar and uses the
  `columns-2` icon instead of `x`.
- The sessions view removes its three-dot actions menu.
- The sessions tag-column toggle uses the existing `tag` icon.
- The sessions view removes its new-session action.
- The sessions action order is `tag`, then the shared `columns-2` button at the
  far right.
- Main editor tab bars replace their plain `plus` new-session icon with
  Lucide's `message-circle-plus`.

The shared hide action keeps its current click behavior, tooltip, and accessible
name. No plugin implements a duplicate hide action.

## Architecture

Workbench remains the owner of the shared hide action and appends it after
plugin-provided actions. The sessions view no longer opts out. The shared icon
registry adds Lucide's `message-circle-plus`, and all editor tab-bar variants
use it for their existing new-session command.

## Verification

Tests cover the shared hide action and its `columns-2` icon. Icon tests cover
`message-circle-plus`. Browser verification checks that sessions renders
`tag` and `columns-2`, while the editor tab bar renders
`message-circle-plus`.
