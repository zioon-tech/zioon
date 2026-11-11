import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { createActivityFeed } from "../src/cli-activity-feed.mjs";
import { createActivity, terminalTheme, safeText, cellWidth } from "../src/cli-terminal.mjs";
import { ChatInput } from "../src/cli-input.mjs";

const captured = (columns = 90) => {
  const output = new PassThrough(); output.isTTY = true; output.columns = columns; output.rows = 24;
  let text = ""; output.on("data", (value) => text += value.toString());
  return { output, text: () => text, theme: terminalTheme(output, { TERM: "xterm", COLORFGBG: "0;15" }) };
};
const harness = (options = {}, width) => {
  const io = captured(width), activity = createActivity(io.output, io.theme);
  const feed = createActivityFeed(io.output, io.theme, { activity, ...options });
  return { ...io, activity, feed };
};
const event = (type, data) => ({ type, data });
afterEach(() => vi.useRealTimers());

describe("readable Run activity", () => {
  it("commits a sixty-call burst once and keeps actual calls inspectable", () => {
    const { feed, text } = harness();
    for (let i = 0; i < 60; i++) {
      feed.event(event("tool.requested", { callId: `c${i}`, name: "Bash", arguments: { command: `inspect ${i}` } }));
      feed.event(event("tool.completed", { callId: `c${i}`, ok: true, result: "done" }));
    }
    feed.beforeAnswer(); feed.finish("completed");
    const lines = safeText(text()).split("\n").filter((s) => s.includes("✓"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Run command ×60");
    expect(feed.count).toBe(60);
    expect(feed.tools).toHaveLength(60);
    expect(feed.tools[20].request.arguments.command).toBe("inspect 20");
  });

  it("correlates out-of-order same-name tools and treats completed ok:false as failure", () => {
    const { feed, text } = harness();
    feed.event(event("tool.requested", { callId: "a", name: "Bash" }));
    feed.event(event("tool.requested", { callId: "b", name: "Bash" }));
    feed.event(event("tool.completed", { callId: "b", ok: false, error: "Permission denied" }));
    expect(feed.tools[0].status).toBe("running");
    expect(feed.tools[1].status).toBe("failed");
    feed.event(event("tool.completed", { callId: "a", ok: true }));
    feed.finish("completed");
    expect(safeText(text())).toContain("Permission denied");
    expect(safeText(text())).toContain("Run completed with tool failures");
    expect(feed.count).toBe(2);
  });

  it("deduplicates lifecycle replay by ID without collapsing independent calls", () => {
    const { feed } = harness();
    for (const id of ["a", "a", "b"]) feed.event(event("tool.requested", { callId: id, name: "skillsList" }));
    for (const id of ["a", "b", "a"]) feed.event(event("tool.completed", { callId: id }));
    feed.finish("completed");
    expect(feed.count).toBe(2);
    expect(feed.tools.map((t) => t.status)).toEqual(["completed", "completed"]);
  });

  it("retains a denied call with no request and an unresolved call after detach", () => {
    const { feed, text } = harness();
    feed.event(event("tool.denied", { callId: "bad", name: "Bash", reason: "Invalid arguments" }));
    feed.event(event("tool.requested", { callId: "waiting", name: "Bash" }));
    feed.finish(); feed.finish();
    const output = safeText(text());
    expect(output).toContain("Invalid arguments");
    expect(output.match(/1 tool outcome unconfirmed/g)).toHaveLength(1);
    expect(feed.count).toBe(2);
  });

  it("separates confirmed thinking phases from prose without printing reasoning deltas", () => {
    let time = 0;
    const { feed, text, output } = harness({ now: () => time });
    feed.event(event("reasoning.progress", { projection: { deltaChars: 100 } }));
    time = 1000;
    feed.event(event("reasoning.delta", { delta: "private model payload" }));
    time = 2100;
    feed.beforeAnswer(); output.write("Answer\n"); feed.finish("completed");
    expect(safeText(text())).toContain("Thought for 2.1s\nAnswer");
    expect(safeText(text())).not.toContain("private model payload");
    expect(feed.thinkingMs).toBe(2100);
  });

  it("uses durable timestamps when replaying reasoning and tool events", () => {
    const { feed, text } = harness({ now: () => 999999 });
    feed.event({ ...event("reasoning.progress", {}), timestamp: 1000 });
    feed.event({ ...event("tool.requested", { callId: "a", name: "Read" }), timestamp: 2100 });
    feed.event({ ...event("tool.completed", { callId: "a", ok: true }), timestamp: 3600 });
    feed.beforeAnswer({ timestamp: 4000 }); feed.finish("completed");
    expect(feed.thinkingMs).toBe(1100);
    expect(feed.tools[0].elapsedMs).toBe(1500);
    expect(safeText(text())).toContain("Thought for 1.1s");
  });

  it("does not inject a status row into streamed prose when details are toggled", () => {
    const { feed, text, output } = harness();
    feed.beforeAnswer(); output.write("正在回答");
    const before = text();
    feed.setExpanded(true);
    expect(text()).toBe(before);
    output.write("。\n"); feed.finish("completed");
    expect(safeText(text())).toBe("正在回答。\n");
  });

  it("bounds expanded previews and removes malicious terminal controls", () => {
    const { feed, text } = harness({ expanded: true }, 42);
    feed.event(event("tool.requested", { callId: "a", name: "Bash", arguments: { command: "\x1b[2Jrm" } }));
    feed.event(event("tool.completed", { callId: "a", result: Array(1000).fill("very long\n").join("") }));
    feed.finish("completed");
    expect(text()).not.toContain("\x1b[2J");
    expect(safeText(text())).toContain("for received details");
    expect(text().length).toBeLessThan(1200);
  });

  it("keeps the stop key visible in narrow terminals and cancels deferred redraws", () => {
    vi.useFakeTimers();
    const { activity, text } = harness({}, 42);
    activity.start("A very long Chinese task 名称".repeat(10));
    expect(cellWidth(safeText(text()).split("\r").at(-1))).toBeLessThan(42);
    expect(text()).toContain("Esc stop");
    activity.update("changed");
    activity.stop();
    const stopped = text();
    vi.advanceTimersByTime(2000);
    expect(text()).toBe(stopped);
  });

  it("throttles a thousand progress events and preserves drafts when Ctrl+O toggles", () => {
    vi.useFakeTimers();
    const io = captured(), activity = createActivity(io.output, io.theme);
    activity.start("Thinking");
    for (let i = 0; i < 1000; i++) activity.update(`Thinking ${i}`);
    expect(io.text().length).toBeLessThan(200);
    vi.advanceTimersByTime(80);
    expect(io.text()).toContain("Thinking 999");
    activity.stop();
    const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
    const composer = new ChatInput(input, io.output, { environment: { TERM: "xterm" } });
    composer.active = true; composer.setDraft("未发送🙂");
    composer.onDetails = vi.fn();
    composer.consume("\x0f");
    expect(composer.onDetails).toHaveBeenCalledOnce();
    expect(composer.text).toBe("未发送🙂");
    expect(composer.queue).toHaveLength(0);
    composer.close();
  });
});
