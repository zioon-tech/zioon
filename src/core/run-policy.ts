export type RunPolicyPreset = "read-only" | "workspace-write" | "trusted-automation";

export type CapabilityPolicy = {
  preset: RunPolicyPreset;
  allowedTools: string[];
  fileRoots: string[];
  allowedCommandPrefixes: string[];
  allowedTerminalSessionIds: string[];
  allowedRecipients: string[];
  maxMailPerRun: number;
  maxToolCalls: number;
};

export type ToolCallLike = {
  id?: string;
  name?: string;
  args?: Record<string, any>;
};

export type ToolLike = {
  name?: string;
  function?: {
    name?: string;
    parameters?: any;
  };
};

export type RunPolicyCounters = {
  toolCalls?: number;
  mail?: number;
};

export type RunPolicyDecision = {
  allowed: boolean;
  reason?: string;
};

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
  "memoryManage",
  "agentsManage",
  "identityManage",
  "projectAutomationManage"
]);

const SAFE_MEMORY_ACTIONS = new Set(["list", "tree", "read", "search", "build_context", "providers"]);
const SAFE_AGENTS_ACTIONS = new Set(["list_agents", "list_tasks", "get_task"]);
const SAFE_IDENTITY_ACTIONS = new Set(["get"]);
const SAFE_PROJECT_AUTOMATION_ACTIONS = new Set(["get"]);
const WRITE_IDENTITY_ACTIONS = new Set([
  "update_snapshot",
  "patch_files",
  "append_biography_events",
  "load_files",
  "write_files",
  "clear"
]);
const WRITE_PROJECT_AUTOMATION_ACTIONS = new Set([
  "request_update",
  "disable",
  "run_now",
  "stop"
]);
const SAFE_MANAGE_TOOL_ACTIONS = new Map([
  ["memoryManage", SAFE_MEMORY_ACTIONS],
  ["agentsManage", SAFE_AGENTS_ACTIONS],
  ["identityManage", SAFE_IDENTITY_ACTIONS],
  ["projectAutomationManage", SAFE_PROJECT_AUTOMATION_ACTIONS]
]);
const WRITE_AGENTS_ACTIONS = new Set([
  "create_task",
  "create_research_task",
  "delete_task",
  "select_task",
  "run_task",
  "stop_task"
]);
const MUTATING_TOOL_NAMES = new Set([
  "write",
  "edit",
  "Bash",
  "sendMail",
  "todoWrite",
  "modelsManage",
  "toolsManage",
  "mailManage",
  "agentsManage",
  "identityManage",
  "projectAutomationManage",
  "sessionCreate",
  "sessionUpdate",
  "sessionDelete"
]);

const LEGACY_SCHEDULED_TOOL_ALIASES = new Map([
  ["fsWrite", "write"],
  ["fsEdit", "edit"],
  ["terminalExecute", "Bash"]
]);

export function isReadOnlyToolName(name: any): boolean {
  const normalized = String(name || "").trim();
  return !!normalized && !WRITE_TOOL_PATTERN.test(normalized);
}

export function normalizeCapabilityPolicy(input: any = {}): CapabilityPolicy {
  const preset: RunPolicyPreset = ["read-only", "workspace-write", "trusted-automation"].includes(input?.preset)
    ? input.preset
    : "read-only";
  return {
    preset,
    // Keep saved tasks created before the local-tools migration runnable.
    allowedTools: Array.isArray(input?.allowedTools)
      ? [...new Set<string>(input.allowedTools.map((name: any): string => (
          LEGACY_SCHEDULED_TOOL_ALIASES.get(String(name)) || String(name)
        )))]
      : [],
    fileRoots: Array.isArray(input?.fileRoots) ? input.fileRoots.map(String).filter(Boolean) : [],
    allowedCommandPrefixes: Array.isArray(input?.allowedCommandPrefixes)
      ? input.allowedCommandPrefixes.map(String).filter(Boolean)
      : [],
    allowedTerminalSessionIds: Array.isArray(input?.allowedTerminalSessionIds)
      ? input.allowedTerminalSessionIds.map(String).filter(Boolean)
      : [],
    allowedRecipients: Array.isArray(input?.allowedRecipients)
      ? input.allowedRecipients.map((value: any) => String(value).toLowerCase()).filter(Boolean)
      : [],
    maxMailPerRun: Math.max(0, Number(input?.maxMailPerRun) || 0),
    maxToolCalls: Math.max(1, Number(input?.maxToolCalls) || 50)
  };
}

export function filterReadOnlyTools<T extends ToolLike>(tools: T[]): T[] {
  return filterToolsForPolicy(tools, { preset: "read-only" });
}

export function filterToolsForPolicy<T extends ToolLike>(tools: T[], inputPolicy: any = {}): T[] {
  const policy = normalizeCapabilityPolicy(inputPolicy);
  const explicitlyAllowed = new Set(policy.allowedTools);
  return (Array.isArray(tools) ? tools : []).flatMap((tool) => {
    const name = String(tool?.function?.name || tool?.name || "");
    const readOnly = SAFE_TOOL_NAMES.has(name) && isReadOnlyToolName(name);
    const mutating = MUTATING_TOOL_NAMES.has(name) && explicitlyAllowed.has(name);
    if (!readOnly && !mutating) return [];
    if (mutating && policy.preset === "read-only" && !readOnly) return [];
    if (
      name === "Bash"
      || name === "sendMail"
      || name === "todoWrite"
      || name === "modelsManage"
      || name === "toolsManage"
      || name === "mailManage"
    ) {
      if (policy.preset !== "trusted-automation") return [];
    }
    const safeActions = SAFE_MANAGE_TOOL_ACTIONS.get(name);
    if (!safeActions) return [tool];
    const clone = globalThis.structuredClone
      ? globalThis.structuredClone(tool)
      : JSON.parse(JSON.stringify(tool));
    const action = clone?.function?.parameters?.properties?.action;
    if (action && (policy.preset === "read-only" || !explicitlyAllowed.has(name))) {
      action.enum = Array.from(safeActions);
    }
    return [clone];
  });
}

export function isReadOnlyToolCall(call: ToolCallLike): boolean {
  const name = String(call?.name || "");
  if (!SAFE_TOOL_NAMES.has(name) || !isReadOnlyToolName(name)) return false;
  if (name === "memoryManage") return SAFE_MEMORY_ACTIONS.has(String(call?.args?.action || ""));
  if (name === "agentsManage") return SAFE_AGENTS_ACTIONS.has(String(call?.args?.action || ""));
  if (name === "identityManage") return SAFE_IDENTITY_ACTIONS.has(String(call?.args?.action || ""));
  if (name === "projectAutomationManage") return SAFE_PROJECT_AUTOMATION_ACTIONS.has(String(call?.args?.action || ""));
  return true;
}

function normalizePath(value: any): string {
  const raw = String(value || "").trim().replaceAll("\\", "/");
  const prefix = raw.startsWith("/") ? "/" : /^[A-Za-z]:\//.test(raw) ? raw.slice(0, 3) : "";
  const source = prefix === "/" ? raw.slice(1) : prefix ? raw.slice(3) : raw;
  const parts: string[] = [];
  for (const part of source.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${prefix}${parts.join("/")}`.replace(/\/+$/, "");
}

function isPathWithinRoots(value: any, roots: string[]): boolean {
  const path = normalizePath(value);
  return roots.some((rootValue) => {
    const root = normalizePath(rootValue);
    return !!root && (path === root || path.startsWith(`${root}/`));
  });
}

function hasUnquotedShellControlSyntax(value: string): boolean {
  let quote: "'" | '"' | null = null;
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
    if (quote === '"') {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === "`" || (char === "$" && value[index + 1] === "(")) return true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (
      char === ";"
      || char === "|"
      || char === "&"
      || char === "<"
      || char === ">"
      || char === "`"
      || char === "\n"
      || char === "\r"
      || (char === "$" && value[index + 1] === "(")
    ) {
      return true;
    }
  }
  return false;
}

function commandMatchesAllowedPrefix(command: string, prefixValue: string): boolean {
  const prefix = prefixValue.trim();
  if (!prefix) return false;
  if (command === prefix) return true;
  if (!command.startsWith(`${prefix} `)) return false;
  return !hasUnquotedShellControlSyntax(command.slice(prefix.length));
}

export function authorizeToolCall(
  call: ToolCallLike,
  inputPolicy: any = {},
  counters: RunPolicyCounters = {}
): RunPolicyDecision {
  const policy = normalizeCapabilityPolicy(inputPolicy);
  const name = String(call?.name || "");
  const args = call?.args || {};
  if (Number(counters.toolCalls || 0) >= policy.maxToolCalls) {
    return { allowed: false, reason: "tool call quota exceeded" };
  }
  if (isReadOnlyToolCall(call)) return { allowed: true };
  if (!policy.allowedTools.includes(name)) return { allowed: false, reason: "tool is not allowed by task policy" };
  if (policy.preset === "read-only") return { allowed: false, reason: "read-only policy" };
  if (name === "write" || name === "edit") {
    const path = args.file_path || args.path;
    return isPathWithinRoots(path, policy.fileRoots)
      ? { allowed: true }
      : { allowed: false, reason: "file path is outside allowed roots" };
  }
  if (name === "memoryManage") return { allowed: true };
  if (name === "agentsManage") {
    return WRITE_AGENTS_ACTIONS.has(String(args.action || ""))
      ? { allowed: true }
      : { allowed: false, reason: "unsupported agentsManage action" };
  }
  if (name === "identityManage") {
    return WRITE_IDENTITY_ACTIONS.has(String(args.action || ""))
      ? { allowed: true }
      : { allowed: false, reason: "unsupported identityManage action" };
  }
  if (name === "projectAutomationManage") {
    return WRITE_PROJECT_AUTOMATION_ACTIONS.has(String(args.action || ""))
      ? { allowed: true }
      : { allowed: false, reason: "unsupported projectAutomationManage action" };
  }
  if (policy.preset !== "trusted-automation") return { allowed: false, reason: "trusted automation is required" };
  if (name === "Bash") {
    const command = String(args.command || "").trim();
    const commandAllowed = policy.allowedCommandPrefixes.length === 0
      || policy.allowedCommandPrefixes.some((prefix) => commandMatchesAllowedPrefix(command, prefix));
    if (!commandAllowed) return { allowed: false, reason: "terminal command is outside allowed prefixes" };
    if (policy.allowedTerminalSessionIds.length && !policy.allowedTerminalSessionIds.includes(String(args.session_id || ""))) {
      return { allowed: false, reason: "terminal session is not allowed" };
    }
    return { allowed: true };
  }
  if (name === "sendMail") {
    if (Number(counters.mail || 0) >= policy.maxMailPerRun) return { allowed: false, reason: "mail quota exceeded" };
    const recipients = [...(args.to || []), ...(args.cc || []), ...(args.bcc || [])]
      .map((value) => String(value).toLowerCase());
    if (!recipients.length || recipients.some((email) => !policy.allowedRecipients.includes(email))) {
      return { allowed: false, reason: "mail recipient is not allowed" };
    }
    return { allowed: true };
  }
  if (name === "todoWrite") return { allowed: true };
  return { allowed: false, reason: "unsupported mutating tool" };
}

export function normalizeToolCall(call: ToolCallLike): ToolCallLike {
  const args = { ...(call?.args || {}) };
  for (const key of ["url", "uri", "href"]) {
    if (typeof args[key] !== "string") continue;
    args[key] = args[key].trim().replace(/^`+|`+$/g, "").trim();
  }
  return { ...call, args };
}
