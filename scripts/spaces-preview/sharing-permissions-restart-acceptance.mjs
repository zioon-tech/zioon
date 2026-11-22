import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directory = join(repository, ".runtime-data/spaces-preview");
const config = JSON.parse(await readFile(join(directory, "config.local.json"), "utf8"));
const [owner, receiver] = config.accounts;
const id = `permissions-restart-${randomUUID()}`;
const api = async (account, path, body, method = body === undefined ? "GET" : "POST", scoped = false) => {
  const response = await fetch(config.runtimeUrl + path, { method, headers: {
    authorization: `Bearer ${account.token}`, "x-zioon-space-id": account.personalSpaceId,
    "content-type": "application/json", "x-zion-workbench-protocol": "5",
    ...(scoped ? { "x-zioon-content-space": owner.personalSpaceId, "x-zioon-content-document": id } : {})
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  return { status: response.status, value: await response.json() };
};
const ok = async (...args) => { const result = await api(...args); assert.ok(result.status < 300, `HTTP ${result.status}`); return result.value; };
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
try {
  assert.equal((await pool.query("SELECT COUNT(*)::integer AS n FROM runtime_runs WHERE status IN ('created','queued','running')")).rows[0].n, 0, "The preview must be idle before restarting");
} finally { await pool.end(); }
let shareId;
try {
  await ok(owner, `/v1/workbench-state/sessions/${id}`, { text: "user DIRECT_RESTART", meta: { title: "验收 · 直接授权持久化" } }, "PUT");
  const created = await ok(owner, "/v1/sharing", { kind: "document", sourceId: id, recipient: receiver.userId, role: "editor" });
  shareId = created.share.id; assert.equal(created.invitation, undefined);
  await ok(owner, `/v1/sharing/documents/${id}/collaborators/${encodeURIComponent(receiver.userId)}`, { role: "viewer" }, "PUT");
  const run = promisify(execFile);
  // The existing restart check also verifies original samples, Memory and model catalogs.
  await run(process.execPath, ["scripts/spaces-preview/sharing-restart-acceptance.mjs"], { cwd: repository, timeout: 60000 });
  const received = (await ok(receiver, "/v1/sharing?direction=received")).shares.find(share => share.id === shareId);
  assert.equal(received.role, "viewer");
  const sent = (await ok(owner, "/v1/sharing?direction=sent")).shares.find(share => share.id === shareId);
  assert.equal(sent.recipients.find(person => person.id === receiver.userId).role, "viewer");
  assert.deepEqual(sent.invitations, []);
  assert.ok((await ok(receiver, `/v1/workbench-state/sessions/${id}`, undefined, "GET", true)).text.includes("DIRECT_RESTART"));
  assert.equal((await api(receiver, `/v1/workbench-state/sessions/${id}`, { text: "forbidden" }, "PUT", true)).status, 404);
  const receipt = { status: "PASS", checks: ["idle preview restarted with existing samples and Memory retained",
    "direct account grant retained without an invitation", "per-user downgrade retained while invitation default stays editor",
    "received list retains viewer permission", "original document remains readable", "HTTP edit remains denied after restart"] };
  await writeFile(join(directory, "acceptance/sharing-permissions-native-restart.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  if (shareId) await api(owner, `/v1/sharing/${encodeURIComponent(shareId)}/revoke`, {});
  await api(owner, `/v1/workbench-state/sessions/${id}`, undefined, "DELETE");
}
