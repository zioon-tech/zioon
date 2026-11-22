import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { runRuntimeCli } from "../../apps/runtime/src/runtime-cli.mjs";
import { runChatCli } from "../../apps/runtime/src/chat-cli.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directory = join(repository, ".runtime-data/spaces-preview");
const config = JSON.parse(await readFile(join(directory, "config.local.json"), "utf8"));
const [owner, partner, guest] = config.accounts;
const receipts = [];
const api = async (account, path, body, scope, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(config.runtimeUrl + path, { method, headers: {
    authorization: `Bearer ${account.token}`, "x-zioon-space-id": account.personalSpaceId,
    "x-zion-workbench-protocol": "5", "content-type": "application/json",
    ...(scope ? { "x-zioon-content-space": owner.personalSpaceId, "x-zioon-content-document": scope } : {})
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  return { status: response.status, value: await response.json().catch(() => ({})) };
};
const ok = async (...args) => {
  const result = await api(...args);
  assert.ok(result.status < 300 && result.value.ok !== false, JSON.stringify(result));
  return result.value;
};
const check = async (name, action) => {
  await action(); receipts.push({ name, status: "PASS" }); console.log(`PASS ${name}`);
};
const environment = { ...process.env, TERM: "dumb", ZIOON_CHAT_STATE_DIR: join(directory, "acceptance/cli-sharing"),
  ZION_RUNTIME_CLI_CONFIG: join(directory, "cli-profiles.local.json") };
async function cli(account, args, lines, fetchImpl = globalThis.fetch) {
  const output = new PassThrough(); let text = "";
  output.on("data", chunk => text += chunk);
  const options = { output, environment, fetchImpl, credentialStore: { get: async () => ({
    origin: config.runtimeUrl, token: account.token, expiresAt: Date.now() + 600000 }) } };
  const argv = [...args, "--url", config.runtimeUrl, "--account"];
  const result = lines ? await runChatCli({ ...options, argv, input: Readable.from([lines]) })
    : await runRuntimeCli({ ...options, argv });
  return { result, text };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function complete(account, runId, documentId) {
  for (let i = 0; i < 600; i++) {
    const { run } = await ok(account, `/v1/runs/${encodeURIComponent(runId)}`, undefined, documentId);
    if (!["created", "queued", "running"].includes(run.status)) {
      assert.equal(run.status, "completed", JSON.stringify(run)); return run;
    }
    await sleep(25);
  }
  throw new Error("Run did not finish");
}
await mkdir(join(directory, "acceptance"), { recursive: true });
let privateSession, testDoc, testShare;
try {
  await check("真实 OIDC 登录进入自己的 Workbench，无需空间参数", async () => {
    const begin = await fetch(config.runtimeUrl + "/v1/account/login?returnTo=%2F", { redirect: "manual" });
    assert.equal(begin.status, 302);
    const cookie = begin.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    const form = await (await fetch(begin.headers.get("location"), { redirect: "manual" })).text();
    const tx = form.match(/name="tx" value="([^"]+)"/)?.[1];
    assert.ok(tx);
    const signed = await fetch(config.issuer + "/login", { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tx, email: partner.email, password: partner.password }) });
    assert.equal(signed.status, 303);
    const callback = await fetch(signed.headers.get("location"), { redirect: "manual", headers: { cookie } });
    assert.equal(callback.status, 303);
    const login = callback.headers.getSetCookie().find(c => c.startsWith("zion_account_local="))?.split(";")[0];
    assert.ok(login);
    const root = await fetch(config.runtimeUrl + "/", { headers: { cookie: login } });
    assert.equal(root.status, 200); assert.match(await root.text(), /type="module"/);
    const me = await (await fetch(config.runtimeUrl + "/v1/account/me", { headers: { cookie: login } })).json();
    assert.equal(me.space.id, partner.personalSpaceId);
  });
  await check("自己的模型与收到的模型并列，提供者配置不外泄", async () => {
    const { profiles } = await ok(partner, "/v1/models");
    assert.ok(profiles.some(p => !p.id.startsWith("share.")));
    const model = profiles.find(p => p.id === `share.${config.sharingModelId}`);
    assert.ok(model); assert.equal(model.metadata.providerName, owner.name);
    assert.ok(!JSON.stringify(model).includes("55675"));
    const result = await cli(partner, ["--plain"], "/model\n/exit\n");
    assert.match(result.text, /分享提供者 分享/);
    assert.ok(!result.text.includes("Space:"));
  });
  await check("CLI 用借来的模型生成，提供者不能读接收者的私密会话", async () => {
    const result = await cli(partner, ["--plain", "--model-profile", `share.${config.sharingModelId}`],
      `RECEIVER_PRIVATE_${randomUUID()}\n/exit\n`);
    privateSession = result.result.id;
    assert.match(result.text, /completed/);
    assert.equal((await api(owner, `/v1/sessions/${encodeURIComponent(privateSession)}`)).status, 404);
    assert.equal((await api(owner, `/v1/workbench-state/sessions/${encodeURIComponent(privateSession)}`)).status, 404);
    assert.equal((await api(partner, "/v1/workbench-state/catalog", undefined, config.sharingDocumentId)).status, 403);
  });
  await check("文件夹继承分享，私密子会话被过滤", async () => {
    const folder = await ok(partner, `/v1/sharing/${encodeURIComponent(config.sharingFolderShareId)}/documents`);
    assert.ok(JSON.stringify(folder.tree).includes(config.sharingFolderDocumentId));
    assert.ok(!JSON.stringify(folder.tree).includes(config.sharingPrivateChildId));
    assert.equal((await api(partner, `/v1/workbench-state/sessions/${encodeURIComponent(config.sharingPrivateChildId)}`,
      undefined, config.sharingPrivateChildId)).status, 404);
  });
  await check("CLI 接受邀请、编辑并生成于原始会话，草稿与私密目标分离", async () => {
    testDoc = `sharing-cli-${randomUUID()}`;
    await ok(owner, `/v1/workbench-state/sessions/${testDoc}`, { text: "user ORIGINAL_CLI_CONTEXT\nassistant 原文\nuser ",
      meta: { title: "验收 · 共享 CLI" } }, undefined, "PUT");
    const created = (await cli(owner, ["share", "document", testDoc, "--role", "editor", "--json"])).result;
    testShare = created.share.id;
    await cli(partner, ["share", "preview", created.invitation.url]);
    await cli(partner, ["share", "accept", created.invitation.url]);
    const prompt = `共享会话里使用借来的模型 ${randomUUID()}`;
    const generated = await cli(partner, ["--shared", testShare, "--plain"],
      `/model share.${config.sharingModelId}\n${prompt}\n/history\n/new\n/exit\n`);
    assert.match(generated.text, /completed/);
    assert.match(generated.text, /Private conversation/);
    const source = await ok(owner, `/v1/workbench-state/sessions/${testDoc}`);
    assert.ok(source.text.includes(prompt), source.text);
    assert.ok(source.text.includes("收到："), source.text);
    assert.equal((await api(partner, `/v1/sessions/${testDoc}`)).status, 404);
    const history = await ok(partner, `/v1/sessions/${testDoc}/transcript`, undefined, testDoc);
    assert.ok(history.messages.some(message => JSON.stringify(message.content).includes("ORIGINAL_CLI_CONTEXT")));
    assert.ok(!JSON.stringify(history).includes("RECEIVER_PRIVATE_"));
  });
  await check("共享会话允许自己的模型，原文写入完成后可重读", async () => {
    const source = (await ok(partner, "/v1/models")).profiles.find(p => p.id === "spaces-local-fixture");
    assert.ok(source);
    const generated = await cli(partner, ["--shared", testShare, "--plain", "--model-profile", source.id],
      "用我自己的模型补充计划\n/exit\n");
    assert.match(generated.text, /completed/);
    assert.ok((await ok(owner, `/v1/workbench-state/sessions/${testDoc}`)).text.includes("用我自己的模型补充计划"));
  });
  await check("CLI 接收回执丢失时查询持久回执，不重复提交", async () => {
    let submissions = 0, lost = false;
    const fetchImpl = async (url, init) => {
      const response = await fetch(url, init);
      if (new URL(url).pathname === "/v1/runs" && init?.method === "POST") {
        submissions++;
        if (!lost && response.status === 202) {
          lost = true; await response.json();
          throw new TypeError("Simulated connection loss after durable acceptance");
        }
      }
      return response;
    };
    const recovered = await cli(partner, ["--shared", testShare, "--plain", "--model-profile", "spaces-local-fixture"],
      "验证断线后的原请求恢复\n/recover\n/exit\n", fetchImpl);
    assert.ok(lost);
    assert.equal(submissions, 1);
    assert.match(recovered.text, /previous message was accepted/);
    assert.match(recovered.text, /completed/);
  });
  await check("只读会话可读原文，禁止文本修改与生成", async () => {
    const view = await cli(guest, ["--shared", config.sharingViewerShareId, "--plain"], "/history\nforbidden viewer send\n/exit\n");
    assert.match(view.text, /view-only/);
    const write = await api(guest, `/v1/workbench-state/sessions/${encodeURIComponent(config.sharingDocumentId)}`,
      { text: "forbidden" }, config.sharingDocumentId, "PUT");
    assert.equal(write.status, 404);
  });
  await check("共享文档 Memory 与个人 Memory 分离，HTTP 权限保持精确", async () => {
    const path = "/v1/plugins/dev.identity/files/write?path=user.md";
    await ok(owner, path, { path: "user.md", content: "OWNER_PRIVATE_MEMORY" });
    await ok(partner, path, { path: "user.md", content: "RECEIVER_PRIVATE_MEMORY" });
    await ok(partner, path + `&document=${testDoc}`, { path: "user.md", content: "SHARED_DOCUMENT_MEMORY" }, testDoc);
    const read = await ok(partner, `/v1/plugins/dev.identity/files/read?path=user.md&document=${testDoc}`, undefined, testDoc);
    assert.ok(JSON.stringify(read).includes("SHARED_DOCUMENT_MEMORY"));
    assert.ok(!JSON.stringify(read).includes("PRIVATE_MEMORY"));
    assert.ok(JSON.stringify(await ok(partner, "/v1/plugins/dev.identity/files/read?path=user.md")).includes("RECEIVER_PRIVATE_MEMORY"));
    for (const path of ["/v1/models", "/v1/workbench-state/catalog", "/v1/workbench-state/tree", "/v1/skills/snapshot"]) {
      assert.equal((await api(partner, path, undefined, testDoc)).status, 403);
    }
  });
  await check("撤销单人授权立即阻止原文和 Memory 访问", async () => {
    await cli(owner, ["share", "revoke", testShare, "--recipient", partner.userId]);
    assert.equal((await api(partner, `/v1/workbench-state/sessions/${testDoc}`, undefined, testDoc)).status, 404);
    assert.equal((await api(partner, `/v1/plugins/dev.identity/files/read?path=user.md&document=${testDoc}`, undefined, testDoc)).status, 404);
  });
  await writeFile(join(directory, "acceptance/sharing-config.json"), JSON.stringify({ privateSession, testDoc, testShare }, null, 2));
} finally {
  await writeFile(join(directory, "acceptance/sharing-http.json"), JSON.stringify({ status: receipts.length === 10 ? "PASS" : "INCOMPLETE", checks: receipts }, null, 2));
}
