import { describe, expect, it } from "vitest";
import type { PluginInfo } from "../src/plugin/types";
import {
  runtimeHostedPluginActivationAllowed
} from "../src/runtime/workbench-plugin-policy";

function plugin(
  id: string,
  origin: PluginInfo["origin"] = "builtin"
): PluginInfo {
  return {
    id,
    name: id,
    version: "1.0.0",
    path: `/extensions/${id}`,
    manifest: {
      zion: {
        id,
        name: id,
        version: "1.0.0",
        main: "./main.js",
        engines: { zion: ">=1.0.0" }
      }
    },
    state: "installed",
    dependencies: [],
    peerDependencies: [],
    createdAt: 1,
    updatedAt: 1,
    isLegacy: false,
    origin,
    enabled: true
  } as PluginInfo;
}

describe("Runtime-hosted Workbench plugin policy", () => {
  it("allows Runtime-aware built-ins", () => {
    expect(runtimeHostedPluginActivationAllowed(
      plugin("dev.session-manager")
    )).toBe(true);
    expect(runtimeHostedPluginActivationAllowed(
      plugin("dev.tools")
    )).toBe(true);
    expect(runtimeHostedPluginActivationAllowed(
      plugin("dev.plugins")
    )).toBe(true);
    expect(runtimeHostedPluginActivationAllowed(
      plugin("dev.skills")
    )).toBe(true);
    expect(runtimeHostedPluginActivationAllowed(
      plugin("dev.terminal-manager")
    )).toBe(true);
    expect(runtimeHostedPluginActivationAllowed(
      plugin("dev.terminal-enhanced")
    )).toBe(true);
  });

  it("blocks Workbench plugins that connect to browser-local services", () => {
    expect(runtimeHostedPluginActivationAllowed(
      plugin("dev.fs-manager")
    )).toBe(false);
    expect(runtimeHostedPluginActivationAllowed(
      plugin("dev.identity")
    )).toBe(false);
  });

  it("blocks persisted development and external plugins", () => {
    expect(runtimeHostedPluginActivationAllowed(
      plugin("dev.custom", "dev")
    )).toBe(false);
    expect(runtimeHostedPluginActivationAllowed(
      plugin("third.party", "external")
    )).toBe(false);
  });

  it("allows browser-installed ZIP plugins backed by local blob module URLs", () => {
    const zipPlugin = plugin("dev.mind-dashboard", "external");
    zipPlugin.path = "file://dev.mind-dashboard-bundled-0.2.8.zip";
    zipPlugin.sourceEntries = { workbench: "./main.js" };
    zipPlugin.scriptContents = {
      "main.js": "export function activate() {}\n"
    };
    zipPlugin.manifest.zion!.main = "blob:mind-dashboard-main";
    zipPlugin.contract = {
      id: "dev.mind-dashboard",
      name: "Mind Dashboard",
      version: "0.2.8",
      manifestVersion: 1,
      entries: { workbench: "blob:mind-dashboard-main" },
      hosts: { workbench: true },
      capabilities: [],
      activationEvents: []
    } as any;

    expect(runtimeHostedPluginActivationAllowed(zipPlugin)).toBe(true);
  });

  it("allows the externalized Identity package from the same-origin Device service", () => {
    const proxied = plugin("dev.identity", "external");
    proxied.path =
      `${window.location.origin}/v1/device-services/plugin-service/`
      + "plugins/dev.identity/download";

    expect(runtimeHostedPluginActivationAllowed(proxied)).toBe(true);

    const untrusted = plugin("dev.identity", "external");
    untrusted.path = "https://plugins.example/dev.identity.zip";
    expect(runtimeHostedPluginActivationAllowed(untrusted)).toBe(false);
  });

  it("allows Device-proxied development plugins", () => {
    const proxied = plugin("dev.identity", "dev");
    proxied.path =
      `${window.location.origin}/v1/device-services/plugin-service/`
      + "plugins/dev/dev-123";

    expect(runtimeHostedPluginActivationAllowed(proxied)).toBe(true);
  });
});
