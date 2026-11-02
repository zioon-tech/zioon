# Session Tag Exclusions

## Goal

Let users suppress false-positive `#tag` extraction without editing conversation text. The Sessions tag tree supports confirmed bulk exclusion, while the Context Panel supports precise exclusion and restoration for the current session.

## Data Model

Document tag exclusions live in each persisted `sessions.tagIndex` entry:

```js
{
  hash: "document-hash",
  tags: ["project/zion", "project/zion/ui"],
  exclusions: [
    { path: "project/zion", subtree: false },
    { path: "topic/generated", subtree: true }
  ]
}
```

An exact rule matches only its path. A subtree rule matches its path and every descendant. Document re-indexing preserves exclusions. Biography-derived tags are not filtered because their source is not the document index.

Session Manager owns persistence and exposes commands to exclude, restore, inspect, and bulk-exclude document tags. Context Panel uses those public commands and subscribes to `sessions.tagIndex`; it does not own a second exclusion store.

## Interactions

### Context Panel

- Extracted visible tags retain click-to-source behavior.
- Hover reveals an ignore icon. Activating it excludes that exact tag from the current session immediately.
- The Tags group includes an `Ignored` child group when exclusions match extracted tags.
- Ignored rows show the tag and a restore icon. Restoring removes the corresponding rule.
- A notification confirms ignore or restore. No confirmation is required because the scope is one session and restoration is adjacent.

### Sessions Tag Tree

- A document-backed row context menu includes `Ignore in matching sessions`.
- Biography-only rows do not offer exclusion.
- Activating the command opens an inline confirmation below the row.
- The confirmation states the number of affected sessions and concrete extracted tags. The operation includes the selected path and all descendants.
- Confirmation adds one subtree rule to every currently matching session. Cancellation changes nothing.
- If the selected row is also Biography-derived, only document-backed matches are affected; Biography tags remain visible.

## State and Failure Handling

- Every mutation publishes a new `sessions.tagIndex` object before asynchronous persistence, so both panels update immediately.
- Persistence failures keep the in-memory result for the page and show an error notification.
- Invalid rules are dropped during index validation.
- Removing a session removes its exclusions with the index entry.

## Verification

- Pure model tests cover exact/subtree matching, validation, update preservation, bulk impact calculation, exclusion, and restoration.
- Tag-tree tests cover the menu, affected counts, confirmation, cancellation, and Biography-only behavior.
- Context Panel tests cover visible/ignored partitioning plus command payloads.
- Browser verification covers both surfaces against a real session and confirms that reloading preserves exclusions.
