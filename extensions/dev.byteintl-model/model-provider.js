import { buildByteIntlRequestPayload } from "./byteintl-adapter.js";
import { setDefaultResultOrder } from "node:dns";

export const runtimePluginApiVersion = 2;
export const BYTEINTL_ENDPOINT = "https://aidp.byteintl.net/api/modelhub/online/v2/crawl";
export const BYTEINTL_MODELS = Object.freeze([
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite · ByteIntl", supportsStreaming: false, supportsTools: true }
]);

/** Account plugin entry; runs inside the authorized intranet Node Host. */
export function activateRuntimePlugin(context) {
  const connection = context.credentials;
  const key = connection.env?.BYTEINTL_AK;
  if (connection.endpoint !== BYTEINTL_ENDPOINT || typeof key !== "string" || !key) {
    throw new Error("byteintl_connection_required");
  }
  // Preserve the existing intranet adapter's working network preference.
  setDefaultResultOrder("ipv6first");
  const registration = context.models.registerProvider({
    id: "byteintl", models: BYTEINTL_MODELS,
    async request(input, ctx) {
      if (!BYTEINTL_MODELS.some((m) => m.id === input.model)) throw new Error("byteintl_model_unavailable");
      const url = new URL(BYTEINTL_ENDPOINT);
      url.searchParams.set("ak", key);
      const payload = buildByteIntlRequestPayload(input, { model: input.model, defaultMaxTokens: 8192 });
      try {
        return await fetch(url, {
          method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(payload), redirect: "error", signal: ctx.abortSignal
        });
      } catch (error) {
        if (ctx.abortSignal.aborted) throw error;
        throw Object.assign(new Error("byteintl_network_unavailable"), { code: "byteintl_network_unavailable" });
      }
    }
  });
  return { dispose: () => registration.dispose() };
}
