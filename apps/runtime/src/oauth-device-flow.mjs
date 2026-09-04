import { setTimeout as delay } from "node:timers/promises";
import { URLSearchParams } from "node:url";

async function postForm(fetchImpl, url, body) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(body).toString()
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function authConfig(input = {}) {
  const deviceAuthorizationUrl = String(input.deviceAuthorizationUrl || "").trim();
  const tokenUrl = String(input.tokenUrl || "").trim();
  const clientId = String(input.clientId || "").trim();
  if (!deviceAuthorizationUrl || !tokenUrl || !clientId) {
    throw new Error(
      "OAuth device profile requires deviceAuthorizationUrl, tokenUrl, and clientId"
    );
  }
  return {
    deviceAuthorizationUrl,
    tokenUrl,
    clientId,
    scope: String(input.scope || "").trim(),
    audience: String(input.audience || "").trim()
  };
}

function normalizeCredential(payload, now) {
  const accessToken = String(payload?.access_token || "").trim();
  if (!accessToken) throw new Error("OAuth token response has no access_token");
  const expiresIn = Math.max(1, Number(payload.expires_in) || 3600);
  return {
    schemaVersion: 1,
    tokenType: String(payload.token_type || "Bearer"),
    accessToken,
    ...(payload.refresh_token
      ? { refreshToken: String(payload.refresh_token) }
      : {}),
    ...(payload.scope ? { scope: String(payload.scope) } : {}),
    expiresAt: now() + expiresIn * 1000
  };
}

export async function loginWithOAuthDeviceFlow({
  profileName,
  auth,
  credentialStore,
  fetchImpl = globalThis.fetch,
  emit = () => {},
  now = () => Date.now(),
  sleep = delay
}) {
  const config = authConfig(auth);
  const { response, payload } = await postForm(
    fetchImpl,
    config.deviceAuthorizationUrl,
    {
      client_id: config.clientId,
      ...(config.scope ? { scope: config.scope } : {}),
      ...(config.audience ? { audience: config.audience } : {})
    }
  );
  if (!response.ok) {
    throw new Error(
      payload?.error_description
      || payload?.error
      || `OAuth device authorization failed: ${response.status}`
    );
  }
  const deviceCode = String(payload.device_code || "");
  const userCode = String(payload.user_code || "");
  const verificationUri = String(
    payload.verification_uri_complete
    || payload.verification_uri
    || ""
  );
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error("OAuth device authorization response is incomplete");
  }
  emit({
    type: "auth.deviceCode",
    profileName,
    userCode,
    verificationUri,
    expiresIn: Number(payload.expires_in) || 600
  });

  let intervalSeconds = Math.max(1, Number(payload.interval) || 5);
  const deadline = now() + Math.max(1, Number(payload.expires_in) || 600) * 1000;
  while (now() < deadline) {
    await sleep(intervalSeconds * 1000);
    const token = await postForm(fetchImpl, config.tokenUrl, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: config.clientId
    });
    if (token.response.ok) {
      const credential = normalizeCredential(token.payload, now);
      await credentialStore.set(profileName, credential);
      emit({
        type: "auth.completed",
        profileName,
        expiresAt: credential.expiresAt,
        scope: credential.scope || ""
      });
      return credential;
    }
    const code = String(token.payload?.error || "");
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      intervalSeconds += 5;
      continue;
    }
    if (code === "expired_token") break;
    throw new Error(
      token.payload?.error_description
      || code
      || `OAuth token request failed: ${token.response.status}`
    );
  }
  throw new Error("OAuth device authorization expired before approval");
}

async function refreshCredential({
  profileName,
  auth,
  credential,
  credentialStore,
  fetchImpl,
  now
}) {
  const config = authConfig(auth);
  const refreshToken = String(credential?.refreshToken || "");
  if (!refreshToken) return null;
  const token = await postForm(fetchImpl, config.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId
  });
  if (!token.response.ok) return null;
  const refreshed = normalizeCredential({
    ...token.payload,
    refresh_token: token.payload?.refresh_token || refreshToken
  }, now);
  await credentialStore.set(profileName, refreshed);
  return refreshed;
}

export async function resolveOAuthDeviceCredential({
  profileName,
  auth,
  credentialStore,
  fetchImpl = globalThis.fetch,
  now = () => Date.now()
}) {
  const credential = await credentialStore.get(profileName);
  if (!credential) {
    throw new Error(`Runtime CLI profile is not logged in: ${profileName}`);
  }
  if (Number(credential.expiresAt || 0) > now() + 30_000) return credential;
  const refreshed = await refreshCredential({
    profileName,
    auth,
    credential,
    credentialStore,
    fetchImpl,
    now
  });
  if (refreshed) return refreshed;
  throw new Error(`Runtime CLI credential expired; run: zion auth login ${profileName}`);
}
