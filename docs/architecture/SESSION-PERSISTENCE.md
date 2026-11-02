# Session persistence

## Source of truth

Session documents, metadata, tree structure, index, and tag state are stored by
Zion Runtime in the configured Runtime Store. PostgreSQL is authoritative in
account deployments; PostgreSQL is the local/offline adapter. Browser memory is only
the active view.
The Yjs IndexedDB database is an offline replica for collaborative text, not a
Session source of truth. The Runtime Store remains authoritative for both the
encoded Yjs state and its plain-text Session projection.

An HTTP save is durable only after the `/v1/workbench-state` API returns
successfully after the Runtime database transaction commits. Failed HTTP writes
remain queued in memory and the UI state stays marked as pending. Collaborative
updates are batched by Hocuspocus and become durable when Runtime's store hook
commits the encoded state and text projection.

## Realtime discovery

Every committed Session, tree, KV, document checkpoint, and Run lifecycle
mutation is written to `runtime_workbench_events` with a monotonically
increasing sequence. Individual Yjs updates are not copied into this feed. A
client:

1. reads `/v1/workbench-state/snapshot` and remembers `event_cursor`;
2. subscribes to `/v1/workbench-state/events/stream` from that cursor;
3. applies lightweight invalidation and Run lifecycle events;
4. reconnects with `Last-Event-ID` or `after`;
5. reloads the snapshot when Runtime sends `reset` for an expired cursor.

The JSON catch-up endpoint is
`GET /v1/workbench-state/events?after={sequence}`. The event log retains the
latest 50,000 events. The 30-second snapshot check remains a compatibility
fallback, not the normal synchronization path.

## Collaborative document

The editable Session body is a Yjs document served through Hocuspocus at
`WS /v1/collaboration`:

```text
Y.Doc(sessionId)
├── Y.Text("content")
├── Y.Map("annotations")
├── Y.Map("blocks")
└── Y.Map("runs")
```

Runtime stores the encoded state in `runtime_collaboration_documents` and
updates the ordinary Session document in the same outer database transaction.
Concurrent Workbench edits therefore converge through CRDT updates rather than
whole-document last-write-wins saves. Non-CRDT Session and metadata writes still
use `expected_session_revision`.

In-flight model output is not collaborative document state. Runtime exposes a
coalesced Run projection stream; Workbench renders it as a temporary CodeMirror
decoration, Mobile can render it as a normal message, and CLI writes it to
stdout. Runtime Core delegates document mutation to a registered Document
Projector. The `dev.session-manager` Runtime plugin owns Workbench role-line
syntax and commits the final assistant block to Yjs on `message.completed` or
terminal Run state. A Workbench may detach or reload without becoming the sole
persistence owner.

For a Session-bound Run, Workbench sends its trigger location as a Yjs
`RelativePosition` and a bounded, context-checked offset fallback. The Session
Manager projector inserts the submitted user content and the Run's assistant
anchor there with incremental operations. A disconnected Workbench must not
fall back to token-level whole-document writes.
`message.completed.content`, rather than the Run's aggregate output, defines
the final visible assistant block.

Empty `user ` prompts are local Workbench interaction state and are not
persisted into Yjs. For an arbitrary-position Run with following content, the
Session Manager projector inserts an invisible continuation boundary. This
keeps the following text in its original user-side segment without exposing a
second visible role chip. Workbench never performs a competing terminal
document mutation.

All split Workbench views for one Session share one Y.Doc/provider. The legacy
`SessionSync` path skips Yjs-bound views, so one edit is not replayed through a
second synchronization mechanism. Thinking and tool markers have one document
writer; observer clients retain card metadata but render only after the marker
arrives through Yjs.

Hocuspocus persistence does not publish one durable event per CRDT update.
After an editing burst settles, Runtime publishes one
`document.checkpointed` event so non-Yjs clients can invalidate their snapshot.

## Canonical transcript

Runtime stores each Run's assistant messages, reasoning content, tool calls,
and full tool results in `runtime_run_transcript`, keyed by
`(run_id, turn, ordinal)`. Replayed Attempts replace the same logical turn entry
instead of duplicating it. User `text/image_url` content parts remain structured
through model invocation and Session reconstruction.

Workbench document state and canonical Agent history are separate models that
normally share the same Session ID. On the first Runtime Run for an existing
Workbench Session, the client sends the unmodified conversation as
`sessionHistory`. Runtime stores all entries before the current user message in
`runtime_session_seed_transcript`. The seed is immutable and idempotent, and is
copied when the Session is forked. Messages added by Workbench Context
Contributors are sent only in `messages` and are not persisted as seed history.

`GET /v1/sessions/{session_id}/transcript` reconstructs canonical model history
from user messages and completed Run transcript entries. New Runs use this
history directly. `GET /v1/sessions/{session_id}/messages` remains the
backward-compatible user/assistant text projection used by existing Workbench
views. A single Run transcript is available at
`GET /v1/runs/{run_id}/transcript`.

`POST /v1/sessions/{session_id}/fork` atomically creates a new Runtime Session
and copies the source's seed transcript and user/assistant projection. Both
Sessions reference the same immutable Run transcript entries up to the fork
point, while subsequent Runs belong only to the fork. The Workbench fork command
mirrors the same new Session ID into this endpoint when Runtime is active.

## Browser storage migration

On startup, Session Manager performs a read-only scan of the legacy
`zion.sessions.db` database and the old localStorage session keys.

The candidate data is sent to
`/v1/workbench-state/migrate-browser-storage`:

- Records missing from the Runtime Store are imported.
- Records identical to the Runtime Store are verified and skipped.
- Conflicting browser records are archived as recoverable revisions.
- Existing Runtime records are never overwritten by migration.
- Tombstoned records are not silently resurrected.

After the backend confirms that every candidate was imported, archived, or
verified, Session Manager clears only the `docs`, `metas`, and session-owned KV
records. The shared comments KV records are left untouched.

## Recovery

The Runtime Store keeps:

- A current document and metadata row for each session.
- The latest encoded Yjs state and version for each collaborative Session.
- A durable ordered Workbench event feed for cursor-based reconnect.
- Sparse semantic revisions per session. Current document/Yjs state is still
  persisted continuously, while collaborative autosaves create history only
  after a five-minute interval or a 64 KiB text-size change.
- Revision history is capped at 20 rows and 8 MiB per session. Repeated tool and
  reasoning annotations are content-addressed outside revision rows and are
  transparently hydrated during restore.
- Local PostgreSQL databases are pruned by resumable background maintenance after
  Runtime is serving. PostgreSQL physical compaction remains an explicit
  maintenance-window operation; PostgreSQL uses normal server maintenance.
- Explicit tombstones for deletions.
- Idempotency records for retried operations.

Revision listing and restore are exposed through:

- `GET /v1/workbench-state/sessions/{session_id}/revisions`
- `POST /v1/workbench-state/sessions/{session_id}/restore`

## Failure behavior

If Zion Runtime is unavailable during startup, Session Manager does not fall
back to browser storage and does not enable editing with a false saved state.
During an active session, failed writes stay queued and are retried. Page hiding
and session switching trigger an immediate flush.
