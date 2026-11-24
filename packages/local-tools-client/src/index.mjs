import { homedir } from "node:os";
import { clearTimeout, setTimeout } from "node:timers";
import { URL, URLSearchParams } from "node:url";
import { normalizeToolExecution } from "../../plugin-sdk/src/tool-execution.mjs";

export const LOCAL_TOOLS_BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const LOCAL_TOOLS_BASH_MAX_TIMEOUT_MS = 600_000;

const TOOL_EXECUTION = Object.freeze({
  read: normalizeToolExecution({ effect: "read" }),
  write: normalizeToolExecution({ effect: "write" }),
  process: normalizeToolExecution({ effect: "process" }),
  external: normalizeToolExecution({ effect: "external" }),
  bash: normalizeToolExecution({
    effect: "process",
    timeoutMs: LOCAL_TOOLS_BASH_DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: LOCAL_TOOLS_BASH_MAX_TIMEOUT_MS,
    timeoutArgument: "timeout"
  })
});

export const READ_ONLY_TOOL_DEFINITIONS = [
  {
    name: "read",
    description: "Read a UTF-8 text file inside an allowed root; session_id selects an optional local or SSH session.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        session_id: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" }
      },
      required: ["path"],
      additionalProperties: false
    },
    hostKinds: ["local-tools"],
    execution: TOOL_EXECUTION.read
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern inside an allowed root.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        session_id: { type: "string" }
      },
      required: ["pattern"],
      additionalProperties: false
    },
    hostKinds: ["local-tools"],
    execution: TOOL_EXECUTION.read
  },
  {
    name: "grep",
    description: "Search file contents with a regular expression inside an allowed root.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        session_id: { type: "string" },
        glob: { type: "array", items: { type: "string" } },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"]
        },
        B: { type: "number" },
        A: { type: "number" },
        C: { type: "number" },
        n: { type: "boolean" },
        i: { type: "boolean" },
        type: { type: "string" },
        head_limit: { type: "number" },
        offset: { type: "number" },
        multiline: { type: "boolean" }
      },
      required: ["pattern"],
      additionalProperties: false
    },
    hostKinds: ["local-tools"],
    execution: TOOL_EXECUTION.read
  },
  {
    name: "tree",
    description: "List directory entries to a bounded depth inside an allowed root.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        session_id: { type: "string" },
        max_depth: { type: "number" }
      },
      required: ["path"],
      additionalProperties: false
    },
    hostKinds: ["local-tools"],
    execution: TOOL_EXECUTION.read
  }
];

export const LOCAL_TOOLS_TOOL_DEFINITIONS = [
  ...READ_ONLY_TOOL_DEFINITIONS,
  {
    name: "write",
    description: "Write a UTF-8 file inside an explicitly allowed workspace root.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        expected_hash: { type: "string", description: "content_hash from read, for conditional plugin-data writes." },
        create_only: { type: "boolean", description: "Create the file only when it does not already exist." },
        prompt: { type: "string" },
        session_id: { type: "string" }
      },
      required: ["path", "content"],
      additionalProperties: false
    },
    hostKinds: ["local-tools"],
    execution: TOOL_EXECUTION.write
  },
  {
    name: "edit",
    description: "Replace exact text in a file inside an explicitly allowed workspace root.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
        expected_hash: { type: "string" },
        prompt: { type: "string" },
        session_id: { type: "string" }
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false
    },
    hostKinds: ["local-tools"],
    execution: TOOL_EXECUTION.write
  },
  {
    name: "Bash",
    description: "Execute a command through local-tools under the Runtime command policy. "
      + "A timeout can leave the outcome unknown; inspect effects before retrying.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: {
          type: "integer",
          minimum: 1,
          maximum: LOCAL_TOOLS_BASH_MAX_TIMEOUT_MS,
          default: LOCAL_TOOLS_BASH_DEFAULT_TIMEOUT_MS
        },
        description: { type: "string" },
        session_id: { type: "string" }
      },
      required: ["command"],
      additionalProperties: false
    },
    hostKinds: ["local-tools"],
    execution: TOOL_EXECUTION.bash
  },
  {
    name: "webSearch",
    description: "Search the web through the configured local search provider.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        top_k: { type: "number" },
        allowed_domains: { type: "array", items: { type: "string" } },
        blocked_domains: { type: "array", items: { type: "string" } }
      },
      required: ["query"],
      additionalProperties: false
    },
    hostKinds: ["local-tools"],
    execution: TOOL_EXECUTION.read
  },
  {
    name: "sendMail",
    description: "Send email to recipients explicitly allowed by the Runtime policy.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
        html: { type: "boolean" },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              content: { type: "string" },
              content_type: { type: "string" }
            },
            required: ["filename", "content"],
            additionalProperties: false
          }
        }
      },
      required: ["to", "subject", "body"],
      additionalProperties: false
    },
    hostKinds: ["local-tools"],
    execution: TOOL_EXECUTION.external
  },
  {
    name: "mcpListTools",
    description: "List the tools exposed by the private local-tools MCP host.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    hostKinds: ["local-tools"],
    execution: TOOL_EXECUTION.read
  },
  {
    name: "mcpCall",
    description: "Invoke an allowlisted built-in local-tools MCP tool.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: [
            "read_file",
            "write_file",
            "list_files",
            "search_content",
            "execute_command"
          ]
        },
        arguments: { type: "object" }
      },
      required: ["name", "arguments"],
      additionalProperties: false
    },
    hostKinds: ["local-tools"],
    execution: TOOL_EXECUTION.process
  }
];

const TOOL_NAMES = new Set(LOCAL_TOOLS_TOOL_DEFINITIONS.map((tool) => tool.name));
const FILE_TOOL_NAMES = new Set(["read", "glob", "grep", "tree", "write", "edit"]);
const WRITE_TOOL_NAMES = new Set(["write", "edit"]);

function normalizePath(value) {
  let raw = String(value || "").trim().replaceAll("\\", "/");
  if (raw === "~" || raw.startsWith("~/")) {
    const home = homedir().replaceAll("\\", "/").replace(/\/+$/, "");
    raw = raw === "~" ? home : `${home}/${raw.slice(2)}`;
  }
  const drive = raw.match(/^[A-Za-z]:\//)?.[0] || "";
  const absolute = raw.startsWith("/") || !!drive;
  if (!absolute) return "";
  const prefix = raw.startsWith("/") ? "/" : drive;
  const source = raw.startsWith("/") ? raw.slice(1) : raw.slice(drive.length);
  const parts = [];
  for (const part of source.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return "";
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${prefix}${parts.join("/")}`.replace(/\/+$/, "") || prefix;
}

function pathWithinRoots(pathValue, roots) {
  const path = normalizePath(pathValue);
  if (!path) return false;
  return roots.some((rootValue) => {
    const root = normalizePath(rootValue);
    if (!root) return false;
    if (root === "/") return path.startsWith("/");
    return path === root || path.startsWith(`${root}/`);
  });
}

function intersectRoots(requestedRoots, localRoot) {
  const local = normalizePath(localRoot);
  if (!local) return [];
  const intersections = [];
  for (const requestedRoot of requestedRoots || []) {
    const requested = normalizePath(requestedRoot);
    if (!requested) continue;
    if (pathWithinRoots(requested, [local])) {
      intersections.push(requested);
    } else if (pathWithinRoots(local, [requested])) {
      intersections.push(local);
    }
  }
  return [...new Set(intersections)];
}

function appendQuery(query, key, value) {
  if (value === undefined || value === null || value === "") return;
  if (Array.isArray(value)) {
    for (const item of value) query.append(key, String(item));
    return;
  }
  query.set(key, String(value));
}

function hasUnquotedShellControlSyntax(value) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === "\"") {
      if (char === "\"") quote = null;
      else if (char === "`" || (char === "$" && value[index + 1] === "(")) {
        return true;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (
      [";", "|", "&", "<", ">", "`", "\n", "\r"].includes(char)
      || (char === "$" && value[index + 1] === "(")
    ) {
      return true;
    }
  }
  return false;
}

function commandMatchesPrefix(command, prefixValue) {
  const prefix = String(prefixValue || "").trim();
  if (!prefix) return false;
  if (command === prefix) return true;
  if (!command.startsWith(`${prefix} `)) return false;
  return !hasUnquotedShellControlSyntax(command.slice(prefix.length));
}

function assertSessionAllowed(args, policy) {
  const allowedSessionIds = (policy.allowedTerminalSessionIds || [])
    .map(String)
    .filter(Boolean);
  let sessionId = String(args.session_id || "").trim();
  if (!sessionId && allowedSessionIds.length === 1) {
    [sessionId] = allowedSessionIds;
    args.session_id = sessionId;
  }
  if (
    sessionId
    && allowedSessionIds.length
    && !allowedSessionIds.includes(sessionId)
  ) {
    throw new Error("terminal session is not allowed by capability policy");
  }
  return sessionId;
}

function assertFileAllowed(args, policy, { allowUnscoped = false } = {}) {
  const roots = policy.fileRoots || [];
  if (!String(args.path || "").trim() && roots.length === 1) [args.path] = roots;
  const normalized = normalizePath(args.path);
  if (allowUnscoped && roots.length === 0 && normalized) {
    args.path = normalized;
    return;
  }
  if (!pathWithinRoots(normalized, roots)) {
    const allowed = roots.map(normalizePath).filter(Boolean).join(", ") || "(none)";
    throw new Error(
      `file path "${String(args.path || "").trim() || "(missing)"}" `
      + `is outside allowed roots: ${allowed}`
    );
  }
  args.path = normalized;
}

function mailRecipients(args) {
  return [
    ...(Array.isArray(args.to) ? args.to : []),
    ...(Array.isArray(args.cc) ? args.cc : []),
    ...(Array.isArray(args.bcc) ? args.bcc : [])
  ].map((value) => String(value).trim().toLowerCase()).filter(Boolean);
}

function authorizeTool(name, args, policy, {
  allowDangerousCommands = false
} = {}) {
  if (!(policy.allowedTools || []).includes(name)) {
    throw new Error("tool is not allowed by capability policy");
  }
  if (FILE_TOOL_NAMES.has(name)) {
    assertSessionAllowed(args, policy);
    assertFileAllowed(args, policy, {
      allowUnscoped: true
    });
  }
  if (WRITE_TOOL_NAMES.has(name) && policy.preset === "read-only") {
    throw new Error("file mutation requires workspace-write capability");
  }
  if (name === "Bash") {
    if (policy.preset !== "trusted-automation") {
      throw new Error("Bash requires trusted-automation capability");
    }
    if (
      args.dangerouslyDisableSandbox === true
      && !allowDangerousCommands
    ) {
      throw new Error("Runtime never disables the local-tools sandbox");
    }
    assertSessionAllowed(args, policy);
    const command = String(args.command || "").trim();
    if (!command) throw new Error("command is required");
    const prefixes = policy.allowedCommandPrefixes || [];
    if (
      prefixes.length
      && !prefixes.some((prefix) => commandMatchesPrefix(command, prefix))
    ) {
      throw new Error("terminal command is outside allowed prefixes");
    }
  }
  if (name === "sendMail") {
    if (policy.preset !== "trusted-automation") {
      throw new Error("sendMail requires trusted-automation capability");
    }
    const allowed = new Set(
      (policy.allowedRecipients || []).map((value) => String(value).toLowerCase())
    );
    const recipients = mailRecipients(args);
    if (
      !recipients.length
      || (
        !allowed.has("*")
        && recipients.some((recipient) => !allowed.has(recipient))
      )
    ) {
      throw new Error("mail recipient is not allowed by capability policy");
    }
  }
  if (name === "mcpCall") {
    const mcpName = String(args.name || "");
    const mcpArgs = args.arguments && typeof args.arguments === "object"
      ? { ...args.arguments }
      : {};
    args.arguments = mcpArgs;
    if (["read_file", "list_files", "search_content", "write_file"].includes(mcpName)) {
      assertFileAllowed(mcpArgs, policy, {
        allowUnscoped: true
      });
    }
    if (mcpName === "write_file" && policy.preset === "read-only") {
      throw new Error("MCP file mutation requires workspace-write capability");
    }
    if (mcpName === "execute_command") {
      if (policy.preset !== "trusted-automation") {
        throw new Error("MCP command execution requires trusted-automation capability");
      }
      const command = String(mcpArgs.command || "").trim();
      const prefixes = policy.allowedCommandPrefixes || [];
      if (
        prefixes.length
        && !prefixes.some((prefix) => commandMatchesPrefix(command, prefix))
      ) {
        throw new Error("MCP command is outside allowed prefixes");
      }
    }
  }
}

function canAdvertiseTool(name, policy) {
  if (!(policy.allowedTools || []).includes(name)) return false;
  if (WRITE_TOOL_NAMES.has(name) && policy.preset === "read-only") return false;
  if (name === "Bash" && policy.preset !== "trusted-automation") return false;
  if (name === "sendMail") {
    return policy.preset === "trusted-automation"
      && Number(policy.maxMailPerRun || 0) > 0
      && (policy.allowedRecipients || []).length > 0;
  }
  return true;
}

function requestForTool(name, args) {
  const query = new URLSearchParams();
  if (name === "read") {
    for (const key of ["path", "session_id", "offset", "limit"]) {
      appendQuery(query, key, args[key]);
    }
    return `/files/read?${query}`;
  }
  if (name === "glob") {
    for (const key of ["pattern", "path", "session_id"]) {
      appendQuery(query, key, args[key]);
    }
    return `/files/glob?${query}`;
  }
  if (name === "grep") {
    for (const key of [
      "pattern",
      "path",
      "session_id",
      "glob",
      "output_mode",
      "B",
      "A",
      "C",
      "n",
      "i",
      "type",
      "head_limit",
      "offset",
      "multiline"
    ]) {
      appendQuery(query, key, args[key]);
    }
    return `/files/grep?${query}`;
  }
  if (name === "tree") {
    for (const key of ["path", "session_id", "max_depth"]) {
      appendQuery(query, key, args[key]);
    }
    return `/files/entries?${query}`;
  }
  if (name === "webSearch") {
    appendQuery(query, "q", args.query);
    appendQuery(query, "k", args.top_k || 10);
    appendQuery(query, "allowed_domains", args.allowed_domains);
    appendQuery(query, "blocked_domains", args.blocked_domains);
    return `/search?${query}`;
  }
  throw new Error(`Unsupported local-tools tool: ${name}`);
}

function requestOptionsForTool(name, args, {
  allowDangerousCommands = false
} = {}) {
  if (["read", "glob", "grep", "tree", "webSearch"].includes(name)) {
    return { path: requestForTool(name, args), method: "GET" };
  }
  if (name === "write") {
    return {
      path: "/files/write",
      method: "POST",
      body: {
        path: args.path,
        content: String(args.content ?? ""),
        ...(args.expected_hash !== undefined
          ? { expected_hash: args.expected_hash }
          : {}),
        ...(args.create_only ? { create_only: true } : {}),
        session_id: args.session_id || undefined
      }
    };
  }
  if (name === "edit") {
    return {
      path: "/files/edit",
      method: "POST",
      body: {
        path: args.path,
        old_string: String(args.old_string ?? ""),
        new_string: String(args.new_string ?? ""),
        replace_all: args.replace_all === true,
        ...(args.expected_hash !== undefined
          ? { expected_hash: args.expected_hash }
          : {}),
        session_id: args.session_id || undefined
      }
    };
  }
  if (name === "Bash") {
    const sessionId = String(args.session_id || "").trim();
    return {
      path: sessionId
        ? `/sessions/${encodeURIComponent(sessionId)}/exec`
        : "/bash",
      method: "POST",
      body: {
        command: String(args.command || ""),
        timeout: args.timeout,
        dangerouslyDisableSandbox: allowDangerousCommands,
        ...(sessionId ? {} : { cwd: args.cwd || undefined })
      }
    };
  }
  if (name === "sendMail") {
    return {
      path: "/mail/send",
      method: "POST",
      body: {
        to: args.to || [],
        cc: args.cc || undefined,
        bcc: args.bcc || undefined,
        subject: String(args.subject || ""),
        body: String(args.body || ""),
        html: args.html === true,
        attachments: args.attachments || undefined
      }
    };
  }
  if (name === "mcpListTools" || name === "mcpCall") {
    return {
      path: "/mcp",
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: args.request_id || 1,
        method: name === "mcpListTools" ? "tools/list" : "tools/call",
        params: name === "mcpListTools"
          ? {}
          : { name: args.name, arguments: args.arguments || {} }
      }
    };
  }
  throw new Error(`Unsupported local-tools tool: ${name}`);
}

function compactResult(value, maxChars) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} characters]`;
}

export class LocalToolsBroker {
  constructor({
    baseUrl = "http://127.0.0.1:8765",
    fetchImpl = globalThis.fetch,
    healthTimeoutMs = 5000,
    dataFiles = null,
    maxResultChars = 30_000,
    allowDangerousCommands = false
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.healthTimeoutMs = healthTimeoutMs;
    this.dataFiles = dataFiles;
    this.maxResultChars = maxResultChars;
    this.allowDangerousCommands = allowDangerousCommands === true;
    this.supportedToolNames = LOCAL_TOOLS_TOOL_DEFINITIONS.map((tool) => tool.name);
  }

  async listTools(request = {}) {
    const policy = request.policy || {};
    const selected = LOCAL_TOOLS_TOOL_DEFINITIONS.filter(
      (tool) => canAdvertiseTool(tool.name, policy)
    );
    if (!selected.length) return [];
    await this.assertHealthy();
    return selected;
  }

  getToolDefinitions() {
    return LOCAL_TOOLS_TOOL_DEFINITIONS.map((tool) => ({
      ...tool,
      inputSchema: { ...tool.inputSchema },
      execution: { ...tool.execution }
    }));
  }

  async invoke(invocation, signal) {
    const call = invocation.toolCall || {};
    if (!TOOL_NAMES.has(call.name)) {
      throw new Error(`Unsupported local-tools tool: ${call.name}`);
    }
    const args = { ...(call.arguments || {}) };
    const explicitSessionId = Object.hasOwn(call.arguments || {}, "session_id")
      && String(call.arguments?.session_id || "").trim();
    authorizeTool(call.name, args, invocation.policy || {}, {
      allowDangerousCommands: this.allowDangerousCommands
    });
    if (this.dataFiles) {
      signal.throwIfCancelled();
      try {
        const dataFileArgs = explicitSessionId ? args : { ...args, session_id: undefined };
        const payload = await this.dataFiles.handle(call.name, dataFileArgs, { signal });
        if (payload) return { ok: true, content: compactResult(payload, this.maxResultChars) };
      } catch (error) {
        return { ok: false, content: error.message, error: error.message };
      }
    }
    if (args.expected_hash !== undefined) {
      throw new Error("Conditional writes require a plugin-data path without a terminal session");
    }
    const request = requestOptionsForTool(call.name, args, {
      allowDangerousCommands: this.allowDangerousCommands
    });

    signal.throwIfCancelled();
    const controller = new globalThis.AbortController();
    const cancellation = signal.onCancel((reason) => {
      // #region debug-point B:mac-local-tools-abort
      void fetch("http://127.0.0.1:7777/event", { method: "POST", body: JSON.stringify({ sessionId: "mac-command-sigkill", runId: "post-fix", hypothesisId: "B", location: "local-tools-client:index.mjs:invoke", msg: "[DEBUG] Mac local-tools request aborted", data: { invocationId: invocation.invocationId, toolName: call.name, reason: reason || signal.reason || null, abortedAt: Date.now() }, ts: Date.now() }) }).catch(() => {});
      // #endregion
      // #region debug-point A:local-tools-abort-requested
      void fetch("http://127.0.0.1:7777/event", { method: "POST", body: JSON.stringify({ sessionId: "command-timeout-duplicates", runId: "pre-fix", hypothesisId: "A", location: "local-tools-client:index.mjs:invoke", msg: "[DEBUG] Local-tools HTTP abort requested", data: { invocationId: invocation.invocationId, toolName: call.name, reason: reason || signal.reason || null, abortedAt: Date.now() }, ts: Date.now() }) }).catch(() => {});
      // #endregion
      controller.abort();
    });
    // #region debug-point A-D:mac-local-tools-request
    void fetch("http://127.0.0.1:7777/event", { method: "POST", body: JSON.stringify({ sessionId: "mac-command-sigkill", runId: "post-fix", hypothesisId: "A-D", location: "local-tools-client:index.mjs:invoke", msg: "[DEBUG] Mac local-tools HTTP request started", data: { invocationId: invocation.invocationId, toolName: call.name, requestPath: request.path, hasSessionId: Boolean(args.session_id), requestedTimeoutMs: request.body?.timeout ?? null, dangerousRequested: request.body?.dangerouslyDisableSandbox === true, startedAt: Date.now() }, ts: Date.now() }) }).catch(() => {});
    // #endregion
    // #region debug-point A:local-tools-request-started
    void fetch("http://127.0.0.1:7777/event", { method: "POST", body: JSON.stringify({ sessionId: "command-timeout-duplicates", runId: "pre-fix", hypothesisId: "A", location: "local-tools-client:index.mjs:invoke", msg: "[DEBUG] Local-tools HTTP request started", data: { invocationId: invocation.invocationId, toolName: call.name, requestPath: request.path, requestedTimeoutMs: request.body?.timeout ?? null, startedAt: Date.now() }, ts: Date.now() }) }).catch(() => {});
    // #endregion
    try {
      const response = await this.fetchImpl(
        new URL(request.path, this.baseUrl),
        {
          method: request.method,
          headers: {
            accept: "application/json",
            ...(request.body ? { "content-type": "application/json" } : {}),
            "x-zion-invocation-id": invocation.invocationId
          },
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
          signal: controller.signal
        }
      );
      const raw = await response.text();
      let payload;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = raw;
      }
      const mcpResult = call.name === "mcpListTools" || call.name === "mcpCall"
        ? payload?.result
        : null;
      const applicationError = payload && typeof payload === "object"
        ? payload.error
          || (payload.ok === false ? "local-tools request failed" : "")
          || (mcpResult?.isError ? "MCP tool returned an error" : "")
        : "";
      // #region debug-point C:mac-local-tools-response
      void fetch("http://127.0.0.1:7777/event", { method: "POST", body: JSON.stringify({ sessionId: "mac-command-sigkill", runId: "post-fix", hypothesisId: "C", location: "local-tools-client:index.mjs:invoke", msg: "[DEBUG] Mac local-tools HTTP response received", data: { invocationId: invocation.invocationId, toolName: call.name, httpStatus: response.status, payloadOk: payload?.ok ?? null, exitCode: payload?.exit_code ?? null, payloadTimeout: payload?.timeout === true, durationMs: payload?.duration_ms ?? null, sandbox: payload?.sandbox ?? null, applicationError: Boolean(applicationError), receivedAt: Date.now() }, ts: Date.now() }) }).catch(() => {});
      // #endregion
      // #region debug-point E:local-tools-response
      void fetch("http://127.0.0.1:7777/event", { method: "POST", body: JSON.stringify({ sessionId: "command-timeout-duplicates", runId: "pre-fix", hypothesisId: "E", location: "local-tools-client:index.mjs:invoke", msg: "[DEBUG] Local-tools HTTP response received", data: { invocationId: invocation.invocationId, toolName: call.name, httpStatus: response.status, payloadOk: payload?.ok ?? null, payloadTimeout: payload?.timeout === true, durationMs: payload?.duration_ms ?? null, applicationError: Boolean(applicationError), receivedAt: Date.now() }, ts: Date.now() }) }).catch(() => {});
      // #endregion
      if (!response.ok || applicationError) {
        const executionOutcomeUnknown = call.name === "Bash"
          && payload?.timeout === true;
        const uncertaintyWarning = executionOutcomeUnknown
          ? (payload?.termination_confirmed === true
            ? "Command execution timed out and its process group was terminated. Partial effects may remain. "
            : "Command execution timed out, but child-process termination was not confirmed. "
              + "The command may still be running or may already have completed. ")
            + "Do not retry it until you have inspected its effects."
          : "";
        const error = String(
          uncertaintyWarning
          || applicationError
          || payload?.detail
          || raw
          || `HTTP ${response.status}`
        );
        return {
          ok: false,
          content: [
            uncertaintyWarning,
            compactResult(payload ?? error, this.maxResultChars)
          ].filter(Boolean).join("\n"),
          error,
          ...(executionOutcomeUnknown
            ? { failureCode: "execution_outcome_unknown", retryable: false }
            : {
                failureCode: String(payload?.failureCode || (response.status >= 500 ? "http_5xx" : "http_4xx")),
                ...(typeof payload?.retryable === "boolean" ? { retryable: payload.retryable } : {})
              })
        };
      }
      return {
        ok: true,
        content: compactResult(mcpResult ?? payload, this.maxResultChars)
      };
    } catch (error) {
      // #region debug-point D:local-tools-request-error
      void fetch("http://127.0.0.1:7777/event", { method: "POST", body: JSON.stringify({ sessionId: "command-timeout-duplicates", runId: "pre-fix", hypothesisId: "D", location: "local-tools-client:index.mjs:invoke", msg: "[DEBUG] Local-tools HTTP request threw", data: { invocationId: invocation.invocationId, toolName: call.name, errorName: error?.name || "", errorMessage: String(error?.message || error), signalCancelled: signal.cancelled, cancelReason: signal.reason || null, failedAt: Date.now() }, ts: Date.now() }) }).catch(() => {});
      // #endregion
      throw error;
    } finally {
      cancellation.dispose();
    }
  }

  async assertHealthy() {
    const controller = new globalThis.AbortController();
    const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs);
    try {
      const response = await this.fetchImpl(new URL("/health", this.baseUrl), {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`local-tools health HTTP ${response.status}`);
      }
    } catch (error) {
      throw new Error(
        `local-tools unavailable at ${this.baseUrl}: ${error?.message || String(error)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export class LocalToolsReadOnlyBroker extends LocalToolsBroker {
  getToolDefinitions() {
    return READ_ONLY_TOOL_DEFINITIONS.map((tool) => ({
      ...tool,
      inputSchema: { ...tool.inputSchema },
      execution: { ...tool.execution }
    }));
  }

  async listTools(request = {}) {
    const readOnlyAllowed = (request.policy?.allowedTools || [])
      .filter((name) => READ_ONLY_TOOL_DEFINITIONS.some((tool) => tool.name === name));
    return super.listTools({
      ...request,
      policy: { ...(request.policy || {}), allowedTools: readOnlyAllowed }
    });
  }

  async invoke(invocation, signal) {
    if (!READ_ONLY_TOOL_DEFINITIONS.some(
      (tool) => tool.name === invocation.toolCall?.name
    )) {
      throw new Error(`Unsupported read-only local-tools tool: ${invocation.toolCall?.name}`);
    }
    return super.invoke(invocation, signal);
  }
}

export class LocalToolsDeviceHost {
  constructor({
    baseUrl = "http://127.0.0.1:8765",
    resourceBindings = {},
    additionalRoots = [],
    accessPolicyProvider = null,
    dataFiles = null,
    fetchImpl = globalThis.fetch,
    healthTimeoutMs = 5000,
    maxResultChars = 30_000,
    allowDangerousCommands = false
  } = {}) {
    this.broker = new LocalToolsBroker({
      baseUrl,
      fetchImpl,
      healthTimeoutMs,
      dataFiles,
      maxResultChars,
      allowDangerousCommands
    });
    this.accessPolicyProvider = typeof accessPolicyProvider === "function"
      ? accessPolicyProvider
      : null;
    this.bindings = new Map();
    const extraRoots = (Array.isArray(additionalRoots) ? additionalRoots : [])
      .map(normalizePath)
      .filter(Boolean);
    for (const [resourceId, input] of Object.entries(resourceBindings)) {
      const root = normalizePath(input?.root);
      if (!root) {
        throw new Error(`Device resource ${resourceId} requires an absolute root`);
      }
      this.bindings.set(resourceId, {
        root,
        roots: [...new Set([root, ...extraRoots])],
        allowedTerminalSessionIds: new Set(
          Array.isArray(input?.allowedTerminalSessionIds)
            ? input.allowedTerminalSessionIds.map(String).filter(Boolean)
            : []
        )
      });
    }
  }

  async assertHealthy() {
    await this.broker.assertHealthy();
  }

  async invoke(invocation, signal, route = {}) {
    const resourceId = String(route.resourceId || "");
    const binding = this.bindings.get(resourceId);
    if (!binding) {
      throw new Error(`Device resource is not configured: ${resourceId || "missing"}`);
    }

    const dynamicAccess = await this.accessPolicyProvider?.({
      invocation,
      resourceId,
      binding: {
        root: binding.root,
        roots: [...binding.roots],
        allowedTerminalSessionIds: Array.from(
          binding.allowedTerminalSessionIds
        )
      }
    });
    const deviceRoots = Array.isArray(dynamicAccess?.fileRoots)
      ? dynamicAccess.fileRoots.map(normalizePath).filter(Boolean)
      : binding.roots;
    const deviceSessionIds = new Set(
      Array.isArray(dynamicAccess?.allowedTerminalSessionIds)
        ? dynamicAccess.allowedTerminalSessionIds.map(String).filter(Boolean)
        : binding.allowedTerminalSessionIds
    );
    const remotePolicy = invocation.policy || {};
    const toolName = String(invocation.toolCall?.name || "");
    const resourceScoped = FILE_TOOL_NAMES.has(toolName)
      || toolName === "Bash"
      || toolName === "mcpCall";
    const requestedRoots = remotePolicy.fileRoots || [];
    const fileRoots = resourceScoped
      ? requestedRoots.length
        ? [...new Set(deviceRoots.flatMap((root) =>
            intersectRoots(requestedRoots, root)
          ))]
        : deviceRoots
      : requestedRoots;
    if (resourceScoped && !fileRoots.length) {
      throw new Error("Runtime file roots do not intersect the Device resource");
    }
    const requestedSessions = (remotePolicy.allowedTerminalSessionIds || [])
      .map(String);
    const allowedTerminalSessionIds = requestedSessions.length
      ? requestedSessions.filter((id) => deviceSessionIds.has(id))
      : Array.from(deviceSessionIds);
    if (requestedSessions.length && !allowedTerminalSessionIds.length) {
      throw new Error("Runtime terminal sessions do not intersect the Device resource");
    }

    return await this.broker.invoke({
      ...invocation,
      policy: {
        ...remotePolicy,
        allowedTools: (remotePolicy.allowedTools || [])
          .filter((name) => TOOL_NAMES.has(name)),
        fileRoots,
        allowedTerminalSessionIds
      }
    }, signal);
  }
}
