import { createHash, randomUUID } from "node:crypto";
import { accountError } from "../accounts/account-policy.mjs";
import { spaceText } from "../spaces/space-policy.mjs";
import { projectPublicCards } from "../../../../src/chat/public-document.mjs";

const find = (node, id) => node?.id === id ? node
  : (node?.children || []).map(child => find(child, id)).find(Boolean);

/** Move a caller-owned document into an editor grant, without cloning account
 * settings, hidden Run records, Memory or private extension metadata. */
export function createSharedFolderTransfer({ sharing, spaces, acquireRuntime }) {
  return async (userId, shareId, input) => {
    const sourceDocumentId = spaceText(input.sourceDocumentId, "Source document", 256);
    const parentId = spaceText(input.id, "Destination folder", 256);
    const token = spaceText(input.operationId, "Operation", 128);
    if (input.sourceRevision !== undefined && (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 1)) {
      throw accountError(400, "invalid_source_revision");
    }
    const requestId = `shared:${createHash("sha256").update(JSON.stringify([userId, shareId, token])).digest("hex")}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([shareId, parentId, sourceDocumentId, input.sourceRevision ?? null])).digest("hex");
    const grant = await sharing.requireGrant(userId, shareId);
    const destinationId = grant.originSpaceId;
    // A received document can never be used as the source, even with a forged
    // sourceSpaceId. Only the caller's own personal space is considered.
    const sourceId = (await sharing.ownerSpace(userId)).id;
    if (sourceId === destinationId) throw accountError(400, "invalid_shared_import");
    const authorizeTarget = async client => {
      const current = await sharing.requireGrant(userId, shareId, client, true);
      if (current.kind !== "folder" || current.role !== "editor" || current.originSpaceId !== destinationId) {
        throw accountError(403, "folder_editor_required", "此操作需要文件夹编辑权限");
      }
      const root = find(await sharing.tree(destinationId, client), current.sourceId);
      if (root?.type !== "folder" || find(root, parentId)?.type !== "folder") {
        throw accountError(404, "shared_folder_not_found");
      }
      return current;
    };
    const duplicate = async client => {
      const prior = (await client.query(`SELECT fingerprint,document_id FROM space_document_transfers
        WHERE space_id=$1 AND requester_id=$2 AND request_id=$3`, [destinationId, userId, requestId])).rows[0];
      if (!prior) return null;
      if (prior.fingerprint !== fingerprint) throw accountError(409, "document_transfer_request_conflict");
      await sharing.documentAccess(userId, destinationId, prior.document_id, "edit", client);
      return { ok: true, id: prior.document_id, type: "session",
        title: (await spaces.content(destinationId, prior.document_id, client)).title, duplicate: true };
    };
    const previous = await sharing.transaction(async client => {
      await authorizeTarget(client);
      return duplicate(client);
    });
    if (previous) return previous;
    const source = await acquireRuntime(sourceId);
    let destination, staged = [], committed = false;
    try {
      destination = await acquireRuntime(destinationId);
      const document = await spaces.requireDocument(userId, sourceId, sourceDocumentId, "manage");
      if (document.createdBy !== userId) throw accountError(403, "source_document_owner_required");
      const original = await spaces.content(sourceId, sourceDocumentId);
      if (input.sourceRevision !== undefined && original.revision !== input.sourceRevision) {
        throw accountError(409, "source_document_changed", "会话已变化，请刷新后重新拖入");
      }
      const cards = JSON.stringify(original.cards || {});
      const refs = [...new Set([...`${original.text}\n${cards}`.matchAll(/zion-asset:\/\/([A-Za-z0-9_-]+)/g)].map(match => match[1]))];
      const assets = refs.length ? await source.app.readPublicationAssets(userId, sourceDocumentId, refs) : [];
      staged = assets.length ? await destination.app.stageReviewedAssets(grant.providerId, assets) : [];
      const assetIds = new Map(staged.map(asset => [asset.sourceId, asset.id]));
      if (refs.some(id => !assetIds.has(id))) throw accountError(400, "source_asset_unavailable", "会话图片不可用，原会话已保留");
      const rewrite = value => value.replace(/zion-asset:\/\/([A-Za-z0-9_-]+)/g,
        (_uri, id) => `zion-asset://${assetIds.get(id)}`);
      const text = rewrite(original.text);
      const annotations = projectPublicCards(text, JSON.parse(rewrite(cards)));
      const result = await spaces.transactionMany([sourceId, destinationId], async (client, afterCommit) => {
        const currentGrant = await authorizeTarget(client);
        // Match owner writes and lock both directories in a stable order.
        await client.query(`SELECT space_id FROM runtime_workbench_state
          WHERE space_id=ANY($1::text[]) ORDER BY space_id FOR UPDATE`, [[sourceId, destinationId].sort()]);
        const prior = await duplicate(client);
        if (prior) return prior;
        await client.query("SELECT id FROM runtime_sessions WHERE space_id=$1 AND id=$2 FOR UPDATE", [sourceId, sourceDocumentId]);
        const currentDocument = await spaces.requireDocument(userId, sourceId, sourceDocumentId, "manage", client);
        const current = await spaces.content(sourceId, sourceDocumentId, client);
        if (currentDocument.createdBy !== userId || currentDocument.aclRevision !== document.aclRevision
          || current.revision !== original.revision || current.text !== original.text || current.title !== original.title
          || JSON.stringify(current.cards || {}) !== cards) {
          throw accountError(409, "source_document_changed", "会话已变化，请刷新后重新拖入");
        }
        const busy = await client.query(`SELECT 1 FROM runtime_runs WHERE space_id=$1
            AND payload_json->>'sessionId'=$2 AND status IN ('created','queued','running','waiting')
          UNION ALL SELECT 1 FROM runtime_conversation_inputs WHERE space_id=$1 AND session_id=$2
            AND status='reserved' AND reserved_until > EXTRACT(EPOCH FROM clock_timestamp()) * 1000
          UNION ALL SELECT 1 FROM space_run_queue WHERE space_id=$1 AND document_id=$2
            AND status IN ('queued','running','cancelling','outcome_unknown') LIMIT 1`, [sourceId, sourceDocumentId]);
        if (busy.rowCount) throw accountError(409, "source_document_busy", "会话正在执行，请结束后再拖入");
        const id = `session_${randomUUID()}`, now = spaces.now(), options = { client, afterCommit };
        await spaces.registerDocument(currentGrant.providerId, destinationId, id, client);
        await spaces.bindDocumentAssets(currentGrant.providerId, destinationId, id, staged.map(asset => asset.id), client);
        const created = await destination.app.documentStore.createSession({
          id, title: original.title, text, parent_id: parentId, meta: { titleAuto: false, annotations }
        }, options);
        if (!created.ok) throw accountError(409, "document_transfer_conflict");
        await client.query(`INSERT INTO runtime_sessions (space_id,id,payload_json,status,updated_at)
          VALUES ($1,$2,$3::jsonb,'active',$4)`, [destinationId, id, JSON.stringify({
          id, title: original.title, status: "active", metadata: { titleAuto: false }, createdAt: now, updatedAt: now
        }), now]);
        const removed = await source.app.documentStore.deleteSession(sourceDocumentId, {
          expected_session_revision: original.revision
        }, options);
        if (!removed.ok) throw accountError(409, "document_move_conflict");
        await client.query(`UPDATE space_documents SET lifecycle='deleted',acl_revision=acl_revision+1,updated_at=$3
          WHERE space_id=$1 AND id=$2`, [sourceId, sourceDocumentId, now]);
        await client.query(`UPDATE space_publications SET status='revoked',revoked_at=$3
          WHERE space_id=$1 AND document_id=$2 AND status='active'`, [sourceId, sourceDocumentId, now]);
        await spaces.invalidateKnowledge(client, sourceId, sourceDocumentId);
        await client.query(`INSERT INTO space_document_transfers
          (space_id,requester_id,request_id,fingerprint,document_id,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [destinationId, userId, requestId, fingerprint, id, now]);
        await spaces.emit(client, sourceId, userId, "document.moved", "document", sourceDocumentId);
        await spaces.emit(client, destinationId, userId, "document.imported", "document", id);
        await sharing.event(client, shareId, userId, "folder.importDocument", { id });
        return { ok: true, id, type: "session", title: original.title };
      });
      committed = !result.duplicate;
      return result;
    } catch (error) {
      // Another request with this token may commit after our first lookup but
      // before the source/asset snapshot. Recheck the receipt before reporting
      // a missing or stale source, while retaining current grant checks.
      if ([404, 409, 410].includes(error.statusCode)) {
        const prior = await sharing.transaction(async client => {
          await authorizeTarget(client);
          return duplicate(client);
        });
        if (prior) return prior;
      }
      throw error;
    } finally {
      try {
        if (!committed && staged.length) await destination?.app.discardReviewedAssets(grant.providerId, staged.map(asset => asset.id));
      } finally { destination?.release(); source.release(); }
    }
  };
}
