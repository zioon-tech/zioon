import { accountError } from "../accounts/account-policy.mjs";
import { headerValue } from "../access-control.mjs";

export const contentSpaceId = p => p?.contentScope?.originSpaceId || p?.spaceId || p?.space?.id;

/** A foreign document is an explicit request scope, never an account switch. */
export function requestedContentScope(request) {
  const url = new URL(request.url || "/", "http://runtime.local");
  const socket = url.pathname === "/v1/collaboration";
  const originSpaceId = headerValue(request.headers, "x-zioon-content-space") || (socket && url.searchParams.get("content_space")) || "";
  const documentId = headerValue(request.headers, "x-zioon-content-document") || (socket && url.searchParams.get("content_document")) || "";
  if (!originSpaceId && !documentId) return null;
  if ([originSpaceId, documentId].some(v => !v || v.length > 256 || /[\x00-\x20]/.test(v))) {
    throw accountError(400, "invalid_content_scope");
  }
  return { originSpaceId, documentId };
}

/** Positive endpoint rules keep unrelated owner APIs outside this authority. */
export function contentRequestAction(request, scope) {
  const url = new URL(request.url || "/", "http://runtime.local"), path = url.pathname, method = request.method || "GET";
  const read = method === "GET" || method === "HEAD";
  const session = path.match(/^\/v1\/(?:workbench-state\/)?sessions\/([^/]+)(.*)$/);
  if (session) {
    if (decodeURIComponent(session[1]) !== scope.documentId) throw accountError(403, "content_document_mismatch");
    const suffix = session[2];
    if (read && ["", "/metadata", "/messages", "/transcript", "/events", "/events/stream", "/revisions", "/active-run"].includes(suffix)) return "view";
    if (read && /^\/inputs\/[^/]+$/.test(suffix)) return "view";
    if (method === "PUT" && !suffix && path.startsWith("/v1/workbench-state/")) return "edit";
    if (method === "POST" && suffix === "/messages") return "edit";
    if (method === "POST" && suffix === "/restore" && path.startsWith("/v1/workbench-state/")) return "edit";
  }
  if (read && /^\/v1\/workbench-state\/events(?:\/stream)?$/.test(path)
    && url.searchParams.get("session_id") === scope.documentId) return "view";
  if (read && path === "/v1/collaboration") return "view";
  if (method === "POST" && ["/v1/runs", "/v1/runs/preview", "/v1/plugins/dev.langchain-chat/commands"].includes(path)) return "edit";
  if (/^\/v1\/runs\/[^/]+(?:\/events(?:\/(?:stream|\d+))?|\/projection(?:\/stream)?|\/(?:transcript|model-requests)(?:\/[^/]+)?)?$/.test(path) && read) return "view";
  if (/^\/v1\/runs\/[^/]+\/(?:abort|resume)$/.test(path) && method === "POST") return "edit";
  if (/^\/v1\/assets\/[^/]+(?:\/content)?$/.test(path) && read) return "view";
  if (method === "POST" && path === "/v1/assets") return "edit";
  if (/^\/v1\/plugins\/dev\.identity\/files\//.test(path)
    && url.searchParams.get("document") === scope.documentId && ["GET", "PUT", "DELETE"].includes(method)) return read ? "view" : "edit";
  if (/^\/v1\/plugins\/dev\.identity\/files\/(?:write|append-jsonl)$/.test(path)
    && url.searchParams.get("document") === scope.documentId && method === "POST") return "edit";
  throw accountError(403, "content_endpoint_denied");
}

export async function authorizeContentScope(access, request, principal) {
  const scope = requestedContentScope(request);
  if (!scope) return principal;
  if (principal?.kind !== "account" || principal.space?.kind !== "personal" || !access.sharing) {
    throw accountError(403, "content_identity_required");
  }
  const action = contentRequestAction(request, scope);
  const grant = await access.sharing.documentAccess(principal.user.id, scope.originSpaceId, scope.documentId, action);
  return { ...principal, contentScope: { ...scope, ownerId: grant.ownerId },
    documentId: scope.documentId, documentAction: action };
}

export function assertContentRun(principal, input) {
  const scope = principal?.contentScope;
  if (scope && input.sessionId !== scope.documentId) throw accountError(403, "content_document_mismatch");
}
