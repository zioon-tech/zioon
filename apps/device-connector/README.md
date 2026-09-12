# Zion Device Connector

Outbound adapter between a Runtime Host and one local `zion-local-tools`
instance.

The Connector is a separate process and responsibility:

```text
Runtime Host
  -> authenticated long poll
    -> Device Connector
      -> loopback HTTP
        -> zion-local-tools
```

It does not own Runs, Sessions, model execution, or local tool implementations.
It registers a Node capability snapshot, receives Tool Invocations, invokes the
local Tool Host, and returns normalized results.

## Current checkpoint

- Device protocol version 1;
- explicit Node and process-instance identity;
- one-time Resource pairing and per-device bearer authentication;
- project-to-resource advertisement without local filesystem paths;
- the local-tools file, command, search, mail, and MCP capability catalog;
- an Owner-only, allowlisted service relay for Skills, terminal management,
  interactive PTY streams, and local development plugin assets;
- cancellation propagation;
- Runtime-issued invocation deadline validation before local execution;
- in-process Device result receipts for duplicate delivery;
- Runtime-side completed receipts and project bindings persisted in SQLite;
- reconnect redelivery within the same instance; reference-bound and mutating
  invocations fail closed when a replacement instance registers.

Control messages and fallback traffic use authenticated HTTP long polling.
Interactive PTY sessions negotiate an encrypted WebRTC DataChannel through the
same authenticated Device Service; if ICE negotiation fails, Workbench falls
back to the HTTP relay automatically.

## Pair for remote access

Create a short-lived Resource invitation on the Runtime host:

```bash
npm run runtime:access -- pair create \
  --kind resource \
  --delivery bearer
```

Use the printed code once on the machine that owns the project:

```bash
npm run device:connect -- \
  --runtime-url https://zion.example.com \
  --pairing-code XXXX-XXXX-XXXX \
  --plugin-service-url http://127.0.0.1:8767
```

The Connector exchanges the code for a credential bound to
`node:macbook`. On macOS it stores the credential in Keychain; other platforms
use `~/.zion-next/device-credentials.json` with mode `0600`. Later starts reuse
that credential. By default it uses the directory where the user invoked npm
(`INIT_CWD`) as the workspace, derives the project/resource IDs, and reuses or
creates a matching local terminal session. Remote Runtime URLs must use HTTPS.
The workspace root, `~/.zion-next/skills`, and `~/.zion-next/memory` are the
default Device file grants. Additional grants must be explicit:

```bash
npm run device:connect -- \
  --runtime-url https://zion.example.com \
  --access-scope registered-projects \
  --additional-roots /absolute/path/one,/absolute/path/two
```

Active local terminal sessions under the workspace or any additional root are
authorized together with that root. Both absolute paths and `~/...` paths are
accepted.

The Device access policy is managed by an Owner in Workbench under
`Settings > Devices & Remote Access > Agent Project Access` and is persisted to
`~/.zion-next/device-access.json` with mode `0600`. Changes take effect on the
next tool invocation without restarting the Connector. Supported scopes are:

- `workspace`: the Connector workspace plus built-in Skills and Memory roots.
- `registered-projects`: every active local or SSH terminal workspace, resolved
  to its nearest Git root when available.
- `selected-roots`: the base roots plus explicitly approved directories.
- `home`: the current user's home directory, while sensitive roots remain
  approval-gated.

`ZION_NODE_ADDITIONAL_ROOTS` remains a bootstrap default for first startup;
after the policy file is created, use Workbench to manage explicit roots.

For macOS background operation, use
`deploy/launchd/dev.zion.device-connector.plist.example`. The LaunchAgent reads
the Device credential from the login Keychain and contains no bearer secret.

## Legacy local mode

Start Runtime in explicit Node tool mode:

```bash
ZION_RUNTIME_NODE_TOKEN=<shared-development-token> \
ZION_RUNTIME_TOOL_MODE=node \
npm run runtime:serve -- --runtime-plugins none
```

Start the Connector on the machine that owns the project:

```bash
ZION_DEVICE_TOKEN=<shared-development-token> \
ZION_NODE_ID=node:macbook \
ZION_NODE_PROJECT_ID=zion-next \
ZION_NODE_RESOURCE_ID=workspace:zion-next \
ZION_NODE_WORKSPACE_ROOT=/absolute/path/to/zion-next \
ZION_NODE_TERMINAL_SESSION_IDS=<local-tools-session-id> \
npm run device:connect -- \
  --runtime-url http://127.0.0.1:8766 \
  --local-tools-url http://127.0.0.1:8765
```

`ZION_DEVICE_TOKEN` and `ZION_RUNTIME_NODE_TOKEN` must match. Tokens are read
from the environment and are not included in health responses or logs.
`ZION_NODE_WORKSPACE_ROOT` and `ZION_NODE_TERMINAL_SESSION_IDS` are Device-local
authorization settings and are never included in Node registration. Runtime sees
only the opaque `ZION_NODE_RESOURCE_ID` and its project association.

## Multiple Nodes

Each local-tools instance needs a distinct Connector Node ID, even when it runs
on the Runtime server. Pair each Node separately; do not share Resource credentials.
Keep Runtime in `node` tool mode and enable `dev.terminal-manager`.

```bash
npm run device:connect -- \
  --runtime-url https://zion.example.com \
  --node-id node:cloud-workspace \
  --workspace-root /srv/workspaces/zion-next \
  --project-id zion-next \
  --resource-id workspace:cloud-zion-next \
  --pairing-code XXXX-XXXX-XXXX
```

The Python local-tools service must already be running on that machine. Use a
restricted execution account or isolated container; do not give Agent tools access
to the Runtime database or model credentials simply because they share a server.

Runtime and Workbench now return global terminal `session_id` values. These select
the Node and its native terminal together. Tools without a terminal handle can
select `node_id` explicitly. Inventory and creation use the existing terminal
manager, including a Node selector. An offline laptop is never silently replaced
by the server's terminal or same-named directory.

References are scoped to the Connector instance: refresh inventory and rebind
restricted Run/Scheduler policies after a Connector replacement. A second Node
makes legacy unqualified IDs ambiguous, including when either Node is offline.
There is no automatic file synchronization or durable wait-and-resume yet.

See [Multi-Node Terminal Routing](../../docs/architecture/MULTI-NODE-TERMINAL-ROUTING.md)
for the first milestone, validation evidence, and remaining isolation boundaries.

## Security boundary

The shared static-token path is for loopback and private tests only. Remote
Access-Control mode uses one-time pairing, per-device credentials, TLS, expiry,
and device-level revocation. Device-held proof-of-possession keys, automatic
rotation, remote Approval, and durable Device-side receipts remain later
milestones.

The current Runtime persists accepted invocation receipts, Device registrations,
and project/resource bindings. The Connector's local receipt cache remains
process-local, and an invocation that finished locally but was never accepted by
Runtime can therefore execute again after both processes restart. Mutating and
external-effect tools are advertised but remain unusable unless the Run carries
the required Runtime preset and explicit scopes. The Device Host then intersects
those scopes with its configured local grants.

The Runtime forwards the Run's existing absolute `fileRoots` and translates
global terminal references and terminal allowlists to IDs native to the selected
Node for compatibility with the current Agent tool schema.
Before each call, Device Host intersects those scopes with its local resource
binding and rejects an unknown resource, disjoint root, disjoint session, or
tool absent from the final allowlist. Runtime therefore cannot expand Device
permissions. A later resource-relative tool schema should remove local paths and
session IDs from Runtime-visible policy entirely.
