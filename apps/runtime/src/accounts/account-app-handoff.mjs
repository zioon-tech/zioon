import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { bearerToken, cookieValue, headerValue, json, readJson } from "../access-control.mjs";
import { accountError } from "./account-policy.mjs";
import { accountPublicUrl, safeReturnTo } from "./oidc-provider.mjs";

const opaque = (value) => /^[A-Za-z0-9_-]{43}$/.test(String(value || ""));
const challengeFor = (value) => createHash("sha256").update(value).digest("base64url");

/** Browser-bound SSO handoff. The authorization code has no session authority;
 * only the server holding its PKCE verifier can exchange it once. */
export function createAccountAppHandoff({ access, key,
  appOrigin = "https://marketplace.zioon.tech", appOrigins = {}, allowLoopbackHttp = false }) {
  const destinations = new Map(Object.entries({ marketplace: appOrigin, ...appOrigins })
    .map(([name, value]) => [name, accountPublicUrl(value, allowLoopbackHttp).origin]));
  const runtimeOrigin = new URL(access.publicBaseUrl).origin;
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Invalid handoff encryption key");
  const seal = (token, destination) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(destination));
    const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
  };
  const open = (value, destination) => {
    const bytes = Buffer.from(value, "base64url");
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(destination));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
  };
  const redirect = (response, location) => {
    response.writeHead(303, { location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
    response.end();
  };
  return async (request, response, url) => {
    if (!/^\/v1\/account\/apps\/(?:authorize|exchange)$/.test(url.pathname)) return false;
    try {
      if (headerValue(request.headers, "host").toLowerCase() !== new URL(runtimeOrigin).host.toLowerCase()) {
        throw accountError(403, "invalid_origin");
      }
      if (url.pathname.endsWith("/authorize") && request.method === "GET") {
        const app = url.searchParams.get("app") || "marketplace";
        const destination = destinations.get(app);
        if (!destination) throw accountError(400, "invalid_app_login");
        access.checkLoginRate(request, "app-authorize");
        const state = url.searchParams.get("state");
        const challenge = url.searchParams.get("code_challenge");
        const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
        if (!opaque(state) || !opaque(challenge) || returnTo.startsWith("/api/")) {
          throw accountError(400, "invalid_app_login");
        }
        const principal = await access.requireLogin(request, { csrf: false }).catch((error) => {
          if (error.statusCode === 401) return null;
          throw error;
        });
        if (!principal) {
          redirect(response, `${runtimeOrigin}/v1/account/login?${new URLSearchParams({
            returnTo: url.pathname + url.search, uiTheme: "light"
          })}`);
          return true;
        }
        // Transferring a device credential is explicitly forbidden.
        const token = bearerToken(request.headers) || cookieValue(request.headers, access.sessionCookie);
        const code = randomBytes(32).toString("base64url");
        await access.accounts.saveLoginTransaction(code, challenge, {
          kind: "account-app-handoff", appOrigin: destination,
          sessionId: principal.sessionId, token: seal(token, destination), state, returnTo,
          expiresAt: principal.expiresAt
        }, 60_000);
        const callback = new URL("/api/auth/callback", destination);
        callback.search = new URLSearchParams({ code, state }).toString();
        redirect(response, callback.href);
        return true;
      }
      if (url.pathname.endsWith("/exchange") && request.method === "POST") {
        access.checkLoginRate(request, "app-exchange");
        const input = await readJson(request);
        const destination = destinations.get(input.app || "marketplace");
        if (!destination) throw accountError(400, "invalid_app_login");
        if (!opaque(input.code) || !opaque(input.verifier) || !opaque(input.state)) {
          throw accountError(400, "invalid_app_login");
        }
        const transaction = await access.accounts.consumeLoginTransaction(
          input.code, challengeFor(input.verifier));
        if (transaction.kind !== "account-app-handoff" || transaction.appOrigin !== destination
          || transaction.state !== input.state) throw accountError(401, "invalid_app_login");
        const token = open(transaction.token, destination);
        const common = String(headerValue(request.headers, "cookie") || "").split(";")
          .map((part) => part.trim()).filter((part) => /^__Secure-zioon\.session_token=[^;\r\n]*$/.test(part));
        const principal = await access.authenticateHeaders({
          cookie: [...common, `${access.sessionCookie}=${encodeURIComponent(token)}`].join("; ")
        });
        if (!principal || principal.kind !== "account" || principal.sessionId !== transaction.sessionId) {
          throw accountError(401, "authentication_required");
        }
        json(response, 200, { token, returnTo: transaction.returnTo, expiresAt: principal.expiresAt });
        return true;
      }
      throw accountError(405, "method_not_allowed");
    } catch (error) {
      json(response, error.statusCode || 503, {
        error: error.statusCode ? error.message : "登录暂时不可用，请重新尝试",
        code: error.code || "app_login_unavailable"
      });
      return true;
    }
  };
}
