import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directory = join(repository, ".runtime-data/spaces-preview");
const config = JSON.parse(await readFile(join(directory, "config.local.json"), "utf8"));
const evidence = JSON.parse(await readFile(join(directory, "acceptance/config.json"), "utf8"));
const owner = config.accounts[0], partner = config.accounts[1];
const headers = { authorization: `Bearer ${owner.token}`, "x-zioon-space-id": config.teamSpaceId };
const fetchJson = async (url, extra = {}) => {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000), ...extra });
  assert.equal(response.status, 200);
  return response.json();
};
async function snapshot() {
  const space = `${config.runtimeUrl}/v1/spaces/${encodeURIComponent(config.teamSpaceId)}`;
  const document = await fetchJson(`${space}/documents/${evidence.testDocumentId}`);
  const members = (await fetchJson(space + "/members")).members;
  const resources = (await fetchJson(space + "/capabilities")).capabilities;
  const memory = await fetchJson(`${config.memoryUrl}/zion/files/read?${new URLSearchParams({
    path: "/memory/dev.identity/user.md", document: evidence.testDocumentId
  })}`, { headers: { ...headers, authorization: `Bearer ${partner.token}` } });
  return { text: document.content.text, revision: document.content.revision,
    aclRevision: document.document.aclRevision, memory: memory.content, memoryHash: memory.content_hash,
    members: members.map(m => [m.id, m.role, m.status]), resources: resources.map(r => [r.id, r.status]) };
}
const before = await snapshot();
const run = promisify(execFile);
await run(process.execPath, ["scripts/spaces-preview.mjs", "stop"], { cwd: repository, timeout: 20000 });
await run(process.execPath, ["scripts/spaces-preview.mjs", "start"], { cwd: repository, timeout: 40000 });
const after = await snapshot();
assert.deepEqual(after, before);
const identity = await fetchJson(config.runtimeUrl + "/v1/account/me", { headers: {
  authorization: `Bearer ${partner.token}`, "x-zioon-space-id": config.teamSpaceId
} });
assert.equal(identity.space.id, config.teamSpaceId);
assert.equal(identity.membership.role, "member");
const guest = await fetch(`${config.runtimeUrl}/v1/spaces/${encodeURIComponent(config.teamSpaceId)}/documents/${config.guestDocumentId}`, {
  headers: { authorization: `Bearer ${config.accounts[2].token}`, "x-zioon-space-id": config.teamSpaceId }
});
assert.equal(guest.status, 200);
const receipt = { status: "PASS", at: Date.now(),
  checks: ["Runtime and Memory processes stopped/restarted", "same document bytes and revision",
    "same document ACL", "same native SQLite/FS Memory bytes and hash", "members and resource bindings retained",
    "account login retained", "single-document guest access retained"] };
await writeFile(join(directory, "acceptance/native-restart.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
