import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountOidcFixture } from "./helpers/account-oidc-fixture.mjs";
import { startAccountRuntimeFixture, browserAccountLogin } from "./helpers/account-runtime-fixture.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zioon-account-sharing-"));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const idp = await createAccountOidcFixture(); cleanup.push(idp.close);
  const runtime = await startAccountRuntimeFixture({ directory, spaceId: "space:sharing-fixture", idp, ...options });
  cleanup.push(runtime.close);
  const api = async (login, path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(runtime.url + path, { method, headers: { cookie: login.cookie,
      origin: runtime.url, "content-type": "application/json", "x-zion-workbench-protocol": "6",
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
  it("does not block a received document after a missing-credential failure and preserves genuinely unknown dispatches", async () => {
    const calls = [];
    const provider = createServer(async (req, res) => {
      let body = ""; for await (const part of req) body += part;
      calls.push(JSON.parse(body).model);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"borrowed-after-failure"}}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise(resolve => provider.close(resolve)));
    const h = await setup({ engine: "openai", legacyWorkspace: true,
      environment: { ZION_RUNTIME_MODEL_PROFILE: "missing-key", ZION_RUNTIME_DEFAULT_INTERACTION_MODEL_PROFILE: "missing-key" },
      prepare: async ({ dataDirectory }) => {
        await mkdir(dataDirectory, { recursive: true });
        await writeFile(join(dataDirectory, "model-profiles.json"), JSON.stringify({ profiles:
          ["missing-key", "working-key"].map(id => ({ id, label: id, providerId: "fixture", providerType: "openai",
            model: id, endpoint: `http://127.0.0.1:${provider.address().port}/chat`, credentialRef: `model.${id}`,
            credentialRequired: true })) }));
        await writeFile(join(dataDirectory, "credentials.json"), JSON.stringify({ "model.working-key": { value: "fixture-only" } }));
      } });
    const id = "failure-then-borrowed";
    expect((await h.api(h.owner, `/v1/workbench-state/sessions/${id}`, { text: "user original" }, "PUT")).status).toBe(200);
    const docShare = await h.api(h.owner, "/v1/sharing", { kind: "document", sourceId: id, recipient: h.receiver.user.id, role: "editor" });
    expect(docShare.status).toBe(201);
    const scoped = { ...h.receiver, contentScope: { originSpaceId: h.owner.spaceId, documentId: id } };
    const failed = await h.api(h.owner, "/v1/runs", { sessionId: id, prompt: "missing credential", model: { profileId: "missing-key" } });
    expect(failed.status, JSON.stringify(failed.value)).toBe(202);
    expect((await h.run(h.owner, failed.value.runId)).value.run).toMatchObject({
      status: "failed", error: "Credential is required: model.missing-key"
    });
    for (let i = 0; i < 100; i++) {
      const queue = (await h.runtime.database.pool.query("SELECT status FROM space_run_queue WHERE space_id=$1 AND run_id=$2",
        [h.owner.spaceId, failed.value.runId])).rows[0];
      if (queue?.status === "failed") break;
      await delay(25);
    }
    expect(calls).toEqual([]);
    expect((await h.runtime.database.pool.query(
      "SELECT state,actual FROM space_usage_reservations WHERE space_id=$1 AND run_id=$2",
      [h.owner.spaceId, failed.value.runId])).rows).toEqual([{ state: "settled", actual: "0" }]);
    const modelShare = await h.api(h.owner, "/v1/sharing", { kind: "model", sourceId: "working-key", recipient: h.receiver.user.id });
    expect(modelShare.status).toBe(201);
    const borrowed = await h.api(scoped, "/v1/runs", { sessionId: id, prompt: "use shared model",
      model: { profileId: `share.${modelShare.value.share.id}` } });
    expect(borrowed.status, JSON.stringify(borrowed.value)).toBe(202);
    expect((await h.run(scoped, borrowed.value.runId)).value.run).toMatchObject({
      status: "completed", output: "borrowed-after-failure"
    });
    expect(calls).toEqual(["working-key"]);
    expect((await h.api(scoped, `/v1/workbench-state/sessions/${id}`)).value.text).toContain("borrowed-after-failure");
    expect((await h.api(h.receiver, `/v1/sessions/${id}`)).status).toBe(404);
    await expect.poll(async () => (await h.runtime.database.pool.query(
      "SELECT status FROM space_run_queue WHERE space_id=$1 AND run_id=$2",
      [h.owner.spaceId, borrowed.value.runId])).rows[0]?.status).toBe("completed");
    // A durable ambiguous predecessor must be reported promptly, never replayed.
    await h.runtime.database.pool.query(
      "UPDATE space_run_queue SET status='outcome_unknown' WHERE space_id=$1 AND run_id=$2",
      [h.owner.spaceId, failed.value.runId]);
    const blocked = await h.api(scoped, "/v1/runs", { sessionId: id, prompt: "must not call provider",
      model: { profileId: `share.${modelShare.value.share.id}` } });
    expect(blocked.status).toBe(202);
    expect((await h.run(scoped, blocked.value.runId)).value.run).toMatchObject({
      status: "failed", error: expect.stringContaining("上一条任务的执行结果尚未确认")
    });
    expect(calls).toEqual(["working-key"]);
  }, 45000);
  it("moves a private session with images and visible cards into an editor folder, retains provider ownership and supports deletion", async () => {
    const h = await setup(), sourceId = "receiver-inward";
    const initial = await h.api(h.owner, "/v1/workbench-state/tree");
    const written = await h.api(h.owner, "/v1/workbench-state/tree", { expected_revision: initial.value.revision, tree: { id: "root", type: "folder", children: [
      { id: "inward-folder", type: "folder", title: "轩轩", children: [
        { id: "inward-child", type: "folder", title: "子目录", children: [] }
      ] }
    ] } }, "PUT");
    expect(written.status, JSON.stringify(written.value)).toBe(200);
    const share = await h.api(h.owner, "/v1/sharing", { kind: "folder", sourceId: "inward-folder",
      recipient: h.receiver.user.id, role: "editor" });
    expect(share.status, JSON.stringify(share.value)).toBe(201);
    await h.api(h.owner, `/v1/sharing/${share.value.share.id}/recipients`, { recipient: h.other.user.id, role: "viewer" });
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=", "base64");
    const upload = await fetch(`${h.runtime.url}/v1/assets`, { method: "POST", headers: {
      cookie: h.receiver.cookie, origin: h.runtime.url, "x-zioon-space-id": h.receiver.spaceId, "content-type": "image/png"
    }, body: bytes });
    const uploaded = await upload.json();
    expect(upload.status, JSON.stringify(uploaded)).toBe(201);
    const assetId = uploaded.asset.id;
    const text = `user 我自己的内容 ![图片](zion-asset://${assetId})\nassistant <!-- zion-assistant:id=answer -->\n思考 <!-- zion-thinking:id=visible -->\n回答`;
    const saved = await h.api(h.receiver, `/v1/workbench-state/sessions/${sourceId}`, {
      text, meta: { title: "迁入会话", privateIdentity: "PRIVATE_CONFIG", modelProfileId: "PRIVATE_MODEL",
        annotations: { thinking: [
          { id: "visible", text: "已显示的思考", privateTrace: "DROP_CARD_PRIVATE_FIELD", assistantBlockId: "answer" },
          { id: "hidden", text: "HIDDEN_CARD" }
        ] } }
    }, "PUT");
    expect(saved.status, JSON.stringify(saved.value)).toBe(200);
    const oldShare = await h.api(h.receiver, "/v1/sharing", {
      kind: "document", sourceId, recipient: h.other.user.id, role: "viewer"
    });
    expect(oldShare.status, JSON.stringify(oldShare.value)).toBe(201);
    const path = `/v1/sharing/${share.value.share.id}/folder-operations`;
    const input = { action: "importDocument", id: "inward-child", sourceDocumentId: sourceId,
      operationId: "inward-image", sourceRevision: saved.value.session_revision };
    const imported = await h.api(h.receiver, path, input);
    expect(imported.status, JSON.stringify(imported.value) + h.runtime.logs()).toBe(200);
    const id = imported.value.id;
    expect((await h.api(h.receiver, path, input)).value).toMatchObject({ id, duplicate: true });
    expect((await h.api(h.receiver, `/v1/workbench-state/sessions/${sourceId}`)).status).toBe(404);
    expect((await h.runtime.database.pool.query(`SELECT id FROM runtime_workbench_tombstones WHERE space_id=$1 AND id=$2`,
      [h.receiver.spaceId, sourceId])).rowCount).toBe(1);
    expect(JSON.stringify((await h.api(h.receiver, "/v1/workbench-state/catalog")).value)).not.toContain(sourceId);
    expect((await h.api(h.other, "/v1/sharing/content")).value.received.some(node => node.id === sourceId)).toBe(false);
    expect((await h.api(h.other, `/v1/sharing/${oldShare.value.share.id}/folder-operations`, {
      action: "importDocument", id: "inward-child", sourceDocumentId: sourceId, operationId: "deleted-source"
    })).status).toBe(403);
    const read = await h.api(h.owner, `/v1/workbench-state/sessions/${id}`);
    expect(read.value.text).toContain("我自己的内容");
    expect(read.value.meta.title).toBe("迁入会话");
    expect(read.value.meta.annotations.thinking).toMatchObject([{ id: "visible", text: "已显示的思考" }]);
    expect(JSON.stringify(read.value)).not.toMatch(/PRIVATE_CONFIG|PRIVATE_MODEL|HIDDEN_CARD|DROP_CARD_PRIVATE_FIELD/);
    const newAssetId = /zion-asset:\/\/([A-Za-z0-9_-]+)/.exec(read.value.text)[1];
    expect(newAssetId).not.toBe(assetId);
    const scoped = { ...h.other, contentScope: { originSpaceId: h.owner.spaceId, documentId: id } };
    expect((await h.api(scoped, `/v1/workbench-state/sessions/${id}`)).status).toBe(200);
    const image = await fetch(`${h.runtime.url}/v1/assets/${newAssetId}/content`, { headers: {
      cookie: h.other.cookie, "x-zioon-space-id": h.other.spaceId, "x-zioon-content-space": h.owner.spaceId, "x-zioon-content-document": id
    } });
    expect(image.status).toBe(200); expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes);
    expect((await h.api(h.other, `/v1/assets/${newAssetId}`)).status).toBe(404);
    const tree = (await h.api(h.owner, "/v1/workbench-state/tree")).value.tree;
    expect(tree.children[0].children[0].children.map(node => node.id)).toEqual([id]);
    const document = (await h.runtime.database.pool.query(`SELECT created_by FROM space_documents WHERE space_id=$1 AND id=$2`,
      [h.owner.spaceId, id])).rows[0];
    expect(document.created_by).toBe(h.owner.user.id);
    expect((await h.api(h.owner, "/v1/sharing", { kind: "document", sourceId: id, recipient: h.other.user.id, role: "viewer" })).status).toBe(201);
    expect((await h.runtime.database.pool.query(`SELECT user_id FROM space_document_grants WHERE space_id=$1 AND document_id=$2`,
      [h.owner.spaceId, id])).rows.map(row => row.user_id)).toEqual([h.owner.user.id]);
    expect((await h.api(h.other, path, { action: "delete", id, operationId: "viewer-delete" })).status).toBe(403);
    expect((await h.api(h.receiver, path, { action: "delete", id, operationId: "editor-delete" })).status).toBe(200);
    expect((await h.api(scoped, `/v1/workbench-state/sessions/${id}`)).status).toBe(404);
    expect(JSON.stringify((await h.api(h.other, "/v1/sharing/content")).value.received)).not.toContain(id);
    expect((await h.runtime.database.pool.query(`SELECT lifecycle FROM space_documents WHERE space_id=$1 AND id=$2`,
      [h.owner.spaceId, id])).rows[0].lifecycle).toBe("deleted");
  }, 45000);
  it("denies inward transfer for busy, stale, missing-image, outside, viewer and revoked requests while preserving sources", async () => {
    const h = await setup();
    const initial = await h.api(h.owner, "/v1/workbench-state/tree");
    const written = await h.api(h.owner, "/v1/workbench-state/tree", { expected_revision: initial.value.revision, tree: { id: "root", type: "folder", children: [
      { id: "limited", type: "folder", title: "共享", children: [] },
      { id: "unshared", type: "folder", title: "未共享", children: [] }
    ] } }, "PUT");
    expect(written.status, JSON.stringify(written.value)).toBe(200);
    const share = await h.api(h.owner, "/v1/sharing", { kind: "folder", sourceId: "limited", recipient: h.receiver.user.id, role: "editor" });
    expect(share.status, JSON.stringify(share.value)).toBe(201);
    const path = `/v1/sharing/${share.value.share.id}/folder-operations`;
    await h.api(h.receiver, "/v1/workbench-state/sessions/movable", { text: "user 原内容" }, "PUT");
    await h.api(h.owner, "/v1/workbench-state/sessions/owners-secret", { text: "user OWNER_SECRET" }, "PUT");
    let sequence = 0;
    const transfer = overrides => h.api(h.receiver, path, { action: "importDocument", id: "limited",
      sourceDocumentId: "movable", operationId: `deny-${sequence++}`, ...overrides });
    expect((await transfer({ sourceDocumentId: "owners-secret", sourceSpaceId: h.owner.spaceId })).status).toBe(404);
    expect((await transfer({ id: "unshared" })).status).toBe(404);
    expect((await transfer({ sourceRevision: 100 })).status).toBe(409);
    await h.runtime.database.pool.query(`INSERT INTO runtime_runs (space_id,id,payload_json,status,updated_at)
      VALUES ($1,'inward-busy',$2::jsonb,'running',$3)`, [h.receiver.spaceId, JSON.stringify({ sessionId: "movable" }), Date.now()]);
    expect((await transfer({})).value.code).toBe("source_document_busy");
    await h.runtime.database.pool.query("DELETE FROM runtime_runs WHERE space_id=$1 AND id='inward-busy'", [h.receiver.spaceId]);
    expect((await h.api(h.receiver, "/v1/workbench-state/sessions/missing-image", { text: "user image" }, "PUT")).status).toBe(200);
    await h.runtime.database.pool.query("UPDATE runtime_workbench_documents SET text=$3 WHERE space_id=$1 AND id=$2",
      [h.receiver.spaceId, "missing-image", "user ![](zion-asset://nonexistent)"]);
    expect((await transfer({ sourceDocumentId: "missing-image" })).status).toBe(404);
    expect((await h.api(h.receiver, "/v1/workbench-state/sessions/missing-image")).value.text).toContain("nonexistent");
    await h.api(h.owner, `/v1/sharing/${share.value.share.id}/recipients/${h.receiver.user.id}`, { role: "viewer" }, "PUT");
    expect((await transfer({})).status).toBe(403);
    await h.api(h.owner, `/v1/sharing/${share.value.share.id}/revoke`, { recipientId: h.receiver.user.id });
    expect((await transfer({})).status).toBe(403);
    expect((await h.api(h.receiver, "/v1/workbench-state/sessions/movable")).value.text).toBe("user 原内容");
    expect((await h.api(h.owner, "/v1/workbench-state/sessions/owners-secret")).value.text).toBe("user OWNER_SECRET");
    expect((await h.api(h.owner, "/v1/workbench-state/tree")).value.tree.children.find(node => node.id === "limited").children).toEqual([]);
  }, 45000);
  it("keeps legacy owner models private and executes only the explicitly shared model from a fresh account", async () => {
    const calls = [];
    const provider = createServer(async (req, res) => {
      let body = ""; for await (const part of req) body += part;
      calls.push({ model: JSON.parse(body).model, authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"shared-model-ok"}}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise(resolve => provider.close(resolve)));
    const h = await setup({ engine: "openai", legacyWorkspace: true,
      environment: { ZION_RUNTIME_MODEL_PROFILE: "legacy-secret", ZION_RUNTIME_DEFAULT_INTERACTION_MODEL_PROFILE: "legacy-secret" },
      prepare: async ({ dataDirectory }) => {
        await mkdir(dataDirectory, { recursive: true });
        await writeFile(join(dataDirectory, "model-profiles.json"), JSON.stringify({ profiles:
          ["legacy-secret", "legacy-shared"].map(id => ({ id, label: id, providerId: "fixture", providerType: "openai",
            model: id, endpoint: `http://127.0.0.1:${provider.address().port}/chat`, credentialRef: `model.${id}`,
            credentialRequired: true })) }));
        await writeFile(join(dataDirectory, "credentials.json"), JSON.stringify({
          "model.legacy-secret": { value: "secret-owner-key" }, "model.legacy-shared": { value: "shared-owner-key" }
        }));
      } });
    const owner = await h.api(h.owner, "/v1/models");
    expect(owner.status).toBe(200);
    expect(owner.value.profiles.map(p => p.id)).toEqual(expect.arrayContaining(["legacy-secret", "legacy-shared"]));
    const created = await h.api(h.owner, "/v1/sharing", { kind: "model", sourceId: "legacy-shared", recipient: h.receiver.user.id });
    expect(created.status, JSON.stringify(created.value)).toBe(201);
    const sharedId = `share.${created.value.share.id}`;
    const recipient = await h.api(h.receiver, "/v1/models");
    expect(recipient.status, JSON.stringify(recipient.value)).toBe(200);
    expect(recipient.value.profiles.some(p => p.id === sharedId)).toBe(true);
    expect(recipient.value.profiles.some(p => p.id.startsWith("legacy-"))).toBe(false);
    expect(recipient.value.profiles.some(p => p.metadata?.platformManaged)).toBe(false);
    expect(JSON.stringify(recipient.value)).not.toContain("secret-owner-key");
    expect(recipient.value.activeProfileId).not.toBe("legacy-secret");
    expect((await h.api(h.receiver, "/v1/workbench-state/sessions/recipient-private", { text: "user private" }, "PUT")).status).toBe(200);
    for (const profileId of ["legacy-secret", "legacy-shared"]) {
      expect((await h.api(h.receiver, "/v1/models/selection", { profileId }, "PUT")).status).toBe(422);
      const denied = await h.api(h.receiver, "/v1/runs", { sessionId: "recipient-private", prompt: "forbidden", model: { profileId } });
      expect(denied.status).toBeGreaterThanOrEqual(400);
    }
    expect(calls).toEqual([]);
    expect((await h.api(h.receiver, "/v1/models/selection", { profileId: sharedId }, "PUT")).status).toBe(200);
    const run = await h.api(h.receiver, "/v1/runs", { sessionId: "recipient-private", prompt: "use authorized model" });
    expect(run.status, JSON.stringify(run.value)).toBe(202);
    expect((await h.run(h.receiver, run.value.runId)).value.run.status).toBe("completed");
    expect(calls).toEqual([{ model: "legacy-shared", authorization: "Bearer shared-owner-key" }]);
    expect((await h.api(h.other, "/v1/models")).value.profiles.some(p => p.id === sharedId)).toBe(false);
  }, 45000);
  it("routes shared folder editor CRUD to the owner and immediately enforces viewer and revoked grants", async () => {
    const h = await setup();
    const current = await h.api(h.owner, "/v1/workbench-state/tree");
    const written = await h.api(h.owner, "/v1/workbench-state/tree", { expected_revision: current.value.revision,
      tree: { id: "root", type: "folder", children: [
      { id: "shared-folder", type: "folder", title: "轩轩", children: [] },
      { id: "outside", type: "folder", title: "不共享", children: [] }
    ] } }, "PUT");
    expect(written.status, JSON.stringify(written.value)).toBe(200);
    const created = await h.api(h.owner, "/v1/sharing", { kind: "folder", sourceId: "shared-folder",
      recipient: h.receiver.user.id, role: "editor" });
    expect(created.status, JSON.stringify(created.value)).toBe(201);
    const path = `/v1/sharing/${encodeURIComponent(created.value.share.id)}/folder-operations`;
    let sequence = 0;
    const mutate = (input, account = h.receiver) => h.api(account, path, { operationId: `op-${sequence++}`, ...input });
    const before = (await h.api(h.receiver, "/v1/workbench-state/catalog")).value;
    const folder = await mutate({ action: "createFolder", id: "shared-folder", title: "新目录" });
    expect(folder.status, JSON.stringify(folder.value)).toBe(200);
    const doc = await mutate({ action: "createDocument", id: folder.value.id, title: "新会话" });
    expect(doc.status, JSON.stringify(doc.value)).toBe(200);
    const ownerDoc = await h.api(h.owner, `/v1/workbench-state/sessions/${doc.value.id}`);
    expect(ownerDoc.status, JSON.stringify(ownerDoc.value)).toBe(200);
    expect(ownerDoc.value.meta.title).toBe("新会话");
    expect((await h.runtime.database.pool.query(`SELECT created_by FROM space_documents WHERE space_id=$1 AND id=$2`,
      [h.owner.spaceId, doc.value.id])).rows[0].created_by).toBe(h.owner.user.id);
    expect((await h.runtime.database.pool.query(`SELECT user_id FROM space_document_grants WHERE space_id=$1 AND document_id=$2`,
      [h.owner.spaceId, doc.value.id])).rows.map(row => row.user_id)).toEqual([h.owner.user.id]);
    const scoped = { ...h.receiver, contentScope: { originSpaceId: h.owner.spaceId, documentId: doc.value.id } };
    expect((await h.api(scoped, `/v1/workbench-state/sessions/${doc.value.id}`, { text: "user 共享编辑" }, "PUT")).status).toBe(200);
    const titleAfterEdit = (await h.api(h.owner, `/v1/workbench-state/sessions/${doc.value.id}`)).value.meta.title;
    expect((await mutate({ action: "rename", id: doc.value.id, title: "改名会话", expectedTitle: titleAfterEdit })).status).toBe(200);
    expect((await mutate({ action: "rename", id: "shared-folder", title: "共享清单" })).status).toBe(200);
    expect((await h.api(h.receiver, "/v1/sharing/content")).value.received[0].title).toBe("共享清单");
    expect((await mutate({ action: "createFolder", id: "outside", title: "越界" })).status).toBe(404);
    expect((await mutate({ action: "move", id: doc.value.id, parentId: "outside" })).status).toBe(400);
    expect((await mutate({ action: "move", id: doc.value.id, parentId: "shared-folder" })).status).toBe(200);
    expect((await mutate({ action: "delete", id: doc.value.id })).status).toBe(200);
    expect((await h.api(scoped, `/v1/workbench-state/sessions/${doc.value.id}`)).status).toBe(404);
    expect((await mutate({ action: "delete", id: folder.value.id,
      expectedTree: { id: folder.value.id, type: "folder", children: [] } })).status).toBe(200);
    expect((await h.api(h.receiver, "/v1/workbench-state/catalog")).value).toEqual(before);
    expect(JSON.stringify(folder.value)).not.toContain("不共享");
    expect((await mutate({ action: "rename", id: "shared-folder", title: "未授权" }, h.other)).status).toBe(403);
    await h.api(h.owner, `/v1/sharing/${encodeURIComponent(created.value.share.id)}/recipients/${encodeURIComponent(h.receiver.user.id)}`, { role: "viewer" }, "PUT");
    expect((await mutate({ action: "createFolder", id: "shared-folder", title: "只读" })).status).toBe(403);
    await h.api(h.owner, `/v1/sharing/${encodeURIComponent(created.value.share.id)}/revoke`, { recipientId: h.receiver.user.id });
    expect((await mutate({ action: "rename", id: "shared-folder", title: "撤权" })).status).toBe(403);
  }, 45000);
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
