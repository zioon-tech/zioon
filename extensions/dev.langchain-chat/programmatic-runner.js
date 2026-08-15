const WRITE_TOOL_PATTERN = /(write|edit|delete|remove|move|rename|mkdir|shell|bash|terminal|mail|send|schedule|taskmanage)/i;
const SAFE_TOOL_NAMES = new Set([
  "fsEntries",
  "fsRead",
  "fsTree",
  "sessionList",
  "sessionGet",
  "webFetch",
  "webSearch",
  "localSearch",
  "glob",
  "grep",
  "read",
  "tree",
  "memoryManage"
]);
const SAFE_MEMORY_ACTIONS = new Set(["list", "tree", "read", "search", "build_context", "providers"]);
const MUTATING_TOOL_NAMES = new Set(["write", "edit", "Bash", "sendMail", "todoWrite"]);
const LEGACY_SCHEDULED_TOOL_ALIASES = new Map([
  ["fsWrite", "write"],
  ["fsEdit", "edit"],
  ["terminalExecute", "Bash"]
]);

export function isReadOnlyToolName(name) {
  const normalized = String(name || "").trim();
  return !!normalized && !WRITE_TOOL_PATTERN.test(normalized);
}

export function filterReadOnlyTools(tools) {
  return filterToolsForPolicy(tools, { preset: "read-only" });
}

export function normalizeCapabilityPolicy(input = {}) {
  const preset = ["read-only", "workspace-write", "trusted-automation"].includes(input?.preset)
    ? input.preset
    : "read-only";
  return {
    preset,
    // Keep saved tasks created before the local-tools migration runnable.
    allowedTools: Array.isArray(input?.allowedTools)
      ? [...new Set(input.allowedTools.map((name) => LEGACY_SCHEDULED_TOOL_ALIASES.get(String(name)) || String(name)))]
      : [],
    fileRoots: Array.isArray(input?.fileRoots) ? input.fileRoots.map(String).filter(Boolean) : [],
    allowedCommandPrefixes: Array.isArray(input?.allowedCommandPrefixes) ? input.allowedCommandPrefixes.map(String).filter(Boolean) : [],
    allowedTerminalSessionIds: Array.isArray(input?.allowedTerminalSessionIds) ? input.allowedTerminalSessionIds.map(String).filter(Boolean) : [],
    allowedRecipients: Array.isArray(input?.allowedRecipients) ? input.allowedRecipients.map((value) => String(value).toLowerCase()).filter(Boolean) : [],
    maxMailPerRun: Math.max(0, Number(input?.maxMailPerRun) || 0),
    maxToolCalls: Math.max(1, Number(input?.maxToolCalls) || 50)
  };
}

export function filterToolsForPolicy(tools, inputPolicy = {}) {
  const policy = normalizeCapabilityPolicy(inputPolicy);
  const explicitlyAllowed = new Set(policy.allowedTools);
  return (Array.isArray(tools) ? tools : []).flatMap((tool) => {
    const name = String(tool?.function?.name || tool?.name || "");
    const readOnly = SAFE_TOOL_NAMES.has(name) && isReadOnlyToolName(name);
    const mutating = MUTATING_TOOL_NAMES.has(name) && explicitlyAllowed.has(name);
    if (!readOnly && !mutating) return [];
    if (mutating && policy.preset === "read-only") return [];
    if (name === "Bash" || name === "sendMail" || name === "todoWrite") {
      if (policy.preset !== "trusted-automation") return [];
    }
    if (name !== "memoryManage") return [tool];
    const clone = globalThis.structuredClone
      ? globalThis.structuredClone(tool)
      : JSON.parse(JSON.stringify(tool));
    const action = clone?.function?.parameters?.properties?.action;
    if (action) action.enum = Array.from(SAFE_MEMORY_ACTIONS);
    return [clone];
  });
}

export function isReadOnlyToolCall(call) {
  const name = String(call?.name || "");
  if (!SAFE_TOOL_NAMES.has(name) || !isReadOnlyToolName(name)) return false;
  if (name === "memoryManage") return SAFE_MEMORY_ACTIONS.has(String(call?.args?.action || ""));
  return true;
}

function normalizePath(value) {
  const raw = String(value || "").trim().replaceAll("\\", "/");
  const prefix = raw.startsWith("/") ? "/" : /^[A-Za-z]:\//.test(raw) ? raw.slice(0, 3) : "";
  const source = prefix === "/" ? raw.slice(1) : prefix ? raw.slice(3) : raw;
  const parts = [];
  for (const part of source.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${prefix}${parts.join("/")}`.replace(/\/+$/, "");
}

function isPathWithinRoots(value, roots) {
  const path = normalizePath(value);
  return roots.some((rootValue) => {
    const root = normalizePath(rootValue);
    return !!root && (path === root || path.startsWith(`${root}/`));
  });
}

export function authorizeToolCall(call, inputPolicy = {}, counters = {}) {
  const policy = normalizeCapabilityPolicy(inputPolicy);
  const name = String(call?.name || "");
  const args = call?.args || {};
  if (Number(counters.toolCalls || 0) >= policy.maxToolCalls) return { allowed: false, reason: "tool call quota exceeded" };
  if (isReadOnlyToolCall(call)) return { allowed: true };
  if (!policy.allowedTools.includes(name)) return { allowed: false, reason: "tool is not allowed by task policy" };
  if (policy.preset === "read-only") return { allowed: false, reason: "read-only policy" };
  if (name === "write" || name === "edit") {
    const path = args.file_path || args.path;
    return isPathWithinRoots(path, policy.fileRoots)
      ? { allowed: true }
      : { allowed: false, reason: "file path is outside allowed roots" };
  }
  if (policy.preset !== "trusted-automation") return { allowed: false, reason: "trusted automation is required" };
  if (name === "Bash") {
    const command = String(args.command || "").trim();
    const commandAllowed = policy.allowedCommandPrefixes.length === 0 || policy.allowedCommandPrefixes.some((prefix) =>
      command === prefix || command.startsWith(`${prefix} `)
    );
    if (!commandAllowed) return { allowed: false, reason: "terminal command is outside allowed prefixes" };
    if (policy.allowedTerminalSessionIds.length && !policy.allowedTerminalSessionIds.includes(String(args.session_id || ""))) {
      return { allowed: false, reason: "terminal session is not allowed" };
    }
    return { allowed: true };
  }
  if (name === "sendMail") {
    if (Number(counters.mail || 0) >= policy.maxMailPerRun) return { allowed: false, reason: "mail quota exceeded" };
    const recipients = [...(args.to || []), ...(args.cc || []), ...(args.bcc || [])].map((value) => String(value).toLowerCase());
    if (!recipients.length || recipients.some((email) => !policy.allowedRecipients.includes(email))) {
      return { allowed: false, reason: "mail recipient is not allowed" };
    }
    return { allowed: true };
  }
  if (name === "todoWrite") return { allowed: true };
  return { allowed: false, reason: "unsupported mutating tool" };
}

export function normalizeToolCall(call) {
  const args = { ...(call?.args || {}) };
  for (const key of ["url", "uri", "href"]) {
    if (typeof args[key] !== "string") continue;
    args[key] = args[key].trim().replace(/^`+|`+$/g, "").trim();
  }
  return { ...call, args };
}

function createAsyncEventQueue() {
  const values = [];
  const waiters = [];
  let closed = false;

  return {
    push(value) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else values.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (values.length) return Promise.resolve({ value: values.shift(), done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => waiters.push(resolve));
          }
        };
      }
    }
  };
}

function createId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createProgrammaticExecutor(deps) {
  const {
    runStream,
    getActiveModel,
    getTools,
    executeTool,
    runContributors,
    emit
  } = deps;

  return function execute(request = {}) {
    const prompt = String(request.prompt || "").trim();
    if (!prompt) throw new Error("prompt is required");
    if (!["local-only", "service-backed"].includes(request.executionMode)) {
      throw new Error("Unsupported scheduled execution mode");
    }

    const runId = createId("run");
    const sessionId = String(request.sessionId || `scheduled:${runId}`);
    const queue = createAsyncEventQueue();
    const controllerRef = { current: null };
    let sequence = 0;
    let aborted = false;
    let abortReason = null;

    const publish = (type, data = {}) => {
      const event = {
        schemaVersion: 1,
        eventId: createId("evt"),
        runId,
        sequence: ++sequence,
        type,
        ts: Date.now(),
        data
      };
      queue.push(event);
      try { emit?.("chat/runEvent", event); } catch {}
      return event;
    };

    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });

    const abort = async (reason = "user") => {
      if (aborted) return;
      aborted = true;
      abortReason = reason;
      try { controllerRef.current?.abort?.(); } catch {}
    };

    void (async () => {
      const startedAt = Date.now();
      let output = "";
      let usage = { input_tokens: 0, output_tokens: 0 };
      let messages = [{ role: "user", content: prompt }];
      const policy = normalizeCapabilityPolicy(request.policy);
      const counters = { toolCalls: 0, mail: 0 };
      const tools = filterToolsForPolicy(getTools?.() || [], policy);

      publish("run.started", {
        prompt,
        executionMode: request.executionMode,
        policy: { ...policy, allowedTools: tools.map((tool) => tool?.function?.name || tool?.name) }
      });

      try {
        if (runContributors) {
          messages = await runContributors(messages, "pre", {
            editor: null,
            sessionId,
            panelId: null,
            requestSource: "scheduled-task",
            runId
          });
        }

        let turn = 0;
        while (!aborted) {
          turn += 1;
          publish("turn.started", { turn });
          if (runContributors) {
            messages = await runContributors(messages, "post", {
              editor: null,
              sessionId,
              panelId: null,
              requestSource: "scheduled-task",
              runId
            });
          }

          const calls = [];
          let turnOutput = "";
          let streamError = null;
          const result = await runStream({
            messages,
            tools,
            activeModel: getActiveModel?.(),
            runId,
            sessionId,
            panelId: null,
            requestSource: "scheduled-task",
            stepIndex: turn,
            silentReasoning: true,
            onToken(token) {
              const text = String(token || "");
              output += text;
              turnOutput += text;
              publish("message.delta", { turn, delta: text });
            },
            onToolCall(call) {
                const normalizedCall = normalizeToolCall(call);
                calls.push(normalizedCall);
              publish("tool.requested", {
                turn,
                  callId: normalizedCall.id,
                  name: normalizedCall.name,
                  args: normalizedCall.args
              });
            },
            onInvalidToolCall(call) {
              publish("tool.denied", {
                turn,
                callId: call.id,
                name: call.name,
                reason: call.error || "invalid arguments"
              });
            },
            onError(error) {
              streamError = error;
            },
              onEnd() {},
            getController(controller) {
              controllerRef.current = controller;
              if (aborted) controller.abort();
            }
          });

          if (streamError) throw streamError;
          if (result?.usage) {
            usage = {
              input_tokens: usage.input_tokens + Number(result.usage.input_tokens || result.usage.prompt_tokens || 0),
              output_tokens: usage.output_tokens + Number(result.usage.output_tokens || result.usage.completion_tokens || 0)
            };
          }
          if (aborted) break;

          if (!calls.length) {
            publish("message.completed", { turn, content: turnOutput || output });
            publish("turn.completed", { turn, usage });
            break;
          }

          const toolCalls = [];
          const toolMessages = [];
          for (const call of calls) {
            toolCalls.push({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args || {}) }
            });
            const decision = authorizeToolCall(call, policy, counters);
            if (!decision.allowed) {
              publish("tool.denied", { turn, callId: call.id, name: call.name, reason: decision.reason });
              toolMessages.push({ role: "tool", tool_call_id: call.id, content: `Denied by task policy: ${decision.reason}` });
              continue;
            }
            counters.toolCalls += 1;
            if (call.name === "sendMail") counters.mail += 1;
            let toolResult;
            try {
              toolResult = await executeTool(call, { runId, sessionId, policy });
              publish("tool.completed", {
                turn,
                callId: call.id,
                name: call.name,
                result: String(toolResult ?? "").slice(0, 4000)
              });
            } catch (error) {
              toolResult = `Tool "${call.name}" error: ${error?.message || String(error)}`;
              publish("tool.completed", {
                turn,
                callId: call.id,
                name: call.name,
                error: String(error?.message || error)
              });
            }
            toolMessages.push({ role: "tool", tool_call_id: call.id, content: String(toolResult ?? "") });
          }
          messages = [...messages, { role: "assistant", content: turnOutput, tool_calls: toolCalls }, ...toolMessages];
          publish("turn.completed", { turn, usage });
        }

        if (aborted) {
          publish("run.aborted", { reason: abortReason || "user" });
          resolveCompletion({ runId, status: "aborted", reason: abortReason || "user", output, usage });
        } else {
          publish("run.completed", { output, usage, durationMs: Date.now() - startedAt });
          resolveCompletion({ runId, status: "completed", output, usage });
        }
      } catch (error) {
        const isAbort = aborted || error?.name === "AbortError";
        if (isAbort) {
          publish("run.aborted", { reason: abortReason || "user" });
          resolveCompletion({ runId, status: "aborted", reason: abortReason || "user", output, usage });
        } else {
          publish("run.failed", { error: error?.message || String(error) });
          resolveCompletion({ runId, status: "failed", error: error?.message || String(error), output, usage });
        }
      } finally {
        queue.close();
      }
    })();

    return { runId, completion, abort, events: queue.iterable };
  };
}
