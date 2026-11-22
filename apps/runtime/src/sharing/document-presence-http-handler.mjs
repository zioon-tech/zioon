import { randomBytes } from "node:crypto";
import { json } from "../access-control.mjs";
import { accountError } from "../accounts/account-policy.mjs";
const cookieName = "zioon_reader_presence";
const validToken = value => /^[A-Za-z0-9_-]{43}$/.test(value || "");
const readBinding = request => String(request.headers.cookie || "").split(";").map(value => value.trim())
  .find(value => value.startsWith(cookieName + "="))?.slice(cookieName.length + 1) || "";
async function emptyBody(request) {
  let size = 0, body = "";
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024) throw accountError(413, "request_too_large");
    body += chunk.toString("utf8");
  }
  let value;
  try { value = body ? JSON.parse(body) : {}; } catch { throw accountError(400, "invalid_visit"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) throw accountError(400, "invalid_visit");
}

/** Reading authorization is independent from collaboration/write capabilities. */
export function createDocumentPresenceHttpHandler({ sharing, spaces, accessControl, acquireRuntime, now = Date.now }) {
  const registrations = new Map();
  return async (request, response, url) => {
    const link = /^\/share\/([A-Za-z0-9_-]{43})\/presence(?:\/([A-Za-z0-9_-]{43}))?$/.exec(url.pathname);
    const document = /^\/v1\/spaces\/([^/]+)\/documents\/([^/]+)\/presence(?:\/([A-Za-z0-9_-]{43}))?$/.exec(url.pathname);
    if (!link && !document) return false;
    let lease;
    try {
      const method = request.method, visitId = link?.[2] || document?.[3];
      if (!["GET", "POST", "PUT", "DELETE"].includes(method) ||
        (["PUT", "DELETE"].includes(method) !== !!visitId) || method === "GET" && visitId) throw accountError(405, "method_not_allowed");
      if (method !== "GET") {
        if (!accessControl.originAllowed(request.headers.origin)) throw accountError(403, "invalid_origin");
        await emptyBody(request);
      }
      let principal = null;
      try { principal = await accessControl.requireLogin(request); }
      catch (error) { if (!link || error.statusCode !== 401) throw error; }
      let binding = readBinding(request);
      if (!validToken(binding)) binding = "";
      if (method === "POST") {
        // Bound memory, per-source/per-client registration rate and document capacity.
        for (const [key, entry] of registrations) if (entry.until <= now()) registrations.delete(key);
        const rateKey = `${link?.[1] || document?.[1]}:${request.socket?.remoteAddress || "local"}`;
        const rate = registrations.get(rateKey) || { count: 0, until: now() + 60000 };
        if (registrations.size >= 4096 && !registrations.has(rateKey) || ++rate.count > 30) throw accountError(429, "visit_rate_limit");
        registrations.set(rateKey, rate);
        if (!binding) {
          binding = randomBytes(32).toString("base64url");
          response.setHeader("set-cookie", `${cookieName}=${binding}; Path=/; HttpOnly; SameSite=Strict${
            request.socket?.encrypted || request.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
        }
      }
      const userId = principal?.user.id || null;
      const sourceKey = link ? `link:${link[1]}` : `space:${decodeURIComponent(document[1])}`;
      let spaceId, documentId, linkRevision, publicView = false;
      const sessionActive = async () => {
        if (principal && !await (sharing?.accounts || spaces.accounts).activeSession(principal.sessionId, userId))
          throw accountError(401, "authentication_required");
      };
      const permission = async () => {
        await sessionActive();
        if (link) {
          const value = await sharing.links.view(link[1], userId, { includeContent: false });
          if (value.state !== "read" || linkRevision !== undefined && value.revision !== linkRevision)
            throw accountError(404, "document_link_unavailable");
          if (spaceId && (value.originSpaceId !== spaceId || value.documentId !== documentId)) throw accountError(404, "document_link_unavailable");
          spaceId = value.originSpaceId; documentId = value.documentId; linkRevision = value.revision;
          publicView = value.mode === "public";
          await sessionActive();
          return value.role || "visitor";
        }
        spaceId = decodeURIComponent(document[1]); documentId = decodeURIComponent(document[2]);
        const value = await spaces.requireDocument(userId, spaceId, documentId);
        await sessionActive();
        return value.access.role;
      };
      const authorize = async () => ({
        kind: principal ? "account" : "anonymous", id: userId || binding,
        name: principal?.user.name || "匿名访客", role: await permission()
      });
      const identity = await authorize();
      if (method !== "GET" && method !== "POST" && !binding) throw accountError(404, "visit_expired");
      lease = await acquireRuntime(spaceId);
      const input = { binding, sourceKey, identityKey: principal ? `${userId}:${principal.sessionId}` : binding, authorize };
      let result;
      if (method === "POST") result = await lease.app.registerDocumentVisit(documentId, input);
      else if (method === "PUT") result = await lease.app.renewDocumentVisit(documentId, visitId, input);
      else if (method === "DELETE") result = await lease.app.removeDocumentVisit(documentId, visitId, input);
      else result = {};
      if (method !== "DELETE") {
        const presence = await lease.app.listDocumentVisitors(documentId, { public: publicView, self: identity });
        // Recheck requester authorization after the async visitor collection.
        await permission();
        result = { ...result, ...presence };
      }
      json(response, method === "POST" ? 201 : 200, result, { "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" });
    } catch (error) {
      json(response, error.statusCode || 503, { code: error.statusCode ? error.code : "presence_unavailable" });
    } finally { lease?.release(); }
    return true;
  };
}
