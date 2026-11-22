import { afterEach, describe, expect, it } from "vitest";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { PostgresSharedSpaceStore } from "../src/spaces/postgres-shared-space-store.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { SpaceExecutionStore } from "../src/spaces/space-execution-store.mjs";
import { createDocumentTransfer } from "../src/spaces/document-transfer.mjs";
import { createAuthorizedWorkbenchStore } from "../src/spaces/authorized-workbench-store.mjs";
import { createSharedCollaborationPersistence } from "../src/spaces/collaboration-persistence.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const db = await createPostgresTestDatabase("space_transfer");
  cleanup.push(() => db.close());
  const alice = await db.accounts.resolveIdentity({ issuer: "https://fixture.test", subject: "Alice" });
  const bob = await db.accounts.resolveIdentity({ issuer: "https://fixture.test", subject: "Bob" });
  const personal = await db.accounts.personalSpace(alice.id);
  const team = await db.accounts.createTeamSpace(alice.id, { name: "Shared" });
  const spaces = new PostgresSharedSpaceStore({ accounts: db.accounts });
  await spaces.acceptInvitation(bob.id, (await spaces.invite(alice.id, team.id, { userId: bob.id })).token);
  const source = new PostgresWorkbenchStateStore(db.pool, { spaceId: personal.id });
  const target = new PostgresWorkbenchStateStore(db.pool, { spaceId: team.id });
  await spaces.registerDocument(alice.id, personal.id, "source");
  await source.createSession({ id: "source", text: "user reviewed text", title: "Private title",
    meta: { privateInstallation: "SHOULD_NOT_COPY" } });
  const transfer = createDocumentTransfer({ spaces, acquireRuntime: async spaceId => ({
    app: { documentStore: spaceId === personal.id ? source : target }, release() {}
  }) });
  const input = { requestId: "request", sourceSpaceId: personal.id, sourceDocumentId: "source",
    sourceRevision: (await spaces.content(personal.id, "source")).revision,
    sourceAclRevision: 1, title: "Reviewed version", markdown: "user selected passage", reviewed: true };
  return { db, alice, bob, personal, team, spaces, source, target, transfer, input };
}

describe("reviewed transfer and authorization persistence with PostgreSQL", () => {
  it("keeps operation replays local to the initiating user and rolls back failed creation", async () => {
    const h = await fixture();
    const scoped = user => createAuthorizedWorkbenchStore({ store: h.target, spaces: h.spaces,
      principal: { kind: "account", user, space: h.team } });
    const first = await scoped(h.alice).createSession({ id: "alice-only", text: "private", operation_id: "same-operation" });
    await h.spaces.updateDocumentAccess(h.alice.id, h.team.id, first.id, {
      expectedRevision: 1, protection: "restricted", audienceMode: "specific",
      grants: [{ subjectType: "user", subjectId: h.alice.id, role: "manager" }]
    });
    const second = await scoped(h.bob).createSession({ id: "bob-own", text: "mine", operation_id: "same-operation" });
    expect(second.id).toBe("bob-own");
    expect((await scoped(h.bob).createSession({ id: "bob-own", text: "mine", operation_id: "same-operation" })).duplicate).toBe(true);
    const failed = await scoped(h.bob).createSession({ id: "conflict", expected_revision: 999999, text: "unused" });
    expect(failed.conflict).toBe(true);
    expect((await h.db.pool.query("SELECT 1 FROM space_documents WHERE space_id=$1 AND id='conflict'", [h.team.id])).rowCount).toBe(0);
  });

  it("commits personal imports with ACL enrollment and rolls back both on failed asset checks", async () => {
    const h = await fixture();
    const scoped = createAuthorizedWorkbenchStore({ store: h.source, spaces: h.spaces,
      principal: { kind: "account", user: h.alice, space: h.personal } });
    await scoped.writeSnapshot({ docs: [{ id: "imported", text: "user selected" }], metas: [] });
    expect((await scoped.readSession("imported")).text).toBe("user selected");
    await expect(scoped.writeSnapshot({ docs: [
      { id: "partial", text: "user first" }, { id: "bad", text: "![hidden](zion-asset://missing)" }
    ] })).rejects.toMatchObject({ statusCode: 404 });
    expect(await h.source.readSession("partial")).toBeNull();
    expect((await h.db.pool.query("SELECT 1 FROM space_documents WHERE space_id=$1 AND id=ANY($2::text[])",
      [h.personal.id, ["partial", "bad"]])).rowCount).toBe(0);
  });

  it("rolls back a canonical fork when its copied document permissions cannot be committed", async () => {
    const h = await fixture(), runs = new PostgresRunStore(h.db.pool, { spaceId: h.personal.id });
    await runs.createSession({ id: "source", title: "original", status: "active", metadata: {}, createdAt: Date.now(), updatedAt: Date.now() });
    await expect(h.spaces.transaction(h.personal.id, async client => {
      await runs.forkSession("source", { id: "failed-fork" }, { client });
      await h.spaces.copyDocumentAccess(h.alice.id, h.personal.id, "missing", "failed-fork", client);
    })).rejects.toMatchObject({ statusCode: 404 });
    expect(await runs.getSession("failed-fork")).toBeNull();
  });

  it("creates content and restricted permissions together, without copying private metadata", async () => {
    const h = await fixture();
    const result = await h.transfer(h.alice.id, h.team.id, h.input);
    expect(result.document.protection).toBe("restricted");
    await expect(h.spaces.requireDocument(h.bob.id, h.team.id, result.document.id)).rejects.toMatchObject({ statusCode: 404 });
    const doc = await h.target.readSession(result.document.id);
    expect(doc.text).toBe(h.input.markdown);
    expect(JSON.stringify(doc)).not.toContain("SHOULD_NOT_COPY");
    expect((await h.transfer(h.alice.id, h.team.id, h.input)).document.id).toBe(result.document.id);
    await expect(h.transfer(h.alice.id, h.team.id, { ...h.input, markdown: "different" }))
      .rejects.toMatchObject({ code: "document_transfer_request_conflict" });
  });

  it("shares a reviewed copy with the chosen Space audience", async () => {
    const h = await fixture();
    const result = await h.transfer(h.alice.id, h.team.id, { ...h.input,
      audience: { protection: "space", audienceMode: "space", grants: [] } });
    expect((await h.spaces.requireDocument(h.bob.id, h.team.id, result.document.id)).access.role).toBe("editor");
  });

  it("rejects a stale review without creating an orphan document or ACL", async () => {
    const h = await fixture();
    await h.source.updateSession("source", { text: "user changed" });
    await expect(h.transfer(h.alice.id, h.team.id, h.input)).rejects.toMatchObject({ code: "document_review_stale" });
    expect((await h.db.pool.query("SELECT 1 FROM space_documents WHERE space_id=$1", [h.team.id])).rowCount).toBe(0);
    expect((await h.target.readCatalog()).metas || []).toEqual([]);
  });

  it("moves a reviewed document atomically and replays the receipt after the source becomes unavailable", async () => {
    const h = await fixture(), input = { ...h.input, mode: "move" };
    const result = await h.transfer(h.alice.id, h.team.id, input);
    await expect(h.spaces.requireDocument(h.alice.id, h.personal.id, "source")).rejects.toMatchObject({ statusCode: 404 });
    expect((await h.transfer(h.alice.id, h.team.id, input)).document.id).toBe(result.document.id);
  });

  it("rejects source images which were not explicitly selected", async () => {
    const h = await fixture();
    await expect(h.transfer(h.alice.id, h.team.id, { ...h.input, markdown: "![private](zion-asset://private)" }))
      .rejects.toMatchObject({ code: "document_contains_unapproved_assets" });
  });

  it("claims frozen queued context after the previous answer changes the document", async () => {
    const h = await fixture(), result = await h.transfer(h.alice.id, h.team.id, { ...h.input,
      audience: { protection: "space", audienceMode: "space", grants: [] } });
    const documentId = result.document.id;
    const runs = new PostgresRunStore(h.db.pool, { spaceId: h.team.id });
    await runs.create({ id: "frozen", attemptId: "attempt", status: "created", sessionId: documentId,
      principal: { userId: h.bob.id, spaceId: h.team.id }, inputMessages: [{ role: "user", content: "my snapshot" }],
      metadata: {}, updatedAt: Date.now() });
    const execution = new SpaceExecutionStore({ spaces: h.spaces });
    await execution.enqueue({ userId: h.bob.id, spaceId: h.team.id, documentId, runId: "frozen",
      inputRevision: (await h.spaces.content(h.team.id, documentId)).revision, frozenInput: true });
    await h.target.updateSession(documentId, { text: "user previous\nassistant earlier answer" });
    expect((await execution.claim(h.team.id, "frozen")).status).toBe("running");
  });

  it("reserves again after a proven undispatched release and preserves both ledger records", async () => {
    const h = await fixture(), result = await h.transfer(h.alice.id, h.team.id, { ...h.input,
      audience: { protection: "space", audienceMode: "space", grants: [] } });
    const documentId = result.document.id, execution = new SpaceExecutionStore({ spaces: h.spaces });
    await execution.enqueue({ userId: h.bob.id, spaceId: h.team.id, documentId, runId: "run", inputRevision: 1 });
    await execution.claim(h.team.id, "run");
    const args = { userId: h.bob.id, spaceId: h.team.id, documentId, runId: "run", stepId: "tool:call", input: "unchanged" };
    const first = await execution.reserve(args);
    await execution.releaseUndispatched(h.team.id, first.id);
    const second = await execution.reserve(args);
    expect(second.id).not.toBe(first.id);
    await execution.dispatch(h.team.id, second.id);
    await execution.settle(h.team.id, second.id, { id: "receipt", calls: 1, verified: true });
    const usage = await execution.usage(h.alice.id, h.team.id);
    expect(usage.budgets.find(b => b.scopeKey === "space")).toMatchObject({ committed: 1, reserved: 0 });
    expect(usage.reservations.map(r => r.state).sort()).toEqual(["released", "settled"]);
  });

  it("rolls back content deletion when ACL invalidation fails", async () => {
    const h = await fixture(), result = await h.transfer(h.alice.id, h.team.id, h.input);
    const spaces = Object.create(h.spaces);
    spaces.invalidateKnowledge = async () => { throw new Error("injected failure"); };
    const store = createAuthorizedWorkbenchStore({ store: h.target, spaces,
      principal: { kind: "account", user: h.alice, space: h.team } });
    await expect(store.deleteSession(result.document.id, {})).rejects.toThrow("injected failure");
    expect((await h.target.readSession(result.document.id)).deleted).not.toBe(true);
    expect((await h.spaces.requireDocument(h.alice.id, h.team.id, result.document.id)).lifecycle).toBe("active");
  });

  it("rejects delayed peer writes if any unpersisted contributor has lost permission", async () => {
    const h = await fixture(), result = await h.transfer(h.alice.id, h.team.id, { ...h.input,
      audience: { protection: "space", audienceMode: "space", grants: [] } });
    const documentId = result.document.id;
    await h.db.accounts.setMember(h.alice.id, h.bob.id, { role: "member", status: "removed" }, h.team.id);
    const persistence = createSharedCollaborationPersistence({ spaces: h.spaces, store: h.target,
      access: { reauthorize: async () => {} }, runs: {} });
    const peer = { principal: { kind: "account", user: h.bob, space: h.team }, documentId };
    const owner = { principal: { kind: "account", user: h.alice, space: h.team }, documentId };
    await expect(persistence({ sessionId: documentId, context: owner, contributors: [peer], kind: "store", text: "unauthorized" },
      tx => h.target.updateSession(documentId, { text: "unauthorized" }, tx))).rejects.toMatchObject({ statusCode: 404 });
    expect((await h.target.readSession(documentId)).text).toBe(h.input.markdown);
  });
});
