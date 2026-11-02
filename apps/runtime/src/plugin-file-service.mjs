import { CancellationController } from "../../../packages/runtime/dist/index.js";
import { URLSearchParams } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  contentHash,
  mergeJsonlRecords
} from "../../../packages/local-tools-client/src/plugin-data-files.mjs";

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

function toolResultError(result, fallback) {
  const error = new Error(result?.error || result?.content || fallback);
  if (result?.failureCode) error.failureCode = result.failureCode;
  if (result?.failureCode === "sandbox_workspace_busy") error.statusCode = 409;
  if (typeof result?.retryable === "boolean") error.retryable = result.retryable;
  return error;
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
  authorizeRequest = null,
  serializeInvocations = false,
  busyWaitMs = 30_000,
  invocationPrefix = "plugin-file"
} = {}) {
  if (!toolHost?.invoke && !fileClient?.request) {
    throw new Error("Plugin file service requires a tool host or file API client");
  }
  // An account-aware adapter authorizes the individual leaf path below. Its
  // root may be a common container for several separately allowed files.
  const requestRoot = (root, policy) => assertRootAllowed(root, authorizeRequest ? {} : policy);
  const invocationTails = new Map();

  function runContextForLocation(runContext, location) {
    if (runContext.target?.nodeId && runContext.target.nodeId !== location.nodeId) {
      throw new Error("Plugin data Node conflicts with the requested target");
    }
    return {
      ...runContext,
      ...(location.nodeId ? { target: { nodeId: location.nodeId } } : {})
    };
  }

  async function boundRequest(fileRoot, sessionId, runContext = {}, access = "read") {
    const resolved = typeof dataLocation === "function"
      ? await dataLocation(runContext, { access })
      : dataLocation;
    const binding = resolved?.data ? resolved : { data: resolved };
    const location = binding.data;
    if (!location) return { fileRoot, sessionId, runContext, readFallbacks: [] };
    const root = normalizePath(location.root);
    if (fileRoot && normalizePath(fileRoot) !== root) {
      throw new Error("file_root conflicts with the plugin data location");
    }
    if (sessionId || runContext.terminalSessionId
      || runContext.policy?.allowedTerminalSessionIds?.length) {
      throw new Error("Plugin data access cannot use a terminal-bound policy");
    }
    requestRoot(root, runContext.policy);
    const readFallbacks = access === "read"
      ? (binding.readFallbacks || []).map((fallback) => {
          const fallbackRoot = normalizePath(fallback.root);
          requestRoot(fallbackRoot, runContext.policy);
          return Object.freeze({
            root: fallbackRoot,
            runContext: runContextForLocation(runContext, fallback)
          });
        })
      : [];
    return {
      fileRoot: root,
      sessionId: "",
      runContext: runContextForLocation(runContext, location),
      readFallbacks
    };
  }

  async function requestFile(endpoint, { fileRoot, sessionId, runContext, body, query }) {
    const params = new URLSearchParams(query || "");
    const operation = { write: !!body, path: body?.path || params.get("path"), fileRoot };
    await authorizeRequest?.(runContext, operation);
    const root = requestRoot(fileRoot, runContext.policy);
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
    await authorizeRequest?.(runContext, operation);
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
    await authorizeRequest?.(
      runContext,
      { write: preset !== "read-only", path: args.path, fileRoot }
    );
    const root = requestRoot(fileRoot, runContext.policy);
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
    const signal = runContext.signal || cancellation.signal;
    const invocation = {
      invocationId: invocationId(invocationPrefix, toolName, key),
      runId: runContext.runId || `${invocationPrefix}:run`,
      attemptId: runContext.attemptId || `${invocationPrefix}:attempt`,
      sessionId: runContext.sessionId || "",
      projectId: runContext.projectId || "",
      ...(runContext.principal ? { principal: runContext.principal } : {}),
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
    };
    const execute = async () => {
      const deadline = Date.now() + busyWaitMs;
      for (;;) {
        signal.throwIfCancelled?.();
        await authorizeRequest?.(
          runContext,
          { write: preset !== "read-only", path: args.path, fileRoot }
        );
        const result = await toolHost.invoke(invocation, signal);
        if (!serializeInvocations
          || result?.failureCode !== "sandbox_workspace_busy"
          || result?.dispatched !== false
          || result?.retryable !== true
          || Date.now() >= deadline) return result;
        // The broker explicitly proves that this attempt never dispatched.
        // Unknown outcomes and all other failures must never be retried here.
        await delay(Math.min(250, Math.max(1, deadline - Date.now())));
      }
    };
    if (!serializeInvocations) return await execute();
    const principal = runContext.principal || {};
    const queueKey = JSON.stringify([
      principal.spaceId || principal.space?.id || "",
      principal.userId || principal.user?.id || "",
      invocation.target?.nodeId || root
    ]);
    const previous = invocationTails.get(queueKey) || Promise.resolve();
    const pending = previous.catch(() => {}).then(execute);
    const tail = pending.catch(() => {});
    invocationTails.set(queueKey, tail);
    try {
      return await pending;
    } finally {
      if (invocationTails.get(queueKey) === tail) invocationTails.delete(queueKey);
    }
  }

  async function readTextFileAt({
    root,
    relativePath,
    sessionId,
    runContext,
    key
  }) {
    const path = resolveRelativePath(root, relativePath);
    if (fileClient) {
      try {
        const payload = await requestFile("/files/read", {
          fileRoot: root,
          sessionId,
          runContext,
          query: new URLSearchParams({
            path,
            ...(sessionId ? { session_id: sessionId } : {})
          })
        });
        if (payload?.ok === false || payload?.error) {
          throw new Error(payload.error || "File read failed");
        }
        if (payload?.truncated || payload?.has_more) {
          throw new Error("Plugin file read was truncated");
        }
        const content = String(payload?.content || "");
        return {
          content,
          contentHash: String(payload?.content_hash || contentHash(content)),
          missing: false
        };
      } catch (error) {
        if (error.statusCode !== 404
          && !/\bENOENT\b|no such file/i.test(error.message)) {
          throw error;
        }
        return { content: "", missing: true };
      }
    }
    const result = await invokeTool("read", {
      path,
      session_id: sessionId,
      ...(dataLocation ? { _plugin_data: true } : {})
    }, {
      fileRoot: root,
      key,
      runContext,
      preset: "read-only"
    });
    if (!result?.ok) {
      if (isMissingFileError(result?.error || result?.content)) {
        return { content: "", missing: true };
      }
      throw toolResultError(result, `Failed to read ${path}`);
    }
    const parsed = parseToolContent(result);
    if (parsed?.truncated || parsed?.has_more) {
      throw new Error("Plugin file read was truncated");
    }
    const content = typeof parsed === "object" && parsed
      ? String(parsed.content || "")
      : String(parsed || "");
    return {
      content,
      contentHash: String(parsed?.content_hash || contentHash(content)),
      missing: false
    };
  }

  async function writeTextFileAt({
    root,
    relativePath,
    content,
    expectedHash,
    createOnly = false,
    sessionId,
    runContext,
    key
  }) {
    const path = resolveRelativePath(root, relativePath);
    if (fileClient) {
      const result = await requestFile("/files/write", {
        fileRoot: root,
        sessionId,
        runContext,
        body: {
          path,
          content: String(content),
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(expectedHash !== undefined ? { expected_hash: expectedHash } : {}),
          ...(createOnly ? { create_only: true } : {})
        }
      });
      if (result?.ok === false || result?.error) {
        throw new Error(result.error || `Failed to write ${path}`);
      }
      return {
        path,
        contentHash: String(result?.content_hash || contentHash(String(content))),
        written: result?.written !== false,
        created: result?.created
      };
    }
    const result = await invokeTool("write", {
      path,
      content: String(content),
      session_id: sessionId,
      ...(dataLocation ? { _plugin_data: true } : {}),
      ...(expectedHash !== undefined ? { expected_hash: expectedHash } : {}),
      ...(createOnly ? { create_only: true } : {})
    }, {
      fileRoot: root,
      key,
      runContext,
      preset: "workspace-write"
    });
    if (!result?.ok) {
      throw toolResultError(result, `Failed to write ${path}`);
    }
    const payload = parseToolContent(result);
    return {
      path,
      contentHash: String(payload?.content_hash || contentHash(String(content))),
      written: payload?.written !== false,
      created: payload?.created
    };
  }

  async function listEntriesAt({
    root,
    relativePath,
    sessionId,
    runContext,
    key
  }) {
    const path = resolveRelativePath(root, relativePath);
    if (fileClient) {
      try {
        const payload = await requestFile("/files/entries", {
          fileRoot: root,
          sessionId,
          runContext,
          query: new URLSearchParams({
            path,
            ...(sessionId ? { session_id: sessionId } : {})
          })
        });
        if (payload?.ok === false || payload?.error) {
          throw new Error(payload.error || "Directory read failed");
        }
        return {
          path,
          entries: Array.isArray(payload?.entries)
            ? payload.entries
            : Array.isArray(payload?.results)
              ? payload.results
              : [],
          missing: false
        };
      } catch (error) {
        if (error.statusCode !== 404
          && !/\bENOENT\b|no such file/i.test(error.message)) {
          throw error;
        }
        return { path, entries: [], missing: true };
      }
    }
    const result = await invokeTool("tree", {
      path,
      max_depth: 1,
      session_id: sessionId,
      ...(dataLocation ? {
        _plugin_data: true,
        _plugin_entries: true
      } : {})
    }, {
      fileRoot: root,
      key,
      runContext,
      preset: "read-only"
    });
    if (!result?.ok) {
      if (isMissingFileError(result?.error || result?.content)) {
        return { path, entries: [], missing: true };
      }
      throw toolResultError(result, `Failed to list ${path}`);
    }
    const payload = parseToolContent(result);
    const entries = Array.isArray(payload?.entries)
      ? payload.entries
      : Array.isArray(payload?.results)
        ? payload.results
        : [];
    return { path, entries, missing: false };
  }

  return Object.freeze({
    resolvePath: resolveRelativePath,
    async readTextFile({
      fileRoot,
      relativePath,
      sessionId = "",
      runContext = {}
    } = {}) {
      let readFallbacks;
      ({ fileRoot, sessionId, runContext, readFallbacks } =
        await boundRequest(fileRoot, sessionId, runContext, "read"));
      const root = requestRoot(fileRoot, runContext.policy);
      let loaded = { content: "", missing: true };
      let resolvedRoot = root;
      for (const candidate of [
        { root, runContext },
        ...readFallbacks
      ]) {
        loaded = await readTextFileAt({
          root: candidate.root,
          relativePath,
          sessionId,
          runContext: candidate.runContext,
          key: relativePath
        });
        resolvedRoot = candidate.root;
        if (!loaded.missing) break;
      }
      return {
        fileRoot: root,
        path: resolveRelativePath(resolvedRoot, relativePath),
        content: loaded.content,
        contentHash: loaded.contentHash,
        missing: loaded.missing
      };
    },
    async readTextFiles({
      fileRoot,
      files = {},
      sessionId = "",
      runContext = {}
    } = {}) {
      let readFallbacks;
      ({ fileRoot, sessionId, runContext, readFallbacks } =
        await boundRequest(fileRoot, sessionId, runContext, "read"));
      const root = requestRoot(fileRoot, runContext.policy);
      const out = {};
      const missing = [];
      for (const [key, relativePath] of Object.entries(files || {})) {
        const candidates = [
          { root, runContext },
          ...readFallbacks
        ];
        let loaded = { content: "", missing: true };
        for (const candidate of candidates) {
          loaded = await readTextFileAt({
            root: candidate.root,
            relativePath,
            sessionId,
            runContext: candidate.runContext,
            key
          });
          if (!loaded.missing) break;
        }
        out[key] = loaded.content;
        if (loaded.missing) missing.push(key);
      }
      return {
        fileRoot: root,
        files: out,
        ...(fileClient || dataLocation ? { missing } : {})
      };
    },
    async writeTextFile({
      fileRoot,
      relativePath,
      content,
      expectedHash,
      createOnly = false,
      sessionId = "",
      runContext = {}
    } = {}) {
      ({ fileRoot, sessionId, runContext } =
        await boundRequest(fileRoot, sessionId, runContext, "write"));
      const root = requestRoot(fileRoot, runContext.policy);
      const written = await writeTextFileAt({
        root,
        relativePath,
        content,
        expectedHash,
        createOnly,
        sessionId,
        runContext,
        key: relativePath
      });
      return { fileRoot: root, ...written };
    },
    async writeTextFiles({
      fileRoot,
      files = {},
      sessionId = "",
      runContext = {}
    } = {}) {
      ({ fileRoot, sessionId, runContext } =
        await boundRequest(fileRoot, sessionId, runContext, "write"));
      const root = requestRoot(fileRoot, runContext.policy);
      const written = [];
      for (const [key, spec] of Object.entries(files || {})) {
        const relativePath = typeof spec === "string" ? key : spec?.relativePath;
        const content = typeof spec === "string" ? spec : spec?.content;
        if (content == null) continue;
        const result = await writeTextFileAt({
          root,
          relativePath,
          content,
          expectedHash: spec?.expected_hash,
          createOnly: spec?.create_only,
          sessionId,
          runContext,
          key,
        });
        written.push({ key, path: result.path });
      }
      return {
        fileRoot: root,
        written
      };
    },
    async listEntries({
      fileRoot,
      relativePath = ".",
      sessionId = "",
      runContext = {}
    } = {}) {
      let readFallbacks;
      ({ fileRoot, sessionId, runContext, readFallbacks } =
        await boundRequest(fileRoot, sessionId, runContext, "read"));
      const root = requestRoot(fileRoot, runContext.policy);
      let loaded = { entries: [], missing: true };
      for (const candidate of [
        { root, runContext },
        ...readFallbacks
      ]) {
        loaded = await listEntriesAt({
          root: candidate.root,
          relativePath,
          sessionId,
          runContext: candidate.runContext,
          key: relativePath
        });
        if (!loaded.missing) break;
      }
      return {
        fileRoot: root,
        path: loaded.path || resolveRelativePath(root, relativePath),
        entries: loaded.entries,
        missing: loaded.missing
      };
    },
    async readJsonlPage({
      fileRoot,
      relativePath,
      offset = 1,
      limit = 80,
      tail = 0,
      sessionId = "",
      runContext = {}
    } = {}) {
      const loaded = await this.readTextFile({
        fileRoot,
        relativePath,
        sessionId,
        runContext
      });
      if (loaded.missing) return { ...loaded, content: "" };
      const lines = loaded.content.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const pageLimit = Math.max(1, Math.min(1000, Number(limit) || 80));
      const tailCount = Math.max(0, Number(tail) || 0);
      const start = tailCount
        ? Math.max(0, lines.length - Math.min(pageLimit, tailCount))
        : Math.max(0, (Number(offset) || 1) - 1);
      const end = Math.min(lines.length, start + pageLimit);
      return {
        ...loaded,
        content: lines.slice(start, end).join("\n"),
        startLine: start + 1,
        endLine: end,
        previousOffset: Math.max(1, start - pageLimit + 1),
        hasPrevious: start > 0,
        hasMore: end < lines.length
      };
    },
    async appendJsonl({ fileRoot, relativePath, records, sessionId = "", runContext = {} }) {
      ({ fileRoot, sessionId, runContext } =
        await boundRequest(fileRoot, sessionId, runContext, "write"));
      const path = resolveRelativePath(fileRoot, relativePath);
      if (fileClient) {
        const result = await requestFile("/files/append-jsonl", {
          fileRoot, sessionId, runContext,
          body: {
            path,
            records,
            dedupe_field: "id",
            ...(sessionId ? { session_id: sessionId } : {})
          }
        });
        if (result?.ok === false || result?.error) {
          throw new Error(result.error || "JSONL append failed");
        }
        return result;
      }

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const loaded = await readTextFileAt({
          root: fileRoot,
          relativePath,
          sessionId,
          runContext,
          key: `append:${attempt}`
        });
        const update = mergeJsonlRecords(
          loaded.missing ? "" : loaded.content,
          records,
          "id"
        );
        if (!update.appended.length) {
          return {
            ok: true,
            plugin_data_version: 1,
            appended: [],
            skipped: update.skipped
          };
        }
        const result = await invokeTool("write", {
          path,
          content: update.content,
          session_id: sessionId,
          _plugin_data: true,
          ...(loaded.missing
            ? { create_only: true }
            : { expected_hash: loaded.contentHash })
        }, {
          fileRoot,
          key: `append:${attempt}`,
          runContext,
          preset: "workspace-write"
        });
        const payload = parseToolContent(result);
        if (result?.ok && payload?.written !== false) {
          return {
            ok: true,
            plugin_data_version: 1,
            appended: update.appended,
            skipped: update.skipped
          };
        }
        const message = String(
          result?.error || result?.content || "JSONL append failed"
        );
        if (!/content_hash_conflict|changed since|created.?false/i.test(message)
          && payload?.written !== false) {
          throw toolResultError(result, message);
        }
      }
      throw new Error("JSONL append conflicted repeatedly; retry after current writers finish");
    }
  });
}
