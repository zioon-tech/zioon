# Commands

Official endpoints: https://runtime.zioon.tech, https://zioon.tech/docs/.
The fixed matching CLI download is https://zioon.tech/downloads/zioon-cli-0.3.0.tgz.

```sh
zioon auth login zioon-cloud
zioon auth status zioon-cloud
zioon session list --limit 10
zioon session transcript SESSION_ID
zioon chat --session SESSION_ID
zioon chat --continue
zioon chat --image screenshot.png
zioon run "Continue the work" --session SESSION_ID --jsonl
zioon attach RUN_ID --jsonl
zioon abort RUN_ID --reason "User requested stop"
zioon resume RUN_ID --wait-id WAIT_ID --input-file response.json
zioon profile show zioon-cloud
```

Account extension lifecycle:

```sh
zioon extensions init my-tool --kind plugin
zioon extensions dev my-tool
zioon extensions dev list
zioon extensions dev stop my-tool
zioon extensions publish my-tool
zioon extensions publish my-tool --public
zioon extensions validate my-tool
zioon extensions pack my-tool --out my-tool-0.1.0.zion.json
zioon extensions upload my-tool-0.1.0.zion.json
zioon extensions install LISTING_ID@0.1.0
zioon extensions configure LISTING_ID --node NODE_ID
zioon extensions probe LISTING_ID
zioon extensions call LISTING_ID --tool hello --args '{"name":"Zioon"}'
```

`dev` keeps watching; edits install only after the build and metadata transaction succeed. Runtime builds reserve package overhead and allow 190KB including build metadata; complete release artifacts allow 200KB. Bundle third-party dependencies. `publish --public` returns `status: submitted`, and review makes it visible to other accounts. Development versions never overwrite published versions.

Installed extension files:

```sh
zioon extensions files LISTING_ID
zioon extensions read LISTING_ID --path SKILL.md
zioon extensions write LISTING_ID --path SKILL.md --file ./SKILL.md --source-hash ACTUAL_HASH
zioon extensions reload LISTING_ID --source-hash ACTUAL_HASH_AFTER_SAVE
zioon extensions restore LISTING_ID
zioon extensions install LISTING_ID@NEW_VERSION --switch-source
```

Use paths and hashes returned by `files`/`read`; plugin packages may use `main.mjs` and `zion-extension.json`, while bundles use `skills/COMPONENT_ID/SKILL.md`. Writes save the account source. Reload validates it and stores the private immutable OSS revision before switching backend and UI together. The source installation version stays fixed. Restore and source updates preserve edited directories. Handle a stale hash by reading again and merging the edits, never by silently overwriting.

```sh
zioon extensions init intranet-model --kind model
zioon extensions dev intranet-model
zioon extensions configure LISTING_ID --node NODE_ID --credentials-file /private/connection.json
zioon extensions configure LISTING_ID --settings-file public-settings.json
```

The model template's `request(body, context)` runs on the selected Node and returns an HTTP response. It uses `context.abortSignal`, `context.env` and `context.settings`. Keep the endpoint fixed in the module and refuse redirects. Declare `supportsStreaming: false` for JSON-only services.

Full Runtime SDK plugins:

```sh
zioon extensions list --host runtime
zioon extensions show dev.agent-device-cloud --host runtime
zioon extensions call dev.agent-device-cloud --host runtime --tool adc_status --args '{}'
```

`adc_status` can complete with `connected: false`. That is an actual status, not an OAuth or device execution success.
The chosen interaction profile must permit the tool. Use `--profile` only for a profile the account can access.

```sh
zioon api GET /v1/account/me
zioon api GET /v1/marketplace/snapshot
zioon api GET /v1/capabilities/tools
zioon api POST /v1/runs --data-file run-request.json
```

Account tool request:

```json
{
  "prompt": "Extension call",
  "interactionProfileId": "interactive.default",
  "policy": {
    "preset": "trusted-automation",
    "allowedTools": ["extensionsCall", "write", "Bash"],
    "fileRoots": ["/workspace"]
  },
  "metadata": {
    "extensionInvocation": {
      "action": "call",
      "listingId": "LISTING_ID",
      "epoch": "ACTUAL_EXECUTION_EPOCH",
      "tool": "hello",
      "arguments": {"name": "Zioon"}
    }
  }
}
```

Get the actual epoch and configured workspace from the account snapshot. Prefer the SDK's `extensionRunRequest` helper to handwritten requests.
For full plugins use `runtimePluginToolRequest(pluginId, discoveredTool, args, profileId)`.
Read the returned Run snapshot and inspect the status. CLI exits are 0 completed,
1 failed, 2 interrupted, 3 waiting and 130 aborted. A waiting Run is not finished.
Use the observed wait ID and the requested input shape; never invent approval.

Mac credentials use Keychain; Linux uses user-owned private files; Windows uses CurrentUser DPAPI.
Endpoint config is `~/.zion-next/cli.json`. It contains URLs and auth types, not account token values.
