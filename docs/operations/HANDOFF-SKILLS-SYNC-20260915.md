# Handoff: Skills Sync / Workbench-Mobile Inconsistency

Last updated: 2026-09-15

## Current Production Entry

- Runtime public entry currently in use: `https://47-101-150-8.nip.io:8443/`
- Mobile entry: `https://47-101-150-8.nip.io:8443/mobile/`
- `runtime.zioon.tech` is still not the reliable entry because Alibaba Cloud returns ICP filing interception on the public domain path.

## Latest Production Deployment

Release: `skills-fix-20260915T001900Z`

Published changes:

- `extensions/dev.skills/main.js`
- `extensions/dev.skills/skills-runtime-state.js`
- `apps/runtime/src/skills-catalog-http-handler.mjs`
- `apps/runtime/tests/skills-catalog-http-handler.test.js`
- `tests/skills-runtime-state.test.js`
- rebuilt Workbench desktop dist
- rebuilt Mobile dist

Production verification after deploy:

- `zion-runtime`: active
- `caddy`: active
- `zion-local-tools`: active
- `zion-plugin-host`: active
- `zion-cloud-device-connector`: active
- Public health: `https://47-101-150-8.nip.io:8443/health` -> `200`
- Desktop entry: `https://47-101-150-8.nip.io:8443/` -> `200`
- Mobile entry: `https://47-101-150-8.nip.io:8443/mobile/` -> `200`
- AppleDouble files under deployed source/dist: `0`
- Remote staging `/tmp/zion-skills-fix-20260915T001900Z` removed.

Important production backup:

- `/var/lib/zion-next/backups/skills-fix-20260915T001900Z`
- Size observed after deploy: about `25M`

## What Was Fixed

The production error reported before this handoff included:

- `Device access approval required ... path is outside the active selected-roots scope`
- `[skills] snapshot persistence failed Error: Skills sync requires at least one source Node snapshot`
- `[skills] plugin skill sync failed Error: Unable to resolve one source Node for plugin skills`

Fixes made:

- Client no longer syncs a Runtime Skills snapshot if it has no source provenance.
- Runtime `/v1/skills/sync` treats an empty source snapshot as a no-op and preserves existing source snapshots.
- `dev.skills` now tries to infer `node_id` for legacy path-only entries from:
  - `skills.pathSources`
  - `skills.sources`
  - `skills.catalog`
  - `terminal.sessions`
  - `/v1/device-services/local-tools/sessions`
- In Runtime mode, unresolved path-only Skill directories are skipped with `source-node-unresolved` instead of scanning the wrong Node.
- Device access approval errors are collected as scan warnings and should not wipe existing Runtime Skill state.
- Plugin skill materialization failure no longer implies plugin Skills were deleted.

Local verification before deployment:

- `npx vitest run --exclude '.deploy-tmp/**' tests/skills-runtime-state.test.js`
- `npm --prefix apps/runtime test -- tests/skills-catalog-http-handler.test.js`
- `npm run build`
- `npm run build:mobile`

## Production Issue Discovered During Deploy

`zion-cloud-device-connector` restart initially failed with:

```text
Cannot find module '/opt/zion-next/apps/device-connector/src/main.mjs'
```

The actual file existed. Root cause was directory permissions:

- `/opt/zion-next` had become `700 zion:zion`
- `zion-worker` could not traverse `/opt/zion-next`
- Node reported this as `MODULE_NOT_FOUND`

Applied production fix:

```bash
chown -R zion:zion /opt/zion-next
find /opt/zion-next -type d -exec chmod u+rwx,go+rx {} +
find /opt/zion-next -type f -exec chmod u+rw,go+r {} +
systemctl restart zion-cloud-device-connector
```

Deployment script was also updated to preserve these permissions after source patch extraction and rollback.

## Workbench-Mobile Selected Skills Follow-up

Original report:

```text
Mobile says 11 selected skills, but Workbench desktop Skills panel shows 0 selected.
```

Status: investigated and deployed to production as `skills-sync-cleanup-20260914T174057Z`.

Root cause direction:

- Desktop Workbench could prefer a newer local browser snapshot for `skills.enabled` even when Runtime already had authoritative `catalog`/`sources`.
- That allowed a stale local `enabled: []` to render as 0 selected and risk being written back later.
- The client also still carried a legacy fallback from `/v1/skills/snapshot` to raw `/v1/workbench-state/kv/...`, which blurred the Runtime Skills API ownership boundary.
- The previous full-snapshot fingerprint mixed source state, enabled selection, UI settings, and volatile timestamps, making write decisions harder to reason about.

Follow-up local fixes:

- Runtime `/v1/skills/snapshot` is now the only Runtime read path for desktop Skills state; the old workbench-state KV read fallback was removed.
- Desktop restore now treats Runtime `catalog`, `sources`, and `enabled` as authoritative whenever Runtime has Skills state.
- Local browser snapshots may only contribute client-local fields and transient unsynced skill bodies during restore.
- Client write-back now uses two clear fingerprints:
  - source fingerprint: controls when `/v1/skills/sync` is needed
  - enabled fingerprint: controls when `PATCH /v1/skills/snapshot` is needed
- Runtime `/v1/skills/sync` no longer accepts incoming `enabled` as a way to overwrite existing shared state. Once Runtime has state, enabled Skills can only change through `PATCH /v1/skills/snapshot`.
- Newly discovered Skills remain enabled by default during source sync, preserving the current UX.

Verification after follow-up fix:

- `npx vitest run --exclude '.deploy-tmp/**' tests/skills-runtime-state.test.js`
- `npm --prefix apps/runtime test -- tests/skills-catalog-http-handler.test.js`
- `npm run build`

Build output now references desktop bundle:

- `dist/assets/extensions/dev.skills/main-DAX6O5Cw.js`

Production deployment verification:

- public `/health`: 200
- public `/mobile/`: 200
- unauthenticated `/v1/skills/snapshot`: 401
- active services: `zion-runtime`, `caddy`, `zion-local-tools`, `zion-plugin-host`, `zion-cloud-device-connector`
- remote staging directory removed
- AppleDouble files: 0

## First Checks For Next Agent

Use public entry:

```bash
curl -k -fsS https://47-101-150-8.nip.io:8443/health
```

Check Runtime source of truth:

```bash
curl -k -fsS https://47-101-150-8.nip.io:8443/v1/skills/snapshot
```

Expected focus:

- `snapshot.enabled.length`
- `snapshot.catalog.length`
- `snapshot.sources.length`
- whether `enabled` is empty in Runtime or only empty in desktop Workbench state

In browser devtools, compare desktop vs mobile:

```js
window.zion?.state?.get("skills.enabled")
window.zion?.state?.get("skills.catalog")?.length
window.zion?.state?.get("skills.sources")?.length
window.zion?.state?.get("runtime.skillsSync")
localStorage.getItem("zion.skills.snapshot.v1")
localStorage.getItem("zion.runtime.baseUrl")
localStorage.getItem("zion.runtime.mode")
```

Also confirm which plugin bundle is loaded:

- Desktop `dev.skills` bundle for the follow-up fix should contain:
  - `source-node-unresolved`
  - `no-source-snapshot`
  - `runtime.skillsSourceFingerprint`
  - `runtime.skillsEnabledFingerprint`

It should not contain:

- `/v1/workbench-state/kv`
- `runtime.skillsSnapshotFingerprint`

If the desktop page still loads an old bundle, hard-refresh or unregister the service worker for the current origin.

## Code Areas To Inspect

Primary:

- `extensions/dev.skills/main.js`
  - `restoreFromRuntimeIfAvailable`
  - `saveSnapshotSoon`
  - `scanAllSkillsWhileLocked`
  - `renderSkillsList`
  - `openSkillsPanel`
  - `registerStateListeners`
- `extensions/dev.skills/skills-runtime-state.js`
  - `selectNewestSkillsSnapshot`
  - `syncSkillsSnapshotToRuntime`
  - `persistSkillsSnapshot`
  - `applySkillsSnapshotToState`
- `apps/runtime/src/skills-catalog-http-handler.mjs`
  - `syncSkillsCatalog`
  - empty source snapshot no-op behavior

Mobile:

- `apps/mobile-client/src/MoreScreens.tsx`
- any mobile API code that reads Skills status or selected count

## Likely Fix Direction

Make Runtime `/v1/skills/snapshot` the authoritative source for enabled Skills in both Workbench and Mobile.

Recommended behavior:

- On desktop Workbench boot:
  - load Runtime snapshot first when Runtime backend is active
  - do not let empty local/browser snapshots overwrite non-empty Runtime `enabled`
  - if local state is newer but has no source provenance, treat it as transient UI-only and do not replace Runtime enabled/catalog
- On scan failure:
  - preserve prior `skills.enabled`
  - preserve prior Runtime snapshot
  - show scan warnings separately
- In panel render:
  - distinguish `0 selected because user disabled all` from `0 selected because Runtime snapshot has not loaded yet`

The first two bullets are now implemented locally. The panel loading-state distinction remains a possible UX improvement, not part of the minimal consistency fix.

## Deployment Notes

Deployment used Alibaba Cloud Cloud Assistant via `.deploy-tmp/alicloud-sdk/cloud.mjs`.

Credential handling:

- Temporary AK/SK was passed through process stdin/env only.
- No AK/SK file was intentionally written.
- No Workbench CLI config was recreated.
- User should revoke/delete the temporary AK/SK after deployment.

Do not use `runtime.zioon.tech` as the primary verification URL until ICP/domain routing is fixed.

## Subsequent UX Review (Not Deployed)

The follow-up review found that boot restore fixes alone did not provide live
cross-client freshness. Local changes now add foreground refresh, per-id
selection updates, acknowledged write coordination, immediate cancellable chat
preparation, and Runtime-owned durable assistant text.

See [RUNTIME-UX-REVIEW-20260915.md](./RUNTIME-UX-REVIEW-20260915.md) for the
current contract, verification evidence, filesystem-scan limitation, and release
requirements. This section describes local work, not the deployed release above.
