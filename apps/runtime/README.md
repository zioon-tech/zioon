# Zion Runtime Host

Local, standalone host for `@zion/runtime`.

Requires Node.js 22.5 or newer because the current SQLite adapter uses the built-in
`node:sqlite` module. Node 22 may print an experimental-module warning.

The current checkpoint provides:

- a loopback-only HTTP API;
- SQLite-backed Run and ordered Event persistence;
- Run creation, lookup, event catch-up, SSE streaming, and abort;
- startup reconciliation for Runs left active without a live owner;
- durable checkpoints after completed tool turns and explicit new-Attempt resume;
- durable Sessions with ordered user/assistant transcripts;
- immutable Session seed transcripts imported from pre-Runtime Workbench history;
- canonical Run transcripts with reasoning, tool calls, and full tool results,
  reused as structured history by later Session Runs;
- durable file Artifacts and ChangeSets derived at the Tool Broker boundary and
  queryable by Run or Session;
- Runtime-owned Workbench documents, metadata, tree, KV, tombstones, and
  revision history;
- a durable, cursor-based Workbench Session event feed with JSON catch-up and
  SSE streaming for Workbench, CLI, and future Mobile clients;
- a cursor-preserving Client Run Projection Stream that coalesces raw model
  deltas and applies HTTP backpressure;
- embedded Hocuspocus/Yjs collaboration rooms with SQLite persistence,
  CodeMirror-compatible document state, and terminal model output commits;
- one immutable Run per Session message and idempotent completion projection;
- an interactive CLI that creates or reconnects to a Session;
- a local Model Registry with sanitized profile discovery;
- strict per-Run Model Profile routing with no silent model substitution;
- loopback write-only import of existing Workbench OpenAI-compatible profiles;
- separate `0600` profile and credential stores;
- a real OpenAI-compatible streaming Engine adapter;
- an environment-backed, allowlisted Credential Provider;
- a policy-scoped local-tools broker for files, Bash, search, mail, and MCP;
- Runtime-native `webFetch` and durable `todoWrite`;
- durable invocation receipts that prevent replayed side effects;
- a manifest-driven Runtime Plugin Service with an explicit plugin allowlist,
  API-version validation, failure isolation, and reverse-order disposal;
- an opt-in Node Broker for authenticated Device Connector registration,
  capability discovery, invocation routing, cancellation, and reconnect
  redelivery;
- SQLite-backed Device registry, project/resource bindings, and completed
  invocation receipts;
- a policy-scoped Terminal Inventory Context Provider compatible with the current
  Workbench XML format;
- a service-backed Scheduler Agent worker that claims and completes tasks without
  an online Workbench;
- Runtime-owned Scheduler Task, occurrence, Run, lease, and trigger persistence;
- a Runtime-owned Project Automation coordinator that reads Identity project
  files, starts bounded Agent Runs, mirrors Agent task state, and records
  attention items without an online Workbench;
- a restricted model gateway for legacy browser execution paths;
- idempotent one-time import of legacy Workbench and Scheduler state from
  `zion-local-tools`;
- a deliberately limited Echo Engine for protocol smoke testing.

It connects to `zion-next` through the HTTP/SSE RuntimeClient while preserving a
temporary browser compatibility path. It never exposes `zion-local-tools` directly.
It is not safe to bind publicly: Client authentication, device pairing,
per-device credentials, isolated third-party plugin execution, and OS
keychain/Vault credential providers remain later milestones.

## Start

From the repository root:

```bash
npm run runtime:serve
```

Defaults:

```text
listen: 127.0.0.1:8766
database: ~/.zion-next/runtime/runtime.sqlite3
model profiles: ~/.zion-next/runtime/model-profiles.json
credentials: ~/.zion-next/runtime/credentials.json
engine: zion.echo
scheduler worker: enabled
project automation worker: enabled
default interaction profile: read-only
```

Disable Scheduler claiming for diagnostics with
`ZION_RUNTIME_SCHEDULER_WORKER=0`. The worker claims directly from the
Runtime-owned Scheduler store and does not require local-tools or an open
Workbench for control-plane access. Tool calls still use the configured Tool
Host.

Project Automation uses `~/.zion-next/memory` by default and checks enabled
project policies once per minute. Configure it with
`ZION_IDENTITY_MEMORY_ROOT`, `ZION_RUNTIME_PROJECT_AUTOMATION_POLL_MS`, or the
matching `--identity-memory-root` / `--project-automation-poll-ms` flags. Disable
only its background heartbeat with `ZION_RUNTIME_PROJECT_AUTOMATION_WORKER=0`;
manual `run_now` and `stop` remain available through the Runtime tool and
control-plane endpoints.

```text
GET  /v1/project-automation
POST /v1/project-automation/projects/{projectKey}/run
POST /v1/project-automation/projects/{projectKey}/stop
GET  /v1/runs/{runId}/artifacts
GET  /v1/sessions/{sessionId}/artifacts
```

Legacy state import is enabled by default during migration. Runtime reads the old
local-tools `/app-sessions` and `/scheduler` endpoints once, records import
markers, and keeps the source data untouched. Disable the probe after migration:

```bash
ZION_RUNTIME_MIGRATE_LOCAL_TOOLS_STATE=0 npm run runtime:serve
```

Start with an OpenAI-compatible endpoint:

```bash
ZION_RUNTIME_ENGINE=openai \
ZION_RUNTIME_MODEL_URL=https://api.example.com/v1/chat/completions \
ZION_RUNTIME_MODEL_ID=model-name \
ZION_RUNTIME_API_KEY=secret \
npm run runtime:serve
```

Use the built-in DeepSeek V4 Flash profile:

```bash
ZION_RUNTIME_ENGINE=openai \
ZION_RUNTIME_MODEL_PROFILE=deepseek-v4-flash \
ZION_RUNTIME_DEEPSEEK_API_KEY=<deepseek-api-key> \
npm run runtime:serve
```

The profile configures streaming, `max_tokens: 8192`, thinking mode, high reasoning
effort, capability metadata, and `model.deepseek -> ZION_RUNTIME_DEEPSEEK_API_KEY`.
The profile contains only a credential reference and never stores the key.

The API key is read by the Runtime process and is never returned by the Runtime
API. The Engine obtains it through the `EnvironmentCredentialProvider` binding
`model.default -> ZION_RUNTIME_API_KEY`; a Run cannot request arbitrary environment
variables. Set `ZION_RUNTIME_API_KEY_REQUIRED=1` to reject missing credentials.
The key may be omitted for an authenticated local model server.

Workbench can migrate an existing OpenAI-compatible configuration without asking
the user to re-enter it:

```text
PUT /v1/model-profiles/{profileId}
```

The request may contain a credential, but the response and `GET /v1/models` only
expose `credentialConfigured`. The current local credential store is an
intermediate `0600` file and must be replaced by OS Keychain/Vault before remote
binding is enabled.

Override the local port or database:

```bash
npm run runtime:serve -- --port 8877 --db /tmp/zion-runtime.sqlite3
```

## Device node mode

The default tool mode remains direct, same-machine `local-tools`. Enable the
remote Node Broker explicitly:

```bash
ZION_RUNTIME_NODE_TOKEN=<shared-development-token> \
ZION_RUNTIME_TOOL_MODE=node \
ZION_RUNTIME_INVOCATION_LEASE_MS=120000 \
npm run runtime:serve -- --runtime-plugins none
```

The Device Connector uses authenticated outbound long polling, so the machine
running `zion-local-tools` does not expose its local HTTP port. Runtime routes a
Tool Invocation by `projectId` to an online Node that advertises a matching
resource and capability. Node mode defaults to no Runtime plugins because the
built-in Terminal Inventory Provider observes the Runtime machine rather than a
remote Device; pass `--runtime-plugins ...` only for providers intentionally
installed on that Host.

The Node gateway endpoints are mounted only when
`ZION_RUNTIME_NODE_TOKEN` is configured:

```text
POST /v1/device-nodes/register
POST /v1/device-nodes/{nodeId}/heartbeat
GET  /v1/device-nodes/{nodeId}/invocations/next
POST /v1/device-nodes/{nodeId}/invocations/{invocationId}/result
GET  /v1/device-nodes
```

This is a protocol validation checkpoint, not a public deployment boundary.
The static bearer token must be replaced by device pairing and per-device
credentials before remote binding. Device registrations, project/resource
bindings, and completed Runtime-side invocation receipts use the Runtime SQLite
database. A restored Device is deliberately offline until its Connector
registers again. Runtime restart still interrupts active remote invocations;
pending command delivery and Device-side receipts are not durable. Each Connector
must also configure an absolute local workspace root and explicit local-tools
terminal-session allowlist. Device Host intersects those local grants with every
Runtime policy before invoking local-tools.

Every remote invocation has a Runtime-owned lease, 120 seconds by default.
Queued work is removed at expiry; already delivered work receives a
`tool.cancel` command. Device Connector also checks the absolute deadline before
starting local execution. Override the positive millisecond duration with
`ZION_RUNTIME_INVOCATION_LEASE_MS` or `--invocation-lease-ms`.

Inspect current and restored Node state with the same development credential:

```bash
curl http://127.0.0.1:8766/v1/device-nodes \
  -H "Authorization: Bearer ${ZION_RUNTIME_NODE_TOKEN}"
```

## Continuous conversation

Keep the Runtime running, then start the interactive client in another terminal:

```bash
npm run runtime:chat -- --url http://127.0.0.1:8766
```

The CLI prints the durable Session ID. Reconnect to the same conversation later:

```bash
npm run runtime:chat -- \
  --url http://127.0.0.1:8766 \
  --session <session-id>
```

Each user message creates a new Run. Runtime loads the Session transcript before
execution and appends the completed assistant output back to the Session. A new
message therefore creates a new Run in the same Session; `/resume` remains reserved
for recovering an interrupted Attempt of an existing Run.

When Workbench first binds an existing document Session, it sends a separate
`sessionHistory` snapshot. Runtime stores the history before the current user
message as an immutable seed transcript. Runtime Context Provider output is not
included in this seed, so temporary injected context does not become conversation
history.

## Runtime control CLI

The `zion` control CLI uses only Runtime Host HTTP APIs:

```bash
npm run runtime:cli -- run "inspect the repository" --jsonl
npm run runtime:cli -- attach <run-id>
npm run runtime:cli -- attach <run-id> --raw-events
npm run runtime:cli -- resume <run-id>
npm run runtime:cli -- abort <run-id>
npm run runtime:cli -- session list
npm run runtime:cli -- session transcript <session-id>
npm run runtime:cli -- session fork <session-id> --title "Alternative"
npm run runtime:cli -- session attach <session-id>
npm run runtime:cli -- session watch <session-id> --jsonl
npm run runtime:cli -- task list
npm run runtime:cli -- task run <task-id>
npm run runtime:cli -- task cancel <scheduler-run-id>
```

Run follow and attach use the coalesced projection stream by default. Add
`--raw-events` only for diagnostics that require every canonical token event.
Omit `--jsonl` for human output. JSONL records use `schemaVersion: 1` and retain
the canonical Runtime `RunEvent` unchanged in each `run.event` record. The
package also exposes the same entry point as the `zion` executable.

Endpoint profiles live in `~/.zion-next/cli.json` (override with
`ZION_RUNTIME_CLI_CONFIG`). Credentials are referenced by environment variable
and are never stored in or printed with the profile:

```json
{
  "version": 1,
  "defaultProfile": "local",
  "profiles": {
    "local": { "url": "http://127.0.0.1:8766" },
    "cloud": {
      "url": "https://runtime.example.com",
      "auth": { "type": "bearer", "env": "ZION_CLOUD_RUNTIME_TOKEN" }
    }
  }
}
```

Select one with `--runtime-profile cloud`; `zion profile list` and
`zion profile show cloud` return only sanitized endpoint metadata.
For CI workloads, use `{ "type": "workload", "tokenFileEnv":
"ZION_WORKLOAD_TOKEN_FILE" }`; the projected token is read for the process and
is never included in profile output.

For interactive cloud login, configure RFC 8628 metadata:

```json
{
  "url": "https://runtime.example.com",
  "auth": {
    "type": "device_code",
    "deviceAuthorizationUrl": "https://identity.example.com/oauth/device/code",
    "tokenUrl": "https://identity.example.com/oauth/token",
    "clientId": "zion-cli",
    "scope": "runtime.run offline_access"
  }
}
```

Run `zion auth login <profile>`. Access and refresh tokens are stored in macOS
Keychain, refreshed when possible, and never written to the CLI config.
`zion auth status <profile>` exposes only expiry metadata; `zion auth logout
<profile>` deletes the Keychain item.

The CLI can also act as the outbound Device Tool Host:

```bash
ZION_DEVICE_TOKEN=<device-token> \
npm run runtime:cli -- device connect \
  --runtime-profile cloud \
  --project zion-next \
  --resource-id workspace:zion-next \
  --workspace-root /absolute/path/to/zion-next \
  --terminal-sessions <local-tools-session-id>
```

To create a CLI Session that can use the read-only tools advertised by a Device:

```bash
ZION_RUNTIME_PROJECT_ID=zion-next \
ZION_RUNTIME_ALLOWED_TOOLS=read,glob,grep,tree \
ZION_RUNTIME_FILE_ROOTS=/absolute/path/to/zion-next \
ZION_RUNTIME_TERMINAL_SESSION_IDS=<local-tools-session-id> \
npm run runtime:chat -- --url http://127.0.0.1:8766
```

The equivalent flags are `--project`, repeatable `--tool`, repeatable
`--file-root`, repeatable `--terminal-session`, and `--max-tool-calls`. These
values are stored in the Session when it is created; reconnecting with
`--session` reuses the stored policy.

## End-to-end read-only setup

This is the currently usable private standalone path. First obtain an active
local-tools Session ID on the Device:

```bash
curl http://127.0.0.1:8765/sessions
```

Start Runtime with a real model and Node mode:

```bash
ZION_RUNTIME_ENGINE=openai \
ZION_RUNTIME_MODEL_PROFILE=deepseek-v4-flash \
ZION_RUNTIME_DEEPSEEK_API_KEY=<deepseek-api-key> \
ZION_RUNTIME_NODE_TOKEN=<shared-development-token> \
ZION_RUNTIME_TOOL_MODE=node \
npm run runtime:serve
```

Start the Connector on the Device that owns the project:

```bash
ZION_DEVICE_TOKEN=<shared-development-token> \
ZION_NODE_ID=node:macbook \
ZION_NODE_PROJECT_ID=zion-next \
ZION_NODE_RESOURCE_ID=workspace:zion-next \
ZION_NODE_WORKSPACE_ROOT=/absolute/path/to/zion-next \
ZION_NODE_TERMINAL_SESSION_IDS=<local-tools-session-id> \
npm run device:connect -- --runtime-url http://127.0.0.1:8766
```

Then start the scoped CLI using the same project root and terminal Session ID:

```bash
npm run runtime:chat -- \
  --url http://127.0.0.1:8766 \
  --project zion-next \
  --tool read,glob,grep,tree \
  --file-root /absolute/path/to/zion-next \
  --terminal-session <local-tools-session-id>
```

The Runtime API remains loopback-only by default. Use an authenticated private
tunnel for cross-machine validation; do not bind this checkpoint directly to the
public internet.

## API

```text
GET  /health
GET  /v1/models
GET  /v1/capabilities/tools
GET  /v1/interaction-profiles
GET/PUT/PATCH /v1/interaction-profiles/{profileId}
PUT/DELETE /v1/model-profiles/{profileId}
POST /v1/model-gateway/proxy?target={url}
GET  /v1/device-nodes
GET  /v1/workbench-state/status
GET  /v1/workbench-state/snapshot
PUT  /v1/workbench-state/snapshot
GET/PUT /v1/workbench-state/tree
GET  /v1/workbench-state/events?after={sequence}
GET  /v1/workbench-state/events/stream?after={sequence}
GET/PUT/DELETE /v1/workbench-state/sessions/{sessionId}
GET  /v1/workbench-state/sessions/{sessionId}/revisions
POST /v1/workbench-state/sessions/{sessionId}/restore
GET/PUT /v1/workbench-state/kv/{key}
GET/POST /v1/scheduler/tasks
GET/PUT/DELETE /v1/scheduler/tasks/{taskId}
POST /v1/scheduler/tasks/{taskId}/run
GET  /v1/scheduler/runs
GET  /v1/scheduler/runs/{runId}
POST /v1/scheduler/runs/{runId}/cancel
POST /v1/sessions
GET  /v1/sessions/{sessionId}
GET  /v1/sessions/{sessionId}/active-run
GET  /v1/sessions/{sessionId}/transcript?after={sequence}
GET  /v1/sessions/{sessionId}/messages?after={sequence}
POST /v1/sessions/{sessionId}/messages
POST /v1/sessions/{sessionId}/fork
POST /v1/runs
GET  /v1/runs/{runId}
GET  /v1/runs/{runId}/events?after={sequence}
GET  /v1/runs/{runId}/events/{sequence}
GET  /v1/runs/{runId}/events/stream?after={sequence}
GET  /v1/runs/{runId}/projection?after={sequence}
GET  /v1/runs/{runId}/projection/stream?after={sequence}
GET  /v1/runs/{runId}/transcript
POST /v1/runs/{runId}/abort
POST /v1/runs/{runId}/resume
WS   /v1/collaboration
```

Workbench state events are committed in the same SQLite transaction as the
Session, tree, or KV mutation. Clients initialize from a snapshot and continue
from its `event_cursor`. Expired cursors receive a `reset` event and reload the
snapshot. The 30-second Workbench snapshot check remains only as a compatibility
fallback.

`/v1/collaboration` speaks the Hocuspocus/Yjs protocol. Runtime seeds a room from
the current Workbench Session, stores the Yjs state in
`runtime_collaboration_documents`, and projects committed collaborative text
back to the normal Workbench document record. In-flight Run output uses the
coalesced projection stream and is never persisted per token. Runtime commits
the final assistant block to the collaborative document, so the Workbench that
started a Run is not the only persistence owner.

`/projection/stream` preserves the last raw Run event sequence as each SSE id.
It accepts `reasoning=stream|summary|none`, `max_delay_ms`, and
`max_chunk_chars`. `/events/stream` remains available for explicit raw
diagnostics.

Runtime's fallback projection batch is 200ms/1024 characters. Shared clients
use 100ms/512 characters, while Workbench requests 50ms/256 characters for
visible assistant output and independently limits reasoning UI updates to four
per second.

`POST /v1/runs` accepts optional per-Run model preferences:

```json
{
  "modelOptions": {
    "thinkingMode": "on",
    "thinkingEffort": "high"
  }
}
```

These values are request overrides. Workbench sends them with each Run; they do
not mutate the persisted Runtime Model Profile.

`maxTurns` and `policy.maxToolCalls` are separate safeguards. An explicit
`maxTurns` is honored. Otherwise Runtime derives enough turns to consume the
tool-call budget and produce a final answer (`max(defaultMaxTurns,
maxToolCalls + 1)`), so the historical 16-turn fallback cannot silently shadow
a larger tool-call quota.

The API permits browser CORS only for loopback origins and refuses non-loopback
binding without the explicit development override. Remote client authentication
remains required before public deployment.

## Tool Host integration

The Runtime connects to `http://127.0.0.1:8765` by default. Override it with
`ZION_LOCAL_TOOLS_URL` or `--local-tools-url`.

Tools are not globally enabled. Each Run must explicitly grant the tool names
and capability scope it needs:

```json
{
  "policy": {
    "allowedTools": ["read", "glob", "grep", "tree"],
    "maxToolCalls": 12,
    "fileRoots": ["/absolute/project/root"],
    "allowedTerminalSessionIds": ["exact-session-id"]
  }
}
```

Empty `fileRoots` and `allowedTerminalSessionIds` lists leave interactive
file tools unrestricted across absolute paths and existing terminal sessions.
Supplying either list enables strict allowlist enforcement for that scope.
Write tools still require `workspace-write`; durable Scheduler tasks also
require explicit `fileRoots`. Bash requires `trusted-automation` and matches
`allowedCommandPrefixes` when configured. Mail requires `trusted-automation`,
a recipient scope, and a per-Run quota; `"*"` is the explicit local-interactive
recipient scope. Node mode always narrows unrestricted Runtime scopes to the
Device-local resource root and terminal bindings.

## Runtime plugins

Runtime Host scans manifests under the repository `extensions` directory by
default, but executes only explicitly enabled plugin IDs. In local tool mode the
default allowlist currently includes Terminal Manager, Skills, Memory, Identity,
Context Compression, Scheduler, Session Manager, Chat model management, Tools,
Mail, and Agents. Node mode defaults to no Runtime plugins because local
machine-observation plugins may not describe the selected remote Device. Override
the plugin root and allowlist with:

```bash
npm run runtime:serve -- \
  --plugin-root /absolute/plugin-root \
  --runtime-plugins dev.example.context,dev.terminal-manager
```

Use `--runtime-plugins none` to start without Runtime plugins. A Runtime-capable
manifest declares:

```json
{
  "zion": {
    "entries": {
      "runtime": "./runtime.js"
    },
    "runtime": {
      "apiVersion": 1
    }
  }
}
```

The entry exports `activateRuntimePlugin(context)`. API version 1 accepts returned
Context Providers. API version 2 adds Host-owned Tool, Context Provider, Run
post-processor, namespaced state, and plugin-event registration. Plugin activation
failures are isolated and reported in `/health`; successful registrations and
plugins are disposed in reverse order during shutdown.

Runtime plugins currently execute in the Host process and therefore must be
trusted code. Entry canonicalization prevents a manifest from escaping its plugin
directory, but it is not a process or permission sandbox. Untrusted third-party
plugins must not be enabled until an isolated host model exists.

## Skills context

Workbench persists only Skills metadata, paths, and enabled IDs. Plugin source
files and complete `SKILL.md` bodies remain on the filesystem. Browser storage
and Runtime KV are written independently, and startup keeps the newer snapshot
instead of allowing an older Runtime value to overwrite recent Workbench
selections.

## Capability defaults

The built-in `interactive.default` profile starts read-only. Mutating tools,
command execution, model/tool control, and external effects must be explicitly
enabled through the Workbench tool selector or an explicit request override.
There is no asynchronous Approval Provider yet; explicit enablement is a local
Run grant, not a production approval workflow.

## Terminal inventory context

Before the first model turn, the Terminal Manager runtime entry reads local-tools
`/sessions` and `/machines` and injects the same compact `<terminal_inventory>`
block used by its Workbench entry. Runtime Plugin Service activates the entry from
its manifest and contributes the Provider to Runtime Host; it is not part of
`@zion/runtime`. It includes only terminal sessions explicitly listed in the Run's
`allowedTerminalSessionIds`; a non-empty list filters the inventory strictly,
while an empty list includes all terminal sessions visible to the local tool
host.

The automatically injected XML is a bounded projection: at most 8 machines,
24 workspaces overall, and 12 workspaces per machine by default. Explicitly
allowed terminal sessions and their parent workspaces are retained even when
that raises a nominal limit; remaining entries prefer the local machine and
then recent activity. The XML reports included and total counts plus a
`truncated` flag. The `terminalInventory` tool remains untruncated within the
Run policy scope so omitted workspaces can be queried on demand.

Set Run metadata `includeTerminalContext` to `false` to disable the provider for a
specific Run. A session-list failure emits `context.failed` and does not terminate
the Run, matching the existing contributor isolation rule. Machine-profile failure
falls back to the normalized session data.

## Restart behavior

Completed history and ordered events survive restart. Runs left `queued` or
`running` without a live owner are marked `interrupted` with a new
`run.interrupted` event.

After every completed tool turn, Runtime saves the normalized transcript, aggregate
usage, tool-call counters, output, and next turn in a checkpoint. An interrupted,
aborted, or failed Run with a checkpoint can be resumed explicitly:

```bash
curl -X POST http://127.0.0.1:8766/v1/runs/<run-id>/resume \
  -H 'content-type: application/json' \
  -d '{}'
```

Resume preserves the Run ID, creates a new Attempt ID, and continues event sequence
numbering. Completed Runs and Runs without a checkpoint cannot be resumed. Runtime
does not automatically replay interrupted work because doing so could repeat
external side effects without user intent.

Session transcript projection is keyed by Run ID and message role, so completion
retries do not duplicate assistant messages. On startup, Runtime also repairs a
completed Run whose assistant output was committed before the process stopped but
had not yet been projected into its Session.
