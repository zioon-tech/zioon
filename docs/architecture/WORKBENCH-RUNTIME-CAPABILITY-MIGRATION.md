# Workbench / Runtime Capability Migration

> Status: implemented migration checkpoint
> Date: 2026-09-03
> Scope: clarify what belongs in Workbench, CLI, Runtime Core, Runtime Host, and
> plugin/device hosts; define how models, tools, context, and plugin
> capabilities migrate out of the browser without losing the current Workbench
> experience.

Related documents:

- [ZION-CLIENT-RUNTIME-SEPARATION.md](./ZION-CLIENT-RUNTIME-SEPARATION.md)
- [RUNTIME-ZION-NEXT-COMPATIBILITY.md](./RUNTIME-ZION-NEXT-COMPATIBILITY.md)
- [RUNTIME-LOCAL-TOOLS-BOUNDARY.md](./RUNTIME-LOCAL-TOOLS-BOUNDARY.md)
- [ZION-RUNTIME-PLATFORM-BLUEPRINT.md](./ZION-RUNTIME-PLATFORM-BLUEPRINT.md)

## 1. Core Position

Workbench and CLI are interaction surfaces. They should not each own a separate
Agent capability model.

The durable execution truth should live in Runtime Core and Runtime Host:

```text
Workbench UI  ─┐
CLI           ─┼─> Runtime Host ─> Runtime Core ─> Tool Brokers / Device Hosts
API / bot     ─┘
```

The long-term rule is:

- Workbench presents, configures, and observes.
- CLI submits text commands and observes.
- Runtime Host owns model profiles, credentials, interaction profiles, plugin
  runtime entries, tool catalog, persistence, and scheduling.
- Runtime Core executes Run state machines using host-provided models, tools,
  context providers, stores, and policy.
- Tool Hosts and Device Connectors perform resource-touching operations such as
  filesystem, terminal, SSH, mail, search, and MCP.

## 2. Migration Baseline

The migration started from a system that mixed these concerns:

| Concern | Former source | Problem |
| --- | --- | --- |
| Model configs | Workbench localStorage, Runtime profile store, CLI flags | Default model can differ by surface. |
| Tool definitions | Browser plugins set `chat.tools`; Runtime has its own broker definitions | CLI and Workbench can expose different tool lists. |
| Tool enablement | Workbench `chat.enabledTools` and localStorage; CLI `--tool` flags | A Workbench checkbox does not automatically affect CLI. |
| Message contributors | Browser `window.zion.messages.registerContributor`; Runtime context providers | Headless Runs lose browser-only contributors. |
| Plugin lifecycle | Workbench PluginLoader; Runtime Plugin Service v1 allowlist | Installing a Workbench plugin does not mean Runtime can use it. |
| Session and Run state | Runtime SQLite plus Workbench projection state | Mostly migrated, but client-local projections still need clear ownership. |

This causes user-visible confusion:

- A model selected in Workbench may not be the Runtime default.
- CLI can start a Session with no tools unless it explicitly sends a policy.
- Model answers about available tools may be hallucinated when the OpenAI request
  does not include `tools`.
- Runtime plugin v1 could add context providers but could not register
  model-callable tools.

## 3. Ownership Boundary

### 3.1 Runtime Core

Runtime Core should contain host-neutral execution semantics:

- Run and Attempt lifecycle.
- Event ordering.
- Message and tool-call loop.
- Context provider pipeline.
- Capability policy checks.
- Tool invocation protocol.
- Abort, timeout, checkpoint, and resume semantics.

It must not import:

- DOM, CodeMirror, browser APIs.
- Workbench plugin loader.
- localStorage.
- concrete model-provider UI config.
- local filesystem or terminal implementations.

### 3.2 Runtime Host

Runtime Host is the local or service-side control plane. It owns:

- Model Profile registry.
- Credential store.
- Interaction Profile store.
- Capability Catalog.
- Runtime Plugin Service.
- Tool Broker composition.
- Device Broker and project/resource bindings.
- SQLite persistence for Runs, Sessions, Scheduler, workbench documents, events,
  receipts, and state.
- Scheduler Worker.
- Project Automation coordinator and background heartbeat.

Runtime Host is where Workbench and CLI converge.

### 3.3 Workbench

Workbench owns interactive UI:

- Editor, panels, status bars, sidebars, cards, tool switcher, model switcher.
- Current selection, cursor, focused panel, visible document.
- Human approval UI and confirmation dialogs.
- Rendering Run events into messages, reasoning blocks, tool cards, diffs, and
  changes panels.
- Client-only draft state.

Workbench should not be the source of truth for:

- model credentials;
- default model;
- canonical enabled tool set;
- Scheduler execution;
- Run state;
- tool execution receipts.

### 3.4 CLI

CLI owns only terminal interaction:

- create or attach Session;
- send user messages;
- stream Run events;
- expose command-line overrides;
- return process-level success/failure for automation.

CLI should not maintain its own default tool catalog or default model. It should
ask Runtime Host for an Interaction Profile, then apply explicit user overrides.

## 4. Shared vs Local State

Workbench and CLI may affect each other only through Runtime-owned state.

| State | Shared across Workbench and CLI? | Owner |
| --- | --- | --- |
| Model profiles | Yes | Runtime Host |
| Credentials | Yes, never returned to clients | Runtime Host |
| Default interaction profile | Yes | Runtime Host |
| Tool catalog | Yes | Runtime Host |
| Runtime plugin enablement | Yes | Runtime Host |
| Session transcript | Yes, when clients attach same Session | Runtime Host |
| Run events | Yes | Runtime Host |
| Scheduler tasks and runs | Yes | Runtime Host |
| Workbench current editor selection | No | Workbench |
| Workbench panel layout | No | Workbench |
| CLI current input line | No | CLI |
| Unsaved tool checkbox draft | No, until persisted | Workbench |
| One-off CLI flags | No, unless saved as profile | CLI request override |

Rule:

> Saved configuration affects all clients. Unsaved UI state stays local to the
> client.

## 5. Interaction Profile

Introduce Runtime Host owned `InteractionProfile`.

It is the reusable description of how a user-facing interaction should run:

```json
{
  "id": "interactive.default",
  "label": "Default interactive agent",
  "modelProfileId": "workbench.user.dynamic.kimi-k2.5",
  "policy": {
    "preset": "trusted-automation",
    "allowedTools": [
      "read",
      "glob",
      "grep",
      "tree",
      "write",
      "edit",
      "Bash",
      "webSearch",
      "webFetch",
      "todoWrite",
      "mcpListTools",
      "mcpCall"
    ],
    "fileRoots": [],
    "allowedTerminalSessionIds": [],
    "allowedCommandPrefixes": [],
    "allowedRecipients": [],
    "maxMailPerRun": 0,
    "maxToolCalls": 50
  },
  "contextProviders": {
    "enabled": [
      "memory",
      "skills",
      "terminal-inventory",
      "project"
    ],
    "disabled": []
  },
  "metadata": {
    "includeTerminalContext": true
  }
}
```

Recommended defaults during local development:

- `interactive.default.modelProfileId = workbench.user.dynamic.kimi-k2.5`
- `interactive.default.policy.preset = read-only`
- read, search, inventory, skill, identity-context, and Session-query tools are
  enabled by default;
- write, command, control-plane mutation, and external-effect tools require an
  explicit Workbench selection or request override.

For stricter production or cloud profiles:

- use `read-only` or `workspace-write`;
- set explicit `fileRoots`;
- set explicit `allowedTerminalSessionIds`;
- require approvals for mutating or external side-effect tools.

### 5.1 Profile Resolution

Session and Run creation should accept:

```json
{
  "interactionProfileId": "interactive.default",
  "overrides": {
    "modelProfileId": "workbench.user.dynamic.kimi-k3",
    "policy": {
      "allowedTools": ["read", "grep", "webSearch"]
    },
    "metadata": {
      "includeTerminalContext": false
    }
  },
  "clientContext": {
    "surface": "workbench",
    "panelId": "panel-1",
    "selection": "..."
  }
}
```

Runtime Host resolves this into an immutable effective request:

```text
base InteractionProfile
  + saved project profile
  + client override
  -> resolved ModelRef
  -> normalized CapabilityPolicy
  -> enabled ContextProvider set
  -> model-callable ToolDefinition list
```

The resolved model, policy, and provider list are persisted on the Session/Run, so
later Workbench or CLI changes do not mutate already accepted Runs.

## 6. Capability Catalog

Runtime Host should expose a single catalog of model-callable capabilities:

```text
Runtime native tools
  webFetch
  todoWrite

local-tools / Device tools
  read
  glob
  grep
  tree
  write
  edit
  Bash
  webSearch
  sendMail
  mcpListTools
  mcpCall

Runtime plugin tools
  plugin-defined tools

Client capabilities
  foreground UI actions, only available while a compatible client is attached
```

Each catalog item should include:

```ts
type CapabilityCatalogItem = {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  owner: {
    kind: "runtime" | "plugin" | "device" | "client" | "mcp";
    id: string;
  };
  availability: {
    headless: boolean;
    requiresWorkbench: boolean;
    requiresDevice: boolean;
    requiresNetwork: boolean;
  };
  policy: {
    minimumPreset: "read-only" | "workspace-write" | "trusted-automation";
    requiresFileRoots?: boolean;
    requiresTerminalSession?: boolean;
    requiresApproval?: boolean;
    requiredScopes?: string[];
  };
};
```

Model requests should only receive tools produced by Runtime Host after applying
the effective policy. Clients should never serialize their own browser functions
into the model request.

## 7. Plugin Development Model

A plugin can target multiple hosts through explicit entries:

```json
{
  "zion": {
    "id": "dev.example",
    "entries": {
      "ui": "./main.js",
      "runtime": "./runtime.js",
      "device": "./device.js"
    },
    "runtime": {
      "apiVersion": 2
    }
  }
}
```

### 7.1 UI Entry

`main.js` runs in Workbench and may register:

- commands;
- views;
- status bar items;
- settings pages;
- tool result renderers;
- approval UI;
- editor integrations.

Example:

```js
export function activate(ctx) {
  ctx.subscriptions.push(
    window.zion.commands.registerCommand("example.openPanel", () => {
      // Workbench-only UI.
    })
  );
}
```

### 7.2 Runtime Entry

`runtime.js` runs in Runtime Host and should register headless capabilities:

```js
export const runtimePluginApiVersion = 2;

export function activateRuntimePlugin(ctx) {
  ctx.tools.registerTool({
    name: "example.searchDocs",
    description: "Search project documentation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" }
      },
      required: ["query"],
      additionalProperties: false
    },
    policy: {
      minimumPreset: "read-only"
    },
    async invoke(args, runContext) {
      return await ctx.state.namespace("docs").search(args.query, runContext);
    }
  });

  ctx.context.registerProvider({
    id: "example.projectContext",
    stage: "pre",
    order: 60,
    async contribute(messages, runContext) {
      return [
        { role: "user", content: "<project_context>...</project_context>" },
        ...messages
      ];
    }
  });
}
```

### 7.3 Device Entry

`device.js` runs where local resources exist. Runtime routes to it through a Tool
Host or Device Connector.

Use this for:

- filesystem access;
- terminal execution;
- SSH-bound work;
- OS-specific operations;
- tools that require installed local binaries.

Runtime should keep the tool schema and authorization policy; the Device only
executes the already-authorized invocation within its local sandbox.

### 7.4 Client Capabilities

Some plugin abilities cannot be headless:

- use current editor selection;
- open a diff view and ask the user to accept;
- show a browser picker;
- read unsaved UI-only state.

These should be declared as client capabilities rather than Runtime tools. Runtime
may route them only when an attached Workbench client advertises support.

CLI should not receive these capabilities unless an explicit CLI equivalent
exists.

## 8. Proposed Runtime Plugin API v2

Runtime Plugin API v1 currently supports only `contextProviders`. API v2 should
add explicit registries:

```ts
type RuntimePluginContextV2 = {
  apiVersion: 2;
  plugin: {
    id: string;
    version: string;
  };
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
  tools: {
    registerTool(tool: RuntimeToolContribution): Disposable;
  };
  context: {
    registerProvider(provider: RuntimeContextProvider): Disposable;
  };
  runs: {
    registerPostProcessor(processor: RuntimeRunPostProcessor): Disposable;
  };
  state: {
    namespace(name?: string): RuntimeNamespacedState;
  };
  events: {
    emit(type: string, payload?: unknown): void;
    on(type: string, handler: (payload: unknown) => void): Disposable;
  };
};
```

Initial constraints:

- v2 plugins remain trusted same-process code.
- Plugin tool names must be globally unique or namespaced by plugin ID.
- A plugin cannot bypass Runtime policy.
- Tool schemas must be serializable JSON Schema.
- Tool results must be serializable and bounded.
- Plugin failures are isolated and reported in `/health`.
- Runtime disposes plugins in reverse activation order.

## 9. Runtime Host APIs

Add these APIs before changing Workbench defaults:

```text
GET  /v1/capabilities/tools
GET  /v1/models
PUT  /v1/model-profiles/{id}
DELETE /v1/model-profiles/{id}
GET  /v1/interaction-profiles
GET  /v1/interaction-profiles/{id}
PUT  /v1/interaction-profiles/{id}
PATCH /v1/interaction-profiles/{id}
POST /v1/sessions
POST /v1/runs
GET  /v1/project-automation
POST /v1/project-automation/projects/{projectKey}/run
POST /v1/project-automation/projects/{projectKey}/stop
```

`POST /v1/sessions` and `POST /v1/runs` should accept:

```ts
{
  interactionProfileId?: string;
  model?: ModelRef;             // override
  policy?: Partial<CapabilityPolicy>; // override
  sessionHistory?: TranscriptMessage[]; // first-bind seed, before current user message
  metadata?: Record<string, unknown>;
  clientContext?: ClientContextSnapshot;
}
```

Resolution must happen server-side. The response should include the effective
model and policy summary so clients can render what actually happened.

## 10. Workbench Migration Plan

### Phase 0: Document and Freeze Boundaries

- Keep current behavior working.
- Do not add new browser-only Agent tools unless they are explicitly marked
  client-only.
- Document which current tools are headless, device-bound, or UI-only.

### Phase 1: Interaction Profile Store

- Add Runtime `InteractionProfileStore`.
- Seed `interactive.default`.
- Default model: `workbench.user.dynamic.kimi-k2.5` when present; otherwise the
  Runtime active profile.
- Add `/v1/interaction-profiles/*`.
- Update CLI to use `interactive.default` by default.

### Phase 2: Workbench Uses Runtime Profiles

- Model switcher reads Runtime model profiles.
- Workbench model selection writes the active interaction profile or per-session
  override.
- Existing localStorage model configs are imported once through
  `PUT /v1/model-profiles/{id}`.
- Browser keeps only display cache and migration markers.

### Phase 3: Tool Catalog Migration

- Runtime exposes `GET /v1/capabilities/tools`.
- Workbench tool switcher renders Runtime catalog plus client-only capabilities.
- Tool enablement writes to InteractionProfile.
- `chat.enabledTools` becomes a projection/cache, not the source of truth.
- Runtime request creation no longer depends on `tools.parseFromContent`.

### Phase 4: Runtime Plugin API v2

- Add `ctx.tools.registerTool`.
- Add `ctx.context.registerProvider`.
- Add namespaced plugin state.
- Add plugin-scoped events.
- Keep v1 compatibility for existing context-only Runtime plugins.

### Phase 5: Migrate Built-in Plugins

Suggested order:

1. Terminal Manager: keep Runtime context provider; add explicit terminal/device
   capabilities if needed.
2. Skills: move skill discovery and `<available_skills>` context to Runtime.
3. Memory / Identity: move durable project/user context providers to Runtime.
4. Tools: split UI panels from Runtime tool catalog.
5. Models: make Workbench model UI a Runtime profile editor.
6. Scheduler: ensure tasks reference InteractionProfile IDs instead of embedding
   ad hoc capability objects.

### Phase 6: Deprecate Browser Agent Ownership

- Browser execution path remains only as compatibility fallback.
- Workbench no longer builds OpenAI `tools` payload directly.
- Workbench no longer owns model credentials.
- Runtime is the default execution path for ordinary chat and Scheduler.

## 11. CLI Migration Plan

CLI should become thin:

```bash
zion runtime:chat --profile interactive.default
zion runtime:chat --session <id>
zion runtime:chat --override-model workbench.user.dynamic.kimi-k3
zion runtime:chat --no-tools
zion runtime:chat --no-terminal-context
```

Until a separate binary exists, `npm run runtime:chat` should follow the same
contract.

CLI-specific flags should be request overrides, not a separate capability source.

## 12. Safety Model

"Trusted local" remains an explicit profile or per-Run override, not the default:

```text
preset: trusted-automation
allowedTools: all Runtime-supported headless tools
fileRoots: []
allowedTerminalSessionIds: []
allowedCommandPrefixes: []
maxToolCalls: 50
```

This intentionally keeps these guardrails:

- the built-in default remains read-only until the user changes it;
- Runtime must still decide which tools are exposed.
- Tool Host still applies local sandbox and canonical-path checks.
- `sendMail` requires explicit recipients and quota.
- `webFetch` rejects private, loopback, link-local, and metadata targets.
- Device mode narrows Runtime policy to Device resource bindings.
- Tool invocation receipts prevent repeated side effects after replay.

Future remote/cloud profiles must be stricter by default.

## 13. Acceptance Criteria

The migration is correct when:

- Workbench and CLI can create Sessions from the same `interactive.default`
  profile.
- Asking the model what tools are available matches the `model.request.tools`
  payload in Runtime events.
- Changing default model in Workbench updates Runtime Host, and a new CLI Session
  uses the same default.
- Workbench closure does not remove Runtime plugin tools or context providers.
- Runtime restart preserves profiles, sessions, runs, events, and scheduler state.
- Browser-only client capabilities are never exposed to CLI as if they were
  headless tools.
- A plugin with `entries.runtime` can register a tool usable by CLI without
  Workbench open.
- A plugin with only `entries.ui` cannot accidentally affect headless execution.

## 14. Immediate Implementation Checklist

- [x] Add `InteractionProfileStore` under `apps/runtime/src`.
- [x] Add default profile seeding with `workbench.user.dynamic.kimi-k2.5`
  preference.
- [x] Add `/v1/capabilities/tools`.
- [x] Add `/v1/interaction-profiles` APIs.
- [x] Update `/v1/sessions` and `/v1/runs` to resolve
  `interactionProfileId`.
- [x] Update CLI to request `interactive.default` by default.
- [x] Update Workbench Runtime bridge to request `interactive.default` while
  preserving current Workbench model/tool overrides.
- [x] Move Workbench tool switcher persistence from localStorage projection to
  Runtime `InteractionProfile`, with localStorage retained as browser/offline
  fallback.
- [x] Upgrade Runtime Plugin API to v2 with `ctx.tools.registerTool`.
- [x] Move model switcher default-model persistence from localStorage to Runtime
  `InteractionProfile`, with localStorage retained as browser/offline fallback.
- [x] Migrate one simple built-in tool plugin as the reference
  (`dev.terminal-manager` registers `terminalInventory` and the Device-backed
  `terminalManage` tool from its Runtime v2 entry).
- [x] Make Workbench tool switcher render Runtime-only plugin tools from
  `/v1/capabilities/tools`.
- [x] Add `scheduled.default` and let Scheduler tasks carry
  `interactionProfileId`; existing task `capability` remains a per-task override
  for compatibility.
- [x] Move `user.dynamic` model CRUD to Runtime Host first, with browser
  localStorage retained only as offline fallback / sanitized projection.
- [x] Keep imported model credentials write-only in Runtime credential store;
  Workbench receives only `credentialConfigured`.
- [x] Add a `dev.langchain-chat` Runtime v2 entry for `modelsManage`, backed by
  Runtime Host model profiles, credentials, and `interactive.default`
  InteractionProfile updates; browser provider health probes remain a
  Workbench-side enhancement.
- [x] Add a `dev.tools` Runtime v2 entry for `toolsManage`, backed by Runtime
  capability catalog inspection and InteractionProfile policy patching.
- [x] Add a `dev.plugins` Runtime v2 entry for the headless `pluginsManage`
  subset. Catalog search and development-session lifecycle use the Device-hosted
  Plugin Host; Workbench-local enable, disable, install, and uninstall state
  remains client-owned and is not exposed as a headless action.
- [x] Add a `dev.mail` Runtime v2 entry for `mailManage`, backed by
  `InteractionProfile.policy.allowedRecipients`, `maxMailPerRun`, and
  `sendMail` tool enablement; SMTP host/password configuration remains
  device/local-tools configuration owned by the Workbench mail panel.
- [x] Persist Skills snapshot into Runtime workbench-state KV and load it from
  the `dev.skills` Runtime v2 entry as a headless `<available_skills>` context
  provider.
- [x] Persist Memory snapshot into Runtime workbench-state KV and load it from
  the `dev.memory` Runtime v2 entry as a headless `<working_memory>` context
  provider, with Workbench localStorage retained as fallback/projection.
- [x] Add Runtime `memoryManage` read-only safe actions
  (`list/tree/read/search/build_context/providers`) backed by the Runtime
  Memory snapshot.
- [x] Move Runtime `memoryManage` write semantics
  (`create/update/delete/select/settings`) onto the Runtime Memory snapshot in
  plugin KV; Workbench localStorage remains a projection/fallback, while direct
  filesystem-backed Memory providers remain a future Device/file-broker
  boundary.
- [x] Persist Agents task snapshot into Runtime workbench-state KV and add a
  `dev.agents` Runtime v2 entry for read-only `agentsManage`
  (`list_agents/list_tasks/get_task`).
- [x] Move Runtime `agentsManage` task-state writes
  (`create_task/create_research_task/delete_task/select_task`) onto the Runtime
  Agents snapshot in plugin KV.
- [x] Add Runtime Host-backed `agentsManage run_task/stop_task` support:
  `dev.agents` can now start background Agent Runs through the Runtime
  executor, apply a task/profile-constrained capability policy, and persist
  running/completed/aborted state back to the Agents plugin KV snapshot;
  `reveal_task` and `open_panel` remain Workbench-only UI attachment actions.
- [x] Add Workbench projection polling for Runtime-backed Agent Runs: while a
  Runtime Agents snapshot contains running tasks, the Workbench periodically
  restores the Runtime KV snapshot so task details and terminal results become
  visible without reopening the Workbench.
- [x] Persist Identity rendered context snapshot into Runtime workbench-state KV
  and load it from the `dev.identity` Runtime v2 entry as a headless
  `<identity_context>` provider; the remaining Identity file, biography, and
  project automation responsibilities are migrated by the following items.
- [x] Add Runtime `identityManage` for rendered Identity snapshot management:
  `get` is read-only, while `update_snapshot`, `patch_files`, and `clear`
  update only the Runtime plugin KV snapshot under workspace-write policy.
- [x] Add a Runtime Host plugin file service for Identity profile files:
  `identityManage load_files/write_files` reads or writes the whitelisted
  identity/user/biography/project context files through the existing
  local-tools/Device broker with `file_root`-scoped policy, then refreshes the
  Runtime Identity snapshot.
- [x] Move Biography event persistence and digest rebuild into Runtime:
  `identityManage append_biography_events` appends deduplicated events to
  `biography/events.jsonl`, rebuilds `biography/digest.md`, and refreshes the
  Runtime Identity snapshot through the same `file_root`-scoped file service.
- [x] Add Runtime Run post-processors to Plugin API v2 and register
  `dev.identity.biography`: completed Runtime Runs now trigger Runtime-side
  biography distillation via the Host model service, then persist the resulting
  events through `identityManage append_biography_events`; the Workbench
  `chat/runFinished` path is skipped for `backend: runtime` events and remains
  only as compatibility for browser-owned Runs.
- [x] Move Project Automation policy state into `dev.identity` Runtime plugin
  KV and expose `projectAutomationManage
  get/request_update/disable/run_now/stop`.
  Workbench `globalState.projectAutomation.v1` is now a projection/offline
  fallback: activation, Runtime reconnect, completed Runtime Runs, and manual
  project refresh compare document revisions, restore newer Runtime state, or
  upload newer local state without duplicate configuration.
- [x] Keep Project Automation approval user-owned: the model-callable Runtime
  tool can create a pending request but does not expose `approve_request` or
  `reject_request`; the Biography UI resolves requests and synchronizes the
  resulting document back to Runtime.
- [x] Move Project Automation heartbeat coordination and `run_now/stop`
  execution into Runtime Host. The `dev.identity` coordinator reads project
  files through the scoped plugin file service, starts bounded Runs through the
  shared Runtime Agent runner, mirrors those tasks into the `dev.agents` Runtime
  KV, persists running/completed/failed policy state, and records attention
  items. Runtime exposes dedicated run/stop control-plane routes; Workbench
  suppresses its local heartbeat and polls Runtime projections while the health
  contract advertises `projectAutomationWorker: true`, retaining the browser
  coordinator only as an offline/older-Host fallback.
- [x] Externalize the complete `dev.identity` UI and Runtime Entry as one
  versioned package. Runtime marks plugin origins, requires Identity from the
  external plugin root without built-in fallback, and loads the Project
  Automation coordinator from the bundled Runtime Entry instead of importing
  Identity source from Runtime Host core.
- [x] Exclude Workbench contributors that are already backed by active Runtime
  context providers when creating Runtime Runs, preventing duplicate Skills,
  Memory, Identity, and terminal inventory injections.
- [x] Add a `dev.context-compression` Runtime v2 post-stage ContextProvider.
  Workbench settings synchronize into plugin KV, Runtime preserves canonical
  `toolCalls/toolCallId` transcript fields during compression, and the
  Workbench contributor is excluded whenever the Runtime provider is active.
- [x] Preserve multimodal `text/image_url` message parts through the Workbench
  Runtime bridge, Runtime Core transcript, OpenAI-compatible model request, and
  canonical Session history. Unknown content-part types remain rejected rather
  than silently stringified.
- [x] Persist a canonical Run transcript separately from the Workbench message
  projection. Runtime records assistant reasoning, tool calls, full tool
  results, and final responses by turn/ordinal; Session `/transcript` rebuilds
  cross-Run model history from those entries while `/messages` remains the
  backward-compatible user/assistant UI projection.
- [x] Add atomic Runtime Session fork. A fork copies the source's stable
  user/assistant projection while sharing immutable Run transcript history;
  Workbench mirrors its generated fork ID through the Runtime control plane so
  subsequent Runs diverge without losing reasoning or tool context.
- [x] Persist Runtime file Artifacts and ChangeSets at the Tool Broker boundary.
  Successful `write/edit/apply_patch` invocations receive deterministic artifact
  IDs, SQLite stores the bounded change payload beside the durable invocation
  receipt, and Run/Session artifact APIs feed the existing Workbench Changes
  panel after reconnect.
- [x] Standardize Runtime tool presentation metadata. `tool.requested`,
  `tool.completed`, and `tool.denied` project a generic renderer envelope with
  title, status, and artifact IDs; existing specialized cards remain optional
  enhancements while unknown Runtime tools render through the JSON fallback.
- [x] Add the standalone `zion` Runtime control CLI. It supports one-shot Runs,
  attach/resume/abort, Session list/get/transcript/fork, scheduled-task
  list/get/run/runs/cancel, and versioned human or JSONL output without loading
  Workbench code or browser tool handlers.
- [x] Add local/cloud CLI endpoint profiles and a standalone Host fixture.
  Profiles keep only endpoint metadata and bearer-token environment references;
  the token value is injected into requests at runtime and never stored or
  printed. CI now executes `zion run --jsonl` against a real in-process Runtime
  Server and verifies canonical RunEvent output.
- [x] Add projected-token workload identity and CLI Tool Host mode. Cloud
  profiles may resolve a short-lived bearer token from a configured token-file
  environment variable, while `zion device connect` reuses
  `DeviceConnector + LocalToolsDeviceHost` to expose scoped local tools without
  starting Workbench.
- [x] Add OAuth 2.0 device authorization for cloud CLI profiles. The CLI emits
  the verification URI and user code, follows RFC 8628 pending/slow-down
  semantics, refreshes expired credentials, and stores access/refresh tokens in
  macOS Keychain rather than profile files.
- [x] Split Scheduler UI from the headless Scheduler management tool:
  `dev.scheduler` now has a Runtime v2 entry that registers `schedulerManage`
  against Runtime Host's Scheduler store, while `open_panel` remains a
  Workbench-only action.
- [x] Enrich `/v1/capabilities/tools` with catalog metadata
  (`owner`, `availability`, and `policy.minimumPreset`) so Workbench and CLI can
  distinguish Runtime-native, plugin, device/local-tools, MCP, and UI-only
  capabilities without guessing from browser `chat.tools`.
- [x] Add a `dev.session-manager` Runtime v2 entry for session inspection
  (`sessionList`, `sessionGet`) backed by Runtime workbench-state.
- [x] Move Session Manager write primitives into Runtime Host-backed atomic
  state operations: `sessionCreate`, `sessionUpdate`, and `sessionDelete` are
  now Runtime v2 workspace-write tools backed by SQLite workbench-state updates
  that keep document, metadata, tree, index, revisions, tombstones, and
  operation-id idempotency in one transaction.
- [x] Expose Runtime-native `todoWrite` state through Runtime Host todo-list
  read APIs and let Workbench Task Panel restore that state into its local
  `todo.tasks` projection, so CLI/headless todo updates remain visible after
  Workbench reconnects.
