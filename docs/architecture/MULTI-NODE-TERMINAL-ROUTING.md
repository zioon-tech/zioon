# Multi-Node Terminal Routing

Status: first milestone implemented locally, 2026-09-10. Not deployed.

## Scope

One Runtime can use several independent local-tools services through authenticated
Device Connectors. A local-tools service on the Runtime server is another Resource
Node, not an implicit fallback. No public deployment changes are part of this work.

Existing `session_id` parameters remain the execution handle for file and terminal
tools. A Runtime-issued reference identifies the Node, Connector instance, resource
binding, and native terminal ID. These references are routing data, not credentials.
Machine references are namespaced by Node. A Machine reached through SSH is not the
same thing as the Node providing that connection.

## Invariants

- Resolve the target before translating the global session ID to a native ID.
- Preserve both Run restrictions and the Connector's local grant.
- Never fall back to another Node when an explicit reference is offline or stale.
- Legacy native IDs are accepted only when the registered target is unambiguous,
  including offline registrations when determining ambiguity.
- Invalidate instance-bound references after Connector replacement. Rediscover the
  terminal instead of silently attaching an old reference to a replacement session.
- Do not replay reference-bound in-flight calls across Connector replacement.
  A delivered operation can have unknown side effects.
- Aggregate inventories with bounded request deadlines and per-Node error status.
  An unavailable Node must not prevent conversation or discovery of healthy Nodes.
- Runtime tools and Workbench HTTP relay use the same reference contract.
- Node labels, paths, and descriptions are untrusted data in model context.
- Project binding is an additional target constraint, not permission to access every
  resource on a Node. Conversation sessions remain owned by Runtime.

## First Milestone

1. Shared reference codec; precise Broker selection and policy translation.
2. Multi-Node terminal and machine inventory, management, and Workbench relay.
3. Bounded resource context, read-only node discovery, explicit create target.
4. Regression coverage for duplicate native IDs, offline targets, stale instances,
   cross-Node policy restrictions, partial inventory failure, and legacy operation.

Same-machine deployments without a Node Broker keep native IDs. Multi-Node mode
requires each local-tools instance to have its own Node ID and Connector. The
Connector instance is a conservative lifetime boundary, not a durable PTY generation.
Native session IDs must not be reused within that lifetime.

Runtime exposes one same-origin `/v1/device-services/*` surface in both modes.
Node mode routes it through the Broker; local mode proxies only configured
loopback services and uses the same terminal-management facade for inventory and
creation. A Runtime-backed Workbench must not fall through to a browser-side
`127.0.0.1` service or receive `404` merely because the Node gateway is disabled.

## Execution Contract

Terminal reference format:

```text
zterminal1:<encoded nodeId>:<encoded instanceId>:<encoded resourceId>:<encoded native sessionId>
zmachine1:<encoded nodeId>:<encoded native machineId>
```

Components are URI-encoded and validated canonically. References must be copied
verbatim from the inventory; clients must not truncate or construct them. Native
IDs are only presentation hints outside the Connector boundary.

1. `terminalInventory`, `terminalManage.list`, and the Workbench relay enumerate
   all eligible Node resource targets. The service uses at most four concurrent
   workers and a three-second deadline per target, returning partial results with
   `nodes[].status` (`online`, `offline`, or `unavailable`).
2. `read/write/edit/glob/grep/tree/Bash` accept a global `session_id`. NodeBroker
   resolves Node, instance, resource and project constraints before translating it
   to the native ID. It translates the Run terminal allowlist for that same target.
3. Delegated tools also expose `node_id` for operations without a terminal handle.
   When both `node_id` and `session_id` are provided, they must agree. `node_id` is
   consumed by Runtime and is not forwarded as a local-tools argument.
4. The Connector still receives Device protocol v1 and native local-tools IDs.
   There is no file replication, server-local fallback or implicit SSH migration.
5. A missing or ambiguous target fails before dispatch. Offline targets return
   HTTP 503; stale references and ambiguous targets return 409. A new Connector
   instance invalidates old terminal references. Reference-bound calls and
   mutating calls are not redelivered across instance replacement.
6. Machine/workspace grouping includes Node identity. Two `/workspace/project`
   directories on different Nodes never merge. Identical SSH addresses reached
   through different Nodes remain separate routes until identity is proven.
7. `terminalManage.create` accepts `node_id` and optionally `resource_id`, or
   resolves them from an existing machine/workspace. A Run constrained to specific
   terminal IDs cannot create a terminal to expand that allowlist.
8. `pluginsManage` accepts `node_id` for all five headless Host actions and rejects
   conflicts with the parent target. Omitting `devId` in `stopDev` stops sessions
   only on that selected Host; it is not a fleet-wide operation.
9. Nested plugin file calls preserve the parent target and terminal restriction.
   An explicit terminal outside the parent allowlist is rejected. If no terminal
   is specified, the only allowed terminal may be used; several allowed terminals
   require an explicit selection. An empty parent allowlist retains the existing
   unrestricted-by-terminal semantics, still subject to Device grants and routing.

## Workbench and Model Context

The existing terminal manager is the first UI, not a new competing node directory:

- creation has an execution-Node selector;
- machine and terminal labels identify their Node;
- native ID hints keep rows short, while commands and tooltips retain global IDs;
- terminal lifecycle, file relay and PTY route paths resolve through NodeBroker;
- current browser-wide active terminal is not an implicit cross-Node routing grant.

The Runtime terminal Context Provider reads the shared inventory before each
model turn, including resumed turns. It replaces only its own tagged context
message; it does not append multiple inventories or rewrite conversation messages.
The prompt contains bounded machine/workspace summaries, exact preferred terminal
references and Node availability, with instructions not to treat same-named
workspaces as replicas. User-controlled descriptions are escaped as data.

`terminalInventory` already provides read-only Node discovery in `nodes[]`; a
separate `nodeInventory` tool is intentionally unnecessary in this milestone.
The Workbench interactive request now forwards an explicitly provided `projectId`.
Automatic per-conversation Project/Workspace binding and a picker remain deferred.

## Deployment and Compatibility

Run local-tools and a separately paired Connector on each machine, including the
Runtime server if it needs always-on execution. Give each Connector a distinct
stable `--node-id`, a local `--workspace-root`, and an explicit project/resource
association. Keep the Python service private; expose only the authenticated Runtime
gateway. SSH machines can host a Connector themselves or be reached from an
authorized always-on Node; neither option copies credentials off an offline laptop.

Deploy Runtime and Workbench together and refresh old pages. Old browser builds
can truncate long IDs or display a single-host inventory. Existing raw IDs in
scheduled policies should be replaced by current global references before adding a
second Node. A restart then requires rediscovery and explicit policy rebinding;
durable generation-independent terminal handles are a later milestone.

The shipped Connector still advertises one workspace binding. The reference format
can identify multiple bindings, but a v1 internal service advertises Node-level
inventory, not verified per-resource terminal ownership. Do not treat registering
several bindings on one Connector as an isolation boundary. Device local grants
remain authoritative; multi-resource service isolation and tenant authorization
need their own protocol work.

## Verification

- New unit cases: 40 across the initial routing scope, plugin follow-up, and local
  Runtime relay compatibility. The
  initial two routing failures and the plugin follow-up's fifteen failures were
  preserved as evidence and fixed in the implementation phase; unchanged
  assertions now pass. See `MULTI-NODE-PLUGIN-VERIFICATION.md` for the follow-up.
- HTTP integration: two real Connector instances, independent fixture HTTP
  services and temporary directories sharing the same native terminal ID.
  Exercises read/write/edit, an actual `pwd` subprocess, relay file writes,
  terminal lifecycle, scoped model context, replacement of context, denial of
  grant expansion, and offline failure without cross-Node writes.
- This fixture is not the Python local-tools server and does not claim an actual
  SSH, production authentication, or cross-host WebRTC acceptance test.
- Full local suites: Runtime Host 272, Connector 28, Runtime Core 22, Node
  protocol 7; selected Workbench/compatibility tests 84. Total: 413 passing.
- Runtime TypeScript build and diff whitespace checks pass.
- Build Runtime Core before starting Host tests: its build deletes `dist` before
  compiling, so running these two operations concurrently can produce transient
  missing-module failures. The final Host suite passed after the build completed.
- Browser verification confirmed both Nodes and creation exclusively on the
  selected cloud fixture Node, required Node selection, and short terminal labels
  retaining full global references. The 379px-wide sidebar had no horizontal
  overflow. Verification uses accessibility snapshots and DOM measurements, not a
  completed screenshot-based desktop/mobile visual acceptance.
- Local Workbench verification against Runtime `8766` confirmed the relay returns
  the local inventory instead of `404`: six machines and 210 sessions were loaded,
  with 191 available and 19 disconnected sessions displayed.
- The terminal sidebar is mounted from production sources via
  `node scripts/verify-multi-node-ui.mjs` on port 5194 (or the next free port). It
  touches only temporary fixture resources. The harness supplies dummy Workbench
  commands: creation and directory interactions are real fixture operations, but
  opening PTYs or attaching terminals to conversations is not a complete
  Workbench workflow on this page.
- Full Workbench build currently fails in the unrelated
  `extensions/dev.byteintl-model/byteintl-adapter.js`: Node-only imports such as
  `node:url` are pulled into the browser bundle. That plugin was not modified.
- The unit-test helper's `utree flush` was attempted but its external cache/report
  writes were blocked by the sandbox. Vitest results above are independently
  available; no coverage percentage is claimed.

## Scheduler Node Selection

Scheduler tasks expose only a stable `nodeId`:

- Agent tasks may leave `nodeId` empty. The scheduled interaction profile injects
  terminal inventory, identity, skills, and memory so the model can select a Node.
- Agent tasks may set `nodeId`; Runtime then copies it to
  `RunRequest.target.nodeId` and every tool invocation. The model cannot redirect
  that Run to another Node.
- Command tasks must set `nodeId` because no model runs before the Bash invocation.
- Tasks do not store `resourceId` or a terminal id for ordinary Node selection.
  Runtime resolves the selected Node's current internal resource binding.
- If a selected Node is absent or offline, routing fails closed. It does not run
  the task on another Node.

## Deferred Milestones

Persistent `waiting_for_resource`, durable dispatch/Device receipts, resource
replicas and revision-aware migration, full Project resource pickers, tenant Spaces,
and a standalone node administration plugin are subsequent changes. The first
milestone fails closed with actionable errors rather than claiming those features.
Their staged implementation order, scale triggers, compatibility rules, and exit
criteria are defined in
[NODE-CONTROL-PLANE-ROADMAP.md](./NODE-CONTROL-PLANE-ROADMAP.md).

Next acceptance sequence:

1. Install two real local-tools/Connector pairs and validate SSH, PTY, credential
   revocation and filesystem access using actual Device grants.
2. Persist per-conversation resource bindings without using global active-terminal
   state. Add durable terminal generations and policy migration.
3. Add durable dispatch/receipts and `waiting_for_resource`; only then implement
   automatic resume after uncertain side effects have been reconciled.
