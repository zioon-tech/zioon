import { createExtensionsClient } from '../../packages/runtime-client/src/extensions.mjs';
import type { PluginManager } from './manager';
import type { HttpPluginInstaller } from './http-installer';
import { withPluginSync } from './sync-lock';

/** A private static release is readable without starting its execution Host. */
export function syncAccountPlugins({ manager, installer, baseUrl, intervalMs = 5000,
  onStatus = () => {} }: {
  manager: PluginManager; installer: HttpPluginInstaller; baseUrl: string; intervalMs?: number;
  onStatus?: (pluginId: string, status: string, error?: unknown) => void;
}) {
  const cancellation = new AbortController();
  const client = createExtensionsClient({ baseUrl, signal: cancellation.signal, credentials: 'include' });
  let disposed = false, busy = false, timer: ReturnType<typeof setTimeout>;
  const remove = async (id: string) => {
    await withPluginSync(manager, async () => {
      if (manager.get(id)?.origin === 'account') {
        await manager.uninstall(id);
        installer.removeFromCache(id);
      }
    });
  };
  const refresh = async () => {
    if (disposed || busy) return;
    clearTimeout(timer);
    busy = true;
    try {
      const snapshot = await client.snapshot();
      if (disposed) return;
      const desired = new Map<string, any>();
      for (const entry of snapshot.entries) {
        const release = entry.installedRelease;
        const id = release?.artifact?.plugin?.id;
        if (entry.installation && !release.development && id && ['published', 'private'].includes(release.status)
          && release.artifact.plugin.entries.workbench) {
          if (desired.has(id)) throw new Error(`Installed UI identity conflict: ${id}`);
          desired.set(id, entry);
        }
      }
      for (const plugin of manager.list()) {
        if (plugin.origin === 'account' && (!desired.has(plugin.id)
          || plugin.accountInstallation?.accountId !== snapshot.accountId)) await remove(plugin.id);
      }
      for (const [id, entry] of desired) {
        if (disposed) return;
        const install = entry.installation;
        const contentDigest = install.activeRevision?.digest || install.digest;
        const current = manager.get(id);
        if (current && current.origin !== 'account') {
          onStatus(id, 'identity-conflict');
          continue;
        }
        if (!install.enabled) {
          await withPluginSync(manager, async () => {
            const local = manager.get(id);
            if (local?.origin !== 'account') return;
            if (local.accountInstallation?.digest !== contentDigest) await manager.uninstall(id);
            else if (local.enabled) await manager.disable(id);
          });
          onStatus(id, 'disabled');
          continue;
        }
        if (current?.accountInstallation?.digest === contentDigest && current.state === 'active') {
          current.accountInstallation.epoch = install.executionEpoch;
          continue;
        }
        let fetched: any, adopted = false;
        try {
          const source = `${baseUrl.replace(/\/+$/, '')}/v1/marketplace/${install.activeRevision
            ? `installations/${encodeURIComponent(entry.id)}/revisions/${contentDigest}`
            : `releases/${encodeURIComponent(entry.id)}/${encodeURIComponent(install.version)}`}/files`;
          const loaded = await installer.installFromDevBase(source, '', { signal: cancellation.signal,
            accountInstallation: { accountId: snapshot.accountId, listingId: entry.id,
              digest: contentDigest, epoch: install.executionEpoch } });
          fetched = loaded.plugin;
          if (disposed) return;
          if (!loaded.success || !loaded.plugin || loaded.plugin.id !== id) throw new Error(loaded.error?.message || 'Installed UI load failed');
          const latest = await client.snapshot();
          const confirmed = latest.entries.find((candidate: any) => candidate.id === entry.id)?.installation;
          if (disposed || latest.accountId !== snapshot.accountId || !confirmed?.enabled
            || (confirmed.activeRevision?.digest || confirmed.digest) !== contentDigest
            || confirmed.executionEpoch !== install.executionEpoch) continue;
          // Loading succeeds before replacing the currently active module.
          await withPluginSync(manager, async () => {
            if (disposed) return;
            const local = manager.get(id);
            if (local && local.origin !== 'account') { onStatus(id, 'identity-conflict'); return; }
            const installed = await manager.installFromInfo(loaded.plugin!, { enabled: true });
            installed.accountInstallation = loaded.plugin!.accountInstallation;
            adopted = true;
            onStatus(id, manager.get(id)?.state === 'active' ? 'active' : 'activation-failed');
          });
        } catch (error) { onStatus(id, 'load-error', error); }
        finally { if (fetched && !adopted) installer.releasePlugin(fetched); }
      }
    } catch (error: any) {
      if (!disposed) {
        if ([401, 403].includes(error.statusCode)) {
          for (const plugin of manager.list()) if (plugin.origin === 'account') await remove(plugin.id);
        }
        onStatus('', 'registry-unavailable', error);
      }
    } finally {
      busy = false;
      if (!disposed) timer = setTimeout(() => void refresh(), intervalMs);
    }
  };
  const onResume = () => {
    if (!disposed && !document.hidden) void refresh();
  };
  document.addEventListener('visibilitychange', onResume);
  window.addEventListener('online', onResume);
  void refresh();
  return { refresh, dispose() {
    disposed = true; clearTimeout(timer); cancellation.abort();
    document.removeEventListener('visibilitychange', onResume);
    window.removeEventListener('online', onResume);
  } };
}
