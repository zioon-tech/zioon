import { performance } from "node:perf_hooks";
import { shutdownTelemetry } from "../../src/telemetry/bootstrap.mjs";
import { createAgentExecutor, MemoryRunStore, OpenAICompatibleEngine } from "../../../../packages/runtime/dist/index.js";

const started = performance.now();
const executor = createAgentExecutor({
  runs: new MemoryRunStore(),
  tools: { async listTools() { return []; }, async invoke() { return { ok: true, content: "SECRET_RESULT" }; } },
  engine: new OpenAICompatibleEngine({
    model: "test-model",
    endpoint: "https://SECRET_USER:SECRET_PASSWORD@example.com/SECRET_PATH?api_key=SECRET_KEY",
    apiKey: "SECRET_KEY",
    transport: async () => ({
      ok: true, status: 200, body: null, async text() { return "SECRET_ERROR"; },
      async json() { return { choices: [{ message: { content: "SECRET_RESPONSE" }, finish_reason: "stop" }] }; }
    })
  })
});
const handle = executor.execute({ prompt: "SECRET_PROMPT", metadata: { password: "SECRET_METADATA" } });
for await (const event of handle.events) { /* drain */ }
const result = await handle.completion;
const runMs = performance.now() - started;
const shutdownAt = performance.now();
await Promise.all([shutdownTelemetry(), shutdownTelemetry()]);
console.log(JSON.stringify({ status: result.status, runMs, shutdownMs: performance.now() - shutdownAt }));
