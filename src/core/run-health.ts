export type ContextHealthRecommendation = "continue" | "compress" | "new-session";

export type ContextHealthInput = {
  sessionId?: string;
  modelContextWindow?: number;
  estimatedTokens?: number;
  messageCount?: number;
  compressionCount?: number;
};

export type ContextHealthSnapshot = {
  sessionId?: string;
  estimatedTokens: number;
  modelContextWindow: number;
  utilization: number;
  messageCount: number;
  compressionCount: number;
  recommendation: ContextHealthRecommendation;
  reasons: string[];
};

function nonNegative(value: any): number {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function estimateContextHealth(input: ContextHealthInput = {}): ContextHealthSnapshot {
  const estimatedTokens = nonNegative(input.estimatedTokens);
  const modelContextWindow = Math.max(1, nonNegative(input.modelContextWindow) || 128_000);
  const messageCount = nonNegative(input.messageCount);
  const compressionCount = nonNegative(input.compressionCount);
  const utilization = Math.min(1, estimatedTokens / modelContextWindow);
  const reasons: string[] = [];
  let recommendation: ContextHealthRecommendation = "continue";

  if (utilization >= 0.85) {
    recommendation = "new-session";
    reasons.push("context-window-critical");
  } else if (utilization >= 0.65) {
    recommendation = "compress";
    reasons.push("context-window-high");
  }

  if (messageCount >= 80 && recommendation === "continue") {
    recommendation = "compress";
    reasons.push("many-messages");
  }

  if (compressionCount >= 3 && utilization >= 0.55) {
    recommendation = "new-session";
    reasons.push("repeated-compression");
  }

  return {
    sessionId: input.sessionId,
    estimatedTokens,
    modelContextWindow,
    utilization,
    messageCount,
    compressionCount,
    recommendation,
    reasons
  };
}
