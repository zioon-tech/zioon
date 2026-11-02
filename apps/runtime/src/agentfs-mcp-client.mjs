import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMemoryDelegation } from "./accounts/memory-delegation.mjs";
import {
  AGENTFS_MCP_PREFIX, agentFsMcpEffect, agentFsMcpPaths
} from "../../../packages/plugin-sdk/src/agentfs-mcp-policy.mjs";

export function createAgentFsMcpClient({ baseUrl, secret, fetchImpl = fetch }) {
  const endpoint = new URL("/mcp", baseUrl);
  if (endpoint.username || endpoint.password || (endpoint.protocol !== "https:"
    && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1"].includes(endpoint.hostname)))) {
    throw new Error("Memory MCP requires HTTPS or loopback");
  }
  let definitions = [];
  async function connected(action, { context, signal } = {}) {
    const abort = new AbortController();
    const subscription = signal?.onCancel((reason) => abort.abort(reason));
    const client = new Client({ name: "zion-agentfs", version: "1" });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      reconnectionOptions: { maxRetries: 0 },
      fetch: async (url, init = {}) => {
        const target = new URL(url);
        if (target.href !== endpoint.href) throw new Error("Unexpected MCP endpoint");
        const body = typeof init.body === "string" ? init.body : "";
        const request = body ? JSON.parse(body) : {};
        const headers = new Headers(init.headers);
        headers.delete("authorization");
        if (request.method === "tools/call") {
          const name = request.params?.name;
          const effect = agentFsMcpEffect(name);
          if (!context || !effect) throw new Error("MCP call requires an authorized Runtime context");
          const token = await createMemoryDelegation(secret, {
            context, method: init.method, path: endpoint.pathname,
            body, toolName: `${AGENTFS_MCP_PREFIX}${name}`,
            filePaths: agentFsMcpPaths(name, request.params.arguments), write: effect === "write"
          });
          headers.set("authorization", `Bearer ${token}`);
        }
        signal?.throwIfCancelled();
        const signals = [abort.signal, AbortSignal.timeout(30_000), init.signal].filter(Boolean);
        try {
          const response = await fetchImpl(target, {
            ...init, headers, redirect: "error", signal: AbortSignal.any(signals)
          });
          if (request.method === "tools/call" && response.status >= 500
            && agentFsMcpEffect(request.params.name) === "write") {
            await response.body?.cancel();
            throw Object.assign(new Error("Memory write outcome unknown; inspect the file before retrying"), {
              code: "execution_outcome_unknown"
            });
          }
          return response;
        } catch (cause) {
          if (request.method === "tools/call" && agentFsMcpEffect(request.params.name) === "write") {
            throw Object.assign(new Error("Memory write outcome unknown; inspect the file before retrying", { cause }), {
              code: "execution_outcome_unknown"
            });
          }
          throw cause;
        }
      }
    });
    try {
      signal?.throwIfCancelled();
      await client.connect(transport, { signal: abort.signal, timeout: 30_000 });
      return await action(client, abort.signal);
    } finally {
      subscription?.dispose();
      await client.close();
    }
  }
  return {
    async discover() {
      definitions = await connected(async (client) => {
        const tools = [];
        let cursor;
        do {
          const listing = await client.listTools(cursor ? { cursor } : {});
          tools.push(...listing.tools);
          cursor = listing.nextCursor;
        } while (cursor);
        return tools.filter((tool) => agentFsMcpEffect(tool.name)).map((tool) => ({
          name: `${AGENTFS_MCP_PREFIX}${tool.name}`,
          description: tool.description || tool.name,
          inputSchema: tool.inputSchema,
          execution: { effect: agentFsMcpEffect(tool.name) },
          policy: { minimumPreset: agentFsMcpEffect(tool.name) === "write" ? "workspace-write" : "read-only" }
        }));
      });
      if (!definitions.some((tool) => tool.name === `${AGENTFS_MCP_PREFIX}cat`)) {
        throw new Error("agent-fs MCP does not advertise its native cat tool");
      }
      return definitions;
    },
    getToolDefinitions() { return definitions; },
    async invoke(name, args, context = {}) {
      if (!definitions.some((tool) => tool.name === name)) throw new Error("Unknown agent-fs MCP tool");
      const nativeName = name.slice(AGENTFS_MCP_PREFIX.length);
      try {
        const result = await connected((client, signal) =>
          client.callTool({ name: nativeName, arguments: args }, undefined, { signal, timeout: 30_000 }),
        { context, signal: context.signal });
        const content = result.content.map((block) => block.type === "text" ? block.text : JSON.stringify(block)).join("\n");
        return { ok: !result.isError, content, ...(result.isError ? { error: content, retryable: false } : {}) };
      } catch (error) {
        if (error.code === "execution_outcome_unknown") return {
          ok: false, content: error.message, error: error.message,
          failureCode: error.code, retryable: false
        };
        throw error;
      }
    }
  };
}
