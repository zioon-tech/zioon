export type ContextHealthRecommendation = "continue" | "compress" | "new-session";
export type ContextHealthSeverity = "ok" | "warning" | "critical";

export type ContextHealthInput = {
  sessionId?: string;
  modelContextWindow?: number;
  estimatedTokens?: number;
  messageCount?: number;
  compressionCount?: number;
  warningThreshold?: number;
  criticalThreshold?: number;
};

export type ContextHealthSnapshot = {
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
};

const DEFAULT_WARNING_THRESHOLD = 0.7;
const DEFAULT_CRITICAL_THRESHOLD = 0.85;

function nonNegative(value: any): number {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function estimateContextHealth(input: ContextHealthInput = {}): ContextHealthSnapshot {
  const estimatedTokens = nonNegative(input.estimatedTokens);
  const modelContextWindow = Math.max(1, nonNegative(input.modelContextWindow) || 128_000);
  const messageCount = nonNegative(input.messageCount);
  const compressionCount = nonNegative(input.compressionCount);
  const warningThreshold = normalizeThreshold(input.warningThreshold, DEFAULT_WARNING_THRESHOLD);
  const criticalThreshold = Math.max(
    warningThreshold,
    normalizeThreshold(input.criticalThreshold, DEFAULT_CRITICAL_THRESHOLD)
  );
  const utilization = Math.min(1, estimatedTokens / modelContextWindow);
  const reasons: string[] = [];
  let severity: ContextHealthSeverity = "ok";
  let recommendation: ContextHealthRecommendation = "continue";

  if (utilization >= criticalThreshold) {
    severity = "critical";
    recommendation = "new-session";
    reasons.push("context-window-critical");
  } else if (utilization >= warningThreshold) {
    severity = "warning";
    recommendation = "compress";
    reasons.push("context-window-high");
  }

  if (messageCount >= 80 && recommendation === "continue") {
    severity = "warning";
    recommendation = "compress";
    reasons.push("many-messages");
  }

  if (compressionCount >= 3 && utilization >= 0.55) {
    severity = "critical";
    recommendation = "new-session";
    reasons.push("repeated-compression");
  }

  return {
    sessionId: input.sessionId,
    estimatedTokens,
    modelContextWindow,
    utilization,
    warningThreshold,
    criticalThreshold,
    messageCount,
    compressionCount,
    severity,
    recommendation,
    reasons
  };
}

function normalizeThreshold(value: any, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return fallback;
  return n;
}
