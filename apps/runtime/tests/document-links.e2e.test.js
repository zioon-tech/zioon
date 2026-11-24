import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountOidcFixture } from "./helpers/account-oidc-fixture.mjs";
import { startAccountRuntimeFixture, browserAccountLogin } from "./helpers/account-runtime-fixture.mjs";
import { createDocumentLinkHttpHandler } from "../src/sharing/document-link-http-handler.mjs";
import { createDocumentPresenceHttpHandler } from "../src/sharing/document-presence-http-handler.mjs";
import { COLLABORATION_PROTOCOL } from "../src/collaboration-service.mjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zioon-link-http-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const idp = await createAccountOidcFixture(); cleanup.push(idp.close);
  const runtime = await startAccountRuntimeFixture({ directory, spaceId: "space:link-fixture", idp }); cleanup.push(runtime.close);
  const api = async (user, path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(runtime.url + path, { method, headers: { cookie: user.cookie, origin: runtime.url,
      "content-type": "application/json", "x-zion-workbench-protocol": "6",
      ...(user.spaceId ? { "x-zioon-space-id": user.spaceId } : {}),
      ...(user.scope ? { "x-zioon-content-space": user.scope.origin, "x-zioon-content-document": user.scope.doc } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  const login = async subject => {
    idp.setSubject(subject); const user = await browserAccountLogin(runtime.url);
    user.identity = (await api(user, "/v1/account/me")).value;
    user.spaceId = (await runtime.accounts.personalSpace(user.identity.user.id)).id;
    return user;
  };
  return { runtime, api, owner: await login("test-owner"), reader: await login("link-reader"), stranger: await login("link-stranger") };
}
describe("document links through the native gateway, OIDC and image storage", () => {
  it("restricts a team guest's reading presence to the granted document and removes it on ACL revocation", async () => {
    const h = await fixture(), spaceId = "space:link-fixture", doc = "team-guest-presence";
    const owner = { ...h.owner, spaceId }, guest = { ...h.reader, spaceId };
    expect((await h.api(owner, `/v1/workbench-state/sessions/${doc}`, { text: "user 团队讨论", meta: { title: "团队讨论" } }, "PUT")).status).toBe(200);
    const base = `/v1/spaces/${encodeURIComponent(spaceId)}`, path = `${base}/documents/${doc}`;
    expect((await h.api(owner, base, { expectedRevision: 2, allowExternal: true }, "PATCH")).status).toBe(200);
    const grants = [{ subjectType: "user", subjectId: h.owner.identity.user.id, role: "manager" },
      { subjectType: "user", subjectId: h.reader.identity.user.id, role: "viewer" }];
    expect((await h.api(owner, path + "/access", { expectedRevision: 1,
      protection: "external", audienceMode: "specific", grants }, "PUT")).status).toBe(200);
    expect((await h.api(guest, path)).value.reader).toMatchObject({ state: "read", role: "viewer" });
    const presence = await h.api(guest, path + "/presence", {});
    expect(presence.status).toBe(201);
    expect(presence.value.visitors).toMatchObject([{ name: h.reader.identity.user.name, online: true, role: "viewer" }]);
    expect((await h.api(guest, base)).status).toBe(403);
    expect((await h.api(guest, `${base}/documents/unknown/presence`, {})).status).toBe(404);
    expect((await h.api(guest, "/v1/workbench-state/snapshot")).status).toBe(403);
    expect((await h.api(owner, path + "/access", { expectedRevision: 2,
      protection: "external", audienceMode: "specific", grants: grants.slice(0, 1) }, "PUT")).status).toBe(200);
    expect((await h.api(guest, path + "/presence")).status).toBe(404);
    expect((await h.api(owner, path + "/presence")).value.visitors).toEqual([]);
  }, 45000);
  it("does not return visitor identities when the requester session expires during the final document permission read", async () => {
    for (const link of [false, true]) {
      let active = true, reads = 0, released = false;
      const accounts = { activeSession: async () => active };
      const read = async () => {
        if (++reads === 2) active = false;
        return { state: "read", mode: "restricted", role: "viewer", revision: 1,
          originSpaceId: "team", documentId: "doc", access: { role: "viewer" } };
      };
      const handler = createDocumentPresenceHttpHandler({
        sharing: { accounts, links: { view: read } }, spaces: { accounts, requireDocument: read },
        accessControl: { requireLogin: async () => ({ user: { id: "reader", name: "Reader" }, sessionId: "session" }) },
        acquireRuntime: async () => ({ app: { listDocumentVisitors: async () => ({
          visitors: [{ id: "peer", name: "Private peer name", online: true }] }) }, release: () => { released = true; } })
      });
      const path = link ? `/share/${"a".repeat(43)}/presence` : "/v1/spaces/team/documents/doc/presence";
      const response = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
      await handler({ method: "GET", headers: {} }, response, new URL(path, "https://zioon.test"));
      expect(response.status).toBe(401);
      expect(String(response.body)).not.toContain("Private peer name");
      expect(released).toBe(true);
    }
  });
  it("counts active reading pages through trusted runtime leases, keeps public identities minimal and removes access after link changes", async () => {
    const h = await fixture(), doc = "visitor-http";
    await h.api(h.owner, `/v1/workbench-state/sessions/${doc}`, { text: "user 一起讨论\nassistant 回答", meta: { title: "访客测试" } }, "PUT");
    const created = await h.api(h.owner, `/v1/sharing/documents/${doc}/link`, { mode: "public" }, "PUT");
    const path = `/share/${created.value.link.id}/presence`;
    const call = async (cookie = "", method = "GET", suffix = "", body = {}, origin = h.runtime.url) => {
      const response = await fetch(h.runtime.url + path + suffix, { method,
        headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json(),
        cookie: response.headers.getSetCookie().find(value => value.startsWith("zioon_reader_presence="))?.split(";")[0] };
    };
    expect((await call()).value.visitors).toEqual([]);
    expect((await call("", "POST", "", {}, "")).status).toBe(403);
    expect((await call("", "POST", "", { name: "伪造身份" })).status).toBe(400);
    const first = await call("", "POST");
    expect(first.status).toBe(201); expect(first.cookie).toBeTruthy();
    expect(first.value).toMatchObject({ ttlMs: 45000, visitors: [{ name: "匿名访客", online: true }] });
    expect(first.value.visitors[0].id).toBe(first.value.selfVisitorId);
    const second = await call("", "POST");
    expect(second.value.visitors).toHaveLength(2);
    expect((await call(second.cookie, "PUT", "/" + first.value.visitId)).status).toBe(404);
    expect((await call(first.cookie, "PUT", "/" + first.value.visitId)).status).toBe(200);
    const ydoc = new Y.Doc(); let provider;
    class OwnerSocket extends WebSocket {
      constructor(url, protocols) { super(url, protocols, { headers: { cookie: h.owner.cookie, origin: h.runtime.url } }); }
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Owner socket timed out")), 4000);
      provider = new HocuspocusProvider({ url: `${h.runtime.url.replace(/^http/, "ws")}/v1/collaboration?${new URLSearchParams({
        protocol: COLLABORATION_PROTOCOL, space: h.owner.spaceId })}`, name: doc, document: ydoc, token: "", WebSocketPolyfill: OwnerSocket,
        onSynced() { clearTimeout(timer); resolve(); }, onAuthenticationFailed({ reason }) { clearTimeout(timer); reject(new Error(reason)); } });
    });
    cleanup.push(() => { provider.destroy(); ydoc.destroy(); });
    provider.awareness.setLocalStateField("user", { id: "fake", name: "伪造访客" });
    const ownerVisit = await call(h.owner.cookie, "POST");
    expect(ownerVisit.value.visitors).toHaveLength(3);
    expect(ownerVisit.value.visitors.find(person => person.kind === "account").name).toBe("已登录访客");
    expect(JSON.stringify(ownerVisit.value)).not.toMatch(/accountId|ownerId|originSpace|grants|email|session|token/);
    const native = await h.api(h.owner, `/v1/sharing/documents/${doc}/participants`);
    expect(native.value.visitors).toHaveLength(3);
    expect(native.value.visitors.filter(person => person.visitor)).toHaveLength(2);
    expect((await call(first.cookie, "DELETE", "/" + first.value.visitId)).status).toBe(200);
    expect((await call()).value.visitors).toHaveLength(2);
    await h.api(h.owner, `/v1/sharing/documents/${doc}/link`, { mode: "restricted" }, "PUT");
    expect((await call(second.cookie, "PUT", "/" + second.value.visitId)).status).toBe(404);
    expect((await h.api(h.owner, `/v1/sharing/documents/${doc}/participants`)).value.visitors.map(person => person.id)).toEqual([h.owner.identity.user.id]);
    const granted = await h.api(h.owner, "/v1/sharing", { kind: "document", sourceId: doc, recipient: h.reader.identity.user.id, role: "viewer" });
    expect(granted.status).toBe(201);
    const sharedPath = `/v1/spaces/${encodeURIComponent(h.owner.spaceId)}/documents/${doc}`;
    const guest = { ...h.reader, spaceId: h.owner.spaceId };
    expect((await h.api(guest, sharedPath)).value.reader).toMatchObject({ state: "read", role: "viewer" });
    expect((await h.api(guest, sharedPath + "/presence", {})).status).toBe(201);
    await h.api(h.owner, `/v1/sharing/${encodeURIComponent(granted.value.share.id)}`, undefined, "DELETE");
    expect((await h.api(guest, sharedPath)).status).toBe(404);
    expect((await h.api(h.owner, `/v1/sharing/documents/${doc}/participants`)).value.visitors.map(person => person.id)).toEqual([h.owner.identity.user.id]);
  }, 45000);
  it("returns to the restricted URL after login, applies approved permissions and closes access on revoke", async () => {
    const h = await fixture(), doc = "restricted-http";
    expect((await h.api(h.owner, `/v1/workbench-state/sessions/${doc}`, { text: "PRIVATE_BODY", meta: { title: "私人标题", secret: "PRIVATE_METADATA" } }, "PUT")).status).toBe(200);
    const created = await h.api(h.owner, `/v1/sharing/documents/${doc}/link`, { mode: "restricted" }, "PUT");
    expect(created.status).toBe(200);
    const path = `/share/${created.value.link.id}`, url = h.runtime.url + path;
    const anonymous = await fetch(url); const page = await anonymous.text();
    expect(anonymous.status).toBe(200); expect(page).toContain("登录并继续"); expect(page).not.toMatch(/PRIVATE_BODY|PRIVATE_METADATA|私人标题/);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    const returned = await browserAccountLogin(h.runtime.url, path);
    expect(new URL(returned.returnTo, h.runtime.url).pathname).toBe(path);
    const form = await fetch(url, { headers: { cookie: h.reader.cookie } });
    expect(await form.text()).toContain("发送访问申请");
    const post = async origin => fetch(url + "/request", { method: "POST", redirect: "manual",
      headers: { cookie: h.reader.cookie, ...(origin ? { origin } : {}), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ role: "editor", message: "共同整理" }) });
    expect((await post("https://foreign.test")).status).toBe(403);
    expect((await post()).status).toBe(403);
    expect((await post(h.runtime.url)).status).toBe(303);
    expect((await post(h.runtime.url)).status).toBe(303);
    const requests = await h.api(h.owner, `/v1/sharing/documents/${doc}/requests`);
    expect(requests.value.requests).toHaveLength(1);
    const id = requests.value.requests[0].id, decision = `/v1/sharing/documents/${doc}/requests/${encodeURIComponent(id)}`;
    expect((await h.api(h.stranger, decision, { status: "approved", role: "editor" }, "PUT")).status).toBe(404);
    expect((await h.api(h.owner, decision, { status: "approved", role: "viewer" }, "PUT")).status).toBe(200);
    const approved = await fetch(url, { headers: { cookie: h.reader.cookie } });
    expect(await approved.text()).toContain("PRIVATE_BODY");
    const content = await h.api(h.reader, "/v1/sharing/content");
    expect(content.value.received[0]).toMatchObject({ id: doc, role: "viewer" });
    const scope = { ...h.reader, scope: { origin: h.owner.spaceId, doc } };
    expect((await h.api(scope, `/v1/workbench-state/sessions/${doc}`, { text: "FORBIDDEN" }, "PUT")).status).toBe(404);
    const collaborator = `/v1/sharing/documents/${doc}/collaborators/${encodeURIComponent(h.reader.identity.user.id)}`;
    expect((await h.api(h.owner, collaborator, { role: "editor" }, "PUT")).status).toBe(200);
    expect((await h.api(scope, `/v1/workbench-state/sessions/${doc}`, { text: "EDITED" }, "PUT")).status).toBe(200);
    expect(await (await fetch(url, { headers: { cookie: h.reader.cookie } })).text()).toContain("EDITED");
    expect((await h.api(h.reader, `/v1/sharing/links/${created.value.link.id}`)).value).toMatchObject({ documentId: doc, role: "editor" });
    await h.api(h.owner, collaborator, { role: "removed" }, "PUT");
    expect(await (await fetch(url, { headers: { cookie: h.reader.cookie } })).text()).not.toContain("EDITED");
  }, 45000);
  it("reads anonymous current content and only its bound images, escaping active HTML and blocking private access", async () => {
    const h = await fixture(), doc = "public-http";
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=", "base64");
    const upload = async () => {
      const response = await fetch(h.runtime.url + "/v1/assets", { method: "POST",
        headers: { cookie: h.owner.cookie, origin: h.runtime.url, "x-zioon-space-id": h.owner.spaceId, "content-type": "image/png" }, body: png });
      expect(response.status).toBe(201); return (await response.json()).asset.id;
    };
    const image = await upload(), other = await upload();
    await h.api(h.owner, `/v1/workbench-state/sessions/${doc}`, {
      text: `# PUBLIC_BODY\n![公开图片](zion-asset://${image})\n<script>alert(1)</script>\n[x](javascript:alert(1))\n![远程图片](https://foreign.test/a.png)`,
      meta: { title: "<img onerror=alert(1)>", secret: "PRIVATE_METADATA" } }, "PUT");
    const created = await h.api(h.owner, `/v1/sharing/documents/${doc}/link`, { mode: "public" }, "PUT");
    expect(created.status).toBe(200);
    const url = h.runtime.url + `/share/${created.value.link.id}`;
    const html = await (await fetch(url)).text();
    expect(html).toContain("PUBLIC_BODY"); expect(html).toContain(`/assets/${image}`);
    expect(html).not.toMatch(/<script>|onerror=alert\(1\)>|href="javascript:|src="https:\/\/foreign|PRIVATE_METADATA/);
    const asset = await fetch(url + `/assets/${image}`);
    expect(asset.status).toBe(200); expect(Buffer.from(await asset.arrayBuffer())).toEqual(png);
    expect((await fetch(url + `/assets/${other}`)).status).toBe(404);
    expect((await h.api(h.reader, `/v1/sharing/links/${created.value.link.id}`)).status).toBe(403);
    await h.api(h.owner, `/v1/sharing/documents/${doc}/link`, { mode: "restricted" }, "PUT");
    expect((await fetch(url + `/assets/${image}`)).status).toBe(404);
    await h.api(h.owner, `/v1/sharing/documents/${doc}/link`, { mode: "public" }, "PUT");
    await h.api(h.owner, `/v1/sharing/documents/${doc}/privacy`, { private: true }, "PUT");
    expect((await fetch(url)).status).toBe(404); expect((await fetch(url + `/assets/${image}`)).status).toBe(404);
    expect((await h.api(h.owner, `/v1/sharing/documents/${doc}/link`, { mode: "public" }, "PUT")).status).toBe(409);
    await h.api(h.owner, `/v1/sharing/documents/${doc}/privacy`, { private: false }, "PUT");
    await h.api(h.owner, `/v1/workbench-state/sessions/${doc}`, undefined, "DELETE");
    expect((await fetch(url)).status).toBe(404);
  }, 45000);
  it("rechecks link and image references after an asynchronous image read", async () => {
    let revoked = false;
    const handler = createDocumentLinkHttpHandler({
      sharing: { links: { view: async () => revoked ? { state: "login" } : {
        state: "read", markdown: "![image](zion-asset://image123)", ownerId: "owner", originSpaceId: "origin", documentId: "doc" } } },
      accessControl: { requireLogin: async () => { throw Object.assign(new Error("login"), { statusCode: 401 }); } },
      readDocumentAsset: async () => { revoked = true; return { mediaType: "image/png", content: Buffer.from("old bytes") }; }
    });
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await handler({ method: "GET", headers: {} }, response, new URL(`https://zioon.test/share/${"a".repeat(43)}/assets/image123`));
    expect(response.status).toBe(404); expect(String(response.body)).not.toContain("old bytes");
  });
});
