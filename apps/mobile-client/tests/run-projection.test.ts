import { describe, expect, it } from "vitest";
import { initialRunProjection, reduceRunProjection } from "../src/run-projection";
import type { RunEvent } from "../src/types";

function replay() {
  let state = initialRunProjection("r");
  let sequence = 0;
  return {
    get state() { return state; },
    event(type: string, data: Record<string, unknown> = {}) {
      state = reduceRunProjection(state, {
        type: "event",
        event: { runId: "r", sequence: ++sequence, type, eventId: `e${sequence}`, data } as RunEvent,
      });
      return state;
    },
  };
}

describe("ordered Run projection", () => {
  it("keeps commentary between activities and appends the final answer once", () => {
    const run = replay();
    run.event("run.started");
    run.event("reasoning.started", { turn: 1 });
    run.event("reasoning.delta", { turn: 1, delta: "Inspect" });
    run.event("message.delta", { turn: 1, delta: "First " });
    run.event("message.delta", { turn: 1, delta: "step." });
    run.event("tool.requested", { turn: 1, callId: "a", name: "read" });
    run.event("tool.completed", { turn: 1, callId: "a", ok: true, result: "Read file" });
    run.event("turn.started", { turn: 2 });
    run.event("reasoning.progress", { turn: 2 });
    run.event("reasoning.delta", { turn: 2, delta: "Verify" });
    run.event("reasoning.completed", { turn: 2 });
    run.event("message.delta", { turn: 2, delta: "Second step." });
    run.event("tool.requested", { turn: 2, callId: "b", name: "Bash" });
    run.event("tool.completed", { turn: 2, callId: "b", ok: true, result: "OK" });
    run.event("turn.started", { turn: 3 });
    run.event("message.delta", { turn: 3, delta: "Final." });
    run.event("message.completed", { turn: 3, content: "Final." });
    const before = run.state.blocks;
    run.event("run.completed", { output: "First step.Second step.Final." });
    expect(run.state.blocks.map((block) => block.kind))
      .toEqual(["reasoning", "text", "tool", "reasoning", "text", "tool", "text"]);
    expect(run.state.blocks.filter((block) => block.kind === "text").map((block) => block.content))
      .toEqual(["First step.", "Second step.", "Final."]);
    expect(run.state.blocks.map((block) => block.id)).toEqual(before.map((block) => block.id));
    expect(run.state.status).toBe("completed");
    expect(run.state.blocks.filter((block) => block.kind === "reasoning"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ content: "Verify", running: false })]));
  });

  it("updates concurrent tools in their original positions, including denied and failed results", () => {
    const run = replay();
    run.event("tool.requested", { turn: 1, callId: "a", name: "read", arguments: { path: "/a" } });
    run.event("tool.requested", { turn: 1, callId: "b", name: "write" });
    run.event("tool.completed", { turn: 1, callId: "b", ok: false, error: "Permission denied" });
    run.event("tool.completed", { turn: 1, callId: "a", ok: true, result: "OK" });
    run.event("tool.denied", { turn: 1, callId: "c", name: "Bash", reason: "Read only" });
    expect(run.state.blocks.map((block) => block.kind === "tool" && [block.call.id, block.status]))
      .toEqual([["a", "completed"], ["b", "failed"], ["c", "failed"]]);
    const first = run.state.blocks[0];
    expect(first.kind).toBe("tool");
    expect(first.kind === "tool" && JSON.parse(first.call.function.arguments)).toEqual({ path: "/a" });
  });

  it.each(["failed", "aborted", "interrupted"])("retains partial text when a Run is %s", (status) => {
    const run = replay();
    run.event("message.delta", { turn: 1, delta: "Partial answer" });
    run.event("tool.requested", { turn: 1, callId: "a", name: "read" });
    run.event(`run.${status}`, { error: "Stopped" });
    expect(run.state.blocks[0]).toMatchObject({ content: "Partial answer" });
    expect(run.state.blocks[1]).toMatchObject({ status: "interrupted" });
    expect(run.state.status).toBe(status);
  });

  it("ignores replayed sequences and late events from another Run", () => {
    const run = replay();
    const state = run.event("message.delta", { turn: 1, delta: "One" });
    const duplicate = { runId: "r", sequence: 1, type: "message.delta", data: { delta: "One" } } as RunEvent;
    expect(reduceRunProjection(state, { type: "event", event: duplicate })).toBe(state);
    expect(reduceRunProjection(state, { type: "event", event: { ...duplicate, runId: "other", sequence: 9 } })).toBe(state);
    expect(reduceRunProjection(state, { type: "reset", runId: "next" })).toEqual(initialRunProjection("next"));
  });

  it("supports completed-only output and separates transport errors from Run state", () => {
    const run = replay();
    run.event("run.completed", { output: "Final only" });
    expect(run.state.blocks).toEqual([{ id: "r:turn:1:text", turn: 1, kind: "text", content: "Final only" }]);
    expect(reduceRunProjection(run.state, { type: "error", error: "Offline" }))
      .toMatchObject({ status: "completed", error: "Offline", blocks: run.state.blocks });
  });
});
