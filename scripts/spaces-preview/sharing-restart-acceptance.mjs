import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directory = join(repository, ".runtime-data/spaces-preview");
const config = JSON.parse(await readFile(join(directory, "config.local.json"), "utf8"));
const evidence = JSON.parse(await readFile(join(directory, "acceptance/sharing-config.json"), "utf8"));
const [owner, partner] = config.accounts;
async function get(account, path, scoped = "") {
  const response = await fetch(config.runtimeUrl + path, { headers: {
    authorization: `Bearer ${account.token}`, "x-zioon-space-id": account.personalSpaceId,
    ...(scoped ? { "x-zioon-content-space": owner.personalSpaceId, "x-zioon-content-document": scoped } : {})
  }, signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, path);
  return response.json();
}
async function snapshot() {
  const document = await get(owner, `/v1/workbench-state/sessions/${encodeURIComponent(config.sharingDocumentId)}`);
  const received = await get(partner, "/v1/sharing?direction=received");
  const sent = await get(owner, "/v1/sharing?direction=sent");
  const privateTranscript = await get(partner, `/v1/sessions/${encodeURIComponent(evidence.privateSession)}/transcript`);
  const personalMemory = await get(partner, "/v1/plugins/dev.identity/files/read?path=user.md");
  const sharedMemory = await get(owner, `/v1/plugins/dev.identity/files/read?path=user.md&document=${evidence.testDoc}`, evidence.testDoc);
  const folder = await get(partner, `/v1/sharing/${encodeURIComponent(config.sharingFolderShareId)}/documents`);
  const models = (await get(partner, "/v1/models")).profiles.map(p => p.id);
  return { text: document.text, revision: document.session_revision, received, sent, privateTranscript,
    memory: personalMemory.content, memoryHash: personalMemory.content_hash,
    sharedMemory: sharedMemory.content, sharedMemoryHash: sharedMemory.content_hash, folder, models };
}
const before = await snapshot();
const run = promisify(execFile);
await run(process.execPath, ["scripts/spaces-preview.mjs", "stop"], { cwd: repository, timeout: 20000 });
await run(process.execPath, ["scripts/spaces-preview.mjs", "start"], { cwd: repository, timeout: 40000 });
assert.deepEqual(await snapshot(), before);
const identity = await get(partner, "/v1/account/me");
assert.equal(identity.space.id, partner.personalSpaceId);
const receipt = { status: "PASS", checks: ["Runtime and native Memory restarted in same persistent database",
  "original shared text and revision retained", "received and sent grants/invitation revocations retained",
  "private transcript retained", "native personal and document Memory bytes and hashes retained",
  "folder private-child filtering retained", "own and borrowed model catalog retained", "same account login"] };
await writeFile(join(directory, "acceptance/sharing-native-restart.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
