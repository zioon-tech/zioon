import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "acorn";
import { PluginManager } from "../src/plugin/manager";
import type { PluginInfo } from "../src/plugin/types";
import stickyManifest from "../extensions/dev.sticky-header/manifest.json";

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

function stubBlobUrls(prefix = "blob:plugin-manager") {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const blobs = new Map<string, Blob>();
  let counter = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      const url = `${prefix}-${++counter}`;
      blobs.set(url, blob);
      return url;
    })
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn()
  });

  return {
    blobs,
    restore() {
      vi.restoreAllMocks();
      if (originalCreateObjectURL) {
        Object.defineProperty(URL, "createObjectURL", {
          configurable: true,
          value: originalCreateObjectURL
        });
      } else {
        delete (URL as any).createObjectURL;
      }
      if (originalRevokeObjectURL) {
        Object.defineProperty(URL, "revokeObjectURL", {
          configurable: true,
          value: originalRevokeObjectURL
        });
      } else {
        delete (URL as any).revokeObjectURL;
      }
    }
  };
}

function readBlobText(blob: Blob | undefined): Promise<string> {
  if (!blob) return Promise.resolve("");
  const candidate = blob as Blob & { text?: () => Promise<string> };
  if (typeof candidate.text === "function") return candidate.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read Blob"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsText(blob);
  });
}

describe("PluginManager enabled state persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("repairs the persisted compatibility plugin display-name ID before activation", async () => {
    const info = { ...pluginInfo(true), id: stickyManifest.name, name: stickyManifest.name,
      path: "/extensions/dev.sticky-header", manifest: stickyManifest, origin: "builtin" };
    localStorage.setItem("zion.installedPlugins", JSON.stringify([info]));
    const manager = new PluginManager({ pluginDir: "", extensionsDir: "", logLevel: "error" });
    await (manager as any).loadPersistedPlugins();
    expect(manager.get("dev.sticky-header")?.id).toBe("dev.sticky-header");
    expect(manager.get(stickyManifest.name)).toBeNull();
    expect(() => (manager as any).createPluginContext(manager.get("dev.sticky-header"))).not.toThrow();
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

  it("keeps a policy-blocked plugin installed without loading it", async () => {
    const manager = new PluginManager({
      pluginDir: "",
      extensionsDir: "",
      logLevel: "error",
      activationAllowed: () => false
    });

    await manager.installFromInfo(pluginInfo(true), { enabled: true });

    expect(manager.get("dev.example")?.state).toBe("installed");
    expect(manager.getActivePlugins()).toEqual([]);
  });

  it("does not activate an externalized plugin from a persisted dev session", async () => {
    const manager = new PluginManager({
      pluginDir: "",
      extensionsDir: "",
      logLevel: "error"
    });
    const identity = {
      ...pluginInfo(true),
      id: "dev.identity",
      name: "Identity",
      origin: "dev" as const,
      path: "http://127.0.0.1:8767/plugins/dev/dev-old",
      devId: "dev-old",
      sourceDir: "/Users/test/.zion-next/plugins/dev.identity"
    };
    identity.manifest.name = "dev.identity";
    identity.manifest.zion!.id = "dev.identity";
    identity.manifest.zion!.name = "Identity";

    await manager.installFromInfo(identity, { enabled: true });

    expect(manager.get("dev.identity")?.state).toBe("installed");
    expect(manager.getActivePlugins()).toEqual([]);
  });

  it.each(["installed", "error"] as const)(
    "replaces a same-version external package in %s state before activation",
    async (existingState) => {
      const manager = new PluginManager({
        pluginDir: "",
        extensionsDir: "",
        logLevel: "error"
      });
      const sourceEntries = { workbench: "./dist/main.js" };
      const scriptContents = {
        "dist/main.js": "export function activate() {}"
      };
      const existing = {
        ...pluginInfo(true),
        id: "dev.identity",
        name: "Identity",
        origin: "external" as const,
        path: "https://zion.example/v1/device-services/plugin-service/plugins/dev.identity/download",
        state: existingState,
        error: existingState === "error" ? {
          type: "activation_failed" as const,
          message: "stale relative URL",
          timestamp: 1
        } : undefined,
        sourceEntries,
        scriptContents,
        contract: {
          id: "dev.identity",
          name: "Identity",
          version: "1.0.0",
          hosts: { workbench: true, runtime: false, renderer: false },
          entries: { workbench: "./dist/main.js" }
        }
      };
      existing.manifest.name = "dev.identity";
      existing.manifest.zion!.id = "dev.identity";
      existing.manifest.zion!.name = "Identity";
      const incoming = {
        ...existing,
        state: "installed" as const,
        error: undefined,
        contract: {
          ...existing.contract,
          entries: { workbench: "blob:fresh-identity-entry" }
        },
        scriptBlobUrls: {
          "dist/main.js": "blob:fresh-identity-entry"
        }
      };
      (manager as any).plugins.set(existing.id, existing);
      (manager as any).enabledPlugins.add(existing.id);
      vi.spyOn((manager as any).loader, "loadModule").mockResolvedValue({
        activate: vi.fn()
      });

      await manager.installFromInfo(incoming, { enabled: true });

      expect(manager.get(existing.id)).toMatchObject({
        state: "active",
        error: undefined,
        contract: {
          entries: { workbench: "blob:fresh-identity-entry" }
        }
      });
    }
  );

  it("rehydrates persisted ZIP plugin modules with fresh blob URLs", async () => {
    const { blobs, restore } = stubBlobUrls("blob:rehydrated-plugin");
    try {
      localStorage.setItem("zion.installedPlugins", JSON.stringify([{
        ...pluginInfo(true),
        id: "dev.zip-modules",
        name: "Zip Modules",
        origin: "external",
        path: "file://dev.zip-modules.zip",
        manifest: {
          name: "dev.zip-modules",
          version: "1.0.0",
          zion: {
            id: "dev.zip-modules",
            name: "Zip Modules",
            version: "1.0.0",
            main: "./main.js"
          }
        },
        scriptContents: {
          "main.js": "import { label } from './dashboard-model.js';\nexport function activate() { return label; }\n",
          "dashboard-model.js": "export const label = 'dashboard';\n"
        },
        sourceEntries: {
          workbench: "./main.js"
        },
        contract: undefined
      }]));

      const manager = new PluginManager({ pluginDir: "", extensionsDir: "", logLevel: "error" });
      await (manager as any).loadPersistedPlugins();

      const restored = manager.get("dev.zip-modules");
      const mainUrl = String(restored?.contract?.entries.workbench || "");
      expect(mainUrl).toMatch(/^blob:rehydrated-plugin-/);
      expect((restored?.manifest as any).zion.main).toBe(mainUrl);
      const code = await readBlobText(blobs.get(mainUrl));
      const imports = parse(code, { ecmaVersion: "latest", sourceType: "module" }).body
        .filter((node) => node.type === "ImportDeclaration");
      expect(imports.map((node) => node.source.value)).toEqual(["blob:rehydrated-plugin-1"]);

      await (manager as any).savePluginStates();
      const saved = JSON.parse(localStorage.getItem("zion.installedPlugins") || "[]");
      expect(saved[0].manifest.zion.main).toBe("./main.js");
      expect(saved[0].contract.entries.workbench).toBe("./main.js");
      expect(saved[0].scriptContents).toBeUndefined();
      expect(saved[0].scriptBlobUrls).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("does not persist ZIP JavaScript sources into localStorage", async () => {
    const largeSource = `export function activate() {}\n${"x".repeat(600_000)}`;
    const largePlugin: PluginInfo = {
      ...pluginInfo(true),
      id: "dev.large-zip",
      name: "Large Zip",
      origin: "external",
      path: "file://dev.large-zip.zip",
      manifest: {
        name: "dev.large-zip",
        version: "1.0.0",
        zion: {
          id: "dev.large-zip",
          name: "Large Zip",
          version: "1.0.0",
          main: "blob:large-plugin-main"
        }
      },
      scriptContents: {
        "main.js": largeSource
      },
      sourceEntries: {
        workbench: "./main.js"
      },
      scriptBlobUrls: {
        "main.js": "blob:large-plugin-main"
      }
    };
    const manager = new PluginManager({
      pluginDir: "",
      extensionsDir: "",
      logLevel: "error",
      activationAllowed: () => false
    });

    await manager.installFromInfo(largePlugin, { enabled: true });

    const raw = localStorage.getItem("zion.installedPlugins") || "";
    const saved = JSON.parse(raw);
    expect(raw.length).toBeLessThan(100_000);
    expect(saved[0].scriptContents).toBeUndefined();
    expect(saved[0].scriptContentBytes).toBeGreaterThan(600_000);
  });

  it("does not persist bundled plugins because they are scanned from the Workbench bundle", async () => {
    const manager = new PluginManager({
      pluginDir: "",
      extensionsDir: "",
      logLevel: "error",
      activationAllowed: () => false
    });

    await manager.installFromInfo(pluginInfo(true), { enabled: true });

    expect(JSON.parse(localStorage.getItem("zion.installedPlugins") || "[]")).toEqual([]);
  });

  it("retries installed plugin persistence after removing the previous oversized value", async () => {
    localStorage.setItem("zion.installedPlugins", "x".repeat(1000));
    const originalSetItem = Storage.prototype.setItem;
    const removeSpy = vi.spyOn(Storage.prototype, "removeItem");
    let failedOnce = false;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(key, value) {
      if (key === "zion.installedPlugins" && !failedOnce) {
        failedOnce = true;
        throw new DOMException("quota", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    });
    const manager = new PluginManager({
      pluginDir: "",
      extensionsDir: "",
      logLevel: "error",
      activationAllowed: () => false
    });
    const external = {
      ...pluginInfo(true),
      id: "dev.external",
      origin: "external" as const,
      path: "https://runtime.test/plugins/dev.external/download"
    };

    await manager.installFromInfo(external, { enabled: true });

    expect(removeSpy).toHaveBeenCalledWith("zion.installedPlugins");
    expect(JSON.parse(localStorage.getItem("zion.installedPlugins") || "[]")[0]).toMatchObject({
      id: "dev.external"
    });
  });

  it("rewrites installed plugins even when the small state record initially hits quota", async () => {
    localStorage.setItem("zion.installedPlugins", "x".repeat(1000));
    const originalSetItem = Storage.prototype.setItem;
    let failedStateOnce = false;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(key, value) {
      if (key === "zion.pluginStates" && !failedStateOnce) {
        failedStateOnce = true;
        throw new DOMException("quota", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    });
    const manager = new PluginManager({
      pluginDir: "",
      extensionsDir: "",
      logLevel: "error",
      activationAllowed: () => false
    });
    const external = {
      ...pluginInfo(true),
      id: "dev.external-state-retry",
      origin: "external" as const,
      path: "https://runtime.test/plugins/dev.external-state-retry/download"
    };

    await manager.installFromInfo(external, { enabled: true });

    expect(JSON.parse(localStorage.getItem("zion.pluginStates") || "{}").enabled)
      .toContain("dev.external-state-retry");
    expect(JSON.parse(localStorage.getItem("zion.installedPlugins") || "[]")[0])
      .toMatchObject({ id: "dev.external-state-retry" });
  });

  it("falls back to lightweight installed plugin records when embedded assets exceed quota", async () => {
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(key, value) {
      if (key === "zion.installedPlugins" && String(value).includes("large-skill-content")) {
        throw new DOMException("quota", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    });
    const manager = new PluginManager({
      pluginDir: "",
      extensionsDir: "",
      logLevel: "error",
      activationAllowed: () => false
    });
    const external = {
      ...pluginInfo(true),
      id: "dev.asset-heavy",
      origin: "external" as const,
      path: "https://runtime.test/plugins/dev.asset-heavy/download",
      skillContents: {
        "heavy-skill": "large-skill-content"
      },
      skillFiles: {
        "heavy-skill": {
          "SKILL.md": "large-skill-content"
        }
      },
      styleContents: {
        "styles.css": "large-skill-content"
      }
    };

    await manager.installFromInfo(external, { enabled: true });

    const saved = JSON.parse(localStorage.getItem("zion.installedPlugins") || "[]");
    expect(saved[0]).toMatchObject({ id: "dev.asset-heavy" });
    expect(saved[0].skillContents).toBeUndefined();
    expect(saved[0].skillFiles).toBeUndefined();
    expect(saved[0].styleContents).toBeUndefined();
  });

  it("retries activation when an enabled builtin was previously policy-blocked", async () => {
    const manager = new PluginManager({
      pluginDir: "",
      extensionsDir: "",
      logLevel: "error",
      activationAllowed: () => true
    });
    const activate = vi.spyOn(manager, "activate").mockResolvedValue();
    const info = pluginInfo(true);
    (manager as any).plugins.set(info.id, info);
    (manager as any).enabledPlugins.add(info.id);

    await manager.updateFromInfo({ ...info }, { enabled: true });

    expect(activate).toHaveBeenCalledWith("dev.example");
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
