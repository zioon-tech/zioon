# Runtime and local-tools boundary

Status: implemented in `feature/core-observability`.

## Decision

`zion-next` is the Workbench client. `apps/runtime` is the durable Agent host and
control plane. `zion-local-tools` is a private device capability service.

The ownership rule is:

- if state determines what an Agent should run, when it should run, which model
  it should use, or how its lifecycle resumes, Runtime owns it;
- if an operation touches a device resource such as a file, terminal, SSH host,
  mailbox, search provider, or MCP server, local-tools implements the atomic
  capability;
- Workbench owns presentation and local draft/projection state, not execution.

## Current ownership

| Concern | Owner | Implementation |
| --- | --- | --- |
| Model profiles and credentials | Runtime | `model-registry.mjs`, `model-profile-store.mjs`, `environment-credential-provider.mjs` |
| Provider network transport | Runtime | `openai-compatible-engine.ts`, restricted `/v1/model-gateway/proxy` compatibility route |
| Run, Attempt, Event, checkpoint | Runtime | `PostgresRunStore` |
| Runtime conversation transcript | Runtime | `runtime_sessions`, `runtime_session_messages` |
| Workbench session documents/tree/KV/revisions | Runtime | `PostgresWorkbenchStateStore`, `/v1/workbench-state/*` |
| Scheduled Task, occurrence, Run, lease, clock | Runtime | `PostgresSchedulerStore`, `/v1/scheduler/*` |
| Scheduled Agent and command execution | Runtime worker | `RuntimeSchedulerWorker` |
| Files, search, Bash, terminal, SSH, mail, MCP | local-tools | private tool HTTP endpoints |
| Device/resource discovery | local-tools or Device Connector | `/sessions`, `/machines`, Node protocol |
| Plugin packages and dev hot reload | standalone Plugin Host | `zion_local_tools.plugin_host`, port `8767` |

`local-tools` no longer owns application sessions, model transport, or Scheduler
state. Its old `/app-sessions`, `/scheduler`, and `/llm` routes are disabled by
default and can only be enabled temporarily with
`ZION_ENABLE_LEGACY_CONTROL_PLANE=1`.

## Runtime APIs

Workbench state:

```text
GET  /v1/workbench-state/status
GET  /v1/workbench-state/snapshot
PUT  /v1/workbench-state/snapshot
PUT  /v1/workbench-state/tree
GET  /v1/workbench-state/sessions/{id}
PUT  /v1/workbench-state/sessions/{id}
DELETE /v1/workbench-state/sessions/{id}
GET  /v1/workbench-state/sessions/{id}/revisions
POST /v1/workbench-state/sessions/{id}/restore
GET  /v1/workbench-state/kv/{key}
PUT  /v1/workbench-state/kv/{key}
POST /v1/workbench-state/migrate-browser-storage
```

Scheduler:

```text
GET/POST /v1/scheduler/tasks
GET/PUT/DELETE /v1/scheduler/tasks/{id}
POST /v1/scheduler/tasks/{id}/run
GET /v1/scheduler/runs
GET /v1/scheduler/runs/{id}
POST /v1/scheduler/runs/{id}/cancel
```

Claim, event append, and completion are internal Store operations used only by
the in-process Runtime worker; they are not public Workbench APIs.

Model compatibility:

```text
POST /v1/model-gateway/proxy?target={registered-or-allowlisted-url}
```

The model gateway is not an arbitrary URL proxy. It accepts only a registered
Model Profile endpoint or an explicit built-in provider host. When a matching
profile has a Runtime credential, that credential replaces browser-supplied
authorization.

## Migration

On first startup, Runtime can read the legacy local-tools session snapshot and
Scheduler records. Import markers make this idempotent. Subsequent startups read
only the lightweight legacy session revision and skip the large Scheduler export
after the first successful import.

The rollout order is:

1. Start new Runtime while legacy local-tools control-plane routes are available.
2. Verify Runtime reports `workbenchStateOwner=runtime` and
   `schedulerOwner=runtime`.
3. Verify document, task, and Run counts.
4. Point Workbench at `zion.runtime.baseUrl`.
5. Disable the legacy routes in local-tools.

The old PostgreSQL files are retained as rollback data and are never deleted by the
automatic migration.

## Tool execution

The same-machine Runtime Broker supports:

```text
read, glob, grep, tree, write, edit, Bash, webSearch, webFetch,
sendMail, todoWrite, mcpListTools, mcpCall
```

Runtime validates configured roots, terminal-session allowlists, command
prefixes, mail recipients, mail quotas, and policy presets before dispatch.
Empty root/session lists preserve permissive local read-only behavior; non-empty
lists enable strict enforcement. Device Connector bindings always narrow those
scopes before execution. local-tools applies its own sandbox at the device
boundary. Runtime stores a receipt keyed by deterministic `invocationId`, so
restart or retry replays a completed result instead of repeating a side effect.

`webFetch` is Runtime-native and rejects loopback, private, link-local, and
metadata targets. `todoWrite` is persisted in Runtime PostgreSQL. The remaining
capabilities are delegated to local-tools or an authenticated Device Connector.

`interactive.default` enables only read-oriented tools on a fresh or
non-user-managed profile. Enabling write, command, control-plane mutation, or
external-effect tools is an explicit persisted user choice. This is a local grant;
the asynchronous Approval Provider required for remote unattended mutation remains
a separate milestone.

File Artifact and ChangeSet records currently store bounded metadata and text
diffs in Runtime PostgreSQL. They are queryable projections, not the future external
binary Artifact Store.

Workbench never claims service-backed Scheduler Runs. Browser-only UI commands
remain available only to interactive browser execution and cannot be selected
for durable tasks.
