import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import process from "node:process";
import { setImmediate } from "node:timers";

const startupAt = performance.now();
const { shutdownTelemetry } = await import("../apps/runtime/src/telemetry/bootstrap.mjs");
const {
  createAgentExecutor,
  MemoryRunStore,
  OpenAICompatibleEngine
} = await import("../packages/runtime/dist/index.js");
const startupMs = performance.now() - startupAt;
const args = process.argv.slice(2);
const representative = args.includes("--representative");
const numericArg = args.find((arg) => !arg.startsWith("--"));
const deltas = Number(numericArg || 1000);
if (!Number.isSafeInteger(deltas) || deltas < 1 || deltas > 10000) {
  throw new Error("deltas must be 1..10000");
}

let cleanup = () => {};
let executor;
let iterations = 120;
let warmups = 20;
if (representative) {
  const [{ SqliteRunStore }, { RuntimeToolBroker }] = await Promise.all([
    import("../apps/runtime/src/sqlite-run-store.mjs"),
    import("../apps/runtime/src/runtime-tool-broker.mjs")
  ]);
  const directory = mkdtempSync(join(tmpdir(), "zion-otel-benchmark-"));
  const runs = new SqliteRunStore(join(directory, "runtime.sqlite3"));
  const broker = new RuntimeToolBroker({
    localTools: {
      async listTools() {
        return [{
          name: "read",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false
          }
        }];
      },
      async invoke() {
        return { ok: true, content: "benchmark-result" };
      }
    },
    receipts: runs,
    delegatedToolNames: ["read"]
  });
  let modelCall = 0;
  const engine = new OpenAICompatibleEngine({
    endpoint: "https://benchmark.invalid/v1/chat/completions",
    model: "benchmark-model",
    transport: async () => {
      modelCall += 1;
      const firstTurn = modelCall % 2 === 1;
      return {
        ok: true,
        status: 200,
        headers: { "content-type": "application/json" },
        body: null,
        async text() {
          return "";
        },
        async json() {
          return {
            model: "benchmark-model",
            choices: [{
              message: firstTurn
                ? {
                    content: "",
                    tool_calls: [{
                      id: "read-1",
                      function: {
                        name: "read",
                        arguments: "{\"path\":\"benchmark.txt\"}"
                      }
                    }]
                  }
                : { content: "done" },
              finish_reason: firstTurn ? "tool_calls" : "stop"
            }],
            usage: {
              prompt_tokens: 20,
              completion_tokens: firstTurn ? 5 : 2
            }
          };
        }
      };
    }
  });
  executor = createAgentExecutor({ engine, tools: broker, runs });
  iterations = 35;
  warmups = 5;
  cleanup = () => {
    runs.close();
    rmSync(directory, { recursive: true, force: true });
  };
} else {
  executor = createAgentExecutor({
    engine: {
      id: "bench",
      async *streamTurn() {
        for (let i = 0; i < deltas; i++) {
          yield { type: "message.delta", delta: "x" };
        }
      }
    },
    tools: {
      async listTools() {
        return [];
      },
      async invoke() {
        return { ok: true, content: "" };
      }
    },
    runs: new MemoryRunStore()
  });
}

const samples = [];
const cpuStart = process.cpuUsage();
const eventLoop = monitorEventLoopDelay({ resolution: 10 });
eventLoop.enable();
for (let i = 0; i < iterations; i++) {
  const started = performance.now();
  const handle = executor.execute({
    prompt: "benchmark",
    ...(representative ? { policy: { allowedTools: ["read"] } } : {})
  });
  for await (const event of handle.events) void event;
  if ((await handle.completion).status !== "completed") throw new Error("benchmark Run failed");
  if (i >= warmups) samples.push(performance.now() - started);
  await new Promise((resolve) => setImmediate(resolve));
}
eventLoop.disable();
samples.sort((left, right) => left - right);
const cpu = process.cpuUsage(cpuStart);
const rssMB = process.memoryUsage().rss / 1048576;
const shutdownAt = performance.now();
await shutdownTelemetry();
cleanup();
process.stdout.write(`${JSON.stringify({
  configured: !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  mode: representative ? "sqlite-model-tool-model" : "memory-deltas",
  runs: samples.length,
  ...(representative
    ? { modelCallsPerRun: 2, toolCallsPerRun: 1 }
    : { deltas }),
  startupMs,
  p50Ms: samples[Math.floor(samples.length * 0.5)],
  p95Ms: samples[Math.floor(samples.length * 0.95)],
  cpuMs: (cpu.user + cpu.system) / 1000, rssMB,
  eventLoopP95Ms: eventLoop.percentile(95) / 1_000_000,
  shutdownMs: performance.now() - shutdownAt
})}\n`);
