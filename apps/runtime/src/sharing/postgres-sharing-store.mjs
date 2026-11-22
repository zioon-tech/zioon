import { createHash, randomBytes, randomUUID } from "node:crypto";
import { accountError } from "../accounts/account-policy.mjs";
import { DocumentLinks } from "./document-links.mjs";

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const identifier = (kind) => `${kind}:${randomUUID()}`;
const DAY = 86_400_000;
const text = (value, max = 256) => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw accountError(400, "invalid_share_input");
  }
  return value.trim();
};
const positive = (value, fallback, max) => {
  const n = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw accountError(400, "invalid_share_limit");
  return n;
};
const shareRole = (kind, value) => {
  const role = value || (kind === "model" ? "use" : "viewer");
  if (!(kind === "model" ? role === "use" : ["viewer", "editor"].includes(role))) {
    throw accountError(400, "invalid_share_role");
  }
  return role;
};
const projection = (row) => ({
  id: row.id, kind: row.kind, sourceId: row.source_id, name: row.name, role: row.role,
  owner: { id: row.owner_id, name: row.owner_name || "" }, status: row.status,
  revision: Number(row.revision), monthlyCalls: row.monthly_calls,
  createdAt: Number(row.created_at), expiresAt: row.expires_at == null ? null : Number(row.expires_at),
  originSpaceId: row.origin_space_id
});
const pathTo = (node, id, path = []) => {
  if (!node || typeof node !== "object") return null;
  const next = [...path, node];
  if (node.id === id) return next;
  for (const child of node.children || []) {
    const found = pathTo(child, id, next);
    if (found) return found;
  }
  return null;
};

/** Account grants authorize use or content, never the owner's account settings. */
export class PostgresSharingStore {
  constructor({ accounts, now = () => Date.now() }) {
    Object.assign(this, { accounts, pool: accounts.pool, now });
    accounts.sharing = this;
    this.links = new DocumentLinks(this);
  }
  async lockContent(client, spaceId) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`shared-space:${spaceId}`]);
  }
  async transaction(action) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async ownerSpace(userId, client = this.pool) {
    const space = await this.accounts.personalSpace(userId, client);
    if (!space || (await this.accounts.membership(userId, space.id, client))?.role !== "owner") {
      throw accountError(403, "share_owner_required");
    }
    return space;
  }
  async tree(spaceId, client = this.pool) {
    return (await client.query("SELECT tree_json FROM runtime_workbench_state WHERE space_id=$1", [spaceId])).rows[0]?.tree_json;
  }
  /** Resolve display names by stable source IDs; stored names remain audit/fallback snapshots. */
  async contentNames(rows, client) {
    const names = new Map();
    for (const origin of [...new Set(rows.filter(row => row.kind !== "model").map(row => row.origin_space_id))]) {
      const shares = rows.filter(row => row.origin_space_id === origin && row.kind !== "model");
      const nodes = new Map();
      const walk = node => { if (!node) return; nodes.set(node.id, node); (node.children || []).forEach(walk); };
      walk(await this.tree(origin, client));
      const ids = shares.filter(row => row.kind === "document").map(row => row.source_id);
      const metadata = new Map(ids.length ? (await client.query(`SELECT m.id,m.meta_json->>'title' AS title
        FROM runtime_workbench_metadata m WHERE m.space_id=$1 AND m.id=ANY($2::text[])
          AND (EXISTS (SELECT 1 FROM runtime_workbench_documents d WHERE d.space_id=m.space_id AND d.id=m.id)
            OR EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.space_id=m.space_id AND s.id=m.id))`,
      [origin, ids])).rows.map(row => [row.id, row.title]) : []);
      for (const row of shares) {
        const node = nodes.get(row.source_id);
        const title = row.kind === "folder" ? node?.type === "folder" && node.title
          : metadata.get(row.source_id) || (node?.type === "session" && node.title);
        if (typeof title === "string" && title.trim()) names.set(row.id, title);
      }
    }
    return names;
  }
  async projectShares(userId, rows, client = this.pool) {
    if (!rows.some(row => row.kind !== "model")) return rows.map(projection);
    if (client === this.pool) return this.transaction(async tx => {
      for (const origin of [...new Set(rows.filter(row => row.kind !== "model").map(row => row.origin_space_id))].sort()) {
        await this.lockContent(tx, origin);
      }
      return this.projectShares(userId, rows, tx);
    });
    // A list can contain expired entries. Do not disclose subsequent renames after access ends.
    const allowed = new Set((await client.query(`SELECT s.id FROM account_shares s
      JOIN account_users u ON u.id=s.owner_id AND u.status='active'
      JOIN account_share_grants g ON g.share_id=s.id AND g.user_id=$1 AND g.status='active'
      JOIN account_users r ON r.id=g.user_id AND r.status='active'
      WHERE s.id=ANY($2::text[]) AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at>$3)
        AND (s.kind<>'document' OR NOT EXISTS (SELECT 1 FROM account_document_privacy p
          WHERE p.origin_space_id=s.origin_space_id AND p.document_id=s.source_id AND p.private))`,
    [userId, rows.filter(row => row.owner_id !== userId && row.kind !== "model").map(row => row.id), this.now()])).rows.map(row => row.id));
    const names = await this.contentNames(rows.filter(row => row.owner_id === userId || allowed.has(row.id)), client);
    return rows.map(row => ({ ...projection(row), name: names.get(row.id) || row.name }));
  }
  async contentExists(spaceId, id, client = this.pool) {
    return (await client.query(`SELECT 1 FROM runtime_workbench_documents WHERE space_id=$1 AND id=$2
      UNION ALL SELECT 1 FROM runtime_sessions WHERE space_id=$1 AND id=$2 LIMIT 1`, [spaceId, id])).rowCount > 0;
  }
  async markMemory(spaceId, documentId, client = this.pool) {
    await client.query(`INSERT INTO account_document_privacy (origin_space_id,document_id,updated_at)
      VALUES ($1,$2,$3) ON CONFLICT (origin_space_id,document_id) DO NOTHING`, [spaceId, documentId, this.now()]);
  }
  async resolveRecipient(userId, value, client = this.pool) {
    const input = text(value, 254), email = input.includes("@");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) throw accountError(400, "invalid_recipient", "请输入完整邮箱或账号 ID");
    const rows = (await client.query(`SELECT DISTINCT u.id,u.name FROM account_users u
      ${email ? "JOIN account_verified_addresses a ON a.user_id=u.id" : ""}
      WHERE u.status='active' AND ${email ? "a.email=$1" : "u.id=$1"}`, [email ? input.toLowerCase() : input])).rows;
    if (rows.length !== 1) throw accountError(404, "share_recipient_unavailable",
      rows.length > 1 ? "此邮箱对应多个账号，请使用对方的账号 ID" : "未找到可授权的账号，请确认邮箱已注册并验证，或使用账号 ID");
    if (rows[0].id === userId) throw accountError(400, "cannot_accept_own_share", "无需给自己添加授权");
    return rows[0];
  }
  async grantRecipient(client, share, recipient, role) {
    const existing = (await client.query("SELECT * FROM account_share_grants WHERE share_id=$1 AND user_id=$2",
      [share.id, recipient.id])).rows[0];
    // Adding the same collaborator again must never silently downgrade them.
    const next = existing?.status === "active" && existing.role === "editor" ? "editor" : shareRole(share.kind, role);
    await client.query(`INSERT INTO account_share_grants (share_id,user_id,invitation_id,role,accepted_at)
      VALUES ($1,$2,NULL,$3,$4) ON CONFLICT (share_id,user_id) DO UPDATE
      SET status='active',role=$3,accepted_at=$4,revoked_at=NULL`,
    [share.id, recipient.id, next, this.now()]);
    return { ...recipient, role: next, status: "active" };
  }
  async create(userId, input, source = null) {
    const space = await this.ownerSpace(userId);
    const kind = input.kind, sourceId = text(input.sourceId), name = text(input.name || source?.name || "分享", 160);
    if (!["model", "document", "folder"].includes(kind)) throw accountError(400, "share_kind_not_available");
    const role = shareRole(kind, input.role);
    if (kind === "model" && (!source || source.id !== sourceId || source.kind !== "model")) {
      throw accountError(409, "share_source_unavailable");
    }
    const monthlyCalls = kind === "model" ? positive(input.monthlyCalls, 1000, 1_000_000) : null;
    const duration = input.durationDays == null ? null : positive(input.durationDays, 30, 365) * DAY;
    const inviteDays = positive(input.inviteDays, 7, 30), maxClaims = positive(input.maxClaims, 1, 100);
    return this.transaction(async client => {
      await this.lockContent(client, space.id);
      if (kind === "document" && !await this.contentExists(space.id, sourceId, client)) throw accountError(404, "document_not_found");
      if (kind === "folder" && pathTo(await this.tree(space.id, client), sourceId)?.at(-1)?.type !== "folder") {
        throw accountError(404, "folder_not_found");
      }
      const recipient = input.recipient == null ? null : await this.resolveRecipient(userId, input.recipient, client);
      const id = identifier("share"), now = this.now();
      const row = (await client.query(`INSERT INTO account_shares
        (id,owner_id,origin_space_id,kind,source_id,name,source_version,role,monthly_calls,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, userId, space.id, kind, sourceId, name, source?.version || "", role, monthlyCalls, now, duration && now + duration])).rows[0];
      if (kind === "document") await this.markMemory(space.id, sourceId, client);
      const invitation = recipient ? null : await this.newInvitation(client, id, inviteDays, maxClaims);
      const granted = recipient ? await this.grantRecipient(client, row, recipient, role) : null;
      await this.event(client, id, userId, "created");
      if (recipient) await this.event(client, id, userId, "recipient_added", { recipientId: recipient.id, role });
      return { share: (await this.projectShares(userId, [row], client))[0], ...(invitation ? { invitation } : { recipient: granted }) };
    });
  }
  async event(client, shareId, userId, action, details = {}) {
    await client.query("INSERT INTO account_sharing_events (share_id,actor_id,action,created_at,details_json) VALUES ($1,$2,$3,$4,$5)",
      [shareId, userId, action, this.now(), JSON.stringify(details)]);
  }
  async newInvitation(client, shareId, days, maxClaims) {
    const token = randomBytes(32).toString("base64url"), id = identifier("share-invite"), expiresAt = this.now() + days * DAY;
    await client.query(`INSERT INTO account_share_invitations
      (id,share_id,token_hash,max_claims,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, shareId, hash(token), maxClaims, this.now(), expiresAt]);
    return { id, token, expiresAt, maxClaims };
  }
  async invite(userId, shareId, input = {}) {
    return this.transaction(async client => {
      const share = await this.requireOwner(userId, shareId, client, true);
      if (share.status !== "active" || share.expires_at && Number(share.expires_at) <= this.now()) {
        throw accountError(409, "share_access_revoked", "分享已失效，请创建新的分享");
      }
      const result = await this.newInvitation(client, shareId,
        positive(input.inviteDays, 7, 30), positive(input.maxClaims, 1, 100));
      await this.event(client, shareId, userId, "invited");
      return result;
    });
  }
  async preview(token) {
    text(token, 128);
    return this.transaction(async client => {
      const source = (await client.query(`SELECT s.origin_space_id FROM account_share_invitations i
        JOIN account_shares s ON s.id=i.share_id WHERE i.token_hash=$1`, [hash(token)])).rows[0];
      if (!source) throw accountError(404, "share_invitation_unavailable", "邀请已失效或已被使用");
      await this.lockContent(client, source.origin_space_id);
      const row = (await client.query(`SELECT s.*,u.name AS owner_name,i.expires_at AS invite_expires_at
      FROM account_share_invitations i JOIN account_shares s ON s.id=i.share_id
      JOIN account_users u ON u.id=s.owner_id
      WHERE i.token_hash=$1 AND i.status='active' AND i.claims<i.max_claims AND i.expires_at>$2
        AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at>$2) AND u.status='active'
        AND (s.kind<>'document' OR NOT EXISTS (SELECT 1 FROM account_document_privacy p
          WHERE p.origin_space_id=s.origin_space_id AND p.document_id=s.source_id AND p.private))`,
      [hash(token), this.now()])).rows[0];
      if (!row) throw accountError(404, "share_invitation_unavailable", "邀请已失效或已被使用");
      const names = await this.contentNames([row], client);
      return { share: { ...projection(row), name: names.get(row.id) || row.name }, inviteExpiresAt: Number(row.invite_expires_at) };
    });
  }
  async accept(userId, token) {
    text(token, 128);
    return this.transaction(async client => {
      // All grant/dispatch mutations lock the share first to avoid deadlocks.
      const found = (await client.query("SELECT share_id FROM account_share_invitations WHERE token_hash=$1", [hash(token)])).rows[0];
      if (!found) throw accountError(404, "share_invitation_unavailable");
      const origin = (await client.query("SELECT origin_space_id FROM account_shares WHERE id=$1", [found.share_id])).rows[0];
      await this.lockContent(client, origin.origin_space_id);
      const share = (await client.query("SELECT * FROM account_shares WHERE id=$1 FOR UPDATE", [found.share_id])).rows[0];
      const invite = (await client.query("SELECT * FROM account_share_invitations WHERE token_hash=$1 FOR UPDATE", [hash(token)])).rows[0];
      const existing = (await client.query("SELECT * FROM account_share_grants WHERE share_id=$1 AND user_id=$2",
        [share.id, userId])).rows[0];
      if (share.owner_id === userId) throw accountError(400, "cannot_accept_own_share", "这是你发出的分享");
      if (share.status !== "active" || share.expires_at && Number(share.expires_at) <= this.now()
        || invite.status !== "active" || Number(invite.expires_at) <= this.now()) throw accountError(404, "share_invitation_unavailable");
      if (!(await client.query("SELECT 1 FROM account_users WHERE id=$1 AND status='active'", [share.owner_id])).rowCount
        || share.kind === "document" && (await client.query(`SELECT 1 FROM account_document_privacy
          WHERE origin_space_id=$1 AND document_id=$2 AND private`, [share.origin_space_id, share.source_id])).rowCount) {
        throw accountError(404, "share_invitation_unavailable");
      }
      if (existing?.status === "active" && existing.invitation_id === invite.id) {
        return { share: (await this.projectShares(userId, [{ ...share, role: existing.role }], client))[0], duplicate: true };
      }
      if (invite.claims >= invite.max_claims || existing?.status === "revoked" && existing.invitation_id === invite.id) {
        throw accountError(404, "share_invitation_unavailable");
      }
      // Accepting another link cannot undo an owner's explicit per-user downgrade.
      const role = existing?.status === "active" ? existing.role : share.role;
      await client.query(`INSERT INTO account_share_grants (share_id,user_id,invitation_id,role,accepted_at)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (share_id,user_id) DO UPDATE
        SET invitation_id=$3,status='active',role=$4,accepted_at=$5,revoked_at=NULL`,
      [share.id, userId, invite.id, role, this.now()]);
      await client.query("UPDATE account_share_invitations SET claims=claims+1 WHERE id=$1", [invite.id]);
      await this.event(client, share.id, userId, "accepted");
      return { share: (await this.projectShares(userId, [{ ...share, role }], client))[0], duplicate: false };
    });
  }
  async requireOwner(userId, id, client = this.pool, lock = false) {
    if (lock) {
      const source = (await client.query("SELECT origin_space_id FROM account_shares WHERE id=$1 AND owner_id=$2", [id, userId])).rows[0];
      if (!source) throw accountError(404, "share_not_found");
      await this.lockContent(client, source.origin_space_id);
    }
    const row = (await client.query(`SELECT * FROM account_shares WHERE id=$1 AND owner_id=$2${lock ? " FOR UPDATE" : ""}`,
      [id, userId])).rows[0];
    if (!row) throw accountError(404, "share_not_found");
    return row;
  }
  async requireGrant(userId, id, client = this.pool, lock = false) {
    if (client === this.pool) return this.transaction(tx => this.requireGrant(userId, id, tx, true));
    if (lock) {
      const source = (await client.query("SELECT origin_space_id FROM account_shares WHERE id=$1", [id])).rows[0];
      if (!source) throw accountError(403, "share_access_revoked");
      await this.lockContent(client, source.origin_space_id);
    }
    const row = (await client.query(`SELECT s.*,g.role,u.name AS owner_name FROM account_shares s
      JOIN account_share_grants g ON g.share_id=s.id JOIN account_users u ON u.id=s.owner_id
      JOIN account_users r ON r.id=g.user_id
      WHERE s.id=$1 AND g.user_id=$2 AND s.status='active' AND g.status='active'
        AND (s.expires_at IS NULL OR s.expires_at>$3) AND u.status='active' AND r.status='active'
        AND (s.kind<>'document' OR NOT EXISTS (SELECT 1 FROM account_document_privacy p
          WHERE p.origin_space_id=s.origin_space_id AND p.document_id=s.source_id AND p.private))
      ${lock ? "FOR UPDATE OF s,g" : ""}`, [id, userId, this.now()])).rows[0];
    if (!row) throw accountError(403, "share_access_revoked", "分享已失效，请联系提供者");
    return { ...(await this.projectShares(userId, [row], client))[0], providerId: row.owner_id, originResourceId: row.source_id,
      sourceVersion: row.source_version };
  }
  async list(userId, direction = "received") {
    const sent = direction === "sent";
    const rows = (await this.pool.query(`SELECT s.*,${sent ? "" : "g.role,"}u.name AS owner_name
      FROM account_shares s JOIN account_users u ON u.id=s.owner_id
      ${sent ? "" : "JOIN account_share_grants g ON g.share_id=s.id"}
      WHERE ${sent ? "s.owner_id=$1" : "g.user_id=$1 AND g.status='active' AND s.status='active'"}
      ORDER BY s.created_at DESC`, [userId])).rows;
    const result = [], projected = await this.projectShares(userId, rows);
    for (const [index, row] of rows.entries()) {
      const share = projected[index];
      if (sent) {
        share.recipients = (await this.pool.query(`SELECT g.user_id AS id,u.name,g.role,g.status,g.accepted_at
          FROM account_share_grants g JOIN account_users u ON u.id=g.user_id WHERE g.share_id=$1`, [row.id])).rows
          .map(g => ({ id: g.id, name: g.name, role: g.role, status: g.status, acceptedAt: Number(g.accepted_at) }));
        share.invitations = (await this.pool.query(`SELECT id,status,claims,max_claims,expires_at
          FROM account_share_invitations WHERE share_id=$1 ORDER BY created_at DESC`, [row.id])).rows
          .map(i => ({ id: i.id, status: i.status, claims: i.claims, maxClaims: i.max_claims, expiresAt: Number(i.expires_at) }));
        share.usage = await this.usage(userId, row.id);
      }
      result.push(share);
    }
    return result;
  }
  async addRecipient(userId, shareId, input) {
    return this.transaction(async client => {
      const share = await this.requireOwner(userId, shareId, client, true);
      if (share.status !== "active" || share.expires_at && Number(share.expires_at) <= this.now()) {
        throw accountError(409, "share_access_revoked", "分享已失效，请创建新的分享");
      }
      const recipient = await this.resolveRecipient(userId, input.recipient, client);
      const granted = await this.grantRecipient(client, share, recipient, shareRole(share.kind, input.role || share.role));
      await this.event(client, shareId, userId, "recipient_added", { recipientId: recipient.id, role: granted.role });
      return { recipient: granted };
    });
  }
  async updateRecipient(userId, shareId, recipientId, role) {
    text(role, 16);
    return this.transaction(async client => {
      const share = await this.requireOwner(userId, shareId, client, true);
      shareRole(share.kind, role);
      if (share.status !== "active" || share.expires_at && Number(share.expires_at) <= this.now()) {
        throw accountError(409, "share_access_revoked");
      }
      const updated = await client.query(`UPDATE account_share_grants SET role=$3
        WHERE share_id=$1 AND user_id=$2 AND status='active' RETURNING user_id`, [shareId, text(recipientId), role]);
      if (!updated.rowCount) throw accountError(404, "share_recipient_unavailable");
      await this.event(client, shareId, userId, "recipient_role_changed", { recipientId, role });
      return { updated: true, role };
    });
  }
  async updateDocumentCollaborator(userId, documentId, recipientId, role) {
    if (!["viewer", "editor", "removed"].includes(role)) throw accountError(400, "invalid_share_role");
    const space = await this.ownerSpace(userId);
    text(documentId); text(recipientId);
    if (recipientId === userId) throw accountError(400, "share_owner_required");
    return this.transaction(async client => {
      await this.lockContent(client, space.id);
      await this.documentAccess(userId, space.id, documentId, "manage", client);
      const folders = (pathTo(await this.tree(space.id, client), documentId) || [])
        .filter(node => node.type === "folder").map(node => node.id);
      const rows = (await client.query(`SELECT s.*,g.role FROM account_shares s
        JOIN account_share_grants g ON g.share_id=s.id
        WHERE s.owner_id=$1 AND s.origin_space_id=$2 AND g.user_id=$3 AND s.status='active' AND g.status='active'
          AND (s.expires_at IS NULL OR s.expires_at>$4)
          AND ((s.kind='document' AND s.source_id=$5) OR (s.kind='folder' AND s.source_id=ANY($6::text[])))
        FOR UPDATE OF s,g`, [userId, space.id, recipientId, this.now(), documentId, folders])).rows;
      const inherited = rows.filter(row => row.kind === "folder");
      if (role === "viewer" && inherited.some(row => row.role === "editor")) {
        throw accountError(409, "document_permission_inherited", "此用户通过文件夹拥有编辑权限，请先修改对应文件夹的授权");
      }
      const direct = rows.filter(row => row.kind === "document");
      if (!direct.length) throw accountError(409, "document_permission_inherited", "此用户的权限来自文件夹，请管理文件夹授权；也可在此添加会话授权");
      for (const share of direct) {
        if (role === "removed") await client.query(`UPDATE account_share_grants SET status='revoked',revoked_at=$3
          WHERE share_id=$1 AND user_id=$2`, [share.id, recipientId, this.now()]);
        else await client.query("UPDATE account_share_grants SET role=$3 WHERE share_id=$1 AND user_id=$2", [share.id, recipientId, role]);
        await this.event(client, share.id, userId, role === "removed" ? "recipient_revoked" : "recipient_role_changed", { recipientId, role });
      }
      return { updated: true, inherited: inherited.length > 0 };
    });
  }
  async updateSourceCollaborator(userId, kind, sourceId, recipientId, role) {
    if (!["model", "folder"].includes(kind) || !(role === "removed" || (kind === "model" ? role === "use" : ["viewer", "editor"].includes(role)))) {
      throw accountError(400, "invalid_share_role");
    }
    text(sourceId); text(recipientId);
    const space = await this.ownerSpace(userId);
    return this.transaction(async client => {
      await this.lockContent(client, space.id);
      const rows = (await client.query(`SELECT s.id FROM account_shares s JOIN account_share_grants g ON g.share_id=s.id
        WHERE s.owner_id=$1 AND s.origin_space_id=$2 AND s.kind=$3 AND s.source_id=$4 AND g.user_id=$5
          AND s.status='active' AND g.status='active' AND (s.expires_at IS NULL OR s.expires_at>$6)
        FOR UPDATE OF s,g`, [userId, space.id, kind, sourceId, recipientId, this.now()])).rows;
      if (!rows.length) throw accountError(404, "share_recipient_unavailable");
      for (const share of rows) {
        if (role === "removed") await client.query(`UPDATE account_share_grants SET status='revoked',revoked_at=$3
          WHERE share_id=$1 AND user_id=$2`, [share.id, recipientId, this.now()]);
        else await client.query("UPDATE account_share_grants SET role=$3 WHERE share_id=$1 AND user_id=$2", [share.id, recipientId, role]);
        await this.event(client, share.id, userId, role === "removed" ? "recipient_revoked" : "recipient_role_changed", { recipientId, role });
      }
      return { updated: true };
    });
  }
  async revoke(userId, shareId, { recipientId = null, invitationId = null } = {}) {
    return this.transaction(async client => {
      const row = await this.requireOwner(userId, shareId, client, true);
      if (recipientId) await client.query(`UPDATE account_share_grants SET status='revoked',revoked_at=$3
        WHERE share_id=$1 AND user_id=$2`, [shareId, recipientId, this.now()]);
      else if (invitationId) await client.query(`UPDATE account_share_invitations SET status='revoked'
        WHERE share_id=$1 AND id=$2`, [shareId, invitationId]);
      else {
        await client.query("UPDATE account_shares SET status='revoked',revision=revision+1 WHERE id=$1", [shareId]);
        await client.query("UPDATE account_share_invitations SET status='revoked' WHERE share_id=$1", [shareId]);
      }
      await this.event(client, shareId, userId, recipientId ? "recipient_revoked" : invitationId ? "invitation_revoked" : "revoked", { recipientId, invitationId });
      return { revoked: true, kind: row.kind };
    });
  }
  async leave(userId, shareId) {
    await this.transaction(async client => {
      const source = (await client.query("SELECT origin_space_id FROM account_shares WHERE id=$1", [shareId])).rows[0];
      if (source) await this.lockContent(client, source.origin_space_id);
      await client.query(`UPDATE account_share_grants SET status='revoked',revoked_at=$3
        WHERE share_id=$1 AND user_id=$2`, [shareId, userId, this.now()]);
    });
    return { removed: true };
  }
  async setPrivate(userId, documentId, isPrivate) {
    if (typeof isPrivate !== "boolean") throw accountError(400, "invalid_document_privacy");
    const space = await this.ownerSpace(userId);
    if (!await this.contentExists(space.id, documentId)) throw accountError(404, "document_not_found");
    await this.transaction(async client => {
      await this.lockContent(client, space.id);
      await client.query(`INSERT INTO account_document_privacy (origin_space_id,document_id,private,updated_at)
      VALUES ($1,$2,$3,$4) ON CONFLICT (origin_space_id,document_id) DO UPDATE
      SET private=$3,revision=account_document_privacy.revision+1,updated_at=$4`, [space.id, documentId, isPrivate, this.now()]);
    });
    return { private: isPrivate };
  }
  async documentPrivacy(userId, documentId) {
    const space = await this.ownerSpace(userId);
    if (!await this.contentExists(space.id, documentId)) throw accountError(404, "document_not_found");
    const row = (await this.pool.query("SELECT private FROM account_document_privacy WHERE origin_space_id=$1 AND document_id=$2",
      [space.id, documentId])).rows[0];
    return { private: !!row?.private, sharedContent: await this.sharedMemory(space.id, documentId) };
  }
  async documentAccess(userId, originSpaceId, documentId, action = "view", client = this.pool) {
    if (!await this.contentExists(originSpaceId, documentId, client)) throw accountError(404, "document_not_found");
    const space = await this.accounts.space(originSpaceId, client);
    if (space?.kind !== "personal") throw accountError(404, "document_not_found");
    const privacy = (await client.query(`SELECT * FROM account_document_privacy
      WHERE origin_space_id=$1 AND document_id=$2`, [originSpaceId, documentId])).rows[0];
    if (space.createdBy === userId) return { ownerId: userId, originSpaceId, documentId, role: "owner", private: !!privacy?.private };
    if (privacy?.private) throw accountError(404, "document_not_found");
    const path = pathTo(await this.tree(originSpaceId, client), documentId) || [];
    const folders = path.filter(n => n.type === "folder").map(n => n.id);
    const rows = (await client.query(`SELECT s.*,g.role FROM account_shares s JOIN account_share_grants g ON g.share_id=s.id
      JOIN account_users u ON u.id=s.owner_id
      WHERE s.origin_space_id=$1 AND g.user_id=$2 AND s.status='active' AND g.status='active'
        AND (s.expires_at IS NULL OR s.expires_at>$3) AND u.status='active'
        AND ((s.kind='document' AND s.source_id=$4) OR (s.kind='folder' AND s.source_id=ANY($5::text[])))`,
    [originSpaceId, userId, this.now(), documentId, folders])).rows;
    const usable = rows.find(s => s.role === "editor") || rows[0];
    if (!usable || action === "manage" || action === "edit" && usable.role !== "editor") throw accountError(404, "document_not_found");
    await this.markMemory(originSpaceId, documentId, client);
    return { ownerId: space.createdBy, originSpaceId, documentId, role: usable.role, shareId: usable.id,
      inherited: usable.kind === "folder", private: false };
  }
  async documentParticipants(userId, originSpaceId, documentId) {
    text(originSpaceId); text(documentId);
    return this.transaction(async client => {
      await this.lockContent(client, originSpaceId);
      const access = await this.documentAccess(userId, originSpaceId, documentId, "view", client);
      const owner = (await client.query("SELECT id,name FROM account_users WHERE id=$1 AND status='active'",
        [access.ownerId])).rows[0];
      if (!owner) throw accountError(404, "document_not_found");
      const participants = [{ id: owner.id, name: owner.name || "", role: "owner", inherited: false }];
      let rows = [];
      if (!access.private) {
        const folders = (pathTo(await this.tree(originSpaceId, client), documentId) || [])
          .filter(node => node.type === "folder").map(node => node.id);
        rows = (await client.query(`SELECT u.id,u.name,g.role,s.id AS share_id,s.kind,s.source_id,s.name AS share_name
          FROM account_shares s JOIN account_share_grants g ON g.share_id=s.id
          JOIN account_users u ON u.id=g.user_id
          WHERE s.origin_space_id=$1 AND s.owner_id=$2 AND s.status='active' AND g.status='active'
            AND u.status='active' AND u.id<>$2 AND (s.expires_at IS NULL OR s.expires_at>$3)
            AND ((s.kind='document' AND s.source_id=$4) OR (s.kind='folder' AND s.source_id=ANY($5::text[])))
          ORDER BY u.name,u.id,s.created_at`,
        [originSpaceId, owner.id, this.now(), documentId, folders])).rows;
      }
      const titleKey = "document-title";
      const names = await this.contentNames([
        ...rows.map(row => ({ ...row, id: row.share_id, origin_space_id: originSpaceId })),
        { id: titleKey, kind: "document", source_id: documentId, origin_space_id: originSpaceId }
      ], client);
      const people = new Map();
      for (const row of rows) {
        const person = people.get(row.id) || { id: row.id, name: row.name, role: "viewer", inherited: true, grants: [] };
        person.grants.push({ shareId: row.share_id, kind: row.kind, sourceId: row.source_id,
          name: names.get(row.share_id) || row.share_name, role: row.role });
        if (row.role === "editor") person.role = "editor";
        people.set(row.id, person);
      }
      for (const person of people.values()) {
        person.inherited = person.grants.filter(grant => grant.role === person.role).every(grant => grant.kind === "folder");
        if (userId !== owner.id) delete person.grants;
        participants.push(person);
      }
      return { documentId, title: names.get(titleKey) || documentId, originSpaceId, selfId: userId, participants };
    });
  }
  /** A display-only catalog. No bodies, private metadata, or owner catalog is exposed. */
  async contentIndex(userId) {
    const own = await this.ownerSpace(userId);
    return this.transaction(async client => {
      const origins = (await client.query(`SELECT DISTINCT s.origin_space_id FROM account_shares s
        JOIN account_share_grants g ON g.share_id=s.id
        WHERE g.user_id=$1 AND g.status='active' AND s.status='active' AND s.kind IN ('document','folder')`,
      [userId])).rows.map(row => row.origin_space_id);
      for (const origin of [...new Set([own.id, ...origins])].sort()) await this.lockContent(client, origin);
      const rows = (await client.query(`SELECT s.*,
        CASE WHEN s.owner_id=$1 THEN s.role ELSE (SELECT g.role FROM account_share_grants g
          WHERE g.share_id=s.id AND g.user_id=$1) END AS role,u.name AS owner_name FROM account_shares s
        JOIN account_users u ON u.id=s.owner_id
        JOIN account_spaces a ON a.id=s.origin_space_id
        WHERE s.kind IN ('document','folder') AND s.status='active' AND u.status='active'
          AND a.kind='personal' AND a.created_by=s.owner_id
          AND s.origin_space_id=ANY($3::text[])
          AND (s.expires_at IS NULL OR s.expires_at>$2)
          AND (s.owner_id=$1 OR EXISTS (SELECT 1 FROM account_share_grants g
            JOIN account_users r ON r.id=g.user_id
            WHERE g.share_id=s.id AND g.user_id=$1 AND g.status='active' AND r.status='active'))
        ORDER BY s.created_at DESC,s.id`, [userId, this.now(), [...new Set([own.id, ...origins])]])).rows;
      const received = [], sentIds = new Set();
      for (const origin of [...new Set(rows.map(row => row.origin_space_id))]) {
        const shares = rows.filter(row => row.origin_space_id === origin);
        const tree = await this.tree(origin, client);
        const metadata = new Map((await client.query(`SELECT d.id,d.updated_at,m.meta_json
          FROM (SELECT id,MAX(updated_at) AS updated_at FROM
            (SELECT id,updated_at FROM runtime_workbench_documents WHERE space_id=$1
              UNION ALL SELECT id,updated_at FROM runtime_sessions WHERE space_id=$1) content GROUP BY id) d
          LEFT JOIN runtime_workbench_metadata m ON m.space_id=$1 AND m.id=d.id`,
        [origin])).rows.map(row => [row.id, row]));
        const privateIds = new Set((await client.query(`SELECT document_id FROM account_document_privacy
          WHERE origin_space_id=$1 AND private`, [origin])).rows.map(row => row.document_id));
        const roots = new Map();
        const roles = new Map();
        const project = (node, grant) => {
          if (!node || !["folder", "session"].includes(node.type)) return null;
          if (node.type === "session" && (!metadata.has(node.id) || privateIds.has(node.id))) return null;
          const previous = roles.get(node.id);
          roles.set(node.id, previous === "editor" || grant.role === "editor" ? "editor" : "viewer");
          if (origin === own.id) sentIds.add(node.id);
          const meta = metadata.get(node.id);
          const result = { id: node.id, type: node.type,
            title: String(meta?.meta_json?.title || node.title || grant.name || node.id),
            originSpaceId: origin, providerName: grant.owner_name || "", shareId: grant.id };
          if (node.type === "folder") result.children = (node.children || []).map(child => project(child, grant)).filter(Boolean);
          else result.updatedAt = Number(meta?.updated_at || 0);
          return result;
        };
        for (const grant of shares) {
          let node = pathTo(tree, grant.source_id)?.at(-1);
          if (grant.kind === "document" && metadata.has(grant.source_id)) {
            node = { id: grant.source_id, type: "session", title: node?.title || grant.name };
          }
          if (node?.type !== (grant.kind === "document" ? "session" : "folder")) continue;
          const root = project(node, grant);
          if (root) roots.set(root.id, root);
        }
        // Overlapping folder/direct grants retain one hierarchy and the strongest permission.
        const contained = new Set();
        const descend = node => { for (const child of node.children || []) { contained.add(child.id); descend(child); } };
        for (const root of roots.values()) descend(root);
        const applyRoles = node => ({ ...node, role: roles.get(node.id),
          ...(node.children ? { children: node.children.map(applyRoles) } : {}) });
        if (origin !== own.id) received.push(...[...roots.values()].filter(node => !contained.has(node.id)).map(applyRoles));
      }
      return { received, sentIds: [...sentIds] };
    });
  }
  async sharedMemory(originSpaceId, documentId) {
    if (!documentId) return false;
    if ((await this.pool.query(`SELECT 1 FROM account_document_privacy
      WHERE origin_space_id=$1 AND document_id=$2 AND memory_scoped`, [originSpaceId, documentId])).rowCount) return true;
    const path = pathTo(await this.tree(originSpaceId), documentId) || [];
    const ids = path.map(n => n.id);
    const shared = (await this.pool.query(`SELECT 1 FROM account_shares
      WHERE origin_space_id=$1 AND source_id=ANY($2::text[]) AND kind IN ('document','folder') LIMIT 1`, [originSpaceId, ids])).rowCount > 0;
    if (shared) await this.markMemory(originSpaceId, documentId);
    return shared;
  }
  async folderDocuments(userId, shareId) {
    return this.transaction(async client => {
      const share = await this.requireGrant(userId, shareId, client, true);
      if (share.kind !== "folder") throw accountError(400, "folder_share_required");
      const root = pathTo(await this.tree(share.originSpaceId, client), share.sourceId)?.at(-1);
      const documents = [];
      const walk = node => { if (!node) return; if (node.type === "session") documents.push({
        id: node.id, source_id: node.id, kind: "document", origin_space_id: share.originSpaceId
      }); (node.children || []).forEach(walk); };
      walk(root);
      const names = await this.contentNames(documents, client);
      const prune = async node => {
        if (!node) return null;
        if (node.type === "session") {
          try {
            await this.documentAccess(userId, share.originSpaceId, node.id, "view", client);
            return { id: node.id, type: node.type, title: names.get(node.id) || node.title };
          } catch (error) { if (error.statusCode === 404) return null; throw error; }
        }
        const children = [];
        for (const child of node.children || []) { const found = await prune(child); if (found) children.push(found); }
        return { id: node.id, type: "folder", title: node.title, children };
      };
      return { share, tree: await prune(root) };
    });
  }
  async reserve(userId, shareId, { runId, attemptId, turn, inputHash }) {
    return this.transaction(async client => {
      const share = await this.requireGrant(userId, shareId, client, true);
      if (share.kind !== "model") throw accountError(403, "model_share_required");
      const period = new Date(this.now()).toISOString().slice(0, 7);
      const previous = (await client.query(`SELECT * FROM account_share_model_calls
        WHERE share_id=$1 AND run_id=$2 AND attempt_id=$3 AND turn_key=$4`,
      [shareId, text(runId), text(attemptId), String(turn ?? 0)])).rows[0];
      if (previous) throw accountError(409, previous.input_hash === inputHash ? "share_dispatch_already_recorded" : "share_dispatch_conflict",
        "此模型调用已有记录，请查看原任务结果");
      if ((await client.query(`SELECT 1 FROM account_share_model_calls
        WHERE share_id=$1 AND run_id=$2 AND state IN ('dispatched','pending') LIMIT 1`, [shareId, runId])).rowCount) {
        throw accountError(409, "share_outcome_requires_reconciliation", "此前的模型调用结果尚未确认，请先查看原任务结果");
      }
      const used = Number((await client.query(`SELECT COUNT(*) AS n FROM account_share_model_calls
        WHERE share_id=$1 AND period_key=$2 AND state<>'released'`, [shareId, period])).rows[0].n);
      if (used >= share.monthlyCalls) throw accountError(429, "share_model_quota_exceeded", "此分享本月的模型调用额度已用完");
      const id = identifier("share-call");
      await client.query(`INSERT INTO account_share_model_calls
        (id,share_id,requester_id,run_id,attempt_id,turn_key,input_hash,period_key,state,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9,$9)`,
      [id, shareId, userId, runId, attemptId, String(turn ?? 0), inputHash, period, this.now()]);
      return { id };
    });
  }
  async dispatch(id) {
    const row = (await this.pool.query(`UPDATE account_share_model_calls SET state='dispatched',updated_at=$2
      WHERE id=$1 AND state='reserved' RETURNING id`, [id, this.now()])).rows[0];
    if (!row) throw accountError(409, "share_dispatch_already_recorded");
  }
  async finish(id, { complete = false, usage = null } = {}) {
    await this.pool.query(`UPDATE account_share_model_calls SET
      state=CASE WHEN state='reserved' THEN 'released' WHEN $2 THEN 'settled' ELSE 'pending' END,
      input_tokens=$3,output_tokens=$4,updated_at=$5 WHERE id=$1 AND state IN ('reserved','dispatched')`,
    [id, complete, usage?.inputTokens ?? usage?.promptTokens ?? null, usage?.outputTokens ?? usage?.completionTokens ?? null, this.now()]);
  }
  async usage(userId, shareId) {
    const share = await this.requireOwner(userId, shareId);
    const period = new Date(this.now()).toISOString().slice(0, 7);
    const rows = (await this.pool.query(`SELECT state,COUNT(*)::integer AS calls FROM account_share_model_calls
      WHERE share_id=$1 AND period_key=$2 GROUP BY state`, [shareId, period])).rows;
    return { period, limit: share.monthly_calls, calls: rows.filter(r => r.state !== "released").reduce((n, r) => n + r.calls, 0),
      pending: rows.find(r => r.state === "pending")?.calls || 0 };
  }
}
