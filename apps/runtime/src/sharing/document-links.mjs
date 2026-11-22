import { createHash, randomBytes, randomUUID } from "node:crypto";
import { accountError } from "../accounts/account-policy.mjs";
import { projectPublicCards } from "../../../../src/chat/public-document.mjs";

const unavailable = () => accountError(404, "document_link_unavailable", "链接不可用或会话已设为私密");
const requestProjection = row => ({ id: row.id, userId: row.user_id, name: row.name || "",
  role: row.role, message: row.message, status: row.status, updatedAt: Number(row.updated_at) });
const linkProjection = row => row ? ({ id: row.id, mode: row.mode, revision: Number(row.revision) }) : null;

/** Stable links authorize reading only. Approved requests use ordinary account grants. */
export class DocumentLinks {
  constructor(sharing) { this.sharing = sharing; }
  async document(client, row) {
    const result = (await client.query(`SELECT d.text,m.meta_json->>'title' AS title,
      m.meta_json->'annotations' AS annotations, GREATEST(d.updated_at,m.updated_at) AS updated_at
      FROM runtime_workbench_documents d LEFT JOIN runtime_workbench_metadata m
      ON m.space_id=d.space_id AND m.id=d.id WHERE d.space_id=$1 AND d.id=$2`,
    [row.origin_space_id, row.document_id])).rows[0];
    if (!result || typeof result.text !== "string") throw unavailable();
    return result;
  }
  async resolve(client, id) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(String(id))) throw unavailable();
    const row = (await client.query(`SELECT l.*,p.private FROM account_document_links l
      JOIN account_users u ON u.id=l.owner_id AND u.status='active'
      LEFT JOIN account_document_privacy p ON p.origin_space_id=l.origin_space_id AND p.document_id=l.document_id
      WHERE l.id=$1`, [id])).rows[0];
    if (!row) throw unavailable();
    await this.sharing.lockContent(client, row.origin_space_id);
    // Re-read after the shared content lock, so a queued revoke/private change wins.
    const current = (await client.query(`SELECT l.*,p.private FROM account_document_links l
      JOIN account_users u ON u.id=l.owner_id AND u.status='active'
      LEFT JOIN account_document_privacy p ON p.origin_space_id=l.origin_space_id AND p.document_id=l.document_id
      WHERE l.id=$1`, [id])).rows[0];
    if (!current || current.mode === "disabled" || current.private) throw unavailable();
    await this.document(client, current);
    return current;
  }
  async get(userId, documentId) {
    const s = this.sharing, space = await s.ownerSpace(userId);
    return s.transaction(async client => {
      await s.lockContent(client, space.id);
      await this.document(client, { origin_space_id: space.id, document_id: documentId });
      const row = (await client.query("SELECT * FROM account_document_links WHERE origin_space_id=$1 AND document_id=$2",
        [space.id, documentId])).rows[0];
      return { link: linkProjection(row) };
    });
  }
  async set(userId, documentId, mode) {
    if (!["restricted", "public", "disabled"].includes(mode)) throw accountError(400, "invalid_link_mode");
    const s = this.sharing, space = await s.ownerSpace(userId);
    return s.transaction(async client => {
      await s.lockContent(client, space.id);
      await this.document(client, { origin_space_id: space.id, document_id: documentId });
      const privacy = (await client.query("SELECT private FROM account_document_privacy WHERE origin_space_id=$1 AND document_id=$2",
        [space.id, documentId])).rows[0];
      if (mode === "public" && privacy?.private) throw accountError(409, "document_is_private", "请先取消会话私密，再开启公开阅读");
      const row = (await client.query(`INSERT INTO account_document_links
        (id,owner_id,origin_space_id,document_id,mode,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)
        ON CONFLICT (origin_space_id,document_id) DO UPDATE SET mode=$5,revision=account_document_links.revision+1,updated_at=$6
        RETURNING *`, [randomBytes(32).toString("base64url"), userId, space.id, documentId, mode, s.now()])).rows[0];
      await s.markMemory(space.id, documentId, client);
      await s.event(client, null, userId, "document_link_changed", { documentId, mode });
      return { link: linkProjection(row) };
    });
  }
  async view(id, userId = null, { includeContent = true } = {}) {
    const s = this.sharing;
    return s.transaction(async client => {
      const row = await this.resolve(client, id);
      let access = null;
      if (userId) {
        try { access = await s.documentAccess(userId, row.origin_space_id, row.document_id, "view", client); }
        catch (error) { if (error.statusCode !== 404) throw error; }
      }
      if (row.mode !== "public" && !access) {
        const request = userId ? (await client.query(`SELECT * FROM account_document_access_requests
          WHERE link_id=$1 AND user_id=$2`, [id, userId])).rows[0] : null;
        return { state: userId ? "request" : "login", request: request ? requestProjection(request) : null };
      }
      const accessView = { state: "read", revision: Number(row.revision), ownerId: row.owner_id,
        originSpaceId: row.origin_space_id, documentId: row.document_id, role: access?.role || null, mode: row.mode };
      if (!includeContent) return accessView;
      const document = await this.document(client, row);
      const cards = projectPublicCards(document.text, document.annotations);
      const contentRevision = createHash("sha256").update(JSON.stringify([document.title, document.text, cards])).digest("hex");
      return { ...accessView, title: document.title || "分享会话", markdown: document.text,
        cards, contentRevision, updatedAt: Number(document.updated_at || 0),
      };
    });
  }
  async request(userId, id, input = {}) {
    const role = input.role || "viewer", message = input.message ?? "";
    if (!["viewer", "editor"].includes(role) || typeof message !== "string" || message.length > 1000
      || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(message)) throw accountError(400, "invalid_access_request");
    const s = this.sharing;
    return s.transaction(async client => {
      const row = await this.resolve(client, id);
      if (!(await client.query("SELECT 1 FROM account_users WHERE id=$1 AND status='active'", [userId])).rowCount) {
        throw accountError(401, "authentication_required");
      }
      if (row.owner_id === userId) throw accountError(400, "cannot_request_own_document");
      try {
        await s.documentAccess(userId, row.origin_space_id, row.document_id, "view", client);
        return { alreadyAuthorized: true };
      } catch (error) { if (error.statusCode !== 404) throw error; }
      const request = (await client.query(`INSERT INTO account_document_access_requests
        (id,link_id,user_id,role,message,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'pending',$6,$6)
        ON CONFLICT (link_id,user_id) DO UPDATE SET role=CASE WHEN account_document_access_requests.status='pending'
          THEN account_document_access_requests.role ELSE $4 END,
          message=CASE WHEN account_document_access_requests.status='pending' THEN account_document_access_requests.message ELSE $5 END,
          status='pending',updated_at=$6 RETURNING *`, [`access-request:${randomUUID()}`, id, userId, role, message.trim(), s.now()])).rows[0];
      return { request: requestProjection(request) };
    });
  }
  async requests(userId, documentId) {
    const s = this.sharing, space = await s.ownerSpace(userId);
    const rows = (await s.pool.query(`SELECT r.*,u.name FROM account_document_access_requests r
      JOIN account_document_links l ON l.id=r.link_id JOIN account_users u ON u.id=r.user_id AND u.status='active'
      WHERE l.owner_id=$1 AND l.origin_space_id=$2 AND l.document_id=$3 AND r.status='pending'
      ORDER BY r.created_at LIMIT 200`, [userId, space.id, documentId])).rows;
    return { requests: rows.map(requestProjection) };
  }
  async decide(userId, documentId, requestId, input) {
    if (!["approved", "rejected"].includes(input.status) || input.status === "approved" && !["viewer", "editor"].includes(input.role)) {
      throw accountError(400, "invalid_access_decision");
    }
    const s = this.sharing, space = await s.ownerSpace(userId);
    return s.transaction(async client => {
      await s.lockContent(client, space.id);
      const row = (await client.query(`SELECT r.*,l.origin_space_id,l.document_id,l.owner_id,l.mode
        FROM account_document_access_requests r JOIN account_document_links l ON l.id=r.link_id
        WHERE r.id=$1 AND l.owner_id=$2 AND l.origin_space_id=$3 AND l.document_id=$4 FOR UPDATE OF r`,
      [requestId, userId, space.id, documentId])).rows[0];
      if (!row) throw accountError(404, "access_request_not_found");
      if (row.status !== "pending") return { request: requestProjection(row) };
      const link = await this.resolve(client, row.link_id);
      let shareId = null;
      if (input.status === "approved") {
        const recipient = await s.resolveRecipient(userId, row.user_id, client);
        const document = await this.document(client, link);
        let share = (await client.query(`SELECT * FROM account_shares WHERE owner_id=$1 AND origin_space_id=$2
          AND kind='document' AND source_id=$3 AND status='active' AND expires_at IS NULL ORDER BY created_at LIMIT 1`,
        [userId, space.id, documentId])).rows[0];
        if (!share) share = (await client.query(`INSERT INTO account_shares
          (id,owner_id,origin_space_id,kind,source_id,name,role,created_at) VALUES ($1,$2,$3,'document',$4,$5,'viewer',$6) RETURNING *`,
        [`share:${randomUUID()}`, userId, space.id, documentId, (document.title || "分享会话").slice(0, 160), s.now()])).rows[0];
        await s.grantRecipient(client, share, recipient, input.role);
        shareId = share.id;
        await s.markMemory(space.id, documentId, client);
      }
      const updated = (await client.query(`UPDATE account_document_access_requests SET status=$2,role=$3,share_id=$4,updated_at=$5
        WHERE id=$1 RETURNING *`, [requestId, input.status, input.role || row.role, shareId, s.now()])).rows[0];
      await s.event(client, shareId, userId, `access_request_${input.status}`, { requestId, recipientId: row.user_id,
        role: input.status === "approved" ? input.role : row.role });
      return { request: requestProjection(updated) };
    });
  }
}
