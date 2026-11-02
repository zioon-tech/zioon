import { createHash, createHmac } from "node:crypto";
import { core, createApp, createMcpServer, WebStandardStreamableHTTPServerTransport, eq } from "./upstream.ts";
import { pluginFileOperation } from "./plugin-files.ts";
import { createAccountBindings } from "./account-bindings.ts";
import { AGENTFS_MCP_PREFIX, agentFsMcpEffect, agentFsMcpPaths } from "../../../packages/plugin-sdk/src/agentfs-mcp-policy.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const BLOCKED_TOOLS = new Set(["member-invite", "member-update-role", "member-remove", "share-create", "share-revoke", "signed-url"]);
const READ_OPS = new Set(["cat", "ls", "stat", "reveal", "tail", "log", "diff", "recent", "grep", "fts",
  "search", "vec-search", "tree", "glob", "find", "sql", "comment-list", "comment-get",
  "comment-notification-list", "drive-members", "favorite-list"]);
const READ_TOOLS = new Set([...READ_OPS, "health", "whoami", "profile-get", "member-list"]);

export function createMemoryGateway({ db, storage, runtimeUrl, secret, origins = [], fetchImpl = fetch,
  accountIssuer = "", adcOrigin = "" }) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("Memory bridge secret requires at least 32 bytes");
  const upstream = createApp(db, storage, null);
  const accounts = createAccountBindings(db, accountIssuer);
  const queues = new Map();
  let pending = 0;
  // Whole-account serialization includes reads so bytes and version metadata
  // stay consistent across API, CLI, MCP, raw uploads and JSONL appends.
  async function locked(key, action) {
    if (pending >= 16) throw Object.assign(new Error("memory_queue_full"), { statusCode: 429 });
    pending++;
    const previous = queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    queues.set(key, current);
    try { return await current; } finally {
      pending--;
      if (queues.get(key) === current) queues.delete(key);
    }
  }
  async function identity(request, body) {
    const authorization = request.headers.get("authorization") || "";
    if (accountIssuer && authorization.startsWith("Bearer zioon_at_")) {
      const response = await fetchImpl(`${accountIssuer}/userinfo`, {
        headers: { authorization }, redirect: "error", signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw Object.assign(new Error("account_authentication_failed"), {
        statusCode: response.status === 401 ? 401 : 503
      });
      const user = await response.json();
      if (!user.sub || user.iss !== accountIssuer) throw Object.assign(new Error("invalid_account_identity"), { statusCode: 401 });
      return { authenticated: true, user: { id: user.sub, name: user.name, email: user.email },
        space: { id: user.sub }, membership: { status: "active" },
        accountIdentity: { issuer: accountIssuer, subject: user.sub },
        scopes: String(user.scope || "").split(" ").flatMap((scope) =>
          scope === "memory.read" ? ["runtime.read"] : scope === "memory.write" ? ["runtime.write"] : []) };
    }
    const delegated = authorization.startsWith("Bearer zm_");
    const response = await fetchImpl(`${runtimeUrl}${delegated ? "/v1/account/memory/verify" : "/v1/account/me"}`, {
      method: delegated ? "POST" : "GET",
      headers: { authorization, ...(delegated ? { "content-type": "application/json" } : {}) },
      ...(delegated ? { body: JSON.stringify({
        method: request.method, path: new URL(request.url).pathname + new URL(request.url).search, bodyHash: hash(body),
        ...(new URL(request.url).pathname === "/mcp" ? (() => {
          const call = JSON.parse(new TextDecoder().decode(body));
          const effect = agentFsMcpEffect(call.params?.name);
          if (call.method !== "tools/call" || !effect) throw Object.assign(
            new Error("unsupported_delegated_mcp_request"), { statusCode: 403 });
          return { toolName: `${AGENTFS_MCP_PREFIX}${call.params.name}`,
            filePaths: agentFsMcpPaths(call.params.name, call.params.arguments),
            write: effect === "write" };
        })() : {})
      }) } : {}),
      redirect: "error", signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw Object.assign(new Error("Zion authentication or permission check failed"), {
      statusCode: response.status === 401 || response.status === 403 ? response.status : 503
    });
    const value = await response.json();
    if (!value.authenticated || !value.user?.id || !value.space?.id
      || value.membership?.status !== "active") throw Object.assign(new Error("Active Zion membership required"), { statusCode: 403 });
    return value;
  }
  function bind(value) {
    const { scope } = accounts.resolve(value);
    const email = `${hash(scope)}@zion.invalid`;
    let user = core.getUserByEmail(db, email);
    if (!user) user = db.transaction(() => core.createUser(db, { email }).user);
    const apiKey = `af_${createHmac("sha256", secret).update(scope).digest("hex")}`;
    db.update(core.schema.users).set({ apiKeyHash: hash(apiKey) }).where(eq(core.schema.users.id, user.id)).run();
    return { apiKey, userId: user.id, ...core.resolveContext(db, { userId: user.id }) };
  }
  async function dispatch(request) {
    const url = new URL(request.url);
    if (["/health", "/ready"].includes(url.pathname) && request.method === "GET") {
      db.$client.query("SELECT 1").get();
      if (url.pathname === "/ready") {
        await storage.listObjects("zion-memory-readiness/", { delimiter: "/" });
        const response = await fetchImpl(`${runtimeUrl}/v1/account/config`, { redirect: "error", signal: AbortSignal.timeout(5000) });
        if (!response.ok) return json({ ok: false, error: "identity_unavailable" }, 503);
        if (accountIssuer) {
          const account = await fetchImpl(`${accountIssuer}/.well-known/openid-configuration`, {
            redirect: "error", signal: AbortSignal.timeout(5000)
          });
          if (!account.ok || (await account.json()).issuer !== accountIssuer) return json({ ok: false, error: "account_unavailable" }, 503);
        }
      }
      return json({ ok: true, version: core.VERSION, storage: storage.constructor.name, embeddings: false,
        rssBytes: process.memoryUsage().rss, queuedAccounts: queues.size, pendingRequests: pending });
    }
    const origin = request.headers.get("origin");
    if (origin && !origins.includes(origin)) return json({ error: "invalid_origin" }, 403);
    // Bearer credentials only. Host-only Zion cookies remain on the Runtime;
    // its same-origin panel API delegates requests to this service.
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    if (url.pathname === "/mcp" && request.method === "GET") {
      return json({ error: "event_stream_disabled" }, 405);
    }
    const bytes = ["GET", "HEAD"].includes(request.method) ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > 5 * 1024 * 1024) return json({ error: "body_too_large" }, 413);
    const body = new TextDecoder().decode(bytes);
    let parsed;
    try { parsed = body ? JSON.parse(body) : {}; } catch {
      if (!url.pathname.endsWith("/raw")) return json({ error: "invalid_json" }, 400);
    }
    if (url.pathname === "/zion/accounts/link" && request.method === "POST" && accountIssuer && adcOrigin) {
      const response = await fetchImpl(`${adcOrigin}/api/v1/me`, {
        headers: { authorization: request.headers.get("authorization") || "" },
        redirect: "error", signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) return json({ error: "adc_login_required" }, response.status === 401 ? 401 : 503);
      const adc = await response.json();
      if (adc.kind !== "session" || !adc.user?.id) return json({ error: "adc_account_session_required" }, 403);
      if (!parsed.runtimeToken?.startsWith("zion_account_v1.")) return json({ error: "runtime_session_required" }, 400);
      const runtime = await identity(new Request(request.url, {
        headers: { authorization: `Bearer ${parsed.runtimeToken}` }
      }), new Uint8Array());
      if (!runtime.scopes?.includes("runtime.write")) return json({ error: "permission_denied" }, 403);
      if (pending) return json({ error: "memory_busy_retry_link" }, 409);
      return json(accounts.link({ accountIdentity: { issuer: accountIssuer, subject: adc.user.id } }, runtime));
    }
    if (url.pathname === "/mcp") {
      if (Array.isArray(parsed)) return json({ error: "mcp_batch_unsupported" }, 400);
      // Discovery uses the actual upstream MCP server. No account is created,
      // and no tool handler may execute through this public metadata route.
      if (!request.headers.get("authorization") && request.method === "POST"
        && ["initialize", "notifications/initialized", "tools/list"].includes(parsed?.method)) {
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined, enableJsonResponse: true
        });
        const server = createMcpServer({ db, s3: storage, embeddingProvider: null });
        try {
          await server.connect(transport);
          const result = await transport.handleRequest(request, { parsedBody: parsed });
          const content = await result.arrayBuffer();
          if (parsed.method === "tools/list" && result.ok) {
            const listing = JSON.parse(new TextDecoder().decode(content));
            if (listing.result?.tools) listing.result.tools = listing.result.tools.filter((tool) => !BLOCKED_TOOLS.has(tool.name));
            return json(listing, result.status);
          }
          return new Response(content.byteLength ? content : null, { status: result.status, headers: result.headers });
        } finally { await server.close(); }
      }
    }
    const value = await identity(request, bytes);
    let read = ["GET", "HEAD"].includes(request.method);
    const pluginOperation = url.pathname.match(/^\/zion\/files\/(read|write|entries|append-jsonl)$/)?.[1];
    if (pluginOperation) {
      read = ["read", "entries"].includes(pluginOperation);
      if (request.method !== (read ? "GET" : "POST")) return json({ error: "method_not_allowed" }, 405);
    }
    const isOps = /^\/orgs\/[^/]+\/ops$/.test(url.pathname) && request.method === "POST";
    if (isOps) {
      if (BLOCKED_TOOLS.has(parsed?.op)) return json({ error: "sharing_disabled" }, 403);
      read = READ_OPS.has(parsed?.op);
    }
    if (url.pathname === "/mcp") {
      if (Array.isArray(parsed)) return json({ error: "mcp_batch_unsupported" }, 400);
      if (parsed?.method === "tools/call") {
        if (BLOCKED_TOOLS.has(parsed.params?.name)) return json({ error: "account_management_disabled" }, 403);
        read = READ_TOOLS.has(parsed.params?.name);
      } else read = true;
    }
    if (!value.scopes?.includes(read ? "runtime.read" : "runtime.write")) return json({ error: "permission_denied" }, 403);
    const allowed = !!pluginOperation || url.pathname === "/mcp"
      || (url.pathname === "/auth/me" && request.method === "GET")
      || (url.pathname === "/auth/profile" && ["GET", "PATCH"].includes(request.method))
      || (url.pathname.startsWith("/orgs") && !url.pathname.endsWith("/events") && !url.pathname.includes("/presence") && (read || isOps
        || (/\/files\/.+\/raw$/.test(url.pathname) && request.method === "PUT")));
    if (!allowed || /\/(?:share|site)(?:\/|$)|\/reset-key|\/members\/|\/auth\/register/.test(url.pathname)) {
      return json({ error: "account_management_disabled" }, 403);
    }
    const key = accounts.resolve(value).scope;
    return locked(key, async () => {
      const binding = bind(value);
      if (url.pathname === "/auth/me") return json({
        userId: binding.userId, email: value.user.email, displayName: value.user.name,
        defaultOrgId: binding.orgId, defaultDriveId: binding.driveId
      });
      if (pluginOperation) {
        return json(await pluginFileOperation({ db, storage, binding }, pluginOperation,
          read ? Object.fromEntries(url.searchParams) : parsed));
      }
      const org = url.pathname.match(/^\/orgs\/([^/]+)/)?.[1];
      const drive = url.pathname.match(/\/drives\/([^/]+)/)?.[1];
      if ((org && decodeURIComponent(org) !== binding.orgId)
        || (drive && decodeURIComponent(drive) !== binding.driveId)
        || (parsed?.driveId && parsed.driveId !== binding.driveId)
        || (parsed?.drive_id && parsed.drive_id !== binding.driveId)) return json({ error: "not_found" }, 404);
      const headers = new Headers(request.headers);
      headers.delete("cookie");
      headers.delete("origin");
      headers.delete("content-length");
      headers.set("authorization", `Bearer ${binding.apiKey}`);
      const result = await upstream.fetch(new Request(request.url, {
        method: request.method, headers, ...(bytes.length ? { body: bytes } : {})
      }));
      // Buffer finite responses before releasing the lock. Long-lived event
      // streams are deliberately excluded from this first single-instance pilot.
      if (result.headers.get("content-type")?.includes("text/event-stream")) return json({ error: "event_stream_disabled" }, 403);
      let resultBody = await result.arrayBuffer();
      if (url.pathname === "/mcp" && parsed?.method === "tools/list" && result.ok) {
        const listing = JSON.parse(new TextDecoder().decode(resultBody));
        if (listing.result?.tools) listing.result.tools = listing.result.tools.filter((tool) => !BLOCKED_TOOLS.has(tool.name));
        resultBody = new TextEncoder().encode(JSON.stringify(listing));
      }
      const responseHeaders = new Headers(result.headers);
      responseHeaders.delete("content-length");
      for (const name of [...responseHeaders.keys()]) {
        if (name.startsWith("access-control-")) responseHeaders.delete(name);
      }
      responseHeaders.set("cache-control", "no-store");
      return new Response(resultBody, { status: result.status, headers: responseHeaders });
    });
  }
  return {
    async fetch(request) {
      try {
        const response = await dispatch(request);
        const origin = request.headers.get("origin");
        if (origin && origins.includes(origin)) {
          response.headers.set("access-control-allow-origin", origin);
          response.headers.set("access-control-allow-headers", "authorization, content-type, mcp-protocol-version");
          response.headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, OPTIONS");
          response.headers.set("vary", "Origin");
        }
        return response;
      } catch (error) {
        return json({ error: error.statusCode ? error.message : "memory_service_unavailable" }, error.statusCode || 503);
      }
    }
  };
}
