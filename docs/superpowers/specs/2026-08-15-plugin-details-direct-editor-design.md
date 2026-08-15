# Plugin Details Direct Editor Interaction

## Goal

Make plugin management direct and predictable. Selecting a plugin in the Plugins sidebar opens its full details in the main editor area without an intermediate Inspector view.

## Considered Approaches

1. Inspector first, then full details: preserves the current editor context but adds an unnecessary navigation step for a dedicated management workflow.
2. Hybrid single-click Inspector and double-click editor: exposes both surfaces but makes click behavior harder to discover and duplicates the same information.
3. Direct editor details: a single click opens or focuses the complete plugin details tab. This is the selected approach because the Plugins sidebar is already an explicit management context.

## Interaction Design

- Clicking a plugin row opens its details with `openFileTab`.
- If that plugin detail tab already exists, the same action focuses and refreshes it instead of creating another tab.
- Pressing Enter or Space on a focused plugin row performs the same action.
- Double-click has no separate behavior.
- Clicking the enable toggle only changes plugin state and never opens the detail tab.
- Plugin detail content is no longer opened or refreshed through the Inspector.
- The list selection follows the most recently opened plugin detail from this sidebar.

## Implementation Boundaries

- Remove the plugin manager's `renderPluginInspector` import and `openPluginInspector` path.
- Keep `renderPluginEditor` and the existing `file:plugin-detail:<plugin-id>` tab identity.
- Keep plugin detail data models, manifest presentation metadata, status handling, reload actions, and responsive editor layout unchanged.
- Keep Inspector infrastructure available to other features; only plugin details stop using it.
- When plugin state changes, refresh an existing editor detail tab without forcing focus.

## Error Handling

- If `openFileTab` is unavailable, return `false` without changing list selection.
- Enable, disable, reload, and command errors continue to use the existing plugin manager message surface.
- Toggle failures restore the prior checked state and do not trigger navigation.

## Verification

- Add or update tests to prove a row click and keyboard activation call the editor tab path.
- Verify toggle click propagation remains stopped.
- Verify repeated activation reuses the stable detail tab ID.
- Run the plugin details and plugin manager state tests.
- Verify in the browser that a single click opens the editor detail directly and does not open the Inspector.
