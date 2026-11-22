# Shared readers use the Workbench editor surface

`/share/:link` and `/shared?space=…&document=…` mount the same `createEditorPanelSurface`, `EditorCore`, `PanelManager` and header components as Workbench. The reading adapters provide projected document snapshots and read-only capabilities. Original TOC, search, role navigation, overview rail, sticky user header, grouped settings menu, editor configuration and typography controls are shared implementations.

Display preferences use an explicit allowlist and the current viewer's storage namespace. Native and reader document aliases resolve to the same opaque document identity for per-document Minimap settings. Changes propagate between panels and same-origin browser tabs. This does not introduce a cloud preference sync service.

The original participant header renderer consumes authorized presence sources. Runtime merges authenticated, reauthorized collaboration sockets with short-lived reading leases, deduplicating accounts across tabs and panels. Every reading page registers once, renews every 15 seconds and expires after 45 seconds. Closing a split does not close the page visit.

Public readers show document-scoped display IDs and generic visitor names; authorized readers show trusted names. The public endpoint does not disclose the authorization roster, email, account ID or private Runtime state. Registration and renewal validate Origin, browser binding, session, document authorization and link revision. Collection is bounded and authorization is rechecked before delivery.

Readers remain read-only regardless of Vim operational mode. The authorized reader retains document comments according to existing permissions. Content revocation clears every panel and comments. The Workbench collaboration client intersects host permissions with current server authorization and cannot regain editing through a late synchronization callback.

Local validation on 2026-11-23:

- Workbench: 193 suites, 1237 checks passed; 7 optional preview checks skipped in the default run.
- Actual persistent preview: 6 suites, 7 checks passed separately.
- Complete `runtime:test`: 1112 checks passed; 1 environment-dependent check skipped.
- Runtime and Workbench production builds passed.
- 109 actual built reader modules executed in an isolated DOM, covering native header, search, splits, closing, read-only behavior and one page visit.
- Full TypeScript check still reports the 25 pre-existing diagnostics; it is not a clean typecheck.

No browser UI automation was used. DOM and delivered-build checks do not establish pixel, touch or scrolling feel acceptance. Production publication uses successful main-branch CI artifacts and separate release receipts.
