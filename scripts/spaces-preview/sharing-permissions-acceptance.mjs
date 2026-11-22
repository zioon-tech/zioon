import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directory = join(repository, ".runtime-data/spaces-preview");
const config = JSON.parse(await readFile(join(directory, "config.local.json"), "utf8"));
const [owner, receiver, guest] = config.accounts;
const id = `permission-check-${randomUUID()}`, folderId = `folder-permission-${randomUUID()}`;
const clients = [], shareIds = [], checks = [];
let folderAdded = false;
const api = async (account, path, body, scoped = false, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(config.runtimeUrl + path, { method, headers: {
    authorization: `Bearer ${account.token}`, "x-zioon-space-id": account.personalSpaceId,
    "content-type": "application/json", "x-zion-workbench-protocol": "5",
    ...(scoped ? { "x-zioon-content-space": owner.personalSpaceId, "x-zioon-content-document": id } : {})
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  return { status: response.status, value: await response.json().catch(() => ({})) };
};
const ok = async (...args) => {
  const result = await api(...args); assert.ok(result.status < 300 && result.value.ok !== false, `HTTP ${result.status}: ${JSON.stringify(result.value)}`);
  return result.value;
};
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
const waitFor = async (action, message) => {
  for (let attempt = 0; attempt < 60; attempt++) { if (await action()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(message);
};
const connect = async account => {
  class PreviewSocket extends WebSocket {
    constructor(address, protocols) { super(address, protocols, {
      origin: config.runtimeUrl, headers: { authorization: `Bearer ${account.token}` }
    }); }
  }
  const document = new Y.Doc();
  let provider;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Permission socket sync timed out")), 10000);
    provider = new HocuspocusProvider({ url: `${config.runtimeUrl.replace(/^http/, "ws")}/v1/collaboration?${new URLSearchParams({
      protocol: "6", space: account.personalSpaceId, content_space: owner.personalSpaceId, content_document: id
    })}`, name: id, document, token: account.token, WebSocketPolyfill: PreviewSocket,
      onSynced() { clearTimeout(timer); resolve(); },
      onAuthenticationFailed({ reason }) { clearTimeout(timer); reject(new Error(reason)); } });
    clients.push({ provider, document });
  });
  return { provider, document, text: document.getText("content") };
};
let direct;
try {
  await ok(owner, `/v1/workbench-state/sessions/${id}`, { text: "user DIRECT_INITIAL\n", meta: { title: "验收 · 直接分享权限" } }, false, "PUT");
  await check("按已验证邮箱直接授权，无邀请链接，接收者立即收到资源", async () => {
    const resolved = await ok(owner, "/v1/sharing/recipients/resolve", { recipient: receiver.email.toUpperCase() });
    assert.equal(resolved.recipient.id, receiver.userId);
    const result = await ok(owner, "/v1/sharing", { kind: "document", sourceId: id, name: "验收 · 直接分享权限", recipient: receiver.email, role: "editor" });
    direct = result.share.id; shareIds.push(direct);
    assert.equal(result.invitation, undefined);
    assert.equal((await ok(receiver, "/v1/sharing?direction=received")).shares.find(share => share.id === direct).role, "editor");
    assert.equal((await ok(receiver, "/v1/sharing/content")).received.find(node => node.id === id).role, "editor");
    assert.equal((await api(receiver, `/v1/workbench-state/sessions/${id}`)).status, 404);
    assert.ok(!JSON.stringify(await ok(receiver, "/v1/workbench-state/catalog")).includes(id));
    assert.ok(!(await ok(owner, "/v1/sharing?direction=sent")).shares.find(share => share.id === direct).invitations.length);
  });
  const editor = await connect(receiver), original = await connect(owner);
  await check("新直接授权可经实际 WebSocket 编辑原文", async () => {
    editor.text.insert(editor.text.length, "BEFORE_DOWNGRADE\n");
    await waitFor(async () => (await ok(owner, `/v1/workbench-state/sessions/${id}`)).text.includes("BEFORE_DOWNGRADE"), "Initial socket edit did not persist");
  });
  await check("降为只读后，已有编辑连接无法继续写入，HTTP 编辑与生成被拒绝", async () => {
    await ok(owner, `/v1/sharing/${encodeURIComponent(direct)}/recipients/${encodeURIComponent(receiver.userId)}`, { role: "viewer" }, false, "PUT");
    editor.text.insert(editor.text.length, "FORBIDDEN_AFTER_DOWNGRADE\n");
    original.text.insert(original.text.length, "OWNER_AFTER_DOWNGRADE\n");
    await waitFor(async () => (await ok(owner, `/v1/workbench-state/sessions/${id}`)).text.includes("OWNER_AFTER_DOWNGRADE"), "Owner socket edit did not persist");
    const persisted = await ok(owner, `/v1/workbench-state/sessions/${id}`);
    assert.ok(!persisted.text.includes("FORBIDDEN_AFTER_DOWNGRADE"));
    assert.equal((await api(receiver, `/v1/workbench-state/sessions/${id}`, { text: "FORBIDDEN_HTTP" }, true, "PUT")).status, 404);
    assert.equal((await api(receiver, "/v1/runs", { sessionId: id, prompt: "FORBIDDEN_RUN" }, true)).status, 404);
    const reader = await connect(receiver);
    assert.ok(reader.text.toString().includes("OWNER_AFTER_DOWNGRADE"));
    assert.ok(!reader.text.toString().includes("FORBIDDEN_AFTER_DOWNGRADE"));
    reader.provider.destroy();
    editor.provider.destroy();
  });
  await check("添加另一账号与权限更新互不影响，协作者无法管理授权", async () => {
    await ok(owner, `/v1/sharing/${encodeURIComponent(direct)}/recipients`, { recipient: guest.userId, role: "editor" });
    const path = `/v1/sharing/documents/${id}/collaborators/${encodeURIComponent(receiver.userId)}`;
    assert.equal((await api(guest, path, { role: "editor" }, false, "PUT")).status, 404);
    await ok(owner, path, { role: "editor" }, false, "PUT");
    assert.equal((await ok(guest, "/v1/sharing?direction=received")).shares.find(share => share.id === direct).role, "editor");
    const fresh = await connect(receiver);
    fresh.text.insert(fresh.text.length, "UPGRADED_AGAIN\n");
    await waitFor(async () => (await ok(owner, `/v1/workbench-state/sessions/${id}`)).text.includes("UPGRADED_AGAIN"), "Upgraded socket edit did not persist");
    fresh.provider.destroy();
    await ok(owner, path, { role: "removed" }, false, "PUT");
    assert.equal((await api(receiver, `/v1/workbench-state/sessions/${id}`, undefined, true)).status, 404);
  });
  editor.provider.destroy(); original.provider.destroy();
  await check("文件夹权限来源清晰，低级直接授权不能覆盖继承编辑权限", async () => {
    const current = (await ok(owner, "/v1/workbench-state/tree")).tree;
    const tree = structuredClone(current); tree.children = (tree.children || []).filter(node => node.id !== id);
    // The new folder contains only this script's document; preserve all user nodes.
    tree.children.push({ id: folderId, type: "folder", title: "验收 · 文件夹权限", children: [{ id, type: "session", title: "验收 · 直接分享权限" }] });
    await ok(owner, "/v1/workbench-state/tree", { tree, base_tree: current }, false, "PUT"); folderAdded = true;
    const folder = await ok(owner, "/v1/sharing", { kind: "folder", sourceId: folderId, name: "验收 · 文件夹权限", role: "editor", recipient: receiver.userId });
    shareIds.push(folder.share.id);
    await ok(owner, `/v1/sharing/${encodeURIComponent(direct)}/recipients`, { recipient: receiver.userId, role: "viewer" });
    const denied = await api(owner, `/v1/sharing/documents/${id}/collaborators/${encodeURIComponent(receiver.userId)}`, { role: "viewer" }, false, "PUT");
    assert.equal(denied.status, 409); assert.equal(denied.value.code, "document_permission_inherited");
    const people = await ok(owner, `/v1/sharing/documents/${id}/participants`);
    assert.ok(people.participants.find(person => person.id === receiver.userId).grants.some(grant => grant.kind === "folder"));
    await ok(owner, `/v1/sharing/resources/folder/${encodeURIComponent(folderId)}/collaborators/${encodeURIComponent(receiver.userId)}`, { role: "viewer" }, false, "PUT");
    assert.equal((await api(receiver, `/v1/workbench-state/sessions/${id}`, { text: "FORBIDDEN_FOLDER" }, true, "PUT")).status, 404);
    await ok(owner, `/v1/sharing/documents/${id}/privacy`, { private: true }, false, "PUT");
    assert.equal((await api(receiver, `/v1/workbench-state/sessions/${id}`, undefined, true)).status, 404);
  });
  await check("模型可按账号直接分享，自己的模型与个人内容边界保持独立", async () => {
    const source = (await ok(owner, "/v1/sharing/sources")).sources[0];
    const result = await ok(owner, "/v1/sharing", { kind: "model", sourceId: source.id, name: "验收 · 直接分享模型", recipient: receiver.userId, monthlyCalls: 5 });
    shareIds.push(result.share.id); assert.equal(result.invitation, undefined);
    const models = (await ok(receiver, "/v1/models")).profiles;
    assert.ok(models.some(model => model.id === `share.${result.share.id}`));
    assert.ok(models.some(model => !model.id.startsWith("share.")));
    assert.equal((await api(receiver, `/v1/workbench-state/sessions/${config.sharingPrivateDocumentId}`)).status, 404);
    await ok(owner, `/v1/sharing/resources/model/${encodeURIComponent(source.id)}/collaborators/${encodeURIComponent(receiver.userId)}`, { role: "use" }, false, "PUT");
    await ok(owner, `/v1/sharing/${encodeURIComponent(result.share.id)}/revoke`, {});
    assert.ok(!(await ok(receiver, "/v1/models")).profiles.some(model => model.id === `share.${result.share.id}`));
  });
} finally {
  for (const { provider, document } of clients) { provider.destroy(); document.destroy(); }
  for (const shareId of shareIds) await api(owner, `/v1/sharing/${encodeURIComponent(shareId)}/revoke`, {});
  if (folderAdded) {
    const current = (await ok(owner, "/v1/workbench-state/tree")).tree;
    const tree = structuredClone(current); tree.children = (tree.children || []).filter(node => node.id !== folderId);
    await ok(owner, "/v1/workbench-state/tree", { tree, base_tree: current }, false, "PUT");
  }
  await api(owner, `/v1/workbench-state/sessions/${id}`, undefined, false, "DELETE");
  const receipt = { status: checks.length === 6 ? "PASS" : "INCOMPLETE", checks };
  await writeFile(join(directory, "acceptance/sharing-permissions-native-http-ws.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}
