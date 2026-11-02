import { describe, expect, it, vi } from "vitest";
import { activateRuntimePlugin } from "../extensions/dev.context-compression/runtime.js";
import {
  COMPRESSION_RUNTIME_KV_KEY,
  compressionSettingsSyncDirection,
  normalizeCompressionSettings,
  toCompressionMessages,
  toRuntimeMessages
} from "../extensions/dev.context-compression/compression-runtime-shared.js";
import {
  loadCompressionSettingsFromRuntime,
  syncCompressionSettingsToRuntime
} from "../extensions/dev.context-compression/compression-runtime-state.js";

function state(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: vi.fn((key) => values.get(key)),
    set: vi.fn((key, value) => {
      values.set(key, value);
      return value;
    }),
    values
  };
}

describe("Runtime Context Compression provider", () => {
  it("normalizes settings and compares Workbench/Runtime revisions", () => {
    expect(normalizeCompressionSettings({
      threshold: 9,
      contextLimitTokens: 20,
      defaultStrategy: "manus",
      updatedAt: 2000
    })).toMatchObject({
      threshold: 1,
      contextLimitTokens: 1000,
      defaultStrategy: "manus",
      updatedAt: 2000
    });
    expect(compressionSettingsSyncDirection(
      { updatedAt: 1000 },
      { updatedAt: 2000 }
    )).toBe("restore");
    expect(compressionSettingsSyncDirection(
      { updatedAt: 2000 },
      { updatedAt: 1000 }
    )).toBe("upload");
  });

  it("round-trips Runtime tool call fields through compression format", () => {
    const source = [{
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: "{\"path\":\"a.md\"}" }
      }]
    }, {
      role: "tool",
      toolCallId: "call-1",
      content: "result"
    }, {
      role: "user",
      content: "continue"
    }];

    expect(toRuntimeMessages(toCompressionMessages(source), source)).toEqual(source);
  });

  it("preserves context when no persistent Session is supplied", async () => {
    const bucket = new Map([
      ["settings", normalizeCompressionSettings({
        defaultStrategy: "progressive",
        threshold: 0.5,
        contextLimitTokens: 1000,
        progressiveRecentProtectTokens: 0,
        progressiveKeepRecentTurns: 0,
        updatedAt: 1000
      })]
    ]);
    const providers = [];
    const emit = vi.fn();
    activateRuntimePlugin({
      config: {},
      state: {
        namespace: () => ({
          get: (key) => bucket.get(key),
          read: async (key) => bucket.get(key),
          put: async (key, value) => bucket.set(key, value)
        })
      },
      runs: { registerCommands: vi.fn() },
      tools: { registerTool: vi.fn() },
      context: {
        registerProvider(provider) {
          providers.push(provider);
          return { dispose: vi.fn() };
        }
      },
      events: { emit },
      log: vi.fn()
    });
    const messages = [{
      role: "system",
      content: "base"
    }, {
      role: "user",
      content: "inspect"
    }, {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: "{\"path\":\"large.md\"}" }
      }]
    }, {
      role: "tool",
      toolCallId: "call-1",
      content: "x".repeat(5000)
    }, {
      role: "user",
      content: "continue"
    }];

    const compressed = await providers[0].contribute(messages, {
      runId: "run-1",
      attemptId: "attempt-1",
      turn: 2
    });

    expect(providers[0]).toMatchObject({
      id: "dev.context-compression",
      stage: "post",
      order: 90
    });
    expect(compressed.at(-1)).toEqual({ role: "user", content: "continue" });
    expect(compressed).toEqual(messages);
    expect(bucket.get("stats")).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  it("synchronizes Workbench compression settings through Runtime KV", async () => {
    const runtimeState = state({
      "runtime.mode": "runtime",
      "runtime.baseUrl": "http://runtime.test"
    });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      expect(String(url)).toBe(
        `http://runtime.test/v1/workbench-state/kv/${encodeURIComponent(COMPRESSION_RUNTIME_KV_KEY)}`
      );
      if (init.method === "PUT") {
        expect(JSON.parse(init.body).value).toMatchObject({
          defaultStrategy: "progressive",
          updatedAt: 3000
        });
        return new globalThis.Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new globalThis.Response(JSON.stringify({
        value: {
          autoCompression: true,
          defaultStrategy: "progressive",
          updatedAt: 3000
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const loaded = await loadCompressionSettingsFromRuntime({
      state: runtimeState,
      fetchImpl
    });
    expect(loaded).toMatchObject({
      defaultStrategy: "progressive",
      updatedAt: 3000
    });
    await expect(syncCompressionSettingsToRuntime({
      settings: loaded,
      state: runtimeState,
      fetchImpl
    })).resolves.toMatchObject({ synced: true });
    expect(runtimeState.values.get("runtime.compressionSync")).toMatchObject({
      status: "synced",
      revision: 3000
    });
  });
});
