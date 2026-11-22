import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directory = join(repository, ".runtime-data/spaces-preview");
const config = JSON.parse(await readFile(join(directory, "config.local.json"), "utf8"));
const [owner, partner, guest] = config.accounts;
const clients = [];
const checks = [];
async function participants(account, documentId = config.sharingDocumentId) {
  const response = await fetch(`${config.runtimeUrl}/v1/sharing/documents/${encodeURIComponent(documentId)}/participants?origin=${encodeURIComponent(owner.personalSpaceId)}`, {
    headers: { authorization: `Bearer ${account.token}`, "x-zioon-space-id": account.personalSpaceId },
    signal: AbortSignal.timeout(10000)
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}
async function connect(account) {
  class PreviewSocket extends WebSocket {
    constructor(address, protocols) {
      // Browsers send the login cookie on upgrade; the native client uses the
      // same account session as a bearer before the gateway chooses a Runtime.
      super(address, protocols, { origin: config.runtimeUrl,
        headers: { authorization: `Bearer ${account.token}` } });
    }
  }
  const document = new Y.Doc();
  let provider;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Preview presence sync timed out")), 10000);
    provider = new HocuspocusProvider({
      url: `${config.runtimeUrl.replace(/^http/, "ws")}/v1/collaboration?${new URLSearchParams({
        protocol: "6", space: account.personalSpaceId, content_space: owner.personalSpaceId,
        content_document: config.sharingDocumentId
      })}`,
      name: config.sharingDocumentId, document, token: account.token, WebSocketPolyfill: PreviewSocket,
      onSynced() { clearTimeout(timer); resolve(); },
      onAuthenticationFailed({ reason }) { clearTimeout(timer); reject(new Error(reason)); }
    });
    clients.push({ provider, document });
  });
  return provider;
}
try {
  const initial = await participants(partner);
  assert.equal(initial.selfId, partner.userId);
  assert.ok(initial.participants.some(p => p.id === owner.userId && p.role === "owner"));
  assert.ok(initial.participants.some(p => p.id === partner.userId && p.role === "editor"));
  assert.ok(initial.participants.some(p => p.id === guest.userId && p.role === "viewer"));
  assert.ok(initial.participants.every(p => !("email" in p) && !("token" in p)));
  checks.push("真实账户读取原始会话参与者，角色与已有分享一致，响应不缓存");
  const first = await connect(partner), second = await connect(partner);
  const ownerSocket = await connect(owner);
  first.awareness.setLocalStateField("user", { id: guest.userId, name: "SPOOFED_PRESENCE", role: "owner" });
  const online = await participants(partner);
  assert.equal(online.participants.filter(p => p.id === partner.userId).length, 1);
  assert.equal(online.participants.find(p => p.id === partner.userId).online, true);
  assert.equal(online.participants.find(p => p.id === owner.userId).online, true);
  assert.ok(!JSON.stringify(online).includes("SPOOFED_PRESENCE"));
  checks.push("通过实际账户 Runtime 的 WebSocket 验证双方在线、多窗口去重和身份防伪");
  first.destroy();
  assert.equal((await participants(owner)).participants.find(p => p.id === partner.userId).online, true);
  checks.push("关闭同一人的一个窗口，另一窗口保持在线");
  second.destroy(); ownerSocket.destroy();
  // Return to the original presence snapshot; any pre-existing user connection remains.
  const original = initial.participants.map(p => [p.id, p.online]).sort();
  let restored = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const current = (await participants(owner)).participants.map(p => [p.id, p.online]).sort();
    if (JSON.stringify(current) === JSON.stringify(original)) { restored = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(restored, "Test sockets should leave no stale online participants");
  checks.push("关闭测试连接后恢复原在线状态，没有残留头像在线标记");
  const privateChild = await participants(owner, config.sharingPrivateChildId);
  assert.deepEqual(privateChild.participants.map(p => p.id), [owner.userId]);
  checks.push("实际私密子会话仅返回所有者");
  const denied = await fetch(`${config.runtimeUrl}/v1/sharing/documents/${encodeURIComponent(config.sharingPrivateChildId)}/participants?origin=${encodeURIComponent(owner.personalSpaceId)}`, {
    headers: { authorization: `Bearer ${partner.token}`, "x-zioon-space-id": partner.personalSpaceId }
  });
  assert.equal(denied.status, 404);
  checks.push("文件夹接收者无法通过参与者接口读取私密子会话");
} finally {
  for (const { provider, document } of clients) { provider.destroy(); document.destroy(); }
  const receipt = { status: checks.length === 6 ? "PASS" : "INCOMPLETE", checks };
  await writeFile(join(directory, "acceptance/participants-native-http-ws.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}
