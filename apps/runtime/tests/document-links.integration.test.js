import { afterEach, describe, expect, it } from "vitest";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { PostgresSharingStore } from "../src/sharing/postgres-sharing-store.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const db = await createPostgresTestDatabase("document_links"); cleanup.push(db.close);
  const [owner, reader, stranger] = await Promise.all(["owner", "reader", "stranger"].map(subject =>
    db.accounts.resolveIdentity({ issuer: "https://links.test", subject, name: subject })));
  const space = await db.accounts.personalSpace(owner.id);
  const sharing = new PostgresSharingStore({ accounts: db.accounts });
  const documents = new PostgresWorkbenchStateStore(db.pool, { spaceId: space.id });
  await documents.updateSession("doc", { text: "# BODY_ONLY\n![image](zion-asset://image123)", title: "链接文档" });
  return { db, owner, reader, stranger, space, sharing, documents, links: sharing.links };
}
describe("stable document links and account access requests", () => {
  it("defaults to explicit restricted sharing and never exposes a body before approval", async () => {
    const h = await fixture();
    expect(await h.links.get(h.owner.id, "doc")).toEqual({ link: null });
    const { link } = await h.links.set(h.owner.id, "doc", "restricted");
    expect(await h.links.view(link.id)).toEqual({ state: "login", request: null });
    expect(await h.links.view(link.id, h.reader.id)).toEqual({ state: "request", request: null });
    const results = await Promise.all([1, 2, 3].map(() => h.links.request(h.reader.id, link.id, { role: "editor", message: "一起整理" })));
    expect(new Set(results.map(result => result.request.id)).size).toBe(1);
    expect((await h.links.requests(h.owner.id, "doc")).requests).toHaveLength(1);
    const request = results[0].request;
    await expect(h.links.decide(h.stranger.id, "doc", request.id, { status: "approved", role: "editor" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(h.links.request(h.owner.id, link.id)).rejects.toMatchObject({ code: "cannot_request_own_document" });
    await h.links.decide(h.owner.id, "doc", request.id, { status: "approved", role: "viewer" });
    expect(await h.links.view(link.id, h.reader.id)).toMatchObject({ state: "read", markdown: expect.stringContaining("BODY_ONLY"), role: "viewer" });
    expect((await h.sharing.contentIndex(h.reader.id)).received[0]).toMatchObject({ id: "doc", role: "viewer" });
    await expect(h.sharing.documentAccess(h.reader.id, h.space.id, "doc", "edit")).rejects.toMatchObject({ statusCode: 404 });
    expect(await h.db.accounts.membership(h.reader.id, h.space.id)).toBeFalsy();
    await h.links.decide(h.owner.id, "doc", request.id, { status: "approved", role: "editor" });
    expect((await h.links.view(link.id, h.reader.id)).role).toBe("viewer");
  });
  it("keeps the same URL, reads current content, and closes public reading without changing direct grants", async () => {
    const h = await fixture(), first = await h.links.set(h.owner.id, "doc", "public");
    expect((await h.links.view(first.link.id)).markdown).toContain("BODY_ONLY");
    await h.documents.updateSession("doc", { text: "CURRENT_BODY" });
    expect((await h.links.view(first.link.id)).markdown).toBe("CURRENT_BODY");
    const direct = await h.sharing.create(h.owner.id, { kind: "document", sourceId: "doc", recipient: h.reader.id, role: "editor" });
    const restricted = await h.links.set(h.owner.id, "doc", "restricted");
    expect(restricted.link.id).toBe(first.link.id);
    expect((await h.links.view(first.link.id)).state).toBe("login");
    expect((await h.links.view(first.link.id, h.reader.id)).role).toBe("editor");
    await h.links.set(h.owner.id, "doc", "disabled");
    await expect(h.links.view(first.link.id, h.reader.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await h.sharing.requireGrant(h.reader.id, direct.share.id)).role).toBe("editor");
  });
  it("blocks public access, request approval and republishing while private, then refuses deleted bodies", async () => {
    const h = await fixture(), { link } = await h.links.set(h.owner.id, "doc", "public");
    const { request } = await h.links.request(h.reader.id, link.id);
    await h.sharing.setPrivate(h.owner.id, "doc", true);
    await expect(h.links.view(link.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(h.links.request(h.stranger.id, link.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(h.links.decide(h.owner.id, "doc", request.id, { status: "approved", role: "editor" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(h.links.set(h.owner.id, "doc", "public")).rejects.toMatchObject({ code: "document_is_private" });
    await h.sharing.setPrivate(h.owner.id, "doc", false);
    await h.db.pool.query("DELETE FROM runtime_workbench_documents WHERE space_id=$1 AND id='doc'", [h.space.id]);
    await expect(h.links.view(link.id)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("rejects unknown accounts and invalid roles, and permits a new request after rejection or grant removal", async () => {
    const h = await fixture(), { link } = await h.links.set(h.owner.id, "doc", "restricted");
    await expect(h.links.request("unknown", link.id)).rejects.toMatchObject({ statusCode: 401 });
    await expect(h.links.request(h.reader.id, link.id, { role: "owner" })).rejects.toMatchObject({ statusCode: 400 });
    const first = await h.links.request(h.reader.id, link.id);
    await h.links.decide(h.owner.id, "doc", first.request.id, { status: "rejected" });
    expect((await h.links.view(link.id, h.reader.id)).request.status).toBe("rejected");
    const again = await h.links.request(h.reader.id, link.id, { role: "editor" });
    await h.links.decide(h.owner.id, "doc", again.request.id, { status: "approved", role: "editor" });
    await h.sharing.updateDocumentCollaborator(h.owner.id, "doc", h.reader.id, "removed");
    expect((await h.links.view(link.id, h.reader.id)).state).toBe("request");
    expect((await h.links.request(h.reader.id, link.id)).request.status).toBe("pending");
    await h.db.pool.query("UPDATE account_users SET status='disabled' WHERE id=$1", [h.owner.id]);
    await expect(h.links.view(link.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
