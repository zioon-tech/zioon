import { readJson, json } from "../access-control.mjs";
import { accountError } from "../accounts/account-policy.mjs";

export function createSharingHttpHandler({ sharing, models, accessControl, publicBaseUrl, readDocumentPresence, readDocumentVisitors }) {
  const withLink = invitation => ({ ...invitation,
    url: `${publicBaseUrl.replace(/\/$/, "")}/#share=${encodeURIComponent(invitation.token)}` });
  return async (request, response, url) => {
    if (!/^\/v1\/sharing(?:\/|$)/.test(url.pathname)) return false;
    try {
      const principal = await accessControl.requireLogin(request);
      const userId = principal.user.id, method = request.method;
      const parts = url.pathname.slice("/v1/sharing".length).split("/").filter(Boolean).map(decodeURIComponent);
      let result, status = 200;
      if (!parts.length && method === "GET") result = { shares: await sharing.list(userId, url.searchParams.get("direction")) };
      else if (!parts.length && method === "POST") {
        const input = await readJson(request);
        const source = input.kind === "model" ? await models.source(principal, input) : null;
        result = await sharing.create(userId, input, source);
        if (result.invitation) result.invitation = withLink(result.invitation); status = 201;
      } else if (parts[0] === "sources" && method === "GET") result = { sources: await models.sources(principal) };
      else if (parts[0] === "recipients" && parts[1] === "resolve" && parts.length === 2 && method === "POST") {
        await sharing.ownerSpace(userId);
        result = { recipient: await sharing.resolveRecipient(userId, (await readJson(request)).recipient) };
      }
      else if (parts[0] === "content" && parts.length === 1 && method === "GET") result = await sharing.contentIndex(userId);
      else if (parts[0] === "preview" && method === "POST") result = await sharing.preview((await readJson(request)).token);
      else if (parts[0] === "accept" && method === "POST") result = await sharing.accept(userId, (await readJson(request)).token);
      else if (parts[0] === "links" && parts[1] && parts.length === 2 && method === "GET") {
        const view = await sharing.links.view(parts[1], userId);
        if (view.state !== "read" || !view.role) throw accountError(403, "document_access_required");
        result = { documentId: view.documentId, originSpaceId: view.originSpaceId, title: view.title, role: view.role };
      }
      else if (parts[0] === "documents" && parts[1] && parts[2] === "link" && parts.length === 3 && ["GET", "PUT"].includes(method)) {
        result = method === "GET" ? await sharing.links.get(userId, parts[1])
          : await sharing.links.set(userId, parts[1], (await readJson(request)).mode);
        if (result.link) result.link.url = `${publicBaseUrl.replace(/\/$/, "")}/share/${result.link.id}`;
      }
      else if (parts[0] === "documents" && parts[1] && parts[2] === "requests" && parts.length === 3 && method === "GET") {
        result = await sharing.links.requests(userId, parts[1]);
      }
      else if (parts[0] === "documents" && parts[1] && parts[2] === "requests" && parts[3] && parts.length === 4 && method === "PUT") {
        result = await sharing.links.decide(userId, parts[1], parts[3], await readJson(request));
      }
      else if (parts[0] === "documents" && parts[1] && parts[2] === "participants" && parts.length === 3 && method === "GET") {
        const origin = url.searchParams.get("origin") || (await sharing.accounts.personalSpace(userId)).id;
        result = await sharing.documentParticipants(userId, origin, parts[1]);
        let online = null, presence;
        if (readDocumentVisitors) {
          try {
            presence = await readDocumentVisitors(origin, parts[1], { kind: "account", id: userId });
            online = new Set(presence.visitors.filter(person => person.accountId).map(person => person.accountId));
          } catch { presence = { visitors: [], selfVisitorId: null }; }
          result = await sharing.documentParticipants(userId, origin, parts[1]);
        } else if (result.participants.length > 1 && readDocumentPresence) {
          try { online = new Set(await readDocumentPresence(origin, parts[1])); }
          catch { /* A failed presence lookup must not claim that someone is offline. */ }
          // The socket lookup can await reauthorization; filter grants again after it.
          result = await sharing.documentParticipants(userId, origin, parts[1]);
        }
        result.participants = result.participants.map(person => ({ ...person,
          online: online === null ? null : online.has(person.id) }));
        if (readDocumentVisitors) {
          const grants = new Map(result.participants.map(person => [person.id, person]));
          result = { ...result, selfVisitorId: presence.selfVisitorId,
            visitors: presence.visitors.map(person => {
              const grant = grants.get(person.accountId);
              return grant ? { ...grant, online: true } : {
                id: person.id, name: person.name, role: "viewer", inherited: false, online: true, visitor: true
              };
            }) };
        }
      }
      else if (parts[0] === "documents" && parts[1] && parts[2] === "privacy" && method === "GET") {
        result = await sharing.documentPrivacy(userId, parts[1]);
      }
      else if (parts[0] === "documents" && parts[1] && parts[2] === "privacy" && method === "PUT") {
        result = await sharing.setPrivate(userId, parts[1], (await readJson(request)).private);
      } else if (parts[0] === "documents" && parts[1] && parts[2] === "collaborators" && parts[3] && parts.length === 4 && method === "PUT") {
        result = await sharing.updateDocumentCollaborator(userId, parts[1], parts[3], (await readJson(request)).role);
      } else if (parts[0] === "resources" && parts[1] && parts[2] && parts[3] === "collaborators" && parts[4] && parts.length === 5 && method === "PUT") {
        result = await sharing.updateSourceCollaborator(userId, parts[1], parts[2], parts[4], (await readJson(request)).role);
      } else if (parts[0] && parts[1] === "recipients" && parts.length === 2 && method === "POST") {
        result = await sharing.addRecipient(userId, parts[0], await readJson(request)); status = 201;
      } else if (parts[0] && parts[1] === "recipients" && parts[2] && parts.length === 3 && method === "PUT") {
        result = await sharing.updateRecipient(userId, parts[0], parts[2], (await readJson(request)).role);
      } else if (parts[0] && parts[1] === "invitations" && method === "POST") {
        result = { invitation: withLink(await sharing.invite(userId, parts[0], await readJson(request))) }; status = 201;
      } else if (parts[0] && parts[1] === "revoke" && method === "POST") result = await sharing.revoke(userId, parts[0], await readJson(request));
      else if (parts[0] && parts[1] === "leave" && method === "POST") result = await sharing.leave(userId, parts[0]);
      else if (parts[0] && parts[1] === "documents" && method === "GET") result = await sharing.folderDocuments(userId, parts[0]);
      else if (parts[0] && !parts[1] && method === "DELETE") result = await sharing.revoke(userId, parts[0]);
      else throw accountError(404, "sharing_endpoint_not_found");
      json(response, status, result);
    } catch (error) {
      json(response, error.statusCode || 500, { code: error.statusCode ? error.code : "sharing_operation_failed",
        error: error.statusCode ? error.message : "分享操作失败，请稍后重试" });
    }
    return true;
  };
}
