import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough, Readable } from "node:stream";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runChatCli } from "../src/chat-cli.mjs";
import { runRuntimeCli, resolveRuntimeCliTarget } from "../src/runtime-cli.mjs";
import { createSpacesClient } from "../../../packages/runtime-client/src/spaces.mjs";

let dir, environment;
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zioon-spaces-cli-"));
  environment = { TERM: "dumb", ZIOON_CHAT_STATE_DIR: dir, ZION_RUNTIME_CLI_CONFIG: join(dir, "missing.json") };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const credentialStore = { get: async () => ({ origin: "https://fixture.test", token: "zion_account_v1.fixture", expiresAt: Date.now() + 600000 }) };

function fixture() {
  const calls = [], sessions = new Map();
  const spaces = ["one", "two"].map(id => ({ id, name: `Space ${id}`, kind: "team", membership: { role: "member", status: "active" } }));
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const path = new URL(url).pathname, space = new Headers(init.headers).get("x-zioon-space-id");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, space, body, method: init.method || "GET" });
    if (path === "/v1/account/me") return json({ user: { id: "alice" }, space: spaces.find(s => s.id === space) || spaces[0] });
    if (path === "/v1/account/spaces") return json({ spaces });
    if (path === "/v1/sessions" && init.method === "POST") {
      const session = { id: `session-${space}`, title: body.title }; sessions.set(session.id, session); return json({ session });
    }
    if (path.endsWith("/messages")) return json({ runId: `run-${space}` });
    if (path.endsWith("/transcript")) return json({ messages: [] });
    if (path.endsWith("/active-run")) return json({ activeRun: null });
    if (path.includes("/sessions/")) return json({ session: sessions.get(path.split("/")[3]) });
    if (path.endsWith("/stream")) return new Response("", { headers: { "content-type": "text/event-stream" } });
    if (path.endsWith("/projection")) return json({ events: [] });
    if (path.includes("/runs/")) return json({ run: { status: "completed" } });
    if (path.endsWith("/documents/doc")) return json({ document: { id: "doc", aclRevision: 4 }, access: { role: "manager" },
      content: { title: "Reviewed", revision: 9, text: "original private" } });
    if (path.endsWith("/documents/transfer")) return json({ document: { id: "copy" } });
    return json({});
  });
  return { fetchImpl, calls };
}
describe("shared Space CLI and SDK", () => {
  it("pins each interactive chat, isolates recovery, and switches without leaking a Session", async () => {
    const f = fixture(), output = new PassThrough(); let text = ""; output.on("data", chunk => text += chunk);
    await runChatCli({ argv: ["--account", "--url", "https://fixture.test", "--space", "one", "--plain"],
      input: Readable.from(["first\n/space two\nsecond\n/exit\n"]), output, environment, credentialStore, fetchImpl: f.fetchImpl });
    const sends = f.calls.filter(c => c.path.endsWith("/messages"));
    expect(sends.map(c => [c.space, c.path])).toEqual([["one", "/v1/sessions/session-one/messages"], ["two", "/v1/sessions/session-two/messages"]]);
    expect(f.calls.filter(c => c.path.includes("/runs/")).every(c => ["one", "two"].includes(c.space))).toBe(true);
    expect(text).toContain("Space: Space one"); expect(text).toContain("Space: Space two");
    expect((await readdir(dir)).length).toBe(2);
    expect(f.calls.some(c => c.path === "/v1/account/spaces/select")).toBe(false);
  });
  it("keeps --space out of positional names and applies the environment default", async () => {
    const target = resolveRuntimeCliTarget({ argv: ["space", "create", "Together", "--space", "one"], environment });
    expect(target.spaceId).toBe("one"); expect(target.headers["x-zioon-space-id"]).toBe("one");
    expect(resolveRuntimeCliTarget({ argv: [], environment: { ...environment, ZIOON_SPACE_ID: "two" } }).spaceId).toBe("two");
    const f = fixture();
    await runRuntimeCli({ argv: ["space", "create", "Together", "--space", "one", "--url", "https://fixture.test"],
      environment, fetchImpl: f.fetchImpl, output: new PassThrough() });
    expect(f.calls.at(-1).body).toEqual({ name: "Together" });
    expect(f.calls.at(-1).space).toBe("one");
  });
  it("uses destination scope for reviewed transfers and sends only the reviewed content", async () => {
    const path = join(dir, "reviewed.md"); await writeFile(path, "safe reviewed text");
    const f = fixture();
    await runRuntimeCli({ argv: ["share", "doc", "--space", "one", "--url", "https://fixture.test",
      "--destination", "two", "--markdown", path, "--reviewed", "--request-id", "stable-reviewed-copy"],
      environment, fetchImpl: f.fetchImpl, output: new PassThrough() });
    const transfer = f.calls.at(-1);
    expect(transfer.space).toBe("two"); expect(transfer.body.markdown).toBe("safe reviewed text");
    expect(transfer.body.sourceSpaceId).toBe("one"); expect(transfer.body.sourceRevision).toBe(9);
    expect(transfer.body.sourceAclRevision).toBe(4); expect(transfer.body).not.toHaveProperty("metadata");
  });
  it("requires a reviewed-file flag and never sends unreviewed content", async () => {
    const f = fixture();
    await expect(runRuntimeCli({ argv: ["share", "doc", "--space", "one", "--url", "https://fixture.test", "--destination", "two"],
      environment, fetchImpl: f.fetchImpl, output: new PassThrough() })).rejects.toThrow("--reviewed");
    expect(f.calls.some(c => c.method === "POST")).toBe(false);
  });
  it("sets the explicit SDK target scope and propagates stale review errors", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"document_review_stale"}', { status: 409 }));
    const client = createSpacesClient({ baseUrl: "https://fixture.test", spaceId: "one", headers: { authorization: "Bearer test" }, fetchImpl });
    await expect(client.transfer("two", {})).rejects.toMatchObject({ status: 409, code: "document_review_stale" });
    expect(new Headers(fetchImpl.mock.calls[0][1].headers).get("x-zioon-space-id")).toBe("two");
    expect(new Headers(fetchImpl.mock.calls[0][1].headers).get("authorization")).toBe("Bearer test");
  });
});
