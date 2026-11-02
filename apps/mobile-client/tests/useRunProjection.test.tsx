import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeRun } from "../src/api";
import { useRunProjection, type RunProjectionState } from "../src/useRunProjection";

vi.mock("../src/api", () => ({ subscribeRun: vi.fn() }));

let root: Root;
let host: HTMLDivElement;
let latest: RunProjectionState;
const onTerminal = vi.fn();
function Probe({ runId }: { runId: string }) {
  latest = useRunProjection(runId, onTerminal);
  return <div>{latest.blocks.map((block) => block.kind === "text" ? block.content : "").join("|")}</div>;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("useRunProjection", () => {
  it("delivers all text blocks at completion and never reports the old Run as the new Run", async () => {
    vi.mocked(subscribeRun).mockImplementation(async function* (runId) {
      if (runId === "next") return;
      yield { runId, sequence: 1, eventId: "1", type: "message.delta", data: { turn: 1, delta: "First" } };
      yield { runId, sequence: 2, eventId: "2", type: "message.delta", data: { turn: 2, delta: "Last" } };
      yield { runId, sequence: 3, eventId: "3", type: "run.completed", data: { output: "FirstLast" } };
    });
    await act(async () => root.render(<Probe runId="first" />));
    expect(host.textContent).toBe("First|Last");
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(onTerminal.mock.calls[0][0]).toMatchObject({ runId: "first", status: "completed" });
    await act(async () => root.render(<Probe runId="next" />));
    expect(latest.runId).toBe("next");
    expect(latest.blocks).toEqual([]);
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("aborts the old stream when switching Runs and ignores its late events", async () => {
    let release!: () => void;
    const signals: AbortSignal[] = [];
    vi.mocked(subscribeRun).mockImplementation(async function* (runId, options) {
      signals.push(options!.signal!);
      if (runId === "first") await new Promise<void>((resolve) => { release = resolve; });
      yield { runId, sequence: 1, eventId: "1", type: "message.delta", data: { turn: 1, delta: runId } };
    });
    await act(async () => root.render(<Probe runId="first" />));
    await act(async () => root.render(<Probe runId="second" />));
    expect(signals[0].aborted).toBe(true);
    await act(async () => release());
    expect(host.textContent).toBe("second");
    expect(latest.runId).toBe("second");
  });

  it("retains partial text after a stream error", async () => {
    vi.mocked(subscribeRun).mockImplementation(async function* (runId) {
      yield { runId, sequence: 1, eventId: "1", type: "message.delta", data: { turn: 1, delta: "Partial" } };
      throw new Error("Stream offline");
    });
    await act(async () => root.render(<Probe runId="first" />));
    expect(host.textContent).toBe("Partial");
    expect(latest.error).toBe("Stream offline");
    expect(onTerminal).not.toHaveBeenCalled();
  });
});
