import { afterEach, describe, expect, it, vi } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { PostgresSharingStore } from "../src/sharing/postgres-sharing-store.mjs";
import { PostgresSharedSpaceStore } from "../src/spaces/postgres-shared-space-store.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresAccessStore } from "../src/postgres-access-store.mjs";
import { AccountAccessControl } from "../src/accounts/account-access-control.mjs";
import { createAuthorizedWorkbenchStore } from "../src/spaces/authorized-workbench-store.mjs";
import { createSharedCollaborationPersistence } from "../src/spaces/collaboration-persistence.mjs";
import { resolveMemoryScope } from "../src/spaces/memory-scope.mjs";
import { authorizeMemoryContext } from "../src/accounts/memory-delegation.mjs";
import { createRuntimeCollaborationService, COLLABORATION_TEXT_KEY, COLLABORATION_PROTOCOL } from "../src/collaboration-service.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { contentSpaceId } from "../src/sharing/content-scope.mjs";
import { RuntimeIdentityContextProvider } from "../../../extensions/dev.identity/runtime.js";
import { PostgresIdentityContextStore } from "../src/identity-context-store.mjs";
import { createSharingHttpHandler } from "../src/sharing/sharing-http-handler.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const db = await createPostgresTestDatabase("direct_content");
  cleanup.push(() => db.close());
  const [owner, editor, viewer] = await Promise.all(["owner", "editor", "viewer"].map(subject =>
    db.accounts.resolveIdentity({ issuer: "https://content.test", subject, name: subject })));
  const origin = await db.accounts.personalSpace(owner.id);
  const sharing = new PostgresSharingStore({ accounts: db.accounts });
  const spaces = new PostgresSharedSpaceStore({ accounts: db.accounts }); spaces.sharing = sharing;
  const store = await new PostgresWorkbenchStateStore(db.pool, { spaceId: origin.id }).initialize();
  await spaces.transaction(origin.id, async (client, afterCommit) => {
    await spaces.registerDocument(owner.id, origin.id, "doc", client);
    await store.createSession({ id: "doc", text: "shared initial", title: "共同文档" }, { client, afterCommit });
  });
  const invites = [];
  for (const [user, role] of [[editor, "editor"], [viewer, "viewer"]]) {
    const created = await sharing.create(owner.id, { kind: "document", sourceId: "doc", role });
    await sharing.accept(user.id, created.invitation.token); invites.push(created.share);
  }
  const runs = new PostgresRunStore(db.pool, { spaceId: origin.id });
  const access = new AccountAccessControl({ accounts: db.accounts, sharing, sharedSpaces: spaces, oidc: {},
    servedSpaceId: origin.id, store: new PostgresAccessStore(db.pool, { spaceId: origin.id }) });
  const login = async user => {
    const personal = await db.accounts.personalSpace(user.id);
    const session = await db.accounts.createSession(user.id, { activeSpaceId: personal.id });
    const principal = await access.authenticateHeaders({}, session.token, { spaceId: personal.id });
    return { principal, token: session.token, personal };
  };
  const [alice, bob, eve] = await Promise.all([owner, editor, viewer].map(login));
  const scoped = p => ({ ...p, contentScope: { originSpaceId: origin.id, documentId: "doc", ownerId: owner.id },
    documentId: "doc", documentAction: "view" });
  return { db, origin, owner, editor, viewer, sharing, spaces, store, runs, access, alice, bob, eve, scoped, invites };
}
describe("direct document authority through native PostgreSQL and WebSockets", () => {
  it("reuses the collaboration transaction through cross-account profile authorization", async () => {
    const h = await fixture();
    const policy = { preset: "workspace-write", allowedTools: ["read"] };
    const principal = await h.db.accounts.issueGrant(h.editor.id, policy, {
      spaceId: h.bob.personal.id, profileId: "default",
      contentScope: { originSpaceId: h.origin.id, documentId: "doc", ownerId: h.owner.id }
    });
    let lockClient;
    h.access.resolveProfile = async (_id, actor, client) => {
      expect(client).toBe(lockClient);
      await h.sharing.documentAccess(actor.userId, h.origin.id, "doc", "edit", client);
      return { policy };
    };
    await h.spaces.transaction(h.origin.id, async client => {
      lockClient = client;
      // A new memory marker remains uncommitted while nested authorization runs.
      await client.query("DELETE FROM account_document_privacy WHERE origin_space_id=$1 AND document_id='doc'", [h.origin.id]);
      await h.sharing.documentAccess(h.editor.id, h.origin.id, "doc", "edit", client);
      const query = vi.spyOn(h.db.pool, "query").mockImplementation(() => { throw new Error("nested pool acquisition"); });
      try { await h.access.authorizeRunExecution({ principal, sessionId: "doc", policy }, client); }
      finally { query.mockRestore(); }
    });
    expect((await h.store.readSession("doc")).text).toBe("shared initial");
  });
  it("reads a consistent shared catalog while another writer holds the content lock", async () => {
    const h = await fixture(), writer = await h.db.pool.connect();
    try {
      await writer.query("BEGIN");
      await h.sharing.lockContent(writer, h.origin.id);
      const catalog = await Promise.race([
        h.sharing.contentIndex(h.editor.id),
        new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("catalog blocked on writer")), 1500); timer.unref(); })
      ]);
      expect(catalog.received.some(node => node.id === "doc")).toBe(true);
    } finally { await writer.query("ROLLBACK"); writer.release(); }
  });
  it("derives participants from effective document and folder grants, respecting privacy and active accounts", async () => {
    const h = await fixture();
    const [follower, modelOnly, pending] = await Promise.all(["follower", "modelOnly", "pending"].map(subject =>
      h.db.accounts.resolveIdentity({ issuer: "https://content.test", subject, name: subject })));
    await h.store.createSession({ id: "other", text: "unrelated" });
    const tree = ids => ({ id: "root", type: "folder", children: [
      { id: "folder", type: "folder", children: ids.map(id => ({ id, type: "session" })) }
    ] });
    await h.store.writeTree(tree(["doc"]));
    const folder = await h.sharing.create(h.owner.id, { kind: "folder", sourceId: "folder", role: "viewer", maxClaims: 2 });
    await h.sharing.accept(h.editor.id, folder.invitation.token);
    await h.sharing.accept(follower.id, folder.invitation.token);
    const folderEditor = await h.sharing.create(h.owner.id, { kind: "folder", sourceId: "folder", role: "editor" });
    await h.sharing.accept(h.viewer.id, folderEditor.invitation.token);
    const source = { id: "model", kind: "model", name: "model", version: "1" };
    const model = await h.sharing.create(h.owner.id, { kind: "model", sourceId: source.id }, source);
    await h.sharing.accept(modelOnly.id, model.invitation.token);
    await h.sharing.create(h.owner.id, { kind: "document", sourceId: "doc", name: pending.name });
    const read = user => h.sharing.documentParticipants(user.id, h.origin.id, "doc");
    const result = await read(h.editor);
    expect(result.participants.map(p => p.id).sort()).toEqual([h.owner, h.editor, h.viewer, follower].map(u => u.id).sort());
    expect(result.participants.find(p => p.id === h.editor.id)).toMatchObject({ role: "editor", inherited: false });
    expect(result.participants.find(p => p.id === follower.id)).toMatchObject({ role: "viewer", inherited: true });
    expect(result.participants.find(p => p.id === h.viewer.id)).toMatchObject({ role: "editor", inherited: true });
    expect(JSON.stringify(result)).not.toMatch(/email|invitation|acceptedAt|token|modelOnly|pending/);
    await expect(h.sharing.documentParticipants(modelOnly.id, h.origin.id, "doc")).rejects.toMatchObject({ statusCode: 404 });
    await h.db.pool.query("UPDATE account_users SET status='disabled' WHERE id=$1", [h.viewer.id]);
    expect((await read(h.owner)).participants.some(p => p.id === h.viewer.id)).toBe(false);
    await h.store.writeTree(tree(["other"]));
    expect((await read(h.owner)).participants.some(p => p.id === follower.id)).toBe(false);
    await h.sharing.setPrivate(h.owner.id, "doc", true);
    expect((await read(h.owner)).participants).toEqual([{ id: h.owner.id, name: h.owner.name, role: "owner", inherited: false }]);
    await expect(read(h.editor)).rejects.toMatchObject({ statusCode: 404 });
    await h.sharing.setPrivate(h.owner.id, "doc", false);
    await h.db.pool.query("UPDATE account_shares SET expires_at=$1 WHERE id=$2", [Date.now() - 1, h.invites[0].id]);
    expect((await read(h.owner)).participants).toHaveLength(1);
  });
  it("reports trusted live socket identities, deduplicates tabs and removes disconnected or revoked peers through HTTP", async () => {
    const h = await fixture();
    const collaboration = createRuntimeCollaborationService({ store: h.store,
      authenticate: input => h.access.authenticateCollaboration(input),
      reauthorize: context => h.access.reauthorize(context.principal, "runtime.read"),
      authorizeOutbound: async context => {
        await h.access.reauthorize(context.principal, "runtime.read");
        await h.spaces.requireDocument(context.principal.user.id, h.origin.id, context.documentId);
      }
    });
    cleanup.push(() => collaboration.close());
    let revokeDuringLookup = false;
    const handler = createSharingHttpHandler({ sharing: h.sharing, accessControl: h.access, models: {}, publicBaseUrl: "http://localhost",
      readDocumentPresence: async (origin, doc) => {
        expect(origin).toBe(h.origin.id);
        if (revokeDuringLookup) await h.sharing.revoke(h.owner.id, h.invites[1].id);
        return collaboration.listDocumentPresence(doc);
      } });
    const server = createRuntimeServer({ runs: h.runs, executor: { execute() { throw new Error("unused"); } }, accessControl: h.access,
      publicHttpHandlers: [handler], upgradeHandlers: [collaboration.handleUpgrade] });
    cleanup.push(() => server.close());
    const address = await server.start();
    h.access.publicBaseUrl = address.url;
    async function connect(login) {
      const document = new Y.Doc();
      let provider;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Presence socket timed out")), 4000);
        provider = new HocuspocusProvider({ url: `${address.url.replace(/^http/, "ws")}/v1/collaboration?${new URLSearchParams({
          protocol: COLLABORATION_PROTOCOL, space: login.personal.id, content_space: h.origin.id, content_document: "doc"
        })}`, name: "doc", document, token: login.token, WebSocketPolyfill: WebSocket,
        onSynced() { clearTimeout(timer); resolve(); }, onAuthenticationFailed({ reason }) { clearTimeout(timer); reject(new Error(reason)); } });
      });
      cleanup.push(() => { provider.destroy(); document.destroy(); });
      return provider;
    }
    const first = await connect(h.bob), second = await connect(h.bob);
    first.awareness.setLocalStateField("user", { id: h.viewer.id, name: "SPOOFED_OWNER", role: "owner" });
    const request = async (login = h.alice, doc = "doc", origin = h.origin.id) => fetch(
      `${address.url}/v1/sharing/documents/${doc}/participants?origin=${encodeURIComponent(origin)}`,
      { headers: { authorization: `Bearer ${login.token}`, "x-zioon-space-id": login.personal.id } });
    let response = await request(h.bob);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    let result = await response.json();
    expect(result.selfId).toBe(h.editor.id);
    expect(result.participants.filter(p => p.online).map(p => p.id)).toEqual([h.editor.id]);
    expect(result.participants.find(p => p.id === h.viewer.id)).toMatchObject({ name: "viewer", online: false });
    expect(JSON.stringify(result)).not.toMatch(/SPOOFED|email|token/);
    const ownerSocket = await connect(h.alice);
    result = await (await request()).json();
    expect(result.participants.filter(p => p.online)).toHaveLength(2);
    first.destroy();
    expect(await collaboration.listDocumentPresence("doc")).toContain(h.editor.id);
    second.destroy();
    await vi.waitFor(async () => expect(await collaboration.listDocumentPresence("doc")).not.toContain(h.editor.id));
    expect((await (await request()).json()).participants.find(p => p.id === h.editor.id).online).toBe(false);
    expect(await collaboration.listDocumentPresence("different")).toEqual([]);
    expect((await request(h.bob, "other")).status).toBe(404);
    expect((await request(h.bob, "doc", h.bob.personal.id)).status).toBe(404);
    expect((await fetch(`${address.url}/v1/sharing/documents/doc/participants`)).status).toBe(401);
    revokeDuringLookup = true;
    expect((await (await request()).json()).participants.some(p => p.id === h.viewer.id)).toBe(false);
    await h.sharing.setPrivate(h.owner.id, "doc", true);
    expect((await request(h.bob)).status).toBe(404);
    ownerSocket.destroy();
  }, 15000);
  it("isolates document Memory for both accounts and retains that boundary after revoke", async () => {
    const h = await fixture(), p = h.scoped(h.bob.principal);
    const namespace = { kind: "document", spaceId: h.origin.id, documentId: "doc" };
    expect(await resolveMemoryScope(h.access, { principal: p, sessionId: "doc" })).toEqual(namespace);
    expect(await resolveMemoryScope(h.access, { principal: h.alice.principal, sessionId: "doc" })).toEqual(namespace);
    const payload = { context: { principal: p, sessionId: "doc", policy: { fileRoots: ["/memory"] } },
      filePaths: ["/memory/dev.identity/PROFILE.md"], write: false };
    const auth = await authorizeMemoryContext(h.access, payload);
    expect(auth.memoryScope).toEqual(namespace);
    expect(auth.space.id).toBe(h.bob.personal.id);
    expect(auth.contentScope).toEqual({ originSpaceId: h.origin.id, documentId: "doc" });
    const admitted = await h.access.authorizeRunRequest(p, { sessionId: "doc", policy: {
      preset: "workspace-write", allowedTools: ["webSearch", "read", "modelsManage"] } },
    { preset: "workspace-write", allowedTools: ["webSearch", "read", "modelsManage"] });
    expect(admitted.principal.spaceId).toBe(h.bob.personal.id);
    expect(await resolveMemoryScope(h.access, { principal: admitted.principal, sessionId: "doc" })).toEqual(namespace);
    await expect(h.db.accounts.validateGrant({ ...admitted.principal,
      contentScope: { ...admitted.principal.contentScope, documentId: "other" } })).rejects.toMatchObject({ code: "content_grant_mismatch" });
    await h.sharing.revoke(h.owner.id, h.invites[0].id);
    await expect(authorizeMemoryContext(h.access, payload)).rejects.toMatchObject({ code: "document_not_found" });
    await expect(h.db.accounts.validateGrant(admitted.principal)).rejects.toMatchObject({ code: "document_not_found" });
    expect(await resolveMemoryScope(h.access, { principal: h.alice.principal, sessionId: "doc" })).toEqual(namespace);
  });
  it("serializes edits and privacy changes, and refuses stale or wrong-document writes", async () => {
    const h = await fixture();
    const facade = createAuthorizedWorkbenchStore({ store: h.store, spaces: h.spaces, principal: h.scoped(h.bob.principal) });
    const revision = (await facade.readSession("doc")).session_revision;
    const results = await Promise.all(["one", "two"].map(text => facade.updateSession("doc",
      { text, expected_session_revision: revision, operation_id: text })));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => r.conflict)).toHaveLength(1);
    await expect(facade.readSession("other")).rejects.toMatchObject({ code: "content_document_mismatch" });
    expect(() => facade.readTree()).toThrow("content_endpoint_denied");
    await h.sharing.setPrivate(h.owner.id, "doc", true);
    await expect(facade.updateSession("doc", { text: "after privacy" })).rejects.toMatchObject({ code: "document_not_found" });
    expect((await h.store.readSession("doc")).text).not.toBe("after privacy");
  });
  it("keeps cached personal Identity projections out of shared document context", async () => {
    const h = await fixture();
    const projections = new PostgresIdentityContextStore(h.db.pool);
    const provider = new RuntimeIdentityContextProvider({ state: { get() { return {}; } },
      scopeMode: "account", contextStore: projections, spaceKind: "personal" });
    const sourceRoot = "/memory/dev.identity";
    const own = { principal: h.bob.principal, sessionId: "doc" };
    const document = { principal: h.scoped(h.bob.principal), sessionId: "doc" };
    await projections.publish(provider.cacheScope(sourceRoot, own), "doc",
      { sourceRoot, sourceHashes: {}, content: "PRIVATE_IDENTITY_NEEDLE" });
    expect(await provider.storedSessionSnapshot("doc", sourceRoot, document)).toBeNull();
    await projections.publish(provider.cacheScope(sourceRoot, document), "doc",
      { sourceRoot, sourceHashes: {}, content: "SHARED_DOCUMENT_PREFERENCE" });
    expect((await provider.storedSessionSnapshot("doc", sourceRoot, document)).content).toBe("SHARED_DOCUMENT_PREFERENCE");
    expect((await provider.storedSessionSnapshot("doc", sourceRoot, own)).content).toBe("PRIVATE_IDENTITY_NEEDLE");
    expect(provider.cacheScope(sourceRoot, { principal: h.scoped(h.alice.principal) }))
      .toBe(provider.cacheScope(sourceRoot, document));
  });
  it("shares the original Yjs document, denies viewer writes and stops updates after revoke", async () => {
    const h = await fixture();
    let deniedOutbound = 0;
    const collaboration = createRuntimeCollaborationService({ store: h.store,
      withPersistence: createSharedCollaborationPersistence({ spaces: h.spaces, store: h.store, access: h.access, runs: h.runs }),
      authenticate: input => h.access.authenticateCollaboration(input),
      reauthorize: async context => {
        await h.access.reauthorize(context.principal, context.readOnly ? "runtime.read" : "collaboration.write");
        await h.spaces.requireDocument(context.principal.user.id, contentSpaceId(context.principal), "doc", context.readOnly ? "view" : "edit");
      },
      authorizeOutbound: async context => {
        try { await h.access.reauthorize(context.principal, "runtime.read"); }
        catch (error) { deniedOutbound++; throw error; }
      }
    });
    cleanup.push(() => collaboration.close());
    const server = createRuntimeServer({ runs: h.runs, executor: { execute() { throw new Error("unused"); } },
      upgradeHandlers: [collaboration.handleUpgrade] });
    cleanup.push(() => server.close());
    const address = await server.start();
    const connect = async login => {
      const document = new Y.Doc();
      let provider;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WebSocket sync timed out")), 4000);
        provider = new HocuspocusProvider({ url: `${address.url.replace(/^http/, "ws")}/v1/collaboration?${new URLSearchParams({
          protocol: COLLABORATION_PROTOCOL, space: login.personal.id, content_space: h.origin.id, content_document: "doc"
        })}`, name: "doc", document, token: login.token, WebSocketPolyfill: WebSocket,
        onSynced() { clearTimeout(timer); resolve(); }, onAuthenticationFailed({ reason }) { clearTimeout(timer); reject(new Error(reason)); } });
        cleanup.push(() => { provider.destroy(); document.destroy(); });
      });
      return { provider, document, text: document.getText(COLLABORATION_TEXT_KEY) };
    };
    const editor = await connect(h.bob), reader = await connect(h.eve);
    expect(reader.text.toString()).toBe("shared initial");
    expect(reader.provider.configuration.name).toBe("doc");
    reader.text.insert(0, "forbidden ");
    editor.text.insert(editor.text.length, " accepted");
    await vi.waitFor(() => expect(reader.text.toString()).toContain(" accepted"), { timeout: 4000 });
    await vi.waitFor(() => expect(editor.text.toString()).toBe("shared initial accepted"));
    await h.sharing.revoke(h.owner.id, h.invites[1].id);
    editor.text.insert(editor.text.length, " after revoke");
    await vi.waitFor(() => expect(deniedOutbound).toBeGreaterThan(0), { timeout: 4000 });
    expect(reader.text.toString()).not.toContain(" after revoke");
  }, 15000);
});
