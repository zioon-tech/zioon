// No SDK or exporter import in disabled mode. This module is also a Node
// --import entry point, and main imports it for direct/remote/systemd startup.
let shutdown = async () => {};
let failureReported = false;
function reportFailure() {
  if (failureReported) return;
  failureReported = true;
  process.stderr.write("[runtime-telemetry] Telemetry unavailable; Runtime continues.\n");
}

export function readTelemetryConfig(env) {
  if (["1", "true"].includes(String(env.OTEL_SDK_DISABLED).toLowerCase())) return null;
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return null;
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid telemetry endpoint");
  }
  if (!env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/traces`;
  }
  const protocol = env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL || env.OTEL_EXPORTER_OTLP_PROTOCOL || "http/json";
  if (protocol !== "http/json") throw new Error("unsupported telemetry protocol");
  const sampler = env.OTEL_TRACES_SAMPLER || "parentbased_traceidratio";
  if (sampler !== "parentbased_traceidratio") throw new Error("unsupported telemetry sampler");
  const ratio = Number(env.OTEL_TRACES_SAMPLER_ARG ?? "1");
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error("invalid telemetry sample ratio");
  const identifier = (value, fallback) => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(value)
    ? value : fallback;
  return {
    url: url.href,
    ratio,
    serviceName: identifier(env.OTEL_SERVICE_NAME, "zion-runtime"),
    serviceVersion: identifier(env.ZION_SERVICE_VERSION, "0.1.0"),
    environment: identifier(env.ZION_DEPLOYMENT_ENVIRONMENT, "development")
  };
}

export async function shutdownTelemetry() {
  await shutdown();
}

try {
  const config = readTelemetryConfig(process.env);
  if (config) {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { resourceFromAttributes } = await import("@opentelemetry/resources");
    const { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } =
      await import("@opentelemetry/sdk-trace-base");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { W3CTraceContextPropagator } = await import("@opentelemetry/core");
    const { diag } = await import("@opentelemetry/api");
    const { randomUUID } = await import("node:crypto");
    const { MetadataOnlyExporter } = await import("./export-policy.mjs");
    const processor = new BatchSpanProcessor(new MetadataOnlyExporter(
      new OTLPTraceExporter({ url: config.url, timeoutMillis: 1000, concurrencyLimit: 1 }),
      reportFailure
    ), {
      maxQueueSize: 1024,
      maxExportBatchSize: 128,
      scheduledDelayMillis: 1000,
      exportTimeoutMillis: 1500
    });
    const sdk = new NodeSDK({
      autoDetectResources: false,
      resource: resourceFromAttributes({
        "service.name": config.serviceName,
        "service.version": config.serviceVersion,
        "service.instance.id": randomUUID(),
        "deployment.environment.name": config.environment
      }),
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.ratio) }),
      textMapPropagator: new W3CTraceContextPropagator(),
      spanProcessors: [processor],
      spanLimits: { attributeCountLimit: 40, attributeValueLengthLimit: 128, eventCountLimit: 32, linkCountLimit: 2 },
      instrumentations: [],
      metricReaders: [],
      logRecordProcessors: []
    });
    // NodeSDK honors OTEL_LOG_LEVEL; diagnostics can contain endpoint/error
    // details. Zion exports only the bounded, content-free warning above.
    diag.disable();
    let shutdownPromise;
    shutdown = () => shutdownPromise ||= (async () => {
      let timer;
      try {
        await Promise.race([
          sdk.shutdown(),
          new Promise((resolve) => { timer = setTimeout(resolve, 2000); })
        ]);
      } catch {
        reportFailure();
      } finally {
        clearTimeout(timer);
      }
    })();
    sdk.start();
    process.once("beforeExit", () => { void shutdownTelemetry(); });
  }
} catch {
  reportFailure();
  await shutdownTelemetry();
}
