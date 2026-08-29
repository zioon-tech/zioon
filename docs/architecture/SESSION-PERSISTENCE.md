# Session persistence

## Source of truth

Session documents, metadata, tree structure, index, and tag state are stored by
`zion-local-tools` in SQLite. Browser memory is only the active runtime view.
IndexedDB is not a session persistence target.

A save is durable only after the `/app-sessions` API returns successfully after
the SQLite transaction commits. Failed writes remain queued in memory and the
UI state stays marked as pending.

## Browser storage migration

On startup, Session Manager performs a read-only scan of the legacy
`zion.sessions.db` database and the old localStorage session keys.

The candidate data is sent to `/app-sessions/migrate-browser-storage`:

- Records missing from SQLite are imported.
- Records identical to SQLite are verified and skipped.
- Conflicting browser records are archived as recoverable revisions.
- Existing SQLite records are never overwritten by migration.
- Tombstoned records are not silently resurrected.

After the backend confirms that every candidate was imported, archived, or
verified, Session Manager clears only the `docs`, `metas`, and session-owned KV
records. The shared comments KV records are left untouched.

## Recovery

SQLite keeps:

- A current document and metadata row for each session.
- Up to 20 compressed revisions per session.
- Explicit tombstones for deletions.
- Idempotency records for retried operations.
- Up to 14 periodic SQLite backups.

Revision listing and restore are exposed through:

- `GET /app-sessions/{session_id}/revisions`
- `POST /app-sessions/{session_id}/restore`

## Failure behavior

If `zion-local-tools` is unavailable during startup, Session Manager does not
fall back to browser storage and does not enable editing with a false saved
state. During an active session, failed writes stay queued and are retried.
Page hiding and session switching trigger an immediate flush.
