# @zion/local-tools-client

Reusable loopback adapter for the existing `zion-local-tools` HTTP service.

It owns the device capability schemas, request mapping, and policy checks for:

- `read`
- `glob`
- `grep`
- `tree`
- `write`
- `edit`
- `Bash`
- `webSearch`
- `sendMail`
- scoped MCP listing and calls

Both same-machine Runtime Host and Device Connector use this adapter. It is
separate from `@zion/runtime` because local-tools endpoints, terminal session
IDs, filesystem roots, and HTTP transport are host integration details.

`LocalToolsBroker` enforces file roots, terminal session grants, command prefixes,
mail recipients, and policy presets before calling local-tools.
`LocalToolsReadOnlyBroker` remains as a compatibility facade.
`LocalToolsDeviceHost` additionally resolves an opaque `resourceId` to
Device-local roots and terminal sessions, intersects those grants with the
Runtime policy, and only then delegates to the loopback broker.
