import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readTelemetryConfig } from "../src/telemetry/bootstrap.mjs";

const exec = promisify(execFile);
const runner = fileURLToPath(new URL("./fixtures/telemetry-runner.mjs", import.meta.url));
async function run(env = {}) {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("OTEL_") && !key.startsWith("ZION_")));
  const output = await exec(process.execPath, [runner, "SECRET_COMMAND_ARGUMENT"], {
    timeout: 12000, env: { ...cleanEnv, ...env }
  });
  return { ...output, result: JSON.parse(output.stdout.trim()) };
}
async function receiver(mode, action) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body });
    if (mode === "slow") return;
    res.writeHead(mode === "reject" ? 400 : 200, { "content-type": "application/json" });
    res.end(mode === "reject" ? "SECRET_COLLECTOR_BODY" : "{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await action(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("optional Runtime telemetry bootstrap", () => {
  it("requires an endpoint and validates supported settings", () => {
    expect(readTelemetryConfig({})).toBeNull();
    expect(readTelemetryConfig({ OTEL_SDK_DISABLED: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "bad" })).toBeNull();
    expect(readTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318/prefix/" }))
      .toMatchObject({ url: "http://localhost:4318/prefix/v1/traces", ratio: 1 });
    expect(readTelemetryConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/custom" }))
      .toMatchObject({ url: "http://localhost:4318/custom" });
    for (const value of ["file:///tmp/out", "http://user:password@localhost", "http://localhost?key=secret", "bad"]) {
      expect(() => readTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: value })).toThrow();
    }
    for (const invalid of [
      { OTEL_TRACES_SAMPLER_ARG: "NaN" }, { OTEL_TRACES_SAMPLER_ARG: "2" },
      { OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }, { OTEL_TRACES_SAMPLER: "invalid" }
    ]) {
      expect(() => readTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318", ...invalid })).toThrow();
    }
  });

  it.each(["unset", "disabled", "invalid", "unsampled"])("runs normally with %s telemetry", async (mode) => {
    await receiver("ok", async (endpoint, requests) => {
      const env = mode === "unset" ? {} : {
        OTEL_EXPORTER_OTLP_ENDPOINT: mode === "invalid" ? "invalid-url" : endpoint,
        ...(mode === "disabled" ? { OTEL_SDK_DISABLED: "1" } : {}),
        ...(mode === "unsampled" ? { OTEL_TRACES_SAMPLER_ARG: "0" } : {})
      };
      const output = await run(env);
      expect(output.result.status).toBe("completed");
      expect(requests).toHaveLength(0);
      expect(output.stderr).not.toContain("SECRET");
      if (mode === "invalid") expect(output.stderr).toContain("Runtime continues");
    });
  });

  it("exports a sanitized parent-child trace over OTLP HTTP without implicit logs or metrics", async () => {
    await receiver("ok", async (endpoint, requests) => {
      const output = await run({
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        OTEL_RESOURCE_ATTRIBUTES: "secret=SECRET_ENV,service.name=SECRET_OVERRIDE",
        OTEL_LOGS_EXPORTER: "otlp", OTEL_METRICS_EXPORTER: "otlp"
      });
      expect(output.result.status).toBe("completed");
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((item) => item.url === "/v1/traces")).toBe(true);
      expect(JSON.stringify(requests)).not.toContain("SECRET");
      const resources = requests.flatMap((item) => JSON.parse(item.body).resourceSpans);
      const spans = resources.flatMap((item) => item.scopeSpans.flatMap((scope) => scope.spans));
      expect(spans.map((span) => span.name).sort()).toEqual(["chat", "invoke_agent"]);
      const root = spans.find((span) => span.name === "invoke_agent");
      const model = spans.find((span) => span.name === "chat");
      expect(model.parentSpanId).toBe(root.spanId);
      expect(model.traceId).toBe(root.traceId);
      const keys = resources.flatMap((item) => item.resource.attributes.map((attribute) => attribute.key));
      expect(new Set(keys)).toEqual(new Set(["service.name", "service.version", "service.instance.id", "deployment.environment.name"]));
    });
  });

  it.each(["reject", "slow", "unreachable"])("isolates a %s Collector and bounds shutdown", async (mode) => {
    await receiver(mode, async (endpoint, requests) => {
      const output = await run({ OTEL_EXPORTER_OTLP_ENDPOINT: mode === "unreachable" ? "http://127.0.0.1:1" : endpoint });
      expect(output.result.status).toBe("completed");
      expect(output.result.runMs).toBeLessThan(500);
      expect(output.result.shutdownMs).toBeLessThan(2600);
      if (mode !== "unreachable") expect(requests.length).toBeGreaterThan(0);
      expect(output.stderr).not.toContain("SECRET");
      expect(output.stderr.match(/Runtime continues/g)?.length).toBe(1);
    });
  });
});
