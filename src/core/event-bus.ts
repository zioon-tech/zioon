import type { Disposable } from "../types/zion";

export class EventBus {
  private map = new Map<string, Set<(payload: any) => void>>();

  emit(topic: string, payload?: any) {
    const set = this.map.get(topic);
    if (!set) return;
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (e) {
        console.error("[events] handler error for", topic, e);
      }
    }
  }

  on(topic: string, handler: (payload: any) => void): Disposable {
    let set = this.map.get(topic);
    if (!set) {
      set = new Set();
      this.map.set(topic, set);
    }
    set.add(handler);
    return { dispose: () => set!.delete(handler) };
  }
}