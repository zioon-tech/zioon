# Account Sandbox onboarding

Account mode can provision a durable managed workspace when a user first logs
in. Enable it only with the account gateway and cloud provisioning adapter.

## Runtime configuration

```ini
ZION_RUNTIME_AUTH_MODE=accounts
ZION_RUNTIME_TOOL_MODE=sandbox
ZION_SANDBOX_AUTO_PROVISION=1
ZION_SANDBOX_BINDINGS_FILE=/etc/zion-next/sandbox-bindings.json
ZION_SANDBOX_PROVISIONING_CONFIG=/etc/zion-next/sandbox-provisioning.json
ZION_PLUGIN_DATA_HOST=managed
ZION_PLUGIN_DATA_SCOPE=account
ZION_PLUGIN_DATA_ROOT=/workspace/.zion/plugin-data
ZION_ACCOUNT_ALLOW_RESOURCE_EXECUTION=1
ZION_ALLOW_DANGEROUS=1
ZION_DATABASE_POOL_SIZE=5
ZION_ACCOUNT_RUNTIME_MAX_ACTIVE=12
```

The existing Sandbox provider key remains in the private Runtime environment.
The NAS/RAM adapter obtains rotating IMDSv2 credentials from the ECS instance
role named in `deploy/sandbox/account-provisioning.config.json`. Do not install
an operator's long-lived AccessKey in Runtime or pass cloud credentials to a
Sandbox.

Attach `deploy/sandbox/account-provisioning.policy.json` to that instance role.
Some NAS operations only support a wildcard resource; the adapter validates the
configured filesystem, account path, access point, VPC, role trust, and attached
mount policy before accepting a binding. Each managed FC role can mount only its
account's access point.

## Onboarding and recovery

The unified login callback resolves the identity, creates the Runtime account
session, and ensures the account workspace before completing login. Existing
unbound accounts are also provisioned when making authenticated Runtime
requests. Existing imported bindings must match their durable database binding;
the provisioner does not replace an existing account volume.

`runtime_account_workspaces` stores each account's provisioning progress.
Per-account PostgreSQL advisory locks serialize cloud mutations. Completed
steps survive Runtime restarts. Failed attempts become retryable after 30
seconds; failures with an unknown access-point creation outcome require
reconciliation of the existing access point before any new create operation.

```sql
SELECT account_id, workspace_id, status, attempts, error_code, retry_at, updated_at
FROM runtime_account_workspaces
ORDER BY updated_at DESC;
```

Do not delete a partially provisioned row to retry: it contains the identifiers
needed to recover resources already created in the cloud.

The gateway authenticates before selecting a Runtime. Each Space has separate
session caches, Run stores, plugin state, collaboration service, account model
credentials, and Node authority. All Runtime instances share the PostgreSQL
pool. Idle instances can be evicted and reopened from durable state. The active
Runtime limit controls control-plane memory; it is not the number of accounts
that may have a persistent Sandbox volume.

New accounts receive the default managed file and Bash tools. Platform models
are available through protected references; users cannot replace their
configuration or inherit a platform environment credential into a custom
profile. New account Runtimes select the platform's configured interactive
model as their default. An automatically generated account profile that still
points to the unconfigured built-in fallback is repaired on startup; a
configured account model is retained.

## Execution boundaries

Keep `ZION_PLATFORM_NODE_IDS` and `ZION_PLATFORM_NODE_SERVICE_GRANT_IDS` intact.
ECS remains a platform service host and cannot serve interactive user execution,
including owner/admin execution. Existing scheduled service grants remain
separate. Explicit authorized personal Nodes retain the same policy and
dispatch path.

File tools and Bash share the account's AgenticFS `/workspace` mount. `/root`
uses the persistent home under `/workspace/.zion/home`; pause/resume and
Sandbox recreation preserve files and installed user CLI configuration.

## Deployment checks

Before restarting, check that no user Run or Sandbox operation is active.
Back up affected source files, dependency installation, Runtime environment and
existing bindings. Check account identities, memberships, device bindings and
static scheduled-task configuration before and after deployment.

Wait for the HTTP `/health` response, not only `systemd active`. Validate through
the public login path with two previously unknown identities: distinct volumes,
default model Run, file/Bash interoperability, editor document projection,
cross-account access denial, explicit ECS execution denial, and persistent
home after pause and rebuild. Remove only the test resources created for that
verification.

## Production verification, 2026-10-23

Automatic onboarding is deployed at `https://runtime.zioon.tech`. Two identities
created through its public registration form had no previous Runtime identity
or Sandbox binding. Their first native login created distinct persistent
volumes, access points, and scoped FC roles. Production email verification
remains required. The test fixture marked only these synthetic mailboxes as
verified before login; SMTP delivery itself was not tested.

Both accounts completed their default-model Run with `write`, `Bash`, and
`read`, with durable receipts pointing to the same account Sandbox. Their
assistant responses appeared in the persisted editor documents. Cross-account
Run, file, and forced Node requests were denied, as was explicitly selecting
the ECS Node. Pause/resume and release/rebuild preserved files and the installed
test CLI under the persistent HOME.

The original account retained its 919 Memory events, 243 citations, 52 device
records, project bindings, and all 23 scheduled task definitions. The three
platform service grants were preserved. Test Sandbox instances were released
before removing their cloud storage and roles; synthetic accounts and their
Memory data were removed after verification. Sanitized evidence is under
`artifacts/zion-account-onboarding-20261023` in the shared workspace.
