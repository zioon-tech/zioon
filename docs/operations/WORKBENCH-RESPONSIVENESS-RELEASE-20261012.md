# Workbench responsiveness release

Release: `workbench-responsiveness-20261012`

Target: ECS `i-uf6dkbxlai8d1zr81859`, `cn-shanghai`, public origin `https://47-101-150-8.nip.io:8443`.

Published the Workbench responsiveness source patch and desktop/mobile build. Runtime restarted successfully; no database schema or credential changes. All 23 deployed source files and three entry/worker files match the local release hashes.

Verification:

- Runtime and Caddy active; desktop, mobile and health return HTTP 200.
- Public desktop/mobile entries and worker helper match local files.
- Anonymous search returns HTTP 401.
- Read-only queries against existing production data verified catalog metadata limit 2 and search limit 2.
- Worker helper announces update availability and contains no `client.navigate`.
- Remote staging directory removed and absence confirmed.

Rollback backup: `/var/lib/zion-next/backups/workbench-responsiveness-20261012`.

Source archive SHA-256: `e4b252a704370b7f658633006a1aa8497706149b0d0673e6aacfaa4acf8e2c39`.

Dist archive SHA-256: `45d9e80d8142985390c42c7f4921b5525b2002b44bfa9a4eb64036182d08b038`.

Desktop index SHA-256: `0e2e37b71b1a2533c60bc9c74f8dc88256b32560e092f9fb65c1fcaef61f91d5`.

Mobile index SHA-256: `216909f24b9ea60dee9087ccbeb57179bff4c483880aaceeceb618d55c718b4b`.

Worker helper SHA-256: `2f26a045873382d2f9e949dec86a7ca3b02aee08c20b4c1470195928a081b074`.

Credentials supplied for this operation were passed through subprocess stdin, never written to configuration or release files.

Interactive verification remains with the owner. Save existing input and reopen the Workbench to ensure the new frontend is loaded. Complete catalog pagination and measured production first-token latency remain outside this patch; see `docs/architecture/WORKBENCH-RESPONSIVENESS.md`.
