---
name: agentfs-memory
description: Install, log in to and use the agent-fs CLI. Use when retrieving or updating shared Identity, user preferences, project notes or biography memories in Zion or another Harness.
---

# Agent-fs Memory

Use the agent-fs CLI to access the online memory files shared with the Identity
panel. Reuse installed tools and saved login before installing or authenticating.
The memory root is normally `/memory/dev.identity`; use the supplied data
location if it declares a different root or service.

## 1. Check the existing installation

```bash
command -v bun
command -v agent-fs
bun --version
agent-fs --version
agent-fs login --help
```

The package is `@desplega.ai/agent-fs`, the executable is `agent-fs`, and Bun
must be at least 1.4.0. The Zion login helper's help lists browser login,
status and logout. A plain upstream installation needs that helper added.

The managed Zion sandbox already has Bun, CLI and the login helper. Skip
installation when they work. Its wrapper restores missing temporary
dependencies from the persistent archive automatically; do not reinstall
packages just because `/tmp` was cleared.

## 2. Install only missing components

For a new environment, install Bun only when it is missing or too old:

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.1"
```

Install the upstream CLI only when it is missing. Run the bundled helper
installer from this Skill's directory:

```bash
"$HOME/.bun/bin/bun" add --global @desplega.ai/agent-fs@0.18.5
"$HOME/.bun/bin/bun" scripts/install-agentfs-login.mjs \
  --bun "$HOME/.bun/bin/bun" \
  --upstream-cli "$HOME/.bun/install/global/node_modules/@desplega.ai/agent-fs/dist/cli.js"
```

For an existing compatible upstream CLI, pass its actual entry path instead of
installing another copy. The bundled scripts are
[the installer](scripts/install-agentfs-login.mjs) and
[the login helper](scripts/agentfs-login.mjs); use their paths relative to the
Skill directory available in the execution environment.

The installer places the Zion-aware executable at `~/.local/bin/agent-fs`.
If it is not on PATH yet, call that full path. Configure PATH once through the
environment's persistent shell setup, rather than changing it on every use.
In a managed sandbox with the persistent CLI archive already present, the
helper installer can rebuild the wrapper without `--upstream-cli` or downloads.

## 3. Reuse login or request browser approval

```bash
agent-fs auth status
agent-fs auth whoami
```

If authenticated, continue with file commands. If login is missing or expired:

```bash
agent-fs login
```

Show the returned Zion URL to the user and keep the command running until they
confirm and it reports success. Credentials and drive selection are saved
automatically. Do not ask for an API key or open the browser for the user.
Use `agent-fs logout` only when the user wants to revoke this login.

The default service is `https://memory.zioon.tech`. For another
deployment, supply `--api-url` and `--runtime-url` once during login; the helper
saves both. Ordinary file commands need no exported service URL or credential.
If an existing environment override causes a mismatch, inspect only whether it
is set, then remove that override. Never print credentials or config contents.
A connectivity failure is not a reason to register a new account.

## 4. Understand what persists

- `~/.agent-fs/config.json` stores the login, service URL, default org/drive and
  session expiry, with mode `0600`. A new shell uses the same saved login.
- In the managed sandbox, `/root` is on persistent NAS. Login config, Bun,
  the executable wrapper and its dependency archive survive pause/recreation.
- Extracted CLI dependencies under `/tmp` are temporary and restored from the
  archive when needed. Clearing this cache does not clear the saved login.
- In another Harness, persistence depends on keeping its home directory.
  Log in again after session expiry or revocation, not after every shell call.
- Memory files themselves remain in the online service. `/memory/dev.identity`
  is a path inside the agent-fs drive; native `cat` or `ls` cannot access it
  without a separate filesystem mount.

## 5. Read and search memory

Start with the digest or the smallest relevant file:

```bash
agent-fs ls /memory/dev.identity
agent-fs cat /memory/dev.identity/user.md --raw
agent-fs cat /memory/dev.identity/biography/digest.md --raw
agent-fs grep 'release' /memory/dev.identity/biography
agent-fs log /memory/dev.identity/user.md
```

`grep` takes a directory scope. Matches in `biography/` contain event JSON
with stable IDs; cite recovered events as `[[memory:<event-id>]]`.
Never invent an event ID or treat a partial result as the complete event count.

`cat` defaults to 200 lines when stdout is a terminal. Use `--offset` and
`--limit` to paginate, or download complete JSONL to a unique temporary file:

```bash
agent-fs download /memory/dev.identity/biography/events.jsonl -o /tmp/events-unique.jsonl
```

Choose an actual unique filename, process the downloaded file locally, then
remove it. Piped or redirected `cat --raw` is also suitable for complete reads
unless an explicit limit is supplied.

## 6. Make authorized changes

Read the current file and version before changing it. Use the CLI's `write`,
`edit` or `append` commands and check the specific command's `--help`.
For replacement writes, use `--expected-version` with the version you read.
On conflict, reread and reconcile. After a timeout, inspect the file before
repeating a write.

Keep explicit stable preferences in `user.md` and project notes in
`projects/*.md`. Treat `identity.md` and `biography/` as read-only unless the
user asks to change them. Events require stable unique IDs. Keep all files
under the supplied root and access them through `agent-fs`.
