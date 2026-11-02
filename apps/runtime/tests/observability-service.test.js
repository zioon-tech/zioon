import { describe, expect, it, vi } from "vitest";
import { createJaegerTraceReader } from "../src/observability/jaeger-trace-reader.mjs";
import { createObservabilityHttpHandler } from "../src/observability/observability-http-handler.mjs";
import { createRuntimeObservabilityService } from "../src/observability/observability-service.mjs";

const TRACE_ID = "1".repeat(32);
const ROOT_SPAN_ID = "2".repeat(16);

function run(overrides = {}) {
  return {
    id: "run-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    projectId: "project-1",
    status: "completed",
    title: "Diagnostic Run",
    createdAt: 1000,
    updatedAt: 5000,
    completedAt: 5000,
    metadata: {
      zionTelemetry: {
        version: 1,
        attemptId: "attempt-1",
        traceId: TRACE_ID,
        spanId: ROOT_SPAN_ID,
        traceFlags: 1
      }
    },
    ...overrides
  };
}

function span({
  id,
  operationName,
  startTime,
  duration,
  tags = [],
  parent = ""
}) {
  return {
    spanID: id,
    traceID: TRACE_ID,
    operationName,
    processID: "p1",
    startTime,
    duration,
    references: parent ? [{
      refType: "CHILD_OF",
      traceID: TRACE_ID,
      spanID: parent
    }] : [],
    tags: tags.map(([key, value]) => ({
      key,
      type: typeof value === "boolean"
        ? "bool"
        : typeof value === "number"
          ? "int64"
          : "string",
      value
    }))
  };
}

function trace() {
  return {
    traceID: TRACE_ID,
    processes: {
      p1: {
        serviceName: "zion-runtime",
        tags: [{ key: "secret.resource", value: "SECRET_RESOURCE" }]
      }
    },
    spans: [
      span({
        id: ROOT_SPAN_ID,
        operationName: "invoke_agent",
        startTime: 1_000_000,
        duration: 4_000_000,
        tags: [
          ["zion.run.status", "completed"],
          ["secret.prompt", "SECRET_PROMPT"]
        ]
      }),
      span({
        id: "3".repeat(16),
        parent: ROOT_SPAN_ID,
        operationName: "chat",
        startTime: 1_100_000,
        duration: 2_400_000,
        tags: [
          ["gen_ai.request.model", "deepseek-v4"],
          ["gen_ai.response.time_to_first_chunk", 1.2],
          ["zion.model.consumer_wait.duration", 0.5],
          ["zion.model.credential.duration", 0.2],
          ["http.response.status_code", 429],
          ["gen_ai.usage.input_tokens", 100],
          ["gen_ai.usage.output_tokens", 20],
          ["secret.response", "SECRET_RESPONSE"]
        ]
      }),
      span({
        id: "4".repeat(16),
        parent: ROOT_SPAN_ID,
        operationName: "execute_tool",
        startTime: 3_600_000,
        duration: 900_000,
        tags: [
          ["gen_ai.tool.name", "read"],
          ["zion.tool.host_kind", "delegated"],
          ["zion.tool.receipt_hit", false],
          ["zion.tool.ok", false],
          ["zion.tool.artifact_count", 2],
          ["zion.tool.change_count", 1],
          ["secret.arguments", "SECRET_ARGUMENTS"]
        ]
      })
    ]
  };
}

function event(sequence, type, data = {}, overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    runId: "run-1",
    attemptId: "attempt-1",
    sequence,
    type,
    timestamp: 1000 + sequence,
    data,
    ...overrides
  };
}

function runStore(records = [run()], {
  events = new Map(),
  messages = new Map()
} = {}) {
  const values = new Map(records.map((record) => [record.id, record]));
  return {
    get: vi.fn(async (runId) => values.get(runId) || null),
    getEvents: vi.fn(async (runId) => events.get(runId) || []),
    getSessionMessages: vi.fn(async (sessionId) => messages.get(sessionId) || []),
    listRuns: vi.fn(async ({ since = 0, statuses, limit = 100 } = {}) => {
      const statusSet = statuses?.length ? new Set(statuses) : null;
      return [...values.values()]
        .filter((record) => record.updatedAt >= since)
        .filter((record) => !statusSet || statusSet.has(record.status))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, limit);
    })
  };
}

describe("RuntimeObservabilityService", () => {
  it("reports Jaeger query health without claiming pipeline health", async () => {
    const disabled = createRuntimeObservabilityService({ runs: runStore() });
    await expect(disabled.status()).resolves.toEqual({
      enabled: false,
      backend: "none",
      queryBackend: {
        available: false,
        reason: "telemetry-disabled"
      }
    });

    const enabled = createRuntimeObservabilityService({
      runs: runStore(),
      traceReader: {
        getTrace: vi.fn(),
        health: vi.fn(async () => ({ available: true, serviceCount: 2 }))
      }
    });
    await expect(enabled.status()).resolves.toMatchObject({
      enabled: true,
      backend: "jaeger",
      queryBackend: {
        available: true,
        serviceCount: 2
      }
    });
  });

  it("projects one sanitized Run diagnostic with deterministic findings", async () => {
    const reader = {
      getTrace: vi.fn(async () => trace()),
      health: vi.fn(async () => ({ available: true, serviceCount: 1 }))
    };
    const service = createRuntimeObservabilityService({
      runs: runStore(),
      traceReader: reader,
      traceUrlTemplate: "https://observe.example/trace/{traceId}"
    });

    const diagnostic = await service.diagnoseRun("run-1", {
      requester: { sessionId: "session-1" },
      enforceVisibility: true,
      includeExternalUrl: true
    });

    expect(diagnostic).toMatchObject({
      availability: "ready",
      source: { runLedger: true, runEvents: true, trace: true },
      coverage: ["run-events", "attempt", "model", "tool"],
      summary: {
        outcome: "success",
        durationMs: 4000,
        confidence: "high"
      },
      largestObservedStage: {
        stage: "model",
        name: "deepseek-v4",
        durationMs: 2400,
        share: 0.6
      },
      stages: [
        expect.objectContaining({ kind: "attempt", durationMs: 4000 }),
        expect.objectContaining({
          kind: "model",
          name: "deepseek-v4",
          firstChunkMs: 1200,
          consumerWaitMs: 500,
          activeDurationMs: 1900,
          credentialMs: 200,
          httpStatus: 429,
          tokenUsage: { input: 100, output: 20 }
        }),
        expect.objectContaining({
          kind: "tool",
          name: "read",
          hostKind: "delegated",
          receiptHit: false,
          toolOk: false,
          artifactCount: 2,
          changeCount: 1
        })
      ],
      externalUrl: `https://observe.example/trace/${TRACE_ID}`
    });
    expect(diagnostic.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "largest_observed_stage",
        "slow_first_chunk",
        "model_consumer_backpressure"
      ])
    );
    expect(JSON.stringify(diagnostic)).not.toContain("SECRET");
    expect(reader.getTrace).toHaveBeenCalledWith(TRACE_ID, undefined);

    const summaryOnly = await service.diagnoseRun("run-1", {
      includeStages: false,
      includeFindings: false
    });
    expect(summaryOnly).not.toHaveProperty("stages");
    expect(summaryOnly).not.toHaveProperty("findings");
  });

  it.each([
    ["telemetry-disabled", null, run(), "telemetry-disabled"],
    ["unsampled", { getTrace: vi.fn() }, run({
      metadata: {
        zionTelemetry: {
          traceId: TRACE_ID,
          spanId: ROOT_SPAN_ID,
          traceFlags: 0
        }
      }
    }), "unsampled"],
    ["active", { getTrace: vi.fn() }, run({ status: "running", completedAt: undefined }), "active"],
    ["not-found", { getTrace: vi.fn(async () => null) }, run(), "not-found"],
    ["backend-unavailable", {
      getTrace: vi.fn(async () => {
        throw Object.assign(new Error("SECRET_BACKEND_BODY"), {
          code: "backend_unavailable"
        });
      })
    }, run(), "backend-unavailable"]
  ])("represents %s without changing the Run outcome", async (
    _name,
    reader,
    record,
    availability
  ) => {
    const service = createRuntimeObservabilityService({
      runs: runStore([record]),
      traceReader: reader
    });
    const diagnostic = await service.diagnoseRun(record.id);

    expect(diagnostic.availability).toBe(availability);
    expect(diagnostic.source).toEqual({
      runLedger: true,
      runEvents: true,
      trace: false
    });
    expect(diagnostic.summary.outcome).toBe(
      record.status === "completed" ? "success" : "unknown"
    );
    expect(JSON.stringify(diagnostic)).not.toContain("SECRET");
  });

  it("enforces same-Run, Session, or Project visibility for Tool callers", async () => {
    const reader = {
      getTrace: vi.fn(async () => trace())
    };
    const service = createRuntimeObservabilityService({
      runs: runStore(),
      traceReader: reader
    });

    await expect(service.diagnoseRun("run-1", {
      requester: { sessionId: "different", projectId: "different" },
      enforceVisibility: true
    })).resolves.toBeNull();
    await expect(service.diagnoseRun("run-1", {
      requester: { sessionId: "session-1" },
      enforceVisibility: true
    })).resolves.toMatchObject({ availability: "ready" });
    await expect(service.diagnoseRun("run-1", {
      requester: { projectId: "project-1" },
      enforceVisibility: true
    })).resolves.toMatchObject({ availability: "ready" });
  });

  it("projects allowlisted Run facts without exposing event content", async () => {
    const record = run({
      status: "failed",
      terminalReason: "failed",
      error: "SECRET_RUN_ERROR",
      usage: {
        inputTokens: 40,
        outputTokens: 8,
        reasoningTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 1
      }
    });
    const events = new Map([["run-1", [
      event(1, "run.started", { prompt: "SECRET_PROMPT" }),
      event(2, "context.failed", {
        providerId: "project-context",
        stage: "pre",
        error: "SECRET_CONTEXT_ERROR"
      }),
      event(3, "tool.requested", {
        turn: 1,
        callId: "call-policy",
        name: "Bash",
        arguments: { command: "SECRET_COMMAND" }
      }),
      event(4, "tool.denied", {
        turn: 1,
        callId: "call-policy",
        name: "Bash",
        denialType: "policy",
        reason: "SECRET_POLICY_REASON"
      }),
      event(5, "tool.denied", {
        turn: 1,
        callId: "call-invalid",
        name: "search",
        denialType: "invalid_arguments",
        reason: "SECRET_VALIDATION_REASON"
      }),
      event(6, "tool.completed", {
        turn: 2,
        callId: "call-read",
        name: "read",
        ok: false,
        result: "SECRET_RESULT",
        error: "SECRET_TOOL_ERROR"
      }),
      event(7, "run.failed", { error: "SECRET_EVENT_ERROR" })
    ]]]);
    const service = createRuntimeObservabilityService({
      runs: runStore([record], { events })
    });

    const diagnostic = await service.diagnoseRun("run-1");

    expect(diagnostic).toMatchObject({
      availability: "telemetry-disabled",
      summary: { outcome: "failed" },
      ledger: {
        status: "failed",
        terminalReason: "failed",
        eventCount: 7,
        lastSequence: 7,
        attemptCount: 1,
        usage: {
          input: 40,
          output: 8,
          reasoning: 3,
          cacheRead: 2,
          cacheWrite: 1
        },
        tools: [
          { name: "Bash", status: "denied", turn: 1 },
          { name: "search", status: "denied", turn: 1 },
          { name: "read", status: "failed", turn: 2 }
        ],
        policyDenials: [
          { tool: "Bash", type: "policy", turn: 1 },
          { tool: "search", type: "invalid_arguments", turn: 1 }
        ],
        contextFailures: [
          { providerId: "project-context", stage: "pre" }
        ]
      }
    });
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain("SECRET_");
    expect(serialized).not.toContain("\"prompt\"");
    expect(serialized).not.toContain("\"arguments\"");
    expect(serialized).not.toContain("\"result\"");
  });

  it("distinguishes timeout and trace indexing states without inventing expiry", async () => {
    const timeout = run({
      id: "run-timeout",
      status: "aborted",
      terminalReason: "timeout",
      createdAt: 90_000,
      updatedAt: 99_000,
      completedAt: 99_000
    });
    const old = run({
      id: "run-old",
      createdAt: 80_000,
      updatedAt: 90_000,
      completedAt: 90_000
    });
    const reader = { getTrace: vi.fn(async () => null) };
    const service = createRuntimeObservabilityService({
      runs: runStore([timeout, old]),
      traceReader: reader,
      now: () => 100_000
    });

    await expect(service.diagnoseRun("run-timeout")).resolves.toMatchObject({
      availability: "not-found",
      summary: { outcome: "timeout" },
      traceState: { reason: "pending-index", retryable: true }
    });
    const oldDiagnostic = await service.diagnoseRun("run-old");
    expect(oldDiagnostic).toMatchObject({
      availability: "not-found",
      traceState: { reason: "trace-missing", retryable: false }
    });
    expect(JSON.stringify(oldDiagnostic)).not.toContain("expired");
  });

  it("selects the latest terminal Run in the current Session when runId is omitted", async () => {
    const records = [
      run({ id: "run-prior", updatedAt: 2000, completedAt: 2000 }),
      run({
        id: "run-active",
        status: "running",
        updatedAt: 3000,
        completedAt: undefined
      }),
      run({
        id: "run-other-session",
        sessionId: "session-other",
        updatedAt: 4000,
        completedAt: 4000
      }),
      run({
        id: "run-current",
        status: "running",
        updatedAt: 5000,
        completedAt: undefined
      })
    ];
    const messages = new Map([["session-1", [
      { sequence: 1, runId: "run-prior" },
      { sequence: 2, runId: "run-other-session" },
      { sequence: 3, runId: "run-active" },
      { sequence: 4, runId: "run-current" }
    ]]]);
    const service = createRuntimeObservabilityService({
      runs: runStore(records, { messages })
    });

    await expect(service.diagnoseRun(undefined, {
      requester: {
        runId: "run-current",
        sessionId: "session-1",
        projectId: "project-1"
      },
      enforceVisibility: true
    })).resolves.toMatchObject({ runId: "run-prior" });
    await expect(service.diagnoseRun(undefined, {
      requester: { projectId: "project-1" },
      enforceVisibility: true
    })).resolves.toBeNull();
  });

  it("returns a bounded Project overview without querying traces per Run", async () => {
    const now = 1_000_000;
    const timed = (id, overrides = {}) => run({
      id,
      createdAt: now - 10_000,
      updatedAt: now - 1_000,
      completedAt: now - 1_000,
      ...overrides
    });
    const records = [
      timed("run-failed", { status: "failed", terminalReason: "failed" }),
      timed("run-timeout", { status: "aborted", terminalReason: "timeout" }),
      timed("run-interrupted", {
        status: "interrupted",
        terminalReason: "runtime-restart"
      }),
      timed("run-slow", { createdAt: now - 50_000 }),
      timed("run-stalled", {
        status: "running",
        updatedAt: now - 40_000,
        completedAt: undefined
      }),
      timed("run-trace-missing", {
        metadata: { zionTelemetry: { traceFlags: 1 } }
      }),
      timed("run-healthy"),
      timed("run-other-project", {
        projectId: "project-other",
        status: "failed"
      })
    ];
    const reader = {
      getTrace: vi.fn(() => {
        throw new Error("Overview must not query individual traces");
      }),
      health: vi.fn(async () => ({ available: true, serviceCount: 1 }))
    };
    const store = runStore(records);
    const service = createRuntimeObservabilityService({
      runs: store,
      traceReader: reader,
      now: () => now
    });

    const overview = await service.overview({
      windowMinutes: 60,
      limit: 3,
      minDurationMs: 30_000
    }, {
      requester: {
        sessionId: "session-1",
        projectId: "project-1"
      }
    });

    expect(overview).toMatchObject({
      scope: { kind: "project", id: "project-1" },
      window: { since: now - 60 * 60_000, until: now, minutes: 60 },
      thresholds: { slowMs: 30_000, stalledMs: 30_000 },
      backend: { queryAvailable: true },
      totals: {
        inspected: 7,
        problems: 6,
        failed: 1,
        timeout: 1,
        interrupted: 1,
        slow: 1,
        stalled: 1,
        traceMissing: 1
      },
      truncated: true
    });
    expect(overview.runs).toHaveLength(3);
    expect(overview.runs.flatMap((item) => item.signals)).toEqual(
      expect.arrayContaining(["failed", "timeout", "interrupted"])
    );
    expect(store.listRuns).toHaveBeenCalledWith({
      since: now - 60 * 60_000,
      limit: 30
    });
    expect(reader.getTrace).not.toHaveBeenCalled();
    expect(reader.health).toHaveBeenCalledOnce();
    expect(JSON.stringify(overview)).not.toContain("run-other-project");
  });

  it("falls back to Session scope and clamps overview inputs", async () => {
    const now = 10_000_000;
    const store = runStore([
      run({
        id: "run-session",
        projectId: undefined,
        sessionId: "session-1",
        status: "failed",
        createdAt: now - 500,
        updatedAt: now
      }),
      run({
        id: "run-other-session",
        projectId: undefined,
        sessionId: "session-2",
        status: "failed",
        createdAt: now - 500,
        updatedAt: now
      })
    ]);
    const service = createRuntimeObservabilityService({
      runs: store,
      now: () => now
    });

    const overview = await service.overview({
      windowMinutes: 99_999,
      limit: 999,
      minDurationMs: 0
    }, {
      requester: { sessionId: "session-1" }
    });

    expect(overview).toMatchObject({
      scope: { kind: "session", id: "session-1" },
      window: { minutes: 1440 },
      thresholds: { slowMs: 1000, stalledMs: 1000 }
    });
    expect(overview.runs.map((item) => item.runId)).toEqual(["run-session"]);
    expect(store.listRuns).toHaveBeenCalledWith({
      since: now - 1440 * 60_000,
      limit: 500
    });
  });

  it("reports missing RunEvent support as a limitation", async () => {
    const service = createRuntimeObservabilityService({
      runs: { get: vi.fn(async () => run()) }
    });

    await expect(service.diagnoseRun("run-1")).resolves.toMatchObject({
      source: { runLedger: true, runEvents: false, trace: false },
      limitations: expect.arrayContaining(["RunEvent details were unavailable."])
    });
  });

  it("reports stage and finding truncation with pre-truncation counts", async () => {
    const manySpans = trace();
    manySpans.spans = [
      manySpans.spans[0],
      ...Array.from({ length: 15 }, (_, index) => span({
        id: (index + 10).toString(16).padStart(16, "0"),
        parent: ROOT_SPAN_ID,
        operationName: "chat",
        startTime: 1_100_000 + index * 10_000,
        duration: 1_100_000,
        tags: [
          ["gen_ai.request.model", `model-${index}`],
          ["gen_ai.response.time_to_first_chunk", 1.05]
        ]
      })),
      ...Array.from({ length: 15 }, (_, index) => span({
        id: (index + 100).toString(16).padStart(16, "0"),
        parent: ROOT_SPAN_ID,
        operationName: "execute_tool",
        startTime: 2_000_000 + index * 10_000,
        duration: 100_000,
        tags: [
          ["gen_ai.tool.name", `tool-${index}`],
          ["zion.tool.receipt_hit", true]
        ]
      }))
    ];
    const service = createRuntimeObservabilityService({
      runs: runStore(),
      traceReader: { getTrace: vi.fn(async () => manySpans) }
    });

    const diagnostic = await service.diagnoseRun("run-1");

    expect(diagnostic.counts.stages).toBe(31);
    expect(diagnostic.counts.findings).toBeGreaterThan(10);
    expect(diagnostic.truncated).toEqual({ stages: true, findings: true });
    expect(diagnostic.stages).toHaveLength(20);
    expect(diagnostic.findings).toHaveLength(10);
  });

  it("caches terminal traces without caching Backend failures", async () => {
    const reader = {
      getTrace: vi.fn(async () => trace())
    };
    const service = createRuntimeObservabilityService({
      runs: runStore(),
      traceReader: reader,
      cacheTtlMs: 30_000
    });
    await service.diagnoseRun("run-1");
    await service.diagnoseRun("run-1");
    expect(reader.getTrace).toHaveBeenCalledOnce();
  });
});

describe("JaegerTraceReader", () => {
  it("queries a bounded fixed Jaeger path without forwarding error bodies", async () => {
    const fetchImpl = vi.fn(async (url) => new globalThis.Response(JSON.stringify({
      data: [trace()]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const reader = createJaegerTraceReader({
      baseUrl: "http://127.0.0.1:16686/prefix",
      fetchImpl,
      headers: { authorization: "Bearer SECRET_TOKEN" }
    });

    await expect(reader.getTrace(TRACE_ID)).resolves.toMatchObject({
      traceID: TRACE_ID
    });
    expect(String(fetchImpl.mock.calls[0][0]))
      .toBe(`http://127.0.0.1:16686/prefix/api/traces/${TRACE_ID}`);
    expect(fetchImpl.mock.calls[0][1].headers.authorization)
      .toBe("Bearer SECRET_TOKEN");

    fetchImpl.mockResolvedValueOnce(new globalThis.Response("SECRET_BACKEND_BODY", {
      status: 500
    }));
    await expect(reader.health()).rejects.toThrow("Jaeger query HTTP 500");
  });

  it("rejects unsafe configuration and invalid Trace ids", async () => {
    for (const baseUrl of [
      "file:///tmp/trace",
      "http://user:password@localhost:16686",
      "http://localhost:16686?token=secret"
    ]) {
      expect(() => createJaegerTraceReader({ baseUrl })).toThrow();
    }
    const reader = createJaegerTraceReader({
      baseUrl: "http://127.0.0.1:16686",
      fetchImpl: vi.fn()
    });
    await expect(reader.getTrace("not-a-trace")).rejects.toThrow(
      "Trace ID is invalid"
    );
  });
});

describe("Observability HTTP handler", () => {
  it("serves status and owner-aware diagnostics without exposing Backend details", async () => {
    const service = {
      status: vi.fn(async () => ({
        enabled: true,
        backend: "jaeger",
        queryBackend: { available: true }
      })),
      diagnoseRun: vi.fn(async (_runId, options) => ({
        schemaVersion: 1,
        runId: "run-1",
        availability: "ready",
        ...(options.includeExternalUrl
          ? { externalUrl: "https://observe.example/trace/id" }
          : {})
      }))
    };
    const handler = createObservabilityHttpHandler({
      service,
      canViewExternalTrace: (principal) => principal?.owner === true
    });
    const response = () => {
      const result = { status: 0, headers: {}, body: "" };
      return {
        result,
        writeHead(status, headers) {
          result.status = status;
          result.headers = headers;
        },
        end(body = "") {
          result.body = String(body);
        }
      };
    };

    const statusResponse = response();
    await expect(handler(
      { method: "GET" },
      statusResponse,
      new URL("http://runtime/v1/observability/status")
    )).resolves.toBe(true);
    expect(JSON.parse(statusResponse.result.body)).toMatchObject({
      enabled: true,
      queryBackend: { available: true }
    });

    const diagnosticResponse = response();
    await handler(
      { method: "GET", zionPrincipal: { owner: true } },
      diagnosticResponse,
      new URL("http://runtime/v1/runs/run-1/diagnostics?include=findings")
    );
    expect(service.diagnoseRun).toHaveBeenCalledWith("run-1", {
      includeStages: false,
      includeFindings: true,
      includeExternalUrl: true
    });
    expect(JSON.parse(diagnosticResponse.result.body).diagnostic)
      .toMatchObject({ runId: "run-1", externalUrl: expect.any(String) });

    const summaryResponse = response();
    await handler(
      { method: "GET", zionPrincipal: { owner: false } },
      summaryResponse,
      new URL("http://runtime/v1/runs/run-1/diagnostics")
    );
    expect(service.diagnoseRun).toHaveBeenLastCalledWith("run-1", {
      includeStages: false,
      includeFindings: false,
      includeExternalUrl: false
    });
  });
});
