import { createHash, randomBytes, randomUUID } from "node:crypto";
import { projectPublicCards } from "../../../../src/chat/public-document.mjs";
import { hydrateSessionCardMetadata } from "../session-card-bodies.mjs";
import { accountError } from "../accounts/account-policy.mjs";
import {
  activeMember, isSpaceManager, spaceText, validateDocumentAudience,
  requireDocumentAccess, effectiveDocumentAccess, requireSpaceExecution,
  bindingProjection, publicProjection, invitationRecipient, integerLimit,
  sourceAllowsAudience
} from "./space-policy.mjs";

const DAY = 86_400_000;
const makeId = (kind) => `${kind}:${randomUUID()}`;
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const num = (value) => value == null ? null : Number(value);
const revision = (value) => integerLimit(value);
const ttl = (value = 7 * DAY) => integerLimit(value, { minimum: 60_000, maximum: 30 * DAY });
const doc = (r) => r && ({
  id: r.id, spaceId: r.space_id, createdBy: r.created_by, protection: r.protection,
  audienceMode: r.audience_mode, lifecycle: r.lifecycle, aclRevision: num(r.acl_revision),
  createdAt: num(r.created_at), updatedAt: num(r.updated_at)
});
const grant = (r) => ({
  subjectType: r.subject_type, subjectId: r.subject_id, role: r.role,
  expiresAt: num(r.expires_at)
});
const binding = (r) => r && ({
  id: r.id, spaceId: r.space_id, providerId: r.provider_id, originSpaceId: r.origin_space_id,
  originResourceId: r.origin_resource_id, kind: r.kind, name: r.name, description: r.description,
  sourceVersion: r.source_version, status: r.status, audienceMode: r.audience_mode,
  limits: r.ceiling_json, allowedTools: r.ceiling_json.allowedTools || [],
  revision: num(r.revision), expiresAt: num(r.expires_at)
});

/**
 * Authoritative relationships and governance. Every mutation of a Space uses
 * the same transaction lock, including legacy account membership mutations.
 * Content stays in the existing Workbench/Runtime stores.
 */
export class PostgresSharedSpaceStore {
  constructor({ accounts, pool = accounts?.pool, now = () => Date.now() }) {
    if (!pool || !accounts) throw new Error("Shared Spaces require PostgreSQL accounts");
    Object.assign(this, { accounts, pool, now });
  }

  async transaction(spaceId, action) {
    return this.transactionMany([spaceId], action);
  }

  async transactionMany(spaceIds, action) {
    const ids = [...new Set(spaceIds.map(id => spaceText(id, "Space", 256)))].sort();
    const afterCommit = [];
    const result = await this.accounts.transaction(async (client) => {
      for (const id of ids) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`shared-space:${id}`]);
      return action(client, afterCommit);
    }).catch(error => {
      for (const callback of afterCommit) callback.rollback?.();
      throw error;
    });
    for (const callback of afterCommit) callback();
    return result;
  }

  async member(userId, spaceId, client = this.pool, manage = false) {
    const membership = await this.accounts.membership(userId, spaceId, client);
    if (!activeMember(membership) || (manage && !isSpaceManager(membership))) {
      throw accountError(403, manage ? "space_management_required" : "space_membership_required");
    }
    return membership;
  }

  async emit(client, spaceId, actorId, action, objectType, objectId, version = 1, details = {}) {
    await client.query(`INSERT INTO space_authorization_outbox
      (space_id,actor_id,action,object_type,object_id,revision,details_json,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [spaceId, actorId, action, objectType, objectId, version, JSON.stringify(details), this.now()]);
    await this.accounts.audit(actorId, action, objectId, details, { spaceId, client });
  }

  async policy(spaceId, client = this.pool) {
    const space = await this.accounts.space(spaceId, client);
    if (!space) throw accountError(404, "space_not_found");
    const r = (await client.query("SELECT * FROM space_policies WHERE space_id=$1", [spaceId])).rows[0];
    return { ...space, allowExternal: r?.allow_external === true, allowPublic: r?.allow_public === true,
      defaultBindingId: r?.default_binding_id || null, revision: num(r?.revision) || 1 };
  }

  async describe(userId, spaceId) {
    const membership = await this.member(userId, spaceId);
    return { space: await this.policy(spaceId), membership };
  }

  async updatePolicy(userId, spaceId, input) {
    return this.transaction(spaceId, async (client) => {
      await this.member(userId, spaceId, client, true);
      const current = await this.policy(spaceId, client);
      if (revision(input.expectedRevision) !== current.revision) throw accountError(409, "space_revision_conflict");
      if (input.allowExternal != null && typeof input.allowExternal !== "boolean"
        || input.allowPublic != null && typeof input.allowPublic !== "boolean") throw accountError(400, "invalid_space_policy");
      const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([k]) =>
        ["allowExternal", "allowPublic", "defaultBindingId", "name"].includes(k))) };
      if (current.kind === "personal" && (next.allowExternal || next.allowPublic)) throw accountError(409, "personal_space_private");
      if (next.defaultBindingId) {
        const selected = await this.requireBinding(userId, spaceId, next.defaultBindingId, client);
        if (selected.kind !== "model" || selected.audienceMode !== "space") throw accountError(400, "invalid_default_model");
      }
      if (input.name != null) await client.query("UPDATE account_spaces SET name=$1 WHERE id=$2",
        [spaceText(input.name, "Name"), spaceId]);
      await client.query(`INSERT INTO space_policies
        (space_id,allow_external,allow_public,default_binding_id,revision,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (space_id) DO UPDATE SET
        allow_external=$2,allow_public=$3,default_binding_id=$4,revision=$5,updated_at=$6`,
      [spaceId, next.allowExternal, next.allowPublic, next.defaultBindingId || null, current.revision + 1, this.now()]);
      if (!next.allowPublic) await client.query(`UPDATE space_publications SET status='revoked',revoked_at=$2
        WHERE space_id=$1 AND status='active'`, [spaceId, this.now()]);
      if (!next.allowExternal && current.allowExternal) {
        await client.query("UPDATE space_documents SET acl_revision=acl_revision+1 WHERE space_id=$1", [spaceId]);
      }
      await this.emit(client, spaceId, userId, "space.policy_changed", "space", spaceId, current.revision + 1);
      return this.policy(spaceId, client);
    });
  }

  async contacts(userId) {
    return (await this.pool.query(`SELECT u.id,u.name FROM space_contacts c
      JOIN account_users u ON u.id=c.contact_id AND u.status='active'
      WHERE c.user_id=$1 ORDER BY u.name,u.id`, [userId])).rows;
  }

  async addContact(userId, contactId) {
    spaceText(contactId, "Contact", 256);
    if (userId === contactId) throw accountError(400, "contact_is_self");
    const contact = await this.accounts.getUser(contactId);
    if (!contact || contact.status !== "active") throw accountError(404, "contact_not_found");
    await this.pool.query(`INSERT INTO space_contacts (user_id,contact_id,created_at)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [userId, contactId, this.now()]);
    return { id: contact.id, name: contact.name };
  }

  async removeContact(userId, contactId) {
    await this.pool.query("DELETE FROM space_contacts WHERE user_id=$1 AND contact_id=$2", [userId, contactId]);
    return { removed: true };
  }

  async members(userId, spaceId) {
    await this.member(userId, spaceId);
    return (await this.pool.query(`SELECT u.id,u.name,m.role,m.status,m.revision FROM account_memberships m
      JOIN account_users u ON u.id=m.user_id AND u.status='active'
      WHERE m.space_id=$1 AND m.status='active' ORDER BY m.created_at,u.id`, [spaceId])).rows
      .map((r) => ({ ...r, revision: num(r.revision) }));
  }

  async invite(userId, spaceId, input) {
    const recipient = invitationRecipient(input);
    const role = input.role || "member";
    if (!["admin", "member", "viewer"].includes(role)) throw accountError(400, "invalid_invitation_role");
    const lifetime = ttl(input.ttlMs);
    return this.transaction(spaceId, async (client) => {
      const actor = await this.member(userId, spaceId, client, true);
      const space = await this.policy(spaceId, client);
      if (space.kind !== "team") throw accountError(409, "personal_space_private");
      if (role === "admin" && actor.role !== "owner") throw accountError(403, "owner_required");
      if (recipient.userId) {
        const target = await this.accounts.getUser(recipient.userId, client);
        if (!target || target.status !== "active") throw accountError(404, "recipient_not_found");
        if (activeMember(await this.accounts.membership(recipient.userId, spaceId, client))) {
          throw accountError(409, "already_member");
        }
      }
      await client.query(`UPDATE space_invitations SET status='expired'
        WHERE space_id=$1 AND status='pending' AND expires_at<=$2`, [spaceId, this.now()]);
      await client.query(`UPDATE space_invitations SET status='revoked' WHERE space_id=$1 AND status='pending'
        AND (recipient_id=$2 OR recipient_email=$3)`, [spaceId, recipient.userId, recipient.email]);
      const id = makeId("invite"), token = randomBytes(32).toString("base64url"), expiresAt = this.now() + lifetime;
      await client.query(`INSERT INTO space_invitations
        (id,space_id,recipient_id,recipient_email,token_hash,proposed_role,invited_by,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, spaceId, recipient.userId, recipient.email, hash(token), role, userId, this.now(), expiresAt]);
      await this.emit(client, spaceId, userId, "invitation.created", "invitation", id);
      return { id, token, spaceId, role, expiresAt, recipient };
    });
  }

  async invitations(userId, spaceId) {
    await this.member(userId, spaceId, this.pool, true);
    return (await this.pool.query(`SELECT id,recipient_id AS "userId",recipient_email AS email,
      proposed_role AS role,status,expires_at AS "expiresAt" FROM space_invitations
      WHERE space_id=$1 ORDER BY created_at DESC LIMIT 200`, [spaceId])).rows
      .map((r) => ({ ...r, expiresAt: num(r.expiresAt) }));
  }

  async acceptInvitation(userId, token) {
    spaceText(token, "Invitation", 256);
    const found = (await this.pool.query("SELECT space_id FROM space_invitations WHERE token_hash=$1", [hash(token)])).rows[0];
    if (!found) throw accountError(403, "invalid_invitation");
    return this.transaction(found.space_id, async (client) => {
      const r = (await client.query("SELECT * FROM space_invitations WHERE token_hash=$1 FOR UPDATE", [hash(token)])).rows[0];
      if (!r || r.status !== "pending" || num(r.expires_at) <= this.now()) throw accountError(403, "invalid_invitation");
      const user = await this.accounts.getUser(userId, client);
      if (!user || user.status !== "active") throw accountError(401, "authentication_required");
      const recipientMatches = r.recipient_id === userId || !!(r.recipient_email && (await client.query(
        "SELECT 1 FROM account_verified_addresses WHERE user_id=$1 AND email=$2", [userId, r.recipient_email])).rowCount);
      if (!recipientMatches) throw accountError(403, "invitation_recipient_mismatch");
      const inviter = await this.member(r.invited_by, r.space_id, client, true);
      if (r.proposed_role === "admin" && inviter.role !== "owner") throw accountError(403, "invalid_invitation");
      const existing = await this.accounts.membership(userId, r.space_id, client);
      if (!activeMember(existing)) await client.query(`INSERT INTO account_memberships
        (space_id,user_id,role,status,revision,created_at,updated_at) VALUES ($1,$2,$3,'active',1,$4,$4)
        ON CONFLICT (space_id,user_id) DO UPDATE SET role=$3,status='active',
        revision=account_memberships.revision+1,updated_at=$4`, [r.space_id, userId, r.proposed_role, this.now()]);
      await client.query(`UPDATE space_invitations SET status='accepted',accepted_by=$2,accepted_at=$3 WHERE id=$1`,
        [r.id, userId, this.now()]);
      await this.emit(client, r.space_id, userId, "invitation.accepted", "invitation", r.id);
      return { space: await this.policy(r.space_id, client), membership: await this.accounts.membership(userId, r.space_id, client) };
    });
  }

  async revokeInvitation(userId, spaceId, invitationId) {
    return this.transaction(spaceId, async (client) => {
      await this.member(userId, spaceId, client, true);
      const result = await client.query(`UPDATE space_invitations SET status='revoked'
        WHERE space_id=$1 AND id=$2 AND status='pending' RETURNING id`, [spaceId, invitationId]);
      if (result.rowCount) await this.emit(client, spaceId, userId, "invitation.revoked", "invitation", invitationId);
      return { revoked: true };
    });
  }

  async groups(userId, spaceId, client = this.pool) {
    await this.member(userId, spaceId, client);
    return (await client.query(`SELECT g.id,g.name,g.revision,
      COALESCE(jsonb_agg(m.user_id) FILTER (WHERE m.user_id IS NOT NULL),'[]'::jsonb) AS members
      FROM space_groups g LEFT JOIN space_group_members m ON m.space_id=g.space_id AND m.group_id=g.id
      WHERE g.space_id=$1 GROUP BY g.id,g.name,g.revision ORDER BY g.name,g.id`, [spaceId])).rows
      .map((r) => ({ ...r, revision: num(r.revision) }));
  }

  async saveGroup(userId, spaceId, groupId, input) {
    const name = spaceText(input.name, "Group name"), memberIds = input.members;
    if (!Array.isArray(memberIds) || memberIds.length > 500 || new Set(memberIds).size !== memberIds.length) {
      throw accountError(400, "invalid_group_members");
    }
    return this.transaction(spaceId, async (client) => {
      await this.member(userId, spaceId, client, true);
      for (const memberId of memberIds) await this.member(memberId, spaceId, client);
      const id = groupId || makeId("group");
      const current = (await client.query("SELECT * FROM space_groups WHERE space_id=$1 AND id=$2", [spaceId, id])).rows[0];
      if (groupId && (!current || revision(input.expectedRevision) !== num(current.revision))) {
        throw accountError(409, "group_revision_conflict");
      }
      const version = current ? num(current.revision) + 1 : 1;
      await client.query(`INSERT INTO space_groups (space_id,id,name,created_by,revision,created_at)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (space_id,id) DO UPDATE SET name=$3,revision=$5`,
      [spaceId, id, name, userId, version, this.now()]);
      await client.query("DELETE FROM space_group_members WHERE space_id=$1 AND group_id=$2", [spaceId, id]);
      for (const memberId of memberIds) await client.query(`INSERT INTO space_group_members
        (space_id,group_id,user_id,created_at) VALUES ($1,$2,$3,$4)`, [spaceId, id, memberId, this.now()]);
      // A changed group changes the audience of every document using it.
      await client.query(`UPDATE space_documents d SET acl_revision=acl_revision+1 WHERE d.space_id=$1
        AND EXISTS (SELECT 1 FROM space_document_grants g WHERE g.space_id=d.space_id
        AND g.document_id=d.id AND g.group_id=$2)`, [spaceId, id]);
      await this.invalidateKnowledge(client, spaceId);
      await this.emit(client, spaceId, userId, "group.changed", "group", id, version);
      return { id, name, members: memberIds, revision: version };
    });
  }

  async deleteGroup(userId, spaceId, groupId) {
    return this.transaction(spaceId, async (client) => {
      await this.member(userId, spaceId, client, true);
      await client.query(`UPDATE space_documents d SET acl_revision=acl_revision+1 WHERE d.space_id=$1
        AND EXISTS (SELECT 1 FROM space_document_grants g WHERE g.space_id=d.space_id
        AND g.document_id=d.id AND g.group_id=$2)`, [spaceId, groupId]);
      await client.query("DELETE FROM space_groups WHERE space_id=$1 AND id=$2", [spaceId, groupId]);
      await this.invalidateKnowledge(client, spaceId);
      await this.emit(client, spaceId, userId, "group.deleted", "group", groupId);
      return { deleted: true };
    });
  }

  async accessInput(userId, spaceId, documentId, client = this.pool) {
    const [space, membership, documentResult, grantsResult, groupsResult] = await Promise.all([
      this.policy(spaceId, client), this.accounts.membership(userId, spaceId, client),
      client.query("SELECT * FROM space_documents WHERE space_id=$1 AND id=$2", [spaceId, documentId]),
      client.query("SELECT * FROM space_document_grants WHERE space_id=$1 AND document_id=$2", [spaceId, documentId]),
      client.query("SELECT group_id FROM space_group_members WHERE space_id=$1 AND user_id=$2", [spaceId, userId])
    ]);
    return { userId, space, membership, document: doc(documentResult.rows[0]), grants: grantsResult.rows.map(grant),
      groupIds: groupsResult.rows.map((r) => r.group_id), now: this.now() };
  }

  async requireDocument(userId, spaceId, documentId, action = "view", client = this.pool) {
    const input = await this.accessInput(userId, spaceId, documentId, client);
    if (this.sharing && input.space.kind === "personal" && input.space.createdBy !== userId
      && !(input.space.legacyAccountWorkspace && activeMember(input.membership))) {
      const direct = await this.sharing.documentAccess(userId, spaceId, documentId, action, client);
      if (input.document?.lifecycle !== "active") throw accountError(404, "document_not_found");
      return { ...input.document, access: { role: direct.role, inherited: direct.inherited, shareId: direct.shareId } };
    }
    const access = requireDocumentAccess(input, action);
    return { ...input.document, access };
  }

  async requireDocuments(userId, spaceId, documentIds, action = "view", client = this.pool) {
    const ids = [...new Set(documentIds || [])];
    if (!ids.length) return [];
    const [space, membership, groups] = await Promise.all([
      this.policy(spaceId, client), this.accounts.membership(userId, spaceId, client),
      client.query("SELECT group_id FROM space_group_members WHERE space_id=$1 AND user_id=$2", [spaceId, userId])
    ]);
    if (this.sharing && space.kind === "personal" && space.createdBy !== userId
      && !(space.legacyAccountWorkspace && activeMember(membership))) {
      const documents = [];
      for (const id of ids) documents.push(await this.requireDocument(userId, spaceId, id, action, client));
      return documents;
    }
    const groupIds = groups.rows.map(row => row.group_id);
    const rows = (await client.query(`SELECT d.*,COALESCE(g.grants,'[]'::jsonb) AS grants FROM space_documents d
      LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('subjectType',subject_type,
        'subjectId',subject_id,'role',role,'expiresAt',expires_at)) AS grants
        FROM space_document_grants WHERE space_id=d.space_id AND document_id=d.id) g ON TRUE
      WHERE d.space_id=$1 AND d.id=ANY($2::text[])`, [spaceId, ids])).rows;
    const documents = new Map(rows.map(row => [row.id, row]));
    return ids.map(id => {
      const row = documents.get(id), document = doc(row);
      const access = requireDocumentAccess({ userId, space, membership, document,
        grants: (row?.grants || []).map(value => ({ ...value, expiresAt: num(value.expiresAt) })),
        groupIds, now: this.now() }, action);
      return { ...document, access };
    });
  }

  async documentAccess(userId, spaceId, documentId) {
    const input = await this.accessInput(userId, spaceId, documentId);
    if (this.sharing && input.space.kind === "personal" && input.space.createdBy !== userId
      && !(input.space.legacyAccountWorkspace && activeMember(input.membership))) {
      const document = await this.requireDocument(userId, spaceId, documentId, "view");
      return { document, access: document.access };
    }
    const access = requireDocumentAccess(input);
    return { document: input.document, access,
      ...(access.role === "manager" ? { grants: input.grants } : {}) };
  }

  async requireAsset(userId, spaceId, assetId, client = this.pool) {
    const asset = (await client.query("SELECT owner_id FROM runtime_assets WHERE space_id=$1 AND id=$2 AND state='ready'",
      [spaceId, assetId])).rows[0];
    if (!asset) throw accountError(404, "asset_not_found");
    if (asset.owner_id === userId) return true;
    const space = await this.policy(spaceId, client);
    if (space.kind === "personal" && space.createdBy === userId) return true;
    const refs = (await client.query("SELECT document_id FROM space_document_assets WHERE space_id=$1 AND asset_id=$2",
      [spaceId, assetId])).rows;
    for (const r of refs) {
      if (this.sharing && space.kind === "personal") {
        try { await this.requireDocument(userId, spaceId, r.document_id, "view", client); return true; }
        catch (error) { if (error.statusCode !== 404) throw error; }
      }
      if (effectiveDocumentAccess(await this.accessInput(userId, spaceId, r.document_id, client)).role !== "none") return true;
    }
    throw accountError(404, "asset_not_found");
  }

  async bindDocumentAssets(userId, spaceId, documentId, assetIds, client) {
    await this.requireDocument(userId, spaceId, documentId, "edit", client);
    for (const assetId of new Set(assetIds)) {
      await this.requireAsset(userId, spaceId, assetId, client);
      const asset = (await client.query("SELECT owner_id FROM runtime_assets WHERE space_id=$1 AND id=$2", [spaceId, assetId])).rows[0];
      const alreadyBound = (await client.query(`SELECT 1 FROM space_document_assets
        WHERE space_id=$1 AND document_id=$2 AND asset_id=$3`, [spaceId, documentId, assetId])).rowCount;
      // A reader cannot launder an attachment from another restricted audience.
      if (!alreadyBound && asset.owner_id !== userId) throw accountError(403, "attachment_copy_requires_owner");
      await client.query(`INSERT INTO space_document_assets (space_id,document_id,asset_id,created_by,created_at)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [spaceId, documentId, assetId, userId, this.now()]);
    }
  }

  async copyDocumentAccess(userId, spaceId, sourceId, targetId, externalClient) {
    const run = async (client) => {
      const source = await this.requireDocument(userId, spaceId, sourceId, "view", client);
      if ((await client.query("SELECT 1 FROM space_documents WHERE space_id=$1 AND id=$2", [spaceId, targetId])).rowCount) {
        throw accountError(409, "document_already_exists");
      }
      await client.query(`INSERT INTO space_documents
        (space_id,id,created_by,protection,audience_mode,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      [spaceId, targetId, userId, source.protection, source.audienceMode, this.now()]);
      await client.query(`INSERT INTO space_document_grants
        (space_id,document_id,user_id,group_id,role,granted_by,created_at,expires_at)
        SELECT space_id,$3,user_id,group_id,role,$4,$5,expires_at FROM space_document_grants
        WHERE space_id=$1 AND document_id=$2`, [spaceId, sourceId, targetId, userId, this.now()]);
      // A branch preserves management rights too. Creating a branch must not
      // turn an editor of a restricted document into someone who can reshare it.
      await client.query(`INSERT INTO space_document_assets (space_id,document_id,asset_id,created_by,created_at)
        SELECT space_id,$3,asset_id,$4,$5 FROM space_document_assets WHERE space_id=$1 AND document_id=$2`,
      [spaceId, sourceId, targetId, userId, this.now()]);
      await this.emit(client, spaceId, userId, "document.copied", "document", targetId);
      return this.requireDocument(userId, spaceId, targetId, "view", client);
    };
    return externalClient ? run(externalClient) : this.transaction(spaceId, run);
  }

  async registerDocument(userId, spaceId, documentId, client = null) {
    spaceText(documentId, "Document", 256);
    const run = async (db) => {
      const existing = (await db.query("SELECT id FROM space_documents WHERE space_id=$1 AND id=$2", [spaceId, documentId])).rowCount;
      if (existing) return this.requireDocument(userId, spaceId, documentId, "edit", db);
      const member = await this.member(userId, spaceId, db);
      if (member.role === "viewer") throw accountError(403, "document_creation_denied");
      const personal = (await this.policy(spaceId, db)).kind === "personal";
      await db.query(`INSERT INTO space_documents
        (space_id,id,created_by,protection,audience_mode,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$6)`, [spaceId, documentId, userId,
        personal ? "restricted" : "space", personal ? "specific" : "space", this.now()]);
      await db.query(`INSERT INTO space_document_grants
        (space_id,document_id,user_id,role,granted_by,created_at) VALUES ($1,$2,$3,'manager',$3,$4)`,
      [spaceId, documentId, userId, this.now()]);
      await this.emit(db, spaceId, userId, "document.created", "document", documentId);
      return this.requireDocument(userId, spaceId, documentId, "edit", db);
    };
    return client ? run(client) : this.transaction(spaceId, run);
  }

  async updateDocumentAccess(userId, spaceId, documentId, input) {
    return this.transaction(spaceId, async (client) => {
      const current = await this.requireDocument(userId, spaceId, documentId, "manage", client);
      if (revision(input.expectedRevision) !== current.aclRevision) throw accountError(409, "document_acl_conflict");
      const space = await this.policy(spaceId, client);
      if (space.kind === "personal") throw accountError(409, "move_to_shared_space_required");
      const memberRows = (await client.query(`SELECT m.user_id FROM account_memberships m JOIN account_users u
        ON u.id=m.user_id AND u.status='active' WHERE m.space_id=$1 AND m.status='active'`, [spaceId])).rows;
      const groupRows = (await client.query("SELECT id FROM space_groups WHERE space_id=$1", [spaceId])).rows;
      const next = validateDocumentAudience({ ...input, allowExternal: space.allowExternal,
        memberIds: memberRows.map((r) => r.user_id), groupIds: groupRows.map((r) => r.id) });
      for (const g of next.grants.filter((g) => g.subjectType === "user")) {
        const user = await this.accounts.getUser(g.subjectId, client);
        if (!user || user.status !== "active") throw accountError(400, "unknown_person");
      }
      const nextInput = { userId, space, document: { ...current, ...next },
        membership: await this.member(userId, spaceId, client), grants: next.grants,
        groupIds: (await client.query("SELECT group_id FROM space_group_members WHERE space_id=$1 AND user_id=$2",
          [spaceId, userId])).rows.map((r) => r.group_id), now: this.now() };
      if (effectiveDocumentAccess(nextInput).role !== "manager") throw accountError(409, "keep_document_manager");
      await client.query("DELETE FROM space_document_grants WHERE space_id=$1 AND document_id=$2", [spaceId, documentId]);
      for (const g of next.grants) await client.query(`INSERT INTO space_document_grants
        (space_id,document_id,user_id,group_id,role,granted_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [spaceId, documentId, g.subjectType === "user" ? g.subjectId : null,
        g.subjectType === "group" ? g.subjectId : null, g.role, userId, this.now()]);
      await client.query(`UPDATE space_documents SET protection=$3,audience_mode=$4,
        acl_revision=acl_revision+1,updated_at=$5 WHERE space_id=$1 AND id=$2`,
      [spaceId, documentId, next.protection, next.audienceMode, this.now()]);
      await this.invalidateKnowledge(client, spaceId, documentId);
      await client.query(`UPDATE space_publications SET status='revoked',revoked_at=$3
        WHERE space_id=$1 AND document_id=$2 AND status='active'`, [spaceId, documentId, this.now()]);
      await this.emit(client, spaceId, userId, "document.access_changed", "document", documentId, current.aclRevision + 1);
      return { document: { ...current, ...next, aclRevision: current.aclRevision + 1 } };
    });
  }

  async readableIds(userId, spaceId, client = this.pool) {
    const membership = await this.member(userId, spaceId, client), space = await this.policy(spaceId, client);
    const groups = (await client.query("SELECT group_id FROM space_group_members WHERE space_id=$1 AND user_id=$2",
      [spaceId, userId])).rows.map((r) => r.group_id);
    const rows = (await client.query(`SELECT d.*,COALESCE(g.grants,'[]'::jsonb) AS grants FROM space_documents d
      LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('subjectType',subject_type,
        'subjectId',subject_id,'role',role,'expiresAt',expires_at)) AS grants
        FROM space_document_grants WHERE space_id=d.space_id AND document_id=d.id
        AND (user_id=$2 OR group_id=ANY($3::text[]))) g ON TRUE
      WHERE d.space_id=$1 AND d.lifecycle='active'`, [spaceId, userId, groups])).rows;
    return rows.filter((r) => effectiveDocumentAccess({
      userId, space, membership, document: doc(r), grants: r.grants.map((g) => ({ ...g, expiresAt: num(g.expiresAt) })),
      groupIds: groups, now: this.now()
    }).role !== "none").map((r) => r.id);
  }

  async comments(userId, spaceId, documentId) {
    await this.requireDocument(userId, spaceId, documentId);
    return (await this.pool.query(`SELECT c.id,c.body,c.author_id AS "authorId",u.name AS "authorName",
      c.created_at AS "createdAt",c.updated_at AS "updatedAt" FROM space_document_comments c
      JOIN account_users u ON u.id=c.author_id WHERE c.space_id=$1 AND c.document_id=$2
      ORDER BY c.created_at,c.id LIMIT 1000`, [spaceId, documentId])).rows
      .map((r) => ({ ...r, createdAt: num(r.createdAt), updatedAt: num(r.updatedAt) }));
  }

  async comment(userId, spaceId, documentId, body) {
    const text = spaceText(body, "Comment", 8000);
    return this.transaction(spaceId, async (client) => {
      await this.requireDocument(userId, spaceId, documentId, "comment", client);
      const id = makeId("comment");
      await client.query(`INSERT INTO space_document_comments
        (space_id,document_id,id,author_id,body,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      [spaceId, documentId, id, userId, text, this.now()]);
      await this.emit(client, spaceId, userId, "document.commented", "document", documentId, 1, { commentId: id });
      return { id, body: text, authorId: userId, createdAt: this.now() };
    });
  }

  async deleteComment(userId, spaceId, documentId, commentId) {
    return this.transaction(spaceId, async (client) => {
      const access = await this.requireDocument(userId, spaceId, documentId, "comment", client);
      const r = (await client.query(`SELECT author_id FROM space_document_comments
        WHERE space_id=$1 AND document_id=$2 AND id=$3`, [spaceId, documentId, commentId])).rows[0];
      if (!r) throw accountError(404, "comment_not_found");
      if (r.author_id !== userId && access.access.role !== "manager") throw accountError(403, "comment_delete_denied");
      await client.query("DELETE FROM space_document_comments WHERE space_id=$1 AND document_id=$2 AND id=$3", [spaceId, documentId, commentId]);
      await this.emit(client, spaceId, userId, "document.comment_deleted", "document", documentId, 1, { commentId });
      return { deleted: true };
    });
  }

  async requireBinding(userId, spaceId, bindingId, client = this.pool) {
    requireSpaceExecution(await this.member(userId, spaceId, client));
    const b = binding((await client.query("SELECT * FROM space_resource_bindings WHERE space_id=$1 AND id=$2", [spaceId, bindingId])).rows[0]);
    if (!b || b.status !== "active" || b.expiresAt != null && b.expiresAt <= this.now()) throw accountError(403, "capability_unavailable");
    // Removing a provider or its source authority immediately withdraws lending.
    const sourceMember = await this.accounts.membership(b.providerId, b.originSpaceId, client);
    if (!activeMember(await this.accounts.membership(b.providerId, spaceId, client))
      || !activeMember(sourceMember) || sourceMember.role !== "owner"
      || (await this.accounts.getUser(b.providerId, client))?.status !== "active") {
      throw accountError(403, "capability_provider_unavailable");
    }
    if (b.audienceMode !== "space") {
      const result = await client.query(`SELECT 1 FROM space_binding_grants g WHERE g.space_id=$1 AND g.binding_id=$2
        AND (g.user_id=$3 OR g.group_id IN (SELECT group_id FROM space_group_members WHERE space_id=$1 AND user_id=$3))`,
      [spaceId, bindingId, userId]);
      if (!result.rowCount) throw accountError(403, "capability_not_shared");
    }
    return b;
  }

  async bindings(userId, spaceId) {
    await this.member(userId, spaceId);
    const result = [];
    for (const r of (await this.pool.query("SELECT * FROM space_resource_bindings WHERE space_id=$1 ORDER BY created_at,id", [spaceId])).rows) {
      const b = binding(r);
      const manager = isSpaceManager(await this.accounts.membership(userId, spaceId));
      try { await this.requireBinding(userId, spaceId, b.id); }
      catch { if (!manager && b.providerId !== userId) continue; }
      const provider = await this.accounts.getUser(b.providerId);
      const projection = bindingProjection(b, { id: provider.id, name: provider.name });
      if (manager || b.providerId === userId) projection.grants = (await this.pool.query(
        "SELECT user_id,group_id FROM space_binding_grants WHERE space_id=$1 AND binding_id=$2",
        [spaceId, b.id])).rows.map(g => ({ subjectType: g.user_id ? "user" : "group", subjectId: g.user_id || g.group_id }));
      result.push(projection);
    }
    return result;
  }

  async createBinding(userId, spaceId, input, verifiedSource) {
    if (!verifiedSource || verifiedSource.id !== input.originResourceId || verifiedSource.kind !== input.kind) {
      throw accountError(400, "capability_source_unverified");
    }
    if (input.transferApproved !== true) throw accountError(400, "capability_transfer_confirmation_required");
    const limits = { monthlyCalls: input.limits?.monthlyCalls == null ? null
      : integerLimit(input.limits.monthlyCalls, { minimum: 0 }),
    allowedTools: verifiedSource.allowedTools || [], dedicatedRoot: verifiedSource.dedicatedRoot || null };
    return this.transaction(spaceId, async (client) => {
      await this.member(userId, spaceId, client, true);
      const origin = await this.member(userId, input.originSpaceId, client);
      if (origin.role !== "owner") throw accountError(403, "source_owner_required");
      if ((await this.policy(spaceId, client)).kind !== "team") throw accountError(409, "shared_space_required");
      if (!["model", "skill", "plugin", "device"].includes(input.kind)) throw accountError(400, "invalid_capability_kind");
      const audience = input.audienceMode || "space";
      if (!["space", "specific"].includes(audience)) throw accountError(400, "invalid_audience");
      const id = makeId("binding"), name = spaceText(input.name || verifiedSource.name, "Capability name");
      await client.query(`INSERT INTO space_resource_bindings
        (id,space_id,provider_id,origin_space_id,origin_resource_id,kind,name,description,source_version,
        audience_mode,ceiling_json,transfer_approved,created_at,updated_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,TRUE,$12,$12,$13)`,
      [id, spaceId, userId, input.originSpaceId, spaceText(input.originResourceId, "Source", 256), input.kind,
        name, spaceText(input.description || verifiedSource.description || name, "Description", 1000),
        String(verifiedSource.version || ""), audience, JSON.stringify(limits), this.now(),
        input.ttlMs == null ? null : this.now() + ttl(input.ttlMs)]);
      await this.saveBindingGrants(client, userId, spaceId, id, input.grants || []);
      await this.emit(client, spaceId, userId, "capability.shared", "binding", id);
      const created = binding((await client.query("SELECT * FROM space_resource_bindings WHERE space_id=$1 AND id=$2",
        [spaceId, id])).rows[0]);
      return bindingProjection(created, await this.accounts.getUser(userId, client));
    });
  }

  async saveBindingGrants(client, userId, spaceId, bindingId, grants) {
    if (!Array.isArray(grants) || grants.length > 500) throw accountError(400, "invalid_binding_grants");
    const seen = new Set();
    for (const g of grants) {
      const key = JSON.stringify([g.subjectType, g.subjectId]);
      if (seen.has(key)) throw accountError(400, "duplicate_grant");
      seen.add(key);
      if (g.subjectType === "user") await this.member(g.subjectId, spaceId, client);
      else if (g.subjectType !== "group" || !(await client.query(
        "SELECT 1 FROM space_groups WHERE space_id=$1 AND id=$2", [spaceId, g.subjectId])).rowCount) {
        throw accountError(400, "unknown_group");
      }
      await client.query(`INSERT INTO space_binding_grants (space_id,binding_id,user_id,group_id,created_at)
        VALUES ($1,$2,$3,$4,$5)`, [spaceId, bindingId, g.subjectType === "user" ? g.subjectId : null,
        g.subjectType === "group" ? g.subjectId : null, this.now()]);
    }
  }

  async updateBinding(userId, spaceId, bindingId, input) {
    return this.transaction(spaceId, async (client) => {
      const b = binding((await client.query("SELECT * FROM space_resource_bindings WHERE space_id=$1 AND id=$2",
        [spaceId, bindingId])).rows[0]);
      if (!b) throw accountError(404, "capability_not_found");
      if (b.providerId !== userId) await this.member(userId, spaceId, client, true);
      if (revision(input.expectedRevision) !== b.revision) throw accountError(409, "capability_revision_conflict");
      const status = input.status || b.status;
      if (!["active", "disabled", "revoked"].includes(status) || b.status === "revoked" && status !== "revoked") {
        throw accountError(400, "invalid_capability_status");
      }
      if (b.providerId !== userId && status === "active") throw accountError(403, "provider_required");
      const audience = input.audienceMode || b.audienceMode;
      if (!["space", "specific"].includes(audience)) throw accountError(400, "invalid_audience");
      if (input.grants) {
        await client.query("DELETE FROM space_binding_grants WHERE space_id=$1 AND binding_id=$2", [spaceId, bindingId]);
        await this.saveBindingGrants(client, userId, spaceId, bindingId, input.grants);
      }
      const limits = { ...b.limits };
      if (Object.hasOwn(input, "monthlyCalls")) limits.monthlyCalls = input.monthlyCalls == null
        ? null : integerLimit(input.monthlyCalls, { minimum: 0 });
      const expiresAt = Object.hasOwn(input, "ttlMs") ? input.ttlMs == null ? null : this.now() + ttl(input.ttlMs) : b.expiresAt;
      await client.query(`UPDATE space_resource_bindings SET status=$3,audience_mode=$4,ceiling_json=$5::jsonb,
        revision=revision+1,updated_at=$6,expires_at=$7 WHERE space_id=$1 AND id=$2`,
      [spaceId, bindingId, status, audience, JSON.stringify(limits), this.now(), expiresAt]);
      if (status !== "active" || audience !== "space") {
        await client.query("UPDATE space_policies SET default_binding_id=NULL,revision=revision+1 WHERE space_id=$1 AND default_binding_id=$2",
          [spaceId, bindingId]);
      }
      if (status !== "active") {
        await client.query(`UPDATE space_run_queue SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END,
          updated_at=$3 WHERE space_id=$1 AND binding_id=$2 AND status IN ('queued','running')`, [spaceId, bindingId, this.now()]);
      }
      await this.emit(client, spaceId, userId, "capability.changed", "binding", bindingId, b.revision + 1);
      return { id: bindingId, status, audienceMode: audience, revision: b.revision + 1, limits, expiresAt };
    });
  }

  async invalidateKnowledge(client, spaceId, documentId = null) {
    await client.query(`UPDATE space_knowledge_sources SET status='review_required',updated_at=$3
      WHERE space_id=$1 AND ($2::text IS NULL OR document_id=$2) AND status='active'`, [spaceId, documentId, this.now()]);
  }

  async content(spaceId, documentId, client = this.pool) {
    const r = (await client.query(`SELECT d.text,h.revision,m.meta_json,GREATEST(d.updated_at,m.updated_at) AS updated_at FROM runtime_workbench_documents d
      LEFT JOIN runtime_workbench_session_heads h ON h.space_id=d.space_id AND h.id=d.id
      LEFT JOIN runtime_workbench_metadata m ON m.space_id=d.space_id AND m.id=d.id
      WHERE d.space_id=$1 AND d.id=$2`, [spaceId, documentId])).rows[0];
    if (!r) {
      // A CLI Session can exist before its first Workbench projection.
      const session = (await client.query("SELECT payload_json FROM runtime_sessions WHERE space_id=$1 AND id=$2",
        [spaceId, documentId])).rows[0]?.payload_json;
      if (!session) throw accountError(404, "document_not_found");
      return { text: "", revision: 1, title: session.title || "Untitled" };
    }
    const meta = await hydrateSessionCardMetadata(client, spaceId, documentId, r.meta_json);
    return { text: r.text, revision: num(r.revision) || 1, title: meta?.title || "Untitled",
      updatedAt: num(r.updated_at), cards: projectPublicCards(r.text, meta?.annotations) };
  }

  async chooseKnowledge(userId, spaceId, documentId, input) {
    if (input.reviewed !== true) throw accountError(400, "knowledge_review_required");
    const title = spaceText(input.title, "Knowledge title"), projection = spaceText(input.text, "Knowledge text", 128 * 1024);
    return this.transaction(spaceId, async (client) => {
      const d = await this.requireDocument(userId, spaceId, documentId, "manage", client);
      const source = await this.content(spaceId, documentId, client);
      if (revision(input.sourceRevision) !== source.revision) throw accountError(409, "source_revision_conflict");
      const id = makeId("knowledge");
      await client.query(`INSERT INTO space_knowledge_sources
        (space_id,id,document_id,source_revision,source_acl_revision,title,projection_text,namespace_id,chosen_by,status,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$10)`,
      [spaceId, id, documentId, source.revision, d.aclRevision, title, projection,
        `space:${hash(spaceId)}`, userId, this.now()]);
      await this.emit(client, spaceId, userId, "knowledge.chosen", "document", documentId, d.aclRevision, { knowledgeId: id });
      return { id, title, documentId, sourceRevision: source.revision, status: "active" };
    });
  }

  async knowledge(userId, spaceId, { destinationId = null, query = "" } = {}) {
    await this.member(userId, spaceId);
    const rows = (await this.pool.query("SELECT * FROM space_knowledge_sources WHERE space_id=$1 ORDER BY created_at DESC", [spaceId])).rows;
    const destination = destinationId ? await this.requireDocument(userId, spaceId, destinationId) : null;
    const users = (await this.pool.query(`SELECT DISTINCT u.id FROM account_users u WHERE u.status='active' AND
      (EXISTS (SELECT 1 FROM account_memberships m WHERE m.space_id=$1 AND m.user_id=u.id AND m.status='active')
       OR EXISTS (SELECT 1 FROM space_document_grants g WHERE g.space_id=$1 AND g.user_id=u.id))`, [spaceId])).rows.map((r) => r.id);
    const result = [];
    for (const r of rows) {
      let source;
      try { source = await this.requireDocument(userId, spaceId, r.document_id); } catch { continue; }
      const content = await this.content(spaceId, r.document_id);
      const status = r.status === "active" && num(r.source_acl_revision) === source.aclRevision
        && num(r.source_revision) === content.revision ? "active" : "review_required";
      if (destination) {
        if (status !== "active") continue;
        const readers = async (d) => {
          const ids = [];
          for (const id of users) {
            if (effectiveDocumentAccess(await this.accessInput(id, spaceId, d.id)).role !== "none") ids.push(id);
          }
          return ids;
        };
        if (!sourceAllowsAudience({ source, destination, sourceUsers: await readers(source), destinationUsers: await readers(destination) })) continue;
      }
      if (query && !`${r.title}\n${r.projection_text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
      result.push({ id: r.id, title: r.title, text: status === "active" ? r.projection_text : null,
        documentId: r.document_id, sourceRevision: num(r.source_revision), status });
    }
    return result;
  }

  async revokeKnowledge(userId, spaceId, knowledgeId) {
    return this.transaction(spaceId, async (client) => {
      const r = (await client.query("SELECT document_id FROM space_knowledge_sources WHERE space_id=$1 AND id=$2",
        [spaceId, knowledgeId])).rows[0];
      if (!r) throw accountError(404, "knowledge_not_found");
      await this.requireDocument(userId, spaceId, r.document_id, "manage", client);
      await client.query("UPDATE space_knowledge_sources SET status='revoked',updated_at=$3 WHERE space_id=$1 AND id=$2",
        [spaceId, knowledgeId, this.now()]);
      await this.emit(client, spaceId, userId, "knowledge.revoked", "document", r.document_id, 1, { knowledgeId });
      return { revoked: true };
    });
  }

  async publish(userId, spaceId, documentId, input, verifiedAssets = []) {
    const lifetime = ttl(input.ttlMs);
    return this.transaction(spaceId, async (client) => {
      const d = await this.requireDocument(userId, spaceId, documentId, "manage", client);
      const space = await this.policy(spaceId, client);
      if (!space.allowPublic || d.protection !== "external") throw accountError(403, "publication_disallowed");
      const content = await this.content(spaceId, documentId, client);
      if (revision(input.sourceRevision) !== content.revision) throw accountError(409, "source_revision_conflict");
      const projected = publicProjection({ ...input, revision: content.revision });
      const id = randomBytes(24).toString("base64url"), expiresAt = this.now() + lifetime;
      const assetIds = input.approvedAssetIds || [];
      if (!Array.isArray(assetIds) || assetIds.length > 20 || new Set(assetIds).size !== assetIds.length
        || assetIds.some((assetId) => typeof assetId !== "string")) throw accountError(400, "invalid_publication_assets");
      const copies = [];
      let bytes = 0;
      for (const assetId of assetIds) {
        await this.requireAsset(userId, spaceId, assetId, client);
        const asset = verifiedAssets.find((a) => a.id === assetId);
        if (!asset || !Buffer.isBuffer(asset.content) || !["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(asset.mediaType)) {
          throw accountError(400, "publication_asset_unverified");
        }
        bytes += asset.content.length;
        if (bytes > 32 * 1024 * 1024) throw accountError(413, "publication_assets_too_large");
        const publicId = randomBytes(18).toString("base64url");
        const uri = `zion-asset://${assetId}`;
        projected.markdown = projected.markdown.replaceAll(uri, `/p/${id}/assets/${publicId}`);
        copies.push({ ...asset, publicId });
      }
      // No raw Runtime/asset URLs can ride along in a public projection.
      if (/(?:\/v1\/|zion-asset:|asset:\/\/|file:\/\/)/i.test(projected.markdown)) {
        throw accountError(400, "publication_private_reference");
      }
      await client.query(`INSERT INTO space_publications
        (id,space_id,document_id,source_revision,source_acl_revision,title,markdown,published_by,status,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10)`,
      [id, spaceId, documentId, content.revision, d.aclRevision, projected.title, projected.markdown, userId, this.now(), expiresAt]);
      for (const asset of copies) await client.query(`INSERT INTO space_publication_assets
        (publication_id,id,name,mime_type,content_blob,sha256) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, asset.publicId, asset.originalName || "image", asset.mediaType, asset.content,
        createHash("sha256").update(asset.content).digest("hex")]);
      await this.emit(client, spaceId, userId, "document.published", "document", documentId, d.aclRevision, { publicationId: id });
      return { id, title: projected.title, sourceRevision: content.revision, expiresAt, path: `/p/${id}` };
    });
  }

  async publication(publicationId) {
    const r = (await this.pool.query(`SELECT p.* FROM space_publications p JOIN space_policies s ON s.space_id=p.space_id
      JOIN space_documents d ON d.space_id=p.space_id AND d.id=p.document_id
      WHERE p.id=$1 AND p.status='active' AND p.expires_at>$2 AND s.allow_public=TRUE
        AND d.lifecycle='active' AND d.acl_revision=p.source_acl_revision AND d.protection='external'`,
    [publicationId, this.now()])).rows[0];
    if (!r) throw accountError(404, "publication_not_found");
    return { id: r.id, title: r.title, markdown: r.markdown, revision: num(r.source_revision), expiresAt: num(r.expires_at) };
  }

  async publicationAsset(publicationId, assetId) {
    await this.publication(publicationId);
    const r = (await this.pool.query(`SELECT mime_type,content_blob,sha256 FROM space_publication_assets
      WHERE publication_id=$1 AND id=$2`, [publicationId, assetId])).rows[0];
    if (!r) throw accountError(404, "publication_asset_not_found");
    return { mediaType: r.mime_type, content: r.content_blob, sha256: r.sha256 };
  }

  async publications(userId, spaceId, documentId) {
    await this.requireDocument(userId, spaceId, documentId, "manage");
    return (await this.pool.query(`SELECT id,title,status,source_revision AS revision,expires_at AS "expiresAt"
      FROM space_publications WHERE space_id=$1 AND document_id=$2 ORDER BY created_at DESC`,
    [spaceId, documentId])).rows.map((r) => ({ ...r, revision: num(r.revision), expiresAt: num(r.expiresAt), path: `/p/${r.id}` }));
  }

  async revokePublication(userId, spaceId, publicationId) {
    return this.transaction(spaceId, async (client) => {
      const r = (await client.query("SELECT document_id FROM space_publications WHERE space_id=$1 AND id=$2",
        [spaceId, publicationId])).rows[0];
      if (!r) throw accountError(404, "publication_not_found");
      await this.requireDocument(userId, spaceId, r.document_id, "manage", client);
      await client.query("UPDATE space_publications SET status='revoked',revoked_at=$3 WHERE space_id=$1 AND id=$2",
        [spaceId, publicationId, this.now()]);
      await this.emit(client, spaceId, userId, "publication.revoked", "document", r.document_id, 1, { publicationId });
      return { revoked: true };
    });
  }

  async transferOwnership(userId, spaceId, toUserId) {
    return this.transaction(spaceId, async (client) => {
      if ((await this.member(userId, spaceId, client)).role !== "owner") throw accountError(403, "owner_required");
      if ((await this.policy(spaceId, client)).kind !== "team" || toUserId === userId) throw accountError(400, "invalid_owner_transfer");
      await this.member(toUserId, spaceId, client);
      await client.query(`UPDATE space_ownership_transfers SET status='expired'
        WHERE space_id=$1 AND status='pending' AND expires_at<=$2`, [spaceId, this.now()]);
      const id = makeId("transfer");
      await client.query(`INSERT INTO space_ownership_transfers
        (id,space_id,from_user_id,to_user_id,status,created_at,expires_at) VALUES ($1,$2,$3,$4,'pending',$5,$6)`,
      [id, spaceId, userId, toUserId, this.now(), this.now() + 7 * DAY]);
      await this.emit(client, spaceId, userId, "ownership.offered", "space", spaceId, 1, { transferId: id });
      return { id, toUserId, expiresAt: this.now() + 7 * DAY };
    });
  }

  async ownershipOffers(userId, spaceId) {
    const member = await this.member(userId, spaceId);
    const owner = member.role === "owner";
    return (await this.pool.query(`SELECT id,from_user_id AS "fromUserId",to_user_id AS "toUserId",
      expires_at AS "expiresAt" FROM space_ownership_transfers WHERE space_id=$1 AND status='pending'
      AND expires_at>$3 AND ($4 OR to_user_id=$2) ORDER BY created_at DESC`,
    [spaceId, userId, this.now(), owner])).rows.map(r => ({ ...r, expiresAt: num(r.expiresAt) }));
  }

  async acceptOwnership(userId, spaceId, transferId) {
    return this.transaction(spaceId, async (client) => {
      const r = (await client.query("SELECT * FROM space_ownership_transfers WHERE space_id=$1 AND id=$2",
        [spaceId, transferId])).rows[0];
      if (!r || r.to_user_id !== userId || r.status !== "pending" || num(r.expires_at) <= this.now()) {
        throw accountError(403, "invalid_owner_transfer");
      }
      await this.member(userId, spaceId, client);
      if ((await this.member(r.from_user_id, spaceId, client)).role !== "owner") throw accountError(403, "invalid_owner_transfer");
      await client.query(`UPDATE account_memberships SET role=CASE WHEN user_id=$2 THEN 'owner' ELSE 'admin' END,
        revision=revision+1,updated_at=$3 WHERE space_id=$1 AND (role='owner' OR user_id=$2)`, [spaceId, userId, this.now()]);
      await client.query("UPDATE space_ownership_transfers SET status='accepted',accepted_at=$3 WHERE space_id=$1 AND id=$2",
        [spaceId, transferId, this.now()]);
      await this.emit(client, spaceId, userId, "ownership.accepted", "space", spaceId, 1, { transferId });
      return { membership: await this.accounts.membership(userId, spaceId, client) };
    });
  }

  async audit(userId, spaceId, { after = 0, documentId = null } = {}) {
    const member = await this.member(userId, spaceId);
    if (documentId) await this.requireDocument(userId, spaceId, documentId, "manage");
    else if (!isSpaceManager(member)) throw accountError(403, "space_management_required");
    const rows = (await this.pool.query(`SELECT * FROM space_authorization_outbox
      WHERE space_id=$1 AND sequence>$2 AND ($3::text IS NULL OR (object_type='document' AND object_id=$3))
      ORDER BY sequence LIMIT 500`, [spaceId, integerLimit(Number(after), { minimum: 0 }), documentId])).rows;
    return rows.map((r) => ({ sequence: num(r.sequence), actorId: r.actor_id, action: r.action,
      objectType: r.object_type, objectId: r.object_id, revision: num(r.revision),
      details: r.details_json, createdAt: num(r.created_at) }));
  }
}
