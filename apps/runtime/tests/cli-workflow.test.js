import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { runChatCli } from "../src/chat-cli.mjs";
import { ChatInput } from "../src/cli-input.mjs";
import { chatStateDirectory, createChatState } from "../src/cli-chat-state.mjs";
import { readTextAttachment, completeFilePath } from "../src/cli-files.mjs";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
let dir, environment;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zioon-workflow-"));
  environment = { TERM: "xterm-256color", ZIOON_CHAT_STATE_DIR: dir, ZION_RUNTIME_CLI_CONFIG: join(dir, "absent.json") };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function fixture() {
  const sessions = new Map(), messages = new Map(), commands = new Map();
  const calls = []; let loseResponse = false;
  const fetch = vi.fn(async (url, init = {}) => {
    const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path, method: init.method || "GET", body });
    if (path === "/v1/models") return json({ activeProfileId: "fast", profiles: [
      { id: "fast", label: "Fast", available: true }, { id: "smart", available: true }, { id: "missing", available: false }
    ] });
    if (path.includes("/plugins/")) return json({ result: { status: "completed", initialTokens: 1000, finalTokens: 500, savedTokens: 500 } });
    if (path === "/v1/runs" && init.method === "POST") {
      sessions.set(body.sessionId, { id: body.sessionId, title: body.title, model: body.model });
      // Runtime's seed contract strips the final user turn from sessionHistory.
      messages.set(body.sessionId, [...body.sessionHistory.slice(0, -1), { role: "user", content: body.messages.at(-1).content, runId: "r-branch" }]);
      return json({ runId: "r-branch" });
    }
    if (path === "/v1/sessions" && init.method === "POST") {
      const session = { ...body, id: `s${sessions.size + 1}` }; sessions.set(session.id, session);
      return json({ session });
    }
    if (path === "/v1/sessions") return json({ sessions: [...sessions.values()] });
    const [, , , id, action] = path.split("/");
    if (path.startsWith("/v1/sessions/")) {
      if (action === "messages") {
        if (commands.has(body.clientRequestId)) return json(commands.get(body.clientRequestId));
        const accepted = { runId: `r${commands.size + 1}` }; commands.set(body.clientRequestId, accepted);
        const transcript = messages.get(id) || [];
        transcript.push({ id: `m${transcript.length + 1}`, role: "user", content: body.content, clientRequestId: body.clientRequestId, runId: accepted.runId },
          { id: `m${transcript.length + 2}`, role: "assistant", content: "**回答**" });
        messages.set(id, transcript);
        if (loseResponse) { loseResponse = false; throw new TypeError("fetch failed"); }
        return json(accepted);
      }
      if (action === "transcript") return json({ messages: messages.get(id) || [] });
      if (action === "active-run") return json({ activeRun: null });
      if (init.method === "PATCH") sessions.set(id, { ...sessions.get(id), ...body });
      return sessions.has(id) ? json({ session: sessions.get(id) }) : json({ error: "Not found" }, 404);
    }
    if (path.includes("/stream")) return new Response('data: {"sequence":1,"type":"message.delta","data":{"delta":"answer"}}\n\n', { headers: { "content-type": "text/event-stream" } });
    if (path.endsWith("/projection")) return json({ events: [] });
    return json({ run: { status: "completed" } });
  });
  return { fetch, calls, sessions, messages, commands, loseNextResponse() { loseResponse = true; } };
}
async function chat(f, text, args = []) {
  let result = ""; const output = new PassThrough(); output.on("data", (chunk) => result += chunk);
  await runChatCli({ argv: ["--url", "http://fixture.test", ...args], input: Readable.from([text]), output, environment, fetchImpl: f.fetch });
  return result;
}

describe("durable chat workflows", () => {
  it("creates no remote Session for empty chat or local commands", async () => {
    const f = fixture();
    await chat(f, "/help\n/new\n/status\n/exit\n");
    expect(f.calls).toEqual([]);
  });
  it("does not submit when durable recovery storage is unwritable", async () => {
    const path = join(dir, "not-a-directory"); await writeFile(path, "retained");
    environment.ZIOON_CHAT_STATE_DIR = path;
    const f = fixture();
    expect(await chat(f, "keep this\n/exit\n")).toContain("Cannot persist recovery state");
    expect(f.calls).toHaveLength(0);
    expect(await readFile(path, "utf8")).toBe("retained");
  });
  it("continues the last local Session across processes without creating another", async () => {
    const f = fixture();
    await chat(f, "你好\n/exit\n");
    await chat(f, "接着说\n/exit\n", ["--continue"]);
    expect(f.sessions.size).toBe(1);
    expect(f.messages.get("s1").filter((m) => m.role === "user").map((m) => m.content)).toEqual(["你好", "接着说"]);
  });
  it("reconciles a lost acceptance response by request ID without resending", async () => {
    const f = fixture(); f.loseNextResponse();
    expect(await chat(f, "only once\n/exit\n")).toContain("Acceptance unconfirmed");
    const result = await chat(f, "/recover\n/exit\n", ["--continue"]);
    expect(result).toContain("was accepted");
    expect(f.commands.size).toBe(1);
    expect(f.calls.filter((c) => c.path.endsWith("/messages"))).toHaveLength(1);
  });
  it("explicit retry reuses the original ID and content", async () => {
    const f = fixture(); f.loseNextResponse();
    await chat(f, "original\n/exit\n");
    await chat(f, "/recover retry\n/exit\n", ["--continue"]);
    const sends = f.calls.filter((c) => c.path.endsWith("/messages"));
    expect(sends).toHaveLength(2);
    expect(sends[0].body).toEqual(sends[1].body);
    expect(f.commands.size).toBe(1);
  });
  it("keeps defaults separate from saved conversation model and blocks unavailable models", async () => {
    const f = fixture();
    await chat(f, "/model smart\none\n/model default fast\n/model missing\n/exit\n");
    expect(f.sessions.get("s1").model.profileId).toBe("smart");
    await chat(f, "two\n/exit\n");
    expect(f.sessions.get("s2").model.profileId).toBe("fast");
    await chat(f, "/model fast\n/exit\n", ["--session", "s1"]);
    expect(f.sessions.get("s1").model.profileId).toBe("fast");
  });
  it("exports original Markdown, searches and compresses while preserving transcript", async () => {
    const f = fixture(), path = join(dir, "conversation.md");
    const result = await chat(f, `needle\n/search needle\n/context\n/compact force\n/export ${path}\n/exit\n`);
    expect(result).toContain("1 · user");
    expect(result).toContain("500 tokens saved");
    expect(await readFile(path, "utf8")).toContain("**回答**");
    expect(f.messages.get("s1")).toHaveLength(2);
  });
  it("skips model compaction for short history while offering an explicit override", async () => {
    const f = fixture();
    expect(await chat(f, "short\n/compact\n/exit\n")).toContain("Compression skipped; original context retained");
    expect(f.calls.some((call) => call.body.action === "compact")).toBe(false);
  });
  it("branches at a message and restores a staged branch on continue", async () => {
    const f = fixture();
    await chat(f, "first\nsecond\n/fork 2\n/exit\n");
    await chat(f, "new direction\n/exit\n", ["--continue"]);
    const seeded = f.calls.find((c) => c.path === "/v1/runs");
    expect(seeded.body.sessionHistory.map((m) => m.content)).toEqual(["first", "**回答**", "new direction"]);
    expect(seeded.body.messages.at(-1).content).toBe("new direction");
    expect(f.messages.get("s1").filter((m) => m.role === "user")).toHaveLength(2);
    expect(f.messages.get(seeded.body.sessionId).map((m) => m.content)).toEqual(["first", "**回答**", "new direction"]);
  });
  it("attaches file contents only on next send and clears accepted attachments", async () => {
    const f = fixture(), path = join(dir, "有 空格.md"); await writeFile(path, "explicit source");
    await chat(f, `/file ${path}\nquestion\nnext\n/exit\n`);
    const sends = f.calls.filter((c) => c.path.endsWith("/messages"));
    expect(sends[0].body.content).toContain("explicit source");
    expect(sends[1].body.content).toBe("next");
  });
  it("bounds aggregate attachments by UTF-8 bytes rather than string length", async () => {
    const f = fixture(), path = join(dir, "中文.md");
    await writeFile(path, "中".repeat(16 * 1024));
    const result = await chat(f, `/file ${path}\n/file ${path}\n/file ${path}\n/exit\n`);
    expect(result).toContain("Attachments exceed 96 KiB");
    expect(f.calls).toHaveLength(0);
  });
});

describe("recovery storage and composer", () => {
  it("uses platform-native user data directories and respects explicit overrides", () => {
    expect(chatStateDirectory({}, "darwin", "/Users/test")).toBe("/Users/test/Library/Application Support/Zioon/chat");
    expect(chatStateDirectory({ XDG_STATE_HOME: "/state" }, "linux", "/home/test")).toBe("/state/zioon/chat");
    expect(chatStateDirectory({ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "win32", "C:\\Users\\test")).toBe("C:\\Users\\test\\AppData\\Local\\Zioon\\chat");
    expect(chatStateDirectory({ ZIOON_CHAT_STATE_DIR: "/explicit" }, "darwin", "/test")).toBe("/explicit");
  });
  it("isolates identities and endpoints and writes private atomic records", async () => {
    const a = createChatState({ baseUrl: "https://a.test", identity: "user-a", environment });
    const b = createChatState({ baseUrl: "https://a.test", identity: "user-b", environment });
    const c = createChatState({ baseUrl: "https://b.test", identity: "user-a", environment });
    await a.write("session:s", { draft: "私密草稿" });
    expect(await b.read("session:s")).toEqual({});
    expect(await c.read("session:s")).toEqual({});
    const [name] = await readdir(a.root);
    expect(name).not.toContain("user-a");
    if (process.platform !== "win32") expect((await stat(join(a.root, name))).mode & 0o777).toBe(0o600);
    expect(await a.read("session:s")).toEqual({ draft: "私密草稿" });
  });
  it("retains a corrupt recovery record rather than overwriting its contents", async () => {
    const errors = [];
    const store = createChatState({ baseUrl: "http://test", environment, onError: (error) => errors.push(error) });
    await store.write("session:s", { draft: "original" });
    const [name] = await readdir(store.root), path = join(store.root, name);
    await writeFile(path, "{broken");
    expect(await store.write("session:s", { draft: "new" })).toBe(false);
    expect(await readFile(path, "utf8")).toBe("{broken");
    expect(errors.length).toBeGreaterThan(0);
  });
  it("searches slash descriptions and selects without sending", async () => {
    const input = new PassThrough(), output = new PassThrough(); output.resume();
    input.isTTY = output.isTTY = true; input.setRawMode = () => {};
    const composer = new ChatInput(input, output, { environment });
    try {
      const pending = composer.read();
      input.write("/\t\x1b[B\t");
      expect(composer.text).toBe("/sessions"); expect(composer.active).toBe(true);
      input.write("\r"); expect(await pending).toBe("/sessions");
    } finally { composer.close(); }
  });
  it("rejects oversized and binary attachments and completes Chinese paths", async () => {
    await writeFile(join(dir, "中文.txt"), "ok");
    expect((await completeFilePath(`/file ${dir}/中`))[0].id).toBe(`/file ${dir}/中文.txt`);
    await writeFile(join(dir, "large"), "x".repeat(49 * 1024));
    await expect(readTextAttachment(join(dir, "large"))).rejects.toThrow("48 KiB");
    await writeFile(join(dir, "binary"), Buffer.from([0, 1, 2]));
    await expect(readTextAttachment(join(dir, "binary"))).rejects.toThrow("UTF-8");
  });
  it("searches history without submitting and keeps path completion in the current read", async () => {
    const input = new PassThrough(), output = new PassThrough(); output.resume();
    input.isTTY = output.isTTY = true; input.setRawMode = () => {};
    const composer = new ChatInput(input, output, { environment });
    try {
      composer.history = ["第一条", "another", "第二条"];
      const pending = composer.read();
      input.write("keep\x12第二\r");
      expect(composer.text).toBe("第二条"); expect(composer.active).toBe(true);
      composer.setDraft(`/file ${dir}/`);
      await writeFile(join(dir, "a.txt"), "a"); await writeFile(join(dir, "b.txt"), "b");
      input.write("\t"); await tick();
      expect(composer.picker).toHaveLength(2);
      input.write("\r"); expect(composer.text).toBe(`/file ${dir}/a.txt`); expect(composer.active).toBe(true);
      input.write("\r"); expect(await pending).toBe(`/file ${dir}/a.txt`);
    } finally { composer.close(); }
  });
  it("keeps an unfinished draft on EOF without sending it", async () => {
    const input = new PassThrough(), output = new PassThrough(); output.resume();
    input.isTTY = output.isTTY = true; input.setRawMode = () => {};
    const composer = new ChatInput(input, output, { environment }); let draft = "";
    composer.onDraft = (value) => draft = value;
    try {
      const pending = composer.read(); input.write("unsent"); input.end();
      expect(await pending).toBeNull(); expect(draft).toBe("unsent");
    } finally { composer.close(); }
  });
});
