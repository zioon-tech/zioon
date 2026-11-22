import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { bearerToken, headerValue, readJson, json } from "../access-control.mjs";
import { accountError } from "./account-policy.mjs";
import { verifyMemoryRequestPayload } from "./memory-delegation.mjs";
import { contentSpaceId } from "../sharing/content-scope.mjs";

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const matches = (secret, digest) => {
  const left = Buffer.from(hash(secret), "hex"), right = Buffer.from(String(digest || ""), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Authenticated routing to independent Runtime service instances. They share
 * a Postgres pool, but never session caches, plugin state or Node authority. */
export class AccountRuntimeGateway {
  constructor({ platform, platformSpaceId, pool, createRuntime, provisioner,
    host = "127.0.0.1", port = 8766, idleMs = 300000, maxRuntimes = 32 }) {
    Object.assign(this, { platform, platformSpaceId, pool, createRuntime, provisioner,
      host, port, idleMs, maxRuntimes });
    this.instances = new Map([[platformSpaceId, {
      app: platform, requests: 0, lastUsed: Date.now()
    }]]);
    this.pending = new Map();
    this.retiring = new Map();
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
  }

  async instance(spaceId) {
    await this.retiring.get(spaceId);
    if (this.closing) throw accountError(503, "runtime_shutting_down");
    if (this.instances.has(spaceId)) return this.instances.get(spaceId);
    if (this.pending.has(spaceId)) return this.pending.get(spaceId);
    if (this.instances.size + this.pending.size >= this.maxRuntimes) {
      await this.evict(true);
      if (this.instances.has(spaceId)) return this.instances.get(spaceId);
      if (this.pending.has(spaceId)) return this.pending.get(spaceId);
      if (this.closing) throw accountError(503, "runtime_shutting_down");
      if (this.instances.size + this.pending.size >= this.maxRuntimes) {
        throw accountError(503, "runtime_capacity_busy");
      }
    }
    const promise = this.createRuntime(spaceId).then((app) => {
      const entry = { app, requests: 0, lastUsed: Date.now() };
      this.instances.set(spaceId, entry);
      return entry;
    }).finally(() => this.pending.delete(spaceId));
    this.pending.set(spaceId, promise);
    return promise;
  }

  async select(request) {
    const url = new URL(request.url || "/", "http://runtime.local");
    // Login transactions and the unified identity callback use the canonical
    // provider. Public static files do not need to initialize a user Runtime.
    if (!url.pathname.startsWith("/v1/") && url.pathname !== "/health"
      && !url.pathname.startsWith("/collaboration")) return this.instances.get(this.platformSpaceId);
    if (request.method === "GET" && url.pathname === "/v1/marketplace/public") {
      return this.instances.get(this.platformSpaceId);
    }
    if (url.pathname.startsWith("/v1/platform-admin/") || url.pathname === "/v1/status/incidents") {
      return this.instances.get(this.platformSpaceId);
    }
    if (/^\/v1\/(?:sharing(?:\/|$)|spaces(?:\/|$)|contacts(?:\/|$)|space-invitations\/|publications\/)/.test(url.pathname)) {
      return this.instances.get(this.platformSpaceId);
    }
    if (/^\/v1\/account\/(?:apps\/|login|callback|shared\/|device\/|token\/exchange|config|logout|sessions|spaces|me(?:\/|$))/.test(url.pathname)) {
      return this.instances.get(this.platformSpaceId);
    }
    if (request.method === "POST" && url.pathname === "/v1/account/memory/verify") {
      const access = this.platform.accessControl;
      if (!access.memoryBridgeSecret) throw accountError(404, "memory_bridge_disabled");
      const payload = await verifyMemoryRequestPayload(access.memoryBridgeSecret,
        bearerToken(request.headers), await readJson(request));
      const principal = payload.context?.principal;
      const spaceId = principal?.spaceId || principal?.space?.id;
      if (!spaceId) throw accountError(403, "memory_identity_required");
      if (principal.kind === "account") {
        if (!await access.accounts.activeSession(principal.sessionId, principal.user?.id)
          || (await access.accounts.membership(principal.user?.id, spaceId))?.status !== "active") {
          throw accountError(403, "memory_identity_required");
        }
      } else {
        await access.accounts.validateGrant(principal, payload.context?.policy);
      }
      return this.instance(principal.contentScope?.originSpaceId || spaceId);
    }
    const principal = await this.platform.accessControl.authenticateRequest(request);
    if (principal?.kind === "account") {
      if (principal.membership?.status !== "active") throw accountError(403, "permission_denied");
      const origin = headerValue(request.headers, "origin");
      if (origin && !this.platform.accessControl.originAllowed(origin)) throw accountError(403, "invalid_origin");
      this.platform.accessControl.checkCsrf(request, principal);
      await this.provisioner?.ensure(principal.user.id);
      return this.instance(contentSpaceId(principal));
    }
    // Connector credentials identify their existing scoped store. Validate
    // the secret before allocating an instance for an unauthenticated caller.
    const parts = bearerToken(request.headers).split(".");
    if (parts.length === 3 && parts[0] === "zion_v1") {
      const row = (await this.pool.query(`SELECT c.space_id,c.secret_hash,c.expires_at,c.revoked_at,
        d.revoked_at AS device_revoked_at,d.kind FROM runtime_access_credentials c
        JOIN runtime_access_devices d ON d.space_id=c.space_id AND d.device_id=c.device_id
        WHERE c.credential_id=$1`, [parts[1]])).rows[0];
      if (row?.kind === "resource" && !row.revoked_at && !row.device_revoked_at
        && Number(row.expires_at) > Date.now() && matches(parts[2], row.secret_hash)) {
        return this.instance(row.space_id);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/access/pair") {
      const body = await readJson(request);
      const code = String(body.userCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const row = (await this.pool.query(`SELECT space_id,secret_hash,user_code_hash,expires_at,consumed_at
        FROM runtime_access_pairings WHERE ${body.pairingId ? "pairing_id=$1" : "user_code_hash=$1"}`,
      [body.pairingId || hash(code)])).rows[0];
      if (row && !row.consumed_at && Number(row.expires_at) > Date.now()
        && (body.pairingId ? matches(body.secret, row.secret_hash) : matches(code, row.user_code_hash))) {
        return this.instance(row.space_id);
      }
    }
    return this.instances.get(this.platformSpaceId);
  }

  async acquire(spaceId) {
    const entry = await this.instance(spaceId);
    entry.requests++;
    entry.lastUsed = Date.now();
    let released = false;
    return { app: entry.app, release() {
      if (released) return;
      released = true; entry.requests--; entry.lastUsed = Date.now();
    } };
  }

  async handleRequest(request, response) {
    let entry;
    try {
      entry = await this.select(request);
      entry.requests++;
      entry.lastUsed = Date.now();
      let released = false;
      const release = () => {
        if (released) return;
        released = true; entry.requests--; entry.lastUsed = Date.now();
      };
      response.once("finish", release);
      response.once("close", release);
      await entry.app.runtime.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) json(response, error.statusCode || 503, {
        error: error.statusCode ? error.message : "Runtime 暂时不可用，请稍后重试。",
        code: error.code || "account_runtime_unavailable"
      });
      else response.end();
    }
  }

  async handleUpgrade(request, socket, head) {
    try {
      const entry = await this.select(request);
      entry.requests++; entry.lastUsed = Date.now();
      socket.once("close", () => { entry.requests--; entry.lastUsed = Date.now(); });
      await entry.app.runtime.handleUpgrade(request, socket, head);
    } catch {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  }

  async evict(forCapacity = false) {
    for (const [spaceId, entry] of this.instances) {
      if (spaceId === this.platformSpaceId || entry.requests || !entry.app.isIdle()
        || (!forCapacity && Date.now() - entry.lastUsed < this.idleMs)) continue;
      // Publish the close promise before yielding so a concurrent request
      // cannot enter a Runtime whose caches are being torn down.
      this.instances.delete(spaceId);
      const closing = Promise.resolve().then(() => entry.app.close())
        .finally(() => this.retiring.delete(spaceId));
      this.retiring.set(spaceId, closing);
      await closing;
      if (forCapacity) break;
    }
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    this.timer = setInterval(() => {
      if (!this.evicting) this.evicting = this.evict().catch(() => {}).finally(() => { this.evicting = null; });
    }, 30000);
    this.timer.unref();
    const address = this.server.address();
    return { url: `http://${this.host}:${address.port}` };
  }

  async close() {
    this.closing = true;
    clearInterval(this.timer);
    const stopped = new Promise((resolve) => this.server.close(resolve));
    this.server.closeAllConnections?.();
    await this.evicting;
    await Promise.allSettled([...this.retiring.values()]);
    await Promise.allSettled([...this.pending.values()]);
    for (const entry of this.instances.values()) await entry.app.close();
    this.instances.clear();
    await stopped;
  }
}
