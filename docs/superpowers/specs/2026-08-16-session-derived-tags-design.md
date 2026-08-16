# Session Derived Tags

## Goal

Show Biography-generated project and topic labels in the Sessions tag tree without direct plugin calls, while removing the need to rescan every session document after reload.

## Architecture

`dev.identity` remains the owner of Biography events. It projects those events into the shared `sessions.derivedTags` state key using a provider-neutral schema:

```js
{
  biography: {
    id: "biography",
    label: "Biography",
    readOnly: true,
    sessions: {
      "<session-id>": [
        { path: "project/<name>", kind: "project" },
        { path: "topic/<name>", kind: "topic" }
      ]
    }
  }
}
```

Session Manager subscribes to the shared key and merges all providers with its own document tags. It does not execute Identity commands or read Biography files.

Document tags are stored in a derived IndexedDB index keyed by session ID and document hash. Saves update one index entry. On first use after upgrade, an idle background migration scans the existing document store once and persists the result. Later reloads read the compact index only.

## UI Behavior

- Derived tags use the same hierarchy, counts, search, selection, and session filtering as document tags.
- A compact `自动` marker identifies rows containing a derived source; its tooltip names the provider.
- Rows containing a derived source are read-only: no rename, delete, pin, reparent, reorder, or child creation.
- Right-click shows source information instead of mutation actions.
- Document-only and manually created tags retain all existing behavior.

## Failure Handling

- A missing or malformed provider projection is ignored.
- Biography loading failure leaves document tags usable.
- A missing or stale document index triggers background reconstruction without blocking sidebar mount.
- Index persistence failure falls back to the current in-memory projection for the running page.

## Verification

- Pure tests cover projection normalization, provider merging, source propagation, and index validation.
- Identity tests cover initial publication and refresh after a Biography update.
- Session sidebar tests cover automatic markers, filtering, and read-only interaction.
- Reload behavior is verified by ensuring sidebar rendering reads the compact index instead of session documents.
