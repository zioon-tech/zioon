# Managed Sandbox PoC

Experimental operator-only adapter for Alibaba Agent Sandbox and E2B. It is not
registered in the production Runtime, exposed to models, or a completed
multi-tenant executor.

## Run locally

From the core-observability worktree:

```sh
npm install --prefix packages/sandbox --ignore-scripts
npm test --prefix packages/sandbox
node scripts/sandbox-poc.mjs preflight
```

Missing configuration exits with code 2 and prints only credential presence.
The package pins E2B SDK 2.31.0 in its own lockfile and does not change the root
dependency manifest.

Configure these variables in the invoking process:

| Variable | Value |
| --- | --- |
| `E2B_API_KEY` | Dedicated PoC Team key; never commit the value |
| `ZION_SANDBOX_PROVIDER` | `aliyun` (default), or `e2b` |
| `ZION_SANDBOX_REGION` | `cn-shanghai` (default for Alibaba) |
| `ZION_SANDBOX_TEMPLATE` | Confirmed template ID; use second-generation MicroVM for the target architecture |
| `ZION_SANDBOX_TIMEOUT_MS` | 300000 by default, maximum 600000 in this PoC |

`E2B_API_URL` and `E2B_DOMAIN`, when present, must match the provider and region.
Legacy tokens, debug mode and sandbox URL overrides are rejected.

```sh
node scripts/sandbox-poc.mjs preflight --live
node scripts/sandbox-poc.mjs run --report /tmp/zion-sandbox-poc.json
node scripts/sandbox-poc.mjs audit
node scripts/sandbox-poc.mjs cleanup
```

On the operator Mac, a Keychain entry can be used without placing the key in a
shell variable:

```sh
ZION_SANDBOX_TEAM_ID='<team-id>' \
ZION_SANDBOX_TEMPLATE='<template-id-or-code-interpreter-v1>' \
node scripts/sandbox-poc-keychain.mjs preflight --live
```

The expected Keychain service is `dev.zion.sandbox-poc`; its account is
`aliyun:<region>:<team-id>`. The wrapper validates that saved metadata matches
the requested Team and region before setting the SDK process environment.

`audit` is read-only. It compares live `zion.poc=1` sandboxes with the local
journal and exits nonzero for an unrecorded cloud sandbox or a journal record
whose supposedly live sandbox is absent. It does not connect, resume or delete.

Live preflight performs a non-creating list request. `run` creates a billable
environment, executes a fixed diagnostic command, validates file contents,
checks durable receipt replay and cleans up. No production credentials,
repositories, Device nodes or services are used.

## Lifecycle and failure semantics

- Scope is `{accountId, workspaceId, attemptId, epoch}`. The CLI's `account:poc`
  is a diagnostic namespace, not a logged-in Zion account.
- Inspect checks server-side metadata before SDK connect; inspect and static
  kill do not resume a paused sandbox.
- Creation is recorded before dispatch. An unknown outcome prevents another
  create using that request key. Metadata reconciliation may recover the ID.
- Each command invocation is recorded before execution. Unknown results are
  never replayed automatically. Successful receipts survive controller restart.
- Create/destroy errors are sanitized; raw provider response bodies are not logged.
- Reconciliation does not treat an empty list as proof the original create failed.
- TTL is a bounded fallback. Orphan creation and failed deletion still require
  inspection and cleanup; no production orphan reaper is claimed.

The default journal is `~/.zion-next/sandbox-poc/operations.json`, mode 0600.
Its directory lock is never stolen automatically. After a process crash, establish
that the owner is dead before removing the corresponding `.lock` directory.
Do not delete operation records while provider outcomes remain unresolved.

The journal is a single-operator proof of recovery semantics. Production requires
PostgreSQL claims, invocation fencing, durable ACK/outbox and authenticated
account grants. Metadata matching alone is not the authorization implementation.
Lexical path validation is not a filesystem jail against sandbox root.

## Pause and persistence probes

Alibaba documents generation-specific pause support. After confirming the
selected template's support, set `ZION_SANDBOX_PAUSE_VERIFIED=1` to enable:

```sh
node scripts/sandbox-poc.mjs run --pause --report /tmp/zion-sandbox-pause.json
```

For file persistence after hard destruction, configure
`ZION_SANDBOX_STORAGE_METADATA` with an operator-selected JSON object:

```json
{
  "fc.sandbox.storage.agenticfs": "{\"userID\":0,\"groupID\":0,\"mountPoints\":[{\"serverAddr\":\"<ISOLATED-ACCESS-POINT>:/\",\"mountDir\":\"/workspace\"}]}",
  "fc.sandbox.network.vpc": "{\"vpcId\":\"<VPC-ID>\",\"securityGroupId\":\"<SG-ID>\",\"vSwitchIds\":[\"<VSWITCH-ID>\"]}",
  "fc.sandbox.auth.role": "<SCOPED-RAM-ROLE-ARN>"
}
```

No long-term AK/SK belongs in metadata. AgenticFS authorization is bounded by
Access Point, not the subdirectory after `:/`. Use a dedicated PoC Access Point
and a role limited to it.

Also set `ZION_SANDBOX_STORAGE_NETWORK` to a JSON object with an explicit
`allowOut` list for storage and DNS. For this PoC:

```json
{"allowOut":["10.88.1.0/24","100.100.2.136/32","100.100.2.138/32"]}
```

Do not combine a persistent NFS mount with `allowInternetAccess=false`: it
blocks the storage transport as well. The adapter rejects AgenticFS configuration
without a storage allowlist. Roles need `nas:ClientWrite` for writes and
`nas:ClientRootAccess` for this root-enabled PoC, restricted to their own
Access Point and filesystem.

```sh
node scripts/sandbox-poc.mjs run --persistence --report /tmp/zion-sandbox-persistence.json
```

The persistence probe writes a unique test file, kills the original sandbox,
creates a replacement with epoch 2, reads the same file and removes that exact
test file. It must run in a disposable PoC storage domain. Failed probes may leave
their named marker file; cleanup does not recursively erase persistent data.

These probes do not test cross-account root attacks, POSIX locking, backups,
workspace writer takeover, arbitrary program resume or external side effects.
Passing them does not authorize a production multi-user launch.

## Template

`deploy/sandbox/Dockerfile` is a candidate Debian/Node/Python image preserving the
components documented for Alibaba's second-generation runtime. It has not been
cloud-built or validated. Build under the PoC Team, select MicroVM explicitly,
and verify root execution, envd injection and readiness. Pin the validated image
digest and template ID before release.

Do not install a sandbox pool or build the image on the production ECS.

The AgenticFS-specific client template `u3sxwxk9b0l0tiphkt32` was cloud-built
with the pinned alinas package and verified for mount, fsync, hard-destroy
recovery, pause/resume, separated A/B file views, rename and Git.
`scripts/agenticfs-live-verification.mjs` reproduces those operator checks.
Wrong-role/wrong-Access-Point creation returned HTTP 500 rather than an explicit
authorization error; this negative authorization test remains unresolved.

## Runtime personal environment

The explicit Runtime sandbox mode constructs the provider with
`{ persistentHome: true }` and calls `prepareEnvironment` under its durable
workspace lock before any tool or PTY operation. Operator PoC commands keep the
default environment unless opted in.

The account's NFS `/workspace/.zion/home` is bind-mounted at `/root`; installers,
Git and shells retain their standard HOME path. User files are seeded once
without overwriting existing content. Missing NFS or missing initialized HOME
fails the operation rather than silently using ephemeral storage.

With `ZION_PLUGIN_DATA_HOST=managed`, mutable account plugin files use the same
durable volume under `/workspace/.zion/plugin-data/{pluginId}`. Runtime publishes
the account's Managed Node id and this stable path. Structured file tools and
Bash therefore operate on one physical file tree; Runtime does not retain a
second copy.

Login Bash and PTY share HOME, XDG directories, PATH and
`~/.config/zion/env.sh`. Defaults cover `~/.local/bin`, Cargo, Bun and pnpm;
global npm packages use `~/.local`, with NVM initialization supported by env.sh.
Other user toolchain setup belongs in that shared file. Internal file commands
bypass user rc output. Canonical absolute file paths are accepted throughout
the VM; Runtime grants and resolved file paths enforce any narrower roots.

Only `/workspace` and its HOME subtree survive hard VM release. System packages
under `/usr`, configuration under `/etc`, and services require a base template
or an explicit reconstruction step.
