import {
  projectRunDiagnostic,
  projectUnavailableRunDiagnostic
} from "./run-diagnostic-projector.mjs";

const TRACE_ID_PATTERN = /^[a-f0-9]{32}$/i;
const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted", "interrupted"]);
const TRACE_INDEX_GRACE_MS = 5_000;
const DEFAULT_OVERVIEW_WINDOW_MINUTES = 30;
const MAX_OVERVIEW_WINDOW_MINUTES = 1_440;
const DEFAULT_OVERVIEW_LIMIT = 10;
const MAX_OVERVIEW_LIMIT = 50;
const DEFAULT_MIN_DURATION_MS = 30_000;
const MAX_MIN_DURATION_MS = 24 * 60 * 60_000;

function compactText(value, max = 200) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function traceCorrelation(run) {
  const value = run?.metadata?.zionTelemetry;
  if (!value || typeof value !== "object") return null;
  const traceId = String(value.traceId || "").trim();
  if (!TRACE_ID_PATTERN.test(traceId)) return null;
  return {
    traceId,
    sampled: Number(value.traceFlags) === 1
  };
}

function normalizeTraceUrlTemplate(value) {
  const template = String(value || "").trim();
  if (!template) return "";
  if (!template.includes("{traceId}")) {
    throw new Error("Trace URL template must include {traceId}");
  }
  const probe = new globalThis.URL(
    template.replace("{traceId}", "0".repeat(32))
  );
  if (!["http:", "https:"].includes(probe.protocol)) {
    throw new Error("Trace URL template must use HTTP(S)");
  }
  if (probe.username || probe.password) {
    throw new Error("Trace URL template must not contain credentials");
  }
  return template;
}

function externalTraceUrl(template, traceId) {
  if (!template || !TRACE_ID_PATTERN.test(String(traceId || ""))) return "";
  return template.replace("{traceId}", encodeURIComponent(traceId));
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function runDuration(run, now) {
  const start = Number(run?.createdAt);
  const end = TERMINAL_STATUSES.has(run?.status)
    ? Number(run?.completedAt || run?.updatedAt)
    : Number(now);
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, end - start)
    : undefined;
}

function overviewTraceState(run) {
  if (ACTIVE_STATUSES.has(run?.status)) return "active";
  const correlation = traceCorrelation(run);
  if (!correlation) return "missing";
  return correlation.sampled ? "queryable" : "unsampled";
}

function sampledWithoutCorrelation(run) {
  const telemetry = run?.metadata?.zionTelemetry;
  return !!telemetry
    && typeof telemetry === "object"
    && Number(telemetry.traceFlags) === 1
    && !traceCorrelation(run);
}

function sameVisibilityBoundary(run, requester = {}) {
  const requesterRunId = String(requester.runId || "");
  const requesterSessionId = String(requester.sessionId || "");
  const requesterProjectId = String(requester.projectId || "");
  if (requesterRunId && run.id === requesterRunId) return true;
  if (
    requesterSessionId
    && run.sessionId
    && requesterSessionId === String(run.sessionId)
  ) {
    return true;
  }
  return !!(
    requesterProjectId
    && run.projectId
    && requesterProjectId === String(run.projectId)
  );
}

export class RuntimeObservabilityService {
  constructor({
    runs,
    traceReader = null,
    traceUrlTemplate = "",
    now = () => Date.now(),
    cacheTtlMs = 30_000,
    cacheLimit = 100
  } = {}) {
    if (!runs?.get) throw new Error("Observability Service requires a Run Store");
    this.runs = runs;
    this.traceReader = traceReader;
    this.traceUrlTemplate = normalizeTraceUrlTemplate(traceUrlTemplate);
    this.now = now;
    this.cacheTtlMs = Math.max(0, Number(cacheTtlMs) || 0);
    this.cacheLimit = Math.max(1, Number(cacheLimit) || 100);
    this.cache = new Map();
  }

  get enabled() {
    return !!this.traceReader;
  }

  configuration() {
    return {
      enabled: this.enabled,
      backend: this.enabled ? "jaeger" : "none",
      externalTraceLinks: !!this.traceUrlTemplate
    };
  }

  async status({ signal } = {}) {
    if (!this.traceReader) {
      return {
        enabled: false,
        backend: "none",
        queryBackend: {
          available: false,
          reason: "telemetry-disabled"
        }
      };
    }
    try {
      const health = await this.traceReader.health(signal);
      return {
        enabled: true,
        backend: "jaeger",
        queryBackend: {
          available: health?.available === true,
          serviceCount: Math.max(0, Number(health?.serviceCount) || 0)
        },
        externalTraceLinks: !!this.traceUrlTemplate
      };
    } catch (error) {
      return {
        enabled: true,
        backend: "jaeger",
        queryBackend: {
          available: false,
          reason: compactText(error?.code || "backend-unavailable", 80)
        }
      };
    }
  }

  getCached(traceId) {
    const cached = this.cache.get(traceId);
    if (!cached || cached.expiresAt <= this.now()) {
      this.cache.delete(traceId);
      return null;
    }
    return cached.trace;
  }

  setCached(traceId, trace) {
    if (!this.cacheTtlMs) return;
    this.cache.delete(traceId);
    this.cache.set(traceId, {
      trace,
      expiresAt: this.now() + this.cacheTtlMs
    });
    while (this.cache.size > this.cacheLimit) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  async diagnoseRun(runId, {
    signal,
    requester = null,
    enforceVisibility = false,
    includeLedger = true,
    includeStages = true,
    includeFindings = true,
    includeExternalUrl = false
  } = {}) {
    const explicitId = String(runId || "").trim();
    const run = explicitId
      ? await this.runs.get(explicitId)
      : await this.resolveRecentRun(requester);
    if (!run || (enforceVisibility && !sameVisibilityBoundary(run, requester))) {
      return null;
    }
    const eventProjection = includeLedger
      ? await this.readRunEvents(run.id) : { events: [], eventsAvailable: false };
    const projectionOptions = {
      ...eventProjection,
      includeStages,
      includeFindings
    };
    const correlation = traceCorrelation(run);
    if (ACTIVE_STATUSES.has(run.status)) {
      return projectUnavailableRunDiagnostic(
        run,
        "active",
        correlation,
        projectionOptions
      );
    }
    if (!this.traceReader) {
      return projectUnavailableRunDiagnostic(
        run,
        "telemetry-disabled",
        correlation,
        projectionOptions
      );
    }
    if (!correlation) {
      return projectUnavailableRunDiagnostic(run, "not-found", null, {
        ...projectionOptions,
        traceState: {
          reason: "no-correlation",
          retryable: false
        }
      });
    }
    if (!correlation.sampled) {
      return projectUnavailableRunDiagnostic(
        run,
        "unsampled",
        correlation,
        projectionOptions
      );
    }
    let trace = this.getCached(correlation.traceId);
    if (!trace) {
      try {
        trace = await this.traceReader.getTrace(correlation.traceId, signal);
      } catch {
        return projectUnavailableRunDiagnostic(
          run,
          "backend-unavailable",
          correlation,
          projectionOptions
        );
      }
      if (trace) this.setCached(correlation.traceId, trace);
    }
    if (!trace) {
      const terminalAt = Number(run.completedAt || run.updatedAt || 0);
      const pending = terminalAt > 0
        && Math.max(0, this.now() - terminalAt) <= TRACE_INDEX_GRACE_MS;
      return projectUnavailableRunDiagnostic(run, "not-found", correlation, {
        ...projectionOptions,
        traceState: {
          reason: pending ? "pending-index" : "trace-missing",
          retryable: pending
        }
      });
    }
    return projectRunDiagnostic(run, trace, {
      ...projectionOptions,
      externalUrl: includeExternalUrl
        ? externalTraceUrl(this.traceUrlTemplate, correlation.traceId)
        : ""
    });
  }

  async readRunEvents(runId) {
    if (typeof this.runs.getEvents !== "function") {
      return { events: [], eventsAvailable: false };
    }
    try {
      const events = await this.runs.getEvents(runId);
      return {
        events: Array.isArray(events) ? events : [],
        eventsAvailable: true
      };
    } catch {
      return { events: [], eventsAvailable: false };
    }
  }

  async resolveRecentRun(requester = {}) {
    const sessionId = String(requester?.sessionId || "").trim();
    if (!sessionId || typeof this.runs.getSessionMessages !== "function") {
      return null;
    }
    let messages;
    try {
      messages = await this.runs.getSessionMessages(sessionId);
    } catch {
      return null;
    }
    const seen = new Set();
    const requesterRunId = String(requester?.runId || "");
    for (const message of (Array.isArray(messages) ? messages : []).slice().reverse()) {
      const candidateId = String(message?.runId || "").trim();
      if (!candidateId || candidateId === requesterRunId || seen.has(candidateId)) {
        continue;
      }
      seen.add(candidateId);
      const candidate = await this.runs.get(candidateId);
      if (
        candidate
        && String(candidate.sessionId || "") === sessionId
        && TERMINAL_STATUSES.has(candidate.status)
      ) {
        return candidate;
      }
    }
    return null;
  }

  async overview({
    windowMinutes = DEFAULT_OVERVIEW_WINDOW_MINUTES,
    limit = DEFAULT_OVERVIEW_LIMIT,
    minDurationMs = DEFAULT_MIN_DURATION_MS
  } = {}, {
    signal,
    requester = null
  } = {}) {
    const projectId = String(requester?.projectId || "").trim();
    const sessionId = String(requester?.sessionId || "").trim();
    const scope = projectId
      ? { kind: "project", id: projectId }
      : sessionId
        ? { kind: "session", id: sessionId }
        : null;
    if (!scope || typeof this.runs.listRuns !== "function") return null;

    const normalizedWindowMinutes = boundedInteger(
      windowMinutes,
      DEFAULT_OVERVIEW_WINDOW_MINUTES,
      1,
      MAX_OVERVIEW_WINDOW_MINUTES
    );
    const normalizedLimit = boundedInteger(
      limit,
      DEFAULT_OVERVIEW_LIMIT,
      1,
      MAX_OVERVIEW_LIMIT
    );
    const normalizedMinDurationMs = boundedInteger(
      minDurationMs,
      DEFAULT_MIN_DURATION_MS,
      1_000,
      MAX_MIN_DURATION_MS
    );
    const until = this.now();
    const since = until - normalizedWindowMinutes * 60_000;
    const candidateLimit = Math.min(500, normalizedLimit * 10);
    const candidates = await this.runs.listRuns({
      since,
      limit: candidateLimit
    });
    const visible = candidates.filter((run) => (
      scope.kind === "project"
        ? String(run?.projectId || "") === scope.id
        : String(run?.sessionId || "") === scope.id
    ));
    const problemRuns = [];
    for (const run of visible) {
      const signals = [];
      if (run.status === "failed") signals.push("failed");
      if (run.status === "interrupted") signals.push("interrupted");
      if (run.status === "aborted" && run.terminalReason === "timeout") {
        signals.push("timeout");
      }
      const durationMs = runDuration(run, until);
      if (
        TERMINAL_STATUSES.has(run.status)
        && durationMs !== undefined
        && durationMs >= normalizedMinDurationMs
      ) {
        signals.push("slow");
      }
      if (
        ACTIVE_STATUSES.has(run.status)
        && Math.max(0, until - Number(run.updatedAt || 0)) >= normalizedMinDurationMs
      ) {
        signals.push("stalled");
      }
      const traceState = overviewTraceState(run);
      if (TERMINAL_STATUSES.has(run.status) && sampledWithoutCorrelation(run)) {
        signals.push("trace-missing");
      }
      if (!signals.length) continue;
      problemRuns.push({
        runId: String(run.id),
        status: String(run.status),
        ...(durationMs !== undefined ? { durationMs } : {}),
        updatedAt: Number(run.updatedAt) || 0,
        traceState,
        signals
      });
    }

    const selected = problemRuns.slice(0, normalizedLimit);
    const totals = {
      inspected: visible.length,
      problems: problemRuns.length,
      failed: problemRuns.filter((run) => run.signals.includes("failed")).length,
      timeout: problemRuns.filter((run) => run.signals.includes("timeout")).length,
      interrupted: problemRuns.filter((run) =>
        run.signals.includes("interrupted")
      ).length,
      slow: problemRuns.filter((run) => run.signals.includes("slow")).length,
      stalled: problemRuns.filter((run) => run.signals.includes("stalled")).length,
      traceMissing: problemRuns.filter((run) =>
        run.signals.includes("trace-missing")
      ).length
    };
    const backendStatus = await this.status({ signal });
    return {
      schemaVersion: 1,
      scope,
      window: {
        since,
        until,
        minutes: normalizedWindowMinutes
      },
      thresholds: {
        slowMs: normalizedMinDurationMs,
        stalledMs: normalizedMinDurationMs
      },
      backend: {
        queryAvailable: backendStatus.queryBackend?.available === true
      },
      totals,
      runs: selected,
      truncated: candidates.length >= candidateLimit
        || problemRuns.length > selected.length
    };
  }
}

export function createRuntimeObservabilityService(options) {
  return new RuntimeObservabilityService(options);
}
