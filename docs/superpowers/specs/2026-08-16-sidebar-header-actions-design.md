# Sidebar Header Actions Design

## Goal

Reduce Sidebar header chrome and make each icon match its action.

## Behavior

- Workbench keeps a shared hide-Sidebar action for every Sidebar and uses the
  `columns-2` icon instead of `x`.
- The sessions view removes its three-dot actions menu.
- The sessions tag-column toggle uses the existing `tag` icon.
- The sessions new-session action uses a new `message-square-plus` icon.
- The sessions action order is `tag`, `message-square-plus`, then the shared
  `columns-2` button at the far right.

The shared hide action keeps its current click behavior, tooltip, and accessible
name. No plugin implements a duplicate hide action.

## Architecture

Workbench remains the single owner of the hide action and always appends it
after plugin-provided actions. The unused `showHideAction` opt-out is removed
from the runtime and public Zion type declarations. The shared icon registry
adds `message-square-plus`, and the sessions plugin only selects icon names for
its two actions.

## Verification

Tests cover the shared hide action and its `columns-2` icon. Icon tests cover
`message-square-plus`. Browser verification checks that sessions renders
`tag`, `message-square-plus`, and `columns-2` in that order.
