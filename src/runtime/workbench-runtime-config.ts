export type WorkbenchRuntimeMode = "auto" | "browser" | "runtime";

export const WORKBENCH_RUNTIME_MODE_STORAGE_KEY = "zion.runtime.mode";
export const WORKBENCH_RUNTIME_BASE_URL_STORAGE_KEY = "zion.runtime.baseUrl";
export const DEFAULT_WORKBENCH_RUNTIME_BASE_URL = "http://127.0.0.1:8766";

type StateLike = {
  get?(key: string): unknown;
};

type StorageLike = {
  getItem?(key: string): string | null;
};

export type WorkbenchRuntimeConfigOptions = {
  state?: StateLike;
  storage?: StorageLike;
  legacyEnabledStateKey?: string;
  legacyEnabledStorageKey?: string;
  legacyBaseUrlStateKey?: string;
  legacyBaseUrlStorageKey?: string;
};

function readStored(storage: StorageLike | undefined, key?: string): string | null {
  if (!key) return null;
  try {
    return storage?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}

function parseMode(value: unknown): WorkbenchRuntimeMode | null {
  if (value === true) return "runtime";
  if (value === false) return "browser";
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "auto") return "auto";
  if (["runtime", "external", "1", "true", "yes", "on"].includes(normalized)) {
    return "runtime";
  }
  if (["browser", "legacy", "0", "false", "no", "off"].includes(normalized)) {
    return "browser";
  }
  return null;
}

function defaultRuntimeBaseUrl(): string {
  try {
    const location = globalThis.location;
    if (
      import.meta.env.PROD
      && ["http:", "https:"].includes(location?.protocol)
    ) {
      return location.origin;
    }
    if (
      location?.protocol === "https:"
      && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname)
    ) {
      return location.origin;
    }
  } catch {
    // Non-browser clients retain the loopback default.
  }
  return DEFAULT_WORKBENCH_RUNTIME_BASE_URL;
}

export function readWorkbenchRuntimeConfig(
  options: WorkbenchRuntimeConfigOptions = {}
): {
  mode: WorkbenchRuntimeMode;
  enabled: boolean;
  baseUrl: string;
} {
  const state = options.state ?? (globalThis as any).window?.zion?.state;
  const storage = options.storage ?? globalThis.localStorage;
  const globalMode = parseMode(
    state?.get?.("runtime.mode")
    ?? readStored(storage, WORKBENCH_RUNTIME_MODE_STORAGE_KEY)
  );
  const legacyMode = parseMode(
    options.legacyEnabledStateKey
      ? state?.get?.(options.legacyEnabledStateKey)
      : undefined
  ) ?? parseMode(readStored(storage, options.legacyEnabledStorageKey));
  const mode = globalMode || legacyMode || "auto";
  const baseUrl = String(
    state?.get?.("runtime.baseUrl")
    || readStored(storage, WORKBENCH_RUNTIME_BASE_URL_STORAGE_KEY)
    || (options.legacyBaseUrlStateKey
      ? state?.get?.(options.legacyBaseUrlStateKey)
      : null)
    || readStored(storage, options.legacyBaseUrlStorageKey)
    || defaultRuntimeBaseUrl()
  ).trim().replace(/\/+$/, "");

  return {
    mode,
    enabled: mode === "runtime",
    baseUrl
  };
}

export function runtimeDeviceServiceBaseUrl(
  service: "local-tools" | "plugin-service",
  options: WorkbenchRuntimeConfigOptions = {}
): string | null {
  const config = readWorkbenchRuntimeConfig(options);
  const state = options.state ?? (globalThis as any).window?.zion?.state;
  const backend = String(state?.get?.("runtime.connection")?.backend || "");
  if (config.mode !== "runtime" && backend !== "runtime") return null;
  return `${config.baseUrl}/v1/device-services/${service}`;
}

export type WorkbenchRuntimeHealth = {
  available: boolean;
  schedulerWorker: boolean;
  projectAutomationWorker: boolean;
  engineId?: string;
  runtimePlugins?: Array<{
    id: string;
    version?: string;
    origin?: string;
    status: string;
    contextProviderIds: string[];
    postProcessorIds?: string[];
    toolNames?: string[];
  }>;
  runtimePluginFailures?: number;
  checkedAt: number;
  error?: string;
};

const healthCache = new Map<string, {
  expiresAt: number;
  value: WorkbenchRuntimeHealth;
}>();

export async function probeWorkbenchRuntime({
  baseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 800,
  cacheTtlMs = 2000
}: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cacheTtlMs?: number;
}): Promise<WorkbenchRuntimeHealth> {
  const normalizedBaseUrl = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  const now = Date.now();
  const cached = healthCache.get(normalizedBaseUrl);
  if (cached && cached.expiresAt > now) return cached.value;
  if (!normalizedBaseUrl || !fetchImpl) {
    return {
      available: false,
      schedulerWorker: false,
      projectAutomationWorker: false,
      checkedAt: now,
      error: "Runtime endpoint is unavailable"
    };
  }

  const controller = new AbortController();
  const timer = globalThis.setTimeout(
    () => controller.abort(),
    Math.max(100, Number(timeoutMs) || 800)
  );
  let value: WorkbenchRuntimeHealth;
  try {
    const response = await fetchImpl(`${normalizedBaseUrl}/health`, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true || payload?.service !== "zion-runtime") {
      throw new Error(payload?.error || `Runtime health HTTP ${response.status}`);
    }
    value = {
      available: true,
      schedulerWorker: payload.schedulerWorker === true,
      projectAutomationWorker: payload.projectAutomationWorker === true,
      engineId: payload.engineId ? String(payload.engineId) : undefined,
      runtimePlugins: Array.isArray(payload.runtimePlugins)
        ? payload.runtimePlugins.map((plugin: any) => ({
            id: String(plugin?.id || ""),
            ...(plugin?.version
              ? { version: String(plugin.version) }
              : {}),
            ...(plugin?.origin
              ? { origin: String(plugin.origin) }
              : {}),
            status: String(plugin?.status || ""),
            contextProviderIds: Array.isArray(plugin?.contextProviderIds)
              ? plugin.contextProviderIds.map(String).filter(Boolean)
              : [],
            ...(Array.isArray(plugin?.postProcessorIds)
              ? {
                  postProcessorIds: plugin.postProcessorIds
                    .map(String)
                    .filter(Boolean)
                }
              : {}),
            ...(Array.isArray(plugin?.toolNames)
              ? { toolNames: plugin.toolNames.map(String).filter(Boolean) }
              : {})
          })).filter((plugin: any) => plugin.id)
        : [],
      runtimePluginFailures: Math.max(
        0,
        Number(payload.runtimePluginFailures) || 0
      ),
      checkedAt: now
    };
  } catch (error) {
    value = {
      available: false,
      schedulerWorker: false,
      projectAutomationWorker: false,
      checkedAt: now,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    globalThis.clearTimeout(timer);
  }
  healthCache.set(normalizedBaseUrl, {
    expiresAt: now + Math.max(0, Number(cacheTtlMs) || 0),
    value
  });
  return value;
}

export async function shouldUseWorkbenchRuntime(
  config: { mode: WorkbenchRuntimeMode; baseUrl: string },
  options: {
    requireSchedulerWorker?: boolean;
    fetchImpl?: typeof fetch;
    cacheTtlMs?: number;
  } = {}
): Promise<boolean> {
  if (config.mode === "browser") return false;
  if (config.mode === "runtime") return true;
  const health = await probeWorkbenchRuntime({
    baseUrl: config.baseUrl,
    fetchImpl: options.fetchImpl,
    cacheTtlMs: options.cacheTtlMs
  });
  return health.available
    && (!options.requireSchedulerWorker || health.schedulerWorker);
}
