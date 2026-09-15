---
name: "biography-memory"
description: "Retrieves detailed biography events from persistent memory. Invoke when the biography digest lacks details or the user asks about prior decisions, outcomes, milestones, or lessons."
---

# Biography Memory

Use this skill to recover details behind the short biography digest.

## Data Sources

Use the `dev.identity` plugin data location supplied in context: its `nodeId`
selects the tool target and its absolute `root` is the base for all paths below.
Do not use the active terminal, guess another Node, or read the legacy memory directory.

- Digest: `<root>/biography/digest.md`
- Full event stream: `<root>/biography/events.jsonl`
- Identity: `<root>/identity.md`
- User profile: `<root>/user.md`

`events.jsonl` is the source of truth. Each line is a JSON object with fields such as:

```json
{
  "id": "session-id:run-id:0",
  "at": "2026-08-12T06:27:19.948Z",
  "kind": "outcome",
  "summary": "A durable result",
  "project": "project-name",
  "topics": ["topic"],
  "sessionId": "session-id",
  "runId": "run-id",
  "confirmed": false
}
```

## Retrieval Workflow

1. Start with the injected biography digest. Do not read the event stream when the digest already answers the question.
2. Identify useful filters from the request: `project`, `topic`, `kind`, date, `sessionId`, `runId`, or distinctive summary terms.
3. Use the bundled `scripts/query-biography.py` for structured queries. Do not construct ad hoc `rg` commands.
4. Read only the matching events returned by the script; use `--limit` to control output size.
5. State when a conclusion comes from an unconfirmed event. `confirmed: false` means the user did not explicitly confirm it; it does not automatically mean the event is incorrect.
6. When the answer depends on a biography event, cite its exact event marker in the form `[[memory:<event-id>]]`. Preserve the marker exactly as written; citing only `sessionId` or `runId` is not sufficient.
7. Do not invent memory markers, and do not add a memory citation when the answer does not rely on a biography event. Only explicit `[[memory:<event-id>]]` markers are counted as cited events. The legacy `[memory:<event-id>]` form is accepted for compatibility.

## Query Methods

Run Bash on the supplied data Node, from this skill's deployed directory.
Set `EVENTS` to the supplied absolute `<root>/biography/events.jsonl` path with
proper shell quoting; it is a shell variable, not a virtual filesystem URI.
The Node must have Python and this script installed. If unavailable, report the
missing dependency; do not silently switch Nodes.

```bash
python3 scripts/query-biography.py index --path "$EVENTS"
python3 scripts/query-biography.py project memory-panel --limit 20 --path "$EVENTS"
python3 scripts/query-biography.py topic observability --limit 20 --path "$EVENTS"
python3 scripts/query-biography.py event session-id:run-id:0 --path "$EVENTS"
python3 scripts/query-biography.py session session-id --limit 40 --path "$EVENTS"
python3 scripts/query-biography.py recent --limit 20 --path "$EVENTS"
```

When a matching record is used in the answer, copy its `id` into the Wiki link:

```text
[[memory:9il616:run_qoh8xurptlg:0]]
```

## Safety

This retrieval workflow is read-only. Do not edit `identity.md`, `user.md`, or
`biography/` while querying history. Project working-memory maintenance under
`<root>/projects/` is governed separately by the injected Identity
context and is outside this skill's retrieval workflow.

Do not infer details absent from matching events. If the event stream is insufficient, say so and ask for the original session or additional context.
