import {
  byteIntlAdapterConfigFromEnvironment,
  createByteIntlAdapter,
  normalizeByteIntlAdapterConfig
} from "./byteintl-adapter.js";

export const runtimePluginApiVersion = 2;

function adapterConfig(context) {
  const configured = context.config?.adapter;
  if (configured && typeof configured === "object") {
    return normalizeByteIntlAdapterConfig(configured);
  }
  return byteIntlAdapterConfigFromEnvironment();
}

export async function activateRuntimePlugin(context) {
  const adapter = createByteIntlAdapter({
    config: adapterConfig(context),
    fetchImpl: context.config?.fetchImpl || globalThis.fetch,
    logger(event) {
      context.log?.(
        event?.level || "info",
        `${event?.message || "ByteIntl adapter event"}`
        + (event?.status ? ` (HTTP ${event.status})` : "")
      );
    }
  });
  const started = await adapter.start();
  context.log?.(
    "info",
    `ByteIntl model adapter listening at ${started.url} for ${started.model}`
  );

  return {
    async dispose() {
      await adapter.stop();
    }
  };
}
