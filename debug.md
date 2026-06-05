# Debug Session: Editor Scrolls After App Switch

Status: [OPEN]

## Symptom

Switching away from the editor to another app and then switching back causes the editor content to scroll upward slightly, regardless of whether WYSIWYG is enabled.

## Initial Hypotheses

1. Window refocus triggers editor/preview scroll synchronization and recalculates `scrollTop`.
2. Focus/blur restoration reveals the current selection and causes a small scroll adjustment.
3. WYSIWYG and non-WYSIWYG modes share a container resize/layout path that misdetects height on app return.
4. Comments/overview rail or adjacent UI extensions trigger layout on `visibilitychange`/`focus`.
5. Browser scroll anchoring adjusts the editor scroll position after DOM updates during focus restoration.

## Instrumentation Plan

- Locate focus, visibility, scroll sync, editor layout, and WYSIWYG toggle paths.
- Add minimal debug-point network logs only, without changing business logic.
- Ask the user to reproduce and collect logs before any fix.

## Instrumentation Added

- `src/editor/EditorCore.ts`: logs window focus/blur/visibilitychange, CodeMirror focus/blur/scroll, and update listener transaction/layout state.
- `extensions/dev.comments/main.js`: logs comments visibility/focus recovery, annotation restore decisions, and `revealThreadAnchor` scrollIntoView dispatches.
- `extensions/dev.thinking/thinking-cards.js`: logs thinking-card visibility/focus recovery and restore decisions.

## Verification

- `npm run build`: passed.
- IDE diagnostics show an existing eslint parser configuration issue: missing `tsconfigRootDir` when both the worktree and parent repo tsconfigs are present.
- `npm run typecheck`: unavailable in `package.json`.

## Evidence

- Pre-fix reproduction collected 336 events.
- On app return, `window focus` and `CodeMirror DOM focus` saw `scrollTop=1174`.
- About 80 ms later, CodeMirror emitted `geometryChanged=true` updates with no `docChanged`, no `selectionSet`, and no transaction `scrollIntoView`.
- During those geometry updates, `scrollHeight` temporarily changed `3173 -> 3157 -> 3159 -> 3173`.
- Immediately after the geometry fluctuation, `scrollTop` changed `1174 -> 1200` (`delta=+26`), which matches the perceived content moving upward.
- `thinking checkAndRestoreWidgets` and `comments restoreActiveThreadCards` ran after the scroll jump and did not restore missing widgets, so they are unlikely to be the direct trigger.

## Fix Attempt

- Added `overflow-anchor: none` to `.cm-editor .cm-scroller` to prevent browser scroll anchoring from compensating transient CodeMirror DOM height changes during focus restoration.
- Switched instrumentation run id to `post-fix` for comparison.
- Post-fix logs showed the same focus-return geometry path remained, but the drift was smaller (`317 -> 319`, and some transient internal `404 -> 412` readings).
- Added a narrow focus-return scroll guard in `EditorCore`: for 260 ms after window focus/visible, restore small geometry-only scroll drift when there is no document change, selection change, or `scrollIntoView` transaction.
- Added inline-widget snapshots to editor focus/scroll/update logs: row counts, visible row counts, total/visible widget heights, thinking/tool inline/card counts, and sample visible row classes.

## Inline Widget Evidence

- Latest reproduction around `1780417227017-1780417227121` confirms inline widgets participate in the geometry fluctuation.
- At focus, the editor had 36 inline widget rows, visible height 312, total height 936 (`15` thinking inline + `21` tool inline).
- During CodeMirror focus-return `geometryChanged`, DOM snapshots temporarily saw thinking-only rows (`15`, visible height `130`), then tool-only rows (`21`, visible height `182`), then the full set (`36`, visible height `312`).
- In the same sequence, `scrollHeight` changed `3270 -> 3214 -> 3226 -> 3256`, and the browser/CodeMirror attempted `scrollTop 2061 -> 2109`.
- The focus-return guard restored it back to `2061`, so the symptom is mitigated, but inline-widget redraw/measurement is a real contributor to the remaining occasional drift/flicker.
- Later reproduction around `1780417511130-1780417511221`: focus started at `scrollTop=2337` with 17 inline widget rows (`7` thinking + `10` tool), then geometry updates temporarily saw thinking-only rows and tool-only rows. `scrollHeight` changed `3270 -> 3200 -> 3206 -> 3220`, and the guard restored attempted drift `2365 -> 2337` (`topDelta=28`).
- Recent larger guard hits show repeated `topDelta=68` cases with 38 inline widget rows (`16` thinking + `22` tool), again during focus-return geometry updates.

## Inline Widget Fix Attempt

- `extensions/dev.thinking/thinking-cards.js`: added a `StateField.update` no-op fast path. If there is no `docChanged` and no thinking-card effect, return the existing decoration set unchanged.
- `extensions/dev.tools/tool-calls.js`: added the same no-op fast path for tool-card effects.
- Rationale: CodeMirror best practice is to keep `DecorationSet` identity stable for transactions that do not semantically affect that extension. Rebuilding line decorations during focus/geometry transactions caused DOM churn and the observed thinking-only/tool-only intermediate layout.
- Verification: `npm run build` passed.
- Follow-up evidence showed focus/geometry redraw can still expose thinking-only/tool-only intermediate DOM even with the fast path, likely because tool and thinking decorations are provided by separate facets and land in separate redraw phases.
- Added a core `inlineWidgetAnchorLineField` in `EditorCore` that marks all semantic inline-widget source lines (`调用 ...` and `思考`) from the document itself. This stable line decoration is independent of tool/thinking widget lifecycle.
- Added CSS for `.zion-inline-widget-anchor-row` with the same flex layout and `min-height: 26px`, so source lines keep widget-row height even if a specific widget decoration briefly disappears during focus redraw.
- Verification: `npm run build` passed after this follow-up fix.

## Unified Inline Widget Source

- Long-term fix: added `src/editor/inlineWidgets.ts` with one editor-owned inline-widget decoration layer.
- `inlineWidgetSourceFacet` lets feature plugins register semantic decoration sources, while `inlineWidgetDecorationsExtension()` is the only `EditorView.decorations` provider for inline widgets.
- Moved stable anchor-row decorations (`调用 ...` and `思考`) into the unified layer and removed the temporary `inlineWidgetAnchorLineField` from `EditorCore`.
- Migrated `extensions/dev.tools/tool-calls.js`: `toolInlineField` now only stores tool item state; `buildToolDecorations()` is registered as a source and builds line/replace/card decorations through the unified layer.
- Migrated `extensions/dev.thinking/thinking-cards.js`: `thinkingField` now only stores thinking item state; `buildThinkingDecorations()` is registered as a source and builds line/replace/card decorations through the unified layer.
- The unified layer sorts the combined decorations before creating the `DecorationSet`; this is required because line decorations and replace widgets from multiple sources may arrive out of range order.
- The unified layer skips recomputation for pure focus/selection transactions with no document change and no effects, reducing focus-return decoration churn.
- Verification: `npm run build` passed; `npx vitest run tests/chat-cards-dom.test.ts` passed (`7` tests).

## Decisions

- No business logic changes before runtime evidence.
