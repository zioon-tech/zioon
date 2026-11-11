import process from "node:process";
import { pathToFileURL } from "node:url";
import { DEFAULT_INTERACTION_PROFILE_ID } from "./interaction-profile-store.mjs";
import { resolveRuntimeCliHeaders } from "./accounts/cli-account-auth.mjs";
import { ChatInput } from "./cli-input.mjs";
import { boundedFetch, cliJson, followCliRun } from "./cli-run-follow.mjs";
import { runChatShell } from "./cli-chat-shell.mjs";
import { createActivity, terminalTheme } from "./cli-terminal.mjs";
import { createChatState } from "./cli-chat-state.mjs";

const CHAT_USAGE = `Usage: zioon chat [options]

Options:
  --url <url>                    Runtime URL
  --runtime-profile <name>       Configured Runtime endpoint and authentication
  --account                     Use account login for --url
  --session <id>                Reconnect to an existing Session
  --continue                    Reopen this account's last local conversation
  --image, -i <path>             Attach an image to the first draft; repeatable
  --profile <id>                Runtime interaction profile for a new Session
  --title <text>                New Session title
  --model-profile <id>          Runtime model profile for a new Session
  --preset <preset>             Policy preset: read-only, workspace-write, trusted-automation
  --no-tools                    Start with no tools exposed to the model
  --no-terminal-context         Do not inject Runtime terminal inventory
  --project <id>                Project routed through a Device
  --tool <name[,name...]>        Allowed tool; repeatable
  --file-root <absolute-path>    Allowed root; repeatable
  --terminal-session <id>        Allowed local-tools Session; repeatable
  --max-tool-calls <count>       Per-Run tool-call limit
  --plain                       Use a basic line prompt (no terminal UI)
  --help                         Show this help

In chat: /help · /sessions · /new · /open <id> · /history · /exit
Keys: Enter send · Alt+Enter or Ctrl+J newline · Tab complete
      ↑↓ history · Esc stop Run · Ctrl+C clear draft / stop / exit
`;

function readArg(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return fallback;
  return argv[index + 1];
}

function hasArg(argv, name) {
  return argv.includes(name);
}

function readListArgs(argv, name, fallback = "") {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && index + 1 < argv.length) {
      values.push(argv[index + 1]);
      index += 1;
    }
  }
  const source = values.length ? values : [fallback];
  return [...new Set(
    source
      .flatMap((value) => String(value || "").split(","))
      .map((value) => value.trim())
      .filter(Boolean)
  )];
}

async function responseJson(response) {
  return cliJson(response);
}

export function createRuntimeChatClient({
  baseUrl,
  fetchImpl = globalThis.fetch,
  headers = {},
  pollIntervalMs = 750
}) {
  const url = String(baseUrl || "").replace(/\/+$/, "");
  if (!url) throw new Error("Runtime URL is required");
  if (!fetchImpl) throw new Error("fetch implementation is required");
  const authenticatedFetch = boundedFetch(fetchImpl, headers);
  const request = async (path, options) => responseJson(await authenticatedFetch(`${url}${path}`, options));

  return {
    models: () => request("/v1/models"),
    uploadImage: async (image, bytes, signal) => (await responseJson(await boundedFetch(fetchImpl, headers, 120_000)(
      `${url}/v1/assets`, { method: "POST", signal, headers: {
        "content-type": image.mediaType, "x-zion-file-name": encodeURIComponent(image.name)
      }, body: bytes }
    ))).asset,
    identity: () => request("/v1/account/me"),
    updateSession: async (id, patch) => (await request(`/v1/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch)
    })).session,
    compression: async (sessionId, action, signal) => responseJson(await boundedFetch(fetchImpl, headers, action === "compact" ? 180_000 : 30_000)(
      `${url}/v1/plugins/dev.context-compression/commands`, {
        method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, action })
      })),
    forkSession: (id) => request(`/v1/sessions/${encodeURIComponent(id)}/fork`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    }),
    startBranch: (sessionId, history, content, options) => request("/v1/runs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...options, sessionId, sessionHistory: [...history, { role: "user", content }],
        messages: [...history, { role: "user", content }] })
    }),
    async createSession({
      title = "CLI conversation",
      interactionProfileId,
      model,
      projectId,
      metadata,
      policy
    } = {}) {
      const response = await authenticatedFetch(`${url}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          ...(interactionProfileId ? { interactionProfileId } : {}),
          ...(model ? { model } : {}),
          ...(projectId ? { projectId } : {}),
          ...(metadata ? { metadata } : {}),
          ...(policy ? { policy } : {})
        })
      });
      return (await responseJson(response)).session;
    },

    async getSession(sessionId) {
      const response = await authenticatedFetch(
        `${url}/v1/sessions/${encodeURIComponent(sessionId)}`
      );
      return (await responseJson(response)).session;
    },
    async listSessions(limit = 30) {
      return (await request(`/v1/sessions?limit=${limit}`)).sessions;
    },
    async getActiveRun(sessionId) {
      return (await request(`/v1/sessions/${encodeURIComponent(sessionId)}/active-run`)).activeRun;
    },
    async getRun(runId) {
      return (await request(`/v1/runs/${encodeURIComponent(runId)}`)).run;
    },
    async abortRun(runId) {
      return request(`/v1/runs/${encodeURIComponent(runId)}/abort`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "CLI user stopped the Run" })
      });
    },
    async resumeRun(runId, body = {}) {
      return request(`/v1/runs/${encodeURIComponent(runId)}/resume`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      });
    },

    async getTranscript(sessionId, afterSequence = 0) {
      const response = await authenticatedFetch(
        `${url}/v1/sessions/${encodeURIComponent(sessionId)}/transcript`
          + `?after=${Math.max(0, Number(afterSequence) || 0)}`
      );
      return (await responseJson(response)).messages;
    },

    async sendMessage(sessionId, content, clientRequestId) {
      const response = await authenticatedFetch(
        `${url}/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content, ...(clientRequestId ? { clientRequestId } : {}) })
        }
      );
      return responseJson(response);
    },

    async followRun(runId, onText = () => {}, options = {}) {
      return followCliRun({
        baseUrl: url, runId, fetchImpl, headers, pollIntervalMs, ...options,
        onEvent(event) {
          if (event.type === "message.delta") onText(String(event.data?.delta || ""), event);
          options.onEvent?.(event);
        }
      });
    }
  };
}

async function startChatCli({
  argv = process.argv.slice(2),
  input = process.stdin,
  output = process.stdout,
  fetchImpl = globalThis.fetch,
  environment = process.env,
  credentialStore,
  composer,
  signal,
  onReady = () => {}
} = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    output.write(CHAT_USAGE);
    return null;
  }
  const { resolveRuntimeCliTarget } = await import("./runtime-cli.mjs");
  const target = resolveRuntimeCliTarget({ argv, environment });
  const baseUrl = target.baseUrl;
  const headers = await resolveRuntimeCliHeaders(target, { credentialStore, fetchImpl });
  let requestedSessionId = readArg(argv, "--session", "");
  const client = createRuntimeChatClient({ baseUrl, fetchImpl, headers });
  const identity = target.auth?.type === "account" ? await client.identity() : null;
  const state = createChatState({ baseUrl, environment,
    identity: identity?.user?.id ? `${identity.user.id}:${identity.space?.id || ""}` : JSON.stringify(headers),
    onError: (error) => { composer.notice = error.message; }
  });
  const defaults = await state.read("settings");
  if (argv.includes("--continue") && !requestedSessionId) requestedSessionId = (await state.read("last")).sessionId || "";
  const profileArg = readArg(
    argv,
    "--profile",
    readArg(
      argv,
      "--interaction-profile",
      environment.ZION_RUNTIME_INTERACTION_PROFILE
        || DEFAULT_INTERACTION_PROFILE_ID
    )
  );
  const interactionProfileId = ["", "none", "off", "false"].includes(
    String(profileArg || "").trim().toLowerCase()
  )
    ? ""
    : String(profileArg || "").trim();
  const title = readArg(argv, "--title", "");
  const modelProfileId = readArg(
    argv,
    "--model-profile",
    environment.ZION_RUNTIME_CHAT_MODEL_PROFILE
      || environment.ZION_RUNTIME_MODEL_PROFILE
      || defaults.modelProfileId
      || ""
  );
  const policyPreset = readArg(
    argv,
    "--preset",
    environment.ZION_RUNTIME_POLICY_PRESET || ""
  );
  const noTools = argv.includes("--no-tools");
  const includeTerminalContext = !argv.includes("--no-terminal-context");
  const projectId = readArg(
    argv,
    "--project",
    environment.ZION_RUNTIME_PROJECT_ID || ""
  );
  const toolFallback = environment.ZION_RUNTIME_ALLOWED_TOOLS
    || "";
  const hasToolOverride = noTools
    || hasArg(argv, "--tool")
    || !!String(environment.ZION_RUNTIME_ALLOWED_TOOLS || "").trim();
  const allowedTools = noTools
    ? []
    : readListArgs(argv, "--tool", toolFallback);
  const fileRoots = readListArgs(
    argv,
    "--file-root",
    environment.ZION_RUNTIME_FILE_ROOTS || ""
  );
  const allowedTerminalSessionIds = readListArgs(
    argv,
    "--terminal-session",
    environment.ZION_RUNTIME_TERMINAL_SESSION_IDS || ""
  );
  const maxToolCallsValue = readArg(
    argv,
    "--max-tool-calls",
    environment.ZION_RUNTIME_MAX_TOOL_CALLS || ""
  );
  const maxToolCalls = maxToolCallsValue
    ? Math.max(1, Number(maxToolCallsValue) || 12)
    : undefined;
  const policy = {
    ...(policyPreset ? { preset: policyPreset } : {}),
    ...(hasToolOverride ? { allowedTools } : {}),
    ...(fileRoots.length ? { fileRoots } : {}),
    ...(allowedTerminalSessionIds.length
      ? { allowedTerminalSessionIds }
      : {}),
    ...(maxToolCalls ? { maxToolCalls } : {})
  };
  const sessionOptions = {
    title,
    interactionProfileId,
    model: modelProfileId ? { profileId: modelProfileId } : undefined,
    projectId,
    metadata: includeTerminalContext ? undefined : { includeTerminalContext: false },
    policy: Object.keys(policy).length ? policy : undefined
  };
  const saved = requestedSessionId ? await state.read(`session:${requestedSessionId}`) : {};
  const session = requestedSessionId
    ? saved.branchHistory ? saved.branchSession : await client.getSession(requestedSessionId)
    : { title, model: sessionOptions.model };

  onReady();
  return runChatShell({ client, session, sessionOptions, baseUrl, composer, output, environment, signal, requestedSessionId, state, defaults,
    initialImages: argv.flatMap((value, index) => value === "--image" || value === "-i" ? [argv[index + 1]] : []),
    modelSource: requestedSessionId ? "saved conversation" : argv.includes("--model-profile") ? "--model-profile" :
      environment.ZION_RUNTIME_CHAT_MODEL_PROFILE || environment.ZION_RUNTIME_MODEL_PROFILE ? "environment" :
      defaults.modelProfileId ? "local default" : "Runtime interaction profile" });
}

export async function runChatCli(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    (options.output || process.stdout).write(CHAT_USAGE);
    return null;
  }
  if (argv.includes("--jsonl")) throw new Error("For JSONL output, use: zioon run <prompt> --jsonl");
  const valueOptions = new Set(["--url", "--runtime-profile", "--session", "--profile", "--interaction-profile",
    "--title", "--model-profile", "--preset", "--project", "--tool", "--file-root", "--terminal-session", "--max-tool-calls", "--image", "-i"]);
  const flags = new Set(["--account", "--no-tools", "--no-terminal-context", "--plain", "--continue"]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (valueOptions.has(arg)) {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`${arg} requires a value. See: zioon chat --help`);
      if (arg === "--max-tool-calls" && !/^[1-9]\d*$/.test(argv[index + 1])) throw new Error("--max-tool-calls must be a positive integer");
      index++;
    } else if (!flags.has(arg)) throw new Error(`Unknown chat option: ${arg}. See: zioon chat --help`);
  }
  const composer = new ChatInput(options.input || process.stdin, options.output || process.stdout, {
    environment: options.environment || process.env, plain: argv.includes("--plain")
  });
  const startup = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, startup.signal]) : startup.signal;
  const theme = terminalTheme(options.output || process.stdout, options.environment || process.env);
  theme.interactive = composer.rich;
  const activity = createActivity(options.output || process.stdout, theme);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  composer.onCancel = () => startup.abort(new DOMException("Cancelled", "AbortError"));
  activity.start("Connecting");
  try {
    return await startChatCli({
      ...options, argv, composer, signal, onReady: () => activity.stop(),
      fetchImpl: (url, init = {}) => fetchImpl(url, {
        ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal
      })
    });
  } finally {
    activity.stop(); composer.close();
  }
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (process.env.ZIOON_CLI_DISTRIBUTION !== "1" && import.meta.url === entryPath) {
  runChatCli().catch((error) => {
    process.stderr.write(`Runtime chat failed: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
