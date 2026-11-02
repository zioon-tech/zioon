import {
  readWorkbenchRuntimeConfig
} from "../../src/runtime/workbench-runtime-config.ts";
import {
  COMPRESSION_RUNTIME_KV_KEY,
  compressionSettingsSyncDirection,
  normalizeCompressionSettings
} from "./compression-runtime-shared.js";

function runtimeConfigForCompression(state, storage) {
  const config = readWorkbenchRuntimeConfig({ state, storage });
  const backend = String(state?.get?.("runtime.connection")?.backend || "").trim();
  if (config.mode === "browser" || (config.mode !== "runtime" && backend !== "runtime")) {
    return null;
  }
  return config;
}

export async function loadCompressionSettingsFromRuntime({
  state = globalThis.window?.zion?.state,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = runtimeConfigForCompression(state, storage);
  if (!config) return null;
  const response = await fetchImpl(
    `${config.baseUrl}/v1/workbench-state/kv/${encodeURIComponent(COMPRESSION_RUNTIME_KV_KEY)}`,
    { headers: { accept: "application/json" } }
  );
  if (response.status === 404) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Runtime compression settings load failed: ${response.status}`);
  }
  return normalizeCompressionSettings(body?.value);
}

export async function syncCompressionSettingsToRuntime({
  settings,
  state = globalThis.window?.zion?.state,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = runtimeConfigForCompression(state, storage);
  if (!config) return { synced: false, reason: "runtime-unavailable" };
  const value = normalizeCompressionSettings(settings);
  const response = await fetchImpl(
    `${config.baseUrl}/v1/workbench-state/kv/${encodeURIComponent(COMPRESSION_RUNTIME_KV_KEY)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value })
    }
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    throw new Error(body?.error || `Runtime compression settings sync failed: ${response.status}`);
  }
  state?.set?.("runtime.compressionSync", {
    status: "synced",
    syncedAt: Date.now(),
    revision: value.updatedAt
  });
  return { synced: true, settings: value, result: body };
}

export {
  COMPRESSION_RUNTIME_KV_KEY,
  compressionSettingsSyncDirection,
  normalizeCompressionSettings
};
