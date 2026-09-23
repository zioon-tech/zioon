import process from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { DEFAULT_INTERACTION_PROFILE_ID } from "./interaction-profile-store.mjs";
import { resolveRuntimeCliHeaders } from "./accounts/cli-account-auth.mjs";

const CHAT_USAGE = `Usage: npm run runtime:chat -- [options]

Options:
  --url <url>                    Runtime URL
  --runtime-profile <name>       Configured Runtime endpoint and authentication
  --account                     Use account login for --url
  --session <id>                Reconnect to an existing Session
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
  --help                         Show this help
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
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error || `Runtime HTTP ${response.status}`);
  }
  return body;
}

export function createRuntimeChatClient({
  baseUrl,
  fetchImpl = globalThis.fetch,
  headers = {},
  pollIntervalMs = 50
}) {
  const url = String(baseUrl || "").replace(/\/+$/, "");
  if (!url) throw new Error("Runtime URL is required");
  if (!fetchImpl) throw new Error("fetch implementation is required");
  const authenticatedFetch = (path, options = {}) => fetchImpl(path, {
    ...options, headers: { ...headers, ...options.headers }
  });

  return {
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

    async getTranscript(sessionId, afterSequence = 0) {
      const response = await authenticatedFetch(
        `${url}/v1/sessions/${encodeURIComponent(sessionId)}/transcript`
          + `?after=${Math.max(0, Number(afterSequence) || 0)}`
      );
      return (await responseJson(response)).messages;
    },

    async sendMessage(sessionId, content) {
      const response = await authenticatedFetch(
        `${url}/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content })
        }
      );
      return responseJson(response);
    },

    async followRun(runId, onText = () => {}) {
      let cursor = 0;
      while (true) {
        const runResponse = await authenticatedFetch(`${url}/v1/runs/${encodeURIComponent(runId)}`);
        const { run } = await responseJson(runResponse);
        const eventResponse = await authenticatedFetch(
          `${url}/v1/runs/${encodeURIComponent(runId)}/events?after=${cursor}`
        );
        const { events } = await responseJson(eventResponse);
        for (const event of events) {
          cursor = event.sequence;
          if (event.type === "message.delta") {
            onText(String(event.data?.delta || ""));
          }
        }

        if (["completed", "failed", "aborted", "interrupted"].includes(run.status)) {
          return run;
        }
        await delay(pollIntervalMs);
      }
    }
  };
}

export async function runChatCli({
  argv = process.argv.slice(2),
  input = process.stdin,
  output = process.stdout,
  fetchImpl = globalThis.fetch,
  environment = process.env,
  credentialStore
} = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    output.write(CHAT_USAGE);
    return null;
  }
  const { resolveRuntimeCliTarget } = await import("./runtime-cli.mjs");
  const target = resolveRuntimeCliTarget({ argv, environment });
  const baseUrl = target.baseUrl;
  const headers = await resolveRuntimeCliHeaders(target, { credentialStore, fetchImpl });
  const requestedSessionId = readArg(argv, "--session", "");
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
  const title = readArg(argv, "--title", "CLI conversation");
  const modelProfileId = readArg(
    argv,
    "--model-profile",
    environment.ZION_RUNTIME_CHAT_MODEL_PROFILE
      || environment.ZION_RUNTIME_MODEL_PROFILE
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
  const client = createRuntimeChatClient({ baseUrl, fetchImpl, headers });
  const session = requestedSessionId
    ? await client.getSession(requestedSessionId)
    : await client.createSession({
        title,
        interactionProfileId,
        model: modelProfileId ? { profileId: modelProfileId } : undefined,
        projectId,
        metadata: includeTerminalContext ? undefined : { includeTerminalContext: false },
        policy: Object.keys(policy).length ? policy : undefined
      });

  output.write(`Connected to ${baseUrl}\n`);
  output.write(`Session: ${session.id}\n`);
  output.write("Commands: /session, /exit\n\n");

  const readline = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY)
  });
  readline.setPrompt("you> ");
  readline.prompt();

  for await (const line of readline) {
    const content = line.trim();
    if (!content) {
      readline.prompt();
      continue;
    }
    if (content === "/exit" || content === "/quit") break;
    if (content === "/session") {
      output.write(`${session.id}\n`);
      readline.prompt();
      continue;
    }

    try {
      const accepted = await client.sendMessage(session.id, content);
      output.write("zion> ");
      const run = await client.followRun(accepted.runId, (delta) => output.write(delta));
      if (run.status !== "completed") {
        output.write(`\n[Run ${run.status}: ${run.terminalReason || run.error || "unknown"}]`);
      }
      output.write("\n");
    } catch (error) {
      output.write(`[error] ${error?.message || String(error)}\n`);
    }
    readline.prompt();
  }

  readline.close();
  return session;
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryPath) {
  runChatCli().catch((error) => {
    process.stderr.write(`Runtime chat failed: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
