import { accountError } from "../accounts/account-policy.mjs";

const sharedId = (node) => `shared-${node.type === "folder" ? "folder" : "document"}:${encodeURIComponent(node.originSpaceId)}:${encodeURIComponent(node.id)}`;
const provenance = node => ({
  received: true, originSpaceId: node.originSpaceId, documentId: node.id,
  providerName: node.providerName, role: node.role
});

/** The tool sees the same received hierarchy as the sidebar, with qualified IDs.
 * Foreign content is read through a fresh document grant, never an owner's catalog. */
export function createSessionManagerSharingService({ store, sharing, principal, readSharedSession }) {
  if (!sharing || principal?.contentScope || principal?.space?.kind !== "personal") return store;
  const userId = principal.user.id;
  const methods = {
    async readSnapshot() {
      const own = await store.readSnapshot() || {};
      const snapshot = own.snapshot || own;
      const index = [...(snapshot.index || [])];
      const project = node => {
        const value = { ...node, id: sharedId(node), sharing: provenance(node) };
        if (node.type === "folder") value.children = (node.children || []).map(project);
        else index.push({ id: value.id, title: node.title, updatedAt: node.updatedAt, sharing: value.sharing });
        return value;
      };
      const received = (await sharing.contentIndex(userId)).received.map(project);
      const value = { ...snapshot, index, tree: {
        ...(snapshot.tree || { id: "root", type: "folder", title: "Sessions" }),
        children: [...(snapshot.tree?.children || []), ...received]
      } };
      return own.snapshot ? { ...own, snapshot: value } : value;
    },
    async readSession(id) {
      if (!String(id).startsWith("shared-document:")) return store.readSession(id);
      const match = /^shared-document:([^:]+):([^:]+)$/.exec(id);
      if (!match) throw accountError(400, "invalid_shared_document_id");
      let originSpaceId, documentId;
      try { originSpaceId = decodeURIComponent(match[1]); documentId = decodeURIComponent(match[2]); }
      catch { throw accountError(400, "invalid_shared_document_id"); }
      const grant = await sharing.documentAccess(userId, originSpaceId, documentId, "view");
      const record = await readSharedSession({ ...principal,
        contentScope: { originSpaceId, documentId, ownerId: grant.ownerId } }, documentId);
      return record && { ...record, id, sharing: {
        received: true, originSpaceId, documentId, role: grant.role
      } };
    }
  };
  return new Proxy(store, { get(target, key) {
    return methods[key] || (typeof target[key] === "function" ? target[key].bind(target) : target[key]);
  } });
}
