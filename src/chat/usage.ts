export type ChatUsageTokens = {
  input: number;
  output: number;
  total: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
};

export type ChatUsagePricing = {
  inputPerMTok?: number;
  outputPerMTok?: number;
  currency?: string;
};

export type ChatUsageRecord = {
  id: string;
  ts: number;
  day: string;
  runId?: string;
  sessionId?: string;
  panelId?: string;
  providerId?: string;
  providerType?: string;
  modelId?: string;
  modelName?: string;
  label?: string;
  stepIndex?: number;
  tokens: ChatUsageTokens;
  cost: number | null;
  currency: string;
};

export type ChatUsageSummary = {
  calls: number;
  tokens: ChatUsageTokens;
  cost: number | null;
  currency: string;
  byModel: Array<{
    key: string;
    providerId?: string;
    modelId?: string;
    modelName?: string;
    label: string;
    calls: number;
    tokens: ChatUsageTokens;
    cost: number | null;
    currency: string;
  }>;
};

const STORAGE_KEY = "zion.chat.usage.records.v1";
const MAX_RECORDS = 2000;
const DEFAULT_CURRENCY = "USD";

type Listener = () => void;

function emptyTokens(): ChatUsageTokens {
  return { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function addTokens(a: ChatUsageTokens, b: Partial<ChatUsageTokens> | undefined): ChatUsageTokens {
  return {
    input: Number(a.input || 0) + Number(b?.input || 0),
    output: Number(a.output || 0) + Number(b?.output || 0),
    total: Number(a.total || 0) + Number(b?.total || 0),
    cacheRead: Number(a.cacheRead || 0) + Number(b?.cacheRead || 0),
    cacheWrite: Number(a.cacheWrite || 0) + Number(b?.cacheWrite || 0),
    reasoning: Number(a.reasoning || 0) + Number(b?.reasoning || 0)
  };
}

function normalizeTokens(value: any): ChatUsageTokens {
  const input = toNumber(
    value?.input ??
    value?.prompt ??
    value?.prompt_tokens ??
    value?.input_tokens ??
    value?.cached_input_tokens ??
    value?.promptTokenCount
  );
  const output = toNumber(
    value?.output ??
    value?.completion ??
    value?.completion_tokens ??
    value?.output_tokens ??
    value?.candidatesTokenCount
  );
  const total = toNumber(value?.total ?? value?.total_tokens ?? value?.totalTokenCount) || input + output;
  return {
    input,
    output,
    total,
    cacheRead: toNumber(value?.cacheRead ?? value?.cache_read_input_tokens ?? value?.cached_tokens ?? value?.cachedContentTokenCount),
    cacheWrite: toNumber(value?.cacheWrite ?? value?.cache_creation_input_tokens ?? value?.cache_creation?.input_tokens),
    reasoning: toNumber(value?.reasoning ?? value?.reasoning_tokens ?? value?.thoughtsTokenCount)
  };
}

function toNumber(value: any): number {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function todayKey(ts = Date.now()): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function stableId(): string {
  return `usage_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function pricingFromConfig(cfg: any): ChatUsagePricing {
  const src = cfg?.pricing || cfg?.price || cfg?.cost || {};
  return {
    inputPerMTok: Number(src.inputPerMTok ?? src.input_per_mtok ?? src.inputPerMillion ?? src.promptPerMTok ?? src.prompt_per_mtok ?? 0) || undefined,
    outputPerMTok: Number(src.outputPerMTok ?? src.output_per_mtok ?? src.outputPerMillion ?? src.completionPerMTok ?? src.completion_per_mtok ?? 0) || undefined,
    currency: String(src.currency || cfg?.currency || DEFAULT_CURRENCY)
  };
}

function estimateCost(tokens: ChatUsageTokens, pricing: ChatUsagePricing): number | null {
  const inPrice = Number(pricing.inputPerMTok || 0);
  const outPrice = Number(pricing.outputPerMTok || 0);
  if (!inPrice && !outPrice) return null;
  return ((Number(tokens.input || 0) * inPrice) + (Number(tokens.output || 0) * outPrice)) / 1_000_000;
}

function loadRecords(): ChatUsageRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || "";
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean).slice(-MAX_RECORDS) : [];
  } catch {
    return [];
  }
}

function saveRecords(records: ChatUsageRecord[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-MAX_RECORDS)));
  } catch {}
}

function summarize(records: ChatUsageRecord[]): ChatUsageSummary {
  const summary: ChatUsageSummary = {
    calls: records.length,
    tokens: emptyTokens(),
    cost: null,
    currency: DEFAULT_CURRENCY,
    byModel: []
  };
  const models = new Map<string, ChatUsageSummary["byModel"][number]>();
  let knownCost = 0;
  for (const record of records) {
    summary.tokens = addTokens(summary.tokens, record.tokens);
    if (typeof record.cost === "number" && Number.isFinite(record.cost)) {
      knownCost += record.cost;
      summary.cost = knownCost;
    }
    const key = `${record.providerId || ""}:${record.modelId || record.modelName || ""}`;
    let item = models.get(key);
    if (!item) {
      item = {
        key,
        providerId: record.providerId,
        modelId: record.modelId,
        modelName: record.modelName,
        label: record.label || record.modelName || record.modelId || key || "Unknown",
        calls: 0,
        tokens: emptyTokens(),
        cost: null,
        currency: record.currency || DEFAULT_CURRENCY
      };
      models.set(key, item);
    }
    item.calls += 1;
    item.tokens = addTokens(item.tokens, record.tokens);
    if (typeof record.cost === "number" && Number.isFinite(record.cost)) {
      item.cost = Number(item.cost || 0) + record.cost;
    }
  }
  summary.byModel = Array.from(models.values()).sort((a, b) => b.tokens.total - a.tokens.total);
  return summary;
}

export function createChatUsageStore() {
  let records = loadRecords();
  const listeners = new Set<Listener>();
  const emit = () => {
    try { saveRecords(records); } catch {}
    for (const listener of Array.from(listeners)) {
      try { listener(); } catch {}
    }
    try { window.zion?.events?.emit?.("chat/usageChanged", getSnapshot()); } catch {}
  };
  const getSnapshot = () => ({
    records: records.slice(),
    today: summarize(records.filter((record) => record.day === todayKey())),
    currentSession: summarize(records.filter((record) => record.sessionId && record.sessionId === window.zion?.state?.get?.("sessions.currentId"))),
    bySession: (sessionId: string) => summarize(records.filter((record) => record.sessionId === sessionId))
  });
  return {
    record(payload: any): ChatUsageRecord | null {
      const tokens = normalizeTokens(payload?.tokens || payload?.usage);
      if (!tokens.total && !tokens.input && !tokens.output) return null;
      const ts = Number(payload?.ts || Date.now());
      const pricing = payload?.pricing || pricingFromConfig(payload?.cfg);
      const cost = payload?.cost != null ? Number(payload.cost) : estimateCost(tokens, pricing);
      const record: ChatUsageRecord = {
        id: String(payload?.id || stableId()),
        ts,
        day: todayKey(ts),
        runId: payload?.runId,
        sessionId: payload?.sessionId,
        panelId: payload?.panelId,
        providerId: payload?.providerId,
        providerType: payload?.providerType,
        modelId: payload?.modelId,
        modelName: payload?.modelName,
        label: payload?.label,
        stepIndex: typeof payload?.stepIndex === "number" ? payload.stepIndex : undefined,
        tokens,
        cost: Number.isFinite(cost) ? cost : null,
        currency: String(pricing?.currency || payload?.currency || DEFAULT_CURRENCY)
      };
      records = [...records, record].slice(-MAX_RECORDS);
      emit();
      return record;
    },
    getSnapshot,
    getRecords: () => records.slice(),
    getToday: () => summarize(records.filter((record) => record.day === todayKey())),
    getSession: (sessionId: string) => summarize(records.filter((record) => record.sessionId === sessionId)),
    subscribe(listener: Listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    clear() {
      records = [];
      emit();
    }
  };
}

export function formatTokenCount(value: number): string {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function formatUsageCost(value: number | null | undefined, currency = DEFAULT_CURRENCY): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "cost n/a";
  if (value === 0) return `${currency} 0`;
  if (value < 0.01) return `${currency} ${value.toFixed(4)}`;
  return `${currency} ${value.toFixed(2)}`;
}
