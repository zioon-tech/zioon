# Mobile Client Implementation

> Status: implementation baseline
> Date: 2026-09-07

## Boundary

The Mobile Client is an independent React application under
`apps/mobile-client`. It does not import Desktop Workbench source, extensions,
CodeMirror, PanelManager, or browser-owned Agent execution.

It shares only Runtime HTTP contracts and same-origin access authentication:

```text
/               Desktop Workbench
/mobile/        Mobile Client
/v1/*           Runtime APIs
```

The production build is emitted into `<workbench-dist>/mobile`. Runtime static
hosting recognizes `/mobile/` as a nested SPA while preserving the Desktop
Workbench fallback for every other route.

## Runtime contracts

The first implementation consumes existing stable endpoints:

- access: `/health`, `/v1/access/*`;
- sessions: `/v1/sessions`, `/messages`, `/transcript`, `/active-run`;
- runs: `/v1/runs/:id`, `/projection/stream`, `/abort`, `/artifacts`;
- work: `/v1/todo-lists`, `/v1/scheduler/*`;
- models and policy: `/v1/models`, `/v1/interaction-profiles`,
  `/v1/capabilities/tools`;
- devices: `/v1/access/devices`, `/v1/device-nodes`;
- Resource Host services: `/v1/device-services/local-tools/*` and
  `/v1/device-services/plugin-service/*`.

No Mobile endpoint reads or writes a Workbench document. Messages are submitted
through the Runtime Session message command and rendered from canonical
transcript plus the active Run projection.

## State ownership

| State | Owner |
| --- | --- |
| Session, message, Run, event, artifact | Runtime |
| Model profile and interaction policy | Runtime |
| Scheduler and Todo | Runtime |
| Terminal and files | Resource Host through Runtime |
| Pairing and devices | Runtime Access Control |
| Current route, draft and display preference | Mobile Client |

React Query owns server cache and invalidation. Local storage is restricted to
drafts, generated Mobile device id, and non-authoritative UI preferences.

## Failure behavior

- `401`: return to the pairing gate without deleting the local draft;
- `403`: show an explicit permission-limited state;
- `409` on message send: attach the Session active Run instead of creating a
  duplicate;
- projection disconnect: resume from the last source sequence;
- Runtime unavailable: keep the application shell and expose retry;
- Resource Host offline: conversation remains available while terminal and file
  pages show a resource-specific unavailable state.

## Delivery

```bash
npm run build
npm run build:mobile -- --outDir /path/to/workbench-dist/mobile
```

`remote:start` performs both builds automatically unless `--skip-build` is
used. Existing Desktop build output remains untouched by Mobile source code.
