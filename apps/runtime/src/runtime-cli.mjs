import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { DEFAULT_INTERACTION_PROFILE_ID } from "./interaction-profile-store.mjs";
import { runChatCli } from "./chat-cli.mjs";
import { boundedFetch, followCliRun } from "./cli-run-follow.mjs";
import { createActivity, createAnswerRenderer, printAuthStatus, printList, safeText, terminalTheme } from "./cli-terminal.mjs";
import { friendlyCliError } from "./cli-chat-shell.mjs";
import { EXTENSIONS_USAGE, LOCAL_EXTENSION_ACTIONS, parseExtensionsArgs, runExtensionsCli } from "./extensions-cli.mjs";
import {
  LOCAL_TOOLS_TOOL_DEFINITIONS,
  LocalToolsDeviceHost
} from "../../../packages/local-tools-client/src/index.mjs";
import {
  DEVICE_PROTOCOL_VERSION
} from "../../../packages/node-protocol/src/index.mjs";
import {
  DeviceConnector,
  exchangeDevicePairing
} from "../../device-connector/src/device-connector.mjs";
import {
  createDeviceCredentialStore,
  deviceCredentialKey
} from "../../device-connector/src/device-credential-store.mjs";
import {
  defaultDeviceProjectId,
  defaultDeviceResourceId,
  ensureDeviceTerminalSessions,
  normalizeLocalToolsUrl,
  resolveDeviceWorkspaceRoot
} from "../../device-connector/src/device-setup.mjs";
import { createCliCredentialStore } from "./cli-credential-store.mjs";
import {
  loginWithOAuthDeviceFlow
} from "./oauth-device-flow.mjs";
import { manageAccountLogin, resolveRuntimeCliHeaders } from "./accounts/cli-account-auth.mjs";
import {
  subscribeEventSource
} from "../../../packages/runtime-client/src/sse.mjs";
import {
  getRunProjectionEvents as fetchRunProjectionEvents,
  subscribeRunStream
} from "../../../packages/runtime-client/src/run-stream.mjs";
import { createActivityFeed } from "./cli-activity-feed.mjs";
import { runSpacesCli, SPACES_USAGE } from "./spaces-cli.mjs";
import { createSpacesClient } from "../../../packages/runtime-client/src/spaces.mjs";
import { runSharingCli, SHARING_USAGE } from "./sharing-cli.mjs";

const USAGE = `zioon — conversations in your terminal

Usage: zioon [command] [options] (alias: zion)

Quick start:
  zioon                         Open chat
  zioon --continue              Reopen your last conversation and draft
  zioon chat --session <id>      Continue a conversation
  zioon run "summarize this"     Run a single prompt
  zioon session list            Find recent conversations
  zioon auth login              Sign in

In chat: /help · /sessions · /new · /history · /exit
         Enter send · Alt+Enter newline · Tab complete · Esc stop

Commands:
  chat                         Start the interactive Runtime chat shell
  run <prompt>                 Start a Run and follow it to completion
  attach <run-id>              Follow an existing Run
  resume <run-id>              Resume a waiting or interrupted Run and follow it
  abort <run-id>               Abort an active Run
  session list                 List Runtime Sessions
  session get <session-id>     Show Session metadata
  session transcript <id>      Print the canonical Session transcript
  session fork <session-id>    Fork a Session
  session attach <session-id>  Follow the Session's active Run
  session watch <session-id>   Stream durable Session and Run events
  task list                    List scheduled tasks
  task get <task-id>           Show a scheduled task
  task run <task-id>           Queue a scheduled task immediately
  task runs [task-id]          List scheduled task Runs
  task cancel <run-id>         Cancel a scheduled task Run
  profile list                 List configured Runtime endpoints
  profile show [name]          Show a sanitized Runtime endpoint profile
  auth login [profile]         Sign in with an account or OAuth device-code profile
  auth status [profile]        Show sanitized credential status
  auth logout [profile]        Delete the profile credential
  extensions <action>          Create, upload and manage account extensions
  share <action>               Share models, conversations and folders by link
  device connect               Run this CLI as an outbound Device Tool Host

Options:
  --url <url>                  Runtime URL (default http://127.0.0.1:8766)
  --runtime-profile <name>     Local/cloud endpoint profile from CLI config
  --account                   Use account login for --url without a profile
  --jsonl                      Emit stable JSON Lines records
  --raw-events                 Consume uncoalesced diagnostic Run events
  --plain                     Basic chat prompt, no terminal UI
  --session <id>              Attach a new Run to a Session
  --profile <id>              Runtime interaction profile
  --model-profile <id>        Runtime model profile
  --project <id>              Device-routed project
  --preset <preset>           read-only, workspace-write, trusted-automation
  --tool <name[,name...]>      Allowed tool; repeatable
  --file-root <path>          Allowed file root; repeatable
  --terminal-session <id>     Allowed terminal Session; repeatable
  --max-tool-calls <count>    Per-Run tool-call limit
  --title <text>              Run, Session, or fork title
  --reason <text>             Abort/cancel reason
  --wait-id <id>              Observed wait to resume
  --input-file <path>         JSON response for the waiting Hook
  --limit <count>             List result limit
  --after <sequence>          Resume an event stream after a sequence
  --local-tools-url <url>     local-tools endpoint for device connect
  --node-id <id>              Stable Device node id
  --resource-id <id>          Device workspace resource id
  --workspace-root <path>     Device workspace root
  --terminal-sessions <ids>   Device terminal Session ids
  --pairing-code <code>       One-time Resource Device pairing code
  --pairing-id <id>           QR pairing identifier
  --pairing-secret <secret>   QR pairing secret
  --help                      Show this help
`;

const VALUE_OPTIONS = new Set([
  "--space", "--from", "--recipient", "--role", "--kind", "--resource", "--root", "--document",
  "--destination", "--markdown", "--access-file", "--budget-scope", "--hard-limit", "--mode",
  "--shared", "--invitation", "--invite-days", "--claims", "--duration-days",
  "--url",
  "--runtime-profile",
  "--session",
  "--profile",
  "--interaction-profile",
  "--model-profile",
  "--project",
  "--preset",
  "--tool",
  "--file-root",
  "--terminal-session",
  "--max-tool-calls",
  "--title",
  "--reason",
  "--wait-id",
  "--input-file",
  "--limit",
  "--after",
  "--local-tools-url",
  "--node-id",
  "--project-id",
  "--resource-id",
  "--workspace-root",
  "--terminal-sessions",
  "--pairing-code",
  "--pairing-id",
  "--pairing-secret"
]);
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "aborted",
  "interrupted",
  "waiting"
]);

function readArg(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
}

function readListArgs(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name || index + 1 >= argv.length) continue;
    values.push(argv[index + 1]);
    index += 1;
  }
  return [...new Set(
    values.flatMap((value) => String(value).split(","))
      .map((value) => value.trim())
      .filter(Boolean)
  )];
}

function positionalArgs(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (VALUE_OPTIONS.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith("-")) values.push(value);
  }
  return values;
}

async function responseJson(response) {
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error || `Runtime HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return body;
}

function loadCliConfig(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Cannot read Runtime CLI config ${path}: ${error?.message || String(error)}`);
  }
}

function sanitizeEndpointProfile(name, profile) {
  return {
    name,
    url: String(profile?.url || ""),
    ...(profile?.auth?.type
      ? {
          auth: {
            type: String(profile.auth.type),
            ...(profile.auth.env ? { env: String(profile.auth.env) } : {}),
            ...(profile.auth.tokenFileEnv
              ? { tokenFileEnv: String(profile.auth.tokenFileEnv) }
              : {}),
            ...(profile.auth.deviceAuthorizationUrl
              ? { deviceAuthorizationUrl: String(profile.auth.deviceAuthorizationUrl) }
              : {}),
            ...(profile.auth.tokenUrl
              ? { tokenUrl: String(profile.auth.tokenUrl) }
              : {}),
            ...(profile.auth.clientId
              ? { clientId: String(profile.auth.clientId) }
              : {}),
            ...(profile.auth.scope ? { scope: String(profile.auth.scope) } : {})
          }
        }
      : {})
  };
}

export function resolveRuntimeCliTarget({
  argv = [],
  environment = process.env,
  requireCredential = true,
  configPath = environment.ZION_RUNTIME_CLI_CONFIG
    || join(homedir(), ".zion-next", "cli.json")
} = {}) {
  const config = loadCliConfig(configPath);
  const distributed = environment.ZIOON_CLI_DISTRIBUTION === "1";
  const profiles = {
    ...(distributed ? { "zioon-cloud": { url: "https://runtime.zioon.tech", auth: { type: "account" } } } : {}),
    ...(config.profiles && typeof config.profiles === "object" ? config.profiles : {})
  };
  const profileName = readArg(
    argv,
    "--runtime-profile",
    environment.ZION_RUNTIME_PROFILE
      || (argv.includes("--url") || environment.ZION_RUNTIME_URL ? "" : config.defaultProfile || (distributed ? "zioon-cloud" : ""))
  );
  const profile = profileName ? profiles[profileName] : null;
  if (profileName && !profile) {
    throw new Error(`Runtime CLI profile not found: ${profileName}`);
  }
  const baseUrl = readArg(
    argv,
    "--url",
    environment.ZION_RUNTIME_URL || profile?.url || "http://127.0.0.1:8766"
  );
  if (profile?.auth && profile.url && new URL(baseUrl).origin !== new URL(profile.url).origin) {
    throw new Error("Authenticated profile URL cannot be overridden with a different origin");
  }
  const headers = {};
  const spaceId = String(readArg(argv, "--space", environment.ZIOON_SPACE_ID || profile?.spaceId || "")).trim();
  if (spaceId && (spaceId.length > 256 || /[\x00-\x20]/.test(spaceId))) throw new Error("Invalid --space");
  if (spaceId) headers["x-zioon-space-id"] = spaceId;
  if (profile?.auth?.type === "bearer" || profile?.auth?.type === "workload") {
    const envName = String(profile.auth.env || "").trim();
    const tokenFileEnv = String(profile.auth.tokenFileEnv || "").trim();
    const tokenFile = String(
      profile.auth.tokenFile
      || (tokenFileEnv ? environment[tokenFileEnv] : "")
      || ""
    ).trim();
    const token = profile.auth.type === "workload"
      ? (tokenFile ? String(readFileSync(tokenFile, "utf8")).trim() : "")
      : String(environment[envName] || "").trim();
    if (profile.auth.type === "bearer" && !envName) {
      throw new Error(`Runtime CLI profile ${profileName} has no bearer token env`);
    }
    if (!token && requireCredential) {
      throw new Error(
        profile.auth.type === "workload"
          ? `Runtime CLI workload token is unavailable: ${tokenFileEnv || tokenFile}`
          : `Runtime CLI credential is unavailable: ${envName}`
      );
    }
    if (token) headers.authorization = `Bearer ${token}`;
  }
  return {
    baseUrl,
    spaceId,
    profileName: String(profileName || ""),
    headers,
    auth: argv.includes("--account") ? { type: "account" } : profile?.auth && typeof profile.auth === "object"
      ? { ...profile.auth }
      : null,
    configPath,
    profiles: Object.fromEntries(
      Object.entries(profiles).map(([name, value]) => [
        name,
        sanitizeEndpointProfile(name, value)
      ])
    )
  };
}

function deviceNodeId(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `node:${normalized || "local"}`;
}

export async function createCliDeviceHost({
  argv = [],
  runtimeUrl,
  environment = process.env,
  output = process.stdout,
  fetchImpl = globalThis.fetch,
  toolHost = null,
  deviceCredentialStore = null,
  createConnector = (options) => new DeviceConnector(options)
} = {}) {
  const machineName = hostname();
  const workspaceRoot = resolveDeviceWorkspaceRoot({
    configured: readArg(
      argv,
      "--workspace-root",
      environment.ZION_NODE_WORKSPACE_ROOT || ""
    ),
    initialCwd: environment.INIT_CWD || "",
    cwd: process.cwd()
  });
  const projectId = readArg(
    argv,
    "--project",
    readArg(
      argv,
      "--project-id",
      environment.ZION_NODE_PROJECT_ID
        || defaultDeviceProjectId(workspaceRoot)
    )
  );
  const resourceId = readArg(
    argv,
    "--resource-id",
    environment.ZION_NODE_RESOURCE_ID
      || defaultDeviceResourceId(projectId)
  );
  let terminalSessionIds = readListArgs(argv, "--terminal-sessions");
  if (!terminalSessionIds.length) {
    terminalSessionIds.push(...readListArgs(argv, "--terminal-session"));
  }
  if (!terminalSessionIds.length) {
    terminalSessionIds.push(...String(
      environment.ZION_NODE_TERMINAL_SESSION_IDS || ""
    ).split(",").map((value) => value.trim()).filter(Boolean));
  }
  const localToolsUrl = normalizeLocalToolsUrl(readArg(
    argv,
    "--local-tools-url",
    environment.ZION_LOCAL_TOOLS_URL || "http://127.0.0.1:8765"
  ));
  terminalSessionIds = await ensureDeviceTerminalSessions({
    localToolsUrl,
    workspaceRoot,
    sessionIds: terminalSessionIds,
    fetchImpl
  });
  const host = toolHost || new LocalToolsDeviceHost({
    baseUrl: localToolsUrl,
    resourceBindings: {
      [resourceId]: {
        root: workspaceRoot,
        allowedTerminalSessionIds: terminalSessionIds
      }
    }
  });
  await host.assertHealthy?.();
  const nodeId = readArg(
    argv,
    "--node-id",
    environment.ZION_NODE_ID || deviceNodeId(machineName)
  );
  const credentialStore = deviceCredentialStore || createDeviceCredentialStore();
  const credentialKey = deviceCredentialKey(runtimeUrl, nodeId);
  let token = String(environment.ZION_DEVICE_TOKEN || "").trim();
  if (!token) {
    const stored = await credentialStore.get(credentialKey);
    if (
      stored?.credential
      && Number(stored.expiresAt || 0) > Date.now()
    ) {
      token = String(stored.credential);
    }
  }
  if (!token) {
    const pairingId = readArg(
      argv,
      "--pairing-id",
      environment.ZION_DEVICE_PAIRING_ID || ""
    );
    const pairingSecret = readArg(
      argv,
      "--pairing-secret",
      environment.ZION_DEVICE_PAIRING_SECRET || ""
    );
    const pairingCode = readArg(
      argv,
      "--pairing-code",
      environment.ZION_DEVICE_PAIRING_CODE || ""
    );
    if ((!pairingId || !pairingSecret) && !pairingCode) {
      throw new Error(
        "Device credential is unavailable; provide ZION_DEVICE_TOKEN or "
        + "--pairing-code"
      );
    }
    const paired = await exchangeDevicePairing({
      runtimeUrl,
      pairingId,
      secret: pairingSecret,
      userCode: pairingCode,
      device: {
        deviceId: nodeId,
        label: machineName,
        platform: process.platform
      },
      fetchImpl
    });
    token = paired.credential;
    await credentialStore.set(credentialKey, {
      credential: token,
      credentialId: paired.credentialId,
      expiresAt: paired.expiresAt,
      deviceId: nodeId,
      runtimeUrl
    });
  }
  const connector = createConnector({
    runtimeUrl,
    token,
    registration: {
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      nodeId,
      instanceId: `instance:${randomUUID()}`,
      label: machineName,
      platform: process.platform,
      capabilities: LOCAL_TOOLS_TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        version: "1",
        risk: ["write", "edit"].includes(tool.name)
          ? "write"
          : tool.name === "sendMail"
            ? "external-effect"
            : ["Bash", "mcpCall"].includes(tool.name)
              ? "execute"
              : "read",
        description: tool.description,
        inputSchema: tool.inputSchema,
        hostKind: "local-tools"
      })),
      resources: [{
        resourceId,
        kind: "workspace",
        projectId,
        label: projectId
      }]
    },
    toolHost: host,
    logger({ level, nodeId: sourceNodeId, message }) {
      output.write(`[device:${sourceNodeId}] ${level}: ${message}\n`);
    }
  });
  const snapshot = await connector.start();
  return { connector, snapshot, nodeId, runtimeUrl, localToolsUrl };
}

export function createRuntimeControlClient({
  baseUrl,
  fetchImpl = globalThis.fetch,
  pollIntervalMs = 750,
  headers = {},
  signal: defaultSignal
} = {}) {
  const url = String(baseUrl || "").replace(/\/+$/, "");
  if (!url) throw new Error("Runtime URL is required");
  if (!fetchImpl) throw new Error("fetch implementation is required");

  const fetchRequest = boundedFetch(fetchImpl, headers);
  const request = async (path, { method = "GET", body, signal = defaultSignal } = {}) =>
    responseJson(await fetchRequest(`${url}${path}`, {
      method,
      signal,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));

  const streamEvents = async function* (path, {
    afterSequence = 0,
    signal
  } = {}) {
    for await (const frame of subscribeEventSource(
      `${url}${path}`,
      {
        fetchImpl,
        headers,
        lastEventId: afterSequence,
        signal
      }
    )) {
      let event;
      try {
        event = frame.data ? JSON.parse(frame.data) : null;
      } catch {
        throw new Error("Runtime returned invalid event stream JSON");
      }
      if (frame.event === "error") {
        throw new Error(event?.error || "Runtime event stream failed");
      }
      if (event) yield event;
    }
  };
  return Object.freeze({
    createRun: (body) => request("/v1/runs", { method: "POST", body }),
    getRun: async (runId) => (
      await request(`/v1/runs/${encodeURIComponent(runId)}`)
    ).run,
    getRunEvents: async (runId, after = 0) => (
      await request(
        `/v1/runs/${encodeURIComponent(runId)}/events?after=${Math.max(0, Number(after) || 0)}`
      )
    ).events,
    getRunProjectionEvents: async (runId, options = {}) => (
      await fetchRunProjectionEvents(url, runId, {
        fetchImpl,
        headers,
        ...options
      })
    ).events,
    streamRunEvents(runId, {
      mode = "projection",
      ...options
    } = {}) {
      return subscribeRunStream(url, runId, {
        fetchImpl,
        headers,
        mode,
        ...options
      });
    },
    resumeRun: (runId, body = {}) => request(
      `/v1/runs/${encodeURIComponent(runId)}/resume`,
      { method: "POST", body }
    ),
    abortRun: (runId, reason = "user") => request(
      `/v1/runs/${encodeURIComponent(runId)}/abort`,
      { method: "POST", body: { reason } }
    ),
    listSessions: async (limit = 100) => (
      await request(`/v1/sessions?limit=${Math.max(1, Number(limit) || 100)}`)
    ).sessions,
    createSession: body => request("/v1/sessions", { method: "POST", body }),
    getSession: async (sessionId) => (
      await request(`/v1/sessions/${encodeURIComponent(sessionId)}`)
    ).session,
    getSessionTranscript: async (sessionId) => (
      await request(`/v1/sessions/${encodeURIComponent(sessionId)}/transcript`)
    ).messages,
    getWorkbenchStatus: () => request("/v1/workbench-state/status"),
    getActiveSessionRun: async (sessionId) => (
      await request(`/v1/sessions/${encodeURIComponent(sessionId)}/active-run`)
    ).activeRun,
    streamSessionEvents(sessionId, {
      afterSequence = 0,
      signal
    } = {}) {
      const query = new URLSearchParams({
        after: String(Math.max(0, Number(afterSequence) || 0)),
        session_id: String(sessionId || "")
      });
      return streamEvents(`/v1/workbench-state/events/stream?${query}`, {
        afterSequence,
        signal
      });
    },
    async *watchSessionEvents(sessionId, {
      afterSequence = 0,
      signal
    } = {}) {
      let cursor = Math.max(0, Number(afterSequence) || 0);
      while (!signal?.aborted) {
        try {
          for await (const event of this.streamSessionEvents(sessionId, {
            afterSequence: cursor,
            signal
          })) {
            cursor = Math.max(cursor, Number(event.sequence) || 0);
            yield event;
          }
        } catch (error) {
          if (signal?.aborted) throw error;
        }
        if (!signal?.aborted) {
          await delay(Math.max(100, pollIntervalMs), undefined, { signal });
        }
      }
    },
    forkSession: (sessionId, body = {}) => request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/fork`,
      { method: "POST", body }
    ),
    listTasks: async () => (await request("/v1/scheduler/tasks")).tasks,
    getTask: (taskId) => request(
      `/v1/scheduler/tasks/${encodeURIComponent(taskId)}`
    ),
    runTask: (taskId) => request(
      `/v1/scheduler/tasks/${encodeURIComponent(taskId)}/run`,
      { method: "POST", body: {} }
    ),
    listTaskRuns: (taskId = "", limit = 50) => request(
      "/v1/scheduler/runs"
      + `?limit=${Math.max(1, Number(limit) || 50)}`
      + (taskId ? `&task_id=${encodeURIComponent(taskId)}` : "")
    ),
    cancelTaskRun: (runId, reason = "user") => request(
      `/v1/scheduler/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST", body: { reason } }
    ),
    async followRun(runId, onEvent = () => {}, {
      signal,
      mode = "projection",
      reasoningMode = "stream",
      afterSequence = 0,
      onConnection
    } = {}) {
      return followCliRun({
        baseUrl: url, runId, fetchImpl, headers, signal, mode, reasoningMode,
        afterSequence, onEvent, pollIntervalMs, onConnection
      });
    }
  });
}

function writeRecord(output, value) {
  output.write(`${JSON.stringify({ schemaVersion: 1, ...value })}\n`);
}

function printHumanValue(output, value) {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

function runPolicy(argv) {
  const tools = readListArgs(argv, "--tool");
  const roots = readListArgs(argv, "--file-root");
  const terminalSessions = readListArgs(argv, "--terminal-session");
  const maxToolCalls = readArg(argv, "--max-tool-calls");
  const preset = readArg(argv, "--preset");
  const policy = {
    ...(preset ? { preset } : {}),
    ...(tools.length ? { allowedTools: tools } : {}),
    ...(roots.length ? { fileRoots: roots } : {}),
    ...(terminalSessions.length
      ? { allowedTerminalSessionIds: terminalSessions }
      : {}),
    ...(maxToolCalls
      ? { maxToolCalls: Math.max(1, Number(maxToolCalls) || 12) }
      : {})
  };
  return Object.keys(policy).length ? policy : undefined;
}

async function followAndPrint(client, runId, {
  jsonl,
  output,
  signal,
  rawEvents = false,
  environment = process.env
}) {
  const theme = terminalTheme(output, environment);
  const activity = createActivity(output, theme);
  const renderer = !jsonl && theme.interactive ? createAnswerRenderer(output, theme) : null;
  const feed = !jsonl && theme.interactive ? createActivityFeed(output, theme, {
    activity, boundary: () => renderer?.end(), inspectHint: "--jsonl for details"
  }) : null;
  if (jsonl) writeRecord(output, { type: "run.attached", runId });
  else { output.write(`Run: ${safeText(runId)}\n`); activity.start(); }
  try {
  const run = await client.followRun(runId, (event) => {
    if (jsonl) {
      writeRecord(output, { type: "run.event", event });
    } else if (event.type === "message.delta") {
      feed?.beforeAnswer(event); activity.stop();
      if (renderer) renderer.write(event.data?.delta || "");
      else output.write(safeText(event.data?.delta || ""));
    } else feed?.event(event);
  }, {
    signal,
    mode: rawEvents ? "raw" : "projection",
    reasoningMode: jsonl ? "stream" : "summary"
  });
  if (jsonl) writeRecord(output, { type: "run.snapshot", run });
  else {
    activity.stop(); renderer?.end(); feed?.finish(run.status); output.write("\n");
    if (run.status !== "completed") {
      output.write(`[${run.status}] ${safeText(run.waiting?.reason || run.terminalReason || run.error || "unknown")}\n`);
      if (run.status === "waiting") {
        output.write(`Resume: zioon resume ${safeText(runId)} --wait-id ${safeText(run.waiting?.id || "")} --input-file response.json\n`);
      }
    }
  }
  return run;
  } catch (error) {
    renderer?.end(); feed?.finish();
    error.runId ||= runId;
    throw error;
  } finally { activity.stop(); renderer?.end(); }
}

export async function runRuntimeCli({
  argv = process.argv.slice(2),
  output = process.stdout,
  errorOutput = process.stderr,
  input = process.stdin,
  fetchImpl = globalThis.fetch,
  environment = process.env,
  pollIntervalMs = 750,
  credentialStore = null,
  sleep,
  signal
} = {}) {
  if (!argv.length || argv[0] === "chat" || (argv[0].startsWith("--") || argv[0] === "-i") && !argv.includes("--help")) {
    return runChatCli({
      argv: argv[0] === "chat" ? argv.slice(1) : argv,
      input,
      output,
      fetchImpl,
      environment,
      credentialStore,
      signal
    });
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    output.write(argv[0] === "extensions" ? EXTENSIONS_USAGE : argv[0] === "share" ? SHARING_USAGE :
      ["space", "contact"].includes(argv[0]) ? SPACES_USAGE : `${USAGE}\n${SHARING_USAGE}`);
    return null;
  }

  const command = argv[0];
  const args = argv.slice(1);
  if (args.includes("--shared")) throw new Error("Use: zioon chat --shared <share-id> [--document <id>]");
  const extensions = command === "extensions" ? parseExtensionsArgs(args) : null;
  if (extensions && LOCAL_EXTENSION_ACTIONS.has(extensions.action)) {
    return runExtensionsCli({ parsed: extensions, output });
  }
  const jsonl = argv.includes("--jsonl");
  const rawEvents = argv.includes("--raw-events");
  const positionals = positionalArgs(args);
  const authProfileName = command === "auth" ? positionals[1] : "";
  const target = resolveRuntimeCliTarget({
    argv: authProfileName && !argv.includes("--runtime-profile")
      ? [...argv, "--runtime-profile", authProfileName]
      : argv,
    environment,
    requireCredential: !["profile", "auth", "device"].includes(command)
  });
  const baseUrl = target.baseUrl;

  if (command === "profile") {
    const action = positionals[0] || "list";
    const name = positionals[1] || target.profileName;
    const result = action === "list"
      ? Object.values(target.profiles)
      : action === "show"
        ? target.profiles[name] || null
        : null;
    if (!result) throw new Error(
      action === "show"
        ? `Runtime CLI profile not found: ${name}`
        : `Unknown profile action: ${action}`
    );
    if (jsonl) {
      const values = Array.isArray(result) ? result : [result];
      for (const value of values) writeRecord(output, { type: `profile.${action}`, value });
    } else {
      if (Array.isArray(result)) printList(output, result, "profiles", environment);
      else printHumanValue(output, result);
    }
    return result;
  }

  if (command === "auth") {
    const action = positionals[0] || "status";
    const profileName = positionals[1] || target.profileName;
    if (target.auth?.type === "account") {
      const result = await manageAccountLogin({
        action, baseUrl, credentialStore: credentialStore || createCliCredentialStore(),
        fetchImpl, signal, sleep,
        emit(event) {
          if (jsonl) writeRecord(output, event);
          else if (event.type === "auth.deviceCode") output.write(
            `Open ${event.verificationUri}\nCode: ${event.userCode}\n`
          );
          else output.write(`Authenticated ${baseUrl}\n`);
        }
      });
      if (action !== "login") {
        if (jsonl) writeRecord(output, { type: `auth.${action}`, ...result });
        else if (action === "status") printAuthStatus(output, result, environment);
        else printHumanValue(output, result);
      }
      return result;
    }
    if (!profileName || !target.auth || target.auth.type !== "device_code") {
      throw new Error(
        `Runtime CLI profile does not use OAuth device flow: ${profileName || "(none)"}`
      );
    }
    const store = credentialStore || createCliCredentialStore();
    if (action === "login") {
      const credential = await loginWithOAuthDeviceFlow({
        profileName,
        auth: target.auth,
        credentialStore: store,
        fetchImpl,
        ...(sleep ? { sleep } : {}),
        emit(event) {
          if (jsonl) writeRecord(output, event);
          else if (event.type === "auth.deviceCode") {
            output.write(
              `Open ${event.verificationUri}\nCode: ${event.userCode}\n`
            );
          } else if (event.type === "auth.completed") {
            output.write(`Authenticated profile ${profileName}\n`);
          }
        }
      });
      return {
        profileName,
        expiresAt: credential.expiresAt,
        scope: credential.scope || ""
      };
    }
    if (action === "status") {
      const credential = await store.get(profileName);
      const result = {
        profileName,
        authenticated: Boolean(credential?.accessToken),
        expiresAt: Number(credential?.expiresAt || 0) || null,
        expired: credential?.expiresAt
          ? Number(credential.expiresAt) <= Date.now()
          : null
      };
      if (jsonl) writeRecord(output, { type: "auth.status", ...result });
      else printAuthStatus(output, result, environment);
      return result;
    }
    if (action === "logout") {
      const deleted = await store.delete(profileName);
      const result = { profileName, deleted };
      if (jsonl) writeRecord(output, { type: "auth.logout", ...result });
      else printHumanValue(output, result);
      return result;
    }
    throw new Error(`Unknown auth action: ${action}`);
  }

  if (command === "device") {
    const action = positionals[0] || "connect";
    if (action !== "connect") throw new Error(`Unknown device action: ${action}`);
    const host = await createCliDeviceHost({
      argv: args,
      runtimeUrl: baseUrl,
      environment,
      output,
      fetchImpl
    });
    if (jsonl) {
      writeRecord(output, {
        type: "device.connected",
        nodeId: host.nodeId,
        runtimeUrl: host.runtimeUrl,
        localToolsUrl: host.localToolsUrl,
        snapshot: host.snapshot
      });
    } else {
      output.write(
        `Device ${host.nodeId} connected to ${host.runtimeUrl} `
        + `(local-tools=${host.localToolsUrl})\n`
      );
    }
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void host.connector.stop().finally(() => {
        process.exitCode = 0;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return host;
  }

  const requestHeaders = await resolveRuntimeCliHeaders(target, { credentialStore, fetchImpl });
  let accountIdentity;
  if (target.auth?.type === "account") {
    accountIdentity = await createSpacesClient({ baseUrl, headers: requestHeaders, spaceId: target.spaceId, fetchImpl, signal }).identity();
    const personal = accountIdentity.spaces?.find(s => s.kind === "personal");
    if (!target.spaceId && personal && personal.id !== accountIdentity.space.id) {
      accountIdentity = await createSpacesClient({ baseUrl, headers: requestHeaders, spaceId: personal.id, fetchImpl, signal }).identity();
    }
  }
  if (accountIdentity && !target.spaceId) {
    const identity = accountIdentity;
    requestHeaders["x-zioon-space-id"] = identity.space.id;
    target.spaceId = identity.space.id;
  }
  if (command === "share" && !args.includes("--destination") && !["publish", "knowledge", "retry"].includes(positionals[0])) {
    return runSharingCli({ args, target, headers: requestHeaders, output, fetchImpl, signal });
  }
  if (["space", "contact", "share"].includes(command)) return runSpacesCli({
    command, args, target, headers: requestHeaders, output, environment, fetchImpl, signal
  });
  const client = createRuntimeControlClient({
    baseUrl,
    fetchImpl,
    pollIntervalMs,
    headers: requestHeaders,
    signal
  });
  if (extensions) return runExtensionsCli({
    parsed: extensions, output, baseUrl, fetchImpl, headers: requestHeaders, signal,
    controlClient: client, defaultProfile: DEFAULT_INTERACTION_PROFILE_ID
  });

  if (command === "run") {
    const prompt = readArg(args, "--prompt", positionals.join(" ")).trim();
    if (!prompt) throw new Error("run requires a prompt");
    const profileArg = readArg(
      args,
      "--profile",
      readArg(
        args,
        "--interaction-profile",
        environment.ZION_RUNTIME_INTERACTION_PROFILE || DEFAULT_INTERACTION_PROFILE_ID
      )
    );
    const profile = ["", "none", "off", "false"].includes(
      String(profileArg || "").trim().toLowerCase()
    )
      ? ""
      : String(profileArg).trim();
    const modelProfileId = readArg(args, "--model-profile", "");
    let sessionId = readArg(args, "--session");
    if (!sessionId && accountIdentity?.space?.kind === "team") {
      const created = await client.createSession({
        title: readArg(args, "--title", prompt.slice(0, 80)),
        ...(profile ? { interactionProfileId: profile } : {}),
        ...(modelProfileId ? { model: { profileId: modelProfileId } } : {})
      });
      sessionId = created.session.id;
    }
    const accepted = await client.createRun({
      prompt,
      title: readArg(args, "--title", prompt.slice(0, 80)),
      ...(profile ? { interactionProfileId: profile } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(readArg(args, "--project") ? { projectId: readArg(args, "--project") } : {}),
      ...(modelProfileId ? { model: { profileId: modelProfileId } } : {}),
      ...(runPolicy(args) ? { policy: runPolicy(args) } : {}),
      metadata: { source: "runtime-cli" }
    });
    if (jsonl) writeRecord(output, { type: "run.accepted", ...accepted });
    return followAndPrint(client, accepted.runId, {
      jsonl,
      output,
      signal,
      rawEvents
    });
  }

  if (command === "attach") {
    const runId = positionals[0];
    if (!runId) throw new Error("attach requires a Run id");
    return followAndPrint(client, runId, {
      jsonl,
      output,
      signal,
      rawEvents
    });
  }

  if (command === "resume") {
    const runId = positionals[0];
    if (!runId) throw new Error("resume requires a Run id");
    const inputFile = readArg(args, "--input-file");
    const resumeInput = inputFile ? JSON.parse(readFileSync(inputFile, "utf8")) : undefined;
    const accepted = await client.resumeRun(runId, {
      ...(readArg(args, "--wait-id") ? { waitId: readArg(args, "--wait-id") } : {}),
      ...(inputFile ? { input: resumeInput } : {})
    });
    if (jsonl) writeRecord(output, { type: "run.resumed", ...accepted });
    return followAndPrint(client, accepted.runId || runId, {
      jsonl,
      output,
      signal,
      rawEvents
    });
  }

  if (command === "abort") {
    const runId = positionals[0];
    if (!runId) throw new Error("abort requires a Run id");
    const result = await client.abortRun(runId, readArg(args, "--reason", "user"));
    if (jsonl) writeRecord(output, { type: "run.abortAccepted", ...result });
    else printHumanValue(output, result);
    return result;
  }

  if (command === "session") {
    const action = positionals[0] || "list";
    const sessionId = positionals[1];
    let result;
    if (action === "list") {
      result = await client.listSessions(readArg(args, "--limit", "100"));
    } else if (action === "get") {
      if (!sessionId) throw new Error("session get requires a Session id");
      result = await client.getSession(sessionId);
    } else if (action === "transcript") {
      if (!sessionId) throw new Error("session transcript requires a Session id");
      result = await client.getSessionTranscript(sessionId);
    } else if (action === "fork") {
      if (!sessionId) throw new Error("session fork requires a Session id");
      result = await client.forkSession(sessionId, {
        ...(readArg(args, "--title") ? { title: readArg(args, "--title") } : {})
      });
    } else if (action === "attach") {
      if (!sessionId) throw new Error("session attach requires a Session id");
      const activeRun = await client.getActiveSessionRun(sessionId);
      if (!activeRun?.runId) {
        throw new Error(`Session has no active Run: ${sessionId}`);
      }
      return followAndPrint(client, activeRun.runId, {
        jsonl,
        output,
        signal,
        rawEvents
      });
    } else if (action === "watch") {
      if (!sessionId) throw new Error("session watch requires a Session id");
      const explicitAfter = readArg(args, "--after", "");
      const status = explicitAfter
        ? null
        : await client.getWorkbenchStatus();
      const afterSequence = explicitAfter
        ? Math.max(0, Number(explicitAfter) || 0)
        : Math.max(0, Number(status?.event_cursor) || 0);
      const activeRun = await client.getActiveSessionRun(sessionId);
      if (activeRun?.runId) {
        if (jsonl) {
          writeRecord(output, {
            type: "session.activeRun",
            sessionId,
            activeRun
          });
        } else {
          output.write(
            `Active Run: ${activeRun.runId} (${activeRun.status})\n`
          );
        }
      }
      const eventLimit = Math.max(
        0,
        Number(readArg(args, "--limit", "0")) || 0
      );
      let eventCount = 0;
      for await (const event of client.watchSessionEvents(sessionId, {
        afterSequence,
        signal
      })) {
        if (jsonl) writeRecord(output, { type: "session.event", event });
        else output.write(
          `[${event.sequence || "-"}] ${event.type}`
          + `${event.runId ? ` run=${event.runId}` : ""}\n`
        );
        eventCount += 1;
        if (eventLimit && eventCount >= eventLimit) break;
      }
      return { sessionId, events: eventCount };
    } else {
      throw new Error(`Unknown session action: ${action}`);
    }
    if (jsonl) {
      const values = Array.isArray(result) ? result : [result];
      for (const value of values) {
        writeRecord(output, { type: `session.${action}`, value });
      }
    } else {
      if (action === "list") printList(output, result, "conversations", environment);
      else printHumanValue(output, result);
    }
    return result;
  }

  if (command === "task") {
    const action = positionals[0] || "list";
    const id = positionals[1] || "";
    let result;
    if (action === "list") result = await client.listTasks();
    else if (action === "get") {
      if (!id) throw new Error("task get requires a task id");
      result = await client.getTask(id);
    } else if (action === "run") {
      if (!id) throw new Error("task run requires a task id");
      result = await client.runTask(id);
    } else if (action === "runs") {
      result = await client.listTaskRuns(id, readArg(args, "--limit", "50"));
    } else if (action === "cancel") {
      if (!id) throw new Error("task cancel requires a Run id");
      result = await client.cancelTaskRun(id, readArg(args, "--reason", "user"));
    } else {
      throw new Error(`Unknown task action: ${action}`);
    }
    if (jsonl) writeRecord(output, { type: `task.${action}`, value: result });
    else if (action === "list") printList(output, result, "tasks", environment);
    else printHumanValue(output, result);
    return result;
  }

  if (!jsonl) errorOutput.write(`Unknown command: ${command}\n\n${USAGE}`);
  throw new Error(`Unknown command: ${command}`);
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (process.env.ZIOON_CLI_DISTRIBUTION !== "1" && import.meta.url === entryPath) {
  await runRuntimeCliEntry();
}

export function runtimeCliExitCode(result) {
  if (result?.status === "failed") return 1;
  if (result?.status === "interrupted") return 2;
  if (result?.status === "waiting") return 3;
  if (result?.status === "aborted") return 130;
  return 0;
}

export async function runRuntimeCliEntry({
  argv = process.argv.slice(2), output = process.stdout, errorOutput = process.stderr,
  ...options
} = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException("Cancelled", "AbortError"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await runRuntimeCli({
      argv, output, errorOutput, ...options,
      signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    });
    process.exitCode = controller.signal.aborted ? 130 : runtimeCliExitCode(result);
    return result;
  } catch (error) {
    errorOutput.write(argv.includes("--jsonl")
      ? `${JSON.stringify({ schemaVersion: 1, type: "cli.error", code: error.code || "cli_error",
          ...(error.statusCode ? { statusCode: error.statusCode } : {}),
          ...(error.runId ? { runId: error.runId } : {}), error: error.message || String(error) })}\n`
      : `zioon: ${friendlyCliError(error)}\n`);
    process.exitCode = error.name === "AbortError" ? 130 : 1;
    return null;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
