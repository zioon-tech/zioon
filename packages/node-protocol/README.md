# @zion/node-protocol

Transport-neutral contracts shared by Runtime Host and Device Connectors.

Version 1 defines:

- Node registration with stable `nodeId` and ephemeral `instanceId`;
- versioned capability descriptors;
- opaque resource descriptors and optional `projectId` binding;
- `tool.invoke` commands with Runtime-issued lease deadlines;
- `tool.cancel` command envelopes;
- normalized Tool Results.

This package does not implement networking, persistence, scheduling, Agent
execution, or local tools. It also strips unknown resource fields so local paths
and connector-only configuration are not published to Runtime by accident.

Runtime Host owns invocation expiry and pending-state cleanup. Device Connector
checks `leaseExpiresAt` again before local execution so a delayed command cannot
start after its lease.
