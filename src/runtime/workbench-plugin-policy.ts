import type { PluginInfo } from "../plugin/types";
import { readWorkbenchRuntimeConfig } from "./workbench-runtime-config";

const RUNTIME_HOSTED_LOCAL_PLUGIN_IDS = new Set([
  "dev.fs-manager",
  "dev.identity",
  "dev.service-baseurl"
]);

function pluginOrigin(plugin: PluginInfo): string {
  const explicit = String(plugin?.origin || "");
  if (explicit) return explicit;
  const path = String(plugin?.path || "");
  const manifest = plugin?.manifest as any;
  const entry = String(
    plugin?.contract?.entries?.workbench
    || manifest?.zion?.entries?.workbench
    || manifest?.zion?.entries?.ui
    || manifest?.zion?.main
    || manifest?.main
    || ""
  );
  if (path.startsWith("/extensions/") || entry.startsWith("internal:")) {
    return "builtin";
  }
  if (/\/plugins\/dev\//.test(path) || /\/plugins\/dev\//.test(entry)) {
    return "dev";
  }
  return "external";
}

function isBrowserInstalledZipPlugin(plugin: PluginInfo): boolean {
  const sourceEntries = plugin.sourceEntries || {};
  const hasSourceEntry = Boolean(sourceEntries.workbench || sourceEntries.renderer);
  const hasScriptSource = Boolean(
    plugin.scriptContents
    && Object.keys(plugin.scriptContents).length > 0
  );
  if (!hasSourceEntry || !hasScriptSource) return false;

  const manifest = plugin.manifest as any;
  const entries = [
    plugin.contract?.entries?.workbench,
    plugin.contract?.entries?.renderer,
    manifest?.zion?.entries?.workbench,
    manifest?.zion?.entries?.renderer,
    manifest?.zion?.entries?.ui,
    manifest?.zion?.main,
    manifest?.main
  ].filter((entry): entry is string => typeof entry === "string");

  return entries.some((entry) => entry.startsWith("blob:"));
}

export function runtimeHostedPluginActivationAllowed(
  plugin: PluginInfo
): boolean {
  const pluginId = String(plugin?.id || "");
  const origin = pluginOrigin(plugin);
  if (origin === "builtin") {
    return !RUNTIME_HOSTED_LOCAL_PLUGIN_IDS.has(pluginId);
  }
  if (
    origin !== "dev"
    && !(origin === "external" && RUNTIME_HOSTED_LOCAL_PLUGIN_IDS.has(pluginId))
  ) {
    return origin === "external" && isBrowserInstalledZipPlugin(plugin);
  }
  const path = String(plugin?.path || "");
  try {
    const url = new URL(path, globalThis.location?.href);
    const runtimeOrigin = new URL(readWorkbenchRuntimeConfig().baseUrl, globalThis.location?.href).origin;
    return (url.origin === runtimeOrigin || url.origin === globalThis.location?.origin)
      && url.pathname.startsWith("/v1/device-services/plugin-service/");
  } catch {
    return false;
  }
}
