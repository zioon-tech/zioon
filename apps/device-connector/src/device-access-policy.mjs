import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve
} from "node:path";
import { normalizeLocalToolsUrl } from "./device-setup.mjs";

export const DEVICE_ACCESS_SCOPES = Object.freeze([
  "workspace",
  "registered-projects",
  "selected-roots",
  "home"
]);

const SCOPE_SET = new Set(DEVICE_ACCESS_SCOPES);
const READ_TOOLS = new Set(["read", "glob", "grep", "tree"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const EXECUTE_TOOLS = new Set(["Bash"]);
const MAX_REQUESTS = 100;

function uniqueStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
}

export function normalizeDevicePath(value, home = homedir()) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  raw = raw.replaceAll("\\", "/");
  if (raw === "~" || raw.startsWith("~/")) {
    raw = raw === "~" ? home : resolve(home, raw.slice(2));
  }
  if (!isAbsolute(raw)) return "";
  return resolve(raw).replace(/\/+$/, "") || parse(resolve(raw)).root;
}

export function pathInsideDeviceRoot(pathValue, rootValue, home = homedir()) {
  const path = normalizeDevicePath(pathValue, home);
  const root = normalizeDevicePath(rootValue, home);
  if (!path || !root) return false;
  const value = relative(root, path);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function uniquePaths(values, home) {
  return [...new Set(
    uniqueStrings(values)
      .map((value) => normalizeDevicePath(value, home))
      .filter(Boolean)
  )];
}

function defaultSensitiveRoots(home) {
  return uniquePaths([
    join(home, ".ssh"),
    join(home, ".gnupg"),
    join(home, ".aws"),
    join(home, ".kube"),
    join(home, "Library", "Keychains"),
    join(home, "Library", "Application Support", "Google", "Chrome"),
    join(home, "Library", "Application Support", "Microsoft Edge")
  ], home);
}

function normalizedPermissions(value = {}) {
  return {
    read: value.read !== false,
    write: value.write !== false,
    execute: value.execute !== false
  };
}

function normalizeRequest(input = {}, home) {
  const path = normalizeDevicePath(input.path, home);
  return {
    id: String(input.id || randomUUID()),
    tool: String(input.tool || ""),
    permission: String(input.permission || "read"),
    path,
    reason: String(input.reason || "outside-scope"),
    suggestedRoot: normalizeDevicePath(input.suggestedRoot, home),
    projectRoot: normalizeDevicePath(input.projectRoot, home),
    status: ["pending", "approved", "approved-once", "rejected"]
      .includes(String(input.status))
      ? String(input.status)
      : "pending",
    createdAt: Math.max(0, Number(input.createdAt) || Date.now()),
    resolvedAt: Math.max(0, Number(input.resolvedAt) || 0)
  };
}

function normalizePolicy(input = {}, defaults = {}) {
  const home = defaults.home || homedir();
  const scope = SCOPE_SET.has(String(input.scope))
    ? String(input.scope)
    : SCOPE_SET.has(String(defaults.scope))
      ? String(defaults.scope)
      : "selected-roots";
  return {
    version: 1,
    scope,
    permissions: normalizedPermissions(
      input.permissions && typeof input.permissions === "object"
        ? input.permissions
        : defaults.permissions
    ),
    selectedRoots: uniquePaths(
      Array.isArray(input.selectedRoots)
        ? input.selectedRoots
        : defaults.selectedRoots,
      home
    ),
    sensitiveExceptions: uniquePaths(
      Array.isArray(input.sensitiveExceptions)
        ? input.sensitiveExceptions
        : defaults.sensitiveExceptions,
      home
    ),
    requests: (Array.isArray(input.requests) ? input.requests : [])
      .map((request) => normalizeRequest(request, home))
      .filter((request) => request.path)
      .slice(-MAX_REQUESTS),
    updatedAt: Math.max(0, Number(input.updatedAt) || Date.now())
  };
}

export class FileDeviceAccessPolicyStore {
  constructor({
    path = join(homedir(), ".zion-next", "device-access.json"),
    defaults = {},
    home = homedir(),
    now = () => Date.now()
  } = {}) {
    this.path = path;
    this.home = home;
    this.now = now;
    this.defaults = {
      scope: defaults.scope,
      permissions: normalizedPermissions(defaults.permissions),
      selectedRoots: uniquePaths(defaults.selectedRoots, home),
      sensitiveExceptions: uniquePaths(defaults.sensitiveExceptions, home),
      home
    };
    this.value = null;
  }

  get() {
    if (this.value) return structuredClone(this.value);
    let stored = {};
    let shouldPersist = false;
    try {
      stored = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(
          `Cannot read Device access policy ${this.path}: ${
            error?.message || String(error)
          }`
        );
      }
      shouldPersist = true;
    }
    this.value = normalizePolicy(stored, this.defaults);
    if (shouldPersist) this.persist();
    return structuredClone(this.value);
  }

  update(patch = {}) {
    const current = this.get();
    this.value = normalizePolicy({
      ...current,
      ...patch,
      permissions: patch.permissions && typeof patch.permissions === "object"
        ? { ...current.permissions, ...patch.permissions }
        : current.permissions,
      updatedAt: this.now()
    }, this.defaults);
    this.persist();
    return this.get();
  }

  recordRequest(request) {
    const current = this.get();
    const normalized = normalizeRequest({
      ...request,
      status: "pending",
      createdAt: this.now()
    }, this.home);
    const existing = current.requests.find((item) =>
      item.status === "pending"
      && item.tool === normalized.tool
      && item.path === normalized.path
      && item.reason === normalized.reason
    );
    if (existing) return existing;
    this.value = normalizePolicy({
      ...current,
      requests: [...current.requests, normalized],
      updatedAt: this.now()
    }, this.defaults);
    this.persist();
    return normalized;
  }

  resolveRequest(id, status) {
    const current = this.get();
    let resolvedRequest = null;
    const requests = current.requests.map((request) => {
      if (request.id !== String(id) || request.status !== "pending") {
        return request;
      }
      resolvedRequest = {
        ...request,
        status,
        resolvedAt: this.now()
      };
      return resolvedRequest;
    });
    if (!resolvedRequest) return null;
    this.value = normalizePolicy({
      ...current,
      requests,
      updatedAt: this.now()
    }, this.defaults);
    this.persist();
    return resolvedRequest;
  }

  persist() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}

function toolPermission(toolName, args = {}) {
  if (READ_TOOLS.has(toolName)) return "read";
  if (WRITE_TOOLS.has(toolName)) return "write";
  if (EXECUTE_TOOLS.has(toolName)) return "execute";
  if (toolName !== "mcpCall") return "";
  const name = String(args.name || "");
  if (name === "write_file") return "write";
  if (name === "execute_command") return "execute";
  if (["read_file", "list_files", "search_content"].includes(name)) {
    return "read";
  }
  return "";
}

function pathForTool(toolName, args = {}) {
  if (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) {
    return args.path;
  }
  if (toolName === "mcpCall") {
    return args.arguments?.path || args.arguments?.file_path;
  }
  return "";
}

function setPathForTool(toolName, args, path) {
  if (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) {
    args.path = path;
  } else if (toolName === "mcpCall") {
    args.arguments = {
      ...(args.arguments || {}),
      path
    };
  }
}

export class DeviceAccessManager {
  constructor({
    localToolsUrl = "http://127.0.0.1:8765",
    workspaceRoot,
    baseRoots = [],
    bootstrapRoots = [],
    scope = "selected-roots",
    store = null,
    policyPath,
    fetchImpl = globalThis.fetch,
    home = homedir(),
    now = () => Date.now(),
    cacheMs = 5000,
    exists = existsSync,
    stat = statSync
  } = {}) {
    this.localToolsUrl = normalizeLocalToolsUrl(localToolsUrl);
    this.home = normalizeDevicePath(home, home);
    this.workspaceRoot = normalizeDevicePath(workspaceRoot, this.home);
    if (!this.workspaceRoot) {
      throw new Error("Device access manager requires an absolute workspace root");
    }
    this.baseRoots = uniquePaths([
      this.workspaceRoot,
      ...baseRoots
    ], this.home);
    this.sensitiveRoots = defaultSensitiveRoots(this.home);
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cacheMs = cacheMs;
    this.exists = exists;
    this.stat = stat;
    this.store = store || new FileDeviceAccessPolicyStore({
      path: policyPath,
      home: this.home,
      now,
      defaults: {
        scope,
        selectedRoots: bootstrapRoots,
        permissions: { read: true, write: true, execute: true }
      }
    });
    this.cachedSessions = [];
    this.cachedAt = 0;
    this.oneTimeRoots = new Map();
  }

  projectRoot(value) {
    const normalized = normalizeDevicePath(value, this.home);
    if (!normalized) return "";
    let current = normalized;
    try {
      if (this.exists(current) && !this.stat(current).isDirectory()) {
        current = dirname(current);
      }
    } catch {
      current = dirname(current);
    }
    const fallback = current;
    const boundary = parse(current).root;
    while (current && current !== boundary) {
      if (this.exists(join(current, ".git"))) return current;
      current = dirname(current);
    }
    return fallback;
  }

  async sessions(force = false) {
    if (!force && this.cachedAt && this.now() - this.cachedAt < this.cacheMs) {
      return this.cachedSessions.map((session) => ({ ...session }));
    }
    const response = await this.fetchImpl(new URL("/sessions", this.localToolsUrl), {
      method: "GET",
      headers: { accept: "application/json" }
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        payload?.error || payload?.detail || `List local terminal sessions failed: HTTP ${response.status}`
      );
    }
    this.cachedSessions = (Array.isArray(payload?.sessions) ? payload.sessions : [])
      .filter((session) =>
        session?.active !== false
        && session?.id
        && normalizeDevicePath(session?.cwd || session?.initial_cwd, this.home)
      )
      .map((session) => ({
        id: String(session.id),
        cwd: normalizeDevicePath(session.cwd || session.initial_cwd, this.home),
        name: String(session.name || ""),
        type: String(session.type || "local"),
        lastActivity: Number(session.last_activity || session.lastActivity || 0)
      }));
    this.cachedAt = this.now();
    return this.cachedSessions.map((session) => ({ ...session }));
  }

  async state({ force = false } = {}) {
    const policy = this.store.get();
    const sessions = await this.sessions(force);
    const projectsByRoot = new Map();
    for (const session of sessions) {
      const root = this.projectRoot(session.cwd);
      if (!root) continue;
      const project = projectsByRoot.get(root) || {
        root,
        name: root.split("/").filter(Boolean).at(-1) || root,
        sessionIds: []
      };
      project.sessionIds.push(session.id);
      projectsByRoot.set(root, project);
    }
    const discoveredProjects = [...projectsByRoot.values()]
      .map((project) => ({
        ...project,
        sessionIds: uniqueStrings(project.sessionIds)
      }))
      .sort((left, right) => left.root.localeCompare(right.root));
    const selectedRoots = uniquePaths(policy.selectedRoots, this.home);
    const oneTimeRoots = [...this.oneTimeRoots.keys()];
    let effectiveRoots = [...this.baseRoots, ...selectedRoots, ...oneTimeRoots];
    if (policy.scope === "registered-projects") {
      effectiveRoots.push(...discoveredProjects.map((project) => project.root));
    } else if (policy.scope === "home") {
      effectiveRoots.push(this.home);
    }
    effectiveRoots = uniquePaths(effectiveRoots, this.home);
    const exceptions = uniquePaths(policy.sensitiveExceptions, this.home);
    const isSensitive = (path) => this.sensitiveRoots.some((root) =>
      pathInsideDeviceRoot(path, root, this.home)
      && !exceptions.some((exception) =>
        pathInsideDeviceRoot(path, exception, this.home)
      )
      && !oneTimeRoots.some((rootValue) =>
        pathInsideDeviceRoot(path, rootValue, this.home)
      )
    );
    const allowedTerminalSessionIds = sessions
      .filter((session) =>
        effectiveRoots.some((root) =>
          pathInsideDeviceRoot(session.cwd, root, this.home)
        )
        && !isSensitive(session.cwd)
      )
      .map((session) => session.id);
    return {
      policy,
      effectiveRoots,
      sensitiveRoots: [...this.sensitiveRoots],
      discoveredProjects,
      sessions,
      allowedTerminalSessionIds,
      pendingRequests: policy.requests.filter((request) =>
        request.status === "pending"
      )
    };
  }

  async updatePolicy(patch = {}) {
    const next = {};
    if (Object.hasOwn(patch, "scope")) {
      if (!SCOPE_SET.has(String(patch.scope))) {
        const error = new Error(`Unsupported Device access scope: ${patch.scope}`);
        error.statusCode = 400;
        throw error;
      }
      next.scope = String(patch.scope);
    }
    if (Object.hasOwn(patch, "permissions")) {
      if (!patch.permissions || typeof patch.permissions !== "object") {
        const error = new Error("Device access permissions must be an object");
        error.statusCode = 400;
        throw error;
      }
      next.permissions = Object.fromEntries(
        ["read", "write", "execute"]
          .filter((permission) =>
            Object.hasOwn(patch.permissions, permission)
          )
          .map((permission) => [
            permission,
            patch.permissions[permission] === true
          ])
      );
    }
    if (Object.hasOwn(patch, "selectedRoots")) {
      const values = Array.isArray(patch.selectedRoots) ? patch.selectedRoots : [];
      if (values.some((value) => !normalizeDevicePath(value, this.home))) {
        const error = new Error("Device access roots must be absolute paths or start with ~/");
        error.statusCode = 400;
        throw error;
      }
      const normalized = uniquePaths(values, this.home);
      next.selectedRoots = normalized;
    }
    if (Object.hasOwn(patch, "sensitiveExceptions")) {
      const values = Array.isArray(patch.sensitiveExceptions)
        ? patch.sensitiveExceptions
        : [];
      if (values.some((value) => !normalizeDevicePath(value, this.home))) {
        const error = new Error("Sensitive exceptions must be absolute paths or start with ~/");
        error.statusCode = 400;
        throw error;
      }
      next.sensitiveExceptions = uniquePaths(values, this.home);
    }
    this.store.update(next);
    return await this.state({ force: true });
  }

  async authorizeInvocation(invocation = {}) {
    const state = await this.state();
    const toolName = String(invocation.toolCall?.name || "");
    const args = invocation.toolCall?.arguments || {};
    const permission = toolPermission(toolName, args);
    if (permission && state.policy.permissions[permission] !== true) {
      const error = new Error(
        `Device ${permission} access is disabled by Owner policy`
      );
      error.code = "DEVICE_ACCESS_DISABLED";
      throw error;
    }

    const requestedSessionId = String(args.session_id || "").trim();
    const requestedSession = state.sessions.find(
      (session) => session.id === requestedSessionId
    );
    const rawPath = String(pathForTool(toolName, args) || "").trim();
    const requestedPath = normalizeDevicePath(rawPath, this.home)
      || (rawPath && requestedSession?.cwd
        ? normalizeDevicePath(resolve(requestedSession.cwd, rawPath), this.home)
        : !rawPath && requestedSession?.cwd && (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName))
          ? requestedSession.cwd
          : "");
    if (rawPath && !requestedPath) {
      const error = new Error(
        "Relative Device paths require an authorized terminal session_id"
      );
      error.code = "DEVICE_ACCESS_PATH_AMBIGUOUS";
      throw error;
    }
    if (requestedPath) setPathForTool(toolName, args, requestedPath);
    let oneTimeRootForInvocation = "";
    if (requestedPath) {
      const matchingOneTimeRoot = [...this.oneTimeRoots.keys()].find((root) =>
        pathInsideDeviceRoot(requestedPath, root, this.home)
      );
      const insideScope = state.effectiveRoots.some((root) =>
        pathInsideDeviceRoot(requestedPath, root, this.home)
      ) || !!matchingOneTimeRoot;
      const sensitive = state.sensitiveRoots.some((root) =>
        pathInsideDeviceRoot(requestedPath, root, this.home)
      );
      const sensitiveException = state.policy.sensitiveExceptions.some((root) =>
        pathInsideDeviceRoot(requestedPath, root, this.home)
      ) || !!matchingOneTimeRoot;
      if (!insideScope || (sensitive && !sensitiveException)) {
        const request = this.recordDenied({
          tool: toolName,
          permission: permission || "read",
          path: requestedPath,
          reason: sensitive && !sensitiveException
            ? "sensitive-path"
            : "outside-scope"
        });
        throw this.approvalError(
          request,
          sensitive && !sensitiveException
            ? "sensitive path requires Owner approval"
            : `path is outside the active ${state.policy.scope} scope`
        );
      }
      if (matchingOneTimeRoot) {
        oneTimeRootForInvocation = matchingOneTimeRoot;
        this.oneTimeRoots.delete(matchingOneTimeRoot);
      }
    }

    if (
      requestedSessionId
      && !state.allowedTerminalSessionIds.includes(requestedSessionId)
    ) {
      const request = this.recordDenied({
        tool: toolName,
        permission: permission || "execute",
        path: requestedSession?.cwd || "",
        reason: "session-outside-scope"
      });
      throw this.approvalError(request, "terminal session is outside the active Device scope");
    }

    return {
      fileRoots: uniquePaths([
        ...state.effectiveRoots,
        oneTimeRootForInvocation,
        ...this.oneTimeRoots.keys()
      ], this.home),
      allowedTerminalSessionIds: state.allowedTerminalSessionIds
    };
  }

  recordDenied({ tool, permission, path, reason }) {
    const normalized = normalizeDevicePath(path, this.home);
    const suggestedRoot = normalized
      ? (() => {
          try {
            return this.exists(normalized) && this.stat(normalized).isDirectory()
              ? normalized
              : dirname(normalized);
          } catch {
            return dirname(normalized);
          }
        })()
      : "";
    return this.store.recordRequest({
      tool,
      permission,
      path: normalized,
      reason,
      suggestedRoot,
      projectRoot: suggestedRoot ? this.projectRoot(suggestedRoot) : ""
    });
  }

  approvalError(request, detail) {
    const error = new Error(
      `Device access approval required${request?.id ? ` (${request.id})` : ""}: ${detail}`
    );
    error.code = "DEVICE_ACCESS_APPROVAL_REQUIRED";
    error.requestId = request?.id || "";
    return error;
  }

  async approveRequest(id, { scope = "project" } = {}) {
    const policy = this.store.get();
    const request = policy.requests.find((item) =>
      item.id === String(id) && item.status === "pending"
    );
    if (!request) {
      const error = new Error("Device access request not found");
      error.statusCode = 404;
      throw error;
    }
    const root = scope === "project"
      ? request.projectRoot || request.suggestedRoot
      : request.suggestedRoot || request.path;
    if (!root) {
      const error = new Error("Device access request has no approvable path");
      error.statusCode = 422;
      throw error;
    }
    if (scope === "once") {
      this.oneTimeRoots.set(root, { requestId: request.id });
      this.store.resolveRequest(request.id, "approved-once");
    } else {
      const sensitive = this.sensitiveRoots.some((item) =>
        pathInsideDeviceRoot(root, item, this.home)
      );
      this.store.update({
        selectedRoots: uniquePaths([...policy.selectedRoots, root], this.home),
        ...(sensitive
          ? {
              sensitiveExceptions: uniquePaths([
                ...policy.sensitiveExceptions,
                root
              ], this.home)
            }
          : {})
      });
      this.store.resolveRequest(request.id, "approved");
    }
    return await this.state({ force: true });
  }

  async rejectRequest(id) {
    const request = this.store.resolveRequest(String(id), "rejected");
    if (!request) {
      const error = new Error("Device access request not found");
      error.statusCode = 404;
      throw error;
    }
    return await this.state();
  }

  async handleRequest({ method = "GET", path = "/", body = {} } = {}) {
    const pathname = new URL(path, "http://device.invalid").pathname;
    if (method === "GET" && pathname === "/policy") {
      return { status: 200, body: await this.state({ force: true }) };
    }
    if (method === "PATCH" && pathname === "/policy") {
      return { status: 200, body: await this.updatePolicy(body) };
    }
    if (method === "POST" && pathname === "/refresh") {
      return { status: 200, body: await this.state({ force: true }) };
    }
    const approve = pathname.match(/^\/requests\/([^/]+)\/approve$/);
    if (method === "POST" && approve) {
      return {
        status: 200,
        body: await this.approveRequest(decodeURIComponent(approve[1]), body)
      };
    }
    const reject = pathname.match(/^\/requests\/([^/]+)\/reject$/);
    if (method === "POST" && reject) {
      return {
        status: 200,
        body: await this.rejectRequest(decodeURIComponent(reject[1]))
      };
    }
    const error = new Error(`Device access endpoint not found: ${method} ${pathname}`);
    error.statusCode = 404;
    throw error;
  }
}
