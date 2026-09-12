import { describe, expect, it, vi } from "vitest";
import {
  probeWorkbenchRuntime,
  readWorkbenchRuntimeConfig,
  runtimeDeviceServiceBaseUrl,
  shouldUseWorkbenchRuntime,
  WORKBENCH_RUNTIME_BASE_URL_STORAGE_KEY,
  WORKBENCH_RUNTIME_MODE_STORAGE_KEY
} from "../src/runtime/workbench-runtime-config";

function storage(values: Record<string, string> = {}) {
  return {
    getItem(key: string) {
      return values[key] ?? null;
    }
  };
}

describe("Workbench Runtime configuration", () => {
  it("keeps browser execution as the default", () => {
    expect(readWorkbenchRuntimeConfig({
      state: { get: () => undefined },
      storage: storage()
    })).toEqual({
      mode: "auto",
      enabled: false,
      baseUrl: "http://127.0.0.1:8766"
    });
  });

  it("uses one global Runtime mode and URL across Workbench features", () => {
    expect(readWorkbenchRuntimeConfig({
      state: { get: () => undefined },
      storage: storage({
        [WORKBENCH_RUNTIME_MODE_STORAGE_KEY]: "runtime",
        [WORKBENCH_RUNTIME_BASE_URL_STORAGE_KEY]: "http://localhost:9000/"
      }),
      legacyEnabledStorageKey: "zion.chat.runtime.enabled",
      legacyBaseUrlStorageKey: "zion.chat.runtime.baseUrl"
    })).toEqual({
      mode: "runtime",
      enabled: true,
      baseUrl: "http://localhost:9000"
    });
  });

  it("keeps legacy per-feature flags as a migration fallback", () => {
    expect(readWorkbenchRuntimeConfig({
      state: { get: () => undefined },
      storage: storage({
        "zion.scheduler.runtime.enabled": "true",
        "zion.scheduler.runtime.baseUrl": "http://127.0.0.1:9876"
      }),
      legacyEnabledStorageKey: "zion.scheduler.runtime.enabled",
      legacyBaseUrlStorageKey: "zion.scheduler.runtime.baseUrl"
    })).toEqual({
      mode: "runtime",
      enabled: true,
      baseUrl: "http://127.0.0.1:9876"
    });
  });

  it("lets the global browser mode override an old enabled flag", () => {
    expect(readWorkbenchRuntimeConfig({
      state: { get: () => undefined },
      storage: storage({
        [WORKBENCH_RUNTIME_MODE_STORAGE_KEY]: "browser",
        "zion.chat.runtime.enabled": "true"
      }),
      legacyEnabledStorageKey: "zion.chat.runtime.enabled"
    }).enabled).toBe(false);
  });

  it("builds same-origin Device service URLs only in Runtime mode", () => {
    expect(runtimeDeviceServiceBaseUrl("local-tools", {
      state: { get: () => undefined },
      storage: storage({
        [WORKBENCH_RUNTIME_MODE_STORAGE_KEY]: "runtime",
        [WORKBENCH_RUNTIME_BASE_URL_STORAGE_KEY]: "https://runtime.test/"
      })
    })).toBe("https://runtime.test/v1/device-services/local-tools");

    expect(runtimeDeviceServiceBaseUrl("plugin-service", {
      state: { get: () => undefined },
      storage: storage({
        [WORKBENCH_RUNTIME_MODE_STORAGE_KEY]: "browser"
      })
    })).toBeNull();
  });

  it("automatically uses a healthy Runtime and checks Scheduler ownership", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      service: "zion-runtime",
      engineId: "zion.echo",
      schedulerWorker: true,
      projectAutomationWorker: true,
      runtimePluginFailures: 0,
      runtimePlugins: [{
        id: "dev.skills",
        version: "2.1.0",
        origin: "builtin",
        status: "active",
        contextProviderIds: ["dev.skills.available"],
        postProcessorIds: [],
        toolNames: ["skillsList"]
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const config = {
      mode: "auto" as const,
      baseUrl: "http://127.0.0.1:8766"
    };

    await expect(probeWorkbenchRuntime({
      baseUrl: config.baseUrl,
      fetchImpl,
      cacheTtlMs: 0
    })).resolves.toMatchObject({
      available: true,
      schedulerWorker: true,
      projectAutomationWorker: true,
      engineId: "zion.echo",
      runtimePluginFailures: 0,
      runtimePlugins: [{
        id: "dev.skills",
        version: "2.1.0",
        origin: "builtin",
        status: "active",
        contextProviderIds: ["dev.skills.available"],
        postProcessorIds: [],
        toolNames: ["skillsList"]
      }]
    });
    await expect(shouldUseWorkbenchRuntime(config, {
      requireSchedulerWorker: true,
      fetchImpl,
      cacheTtlMs: 0
    })).resolves.toBe(true);
  });
});
