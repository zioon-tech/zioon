import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { accountError, roleScopes } from "./account-policy.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const keyBytes = (secret) => {
  if (Buffer.byteLength(secret || "") < 32) throw new Error("Memory bridge secret requires at least 32 bytes");
  return new TextEncoder().encode(secret);
};

export async function createMemoryDelegation(secret, { context, method, path, body, filePath, filePaths, toolName, write }) {
  return `zm_${await new SignJWT({
    context: { principal: context.principal || context.request?.principal,
      policy: context.policy || context.request?.policy,
      interactionProfileId: context.interactionProfileId || context.request?.interactionProfileId },
    method, path, bodyHash: digest(body || ""), filePath, filePaths, toolName, write: write === true
  }).setProtectedHeader({ alg: "HS256" }).setIssuer("zion-memory-bridge")
    .setAudience("zion-memory-service").setIssuedAt().setExpirationTime("30s").sign(keyBytes(secret))}`;
}

export async function verifyMemoryDelegation(accessControl, secret, token, requestBinding) {
  let payload;
  try {
    ({ payload } = await jwtVerify(String(token || "").replace(/^zm_/, ""), keyBytes(secret), {
      algorithms: ["HS256"], issuer: "zion-memory-bridge", audience: "zion-memory-service"
    }));
  } catch { throw accountError(401, "invalid_memory_delegation"); }
  if (payload.method !== requestBinding.method || payload.path !== requestBinding.path
    || payload.bodyHash !== requestBinding.bodyHash) throw accountError(403, "memory_request_binding_mismatch");
  if (payload.path?.split("?")[0] === "/zion/files/read-batch") {
    let paths;
    try {
      // Older gateways forward the signed request path but no separate paths
      // field. Derive the actual paths from that request in both generations.
      const params = new URL(requestBinding.path, "https://memory.invalid").searchParams;
      if (params.getAll("files").length === 1) {
        paths = JSON.parse(params.get("files"))?.map(spec => spec.path);
      }
    } catch {}
    if (!Array.isArray(paths) || !paths.length || paths.length > 32
      || paths.some(path => typeof path !== "string")
      || payload.write || JSON.stringify(payload.filePaths) !== JSON.stringify(paths)
      || requestBinding.filePaths !== undefined
        && JSON.stringify(paths) !== JSON.stringify(requestBinding.filePaths)) {
      throw accountError(403, "memory_file_binding_mismatch");
    }
  }
  if (payload.path === "/mcp" && (
    !payload.toolName || payload.toolName !== requestBinding.toolName
    || payload.write !== requestBinding.write
    || JSON.stringify(payload.filePaths) !== JSON.stringify(requestBinding.filePaths)
  )) throw accountError(403, "memory_tool_binding_mismatch");
  return await authorizeMemoryContext(accessControl, payload);
}

// Both a same-authority bridge and an explicitly linked remote account must
// recheck the local session/grant, current profile and file policy.
export async function authorizeMemoryContext(accessControl, payload) {
  const context = payload.context;
  const principal = context?.principal;
  const validatePolicy = (policy = {}) => {
    if (payload.write && policy.preset === "read-only") throw accountError(403, "file_write_denied");
    if (payload.toolName && !policy.allowedTools?.includes(payload.toolName)) throw accountError(403, "tool_outside_grant");
    const paths = payload.filePaths || [payload.filePath];
    const roots = (policy.fileRoots || []).map((root) => root.replace(/\/+$/, "") || "/");
    if (roots.length && paths.some((path) => !roots.some((root) =>
      root === "/" || path === root || path?.startsWith(`${root}/`)
    ))) throw accountError(403, "file_outside_grant");
  };
  let userId, spaceId, scopes;
  if (principal?.kind === "account") {
    await accessControl.reauthorize(principal, payload.write ? "runtime.write" : "runtime.read");
    validatePolicy(context.policy);
    userId = principal.user.id;
    spaceId = principal.space.id;
    scopes = roleScopes((await accessControl.accounts.membership(userId, spaceId))?.role);
  } else {
    const grant = await accessControl.accounts.validateGrant(principal, context.policy);
    const policy = await accessControl.authorizeRunExecution(context);
    validatePolicy(policy);
    userId = grant.principal.userId;
    spaceId = grant.principal.spaceId;
    scopes = grant.scopes;
  }
  if (!userId || !spaceId) throw accountError(403, "invalid_memory_identity");
  const user = await accessControl.accounts.getUser(userId);
  const space = await accessControl.accounts.space(spaceId);
  const membership = await accessControl.accounts.membership(userId, spaceId);
  const accountIdentity = await accessControl.accounts.identityForUser?.(userId, accessControl.sharedAccountIssuer || accessControl.oidc?.issuer) || null;
  return { authenticated: true, user, space, membership, scopes, accountIdentity };
}
