# Identity Project Memory M1 Design

## Goal

Extend `dev.identity` with project-oriented working memory under
`~/.zion-next/memory/projects/`. M1 gives the main conversation model a compact
project index and a disciplined way to maintain project files while preserving
Biography as immutable historical memory.

M1 does not add scheduler heartbeats, autonomous execution, notifications, a
project UI, or a general-purpose knowledge wiki.

## Runtime Layout

```text
~/.zion-next/memory/
├── identity.md
├── user.md
├── biography/
│   ├── events.jsonl
│   └── digest.md
└── projects/
    ├── index.md
    ├── inbox.md
    ├── _template.md
    └── <project-name>/
        └── project.md
```

`identity.initialize` creates the three project scaffolding files when they do
not exist. Initialization is idempotent and never overwrites user content.

## Module Boundaries

### `projects-core.js`

This new module contains no browser APIs, filesystem access, or global state.
It owns:

- the initial `index.md`, `inbox.md`, and project template content;
- project-index character clipping;
- XML-safe `<projects_index>` context construction;
- the project-maintenance instruction contract;
- composition of those pieces into the Identity context.

The project template uses fixed frontmatter fields:

```yaml
project: example
status: active
priority: medium
owner: user
autonomy: none
next_due:
wait_until:
created: 2026-08-18
updated: 2026-08-18
tags: []
```

`status` is one of `active`, `waiting`, `done`, or `archived`. `autonomy` is
reserved for later phases and is one of `none`, `explore`, `routine`, or
`full`. M1 stores these values but never acts on them.

### `identity-core.js`

The existing Biography and profile context builder remains responsible for
escaping and composing identity, user, and Biography blocks. It accepts the
project index as another bounded input and delegates project-specific
construction to `projects-core.js`.

### `main.js`

The plugin entrypoint owns local-tools I/O:

- resolve paths for `projects/index.md`, `projects/inbox.md`, and
  `projects/_template.md`;
- initialize missing files;
- read `projects/index.md` with the other Identity context files;
- pass the project index to the pure context builder.

The existing session Identity snapshot behavior remains unchanged in M1.
Projects become visible in a new session or after
`identity.refreshContext`. Live snapshot invalidation is deferred until project
writes are managed directly by the plugin.

## Context Contract

The injected `<identity_context>` gains:

```xml
<projects_index source="~/.zion-next/memory/projects/index.md">
  <content>...</content>
</projects_index>
```

The index has a separate character budget of 1600 characters. Identity, user,
and Biography retain their existing 700, 700, and 2600 character limits.

The instructions establish these boundaries:

- `identity.md` and `biography/` remain read-only unless the user explicitly
  requests a direct edit;
- `user.md` may only be updated for explicit, stable user statements and must
  preserve `[user-stated]`;
- `projects/` is model-maintained working memory;
- before editing an existing project, read its `project.md`;
- only substantive project changes update project memory;
- update both `project.md` and its one-line `index.md` entry;
- record a first-time unformed idea in `inbox.md`; propose creating a project
  when it recurs;
- do not infer grants, deadlines, completion, blockers, or user beliefs.

The model uses existing `read`, `write`, and `edit` tools. M1 adds no new
mutating tool.

## Failure Behavior

- Missing project files are treated as empty during context loading.
- A project-index read failure logs the existing profile-read warning and
  produces no Identity context, matching current fail-closed behavior.
- A failed scaffold write makes `identity.initialize` return its existing
  error result and notification.
- Oversized indexes are clipped with the same explicit `[truncated]` marker
  used by other Identity blocks.
- User-created files are never overwritten during initialization.

## Testing

Pure-function tests cover:

- default project templates and fixed sections;
- XML escaping of project-index content;
- independent project-index clipping;
- maintenance instructions and write boundaries;
- unchanged behavior when no project index exists.

Plugin tests cover:

- idempotent creation of all three project scaffold files;
- reading and injecting `projects/index.md`;
- preserving the existing session snapshot and refresh behavior;
- no regression in Biography distillation, digest rebuild, or profile context.

## Success Criteria

After running `identity.initialize`, a new or refreshed normal chat session
receives a bounded project index. The model is explicitly allowed and
instructed to maintain only project working-memory files through existing file
tools. Existing Identity, user profile, Biography, distillation, citation, and
session snapshot behavior continues to pass its current tests.
