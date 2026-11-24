type Disposable = { dispose(): void };

type EventsLike = {
  emit(topic: string, payload?: any): void;
  on?(topic: string, fn: (payload?: any) => void): Disposable;
};

export type ChatCardType = {
  kind: string;
  annotationKey: string;
  pendingKind?: string;
  restoreEvent: string;
  clearEvent: string;
  snapshotEvent?: string;
};

export type ChatCardRuntimeOptions = {
  events: EventsLike;
  getAnnotations(sessionId: string | null | undefined): Record<string, any>;
  setPendingRestore(sessionId: string | null | undefined, kind: string, items: any[] | null | undefined): any[] | null;
};

export type RestoreChatCardsOptions = {
  sessionId: string | null | undefined;
  panelId?: string | null;
  annotations?: Record<string, any> | null;
  clearFirst?: boolean;
  defer?: boolean;
};

export type SnapshotChatCardsOptions = {
  sessionId: string | null | undefined;
  panelId?: string | null;
};

export type AttachSessionLifecycleOptions = {
  snapshotBeforeSwitch?: boolean;
};

function debugChatCardRuntime(_event: string, _payload?: any): void {
}

export class CardTypeRegistry {
  private readonly types = new Map<string, ChatCardType>();

  register(type: ChatCardType): Disposable {
    if (!type?.kind || !type.annotationKey || !type.restoreEvent || !type.clearEvent) {
      throw new Error("Invalid chat card type registration");
    }
    const normalized: ChatCardType = {
      ...type,
      pendingKind: type.pendingKind || type.kind
    };
    this.types.set(normalized.kind, normalized);
    return {
      dispose: () => {
        if (this.types.get(normalized.kind) === normalized) {
          this.types.delete(normalized.kind);
        }
      }
    };
  }

  get(kind: string): ChatCardType | null {
    return this.types.get(kind) || null;
  }

  list(): ChatCardType[] {
    return Array.from(this.types.values());
  }
}

export class ChatCardRuntime {
  readonly registry = new CardTypeRegistry();
  private readonly deferredRestoreVersions = new Map<string, number>();
  private readonly restoring = new Map<string, (success: boolean) => void>();

  constructor(private readonly opts: ChatCardRuntimeOptions) {}

  registerType(type: ChatCardType): Disposable {
    return this.registry.register(type);
  }

  attachSessionLifecycle(attachOpts: AttachSessionLifecycleOptions = {}): Disposable {
    const snapshotBeforeSwitch = attachOpts.snapshotBeforeSwitch !== false;
    const on = this.opts.events.on;
    if (typeof on !== "function") return { dispose() {} };
    const disposables: Disposable[] = [];

    if (snapshotBeforeSwitch) {
      disposables.push(on.call(this.opts.events, "session/beforeSwitch", (payload: any) => {
        const panelId = payload?.panelId ?? null;
        const previousSessionId = payload?.previousSessionId ?? null;
        const nextSessionId = payload?.sessionId ?? null;
        if (!previousSessionId || previousSessionId === nextSessionId) return;
        debugChatCardRuntime("lifecycle.beforeSwitch.snapshot", { panelId, previousSessionId, nextSessionId });
        this.snapshotSession({ panelId, sessionId: previousSessionId });
      }));
    }

    return {
      dispose() {
        for (const disp of disposables) {
          try { disp?.dispose?.(); } catch {}
        }
      }
    };
  }

  restoreSession(restoreOpts: RestoreChatCardsOptions) {
    const sessionId = restoreOpts?.sessionId;
    if (!sessionId) return { annotations: null, restored: {} as Record<string, any[]>, completion: Promise.resolve(false) };
    const panelId = restoreOpts?.panelId ?? null;
    const deferKey = String(panelId || "global");
    this.restoring.get(deferKey)?.(false);
    let complete!: (success: boolean) => void;
    const completion = new Promise<boolean>(resolve => { complete = resolve; });
    this.restoring.set(deferKey, complete);
    const finish = () => {
      if (this.restoring.get(deferKey) !== complete) return;
      this.restoring.delete(deferKey);
      complete(true);
    };
    const deferVersion = (this.deferredRestoreVersions.get(deferKey) || 0) + 1;
    this.deferredRestoreVersions.set(deferKey, deferVersion);
    const annotations = restoreOpts?.annotations || this.opts.getAnnotations(sessionId) || {};
    const restored: Record<string, any[]> = {};
    const types = this.registry.list();

    for (const type of types) {
      const items = Array.isArray(annotations[type.annotationKey]) ? annotations[type.annotationKey] : [];
      restored[type.kind] = items;
      if (restoreOpts?.clearFirst !== false) {
        try { this.opts.events.emit(type.clearEvent, { panelId, sessionId }); } catch {}
      }
      this.opts.setPendingRestore(sessionId, type.pendingKind || type.kind, items.length ? items : null);
    }

    debugChatCardRuntime("restoreSession.preEmit", {
      sessionId,
      panelId,
      clearFirst: restoreOpts?.clearFirst !== false,
      restored: Object.fromEntries(Object.entries(restored).map(([key, items]) => [key, Array.isArray(items) ? items.length : 0]))
    });

    const emitRestore = (type: ChatCardType) => {
      const items = restored[type.kind] || [];
      if (items.length) {
        debugChatCardRuntime("restoreSession.emit", {
          sessionId,
          panelId,
          kind: type.kind,
          event: type.restoreEvent,
          count: items.length,
          ids: items.map((it: any) => it?.id).filter(Boolean).map(String)
        });
        try { this.opts.events.emit(type.restoreEvent, { items, panelId, sessionId }); } catch {}
      }
    };
    if (restoreOpts?.defer && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        setTimeout(() => {
          const restoreNext = (index: number) => {
            if (this.deferredRestoreVersions.get(deferKey) !== deferVersion) return;
            if (index >= types.length) { finish(); return; }
            const run = () => {
              if (this.deferredRestoreVersions.get(deferKey) !== deferVersion) return;
              emitRestore(types[index]);
              restoreNext(index + 1);
            };
            // Restore visible history after the text's first paint. Separate
            // card types into tasks so input can run between their updates.
            setTimeout(run, 0);
          };
          restoreNext(0);
        }, 0);
      });
    } else {
      for (const type of types) emitRestore(type);
      finish();
    }

    return { annotations, restored, completion };
  }

  snapshotSession(snapshotOpts: SnapshotChatCardsOptions) {
    const sessionId = snapshotOpts?.sessionId;
    if (!sessionId) return { snapshotted: [] as string[] };
    const panelId = snapshotOpts?.panelId ?? null;
    const snapshotted: string[] = [];
    for (const type of this.registry.list()) {
      if (!type.snapshotEvent) continue;
      try {
        debugChatCardRuntime("snapshotSession.emit", {
          sessionId,
          panelId,
          kind: type.kind,
          event: type.snapshotEvent
        });
        this.opts.events.emit(type.snapshotEvent, { panelId, sessionId });
        snapshotted.push(type.kind);
      } catch {}
    }
    return { snapshotted };
  }

  clearSession(snapshotOpts: SnapshotChatCardsOptions) {
    const sessionId = snapshotOpts?.sessionId;
    if (!sessionId) return { cleared: [] as string[] };
    const panelId = snapshotOpts?.panelId ?? null;
    const cleared: string[] = [];
    for (const type of this.registry.list()) {
      try {
        this.opts.events.emit(type.clearEvent, { panelId, sessionId });
        this.opts.setPendingRestore(sessionId, type.pendingKind || type.kind, null);
        cleared.push(type.kind);
      } catch {}
    }
    return { cleared };
  }
}
