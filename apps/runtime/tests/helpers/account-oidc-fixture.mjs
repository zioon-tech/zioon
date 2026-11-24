// Loopback-only test IdP. It signs synthetic identities without authentication.
// Never use this fixture as an identity provider for real data.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export async function createAccountOidcFixture() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const key = { ...await exportJWK(publicKey), kid: "test-account", use: "sig", alg: "RS256" };
  const codes = new Map();
  const devices = new Map();
  const callbacks = new Set();
  let subject = "test-owner";
  let profileName;
  let issuer;
  const send = (response, value, status = 200) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  const sign = (sub, claims) => new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setIssuer(issuer).setSubject(sub).setAudience("zion-account-test")
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, issuer);
      if (url.pathname === "/.well-known/openid-configuration") return send(response, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`, device_authorization_endpoint: `${issuer}/device`,
        response_types_supported: ["code"], subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"]
      });
      if (url.pathname === "/jwks") return send(response, { keys: [key] });
      if (url.pathname === "/authorize") {
        const params = Object.fromEntries(url.searchParams);
        if (!callbacks.has(params.redirect_uri) || params.client_id !== "zion-account-test") {
          return send(response, { error: "invalid_request" }, 400);
        }
        const code = randomUUID();
        codes.set(code, { ...params, subject });
        const callback = new URL(params.redirect_uri);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", params.state);
        response.writeHead(302, { location: callback.href }); response.end(); return;
      }
      if (url.pathname === "/device") {
        const deviceCode = randomUUID();
        devices.set(deviceCode, subject);
        return send(response, { device_code: deviceCode, user_code: "TEST-ONLY",
          verification_uri: `${issuer}/activate`, expires_in: 60, interval: 1 });
      }
      if (url.pathname === "/activate") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("Local test identity automatically approved. No real accounts."); return;
      }
      if (url.pathname === "/token") {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body = new URLSearchParams(raw);
        let sub; let nonce;
        if (body.get("grant_type") === "authorization_code") {
          const auth = codes.get(body.get("code"));
          codes.delete(body.get("code"));
          const challenge = createHash("sha256").update(body.get("code_verifier") || "").digest("base64url");
          if (!auth || auth.code_challenge !== challenge || auth.redirect_uri !== body.get("redirect_uri")) {
            return send(response, { error: "invalid_grant" }, 400);
          }
          sub = auth.subject; nonce = auth.nonce;
        } else {
          sub = devices.get(body.get("device_code"));
          devices.delete(body.get("device_code"));
        }
        if (!sub) return send(response, { error: "invalid_grant" }, 400);
        return send(response, {
          access_token: randomUUID(), token_type: "Bearer", expires_in: 300,
          id_token: await sign(sub, { ...(nonce ? { nonce } : {}),
            name: profileName ?? sub, email: `${sub}@example.test`, email_verified: true })
        });
      }
      send(response, { error: "not_found" }, 404);
    } catch { send(response, { error: "fixture_error" }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;
  return {
    issuer, setSubject(value) { subject = value; },
    setName(value) { profileName = value; },
    registerRuntime(origin) { callbacks.add(`${origin}/v1/account/callback`); },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })
  };
}
