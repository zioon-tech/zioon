# Managed Sandbox PoC Delivery

Date: 2026-10-17

Status: Alibaba generation-1 and generation-2 Linux MicroVM execution paths
verified in `cn-shanghai`. AgenticFS remains an external quota-whitelist gate.
Nothing in this delivery is wired into the production Runtime.

## Cloud resources

- Team `zion-test` is active on the standard plan.
- A dedicated PoC data-plane key is stored in macOS Keychain under service
  `dev.zion.sandbox-poc`. It expires on 2026-11-15.
- The key value and the previously authorized RAM AK/SK are not in this
  repository, reports, image or template.
- The ready public `code-interpreter-v1` template is generation 1.
- NAS base service was activated with `OpenNASService`; no NAS filesystem was
  created.
- OSS create/write/read-hash/delete was verified with a temporary bucket and
  object. Both were deleted.
- The ready generation-2 template is `zion-poc-microvm-v1`
  (`iul1tk8sdpmt9p5oho5x`): 2 vCPU, 4 GiB RAM and 15 GiB disk.
- Earlier invalid generation-2 templates were deleted.
- Final read-only audit found zero live PoC sandboxes and zero orphans.

## Verified data-plane path

The live PoC exercised:

1. API-key authentication and list access;
2. sandbox create with a five-minute TTL;
3. command execution as root;
4. writable `/workspace`;
5. `allowInternetAccess=false` blocking access to `example.com`;
6. file write and content-hash read;
7. durable receipt replay without executing the command again;
8. static destroy and post-run orphan audit.

Create timing from individual runs ranged from roughly two to three seconds.
This is diagnostic evidence, not a latency SLO or benchmark.

Generation-1 pause failed and the sandbox was subsequently destroyed. Do not
advertise pause/resume for that template.

The generation-2 MicroVM live path also passed:

- create and root command execution;
- writable `/workspace` and content-hash read;
- deny-internet policy;
- pause and read-only observation of the paused state;
- resume and post-resume file validation;
- static destruction and cleanup.

The key correction from Alibaba support was to use `osType=linux-amd64`, not
`osType=linux`. The latter returned a misleading account-not-enabled error.

## External product gate

AgenticFS still requires the `AgenticFS 白名单` application in the NAS quota
console. After approval, create an isolated PoC AgenticSpace, Access Point and
scoped Function role, then run the hard-destroy persistence probe.

The candidate [`deploy/sandbox/Dockerfile`](../../deploy/sandbox/Dockerfile)
preserves the documented MicroVM system components but was not needed for the
first successful test, which used Alibaba's official code-interpreter image.

## Source

- [`packages/sandbox`](../../packages/sandbox): provider, config, durable PoC
  journal, unit tests and operator README.
- [`scripts/sandbox-poc.mjs`](../../scripts/sandbox-poc.mjs): preflight, run,
  audit and cleanup.
- [`scripts/sandbox-poc-keychain.mjs`](../../scripts/sandbox-poc-keychain.mjs):
  local Keychain wrapper.

The package is intentionally isolated from `apps/runtime`. It pins E2B SDK
2.31.0 in its own lockfile to match Alibaba's documented compatible version.

## Verification

```sh
npm test --prefix packages/sandbox
git diff --check -- \
  packages/sandbox \
  scripts/sandbox-poc.mjs \
  scripts/sandbox-poc-keychain.mjs \
  deploy/sandbox/Dockerfile

ZION_SANDBOX_TEAM_ID='<poc-team-id>' \
ZION_SANDBOX_TEMPLATE='code-interpreter-v1' \
node scripts/sandbox-poc-keychain.mjs audit
```

The final local suite has 11 passing cases, including:

- endpoint and legacy override rejection;
- scope and epoch validation;
- workspace path validation;
- inspection and destruction without waking a paused sandbox;
- known process failure versus unknown transport outcome;
- output limit handling;
- durable result replay after controller restart;
- unknown execution refusing replay;
- create-ACK loss and metadata reconciliation;
- single-operator journal locking;
- read-only orphan and missing-instance audit.

The credential scan found no API key or RAM AK in the added source files.

## Deliberate limitations

This is not a production multi-tenant claim store. The local journal is
single-operator and cannot replace PostgreSQL transactional claims, fencing,
durable dispatch ACK/outbox or account grants.

## AgenticFS follow-up — 2026-10-18

The AgenticFS whitelist became active. An isolated filesystem, VPC, switch,
enterprise security group, two AgenticSpaces and two RAM-enabled Access Points
were provisioned. Dedicated FC roles restrict access to each Access Point.

The client template `u3sxwxk9b0l0tiphkt32` includes the checksum-verified alinas
2.4 package. Live checks passed for real NFS mounting, file fsync, destruction
and replacement of the sandbox, unchanged file contents, pause/resume,
separated A/B file views, rename, directory fsync and Git init/add/commit.
The general provider PoC also passed the hard-destroy persistence workflow.

With storage, use an explicit private storage/DNS egress allowlist. Setting
`allowInternetAccess=false` blocks the NFS transport too. The FC client uses a
local TLS listener on 12049 forwarding to the Access Point's remote 2049;
do not apply ACS-specific network assumptions without verification.

One general pause test hit the 20-second API deadline and a provider 409 during
the transition; the instance was resumed and then deleted successfully. Pause
requests now use a 60-second API deadline. Final audit found no live PoC
instances, cloud orphans or missing-cloud journal records.

Creating a B mount with the A role returned HTTP 500. This does not establish
an explicit authorization denial and requires provider diagnosis.

No current test establishes:

- cross-account root isolation;
- all POSIX behavior, cross-instance locking, backup or quota enforcement;
- user Runtime plugin isolation;
- arbitrary external side-effect reconciliation;
- production cost or capacity.

Do not connect this package to normal users until those gates are verified.
