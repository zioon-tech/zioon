import type { Disposable } from "../types/zion";

export class StateBus {
  private store = new Map<string, { value: any; version: number }>();
  private listeners = new Map<string, Set<(nv: any, ov: any) => void>>();

  get<T = unknown>(key: string): T | undefined {
    return this.store.get(key)?.value;
  }

  set<T = unknown>(key: string, value: T): void {
    const old = this.store.get(key)?.value;
    this.store.set(key, { value, version: Date.now() });
    this.notify(key, value, old);
  }

  update<T = unknown>(key: string, updater: (oldVal: T | undefined) => T): void {
    const oldVal = this.get<T>(key);
    const newVal = updater(oldVal);
    this.set(key, newVal);
  }

  onDidChange<T = unknown>(key: string, handler: (nv: T | undefined, ov: T | undefined) => void): Disposable {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(handler as any);
    return { dispose: () => set!.delete(handler as any) };
  }

  private notify(key: string, newVal: any, oldVal: any) {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(newVal, oldVal);
      } catch (e) {
        console.error("[state] onDidChange error for", key, e);
      }
    }
  }
}