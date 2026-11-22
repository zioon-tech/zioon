import { accountError } from "../accounts/account-policy.mjs";
import { contentSpaceId } from "../sharing/content-scope.mjs";

/** Authorization and the bytes it protects share the Space's mutation lock.
 * Runtime contexts are produced only by local direct-connection methods. */
export function createSharedCollaborationPersistence({ spaces, store, access, runs }) {
  return async ({ sessionId, context, contributors = [], kind, text }, action) => {
    return spaces.transaction(store.spaceId, async (client, afterCommit) => {
      for (const contributor of new Set([context, ...contributors])) {
        if (contributor?.principal?.kind === "account") {
          const p = contributor.principal;
          if (contentSpaceId(p) !== store.spaceId || contributor.documentId !== sessionId) {
            throw accountError(403, "collaboration_scope_mismatch");
          }
          await access.reauthorize(p, kind === "bootstrap" ? "runtime.read" : "collaboration.write");
          await spaces.requireDocument(p.user.id, store.spaceId, sessionId,
            kind === "bootstrap" ? "view" : "edit", client);
          if (contributor.readOnly && kind !== "bootstrap") throw accountError(403, "collaboration_read_only");
          if (kind !== "checkpoint" && kind !== "bootstrap") {
            await spaces.bindDocumentAssets(p.user.id, store.spaceId, sessionId,
              [...String(text || "").matchAll(/zion-asset:\/\/([A-Za-z0-9_-]+)/g)].map(m => m[1]), client);
          }
        } else if (contributor?.runtimeRunId) {
          const run = await runs.get(contributor.runtimeRunId);
          if (!run || run.sessionId !== sessionId || contentSpaceId(run.principal) !== store.spaceId) {
            throw accountError(403, "collaboration_run_scope_mismatch");
          }
          await access.authorizeRunExecution(run);
          await spaces.requireDocument(run.principal.userId, store.spaceId, sessionId, "edit", client);
          if (text != null) await spaces.bindDocumentAssets(run.principal.userId, store.spaceId, sessionId,
            [...String(text).matchAll(/zion-asset:\/\/([A-Za-z0-9_-]+)/g)].map(m => m[1]), client);
        } else if (contributor?.committedSnapshot === true) {
          const d = (await client.query("SELECT lifecycle FROM space_documents WHERE space_id=$1 AND id=$2",
            [store.spaceId, sessionId])).rows[0];
          if (d?.lifecycle !== "active") throw accountError(404, "document_not_found");
          const snapshot = await store.readSession(sessionId, client);
          if (text != null && String(snapshot?.text || "") !== text) {
            throw accountError(409, "collaboration_snapshot_changed");
          }
        } else {
          throw accountError(403, "collaboration_context_required");
        }
      }
      const result = await action({ client, afterCommit });
      if (kind === "store" && !result?.duplicate) await spaces.invalidateKnowledge(client, store.spaceId, sessionId);
      return result;
    });
  };
}
