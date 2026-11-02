# Zion Memory pilot

Independent agent-fs service for Identity memory. The Runtime panel, agent-fs CLI
and HTTP MCP operate on the same files. Authentication uses Zion accounts; the
service does not offer registration, passwords, or an independent user directory.

The reviewed upstream is `desplega-ai/agent-fs` 0.18.5, commit
`aecd4c83606f45325daece46b01f0c38ad2cc0ed`, with Bun 1.4.1. This is not Turso
AgentFS. SQLite owns metadata and search indexes; the selected local/OSS
storage adapter owns versioned file bytes.

## Verified state

On 2026-10-22 the independent service was deployed on ECS at
`https://runtime.zioon.tech/memory`, using persistent local disk under
`/var/lib/zion-memory`. HTTPS readiness, real Zion account authentication,
upstream CLI read/write/delete, reads of CLI writes through the shared file
API, invalid-token rejection, and hash-conflict rejection passed.
The public `/memory/mcp` endpoint returns 404.
The ECS idle process reported approximately 75–92 MiB RSS without embedding
models. This observation is not a concurrency capacity estimate.

An isolated first-generation `code-interpreter-v1` sandbox also installed
Bun 1.4.1 and upstream CLI 0.18.5, then completed authenticated HTTPS
write/read/delete against the ECS service. The sandbox and its temporary
Zion login were removed afterwards. An install without Bun's optional binary
failed; the successful command installs the platform binary directly:

```bash
npm install --prefix /tmp/zion-cli --ignore-scripts --omit=optional \
  @oven/bun-linux-x64@1.4.1 @desplega.ai/agent-fs@0.18.5
```

The bound second-generation template `u3sxwxk9b0l0tiphkt32` now has public
egress. After the operator attached the
[prepared template policy](../../deploy/sandbox/template-network-operator-policy.json),
native template read/update succeeded and changed
`runtimeConfig.internetAccess` from `false` to `true`. The old VM retained its
previous network behavior, so the authenticated Runtime released it and the
normal broker recreated it with the same account/workspace/NAS binding.
The recreated second-generation workspace reached npm and ECS Memory over
HTTPS. A disposable connectivity-test instance was removed. No NAT gateway
was purchased. The first-generation trial did not replace this workspace.

Bun 1.4.1 and upstream CLI 0.18.5 are installed persistently on this workspace.
A direct npm install on NAS returned `EDQUOT`; the successful install staged
on `/tmp` and retained Bun plus a 51.4 MiB compressed dependency archive under
`/root`. The `agent-fs` wrapper restores the archive automatically if its
temporary cache is absent. CLI startup after pause/resume and two concurrent
starts after deleting only this cache passed. The endpoint configuration uses
mode `0600`; the CLI reached the ECS authentication endpoint with the expected
invalid-token rejection. The user subsequently approved online login, and the
actual CLI authenticated and read all 9 migrated Identity files successfully.
See [the operation evidence](../../docs/operations/MEMORY-ECS-PILOT-20261022.md#second-generation-persistent-cli).

The local sandbox Runtime now connects its Identity panel to the ECS service,
using an explicitly approved, per-account online connection. Its 9 files and
14 biography events were migrated and verified through the actual panel API,
public Memory API and sandbox CLI. The old Mac pilot Memory process is stopped.
**Production Runtime Identity itself was not reconfigured by this local
migration. OSS remains unverified; the online service uses persistent ECS disk.**

Earlier local integration verification passed 46 checks with real PostgreSQL accounts,
real HTTP services, upstream CLI/MCP and the actual Node Runtime Identity panel
API. It covers account isolation, version/hash conflicts, concurrent JSONL
append/dedup, session/grant revocation, SQLite snapshot integrity and isolated
Identity caches when accounts use identical logical paths and Session IDs.
It also covers native MCP schema discovery without creating users, Runtime
forwarding, read-only and path/tool grants, copy destination checks, and reply
loss after a committed write returning a non-retryable unknown outcome.
The local storage adapter was used. These earlier checks included MCP before
the CLI-only trial was requested.

The independent `main.ts` startup and `/health` + `/ready` checks also passed.
A local idle process without embedding models reported about 100 MiB RSS;
this is a macOS startup observation, not an ECS concurrency capacity estimate.

Targeted Identity/Skills/project-memory, client policy and Runtime broker
regressions: 147 tests passed. A broader earlier run also
encountered a collaboration anchor expectation failure and an OIDC timing
failure; the broader suite cannot be reported as passing.

Live acceptance with DeepSeek V4 Flash completed as
`run_mvj6aeqn_jn3bbplp`. It read the full `agentfs-memory` Skill with `skillsList`,
then called native MCP `ls`, `cat`, `grep` and `stat`. Six successful PostgreSQL
tool receipts were persisted. It retrieved 6 events and cited 3 existing IDs;
the event file hash was unchanged. The current local Workbench was rebuilt with
Identity 0.1.14 at `http://127.0.0.1:18891`. Memory `/ready` passes.

## Zion tool access

Identity 0.1.14 uses one memory source. The panel and Runtime post-processor call
the authenticated agent-fs API. The local trial sets
`ZION_RUNTIME_MCP_ENABLED=0` and `ZION_MEMORY_MCP_ENABLED=0`; conversation
capabilities expose no MCP tools, and the Skill describes CLI access through
Bash. The custom biography query tool has been removed.

The retained MCP implementation is available for later configurations, but it
is disabled in the current trial. A CLI in a remote sandbox must have Bun,
the upstream `@desplega.ai/agent-fs` package, network access to the service,
and a Zion login for the intended account.

Read the contributed Skill's Runtime-cached body with
`skillsList { name: "agentfs-memory",
include_body: true }`. `runtime:plugins` is source metadata, not a Device Node.
Only Runtime writes this source; client `/v1/skills/sync` cannot overwrite it.
The Skill works in Zion and external Harnesses; clients operate on these same
files. `identityContext` remains a convenience projection, and `identityManage`
retains the structured panel/background operations.

The former Identity plugin-data file host, local-tools fallback, Python query
script and physical-path hints have been removed from the Runtime/Workbench
access chain. When Identity is enabled, an absent Memory service configuration
is a startup error. Old workspace directories do not participate in memory
reads or writes.

## Bootstrap

Install Bun 1.4.1 and Git. On macOS, upstream SQLite requires Homebrew SQLite.
The bootstrap installs the exact upstream outside the repository:

```bash
ZION_BUN_BINARY=/path/to/bun-1.4.1 \
AGENT_FS_UPSTREAM_DIR=/opt/agent-fs \
node scripts/bootstrap-agentfs.mjs
```

For a local empty trial, create a persistent directory and a bridge secret.
Give both services read access to the secret. Never store OSS credentials in the
checkout. The bridge secret is a service credential, not an Alibaba AK/SK.

```bash
mkdir -p "$HOME/.zion-next/memory-pilot"
if [ ! -f "$HOME/.zion-next/memory-pilot/bridge.key" ]; then
  (umask 077; openssl rand -hex 32 > "$HOME/.zion-next/memory-pilot/bridge.key")
fi
chmod 600 "$HOME/.zion-next/memory-pilot/bridge.key"

AGENT_FS_UPSTREAM_DIR=/opt/agent-fs \
AGENT_FS_HOME="$HOME/.zion-next/memory-pilot/data" \
AGENT_FS_STORAGE_PROVIDER=local \
AGENT_FS_LOCAL_ROOT="$HOME/.zion-next/memory-pilot/objects" \
ZION_ACCOUNT_RUNTIME_URL=http://127.0.0.1:18891 \
ZION_MEMORY_BRIDGE_SECRET_FILE="$HOME/.zion-next/memory-pilot/bridge.key" \
/path/to/bun-1.4.1 apps/memory-service/src/main.ts
```

Before using delegated panel requests, configure the Runtime with
`ZION_MEMORY_SERVICE_URL` and `ZION_MEMORY_BRIDGE_SECRET_FILE`.
`ZION_MEMORY_PUBLIC_URL` is metadata for external clients. When `dev.identity`
is enabled, Memory is required; Runtime does not fall back to plugin-data.

## OSS

Supply `OSS_BUCKET`, `OSS_REGION` (for example `oss-cn-shanghai`),
`OSS_ENDPOINT`, `OSS_ACCESS_KEY_ID`, `OSS_ACCESS_KEY_SECRET`, and optionally
`OSS_STS_TOKEN` through a transient secrets injector. Require a private,
versioned Bucket. Startup checks versioning and never enables it automatically.

The native `ali-oss` adapter implements upstream's ten-method StorageAdapter;
it avoids upstream's hardcoded S3 path-style addressing. Direct public signed
URLs are disabled; use the authenticated raw endpoint.

```bash
cd apps/memory-service
/path/to/bun-1.4.1 scripts/probe-oss.ts
```

The probe writes only a random `zion-memory-probe/<uuid>/` prefix, verifies
UTF-8 keys, reads, historical versions, head/list/copy, then removes its exact
object versions. It never edits existing memory or Bucket settings.
Do not claim OSS compatibility until this probe succeeds against the actual
target Bucket.

STS expiry is not automatically renewed in this pilot. Renew the injected
credentials and restart the service. This must be automated before unattended
production use.

## Clients

In the managed second-generation sandbox:

```bash
agent-fs login
agent-fs auth whoami
agent-fs ls /memory/dev.identity
```

`agent-fs login` (also `agent-fs auth login`) prints a Zion login URL. Open it
in your browser and confirm the intended account; keep the command running.
It saves the resulting session automatically after Memory accepts it.
No manual API key is needed. `agent-fs auth status` checks the login and
`agent-fs logout` revokes and clears it. Ctrl+C cancels a pending flow.
Expired or rejected login gives a specific retry instruction. Credentials
are written atomically with mode `0600`; failed saves retain the old config
and attempt to revoke the newly issued session. A successful replacement
also attempts to revoke its previous session.

Login also saves the service URL and default org/drive in
`~/.agent-fs/config.json`. Ordinary commands read this file; no repeated
environment exports or login are needed. In the managed sandbox this config
is on persistent `/root`. Extracted dependencies in `/tmp` are disposable and
restored from the persistent CLI archive independently of the saved login.

These commands augment upstream 0.18.5; file operations still run the upstream
CLI. Auth commands run before extracting the dependency archive, including
`whoami`, so authentication errors cannot fall back to local DB registration.
`zion-agentfs-login` remains a compatible shortcut. The helper, configuration
and executable archive persist under `/root` at `/workspace/.zion/home`.

For an existing upstream install on another machine, add the wrapper:

```bash
node scripts/install-agentfs-login.mjs \
  --bun /path/to/bun \
  --upstream-cli /path/to/node_modules/@desplega.ai/agent-fs/dist/cli.js
```

The installer defaults to `~/.local/bin`; put it before the upstream binary in
`PATH`. In a managed archive installation, omit `--upstream-cli` and optionally
set `--archive-dir`; the installer preserves the archive and its checksum.
Alternatively, `node scripts/agentfs-login.mjs` runs the same standalone flow.
Use `--api-url` / `--runtime-url` or `AGENT_FS_API_URL` /
`ZION_ACCOUNT_RUNTIME_URL` to change the deployment. Unset `AGENT_FS_API_KEY`
before login/logout because upstream treats it as an override of saved auth.
`--json` emits public login/status metadata and never session or flow tokens.

Run the focused HTTP/CLI authentication checks with:

```bash
node --test apps/memory-service/tests/agentfs-login.test.mjs
```

HTTP clients call `/auth/me`, then `/orgs/<defaultOrgId>/ops`, relative to
`https://runtime.zioon.tech/memory`. Public MCP access is disabled for this trial.
The shipped `extensions/dev.identity/skills/agentfs-memory` directory is
contributed in Zion and may be copied to other Harnesses. Its instructions
focus on checking/installing the CLI, browser login, persistent configuration
and CLI memory operations. It includes both standalone authentication scripts,
refreshed from the maintained repository helpers on every plugin package.
External CLI clients can install the login wrapper without a Zion checkout.

`/memory/dev.identity` is inside the agent-fs drive. It is not automatically a
native Bash directory. Mounting/FUSE and just-bash are separate integrations;
this pilot does not expose an unauthenticated filesystem or an IPC socket.

## Authentication and concurrency

- External CLI/API/MCP requests validate their Zion session and active
  membership via Runtime `/v1/account/me` on every request.
- The panel keeps Zion's host-only cookie. Its authenticated Runtime API sends
  a 30-second signed, request-bound delegation to the memory service.
  The service validates it via `/v1/account/memory/verify`; background calls
  recheck the original durable grant and current profile policy.
- MCP initialization and tool schemas are public metadata; they neither bind
  a user nor access files. Every `tools/call` requires authentication. Runtime
  delegations bind the native tool, actual request bytes, read/write effect
  and every input path, including copy/move destinations.
- Each current Zion user+Space is mapped to a private agent-fs personal drive.
  Stable Zion IDs, rather than email addresses, define this mapping. This is
  storage metadata; the Identity UI does not add an organization selector.
- Every request for one account is serialized across CLI, MCP, raw files and
  panel operations. This closes upstream's gap between expected-version
  checking and asynchronous object writes. Run **one memory-service process per
  metadata database**. Multiple replicas require a shared transactional claim.
- Registration, membership mutation, public shares and independent API-key
  reset are disabled. Existing account roles govern reads and writes.
- JSONL append deduplicates stable IDs and rejects a different payload for an
  existing ID. A write timeout is an unknown outcome; reread before retrying.
- Current request limit is 5 MiB; queue limit is 16 requests. Local embedding
  models, event streams and vector search workers are not started.

## ECS and backup

The deployment directory supplies a systemd unit, environment template and a
Caddy route fragment. Provision Linux Bun 1.4.1, the pinned upstream,
the `zion-memory` service user, a persistent local disk for
`/var/lib/zion-memory`, and a shared bridge secret readable by both service
users. Install the unit only after filling the actual non-secret settings.
Keep OSS credentials transient under `/run/zion-memory/oss.env`.

The ECS trial uses `/opt/zion-memory/apps/memory-service` to keep its code
separate from the existing production Runtime checkout. Set the systemd
`WorkingDirectory` accordingly. The supplied Caddy fragment belongs inside
the existing Runtime HTTPS site and strips `/memory` before forwarding.
Runtime-to-service calls, when enabled, use loopback without this prefix.

For this pinned upstream, install the full lockfile with
`bun install --frozen-lockfile --ignore-scripts`. Do not use `--production`
or workspace filters: `core/src/openapi.ts` imports the root development
dependency `zod-to-json-schema`. On a root-owned checkout, give the service
user a narrowly scoped Git `safe.directory=/opt/agent-fs` configuration;
the startup still checks the exact reviewed commit and version.

Use a single instance. The current small ECS already has memory pressure:
evaluate total Runtime+Postgres+Connector usage before deployment; 4 GiB is a
practical starting point for the full stack, not an agent-fs measurement.
The supplied 384/512 MiB systemd memory thresholds are initial limits to tune.

`GET /health` checks process/SQLite and reports RSS/queue length.
`GET /ready` additionally checks object-store listing and the account endpoint.
An external monitor must check both and alert on persistent failures; systemd
active alone is insufficient.

```bash
AGENT_FS_UPSTREAM_DIR=/opt/agent-fs \
AGENT_FS_HOME=/var/lib/zion-memory \
/opt/bun-1.4.1/bun apps/memory-service/scripts/backup.ts /backup/zion-memory
```

The script uses SQLite `VACUUM INTO`, so it captures a consistent database/WAL
snapshot, then checks its integrity. Back up OSS object versions separately and
exclude them from destructive lifecycle rules. SQLite alone is not a full
backup. For a consistent recovery point, pause writers during the coordinated
backup; after restoration, object heads must match the version/content hashes
recorded in SQLite. An old SQLite snapshot against newer OSS heads is not a
completed restore.

## Migration

After the OSS probe and service readiness pass:

1. Pause memory writers and identify the source files for each authenticated
   account. Export from the existing File Service; do not replace its mount.
2. Import the files into that account's `/memory/dev.identity` through the
   service API, using create-only writes.
3. Compare file sets, UTF-8 bytes/hashes and JSONL IDs. Retain the source.
4. Configure only the pilot Runtime to use the memory service; verify its
   Identity panel and CLI/MCP against the imported content.
5. Roll back by restoring the previous Runtime configuration if validation
   fails. Reconcile new memory writes before switching back.

The local sandbox Identity migration is complete after explicit online account
approval; `npm run memory:connect` prepares or renews this connection. The local
demo and production still use separate account databases, so every operation
checks both local authorization and the exact approved online identity.
An ECS local-disk deployment does not require OSS credentials. OSS validation
and migration remain separate work requiring a real Bucket, region, endpoint
and appropriate versioning/storage permissions.

## Reproduce local validation

The verifier uses the existing loopback PostgreSQL connection configured in
`~/.zion-next/sandbox-demo/account.json`, creates/drops its own random schema,
and expects the local OIDC discovery service on port 18091. It creates only
disposable identities and files.

```bash
cd apps/memory-service
AGENT_FS_UPSTREAM_DIR=/opt/agent-fs /path/to/bun-1.4.1 scripts/verify.ts
```

Upstream source:
https://github.com/desplega-ai/agent-fs/tree/aecd4c83606f45325daece46b01f0c38ad2cc0ed
