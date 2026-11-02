import type { PluginManager } from './manager';

const pending = new WeakMap<PluginManager, Promise<unknown>>();

/** Account and development synchronization share one identity mutation gate. */
export function withPluginSync<T>(manager: PluginManager, action: () => Promise<T>): Promise<T> {
  const next = (pending.get(manager) || Promise.resolve()).catch(() => {}).then(action);
  pending.set(manager, next);
  return next.finally(() => {
    if (pending.get(manager) === next) pending.delete(manager);
  });
}
