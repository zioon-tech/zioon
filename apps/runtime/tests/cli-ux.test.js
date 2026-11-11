import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { ChatInput } from "../src/cli-input.mjs";
import { cellWidth, createAnswerRenderer, safeText, terminalTheme } from "../src/cli-terminal.mjs";
import { followCliRun } from "../src/cli-run-follow.mjs";
import { runChatCli } from "../src/chat-cli.mjs";
import { runChatShell } from "../src/cli-chat-shell.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const event = (sequence, delta) => ({ sequence, type: "message.delta", data: { delta } });
const sse = (events) => new Response(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
let stateDirectory;
beforeEach(() => { stateDirectory = mkdtempSync(join(tmpdir(), "zioon-ux-test-")); });
afterEach(() => { rmSync(stateDirectory, { recursive: true, force: true }); });
function terminal() {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = (value) => { input.isRaw = value; };
  output.columns = 80; output.rows = 24;
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  const composer = new ChatInput(input, output, { environment: { TERM: "xterm-256color" } });
  return { input, output, composer, text: () => text };
}

describe("terminal composer", () => {
  it("keeps fragmented Chinese multiline bracketed paste as one draft", async () => {
    const t = terminal();
    try {
      const value = t.composer.read();
      for (const bytes of [Buffer.from("\x1b["), Buffer.from("200~"), ...Array.from(Buffer.from("你好🙂\n第二行"), (byte) => Buffer.from([byte])), Buffer.from("\x1b[20"), Buffer.from("1~")]) t.input.write(bytes);
      expect(t.composer.text).toBe("你好🙂\n第二行");
      expect(t.composer.active).toBe(true);
      t.input.write("\r");
      expect(await value).toBe("你好🙂\n第二行");
    } finally { t.composer.close(); }
    expect(t.input.isRaw).toBe(false);
    expect(t.text()).toContain("\x1b[?2004l");
  });
  it("does not execute pasted control keys or slash commands before Enter", async () => {
    const t = terminal();
    try {
      const value = t.composer.read();
      t.input.write("\x1b[200~/exit\n\x03\x1b[31mnot yet\x1b[201~");
      expect(t.composer.active).toBe(true);
      expect(t.composer.text).toBe("/exit\nnot yet");
      t.input.write("\r"); expect(await value).toBe("/exit\nnot yet");
    } finally { t.composer.close(); }
  });
  it("edits emoji clusters without corrupting UTF-16 and restores history drafts", async () => {
    const t = terminal();
    try {
      const first = t.composer.read();
      t.input.write("A👩‍💻中\x1b[D\x7f\r");
      expect(await first).toBe("A中");
      const next = t.composer.read();
      t.input.write("draft\x1b[A"); expect(t.composer.text).toBe("A中");
      t.input.write("\x1b[B"); expect(t.composer.text).toBe("draft");
      t.input.write("\r"); expect(await next).toBe("draft");
    } finally { t.composer.close(); }
  });
  it("supports Tab, Alt+Enter, Ctrl+J and backslash continuation", async () => {
    const t = terminal();
    try {
      let next = t.composer.read();
      t.input.write("/sessio\t"); expect(t.composer.text).toBe("/sessio");
      t.input.write("n\t"); expect(t.composer.text).toBe("/session");
      t.input.write("\r"); expect(await next).toBe("/session");
      next = t.composer.read();
      t.input.write("one\x1b\rtwo\nthree\\\rfour\r");
      expect(await next).toBe("one\ntwo\nthree\nfour");
    } finally { t.composer.close(); }
  });
  it("clears a draft on Ctrl+C and cancels a busy Run without exiting", async () => {
    const t = terminal();
    let cancellations = 0; t.composer.onCancel = () => cancellations++;
    try {
      const next = t.composer.read();
      t.input.write("discard\x03"); expect(t.composer.text).toBe("");
      t.input.write("send\r"); expect(await next).toBe("send");
      t.input.write("\x03"); expect(cancellations).toBe(1);
      t.input.write("next draft\r"); expect(t.composer.text).toBe("next draft");
      const draft = t.composer.read(); t.input.write("\r"); expect(await draft).toBe("next draft");
    } finally { t.composer.close(); }
  });
  it("searches and selects conversations, and allows Escape to back out", async () => {
    const t = terminal();
    try {
      const choice = t.composer.choose([{ id: "s1", label: "Travel" }, { id: "s2", label: "中文计划" }]);
      t.input.write("中文\r"); expect(await choice).toBe("s2");
      const cancelled = t.composer.choose([{ id: "s1", label: "Travel" }]);
      t.composer.key("escape"); expect(await cancelled).toBeNull();
    } finally { t.composer.close(); }
  });
  it("handles narrow resize, wide characters and multiline navigation", async () => {
    const t = terminal();
    try {
      const next = t.composer.read();
      t.input.write("\x1b[200~中文🙂\n👩‍💻ABC\x1b[201~");
      t.output.columns = 20; t.output.rows = 8; t.output.emit("resize");
      t.input.write("\x01\x1b[C\x1b[A\x7f\r");
      expect(await next).toBe("文🙂\n👩‍💻ABC");
      expect(t.text()).not.toContain("NaN");
    } finally { t.composer.close(); }
  });
  it("rejects oversized paste without silently truncating the sent draft", async () => {
    const t = terminal();
    try {
      const next = t.composer.read();
      t.input.write("keep\x1b[200~" + "x".repeat(70_000) + "\x1b[201~");
      expect(t.composer.text).toBe("keep");
      expect(t.composer.notice).toMatch(/exceeds/);
      t.input.write("\r"); expect(await next).toBe("keep");
    } finally { t.composer.close(); }
  });
  it("preserves all piped lines and EOF while the consumer is busy", async () => {
    const output = new PassThrough();
    const composer = new ChatInput(Readable.from(["one\ntwo\nthree\n"]), output);
    try {
      await tick();
      expect(await composer.read()).toBe("one");
      await tick();
      expect(await composer.read()).toBe("two");
      expect(await composer.read()).toBe("three");
      expect(await composer.read()).toBeNull();
    } finally { composer.close(); }
  });
});

describe("stream recovery", () => {
  it("deduplicates replay and drains deltas committed at terminal transition", async () => {
    const requests = [], seen = [];
    const fetchImpl = async (url) => {
      requests.push(url);
      if (url.includes("/stream")) return sse([event(1, "a"), event(1, "a")]);
      if (url.includes("/projection?")) return json({ events: [event(1, "a"), event(2, "b")] });
      return json({ run: { id: "r1", status: "completed" } });
    };
    await followCliRun({ baseUrl: "http://test", runId: "r1", fetchImpl, onEvent: (e) => seen.push(e.data.delta) });
    expect(seen).toEqual(["a", "b"]);
    expect(requests[1]).toBe("http://test/v1/runs/r1");
    expect(requests[2]).toContain("after=1");
  });
  it("falls back to raw events when projection is unsupported", async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      if (url.includes("/projection")) return json({ error: "Not found" }, 404);
      if (url.includes("/events?")) return json({ events: [event(1, "old server")] });
      return json({ run: { status: "completed" } });
    };
    await followCliRun({ baseUrl: "http://test", runId: "r", fetchImpl, onEvent: (e) => seen.push(e.data.delta) });
    expect(seen).toEqual(["old server"]);
  });
  it("reconnects after a broken stream using its durable cursor", async () => {
    let streams = 0, snapshots = 0;
    const cursors = [], seen = [];
    const fetchImpl = async (url) => {
      if (url.includes("/stream")) {
        cursors.push(new URL(url).searchParams.get("after"));
        return sse([event(++streams, streams === 1 ? "first" : "second")]);
      }
      if (url.includes("/projection?")) return json({ events: [] });
      return json({ run: { status: ++snapshots === 1 ? "running" : "completed" } });
    };
    await followCliRun({ baseUrl: "http://test", runId: "r", fetchImpl, pollIntervalMs: 0, onEvent: (e) => seen.push(e.data.delta) });
    expect(cursors).toEqual(["0", "1"]); expect(seen).toEqual(["first", "second"]);
  });
  it("propagates cancellation through fallback HTTP reads", async () => {
    const controller = new AbortController();
    let pendingRead;
    const ready = new Promise((resolve) => { pendingRead = resolve; });
    const fetchImpl = async (url, { signal }) => {
      if (url.includes("/stream")) return json({}, 404);
      pendingRead();
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    };
    const result = followCliRun({ baseUrl: "http://test", runId: "r", fetchImpl, signal: controller.signal });
    await ready; controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(result).rejects.toThrow("Stopped");
  });
  it("surfaces authorization failures immediately without retrying", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return json({ error: "Unauthorized" }, 401); };
    await expect(followCliRun({ baseUrl: "http://test", runId: "r", fetchImpl })).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("bounds repeated network failures instead of hanging forever", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; throw new Error("offline"); };
    await expect(followCliRun({ baseUrl: "http://test", runId: "r", fetchImpl, pollIntervalMs: 0 })).rejects.toThrow("offline");
    expect(calls).toBe(6);
  });
});

describe("chat shell and rendering", () => {
  it("submits piped prompts in order across delayed session initialization", async () => {
    const prompts = [], output = new PassThrough(); let text = "";
    output.on("data", (chunk) => { text += chunk; });
    const fetchImpl = async (url, options = {}) => {
      if (url.endsWith("/sessions")) { await tick(); return json({ session: { id: "s", title: "Test" } }); }
      if (url.endsWith("/messages")) { prompts.push(JSON.parse(options.body).content); return json({ runId: `r${prompts.length}` }); }
      if (url.includes("/stream")) return sse([event(1, "answer")]);
      if (url.includes("/projection?")) return json({ events: [] });
      return json({ run: { status: "completed" } });
    };
    await runChatCli({ argv: ["--url", "http://test"], environment: { ZIOON_CHAT_STATE_DIR: stateDirectory }, input: Readable.from(["one\ntwo\n/typo\n/exit\n"]), output, fetchImpl });
    expect(prompts).toEqual(["one", "two"]); expect(text).toContain("Unknown command: /typo");
    expect(text).not.toContain("\x1b");
  });
  it("sends one abort, confirms its status, and preserves the conversation", async () => {
    const t = terminal();
    let aborts = 0, began;
    const ready = new Promise((resolve) => { began = resolve; });
    const client = {
      sendMessage: async () => ({ runId: "r" }),
      abortRun: async () => { aborts++; return { status: "accepted" }; },
      getRun: async () => ({ status: "aborted" }),
      followRun: async (_, __, { signal }) => {
        began();
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      }
    };
    const result = runChatShell({ client, session: { id: "s" }, sessionOptions: {}, baseUrl: "http://test", composer: t.composer, output: t.output, environment: {} });
    try {
      t.input.write("hello\r"); await ready;
      t.input.write("\x03\x03"); await tick();
      expect(aborts).toBe(1); expect(t.text()).toContain("[aborted]");
      t.input.write("/exit\r"); expect((await result).id).toBe("s");
    } finally { t.composer.close(); }
  });
  it("removes terminal control injection and honors NO_COLOR and dumb terminals", () => {
    expect(safeText("\x1b[2Jok\x1b]52;c;secret\x07\u202eevil")).toBe("okevil");
    expect(cellWidth("中文👩‍💻e\u0301")).toBe(7);
    expect(terminalTheme({ isTTY: true }, { NO_COLOR: "" }).bold("ok")).toBe("ok");
    expect(terminalTheme({ isTTY: true }, { TERM: "dumb" }).interactive).toBe(false);
  });
  it("batches tiny streaming tokens and flushes the exact final text", () => {
    const chunks = [], output = { write: (text) => chunks.push(text) };
    const renderer = createAnswerRenderer(output, terminalTheme(output, {}));
    for (let i = 0; i < 5000; i++) renderer.write("中");
    renderer.end();
    expect(chunks.join("")).toBe("中".repeat(5000) + "\n");
    expect(chunks.length).toBeLessThan(5);
  });
});
