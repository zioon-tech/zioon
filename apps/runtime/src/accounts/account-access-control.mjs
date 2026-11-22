import {
  RuntimeAccessControl, bearerToken, cookieValue, headerValue, readJson, json, publicDevice
} from "../access-control.mjs";
import { accountError, roleScopes, intersectAccountPolicy } from "./account-policy.mjs";
import { verifyMemoryDelegation } from "./memory-delegation.mjs";
import { resolveMemoryScope } from "../spaces/memory-scope.mjs";
import { authorizeContentScope, contentSpaceId, assertContentRun } from "../sharing/content-scope.mjs";
import { SHARED_DOCUMENT_SAFE_TOOLS } from "../spaces/space-runtime.mjs";

const writeMethod = (method) => !["GET", "HEAD", "OPTIONS"].includes(method);

// Positive routing rules for non-admin writes. New service endpoints require an
// explicit decision before ordinary members may mutate the control plane.
export function accountRequestScope(method, pathname) {
  if (/^\/v1\/webhooks(?:\/|$)/.test(pathname)) return "runtime.manage";
  if (/^\/v1\/workbench-state\/plugin-development(?:\/|$)/.test(pathname)) {
    return writeMethod(method) ? "runtime.write" : "runtime.read";
  }
  if (/^\/v1\/marketplace(?:\/|$)/.test(pathname)) {
    return writeMethod(method) ? "runtime.write" : "runtime.read";
  }
  if (method === "PUT" && pathname === "/v1/models/selection") return "runtime.write";
  if (method === "PATCH" && pathname === "/v1/skills/snapshot") return "runtime.write";
  if (method === "POST" && /^\/v1\/sandbox\/workspace\/(?:pause|release)$/.test(pathname)) return "resource.execute";
  if (/^\/v1\/plugins\/[^/]+\/files(?:\/|$)/.test(pathname)) return "resource.execute";
  if (method === "POST" && /^\/v1\/plugins\/[^/]+\/commands$/.test(pathname)) {
    // The command router separately requires run.execute for every mutation/model call.
    return "runtime.read";
  }
  if (/^\/v1\/(?:model-gateway|device-services|plugins\/[^/]+\/locations)(?:\/|$)/.test(pathname)
    || pathname.startsWith("/v1/workbench-state/kv")) return "runtime.manage";
  if (!writeMethod(method)) return "runtime.read";
  if (/^\/v1\/runs(?:\/|$)/.test(pathname)
    || /^\/v1\/sessions\/[^/]+\/messages$/.test(pathname)) return "run.execute";
  if (/^\/v1\/(?:assets|sessions|workbench-state\/sessions)(?:\/|$)/.test(pathname)) {
    return "runtime.write";
  }
  return "runtime.manage";
}

export class AccountAccessControl extends RuntimeAccessControl {
  constructor({ accounts, oidc, resolveProfile = null, servedSpaceId = "", memoryBridgeSecret = "",
    memoryEnabled = !!memoryBridgeSecret, adcOrigin = "", sharedAccountIssuer = "", sharedSpaces = null, sharing = null, ...options }) {
    super(options);
    this.memoryBridgeSecret = memoryBridgeSecret;
    this.memoryEnabled = memoryEnabled;
    this.accounts = accounts;
    this.sharedSpaces = sharedSpaces;
    this.sharing = sharing;
    this.oidc = oidc;
    this.adcOrigin = adcOrigin ? new URL(adcOrigin).origin : "";
    this.sharedAccountIssuer = sharedAccountIssuer ? new URL(sharedAccountIssuer).origin : "";
    if (this.adcOrigin && !this.adcOrigin.startsWith("https://")) throw new Error("ADC identity proof requires HTTPS");
    this.resolveProfile = resolveProfile;
    this.servedSpaceId = String(servedSpaceId || "");
    this.mode = "accounts-v1";
    this.sessionCookie = oidc.secureCookies ? "__Host-zion_account" : "zion_account_local";
    this.loginCookie = oidc.secureCookies ? "__Host-zion_login" : "zion_login_local";
  }

  // Account cookies are never shared with the pairing credential namespace.
  async authenticateHeaders(headers, token = "", { spaceId = "", allowGuest = false } = {}) {
    const bearer = token || bearerToken(headers);
    const credential = bearer || cookieValue(headers, this.sessionCookie);
    const explicitSpace = spaceId || headerValue(headers, "x-zioon-space-id");
    if (explicitSpace && (explicitSpace.length > 256 || /[\x00-\x20]/.test(explicitSpace))) {
      throw accountError(400, "invalid_space_scope");
    }
    const account = await this.accounts.authenticate(credential, { spaceId: explicitSpace, allowGuest });
    if (account) {
      try { await this.oidc.validateSession?.(account, {
        browser: !bearer, cookies: headerValue(headers, "cookie") || ""
      }); }
      catch (error) {
        if (error.statusCode === 401) return null;
        throw accountError(503, "account_service_unavailable");
      }
      return { ...account, source: bearer ? "bearer" : "cookie", kind: "account" };
    }
    if (!bearer) return null;
    const resource = await super.authenticateHeaders({
      authorization: `Bearer ${bearer}`
    });
    return resource?.device?.kind === "resource" ? resource : null;
  }

  async authenticateRequest(request) {
    const url = new URL(request.url || "/", this.publicBaseUrl);
    const match = url.pathname.match(/^\/v1\/spaces\/([^/]+)(?:\/|$)/);
    const pathSpace = match ? decodeURIComponent(match[1]) : "";
    const headerSpace = headerValue(request.headers, "x-zioon-space-id");
    const socketSpace = url.pathname === "/v1/collaboration" ? url.searchParams.get("space") || "" : "";
    const spaceId = pathSpace || headerSpace || socketSpace;
    if ((pathSpace && headerSpace && pathSpace !== headerSpace) || (socketSpace && headerSpace && socketSpace !== headerSpace)) {
      throw accountError(400, "space_scope_conflict");
    }
    const allowGuest = /^\/v1\/spaces\/[^/]+\/documents\/[^/]+(?:\/(?:access|comments|assets|presence)(?:\/[^/]+)?)?$/.test(url.pathname);
    return authorizeContentScope(this, request, await this.authenticateHeaders(request.headers, "", { spaceId, allowGuest }));
  }

  // Only configured origins in account mode; arbitrary localhost websites
  // are not implicitly allowed to send authenticated requests.
  originAllowed(value) {
    try { return this.allowedOrigins.has(new URL(value).origin); } catch { return false; }
  }

  async hasScope(principal, scope) {
    if (principal?.kind !== "account") {
      return scope === "node.connect" && principal?.device?.kind === "resource"
        && super.hasScope(principal, scope);
    }
    if (this.servedSpaceId && contentSpaceId(principal) !== this.servedSpaceId) return false;
    if (principal.contentScope) {
      if (!["runtime.read", "runtime.write", "run.execute", "collaboration.write"].includes(scope)) return false;
      await this.sharing.documentAccess(principal.user.id, principal.contentScope.originSpaceId,
        principal.contentScope.documentId, scope === "runtime.read" ? "view" : "edit");
    }
    const member = await this.accounts.membership(principal.user.id, principal.space?.id);
    return await this.accounts.activeSession(principal.sessionId, principal.user.id)
      && member?.status === "active" && roleScopes(member.role).includes(scope);
  }

  async requireScope(principal, scope) {
    if (!principal) throw accountError(401, "authentication_required");
    if (!await this.hasScope(principal, scope)) {
      throw accountError(403, "permission_denied", `Permission required: ${scope}`);
    }
    return principal;
  }

  requireServedSpace(principal) {
    if (
      principal?.kind === "account"
      && this.servedSpaceId
      && contentSpaceId(principal) !== this.servedSpaceId
    ) {
      throw accountError(
        409,
        "space_runtime_mismatch",
        "Select the Space served by this Runtime"
      );
    }
    return principal;
  }

  async reauthorize(principal, scope) {
    if (principal?.kind !== "account") {
      if (!principal) throw accountError(401, "authentication_required");
      if (!super.hasScope(principal, scope)) {
        throw accountError(403, "permission_denied", `Permission required: ${scope}`);
      }
      if (!await this.store.isCredentialActive?.(
        principal.credentialId,
        principal.device?.deviceId
      )) {
        throw accountError(401, "authentication_required");
      }
      return principal;
    }
    this.requireServedSpace(principal);
    await this.requireScope(principal, scope);
    if (this.sharedSpaces && principal.documentId) {
      await this.sharedSpaces.requireDocument(principal.user.id, contentSpaceId(principal),
        principal.documentId, principal.documentAction || "view");
    }
    return {
      ...principal,
      membership: await this.accounts.membership(principal.user.id, principal.space?.id)
    };
  }

  async requireLogin(request, { csrf = true } = {}) {
    const principal = await this.authenticateRequest(request);
    if (principal?.kind !== "account") throw accountError(401, "authentication_required");
    if (csrf) this.checkCsrf(request, principal);
    return principal;
  }

  checkCsrf(request, principal) {
    if (principal?.source === "cookie" && writeMethod(request.method)
      && !this.originAllowed(headerValue(request.headers, "origin"))) {
      throw accountError(403, "invalid_origin");
    }
  }

  async authorizeRuntimeRequest(request) {
    const principal = await this.requireLogin(request);
    this.requireServedSpace(principal);
    if (this.sharedSpaces && principal.space?.kind === "team" && !principal.explicitSpace) {
      throw accountError(409, "explicit_space_required", "Shared Space requests require an explicit Space");
    }
    const url = new URL(request.url, this.publicBaseUrl);
    const memoryFiles = this.memoryEnabled
      && /^\/v1\/plugins\/dev\.identity\/files\//.test(url.pathname);
    const memoryLocation = this.memoryEnabled
      && url.pathname === "/v1/plugins/dev.identity/locations" && request.method === "GET";
    if (memoryFiles && url.searchParams.has("document")) {
      const documentId = url.searchParams.get("document");
      await this.sharedSpaces.requireDocument(principal.user.id, contentSpaceId(principal), documentId,
        writeMethod(request.method) ? "edit" : "view");
      principal.documentId = documentId;
      principal.documentAction = writeMethod(request.method) ? "edit" : "view";
    }
    await this.requireScope(principal, memoryFiles
      ? (writeMethod(request.method) ? "runtime.write" : "runtime.read")
      : memoryLocation ? "runtime.read" : accountRequestScope(request.method, url.pathname));
    if (this.sharedSpaces) {
      const sessionPath = url.pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/|$)/);
      const runPath = url.pathname.match(/^\/v1\/runs\/([^/]+)(?:\/|$)/);
      const assetPath = url.pathname.match(/^\/v1\/assets\/([^/]+)(?:\/|$)/);
      let documentId = sessionPath ? decodeURIComponent(sessionPath[1]) : "";
      if (runPath) {
        const runId = decodeURIComponent(runPath[1]);
        const run = (await this.sharedSpaces.pool.query("SELECT payload_json FROM runtime_runs WHERE space_id=$1 AND id=$2",
          [contentSpaceId(principal), runId])).rows[0]?.payload_json;
        documentId = run?.sessionId || "";
        if (!run || !documentId && principal.space.kind === "team") throw accountError(404, "run_not_found");
        if (principal.contentScope && documentId !== principal.contentScope.documentId) throw accountError(404, "run_not_found");
        if (principal.contentScope && principal.contentScope.originSpaceId !== principal.space.id
          && (run.principal?.contentScope?.originSpaceId !== principal.contentScope.originSpaceId
            || run.principal?.contentScope?.documentId !== documentId)) {
          throw accountError(404, "run_not_found");
        }
      }
      if (documentId) {
        const action = request.method === "DELETE" ? "manage" : writeMethod(request.method) ? "edit" : "view";
        await this.sharedSpaces.requireDocument(principal.user.id, contentSpaceId(principal), documentId, action);
        principal.documentId = documentId;
        principal.documentAction = action;
      }
      if (assetPath) {
        const assetId = decodeURIComponent(assetPath[1]);
        if (principal.contentScope && !(await this.sharedSpaces.pool.query(
          "SELECT 1 FROM space_document_assets WHERE space_id=$1 AND document_id=$2 AND asset_id=$3",
          [contentSpaceId(principal), principal.documentId, assetId])).rowCount) throw accountError(404, "asset_not_found");
        await this.sharedSpaces.requireAsset(principal.user.id, contentSpaceId(principal), assetId);
      }
    }
    return principal;
  }

  async authorizeDeviceService(request) {
    const principal = request.zionPrincipal || await this.authorizeRuntimeRequest(request);
    return await this.reauthorize(principal, "resource.execute");
  }

  async authorizeNode(input) {
    const principal = await this.authenticateHeaders(input.request?.headers);
    if (input.operation === "inspect") {
      return await this.reauthorize(principal, "device.manage");
    }
    await this.reauthorize(principal, "node.connect");
    if (
      principal.device?.kind !== "resource"
      || principal.device.deviceId !== String(input.nodeId || "")
    ) {
      throw accountError(403, "permission_denied", "Resource credential is not bound to this Node");
    }
    return principal;
  }

  async authenticateCollaboration(input) {
    let principal = await this.authenticateHeaders(input.headers, input.token, {
      spaceId: input.parameters?.get("space") || input.spaceId || ""
    });
    const parameters = input.parameters || new URLSearchParams();
    principal = await authorizeContentScope(this, { method: "GET", headers: input.headers,
      url: `/v1/collaboration?${parameters}` }, principal);
    assertContentRun(principal, { sessionId: input.documentName });
    this.requireServedSpace(principal);
    await this.requireScope(principal, "runtime.read");
    if (this.sharedSpaces) {
      if (principal.space.kind === "team" && !principal.explicitSpace) throw accountError(409, "explicit_space_required");
      const d = await this.sharedSpaces.requireDocument(principal.user.id, contentSpaceId(principal), input.documentName);
      principal.documentId = input.documentName;
      principal.documentAction = ["editor", "manager"].includes(d.access.role) ? "edit" : "view";
      return { principal, documentId: input.documentName, readOnly: !["editor", "manager"].includes(d.access.role) };
    }
    return {
      principal,
      readOnly: !await this.hasScope(principal, "collaboration.write")
    };
  }

  async authorizeRunRequest(principal, request, ceiling) {
    await this.reauthorize(principal, "run.execute");
    assertContentRun(principal, request);
    const spaceId = principal.space?.id || this.accounts.spaceId;
    if (this.sharedSpaces && principal.space.kind === "team" && !request.sessionId) {
      throw accountError(400, "shared_document_required");
    }
    if (this.sharedSpaces && request.sessionId) {
      await this.sharedSpaces.requireDocument(principal.user.id, contentSpaceId(principal), request.sessionId, "edit");
    }
    if (request.spaceId && request.spaceId !== spaceId) {
      throw accountError(403, "space_mismatch");
    }
    const role = (await this.accounts.membership(principal.user.id, spaceId)).role;
    let policy = intersectAccountPolicy(request.policy, ceiling, role);
    const sharedDocument = principal.contentScope || request.sessionId && this.sharing
      && await this.sharing.sharedMemory(spaceId, request.sessionId);
    const contentScope = principal.contentScope || (sharedDocument ? {
      originSpaceId: spaceId, documentId: request.sessionId, ownerId: principal.user.id
    } : null);
    if (contentScope) {
      policy = { ...policy, allowedTools: policy.allowedTools.filter(t => SHARED_DOCUMENT_SAFE_TOOLS.has(t)),
        maxMailPerRun: 0, allowedRecipients: [], allowedCommandPrefixes: [], allowedTerminalSessionIds: [] };
      request = { ...request, projectId: undefined, target: undefined,
        metadata: Object.fromEntries(Object.entries(request.metadata || {}).filter(([key]) =>
          ["interactionProfileId", "documentProjection", "workbenchClientId", "clientRequestId", "source", "documentRevision"].includes(key))) };
    }
    return {
      ...request,
      principal: await this.accounts.issueGrant(principal.user.id, policy, {
        spaceId, contentScope,
        profileId: request.interactionProfileId || request.metadata?.interactionProfileId || ""
      }),
      policy
    };
  }

  async releaseRunPreview(request) {
    return await this.accounts.discardPreviewGrant?.(request?.principal);
  }

  async authorizeRunExecution(request) {
    const grant = await this.accounts.validateGrant(request?.principal, request?.policy);
    assertContentRun(grant.principal, { sessionId: request.sessionId || grant.principal.contentScope?.documentId });
    if (this.servedSpaceId && contentSpaceId(grant.principal) !== this.servedSpaceId
      && grant.principal.spaceId !== this.servedSpaceId) throw accountError(403, "grant_runtime_mismatch");
    if (this.sharedSpaces && request.sessionId) {
      await this.sharedSpaces.requireDocument(grant.principal.userId, contentSpaceId(grant.principal), request.sessionId, "edit");
      if (request.metadata?.spaceBindingId) await this.sharedSpaces.requireBinding(
        grant.principal.userId, grant.principal.spaceId, request.metadata.spaceBindingId);
    }
    let policy = grant.policy;
    if (this.resolveProfile) {
      const profileIds = new Set([
        grant.profileId,
        request.interactionProfileId || request.metadata?.interactionProfileId || grant.profileId
      ]);
      for (const id of profileIds) {
        const profile = id && this.resolveProfile(id);
        if (!profile?.policy) throw accountError(403, "grant_profile_unavailable");
        const membership = await this.accounts.membership(
          grant.principal.userId,
          grant.principal.spaceId
        );
        policy = intersectAccountPolicy(policy, profile.policy, membership.role);
      }
    }
    return policy;
  }

  async authorizeInvocation(invocation) {
    const policy = await this.authorizeRunExecution(invocation);
    if (!policy.allowedTools.includes(invocation.toolCall?.name)) {
      throw accountError(403, "tool_outside_grant");
    }
    return { ...invocation, policy };
  }

  async authorizeExistingRun(principal, run, { allowRevoked = false } = {}) {
    await this.reauthorize(principal, this.sharedSpaces && allowRevoked ? "runtime.read" : "run.execute");
    if (!run) throw accountError(404, "run_not_found");
    if (run.principal?.spaceId && contentSpaceId(run.principal) !== contentSpaceId(principal)) {
      throw accountError(404, "run_not_found");
    }
    if (this.sharedSpaces && run.sessionId) {
      assertContentRun(principal, run);
      await this.sharedSpaces.requireDocument(principal.user.id, contentSpaceId(principal), run.sessionId, allowRevoked ? "view" : "edit");
    } else if (run.principal?.userId !== principal.user.id) {
      await this.requireScope(principal, "runtime.manage");
    }
    // Legacy Runs can be inspected, but must be submitted as new Runs to get
    // an explicit grant; resuming cannot silently adopt a previous identity.
    if (!allowRevoked) await this.authorizeRunExecution(run);
  }

  async authorizeTask(actor, input, profile, sourceId) {
    let userId;
    let spaceId;
    let scopes;
    let parentCeiling = profile?.policy;
    if (!parentCeiling) throw accountError(403, "task_profile_required");
    if (actor?.kind === "account") {
      await this.reauthorize(actor, "runtime.manage");
      userId = actor.user.id;
      spaceId = actor.space.id;
    } else {
      const grant = await this.accounts.validateGrant(actor);
      if (!grant.scopes.includes("runtime.manage")) throw accountError(403, "task_management_denied");
      userId = grant.principal.userId;
      spaceId = grant.principal.spaceId;
      scopes = grant.scopes;
      parentCeiling = intersectAccountPolicy(
        parentCeiling, await this.authorizeRunExecution({ principal: actor }),
        (await this.accounts.membership(userId, spaceId)).role
      );
    }
    const policy = intersectAccountPolicy(
      input.capability || parentCeiling,
      parentCeiling,
      (await this.accounts.membership(userId, spaceId)).role
    );
    const executionPrincipal = await this.accounts.issueGrant(userId, policy, {
      spaceId,
      purpose: "task", sourceId, profileId: profile.id, scopes,
      ttlMs: 10 * 365 * 86_400_000
    });
    return { ...input, capability: policy, executionPrincipal };
  }

  cookie(name, value, { maxAge = 300, sameSite = "Strict" } = {}) {
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}`
      + (this.oidc.secureCookies ? "; Secure" : "");
  }

  async handleHttp(request, response, url) {
    const path = url.pathname;
    if (request.method === "GET" && ["/account", "/mobile", "/mobile/"].includes(path)
      && ["logged-out", "cancelled"].includes(url.searchParams.get("zionAuth"))) {
      const returnTo = path.startsWith("/mobile") ? "/mobile/" : "/account";
      response.writeHead(303, {
        location: `${this.publicBaseUrl}/v1/account/login?${new URLSearchParams({ returnTo })}`,
        "cache-control": "no-store"
      });
      response.end();
      return true;
    }
    if (path !== "/account/login" && !path.startsWith("/v1/account/") && !path.startsWith("/v1/access/")) return false;
    // Canonicalize HTTPS aliases too: the login cookie is host-only, while
    // the OIDC callback always returns to the configured public origin.
    if (request.method === "GET"
      && ["/v1/account/login", "/v1/account/callback"].includes(path)) {
      const canonical = new URL(this.publicBaseUrl);
      const requestHost = headerValue(request.headers, "host").toLowerCase();
      if (requestHost && requestHost !== canonical.host.toLowerCase()) {
        const location = path === "/v1/account/callback"
          ? `${canonical.origin}/v1/account/login?returnTo=/account`
          : `${canonical.origin}${path}${url.search}`;
        response.writeHead(path === "/v1/account/callback" ? 303 : 307, {
          location, "cache-control": "no-store"
        });
        response.end();
        return true;
      }
    }
    try {
      if (await this.oidc.handleHttp?.(this, request, response, url)) return true;
      if (path === "/account/login") return false;
      if (request.method === "POST" && path === "/v1/account/memory/verify") {
        if (!this.memoryBridgeSecret) throw accountError(404, "memory_bridge_disabled");
        const identity = await verifyMemoryDelegation(
          this, this.memoryBridgeSecret, bearerToken(request.headers), await readJson(request)
        );
        json(response, 200, identity);
      } else if (request.method === "GET" && path === "/v1/account/config") {
        json(response, 200, { mode: this.mode, loginUrl: "/v1/account/login" });
      } else if (request.method === "GET" && path === "/v1/account/login") {
        this.checkLoginRate(request, "page");
        const result = await this.oidc.begin(url.searchParams.get("returnTo"), {
          uiTheme: url.searchParams.get("uiTheme"),
          browser: cookieValue(request.headers, this.loginCookie)
        });
        const bindingCookie = this.oidc.loginBindingCookie?.(this.loginCookie, result.state);
        response.writeHead(302, {
          location: result.url, "cache-control": "no-store",
          "set-cookie": [
            this.cookie(this.loginCookie, result.browser, { sameSite: "Lax" }),
            ...(bindingCookie ? [this.cookie(bindingCookie, result.browser, { sameSite: "Lax" })] : [])
          ]
        });
        response.end();
      } else if (request.method === "GET" && path === "/v1/account/callback") {
        this.checkLoginRate(request, "callback");
        const bindingCookie = this.oidc.loginBindingCookie?.(this.loginCookie, url.searchParams.get("state"));
        const browser = bindingCookie && cookieValue(request.headers, bindingCookie)
          || cookieValue(request.headers, this.loginCookie);
        const result = await this.oidc.callback(url.searchParams, browser);
        response.writeHead(303, {
          location: result.returnTo, "cache-control": "no-store",
          "set-cookie": [
            ...(bindingCookie ? [this.cookie(bindingCookie, "", { maxAge: 0, sameSite: "Lax" })] : []),
            ...(this.oidc.keepLoginCookie ? [] : [
              this.cookie(this.loginCookie, "", { maxAge: 0, sameSite: "Lax" })
            ]),
            this.cookie(this.sessionCookie, result.token, {
              maxAge: Math.floor((result.expiresAt - this.now()) / 1000)
            })
          ]
        });
        response.end();
      } else if (request.method === "POST" && path === "/v1/account/device/start") {
        this.checkLoginRate(request, "device-start");
        json(response, 200, await this.oidc.beginDevice());
      } else if (request.method === "POST" && path === "/v1/account/device/poll") {
        this.checkLoginRate(request, "device-poll");
        const body = await readJson(request);
        json(response, 200, await this.oidc.pollDevice(body.flowToken));
      } else if (request.method === "POST" && path === "/v1/account/token/exchange") {
        this.checkLoginRate(request, "token-exchange");
        json(response, 200, await this.oidc.exchangeAccessToken(bearerToken(request.headers)));
      } else if (request.method === "POST" && path === "/v1/access/pair") {
        this.checkPairingRate(request);
        const body = await readJson(request);
        const pairing = await this.store.inspectPairing(body);
        if (pairing.kind !== "resource") {
          throw accountError(403, "account_login_required");
        }
        await this.accounts.requireResourcePairing(pairing.pairingId);
        const result = await this.store.exchangePairing({
          ...body, deviceId: body.device?.deviceId, label: body.device?.label,
          platform: body.device?.platform
        });
        json(response, 200, {
          paired: true, credential: result.credential, credentialId: result.credentialId,
          expiresAt: result.expiresAt, device: publicDevice(result.device)
        });
      } else {
        const principal = await this.requireLogin(request);
        const userId = principal.user.id;
        const spaceId = principal.space.id;
        if (request.method === "GET" && ["/v1/account/me", "/v1/access/session"].includes(path)) {
          json(response, 200, {
            authenticated: true, mode: this.mode, user: principal.user, space: principal.space,
            memoryScope: principal.space.kind === "team" && !principal.explicitSpace ? null : await resolveMemoryScope(this, {
              principal, sessionId: url.searchParams.get("document")
            }),
            accountIdentity: await this.accounts.identityForUser?.(userId, this.sharedAccountIssuer || this.oidc.issuer) || null,
            membership: await this.accounts.membership(userId, spaceId), expiresAt: principal.expiresAt,
            sessionId: principal.sessionId,
            scopes: roleScopes((await this.accounts.membership(userId, spaceId))?.role),
            spaces: this.accounts.listSpaces
              ? await this.accounts.listSpaces(userId)
              : [{ ...principal.space, membership: principal.membership }],
            capabilities: {
              teamSpaces: typeof this.accounts.createTeamSpace === "function",
              loginSettingsUrl: this.oidc.settingsUrl ?? "/idp/settings"
            }
          });
        } else if (request.method === "POST" && path === "/v1/account/identity/link") {
          if (!this.adcOrigin || !this.sharedAccountIssuer) throw accountError(404, "account_link_disabled");
          const { adcToken } = await readJson(request);
          if (typeof adcToken !== "string" || adcToken.length > 4096) throw accountError(400, "invalid_adc_proof");
          const proof = await fetch(`${this.adcOrigin}/api/v1/me`, {
            headers: { authorization: `Bearer ${adcToken}` }, redirect: "error", signal: AbortSignal.timeout(5000)
          });
          if (!proof.ok) throw accountError(proof.status === 401 ? 401 : 503, "adc_proof_failed");
          const adc = await proof.json();
          if (adc.kind !== "session" || !adc.user?.id) throw accountError(403, "adc_account_session_required");
          json(response, 200, await this.accounts.linkIdentity(userId, spaceId, {
            issuer: this.sharedAccountIssuer, subject: adc.user.id
          }));
        } else if (request.method === "POST" && ["/v1/account/logout", "/v1/access/logout"].includes(path)) {
          const sharedCookies = principal.source === "cookie"
            ? await this.oidc.logoutBrowser?.(principal.sessionId, headerValue(request.headers, "cookie")) || []
            : [];
          await this.accounts.revokeSession(userId, principal.sessionId);
          await this.oidc.revokeSession?.(principal.sessionId);
          json(response, 200, { loggedOut: true }, {
            "set-cookie": [
              ...sharedCookies,
              this.cookie(this.sessionCookie, "", { maxAge: 0 }),
              this.cookie(this.loginCookie, "", { maxAge: 0, sameSite: "Lax" }),
              // Hosted identity has its own cookie under /idp. Leaving it
              // behind silently signs the same user back in on the next visit.
              `zion_local_identity=; Path=/idp; HttpOnly; SameSite=Lax; Max-Age=0${this.oidc.secureCookies ? "; Secure" : ""}`,
              `zion_github=; Path=/idp; HttpOnly; SameSite=Lax; Max-Age=0${this.oidc.secureCookies ? "; Secure" : ""}`
            ]
          });
        } else if (request.method === "GET" && path === "/v1/account/sessions") {
          json(response, 200, { sessions: await this.accounts.listSessions(userId) });
        } else if (request.method === "POST" && path === "/v1/account/sessions/revoke") {
          const sessionId = (await readJson(request)).sessionId;
          const owned = (await this.accounts.listSessions(userId)).some((session) => session.id === sessionId);
          await this.accounts.revokeSession(userId, sessionId);
          if (owned) await this.oidc.revokeSession?.(sessionId);
          json(response, 200, { revoked: true });
        } else if (request.method === "GET" && path === "/v1/account/spaces") {
          json(response, 200, { spaces: await this.accounts.listSpaces(userId) });
        } else if (request.method === "POST" && path === "/v1/account/spaces") {
          if (!this.accounts.createTeamSpace) throw accountError(501, "team_spaces_unavailable");
          json(response, 201, {
            space: await this.accounts.createTeamSpace(userId, await readJson(request))
          });
        } else if (request.method === "POST" && path === "/v1/account/spaces/select") {
          if (!this.accounts.selectSpace) throw accountError(501, "space_selection_unavailable");
          const selected = await this.accounts.selectSpace(
            userId,
            principal.sessionId,
            (await readJson(request)).spaceId
          );
          json(response, 200, selected);
        } else if (request.method === "GET" && path === "/v1/account/members") {
          json(response, 200, { members: await this.accounts.listMembers(userId, spaceId) });
        } else if (request.method === "PATCH" && path.startsWith("/v1/account/members/")) {
          const memberId = decodeURIComponent(path.slice("/v1/account/members/".length));
          const input = await readJson(request);
          if (this.sharedSpaces) {
            if (input.role === "owner") throw accountError(400, "use_ownership_transfer");
            const actor = await this.sharedSpaces.member(userId, spaceId, this.sharedSpaces.pool, true);
            const target = await this.accounts.membership(memberId, spaceId);
            if (actor.role !== "owner" && (input.role === "admin" || target?.role === "admin")) throw accountError(403, "owner_required");
          }
          json(response, 200, {
            membership: await this.accounts.setMember(userId, memberId, input, spaceId)
          });
        } else if (request.method === "POST" && path === "/v1/account/invitations") {
          const invitation = this.sharedSpaces
            ? await this.sharedSpaces.invite(userId, spaceId, await readJson(request))
            : await this.accounts.invite(userId, await readJson(request), spaceId);
          json(response, 201, {
            ...invitation,
            url: `${this.publicBaseUrl}/account#invite=${encodeURIComponent(invitation.token)}`
          });
        } else if (request.method === "POST" && path === "/v1/account/invitations/accept") {
          const accepted = await (this.sharedSpaces || this.accounts).acceptInvitation(userId, (await readJson(request)).token);
          json(response, 200, {
            membership: accepted?.membership || accepted,
            ...(accepted?.space ? { space: accepted.space } : {})
          });
        } else if (request.method === "GET" && path === "/v1/account/grants") {
          json(response, 200, {
            grants: await this.accounts.listGrants(userId, {
              ...Object.fromEntries(url.searchParams),
              spaceId
            })
          });
        } else if (request.method === "POST" && path === "/v1/account/grants/revoke") {
          await this.accounts.revokeGrant(userId, (await readJson(request)).grantId, spaceId);
          json(response, 200, { revoked: true });
        } else if (request.method === "GET" && path === "/v1/account/audit") {
          json(response, 200, {
            events: await this.accounts.listAudit(userId, {
              ...Object.fromEntries(url.searchParams),
              spaceId
            })
          });
        } else if (request.method === "GET" && path === "/v1/access/authorize/observability") {
          this.requireServedSpace(principal);
          await this.requireScope(principal, "runtime.manage");
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
        } else if (request.method === "POST" && path === "/v1/access/pairings") {
          this.requireServedSpace(principal);
          await this.requireScope(principal, "pairing.manage");
          const body = await readJson(request);
          if (body.kind !== "resource") throw accountError(400, "use_account_invitation");
          const pairing = await this.store.createPairing({
            ...body,
            kind: "resource",
            delivery: "bearer"
          });
          await this.accounts.bindResourcePairing(userId, pairing.pairingId, spaceId);
          json(response, 201, pairing);
        } else if (request.method === "GET" && path === "/v1/access/devices") {
          await this.requireScope(principal, "device.manage");
          json(response, 200, {
            devices: (await this.store.listDevices())
              .filter((device) => device.kind === "resource")
              .map(publicDevice)
          });
        } else if (request.method === "POST" && /^\/v1\/access\/devices\/[^/]+\/revoke$/.test(path)) {
          await this.requireScope(principal, "device.manage");
          const deviceId = decodeURIComponent(path.split("/")[4]);
          await this.store.revokeDevice(deviceId);
          await this.accounts.audit(userId, "resource.revoked", deviceId, {}, { spaceId });
          json(response, 200, { revoked: true });
        } else {
          throw accountError(404, "account_endpoint_not_found");
        }
      }
    } catch (error) {
      // Protocol/library failures may include upstream credentials or claims.
      if (error.retryAfterSeconds) response.setHeader("retry-after", error.retryAfterSeconds);
      if (request.method === "GET" && this.oidc.loginFailure
        && ["/v1/account/login", "/v1/account/callback", "/v1/account/shared/login", "/account/login"].includes(path)) {
        const bindingCookie = path === "/v1/account/callback"
          && this.oidc.loginBindingCookie?.(this.loginCookie, url.searchParams.get("state"));
        if (bindingCookie) response.setHeader("set-cookie",
          this.cookie(bindingCookie, "", { maxAge: 0, sameSite: "Lax" }));
        this.oidc.loginFailure(this, response, error);
        return true;
      }
      json(response, Number(error?.statusCode) || 401, {
        error: error?.statusCode ? error.message : "Account authentication failed",
        code: error?.statusCode ? error.code : "authentication_failed"
      });
    }
    return true;
  }
}
