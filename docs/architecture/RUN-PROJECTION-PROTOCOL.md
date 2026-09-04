# Run Projection Protocol

Status: implemented locally

## Purpose

The canonical Run event log is optimized for audit and recovery. It may contain
thousands of token-level events and large diagnostic payloads. Interactive
clients must consume the Client Run Projection Stream instead of replaying that
log directly.

The projection protocol is UI-neutral. Workbench, Desktop, Mobile, and CLI may
render events differently without changing Runtime semantics.

## Endpoints

```text
GET /v1/runs/{runId}/projection?after={rawSequence}
GET /v1/runs/{runId}/projection/stream?after={rawSequence}
GET /v1/runs/{runId}/events/{rawSequence}
```

The raw diagnostic endpoints remain:

```text
GET /v1/runs/{runId}/events?after={rawSequence}
GET /v1/runs/{runId}/events/stream?after={rawSequence}
```

## Cursor semantics

Every projected event retains the sequence of the last canonical event it
represents. Its SSE `id` is the same sequence.

For a merged delta:

```json
{
  "sequence": 42,
  "type": "message.delta",
  "data": {
    "delta": "merged text",
    "projection": {
      "sourceSequenceStart": 31,
      "sourceSequenceEnd": 42,
      "sourceEventCount": 12,
      "characterCount": 84
    }
  }
}
```

A reconnecting client sends this sequence through `after` or
`Last-Event-ID`. Runtime reprojects canonical events after that cursor, so
coalescing never weakens recovery guarantees.

## Projection policy

Supported query parameters:

| Parameter | Values | Runtime fallback |
|---|---|---|
| `reasoning` | `stream`, `summary`, `none` | `stream` |
| `max_delay_ms` | 50-2000 | 200 |
| `max_chunk_chars` | 64-16384 | 1024 |

Consecutive message or reasoning deltas from the same turn are combined.
Semantic events preserve ordering and force pending text to flush first.
The shared client defaults to 100ms/512 characters. Workbench requests
50ms/256 characters for visible assistant text, then limits expensive reasoning
UI updates separately to 250ms/256 characters.

Large `model.request`, tool argument, and tool result payloads are replaced by
bounded summaries containing `rawEventSequence`. A diagnostics surface can
fetch the full event through `/events/{rawSequence}`.

## Client profiles

| Client | Run stream | Reasoning | Collaboration |
|---|---|---|---|
| Workbench/Desktop | projection | stream | Yjs while editing |
| Mobile foreground | projection | summary or none | only in edit mode |
| Mobile background | Session lifecycle notifications | none | disconnected |
| CLI | projection by default | none for human output, stream for JSONL | none |
| Diagnostics | raw | raw | optional |

`zion --raw-events` is the explicit CLI escape hatch for canonical events.

## Persistence boundary

- Raw Run events and canonical transcript are durable in Runtime SQLite.
- Projected deltas are ephemeral and reconstructable.
- Browser Run Ledger excludes `message.delta` and `reasoning.delta`.
- Workbench renders pending assistant text as a CodeMirror decoration.
- Runtime Core delegates document preparation and finalization to a registered,
  UI-owned Document Projector. It does not parse Workbench role-line syntax.
- The `dev.session-manager` Runtime plugin prepares the submitted user block and
  a unique assistant anchor before exposing an accepted Workbench Session Run.
- Workbench sends the trigger location as a Yjs `RelativePosition`, plus a
  bounded context-checked offset fallback. The projector inserts at that anchor,
  not unconditionally at the document tail.
- The Session Manager projector commits final assistant text to Yjs on
  `message.completed` or terminal Run state.
- `message.completed.content` is authoritative for the visible assistant block;
  aggregate `run.completed.output` is recovery-only when no completed message
  was observed.
- Empty user prompts are Workbench-local affordances and are never persisted to
  Yjs. Workbench does not perform a competing terminal document mutation.
- A non-tail insertion writes an invisible continuation boundary so final
  projection and card placement preserve all following document content.
- One client is the document writer for thinking/tool markers. Observers retain
  projection metadata but wait for the matching Yjs marker instead of creating
  a second marker.
- Hocuspocus publishes one trailing `document.checkpointed` event after an edit
  burst instead of one durable Session event per CRDT update.

## Backpressure

Runtime waits when an SSE socket cannot accept more bytes. Shared clients use a
bounded event queue and stop reading the response while the consumer is behind.
This propagates pressure to the transport instead of growing browser or Mobile
memory without limit.

Semantic lifecycle events are never intentionally dropped. Delta events are
coalesced before delivery.

## Performance budgets

- Local Session discovery p95: less than 300ms.
- Visible assistant projection: no more than 20 updates per second in Workbench.
- Visible reasoning UI: no more than 4 updates per second in Workbench.
- A Workbench shares one Y.Doc/provider across all split views of a Session.
- Auto-follow reveals the active Run anchor in each following View; it never
  forces an arbitrary-position Run to the end of the document.
- In-flight Workbench output renders Markdown inside the ephemeral projection
  and follows a stable tail element to avoid scroll oscillation during reflow.
- Client event queue: bounded to 128 entries by default.
- No token-level localStorage writes.
- No token-level CRDT transactions or durable Session events.
