// Disposable, synthetic accounts only. Stop with Ctrl-C to remove test data.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccountOidcFixture } from "../apps/runtime/tests/helpers/account-oidc-fixture.mjs";
import { startAccountRuntimeFixture, browserAccountLogin } from "../apps/runtime/tests/helpers/account-runtime-fixture.mjs";

const directory = mkdtempSync(join(tmpdir(), "zion-account-preview-"));
const idp = await createAccountOidcFixture();
const runtime = await startAccountRuntimeFixture({ directory, spaceId: "space:preview", idp, web: true });
const owner = await browserAccountLogin(runtime.url);
const response = await fetch(`${runtime.url}/v1/sessions`, {
  method: "POST", headers: { cookie: owner.cookie, origin: runtime.url, "content-type": "application/json" },
  body: JSON.stringify({ title: "账号验收会话" })
});
const { session } = await response.json();
await fetch(`${runtime.url}/v1/sessions/${encodeURIComponent(session.id)}/messages`, {
  method: "POST", headers: { cookie: owner.cookie, origin: runtime.url, "content-type": "application/json" },
  body: JSON.stringify({ content: "本会话用于验证账号登录和只读访问。" })
});
if (process.argv.includes("--viewer") || process.argv.includes("--member")) {
  const role = process.argv.includes("--viewer") ? "viewer" : "member";
  const store = runtime.accounts;
  const ownerUser = await store.findIdentity(idp.issuer, "test-owner");
  const user = await store.resolveIdentity({
    issuer: idp.issuer,
    subject: `test-${role}`,
    name: `测试 ${role}`
  });
  await store.acceptInvitation(
    user.id,
    (await store.invite(ownerUser.id, { role }, "space:preview")).token
  );
  idp.setSubject(`test-${role}`);
}
console.log(`Synthetic account preview: ${runtime.url}/account`);
console.log(`Mobile: ${runtime.url}/mobile/`);
console.log(`Conversation: ${runtime.url}/mobile/chat/${encodeURIComponent(session.id)}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await runtime.close();
  await idp.close();
  rmSync(directory, { recursive: true, force: true });
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
