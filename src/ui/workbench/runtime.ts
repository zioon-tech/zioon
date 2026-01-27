export type Disposable = { dispose(): void };

export type ActivityBarItem = {
  id: string;
  pluginId: string;
  icon: string;
  tooltip?: string;
  order?: number;
  when?: string;
  sideBarViewId?: string;
  auxiliaryBarViewId?: string;
  bottomPanelViewId?: string;
  onClick?: () => void;
};

export type SideBarViewComponent = {
  render: (container: HTMLElement) => { dispose?: () => void } | void;
};

export type SideBarView = {
  id: string;
  pluginId: string;
  title: string;
  icon?: string;
  order?: number;
  when?: string;
  canClose?: boolean;
  headerActions?: Array<{ id: string; title: string; ariaLabel?: string; icon?: string; onClick: () => void }>;
  component: SideBarViewComponent;
  onActivate?: () => void | Promise<void>;
  onDeactivate?: () => void | Promise<void>;
  onResize?: (size: { width: number; height: number }) => void;
  onDispose?: () => void;
};

type StateLike = {
  get: <T = unknown>(key: string) => T | undefined;
  set: <T = unknown>(key: string, value: T) => void;
  update: <T = unknown>(key: string, updater: (oldVal: T | undefined) => T) => void;
  onDidChange: <T = unknown>(
    key: string,
    handler: (newVal: T | undefined, oldVal: T | undefined) => void
  ) => Disposable;
};

type EventsLike = {
  emit: (topic: string, payload?: any) => void;
  on: (topic: string, handler: (payload: any) => void) => Disposable;
};

let core: { state: StateLike; events: EventsLike } | null = null;

export function bindWorkbenchCore(input: { state: StateLike; events: EventsLike }) {
  core = input;
}

function evalWhen(expr?: string): boolean {
  const s = (expr ?? "").trim().toLowerCase();
  if (!s) return true;
  if (s === "true") return true;
  if (s === "false") return false;
  return true;
}

class ChangeEmitter {
  private listeners = new Set<() => void>();

  onDidChange(fn: () => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  emit() {
    for (const fn of Array.from(this.listeners)) {
      try {
        fn();
      } catch {}
    }
  }
}

class ActivityBarRuntime {
  private items = new Map<string, ActivityBarItem>();
  private emitter = new ChangeEmitter();

  onDidChange(fn: () => void): Disposable {
    return this.emitter.onDidChange(fn);
  }

  registerItem(item: ActivityBarItem): Disposable {
    this.items.set(item.id, item);
    this.emitter.emit();
    return {
      dispose: () => {
        this.items.delete(item.id);
        this.emitter.emit();
      }
    };
  }

  getItems(): ActivityBarItem[] {
    const arr = Array.from(this.items.values()).filter(it => evalWhen(it.when));
    arr.sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.id.localeCompare(b.id));
    return arr;
  }

  show() {
    core?.state.set("ui.activityBar.visible", true);
    this.emitter.emit();
  }

  hide() {
    core?.state.set("ui.activityBar.visible", false);
    this.emitter.emit();
  }

  toggle(): boolean {
    const cur = !!core?.state.get<boolean>("ui.activityBar.visible");
    const next = !cur;
    core?.state.set("ui.activityBar.visible", next);
    this.emitter.emit();
    return next;
  }

  activateItem(id: string): void {
    const it = this.items.get(id);
    if (!it) return;

    const prevActive = this.getActiveItemId();
    const sideVisible = sideBarRuntime.isVisible();
    const activeViewId = sideBarRuntime.getActiveViewId();

    if (it.sideBarViewId && prevActive === id && sideVisible && activeViewId === it.sideBarViewId) {
      sideBarRuntime.hide();
      this.emitter.emit();
      return;
    }

    core?.state.set("ui.activityBar.activeItemId", id);
    if (typeof it.onClick === "function") {
      try {
        it.onClick();
      } catch {}
    }
    if (it.sideBarViewId) {
      sideBarRuntime.show();
      sideBarRuntime.activateView(it.sideBarViewId);
    }
    this.emitter.emit();
  }

  syncActiveBySideBarViewId(viewId: string) {
    const match = Array.from(this.items.values())
      .filter(it => it.sideBarViewId === viewId)
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.id.localeCompare(b.id))[0];
    if (match) {
      core?.state.set("ui.activityBar.activeItemId", match.id);
      this.emitter.emit();
    }
  }

  getActiveItemId(): string | null {
    return (core?.state.get<string>("ui.activityBar.activeItemId") ?? null) as any;
  }

  isVisible(): boolean {
    const v = core?.state.get<boolean>("ui.activityBar.visible");
    return v == null ? true : !!v;
  }
}

class SideBarRuntime {
  private views = new Map<string, SideBarView>();
  private emitter = new ChangeEmitter();

  onDidChange(fn: () => void): Disposable {
    return this.emitter.onDidChange(fn);
  }

  registerView(view: SideBarView): Disposable {
    this.views.set(view.id, view);
    if (!this.getActiveViewId()) {
      core?.state.set("ui.sideBar.activeViewId", view.id);
    }
    this.emitter.emit();
    return {
      dispose: () => {
        try {
          view.onDispose?.();
        } catch {}
        this.views.delete(view.id);
        if (this.getActiveViewId() === view.id) {
          const next = this.getViews()[0]?.id ?? null;
          core?.state.set("ui.sideBar.activeViewId", next as any);
        }
        this.emitter.emit();
      }
    };
  }

  getViews(): SideBarView[] {
    const arr = Array.from(this.views.values()).filter(v => evalWhen(v.when));
    arr.sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.id.localeCompare(b.id));
    return arr;
  }

  getView(id: string): SideBarView | null {
    return this.views.get(id) || null;
  }

  getActiveViewId(): string | null {
    return (core?.state.get<string>("ui.sideBar.activeViewId") ?? null) as any;
  }

  activateView(id: string): void {
    if (!this.views.has(id)) return;
    core?.state.set("ui.sideBar.activeViewId", id);
    core?.events.emit("ui/sideBarActiveViewChanged", { id });
    activityBarRuntime.syncActiveBySideBarViewId(id);
    this.emitter.emit();
  }

  show(): void {
    core?.state.set("ui.sideBar.visible", true);
    this.emitter.emit();
  }

  hide(): void {
    core?.state.set("ui.sideBar.visible", false);
    this.emitter.emit();
  }

  toggle(): boolean {
    const cur = !!core?.state.get<boolean>("ui.sideBar.visible");
    const next = !cur;
    core?.state.set("ui.sideBar.visible", next);
    this.emitter.emit();
    return next;
  }

  isVisible(): boolean {
    const v = core?.state.get<boolean>("ui.sideBar.visible");
    return v == null ? true : !!v;
  }

  getShowTabs(): boolean {
    const v = core?.state.get<boolean>("ui.sideBar.showTabs");
    return v == null ? false : !!v;
  }

  setShowTabs(enabled: boolean): void {
    core?.state.set("ui.sideBar.showTabs", !!enabled);
    this.emitter.emit();
  }

  setWidth(px: number): void {
    const w = Math.max(180, Math.min(420, Math.round(px)));
    core?.state.set("ui.sideBar.width", w);
    this.emitter.emit();
  }

  getWidth(): number {
    const v = core?.state.get<number>("ui.sideBar.width");
    return typeof v === "number" && isFinite(v) ? v : 240;
  }
}

export const activityBarRuntime = new ActivityBarRuntime();
export const sideBarRuntime = new SideBarRuntime();
