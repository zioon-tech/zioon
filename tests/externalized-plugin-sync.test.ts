import { describe, expect, it, vi } from "vitest";
import {
  externalizedPluginIdForDevSession,
  resolveExternalizedPluginServiceBaseUrl,
  syncExternalizedBuiltinPlugins
} from "../src/plugin/externalized";
import type { HttpPluginInstaller } from "../src/plugin/http-installer";
import type { PluginManager } from "../src/plugin/manager";
import type { PluginInfo } from "../src/plugin/types";

function identityPlugin(version: string, origin: "dev" | "external"): PluginInfo {
  return {
    id: "dev.identity",
    name: "Identity",
    version,
    path: origin === "dev"
      ? "http://127.0.0.1:8767/plugins/dev/dev-old"
      : "http://127.0.0.1:8767/plugins/dev.identity/download",
    manifest: {
      name: "dev.identity",
      version,
      zion: {
        id: "dev.identity",
        name: "Identity",
        version,
        main: "./dist/main.js"
      }
    },
    state: "installed",
    dependencies: [],
    peerDependencies: [],
    createdAt: 1,
    updatedAt: 1,
    isLegacy: false,
    enabled: true,
    origin
  };
}

describe("externalized plugin sync", () => {
  it("recognizes externalized development sessions by plugin id or source directory", () => {
    expect(externalizedPluginIdForDevSession({
      pluginId: "dev.identity"
    })).toBe("dev.identity");
    expect(externalizedPluginIdForDevSession({
      dir: "C:\\Users\\zion\\.zion-next\\plugins\\dev.identity\\"
    })).toBe("dev.identity");
    expect(externalizedPluginIdForDevSession({
      dir: "/tmp/dev.other"
    })).toBeNull();
  });

  it("uses the Runtime gateway only for a same-origin hosted Workbench", () => {
    expect(resolveExternalizedPluginServiceBaseUrl({
      configuredServiceBaseUrl: "http://127.0.0.1:8767",
      runtimeServiceBaseUrl:
        "http://127.0.0.1:8766/v1/device-services/plugin-service",
      pageOrigin: "http://127.0.0.1:5177"
    })).toBe("http://127.0.0.1:8767");

    expect(resolveExternalizedPluginServiceBaseUrl({
      configuredServiceBaseUrl: "http://127.0.0.1:8767",
      runtimeServiceBaseUrl:
        "https://zion.example/v1/device-services/plugin-service",
      pageOrigin: "https://zion.example"
    })).toBe("https://zion.example/v1/device-services/plugin-service");
  });

  it("stops a stale server-side dev session before installing the ZIP package", async () => {
    const installed = identityPlugin("0.1.3", "external");
    const released = identityPlugin("0.1.7", "external");
    const pluginManager = {
      listDevSessionRecords: vi.fn(() => ({})),
      get: vi.fn(() => installed),
      getPluginOrigin: vi.fn((plugin) => plugin.origin),
      removeDevSessionRecord: vi.fn(() => true),
      getEnabledPreference: vi.fn(() => true),
      installFromInfo: vi.fn(async () => released)
    } as unknown as PluginManager;
    const pluginInstaller = {
      installFromService: vi.fn(async () => ({
        success: true,
        plugin: released,
        warnings: []
      }))
    } as unknown as HttpPluginInstaller;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/plugins/dev/list")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              sessions: [
                {
                  devId: "dev-identity",
                  dir: "/Users/test/.zion-next/plugins/dev.identity"
                },
                {
                  devId: "dev-other",
                  dir: "/Users/test/.zion-next/plugins/dev.other"
                }
              ]
            }
          })
        } as Response;
      }
      return {
        ok: true,
        text: async () => ""
      } as Response;
    });

    const logger = { log: vi.fn(), warn: vi.fn() };
    await syncExternalizedBuiltinPlugins({
      pluginManager,
      pluginInstaller,
      serviceBaseUrl: "http://127.0.0.1:8767/",
      logger,
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8767/plugins/dev/stop",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ devId: "dev-identity" })
      })
    );
    expect(fetchImpl).not.toHaveBeenCalledWith(
      "http://127.0.0.1:8767/plugins/dev/stop",
      expect.objectContaining({
        body: JSON.stringify({ devId: "dev-other" })
      })
    );
    expect(pluginManager.removeDevSessionRecord).toHaveBeenCalledWith({
      pluginId: "dev.identity"
    });
    expect(pluginInstaller.installFromService).toHaveBeenCalledWith("dev.identity");
    expect(pluginManager.installFromInfo).toHaveBeenCalledWith(released, {
      enabled: true
    });
  });
});
