import {
  createAgentExecutor,
  MemoryRunStore,
  OpenAICompatibleEngine
} from "../packages/runtime/dist/index.js";
import { RuntimeToolBroker } from "../apps/runtime/src/runtime-tool-broker.mjs";
import { shutdownTelemetry } from "../apps/runtime/src/telemetry/bootstrap.mjs";

const endpoint = String(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "").trim();
if (!endpoint) {
  throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT is required");
}

const receipts = new Map();
const receiptStore = {
  getToolReceipt(invocationId) {
    return receipts.get(invocationId) || null;
  },
  saveToolReceipt(input) {
    if (!receipts.has(input.invocationId)) receipts.set(input.invocationId, input);
    return receipts.get(input.invocationId);
  },
  countToolReceipts(runId, toolName) {
    return [...receipts.values()].filter((receipt) =>
      receipt.runId === runId && (!toolName || receipt.toolName === toolName)
    ).length;
  }
};

const tools = new RuntimeToolBroker({
  receipts: receiptStore,
  localTools: {
    supportedToolNames: ["read"],
    async listTools() {
      return [{
        name: "read",
        description: "Read a smoke-test resource.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false
        },
        hostKinds: ["local"]
      }];
    },
    async invoke() {
      return { ok: true, content: "smoke tool result" };
    }
  }
});

let modelCall = 0;
const engine = new OpenAICompatibleEngine({
  endpoint: "https://example.invalid/v1/chat/completions",
  model: "zion-observability-smoke",
  transport: async () => {
    modelCall += 1;
    return {
      ok: true,
      status: 200,
      body: null,
      async text() {
        return "";
      },
      async json() {
        if (modelCall === 1) {
          return {
            model: "zion-observability-smoke",
            choices: [{
              finish_reason: "tool_calls",
              message: {
                content: "",
                tool_calls: [{
                  id: "smoke-call",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({ path: "/smoke/private-input.txt" })
                  }
                }]
              }
            }],
            usage: { prompt_tokens: 8, completion_tokens: 3 }
          };
        }
        return {
          model: "zion-observability-smoke",
          choices: [{
            finish_reason: "stop",
            message: { content: "Smoke trace completed." }
          }],
          usage: { prompt_tokens: 12, completion_tokens: 4 }
        };
      }
    };
  }
});

const runs = new MemoryRunStore();
const executor = createAgentExecutor({ engine, tools, runs });
const handle = executor.execute({
  prompt: "Create an observability smoke trace.",
  title: "Observability smoke",
  model: {
    providerId: "smoke",
    modelId: "zion-observability-smoke"
  },
  policy: {
    preset: "read-only",
    allowedTools: ["read"]
  },
  metadata: {
    source: "observability-smoke"
  }
});

for await (const _event of handle.events) {
  // Drain only; RunStore remains the source of the final result.
}
const result = await handle.completion;
const run = await runs.get(handle.runId);
const correlation = run?.metadata?.zionTelemetry || {};
await shutdownTelemetry();

const template = String(process.env.ZION_OTEL_TRACE_URL_TEMPLATE || "");
const traceUrl = template && correlation.traceId
  ? template.replace("{traceId}", encodeURIComponent(String(correlation.traceId)))
  : "";

process.stdout.write(`${JSON.stringify({
  status: result.status,
  runId: handle.runId,
  attemptId: handle.attemptId,
  traceId: correlation.traceId || null,
  sampled: correlation.traceFlags === 1,
  spansExpected: ["invoke_agent", "chat", "execute_tool", "chat"],
  ...(traceUrl ? { traceUrl } : {})
}, null, 2)}\n`);

if (result.status !== "completed" || !correlation.traceId) process.exitCode = 1;
