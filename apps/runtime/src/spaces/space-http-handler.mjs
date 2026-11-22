import { readJson, json } from "../access-control.mjs";
import { accountError } from "../accounts/account-policy.mjs";
import { spaceText } from "./space-policy.mjs";
import { renderPublication } from "./publication-renderer.mjs";
import { documentReaderPayload } from "../sharing/document-reader.mjs";
const route = (path) => {
  const match = path.match(/^\/v1\/spaces\/([^/]+)(?:\/(.*))?$/);
  return match ? { spaceId: decodeURIComponent(match[1]), tail: match[2] || "" } : null;
};

/** Management and single-document guest endpoints live on the platform.
 * Guests never enter a general Space Runtime or its catalog/search paths. */
export function createSpaceHttpHandler({ spaces, execution, accessControl, broker = null, resolveSource = null, abortRun = null, readPublicationAssets = null, readDocumentAsset = null, transferDocument = null }) {
  return async (request, response, url) => {
    const publicMatch = url.pathname.match(/^\/(?:p|v1\/publications)\/([A-Za-z0-9_-]{32})$/);
    const publicAsset = url.pathname.match(/^\/p\/([A-Za-z0-9_-]{32})\/assets\/([A-Za-z0-9_-]{24})$/);
    const parsed = route(url.pathname);
    const contactPath = url.pathname.match(/^\/v1\/contacts(?:\/([^/]+))?$/);
    const acceptance = url.pathname === "/v1/space-invitations/accept";
    if (!publicMatch && !publicAsset && !parsed && !contactPath && !acceptance) return false;
    try {
      if (publicAsset && request.method === "GET") {
        const asset = await spaces.publicationAsset(publicAsset[1], publicAsset[2]);
        response.writeHead(200, { "content-type": asset.mediaType, "content-length": asset.content.length,
          "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow",
          "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; sandbox" });
        response.end(asset.content);
        return true;
      }
      if (publicMatch && request.method === "GET") {
        const publication = await spaces.publication(publicMatch[1]);
        if (url.pathname.startsWith("/v1/")) {
          json(response, 200, publication, { "x-robots-tag": "noindex, nofollow" });
        } else {
          const body = renderPublication(publication);
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
            "x-robots-tag": "noindex, nofollow", "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'",
            "referrer-policy": "no-referrer" });
          response.end(body);
        }
        return true;
      }
      const principal = await accessControl.requireLogin(request);
      const userId = principal.user.id, method = request.method;
      const body = async () => readJson(request);
      let result, status = 200;
      if (contactPath) {
        const contactId = contactPath[1] ? decodeURIComponent(contactPath[1]) : null;
        if (method === "GET" && !contactId) result = { contacts: await spaces.contacts(userId), contactCode: userId };
        else if (method === "POST" && !contactId) { result = { contact: await spaces.addContact(userId, (await body()).contactId) }; status = 201; }
        else if (method === "DELETE" && contactId) result = await spaces.removeContact(userId, contactId);
        else throw accountError(404, "space_endpoint_not_found");
      } else if (acceptance && method === "POST") {
        result = await spaces.acceptInvitation(userId, (await body()).token);
      } else if (parsed) {
        const { spaceId, tail } = parsed;
        spaceText(spaceId, "Space", 256);
        const parts = tail.split("/").map(decodeURIComponent);
        const object = parts[0], objectId = parts[1], operation = parts[2];
        if (method === "GET" && !tail) result = await spaces.describe(userId, spaceId);
        else if (method === "PATCH" && !tail) result = { space: await spaces.updatePolicy(userId, spaceId, await body()) };
        else if (object === "members" && !objectId && method === "GET") result = { members: await spaces.members(userId, spaceId) };
        else if (object === "members" && objectId && method === "PATCH") {
          const input = await body();
          if (input.role === "owner") throw accountError(400, "use_ownership_transfer");
          const actor = await spaces.member(userId, spaceId, spaces.pool, true);
          const target = await spaces.accounts.membership(objectId, spaceId);
          if (actor.role !== "owner" && (input.role === "admin" || target?.role === "admin")) throw accountError(403, "owner_required");
          result = { membership: await spaces.accounts.setMember(userId, objectId, input, spaceId) };
        } else if (object === "invitations" && !objectId && method === "GET") result = { invitations: await spaces.invitations(userId, spaceId) };
        else if (object === "invitations" && !objectId && method === "POST") { result = { invitation: await spaces.invite(userId, spaceId, await body()) }; status = 201; }
        else if (object === "invitations" && objectId && method === "DELETE") result = await spaces.revokeInvitation(userId, spaceId, objectId);
        else if (object === "groups" && !objectId && method === "GET") result = { groups: await spaces.groups(userId, spaceId) };
        else if (object === "groups" && !objectId && method === "POST") { result = { group: await spaces.saveGroup(userId, spaceId, null, await body()) }; status = 201; }
        else if (object === "groups" && objectId && method === "PUT") result = { group: await spaces.saveGroup(userId, spaceId, objectId, await body()) };
        else if (object === "groups" && objectId && method === "DELETE") result = await spaces.deleteGroup(userId, spaceId, objectId);
        else if (object === "capabilities" && !objectId && method === "GET") result = { capabilities: await spaces.bindings(userId, spaceId) };
        else if (object === "sources" && !objectId && method === "GET") {
          await spaces.member(userId, spaceId, spaces.pool, true);
          result = { sources: await broker.listSources(principal, url.searchParams.get("origin")) };
        }
        else if (object === "capabilities" && !objectId && method === "POST") {
          const input = await body();
          if (!resolveSource) throw accountError(503, "capability_broker_unavailable");
          const source = await resolveSource(principal, input);
          result = { capability: await spaces.createBinding(userId, spaceId, input, source) }; status = 201;
        } else if (object === "capabilities" && objectId && method === "PATCH") result = { capability: await spaces.updateBinding(userId, spaceId, objectId, await body()) };
        else if (object === "usage" && !objectId && method === "GET") result = await execution.usage(userId, spaceId);
        else if (object === "usage" && objectId === "reconcile" && method === "POST") result = await execution.reconcile(userId, spaceId);
        else if (object === "budgets" && !objectId && method === "PUT") result = { budget: await execution.setBudget(userId, spaceId, await body()) };
        else if (object === "knowledge" && !objectId && method === "GET") result = { sources: await spaces.knowledge(userId, spaceId, {
          destinationId: url.searchParams.get("document"), query: url.searchParams.get("q") || ""
        }) };
        else if (object === "knowledge" && objectId && method === "DELETE") result = await spaces.revokeKnowledge(userId, spaceId, objectId);
        else if (object === "publications" && objectId && method === "DELETE") result = await spaces.revokePublication(userId, spaceId, objectId);
        else if (object === "ownership" && !objectId && method === "GET") result = { transfers: await spaces.ownershipOffers(userId, spaceId) };
        else if (object === "ownership" && !objectId && method === "POST") { result = { transfer: await spaces.transferOwnership(userId, spaceId, (await body()).toUserId) }; status = 201; }
        else if (object === "ownership" && objectId && operation === "accept" && method === "POST") result = await spaces.acceptOwnership(userId, spaceId, objectId);
        else if (object === "audit" && !objectId && method === "GET") result = { events: await spaces.audit(userId, spaceId, {
          after: url.searchParams.get("after") || 0, documentId: url.searchParams.get("document")
        }) };
        else if (object === "documents" && objectId === "transfer" && method === "POST") {
          result = await transferDocument(userId, spaceId, await body()); status = result.duplicate ? 200 : 201;
        }
        else if (object === "documents" && objectId) {
          if (method === "GET" && operation === "assets" && parts[3] && readDocumentAsset) {
            const asset = await readDocumentAsset(userId, spaceId, objectId, parts[3]);
            response.writeHead(200, { "content-type": asset.mediaType, "content-length": asset.content.length,
              "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
              "content-security-policy": "default-src 'none'; sandbox" });
            response.end(asset.content);
            return true;
          } else if (method === "GET" && !operation) {
            await spaces.requireDocument(userId, spaceId, objectId);
            const content = await spaces.content(spaceId, objectId);
            // Recheck after the content await before delivering any body.
            const access = await spaces.documentAccess(userId, spaceId, objectId);
            result = { ...access, content, reader: documentReaderPayload({ state: "read", title: content.title,
              markdown: content.text, cards: content.cards, contentRevision: String(content.revision),
              updatedAt: content.updatedAt, mode: "restricted", role: access.access.role,
              originSpaceId: spaceId, documentId: objectId }) };
          } else if (operation === "access" && method === "GET") result = await spaces.documentAccess(userId, spaceId, objectId);
          else if (operation === "access" && method === "PUT") result = await spaces.updateDocumentAccess(userId, spaceId, objectId, await body());
          else if (operation === "comments" && method === "GET") result = { comments: await spaces.comments(userId, spaceId, objectId) };
          else if (operation === "comments" && method === "POST") { result = { comment: await spaces.comment(userId, spaceId, objectId, (await body()).body) }; status = 201; }
          else if (operation === "comments" && parts[3] && method === "DELETE") result = await spaces.deleteComment(userId, spaceId, objectId, parts[3]);
          else if (operation === "knowledge" && method === "POST") { result = { source: await spaces.chooseKnowledge(userId, spaceId, objectId, await body()) }; status = 201; }
          else if (operation === "publications" && method === "GET") result = { publications: await spaces.publications(userId, spaceId, objectId) };
          else if (operation === "publications" && method === "POST") {
            const input = await body();
            await spaces.requireDocument(userId, spaceId, objectId, "manage");
            const assets = input.approvedAssetIds?.length ? await readPublicationAssets?.(principal, objectId, input.approvedAssetIds) : [];
            result = { publication: await spaces.publish(userId, spaceId, objectId, input, assets || []) }; status = 201;
          }
          else if (operation === "queue" && method === "GET") result = { queue: await execution.listQueue(userId, spaceId, objectId) };
          else throw accountError(404, "space_endpoint_not_found");
        } else if (object === "queue" && objectId && method === "DELETE") {
          const item = await execution.cancel(userId, spaceId, objectId);
          if (item.status === "cancelling") await abortRun?.(spaceId, objectId);
          result = { queue: item };
        } else throw accountError(404, "space_endpoint_not_found");
      } else throw accountError(404, "space_endpoint_not_found");
      json(response, status, result);
    } catch (error) {
      json(response, error.statusCode || 500, { code: error.statusCode ? error.code : "space_operation_failed",
        error: error.statusCode ? error.message : "空间操作失败，请稍后重试" });
    }
    return true;
  };
}
