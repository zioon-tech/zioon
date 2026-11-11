---
name: zioon
description: Use Zioon CLI and API to manage conversations, Runs and installed plugins. Invoke for Zioon login, tasks, sessions, extensions or plugin development. Do not use for ADC device administration or Memory.
---

# Zioon

Use `zioon` (`zion` is an alias). Require Node.js 22.5 or newer.
Read `references/commands.md` for exact commands and API request formats.

1. Run `zioon --version` and `zioon --help`. The matching release is CLI 0.3.0. Install its fixed artifact with `npm install --global https://zioon.tech/downloads/zioon-cli-0.3.0.tgz` when available at the official site; do not guess npm registry package names.
2. Run `zioon profile list` and `zioon auth status zioon-cloud`. Reuse the user's chosen Runtime profile. If login is needed, run `zioon auth login zioon-cloud` and give the displayed verification URL and code to the user. Never complete consent using someone else's credentials.
3. List sessions before continuing prior work. Use the returned IDs; never invent IDs. Create a new session for unrelated work.
4. Submit tasks through `run` or session chat. Check the final Run status. HTTP 202 only means accepted. A waiting Run exits with code 3 and retains its session. Read its reason and requested response before `resume RUN_ID --wait-id WAIT_ID --input-file response.json`; respond only within the user's authorization. Stop with `abort RUN_ID`; closing a listener does not stop the server.
5. Discover installed account extensions with `extensions list`. Discover full Runtime plugins with `extensions list --host runtime` and inspect `show`. Call only discovered tool names with the matching host.
6. Use `api` or the Node SDK for exact JSON requests through the same existing account. Never print, export or read stored tokens for ordinary integration.
7. For authorized plugin development, use `extensions init DIRECTORY --kind plugin` or `--kind model`, then `extensions dev DIRECTORY`. The watch command stages source into the account workspace and atomically installs each successful build for Workbench debugging. The template's single handler is enough; Host setup and MCP dependencies are automatic. Use `dev stop PLUGIN_ID` to unregister.
8. Use `extensions publish DIRECTORY` for an immutable private version. `--public` submits the same package for marketplace review; a submitted package is not published yet. Public packages require a credential-free HTTPS source URL. Increase both package and plugin manifest versions after code changes. Offline `pack --out` and `upload` remain available.
9. Installation defaults to the account workspace. Select a paired Node only for device or intranet dependencies with `configure LISTING_ID --node NODE_ID`; discovery supplies its workspace root. Use `--settings-file` for declared public settings and `--credentials-file` only for a private execution-side connection reference. Credential values never belong in the artifact or public settings. Probe is an optional diagnostic; first invocation prepares and discovers automatically.
10. For authorized edits to an installed extension, use `files` and `read` to obtain the account source and its current hash, then `write --path PATH --file LOCAL_FILE --source-hash HASH`. Reload with the new hash to validate and switch the immutable private revision for both backend and Workbench. Failed validation preserves the previous revision. `restore` returns to the publisher version while preserving edits; source updates require `install LISTING_ID@VERSION --switch-source`. These operations do not publish or create another listing. Skill references and scripts are part of the editable package.

Tools execute in the account sandbox or an explicitly authorized device. Local CLI working directories do not automatically authorize paths. Never use the platform server as a user execution fallback.
Model providers use their installed Node independently of the Run's file/tool target. Static UI, Skill and declared model catalogs do not require waking the execution Host. Shared Nodes accept bundled Node stdio MCP servers with filesystem restrictions; other executables require a dedicated account execution resource.

For `execution_outcome_unknown`, inspect actual effects before retrying. Preserve Run IDs and durable receipts. Do not silently retry mutations, change accounts, enable extensions or widen device permissions.

Use the ADC CLI for independent device management and agent-fs for independent Memory operations. An installed ADC Runtime plugin may be called through Zioon after its own OAuth connection is completed.
