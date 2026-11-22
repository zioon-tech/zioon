import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { runRuntimeCli } from "../../apps/runtime/src/runtime-cli.mjs";
import { DEFAULT_INTERACTION_PROFILE_ID } from "../../apps/runtime/src/interaction-profile-store.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directory = resolve(process.env.ZIOON_SPACES_PREVIEW_DIR || join(repository, ".runtime-data/spaces-preview"));
const config = JSON.parse(await readFile(join(directory, "config.local.json"), "utf8"));
const [owner, partner, guest] = config.accounts;
const team = config.teamSpaceId, endpoint = `/v1/spaces/${encodeURIComponent(team)}`;
const receipts = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(account, space, path, { method = "GET", body, headers = {}, raw = false } = {}) {
  const response = await fetch(config.runtimeUrl + path, { method,
    headers: { authorization: `Bearer ${account.token}`, "x-zioon-space-id": space,
      "content-type": "application/json", "x-zion-workbench-protocol": "5", ...headers },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const value = raw ? Buffer.from(await response.arrayBuffer()) : await response.json().catch(() => ({}));
  return { status: response.status, value, response };
}
async function ok(account, space, path, method = "GET", body) {
  const result = await api(account, space, path, { method, body });
  assert.ok(result.status < 300 && result.value.ok !== false,
    `${method} ${path}: HTTP ${result.status} ${JSON.stringify(result.value)}`);
  return result.value;
}
async function check(name, action) {
  await action();
  receipts.push({ name, status: "PASS", at: Date.now() });
  console.log(`PASS ${name}`);
}
async function createDocument(space, title, text) {
  const { session } = await ok(owner, space, "/v1/sessions", "POST", { title });
  await ok(owner, space, `/v1/workbench-state/sessions/${session.id}`, "PUT", { text, meta: { title } });
  return session.id;
}
async function acl(id, body) {
  const { document } = await ok(owner, team, `${endpoint}/documents/${id}/access`);
  return ok(owner, team, `${endpoint}/documents/${id}/access`, "PUT", { expectedRevision: document.aclRevision, ...body });
}
async function run(account, document, prompt, extra = {}) {
  return ok(account, team, "/v1/runs", "POST", { sessionId: document, interactionProfileId: DEFAULT_INTERACTION_PROFILE_ID,
    messages: [{ role: "user", content: prompt }], ...extra });
}
async function completed(account, runId) {
  for (let i = 0; i < 600; i++) {
    const { run } = await ok(account, team, `/v1/runs/${runId}`);
    if (!["created", "queued", "running"].includes(run.status)) return run;
    await wait(25);
  }
  throw new Error(`Run completion timeout: ${runId}`);
}
async function memory(account, space, document, method, content) {
  const url = new URL(`/zion/files/${method === "GET" ? "read" : "write"}`, config.memoryUrl);
  if (document) url.searchParams.set("document", document);
  if (method === "GET") url.searchParams.set("path", "/memory/dev.identity/user.md");
  const response = await fetch(url, { method, headers: {
    authorization: `Bearer ${account.token}`, "x-zioon-space-id": space, "content-type": "application/json"
  }, ...(method === "GET" ? {} : { body: JSON.stringify({ path: "/memory/dev.identity/user.md", content }) }) });
  return { status: response.status, value: await response.json() };
}
const managed = [{ subjectType: "user", subjectId: owner.userId, role: "manager" }];
const sharedAudience = { protection: "space", audienceMode: "space", grants: managed };
const guestAudience = { protection: "external", audienceMode: "specific",
  grants: [...managed, { subjectType: "user", subjectId: guest.userId, role: "commenter" }] };
await mkdir(join(directory, "acceptance"), { recursive: true });
try {
  await check("真实 OIDC 登录与 Workbench 按窗口选择空间", async () => {
    const begin = await fetch(`${config.runtimeUrl}/v1/account/login?returnTo=${encodeURIComponent(`/?space=${team}`)}`, { redirect: "manual" });
    assert.equal(begin.status, 302);
    const cookie = begin.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    const authorize = await fetch(begin.headers.get("location"), { redirect: "manual" });
    const form = await authorize.text();
    const tx = form.match(/name="tx" value="([^"]+)"/)?.[1];
    assert.ok(tx, "OIDC login transaction");
    const signed = await fetch(`${config.issuer}/login`, { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tx, email: partner.email, password: partner.password }) });
    assert.equal(signed.status, 303);
    const callback = await fetch(signed.headers.get("location"), { redirect: "manual", headers: { cookie } });
    assert.equal(callback.status, 303);
    const accountCookie = callback.headers.getSetCookie().find(c => c.startsWith("zion_account_local="))?.split(";")[0];
    assert.ok(accountCookie, "Runtime browser session cookie");
    const workbench = await fetch(`${config.runtimeUrl}/?space=${encodeURIComponent(team)}`, {
      headers: { cookie: accountCookie }, redirect: "manual" });
    assert.equal(workbench.status, 200);
    assert.match(await workbench.text(), /type="module"/);
    const teamIdentity = await ok(partner, team, "/v1/account/me");
    const ownIdentity = await ok(partner, partner.personalSpaceId, "/v1/account/me");
    assert.equal(teamIdentity.space.id, team);
    assert.equal(ownIdentity.space.id, partner.personalSpaceId);
  });
  await check("跨账号目录、搜索与受限文档隔离", async () => {
    await acl(config.restrictedDocumentId, { protection: "restricted", audienceMode: "specific", grants: managed });
    const catalog = await ok(partner, team, "/v1/workbench-state/catalog");
    assert.ok(JSON.stringify(catalog).includes(config.sharedDocumentId));
    assert.ok(!JSON.stringify(catalog).includes(config.restrictedDocumentId));
    assert.equal((await api(partner, team, `${endpoint}/documents/${config.restrictedDocumentId}`)).status, 404);
    assert.equal((await api(partner, owner.personalSpaceId, "/v1/workbench-state/catalog")).status, 403);
    const search = await ok(partner, team, "/v1/workbench-state/sessions?q=%E4%B8%AA%E4%BA%BA");
    assert.ok(!JSON.stringify(search).includes(config.personalDocumentId));
  });
  let testDocument;
  await check("成员通过默认资源使用提供者模型与真实 Node 只读目录", async () => {
    testDocument = await createDocument(team, "验收 · 授权调用", "user 读取共享文件\n");
    await acl(testDocument, sharedAudience);
    const accepted = await run(partner, testDocument, "读取共享文件");
    const result = await completed(partner, accepted.runId);
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.match(result.output, /明确分享的测试目录/);
    assert.ok(!result.output.includes(join(directory, "shared-folder")));
    const receipts = await readFile(join(directory, "device-receipts.jsonl"), "utf8");
    assert.match(receipts, /\/shared\/欢迎.txt/);
    const usage = await ok(owner, team, endpoint + "/usage");
    assert.ok(usage.reservations.some(r => r.runId === accepted.runId && r.bindingId === config.deviceBindingId && r.state === "settled"));
  });
  await check("Space 模型目录不暴露提供者配置与密钥", async () => {
    const { profiles: models } = await ok(partner, team, "/v1/models");
    assert.ok(models.length > 0);
    assert.ok(models.every(m => m.id.startsWith("space.")));
    assert.ok(!JSON.stringify(models).includes("55675"));
    const personalModel = await api(partner, team, "/v1/runs", { method: "POST",
      body: { sessionId: testDocument, messages: [{ role: "user", content: "unauthorized" }],
        model: { profileId: "spaces-local-fixture" } } });
    assert.equal(personalModel.status, 403);
  });
  await check("额度在调度前拦截，失败后可恢复使用", async () => {
    let usage = await ok(owner, team, endpoint + "/usage");
    const key = `member:${partner.userId}`;
    let budget = usage.budgets.find(b => b.scopeKey === key);
    await ok(owner, team, endpoint + "/budgets", "PUT", {
      scopeKey: key, hardLimit: budget.committed + budget.reserved, expectedRevision: budget.revision
    });
    const accepted = await run(partner, testDocument, "本次应由额度拦截");
    assert.equal((await completed(partner, accepted.runId)).status, "failed");
    usage = await ok(owner, team, endpoint + "/usage");
    budget = usage.budgets.find(b => b.scopeKey === key);
    await ok(owner, team, endpoint + "/budgets", "PUT", {
      scopeKey: key, hardLimit: null, expectedRevision: budget.revision
    });
    assert.equal((await completed(partner, (await run(partner, testDocument, "恢复后的调用")).runId)).status, "completed");
  });
  await check("同篇文档的并发回答按持久队列串行完成", async () => {
    const [first, second] = await Promise.all([run(owner, testDocument, "第一条队列回答"), run(partner, testDocument, "第二条队列回答")]);
    let queue = [];
    for (let i = 0; i < 100; i++) {
      queue = (await ok(owner, team, `${endpoint}/documents/${testDocument}/queue`)).queue;
      if (queue.filter(q => [first.runId, second.runId].includes(q.runId)).length === 2) break;
      await wait(20);
    }
    assert.equal(queue.filter(q => [first.runId, second.runId].includes(q.runId)).length, 2);
    const result = await Promise.all([completed(owner, first.runId), completed(partner, second.runId)]);
    assert.ok(result.every(r => r.status === "completed"));
  });
  await check("原生 Memory 文件按个人、共享文档和 ACL 隔离", async () => {
    assert.equal((await memory(owner, owner.personalSpaceId, null, "POST", "所有者个人记忆")).status, 200);
    assert.equal((await memory(owner, team, testDocument, "POST", "这篇共享文档的共同记忆")).status, 200);
    const read = await memory(partner, team, testDocument, "GET");
    assert.equal(read.status, 200); assert.match(read.value.content, /共同记忆/);
    assert.equal((await memory(partner, partner.personalSpaceId, null, "GET")).status, 404);
    assert.equal((await memory(partner, team, config.restrictedDocumentId, "GET")).status, 403);
    assert.equal((await memory(guest, team, config.guestDocumentId, "GET")).status, 403);
    const accepted = await run(partner, testDocument, "读取文档记忆");
    const result = await completed(partner, accepted.runId);
    assert.equal(result.status, "completed");
    assert.match(result.output, /共同记忆/);
    assert.ok(!result.output.includes("所有者个人记忆"));
  });
  await check("单篇访客附件可读，不能浏览空间或复用无关附件", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64");
    const upload = await api(owner, team, "/v1/assets", { method: "POST", body: png, raw: true, headers: { "content-type": "image/png" } });
    assert.equal(upload.status, 201);
    const asset = JSON.parse(upload.value.toString()).asset;
    const id = await createDocument(team, "验收 · 单篇附件", `user ![授权图片](zion-asset://${asset.id})\n`);
    await acl(id, guestAudience);
    config.acceptanceGuestDocumentId = id;
    const assetPath = `${endpoint}/documents/${id}/assets/${asset.id}`;
    const read = await api(guest, team, assetPath, { raw: true });
    assert.equal(read.status, 200); assert.deepEqual(read.value, png);
    assert.equal(read.response.headers.get("cache-control"), "no-store");
    assert.equal((await api(guest, team, "/v1/workbench-state/catalog")).status, 403);
    assert.equal((await api(guest, team, `/v1/assets/${asset.id}/content`, { raw: true })).status, 403);
    const comment = await ok(guest, team, `${endpoint}/documents/${id}/comments`, "POST", { body: "访客评论验收" });
    assert.equal(comment.comment.authorId, guest.userId);
    const outside = await api(guest, team, `${endpoint}/documents/${config.guestDocumentId}/assets/${asset.id}`, { raw: true });
    assert.equal(outside.status, 404);
    await acl(id, { protection: "restricted", audienceMode: "specific", grants: managed });
    assert.equal((await api(guest, team, assetPath, { raw: true })).status, 404);
    await acl(id, guestAudience);
  });
  await check("原生 CLI 审阅移动可用原清单重试，不重复创建文档", async () => {
    const source = await createDocument(owner.personalSpaceId, "验收 · 已审阅移动", "user 可以分享的摘要\n");
    const markdown = join(directory, "acceptance/reviewed.md");
    const manifest = join(directory, `acceptance/transfer-${randomUUID()}.json`);
    await writeFile(markdown, "user 已检查的共享摘要\n");
    const credentialStore = { get: async () => ({ origin: config.runtimeUrl, token: owner.token, expiresAt: Date.now() + 600000 }) };
    const output = new PassThrough(); output.resume();
    const environment = { ...process.env, ZION_RUNTIME_CLI_CONFIG: join(directory, "acceptance/no-config.json") };
    const args = ["--url", config.runtimeUrl, "--account", "--json"];
    const moved = await runRuntimeCli({ argv: ["share", source, "--space", owner.personalSpaceId,
      "--destination", team, "--markdown", markdown, "--reviewed", "--mode", "move",
      "--request-id", randomUUID(), "--request-file", manifest, ...args], output, credentialStore, environment });
    assert.ok(moved.document.id);
    const retry = await runRuntimeCli({ argv: ["share", "retry", "--space", team,
      "--request-file", manifest, "--reviewed", ...args], output, credentialStore, environment });
    assert.equal(retry.document.id, moved.document.id); assert.equal(retry.duplicate, true);
    assert.equal((await api(owner, owner.personalSpaceId, `/v1/workbench-state/sessions/${source}`)).status, 404);
    assert.ok(!JSON.stringify(await ok(partner, team, "/v1/workbench-state/catalog")).includes(moved.document.id));
  });
  await check("互联网快照仅发布审阅内容，原文受限，撤销即时生效", async () => {
    await acl(testDocument, { protection: "external", audienceMode: "specific", grants: managed });
    const { content, document } = await ok(owner, team, `${endpoint}/documents/${testDocument}`);
    const { publication } = await ok(owner, team, `${endpoint}/documents/${testDocument}/publications`, "POST", {
      title: "验收公开摘要", markdown: "只有这段人工审阅的摘要。",
      reviewed: true, sourceRevision: content.revision
    });
    const publicUrl = config.runtimeUrl + publication.path;
    const read = await fetch(publicUrl);
    assert.equal(read.status, 200); assert.match(await read.text(), /人工审阅的摘要/);
    await ok(owner, team, `${endpoint}/publications/${publication.id}`, "DELETE");
    assert.equal((await fetch(publicUrl)).status, 404);
    await acl(testDocument, sharedAudience);
  });
  await check("资源暂停后模型不可用，提供者恢复后重新可用", async () => {
    const resources = (await ok(owner, team, endpoint + "/capabilities")).capabilities;
    const binding = resources.find(r => r.id === config.modelBindingId);
    await ok(owner, team, `${endpoint}/capabilities/${binding.id}`, "PATCH", { expectedRevision: binding.revision, status: "disabled" });
    assert.equal((await api(partner, team, "/v1/models")).value.profiles.length, 0);
    const paused = (await ok(owner, team, endpoint + "/capabilities")).capabilities.find(r => r.id === binding.id);
    await ok(owner, team, `${endpoint}/capabilities/${binding.id}`, "PATCH", { expectedRevision: paused.revision, status: "active" });
    const { space } = await ok(owner, team, endpoint);
    await ok(owner, team, endpoint, "PATCH", { expectedRevision: space.revision, defaultBindingId: binding.id });
    assert.ok((await ok(partner, team, "/v1/models")).profiles.length > 0);
  });
  await check("原生 CLI 成员群组创建、修改和删除", async () => {
    const file = join(directory, "acceptance/group.json");
    await writeFile(file, JSON.stringify({ name: "验收群组", members: [partner.userId] }));
    const credentialStore = { get: async () => ({ origin: config.runtimeUrl, token: owner.token, expiresAt: Date.now() + 600000 }) };
    const output = new PassThrough(); output.resume();
    const options = { output, credentialStore, environment: {
      ...process.env, ZION_RUNTIME_CLI_CONFIG: join(directory, "acceptance/no-config.json")
    } };
    const args = ["--url", config.runtimeUrl, "--account", "--space", team, "--json"];
    const { group } = await runRuntimeCli({ ...options, argv: ["space", "group", "create", "--access-file", file, ...args] });
    assert.equal(group.name, "验收群组");
    await writeFile(file, JSON.stringify({ name: "验收群组已修改", members: [owner.userId, partner.userId] }));
    const edited = await runRuntimeCli({ ...options, argv: ["space", "group", "save", group.id, "--access-file", file, ...args] });
    assert.equal(edited.group.members.length, 2);
    await runRuntimeCli({ ...options, argv: ["space", "group", "remove", group.id, ...args] });
    assert.ok(!(await ok(owner, team, endpoint + "/groups")).groups.some(g => g.id === group.id));
  });
  await check("审计记录能追踪操作者与授权变更", async () => {
    const { events } = await ok(owner, team, endpoint + "/audit");
    assert.ok(events.some(event => JSON.stringify(event).includes("budget.changed")));
    assert.ok(events.some(event => JSON.stringify(event).includes("document.access_changed")));
    assert.ok(!JSON.stringify(events).includes(owner.token));
  });
  await writeFile(join(directory, "acceptance/config.json"), JSON.stringify({
    testDocumentId: testDocument, guestDocumentId: config.acceptanceGuestDocumentId
  }, null, 2));
} catch (error) {
  receipts.push({ name: "FAIL", status: "FAIL", error: error.message, at: Date.now() });
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, "acceptance/native-http.json"), JSON.stringify(receipts, null, 2));
}
