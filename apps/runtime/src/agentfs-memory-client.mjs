import { createMemoryDelegation } from "./accounts/memory-delegation.mjs";

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
    async request(endpoint, { method = "GET", body, runContext = {} }) {
      const input = new URL(endpoint, base);
      const operation = input.pathname.split("/").at(-1);
      if (!["read", "write", "entries", "append-jsonl"].includes(operation)) throw new Error("Invalid memory operation");
      const servicePath = `/zion/files/${operation}${input.search}`;
      const output = new URL(`zion/files/${operation}`, base);
      output.search = input.search;
      const data = body ? JSON.stringify(body) : "";
      const filePath = body?.path || input.searchParams.get("path");
      if (!(filePath === AGENTFS_MEMORY_ROOT || filePath?.startsWith(`${AGENTFS_MEMORY_ROOT}/`))
        || filePath.split("/").includes("..")) throw new Error("Invalid memory file path");
      const authorization = authorizationProvider
        ? await authorizationProvider({ runContext, method, path: servicePath, body: data, filePath, write: !!body })
        : `Bearer ${await createMemoryDelegation(secret, {
          context: runContext, method, path: servicePath, body: data, filePath, write: !!body
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
