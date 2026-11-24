import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { PostgresSharedSpaceStore } from "../src/spaces/postgres-shared-space-store.mjs";
import { SpaceExecutionStore } from "../src/spaces/space-execution-store.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { createAuthorizedWorkbenchStore } from "../src/spaces/authorized-workbench-store.mjs";
import { AccountAccessControl } from "../src/accounts/account-access-control.mjs";
import { PostgresAssetStore } from "../src/postgres-asset-store.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { createWorkbenchStateHttpHandler } from "../src/workbench-state-http-handler.mjs";
import { contentRequestAction } from "../src/sharing/content-scope.mjs";
import { Readable } from "node:stream";

const cleanup = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function setup() {
  const db = await createPostgresTestDatabase("shared_spaces");
  cleanup.push(() => db.close());
  const accounts = db.accounts;
  const user = (subject, emailVerified = true) => accounts.resolveIdentity({ issuer: "https://verified.test", subject,
    name: subject, email: `${subject}@example.test`, emailVerified });
  const alice = await user("Alice"), bob = await user("Bob"), eve = await user("Eve");
  const team = await accounts.createTeamSpace(alice.id, { name: "Together" });
  const spaces = new PostgresSharedSpaceStore({ accounts }), execution = new SpaceExecutionStore({ spaces });
  await spaces.acceptInvitation(bob.id, (await spaces.invite(alice.id, team.id, { userId: bob.id })).token);
  const store = new PostgresWorkbenchStateStore(db.pool, { spaceId: team.id });
  const document = async (id = randomUUID(), text = "user hello") => {
    await spaces.registerDocument(alice.id, team.id, id);
    await store.updateSession(id, { text, meta: { title: `Title ${id}` } });
    return id;
  };
  const restrict = async (id, grants = []) => {
    const current = await spaces.requireDocument(alice.id, team.id, id, "manage");
    return spaces.updateDocumentAccess(alice.id, team.id, id, {
      protection: "restricted", audienceMode: "specific", expectedRevision: current.aclRevision,
      grants: [{ subjectType: "user", subjectId: alice.id, role: "manager" }, ...grants]
    });
  };
  const borrow = async () => spaces.createBinding(alice.id, team.id, {
    originSpaceId: (await accounts.personalSpace(alice.id)).id, originResourceId: "model-fixture",
    kind: "model", name: "Shared strong model", transferApproved: true, limits: { monthlyCalls: 30 }
  }, { id: "model-fixture", kind: "model", name: "Private model", version: "v1", apiKey: "DO_NOT_PROJECT" });
  return { db, accounts, spaces, execution, alice, bob, eve, team, store, document, restrict, borrow, user };
}

describe("shared Spaces with real PostgreSQL transactions", () => {
  it("serves versioned card details only through current document access and never exposes private shared metadata", async () => {
    const h = await setup(), id = await h.document("lazy-card");
    const fullResult = "private original output ".repeat(300);
    await h.store.updateSession(id, { meta: { annotations: { tools: [{
      id: "tool", kind: "tool", runId: "run", name: "Bash", ok: true, result: fullResult
    }] } } });
    const principal = { kind: "account", user: h.bob, space: h.team };
    const call = async (principal, suffix, method = "GET", data) => {
      const path = `/v1/workbench-state/sessions/${id}${suffix}`;
      const request = Readable.from(data ? [Buffer.from(JSON.stringify(data))] : []);
      Object.assign(request, { method, headers: { "content-type": "application/json" }, url: path, zionPrincipal: principal });
      let status, body;
      const response = { setHeader() {}, writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } };
      await createWorkbenchStateHttpHandler({ store: h.store, spaces: h.spaces })(
        request, response, new URL("http://test" + path));
      return { status, body };
    };
    const render = await call(principal, "?view=render");
    const card = render.body.meta.annotations.tools[0];
    expect(card.result).toBeNull();
    const query = { cards: [{ id: card.id, kind: "tools", ref: card.detailRef }] };
    await h.store.updateSession(id, { title: "A later unrelated revision" });
    expect((await call(principal, "/card-details", "POST", query)).body.details[0].body.result).toBe(fullResult);
    const shared = { ...principal, space: await h.accounts.personalSpace(h.bob.id),
      contentScope: { originSpaceId: h.team.id, documentId: id } };
    await expect(call(shared, "/card-details", "POST", query)).rejects.toMatchObject({ statusCode: 409 });
    await h.restrict(id);
    await expect(call(principal, "/card-details", "POST", query)).rejects.toMatchObject({ statusCode: 404 });
    await h.restrict(id, [{ subjectType: "user", subjectId: h.bob.id, role: "viewer" }]);
    expect((await call(principal, "/card-details", "POST", query)).status).toBe(200);
    await h.store.updateSession(id, { meta: { annotations: { tools: [{
      id: "tool", kind: "tool", runId: "run", ok: true, result: "new content"
    }] } } });
    await expect(call(principal, "/card-details", "POST", query)).rejects.toMatchObject({ statusCode: 409 });
    await expect(h.store.updateSession(id, { meta: render.body.meta })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("allows team owners to delete folders while denying members who cannot manage every child", async () => {
    const h = await setup(), id = await h.document("folder-private");
    await h.restrict(id);
    await h.store.writeTree({ id: "root", type: "folder", children: [
      { id: "folder", type: "folder", children: [{ id, type: "session", title: "private" }] }
    ] });
    const base = (await h.store.readTree()).tree;
    const member = createAuthorizedWorkbenchStore({ store: h.store, spaces: h.spaces,
      principal: { kind: "account", user: h.bob, space: h.team } });
    await expect(member.deleteFolder("folder", { base_tree: base, operation_id: "unauthorized" }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect((await h.store.readTree()).tree.children[0].id).toBe("folder");
    const owner = createAuthorizedWorkbenchStore({ store: h.store, spaces: h.spaces,
      principal: { kind: "account", user: h.alice, space: h.team } });
    const deleted = await owner.deleteFolder("folder", { base_tree: base, operation_id: "owner-delete" });
    expect(deleted.ok).toBe(true);
    expect(deleted.deleted_session_ids).toEqual([id]);
    await h.store.writeTree({ id: "root", type: "folder", children: [
      { id: "empty", type: "folder", children: [] }
    ] });
    const emptyBase = (await h.store.readTree()).tree;
    expect((await owner.deleteFolder("empty", { base_tree: emptyBase, operation_id: "empty-delete" })).ok).toBe(true);
    expect((await owner.readTree()).tree.children).toEqual([]);
  });
  it("checks metadata GET document access and projects shared metadata without private fields", async () => {
    const h = await setup(), id = await h.document("metadata-private");
    await h.store.updateSession(id, { meta: { title: "hidden title", privateConfiguration: "owner-only",
      annotations: { tools: [{ id: "private-card", result: "owner-only output" }] } } });
    await h.restrict(id);
    const metadata = async (principal, documentId = id) => {
      const path = `/v1/workbench-state/sessions/${documentId}/metadata`;
      const request = Readable.from([]);
      request.method = "GET"; request.headers = {}; request.url = path; request.zionPrincipal = principal;
      let status, body;
      const response = { setHeader() {}, writeHead(value) { status = value; },
        end(value) { body = JSON.parse(value); } };
      await createWorkbenchStateHttpHandler({ store: h.store, spaces: h.spaces })(
        request, response, new URL("http://runtime.test" + path));
      return { status, body };
    };
    const principal = { kind: "account", user: h.bob, space: h.team };
    await expect(metadata(principal)).rejects.toMatchObject({ statusCode: 404 });
    await h.restrict(id, [{ subjectType: "user", subjectId: h.bob.id, role: "viewer" }]);
    const shared = { ...principal, space: await h.accounts.personalSpace(h.bob.id),
      contentScope: { originSpaceId: h.team.id, documentId: id } };
    expect(contentRequestAction({ method: "GET", url: `/v1/workbench-state/sessions/${id}/metadata` },
      shared.contentScope)).toBe("view");
    const record = await metadata(shared);
    expect(record.status).toBe(200);
    expect(record.body.meta.title).toBe("hidden title");
    expect(record.body.meta).not.toHaveProperty("annotations");
    expect(record.body.meta).not.toHaveProperty("privateConfiguration");
    await expect(metadata(shared, "another-document")).rejects.toMatchObject({ statusCode: 403 });
    await h.restrict(id);
    await expect(metadata(shared)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("rejects forwarded invitations and consumes a recipient-bound token exactly once", async () => {
    const h = await setup();
    const invitation = await h.spaces.invite(h.alice.id, h.team.id, { userId: h.eve.id });
    await expect(h.spaces.acceptInvitation(h.bob.id, invitation.token)).rejects.toMatchObject({ code: "invitation_recipient_mismatch" });
    expect((await h.spaces.acceptInvitation(h.eve.id, invitation.token)).membership.role).toBe("member");
    await expect(h.spaces.acceptInvitation(h.eve.id, invitation.token)).rejects.toMatchObject({ code: "invalid_invitation" });
  });

  it("requires a verified identity claim rather than a display email for address invitations", async () => {
    const h = await setup(), unverified = await h.user("Unverified", false);
    await h.db.pool.query("UPDATE account_users SET email='unverified@example.test' WHERE id=$1", [unverified.id]);
    const invite = await h.spaces.invite(h.alice.id, h.team.id, { email: "unverified@example.test" });
    await expect(h.spaces.acceptInvitation(unverified.id, invite.token)).rejects.toMatchObject({ code: "invitation_recipient_mismatch" });
    await h.accounts.resolveIdentity({ issuer: "https://verified.test", subject: "Unverified",
      email: "unverified@example.test", emailVerified: true });
    expect((await h.spaces.acceptInvitation(unverified.id, invite.token)).membership.status).toBe("active");
  });

  it("does not restore an explicit removed Space to the user's personal Space", async () => {
    const h = await setup(), login = await h.accounts.createSession(h.bob.id, { activeSpaceId: h.team.id });
    await h.accounts.setMember(h.alice.id, h.bob.id, { role: "member", status: "removed" }, h.team.id);
    await expect(h.accounts.authenticate(login.token, { spaceId: h.team.id })).rejects.toMatchObject({ code: "space_unavailable" });
    expect((await h.accounts.authenticate(login.token)).space.kind).toBe("personal");
  });

  it("allows two windows to use different explicit scopes without changing the login selection", async () => {
    const h = await setup(), login = await h.accounts.createSession(h.bob.id), personal = await h.accounts.personalSpace(h.bob.id);
    const [one, two] = await Promise.all([h.accounts.authenticate(login.token, { spaceId: h.team.id }),
      h.accounts.authenticate(login.token, { spaceId: personal.id })]);
    expect(one.space.id).toBe(h.team.id);
    expect(two.space.id).toBe(personal.id);
    expect((await h.accounts.authenticate(login.token)).space.id).toBe(personal.id);
  });

  it("keeps governance administrators out of restricted documents", async () => {
    const h = await setup(), id = await h.document();
    await h.accounts.setMember(h.alice.id, h.bob.id, { role: "admin" }, h.team.id);
    await h.restrict(id);
    await expect(h.spaces.requireDocument(h.bob.id, h.team.id, id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await h.spaces.readableIds(h.bob.id, h.team.id)).not.toContain(id);
  });

  it("unions group and direct document grants and immediately applies group revocation", async () => {
    const h = await setup(), id = await h.document();
    const group = await h.spaces.saveGroup(h.alice.id, h.team.id, null, { name: "Readers", members: [h.bob.id] });
    const d = await h.spaces.requireDocument(h.alice.id, h.team.id, id, "manage");
    await h.spaces.updateDocumentAccess(h.alice.id, h.team.id, id, {
      protection: "space", audienceMode: "specific", expectedRevision: d.aclRevision,
      grants: [{ subjectType: "user", subjectId: h.alice.id, role: "manager" },
        { subjectType: "user", subjectId: h.bob.id, role: "viewer" },
        { subjectType: "group", subjectId: group.id, role: "editor" }]
    });
    expect((await h.spaces.requireDocument(h.bob.id, h.team.id, id)).access.role).toBe("editor");
    await h.spaces.saveGroup(h.alice.id, h.team.id, group.id, { name: "Readers", members: [], expectedRevision: group.revision });
    expect((await h.spaces.requireDocument(h.bob.id, h.team.id, id)).access.role).toBe("viewer");
  });

  it("keeps contacts separate from membership and document access", async () => {
    const h = await setup(), id = await h.document();
    await h.spaces.addContact(h.alice.id, h.eve.id);
    expect(await h.spaces.contacts(h.alice.id)).toEqual([{ id: h.eve.id, name: "Eve" }]);
    await expect(h.spaces.requireDocument(h.eve.id, h.team.id, id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await h.spaces.contacts(h.eve.id)).toEqual([]);
  });

  it("authorizes a thousand documents with bounded database reads and rejects unknown or deleted documents", async () => {
    const h = await setup();
    const ids = Array.from({ length: 1000 }, (_, index) => `batch-${index}`);
    await h.db.pool.query(`INSERT INTO space_documents
      (space_id,id,created_by,protection,audience_mode,created_at,updated_at)
      SELECT $1,id,$3,'space','space',$4,$4 FROM unnest($2::text[]) AS id`,
    [h.team.id, ids, h.alice.id, Date.now()]);
    let queries = 0;
    const client = { query(...args) { queries += 1; return h.db.pool.query(...args); } };
    const documents = await h.spaces.requireDocuments(h.bob.id, h.team.id, [...ids, ids[0]], "edit", client);
    expect(documents.map(document => document.id)).toEqual(ids);
    expect(documents.every(document => document.access.role === "editor")).toBe(true);
    expect(queries).toBeLessThanOrEqual(5);
    await expect(h.spaces.requireDocuments(h.bob.id, h.team.id, [...ids, "unknown"], "edit"))
      .rejects.toMatchObject({ code: "document_not_found" });
    await h.db.pool.query("UPDATE space_documents SET lifecycle='deleted' WHERE space_id=$1 AND id=$2",
      [h.team.id, ids[0]]);
    await expect(h.spaces.requireDocuments(h.alice.id, h.team.id, ids, "manage"))
      .rejects.toMatchObject({ code: "document_not_found" });
    await h.accounts.setMember(h.alice.id, h.bob.id, { role: "member", status: "removed" }, h.team.id);
    await expect(h.spaces.requireDocuments(h.bob.id, h.team.id, [ids[1]], "view"))
      .rejects.toMatchObject({ code: "document_not_found" });
  });

  it("keeps batched grants equivalent to individual access and immediately applies group revocation and expiry", async () => {
    const h = await setup(), id = await h.document();
    const group = await h.spaces.saveGroup(h.alice.id, h.team.id, null, { name: "Editors", members: [h.bob.id] });
    await h.spaces.updateDocumentAccess(h.alice.id, h.team.id, id, {
      protection: "space", audienceMode: "specific", expectedRevision: 1,
      grants: [{ subjectType: "user", subjectId: h.alice.id, role: "manager" },
        { subjectType: "user", subjectId: h.bob.id, role: "viewer" },
        { subjectType: "group", subjectId: group.id, role: "editor" }]
    });
    expect(await h.spaces.requireDocuments(h.bob.id, h.team.id, [id], "edit"))
      .toEqual([await h.spaces.requireDocument(h.bob.id, h.team.id, id, "edit")]);
    await h.spaces.saveGroup(h.alice.id, h.team.id, group.id,
      { name: "Editors", members: [], expectedRevision: group.revision });
    expect((await h.spaces.requireDocuments(h.bob.id, h.team.id, [id]))[0].access.role).toBe("viewer");
    await expect(h.spaces.requireDocuments(h.bob.id, h.team.id, [id], "edit"))
      .rejects.toMatchObject({ code: "document_not_found" });
    await h.db.pool.query(`UPDATE space_document_grants SET expires_at=$3
      WHERE space_id=$1 AND document_id=$2 AND user_id=$4`, [h.team.id, id, Date.now() - 1, h.bob.id]);
    await expect(h.spaces.requireDocuments(h.bob.id, h.team.id, [id]))
      .rejects.toMatchObject({ code: "document_not_found" });
    await h.accounts.setMember(h.alice.id, h.bob.id, { role: "admin" }, h.team.id);
    await h.restrict(id);
    await expect(h.spaces.requireDocuments(h.bob.id, h.team.id, [id]))
      .rejects.toMatchObject({ code: "document_not_found" });
  });

  it("permits a guest to comment on one external document without browsing its Space", async () => {
    const h = await setup(), id = await h.document();
    await h.spaces.updatePolicy(h.alice.id, h.team.id, { expectedRevision: 1, allowExternal: true });
    await h.spaces.updateDocumentAccess(h.alice.id, h.team.id, id, {
      expectedRevision: 1, protection: "external", audienceMode: "specific",
      grants: [{ subjectType: "user", subjectId: h.alice.id, role: "manager" },
        { subjectType: "user", subjectId: h.eve.id, role: "commenter" }]
    });
    expect((await h.spaces.comment(h.eve.id, h.team.id, id, "Looks good")).authorId).toBe(h.eve.id);
    await expect(h.spaces.describe(h.eve.id, h.team.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(h.spaces.requireDocument(h.eve.id, h.team.id, id, "edit")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("filters content, titles, tree and search before pagination", async () => {
    const h = await setup(), visible = await h.document("visible", "user public needle"), hidden = await h.document("hidden", "user secret needle");
    await h.restrict(hidden);
    await h.store.writeTree({ id: "root", type: "folder", title: "Sessions", children: [
      { id: visible, type: "session", title: "Visible" },
      { id: "secret-folder", type: "folder", title: "Sensitive folder name", children: [{ id: hidden, type: "session", title: "Hidden title" }] }
    ] });
    const scoped = createAuthorizedWorkbenchStore({ store: h.store, spaces: h.spaces,
      principal: { kind: "account", user: h.bob, space: h.team } });
    const snapshot = await scoped.readSnapshot(), catalog = await scoped.readCatalog();
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(JSON.stringify(catalog)).not.toContain("Hidden");
    expect((await scoped.searchSessions({ query: "needle", limit: 1 })).sessions.map((s) => s.id)).toEqual([visible]);
    await expect(scoped.readSession(hidden)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("prevents a crafted tree mutation from removing a hidden document", async () => {
    const h = await setup(), visible = await h.document("visible"), hidden = await h.document("hidden");
    await h.restrict(hidden);
    const tree = { id: "root", type: "folder", title: "Sessions", children: [
      { id: "folder", type: "folder", title: "Folder", children: [
        { id: visible, type: "session", title: "Visible" }, { id: hidden, type: "session", title: "Hidden" }
      ] }
    ] };
    await h.store.writeTree(tree);
    const scoped = createAuthorizedWorkbenchStore({ store: h.store, spaces: h.spaces,
      principal: { kind: "account", user: h.bob, space: h.team } });
    const base = (await scoped.readTree()).tree;
    await expect(scoped.writeTree({ ...base, children: [] }, [], null, "bob", base))
      .rejects.toMatchObject({ code: "folder_contains_unavailable_documents" });
    expect(JSON.stringify((await h.store.readTree()).tree)).toContain("hidden");
  });

  it("skips full permission projection for an empty event feed and filters new hidden events", async () => {
    const h = await setup(), id = await h.document();
    await h.restrict(id);
    const cursor = (await h.store.readTree()).event_cursor;
    let projections = 0;
    const readableIds = h.spaces.readableIds.bind(h.spaces);
    h.spaces.readableIds = (...args) => { projections += 1; return readableIds(...args); };
    const scoped = createAuthorizedWorkbenchStore({ store: h.store, spaces: h.spaces,
      principal: { kind: "account", user: h.bob, space: h.team } });
    const empty = await scoped.listEvents(cursor);
    expect(empty.events).toEqual([]);
    expect(empty.cursor).toBe(cursor);
    expect(projections).toBe(0);
    await h.store.updateSession(id, { text: "hidden changed" });
    const hidden = await scoped.listEvents(cursor);
    expect(hidden.events).toEqual([]);
    expect(hidden.cursor).toBeGreaterThan(cursor);
    expect(projections).toBe(1);
    await expect(scoped.listEvents(cursor, { sessionId: id }))
      .rejects.toMatchObject({ code: "document_not_found" });
  });

  it("rejects a stale ACL edit rather than overwriting someone else's sharing change", async () => {
    const h = await setup(), id = await h.document();
    await h.restrict(id);
    await expect(h.spaces.updateDocumentAccess(h.alice.id, h.team.id, id, { expectedRevision: 1,
      protection: "space", audienceMode: "space", grants: [] })).rejects.toMatchObject({ code: "document_acl_conflict" });
  });

  it("projects capabilities without copying provider credentials or source paths", async () => {
    const h = await setup(), b = await h.borrow();
    expect((await h.spaces.requireBinding(h.bob.id, h.team.id, b.id)).originResourceId).toBe("model-fixture");
    const consumer = JSON.stringify(await h.spaces.bindings(h.bob.id, h.team.id));
    expect(consumer).not.toContain("DO_NOT_PROJECT");
    expect(consumer).not.toContain("originSpaceId");
    expect(consumer).not.toContain("originResourceId");
  });

  it("honors source-owner withdrawal immediately even for existing consumers", async () => {
    const h = await setup(), b = await h.borrow();
    await h.spaces.updateBinding(h.alice.id, h.team.id, b.id, { expectedRevision: 1, status: "revoked" });
    await expect(h.spaces.requireBinding(h.bob.id, h.team.id, b.id)).rejects.toMatchObject({ code: "capability_unavailable" });
    await expect(h.spaces.updateBinding(h.alice.id, h.team.id, b.id, { expectedRevision: 2, status: "active" }))
      .rejects.toMatchObject({ code: "invalid_capability_status" });
  });

  it("serializes quota reservations across concurrent requests without overspending", async () => {
    const h = await setup(), d = await h.document(), b = await h.borrow();
    await h.execution.setBudget(h.alice.id, h.team.id, { hardLimit: 3 });
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, n) => h.execution.reserve({
      userId: h.bob.id, spaceId: h.team.id, documentId: d, bindingId: b.id, runId: `run${n}`, stepId: "model:1", input: `input${n}`
    })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "space_call_budget_exhausted")).toBe(true);
    const usage = await h.execution.usage(h.alice.id, h.team.id);
    expect(usage.budgets.find((r) => r.scopeKey === "space")).toMatchObject({ reserved: 3, committed: 0, hardLimit: 3 });
    expect(usage.reservations.every((r) => r.requesterId === h.bob.id && r.sponsorId === h.alice.id)).toBe(true);
  });

  it("reserves an idempotent step once and rejects an altered replay", async () => {
    const h = await setup(), d = await h.document(), args = { userId: h.bob.id, spaceId: h.team.id,
      documentId: d, runId: "run", stepId: "model:1", input: "original" };
    const [a, b] = await Promise.all([h.execution.reserve(args), h.execution.reserve(args)]);
    expect(a.id).toBe(b.id);
    await expect(h.execution.reserve({ ...args, input: "changed" })).rejects.toMatchObject({ code: "step_idempotency_conflict" });
    expect((await h.execution.usage(h.alice.id, h.team.id)).budgets.find((r) => r.scopeKey === "space").reserved).toBe(1);
  });

  it("keeps an uncertain dispatch reserved until a verified receipt settles it exactly once", async () => {
    const h = await setup(), d = await h.document(), content = await h.spaces.content(h.team.id, d);
    await h.execution.enqueue({ userId: h.bob.id, spaceId: h.team.id, documentId: d, runId: "run", inputRevision: content.revision });
    await h.execution.claim(h.team.id, "run");
    const r = await h.execution.reserve({ userId: h.bob.id, spaceId: h.team.id, documentId: d, runId: "run", stepId: "model:1", input: "hello" });
    await h.execution.dispatch(h.team.id, r.id);
    await h.execution.pending(h.team.id, r.id);
    await expect(h.execution.releaseUndispatched(h.team.id, r.id)).rejects.toMatchObject({ code: "reservation_state_conflict" });
    expect((await h.execution.finish(h.team.id, "run", "cancelled")).status).toBe("outcome_unknown");
    const receipt = { id: "provider-receipt", verified: true, calls: 1, inputTokens: 10, outputTokens: 5 };
    await Promise.all([h.execution.settle(h.team.id, r.id, receipt), h.execution.settle(h.team.id, r.id, receipt)]);
    const usage = await h.execution.usage(h.alice.id, h.team.id);
    expect(usage.budgets.find((r) => r.scopeKey === "space")).toMatchObject({ reserved: 0, committed: 1 });
    expect((await h.db.pool.query("SELECT 1 FROM space_usage_ledger WHERE reservation_id=$1 AND event_type='settled'", [r.id])).rowCount).toBe(1);
  });

  it("rechecks document and capability authority immediately before dispatch", async () => {
    const h = await setup(), d = await h.document(), b = await h.borrow(), c = await h.spaces.content(h.team.id, d);
    await h.execution.enqueue({ userId: h.bob.id, spaceId: h.team.id, documentId: d, bindingId: b.id, runId: "run", inputRevision: c.revision });
    await h.execution.claim(h.team.id, "run");
    const r = await h.execution.reserve({ userId: h.bob.id, spaceId: h.team.id, documentId: d, bindingId: b.id,
      runId: "run", stepId: "model:1", input: "hello" });
    await h.spaces.updateBinding(h.alice.id, h.team.id, b.id, { expectedRevision: 1, status: "disabled" });
    await expect(h.execution.dispatch(h.team.id, r.id)).rejects.toMatchObject({ code: "capability_unavailable" });
    await h.execution.releaseUndispatched(h.team.id, r.id);
  });

  it("blocks an uncertain shared tool replay even with a new invocation ID", async () => {
    const h = await setup(), d = await h.document(), content = await h.spaces.content(h.team.id, d);
    await h.execution.enqueue({ userId: h.bob.id, spaceId: h.team.id, documentId: d, runId: "run", inputRevision: content.revision });
    await h.execution.claim(h.team.id, "run");
    const args = { userId: h.bob.id, spaceId: h.team.id, documentId: d, runId: "run", stepId: "tool:first",
      input: JSON.stringify({ name: "spaceCapabilityCall", arguments: { tool: "write", path: "plan.txt" } }) };
    const r = await h.execution.reserve(args);
    await h.execution.dispatch(h.team.id, r.id);
    await h.execution.pending(h.team.id, r.id);
    await expect(h.execution.reserve({ ...args, stepId: "tool:second" })).rejects.toMatchObject({ code: "shared_tool_outcome_requires_reconciliation" });
  });

  it("uses document FIFO, allows queued cancellation, and never has two writers", async () => {
    const h = await setup(), d = await h.document(), content = await h.spaces.content(h.team.id, d);
    for (const runId of ["first", "second", "third"]) await h.execution.enqueue({ userId: h.bob.id,
      spaceId: h.team.id, documentId: d, runId, inputRevision: content.revision });
    expect(await h.execution.claim(h.team.id, "second")).toBeNull();
    expect((await h.execution.claim(h.team.id, "first")).status).toBe("running");
    expect(await h.execution.claim(h.team.id, "third")).toBeNull();
    await h.execution.cancel(h.bob.id, h.team.id, "second");
    await h.execution.finish(h.team.id, "first", "completed");
    expect((await h.execution.claim(h.team.id, "third")).status).toBe("running");
    expect((await h.db.pool.query("SELECT 1 FROM space_run_queue WHERE space_id=$1 AND status='running'", [h.team.id])).rowCount).toBe(1);
  });

  it("rejects queued work whose document was edited before its turn", async () => {
    const h = await setup(), d = await h.document(), content = await h.spaces.content(h.team.id, d);
    await h.execution.enqueue({ userId: h.bob.id, spaceId: h.team.id, documentId: d, runId: "stale", inputRevision: content.revision });
    await h.store.updateSession(d, { text: "user revised", meta: {} });
    expect(await h.execution.claim(h.team.id, "stale")).toMatchObject({ status: "failed", reason: "document_changed_while_queued" });
  });

  it("removes direct/group grants and queued execution through the legacy member removal endpoint", async () => {
    const h = await setup(), d = await h.document(), c = await h.spaces.content(h.team.id, d);
    await h.restrict(d, [{ subjectType: "user", subjectId: h.bob.id, role: "editor" }]);
    await h.spaces.saveGroup(h.alice.id, h.team.id, null, { name: "Both", members: [h.bob.id] });
    await h.execution.enqueue({ userId: h.bob.id, spaceId: h.team.id, documentId: d, runId: "revoked", inputRevision: c.revision });
    await h.accounts.setMember(h.alice.id, h.bob.id, { role: "member", status: "removed" }, h.team.id);
    expect((await h.db.pool.query("SELECT 1 FROM space_document_grants WHERE space_id=$1 AND user_id=$2", [h.team.id, h.bob.id])).rowCount).toBe(0);
    expect((await h.db.pool.query("SELECT 1 FROM space_group_members WHERE space_id=$1 AND user_id=$2", [h.team.id, h.bob.id])).rowCount).toBe(0);
    expect((await h.execution.listQueue(h.alice.id, h.team.id, d))[0].status).toBe("cancelled");
  });

  it("requires explicit publication review and serves an immutable projection", async () => {
    const h = await setup(), d = await h.document(), content = await h.spaces.content(h.team.id, d);
    await h.spaces.updatePolicy(h.alice.id, h.team.id, { expectedRevision: 1, allowExternal: true, allowPublic: true });
    await h.spaces.updateDocumentAccess(h.alice.id, h.team.id, d, { expectedRevision: 1,
      protection: "external", audienceMode: "space", grants: [{ subjectType: "user", subjectId: h.alice.id, role: "manager" }] });
    const args = { sourceRevision: content.revision, title: "Reviewed answer", markdown: "Public text" };
    await expect(h.spaces.publish(h.alice.id, h.team.id, d, args)).rejects.toMatchObject({ code: "publication_review_required" });
    const published = await h.spaces.publish(h.alice.id, h.team.id, d, { ...args, reviewed: true });
    await h.store.updateSession(d, { text: "user next private draft" });
    expect(await h.spaces.publication(published.id)).toMatchObject({ title: "Reviewed answer", markdown: "Public text", revision: content.revision });
    await h.spaces.revokePublication(h.alice.id, h.team.id, published.id);
    await expect(h.spaces.publication(published.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not feed restricted knowledge into a broader document", async () => {
    const h = await setup(), privateDoc = await h.document("private"), broadDoc = await h.document("broad");
    await h.restrict(privateDoc, [{ subjectType: "user", subjectId: h.bob.id, role: "editor" }]);
    const c = await h.spaces.content(h.team.id, privateDoc);
    await h.spaces.chooseKnowledge(h.alice.id, h.team.id, privateDoc, { reviewed: true, sourceRevision: c.revision, title: "Sensitive", text: "restricted fact" });
    expect((await h.spaces.knowledge(h.bob.id, h.team.id)).map((r) => r.text)).toEqual(["restricted fact"]);
    expect(await h.spaces.knowledge(h.bob.id, h.team.id, { destinationId: broadDoc })).toEqual([]);
    expect((await h.spaces.knowledge(h.bob.id, h.team.id, { destinationId: privateDoc }))).toHaveLength(1);
  });

  it("copies only reviewed assets into the public version and withdraws them with it", async () => {
    const h = await setup(), d = await h.document(), content = await h.spaces.content(h.team.id, d);
    await h.spaces.updatePolicy(h.alice.id, h.team.id, { expectedRevision: 1, allowExternal: true, allowPublic: true });
    await h.spaces.updateDocumentAccess(h.alice.id, h.team.id, d, { expectedRevision: 1,
      protection: "external", audienceMode: "space", grants: [{ subjectType: "user", subjectId: h.alice.id, role: "manager" }] });
    const assets = new PostgresAssetStore(h.db.pool, { spaceId: h.team.id });
    await assets.create({ id: "image", ownerId: h.alice.id, state: "ready", mediaKind: "image",
      mediaType: "image/png", byteLength: 3, sha256: "a".repeat(64), blobKey: "fixture", createdAt: Date.now() });
    const args = { sourceRevision: content.revision, title: "Public image", reviewed: true,
      markdown: "![Approved](zion-asset://image)", approvedAssetIds: ["image"] };
    await expect(h.spaces.publish(h.alice.id, h.team.id, d, args)).rejects.toMatchObject({ code: "publication_asset_unverified" });
    const published = await h.spaces.publish(h.alice.id, h.team.id, d, args,
      [{ id: "image", mediaType: "image/png", content: Buffer.from([1, 2, 3]) }]);
    const copy = await h.spaces.publication(published.id);
    expect(copy.markdown).not.toContain("zion-asset");
    const publicAssetId = copy.markdown.match(/assets\/([A-Za-z0-9_-]+)/)[1];
    expect((await h.spaces.publicationAsset(published.id, publicAssetId)).content).toEqual(Buffer.from([1, 2, 3]));
    await h.spaces.revokePublication(h.alice.id, h.team.id, published.id);
    await expect(h.spaces.publicationAsset(published.id, publicAssetId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rolls back document creation and ACL together when content persistence fails", async () => {
    const h = await setup();
    const store = Object.create(h.store);
    store.updateSession = async () => { throw new Error("injected content write failure"); };
    const scoped = createAuthorizedWorkbenchStore({ store, spaces: h.spaces,
      principal: { kind: "account", user: h.bob, space: h.team } });
    await expect(scoped.updateSession("failed", { text: "user test" })).rejects.toThrow("injected");
    expect((await h.db.pool.query("SELECT 1 FROM space_documents WHERE space_id=$1 AND id='failed'", [h.team.id])).rowCount).toBe(0);
  });

  it("recovers lost owners without repeating external calls or retaining undispatched quota", async () => {
    const h = await setup(), d = await h.document(), content = await h.spaces.content(h.team.id, d);
    const runs = new PostgresRunStore(h.db.pool, { spaceId: h.team.id });
    for (const runId of ["unsubmitted", "unknown"]) {
      await runs.create({ id: runId, attemptId: "attempt", status: "interrupted", sessionId: d,
        principal: { userId: h.bob.id, spaceId: h.team.id }, metadata: {}, updatedAt: Date.now() });
      await h.execution.enqueue({ userId: h.bob.id, spaceId: h.team.id, documentId: d, runId, inputRevision: content.revision });
    }
    await h.execution.claim(h.team.id, "unsubmitted");
    await h.execution.reserve({ userId: h.bob.id, spaceId: h.team.id, documentId: d,
      runId: "unsubmitted", stepId: "model:1", input: "not dispatched" });
    const reopened = new SpaceExecutionStore({ spaces: h.spaces });
    const recovered = await reopened.recover(h.team.id);
    expect(recovered.find((q) => q.runId === "unsubmitted").status).toBe("failed");
    expect((await reopened.usage(h.alice.id, h.team.id)).budgets.find((b) => b.scopeKey === "space").reserved).toBe(0);
    // A fresh dispatch with a lost owner remains unresolved after another restart.
    await h.execution.enqueue({ userId: h.bob.id, spaceId: h.team.id, documentId: d,
      runId: "unknown", inputRevision: content.revision, resume: true });
    await h.execution.claim(h.team.id, "unknown");
    const r = await h.execution.reserve({ userId: h.bob.id, spaceId: h.team.id, documentId: d,
      runId: "unknown", stepId: "model:2", input: "sent" });
    await h.execution.dispatch(h.team.id, r.id);
    const afterRestart = await new SpaceExecutionStore({ spaces: h.spaces }).recover(h.team.id);
    expect(afterRestart.find((q) => q.runId === "unknown").status).toBe("outcome_unknown");
    expect((await h.execution.usage(h.alice.id, h.team.id)).reservations.find((item) => item.id === r.id).state).toBe("pending");
  });

  it("invalidates a reviewed knowledge projection when source content or ACL changes", async () => {
    const h = await setup(), d = await h.document(), c = await h.spaces.content(h.team.id, d);
    await h.spaces.chooseKnowledge(h.alice.id, h.team.id, d, { reviewed: true, sourceRevision: c.revision, title: "Facts", text: "old fact" });
    await h.store.updateSession(d, { text: "user new fact" });
    expect((await h.spaces.knowledge(h.bob.id, h.team.id))[0]).toMatchObject({ status: "review_required", text: null });
  });

  it("transfers ownership only after the named member accepts it", async () => {
    const h = await setup(), transfer = await h.spaces.transferOwnership(h.alice.id, h.team.id, h.bob.id);
    expect((await h.accounts.membership(h.alice.id, h.team.id)).role).toBe("owner");
    await expect(h.spaces.acceptOwnership(h.eve.id, h.team.id, transfer.id)).rejects.toMatchObject({ code: "invalid_owner_transfer" });
    await h.spaces.acceptOwnership(h.bob.id, h.team.id, transfer.id);
    expect((await h.accounts.membership(h.bob.id, h.team.id)).role).toBe("owner");
    expect((await h.accounts.membership(h.alice.id, h.team.id)).role).toBe("admin");
  });

  it("retains documents, sharing and budgets when service objects are recreated", async () => {
    const h = await setup(), d = await h.document(), b = await h.borrow();
    await h.execution.setBudget(h.alice.id, h.team.id, { hardLimit: 20 });
    const reopened = new PostgresSharedSpaceStore({ accounts: h.accounts });
    expect((await reopened.requireDocument(h.bob.id, h.team.id, d)).access.role).toBe("editor");
    expect((await reopened.requireBinding(h.bob.id, h.team.id, b.id)).providerId).toBe(h.alice.id);
    expect((await new SpaceExecutionStore({ spaces: reopened }).usage(h.alice.id, h.team.id)).budgets[0].hardLimit).toBe(20);
  });

  it("enforces explicit shared scope and detects path/header conflicts at authentication", async () => {
    const h = await setup(), login = await h.accounts.createSession(h.bob.id, { activeSpaceId: h.team.id });
    const access = new AccountAccessControl({ accounts: h.accounts, sharedSpaces: h.spaces, oidc: { secureCookies: false },
      store: { authenticate: async () => null, exchangePairing: async () => null },
      publicBaseUrl: "http://127.0.0.1:55672", servedSpaceId: h.team.id });
    const request = { method: "GET", url: "/v1/sessions", headers: { authorization: `Bearer ${login.token}` } };
    await expect(access.authorizeRuntimeRequest(request)).rejects.toMatchObject({ code: "explicit_space_required" });
    expect((await access.authorizeRuntimeRequest({ ...request, headers: { ...request.headers, "x-zioon-space-id": h.team.id } })).space.id).toBe(h.team.id);
    await expect(access.authenticateRequest({ ...request, url: `/v1/spaces/${encodeURIComponent(h.team.id)}/documents/x`,
      headers: { ...request.headers, "x-zioon-space-id": "wrong" } })).rejects.toMatchObject({ code: "space_scope_conflict" });
  });
});
