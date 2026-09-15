import { CancellationController } from "../../../packages/runtime/dist/index.js";
import { URLSearchParams } from "node:url";

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

function isAbsolutePath(value) {
  const text = String(value || "").trim().replaceAll("\\", "/");
  return text.startsWith("/") || /^[A-Za-z]:\//.test(text);
}

function isPathWithinRoot(pathValue, rootValue) {
  const path = normalizePath(pathValue);
  const root = normalizePath(rootValue);
  return !!root && (path === root || path.startsWith(`${root}/`));
}

function platformForPath(pathValue) {
  const path = normalizePath(pathValue);
  if (/^[A-Za-z]:\//.test(path)) return "win32";
  if (path === "/Users" || path.startsWith("/Users/")) return "darwin";
  if (/^\/(?:home|root|var|opt|etc|usr|srv)(?:\/|$)/.test(path)) return "linux";
  return "";
}

function assertRootAllowed(root, policy = {}) {
  const fileRoot = normalizePath(root);
  if (!isAbsolutePath(fileRoot)) {
    throw new Error("file_root must be an absolute path");
  }
  const parentRoots = Array.isArray(policy.fileRoots)
    ? policy.fileRoots.map(normalizePath).filter(Boolean)
    : [];
  if (
    parentRoots.length
    && !parentRoots.some((parentRoot) => isPathWithinRoot(fileRoot, parentRoot))
  ) {
    throw new Error("file_root is outside allowed Runtime policy roots");
  }
  return fileRoot;
}

function resolveRelativePath(root, relativePath) {
  const rel = String(relativePath || "").trim().replaceAll("\\", "/");
  if (!rel || rel.startsWith("/") || /^[A-Za-z]:\//.test(rel)) {
    throw new Error(`relative file path is invalid: ${relativePath}`);
  }
  if (rel.split("/").some((part) => part === "..")) {
    throw new Error(`relative file path escapes file_root: ${relativePath}`);
  }
  const resolved = normalizePath(`${root}/${rel}`);
  if (!isPathWithinRoot(resolved, root)) {
    throw new Error(`file path escapes file_root: ${relativePath}`);
  }
  return resolved;
}

function parseToolContent(result) {
  const content = String(result?.content || "");
  if (!content.trim()) return null;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function isMissingFileError(error) {
  return /no such file|not found|enoent|404/i.test(String(error || ""));
}

function invocationId(prefix, toolName, key) {
  return [
    prefix,
    toolName,
    String(key || "file").replace(/[^a-zA-Z0-9_.:-]+/g, "-"),
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 8)
  ].join(":");
}

function targetRoots(target) {
  const resource = target?.resource || {};
  return [
    resource.root,
    resource.path,
    ...(Array.isArray(resource.roots) ? resource.roots : [])
  ].map(normalizePath).filter(Boolean);
}

function selectTargetForFileRoot({ toolHost, toolName, fileRoot, runContext }) {
  if (runContext.target?.nodeId || runContext.target?.resourceId) {
    return null;
  }
  if (typeof toolHost?.registeredTargets !== "function") return null;
  let targets = toolHost.registeredTargets(runContext.projectId || "", toolName);
  if (typeof toolHost.isOnline === "function") {
    const online = targets.filter(({ node }) => toolHost.isOnline(node));
    if (online.length) targets = online;
  }
  if (targets.length <= 1) return null;

  const root = normalizePath(fileRoot);
  const rootMatches = targets.filter((target) =>
    targetRoots(target).some((candidate) =>
      isPathWithinRoot(root, candidate) || isPathWithinRoot(candidate, root)
    )
  );
  if (rootMatches.length === 1) {
    const target = rootMatches[0];
    return {
      nodeId: target.node.registration.nodeId,
      instanceId: target.node.registration.instanceId,
      resourceId: target.resource?.resourceId
    };
  }

  const platform = platformForPath(root);
  if (!platform) return null;
  const platformMatches = targets.filter((target) =>
    String(target.node.registration.platform || "") === platform
  );
  if (platformMatches.length !== 1) return null;
  const target = platformMatches[0];
  return {
    nodeId: target.node.registration.nodeId,
    instanceId: target.node.registration.instanceId,
    resourceId: target.resource?.resourceId
  };
}

export function createPluginFileService({
  toolHost,
  dataLocation = null,
  fileClient = null,
  invocationPrefix = "plugin-file"
} = {}) {
  if (!toolHost?.invoke) {
    throw new Error("Plugin file service requires a tool host");
  }

  function boundRequest(fileRoot, sessionId, runContext = {}) {
    const location = typeof dataLocation === "function" ? dataLocation() : dataLocation;
    if (!location) return { fileRoot, sessionId, runContext };
    const root = normalizePath(location.root);
    if (fileRoot && normalizePath(fileRoot) !== root) {
      throw new Error("file_root conflicts with the plugin data location");
    }
    if (sessionId || runContext.terminalSessionId
      || runContext.policy?.allowedTerminalSessionIds?.length) {
      throw new Error("Plugin data access cannot use a terminal-bound policy");
    }
    if (runContext.target?.nodeId && runContext.target.nodeId !== location.nodeId) {
      throw new Error("Plugin data Node conflicts with the requested target");
    }
    assertRootAllowed(root, runContext.policy);
    return {
      fileRoot: root,
      sessionId: "",
      runContext: {
        ...runContext,
        ...(location.nodeId ? { target: { nodeId: location.nodeId } } : {})
      }
    };
  }

  async function requestFile(endpoint, { fileRoot, sessionId, runContext, body, query }) {
    const root = assertRootAllowed(fileRoot, runContext.policy);
    const params = new URLSearchParams(query || "");
    if (dataLocation) params.set("plugin_data_version", "1");
    const payload = await fileClient.request(`${endpoint}?${params}`, {
      method: body ? "POST" : "GET",
      body,
      runContext: {
        ...runContext,
        policy: {
          ...runContext.policy,
          preset: body ? "workspace-write" : "read-only",
          fileRoots: [root],
          allowedTerminalSessionIds: sessionId ? [sessionId] : []
        }
      }
    });
    if (dataLocation && payload?.plugin_data_version !== 1) {
      throw new Error("Plugin data file adapter is unavailable; update the data Node Connector");
    }
    return payload;
  }

  async function invokeTool(toolName, args, {
    fileRoot,
    key,
    runContext = {},
    preset = "read-only"
  }) {
    const root = assertRootAllowed(fileRoot, runContext.policy);
    const parentSessionIds = [...new Set(
      Array.isArray(runContext.policy?.allowedTerminalSessionIds)
        ? runContext.policy.allowedTerminalSessionIds.map(String).filter(Boolean)
        : []
    )];
    let sessionId = String(
      args.session_id || runContext.terminalSessionId || ""
    ).trim();
    if (!sessionId && parentSessionIds.length === 1) {
      [sessionId] = parentSessionIds;
    }
    if (parentSessionIds.length) {
      if (!sessionId) {
        throw new Error("session_id is required when the Runtime policy permits multiple terminals");
      }
      if (!parentSessionIds.includes(sessionId)) {
        throw new Error("terminal session is outside the allowed Runtime policy");
      }
    }
    const policy = {
      preset,
      allowedTools: [toolName],
      fileRoots: [root],
      allowedTerminalSessionIds: sessionId ? [sessionId] : [],
      allowedCommandPrefixes: [],
      allowedRecipients: [],
      maxMailPerRun: 0,
      maxToolCalls: 100
    };
    const target = sessionId ? null : selectTargetForFileRoot({
      toolHost,
      toolName,
      fileRoot: root,
      runContext
    });
    const cancellation = new CancellationController();
    return await toolHost.invoke({
      invocationId: invocationId(invocationPrefix, toolName, key),
      runId: runContext.runId || `${invocationPrefix}:run`,
      attemptId: runContext.attemptId || `${invocationPrefix}:attempt`,
      sessionId: runContext.sessionId || "",
      projectId: runContext.projectId || "",
      ...(runContext.target || target ? {
        target: { ...(runContext.target || target) }
      } : {}),
      policy,
      toolCall: {
        id: invocationId(invocationPrefix, `${toolName}-call`, key),
        name: toolName,
        arguments: {
          ...args,
          ...(sessionId ? { session_id: sessionId } : {})
        }
      }
    }, runContext.signal || cancellation.signal);
  }

  return Object.freeze({
    resolvePath: resolveRelativePath,
    async readTextFiles({
      fileRoot,
      files = {},
      sessionId = "",
      runContext = {}
    } = {}) {
      ({ fileRoot, sessionId, runContext } = boundRequest(fileRoot, sessionId, runContext));
      const root = assertRootAllowed(fileRoot, runContext.policy);
      const out = {};
      const missing = [];
      for (const [key, relativePath] of Object.entries(files || {})) {
        const path = resolveRelativePath(root, relativePath);
        if (fileClient) {
          try {
            const payload = await requestFile("/files/read", {
              fileRoot, sessionId, runContext,
              query: new URLSearchParams({ path, ...(sessionId ? { session_id: sessionId } : {}) })
            });
            if (payload?.ok === false || payload?.error) throw new Error(payload.error || "File read failed");
            if (payload?.truncated || payload?.has_more) throw new Error("Plugin file read was truncated");
            out[key] = String(payload?.content || "");
          } catch (error) {
            if (error.statusCode !== 404 && !/\bENOENT\b|no such file/i.test(error.message)) throw error;
            out[key] = "";
            missing.push(key);
          }
          continue;
        }
        const result = await invokeTool("read", {
          path,
          session_id: sessionId
        }, {
          fileRoot: root,
          key,
          runContext,
          preset: "read-only"
        });
        if (!result?.ok) {
          if (isMissingFileError(result?.error || result?.content)) {
            out[key] = "";
            continue;
          }
          throw new Error(result?.error || result?.content || `Failed to read ${path}`);
        }
        const parsed = parseToolContent(result);
        out[key] = typeof parsed === "object" && parsed
          ? String(parsed.content || "")
          : String(parsed || "");
      }
      return {
        fileRoot: root,
        files: out,
        ...(fileClient ? { missing } : {})
      };
    },
    async writeTextFiles({
      fileRoot,
      files = {},
      sessionId = "",
      runContext = {}
    } = {}) {
      ({ fileRoot, sessionId, runContext } = boundRequest(fileRoot, sessionId, runContext));
      const root = assertRootAllowed(fileRoot, runContext.policy);
      const written = [];
      for (const [key, spec] of Object.entries(files || {})) {
        const relativePath = typeof spec === "string" ? key : spec?.relativePath;
        const content = typeof spec === "string" ? spec : spec?.content;
        if (content == null) continue;
        const path = resolveRelativePath(root, relativePath);
        if (fileClient) {
          const result = await requestFile("/files/write", {
            fileRoot, sessionId, runContext,
            body: {
              path, content: String(content),
              ...(sessionId ? { session_id: sessionId } : {}),
              ...(spec.expected_hash !== undefined ? { expected_hash: spec.expected_hash } : {}),
              ...(spec.create_only ? { create_only: true } : {})
            }
          });
          if (result?.ok === false || result?.error) throw new Error(result.error || `Failed to write ${path}`);
          written.push({ key, path });
          continue;
        }
        const result = await invokeTool("write", {
          path,
          content: String(content),
          session_id: sessionId
        }, {
          fileRoot: root,
          key,
          runContext,
          preset: "workspace-write"
        });
        if (!result?.ok) {
          throw new Error(result?.error || result?.content || `Failed to write ${path}`);
        }
        written.push({ key, path });
      }
      return {
        fileRoot: root,
        written
      };
    },
    async appendJsonl({ fileRoot, relativePath, records, sessionId = "", runContext = {} }) {
      if (!fileClient) throw new Error("Atomic JSONL append requires a file client");
      ({ fileRoot, sessionId, runContext } = boundRequest(fileRoot, sessionId, runContext));
      const result = await requestFile("/files/append-jsonl", {
        fileRoot, sessionId, runContext,
        body: {
          path: resolveRelativePath(fileRoot, relativePath),
          records, dedupe_field: "id",
          ...(sessionId ? { session_id: sessionId } : {})
        }
      });
      if (result?.ok === false || result?.error) throw new Error(result.error || "JSONL append failed");
      return result;
    }
  });
}
