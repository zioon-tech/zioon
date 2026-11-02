import { describe, expect, it, beforeEach } from "vitest";
import {
  DEFAULT_BASE_URL,
  DEFAULT_PLUGIN_SERVICE_BASE_URL,
  SERVICE_BASEURL_STORAGE_KEY,
  loadServiceBaseUrlConfig,
  normalizeBaseUrl,
  resetServiceBaseUrlConfig,
  saveServiceBaseUrlConfig,
  initServiceBaseUrlConfig
} from "./serviceBaseUrl";

function makeZionMock() {
  const stateMap = new Map();
  const events: any[] = [];
  return {
    state: {
      set: (k: string, v: any) => stateMap.set(k, v),
      get: (k: string) => stateMap.get(k)
    },
    events: {
      emit: (topic: string, payload?: any) => events.push({ topic, payload })
    },
    __stateMap: stateMap,
    __events: events
  };
}

beforeEach(() => {
  localStorage.clear();
  (window as any).zion = makeZionMock();
});

describe("normalizeBaseUrl", () => {
  it("accepts http/https and strips trailing slash", () => {
    const r1 = normalizeBaseUrl("http://127.0.0.1:8765/");
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value).toBe("http://127.0.0.1:8765");

    const r2 = normalizeBaseUrl("https://example.com/api/");
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toBe("https://example.com/api");
  });

  it("rejects non-http protocols", () => {
    const r = normalizeBaseUrl("ws://127.0.0.1:8765");
    expect(r.ok).toBe(false);
  });
});

describe("service baseUrl config", () => {
  it("reset writes defaults and legacy keys", () => {
    const ret = resetServiceBaseUrlConfig();
    expect(ret.ok).toBe(true);
    const raw = localStorage.getItem(SERVICE_BASEURL_STORAGE_KEY);
    expect(raw).toBeTruthy();

    expect(localStorage.getItem("zion.pluginServiceUrl")).toBe(
      DEFAULT_PLUGIN_SERVICE_BASE_URL
    );
    expect(localStorage.getItem("zion.localTools.baseUrl")).toBe(DEFAULT_BASE_URL);
    expect(localStorage.getItem("zion.localSearch.baseUrl")).toBe(DEFAULT_BASE_URL);
    expect(localStorage.getItem("zion.mail.baseUrl")).toBe(DEFAULT_BASE_URL);
  });

  it("save validates and persists, and updates state", () => {
    const ret = saveServiceBaseUrlConfig({ localTools: "http://localhost:9999/" } as any);
    expect(ret.ok).toBe(true);
    if (!ret.ok) return;

    expect(localStorage.getItem("zion.localTools.baseUrl")).toBe("http://localhost:9999");
    expect((window as any).zion.state.get("localTools.baseUrl")).toBe("http://localhost:9999");
    expect((window as any).zion.state.get("settings.serviceBaseUrl")).toBeTruthy();
  });

  it("load falls back to legacy keys when new key missing", () => {
    localStorage.setItem("zion.localSearch.baseUrl", "http://localhost:7777");
    const cfg = loadServiceBaseUrlConfig();
    expect(cfg.services.localSearch.baseUrl).toBe("http://localhost:7777");
  });

  it("migrates the old local-tools plugin service default", () => {
    localStorage.setItem("zion.pluginServiceUrl", DEFAULT_BASE_URL);
    const cfg = loadServiceBaseUrlConfig();
    expect(cfg.services.pluginService.baseUrl).toBe(
      DEFAULT_PLUGIN_SERVICE_BASE_URL
    );
  });

  it("init syncs config into state", () => {
    localStorage.setItem("zion.mail.baseUrl", "http://localhost:5555/");
    const cfg = initServiceBaseUrlConfig();
    expect(cfg.services.mail.baseUrl).toBe("http://localhost:5555");
    expect((window as any).zion.state.get("mail.baseUrl")).toBe("http://localhost:5555");
  });
});
