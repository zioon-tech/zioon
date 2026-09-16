import { afterAll, beforeAll, beforeEach } from "vitest";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

export function telemetryFixture() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const manager = new AsyncLocalStorageContextManager();
  beforeAll(() => {
    context.setGlobalContextManager(manager.enable());
    trace.setGlobalTracerProvider(provider);
  });
  beforeEach(() => exporter.reset());
  afterAll(async () => {
    await provider.shutdown();
    manager.disable();
    context.disable();
    trace.disable();
  });
  return {
    provider,
    exporter,
    async spans() {
      await provider.forceFlush();
      return exporter.getFinishedSpans();
    }
  };
}
