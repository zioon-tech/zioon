# Runtime and Zion Next Compatibility Contract

> Product roles, placement, Relay, Runtime collaboration, and the multi-host
> plugin lifecycle are defined by
> [ZION-DISTRIBUTED-RUNTIME-PRODUCT-ARCHITECTURE.md](./ZION-DISTRIBUTED-RUNTIME-PRODUCT-ARCHITECTURE.md).
> This document is limited to compatibility between the current Workbench and
> standalone Runtime Host.
> The concrete Workbench/CLI capability migration plan is tracked in
> [WORKBENCH-RUNTIME-CAPABILITY-MIGRATION.md](./WORKBENCH-RUNTIME-CAPABILITY-MIGRATION.md).
> `Tool Host` below is the current implementation term for the capability
> execution part of the canonical `Resource Host` role.

## Purpose

This document prevents the standalone Runtime from evolving away from the current
`zion-next` behavior before Workbench integration starts.

The Runtime remains independently deployable and must not import browser modules.
Compatibility is provided by outer adapters, shared fixtures, and projection
tests. Compatibility-only fields must not be added to `@zion/runtime`.

## Integration rule

`zion-next` must eventually depend on a `RuntimeClient`, not on Runtime internals:

```text
zion-next UI
  -> RuntimeClient
    -> HTTP/SSE Runtime Host
      -> @zion/runtime
```

The existing browser execution path remains available until compatibility gates
pass. Runtime-specific behavior must not be inserted directly into CodeMirror,
plugin UI entry points, or `window.zion`.

Current ownership:

- `packages/runtime`: host-neutral contracts and execution;
- `src/runtime/http-runtime-client.ts`: opt-in HTTP/SSE Runtime client, not wired
  into the default Workbench execution path;
- `src/runtime/zion-next-compatibility.ts`: Workbench protocol adapter;
- `extensions/dev.scheduler/runtime-backend.js`: local-only compatibility bridge;
- `extensions/dev.langchain-chat/runtime-backend.js`: default-off bridge for plain
  interactive Chat Runs that exposes only Runtime-compatible read-only tools;
- `extensions/dev.terminal-manager/terminal-inventory.js`: shared Terminal domain;
- `extensions/dev.terminal-manager/runtime.js`: headless plugin entry;
- `packages/node-protocol`: transport-neutral Device registration and command
  envelopes;
- `packages/local-tools-client`: reusable policy-scoped loopback adapter for
  `zion-local-tools`;
- `apps/runtime`: composition root, Runtime Plugin lifecycle owner, and opt-in
  Node Broker;
- `apps/device-connector`: outbound adapter from one Device Node to its local
  `zion-local-tools`.

The browser PluginLoader excludes `runtime`, `tools`, and `cli` entry paths from
its module glob. Runtime Host discovers `entries.runtime` from manifests and only
imports plugin IDs in its explicit allowlist. Runtime Plugin API v1 accepts
Context Providers and an optional dispose hook; it does not modify
`@zion/runtime`.

## Confirmed contract mapping

| Existing Zion Next | Standalone Runtime | Status |
|---|---|---|
| `{ providerId, modelId, label }` | `ModelRef` | Aligned |
| OpenAI function tool schema | `ToolDefinition` | Pure adapter implemented |
| tool call `{ id, name, args }` | `{ id, name, arguments }` | Event compatibility alias implemented |
| event `ts` | event `timestamp` | `ts` compatibility alias implemented |
| `pre` Message Contributors | pre `ContextProvider` | Once per new Run |
| `post` Message Contributors | post `ContextProvider` | Once before every model turn |
| contributor error isolation | `context.failed` event | Run continues |
| current `RunPolicy` fields | `CapabilityPolicy` | Normalization parity tested |
| `fsWrite/fsEdit/terminalExecute` aliases | `write/edit/Bash` | Workbench adapter only |
| `projectRunEventToSession` | Runtime RunEvent adapter | Tool projection tested |
| programmatic two-turn tool loop | Agent executor tool loop | Dual-execution golden test |
| `chat/reasoningStart/Token/End` | `reasoning.started/delta/completed` | Ordinary Chat projection parity tested |
| browser usage token shape | canonical Runtime `Usage` | Compatibility aliases and projection tested |
| Terminal Inventory contributor | policy-scoped headless Context Provider | One shared domain implementation |
| browser plugin activation | Host Runtime plugin lifecycle | Manifest/API/path validation and disposal tested |
| per-session active Run | Runtime Session message Run | Same one-Run-at-a-time intent |

The executable contract is
`tests/runtime-zion-compatibility.test.ts`. It imports both the current
`createProgrammaticExecutor`/session projector and the standalone Runtime.

## Tool schema compatibility

The local-tools Broker uses the existing names and argument fields:

- `read`
- `glob`
- `grep`
- `tree`
- `write`
- `edit`
- `Bash`
- `webSearch`
- `sendMail`
- scoped MCP tools

`grep` retains the current `B`, `A`, `C`, `n`, `i`, `type`, `head_limit`,
`offset`, and `multiline` parameters. `glob` and `grep` retain optional `path`;
Runtime safely defaults it only when policy contains exactly one `fileRoot`.

For local interactive Runs, empty scope lists preserve the previous permissive
read-only behavior:

- an empty `allowedTerminalSessionIds` allows any existing terminal session;
- an empty `fileRoots` allows read-only file tools to use any absolute path;
- supplying either list enables strict allowlist enforcement immediately;
- only explicitly exposed tools reach the model;
- Node mode resolves an opaque `resourceId` to a Device-local root and session
  allowlist, and always narrows Runtime policy to those Device bindings;
- Tool Host execution still requires independent canonical-path and symlink
  enforcement.

Write tools continue to require `workspace-write`; local interactive Runs may
leave roots unrestricted when the user explicitly enabled those tools, while
durable Scheduler tasks require explicit roots. Bash continues to require
`trusted-automation`; enabling it in the Workbench tool selector is the
interactive grant and the local-tools sandbox remains mandatory.

Workbench tool selection is preserved when creating an interactive Runtime Run.
Selected tools with Runtime Tool Host implementations are copied into
`policy.allowedTools`; the required policy preset is derived from the selected
tools. The Run metadata records `workbenchEnabledTools`,
`runtimeEnabledTools`, and `runtimeUnsupportedTools`, so Workbench-only control
tools are observable instead of being silently discarded. Enabled skills remain
Workbench message contributors and their `<available_skills>` snapshot is sent
with the Run messages.

## Current compatibility boundaries

### Messages and transcript

- Runtime preserves supported `text` and `image_url` content parts.
- Runtime stores tool calls, full tool results, and reasoning in canonical Run
  transcripts in addition to Run events and checkpoints.
- Workbench and Runtime share a Session ID when a Workbench Run is accepted.
  The first binding sends an unmodified `sessionHistory`; Runtime stores the
  entries before the current user message as an immutable seed transcript.
- Workbench document state and canonical Agent history remain separate models
  and must continue to be updated through their respective APIs.

### Tools

- Runtime hosts policy-scoped file, Bash, web, mail, todo, and MCP tools.
- Tools execute directly against same-machine local-tools or, in explicit Node
  mode, through an authenticated Device Connector selected by `projectId`.
- Runtime persists deterministic invocation receipts before checkpointing a
  completed tool turn, preventing restart replay after a confirmed result.
- Browser-only editor and plugin-installation commands remain outside durable
  Scheduler eligibility. Memory, Identity, Agent, Session, model, tool, mail, and
  Scheduler management now have Runtime plugin tools with policy-scoped actions.
- Remote invocation now carries a Runtime-issued `leaseExpiresAt` deadline
  (120 seconds by default). Runtime removes expired queued work, sends
  `tool.cancel` for expired delivered work, and rejects late results; Device
  Connector also rejects a command whose lease expired before local execution.
- Device registrations, project/resource bindings, and accepted invocation
  receipts are SQLite-backed. Restored Devices remain offline until they
  register again; pending command delivery and Device-side receipt caches remain
  process-local.
- Device credentials use one development bearer token rather than pairing and
  per-device keys.
- The current lease is an absolute wall-clock timestamp, so Runtime and Device
  clocks must remain reasonably synchronized. A signed or relative,
  clock-skew-tolerant lease is required before deployment across untrusted
  networks.
- Runtime policy still carries absolute paths and terminal session IDs for
  compatibility. A resource-relative invocation schema must remove those
  Device-local details before public remote deployment.

### Plugins and context

- Runtime now matches contributor stage and ordering semantics, but current
  browser contributor implementations still depend on `window.zion`, StateBus,
  editor instances, or plugin-local state.
- Terminal Inventory is now available through a headless pre-stage provider. It
  reads the existing local-tools `/sessions` and `/machines` APIs and exposes only
  session IDs explicitly granted by the Run policy. Automatic context uses a
  deterministic bounded projection and reports truncation totals; the
  `terminalInventory` tool keeps the complete policy-scoped inventory available
  for follow-up queries.
- Runtime entries now have a Host-owned v2 lifecycle for Tool, Context Provider,
  Run post-processor, namespaced state, and plugin-event registration. Resource
  and renderer entries still need complete deployment contracts; browser
  functions must not be serialized or executed in Runtime.
- Runtime plugins are currently trusted same-process code. Persistent enablement,
  dependency resolution, package installation, permission isolation, and
  out-of-process execution are not implemented.
- Identity, Skills, Memory, Terminal Inventory, and context compression have
  headless providers. Document-bound comments remain a Workbench contributor.
- Interaction Profiles now persist exact Provider IDs and the Core applies their
  enabled/disabled lists.

### Events and UI

- Tool, reasoning, usage, completion, abort, and error projection are covered by
  compatibility tests.
- The Workbench-side HTTP/SSE client is integrated behind the existing
  `window.zion.chat` compatibility facade.
- Workbench defaults to `zion.runtime.mode=auto`: it discovers the local Runtime,
  uses it when healthy, and exposes the actual backend in the status bar. Normal
  users do not configure storage keys. `runtime` and `browser` are explicit
  override modes; `zion.runtime.baseUrl` is an advanced endpoint override. The
  former Chat/Scheduler-specific keys remain compatibility fallbacks only.
- Scheduler persists Runtime Run/Attempt IDs and
  resumes projection from the last durable event sequence after Workbench restart.
- Workbench documents, metadata, tree state, KV data, tombstones, and revision
  history now use Runtime `/v1/workbench-state/*`; local-tools is no longer the
  session database.
- Ordinary Chat supports text and `image_url` messages through Runtime. Comments,
  disabled Session persistence, and explicitly requested unsupported tools remain
  on the browser path.
- The interactive bridge preserves the existing `window.zion.chat.run`,
  ChatRuntime state, Run/Stop control, Session projection, panel attribution, and
  browser Run Ledger projection. It does not silently fall back after attempting
  Runtime Run creation.
- Interactive Runtime tokens use the editor's existing assistant anchor when that
  Session is visible, so invoking Chat in the middle of a document does not move
  the answer to the document tail. Background Sessions continue through serialized
  Session document commands.
- Accepted interactive Runtime Runs persist their Runtime URL, Run/Attempt
  identity, Session/Panel binding, and remote event sequence in the browser Run
  Ledger. Workbench startup reattaches these Runs even when the feature flag has
  since been disabled; disposal detaches observation without aborting execution.
- `apps/runtime` now owns the service-backed Scheduler Agent worker by default.
  It also owns Scheduler Task, occurrence, Run, lease, and trigger persistence.
  Workbench no longer claims service-backed Runs. Runtime supports the persisted
  file, Bash, web, mail, todo, and scoped MCP tool names used by Scheduler tasks.
- The Runtime URL defaults to `http://127.0.0.1:8766` and can be overridden with
  `zion.runtime.baseUrl`. Existing accepted Runtime Runs retain their
  original URL even if the feature flag is later disabled.
- Before an interactive Runtime Run is created, Workbench executes its registered
  `pre` and first-turn `post` message contributors and sends the resulting
  serializable message snapshot. Contributor IDs already implemented as Runtime
  Context Providers are excluded from this snapshot to avoid duplicate injection.
  Dynamic `post` contributors that must run again after every tool turn still need
  a headless Runtime entry.
- Runtime events are canonical; Workbench events are compatibility projections.

### Models and artifacts

- Runtime routes each Run to one selected OpenAI-compatible profile.
- Workbench maps the selected model to a Runtime `modelProfileId`. Runtime
  validates the profile, routes through its Provider/Credential, and returns the
  effective ModelRef in the acceptance response. It never silently substitutes
  Echo or another default model.
- In `auto` mode a selected browser model that has no matching Runtime profile
  stays on the browser compatibility path with a visible warning. Forced Runtime
  mode reports the mismatch as an error.
- Existing OpenAI-compatible Workbench profiles can be imported automatically
  through the loopback write-only profile API. Profile metadata and credentials
  are persisted separately with `0600` permissions; credential values are never
  returned by Runtime APIs. OS Keychain/Vault remains the production replacement
  for the file-backed credential implementation.
- Claude/Gemini Runtime adapters, attachments, and an external binary Artifact
  Store are not implemented. File Artifact and ChangeSet metadata are persisted
  in SQLite and projected into the Workbench Changes panel.

## Next implementation order

1. Implement an external Artifact Store before adding large results or
   attachments.
2. Add approval and durable Device-side operation receipts before remote
   unattended `write`, `edit`, or `Bash`.
3. Add a separate Resource plugin entry contract plus persistent plugin
   enablement and dependency handling.
4. Add Claude/Gemini Runtime engine adapters.
5. Replace the transitional file credential store with OS Keychain/Vault.
