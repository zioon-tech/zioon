import { afterEach, describe, expect, it } from "vitest";
import { createDocumentVisitorRegistry } from "../src/sharing/document-visitor-registry.mjs";
const cleanup = [];
afterEach(() => { cleanup.splice(0).forEach(close => close()); });
describe("bounded HTTP reader lease lifetime", () => {
  it("expires abandoned pages at 45 seconds, cannot revive an expired or deleted visit and checks current authority", async () => {
    let clock = 0, allowed = true;
    const registry = createDocumentVisitorRegistry({ now: () => clock }); cleanup.push(registry.close);
    const input = { binding: "browser", sourceKey: "link", identityKey: "account:session",
      authorize: async () => {
        if (!allowed) throw Object.assign(new Error("revoked"), { statusCode: 404 });
        return { kind: "account", id: "reader", name: "Reader" };
      } };
    const first = await registry.register("doc", input), second = await registry.register("doc", input);
    clock = 15000; await registry.renew("doc", first.visitId, input);
    clock = 45000;
    expect(await registry.list("doc")).toHaveLength(1);
    await expect(registry.renew("doc", second.visitId, input)).rejects.toMatchObject({ statusCode: 404 });
    allowed = false; expect(await registry.list("doc")).toEqual([]);
    allowed = true;
    await expect(registry.renew("doc", first.visitId, input)).rejects.toMatchObject({ statusCode: 404 });
    const third = await registry.register("doc", input);
    registry.remove("doc", third.visitId, input);
    await expect(registry.renew("doc", third.visitId, input)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("cannot extend the lifetime of a visit removed while its authorization was awaiting and enforces document capacity", async () => {
    let complete;
    const registry = createDocumentVisitorRegistry({ maxDocumentVisits: 1 }); cleanup.push(registry.close);
    const input = { binding: "browser", sourceKey: "space", identityKey: "reader", authorize: async () => ({ kind: "account", id: "reader" }) };
    const visit = await registry.register("doc", input);
    await expect(registry.register("doc", input)).rejects.toMatchObject({ statusCode: 429 });
    let slow = false;
    const other = createDocumentVisitorRegistry(); cleanup.push(other.close);
    const delayed = { ...input, authorize: () => slow ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ kind: "account", id: "reader" }) };
    const pendingVisit = await other.register("doc", delayed); slow = true;
    const renew = other.renew("doc", pendingVisit.visitId, delayed);
    other.remove("doc", pendingVisit.visitId, delayed); complete({ kind: "account", id: "reader" });
    await expect(renew).rejects.toMatchObject({ statusCode: 404 });
    await expect(registry.renew("other", visit.visitId, input)).rejects.toMatchObject({ statusCode: 404 });
    await expect(registry.renew("doc", visit.visitId, { ...input, binding: "wrong" })).rejects.toMatchObject({ statusCode: 404 });
  });
});
