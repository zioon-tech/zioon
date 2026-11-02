const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted", "interrupted"]);
const MAX_STAGES = 20;
const MAX_FINDINGS = 10;
const MAX_LEDGER_TOOLS = 50;
const MAX_LEDGER_FAILURES = 20;

function compactText(value, max = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function safeIdentifier(value, fallback) {
  const text = String(value ?? "").trim();
  return /^[a-zA-Z0-9_.:/-]{1,128}$/.test(text) ? text : fallback;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function durationMs(microseconds) {
  return Math.max(0, finiteNumber(microseconds) / 1000);
}

function optionalInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.floor(number)
    : undefined;
}

function projectedUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const aliases = {
    input: ["inputTokens", "input"],
    output: ["outputTokens", "output"],
    reasoning: ["reasoningTokens", "reasoning"],
    cacheRead: ["cacheReadTokens", "cacheRead"],
    cacheWrite: ["cacheWriteTokens", "cacheWrite"]
  };
  const usage = {};
  let found = false;
  for (const [target, keys] of Object.entries(aliases)) {
    const key = keys.find((candidate) => value[candidate] !== undefined);
    if (!key) continue;
    usage[target] = optionalInteger(value[key]) ?? 0;
    found = true;
  }
  return found ? usage : undefined;
}

function eventTurn(data) {
  const turn = optionalInteger(data?.turn);
  return turn && turn > 0 ? turn : undefined;
}

function denialType(value) {
  return value === "policy" || value === "invalid_arguments"
    ? value
    : "unknown";
}

export function projectRunLedgerFacts(run, events = [], {
  eventsAvailable = true
} = {}) {
  const safeEvents = Array.isArray(events) ? events : [];
  const attempts = new Set(
    [run?.attemptId, ...safeEvents.map((event) => event?.attemptId)]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  const tools = new Map();
  const policyDenials = [];
  const contextFailures = [];
  let eventUsage;

  for (const event of safeEvents) {
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    if (event?.type === "model.usage" || event?.type === "turn.completed") {
      eventUsage = projectedUsage(data.usage) || eventUsage;
      continue;
    }
    if (event?.type === "run.completed") {
      eventUsage = projectedUsage(data.usage) || eventUsage;
      continue;
    }
    if (event?.type === "tool.completed") {
      const callId = safeIdentifier(data.callId, `tool-${event.sequence || tools.size + 1}`);
      const key = `${safeIdentifier(event.attemptId, "attempt")}:${callId}`;
      tools.set(key, {
        name: safeIdentifier(data.name, "tool"),
        status: data.ok === false ? "failed" : "completed",
        ...(eventTurn(data) ? { turn: eventTurn(data) } : {})
      });
      continue;
    }
    if (event?.type === "tool.denied") {
      const callId = safeIdentifier(data.callId, `tool-${event.sequence || tools.size + 1}`);
      const key = `${safeIdentifier(event.attemptId, "attempt")}:${callId}`;
      const tool = safeIdentifier(data.name, "tool");
      const type = denialType(data.denialType);
      tools.set(key, {
        name: tool,
        status: "denied",
        ...(eventTurn(data) ? { turn: eventTurn(data) } : {})
      });
      policyDenials.push({
        tool,
        type,
        ...(eventTurn(data) ? { turn: eventTurn(data) } : {})
      });
      continue;
    }
    if (event?.type === "context.failed") {
      contextFailures.push({
        providerId: safeIdentifier(data.providerId, "unknown"),
        stage: data.stage === "pre" || data.stage === "post"
          ? data.stage
          : "unknown",
        ...(eventTurn(data) ? { turn: eventTurn(data) } : {})
      });
    }
  }

  const duration = run?.completedAt && run?.createdAt
    ? Math.max(0, Number(run.completedAt) - Number(run.createdAt))
    : undefined;
  const toolValues = [...tools.values()];
  const usage = projectedUsage(run?.usage) || eventUsage;
  return {
    status: safeIdentifier(run?.status, "unknown"),
    ...(run?.terminalReason
      ? { terminalReason: safeIdentifier(run.terminalReason, "unknown") }
      : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
    eventCount: eventsAvailable ? safeEvents.length : 0,
    lastSequence: eventsAvailable
      ? safeEvents.reduce(
          (maximum, event) => Math.max(maximum, optionalInteger(event?.sequence) || 0),
          0
        )
      : 0,
    attemptCount: Math.max(1, attempts.size),
    ...(usage ? { usage } : {}),
    tools: toolValues.slice(0, MAX_LEDGER_TOOLS),
    policyDenials: policyDenials.slice(0, MAX_LEDGER_FAILURES),
    contextFailures: contextFailures.slice(0, MAX_LEDGER_FAILURES),
    counts: {
      tools: toolValues.length,
      policyDenials: policyDenials.length,
      contextFailures: contextFailures.length
    },
    truncated: {
      tools: toolValues.length > MAX_LEDGER_TOOLS,
      policyDenials: policyDenials.length > MAX_LEDGER_FAILURES,
      contextFailures: contextFailures.length > MAX_LEDGER_FAILURES
    }
  };
}

function tagMap(span) {
  return new Map(
    (Array.isArray(span?.tags) ? span.tags : [])
      .map((tag) => [String(tag?.key || ""), tag?.value])
      .filter(([key]) => key)
  );
}

function processFor(trace, span) {
  const processes = trace?.processes && typeof trace.processes === "object"
    ? trace.processes
    : {};
  return processes[String(span?.processID || "")] || {};
}

function stageKind(operationName) {
  if (operationName === "invoke_agent") return "attempt";
  if (operationName === "chat") return "model";
  if (operationName === "execute_tool") return "tool";
  return "";
}

function stageStatus(tags) {
  const errorType = compactText(tags.get("error.type"), 80);
  const otelStatus = String(tags.get("otel.status_code") || "").toUpperCase();
  const runStatus = String(tags.get("zion.run.status") || "");
  const cancellation = String(tags.get("zion.cancellation.reason") || "");
  if (cancellation) return cancellation === "timeout" ? "error" : "cancelled";
  if (tags.get("zion.tool.ok") === false) return "error";
  if (errorType || otelStatus === "ERROR" || runStatus === "failed") return "error";
  return "ok";
}

function optionalNumber(tags, key) {
  const value = Number(tags.get(key));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalBoolean(tags, key) {
  const value = tags.get(key);
  return typeof value === "boolean" ? value : undefined;
}

function stageFromSpan(trace, span) {
  const operationName = String(span?.operationName || "");
  const kind = stageKind(operationName);
  if (!kind) return null;
  const tags = tagMap(span);
  const service = safeIdentifier(
    processFor(trace, span)?.serviceName,
    "unknown"
  );
  const name = kind === "model"
    ? safeIdentifier(tags.get("gen_ai.request.model"), "model")
    : kind === "tool"
      ? safeIdentifier(tags.get("gen_ai.tool.name"), "tool")
      : "Agent attempt";
  const input = optionalNumber(tags, "gen_ai.usage.input_tokens");
  const output = optionalNumber(tags, "gen_ai.usage.output_tokens");
  const reasoning = optionalNumber(tags, "gen_ai.usage.reasoning.output_tokens");
  const firstChunkSeconds = optionalNumber(
    tags,
    "gen_ai.response.time_to_first_chunk"
  );
  const consumerWaitSeconds = optionalNumber(
    tags,
    "zion.model.consumer_wait.duration"
  );
  const credentialSeconds = optionalNumber(
    tags,
    "zion.model.credential.duration"
  );
  const spanDurationMs = durationMs(span?.duration);
  const consumerWaitMs = consumerWaitSeconds === undefined
    ? undefined
    : consumerWaitSeconds * 1000;
  const httpStatus = optionalNumber(tags, "http.response.status_code");
  const toolOk = optionalBoolean(tags, "zion.tool.ok");
  const artifactCount = optionalNumber(tags, "zion.tool.artifact_count");
  const changeCount = optionalNumber(tags, "zion.tool.change_count");
  return {
    spanId: String(span?.spanID || ""),
    parentSpanId: String(
      (Array.isArray(span?.references) ? span.references : [])
        .find((reference) => reference?.refType === "CHILD_OF")?.spanID || ""
    ),
    startTimeMicros: finiteNumber(span?.startTime),
    kind,
    name,
    ...(service ? { service } : {}),
    status: stageStatus(tags),
    durationMs: spanDurationMs,
    ...(kind === "model" && consumerWaitMs !== undefined
      ? {
          consumerWaitMs,
          activeDurationMs: Math.max(0, spanDurationMs - consumerWaitMs)
        }
      : {}),
    ...(firstChunkSeconds !== undefined
      ? { firstChunkMs: firstChunkSeconds * 1000 }
      : {}),
    ...(kind === "model" && credentialSeconds !== undefined
      ? { credentialMs: credentialSeconds * 1000 }
      : {}),
    ...(kind === "model" && httpStatus !== undefined
      ? { httpStatus: Math.floor(httpStatus) }
      : {}),
    ...(tags.get("error.type")
      ? { errorType: safeIdentifier(tags.get("error.type"), "unknown") }
      : {}),
    ...(input !== undefined || output !== undefined || reasoning !== undefined
      ? {
          tokenUsage: {
            ...(input !== undefined ? { input } : {}),
            ...(output !== undefined ? { output } : {}),
            ...(reasoning !== undefined ? { reasoning } : {})
          }
        }
      : {}),
    ...(kind === "tool"
      ? {
          receiptHit: tags.get("zion.tool.receipt_hit") === true,
          ...(toolOk !== undefined ? { toolOk } : {}),
          ...(artifactCount !== undefined
            ? { artifactCount: Math.floor(artifactCount) }
            : {}),
          ...(changeCount !== undefined
            ? { changeCount: Math.floor(changeCount) }
            : {}),
          ...(tags.get("zion.tool.host_kind")
            ? { hostKind: safeIdentifier(tags.get("zion.tool.host_kind"), "unknown") }
            : {})
        }
      : {}),
    _tags: tags
  };
}

function runOutcome(run) {
  if (run?.status === "completed") return "success";
  if (run?.status === "failed" || run?.status === "interrupted") return "failed";
  if (run?.status === "aborted") {
    return run?.terminalReason === "timeout" ? "timeout" : "cancelled";
  }
  return "unknown";
}

function mergedIntervalDuration(stages, root) {
  if (!root) return 0;
  const rootStart = root.startTimeMicros;
  const rootEnd = rootStart + root.durationMs * 1000;
  const intervals = stages
    .filter((stage) => stage.kind !== "attempt")
    .map((stage) => [
      Math.max(rootStart, stage.startTimeMicros),
      Math.min(rootEnd, stage.startTimeMicros + stage.durationMs * 1000)
    ])
    .filter(([start, end]) => end > start)
    .sort(([left], [right]) => left - right);
  let covered = 0;
  let current = null;
  for (const interval of intervals) {
    if (!current || interval[0] > current[1]) {
      if (current) covered += current[1] - current[0];
      current = [...interval];
    } else {
      current[1] = Math.max(current[1], interval[1]);
    }
  }
  if (current) covered += current[1] - current[0];
  return covered / 1000;
}

function coverageFor(stages) {
  const coverage = [];
  if (stages.some((stage) => stage.kind === "attempt")) coverage.push("attempt");
  if (stages.some((stage) => stage.kind === "model")) coverage.push("model");
  if (stages.some((stage) => stage.kind === "tool")) coverage.push("tool");
  return coverage;
}

function publicStage(stage) {
  const output = { ...stage };
  delete output.spanId;
  delete output.parentSpanId;
  delete output.startTimeMicros;
  delete output._tags;
  return output;
}

function durationLabel(value) {
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function buildFindings(run, stages, root, largestObservedStage, unattributedMs) {
  const findings = [];
  const rootRunStatus = String(root?._tags?.get("zion.run.status") || "");
  if (rootRunStatus && rootRunStatus !== run.status) {
    findings.push({
      code: "run_trace_status_mismatch",
      severity: "error",
      evidence: [`run=${run.status}`, `trace=${rootRunStatus}`]
    });
  }
  const errors = stages.filter((stage) => stage.status === "error");
  if (errors.length) {
    findings.push({
      code: "error_stage",
      severity: "error",
      evidence: errors.slice(0, 5).map((stage) =>
        `${stage.kind}:${stage.name}${stage.errorType ? ` (${stage.errorType})` : ""}`
      )
    });
  }
  if (largestObservedStage && root?.durationMs > 0) {
    findings.push({
      code: "largest_observed_stage",
      severity: "info",
      evidence: [
        `${largestObservedStage.stage}:${largestObservedStage.name}=${durationLabel(largestObservedStage.durationMs)}`,
        `share=${Math.round((largestObservedStage.share || 0) * 100)}%`
      ]
    });
  }
  for (const stage of stages.filter((item) =>
    item.kind === "model" && Number(item.firstChunkMs) >= 1000
  )) {
    findings.push({
      code: "slow_first_chunk",
      severity: "warning",
      evidence: [
        `model=${stage.name}`,
        `firstChunk=${durationLabel(stage.firstChunkMs)}`
      ]
    });
  }
  for (const stage of stages.filter((item) =>
    item.kind === "tool" && item.receiptHit
  )) {
    findings.push({
      code: "tool_receipt_hit",
      severity: "info",
      evidence: [`tool=${stage.name}`, "receiptHit=true"]
    });
  }
  for (const stage of stages.filter((item) =>
    item.kind === "model"
    && Number(item.consumerWaitMs) > Number(item.durationMs) * 0.2
  )) {
    findings.push({
      code: "model_consumer_backpressure",
      severity: "warning",
      evidence: [
        `model=${stage.name}`,
        `consumerWait=${durationLabel(stage.consumerWaitMs)}`,
        `wallTime=${durationLabel(stage.durationMs)}`
      ]
    });
  }
  if (root && unattributedMs > Math.max(10, root.durationMs * 0.25)) {
    findings.push({
      code: "runtime_unattributed",
      severity: "warning",
      evidence: [
        `unattributed=${durationLabel(unattributedMs)}`,
        `attempt=${durationLabel(root.durationMs)}`
      ]
    });
  }
  return findings;
}

function baseSummary(run, availability, correlation, {
  events = [],
  eventsAvailable = true,
  traceState,
  includeStages = true,
  includeFindings = true
} = {}) {
  const duration = run.completedAt && run.createdAt
    ? Math.max(0, Number(run.completedAt) - Number(run.createdAt))
    : undefined;
  const outcome = runOutcome(run);
  const coverage = eventsAvailable ? ["run-events"] : [];
  return {
    schemaVersion: 1,
    runId: run.id,
    attemptId: run.attemptId,
    availability,
    source: {
      runLedger: true,
      runEvents: eventsAvailable,
      trace: false
    },
    ledger: projectRunLedgerFacts(run, events, { eventsAvailable }),
    ...(correlation ? { correlation } : {}),
    ...(traceState ? { traceState } : {}),
    coverage,
    summary: {
      outcome,
      ...(duration !== undefined ? { durationMs: duration } : {}),
      headline: availability === "active"
        ? "Run 仍在执行，Trace 尚未完整导出。"
        : availability === "unsampled"
          ? "本次 Run 未被采样，可继续查看 Run Ledger。"
          : availability === "telemetry-disabled"
            ? "当前 Runtime 未配置可查询的 Trace Backend。"
            : availability === "backend-unavailable"
              ? "Trace Backend 暂时不可用。"
              : "Trace 不可用，可继续查看 Run Ledger。",
      confidence: eventsAvailable ? "medium" : "low"
    },
    counts: {
      stages: 0,
      findings: 0
    },
    truncated: {
      stages: false,
      findings: false
    },
    ...(includeStages ? { stages: [] } : {}),
    ...(includeFindings ? { findings: [] } : {}),
    limitations: [
      "没有可用的完整 Trace。",
      ...(!eventsAvailable ? ["RunEvent details were unavailable."] : [])
    ]
  };
}

export function projectRunDiagnostic(run, trace, {
  events = [],
  eventsAvailable = true,
  includeStages = true,
  includeFindings = true,
  externalUrl = ""
} = {}) {
  const correlationValue = run?.metadata?.zionTelemetry || {};
  const correlation = correlationValue.traceId ? {
    traceId: String(correlationValue.traceId),
    sampled: Number(correlationValue.traceFlags) === 1
  } : null;
  const stages = (Array.isArray(trace?.spans) ? trace.spans : [])
    .map((span) => stageFromSpan(trace, span))
    .filter(Boolean)
    .sort((left, right) =>
      left.startTimeMicros - right.startTimeMicros
      || left.durationMs - right.durationMs
    );
  const root = stages.find((stage) => stage.kind === "attempt") || null;
  const candidates = stages.filter((stage) =>
    stage.kind === "model" || stage.kind === "tool"
  );
  const dominant = candidates.slice().sort((left, right) =>
    right.durationMs - left.durationMs
  )[0] || null;
  const rootDuration = root?.durationMs
    || Math.max(0, Number(run?.completedAt || 0) - Number(run?.createdAt || 0));
  const coveredMs = mergedIntervalDuration(stages, root);
  const unattributedMs = Math.max(0, rootDuration - coveredMs);
  const largestObservedStage = dominant ? {
    stage: dominant.kind,
    name: dominant.name,
    durationMs: dominant.durationMs,
    ...(rootDuration > 0
      ? { share: Math.min(1, dominant.durationMs / rootDuration) }
      : {})
  } : rootDuration > 0 ? {
    stage: "runtime-unattributed",
    durationMs: unattributedMs,
    share: unattributedMs / rootDuration
  } : undefined;
  const coverage = [
    ...(eventsAvailable ? ["run-events"] : []),
    ...coverageFor(stages)
  ];
  const findings = buildFindings(
    run,
    stages,
    root,
    dominant ? largestObservedStage : undefined,
    unattributedMs
  );
  const outcome = runOutcome(run);
  const headline = dominant
    ? `最大单个可观测阶段为 ${dominant.kind}:${dominant.name}（${durationLabel(dominant.durationMs)}）。`
    : "Trace 已找到，但没有可投影的模型或工具阶段。";
  const limitations = [
    ...(!coverage.includes("context") ? ["尚未覆盖 Context Provider 阶段。"] : []),
    ...(!coverage.includes("projection") ? ["尚未覆盖 Session/文档投影阶段。"] : []),
    ...(!coverage.includes("device") ? ["尚未拆分远端 Device 执行阶段。"] : []),
    ...(!eventsAvailable ? ["RunEvent details were unavailable."] : [])
  ];
  return {
    schemaVersion: 1,
    runId: run.id,
    attemptId: run.attemptId,
    availability: "ready",
    source: {
      runLedger: true,
      runEvents: eventsAvailable,
      trace: true
    },
    ledger: projectRunLedgerFacts(run, events, { eventsAvailable }),
    ...(correlation ? { correlation } : {}),
    coverage,
    summary: {
      outcome,
      ...(rootDuration > 0 ? { durationMs: rootDuration } : {}),
      headline,
      confidence: root ? "high" : "medium"
    },
    ...(largestObservedStage ? { largestObservedStage } : {}),
    counts: {
      stages: stages.length,
      findings: findings.length
    },
    truncated: {
      stages: stages.length > MAX_STAGES,
      findings: findings.length > MAX_FINDINGS
    },
    ...(includeStages
      ? { stages: stages.slice(0, MAX_STAGES).map(publicStage) }
      : {}),
    ...(includeFindings
      ? { findings: findings.slice(0, MAX_FINDINGS) }
      : {}),
    limitations,
    ...(externalUrl ? { externalUrl } : {})
  };
}

export function projectUnavailableRunDiagnostic(
  run,
  availability,
  correlation,
  options = {}
) {
  if (!TERMINAL_STATUSES.has(run.status)) {
    return baseSummary(run, "active", correlation, options);
  }
  return baseSummary(run, availability, correlation, options);
}
