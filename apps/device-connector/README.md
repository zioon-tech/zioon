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
- bearer-authenticated outbound registration and polling;
- project-to-resource advertisement without local filesystem paths;
- the local-tools file, command, search, mail, and MCP capability catalog;
- cancellation propagation;
- Runtime-issued invocation deadline validation before local execution;
- in-process Device result receipts for duplicate delivery;
- Runtime-side completed receipts and project bindings persisted in SQLite;
- reconnect redelivery from Runtime when a new instance registers.

The transport is authenticated HTTP long polling so the first distributed
vertical slice has no WebSocket server dependency. The command protocol is
transport-neutral and can later move to WebSocket, HTTP/2, or a relay.

## Run locally

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

## Security boundary

This checkpoint is for loopback and private test environments. A static bearer
token is not sufficient for public deployment. Production remote access still
requires device pairing, per-device keys, TLS, token rotation, revocation,
signed capability leases, approval, and durable Device-side receipts.

The current Runtime persists accepted invocation receipts, Device registrations,
and project/resource bindings. The Connector's local receipt cache remains
process-local, and an invocation that finished locally but was never accepted by
Runtime can therefore execute again after both processes restart. Mutating and
external-effect tools are advertised but remain unusable unless the Run carries
the required Runtime preset and explicit scopes. The Device Host then intersects
those scopes with its configured local grants.

The Runtime currently forwards the Run's existing absolute `fileRoots` and
terminal session IDs for compatibility with the current Agent tool schema.
Before each call, Device Host intersects those scopes with its local resource
binding and rejects an unknown resource, disjoint root, disjoint session, or
tool absent from the final allowlist. Runtime therefore cannot expand Device
permissions. A later resource-relative tool schema should remove local paths and
session IDs from Runtime-visible policy entirely.
