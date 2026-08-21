import type { ContextHealthRecommendation, ContextHealthSeverity } from "./run-health";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "stopped" | "interrupted";
export type RunTrigger = "user" | "schedule" | "supervisor" | "retry" | "system";

export type RunSourceRef = {
  pluginId: string;
  kind: string;
  id: string;
};

export type RunSourceKindRegistration = {
  kind: string;
  label: string;
  color?: string;
  order?: number;
  pluginId?: string;
};

export type RunModelRef = {
  providerId?: string;
  modelId?: string;
  label?: string;
};

export type RunUsageTokens = {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
};

export type RunContextHealth = {
  sessionId?: string;
  estimatedTokens: number;
  modelContextWindow: number;
  utilization: number;
  warningThreshold: number;
  criticalThreshold: number;
  messageCount: number;
  compressionCount: number;
  severity: ContextHealthSeverity;
  recommendation: ContextHealthRecommendation;
  reasons: string[];
  updatedAt: number;
};

export type RunToolSummary = {
  id: string;
  name: string;
  status: "requested" | "completed" | "failed" | "denied";
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  reason?: string;
  resultSize?: number;
};

export type RunOutcome = {
  runId: string;
  source?: RunSourceRef | null;
  verdict: "progressed" | "no-progress" | "invalid" | "needs-user" | "done";
  summary: string;
  evidence?: string[];
  nextStep?: string;
  confidence?: number;
  createdAt: number;
  createdBy?: string;
};

export type RunRecord = {
  id: string;
  title?: string;
  source: RunSourceRef | null;
  trigger: RunTrigger;
  sessionId?: string;
  panelId?: string | null;
  executionMode?: string;
  policyId?: string;
  policy?: any;
  budgetId?: string;
  model?: RunModelRef | null;
  metadata?: Record<string, any>;
  status: RunStatus;
  createdAt: number;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  terminalReason?: string;
  error?: string;
  usage: RunUsageTokens;
  contextHealth?: RunContextHealth;
  cost: number | null;
  currency: string;
  stepCount: number;
  toolCalls: number;
  deniedToolCalls: number;
  tools: RunToolSummary[];
  lastEventAt: number;
  outputPreview?: string;
  outputLength?: number;
  outcome?: RunOutcome;
};

export type RunLedgerEvent = {
  id: string;
  runId: string;
  type: string;
  ts: number;
  sequence?: number;
  data?: Record<string, any>;
};

export type RunListFilter = {
  source?: Partial<RunSourceRef>;
  status?: RunStatus | RunStatus[];
  sessionId?: string;
  since?: number;
  limit?: number;
};

export type RunLedgerSnapshot = {
  runs: RunRecord[];
  active: RunRecord[];
  totals: {
    count: number;
    active: number;
    failed: number;
    tokens: RunUsageTokens;
    cost: number | null;
    currency: string;
  };
};

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

type RunLedgerDocument = {
  version: 1;
  runs: RunRecord[];
  events: RunLedgerEvent[];
  outcomes: RunOutcome[];
};

type RunLedgerOptions = {
  storage?: StorageLike | null;
  storageKey?: string;
  emit?: (topic: string, payload?: any) => void;
  now?: () => number;
  id?: (prefix: string) => string;
  maxRuns?: number;
  maxEvents?: number;
  maxOutcomes?: number;
};

const DEFAULT_STORAGE_KEY = "zion.core.runLedger.v1";
const DEFAULT_CURRENCY = "USD";
const DEFAULT_MAX_RUNS = 500;
const DEFAULT_MAX_EVENTS = 5000;
const DEFAULT_MAX_OUTCOMES = 1000;
const DEFAULT_SOURCE_KINDS: RunSourceKindRegistration[] = [
  { kind: "project", label: "项目", color: "cyan", order: 10, pluginId: "core" },
  { kind: "agent-task", label: "Agent", color: "blue", order: 20, pluginId: "core" },
  { kind: "scheduled-task", label: "定时任务", color: "orange", order: 30, pluginId: "core" },
  { kind: "chat-session", label: "对话", color: "gray", order: 40, pluginId: "core" },
  { kind: "comment", label: "评论", color: "purple", order: 50, pluginId: "core" },
  { kind: "core", label: "Core", color: "gray", order: 1000, pluginId: "core" }
];

function emptyUsage(): RunUsageTokens {
  return { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function addUsage(a: RunUsageTokens, b: Partial<RunUsageTokens> | undefined): RunUsageTokens {
  return {
    input: Number(a.input || 0) + Number(b?.input || 0),
    output: Number(a.output || 0) + Number(b?.output || 0),
    total: Number(a.total || 0) + Number(b?.total || 0),
    cacheRead: Number(a.cacheRead || 0) + Number(b?.cacheRead || 0),
    cacheWrite: Number(a.cacheWrite || 0) + Number(b?.cacheWrite || 0),
    reasoning: Number(a.reasoning || 0) + Number(b?.reasoning || 0)
  };
}

function positiveInteger(value: any): number {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function normalizeRunUsage(value: any): RunUsageTokens {
  const input = positiveInteger(
    value?.input ??
    value?.prompt ??
    value?.prompt_tokens ??
    value?.input_tokens ??
    value?.cached_input_tokens ??
    value?.promptTokenCount
  );
  const output = positiveInteger(
    value?.output ??
    value?.completion ??
    value?.completion_tokens ??
    value?.output_tokens ??
    value?.candidatesTokenCount
  );
  const total = positiveInteger(value?.total ?? value?.total_tokens ?? value?.totalTokenCount) || input + output;
  return {
    input,
    output,
    total,
    cacheRead: positiveInteger(value?.cacheRead ?? value?.cache_read_input_tokens ?? value?.cached_tokens ?? value?.cachedContentTokenCount),
    cacheWrite: positiveInteger(value?.cacheWrite ?? value?.cache_creation_input_tokens ?? value?.cache_creation?.input_tokens),
    reasoning: positiveInteger(value?.reasoning ?? value?.reasoning_tokens ?? value?.thoughtsTokenCount)
  };
}

function stableId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${random}`;
}

function cleanString(value: any, max = 500): string {
  return String(value || "").trim().slice(0, max);
}

function normalizeSource(value: any): RunSourceRef | null {
  const pluginId = cleanString(value?.pluginId || value?.plugin || "", 120);
  const kind = cleanString(value?.kind || value?.type || "", 80);
  const id = cleanString(value?.id || value?.key || "", 160);
  if (!pluginId || !kind || !id) return null;
  return { pluginId, kind, id };
}

function normalizeModel(value: any): RunModelRef | null {
  if (!value) return null;
  const providerId = cleanString(value?.providerId || "", 120);
  const modelId = cleanString(value?.modelId || value?.id || "", 180);
  const label = cleanString(value?.label || "", 180);
  if (!providerId && !modelId && !label) return null;
  return { providerId, modelId, label };
}

function normalizeSourceKindRegistration(input: any): RunSourceKindRegistration | null {
  const kind = cleanString(input?.kind || "", 80);
  const label = cleanString(input?.label || kind, 80);
  if (!kind || !label) return null;
  const order = Number(input?.order);
  return {
    kind,
    label,
    color: cleanString(input?.color || "", 40) || undefined,
    order: Number.isFinite(order) ? order : undefined,
    pluginId: cleanString(input?.pluginId || input?.plugin || "", 120) || undefined
  };
}

function sanitizeModel(value: any): RunModelRef | undefined {
  return normalizeModel(value) || undefined;
}

function normalizeRecommendation(value: any): ContextHealthRecommendation {
  return ["continue", "compress", "new-session"].includes(value) ? value : "continue";
}

function normalizeSeverity(
  value: any,
  recommendation: ContextHealthRecommendation,
  utilization: number,
  warningThreshold: number,
  criticalThreshold: number
): ContextHealthSeverity {
  if (value === "critical" || value === "warning" || value === "ok") return value;
  if (recommendation === "new-session" || utilization >= criticalThreshold) return "critical";
  if (recommendation === "compress" || utilization >= warningThreshold) return "warning";
  return "ok";
}

function normalizeRatio(value: any, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(1, n);
}

function normalizeThreshold(value: any, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return fallback;
  return n;
}

function normalizeContextHealth(input: any, now = Date.now(), fallbackSessionId = ""): RunContextHealth {
  const estimatedTokens = positiveInteger(input?.estimatedTokens ?? input?.tokens ?? input?.contextTokens);
  const modelContextWindow = Math.max(
    1,
    positiveInteger(
      input?.modelContextWindow
      ?? input?.contextWindow
      ?? input?.contextWindowTokens
      ?? input?.maxTokens
    ) || 128_000
  );
  const utilization = normalizeRatio(
    input?.utilization,
    estimatedTokens ? Math.min(1, estimatedTokens / modelContextWindow) : 0
  );
  const warningThreshold = normalizeThreshold(input?.warningThreshold ?? input?.threshold, 0.7);
  const criticalThreshold = Math.max(warningThreshold, normalizeThreshold(input?.criticalThreshold, 0.85));
  const recommendation = normalizeRecommendation(input?.recommendation);
  return {
    sessionId: cleanString(input?.sessionId || fallbackSessionId || "", 180) || undefined,
    estimatedTokens,
    modelContextWindow,
    utilization,
    warningThreshold,
    criticalThreshold,
    messageCount: positiveInteger(input?.messageCount),
    compressionCount: positiveInteger(input?.compressionCount),
    severity: normalizeSeverity(input?.severity, recommendation, utilization, warningThreshold, criticalThreshold),
    recommendation,
    reasons: Array.isArray(input?.reasons)
      ? input.reasons.map((item: any) => cleanString(item, 120)).filter(Boolean).slice(0, 12)
      : [],
    updatedAt: positiveInteger(input?.updatedAt ?? input?.ts) || now
  };
}

function normalizeStatus(value: any): RunStatus {
  return ["queued", "running", "completed", "failed", "stopped", "interrupted"].includes(value)
    ? value
    : "running";
}

function normalizeTrigger(value: any): RunTrigger {
  return ["user", "schedule", "supervisor", "retry", "system"].includes(value)
    ? value
    : "user";
}

function normalizeRun(input: any, now = Date.now()): RunRecord | null {
  const id = cleanString(input?.id || "", 180);
  if (!id) return null;
  const usage = normalizeRunUsage(input?.usage || {});
  return {
    id,
    title: cleanString(input?.title || "", 180) || undefined,
    source: normalizeSource(input?.source),
    trigger: normalizeTrigger(input?.trigger),
    sessionId: cleanString(input?.sessionId || "", 180) || undefined,
    panelId: cleanString(input?.panelId || "", 120) || null,
    executionMode: cleanString(input?.executionMode || "", 80) || undefined,
    policyId: cleanString(input?.policyId || "", 160) || undefined,
    policy: input?.policy,
    budgetId: cleanString(input?.budgetId || "", 160) || undefined,
    model: normalizeModel(input?.model),
    metadata: input?.metadata && typeof input.metadata === "object" ? { ...input.metadata } : undefined,
    status: normalizeStatus(input?.status),
    createdAt: positiveInteger(input?.createdAt) || now,
    startedAt: positiveInteger(input?.startedAt) || positiveInteger(input?.createdAt) || now,
    updatedAt: positiveInteger(input?.updatedAt) || now,
    completedAt: positiveInteger(input?.completedAt) || undefined,
    terminalReason: cleanString(input?.terminalReason || "", 240) || undefined,
    error: cleanString(input?.error || "", 500) || undefined,
    usage,
    contextHealth: input?.contextHealth ? normalizeContextHealth(input.contextHealth, now, input?.sessionId) : undefined,
    cost: typeof input?.cost === "number" && Number.isFinite(input.cost) ? input.cost : null,
    currency: cleanString(input?.currency || DEFAULT_CURRENCY, 16) || DEFAULT_CURRENCY,
    stepCount: positiveInteger(input?.stepCount),
    toolCalls: positiveInteger(input?.toolCalls),
    deniedToolCalls: positiveInteger(input?.deniedToolCalls),
    tools: Array.isArray(input?.tools) ? input.tools.map(normalizeToolSummary).filter(Boolean) as RunToolSummary[] : [],
    lastEventAt: positiveInteger(input?.lastEventAt) || now,
    outputPreview: cleanString(input?.outputPreview || "", 500) || undefined,
    outputLength: positiveInteger(input?.outputLength) || undefined,
    outcome: normalizeOutcome(input?.outcome)
  };
}

function normalizeToolSummary(input: any): RunToolSummary | null {
  const id = cleanString(input?.id || "", 180);
  const name = cleanString(input?.name || "", 180);
  if (!id || !name) return null;
  const status = ["requested", "completed", "failed", "denied"].includes(input?.status)
    ? input.status
    : "requested";
  return {
    id,
    name,
    status,
    startedAt: positiveInteger(input?.startedAt),
    completedAt: positiveInteger(input?.completedAt) || undefined,
    durationMs: positiveInteger(input?.durationMs) || undefined,
    error: cleanString(input?.error || "", 500) || undefined,
    reason: cleanString(input?.reason || "", 500) || undefined,
    resultSize: positiveInteger(input?.resultSize) || undefined
  };
}

function normalizeOutcome(input: any): RunOutcome | undefined {
  if (!input) return undefined;
  const runId = cleanString(input?.runId || "", 180);
  const verdict = ["progressed", "no-progress", "invalid", "needs-user", "done"].includes(input?.verdict)
    ? input.verdict
    : "";
  if (!runId || !verdict) return undefined;
  return {
    runId,
    source: normalizeSource(input?.source),
    verdict,
    summary: cleanString(input?.summary || "", 1000),
    evidence: Array.isArray(input?.evidence) ? input.evidence.map((item: any) => cleanString(item, 300)).filter(Boolean).slice(0, 12) : undefined,
    nextStep: cleanString(input?.nextStep || "", 500) || undefined,
    confidence: Number.isFinite(Number(input?.confidence)) ? Math.max(0, Math.min(1, Number(input.confidence))) : undefined,
    createdAt: positiveInteger(input?.createdAt) || Date.now(),
    createdBy: cleanString(input?.createdBy || "", 120) || undefined
  };
}

function normalizeEvent(input: any, now = Date.now()): RunLedgerEvent | null {
  const runId = cleanString(input?.runId || "", 180);
  const type = cleanString(input?.type || "", 120);
  if (!runId || !type) return null;
  return {
    id: cleanString(input?.id || input?.eventId || "", 180) || stableId("evt"),
    runId,
    type,
    ts: positiveInteger(input?.ts) || now,
    sequence: positiveInteger(input?.sequence) || undefined,
    data: sanitizeEventData(type, input?.data || {})
  };
}

function sanitizeEventData(type: string, data: any): Record<string, any> {
  if (type === "message.delta") {
    return { length: String(data?.delta || "").length };
  }
  if (type === "run.started") {
    const prompt = String(data?.prompt || "");
    return {
      executionMode: cleanString(data?.executionMode || "", 80) || undefined,
      model: sanitizeModel(data?.model),
      promptLength: prompt.length,
      promptPreview: prompt.slice(0, 500),
      policy: data?.policy && typeof data.policy === "object" ? {
        preset: cleanString(data.policy.preset || "", 80) || undefined,
        allowedTools: Array.isArray(data.policy.allowedTools)
          ? data.policy.allowedTools.map((name: any) => cleanString(name, 120)).filter(Boolean).slice(0, 40)
          : undefined,
        maxToolCalls: positiveInteger(data.policy.maxToolCalls)
      } : undefined
    };
  }
  if (type === "run.completed") {
    const output = String(data?.output || "");
    return {
      durationMs: positiveInteger(data?.durationMs),
      outputLength: output.length,
      outputPreview: output.slice(0, 500),
      usage: data?.usage ? normalizeRunUsage(data.usage) : undefined
    };
  }
  if (type === "run.failed") return { error: cleanString(data?.error || "", 500) };
  if (type === "run.aborted") return { reason: cleanString(data?.reason || "user", 120) };
  if (type === "turn.started") {
    return {
      turn: positiveInteger(data?.turn ?? data?.stepIndex),
      model: sanitizeModel(data?.model)
    };
  }
  if (type === "tool.requested") {
    const args = data?.args && typeof data.args === "object" ? data.args : {};
    return {
      turn: positiveInteger(data?.turn),
      callId: cleanString(data?.callId || "", 180),
      name: cleanString(data?.name || "", 180),
      argKeys: Object.keys(args).slice(0, 30)
    };
  }
  if (type === "tool.completed") {
    const result = data?.result == null ? "" : String(data.result);
    return {
      turn: positiveInteger(data?.turn),
      callId: cleanString(data?.callId || "", 180),
      name: cleanString(data?.name || "", 180),
      resultSize: result.length,
      error: cleanString(data?.error || "", 500) || undefined
    };
  }
  if (type === "tool.denied") {
    return {
      turn: positiveInteger(data?.turn),
      callId: cleanString(data?.callId || "", 180),
      name: cleanString(data?.name || "", 180),
      reason: cleanString(data?.reason || "", 500)
    };
  }
  if (type === "turn.completed" || type === "model.usage") {
    return {
      turn: positiveInteger(data?.turn ?? data?.stepIndex),
      model: sanitizeModel(data?.model),
      usage: data?.usage ? normalizeRunUsage(data.usage) : undefined
    };
  }
  if (type === "context.window") {
    return {
      ...normalizeContextHealth(data),
      turn: positiveInteger(data?.turn ?? data?.stepIndex),
      model: sanitizeModel(data?.model)
    };
  }
  return JSON.parse(JSON.stringify(data || {}));
}

function normalizeDocument(input: any, now = Date.now()): RunLedgerDocument {
  return {
    version: 1,
    runs: (Array.isArray(input?.runs) ? input.runs : [])
      .map((run: any) => normalizeRun(run, now))
      .filter(Boolean) as RunRecord[],
    events: (Array.isArray(input?.events) ? input.events : [])
      .map((event: any) => normalizeEvent(event, now))
      .filter(Boolean) as RunLedgerEvent[],
    outcomes: (Array.isArray(input?.outcomes) ? input.outcomes : [])
      .map(normalizeOutcome)
      .filter(Boolean) as RunOutcome[]
  };
}

function matchesSource(run: RunRecord, source?: Partial<RunSourceRef>): boolean {
  if (!source) return true;
  if (!run.source) return false;
  if (source.pluginId && run.source.pluginId !== source.pluginId) return false;
  if (source.kind && run.source.kind !== source.kind) return false;
  if (source.id && run.source.id !== source.id) return false;
  return true;
}

function matchesFilter(run: RunRecord, filter: RunListFilter = {}): boolean {
  if (!matchesSource(run, filter.source)) return false;
  if (filter.sessionId && run.sessionId !== filter.sessionId) return false;
  if (filter.since && run.updatedAt < filter.since) return false;
  if (filter.status) {
    const allowed = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!allowed.includes(run.status)) return false;
  }
  return true;
}

function summarizeRuns(runs: RunRecord[]): RunLedgerSnapshot["totals"] {
  let cost: number | null = null;
  const totals: RunLedgerSnapshot["totals"] = {
    count: runs.length,
    active: runs.filter((run) => run.status === "running" || run.status === "queued").length,
    failed: runs.filter((run) => run.status === "failed" || run.status === "interrupted").length,
    tokens: emptyUsage(),
    cost,
    currency: DEFAULT_CURRENCY
  };
  for (const run of runs) {
    totals.tokens = addUsage(totals.tokens, run.usage);
    if (typeof run.cost === "number" && Number.isFinite(run.cost)) {
      cost = Number(cost || 0) + run.cost;
      totals.cost = cost;
    }
  }
  return totals;
}

function loadDocument(storage: StorageLike | null, storageKey: string, now: number): RunLedgerDocument {
  if (!storage) return normalizeDocument({}, now);
  try {
    const raw = storage.getItem(storageKey);
    return normalizeDocument(raw ? JSON.parse(raw) : {}, now);
  } catch {
    return normalizeDocument({}, now);
  }
}

export function createRunLedger(options: RunLedgerOptions = {}) {
  const storage = options.storage === undefined
    ? (typeof localStorage === "undefined" ? null : localStorage)
    : options.storage;
  const storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
  const now = options.now || (() => Date.now());
  const makeId = options.id || stableId;
  const maxRuns = Math.max(1, Number(options.maxRuns || DEFAULT_MAX_RUNS));
  const maxEvents = Math.max(1, Number(options.maxEvents || DEFAULT_MAX_EVENTS));
  const maxOutcomes = Math.max(1, Number(options.maxOutcomes || DEFAULT_MAX_OUTCOMES));
  const listeners = new Set<(snapshot: RunLedgerSnapshot) => void>();
  let sourceKindToken = 0;
  const sourceKinds = new Map<string, RunSourceKindRegistration & { token: number }>();
  for (const item of DEFAULT_SOURCE_KINDS) {
    sourceKinds.set(item.kind, { ...item, token: 0 });
  }
  let document = loadDocument(storage, storageKey, now());

  const persist = () => {
    document = {
      ...document,
      runs: document.runs.slice(-maxRuns),
      events: document.events.slice(-maxEvents),
      outcomes: document.outcomes.slice(-maxOutcomes)
    };
    try { storage?.setItem(storageKey, JSON.stringify(document)); } catch {}
  };

  const emitChanged = (reason: string, payload: any = {}) => {
    const snapshot = getSnapshot();
    for (const listener of Array.from(listeners)) {
      try { listener(snapshot); } catch {}
    }
    try { options.emit?.("runs/changed", { reason, ...payload, snapshot }); } catch {}
  };

  const updateRun = (runId: string, update: (run: RunRecord) => RunRecord) => {
    let updated: RunRecord | null = null;
    document = {
      ...document,
      runs: document.runs.map((run) => {
        if (run.id !== runId) return run;
        updated = update(run);
        return updated;
      })
    };
    return updated;
  };

  const ensureRun = (runId: string, patch: Partial<RunRecord> = {}) => {
    let run = document.runs.find((item) => item.id === runId) || null;
    if (run) return run;
    run = normalizeRun({
      id: runId,
      trigger: "system",
      status: "running",
      ...patch
    }, now());
    if (!run) throw new Error("run id is required");
    document = { ...document, runs: [...document.runs, run] };
    return run;
  };

  const appendEvent = (event: RunLedgerEvent) => {
    document = { ...document, events: [...document.events, event] };
  };

  const applyEventToRun = (event: RunLedgerEvent) => {
    const at = event.ts || now();
    ensureRun(event.runId, { startedAt: at, createdAt: at });
    updateRun(event.runId, (run) => {
      let next: RunRecord = { ...run, updatedAt: at, lastEventAt: at };
      const data = event.data || {};
      if (event.type === "run.started") {
        next = {
          ...next,
          status: "running",
          startedAt: run.startedAt || at,
          executionMode: cleanString(data.executionMode || run.executionMode || "", 80) || undefined,
          model: normalizeModel(data.model) || run.model,
          policy: data.policy || run.policy
        };
      } else if (event.type === "turn.started") {
        next = {
          ...next,
          stepCount: Math.max(run.stepCount || 0, positiveInteger(data.turn)),
          model: normalizeModel(data.model) || run.model
        };
      } else if (event.type === "turn.completed") {
        next = {
          ...next,
          stepCount: Math.max(run.stepCount || 0, positiveInteger(data.turn)),
          model: normalizeModel(data.model) || run.model,
          usage: data.usage ? normalizeRunUsage(data.usage) : run.usage
        };
      } else if (event.type === "model.usage") {
        next = {
          ...next,
          stepCount: Math.max(run.stepCount || 0, positiveInteger(data.turn)),
          model: normalizeModel(data.model) || run.model,
          usage: addUsage(run.usage, normalizeRunUsage(data.usage || {}))
        };
      } else if (event.type === "context.window") {
        next = {
          ...next,
          stepCount: Math.max(run.stepCount || 0, positiveInteger(data.turn)),
          model: normalizeModel(data.model) || run.model,
          contextHealth: normalizeContextHealth({ ...data, updatedAt: at }, at, run.sessionId)
        };
      } else if (event.type === "tool.requested") {
        const id = cleanString(data.callId || "", 180);
        const name = cleanString(data.name || "", 180);
        if (!id || !name) return next;
        const existing = run.tools.find((tool) => tool.id === id);
        const tools = existing
          ? run.tools.map((tool) => tool.id === id ? { ...tool, name, status: "requested" as const, startedAt: tool.startedAt || at } : tool)
          : [...run.tools, { id, name, status: "requested" as const, startedAt: at }];
        next = { ...next, tools, toolCalls: tools.length };
      } else if (event.type === "tool.completed") {
        const id = cleanString(data.callId || "", 180);
        const name = cleanString(data.name || "", 180);
        const error = cleanString(data.error || "", 500);
        const tools = upsertTool(run.tools, {
          id,
          name,
          status: error ? "failed" : "completed",
          completedAt: at,
          error: error || undefined,
          resultSize: positiveInteger(data.resultSize)
        });
        next = { ...next, tools, toolCalls: tools.length };
      } else if (event.type === "tool.denied") {
        const id = cleanString(data.callId || "", 180);
        const name = cleanString(data.name || "", 180);
        const tools = upsertTool(run.tools, {
          id,
          name,
          status: "denied",
          completedAt: at,
          reason: cleanString(data.reason || "", 500)
        });
        next = { ...next, tools, toolCalls: tools.length, deniedToolCalls: tools.filter((tool) => tool.status === "denied").length };
      } else if (event.type === "run.completed") {
        const usage = data.usage ? normalizeRunUsage(data.usage) : run.usage;
        next = {
          ...next,
          status: "completed",
          completedAt: at,
          terminalReason: "completed",
          usage: usage.total || usage.input || usage.output ? usage : run.usage,
          outputPreview: cleanString(data.outputPreview || "", 500) || run.outputPreview,
          outputLength: positiveInteger(data.outputLength) || run.outputLength
        };
      } else if (event.type === "run.failed") {
        next = {
          ...next,
          status: "failed",
          completedAt: at,
          terminalReason: "failed",
          error: cleanString(data.error || "", 500) || "Run failed"
        };
      } else if (event.type === "run.aborted") {
        const reason = cleanString(data.reason || "user", 120);
        next = {
          ...next,
          status: reason === "timeout" ? "failed" : "stopped",
          completedAt: at,
          terminalReason: reason,
          error: reason === "timeout" ? "Run timed out" : undefined
        };
      }
      return next;
    });
  };

  function getSnapshot(): RunLedgerSnapshot {
    const runs = document.runs.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      runs,
      active: runs.filter((run) => run.status === "running" || run.status === "queued"),
      totals: summarizeRuns(runs)
    };
  }

  return {
    start(input: any = {}): RunRecord {
      const at = positiveInteger(input?.startedAt || input?.createdAt) || now();
      const run = normalizeRun({
        ...input,
        id: input?.id || makeId("run"),
        status: input?.status || "running",
        createdAt: input?.createdAt || at,
        startedAt: input?.startedAt || at,
        updatedAt: at,
        lastEventAt: at
      }, at);
      if (!run) throw new Error("run id is required");
      document = {
        ...document,
        runs: [...document.runs.filter((item) => item.id !== run.id), run]
      };
      persist();
      emitChanged("start", { run });
      return run;
    },
    recordEvent(input: any): RunLedgerEvent | null {
      const event = normalizeEvent(input, now());
      if (!event) return null;
      appendEvent(event);
      applyEventToRun(event);
      persist();
      emitChanged("event", { event });
      return event;
    },
    recordUsage(input: any): RunRecord | null {
      const runId = cleanString(input?.runId || "", 180);
      if (!runId) return null;
      const at = positiveInteger(input?.ts) || now();
      const usage = normalizeRunUsage(input?.usage || input?.tokens || input);
      ensureRun(runId, { startedAt: at, createdAt: at });
      const updated = updateRun(runId, (run) => ({
        ...run,
        model: normalizeModel(input?.model) || run.model,
        usage: addUsage(run.usage, usage),
        cost: typeof input?.cost === "number" && Number.isFinite(input.cost)
          ? Number(run.cost || 0) + input.cost
          : run.cost,
        currency: cleanString(input?.currency || run.currency || DEFAULT_CURRENCY, 16) || DEFAULT_CURRENCY,
        updatedAt: at,
        lastEventAt: at
      }));
      const event = normalizeEvent({
        runId,
        type: "model.usage",
        ts: at,
        data: { usage, stepIndex: input?.stepIndex, model: input?.model }
      }, at);
      if (event) appendEvent(event);
      persist();
      emitChanged("usage", { run: updated });
      return updated;
    },
    submitOutcome(runIdValue: string, input: any): RunOutcome {
      const runId = cleanString(runIdValue || input?.runId || "", 180);
      if (!runId) throw new Error("run id is required");
      const run = ensureRun(runId);
      const outcome = normalizeOutcome({
        ...input,
        runId,
        source: input?.source || run.source,
        createdAt: input?.createdAt || now()
      });
      if (!outcome) throw new Error("valid outcome is required");
      document = {
        ...document,
        outcomes: [...document.outcomes.filter((item) => item.runId !== runId), outcome],
        runs: document.runs.map((item) => item.id === runId
          ? { ...item, outcome, updatedAt: outcome.createdAt }
          : item)
      };
      const event = normalizeEvent({
        runId,
        type: "outcome.submitted",
        ts: outcome.createdAt,
        data: outcome
      }, outcome.createdAt);
      if (event) appendEvent(event);
      persist();
      emitChanged("outcome", { outcome });
      return outcome;
    },
    reconcileActiveRuns(liveRunIds: string[] = [], reason = "startup"): RunRecord[] {
      const live = new Set(liveRunIds.map(String));
      const at = now();
      const interrupted: RunRecord[] = [];
      document = {
        ...document,
        runs: document.runs.map((run) => {
          if (run.status !== "running" && run.status !== "queued") return run;
          if (live.has(run.id)) return run;
          const next = {
            ...run,
            status: "interrupted" as const,
            completedAt: at,
            updatedAt: at,
            lastEventAt: at,
            terminalReason: reason,
            error: "Run interrupted because no live controller owns it"
          };
          interrupted.push(next);
          return next;
        })
      };
      if (interrupted.length) {
        for (const run of interrupted) {
          const event = normalizeEvent({
            runId: run.id,
            type: "run.interrupted",
            ts: at,
            data: { reason }
          }, at);
          if (event) appendEvent(event);
        }
        persist();
        emitChanged("reconcile", { runs: interrupted });
      }
      return interrupted;
    },
    get(runId: string): RunRecord | null {
      const id = cleanString(runId || "", 180);
      return document.runs.find((run) => run.id === id) || null;
    },
    list(filter: RunListFilter = {}): RunRecord[] {
      const limit = Math.max(1, Number(filter.limit || 100));
      return document.runs
        .filter((run) => matchesFilter(run, filter))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
    },
    getEvents(runId: string): RunLedgerEvent[] {
      const id = cleanString(runId || "", 180);
      return document.events.filter((event) => event.runId === id);
    },
    registerSourceKind(input: any) {
      const normalized = normalizeSourceKindRegistration(input);
      if (!normalized) throw new Error("source kind and label are required");
      const previous = sourceKinds.get(normalized.kind) || null;
      const token = ++sourceKindToken;
      const entry = { ...normalized, token };
      sourceKinds.set(entry.kind, entry);
      emitChanged("source-kind", { sourceKind: normalized });
      return {
        dispose() {
          const current = sourceKinds.get(entry.kind);
          if (!current || current.token !== token) return;
          if (previous) sourceKinds.set(entry.kind, previous);
          else sourceKinds.delete(entry.kind);
          emitChanged("source-kind", { sourceKind: normalized, removed: true });
        }
      };
    },
    getSourceKinds(): RunSourceKindRegistration[] {
      return Array.from(sourceKinds.values())
        .map(({ token: _token, ...item }) => item)
        .sort((a, b) => Number(a.order ?? 100) - Number(b.order ?? 100) || a.label.localeCompare(b.label));
    },
    getSnapshot,
    subscribe(filterOrHandler: RunListFilter | ((snapshot: RunLedgerSnapshot) => void), maybeHandler?: (snapshot: RunLedgerSnapshot) => void) {
      const filter = typeof filterOrHandler === "function" ? {} : filterOrHandler || {};
      const handler = typeof filterOrHandler === "function" ? filterOrHandler : maybeHandler;
      if (!handler) return { dispose() {} };
      const listener = (snapshot: RunLedgerSnapshot) => {
        if (!filter || !Object.keys(filter).length) {
          handler(snapshot);
          return;
        }
        handler({
          ...snapshot,
          runs: snapshot.runs.filter((run) => matchesFilter(run, filter)),
          active: snapshot.active.filter((run) => matchesFilter(run, filter))
        });
      };
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    clear() {
      document = normalizeDocument({}, now());
      try { storage?.removeItem?.(storageKey); } catch {}
      emitChanged("clear");
    }
  };
}

function upsertTool(tools: RunToolSummary[], patch: Partial<RunToolSummary> & { id: string; name: string }): RunToolSummary[] {
  if (!patch.id || !patch.name) return tools;
  const existing = tools.find((tool) => tool.id === patch.id);
  if (!existing) {
    return [...tools, {
      id: patch.id,
      name: patch.name,
      status: patch.status || "requested",
      startedAt: patch.startedAt || patch.completedAt || Date.now(),
      completedAt: patch.completedAt,
      durationMs: patch.durationMs,
      error: patch.error,
      reason: patch.reason,
      resultSize: patch.resultSize
    }];
  }
  return tools.map((tool) => {
    if (tool.id !== patch.id) return tool;
    const completedAt = patch.completedAt || tool.completedAt;
    return {
      ...tool,
      ...patch,
      completedAt,
      durationMs: completedAt && tool.startedAt ? Math.max(0, completedAt - tool.startedAt) : patch.durationMs
    };
  });
}

export type RunLedger = ReturnType<typeof createRunLedger>;
