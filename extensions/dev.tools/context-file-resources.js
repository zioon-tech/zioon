function text(value) {
  return String(value || "").trim();
}

function terminalSessionId(sourceId, activeSessionId = "") {
  const source = text(sourceId);
  if (source === "terminal:active") return text(activeSessionId);
  return source.startsWith("terminal:") ? source.slice("terminal:".length) : "";
}

function findTerminalSession(sourceId, sessions = [], activeSessionId = "") {
  const id = terminalSessionId(sourceId, activeSessionId);
  if (!id) return null;
  return (Array.isArray(sessions) ? sessions : []).find((session) => text(session?.id) === id) || null;
}

function isAbsolutePath(path) {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

function normalizePathSegments(path) {
  const value = text(path).replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!value) return "";
  const drive = /^[A-Za-z]:\//.test(value) ? value.slice(0, 2) : "";
  const absolute = value.startsWith("/") || !!drive;
  const body = drive ? value.slice(2) : value;
  const normalized = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (normalized.length && normalized[normalized.length - 1] !== "..") normalized.pop();
      else if (!absolute) normalized.push(part);
      continue;
    }
    normalized.push(part);
  }
  const joined = normalized.join("/");
  if (drive) return joined ? `${drive}/${joined}` : `${drive}/`;
  if (absolute) return joined ? `/${joined}` : "/";
  return joined || (value === "." ? "." : "");
}

function inferHomeDirectory(session) {
  const explicit = text(session?.home || session?.home_dir || session?.homeDirectory);
  if (explicit) return normalizePathSegments(explicit);
  const cwd = normalizePathSegments(session?.cwd || session?.initial_cwd);
  const match = cwd.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(?:\/|$)/);
  if (match) return match[1];
  if (cwd === "/root" || cwd.startsWith("/root/")) return "/root";
  return "";
}

export function normalizeContextResourcePath(path, {
  sourceId = "local",
  terminalSessions = [],
  activeSessionId = ""
} = {}) {
  const observedPath = text(path).replace(/:\d+(?::\d+)?$/, "").replace(/\\/g, "/");
  if (!observedPath) return { observedPath: "", canonicalPath: "", resolved: false };
  const session = findTerminalSession(sourceId, terminalSessions, activeSessionId);
  let candidate = observedPath;
  if (candidate === "~" || candidate.startsWith("~/")) {
    const home = inferHomeDirectory(session);
    if (home) candidate = candidate === "~" ? home : `${home}/${candidate.slice(2)}`;
  }
  if (!isAbsolutePath(candidate) && session) {
    const cwd = normalizePathSegments(session?.cwd || session?.initial_cwd);
    if (isAbsolutePath(cwd)) candidate = `${cwd}/${candidate}`;
  }
  const canonicalPath = normalizePathSegments(candidate);
  return {
    observedPath,
    canonicalPath,
    resolved: isAbsolutePath(canonicalPath)
  };
}

export function getContextResourceDeviceKey(sourceId, {
  terminalSessions = [],
  activeSessionId = ""
} = {}) {
  const source = text(sourceId) || "local";
  if (source === "local") return "local";
  const session = findTerminalSession(source, terminalSessions, activeSessionId);
  // Legacy terminal observations did not persist session metadata. Local is the
  // compatible default; new observations snapshot SSH metadata at execution time.
  if (!session) return "local";
  const type = text(session?.type).toLowerCase();
  const host = text(session?.ssh_host || session?.host || session?.hostname || session?.remote_host);
  const user = text(session?.ssh_user || session?.user || session?.username);
  const port = text(session?.ssh_port || session?.port) || "22";
  if (type === "ssh" || host) return `ssh:${user}@${host}:${port}`;
  return "local";
}

function preferResourceSource(current, candidate) {
  const currentTerminal = text(current?.sourceId).startsWith("terminal:");
  const candidateTerminal = text(candidate?.sourceId).startsWith("terminal:");
  if (candidateTerminal !== currentTerminal) return candidateTerminal ? candidate : current;
  return current;
}

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

export function createContextFileResource(item, options = {}) {
  const executionSession = item?.executionContext?.terminalSession;
  const terminalSessions = executionSession?.id
    ? [
        executionSession,
        ...(Array.isArray(options.terminalSessions) ? options.terminalSessions : [])
          .filter((session) => text(session?.id) !== text(executionSession.id))
      ]
    : options.terminalSessions;
  const effectiveOptions = { ...options, terminalSessions };
  const rawSourceId = text(item?.executionContext?.sourceId || item?.sourceId) || "local";
  const activeSessionId = text(options.activeSessionId);
  const sourceId = rawSourceId === "terminal:active" && activeSessionId
    ? `terminal:${activeSessionId}`
    : rawSourceId;
  const normalized = normalizeContextResourcePath(item?.path || item?.label, { ...effectiveOptions, sourceId });
  if (!normalized.canonicalPath) return null;
  const kind = item?.kind === "folder" || item?.kind === "directory" ? "folder" : "file";
  const deviceKey = getContextResourceDeviceKey(sourceId, effectiveOptions);
  const identityPath = normalized.resolved
    ? normalized.canonicalPath
    : `${sourceId}:${normalized.canonicalPath}`;
  const resourceKey = `${kind}:${deviceKey}:${identityPath}`;
  return {
    ...item,
    kind,
    path: normalized.canonicalPath,
    canonicalPath: normalized.canonicalPath,
    observedPath: normalized.observedPath,
    observedPaths: [normalized.observedPath],
    sourceId,
    sourceIds: [sourceId],
    sources: unique([item?.source]),
    deviceKey,
    resourceKey,
    pathResolved: normalized.resolved
  };
}

export function mergeContextFileResources(items, options = {}) {
  const merged = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const candidate = createContextFileResource(item, options);
    if (!candidate) continue;
    const current = merged.get(candidate.resourceKey);
    if (!current) {
      merged.set(candidate.resourceKey, candidate);
      continue;
    }
    const preferred = preferResourceSource(current, candidate);
    merged.set(candidate.resourceKey, {
      ...current,
      ...preferred,
      observedPaths: unique([...(current.observedPaths || []), ...(candidate.observedPaths || [])]),
      sourceIds: unique([...(current.sourceIds || []), ...(candidate.sourceIds || [])]),
      sources: unique([...(current.sources || []), ...(candidate.sources || [])]),
      resourceKey: current.resourceKey,
      canonicalPath: current.canonicalPath,
      path: current.canonicalPath,
      deviceKey: current.deviceKey,
      pathResolved: current.pathResolved || candidate.pathResolved
    });
  }
  return [...merged.values()];
}

export function getContextFileResourceKey(item, options = {}) {
  if (item?.resourceKey) return text(item.resourceKey);
  return createContextFileResource(item, options)?.resourceKey || "";
}

export function isKnownFileToolFailure(result) {
  if (result == null) return false;
  if (typeof result === "object") {
    if (result.ok === true || result.success === true) return false;
    if (result.ok === false || result.success === false) return true;
    if (result.error) return true;
    if (["error", "failed", "failure"].includes(text(result.status).toLowerCase())) return true;
  }
  const value = typeof result === "string" ? result : (() => {
    try { return JSON.stringify(result); } catch { return ""; }
  })();
  const head = text(value).slice(0, 320).toLowerCase();
  if (!head || head.startsWith("// file:")) return false;
  if (/^http\s+[45]\d\d\b/.test(head)) return true;
  if (/^(?:error|read error|write error|edit error|edit failed|write failed|write blocked|tool "[^"]+" (?:failed|error))\s*:/.test(head)) return true;
  if (/^(?:missing|invalid args|unknown tool)\b/.test(head)) return true;
  return /\b(?:enoent|no such file|permission denied|operation not permitted)\b/.test(head)
    || head.includes("execution aborted");
}
