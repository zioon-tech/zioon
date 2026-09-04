import { CompressionEngine } from "./compression-core.js";
import { OpenCodeStrategy } from "./strategies/opencode.js";
import { ClaudeCodeStrategy } from "./strategies/claude-code.js";
import { ProgressiveStrategy } from "./strategies/progressive.js";
import {
  COMPRESSION_RUNTIME_SETTINGS_KEY,
  COMPRESSION_RUNTIME_STATE_NAMESPACE,
  COMPRESSION_RUNTIME_STATS_KEY,
  configureCompressionEngine,
  normalizeCompressionSettings,
  runtimeCompressionStrategy,
  toCompressionMessages,
  toRuntimeMessages
} from "./compression-runtime-shared.js";

export const runtimePluginApiVersion = 2;

function normalizeStats(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  return {
    compressionCount: Math.max(0, Number(source.compressionCount) || 0),
    totalTokensSaved: Math.max(0, Number(source.totalTokensSaved) || 0),
    strategyUsage: {
      ...(source.strategyUsage && typeof source.strategyUsage === "object"
        ? source.strategyUsage
        : {})
    },
    lastCompressionTime: Math.max(0, Number(source.lastCompressionTime) || 0)
  };
}

function estimatedTokens(messages, charsPerToken) {
  try {
    return Math.ceil(JSON.stringify(messages).length / charsPerToken);
  } catch {
    return 0;
  }
}

export function activateRuntimePlugin(context) {
  const state = context.state.namespace(COMPRESSION_RUNTIME_STATE_NAMESPACE);
  const engine = new CompressionEngine();
  engine.registerStrategy("opencode", new OpenCodeStrategy());
  engine.registerStrategy("claude-code", new ClaudeCodeStrategy());
  engine.registerStrategy("progressive", new ProgressiveStrategy());

  const provider = {
    id: "dev.context-compression",
    stage: "post",
    order: 90,
    async contribute(messages, providerContext = {}) {
      const settings = configureCompressionEngine(
        engine,
        state.get(COMPRESSION_RUNTIME_SETTINGS_KEY)
          || normalizeCompressionSettings()
      );
      if (!settings.autoCompression) return messages;

      const source = toCompressionMessages(messages);
      const compressionContext = engine.createCompressionContext(source);
      if (!await engine.shouldAutoCompress(compressionContext)) return messages;

      const strategy = runtimeCompressionStrategy(settings);
      const compressed = await engine.compress(source, strategy);
      const runtimeMessages = toRuntimeMessages(compressed, messages);
      const originalTokens = Number(compressionContext.tokens || 0);
      const compressedTokens = estimatedTokens(runtimeMessages, settings.charsPerToken);
      const savedTokens = Math.max(0, originalTokens - compressedTokens);
      if (savedTokens <= 0) return messages;

      const stats = normalizeStats(state.get(COMPRESSION_RUNTIME_STATS_KEY));
      state.set(COMPRESSION_RUNTIME_STATS_KEY, {
        ...stats,
        compressionCount: stats.compressionCount + 1,
        totalTokensSaved: stats.totalTokensSaved + savedTokens,
        strategyUsage: {
          ...stats.strategyUsage,
          [strategy]: Number(stats.strategyUsage[strategy] || 0) + 1
        },
        lastCompressionTime: Date.now()
      });
      context.events?.emit?.("compression.completed", {
        runId: providerContext.runId,
        attemptId: providerContext.attemptId,
        turn: providerContext.turn,
        strategy,
        originalTokens,
        compressedTokens,
        savedTokens
      });
      return runtimeMessages;
    }
  };

  const registration = context.context.registerProvider(provider);
  return {
    dispose() {
      registration.dispose();
    }
  };
}
