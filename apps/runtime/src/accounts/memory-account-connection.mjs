import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { authorizeMemoryContext } from "./memory-delegation.mjs";

export function memoryConnectionDirectory(directory, { userId, spaceId }) {
  if (!userId || !spaceId) throw new Error("Memory connection requires an account and Space");
  const key = createHash("sha256").update(JSON.stringify([spaceId, userId])).digest("hex");
  return join(directory, key);
}

const error = (code, message, statusCode = 409) =>
  Object.assign(new Error(message), { code, statusCode });

export function createMemoryAccountAuthorization({
  directory, baseUrl, accessControl, fetchImpl = fetch, now = Date.now
}) {
  const apiUrl = new URL(baseUrl).href.replace(/\/+$/, "");
  return async ({ runContext, filePath, write }) => {
    const local = await authorizeMemoryContext(accessControl, {
      context: { ...runContext,
        principal: runContext.principal || runContext.request?.principal,
        policy: runContext.policy || runContext.request?.policy,
        interactionProfileId: runContext.interactionProfileId || runContext.request?.interactionProfileId },
      filePath, write
    });
    if (!local.scopes?.includes(write ? "runtime.write" : "runtime.read")) {
      throw error("memory_permission_denied", "Local account grant does not permit this memory operation", 403);
    }
    const path = memoryConnectionDirectory(directory, {
      userId: local.user.id, spaceId: local.space.id
    });
    let config, binding;
    try {
      [config, binding] = await Promise.all([
        readFile(join(path, "config.json"), "utf8").then(JSON.parse),
        readFile(join(path, "binding.json"), "utf8").then(JSON.parse)
      ]);
    } catch (cause) {
      if (cause.code === "ENOENT") throw error("memory_login_required", "Connect this account to online Memory first");
      throw error("memory_connection_invalid", "Memory account connection is invalid");
    }
    let runtime;
    try { runtime = new URL(binding.runtimeUrl); }
    catch { throw error("memory_connection_invalid", "Memory account connection is invalid"); }
    if (runtime.protocol !== "https:" || runtime.pathname !== "/" || runtime.search || runtime.hash
      || runtime.username || runtime.password || runtime.origin !== new URL(apiUrl).origin
      || binding.localUserId !== local.user.id || binding.localSpaceId !== local.space.id
      || binding.apiUrl !== apiUrl || config.apiUrl !== apiUrl
      || config.zionAccount?.apiUrl !== apiUrl || config.zionAccount?.runtimeUrl !== binding.runtimeUrl
      || config.defaultOrg !== binding.orgId || config.defaultDrive !== binding.driveId
      || !binding.remoteUserId || !binding.remoteSpaceId
      || typeof config.apiKey !== "string" || !config.apiKey.startsWith("zion_account_v1.")) {
      throw error("memory_connection_mismatch", "Memory connection belongs to a different account or service");
    }
    if (!Number.isFinite(config.zionAccount.expiresAt) || config.zionAccount.expiresAt <= now()) {
      throw error("memory_login_expired", "Online Memory login expired; reconnect this account");
    }
    let response;
    try {
      response = await fetchImpl(new URL("/v1/account/me", runtime), {
        redirect: "error", headers: { authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(5_000)
      });
    } catch {
      throw error("memory_identity_unavailable", "Online Memory account service is unavailable", 503);
    }
    if (!response.ok) throw error(response.status === 401 ? "memory_login_expired" : "memory_identity_unavailable",
      "Online Memory account verification failed", response.status === 401 ? 409 : 503);
    const remote = await response.json();
    if (!remote.authenticated || remote.membership?.status !== "active"
      || remote.user?.id !== binding.remoteUserId || remote.space?.id !== binding.remoteSpaceId) {
      throw error("memory_connection_mismatch", "Online Memory account changed; reconnect explicitly");
    }
    if (!remote.scopes?.includes(write ? "runtime.write" : "runtime.read")) {
      throw error("memory_permission_denied", "Online account does not permit this memory operation", 403);
    }
    return `Bearer ${config.apiKey}`;
  };
}
