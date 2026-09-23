# PostgreSQL Runtime Operations

Zion Runtime uses PostgreSQL as its only authoritative database. Account,
Space, Session, Run, Workbench, Scheduler, Access, Node, and Observability data
share one PostgreSQL pool and are partitioned by `space_id`.

## Required configuration

```sh
export ZION_DATABASE_URL='postgresql://zion:REDACTED@127.0.0.1:5432/zion'
export ZION_SPACE_ID='space:production'
export ZION_RUNTIME_DATA_DIR='/var/lib/zion-next/runtime'
```

`ZION_RUNTIME_DATA_DIR` contains only local configuration, model credentials,
interaction profiles, and plugin files. It is not a database location.

The Runtime refuses to start when `ZION_DATABASE_URL` or `ZION_SPACE_ID` is
missing. There is no alternate backend or automatic fallback.

## Database role

Use a dedicated non-superuser role without `BYPASSRLS`. Grant only the schema
and table privileges required by Zion. Observability queries explicitly reject
privileged roles because their isolation relies on row-level security.

## Deployment

1. Back up PostgreSQL with the platform's native backup mechanism.
2. Stop the Runtime processes being replaced.
3. Deploy the new application build.
4. Start one Runtime process for each served Space.
5. Verify `/health`, account login, Session reads, one Run, Scheduler access,
   Node registration, and observability queries.
6. Confirm the startup log contains `using PostgreSQL`.

Do not enable dual writes. Rollback means restoring a consistent PostgreSQL
backup and the matching application build.

## One-time SQLite production import

Existing single-user SQLite deployments must be imported before starting the
PostgreSQL-only Runtime. The import assigns every legacy row to one explicit
Space. For the current production deployment use:

```sh
export ZION_SPACE_ID='space:production'
export ZION_DATABASE_URL='postgresql://zion:REDACTED@127.0.0.1:5432/zion'
export ZION_OIDC_ISSUER='https://<issuer>'
export ZION_OWNER_SUBJECT='<oidc-subject>'

npm run runtime:import-sqlite -- \
  --sqlite /var/lib/zion-next/runtime.sqlite3 \
  --database-url "$ZION_DATABASE_URL" \
  --space "$ZION_SPACE_ID" \
  --owner-issuer "$ZION_OIDC_ISSUER" \
  --owner-subject "$ZION_OWNER_SUBJECT" \
  --owner-name '<owner display name>' \
  --space-name 'Production' \
  --json
```

The command above is a dry-run. It reads SQLite, runs `PRAGMA integrity_check`,
and reports per-table counts and expected import hashes. It does not initialize
or mutate PostgreSQL.

By default the importer compacts historical `model.request` events while
copying them into PostgreSQL. It strips raw model payloads and stores the same
summary format used by new PostgreSQL writes: message/tool counts, payload
bytes, payload hash, message hash, tool hash, and model/config fields. The
source SQLite files are not modified. Use `--preserve-raw-model-requests` only
when a full forensic copy of raw prompts is required and sufficient storage has
already been provisioned.

The importer also skips the legacy `runtime_invocation_receipts` table by
default. It is an internal Device invocation idempotency cache, not the user
visible Run ledger or Workbench document state. Use `--include-internal-receipts`
only when replay-deduplication evidence for old device calls is more important
than migration time and disk usage.

Before installing PostgreSQL on the current ECS host, check capacity:

```sh
df -hT /
find /var/lib/zion-next -maxdepth 1 \( -name 'runtime.sqlite3*' -o -name 'runtime' \) \
  -printf '%M %u %g %s %p\n'
```

The 2026-09-20 production check showed a 40G root volume with about 15G free,
`runtime.sqlite3` around 13.5G, and WAL around 0.7G. That is not enough for a
raw full-copy migration plus local backup. The supported paths are:

- expand the disk first, then install local PostgreSQL and import;
- attach/provision an external PostgreSQL instance and import there;
- use the default compact import for historical `model.request` rows, keeping
  the original SQLite files in place until PostgreSQL is verified.

Do not delete or vacuum the SQLite source before PostgreSQL has been verified.

Apply only after the Runtime is stopped and the dry-run output is reviewed:

```sh
sudo systemctl stop zion-runtime
sudo install -d -m 0700 -o zion -g zion /var/backups/zion-next/sqlite-import

sudo -u zion env \
  ZION_DATABASE_URL="$ZION_DATABASE_URL" \
  ZION_SPACE_ID="$ZION_SPACE_ID" \
  npm run runtime:import-sqlite -- \
    --sqlite /var/lib/zion-next/runtime.sqlite3 \
    --space "$ZION_SPACE_ID" \
    --owner-issuer "$ZION_OIDC_ISSUER" \
    --owner-subject "$ZION_OWNER_SUBJECT" \
    --owner-name '<owner display name>' \
    --space-name 'Production' \
    --backup-dir /var/backups/zion-next/sqlite-import \
    --apply \
    --json
```

If the host does not have enough free space to copy the 13G+ SQLite source,
replace `--backup-dir ...` with `--skip-source-backup` only after confirming the
source SQLite files will remain untouched and available for rollback. The import
does not write to SQLite.

Apply mode:

- copies `runtime.sqlite3`, `runtime.sqlite3-wal`, and `runtime.sqlite3-shm`
  to the backup directory before writing PostgreSQL;
- initializes account and runtime schemas;
- creates or reuses `space:production`;
- resolves the owner identity and grants it `owner` membership in that Space;
- imports legacy Runtime tables with the target `space_id`;
- compacts historical `model.request` payloads unless explicitly disabled;
- skips legacy device invocation receipt cache unless explicitly enabled;
- records per-table import metadata in `runtime_import_progress`;
- verifies imported target counts and semantic hashes before commit.

Imports are committed table by table under a session advisory lock. If the
command stops after some tables have completed, rerun with
`--allow-non-empty-target`; already verified tables are skipped only when their
target count and hash still match the SQLite source.

The import refuses to merge into non-empty target tables. Use
`--allow-non-empty-target` only for an idempotent rerun after a previous
successful import; if target data differs from the SQLite source, the command
still fails.

After applying, configure `/etc/zion-next/runtime.env`:

```sh
ZION_RUNTIME_AUTH_MODE=accounts
ZION_DATABASE_URL=postgresql://zion:REDACTED@127.0.0.1:5432/zion
ZION_SPACE_ID=space:production
ZION_RUNTIME_DATA_DIR=/var/lib/zion-next/runtime
```

Then start the service:

```sh
sudo systemctl daemon-reload
sudo systemctl start zion-runtime
sudo systemctl status zion-runtime --no-pager
curl -fsS https://<runtime-origin>/health
```

The old data is in the account-visible `space:production` Space. The owner is
the user whose OIDC identity exactly matches `ZION_OIDC_ISSUER` and
`ZION_OWNER_SUBJECT`. Additional users should be added through the account UI
or invitation flow; do not rewrite imported Runtime rows to individual user IDs.

## Verification

```sh
ZION_TEST_POSTGRES_URL="$ZION_DATABASE_URL" \
  npm --prefix apps/runtime test
```

Check schema versions:

```sql
SELECT version, applied_at FROM account_schema_migrations ORDER BY version;
SELECT version, applied_at FROM runtime_schema_migrations ORDER BY version;
SELECT table_name, source_count, rows_imported, source_hash, status
FROM runtime_import_progress
WHERE space_id = 'space:production'
ORDER BY table_name;
```

The application role must report `false` for both privilege flags:

```sql
SELECT rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname = current_user;
```
