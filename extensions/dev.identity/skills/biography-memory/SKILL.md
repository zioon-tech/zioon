---
name: "biography-memory"
description: "Retrieves detailed biography events from persistent memory. Invoke when the biography digest lacks details or the user asks about prior decisions, outcomes, milestones, or lessons."
---

# Biography Memory

Use this skill to recover details behind the short biography digest.

## Data Sources

- Digest: `~/.zion-next/memory/biography/digest.md`
- Full event stream: `~/.zion-next/memory/biography/events.jsonl`
- Identity: `~/.zion-next/memory/identity.md`
- User profile: `~/.zion-next/memory/user.md`

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

Run the script from this skill directory:

```bash
python3 scripts/query-biography.py index
python3 scripts/query-biography.py project memory-panel --limit 20
python3 scripts/query-biography.py topic observability --limit 20
python3 scripts/query-biography.py event session-id:run-id:0
python3 scripts/query-biography.py session session-id --limit 40
python3 scripts/query-biography.py recent --limit 20
```

When a matching record is used in the answer, copy its `id` into the Wiki link:

```text
[[memory:9il616:run_qoh8xurptlg:0]]
```

## Safety

Treat `~/.zion-next/memory` as user-owned, read-only data. Do not create, edit, delete, reformat, commit, or revert files there unless the user explicitly requests that operation.

Do not infer details absent from matching events. If the event stream is insufficient, say so and ask for the original session or additional context.
