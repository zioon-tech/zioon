import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { PostgresSharingStore } from "../src/sharing/postgres-sharing-store.mjs";
import { SharedFolderOperations } from "../src/sharing/shared-folder-operations.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const db = await createPostgresTestDatabase("shared_folder_ops");
  cleanup.push(db.close);
  const alice = await db.accounts.resolveIdentity({ issuer: "https://folder.test", subject: "alice" });
  const bob = await db.accounts.resolveIdentity({ issuer: "https://folder.test", subject: "bob" });
  const space = await db.accounts.personalSpace(alice.id);
  const store = await new PostgresWorkbenchStateStore(db.pool, { spaceId: space.id }).initialize();
  const sharing = new PostgresSharingStore({ accounts: db.accounts });
  await store.updateSession("visible", { text: "visible content", meta: { title: "visible" } });
  await store.updateSession("private", { text: "private content", meta: { title: "private" } });
  await store.writeTree({ id: "root", type: "folder", children: [
    { id: "shared", type: "folder", title: "shared", children: [
      { id: "visible", type: "session", title: "visible" },
      { id: "hidden-folder", type: "folder", title: "hidden-folder", children: [{ id: "private", type: "session", title: "private" }] }
    ] }, { id: "outside", type: "folder", title: "outside", children: [] }
  ] });
  const { share } = await sharing.create(alice.id, { kind: "folder", sourceId: "shared", recipient: bob.id, role: "editor" });
  const operations = new SharedFolderOperations({ sharing, store });
  const mutate = input => operations.mutate(bob.id, share.id, { operationId: randomUUID(), ...input });
  return { db, alice, bob, space, store, sharing, share, operations, mutate };
}
describe("shared folder mutation isolation", () => {
  it("blocks private descendants and stale deletes atomically, without emitting partial changes", async () => {
    const h = await fixture();
    await h.sharing.setPrivate(h.alice.id, "private", true);
    const before = await h.sharing.tree(h.space.id);
    const events = [];
    const subscription = h.store.subscribeEvents(event => events.push(event));
    await expect(h.mutate({ action: "rename", id: "private", title: "stolen" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(h.mutate({ action: "move", id: "hidden-folder", parentId: "shared" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(h.mutate({ action: "delete", id: "shared", expectedTree: before.children[0] })).rejects.toMatchObject({ statusCode: 404 });
    expect(await h.sharing.tree(h.space.id)).toEqual(before);
    expect(events).toEqual([]);
    subscription.dispose();
    await h.sharing.setPrivate(h.alice.id, "private", false);
    const stale = structuredClone(before.children[0]);
    await h.mutate({ action: "createDocument", id: "shared", title: "new" });
    await expect(h.mutate({ action: "delete", id: "shared", expectedTree: stale })).rejects.toMatchObject({ statusCode: 409 });
    expect((await h.store.readSession("private")).text).toBe("private content");
  });
  it("serializes concurrent creation and name changes, and makes retries safe while retaining revocation checks", async () => {
    const h = await fixture();
    const token = randomUUID();
    const inputs = { action: "createFolder", id: "shared", title: "created", operationId: token };
    const [one, two] = await Promise.all([h.mutate(inputs), h.mutate(inputs)]);
    expect(two).toMatchObject(one);
    expect((await h.sharing.tree(h.space.id)).children[0].children.filter(node => node.id === one.id)).toHaveLength(1);
    const results = await Promise.allSettled([
      h.mutate({ action: "rename", id: "shared", title: "first", expectedTitle: "shared" }),
      h.mutate({ action: "rename", id: "shared", title: "second", expectedTitle: "shared" })
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected").reason.statusCode).toBe(409);
    const creates = await Promise.all(Array.from({ length: 8 }, (_, i) => h.mutate({ action: "createDocument", id: one.id, title: `doc ${i}` })));
    expect((await h.sharing.tree(h.space.id)).children[0].children.find(node => node.id === one.id).children).toHaveLength(8);
    for (const created of creates) expect((await h.store.readSession(created.id)).meta.title).toBe(created.title);
    await h.sharing.revoke(h.alice.id, h.share.id, { recipientId: h.bob.id });
    await expect(h.mutate(inputs)).rejects.toMatchObject({ code: "share_access_revoked" });
  });
});
