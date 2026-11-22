import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountOidcFixture } from "./helpers/account-oidc-fixture.mjs";
import { startAccountRuntimeFixture, browserAccountLogin } from "./helpers/account-runtime-fixture.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "zioon-account-sharing-"));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const idp = await createAccountOidcFixture(); cleanup.push(idp.close);
  const runtime = await startAccountRuntimeFixture({ directory, spaceId: "space:sharing-fixture", idp });
  cleanup.push(runtime.close);
  const api = async (login, path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(runtime.url + path, { method, headers: { cookie: login.cookie,
      origin: runtime.url, "content-type": "application/json", "x-zion-workbench-protocol": "5",
      ...(login.spaceId ? { "x-zioon-space-id": login.spaceId } : {}),
      ...(login.contentScope ? { "x-zioon-content-space": login.contentScope.originSpaceId,
        "x-zioon-content-document": login.contentScope.documentId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  const login = async subject => {
    idp.setSubject(subject);
    const signed = await browserAccountLogin(runtime.url);
    const identity = await api(signed, "/v1/account/me");
    signed.user = identity.value.user;
    signed.spaceId = (await runtime.accounts.personalSpace(signed.user.id)).id;
    return signed;
  };
  const owner = await login("test-owner"), receiver = await login("sharing-receiver"), other = await login("sharing-other");
  const run = async (account, runId) => {
    for (let i = 0; i < 200; i++) {
      const result = await api(account, `/v1/runs/${runId}`);
      if (!["created", "queued", "running"].includes(result.value.run?.status)) return result;
      await delay(25);
    }
    throw new Error("Run did not complete");
  };
  return { runtime, api, login, owner, receiver, other, run };
}

describe("account sharing through real OIDC and independent Runtime instances", () => {
  it("shares by verified email through HTTP and applies owner permission changes to existing recipients", async () => {
    const h = await setup(), id = "direct-account-sharing";
    await h.api(h.owner, `/v1/workbench-state/sessions/${id}`, { text: "user 直接协作", meta: { title: "直接协作" } }, "PUT");
    const resolved = await h.api(h.owner, "/v1/sharing/recipients/resolve", { recipient: h.receiver.user.email.toUpperCase() });
    expect(resolved.status).toBe(200);
    expect(resolved.value.recipient).toEqual({ id: h.receiver.user.id, name: "sharing-receiver" });
    expect(JSON.stringify(resolved.value)).not.toMatch(/token|email/);
    const created = await h.api(h.owner, "/v1/sharing", { kind: "document", sourceId: id, recipient: resolved.value.recipient.id, role: "editor" });
    expect(created.status, JSON.stringify(created.value)).toBe(201);
    expect(created.value.invitation).toBeUndefined();
    const shareId = created.value.share.id;
    const scoped = { ...h.receiver, contentScope: { originSpaceId: h.owner.spaceId, documentId: id } };
    expect((await h.api(h.receiver, "/v1/sharing/content")).value.received[0]).toMatchObject({ id, role: "editor" });
    expect(JSON.stringify((await h.api(h.receiver, "/v1/workbench-state/catalog")).value)).not.toContain(id);
    expect((await h.api(scoped, `/v1/workbench-state/sessions/${id}`, { text: "user 允许编辑" }, "PUT")).status).toBe(200);
    expect((await h.api(h.owner, `/v1/sharing/${encodeURIComponent(shareId)}/recipients`, { recipient: h.other.user.id, role: "editor" })).status).toBe(201);
    const path = `/v1/sharing/documents/${id}/collaborators/${encodeURIComponent(h.receiver.user.id)}`;
    expect((await h.api(h.other, path, { role: "editor" }, "PUT")).status).toBe(404);
    expect((await h.api(h.owner, path, { role: "viewer" }, "PUT")).status).toBe(200);
    expect((await h.api(scoped, `/v1/workbench-state/sessions/${id}`)).status).toBe(200);
    expect((await h.api(scoped, `/v1/workbench-state/sessions/${id}`, { text: "forbidden" }, "PUT")).status).toBe(404);
    expect((await h.api(scoped, "/v1/runs", { sessionId: id, prompt: "forbidden" })).status).toBe(404);
    expect((await h.api(h.other, "/v1/sharing?direction=received")).value.shares.find(share => share.id === shareId).role).toBe("editor");
    expect((await h.api(h.owner, path, { role: "removed" }, "PUT")).status).toBe(200);
    expect((await h.api(scoped, `/v1/workbench-state/sessions/${id}`)).status).toBe(404);
    expect((await h.api(h.receiver, "/v1/sharing/content")).value.received).toEqual([]);
  }, 45000);
  it("uploads a shared editor image into the original document without granting access to other assets", async () => {
    const h = await setup();
    const id = "image-doc";
    await h.api(h.owner, `/v1/workbench-state/sessions/${id}`, { text: "user shared", meta: { privateIdentity: "private", title: "共享图片" } }, "PUT");
    const created = await h.api(h.owner, "/v1/sharing", { kind: "document", sourceId: id, role: "editor" });
    await h.api(h.receiver, "/v1/sharing/accept", { token: created.value.invitation.token });
    const scoped = { ...h.receiver, contentScope: { originSpaceId: h.owner.spaceId, documentId: id } };
    const read = await h.api(scoped, `/v1/workbench-state/sessions/${id}`);
    expect(read.value.meta.privateIdentity).toBeUndefined();
    expect(read.value.sharedContent).toBe(true);
    const headers = { cookie: h.receiver.cookie, origin: h.runtime.url, "x-zioon-space-id": h.receiver.spaceId,
      "x-zioon-content-space": h.owner.spaceId, "x-zioon-content-document": id, "content-type": "image/png" };
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=", "base64");
    const upload = await fetch(`${h.runtime.url}/v1/assets`, { method: "POST", headers, body: bytes });
    const uploaded = await upload.json();
    expect(upload.status, JSON.stringify(uploaded)).toBe(201);
    const assetId = uploaded.asset.id;
    const result = await h.api(scoped, `/v1/workbench-state/sessions/${id}`, { text: `user ![image](zion-asset://${assetId})` }, "PUT");
    expect(result.status, JSON.stringify(result.value)).toBe(200);
    const image = await fetch(`${h.runtime.url}/v1/assets/${assetId}/content`, { headers });
    expect(image.status).toBe(200); expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes);
    expect((await h.api(h.receiver, `/v1/assets/${assetId}`)).status).toBe(404);
    expect((await h.api(h.other, `/v1/assets/${assetId}`)).status).toBe(404);
    await h.api(h.owner, `/v1/sharing/${created.value.share.id}/revoke`, {});
    expect((await fetch(`${h.runtime.url}/v1/assets/${assetId}/content`, { headers })).status).toBe(404);
  }, 45000);
  it("edits the original shared document with own models and rejects unrelated owner endpoints", async () => {
    const h = await setup();
    const source = await h.api(h.owner, "/v1/sessions", { title: "共同文档",
      metadata: { privateIdentity: "OWNER_PRIVATE_CONFIGURATION" } });
    const id = source.value.session.id;
    expect(source.status).toBe(201);
    const privateRun = await h.api(h.owner, "/v1/runs", { sessionId: id, messages: [
      { role: "system", content: "OWNER_PRIVATE_HIDDEN_CONTEXT" }, { role: "user", content: "共同内容" }
    ], conversationInput: { schemaVersion: 1, mode: "snapshot", clientRequestId: "owner-private-history" } });
    expect(privateRun.status).toBe(202);
    expect((await h.run(h.owner, privateRun.value.runId)).value.run.status).toBe("completed");
    expect((await h.api(h.owner, `/v1/workbench-state/sessions/${encodeURIComponent(id)}`,
      { text: "user 共同内容", reason: "update" }, "PUT")).status).toBe(200);
    const created = await h.api(h.owner, "/v1/sharing", { kind: "document", sourceId: id, role: "editor", name: "共同文档" });
    expect(created.status, JSON.stringify(created.value)).toBe(201);
    expect((await h.api(h.receiver, "/v1/sharing/accept", { token: created.value.invitation.token })).status).toBe(200);
    const scoped = { ...h.receiver, contentScope: { originSpaceId: h.owner.spaceId, documentId: id } };
    const sessionMetadata = await h.api(scoped, `/v1/sessions/${encodeURIComponent(id)}`);
    expect(sessionMetadata.status).toBe(200);
    expect(sessionMetadata.value.session.metadata).toBeUndefined();
    expect((await h.api(scoped, `/v1/runs/${privateRun.value.runId}`)).status).toBe(404);
    const previousTranscript = await h.api(scoped, `/v1/sessions/${encodeURIComponent(id)}/transcript`);
    expect(previousTranscript.status).toBe(200);
    expect(JSON.stringify(previousTranscript.value)).not.toContain("OWNER_PRIVATE_HIDDEN_CONTEXT");
    expect((await h.api(scoped, `/v1/workbench-state/sessions/${encodeURIComponent(id)}`)).value.text).toContain("共同内容");
    const saved = await h.api(scoped, `/v1/workbench-state/sessions/${encodeURIComponent(id)}`,
      { text: "user 接收者修改", operation_id: "receiver-edit" }, "PUT");
    expect(saved.status, JSON.stringify(saved.value)).toBe(200);
    expect(saved.value.ok).toBe(true);
    expect((await h.api(h.owner, `/v1/workbench-state/sessions/${encodeURIComponent(id)}`)).value.text).toContain("接收者修改");
    for (const path of ["/v1/models", "/v1/skills/snapshot", "/v1/workbench-state/catalog",
      "/v1/workbench-state/tree", "/v1/workbench-state/kv/secret", "/v1/sessions", "/v1/sandbox/workspace"]) {
      expect((await h.api(scoped, path)).status, path).toBe(403);
    }
    expect((await h.api(scoped, "/v1/runs", { sessionId: "different-document", prompt: "wrong target" })).status).toBe(403);
    const models = await h.api(h.receiver, "/v1/models");
    const selected = models.value.profiles.find(m => !m.id.startsWith("share."));
    const started = await h.api(scoped, "/v1/runs", { sessionId: id, prompt: "共享文档里用自己的模型",
      model: { profileId: selected.id }, policy: { preset: "workspace-write", allowedTools: ["webSearch", "read", "modelsManage"] },
      metadata: { source: "test", identity: "must-drop", spaceCapabilities: ["forged"] } });
    expect(started.status, JSON.stringify(started.value)).toBe(202);
    const completed = await h.run(scoped, started.value.runId);
    expect(completed.value.run.status, JSON.stringify(completed.value) + h.runtime.logs()).toBe("completed");
    expect(completed.value.run.principal.userId).toBe(h.receiver.user.id);
    expect(completed.value.run.principal.spaceId).toBe(h.receiver.spaceId);
    expect(completed.value.run.principal.contentScope.documentId).toBe(id);
    expect(completed.value.run.policy.allowedTools).not.toContain("read");
    expect(completed.value.run.policy.allowedTools).not.toContain("modelsManage");
    expect(completed.value.run.metadata.identity).toBeUndefined();
    const modelSource = (await h.api(h.owner, "/v1/sharing/sources")).value.sources.find(s => s.kind === "model");
    const modelShare = await h.api(h.owner, "/v1/sharing", { kind: "model", sourceId: modelSource.id });
    await h.api(h.receiver, "/v1/sharing/accept", { token: modelShare.value.invitation.token });
    const borrowed = await h.api(scoped, "/v1/runs", { sessionId: id, prompt: "这次用收到的模型",
      model: { profileId: `share.${modelShare.value.share.id}` } });
    expect(borrowed.status, JSON.stringify(borrowed.value)).toBe(202);
    expect((await h.run(scoped, borrowed.value.runId)).value.run.status).toBe("completed");
    expect((await h.api(h.other, `/v1/runs/${started.value.runId}`)).status).toBe(404);
    expect((await h.api(h.owner, `/v1/sharing/${encodeURIComponent(created.value.share.id)}`, undefined, "DELETE")).status).toBe(200);
    expect((await h.api(scoped, `/v1/workbench-state/sessions/${encodeURIComponent(id)}`)).status).toBe(404);
    expect((await h.api(h.owner, `/v1/workbench-state/sessions/${encodeURIComponent(id)}`)).status).toBe(200);
  }, 45000);
  it("generates in an existing shared Workbench document without creating content in the receiver's account", async () => {
    const h = await setup();
    const created = await h.api(h.owner, "/v1/workbench-state/sessions/imported-doc",
      { text: "user 原始文档", title: "导入会话" }, "PUT");
    expect(created.status, JSON.stringify(created.value)).toBe(200);
    const share = await h.api(h.owner, "/v1/sharing", { kind: "document", sourceId: "imported-doc", role: "editor" });
    expect(share.status).toBe(201);
    await h.api(h.receiver, "/v1/sharing/accept", { token: share.value.invitation.token });
    const scoped = { ...h.receiver, contentScope: { originSpaceId: h.owner.spaceId, documentId: "imported-doc" } };
    const started = await h.api(scoped, "/v1/runs", { sessionId: "imported-doc", prompt: "继续这个导入的会话" });
    expect(started.status, JSON.stringify(started.value)).toBe(202);
    expect((await h.run(scoped, started.value.runId)).value.run.status).toBe("completed");
    expect((await h.api(h.receiver, "/v1/sessions/imported-doc")).status).toBe(404);
    expect((await h.api(h.owner, "/v1/sessions/imported-doc")).status).toBe(200);
  }, 45000);
  it("keeps viewer grants read-only for HTTP edits and generation", async () => {
    const h = await setup();
    const source = await h.api(h.owner, "/v1/sessions", { title: "只读文档" });
    const id = source.value.session.id;
    const share = await h.api(h.owner, "/v1/sharing", { kind: "document", sourceId: id, role: "viewer" });
    await h.api(h.receiver, "/v1/sharing/accept", { token: share.value.invitation.token });
    const scoped = { ...h.receiver, contentScope: { originSpaceId: h.owner.spaceId, documentId: id } };
    expect((await h.api(scoped, `/v1/sessions/${id}`)).status).toBe(200);
    expect((await h.api(scoped, `/v1/workbench-state/sessions/${id}`, { text: "forbidden" }, "PUT")).status).toBe(404);
    expect((await h.api(scoped, `/v1/sessions/${id}/messages`, { content: "forbidden" })).status).toBe(404);
    expect((await h.api(scoped, "/v1/runs", { sessionId: id, prompt: "forbidden" })).status).toBe(404);
    expect((await h.api({ ...h.other, contentScope: scoped.contentScope }, `/v1/sessions/${id}`)).status).toBe(404);
  }, 45000);
  it("uses received and own models in private sessions, persists selections and denies provider access", async () => {
    const h = await setup();
    const sources = await h.api(h.owner, "/v1/sharing/sources");
    expect(sources.status).toBe(200);
    const source = sources.value.sources.find(s => s.kind === "model");
    expect(source).toBeTruthy();
    const created = await h.api(h.owner, "/v1/sharing", { kind: "model", sourceId: source.id, name: "来自对象的模型", monthlyCalls: 20 });
    expect(created.status).toBe(201);
    const { share, invitation } = created.value;
    expect(invitation.url).toContain("/#share=");
    expect((await h.api(h.receiver, "/v1/sharing/accept", { token: invitation.token })).status).toBe(200);
    expect(await h.runtime.accounts.membership(h.receiver.user.id, h.owner.spaceId)).toBeFalsy();
    const models = await h.api(h.receiver, "/v1/models");
    expect(models.status).toBe(200);
    expect(models.value.profiles.some(m => !m.id.startsWith("share."))).toBe(true);
    const borrowed = models.value.profiles.find(m => m.id === `share.${share.id}`);
    expect(borrowed?.metadata.providerName).toBe("test-owner");
    expect((await h.api(h.receiver, "/v1/models/selection", { profileId: borrowed.id }, "PUT")).status).toBe(200);
    const fresh = await h.login("sharing-receiver");
    expect((await h.api(fresh, "/v1/models")).value.selectedProfileId).toBe(borrowed.id);
    const session = await h.api(fresh, "/v1/sessions", { title: "我的私密会话" });
    expect(session.status).toBe(201);
    const id = session.value.session.id;
    const started = await h.api(fresh, `/v1/sessions/${encodeURIComponent(id)}/messages`, { content: "PRIVATE_RECEIVER_CONTENT" });
    expect(started.status).toBe(202);
    const completed = await h.run(fresh, started.value.runId);
    expect(completed.value.run.status, JSON.stringify(completed.value)).toBe("completed");
    expect(completed.value.run.model.profileId).toBe(borrowed.id);
    expect((await h.api(h.owner, `/v1/sessions/${encodeURIComponent(id)}`)).status).toBe(404);
    expect((await h.api({ ...h.owner, spaceId: fresh.spaceId }, `/v1/sessions/${encodeURIComponent(id)}`)).status).toBe(403);
    const sent = await h.api(h.owner, "/v1/sharing?direction=sent");
    expect(JSON.stringify(sent.value)).not.toMatch(/PRIVATE_RECEIVER_CONTENT|我的私密会话/);
    expect(sent.value.shares.find(s => s.id === share.id).usage.calls).toBeGreaterThan(0);
    expect((await h.api(h.other, "/v1/models")).value.profiles.some(m => m.id === borrowed.id)).toBe(false);
    expect((await h.api(h.owner, `/v1/sharing/${encodeURIComponent(share.id)}`, undefined, "DELETE")).status).toBe(200);
    expect((await h.api(fresh, "/v1/models")).value.profiles.some(m => m.id === borrowed.id)).toBe(false);
    expect((await h.api(fresh, `/v1/sessions/${encodeURIComponent(id)}/messages`, { content: "after revoke" })).status).toBe(409);
    const ownModel = models.value.profiles.find(m => !m.id.startsWith("share."));
    const own = await h.api(fresh, "/v1/runs", { sessionId: id, prompt: "use my own model", model: { profileId: ownModel.id } });
    expect(own.status).toBe(202);
    expect((await h.run(fresh, own.value.runId)).value.run.status).toBe("completed");
  }, 45000);
  it("requires login and a valid cookie origin for sharing writes", async () => {
    const h = await setup();
    const anonymous = await fetch(h.runtime.url + "/v1/sharing");
    expect(anonymous.status).toBe(401);
    const forged = await fetch(h.runtime.url + "/v1/sharing", { method: "POST", headers: {
      cookie: h.owner.cookie, origin: "https://untrusted.test", "content-type": "application/json"
    }, body: JSON.stringify({ kind: "model", sourceId: "echo" }) });
    expect(forged.status).toBe(403);
  }, 45000);
});
