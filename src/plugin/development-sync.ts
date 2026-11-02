import {
  createPluginDevelopmentClient,
  developmentBaseUrl,
  developmentBuildBaseUrl,
  watchDevelopmentSource
} from '../../packages/runtime-client/src/plugin-development.mjs';
import type { PluginManager } from './manager';
import type { HttpPluginInstaller } from './http-installer';
import { withPluginSync } from './sync-lock';

type Source = { pluginId: string; name: string; version: string; nodeId: string; devId: string; directory: string;
  build?: { digest: string; generation: number; hasWorkbench?: boolean } };

/** Account registration is authoritative; source availability is transient. */
export function syncDevelopmentPlugins({
  manager, installer, baseUrl, intervalMs = 5000, onStatus = () => {}, onEntries = () => {}
}: {
  manager: PluginManager;
  installer: HttpPluginInstaller;
  baseUrl: string;
  intervalMs?: number;
  onStatus?: (pluginId: string, status: string, error?: unknown) => void;
  onEntries?: (records: Source[]) => void;
}) {
  const cancellation = new AbortController();
  const client = createPluginDevelopmentClient({ baseUrl, signal: cancellation.signal, credentials: "include" });
  const sources = new Map<string, { record: Source; watcher: { dispose(): void } }>();
  let disposed = false, busy = false, timer: ReturnType<typeof setTimeout>, revision = -1, operations = Promise.resolve();
  const serialize = (action: () => Promise<void>) => {
    const pending = operations.then(() => withPluginSync(manager, action));
    operations = pending.catch(() => {});
    return pending;
  };
  const remove = async (pluginId: string) => {
    const source = sources.get(pluginId);
    if (!source) return;
    source.watcher.dispose();
    sources.delete(pluginId);
    await serialize(async () => {
      // Never remove an independently installed package that replaced a dev UI.
      if (manager.get(pluginId)?.origin === 'dev') {
        await manager.uninstall(pluginId);
        installer.removeFromCache(pluginId);
      }
    });
    onStatus(pluginId, 'unregistered');
  };
  const refresh = async () => {
    if (disposed || busy) return;
    busy = true;
    try {
      const snapshot = await client.snapshot();
      if (disposed) return;
      if (snapshot.revision !== revision) {
        onEntries(snapshot.entries);
        const desired = new Map<string, Source>(snapshot.entries
          .filter((record: Source) => record.build?.hasWorkbench !== false)
          .map((record: Source) => [record.pluginId, record]));
        for (const [pluginId, active] of sources) {
          const next = desired.get(pluginId);
          if (!next) await remove(pluginId);
          else if (next.nodeId !== active.record.nodeId || next.devId !== active.record.devId
            || next.directory !== active.record.directory || next.build?.digest !== active.record.build?.digest) {
            // Keep the last active UI until its replacement has loaded.
            active.watcher.dispose();
            sources.delete(pluginId);
          }
        }
        for (const record of desired.values()) {
          if (disposed || sources.has(record.pluginId)) continue;
          const sourceUrl = record.build
            ? developmentBuildBaseUrl(baseUrl, record.pluginId, record.build.digest)
            : developmentBaseUrl(baseUrl, record.devId, record.nodeId);
          const active = {
            record,
            watcher: null as unknown as { dispose(): void }
          };
          sources.set(record.pluginId, active);
          onStatus(record.pluginId, 'connecting');
          active.watcher = watchDevelopmentSource({
            baseUrl: sourceUrl, loadInitially: true, credentials: "include",
            isVisible: () => !document.hidden,
            onStatus: (status: string, error: unknown) => onStatus(record.pluginId, status, error),
            onChange: (signal: AbortSignal) => serialize(async () => {
              if (disposed || signal.aborted || sources.get(record.pluginId) !== active) return;
              const result = await installer.installFromDevBase(sourceUrl, record.devId, {
                sourceDir: record.directory, sourceNodeId: record.nodeId, signal
              });
              let adopted = false;
              try {
              if (disposed || signal.aborted || sources.get(record.pluginId) !== active) return;
              if (!result.success || !result.plugin) throw new Error(result.error?.message || 'Development UI load failed');
              if (result.plugin.id !== record.pluginId) throw new Error('Development manifest ID changed; register it again with the CLI');
              await manager.hotReloadFromInfo(result.plugin, {
                enabled: manager.getEnabledPreference(record.pluginId) ?? true, skipNotification: true
              });
              adopted = true;
              } finally { if (result.plugin && !adopted) installer.releasePlugin(result.plugin); }
            })
          });
        }
        revision = snapshot.revision;
      }
    } catch (error) {
      if (!disposed) onStatus('', 'registry-unavailable', error);
    } finally {
      busy = false;
      if (!disposed) timer = setTimeout(() => void refresh(), intervalMs);
    }
  };
  const onResume = () => {
    if (!disposed && !document.hidden) {
      clearTimeout(timer);
      // The registry poll uses one sequential loop; resumption schedules the
      // next poll rather than starting a concurrent request.
      timer = setTimeout(() => void refresh(), 0);
    }
  };
  document.addEventListener('visibilitychange', onResume);
  window.addEventListener('online', onResume);
  void refresh();
  return {
    dispose() {
      disposed = true;
      clearTimeout(timer);
      cancellation.abort();
      for (const source of sources.values()) source.watcher.dispose();
      sources.clear();
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('online', onResume);
    }
  };
}
