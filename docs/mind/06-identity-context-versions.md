# Identity context versions

Identity files remain authoritative. A context snapshot records SHA-256 hashes
of the six profile files and biography event log, the rendered context, and the
event hash used by its biography digest. Timestamps are display metadata, not
source revisions.

For each new chat session, Runtime checks the current source hashes through
Memory's `GET /zion/files/read-batch` endpoint. The request includes exact file
paths, optional `known_hash` values and `metadata_only` for the event log.
Memory authenticates the request, checks every delegated path and captures the
batch under the existing account lock shared by API, CLI, MCP and raw uploads.
Unchanged files use authoritative revision metadata without reading objects.
Untracked objects fall back to a normal content read.

Biography publication adds an HTML comment containing the event log hash to
`digest.md`. The comment is omitted from model context. A matching digest is
used directly; an absent or stale marker triggers a coherent conditional read
including the event body and rebuilds the projection. This repair does not
write on the send path. Subsequent unchanged sessions reuse that projection.
Raw event records are never included in default context.

Runtime stores immutable projections and session version selections in private
PostgreSQL tables introduced by migration 009. Scope includes authenticated
account, Space, data root, service endpoint and access mode. It does not use
shared workbench KV. Session selection is durable before the first model call;
concurrent first publishers select one version atomically. Superseded bodies
without a session/latest reference are removed during publication.
Existing sessions recheck the small durable version pointer and transfer the
body only when the cached revision differs, so refresh on another worker is
visible. Refresh reserves an epoch before reading sources; an older request
cannot overwrite a newer refresh, even if its network response finishes later.
Publication locks the session binding row from epoch validation through commit,
so a concurrent reservation cannot advance the epoch between validation and
the revision update. Source IO remains outside the publication transaction.

`POST /v1/plugins/dev.identity/commands` with
`{"action":"refresh_context","sessionId":"..."}` explicitly updates the selected
session version. The standard command endpoint performs current account and
session authorization. Refresh requires an idle session and performs a new
source check. The frontend saves the exact returned projection after success.
A failed refresh retains the prior selection; there is no browser-only success
fallback in Runtime mode.

Initialization belongs to account setup or the explicit Identity initialization
command. Sends only use in-memory defaults for explicitly missing profile
files. Deliberately empty files remain empty.

Install the Memory batch interface before Runtime and Workbench. Runtime can
fall back to the existing per-file read path only if the batch protocol is
absent; authorization, integrity and availability failures remain errors.
Migration 009 is additive. Rollback uses the previous application binaries and
leaves the new tables intact.

Verification covers source edits, stale digests, event/body exclusion,
unchanged object-read avoidance, current path permission and revocation,
restart/eviction, atomic first selection, explicit refresh and failed refresh.
Additional checks cover duplicate batch query parameters, UTF-8 BOM bytes,
older gateway delegation contracts, truncated responses and cross-worker
refresh publication order.
Local request/object counts demonstrate reduced work, not production P50/P95.
Production validation should compare the existing Identity contribution span
and provider authorization span separately after an idle deployment window.
