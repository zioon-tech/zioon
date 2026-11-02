import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const random = () => randomBytes(32).toString("base64url");
const commonCookie = (cookies) => String(cookies || "").split(";").map(v => v.trim())
  .filter(v => /^__Secure-zioon\.session_token=[^;\r\n]*$/.test(v)).join("; ");
export function createAccountClient({ issuer, adcOrigin, clientId, callbackUrl,
  scope = "openid profile email", fetchImpl = fetch }) {
  const authority = new URL(issuer).origin;
  const adc = authority;
  const callback = new URL(callbackUrl);
  if (callback.search || callback.hash || callback.username || callback.password
    || (callback.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(callback.hostname))) {
    throw new Error("Invalid account callback");
  }
  const jwks = createRemoteJWKSet(new URL("/jwks", authority), { timeoutDuration: 5000 });
  async function adcRequest(path, { body, token } = {}) {
    return fetchImpl(`${adc}${path}`, {
      method: body ? "POST" : "GET", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { origin: adc, ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  }
  function authorizeUrl(transaction) {
    const url = new URL("/api/v1/zioon/authorize", adc);
    url.search = new URLSearchParams({
      client_id: clientId, redirect_uri: callback.href, response_type: "code",
      scope, state: transaction.state, nonce: transaction.nonce, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(transaction.verifier).digest("base64url")
    }).toString();
    return url;
  }
  async function request(path, { body, token, cookies } = {}) {
    const response = await fetchImpl(`${authority}${path}`, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(cookies === undefined ? {} : { cookie: commonCookie(cookies) }),
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: new URLSearchParams(body).toString() } : {})
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(value.error || "account_service_unavailable"), {
      statusCode: response.status
    });
    return value;
  }
  return {
    issuer: authority,
    hostedLoginUrl(transaction) {
      return authorizeUrl(transaction).href;
    },
    begin() {
      const transaction = { state: random(), nonce: random(), verifier: random() };
      return { transaction, url: authorizeUrl(transaction).href };
    },
    async loginConfig() {
      const response = await adcRequest("/api/v1/zioon/login-config");
      if (!response.ok) throw new Error("account_service_unavailable");
      return response.json();
    },
    socialUrl(transaction) {
      const url = authorizeUrl(transaction);
      url.pathname = "/api/v1/zioon/social/start";
      return url.href;
    },
    async emailLogin(input, transaction) {
      const callbackURL = new URL("/api/v1/zioon/return", adc);
      callbackURL.searchParams.set("client_id", clientId);
      const response = await adcRequest(input.register ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email", {
        body: { email: input.email, password: input.password, callbackURL: callbackURL.href,
          ...(input.register ? { name: input.name } : {}) }
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) {
        const code = response.status === 429 ? "too_many_login_requests"
          : value.code === "EMAIL_NOT_VERIFIED" ? "email_not_verified"
          : response.status >= 500 ? "account_service_unavailable" : "invalid_credentials";
        throw Object.assign(new Error(code), { statusCode: response.status >= 500 ? 503 : response.status });
      }
      if (input.register && !value.token) return { verificationRequired: true };
      if (typeof value.token !== "string" || !value.token) throw new Error("account_service_unavailable");
      const accepted = await adcRequest(authorizeUrl(transaction).pathname + authorizeUrl(transaction).search, { token: value.token });
      const location = accepted.headers.get("location");
      if (![302, 303].includes(accepted.status) || !location) throw new Error("account_service_unavailable");
      const result = new URL(location);
      if (result.origin !== callback.origin || result.pathname !== callback.pathname) throw new Error("invalid_login_transaction");
      return { query: result.searchParams };
    },
    async callback(query, transaction) {
      if (!transaction || query.get("state") !== transaction.state || query.get("iss") !== authority
        || !query.get("code") || query.has("error")) {
        throw Object.assign(new Error("invalid_login_transaction"), { statusCode: 401 });
      }
      const tokens = await request("/token", { body: {
        grant_type: "authorization_code", client_id: clientId, redirect_uri: callback.href,
        code: query.get("code"), code_verifier: transaction.verifier
      } });
      const { payload } = await jwtVerify(tokens.id_token, jwks, {
        issuer: authority, audience: clientId, algorithms: ["RS256"],
        requiredClaims: ["sub", "iat", "exp", "nonce"]
      });
      if (payload.nonce !== transaction.nonce || !tokens.access_token?.startsWith("zioon_at_")
        || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
        throw Object.assign(new Error("invalid_account_token"), { statusCode: 401 });
      }
      const identity = await request("/userinfo", { token: tokens.access_token });
      if (identity.sub !== payload.sub || identity.iss !== authority) {
        throw Object.assign(new Error("invalid_account_identity"), { statusCode: 401 });
      }
      return { identity, token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
    },
    userinfo(token, cookies) {
      return request(`/userinfo${cookies === undefined ? "" : "?browser=1"}`, { token, cookies });
    },
    revoke(token) { return request("/revoke", { body: { token, client_id: clientId } }); },
    async browserLogout(cookies, token) {
      const common = commonCookie(cookies);
      const response = await fetchImpl(`${authority}/api/v1/zioon/session/logout`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { origin: authority, "content-type": "application/json", ...(common ? { cookie: common } : {}) },
        body: JSON.stringify({ ...(token ? { token, client_id: clientId } : {}) })
      });
      if (!response.ok) throw Object.assign(new Error("account_service_unavailable"), { statusCode: 503 });
      return response.headers.getSetCookie();
    },
    deviceStart() { return request("/device_authorization", { body: { client_id: clientId, scope } }); },
    devicePoll(deviceCode) { return request("/token", { body: { client_id: clientId, device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code" } }); },
    async deviceInfo(userCode) {
      const response = await adcRequest(`/api/v1/zioon/device-info?user_code=${encodeURIComponent(userCode)}`);
      if (!response.ok) throw Object.assign(new Error("device_login_expired"), { statusCode: response.status });
      return response.json();
    },
    async deviceApprove(userCode, token, decision) {
      const response = await adcRequest("/api/v1/zioon/device-approve", {
        body: { user_code: userCode, decision }, token
      });
      if (!response.ok) throw Object.assign(new Error("device_login_failed"), { statusCode: response.status });
      return response.json();
    }
  };
}
