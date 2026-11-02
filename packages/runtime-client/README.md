# @zion/runtime-client

Shared transport helpers for Workbench, CLI, Mobile, and other Zion Runtime
clients.

The package currently owns the bounded streaming SSE parser used by:

- Runtime Run attachment;
- coalesced Run projection streams for Workbench, Mobile, and CLI;
- durable Workbench Session event feeds;
- CLI JSONL watch commands.

It intentionally does not contain Workbench UI state or Runtime business logic.
Raw Run events remain available for diagnostics. Interactive clients should use
`subscribeRunStream()` in projection mode so token bursts are coalesced while
the last raw sequence remains the reconnect cursor.

Projection mode is the default. Its shared batching defaults are 100ms or 512
characters; latency-sensitive clients such as Workbench may request a tighter
50ms/256-character profile. Raw delivery must be selected explicitly.

Yjs/Hocuspocus is reserved for collaborative document edits and completed
message commits. It is not the model token transport.

```js
import { subscribeRunStream } from "@zion/runtime-client/run-stream";

for await (const event of subscribeRunStream(runtimeUrl, runId, {
  mode: "projection",
  reasoningMode: "summary",
  afterSequence
})) {
  // event.sequence is the last canonical sequence represented by this event.
}
```

Recommended client policies:

- Workbench/Desktop: `reasoningMode: "stream"`;
- Mobile foreground: `reasoningMode: "summary"` or `"none"`;
- background clients: durable Session events only;
- diagnostics: `mode: "raw"`.
