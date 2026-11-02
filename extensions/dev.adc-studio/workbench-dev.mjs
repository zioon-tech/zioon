import { activate as activateStudio } from "./workbench.mjs";
import styles from "./styles.css?raw";
import { watchDevelopmentSource } from "../../packages/runtime-client/src/plugin-development.mjs";

export async function activate(context) {
  const element = document.createElement("style");
  element.textContent = styles; document.head.append(element);
  context.subscriptions.push({ dispose() { element.remove(); } });
  const result = await activateStudio(context, { existingAdc: true });
  // Current Workbenches own discovery and hot reload for all development
  // plugins. Keep a shared compatibility watcher only for older ZIP hosts.
  if (window.zion?.pluginDevelopment) return result;
  const entry = new URL(ADC_STUDIO_DEV_ENTRY);
  entry.pathname = entry.pathname.replace(/\/main\.js$/, "");
  context.subscriptions.push(watchDevelopmentSource({
    baseUrl: entry.href, credentials: "include", intervalMs: 5000,
    isVisible: () => !document.hidden,
    async onChange(signal) {
      const manager = window.zion?.plugins, info = manager?.get?.("dev.adc-studio");
      if (!info || signal.aborted) return;
      const moduleUrl = new URL(ADC_STUDIO_DEV_ENTRY);
      moduleUrl.searchParams.set("zionDevTs", String(Date.now()));
      await manager.hotReloadFromInfo({
        ...info, path: entry.href, origin: "dev",
        sourceEntries: undefined, scriptStorageKey: undefined, scriptContents: undefined, scriptBlobUrls: undefined,
        manifest: { ...info.manifest, zion: { ...info.manifest.zion, main: moduleUrl.href } },
        contract: { ...info.contract, entries: { ...info.contract.entries, workbench: moduleUrl.href } }
      }, { enabled: true, skipNotification: true });
    }
  }));
  return result;
}
