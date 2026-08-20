import { describe, expect, it, vi } from "vitest";
import { createRunLedger } from "../src/core/run-ledger";
import { estimateContextHealth } from "../src/core/run-health";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) || null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    values
  };
}

describe("core run ledger", () => {
  it("records runs by source and exposes source-scoped history", () => {
    let clock = 1000;
    const storage = memoryStorage();
    const topics: Array<{ topic: string; payload: any }> = [];
    const ledger = createRunLedger({
      storage,
      storageKey: "runs",
      now: () => clock,
      id: (prefix) => `${prefix}-${clock}`,
      emit: (topic, payload) => topics.push({ topic, payload })
    });

    const run = ledger.start({
      source: { pluginId: "dev.identity", kind: "project", id: "q-first-paper-research" },
      trigger: "user",
      sessionId: "session-1",
      title: "Project research",
      model: { providerId: "test", modelId: "fast" },
      policy: { preset: "read-only", maxToolCalls: 3 }
    });

    clock = 1100;
    ledger.recordEvent({
      runId: run.id,
      type: "tool.requested",
      ts: clock,
      data: { callId: "call-1", name: "webSearch", args: { query: "budget" } }
    });
    clock = 1200;
    ledger.recordEvent({
      runId: run.id,
      type: "tool.denied",
      ts: clock,
      data: { callId: "call-2", name: "Bash", reason: "tool call quota exceeded" }
    });
    clock = 1300;
    ledger.recordUsage({
      runId: run.id,
      usage: { input_tokens: 10, output_tokens: 4 },
      stepIndex: 1
    });
    clock = 1400;
    ledger.recordEvent({
      runId: run.id,
      type: "run.completed",
      ts: clock,
      data: { output: "done", usage: { input_tokens: 12, output_tokens: 5 } }
    });

    const history = ledger.list({
      source: { pluginId: "dev.identity", kind: "project", id: "q-first-paper-research" }
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      status: "completed",
      sessionId: "session-1",
      toolCalls: 2,
      deniedToolCalls: 1,
      usage: { input: 12, output: 5, total: 17 }
    });
    expect(ledger.getEvents(run.id).map((event) => event.type)).toEqual([
      "tool.requested",
      "tool.denied",
      "model.usage",
      "run.completed"
    ]);
    expect(topics.some((item) => item.topic === "runs/changed")).toBe(true);
  });

  it("submits verifier outcomes without changing the run source", () => {
    const ledger = createRunLedger({ storage: memoryStorage(), storageKey: "runs" });
    const run = ledger.start({
      id: "run-1",
      source: { pluginId: "dev.identity", kind: "project", id: "alpha" }
    });

    ledger.submitOutcome(run.id, {
      verdict: "progressed",
      summary: "Updated the project plan",
      evidence: ["project.md changed"],
      confidence: 0.8,
      createdBy: "dev.identity"
    });

    expect(ledger.get("run-1")?.outcome).toMatchObject({
      verdict: "progressed",
      source: { pluginId: "dev.identity", kind: "project", id: "alpha" }
    });
  });

  it("marks stale active runs as interrupted on recovery", () => {
    let clock = 1000;
    const ledger = createRunLedger({ storage: memoryStorage(), storageKey: "runs", now: () => clock });
    ledger.start({ id: "gone", status: "running" });
    ledger.start({ id: "live", status: "running" });

    clock = 2000;
    const interrupted = ledger.reconcileActiveRuns(["live"], "startup");

    expect(interrupted.map((run) => run.id)).toEqual(["gone"]);
    expect(ledger.get("gone")).toMatchObject({
      status: "interrupted",
      terminalReason: "startup",
      error: "Run interrupted because no live controller owns it"
    });
    expect(ledger.get("live")?.status).toBe("running");
  });
});

describe("core run health", () => {
  it("recommends compression or new sessions from deterministic thresholds", () => {
    expect(estimateContextHealth({
      estimatedTokens: 70_000,
      modelContextWindow: 100_000,
      messageCount: 20
    }).recommendation).toBe("compress");

    expect(estimateContextHealth({
      estimatedTokens: 58_000,
      modelContextWindow: 100_000,
      compressionCount: 3
    }).recommendation).toBe("new-session");
  });
});
