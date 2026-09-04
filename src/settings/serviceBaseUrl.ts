export type ServiceId = "pluginService" | "localTools" | "localSearch" | "mail";

export type ServiceBaseUrlConfigV1 = {
  version: 1;
  updatedAt: number;
  services: Record<ServiceId, { name: string; baseUrl: string }>;
};

export const SERVICE_BASEURL_STORAGE_KEY = "zion.settings.serviceBaseUrl";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8765";
export const DEFAULT_PLUGIN_SERVICE_BASE_URL = "http://127.0.0.1:8767";

export const SERVICE_DEFS: Array<{
  id: ServiceId;
  name: string;
  defaultBaseUrl: string;
  legacyStorageKey?: string;
  stateKey?: string;
}> = [
  {
    id: "pluginService",
    name: "Plugin Service",
    defaultBaseUrl: DEFAULT_PLUGIN_SERVICE_BASE_URL,
    legacyStorageKey: "zion.pluginServiceUrl"
  },
  {
    id: "localTools",
    name: "Local Tools",
    defaultBaseUrl: DEFAULT_BASE_URL,
    legacyStorageKey: "zion.localTools.baseUrl",
    stateKey: "localTools.baseUrl"
  },
  {
    id: "localSearch",
    name: "Local Search",
    defaultBaseUrl: DEFAULT_BASE_URL,
    legacyStorageKey: "zion.localSearch.baseUrl",
    stateKey: "localSearch.baseUrl"
  },
  {
    id: "mail",
    name: "Mail Service",
    defaultBaseUrl: DEFAULT_BASE_URL,
    legacyStorageKey: "zion.mail.baseUrl",
    stateKey: "mail.baseUrl"
  }
];

export function normalizeBaseUrl(input: string): { ok: true; value: string } | { ok: false; error: string } {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "empty" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "invalid_protocol" };
  if (!u.hostname) return { ok: false, error: "missing_host" };
  const path = (u.pathname || "/").replace(/\/+$/, "");
  const normalized = path && path !== "/" ? `${u.origin}${path}` : u.origin;
  return { ok: true, value: normalized };
}

export function buildDefaultConfig(now = Date.now()): ServiceBaseUrlConfigV1 {
  const services = {} as ServiceBaseUrlConfigV1["services"];
  for (const def of SERVICE_DEFS) {
    services[def.id] = { name: def.name, baseUrl: def.defaultBaseUrl };
  }
  return { version: 1, updatedAt: now, services };
}

function readLegacyBaseUrl(def: (typeof SERVICE_DEFS)[number]): string {
  if (!def.legacyStorageKey) return "";
  try {
    const v = localStorage.getItem(def.legacyStorageKey) || "";
    return String(v || "").trim();
  } catch {
    return "";
  }
}

export function loadServiceBaseUrlConfig(): ServiceBaseUrlConfigV1 {
  const fallback = buildDefaultConfig(0);
  let raw: any = null;
  try {
    const s = localStorage.getItem(SERVICE_BASEURL_STORAGE_KEY);
    if (s) raw = JSON.parse(s);
  } catch {
    raw = null;
  }

  const out = buildDefaultConfig(typeof raw?.updatedAt === "number" ? raw.updatedAt : Date.now());
  for (const def of SERVICE_DEFS) {
    const fromNew = raw?.version === 1 ? raw?.services?.[def.id]?.baseUrl : null;
    const fromLegacy = readLegacyBaseUrl(def);
    const chosen =
      typeof fromNew === "string" && fromNew.trim()
        ? fromNew.trim()
        : fromLegacy
          ? fromLegacy
          : def.defaultBaseUrl;

    const migrated = def.id === "pluginService" && chosen === DEFAULT_BASE_URL
      ? DEFAULT_PLUGIN_SERVICE_BASE_URL
      : chosen;
    const norm = normalizeBaseUrl(migrated);
    out.services[def.id] = {
      name: def.name,
      baseUrl: norm.ok ? norm.value : def.defaultBaseUrl
    };
  }
  return out || fallback;
}

export function applyServiceBaseUrlConfigToRuntime(cfg: ServiceBaseUrlConfigV1): void {
  try {
    localStorage.setItem(SERVICE_BASEURL_STORAGE_KEY, JSON.stringify(cfg));
  } catch {}

  for (const def of SERVICE_DEFS) {
    const v = cfg?.services?.[def.id]?.baseUrl;
    if (!v) continue;
    if (def.legacyStorageKey) {
      try {
        localStorage.setItem(def.legacyStorageKey, v);
      } catch {}
    }
    if (def.stateKey) {
      try {
        (window as any).zion?.state?.set?.(def.stateKey, v);
      } catch {}
    }
  }
  try {
    (window as any).zion?.state?.set?.("settings.serviceBaseUrl", cfg);
  } catch {}
  try {
    (window as any).zion?.events?.emit?.("settings/serviceBaseUrlChanged", { config: cfg });
  } catch {}
}

export function saveServiceBaseUrlConfig(services: Partial<Record<ServiceId, string>>):
  | { ok: true; config: ServiceBaseUrlConfigV1 }
  | { ok: false; error: string; field?: ServiceId } {
  const cur = loadServiceBaseUrlConfig();
  const next = buildDefaultConfig(Date.now());
  next.services = { ...cur.services } as any;

  for (const def of SERVICE_DEFS) {
    const raw = services[def.id];
    if (typeof raw !== "string") continue;
    const norm = normalizeBaseUrl(raw);
    if (!norm.ok) return { ok: false, error: norm.error, field: def.id };
    next.services[def.id] = { name: def.name, baseUrl: norm.value };
  }
  next.updatedAt = Date.now();
  applyServiceBaseUrlConfigToRuntime(next);
  return { ok: true, config: next };
}

export function resetServiceBaseUrlConfig(): { ok: true; config: ServiceBaseUrlConfigV1 } {
  const cfg = buildDefaultConfig(Date.now());
  applyServiceBaseUrlConfigToRuntime(cfg);
  return { ok: true, config: cfg };
}

export function initServiceBaseUrlConfig(): ServiceBaseUrlConfigV1 {
  const cfg = loadServiceBaseUrlConfig();
  applyServiceBaseUrlConfigToRuntime(cfg);
  return cfg;
}
