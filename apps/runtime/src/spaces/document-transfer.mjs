import { createHash, randomUUID } from "node:crypto";
import { accountError } from "../accounts/account-policy.mjs";
import { spaceText, integerLimit, validateDocumentAudience } from "./space-policy.mjs";

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;

/** A transfer is an explicitly reviewed new document. It never clones hidden
 * Run logs, personal Memory, private extension settings or unapproved assets. */
export function createDocumentTransfer({ spaces, acquireRuntime }) {
  return async (userId, destinationId, input) => {
    const sourceId = spaceText(input.sourceSpaceId, "Source Space", 256);
    const sourceDocumentId = spaceText(input.sourceDocumentId, "Source document", 256);
    const requestId = spaceText(input.requestId, "Request", 200);
    const title = spaceText(input.title, "Title");
    const mode = input.mode || "copy";
    if (!["copy", "move"].includes(mode) || input.reviewed !== true) throw accountError(400, "document_review_required");
    if (typeof input.markdown !== "string" || Buffer.byteLength(input.markdown) > 4 * 1024 * 1024) {
      throw accountError(400, "invalid_reviewed_document");
    }
    integerLimit(input.sourceRevision);
    integerLimit(input.sourceAclRevision);
    const approved = input.approvedAssetIds || [];
    if (!Array.isArray(approved) || approved.length > 20 || approved.some(id => typeof id !== "string")) {
      throw accountError(400, "invalid_reviewed_assets");
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
    if ((await spaces.member(userId, destinationId)).role === "viewer") throw accountError(403, "document_creation_denied");
    const previous = (await spaces.pool.query(`SELECT * FROM space_document_transfers
      WHERE space_id=$1 AND requester_id=$2 AND request_id=$3`, [destinationId, userId, requestId])).rows[0];
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw accountError(409, "document_transfer_request_conflict");
      return { document: await spaces.requireDocument(userId, destinationId, previous.document_id), duplicate: true };
    }
    await spaces.requireDocument(userId, sourceId, sourceDocumentId, "manage");
    const source = await acquireRuntime(sourceId);
    let destination, staged = [], committed = false;
    try {
      destination = await acquireRuntime(destinationId);
      const original = await spaces.content(sourceId, sourceDocumentId);
      const refs = new Set([...original.text.matchAll(/zion-asset:\/\/([A-Za-z0-9_-]+)/g)].map(m => m[1]));
      if (approved.some(id => !refs.has(id))) throw accountError(400, "asset_not_in_reviewed_source");
      const assets = approved.length ? await source.app.readPublicationAssets(userId, sourceDocumentId, approved) : [];
      staged = assets.length ? await destination.app.stageReviewedAssets(userId, assets) : [];
      const assetIds = new Map(staged.map(asset => [asset.sourceId, asset.id]));
      const markdown = input.markdown.replace(/zion-asset:\/\/([A-Za-z0-9_-]+)/g, (uri, id) =>
        assetIds.has(id) ? `zion-asset://${assetIds.get(id)}` : uri);
      const ids = new Set(staged.map(a => a.id));
      if ([...markdown.matchAll(/zion-asset:\/\/([A-Za-z0-9_-]+)/g)].some(m => !ids.has(m[1]))) {
        throw accountError(400, "document_contains_unapproved_assets");
      }
      const result = await spaces.transactionMany([sourceId, destinationId], async (client, afterCommit) => {
        const prior = (await client.query(`SELECT * FROM space_document_transfers
          WHERE space_id=$1 AND requester_id=$2 AND request_id=$3`, [destinationId, userId, requestId])).rows[0];
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw accountError(409, "document_transfer_request_conflict");
          return { document: await spaces.requireDocument(userId, destinationId, prior.document_id), duplicate: true };
        }
        const d = await spaces.requireDocument(userId, sourceId, sourceDocumentId, "manage", client);
        const current = await spaces.content(sourceId, sourceDocumentId, client);
        if (d.aclRevision !== input.sourceAclRevision || current.revision !== input.sourceRevision) {
          throw accountError(409, "document_review_stale", "原文已变化，请重新检查后分享");
        }
        if (mode === "move" && (await client.query(`SELECT 1 FROM space_run_queue
          WHERE space_id=$1 AND document_id=$2 AND status IN ('queued','running','cancelling','outcome_unknown')`,
          [sourceId, sourceDocumentId])).rowCount) throw accountError(409, "source_document_busy");
        const member = await spaces.member(userId, destinationId, client);
        if (member.role === "viewer") throw accountError(403, "document_creation_denied");
        const policy = await spaces.policy(destinationId, client);
        const members = (await client.query("SELECT user_id FROM account_memberships WHERE space_id=$1 AND status='active'",
          [destinationId])).rows.map(r => r.user_id);
        const groups = (await client.query("SELECT id FROM space_groups WHERE space_id=$1", [destinationId])).rows.map(r => r.id);
        const audience = validateDocumentAudience({
          ...(input.audience || { protection: "restricted", audienceMode: "specific",
            grants: [{ subjectType: "user", subjectId: userId, role: "manager" }] }),
          allowExternal: policy.allowExternal, memberIds: members, groupIds: groups
        });
        for (const g of audience.grants.filter(g => g.subjectType === "user")) {
          const person = await spaces.accounts.getUser(g.subjectId, client);
          if (person?.status !== "active") throw accountError(400, "unknown_person");
        }
        if (policy.kind === "personal" && (audience.protection !== "restricted" || audience.grants.some(g => g.subjectId !== userId))) {
          throw accountError(403, "personal_document_audience_required");
        }
        if (!audience.grants.some(g => g.subjectType === "user" && g.subjectId === userId && g.role === "manager")) {
          audience.grants.push({ subjectType: "user", subjectId: userId, role: "manager" });
        }
        const documentId = `session_${randomUUID()}`, now = spaces.now();
        await spaces.registerDocument(userId, destinationId, documentId, client);
        await client.query(`UPDATE space_documents SET protection=$3,audience_mode=$4 WHERE space_id=$1 AND id=$2`,
          [destinationId, documentId, audience.protection, audience.audienceMode]);
        await client.query("DELETE FROM space_document_grants WHERE space_id=$1 AND document_id=$2", [destinationId, documentId]);
        for (const g of audience.grants) await client.query(`INSERT INTO space_document_grants
          (space_id,document_id,user_id,group_id,role,granted_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [destinationId, documentId, g.subjectType === "user" ? g.subjectId : null, g.subjectType === "group" ? g.subjectId : null, g.role, userId, now]);
        await spaces.bindDocumentAssets(userId, destinationId, documentId, [...ids], client);
        const created = await destination.app.documentStore.createSession({ id: documentId, title, text: markdown },
          { client, afterCommit });
        if (!created.ok) throw accountError(409, "document_transfer_conflict");
        const session = { id: documentId, title, status: "active", metadata: { titleAuto: false }, createdAt: now, updatedAt: now };
        await client.query(`INSERT INTO runtime_sessions (space_id,id,payload_json,status,updated_at) VALUES ($1,$2,$3::jsonb,'active',$4)`,
          [destinationId, documentId, JSON.stringify(session), now]);
        await client.query("INSERT INTO space_document_transfers VALUES ($1,$2,$3,$4,$5,$6)",
          [destinationId, userId, requestId, fingerprint, documentId, now]);
        if (mode === "move") {
          const deleted = await source.app.documentStore.deleteSession(sourceDocumentId, {}, { client, afterCommit });
          if (!deleted.ok) throw accountError(409, "document_move_conflict");
          await client.query(`UPDATE space_documents SET lifecycle='deleted',acl_revision=acl_revision+1,updated_at=$3
            WHERE space_id=$1 AND id=$2`, [sourceId, sourceDocumentId, now]);
          await client.query(`UPDATE space_publications SET status='revoked',revoked_at=$3
            WHERE space_id=$1 AND document_id=$2 AND status='active'`, [sourceId, sourceDocumentId, now]);
          await spaces.invalidateKnowledge(client, sourceId, sourceDocumentId);
          await spaces.emit(client, sourceId, userId, "document.moved", "document", sourceDocumentId);
        }
        await spaces.emit(client, destinationId, userId, "document.imported", "document", documentId);
        return { document: await spaces.requireDocument(userId, destinationId, documentId, "manage", client), mode };
      });
      committed = !result.duplicate;
      return result;
    } finally {
      try {
        if (!committed && staged.length) await destination?.app.discardReviewedAssets(userId, staged.map(a => a.id));
      } finally { destination?.release(); source.release(); }
    }
  };
}
