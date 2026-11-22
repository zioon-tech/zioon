import { accountError } from "../accounts/account-policy.mjs";
import { mergeSessionTree } from "../session-tree-merge.mjs";
import { randomUUID, createHash } from "node:crypto";
import { contentSpaceId } from "../sharing/content-scope.mjs";

const sessionIds = (tree) => tree?.type === "session" ? [tree.id] : (tree?.children || []).flatMap(sessionIds);
const pruneTree = (tree, allowed) => {
  if (!tree) return tree;
  if (tree.type === "session") return allowed.has(tree.id) ? tree : null;
  const children = (tree.children || []).map((child) => pruneTree(child, allowed)).filter(Boolean);
  return tree.id === "root" || children.length || !(tree.children || []).length ? { ...tree, children } : null;
};

/** A request-local view; never store an interactive user on a shared store. */
export function createAuthorizedWorkbenchStore({ store, spaces, principal }) {
  if (!spaces || principal?.kind !== "account") return store;
  const userId = principal.user.id, spaceId = contentSpaceId(principal);
  if (store.spaceId !== spaceId) throw accountError(409, "space_store_mismatch");
  const shared = principal.space.kind === "team";
  const operation = (input, action, id = "") => !input?.operation_id ? input : {
    ...input, operation_id: createHash("sha256")
      .update(JSON.stringify([userId, action, id, input.operation_id])).digest("hex")
  };
  const atomicResult = async callback => {
    try {
      return await spaces.transaction(spaceId, async (client, afterCommit) => {
        const result = await callback(client, afterCommit);
        if (result?.ok === false) throw { workbenchConflict: true, result };
        return result;
      });
    } catch (error) {
      if (error?.workbenchConflict) return error.result;
      throw error;
    }
  };
  const allowed = async () => new Set(await spaces.readableIds(userId, spaceId));
  const project = (result, ids) => {
    if (!result) return result;
    const value = { ...result };
    if (value.tree) value.tree = pruneTree(value.tree, ids);
    if (value.index) value.index = value.index.filter((entry) => ids.has(typeof entry === "string" ? entry : entry.id));
    for (const key of ["docs", "metas", "sessions", "tombstones"]) {
      if (value[key]) value[key] = value[key].filter((entry) => ids.has(entry.id));
    }
    if (shared && value.kv) value.kv = {};
    if (value.snapshot) value.snapshot = project(value.snapshot, ids);
    if (value.catalog) value.catalog = project(value.catalog, ids);
    return value;
  };
  const mutate = (documentId, action, callback) => spaces.transaction(spaceId, async (client, afterCommit) => {
    await spaces.requireDocument(userId, spaceId, documentId, action, client);
    return callback(client, afterCommit);
  });
  if (principal.contentScope) {
    const documentId = principal.contentScope.documentId;
    const exact = id => { if (id !== documentId) throw accountError(403, "content_document_mismatch"); };
    const contentRecord = record => !record ? record : { ...record, sharedContent: true,
      meta: Object.fromEntries(Object.entries(record.meta || {}).filter(([key]) =>
        ["id", "title", "createdAt", "updatedAt", "size", "hash", "titleAuto"].includes(key))) };
    const scoped = {
      async readSession(id) {
        exact(id); await spaces.requireDocument(userId, spaceId, id);
        const record = await store.readSession(id);
        return contentRecord(record);
      },
      async listSessionRevisions(id) { exact(id); await spaces.requireDocument(userId, spaceId, id); return store.listSessionRevisions(id); },
      async updateSession(id, input) {
        exact(id);
        // Collaborators edit content; model defaults and private metadata remain account owned.
        const allowed = Object.fromEntries(Object.entries(input || {}).filter(([key]) =>
          ["text", "expected_revision", "expected_session_revision", "base_text", "operation_id", "source_client_id", "reason"].includes(key)));
        return atomicResult(async (client, afterCommit) => {
          await spaces.requireDocument(userId, spaceId, id, "edit", client);
          if (allowed.text != null) await spaces.bindDocumentAssets(userId, spaceId, id,
            [...String(allowed.text).matchAll(/zion-asset:\/\/([A-Za-z0-9_-]+)/g)].map(m => m[1]), client);
          return contentRecord(await store.updateSession(id, operation(allowed, "update", id), { client, afterCommit }));
        });
      },
      async restoreSessionRevision(id, revision, operationId) {
        exact(id);
        return mutate(id, "edit", async (client, afterCommit) => contentRecord(await store.restoreSessionRevision(id, revision,
          operation({ operation_id: operationId }, "restore", id).operation_id, { client, afterCommit })));
      },
      async listEvents(after, options) {
        exact(options?.sessionId);
        await spaces.requireDocument(userId, spaceId, documentId);
        const feed = await store.listEvents(after, options);
        return { ...feed, events: feed.events.filter(e => e.sessionId === documentId) };
      }
    };
    return new Proxy(store, { get(target, key) {
      if (Object.hasOwn(scoped, key)) return scoped[key];
      if (typeof target[key] === "function") return () => { throw accountError(403, "content_endpoint_denied"); };
      return target[key];
    } });
  }
  const methods = {
    async createSession(input) {
      input = operation(input, "create");
      const documentId = input?.id || (input?.operation_id ? `session_${input.operation_id}` : `session_${randomUUID()}`);
      return atomicResult(async (client, afterCommit) => {
        const previous = await store.duplicateOperation(input?.operation_id, client);
        if (previous) {
          await spaces.requireDocument(userId, spaceId, previous.id, "edit", client);
          return previous;
        }
        await spaces.registerDocument(userId, spaceId, documentId, client);
        const result = await store.createSession({ ...input, id: documentId }, { client, afterCommit });
        if (result.ok && input?.text != null) await spaces.bindDocumentAssets(userId, spaceId, documentId,
          [...String(input.text).matchAll(/zion-asset:\/\/([A-Za-z0-9_-]+)/g)].map(m => m[1]), client);
        return result;
      });
    },
    async readSnapshot() { return project(await store.readSnapshot(), await allowed()); },
    async readCatalog(options) { return project(await store.readCatalog(options), await allowed()); },
    async readTree() { return project(await store.readTree(), await allowed()); },
    async readStatus() {
      const value = await store.readStatus(), ids = await allowed();
      return { ...value, documents: ids.size, metadata: ids.size };
    },
    async searchSessions(options) { return store.searchSessions({ ...options, allowedSessionIds: [...await allowed()] }); },
    async readSession(documentId) {
      await spaces.requireDocument(userId, spaceId, documentId);
      const record = await store.readSession(documentId);
      return record && spaces.sharing ? { ...record, sharedContent: await spaces.sharing.sharedMemory(spaceId, documentId) } : record;
    },
    async listSessionRevisions(documentId) {
      await spaces.requireDocument(userId, spaceId, documentId);
      return store.listSessionRevisions(documentId);
    },
    async listEvents(after, options) {
      if (options?.sessionId) await spaces.requireDocument(userId, spaceId, options.sessionId);
      const feed = await store.listEvents(after, options), ids = await allowed();
      return { ...feed, cursor: feed.events.at(-1)?.sequence || Number(after) || 0,
        events: feed.events.flatMap((event) => {
          if (event.sessionId) return ids.has(event.sessionId) ? [event] : [];
          // Global tree/metadata events can contain names and IDs of hidden docs.
          return [{ sequence: event.sequence, type: "catalog.changed", createdAt: event.createdAt }];
        }) };
    },
    async updateSession(documentId, input) {
      input = operation(input, "update", documentId);
      return atomicResult(async (client, afterCommit) => {
        await spaces.registerDocument(userId, spaceId, documentId, client);
        if (input.text != null) await spaces.bindDocumentAssets(userId, spaceId, documentId,
          [...String(input.text).matchAll(/zion-asset:\/\/([A-Za-z0-9_-]+)/g)].map((match) => match[1]), client);
        const result = await store.updateSession(documentId, input, { client, afterCommit });
        if (result.ok) await spaces.invalidateKnowledge(client, spaceId, documentId);
        return result;
      });
    },
    async deleteSession(documentId, input) {
      input = operation(input, "delete", documentId);
      return mutate(documentId, "manage", async (client, afterCommit) => {
        const result = await store.deleteSession(documentId, input, { client, afterCommit });
        if (!result.ok) return result;
        await client.query(`UPDATE space_documents SET lifecycle='deleted',acl_revision=acl_revision+1,updated_at=$3
          WHERE space_id=$1 AND id=$2`, [spaceId, documentId, spaces.now()]);
        await spaces.invalidateKnowledge(client, spaceId, documentId);
        await client.query(`UPDATE space_publications SET status='revoked',revoked_at=$3
          WHERE space_id=$1 AND document_id=$2 AND status='active'`, [spaceId, documentId, spaces.now()]);
        await spaces.emit(client, spaceId, userId, "document.deleted", "document", documentId);
        return result;
      });
    },
    async restoreSessionRevision(documentId, revision, operationId) {
      operationId = operation({ operation_id: operationId }, "restore", documentId).operation_id;
      return mutate(documentId, "edit", async (client, afterCommit) => {
        const result = await store.restoreSessionRevision(documentId, revision, operationId, { client, afterCommit });
        if (result.ok) await spaces.invalidateKnowledge(client, spaceId, documentId);
        return result;
      });
    },
    async writeTree(tree, index, expectedRevision, sourceClientId, baseTree) {
      return spaces.transaction(spaceId, async (client, afterCommit) => {
        const member = await spaces.member(userId, spaceId, client);
        if (member.role === "viewer") throw accountError(403, "tree_edit_denied");
        for (const documentId of new Set([...sessionIds(tree), ...sessionIds(baseTree)])) {
          await spaces.requireDocument(userId, spaceId, documentId, "edit", client);
        }
        const current = await store.readTree(client);
        const ids = new Set(await spaces.readableIds(userId, spaceId, client));
        const base = baseTree || pruneTree(current.tree, ids);
        // Removing a visible folder must not detach somebody else's hidden file.
        const next = mergeSessionTree(base, tree, current.tree);
        const preserved = new Set(sessionIds(next));
        if (sessionIds(current.tree).some((documentId) => !ids.has(documentId) && !preserved.has(documentId))) {
          throw accountError(409, "folder_contains_unavailable_documents");
        }
        return project(await store.writeTree(next, index, current.revision, sourceClientId, current.tree,
          { client, afterCommit }), ids);
      });
    },
    async readKV(key) {
      if (shared) throw accountError(404, "key_not_found");
      return store.readKV(key);
    },
    async writeKV(key, ...args) {
      if (shared) throw accountError(409, "use_scoped_space_settings");
      return store.writeKV(key, ...args);
    },
    async writeSnapshot(snapshot, expectedRevision, sourceClientId) {
      if (shared) throw accountError(409, "use_document_updates");
      return atomicResult(async (client, afterCommit) => {
        for (const d of snapshot?.docs || []) {
          await spaces.registerDocument(userId, spaceId, d.id, client);
          await spaces.bindDocumentAssets(userId, spaceId, d.id,
            [...String(d.text || "").matchAll(/zion-asset:\/\/([A-Za-z0-9_-]+)/g)].map(m => m[1]), client);
        }
        return store.writeSnapshot(snapshot, expectedRevision, sourceClientId, { client, afterCommit });
      });
    },
    async migrateBrowserStorage(sourceId, snapshot, fingerprint) {
      if (shared) throw accountError(409, "personal_import_only");
      return atomicResult(async (client, afterCommit) => {
        const result = await store.migrateBrowserStorage(sourceId, snapshot, fingerprint, { client, afterCommit });
        for (const documentId of result.imported || []) {
          await spaces.registerDocument(userId, spaceId, documentId, client);
          const d = await store.readSession(documentId, client);
          await spaces.bindDocumentAssets(userId, spaceId, documentId,
            [...String(d?.text || "").matchAll(/zion-asset:\/\/([A-Za-z0-9_-]+)/g)].map(m => m[1]), client);
        }
        return result;
      });
    }
  };
  return new Proxy(store, { get(target, property) {
    if (Object.hasOwn(methods, property)) return methods[property];
    const value = target[property];
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
