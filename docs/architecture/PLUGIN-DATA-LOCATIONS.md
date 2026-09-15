# Plugin Data Locations

Plugin business data is stored as real files. `Bash`, `read`, `write`, `edit`,
`glob`, `grep` and `tree` remain the tool surface. There is no Memory database,
virtual URI, new model tool or automatic cross-device synchronization.

## Host Contract

```js
const data = await context.locations.data;
// { nodeId: "the-configured-node", root: "/home/zion/.zion-next/data/plugins/dev.example" }

await tools.read({ node_id: data.nodeId, path: `${data.root}/notes.md` });
await tools.edit({
  node_id: data.nodeId,
  path: `${data.root}/notes.md`,
  old_string: "pending",
  new_string: "complete"
});
```

`tools` above is the caller's existing tool dispatcher, not a new SDK property.
Runtime plugins receive a synchronous location; Workbench plugins resolve it
asynchronously. Using `await` works for both. Workbench activation itself does
not wait for location discovery.

- `root` is an absolute path on `nodeId`, never on the browser's computer.
- The default layout is `~/.zion-next/data/plugins/{manifest.zion.id}/`.
- `dev.identity` uses the same layout, without a `memory/` wrapper or alias.
- Plugin data is separate from installed code, disposable caches and the
  current repository workspace. Plugin removal does not remove this directory.
- Metadata is not permission. Runtime policy and Device grants still apply.
- A Run restricted to a different execution Node cannot bypass that restriction
  by using a data location. Configure the workflow's permitted targets explicitly.
- Single-host `--tool-mode local` returns an empty `nodeId`; omit `node_id` and
  `session_id` when using that host's files.
- Browser-only mode requires an explicit `plugins.dataLocations.<pluginId>`
  host-state binding; it never guesses from the active terminal.
- This is a single Owner deployment contract, not a completed multi-tenant system.

The authenticated metadata route is `GET /v1/plugins/:pluginId/locations`.
It is for clients, not registered as a model tool. It neither grants access nor
creates a directory. Runtime plugins use the in-process host binding.

## Deployment

Runtime and the Connector on the data machine must agree on the physical
plugin-data base directory. Use a persistent volume outside application releases.

```sh
# Runtime: the existing, paired Connector on this server owns this Node id.
ZION_PLUGIN_DATA_NODE_ID='<paired-node-id>'
ZION_PLUGIN_DATA_ROOT='/home/zion/.zion-next/data/plugins'

# Connector on the same server:
ZION_PLUGIN_DATA_ROOT='/home/zion/.zion-next/data/plugins'
```

Both entry points also accept `--plugin-data-root`; Runtime additionally accepts
`--plugin-data-node-id`. In Node mode an absent Node binding fails closed.
No Node name, platform, active terminal or online fallback is used to infer it.
The existing Connector grant must allow the data directory, and its Resource
project binding must permit the projects that will use these files.

Deploy the Runtime, Connector, Workbench, Mobile and `dev.identity` package
together. The updated Connector implements protected plugin-file operations;
its internal file relay advertises capability version 2. Bound plugin-file
requests require this version before dispatch and mark `plugin_data_version=1`.
Old Connectors are rejected before these writes rather than silently ignoring
conditional parameters. This does not change the Device protocol version.
Python and the deployed `biography-memory/scripts/query-biography.py` are needed
for Bash queries. Supply `--path` using the injected data root; never guess `~`.

The Runtime and Connector must see the same filesystem namespace if configured
with the same root. A host path is not automatically visible in a container.
Do not expose local-tools publicly.

## File Writes

The adapter only intercepts paths under its configured plugin-data root, and
only after the existing tool or Device authorization. Unrelated workspaces and
terminal-bound files retain their existing behavior.

- Documents are written to a temporary file, fsynced, then renamed.
- `read` returns `content_hash`; `write`/`edit` accept `expected_hash`.
- New profiles use `create_only`, preserving existing empty files.
- JSONL append validates existing history, serializes updates, deduplicates
  identical IDs, and rejects the same ID with different payloads.
- Supported text files are capped at 4 MiB; existing transport request limits
  also apply. Larger content should be handled explicitly, not silently truncated.
- Symlinks inside the plugin-data tree are rejected.
- Locks are sibling directories named `<absolute-file>.zion-lock`, acquired with
  atomic `mkdir`. A writer holds the lock for the entire read-modify-write.
- Lock acquisition times out instead of stealing another writer's lock. A crash
  can leave a lock behind; an operator must establish that no writer is alive
  before removing it. Lock directories are not shown in data listings.

Bash still accesses the real files. A cooperating shell writer should acquire
the same directory lock, reread the current file, atomically replace it, and
release the lock in a trap. Arbitrary shell commands can bypass advisory locks;
this design does not promise strong consistency for those commands. A directory
path is not a sandbox: preserve command policies and least-privilege Device grants.

## Identity Behavior

Identity UI, Runtime distillation, project automation and model context use the
bound plugin directory. Full event reads used by the plugin are not routed
through the model tool-result truncation path.

Each new Run reads source files and rebuilds its biography digest in memory.
The same Run uses a stable context snapshot. External Bash edits are picked up
by the next Run. The saved digest is a rebuildable projection, not another
event source. The Workbench no longer uploads identity snapshots, and Runtime
rejects direct client writes to its derived snapshot KV.
Runs restricted to a different Node, terminals, or only a narrower project file
do not receive the full Identity profile. Cached Identity context is removed in
that case; task policies are not broadened to make context loading succeed.

The Mobile knowledge view browses the real Identity directory and edits text
with conditional writes. JSONL is displayed read-only there; authorized tools
and scripts can still manage the underlying file. It is not a replacement
for an event-confirmation or deletion workflow.

## Migration

Stop old and new Identity writers before importing. The migration command runs
on the data machine and requires an explicit source, not a snapshot or guessed
directory. To move from another computer, first transfer a verified copy to an
explicit staging directory on this machine.

```sh
node scripts/migrate-plugin-data.mjs \
  --plugin-id dev.identity \
  --source '/path/to/old/.zion-next/memory' \
  --data-root '/home/zion/.zion-next/data/plugins'

# Inspect the dry-run output, then repeat with --apply.
```

The command inventories every regular file, rejects symlinks and active file
locks, copies into staging, verifies hashes against both source and destination,
then publishes the directory. The source remains intact. An identical retry is
a no-op; different destination content is a conflict, never an automatic merge.
Run migration before initializing new profiles. Existing legacy
`ZION_IDENTITY_MEMORY_ROOT` values are only useful for supplying `--source`;
they no longer override the new directory layout.

Back up the entire plugin data base, not just Runtime SQLite. Verify restoration
of profiles, events and project subdirectories. This change does not implement
backups, high availability, durable distillation retries or live migration.
Do not re-enable an old writable directory after new data has been committed.

## Verification (2026-09-13)

Scope: location metadata, host injection, existing file tools and relay,
Identity profiles/events/context, migration, and Mobile file access.
No production deployment, real user-data migration or backup restoration was performed.

Defect analysis: replaced read-modify-overwrite of the event stream with
serialized append; refreshed context between Runs; fenced legacy snapshot
uploads. A disposal/initialization race observed during testing was fixed by
waiting for initialization during plugin disposal.

New cases: 34 passing cases cover per-plugin roots, path rejection, retries,
conditional writes, literal edits, cancellation, concurrent append, conflicting
IDs, migration preview/idempotence/conflicts, old Connector rejection, projection
ownership, context freshness and authorization. Existing related tests were
updated for the new path and append contract.

Final verification:

| Suite | Result |
| --- | --- |
| Runtime Host | 312 passed |
| Device Connector | 28 passed |
| Identity / locations / migration / plugin manager / Runtime compatibility | 89 passed |
| Mobile | 16 passed |
| Total | 445 passed |

Runtime build, Workbench build, Mobile build, Identity archive build,
Mobile TypeScript, new-module lint and `git diff --check` passed.
Repository-wide TypeScript still reports pre-existing errors in session-document
declarations, EditorProxy/main and the manifest module declarations. The new
data-location declaration error was fixed; the unrelated files were not changed.
Coverage percentage was not measured. The test helper's `utree flush` was
attempted but sandbox restrictions blocked its external cache/report writes.

The multi-Node test uses real HTTP, NodeBroker and two DeviceConnector instances
with temporary local files, plus an actual Bash subprocess. Stopping the laptop
Connector leaves server data readable; stopping the data Connector fails closed.
This is not a production cross-host or SSH test.

Browser verification opened the Mobile directory, edited and saved `user.md`,
then reloaded and reopened it to verify persistence. A screenshot and DOM check
at a 1168px desktop viewport showed no horizontal overflow. A narrow-device
screenshot and production browser acceptance remain deployment checks.

For an isolated, disposable UI fixture:

```sh
node scripts/verify-plugin-data-ui.mjs 5286
```

Open `http://127.0.0.1:5286/mobile/knowledge`. It serves temporary sample files,
not the user's Memory directory; stopping the script removes its temporary data.
