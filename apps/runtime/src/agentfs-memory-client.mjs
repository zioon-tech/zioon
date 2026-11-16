import { createMemoryDelegation } from "./accounts/memory-delegation.mjs";
import { createHash } from "node:crypto";

export const AGENTFS_MEMORY_ROOT = "/memory/dev.identity";
export function createAgentFsMemoryLocations(fallback, apiUrl, { accessMode = "mcp" } = {}) {
  return Object.freeze({
    ...fallback,
    scopeMode: "account",
    forPlugin(pluginId, context = {}, options) {
      if (pluginId !== "dev.identity") return fallback.forPlugin(pluginId, context, options);
      const principal = context.principal || context.request?.principal || context;
      const accountId = principal.userId || principal.user?.id;
      const spaceId = principal.spaceId || principal.space?.id;
      if (!accountId || !spaceId) throw Object.assign(new Error("Memory requires an authenticated Zion account"), { statusCode: 403 });
      return { data: { nodeId: "", root: AGENTFS_MEMORY_ROOT, backend: "agent-fs", apiUrl, accessMode },
        scope: { accountId, spaceId }, readFallbacks: [] };
    }
  });
}

export function createAgentFsMemoryClient({ baseUrl, secret, authorizationProvider, fetchImpl = fetch }) {
  const base = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
  if (base.username || base.password || base.search || base.hash
    || (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)))) {
    throw new Error("Memory service requires HTTPS or loopback");
  }
  return {
    async readTextFiles({ files, knownHashes = {}, metadataOnly = [], runContext }) {
      const entries = Object.entries(files);
      const query = new URLSearchParams({ files: JSON.stringify(entries.map(([key, path]) => ({
        path,
        ...(Object.hasOwn(knownHashes, key) ? { known_hash: knownHashes[key] } : {}),
        ...(metadataOnly.includes(key) ? { metadata_only: true } : {})
      }))) });
      let value;
      try {
        value = await this.request(`/files/read-batch?${query}`, { runContext });
      } catch (error) {
        // Only an absent protocol may fall back; authorization and IO failures
        // remain errors. Do not cache capability detection across requests.
        if (error.statusCode === 404 || error.statusCode === 403 && error.message === "account_management_disabled") return null;
        throw error;
      }
      if (value?.ok !== true || value.error || value.truncated || value.has_more
        || value.batch_version !== 1 || value.plugin_data_version !== 1
        || !Array.isArray(value.files) || value.files.length !== entries.length) {
        throw new Error("Invalid Memory batch response");
      }
      const contents = {}, hashes = {}, missing = [];
      value.files.forEach((item, index) => {
        const [key, path] = entries[index];
        if (item?.ok === false || item?.error || item?.truncated || item?.has_more
          || item?.path !== path || typeof item.missing !== "boolean"
          || (item.missing ? item.content_hash !== null : !/^[a-f0-9]{64}$/.test(item.content_hash))
          || item.content !== undefined && typeof item.content !== "string"
          || item.content !== undefined && !item.missing
            && createHash("sha256").update(item.content).digest("hex") !== item.content_hash
          || !item.missing && !metadataOnly.includes(key) && item.content === undefined
            && knownHashes[key] !== item.content_hash) throw new Error("Invalid Memory batch file");
        hashes[key] = item.content_hash;
        if (item.missing) { contents[key] = ""; missing.push(key); }
        else if (item.content !== undefined) contents[key] = item.content;
      });
      return { files: contents, hashes, missing, batchVersion: 1 };
    },
    async request(endpoint, { method = "GET", body, runContext = {} }) {
      const input = new URL(endpoint, base);
      const operation = input.pathname.split("/").at(-1);
      if (!["read", "read-batch", "write", "entries", "append-jsonl"].includes(operation)) throw new Error("Invalid memory operation");
      const servicePath = `/zion/files/${operation}${input.search}`;
      const output = new URL(`zion/files/${operation}`, base);
      output.search = input.search;
      const data = body ? JSON.stringify(body) : "";
      if (operation === "read-batch" && input.searchParams.getAll("files").length !== 1) {
        throw new Error("Invalid memory batch parameters");
      }
      const filePaths = operation === "read-batch"
        ? JSON.parse(input.searchParams.get("files") || "null")?.map(spec => spec.path)
        : [body?.path || input.searchParams.get("path")];
      if (!Array.isArray(filePaths) || !filePaths.length || filePaths.length > 32
        || filePaths.some(path => typeof path !== "string"
          || !(path === AGENTFS_MEMORY_ROOT || path.startsWith(`${AGENTFS_MEMORY_ROOT}/`))
          || path.split("/").some(part => part === ".." || part === ".") || /[\\\x00-\x1f]/.test(path))) {
        throw new Error("Invalid memory file path");
      }
      const filePath = operation === "read-batch" ? undefined : filePaths[0];
      const authorization = authorizationProvider
        ? await authorizationProvider({ runContext, method, path: servicePath, body: data, filePath, filePaths, write: !!body })
        : `Bearer ${await createMemoryDelegation(secret, {
          context: runContext, method, path: servicePath, body: data, filePath, filePaths, write: !!body
        })}`;
      let response;
      try {
        response = await fetchImpl(output, { method, redirect: "error",
          headers: { authorization, "content-type": "application/json" },
          ...(body ? { body: data } : {}), signal: AbortSignal.timeout(30_000) });
      } catch (cause) {
        throw Object.assign(new Error(body ? "Memory write outcome unknown; read the file before retrying" : "Memory service unavailable", { cause }), {
          statusCode: 503, code: body ? "execution_outcome_unknown" : "memory_service_unavailable"
        });
      }
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.message || value.error || "Memory operation failed"), {
        statusCode: response.status
      });
      return value;
    }
  };
}
