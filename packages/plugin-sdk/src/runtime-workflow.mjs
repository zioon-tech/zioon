import { createHash } from "node:crypto";

export function workflowOwner(principal) {
  if (principal?.version === 1) return [principal.spaceId, principal.userId];
  if (principal?.kind === "account") return [principal.space?.id, principal.user?.id];
  if (principal) return ["legacy", principal.credentialId || principal.device?.deviceId || "authenticated"];
  return ["local", "local"];
}

export function workflowScope(context) {
  const request = context.request || context;
  const sessionId = String(context.sessionId || request.sessionId || "");
  if (!sessionId) throw new Error("A persistent Session is required");
  const owner = workflowOwner(context.principal || request.principal);
  if (owner.some((part) => !part)) throw new Error("Workflow owner is required");
  return { sessionId, owner, key: createHash("sha256").update(JSON.stringify([...owner, sessionId])).digest("hex") };
}

export function canonicalJson(value) {
  const sorted = (item) => Array.isArray(item) ? item.map(sorted)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted(item[key])]))
      : item;
  return JSON.stringify(sorted(value)) ?? "null";
}

export function contentHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function workflowError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}
