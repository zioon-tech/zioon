import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(".runtime-data/spaces-preview");
const config = JSON.parse(await readFile(resolve(directory, "config.local.json"), "utf8"));
const stage = JSON.parse(await readFile(resolve(directory, "acceptance/document-links-stage.json"), "utf8"));
const [owner, reader] = config.accounts;
const api = async (user, path, body, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(config.runtimeUrl + path, { method, headers: {
    authorization: `Bearer ${user.token}`, "x-zioon-space-id": user.personalSpaceId,
    "content-type": "application/json", "x-zion-workbench-protocol": "5"
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, 200); return response.json();
};
const url = config.runtimeUrl + `/share/${stage.linkId}`;
const link = await api(owner, `/v1/sharing/documents/${stage.documentId}/link`);
assert.equal(link.link.id, stage.linkId); assert.equal(link.link.mode, "public");
const page = await fetch(url); assert.equal(page.status, 200); assert.ok((await page.text()).includes("批准后更新的原文"));
const view = await api(reader, `/v1/sharing/links/${stage.linkId}`); assert.equal(view.role, "viewer");
const content = await api(reader, "/v1/sharing/content");
assert.equal(content.received.find(node => node.id === stage.documentId)?.role, "viewer");
const pending = await api(owner, `/v1/sharing/documents/${stage.documentId}/requests`);
assert.ok(pending.requests.some(request => request.id === stage.pendingId && request.userId === stage.guestId));
const all = await api(owner, "/v1/sharing?direction=sent");
for (const share of all.shares.filter(share => share.sourceId === stage.documentId)) {
  await api(owner, `/v1/sharing/${encodeURIComponent(share.id)}/revoke`, {});
}
await api(owner, `/v1/workbench-state/sessions/${stage.documentId}`, undefined, "DELETE");
assert.equal((await fetch(url)).status, 404);
await writeFile(resolve(directory, "acceptance/document-links-native-restart.json"), JSON.stringify({
  status: "PASS", checks: ["stable URL and public mode survive runtime restart", "anonymous reader sees current saved body after restart",
    "avatar permission downgrade survives restart", "received session list preserves viewer permission",
    "pending access request and account identity survive restart", "temporary document and grants cleaned; old URL returns 404"]
}, null, 2));
console.log("PASS: 6 native restart checks; temporary content cleaned.");
