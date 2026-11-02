# Workbench interaction corrections

Release: `workbench-ux-corrections-20261012`.

Target: ECS `i-uf6dkbxlai8d1zr81859`, `cn-shanghai`, public origin `https://47-101-150-8.nip.io:8443`.

## Changes

- Removed the duplicate sessions sidebar search; the existing activity search remains available.
- Replaced the load-more button with automatic 100-row batches near the scroll bottom. Rendering preserves scroll position, coalesces requests per animation frame and cancels callbacks on disposal.
- Removed synthetic assistant preparation text while preserving preparation cancellation.
- Prepared seed history concurrently with contributor-enriched history. Their distinct message content remains intact.

## Validation

Five related test files: **55/55 passed**. Added two chat preparation cases and revised the automatic-scroll scenario. Scope covers list/sidebar behavior, history separation, cancellation and Runtime request construction. No additional correctness defects were identified for this correction. Coverage statistics were not requested.

`npm run build:all` succeeded for desktop and mobile. `git diff --check` passed. The required `utree flush` helper was executed but sandbox restrictions prevented its external-directory writes; no generated helper report is claimed.

## Latency evidence and limits

Controlled local preparation probe: two 100ms history dependencies previously took 200ms sequentially; concurrent preparation took 105ms. This is a dependency experiment, not production latency.

Existing production events from the last 24 hours contained one Workbench run with a first reasoning marker: 1561ms from run creation to model request, then 5441ms to `reasoning.started`, totaling 7002ms. No model invocation was created for this investigation. The sample excludes frontend click/save/sync preparation and cannot establish population performance or exact first-token latency. Model-stage projection records were absent. Full response-delay resolution remains unverified.

Temporary network instrumentation remains disabled unless `debug.chatSubmitUrl` is explicitly set. No localhost reporting is enabled by default.

## Deployment

Frontend source patch and desktop/mobile build; Runtime restart disabled. Rollback path: `/var/lib/zion-next/backups/workbench-ux-corrections-20261012`.

Source archive SHA-256: `1f0cfce45b23ea3ec8f6e4a2ff00b518cc7f0b69f4f2873391d77e0123ecf4c4`.

Dist archive SHA-256: `c8efafe3b1dffe64289fb92496309d0940e3cc00c9065085f6761850f1524f38`.

Deployment status: **published and verified**. Four source hashes and desktop/mobile/worker hashes match local files. Public desktop, mobile, worker, chat bundle, sessions bundle and health all return HTTP 200; fetched content hashes match the build. Runtime and Caddy are active, rollback backup exists, and the remote staging directory was removed and its absence confirmed.
