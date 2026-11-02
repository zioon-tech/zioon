import { setTimeout as delay } from "node:timers/promises";
import { createCliCredentialStore } from "../cli-credential-store.mjs";
import { resolveOAuthDeviceCredential } from "../oauth-device-flow.mjs";
import { accountPublicUrl } from "./oidc-provider.mjs";

export function accountCredentialKey(baseUrl) {
  return `account|${accountPublicUrl(baseUrl, true).origin}`;
}

export async function accountCliRequest(baseUrl, path, {
  token, body, fetchImpl = globalThis.fetch, signal
} = {}) {
  const origin = accountPublicUrl(baseUrl, true).origin;
  const response = await fetchImpl(`${origin}/v1/account/${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error || `Account HTTP ${response.status}`), {
    statusCode: response.status
  });
  return value;
}

export async function loginWithAccount({
  baseUrl, credentialStore = createCliCredentialStore(), fetchImpl, signal,
  sleep = (ms) => delay(ms, undefined, { signal }), emit = () => {}
}) {
  const key = accountCredentialKey(baseUrl);
  const previous = await credentialStore.get(key);
  const flow = await accountCliRequest(baseUrl, "device/start", { body: {}, fetchImpl, signal });
  const verificationUri = String(flow.verificationUriComplete || flow.verificationUri || "").trim();
  if (!flow.flowToken || !verificationUri || !Number.isFinite(flow.expiresAt)) {
    throw new Error("Runtime returned an invalid device login flow");
  }
  emit({ type: "auth.deviceCode", verificationUri, userCode: flow.userCode });
  while (Date.now() < flow.expiresAt) {
    await sleep(Math.min(30, Math.max(5, flow.interval || 5)) * 1000);
    signal?.throwIfAborted();
    const result = await accountCliRequest(baseUrl, "device/poll", {
      body: { flowToken: flow.flowToken }, fetchImpl, signal
    });
    if (result.pending) continue;
    if (!result.token?.startsWith("zion_account_v1.") || result.expiresAt <= Date.now()) {
      throw new Error("Runtime returned an invalid account session");
    }
    const credential = { ...result, origin: new URL(baseUrl).origin };
    try { await credentialStore.set(key, credential); }
    catch (error) {
      await accountCliRequest(baseUrl, "logout", { token: result.token, body: {}, fetchImpl }).catch(() => {});
      throw error;
    }
    if (previous?.origin === credential.origin && previous.token) {
      await accountCliRequest(baseUrl, "logout", { token: previous.token, body: {}, fetchImpl }).catch(() => {});
    }
    emit({ type: "auth.completed", runtimeUrl: credential.origin, expiresAt: credential.expiresAt });
    return { runtimeUrl: credential.origin, expiresAt: credential.expiresAt };
  }
  throw new Error("Device login expired; start auth login again");
}

export async function manageAccountLogin({
  action, baseUrl, credentialStore = createCliCredentialStore(), fetchImpl, signal, sleep, emit
}) {
  if (action === "login") return loginWithAccount({ baseUrl, credentialStore, fetchImpl, signal, sleep, emit });
  const key = accountCredentialKey(baseUrl);
  const credential = await credentialStore.get(key);
  const usable = credential?.origin === new URL(baseUrl).origin && credential?.token;
  if (action === "logout") {
    if (usable) {
      try { await accountCliRequest(baseUrl, "logout", { token: credential.token, body: {}, fetchImpl, signal }); }
      catch (error) { if (error.statusCode !== 401) throw error; }
    }
    return { runtimeUrl: new URL(baseUrl).origin, deleted: await credentialStore.delete(key) };
  }
  if (action !== "status") throw new Error(`Unknown auth action: ${action}`);
  if (!usable || credential.expiresAt <= Date.now()) return { authenticated: false };
  try {
    const me = await accountCliRequest(baseUrl, "me", { token: credential.token, fetchImpl, signal });
    return { authenticated: true, user: me.user, space: me.space, membership: me.membership, expiresAt: me.expiresAt };
  } catch (error) {
    if (error.statusCode === 401) return { authenticated: false };
    throw error;
  }
}

export async function resolveRuntimeCliHeaders(target, { credentialStore, fetchImpl } = {}) {
  if (target.auth?.type === "device_code") {
    const credential = await resolveOAuthDeviceCredential({
      profileName: target.profileName, auth: target.auth,
      credentialStore: credentialStore || createCliCredentialStore(), fetchImpl
    });
    return { ...target.headers, authorization: `${credential.tokenType || "Bearer"} ${credential.accessToken}` };
  }
  if (target.auth?.type !== "account") return target.headers;
  const key = accountCredentialKey(target.baseUrl);
  const credential = await (credentialStore || createCliCredentialStore()).get(key);
  if (credential?.origin !== new URL(target.baseUrl).origin || !credential?.token
    || credential.expiresAt <= Date.now()) {
    if (target.auth?.type === "account") throw new Error("Account login required; run auth login for this Runtime");
    return target.headers;
  }
  return { ...target.headers, authorization: `Bearer ${credential.token}` };
}
