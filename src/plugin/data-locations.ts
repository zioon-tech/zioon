import { workbenchStorage as localStorage } from "../runtime/workbench-space";
import { readWorkbenchRuntimeConfig } from "../runtime/workbench-runtime-config";
import {
  normalizeDataLocation,
  validatePluginId
} from "../../packages/plugin-sdk/src/data-location.mjs";

export type PluginDataLocation = Readonly<{ nodeId: string; root: string }>;
export type PluginLocations = {
  readonly data: Promise<PluginDataLocation>;
};

export function createPluginLocations(pluginId: string, {
  state = (globalThis as any).window?.zion?.state,
  storage = localStorage,
  fetchImpl = globalThis.fetch
}: any = {}): PluginLocations {
  const id = validatePluginId(pluginId);
  let cached: { base: string; until: number; value: Promise<PluginDataLocation> } | null = null;
  // Resolve lazily: plugin activation must not wait for a Device connection.
  return Object.freeze({
    get data(): Promise<PluginDataLocation> {
      return (async () => {
        const config = readWorkbenchRuntimeConfig({ state, storage });
        if (config.mode === "browser") {
          const bound = state?.get?.(`plugins.dataLocations.${id}`);
          if (!bound) throw new Error("Plugin data location is not configured for browser-only mode");
          return normalizeDataLocation(bound);
        }
        const connected = state?.get?.("runtime.connection");
        const base = String(connected?.backend === "runtime" && connected.baseUrl
          ? connected.baseUrl : config.baseUrl).replace(/\/+$/, "");
        if (cached?.base === base && cached.until > Date.now()) return cached.value;
        const value = (async () => {
          const response = await fetchImpl(`${base}/v1/plugins/${encodeURIComponent(id)}/locations`, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(5000)
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body?.error || `Plugin locations HTTP ${response.status}`);
          return normalizeDataLocation(body?.data);
        })();
        cached = { base, until: Date.now() + 2000, value };
        value.catch(() => { if (cached?.value === value) cached = null; });
        return value;
      })();
    }
  });
}
