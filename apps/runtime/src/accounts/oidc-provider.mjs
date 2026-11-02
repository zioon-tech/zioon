import { createHash, randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { accountError } from "./account-policy.mjs";

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const loopback = (url) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

export function accountPublicUrl(value, allowHttp = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:" && loopback(url)))) {
    throw new Error("Account public URL must be an HTTPS origin (explicit loopback HTTP for development)");
  }
  return url;
}

export function safeReturnTo(value) {
  const path = String(value || "/");
  // Reject protocol-relative URLs, control characters and backslash normalization.
  return /^\/(?!\/)/.test(path) && !/[\\\x00-\x20\x7f]/.test(path) ? path : "/";
}

export async function createOidcProvider({
  issuer, clientId, clientSecret = "", publicBaseUrl, allowLoopbackHttp = false,
  audience = "", requiredScope = "zion.api", activeSpaceId = "",
  store, now = () => Date.now()
}) {
  const publicUrl = accountPublicUrl(publicBaseUrl, allowLoopbackHttp);
  const issuerUrl = new URL(issuer);
  if (issuerUrl.protocol !== "https:"
    && !(allowLoopbackHttp && issuerUrl.protocol === "http:" && loopback(issuerUrl))) {
    throw new Error("OIDC issuer requires HTTPS");
  }
  if (!clientId || !store) throw new Error("Account mode requires an OIDC client ID and Account Store");
  const config = await oidc.discovery(
    issuerUrl, clientId, undefined,
    clientSecret ? oidc.ClientSecretPost(clientSecret) : oidc.None(),
    { timeout: 15, ...(allowLoopbackHttp ? { execute: [oidc.allowInsecureRequests] } : {}) }
  );
  // Also validate ID-token signatures returned over the back channel.
  oidc.enableNonRepudiationChecks(config);
  const callbackUrl = new URL("/v1/account/callback", publicUrl).href;
  const metadata = config.serverMetadata();
  const jwks = audience && metadata.jwks_uri
    ? createRemoteJWKSet(new URL(metadata.jwks_uri), { timeoutDuration: 10_000 })
    : null;
  const flows = new Map();
  const createUserSession = async (user, options = {}) => {
    const preferredSpaceId = String(activeSpaceId || "");
    const membership = preferredSpaceId && store.membership
      ? await store.membership(user.id, preferredSpaceId)
      : null;
    return await store.createSession(user.id, {
      ...options,
      ...(membership?.status === "active"
        ? { activeSpaceId: preferredSpaceId }
        : {})
    });
  };
  const sessionFromTokens = async (tokens) => {
    const claims = tokens.claims();
    if (!claims?.sub || claims.iss !== metadata.issuer) throw accountError(401, "invalid_oidc_identity");
    const user = await store.resolveIdentity({
      issuer: claims.iss, subject: claims.sub, name: claims.name,
      email: claims.email, emailVerified: claims.email_verified === true
    });
    return await createUserSession(user);
  };
  const sweep = () => {
    for (const [key, flow] of flows) {
      if (flow.expiresAt <= now()) {
        flow.controller.abort();
        flows.delete(key);
      }
    }
  };
  return {
    issuer: metadata.issuer,
    callbackUrl,
    secureCookies: publicUrl.protocol === "https:",
    async begin(returnTo, { uiTheme = "" } = {}) {
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      const browser = randomBytes(32).toString("base64url");
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      const localUiTheme = ["light", "dark"].includes(uiTheme) && loopback(issuerUrl)
        ? uiTheme
        : "";
      await store.saveLoginTransaction(
        state,
        browser,
        { verifier, nonce, returnTo: safeReturnTo(returnTo) }
      );
      return {
        browser,
        url: oidc.buildAuthorizationUrl(config, {
          response_type: "code", redirect_uri: callbackUrl, scope: "openid profile email",
          state, nonce, code_challenge: challenge, code_challenge_method: "S256",
          ...(localUiTheme ? { zion_ui_theme: localUiTheme } : {})
        }).href
      };
    },
    async callback(query, browser) {
      const state = query.get("state");
      if (!state || !browser) throw accountError(401, "invalid_login_transaction");
      const transaction = await store.consumeLoginTransaction(state, browser);
      const currentUrl = new URL(callbackUrl);
      currentUrl.search = query.toString();
      const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: transaction.verifier, expectedState: state,
        expectedNonce: transaction.nonce, idTokenExpected: true
      });
      return { ...await sessionFromTokens(tokens), returnTo: transaction.returnTo };
    },
    // Provider tokens are only accepted at this exchange endpoint. ID tokens
    // cannot pass the mandatory access-token type, audience and scope checks.
    async exchangeAccessToken(token) {
      if (!jwks) throw accountError(404, "access_token_exchange_disabled");
      const { payload, protectedHeader } = await jwtVerify(token, jwks, {
        issuer: metadata.issuer, audience, algorithms: ["RS256", "PS256", "ES256"],
        requiredClaims: ["sub", "iat", "exp"], clockTolerance: 5
      });
      if (protectedHeader.typ?.toLowerCase() !== "at+jwt"
        || !String(payload.scope || "").split(" ").includes(requiredScope)) {
        throw accountError(401, "invalid_access_token");
      }
      const user = await store.resolveIdentity({ issuer: payload.iss, subject: payload.sub });
      return await createUserSession(user, {
        ttlMs: Math.min(7 * 86_400_000, Math.floor(payload.exp * 1000 - now()))
      });
    },
    async beginDevice() {
      sweep();
      if (flows.size >= 100) throw accountError(429, "too_many_login_flows");
      if (!metadata.device_authorization_endpoint) throw accountError(501, "device_login_unavailable");
      const authorization = await oidc.initiateDeviceAuthorization(config, { scope: "openid profile email" });
      const flowToken = randomBytes(32).toString("base64url");
      const controller = new AbortController();
      const expiresAt = now() + Math.min(Number(authorization.expires_in) || 300, 600) * 1000;
      const flow = { controller, expiresAt, status: "pending" };
      flows.set(digest(flowToken), flow);
      void oidc.pollDeviceAuthorizationGrant(config, authorization, undefined, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(expiresAt - now())])
      }).then((tokens) => {
        // Do not create a session until the initiating client redeems its flow.
        flow.tokens = tokens;
        flow.status = "ready";
      }).catch(() => { flow.status = "failed"; });
      return {
        flowToken, userCode: authorization.user_code,
        verificationUri: authorization.verification_uri,
        verificationUriComplete: authorization.verification_uri_complete,
        expiresAt, interval: Math.max(5, Number(authorization.interval) || 5)
      };
    },
    async pollDevice(flowToken) {
      sweep();
      const key = digest(flowToken);
      const flow = flows.get(key);
      if (!flow) throw accountError(401, "device_login_expired");
      if (flow.status === "pending") return { pending: true };
      flows.delete(key);
      if (flow.status !== "ready") throw accountError(401, "device_login_failed");
      return await sessionFromTokens(flow.tokens);
    },
    close() {
      for (const flow of flows.values()) flow.controller.abort();
      flows.clear();
    }
  };
}
