import { beforeEach, describe, expect, it } from "vitest";
import { PluginManager } from "../src/plugin/manager";
import type { PluginInfo } from "../src/plugin/types";

function pluginInfo(enabled: boolean): PluginInfo {
  return {
    id: "dev.example",
    name: "Example",
    version: "1.0.0",
    description: "Example plugin",
    path: "/extensions/dev.example",
    manifest: {
      name: "dev.example",
      version: "1.0.0",
      zion: {
        id: "dev.example",
        name: "Example",
        version: "1.0.0",
        main: "./main.js"
      }
    },
    state: "installed",
    dependencies: [],
    peerDependencies: [],
    createdAt: 1,
    updatedAt: 1,
    isLegacy: false,
    enabled
  };
}

describe("PluginManager enabled state persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("lets an explicit disabled preference override a stale enabled install record", async () => {
    localStorage.setItem("zion.pluginStates", JSON.stringify({
      enabled: [],
      disabled: ["dev.example"]
    }));
    localStorage.setItem("zion.installedPlugins", JSON.stringify([pluginInfo(true)]));

    const manager = new PluginManager({ pluginDir: "", extensionsDir: "", logLevel: "error" });
    await (manager as any).loadPluginStates();
    await (manager as any).loadPersistedPlugins();

    expect(manager.getEnabledPreference("dev.example")).toBe(false);
    expect(manager.get("dev.example")?.enabled).toBe(false);
    expect(manager.getDisabledPlugins().map((plugin) => plugin.id)).toContain("dev.example");
  });

  it("preserves the disabled preference while syncing builtin plugin metadata", async () => {
    localStorage.setItem("zion.pluginStates", JSON.stringify({
      enabled: [],
      disabled: ["dev.example"]
    }));
    localStorage.setItem("zion.installedPlugins", JSON.stringify([pluginInfo(false)]));

    const manager = new PluginManager({ pluginDir: "", extensionsDir: "", logLevel: "error" });
    await (manager as any).loadPluginStates();
    await (manager as any).loadPersistedPlugins();

    const refreshed = { ...pluginInfo(true), description: "Updated description", updatedAt: 2 };
    const enabled = manager.getEnabledPreference(refreshed.id) ?? true;
    await manager.updateFromInfo(refreshed, { enabled });

    expect(manager.get("dev.example")).toMatchObject({
      description: "Updated description",
      enabled: false
    });
    expect(JSON.parse(localStorage.getItem("zion.pluginStates") || "{}").disabled).toContain("dev.example");
  });
});

describe("PluginManager development session persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists and removes development session records by devId", () => {
    const manager = new PluginManager({ pluginDir: "", extensionsDir: "", logLevel: "error" });

    expect(manager.saveDevSessionRecord({
      pluginId: "dev.example",
      devId: "dev-12345678",
      baseUrl: "http://127.0.0.1:8765/plugins/dev/dev-12345678",
      dir: "/tmp/dev.example"
    })).toBe(true);

    expect(manager.listDevSessionRecords()).toEqual({
      "dev.example": {
        pluginId: "dev.example",
        devId: "dev-12345678",
        baseUrl: "http://127.0.0.1:8765/plugins/dev/dev-12345678",
        dir: "/tmp/dev.example"
      }
    });

    expect(manager.removeDevSessionRecord({ devId: "dev-12345678" })).toBe(true);
    expect(manager.listDevSessionRecords()).toEqual({});
  });

  it("migrates legacy dev plugin metadata only once", async () => {
    localStorage.setItem("zion.installedPlugins", JSON.stringify([{
      ...pluginInfo(true),
      origin: "dev",
      path: "http://127.0.0.1:8765/plugins/dev/dev-87654321",
      sourceDir: "/tmp/dev.example",
      devId: "dev-87654321"
    }]));

    const manager = new PluginManager({ pluginDir: "", extensionsDir: "", logLevel: "error" });
    await (manager as any).loadPersistedPlugins();

    expect(manager.listDevSessionRecords()["dev.example"]).toMatchObject({
      devId: "dev-87654321",
      dir: "/tmp/dev.example"
    });

    manager.removeDevSessionRecord({ pluginId: "dev.example" });
    expect(manager.listDevSessionRecords()).toEqual({});
  });
});
