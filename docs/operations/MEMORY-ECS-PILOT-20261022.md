# Memory ECS trial — 2026-10-22

## Deployment

- Instance: `i-uf6dkbxlai8d1zr81859`, `cn-shanghai`, `47.101.150.8`.
- Public endpoint: `https://runtime.zioon.tech/memory`.
- Health: `/memory/health`; readiness: `/memory/ready`.
- Service: `zion-memory.service`, enabled at boot, restart on failure.
- Bind: `127.0.0.1:18991`; Caddy strips the public `/memory` prefix.
- Code: `/opt/zion-memory/apps/memory-service`.
- Upstream: `/opt/agent-fs`, clean checkout of
  `aecd4c83606f45325daece46b01f0c38ad2cc0ed`, version `0.18.5`.
- Bun: `/opt/bun-1.4.1/bun`.
- Metadata: `/var/lib/zion-memory/data/agent-fs.db`.
- Versioned bytes: `/var/lib/zion-memory/objects`, persistent ECS local disk.
- Settings: `/etc/zion-memory/service.env`.
- Account validation: production Runtime `/v1/account/me` over loopback.
- Public MCP: `/memory/mcp` returns 404.

SQLite uses `synchronous=FULL`. The service serializes each account's requests
across the upstream CLI and shared file API. It runs one process with
384 MiB soft and 512 MiB hard memory limits. Observed idle RSS was about
75–92 MiB without embedding models.

The existing production Runtime was not replaced or restarted. Its health
check passed after deployment, and the existing ADC, legacy hostnames and
OAuth callback routes were retained.

## Acceptance

The actual upstream CLI used a short-lived, real Zion session. These checks
passed through the public HTTPS endpoint:

1. Readiness returns 200 and `ok: true`.
2. Invalid account credentials return 401.
3. Shared file API writes are read correctly by the upstream CLI.
4. CLI writes are read correctly by the shared file API.
5. An incorrect expected content hash returns 409.
6. Written content survives a `zion-memory.service` restart.
7. CLI deletion removes the live file.
8. Public MCP requests return 404.

Probe paths were unique and removed. Temporary verification sessions were
deleted after each run. The shared file API check does not imply that the
production Runtime Identity panel has already been connected to this service.

## Sandbox CLI

An isolated first-generation `code-interpreter-v1` sandbox successfully
installed Bun 1.4.1 and upstream CLI 0.18.5, then performed authenticated
HTTPS write/read/delete against this ECS service. Both temporary test
sandboxes were deleted, including the first failed installation attempt.
Their verification account sessions were removed.

The successful installation explicitly installs Bun's platform binary so
`--omit=optional` does not remove the executable:

```bash
npm install --prefix /tmp/zion-cli --ignore-scripts --omit=optional \
  @oven/bun-linux-x64@1.4.1 @desplega.ai/agent-fs@0.18.5
export PATH="/tmp/zion-cli/node_modules/@oven/bun-linux-x64/bin:/tmp/zion-cli/node_modules/.bin:$PATH"
```

Configure `AGENT_FS_API_URL=https://runtime.zioon.tech/memory` and complete
Zion device login with [the login helper](../../scripts/agentfs-login.mjs).
The CLI's API credential is the resulting Zion session.
`/memory/dev.identity` remains a logical agent-fs path; it is not a native
directory in the sandbox unless a filesystem mount is separately configured.

## Second-generation egress repair

Two cloud changes succeeded on 2026-10-22:

- FC function `micro-sandbox-a650d94a8a-zionpoca-06cc2c1d04828417` now has
  `internetAccess=true`, verified through `fcv3.cn-shanghai.aliyuncs.com`.
  The existing VPC configuration was retained.
- Security group `sg-uf6d0rkzvmmo2eqfs73k` now allows outbound traffic to
  `0.0.0.0/0`, rule `sgr-uf68em9tfrisxipargy5`, priority 100.
  Existing NAS and DNS rules were retained.

**Public access is now restored on the bound second-generation workspace.**
The cloud changes above alone were insufficient: actual TCP requests still
timed out on the old instance and on two disposable instances from the same
template. Both disposable instances were removed.

The operator attached the [prepared RAM policy](../../deploy/sandbox/template-network-operator-policy.json).
Native `GetTemplate` then returned 200 and confirmed the intended template,
Team, generation 2 and `runtimeConfig.internetAccess=false`. `UpdateTemplate`
changed only this setting to `true` and returned 200. The template reached
`ready` at `2026-10-22T09:11:44.742126Z`; CPU, memory and image stayed unchanged.
The policy uses the `sandbox` namespace for the actual `2026-08-20` API.

A disposable instance created after this update successfully reached npm and
the ECS `/memory/ready` endpoint. It was removed afterwards. The previous
paused instance still timed out after resume and an SDK network update, so
its existing network configuration could not be repaired in place.

After confirming no active operation or terminal, the authenticated Runtime
`POST /v1/sandbox/workspace/release` terminated only that old VM. The normal
Sandbox broker recreated it with the same account/workspace/NAS binding.
New instance: `sbx-26ed6aa0-68e1-4bf3-b5f2-452d36d757fb`, epoch 25.
The `/workspace` mount remains NFS and `/root` is the persistent
`/workspace/.zion/home` bind mount. SHA-256 hashes of `.bashrc`, `.profile` and
`.config/zion/env.sh` matched before and after recreation.

On the recreated workspace, npm package metadata and ECS Memory readiness
returned 200 over HTTPS. `www.aliyun.com` returned HTTP 403 from the site
with a successful TCP/TLS connection; that response is not an egress failure.
An initial acceptance assertion requiring every site to return 200 failed for
this reason and was corrected to distinguish transport from application status.

The E2B-compatible sandbox-info response still reports
`allowInternetAccess=false` and `denyOut=["0.0.0.0/0"]` even on instances with
successful public HTTPS requests. These fields do not reliably reflect the
template's effective platform exit in this deployment. Use native template
configuration plus actual requests to verify public connectivity.

No account reassignment was performed. No NAT gateway was purchased:
the enabled template setting uses the platform's public exit.

References:
- [Template API and its RAM actions, updated 2026-10-16](https://help.aliyun.com/zh/agent-sandbox/build-and-manage-custom-templates-with-code).
- [VPC and platform internet access, updated 2026-10-15](https://help.aliyun.com/zh/agent-sandbox/vpc-network-configuration-1/).

## Second-generation persistent CLI

The bound workspace installed upstream CLI 0.18.5 and Bun 1.4.1 successfully.
Installing expanded npm dependencies directly on the NAS-backed home first
returned `EDQUOT`. The successful installation staged dependencies and the npm
cache on `/tmp`, then saved the following files on persistent NAS:

- Bun executable: `/root/.bun/bin/bun`.
- CLI entry wrapper: `/root/.local/bin/agent-fs`.
- Dependency archive:
  `/root/.local/share/zion-agent-fs-cli-0.18.5/cli.tar.gz`.
- Archive SHA-256:
  `ec4b6542197cb0806f6eef4738561f51b4abad895035fd93afe70b19c192fa31`.
- Archive size: 53,904,828 bytes, about 51.4 MiB.
- Device-login helper: `/root/.local/bin/zion-agentfs-login`.
- Client configuration: `/root/.agent-fs/config.json`, mode `0600`.
- Endpoint in the persistent shell environment:
  `AGENT_FS_API_URL=https://runtime.zioon.tech/memory`.

The wrapper restores its dependencies from the verified archive into
`/tmp/zion-agent-fs-cli-<archive-hash-prefix>` when the temporary cache is absent.
It uses an atomic directory move so concurrent startup cannot expose a partial
extraction. Restoring the CLI requires no npm download.

After a confirmed pause, the normal Sandbox broker resumed the same instance.
Both executables ran from `PATH` with the expected versions, Memory readiness
returned 200, and a CLI request with an intentionally invalid token received
`Zion authentication or permission check failed`. The configuration retained
mode `0600`; `.bashrc` and `.profile` hashes were unchanged.

Deleting only the installed CLI's temporary extraction cache, then launching two
CLI processes concurrently, successfully restored version 0.18.5 in both
processes. Hashes of the persistent Bun, wrapper, account configuration and
archive were unchanged. After another confirmed pause/resume, versions,
readiness and the expected authentication rejection passed again. Temporary
installer files, the staging archive and the task's npm cache were removed;
the persistent CLI archive was retained.

The pause API returned `sandbox_pause_outcome_unknown` during acceptance.
Read-only cloud inspection subsequently confirmed `paused`, and the broker
reconciled the stored state without issuing another pause request. A successful
CLI command alone is not being used as proof of the lifecycle transition.

Final authenticated Runtime status confirms the same instance is `paused` at
epoch 25 with no active operation. Local Runtime health and local Memory
readiness return 200; production Runtime health and public Memory readiness also
return 200. Local capabilities expose 25 tools and zero MCP tools. Public
Memory MCP initialization returns 404.

The three final acceptance operations have successful durable PostgreSQL
Sandbox receipts:

- Resume and CLI verification:
  `egress-acceptance:verify:8d7b6281-5d74-4c72-98be-31d867ba7a92`.
- Concurrent cold-cache restore:
  `egress-acceptance:restore-cache:142b7e1d-0254-4339-bdd2-70d8c020e8a7`.
- Temporary-file cleanup and verification after another resume:
  `egress-acceptance:cleanup:8c3a8b3b-3621-4ed2-a951-07c5bcb0686f`.

The installed CLI does not yet have a production account session. Run
`agent-fs login` inside the sandbox and complete login for the intended
Zion account before accessing its files. This step does not import or remap
the local development account's memories.

## CLI browser login enhancement

The persistent CLI now supports `agent-fs login` / `agent-fs auth login`,
`agent-fs auth status` / `auth whoami`, and `agent-fs logout`. Login prints a
Zion verification URL and waits for the user to confirm in their browser.
After approval, it validates the resulting session with Memory and saves the
session and default drive automatically. No manual API key is required.
`zion-agentfs-login` remains a compatible shortcut.

The standalone helper is installed at
`/root/.local/share/zion-agent-fs-auth/login.mjs`.
[The reproducible installer](../../scripts/install-agentfs-login.mjs) updates
the wrapper while preserving the existing upstream archive. Auth runs before
dependency extraction, so `whoami` no longer falls back to upstream local DB
registration when account access fails. Upstream file commands are retained.

Configuration writes use an atomic `0600` replacement. Failed saves preserve
the previous file and attempt to revoke the new session. Successful replacement
attempts to revoke the previous session; logout revokes before clearing local
credentials. Expiry, rejection, missing login, connectivity failure and Ctrl+C
have explicit outcomes. The helper never prints session or private flow tokens.

Eleven focused HTTP/CLI integration tests passed, including a real spawned
wrapper completing a fixture approval flow, cancellation, rejected/expired
flows, Memory refusal, save failure, logout failure and upstream argument
forwarding. These fixture approvals are not production-user approvals.

Live sandbox acceptance passed:

- The installed `agent-fs login` emitted a verification URL from the production
  Zion service. The verifier cancelled this pending login; no production
  account session was saved.
- With the CLI extraction cache deleted, help/status/login ran without
  recreating it. Two concurrent upstream version calls then restored it
  successfully and returned `0.18.5`. Bun remained `1.4.1`.
- Hashes of Bun, the dependency archive, account configuration, `.bashrc`
  and `.profile` were unchanged. Account configuration retained mode `0600`.
- The updated Identity Skill was packaged and registered with the local Plugin
  Host; its downloaded archive hash was verified. The running local Runtime's
  cached Skill includes the new URL login instructions.
- Authenticated Runtime inspection confirmed a paused workspace with no active
  invocation. Local capabilities expose 25 tools and zero MCP tools. Local
  Runtime/Memory and public Runtime/Memory health checks returned 200; public
  Memory MCP initialization still returned 404.

A verification script initially mishandled buffered multiline stdout; it was
corrected to read pipe bytes before checking the login URL. A later resume
attempt returned `sandbox_connect_outcome_unknown`. Cloud inspection found
the old instance paused; normal Runtime recovery eventually confirmed its
termination and cleared its active operation. The next broker invocation
created `sbx-cd3b24a3-b4ad-4b0b-aa4b-196708e5a676`, epoch 26, with the same
account/workspace/NAS binding. The hash checks above confirm the persistent
installation and configuration survived this replacement. Final state is
confirmed `paused` at epoch 26.

Successful durable PostgreSQL receipts include:

- Wrapper installation:
  `agentfs-url-login:install:5a6f393b-eb80-4246-837d-a1aaf0cd48ce`.
- Production login URL, cancellation and concurrent cache restoration:
  `agentfs-url-login:verify-cli:7bae884c-6724-46bf-9c2e-797370f7c431`.
- Temporary staging cleanup:
  `agentfs-url-login:cleanup:bf8a591f-3a93-40c1-bf48-f158403f1b81`.

## Remaining integration

- Second-generation public egress and persistent CLI installation are repaired
  as described above. The first-generation trial did not replace the workspace.
  Production-account CLI login remains pending.
- The local pilot uses its existing local memory service and local development
  identity. Its six memory events have not been reassigned to a production
  user. Production Runtime Identity has not been migrated.
- Local Runtime MCP tools are disabled with `ZION_RUNTIME_MCP_ENABLED=0` and
  `ZION_MEMORY_MCP_ENABLED=0`. The Identity Skill describes CLI access.
- OSS has not been configured or validated. This deployment does not require
  an OSS Bucket or cloud storage credentials.
- The upstream installation occupies about 1.7 GiB, leaving about 2.1 GiB
  free before removal of temporary installation archives. This is a trial
  on the existing small ECS, not a concurrency or production-capacity result.
- A monitor can use the health/readiness endpoints. No new external alerting
  subscription was created in this trial.

## Reinstallation detail

Install the full reviewed upstream lockfile:

```bash
/opt/bun-1.4.1/bun install --cwd /opt/agent-fs --frozen-lockfile --ignore-scripts
```

Production-only and filtered installs omitted `zod-to-json-schema`, a root
development dependency imported at runtime by `core/src/openapi.ts`.
Keep the checkout root-owned and configure only `/opt/agent-fs` as a Git
safe directory for the service user. Startup still enforces the exact commit
and version.

The temporary RAM credential process was closed. Temporary SSH authorization,
operator keys, account-session helpers, acceptance scripts and temporary
installation archives were removed after final verification. The persistent
CLI dependency archive described above remains installed.

## Local Identity online connection and migration

The local demo Runtime and production Runtime use separate account databases.
Changing only the Memory URL cannot authenticate the local bridge token at
production, and a shared OIDC issuer would not by itself make their user UUIDs
identical. The implemented route is an explicitly authenticated, per-account
online Memory connection.

`npm run memory:connect` now prepares a private backup, starts the existing
Zion URL approval flow, and waits for the intended online account to approve.
After approval it refreshes the source snapshot, preflights every online target,
imports files using `create_only`, and compares complete API bytes. It installs
the verified login into the existing persistent sandbox CLI through the durable
Sandbox broker, then compares CLI reads with the same snapshot. Credentials are
passed through a private temporary file and are absent from command arguments,
Run transcripts and receipt output.

The local Runtime then persists the public Memory URL, the per-account
connection directory and disabled MCP settings. It restarts with the same local
account database, Runtime data and sandbox/NAS binding. Acceptance reads the
actual Identity panel API, confirms the public location and disabled MCP, and
checks online readiness. Only after these checks may the script stop the exact,
PID-and-working-directory-verified local pilot Memory process. Original storage
and private backups remain available as archives, without a live read fallback.

The Runtime adapter reauthorizes each local session/grant and current policy.
It also checks the local grant's Memory scopes and revalidates the saved
remote user/Space, active membership, scopes and drive binding. A changed
account, expired session or unavailable identity service fails explicitly.
The public `/memory` prefix is now preserved in HTTP requests; bridge JWTs
continue to bind the service-relative path stripped by Caddy.

Preparation on 2026-10-22 exported **9 files and 14 biography events**, including
the updates made after the earlier six-event snapshot. Backup:
`~/.zion-next/sandbox-demo/memory-backups/1792677430953-27b6e2e0-7579-410e-a261-59918fdb321f/export.json`.
The migration refreshes this snapshot again after login approval.

The user approved the online login. Migration and endpoint switching are
**complete** for the local sandbox Workbench:

- All 9 files and 14 biography events were imported without overwriting
  different online contents.
- Actual sandbox CLI authentication and reads of all 9 files passed.
  Durable receipt:
  `identity-online-connect:1608715c-5bfc-4da6-a7f6-e8f46590469f`.
- The actual Identity panel API and public Memory API returned identical bytes
  and hashes for every migrated file. The saved remote user/Space binding was
  independently checked against production `/v1/account/me`.
- Local Runtime restarted with the public endpoint and existing account,
  Runtime data and NAS binding. Capabilities expose zero MCP tools.
- The exact local pilot Memory process was stopped. Port 18991 no longer serves
  requests. Original storage and private backups remain archives.
- The final private backup and result are in
  `~/.zion-next/sandbox-demo/memory-backups/1792681301272-341cf22b-1338-4c09-95b2-ca110550ce1d/`.

Acceptance exposed two installer mistakes: the task authorization adapter
omitted its required PostgreSQL Access Store, and its temporary payload name
did not satisfy the provider's path validation. Both were corrected. The latter
was rejected before the payload write; the failed sandbox was confirmed
terminated before the corrected installer ran.

The CLI installation and reads completed successfully, but its subsequent
pause request returned `sandbox_pause_outcome_unknown`. Read-only cloud status
confirmed the same instance paused at epoch 31. Continuation reused the
successful durable receipt only after matching account, workspace and complete
request fingerprint, then reauthorizing its local grant. The task broker now
leaves lifecycle management to the existing Runtime rather than issuing an
extra pause after installation.

The focused Runtime suite passed **43 tests**, covering public-prefix binding,
account isolation, session/grant revocation, current policy, grant scopes,
remote identity/drive changes, expiry, remote write denial, credential-origin
binding and create-only import conflicts. Public Runtime/Memory and local
Runtime health checks passed. The production Runtime itself was not deployed
or reconfigured by this local Identity migration.
