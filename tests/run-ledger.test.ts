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

  it("does not persist transient token stream events", () => {
    const storage = memoryStorage();
    const ledger = createRunLedger({ storage, storageKey: "runs" });
    ledger.start({ id: "streaming-run", status: "running" });
    const writesAfterStart = storage.setItem.mock.calls.length;

    for (let index = 0; index < 100; index += 1) {
      expect(ledger.recordEvent({
        runId: "streaming-run",
        type: index % 2 === 0 ? "reasoning.delta" : "message.delta",
        sequence: index + 1,
        data: { delta: "x" }
      })).toBeNull();
    }

    expect(ledger.getEvents("streaming-run")).toEqual([]);
    expect(storage.setItem).toHaveBeenCalledTimes(writesAfterStart);
  });

  it("drops legacy transient token events while loading persisted state", () => {
    const storage = memoryStorage();
    storage.values.set("runs", JSON.stringify({
      version: 1,
      runs: [{ id: "legacy-run", status: "running" }],
      events: [{
        id: "reasoning-1",
        runId: "legacy-run",
        type: "reasoning.delta",
        ts: 100,
        data: { length: 1 }
      }, {
        id: "message-1",
        runId: "legacy-run",
        type: "message.delta",
        ts: 101,
        data: { length: 1 }
      }, {
        id: "tool-1",
        runId: "legacy-run",
        type: "tool.requested",
        ts: 102,
        data: { callId: "call-1", name: "read" }
      }],
      outcomes: []
    }));

    const ledger = createRunLedger({ storage, storageKey: "runs" });

    expect(ledger.getEvents("legacy-run").map((event) => event.type))
      .toEqual(["tool.requested"]);
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

  it("preserves model snapshots on run and turn events", () => {
    const ledger = createRunLedger({ storage: memoryStorage(), storageKey: "runs" });
    ledger.start({
      id: "model-run",
      model: { providerId: "anthropic", modelId: "claude-3-5-sonnet", label: "Claude Sonnet" }
    });

    ledger.recordEvent({
      runId: "model-run",
      type: "run.started",
      data: {
        executionMode: "interactive",
        model: { providerId: "anthropic", modelId: "claude-3-5-sonnet", label: "Claude Sonnet" }
      }
    });
    ledger.recordEvent({
      runId: "model-run",
      type: "turn.started",
      data: {
        turn: 2,
        model: { providerId: "openai", modelId: "gpt-4.1", label: "GPT-4.1" }
      }
    });
    ledger.recordUsage({
      runId: "model-run",
      stepIndex: 2,
      model: { providerId: "openai", modelId: "gpt-4.1", label: "GPT-4.1" },
      usage: { input_tokens: 10, output_tokens: 5 }
    });

    expect(ledger.get("model-run")).toMatchObject({
      executionMode: "interactive",
      model: { providerId: "openai", modelId: "gpt-4.1", label: "GPT-4.1" },
      stepCount: 2
    });
    expect(ledger.getEvents("model-run").map((event) => event.data?.model).filter(Boolean)).toEqual([
      { providerId: "anthropic", modelId: "claude-3-5-sonnet", label: "Claude Sonnet" },
      { providerId: "openai", modelId: "gpt-4.1", label: "GPT-4.1" },
      { providerId: "openai", modelId: "gpt-4.1", label: "GPT-4.1" }
    ]);
  });

  it("registers runtime source kinds for plugins", () => {
    const topics: Array<{ topic: string; payload: any }> = [];
    const ledger = createRunLedger({
      storage: memoryStorage(),
      storageKey: "runs",
      emit: (topic, payload) => topics.push({ topic, payload })
    });

    expect(ledger.getSourceKinds()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "project", label: "项目" }),
      expect.objectContaining({ kind: "core", label: "Core" })
    ]));

    const disposable = ledger.registerSourceKind({
      kind: "devops-run",
      label: "DevOps",
      color: "purple",
      order: 45,
      pluginId: "dev.devops"
    });

    expect(ledger.getSourceKinds()).toContainEqual({
      kind: "devops-run",
      label: "DevOps",
      color: "purple",
      order: 45,
      pluginId: "dev.devops"
    });
    expect(topics.some((item) => item.payload?.reason === "source-kind")).toBe(true);

    disposable.dispose();
    expect(ledger.getSourceKinds().some((item) => item.kind === "devops-run")).toBe(false);
  });

  it("projects sanitized context window health onto runs", () => {
    const ledger = createRunLedger({ storage: memoryStorage(), storageKey: "runs" });
    ledger.start({
      id: "context-run",
      sessionId: "session-context",
      model: { providerId: "deepseek", modelId: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }
    });

    ledger.recordEvent({
      runId: "context-run",
      type: "context.window",
      ts: 2000,
      data: {
        turn: 1,
        sessionId: "session-context",
        estimatedTokens: 72_000,
        modelContextWindow: 100_000,
        utilization: 0.72,
        warningThreshold: 0.7,
        criticalThreshold: 0.85,
        messageCount: 18,
        compressionCount: 0,
        recommendation: "compress",
        reasons: ["context-window-high"],
        model: { providerId: "deepseek", modelId: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
        messages: [{ role: "user", content: "raw prompt must not be stored" }]
      }
    });

    expect(ledger.get("context-run")).toMatchObject({
      stepCount: 1,
      contextHealth: {
        sessionId: "session-context",
        estimatedTokens: 72_000,
        modelContextWindow: 100_000,
        utilization: 0.72,
        warningThreshold: 0.7,
        severity: "warning",
        recommendation: "compress",
        reasons: ["context-window-high"],
        updatedAt: 2000
      }
    });
    const event = ledger.getEvents("context-run").find((item) => item.type === "context.window");
    expect(event?.data).toMatchObject({
      turn: 1,
      estimatedTokens: 72_000,
      modelContextWindow: 100_000,
      severity: "warning",
      recommendation: "compress"
    });
    expect(event?.data).not.toHaveProperty("messages");
  });
});

describe("core run health", () => {
  it("recommends compression or new sessions from deterministic thresholds", () => {
    expect(estimateContextHealth({
      estimatedTokens: 69_000,
      modelContextWindow: 100_000
    })).toMatchObject({ recommendation: "continue", severity: "ok" });

    expect(estimateContextHealth({
      estimatedTokens: 70_000,
      modelContextWindow: 100_000,
      messageCount: 20
    })).toMatchObject({ recommendation: "compress", severity: "warning" });

    expect(estimateContextHealth({
      estimatedTokens: 58_000,
      modelContextWindow: 100_000,
      compressionCount: 3
    })).toMatchObject({ recommendation: "new-session", severity: "critical" });
  });
});
