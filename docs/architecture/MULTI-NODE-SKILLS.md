# Multi-Node Skills Catalog

## Goal

Skills remain ordinary files on Device Nodes, while Runtime provides one durable
catalog for every conversation surface. A conversation does not scan all Nodes.
It reads the last successfully synchronized Runtime snapshot.

This design separates two concerns:

- Skill instructions are portable text and may be cached by Runtime.
- Commands, files, credentials, login state, environment variables, and installed
  dependencies belong to an execution Node and are never implied by the cache.

## Data Model

Each configured directory has provenance:

```json
{
  "path": "/Users/me/.zion-next/skills",
  "nodeId": "node:mac",
  "nodeLabel": "This Mac"
}
```

A single-host Runtime has no Device Connector `node_id`. It uses the logical
source ID `runtime:local` in the catalog while omitting `node_id` from actual
file requests. This avoids confusing a valid local host with missing provenance.

Runtime stores two projections:

1. A Source Snapshot for each Node. It is that Node's last successful scan,
   including paths, Skill metadata, `SKILL.md`, content hashes, and source paths.
2. A Resolved Catalog. It contains one entry per Skill ID for model injection.

Source snapshots are retained when a Node is offline. An older synchronization
from another client cannot overwrite a newer snapshot for the same Node.

For duplicate IDs, the resolved entry is selected by:

1. newest `syncedAt`;
2. Runtime-cached content when timestamps match;
3. source Node ID as a stable tie-breaker.

The UI exposes the resolved catalog, not revision management.

## Synchronization

Scanning is scoped by each path's recorded `nodeId`. A legacy path without
provenance may use read-only Runtime discovery once:

- one Node contains the path: record that Node and reuse it;
- multiple Nodes contain the path: return `ambiguous_file_node`;
- no Node contains the path: keep the previous successful Source Snapshot.

After a scan, Workbench sends the source-aware snapshot to:

```text
POST /v1/skills/sync
```

Runtime merges it into the existing per-Node snapshots. It does not delete
snapshots omitted by an offline client. Catalog reads and global enabled-state
updates use:

```text
GET   /v1/skills/snapshot
PATCH /v1/skills/snapshot
```

The Runtime-owned Skills KV keys cannot be written through the generic
Workbench-state endpoint.

## Runtime Cache

Text files are copied to `dev.skills` Plugin Data using content-addressed paths:

```text
{pluginDataRoot}/dev.skills/cache/{skillId}/{contentHash}/
```

The default production location is:

```text
/srv/zion-plugin-data/plugins/dev.skills/cache/
```

Runtime keeps the normalized `SKILL.md` body in its catalog as a fallback. This
allows the Runtime `skillsList` tool to return instructions even when the source
Node or cached file relay is unavailable.

The synchronizer accepts at most 128 text files and 8 MiB per Skill.
`SKILL.md` is loaded first and may use the Plugin Data file limit of 4 MiB.
Auxiliary files are limited to 512 KiB each; oversized generated files are
skipped instead of failing the complete Skill scan. It excludes secret-bearing
or machine-owned paths, including:

- `.env*`, `.ssh`, `.aws`, `.azure`, `.git`, and `node_modules`;
- private-key files and `id_rsa` / `id_ed25519`;
- credential, secret, API-key, and token files.

Binary files are not synchronized.

## Conversation Behavior

The Runtime Context Provider reads only the resolved Runtime snapshot. It
injects the cached file location, source Node, source status, and whether the
instructions are cached.

When a source Node is offline, the model may use cached instructions for
reasoning. It is explicitly told not to assume that source-local commands,
files, credentials, login state, environment variables, or dependencies are
available.

If the current Workbench has a changed Skill body that has not synchronized
successfully, the Run metadata includes that entry as a transient Skill. A
transient entry replaces the same Runtime ID for that Run only and embeds its
instructions. It does not mutate the durable Runtime catalog.

## Non-Goals

- continuous peer-to-peer synchronization;
- copying secrets or environment configuration between Nodes;
- installing dependencies on a target Node;
- automatically selecting an execution Node from the active terminal;
- user-facing revision history or merge conflict resolution.
