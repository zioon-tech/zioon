import { describe, it, expect, vi } from "vitest";
import { PassThrough, Readable } from "node:stream";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuntimeCli } from "../src/runtime-cli.mjs";
import { runChatCli } from "../src/chat-cli.mjs";
import { sharedDocumentMessages } from "../src/cli-shared-content.mjs";

const token = "a".repeat(43);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const credentialStore = { get: async () => ({ origin: "https://fixture.test", token: "zion_account_v1.fixture", expiresAt: Date.now() + 600000 }) };
function fixture(role = "editor") {
  const calls = [];
  const share = { id: "share-doc", sourceId: "same-id", documentId: "same-id", originSpaceId: "owner",
    name: "共同计划", owner: { id: "alice", name: "Alice" }, kind: "document", role, status: "active" };
  const fetchImpl = vi.fn(async (input, init = {}) => {
    const path = new URL(input).pathname, headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    const call = { path, body, method: init.method || "GET", space: headers.get("x-zioon-space-id"),
      contentSpace: headers.get("x-zioon-content-space"), document: headers.get("x-zioon-content-document") };
    calls.push(call);
    if (path === "/v1/account/me") return json({ user: { id: "receiver" }, space: { id: "mine", kind: "personal" } });
    if (path === "/v1/sharing") return body ? json({ share, invitation: { url: `https://fixture.test/#share=${token}`, expiresAt: Date.now() + 100000 } }, 201) : json({ shares: [share] });
    if (path.endsWith("/preview")) return json({ share });
    if (path.endsWith("/accept")) return json({ share });
    if (path === "/v1/models") return json({ profiles: [{ id: "own", label: "自己的模型" }, { id: "borrowed", label: "借用模型", providerName: "Alice" }] });
    if (path.startsWith("/v1/workbench-state/sessions/")) return json({ id: "same-id", text: "user ORIGINAL_SHARED_CONTEXT\nassistant 原始回复\nuser ", meta: { title: "共同计划" } });
    if (path === "/v1/sessions" && init.method === "POST") return json({ session: { id: "same-id", title: "Private" } });
    if (path.endsWith("/active-run")) return json({ activeRun: null });
    if (path.endsWith("/transcript")) return json({ messages: [] });
    if (path === "/v1/runs" || path.endsWith("/messages")) return json({ runId: "run1" }, 202);
    if (path.endsWith("/stream")) return new Response("", { headers: { "content-type": "text/event-stream" } });
    if (path.endsWith("/projection")) return json({ events: [] });
    if (path.includes("/runs/")) return json({ run: { status: "completed" } });
    return json({});
  });
  return { calls, fetchImpl };
}
async function withCli(callback) {
  const dir = await mkdtemp(join(tmpdir(), "zioon-sharing-cli-"));
  const environment = { TERM: "dumb", ZIOON_CHAT_STATE_DIR: dir, ZION_RUNTIME_CLI_CONFIG: join(dir, "missing") };
  const output = new PassThrough(); let text = ""; output.on("data", chunk => text += chunk);
  try { return await callback({ dir, environment, output, text: () => text }); }
  finally { await rm(dir, { force: true, recursive: true }); }
}
describe("account sharing CLI", () => {
  it("reviews fragment invitations and accepts without switching identity", async () => withCli(async env => {
    const f = fixture();
    await runRuntimeCli({ argv: ["share", "accept", `https://fixture.test/#share=${token}`, "--url", "https://fixture.test", "--account"],
      ...env, credentialStore, fetchImpl: f.fetchImpl });
    expect(f.calls.slice(-2).map(c => c.path)).toEqual(["/v1/sharing/preview", "/v1/sharing/accept"]);
    expect(f.calls.at(-1).body).toEqual({ token });
    expect(f.calls.every(c => !c.contentSpace && !/contacts|members|select/.test(c.path))).toBe(true);
    expect(env.text()).toContain("Alice");
  }));
  it("creates model/document links with bounded options and rejects invalid roles before mutation", async () => withCli(async env => {
    const f = fixture();
    await runRuntimeCli({ argv: ["share", "model", "own", "--limit", "50", "--claims", "1", "--url", "https://fixture.test", "--json"],
      ...env, fetchImpl: f.fetchImpl });
    expect(f.calls.at(-1).body).toMatchObject({ kind: "model", sourceId: "own", monthlyCalls: 50, maxClaims: 1 });
    await expect(runRuntimeCli({ argv: ["share", "document", "doc", "--role", "admin"], ...env, fetchImpl: f.fetchImpl })).rejects.toThrow("viewer or editor");
    expect(f.calls.filter(c => c.method === "POST")).toHaveLength(1);
  }));
  it("keeps models own-account and shared generations bound to original document history", async () => withCli(async env => {
    const f = fixture();
    await runChatCli({ argv: ["--account", "--url", "https://fixture.test", "--shared", "share-doc", "--plain"],
      input: Readable.from(["/model\n/model borrowed\ncontinue shared\n/new\nprivate again\n/exit\n"]),
      ...env, credentialStore, fetchImpl: f.fetchImpl });
    const generation = f.calls.find(c => c.path === "/v1/runs");
    expect(generation).toMatchObject({ space: "mine", contentSpace: "owner", document: "same-id" });
    expect(generation.body.model).toEqual({ profileId: "borrowed" });
    expect(generation.body.messages[0].content).toBe("ORIGINAL_SHARED_CONTEXT");
    expect(generation.body.conversationInput.clientRequestId).toBeTruthy();
    expect(f.calls.filter(c => c.path === "/v1/models").every(c => c.space === "mine" && !c.contentSpace)).toBe(true);
    expect(f.calls.find(c => c.path.endsWith("/messages"))).toMatchObject({ space: "mine", contentSpace: null });
    expect(await readdir(env.dir)).toHaveLength(2);
    expect(env.text()).toContain("Alice 分享"); expect(env.text()).toContain("Private conversation");
  }));
  it("keeps viewer drafts without submitting, uploading or mutating content", async () => withCli(async env => {
    const f = fixture("viewer");
    await runChatCli({ argv: ["--account", "--url", "https://fixture.test", "--shared", "share-doc", "--plain"],
      input: Readable.from(["viewer draft\n/exit\n"]), ...env, credentialStore, fetchImpl: f.fetchImpl });
    expect(f.calls.some(c => ["POST", "PUT", "PATCH"].includes(c.method))).toBe(false);
    expect(env.text()).toContain("view-only");
  }));
  it("uses lexical boundaries for fenced roles, markers and document image references", () => {
    const messages = sharedDocumentMessages("user text\n![image](zion-asset://abc)\nassistant <!-- zion-assistant:id=r --> answer\n```md\nuser literal\n```\nassistant 思考 <!-- zion-thinking:id=x -->\nuser ");
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContainEqual({ type: "image_url", image_url: { url: "zion-asset://abc" } });
    expect(messages[1].content).toContain("user literal");
    expect(messages[1].content).not.toContain("zion-");
  });
});
