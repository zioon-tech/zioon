# @zion/runtime

Standalone, DOM-free execution core for Zion Runs.

This package is integrated with `zion-next` only through the Workbench
`RuntimeClient` adapter. It remains independently buildable and testable with
injected engines, Tool Hosts, context providers, timers, identifiers, and Run
storage.

## Boundary

The package owns:

- the multi-turn Agent execution state machine;
- OpenAI-compatible response and tool-call normalization behind an injected
  transport;
- ordered and durable `RunEvent` publication;
- tool authorization and invocation orchestration;
- cancellation, timeout integration, and terminal Run semantics;
- host-neutral contracts for engines, tools, context, Run storage, and durable
  Session transcripts.
- staged Context Providers with pre-once and post-per-turn lifecycle.

The package does not depend on:

- `window`, `document`, `navigator`, or browser storage;
- CodeMirror or Zion Workbench state;
- Zion plugin resources such as Terminal Inventory, Skills, or Memory;
- client compatibility fields such as Workbench `ts` and tool-call `args`;
- a concrete model SDK, HTTP transport, database, or Tool Host;
- UI cards, scrolling, panels, notifications, or Session projection.

## Commands

From the repository root:

```bash
npm exec -- tsc -p packages/runtime/tsconfig.json
npm test -- --run packages/runtime/tests/agent-engine.test.ts
```

## Current status

This is the host-neutral execution core. It includes protocol types, the Agent
executor, cancellation, an OpenAI-compatible Engine adapter, and an in-memory Run
Store. HTTP APIs, PostgreSQL, concrete network transports, Runtime plugins, and
Workbench compatibility remain outside this package and are composed by
`apps/runtime` or client adapters.
