import { afterEach, describe, expect, it } from "vitest";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { PostgresSharingStore } from "../src/sharing/postgres-sharing-store.mjs";
import { AccountModelSharing } from "../src/sharing/model-sharing.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { CancellationController } from "../../../packages/runtime/dist/index.js";
import { createSessionManagerSharingService } from "../src/sharing/session-manager-sharing-service.mjs";
import { createAuthorizedWorkbenchStore } from "../src/spaces/authorized-workbench-store.mjs";
import { PostgresSharedSpaceStore } from "../src/spaces/postgres-shared-space-store.mjs";
import { activateRuntimePlugin } from "../../../extensions/dev.session-manager/runtime.js";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const db = await createPostgresTestDatabase("account_sharing");
  cleanup.push(() => db.close());
  const [alice, bob, eve] = await Promise.all(["Alice", "Bob", "Eve"].map(subject =>
    db.accounts.resolveIdentity({ issuer: "https://sharing.test", subject, name: subject })));
  const personal = await db.accounts.personalSpace(alice.id);
  const receiver = await db.accounts.personalSpace(bob.id);
  const sharing = new PostgresSharingStore({ accounts: db.accounts });
  const store = new PostgresWorkbenchStateStore(db.pool, { spaceId: personal.id });
  const source = { id: "private-source-model", kind: "model", name: "Strong", version: "v1",
    capabilities: { supportsImage: true, supportsTools: true }, modelLimits: { contextWindow: 65536 } };
  const model = input => sharing.create(alice.id, { kind: "model", sourceId: source.id, name: "给你的模型", ...input }, source);
  const request = (id, principal = { userId: bob.id, spaceId: receiver.id }, overrides = {}) => ({
    principal, model: { profileId: `share.${id}`, providerId: "shared", modelId: id },
    runId: "run-private", attemptId: "attempt", turn: 1, messages: [{ role: "user", content: "我的私密问题" }],
    sessionId: "PRIVATE_SESSION", tools: [], signal: new CancellationController().signal, ...overrides
  });
  let releases = 0, dispatches = 0;
  const provider = {
    describeSharedSource: async () => source,
    listShareableSources: async () => [source],
    async *streamSharedModel(binding, input) {
      expect(input.destinationId).toBeUndefined();
      expect(binding.providerId).toBe(alice.id);
      await input.authorize();
      yield { type: "model.request", request: { url: "https://PRIVATE_PROVIDER/v1", payload: {
        model: source.id, messages: input.messages, api_key: "SECRET"
      } } };
      dispatches++;
      yield { type: "message.delta", delta: "模型回答" };
      yield { type: "model.usage", usage: { inputTokens: 10, outputTokens: 5 } };
    }
  };
  const broker = new AccountModelSharing({ sharing, acquireRuntime: async () => ({
    app: provider, release() { releases++; }
  }) });
  const collect = async input => { const result = []; for await (const event of broker.streamTurn(input)) result.push(event); return result; };
  return { db, alice, bob, eve, personal, receiver, sharing, source, store, model, broker, provider, request, collect,
    releases: () => releases, dispatches: () => dispatches };
}

describe("independent account sharing", () => {
  it("lists and gets received folder content through the actual session tools without exposing private owner metadata", async () => {
    const h = await fixture(), spaces = new PostgresSharedSpaceStore({ accounts: h.db.accounts });
    spaces.sharing = h.sharing;
    await spaces.registerDocument(h.alice.id, h.personal.id, "same");
    await h.store.updateSession("same", { text: "user 共享内容", meta: { title: "共享会话", modelProfileId: "PRIVATE_MODEL", privateIdentity: "PRIVATE_ID" } });
    await h.store.updateSession("private", { text: "PRIVATE_CONTENT", meta: { title: "PRIVATE_TITLE" } });
    await h.store.writeTree({ id: "root", type: "folder", children: [
      { id: "folder", type: "folder", title: "分享目录", children: [{ id: "same", type: "session" }] },
      { id: "private", type: "session" }
    ] });
    const share = await h.sharing.create(h.alice.id, { kind: "folder", sourceId: "folder", recipient: h.bob.id, role: "viewer" });
    const own = new PostgresWorkbenchStateStore(h.db.pool, { spaceId: h.receiver.id });
    await own.updateSession("same", { text: "user 我的内容", meta: { title: "自己的同名会话" } });
    const principal = { kind: "account", user: h.bob, space: h.receiver };
    const service = createSessionManagerSharingService({
      store: own, sharing: h.sharing, principal,
      readSharedSession: (scope, id) => createAuthorizedWorkbenchStore({ store: h.store, spaces, principal: scope }).readSession(id)
    });
    const tools = new Map();
    const plugin = activateRuntimePlugin({ config: { sessionService: service },
      documents: { registerProjector: () => ({ dispose() {} }) },
      tools: { registerTool: tool => { tools.set(tool.name, tool); return { dispose() {} }; } } });
    try {
      const list = JSON.parse((await tools.get("sessionList").invoke({})).content);
      const received = list.find(item => item.sharing?.received);
      expect(received).toMatchObject({ id: `shared-document:${encodeURIComponent(h.personal.id)}:same`,
        title: "共享会话", sharing: { role: "viewer", originSpaceId: h.personal.id } });
      expect(list.find(item => item.id === "same").title).toBe("自己的同名会话");
      const tree = JSON.parse((await tools.get("sessionList").invoke({ view_type: "tree" })).content);
      expect(tree.children.find(node => node.sharing?.received)).toMatchObject({ title: "分享目录", children: [{ id: received.id }] });
      const payload = JSON.parse((await tools.get("sessionGet").invoke({ id: received.id })).content);
      expect(payload.doc).toContain("共享内容"); expect(payload.meta.title).toBe("共享会话");
      expect(JSON.stringify([list, tree, payload])).not.toMatch(/PRIVATE_MODEL|PRIVATE_ID|PRIVATE_CONTENT|PRIVATE_TITLE/);
      expect(JSON.parse((await tools.get("sessionGet").invoke({ id: "same" })).content).doc).toContain("我的内容");
      await expect(service.readSession(`shared-document:${encodeURIComponent(h.personal.id)}:private`)).rejects.toMatchObject({ statusCode: 404 });
      await h.sharing.revoke(h.alice.id, share.share.id);
      expect(JSON.parse((await tools.get("sessionList").invoke({})).content)).toHaveLength(1);
      await expect(service.readSession(received.id)).rejects.toMatchObject({ statusCode: 404 });
    } finally { plugin.dispose(); }
  });
  it("follows original folder and document renames across shares, invitations, inherited grants and stable links", async () => {
    const h = await fixture();
    await h.store.updateSession("rename-doc", { text: "user 内容", meta: { title: "原会话" } });
    const tree = title => ({ id: "root", type: "folder", children: [
      { id: "rename-folder", type: "folder", title, children: [{ id: "rename-doc", type: "session", title: "旧树标题" }] }
    ] });
    await h.store.writeTree(tree("原文件夹"));
    const folder = await h.sharing.create(h.alice.id, { kind: "folder", sourceId: "rename-folder", name: "旧分享标签", role: "editor", maxClaims: 3 });
    const doc = await h.sharing.create(h.alice.id, { kind: "document", sourceId: "rename-doc", name: "旧文档标签", maxClaims: 3 });
    expect(folder.share.name).toBe("原文件夹"); expect(doc.share.name).toBe("原会话");
    await h.sharing.accept(h.bob.id, folder.invitation.token); await h.sharing.accept(h.bob.id, doc.invitation.token);
    const link = (await h.sharing.links.set(h.alice.id, "rename-doc", "restricted")).link;
    const stored = (await h.db.pool.query("SELECT * FROM account_shares WHERE id=ANY($1::text[])", [[folder.share.id, doc.share.id]])).rows;
    await h.store.updateSession("rename-doc", { meta: { title: "现在的会话" } });
    await h.store.writeTree(tree("共同清单测试"));
    for (const [user, direction] of [[h.alice, "sent"], [h.bob, "received"]]) {
      const list = await h.sharing.list(user.id, direction);
      expect(list.find(s => s.id === folder.share.id)).toMatchObject({ sourceId: "rename-folder", name: "共同清单测试", role: "editor" });
      expect(list.find(s => s.id === doc.share.id).name).toBe("现在的会话");
    }
    expect((await h.sharing.requireGrant(h.bob.id, folder.share.id)).name).toBe("共同清单测试");
    const detail = await h.sharing.folderDocuments(h.bob.id, folder.share.id);
    expect(detail).toMatchObject({ share: { name: "共同清单测试" }, tree: { title: "共同清单测试", children: [{ title: "现在的会话" }] } });
    const participants = await h.sharing.documentParticipants(h.alice.id, h.personal.id, "rename-doc");
    expect(participants.title).toBe("现在的会话");
    const person = participants.participants.find(p => p.id === h.bob.id);
    expect(person.grants.map(g => g.name).sort()).toEqual(["共同清单测试", "现在的会话"].sort());
    expect((await h.sharing.contentIndex(h.bob.id)).received[0]).toMatchObject({ title: "共同清单测试", children: [{ title: "现在的会话" }] });
    for (const value of [folder, doc]) {
      const expected = value === folder ? "共同清单测试" : "现在的会话";
      expect((await h.sharing.preview(value.invitation.token)).share.name).toBe(expected);
      expect((await h.sharing.accept(h.eve.id, value.invitation.token)).share.name).toBe(expected);
      expect(await h.sharing.accept(h.bob.id, value.invitation.token)).toMatchObject({ share: { name: expected }, duplicate: true });
    }
    expect((await h.sharing.links.get(h.alice.id, "rename-doc")).link).toEqual(link);
    expect((await h.sharing.links.view(link.id, h.bob.id)).title).toBe("现在的会话");
    expect((await h.db.pool.query("SELECT * FROM account_shares WHERE id=ANY($1::text[])", [[folder.share.id, doc.share.id]])).rows).toEqual(stored);
    const model = await h.model({ recipient: h.bob.id });
    expect((await h.sharing.list(h.bob.id)).find(s => s.id === model.share.id).name).toBe("给你的模型");
    await h.store.writeTree({ id: "root", type: "folder", children: [] });
    expect((await h.sharing.list(h.alice.id, "sent")).find(s => s.id === folder.share.id).name).toBe("旧分享标签");
  });
  it("does not disclose new private, expired, revoked or disabled-owner titles to recipients or invitations", async () => {
    const h = await fixture();
    await h.store.updateSession("hidden-name", { text: "user 内容", meta: { title: "共享时的会话" } });
    const { share, invitation } = await h.sharing.create(h.alice.id, {
      kind: "document", sourceId: "hidden-name", name: "创建时快照", maxClaims: 3
    });
    await h.sharing.accept(h.bob.id, invitation.token);
    const hidden = async () => {
      expect(JSON.stringify(await h.sharing.list(h.bob.id))).not.toContain("后续秘密标题");
      await expect(h.sharing.preview(invitation.token)).rejects.toMatchObject({ code: "share_invitation_unavailable" });
      await expect(h.sharing.accept(h.eve.id, invitation.token)).rejects.toMatchObject({ code: "share_invitation_unavailable" });
      expect((await h.sharing.list(h.alice.id, "sent"))[0].name).toBe("后续秘密标题");
    };
    await h.sharing.setPrivate(h.alice.id, "hidden-name", true);
    await h.store.updateSession("hidden-name", { meta: { title: "后续秘密标题" } });
    await hidden();
    await expect(h.sharing.accept(h.bob.id, invitation.token)).rejects.toMatchObject({ code: "share_invitation_unavailable" });
    await expect(h.sharing.requireGrant(h.bob.id, share.id)).rejects.toMatchObject({ code: "share_access_revoked" });
    await h.sharing.setPrivate(h.alice.id, "hidden-name", false);
    await h.db.pool.query("UPDATE account_shares SET expires_at=1 WHERE id=$1", [share.id]); await hidden();
    await h.db.pool.query("UPDATE account_shares SET expires_at=NULL WHERE id=$1", [share.id]);
    await h.db.pool.query("UPDATE account_users SET status='disabled' WHERE id=$1", [h.alice.id]); await hidden();
    await h.db.pool.query("UPDATE account_users SET status='active' WHERE id=$1", [h.alice.id]);
    await h.sharing.revoke(h.alice.id, share.id, { recipientId: h.bob.id });
    expect(await h.sharing.list(h.bob.id)).toEqual([]);
    await h.sharing.revoke(h.alice.id, share.id); await hidden();
  });
  it("grants registered accounts and verified emails directly without invitations or provider memberships", async () => {
    const h = await fixture();
    await h.db.accounts.resolveIdentity({ issuer: "https://sharing.test", subject: "Bob", email: "bob@example.test", emailVerified: true });
    await h.store.updateSession("direct", { text: "BODY_PRIVATE", title: "直接分享" });
    const result = await h.sharing.create(h.alice.id, { kind: "document", sourceId: "direct", role: "editor", recipient: "BOB@EXAMPLE.TEST" });
    expect(result.invitation).toBeUndefined();
    expect(result.recipient).toMatchObject({ id: h.bob.id, name: "Bob", role: "editor" });
    expect((await h.sharing.list(h.bob.id))[0]).toMatchObject({ id: result.share.id, role: "editor" });
    expect((await h.sharing.contentIndex(h.bob.id)).received[0]).toMatchObject({ id: "direct", role: "editor" });
    expect(await h.db.accounts.membership(h.bob.id, h.personal.id)).toBeFalsy();
    expect((await h.sharing.list(h.alice.id, "sent"))[0].invitations).toEqual([]);
    const model = await h.model({ recipient: h.eve.id });
    expect(model.invitation).toBeUndefined();
    expect((await h.broker.models({ userId: h.eve.id }))[0].id).toBe(`share.${model.share.id}`);
    expect(JSON.stringify(await h.sharing.contentIndex(h.eve.id))).not.toMatch(/direct|BODY_PRIVATE/);
  });
  it("rejects display-only addresses, ambiguous verified emails and disabled accounts atomically", async () => {
    const h = await fixture();
    await h.db.pool.query("UPDATE account_users SET email='unverified@example.test' WHERE id=$1", [h.bob.id]);
    await expect(h.model({ recipient: "unverified@example.test" })).rejects.toMatchObject({ code: "share_recipient_unavailable" });
    for (const subject of ["Bob", "Eve"]) await h.db.accounts.resolveIdentity({
      issuer: "https://sharing.test", subject, email: "ambiguous@example.test", emailVerified: true
    });
    await expect(h.model({ recipient: "ambiguous@example.test" })).rejects.toMatchObject({ code: "share_recipient_unavailable" });
    await expect(h.model({ recipient: h.alice.id })).rejects.toMatchObject({ code: "cannot_accept_own_share" });
    await h.db.pool.query("UPDATE account_users SET status='disabled' WHERE id=$1", [h.bob.id]);
    await expect(h.model({ recipient: h.bob.id })).rejects.toMatchObject({ code: "share_recipient_unavailable" });
    expect(await h.sharing.list(h.alice.id, "sent")).toEqual([]);
  });
  it("changes one recipient's permission everywhere without changing invitation defaults or another person", async () => {
    const h = await fixture();
    await h.store.updateSession("roles", { text: "user 共同编辑" });
    const { share, invitation } = await h.sharing.create(h.alice.id, { kind: "document", sourceId: "roles", role: "editor", maxClaims: 3 });
    await h.sharing.accept(h.bob.id, invitation.token); await h.sharing.accept(h.eve.id, invitation.token);
    await h.sharing.updateRecipient(h.alice.id, share.id, h.bob.id, "viewer");
    expect((await h.sharing.requireGrant(h.bob.id, share.id)).role).toBe("viewer");
    expect((await h.sharing.list(h.bob.id))[0].role).toBe("viewer");
    expect((await h.sharing.contentIndex(h.bob.id)).received[0].role).toBe("viewer");
    expect((await h.sharing.documentParticipants(h.bob.id, h.personal.id, "roles")).participants.find(p => p.id === h.bob.id).role).toBe("viewer");
    await expect(h.sharing.documentAccess(h.bob.id, h.personal.id, "roles", "edit")).rejects.toMatchObject({ statusCode: 404 });
    expect((await h.sharing.documentAccess(h.eve.id, h.personal.id, "roles", "edit")).role).toBe("editor");
    const fresh = await h.sharing.invite(h.alice.id, share.id);
    await h.sharing.accept(h.bob.id, fresh.token);
    expect((await h.sharing.accept(h.bob.id, fresh.token)).share.role).toBe("viewer");
    expect((await h.sharing.list(h.alice.id, "sent"))[0].role).toBe("editor");
    await expect(h.sharing.updateRecipient(h.bob.id, share.id, h.eve.id, "editor")).rejects.toMatchObject({ statusCode: 404 });
    await expect(h.sharing.updateRecipient(h.alice.id, share.id, h.bob.id, "use")).rejects.toMatchObject({ code: "invalid_share_role" });
    const event = (await h.db.pool.query("SELECT details_json FROM account_sharing_events WHERE action='recipient_role_changed'")).rows[0];
    expect(event.details_json).toEqual({ recipientId: h.bob.id, role: "viewer" });
  });
  it("updates overlapping direct grants together and explains why inherited editor access cannot be downgraded", async () => {
    const h = await fixture();
    await h.store.updateSession("overlap", { text: "user 共同内容" });
    await h.store.writeTree({ id: "root", type: "folder", children: [
      { id: "folder", title: "共同文件夹", type: "folder", children: [{ id: "overlap", type: "session" }] }
    ] });
    const direct1 = await h.sharing.create(h.alice.id, { kind: "document", sourceId: "overlap", role: "editor", recipient: h.bob.id });
    const direct2 = await h.sharing.create(h.alice.id, { kind: "document", sourceId: "overlap", role: "viewer", recipient: h.bob.id });
    await h.sharing.updateDocumentCollaborator(h.alice.id, "overlap", h.bob.id, "viewer");
    expect((await h.sharing.requireGrant(h.bob.id, direct1.share.id)).role).toBe("viewer");
    const folder = await h.sharing.create(h.alice.id, { kind: "folder", sourceId: "folder", role: "editor", recipient: h.bob.id });
    await expect(h.sharing.updateDocumentCollaborator(h.alice.id, "overlap", h.bob.id, "viewer"))
      .rejects.toMatchObject({ code: "document_permission_inherited" });
    const people = await h.sharing.documentParticipants(h.alice.id, h.personal.id, "overlap");
    expect(people.participants.find(person => person.id === h.bob.id).grants).toHaveLength(3);
    expect((await h.sharing.documentParticipants(h.bob.id, h.personal.id, "overlap")).participants.every(person => !person.grants)).toBe(true);
    expect(await h.sharing.updateDocumentCollaborator(h.alice.id, "overlap", h.bob.id, "removed")).toMatchObject({ inherited: true });
    for (const direct of [direct1, direct2]) await expect(h.sharing.requireGrant(h.bob.id, direct.share.id)).rejects.toMatchObject({ statusCode: 403 });
    expect((await h.sharing.documentAccess(h.bob.id, h.personal.id, "overlap", "edit")).role).toBe("editor");
    await h.sharing.updateSourceCollaborator(h.alice.id, "folder", "folder", h.bob.id, "viewer");
    expect((await h.sharing.requireGrant(h.bob.id, folder.share.id)).role).toBe("viewer");
    await expect(h.sharing.documentAccess(h.bob.id, h.personal.id, "overlap", "edit")).rejects.toMatchObject({ statusCode: 404 });
    await h.sharing.setPrivate(h.alice.id, "overlap", true);
    await expect(h.sharing.documentAccess(h.bob.id, h.personal.id, "overlap")).rejects.toMatchObject({ statusCode: 404 });
  });
  it("adds recipients to an existing share and preserves explicit permissions on repeated adds", async () => {
    const h = await fixture();
    await h.store.updateSession("members", { text: "user members" });
    const result = await h.sharing.create(h.alice.id, { kind: "document", sourceId: "members", role: "viewer", recipient: h.bob.id });
    await h.sharing.addRecipient(h.alice.id, result.share.id, { recipient: h.eve.id, role: "editor" });
    await h.sharing.addRecipient(h.alice.id, result.share.id, { recipient: h.eve.id, role: "viewer" });
    expect((await h.sharing.requireGrant(h.eve.id, result.share.id)).role).toBe("editor");
    expect((await h.sharing.requireGrant(h.bob.id, result.share.id)).role).toBe("viewer");
    await h.sharing.revoke(h.alice.id, result.share.id);
    await expect(h.sharing.addRecipient(h.alice.id, result.share.id, { recipient: h.eve.id })).rejects.toMatchObject({ statusCode: 409 });
    await expect(h.sharing.updateRecipient(h.alice.id, result.share.id, h.eve.id, "viewer")).rejects.toMatchObject({ statusCode: 409 });
  });
  it("updates all folder grants in one transaction and revokes directly shared models", async () => {
    const h = await fixture();
    await h.store.writeTree({ id: "root", type: "folder", children: [{ id: "folder", type: "folder", children: [] }] });
    for (const role of ["viewer", "editor"]) await h.sharing.create(h.alice.id, { kind: "folder", sourceId: "folder", recipient: h.bob.id, role });
    await h.sharing.updateSourceCollaborator(h.alice.id, "folder", "folder", h.bob.id, "viewer");
    expect((await h.sharing.list(h.bob.id)).every(share => share.role === "viewer")).toBe(true);
    await expect(h.sharing.updateSourceCollaborator(h.eve.id, "folder", "folder", h.bob.id, "editor")).rejects.toMatchObject({ statusCode: 404 });
    const model = await h.model({ recipient: h.bob.id });
    await expect(h.sharing.updateRecipient(h.alice.id, model.share.id, h.bob.id, "editor")).rejects.toMatchObject({ code: "invalid_share_role" });
    await h.sharing.updateSourceCollaborator(h.alice.id, "model", h.source.id, h.bob.id, "removed");
    expect(await h.broker.models({ userId: h.bob.id })).toEqual([]);
  });
  it("projects received content with nested folders, strongest grants and no private content or bodies", async () => {
    const h = await fixture();
    for (const id of ["same", "nested", "private", "outside"]) await h.store.updateSession(id, { text: `BODY_SECRET_${id}`, title: `会话 ${id}` });
    await h.store.writeTree({ id: "root", type: "folder", children: [
      { id: "folder", type: "folder", title: "共享目录", children: [
        { id: "same", type: "session", title: "same" },
        { id: "sub", type: "folder", title: "子目录", children: [
          { id: "nested", type: "session", title: "nested" }, { id: "private", type: "session", title: "private" }
        ] }
      ] }, { id: "outside", type: "session", title: "outside" }
    ] });
    const folder = await h.sharing.create(h.alice.id, { kind: "folder", sourceId: "folder", role: "viewer" });
    const direct = await h.sharing.create(h.alice.id, { kind: "document", sourceId: "same", role: "editor" });
    await h.sharing.accept(h.bob.id, folder.invitation.token); await h.sharing.accept(h.bob.id, direct.invitation.token);
    await h.sharing.setPrivate(h.alice.id, "private", true);
    const projection = await h.sharing.contentIndex(h.bob.id);
    expect(projection.received).toHaveLength(1);
    expect(projection.received[0]).toMatchObject({ id: "folder", type: "folder", providerName: "Alice", role: "viewer" });
    expect(projection.received[0].children[0]).toMatchObject({ id: "same", role: "editor" });
    expect(projection.received[0].children[1]).toMatchObject({ id: "sub", children: [{ id: "nested", role: "viewer" }] });
    expect(JSON.stringify(projection)).not.toMatch(/BODY_SECRET|private|outside|recipients|invitations/);
    expect((await h.sharing.contentIndex(h.alice.id)).sentIds.sort()).toEqual(["folder", "nested", "same", "sub"]);
    await h.sharing.revoke(h.alice.id, direct.share.id);
    expect((await h.sharing.contentIndex(h.bob.id)).received[0].children[0].role).toBe("viewer");
    await h.sharing.leave(h.bob.id, folder.share.id);
    expect((await h.sharing.contentIndex(h.bob.id)).received).toEqual([]);
  });
  it("excludes expired shares and disabled providers from received content", async () => {
    const h = await fixture();
    await h.store.updateSession("doc", { text: "user 内容" });
    const { share, invitation } = await h.sharing.create(h.alice.id, { kind: "document", sourceId: "doc", durationDays: 1 });
    await h.sharing.accept(h.bob.id, invitation.token);
    expect((await h.sharing.contentIndex(h.bob.id)).received).toHaveLength(1);
    await h.db.pool.query("UPDATE account_shares SET expires_at=1 WHERE id=$1", [share.id]);
    expect((await h.sharing.contentIndex(h.bob.id)).received).toEqual([]);
    await h.db.pool.query("UPDATE account_shares SET expires_at=NULL WHERE id=$1", [share.id]);
    await h.db.pool.query("UPDATE account_users SET status='disabled' WHERE id=$1", [h.alice.id]);
    expect((await h.sharing.contentIndex(h.bob.id)).received).toEqual([]);
  });
  it("claims a single-use link atomically without creating a provider membership", async () => {
    const h = await fixture(), { share, invitation } = await h.model();
    const attempts = await Promise.allSettled([h.sharing.accept(h.bob.id, invitation.token), h.sharing.accept(h.eve.id, invitation.token)]);
    expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const winner = attempts[0].status === "fulfilled" ? h.bob : h.eve;
    expect((await h.sharing.accept(winner.id, invitation.token)).duplicate).toBe(true);
    expect(await h.db.accounts.membership(winner.id, h.personal.id)).toBeFalsy();
    expect(await h.sharing.requireGrant(winner.id, share.id)).toMatchObject({ providerId: h.alice.id });
    const sent = JSON.stringify(await h.sharing.list(h.alice.id, "sent"));
    expect(sent).not.toContain(invitation.token);
    expect(sent).not.toContain("PRIVATE_SESSION");
  });
  it("does not allow a recipient to reaccept a revoked grant through the same link", async () => {
    const h = await fixture(), { share, invitation } = await h.model();
    await h.sharing.accept(h.bob.id, invitation.token);
    await h.sharing.revoke(h.alice.id, share.id, { recipientId: h.bob.id });
    await expect(h.sharing.accept(h.bob.id, invitation.token)).rejects.toMatchObject({ code: "share_invitation_unavailable" });
    await expect(h.sharing.requireGrant(h.bob.id, share.id)).rejects.toMatchObject({ code: "share_access_revoked" });
    const fresh = await h.sharing.invite(h.alice.id, share.id);
    await h.sharing.accept(h.bob.id, fresh.token);
    expect((await h.sharing.requireGrant(h.bob.id, share.id)).role).toBe("use");
  });
  it("separates invitation revocation from grants already accepted", async () => {
    const h = await fixture(), { share, invitation } = await h.model({ maxClaims: 2 });
    await h.sharing.accept(h.bob.id, invitation.token);
    await h.sharing.revoke(h.alice.id, share.id, { invitationId: invitation.id });
    await expect(h.sharing.accept(h.eve.id, invitation.token)).rejects.toMatchObject({ code: "share_invitation_unavailable" });
    expect((await h.sharing.requireGrant(h.bob.id, share.id)).role).toBe("use");
  });
  it("keeps received model IDs and provider labels while proxying with redacted requests", async () => {
    const h = await fixture(), { share, invitation } = await h.model();
    await h.sharing.accept(h.bob.id, invitation.token);
    expect((await h.broker.models({ userId: h.bob.id }))[0]).toMatchObject({
      id: `share.${share.id}`, metadata: { providerName: "Alice" }, capabilities: { supportsImage: true }
    });
    const events = await h.collect(h.request(share.id));
    expect(events.find(e => e.type === "message.delta").delta).toBe("模型回答");
    const first = JSON.stringify(events[0]);
    expect(first).not.toMatch(/SECRET|PRIVATE_PROVIDER|private-source-model/);
    expect(first).toContain("我的私密问题");
    expect(await h.sharing.usage(h.alice.id, share.id)).toMatchObject({ calls: 1, pending: 0 });
    await expect(h.collect(h.request(share.id))).rejects.toMatchObject({ code: "share_dispatch_already_recorded" });
    expect(h.dispatches()).toBe(1);
  });
  it("offers preview without executing a model or consuming quota", async () => {
    const h = await fixture(), { share, invitation } = await h.model();
    await h.sharing.accept(h.bob.id, invitation.token);
    expect(await h.collect(h.request(share.id, undefined, { preview: true }))).toHaveLength(1);
    expect(h.dispatches()).toBe(0);
    expect((await h.sharing.usage(h.alice.id, share.id)).calls).toBe(0);
  });
  it("applies a shared monthly quota across concurrent receivers", async () => {
    const h = await fixture(), { share, invitation } = await h.model({ monthlyCalls: 1, maxClaims: 2 });
    await h.sharing.accept(h.bob.id, invitation.token); await h.sharing.accept(h.eve.id, invitation.token);
    const result = await Promise.allSettled([h.collect(h.request(share.id)), h.collect(h.request(share.id,
      { userId: h.eve.id, spaceId: (await h.db.accounts.personalSpace(h.eve.id)).id }, { runId: "eve-run" }))]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(result.find(r => r.status === "rejected").reason.code).toBe("share_model_quota_exceeded");
  });
  it("stops a stream on revoke and preserves uncertain dispatch receipts", async () => {
    const h = await fixture(), { share, invitation } = await h.model();
    await h.sharing.accept(h.bob.id, invitation.token);
    const stream = h.broker.streamTurn(h.request(share.id));
    await stream.next(); await stream.next();
    await h.sharing.revoke(h.alice.id, share.id);
    await new Promise(resolve => setTimeout(resolve, 600));
    await expect(stream.next()).rejects.toMatchObject({ code: "share_access_revoked" });
    expect(await h.sharing.usage(h.alice.id, share.id)).toMatchObject({ calls: 1, pending: 1 });
    expect(h.releases()).toBeGreaterThan(0);
  });
  it("does not replay an uncertain provider call when resuming a Run with another attempt", async () => {
    const h = await fixture(), { share, invitation } = await h.model();
    await h.sharing.accept(h.bob.id, invitation.token);
    h.provider.streamSharedModel = async function* () {
      yield { type: "model.request", request: { payload: {} } };
      throw new Error("upstream transport lost");
    };
    await expect(h.collect(h.request(share.id))).rejects.toMatchObject({ code: "shared_model_failed" });
    await expect(h.collect(h.request(share.id, undefined, { attemptId: "resumed-attempt" })))
      .rejects.toMatchObject({ code: "share_outcome_requires_reconciliation" });
    expect(await h.sharing.usage(h.alice.id, share.id)).toMatchObject({ pending: 1, calls: 1 });
  });
  it("disables a borrowed model when its actual source configuration changes", async () => {
    const h = await fixture(), { share, invitation } = await h.model();
    await h.sharing.accept(h.bob.id, invitation.token);
    h.source.version = "v2";
    expect(await h.broker.models({ userId: h.bob.id })).toEqual([]);
    await expect(h.collect(h.request(share.id))).rejects.toMatchObject({ code: "capability_source_changed" });
  });
  it("keeps content authority independent from models", async () => {
    const h = await fixture(), { invitation } = await h.model();
    await h.store.updateSession("owner-doc", { text: "user 私密原文" });
    await h.sharing.accept(h.bob.id, invitation.token);
    await expect(h.sharing.documentAccess(h.bob.id, h.personal.id, "owner-doc")).rejects.toMatchObject({ statusCode: 404 });
    const content = await h.sharing.create(h.alice.id, { kind: "document", sourceId: "owner-doc", role: "viewer" });
    await h.sharing.accept(h.eve.id, content.invitation.token);
    expect(await h.broker.models({ userId: h.eve.id })).toEqual([]);
    expect(await h.sharing.documentAccess(h.eve.id, h.personal.id, "owner-doc")).toMatchObject({ role: "viewer" });
    await expect(h.sharing.documentAccess(h.eve.id, h.personal.id, "owner-doc", "edit")).rejects.toMatchObject({ statusCode: 404 });
  });
  it("follows the current folder tree and explicit private children", async () => {
    const h = await fixture();
    for (const id of ["first", "second", "later"]) await h.store.updateSession(id, { text: `user ${id}` });
    const tree = children => ({ id: "root", type: "folder", title: "会话", children: [
      { id: "shared-folder", type: "folder", title: "一起规划", children: children.map(id => ({ id, type: "session", title: id })) }
    ] });
    await h.store.writeTree(tree(["first", "second"]));
    const shared = await h.sharing.create(h.alice.id, { kind: "folder", sourceId: "shared-folder", role: "editor" });
    await h.sharing.accept(h.bob.id, shared.invitation.token);
    expect(await h.sharing.documentAccess(h.bob.id, h.personal.id, "first", "edit")).toMatchObject({ inherited: true });
    await h.sharing.setPrivate(h.alice.id, "second", true);
    const folder = await h.sharing.folderDocuments(h.bob.id, shared.share.id);
    expect(JSON.stringify(folder.tree)).not.toContain("second");
    await h.store.writeTree(tree(["second", "later"]));
    await expect(h.sharing.documentAccess(h.bob.id, h.personal.id, "first")).rejects.toMatchObject({ statusCode: 404 });
    expect(await h.sharing.documentAccess(h.bob.id, h.personal.id, "later", "edit")).toMatchObject({ inherited: true });
    expect(await h.sharing.sharedMemory(h.personal.id, "later")).toBe(true);
    await h.sharing.revoke(h.alice.id, shared.share.id);
    expect(await h.sharing.sharedMemory(h.personal.id, "later")).toBe(true);
  });
});
