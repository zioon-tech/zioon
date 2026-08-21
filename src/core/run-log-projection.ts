import type {
  RunLedgerEvent,
  RunModelRef,
  RunRecord,
  RunStatus
} from "./run-ledger";

export type RunLogLevel = "debug" | "info" | "warn" | "error";

export type RunLogSourceKind = string;

export type RunLogRow = {
  id: string;
  runId: string;
  timestamp: number;
  level: RunLogLevel;
  kind: "run" | "model" | "tool" | "policy" | "outcome";
  type: string;
  sourceKind: RunLogSourceKind;
  sourceId: string;
  sourceName?: string;
  summary: string;
  detail?: string;
  durationMs?: number;
  sessionId?: string;
  terminal: boolean;
};

export type RunLogGroup = {
  runId: string;
  title: string;
  sourceKind: RunLogSourceKind;
  sourceId: string;
  sourceName?: string;
  sessionId?: string;
  timestamp: number;
  status: string;
  level: RunLogLevel;
  expandedByDefault: boolean;
  modelSummary?: string;
  modelDetail?: string;
  providerSummary?: string;
  executionModeLabel?: string;
  tokenCount: number;
  durationMs?: number;
  rows: RunLogRow[];
};

export type RunLogFilter = {
  query?: string;
  level?: "all" | "info" | "warn" | "error";
  source?: "all" | RunLogSourceKind;
};

type ProjectionOptions = {
  after?: number;
  maxRows?: number;
  resolveSourceName?: (
    run: RunRecord,
    sourceKind: RunLogSourceKind,
    sourceId: string
  ) => string | null | undefined;
};

function safeText(value: unknown, max = 500): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeNumber(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function modelFrom(value: unknown): RunModelRef | null {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!input) return null;
  const providerId = safeText(input.providerId, 120);
  const modelId = safeText(input.modelId || input.id, 180);
  const label = safeText(input.label, 180);
  if (!providerId && !modelId && !label) return null;
  return { providerId, modelId, label };
}

function modelKey(model: RunModelRef | null | undefined): string {
  if (!model) return "";
  return [
    safeText(model.providerId, 120),
    safeText(model.modelId, 180),
    safeText(model.label, 180)
  ].join("\u0000");
}

function modelLabel(model: RunModelRef | null | undefined): string {
  if (!model) return "";
  return safeText(model.label || model.modelId || model.providerId, 180);
}

function providerLabel(model: RunModelRef | null | undefined): string {
  return safeText(model?.providerId, 120);
}

function modelForEvent(event: RunLedgerEvent): RunModelRef | null {
  const data = eventData(event);
  if (!["run.started", "turn.started", "model.usage"].includes(safeText(event.type, 120))) {
    return null;
  }
  return modelFrom(data.model);
}

function modelTrailFor(run: RunRecord, events: RunLedgerEvent[]): RunModelRef[] {
  const trail: RunModelRef[] = [];
  const push = (model: RunModelRef | null) => {
    const key = modelKey(model);
    if (!key || modelKey(trail[trail.length - 1]) === key) return;
    trail.push(model as RunModelRef);
  };
  const sortedEvents = events.slice().sort((a, b) => safeNumber(a.ts) - safeNumber(b.ts));
  for (const event of sortedEvents) {
    push(modelForEvent(event));
  }
  if (trail.length === 0) push(modelFrom(run.model));
  return trail;
}

function modelSummaryFor(models: RunModelRef[]): string {
  const labels = models.map(modelLabel).filter(Boolean);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  const extra = labels.length > 2 ? ` +${labels.length - 2}` : "";
  return `${labels[0]} -> ${labels[labels.length - 1]}${extra}`;
}

function modelDetailFor(models: RunModelRef[]): string {
  return models.map((model) => {
    const label = modelLabel(model);
    const provider = providerLabel(model);
    return provider && label !== provider ? `${label} (${provider})` : label;
  }).filter(Boolean).join(" -> ");
}

function providerSummaryFor(models: RunModelRef[]): string {
  const providers = Array.from(new Set(models.map(providerLabel).filter(Boolean)));
  if (providers.length === 0) return "";
  return providers.length === 1 ? providers[0] : "mixed";
}

function executionModeLabel(value: unknown): string {
  const mode = safeText(value, 80);
  if (mode === "interactive") return "交互";
  if (mode === "local-only") return "本地自动";
  if (mode === "service-backed") return "服务托管";
  return mode;
}

function sourceKindFor(run: RunRecord): RunLogSourceKind {
  const kind = safeText(run.source?.kind, 80) as RunLogSourceKind;
  if (kind === "chat-session" && isCommentRun(run)) return "comment";
  if (isCommentRun(run)) return "comment";
  return kind || "core";
}

function sourceIdFor(run: RunRecord): string {
  return safeText(run.source?.id, 160) || safeText(run.id, 180);
}

function isCommentRun(run: RunRecord): boolean {
  const sourceId = safeText(run.source?.id, 180);
  const sessionId = safeText(run.sessionId, 180);
  const panelId = safeText(run.panelId, 180);
  const requestSource = safeText(run.metadata?.requestSource, 80);
  if (safeText(run.source?.kind, 80) === "comment") return true;
  return sourceId.startsWith("comment:")
    || sessionId.startsWith("comment:")
    || panelId.startsWith("comments:")
    || requestSource === "comments";
}

function metadataSourceName(run: RunRecord): string {
  const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata : {};
  return safeText(
    metadata.displayName
    || metadata.sourceName
    || metadata.sessionTitle
    || metadata.commentTitle
    || metadata.threadTitle
    || metadata.sourceTitle,
    180
  );
}

function sourceNameFor(
  run: RunRecord,
  sourceKind: RunLogSourceKind,
  sourceId: string,
  resolveSourceName?: ProjectionOptions["resolveSourceName"]
): string {
  const resolved = safeText(resolveSourceName?.(run, sourceKind, sourceId), 180);
  return resolved || metadataSourceName(run);
}

function groupTitleFor(
  run: RunRecord,
  sourceKind: RunLogSourceKind,
  sourceId: string,
  sourceName: string
): string {
  const runTitle = safeText(run.title, 180);
  if ((sourceKind === "chat-session" || sourceKind === "comment") && sourceName) {
    return sourceName;
  }
  return runTitle || sourceName || sourceId;
}

function groupLevelFor(status: RunStatus): RunLogLevel {
  if (status === "failed" || status === "interrupted") return "error";
  if (status === "stopped") return "warn";
  return "info";
}

function terminalStatus(status: RunStatus): boolean {
  return ["completed", "failed", "stopped", "interrupted"].includes(status);
}

function eventData(event: RunLedgerEvent): Record<string, unknown> {
  return event.data && typeof event.data === "object" ? event.data : {};
}

function toolDuration(run: RunRecord, callId: string): number | undefined {
  const duration = run.tools.find((tool) => tool.id === callId)?.durationMs;
  return safeNumber(duration) || undefined;
}

function projectModelSwitch(
  run: RunRecord,
  event: RunLedgerEvent,
  previous: RunModelRef | null,
  next: RunModelRef | null,
  sourceKind: RunLogSourceKind,
  sourceId: string,
  sourceName: string
): RunLogRow | null {
  const previousLabel = modelLabel(previous);
  const nextLabel = modelLabel(next);
  if (!previousLabel || !nextLabel || modelKey(previous) === modelKey(next)) return null;
  const runId = safeText(run.id, 180);
  const timestamp = safeNumber(event.ts);
  return {
    id: `${safeText(event.id, 180) || `${runId}:model`}:selected`,
    runId,
    timestamp,
    level: "info",
    kind: "model",
    type: "model.selected",
    sourceKind,
    sourceId,
    sourceName: sourceName || undefined,
    summary: `模型切换 · ${previousLabel} -> ${nextLabel}`,
    detail: providerLabel(next) || undefined,
    sessionId: run.sessionId,
    terminal: false
  };
}

function quotaFailure(reason: string): boolean {
  return /quota|budget|limit|exceeded|terminated/i.test(reason);
}

function outcomeLevel(verdict: string): RunLogLevel {
  if (verdict === "invalid") return "error";
  if (verdict === "no-progress" || verdict === "needs-user") return "warn";
  return "info";
}

function projectEvent(
  run: RunRecord,
  event: RunLedgerEvent,
  sourceKind: RunLogSourceKind,
  sourceId: string,
  sourceName: string
): RunLogRow | null {
  const type = safeText(event.type, 120);
  const runId = safeText(event.runId, 180);
  const timestamp = safeNumber(event.ts);
  if (!type || !runId || !timestamp || type === "message.delta" || type === "run.started" || type === "turn.started") {
    return null;
  }

  const data = eventData(event);
  const base = {
    id: safeText(event.id, 180) || `${runId}:${type}:${timestamp}`,
    runId,
    timestamp,
    sourceKind,
    sourceId,
    sourceName: sourceName || undefined,
    sessionId: run.sessionId,
    terminal: false
  };

  if (type === "tool.requested") {
    const name = safeText(data.name, 180) || "tool";
    return {
      ...base,
      level: "debug",
      kind: "tool",
      type,
      summary: `${name} requested`
    };
  }

  if (type === "tool.completed") {
    const name = safeText(data.name, 180) || "tool";
    const error = safeText(data.error, 500);
    const callId = safeText(data.callId, 180);
    return {
      ...base,
      level: error ? "error" : "info",
      kind: "tool",
      type,
      summary: error || `${name} completed`,
      detail: error ? name : undefined,
      durationMs: toolDuration(run, callId)
    };
  }

  if (type === "tool.denied") {
    const name = safeText(data.name, 180) || "tool";
    const reason = safeText(data.reason, 500) || `${name} denied`;
    return {
      ...base,
      level: quotaFailure(reason) ? "error" : "warn",
      kind: "policy",
      type,
      summary: reason,
      detail: name
    };
  }

  if (type === "model.usage" || type === "turn.completed") {
    const usage = data.usage && typeof data.usage === "object"
      ? data.usage as Record<string, unknown>
      : {};
    const total = safeNumber(usage.total)
      || safeNumber(usage.total_tokens)
      || safeNumber(usage.input) + safeNumber(usage.output);
    return {
      ...base,
      level: "debug",
      kind: "model",
      type,
      summary: total ? `Model usage - ${total.toLocaleString()} tokens` : "Model usage"
    };
  }

  if (type === "run.completed") {
    const durationMs = safeNumber(data.durationMs)
      || (run.completedAt && run.startedAt ? Math.max(0, run.completedAt - run.startedAt) : 0);
    return {
      ...base,
      level: "info",
      kind: "run",
      type,
      summary: "Run completed",
      durationMs: durationMs || undefined,
      terminal: true
    };
  }

  if (type === "run.failed") {
    return {
      ...base,
      level: "error",
      kind: "run",
      type,
      summary: safeText(data.error, 500) || safeText(run.error, 500) || "Run failed",
      terminal: true
    };
  }

  if (type === "run.aborted") {
    const reason = safeText(data.reason, 160) || safeText(run.terminalReason, 160) || "user";
    return {
      ...base,
      level: "warn",
      kind: "run",
      type,
      summary: `Run stopped - ${reason}`,
      terminal: true
    };
  }

  if (type === "run.interrupted") {
    return {
      ...base,
      level: "error",
      kind: "run",
      type,
      summary: safeText(run.error, 500) || "Run interrupted",
      terminal: true
    };
  }

  if (type === "outcome.submitted") {
    const verdict = safeText(data.verdict, 80);
    return {
      ...base,
      level: outcomeLevel(verdict),
      kind: "outcome",
      type,
      summary: safeText(data.summary, 500) || verdict || "Run outcome submitted"
    };
  }

  return {
    ...base,
    level: "debug",
    kind: "run",
    type,
    summary: type
  };
}

function projectRun(
  run: RunRecord,
  getEvents: (runId: string) => RunLedgerEvent[],
  after: number,
  resolveSourceName?: ProjectionOptions["resolveSourceName"]
): RunLogGroup | null {
  const runId = safeText(run?.id, 180);
  if (!runId) return null;
  const sourceKind = sourceKindFor(run);
  const sourceId = sourceIdFor(run);
  const sourceName = sourceNameFor(run, sourceKind, sourceId, resolveSourceName);
  const eventList = getEvents(runId);
  const events = Array.isArray(eventList) ? eventList : [];
  const sortedEvents = events.slice().sort((a, b) => safeNumber(a.ts) - safeNumber(b.ts));
  const modelTrail = modelTrailFor(run, events);
  const rows: RunLogRow[] = [];
  let previousModel = modelTrail.length > 0 ? null : modelFrom(run.model);
  for (const event of sortedEvents) {
    try {
      const timestamp = safeNumber(event?.ts);
      const nextModel = modelForEvent(event);
      const includeEvent = timestamp > after;
      const switchRow = includeEvent ? projectModelSwitch(run, event, previousModel, nextModel, sourceKind, sourceId, sourceName) : null;
      if (switchRow) rows.push(switchRow);
      if (nextModel) previousModel = nextModel;
      if (!includeEvent) continue;
      const projected = projectEvent(run, event, sourceKind, sourceId, sourceName);
      if (projected) rows.push(projected);
    } catch {
      rows.push({
        id: `${runId}:projection-error:${safeNumber(event?.ts) || run.updatedAt}`,
        runId,
        timestamp: safeNumber(event?.ts) || run.updatedAt,
        level: "error",
        kind: "run",
        type: "projection.error",
        sourceKind,
        sourceId,
        sourceName: sourceName || undefined,
        summary: "Unable to format run event",
        sessionId: run.sessionId,
        terminal: false
      });
    }
  }

  const timestamp = safeNumber(run.updatedAt) || safeNumber(run.startedAt);
  if (timestamp <= after && rows.length === 0) return null;
  const durationMs = run.completedAt && run.startedAt
    ? Math.max(0, run.completedAt - run.startedAt)
    : undefined;
  const active = run.status === "running" || run.status === "queued";

  return {
    runId,
    title: groupTitleFor(run, sourceKind, sourceId, sourceName),
    sourceKind,
    sourceId,
    sourceName: sourceName || undefined,
    sessionId: run.sessionId,
    timestamp,
    status: run.status,
    level: groupLevelFor(run.status),
    expandedByDefault: active,
    modelSummary: modelSummaryFor(modelTrail) || undefined,
    modelDetail: modelDetailFor(modelTrail) || undefined,
    providerSummary: providerSummaryFor(modelTrail) || undefined,
    executionModeLabel: executionModeLabel(run.executionMode) || undefined,
    tokenCount: safeNumber(run.usage?.total),
    durationMs,
    rows
  };
}

export function projectRunLogGroups(
  runs: RunRecord[],
  getEvents: (runId: string) => RunLedgerEvent[],
  options: ProjectionOptions = {}
): RunLogGroup[] {
  const after = safeNumber(options.after);
  let remaining = Math.max(1, safeNumber(options.maxRows) || 500);
  const groups = (Array.isArray(runs) ? runs : [])
    .flatMap((run) => {
      try {
        const group = projectRun(run, getEvents, after, options.resolveSourceName);
        return group ? [group] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((group) => {
      if (remaining <= 0) return { ...group, rows: [] };
      const rows = group.rows.length > remaining
        ? group.rows.slice(-remaining)
        : group.rows;
      remaining -= rows.length;
      return { ...group, rows };
    });

  return groups.filter((group) => group.rows.length > 0 || group.timestamp > after);
}

function textMatches(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query);
}

export function filterRunLogGroups(
  groups: RunLogGroup[],
  filter: RunLogFilter = {}
): RunLogGroup[] {
  const query = safeText(filter.query, 300).toLocaleLowerCase();
  const level = filter.level || "all";
  const source = filter.source || "all";

  return (Array.isArray(groups) ? groups : []).flatMap((group) => {
    if (source !== "all" && group.sourceKind !== source) return [];

    const groupMatchesQuery = !query || [
      group.runId,
      group.title,
      group.sourceKind,
      group.sourceId,
      group.sourceName,
      group.modelSummary,
      group.providerSummary,
      group.executionModeLabel,
      group.status
    ].some((value) => textMatches(String(value || ""), query));
    const groupMatchesLevel = level === "all" || group.level === level;

    const rows = group.rows.filter((row) => {
      const matchesQuery = !query || groupMatchesQuery || [
        row.summary,
        row.detail,
        row.type,
        row.runId,
        row.sourceId,
        row.sourceName
      ].some((value) => textMatches(String(value || ""), query));
      const matchesLevel = level === "all"
        ? row.level !== "debug"
        : row.level === level;
      return matchesQuery && matchesLevel;
    });

    if (!groupMatchesQuery && rows.length === 0) return [];
    if (!groupMatchesLevel && rows.length === 0) return [];
    return [{ ...group, rows }];
  });
}
