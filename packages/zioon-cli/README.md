# Zioon CLI

Node.js >=22.5.0, npm; macOS, Linux and Windows.

```sh
npm install --global https://zioon.tech/downloads/zioon-cli-0.2.1.tgz
zioon --version
zioon auth login zioon-cloud
zioon run "Write a clear release plan."
zioon extensions list
zioon extensions list --host runtime
zioon api GET /v1/account/me
```

`zion` is an alias. This is a self-contained npm tarball with zero runtime dependencies and no installation scripts. It does not require the repository. `@zioon/cli` is the package's module name; a public npm registry release is not claimed.

Authentication uses account device consent. macOS uses Keychain, Linux uses 0700/0600 user-owned files, Windows uses CurrentUser DPAPI. Credentials are never printed by status. `ZIOON_CLI_CREDENTIAL_DIR` selects a private file store for isolated environments.

`zioon-cloud` is built in. Existing `~/.zion-next/cli.json` profiles and default choice are preserved. An explicit `--url URL --account` uses a separate account credential bound to that origin.

The Node SDK is imported as `@zioon/cli` when installed locally in a project:

```js
import { createAccountRuntimeClient } from "@zioon/cli";
const { runtime, extensions } = await createAccountRuntimeClient();
const { runId } = await runtime.createRun({ prompt: "Summarize this week's plan." });
const run = await runtime.followRun(runId, () => {});
console.log(run.status, run.output);
console.log(await extensions.snapshot());
```

The reusable agent instructions are in `skills/zioon/SKILL.md` with command references. See https://zioon.tech/docs/agent-skill/ for installation.

Account plugin development in CLI 0.2.0:

```sh
zioon extensions init my-tool --kind plugin
zioon extensions dev my-tool
zioon extensions dev list
zioon extensions dev stop PLUGIN_ID
zioon extensions publish my-tool
zioon extensions publish my-tool --public
```

The template contains one handler plus the helper and development scripts. The watch command stages local built JavaScript into the account's persistent workspace; successful builds and development installations switch together in PostgreSQL. Workbench, CLI and SDK discover the same account version. TypeScript projects should point the command at their build output. Runtime builds allow 190KB including metadata, reserving space within the release artifact's 200KB limit.

`publish` creates a private immutable version; `--public` submits a package with its source URL for marketplace review. Upload does not install a release. Local device development remains `dev start DIRECTORY --node NODE_ID --watch`. Configure a paired Node only when a plugin needs that device or intranet access; the workspace root is discovered and Host/dependency preparation is automatic.

Use `--kind model` for a model request handler. The model Node and conversation tool Node are independent. The platform handles JSON/SSE, usage, completion, cancellation, revocation and backpressure. User modules execute only in isolated Node processes or account sandboxes.

The Runtime and Workbench must include the matching development update. An older Runtime returns `development_upgrade_required`. `dev start DIRECTORY --node NODE_ID --device-only` and `dev list --node NODE_ID --device-only` manage the existing Node-local watcher without claiming account-wide UI installation. `dev stop PLUGIN_ID --stop-source` unregisters first and also attempts to stop the source watcher; the default only unregisters.

The SDK's `development.start(directory, nodeId)`, `development.list()`, `development.snapshot()` and `development.stop(pluginId)` reuse the saved account. Offline sources remain registered. Concurrent registration edits reject stale revisions; inspect state before retrying.

Tools require a provisioned account sandbox or explicitly authorized device. Run snapshots determine completion; HTTP 202 is acceptance. Unknown outcomes require inspection before retrying.

Installed file editing in CLI 0.2.1:

```sh
zioon extensions files LISTING_ID
zioon extensions read LISTING_ID --path SKILL.md
zioon extensions write LISTING_ID --path SKILL.md --file ./SKILL.md --source-hash ACTUAL_HASH
zioon extensions reload LISTING_ID --source-hash ACTUAL_HASH_AFTER_SAVE
zioon extensions restore LISTING_ID
```

`files` prepares a persistent editable account workspace. Use the returned source hash when saving or reloading. Saved changes become effective only after validation and a successful reload. Backend execution and Workbench UI use the same immutable private OSS revision; the original installation version and publisher package remain unchanged. Restore switches execution to the publisher version and preserves the edited directory. A source update with `install LISTING_ID@VERSION --switch-source` also archives the existing directory. Skill packages include references and scripts; credentials must remain outside the package.

Docs: https://zioon.tech/docs/cli/
