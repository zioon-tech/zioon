import { randomBytes } from "node:crypto";
import { accountError } from "../accounts/account-policy.mjs";
const expired = () => accountError(404, "visit_expired");

/** Only HTTP reading leases are stored here. Socket presence stays in Hocuspocus. */
export function createDocumentVisitorRegistry({ now = Date.now, ttlMs = 45000, maxVisits = 2048, maxDocumentVisits = 100 } = {}) {
  const visits = new Map();
  let closed = false;
  const prune = () => {
    for (const [id, visit] of visits) if (visit.expiresAt <= now()) visits.delete(id);
  };
  const timer = setInterval(prune, 3000); timer.unref?.();
  const owned = (documentId, id, binding, identityKey, sourceKey) => {
    const visit = visits.get(id);
    if (closed || !visit || visit.expiresAt <= now() || visit.documentId !== documentId ||
      visit.binding !== binding || visit.identityKey !== identityKey || visit.sourceKey !== sourceKey) throw expired();
    return visit;
  };
  const validate = async visit => {
    try {
      const identity = await visit.authorize();
      if (closed || visits.get(visit.id) !== visit || visit.expiresAt <= now()) throw expired();
      return identity;
    } catch (error) {
      if ([401, 403, 404].includes(error.statusCode)) visits.delete(visit.id);
      throw error;
    }
  };
  return {
    async register(documentId, input) {
      if (closed) throw expired();
      const identity = await input.authorize();
      prune();
      if (visits.size >= maxVisits || [...visits.values()].filter(visit => visit.documentId === documentId).length >= maxDocumentVisits)
        throw accountError(429, "document_visit_limit");
      if (closed) throw expired();
      const id = randomBytes(32).toString("base64url");
      const visit = { ...input, id, documentId, identity, expiresAt: now() + ttlMs };
      visits.set(id, visit);
      return { visitId: id, ttlMs };
    },
    async renew(documentId, id, input) {
      const visit = owned(documentId, id, input.binding, input.identityKey, input.sourceKey);
      visit.identity = await validate(visit);
      visit.expiresAt = now() + ttlMs;
      return { visitId: id, ttlMs };
    },
    remove(documentId, id, input) {
      const visit = visits.get(id);
      if (visit && visit.documentId === documentId && visit.binding === input.binding &&
        visit.identityKey === input.identityKey && visit.sourceKey === input.sourceKey) visits.delete(id);
      return { removed: true };
    },
    async list(documentId) {
      prune();
      const identities = [];
      for (const visit of visits.values()) {
        if (visit.documentId !== documentId) continue;
        try { identities.push(await validate(visit)); }
        catch (error) { if (![401, 403, 404].includes(error.statusCode)) throw error; }
      }
      return identities;
    },
    close() { closed = true; clearInterval(timer); visits.clear(); }
  };
}
