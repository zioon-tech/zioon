export type Disposable = { dispose(): void };

export type ActivityBarItem = {
  id: string;
  pluginId: string;
  icon: string;
  tooltip?: string;
  tooltipKey?: string;
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
  titleKey?: string;
  icon?: string;
  order?: number;
  when?: string;
  canClose?: boolean;
  headerActions?: Array<{ id: string; title: string; titleKey?: string; ariaLabel?: string; ariaLabelKey?: string; icon?: string; text?: string; textKey?: string; active?: boolean | (() => boolean); onClick: () => void }>;
  component: SideBarViewComponent;
  onActivate?: () => void | Promise<void>;
  onDeactivate?: () => void | Promise<void>;
  onResize?: (size: { width: number; height: number }) => void;
  onDispose?: () => void;
};

export type BottomPanelViewComponent = {
  render: (container: HTMLElement) => { dispose?: () => void } | void;
};

export type BottomPanelView = {
  id: string;
  pluginId: string;
  title: string;
  titleKey?: string;
  icon?: string;
  order?: number;
  when?: string;
  keepWhenActive?: boolean;
  maximizable?: boolean;
  headerActions?: Array<{ id: string; title: string; titleKey?: string; ariaLabel?: string; ariaLabelKey?: string; icon?: string; onClick: () => void }>;
  component: BottomPanelViewComponent;
  onActivate?: () => void | Promise<void>;
  onDeactivate?: () => void | Promise<void>;
  onResize?: (size: { width: number; height: number }) => void;
  onDispose?: () => void;
};

export type AuxiliaryBarViewComponent = {
  render: (container: HTMLElement) => { dispose?: () => void } | void;
};

export type AuxiliaryBarView = {
  id: string;
  pluginId: string;
  title: string;
  titleKey?: string;
  icon?: string;
  order?: number;
  when?: string;
  canClose?: boolean;
  keepWhenActive?: boolean;
  headerActions?: Array<{ id: string; title: string; titleKey?: string; ariaLabel?: string; ariaLabelKey?: string; icon?: string; onClick: () => void }>;
  component: AuxiliaryBarViewComponent;
  onActivate?: () => void | Promise<void>;
  onDeactivate?: () => void | Promise<void>;
  onResize?: (size: { width: number; height: number }) => void;
  onDispose?: () => void;
};

export type InspectorFile = {
  kind?: "loading" | "error" | "text" | "image" | "pdf" | "binary";
  content?: string;
  blob?: Blob;
  message?: string;
  size?: number;
  truncated?: boolean;
  loadedBytes?: number;
  previewContent?: string;
  loadFullContent?: () => Promise<string>;
};

export type InspectorItem = {
  id: string;
  ownerId?: string;
  title: string;
  path?: string;
  displayPath?: string;
  url?: string;
  language?: string;
  file?: InspectorFile;
  editable?: boolean;
  onSave?: (content: string) => void | Promise<void>;
  actions?: Array<{
    id: string;
    title: string;
    icon?: string;
    run: (item: InspectorItem) => void | Promise<void>;
  }>;
  render?: (
    container: HTMLElement,
    context: {
      item: InspectorItem;
      update: (patch: Partial<InspectorItem>) => boolean;
      close: () => void;
      openInEditor: () => void;
    }
  ) => void | { dispose?: () => void };
};

export type InspectorRenderer = {
  id: string;
  priority?: number;
  canRender: (item: InspectorItem) => boolean;
  render: NonNullable<InspectorItem["render"]>;
};

export type InspectorTextEditorDecorator = {
  id: string;
  priority?: number;
  createExtension: (editor: any, item: InspectorItem) => any;
};

export function getInspectorTextSessionId(item: Pick<InspectorItem, "id" | "ownerId" | "path" | "displayPath">): string {
  const owner = encodeURIComponent(String(item?.ownerId || "core"));
  const source = encodeURIComponent(String(item?.path || item?.displayPath || item?.id || "untitled"));
  return `inspector-file:${owner}:${source}`;
}

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
  try {
    responsiveRuntime.start();
  } catch {}
}

function evalWhen(expr?: string): boolean {
  const s = (expr ?? "").trim().toLowerCase();
  if (!s) return true;
  if (s === "true") return true;
  if (s === "false") return false;
  return true;
}

function readViewOrder(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map((item) => String(item || "")).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeViewOrder(key: string, ids: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids.map((id) => String(id || "")).filter(Boolean)));
  } catch {}
}

function sortViewsWithCustomOrder<T extends { id: string; order?: number }>(views: T[], storageKey: string): T[] {
  const defaults = [...views].sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.id.localeCompare(b.id));
  const custom = readViewOrder(storageKey);
  if (!custom.length) return defaults;
  const byId = new Map(defaults.map((view) => [view.id, view]));
  const used = new Set<string>();
  const ordered: T[] = [];
  for (const id of custom) {
    const view = byId.get(id);
    if (!view || used.has(id)) continue;
    ordered.push(view);
    used.add(id);
  }
  for (const view of defaults) {
    if (!used.has(view.id)) ordered.push(view);
  }
  return ordered;
}

type FocusSnapshot =
  | { kind: "element"; el: HTMLElement }
  | { kind: "editor"; cursor: any | null }
  | null;

function captureFocusSnapshot(): FocusSnapshot {
  try {
    const el = document.activeElement;
    const ed = (window as any)?.zion?.window?.activeEditor;
    const elInEditor = (() => {
      try {
        if (!el || !(el instanceof HTMLElement)) return false;
        return !!el.closest?.(".cm-editor, .zion-editor");
      } catch {
        return false;
      }
    })();

    if (ed && (elInEditor || !el || el === document.body || el === document.documentElement)) {
      let cursor: any = null;
      try {
        cursor = ed.getCursor?.();
      } catch {}
      return { kind: "editor", cursor };
    }

    if (el && el instanceof HTMLElement) return { kind: "element", el };
    if (ed) return { kind: "editor", cursor: null };
    return null;
  } catch {
    return null;
  }
}

function restoreFocusSnapshot(snap: FocusSnapshot): void {
  if (!snap) return;
  if (snap.kind === "editor") {
    try {
      const ed = (window as any)?.zion?.window?.activeEditor;
      if (!ed) return;
      if (snap.cursor && ed.setCursor) {
        try {
          ed.setCursor(snap.cursor);
        } catch {}
      }
      ed.focus?.();
    } catch {}
    return;
  }
  if (snap.kind === "element") {
    try {
      const el = snap.el;
      if (el && (el as any).isConnected) {
        if (!el.hasAttribute("tabindex") && (el as any).tabIndex == null) {
          try {
            el.setAttribute("tabindex", "-1");
          } catch {}
        }
        el.focus?.();
        if (document.activeElement === el) return;
      }
    } catch {}
    try {
      (window as any)?.zion?.window?.activeEditor?.focus?.();
    } catch {}
  }
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

class PayloadEmitter<T> {
  private listeners = new Set<(payload: T) => void>();

  on(fn: (payload: T) => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  emit(payload: T) {
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(payload);
      } catch {}
    }
  }
}

export type ResponsiveDeviceType = "mobile" | "tablet" | "desktop" | "largedesktop";
export type ResponsiveMode = "compact" | "medium" | "full" | "split";

export const RESPONSIVE_BREAKPOINTS = {
  mobile: 768,
  tablet: 1024,
  largeDesktop: 1440
} as const;

class ResponsiveRuntime {
  private started = false;
  private deviceEmitter = new PayloadEmitter<ResponsiveDeviceType>();
  private modeEmitter = new PayloadEmitter<ResponsiveMode>();

  start() {
    if (this.started) return;
    this.started = true;
    try {
      window.addEventListener("resize", this.onResize, { passive: true });
    } catch {}
    this.updateFromViewport({ applyPolicy: true });
  }

  getCurrentDeviceType(): ResponsiveDeviceType {
    const v = core?.state.get<ResponsiveDeviceType>("ui.responsive.deviceType");
    if (v === "mobile" || v === "tablet" || v === "desktop" || v === "largedesktop") return v;
    return this.computeDeviceType(this.getScreenWidth());
  }

  getCurrentMode(): ResponsiveMode {
    const v = core?.state.get<ResponsiveMode>("ui.responsive.mode");
    if (v === "compact" || v === "medium" || v === "full" || v === "split") return v;
    return this.computeMode(this.getCurrentDeviceType());
  }

  getScreenWidth(): number {
    try {
      const w = window.innerWidth;
      return typeof w === "number" && isFinite(w) ? w : 0;
    } catch {
      return 0;
    }
  }

  getScreenHeight(): number {
    try {
      const h = window.innerHeight;
      return typeof h === "number" && isFinite(h) ? h : 0;
    } catch {
      return 0;
    }
  }

  isMobile(): boolean {
    return this.getCurrentDeviceType() === "mobile";
  }

  isTablet(): boolean {
    return this.getCurrentDeviceType() === "tablet";
  }

  isDesktop(): boolean {
    const t = this.getCurrentDeviceType();
    return t === "desktop" || t === "largedesktop";
  }

  onDidChangeDeviceType(fn: (deviceType: ResponsiveDeviceType) => void): Disposable {
    return this.deviceEmitter.on(fn);
  }

  onDidChangeMode(fn: (mode: ResponsiveMode) => void): Disposable {
    return this.modeEmitter.on(fn);
  }

  setMode(mode: ResponsiveMode): void {
    if (mode !== "compact" && mode !== "medium" && mode !== "full" && mode !== "split") return;
    core?.state.set("ui.responsive.modeOverride", mode);
    this.updateFromViewport({ applyPolicy: true });
  }

  private onResize = () => {
    this.updateFromViewport({ applyPolicy: true });
  };

  private computeDeviceType(width: number): ResponsiveDeviceType {
    const w = typeof width === "number" && isFinite(width) ? width : 0;
    if (w < RESPONSIVE_BREAKPOINTS.mobile) return "mobile";
    if (w < RESPONSIVE_BREAKPOINTS.tablet) return "tablet";
    if (w < RESPONSIVE_BREAKPOINTS.largeDesktop) return "desktop";
    return "largedesktop";
  }

  private computeMode(deviceType: ResponsiveDeviceType): ResponsiveMode {
    switch (deviceType) {
      case "mobile":
        return "compact";
      case "tablet":
        return "medium";
      case "desktop":
        return "full";
      case "largedesktop":
        return "split";
    }
  }

  private updateFromViewport(opts: { applyPolicy: boolean }) {
    const nextDevice = this.computeDeviceType(this.getScreenWidth());
    const override = core?.state.get<ResponsiveMode>("ui.responsive.modeOverride");
    const nextMode =
      override === "compact" || override === "medium" || override === "full" || override === "split"
        ? override
        : this.computeMode(nextDevice);

    const prevDevice = core?.state.get<ResponsiveDeviceType>("ui.responsive.deviceType");
    const prevMode = core?.state.get<ResponsiveMode>("ui.responsive.mode");

    core?.state.set("ui.responsive.deviceType", nextDevice);
    core?.state.set("ui.responsive.mode", nextMode);

    try {
      const de = document.documentElement;
      de.dataset.zionDeviceType = nextDevice;
      de.dataset.zionResponsiveMode = nextMode;
    } catch {}

    if (prevDevice !== nextDevice) {
      this.deviceEmitter.emit(nextDevice);
    }
    if (prevMode !== nextMode) {
      this.modeEmitter.emit(nextMode);
    }

    if (opts.applyPolicy) {
      this.applyLayoutPolicy({ prevDevice, nextDevice, nextMode });
    }
  }

  private applyLayoutPolicy(input: {
    prevDevice: ResponsiveDeviceType | undefined;
    nextDevice: ResponsiveDeviceType;
    nextMode: ResponsiveMode;
  }) {
    if (!core) return;

    const deviceChanged = input.prevDevice !== input.nextDevice;

    if (deviceChanged && input.nextDevice === "mobile") {
      try {
        core.state.set("ui.responsive.snapshot.activityBarVisible", activityBarRuntime.isVisible());
        core.state.set("ui.responsive.snapshot.sideBarVisible", sideBarRuntime.isVisible());
        core.state.set("ui.responsive.snapshot.auxVisible", auxiliaryBarRuntime.isVisible());
        core.state.set("ui.responsive.snapshot.bottomVisible", bottomPanelRuntime.isVisible());
      } catch {}
      try {
        activityBarRuntime.hide();
      } catch {}
      try {
        sideBarRuntime.hide();
      } catch {}
      try {
        auxiliaryBarRuntime.hide();
      } catch {}
      try {
        bottomPanelRuntime.hide();
      } catch {}
      return;
    }

    if (input.prevDevice === "mobile") {
      const prevAux = core.state.get<boolean>("ui.responsive.snapshot.auxVisible");
      const prevBottom = core.state.get<boolean>("ui.responsive.snapshot.bottomVisible");
      if (typeof prevAux === "boolean") {
        try {
          if (prevAux) auxiliaryBarRuntime.show();
          else auxiliaryBarRuntime.hide();
        } catch {}
      }
      if (typeof prevBottom === "boolean") {
        try {
          if (prevBottom) bottomPanelRuntime.show();
          else bottomPanelRuntime.hide();
        } catch {}
      }
    }

    if (deviceChanged) {
      try {
        activityBarRuntime.show();
      } catch {}
      try {
        sideBarRuntime.show();
      } catch {}
    }

    const sideWidthRaw = core.state.get<number>("ui.sideBar.width");
    if (deviceChanged && input.nextMode === "medium") {
      if (!(typeof sideWidthRaw === "number" && isFinite(sideWidthRaw))) {
        try {
          sideBarRuntime.setWidth(180);
        } catch {}
      }
      try {
        auxiliaryBarRuntime.hide();
      } catch {}
    }

    if (deviceChanged && input.nextMode === "full") {
      if (!(typeof sideWidthRaw === "number" && isFinite(sideWidthRaw))) {
        try {
          sideBarRuntime.setWidth(240);
        } catch {}
      }
    }

    if (deviceChanged && input.nextMode === "split") {
      if (!(typeof sideWidthRaw === "number" && isFinite(sideWidthRaw))) {
        try {
          sideBarRuntime.setWidth(280);
        } catch {}
      }
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
    const bottomVisible = bottomPanelRuntime.isVisible();
    const activeBottomViewId = bottomPanelRuntime.getActiveViewId();
    const auxVisible = auxiliaryBarRuntime.isVisible();
    const activeAuxViewId = auxiliaryBarRuntime.getActiveViewId();

    if (it.sideBarViewId && prevActive === id && sideVisible && activeViewId === it.sideBarViewId) {
      sideBarRuntime.hide();
      this.emitter.emit();
      return;
    }
    if (it.bottomPanelViewId && prevActive === id && bottomVisible && activeBottomViewId === it.bottomPanelViewId) {
      bottomPanelRuntime.hide();
      this.emitter.emit();
      return;
    }
    if (it.auxiliaryBarViewId && prevActive === id && auxVisible && activeAuxViewId === it.auxiliaryBarViewId) {
      auxiliaryBarRuntime.hide();
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
    if (it.auxiliaryBarViewId) {
      auxiliaryBarRuntime.show();
      auxiliaryBarRuntime.activateView(it.auxiliaryBarViewId);
    }
    if (it.bottomPanelViewId) {
      bottomPanelRuntime.show();
      bottomPanelRuntime.activateView(it.bottomPanelViewId);
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
  private returnFocus: FocusSnapshot = null;

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
    if (this.isVisible()) return;
    this.returnFocus = captureFocusSnapshot();
    core?.state.set("ui.sideBar.visible", true);
    this.emitter.emit();
  }

  hide(): void {
    core?.state.set("ui.sideBar.visible", false);
    this.emitter.emit();
    const snap = this.returnFocus;
    this.returnFocus = null;
    if (snap) requestAnimationFrame(() => restoreFocusSnapshot(snap));
  }

  toggle(): boolean {
    const cur = this.isVisible();
    const next = !cur;
    if (next) this.show();
    else this.hide();
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

class AuxiliaryBarRuntime {
  private views = new Map<string, AuxiliaryBarView>();
  private emitter = new ChangeEmitter();
  private returnFocus: FocusSnapshot = null;
  private readonly orderKey = "zion.ui.auxiliaryBar.viewOrder";
  private transientWidth: { baseWidth: number; appliedWidth: number; owners: Map<string, number> } | null = null;

  onDidChange(fn: () => void): Disposable {
    return this.emitter.onDidChange(fn);
  }

  registerView(view: AuxiliaryBarView): Disposable {
    this.views.set(view.id, view);
    if (!this.getActiveViewId()) {
      core?.state.set("ui.auxiliaryBar.activeViewId", view.id);
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
          core?.state.set("ui.auxiliaryBar.activeViewId", next as any);
        }
        if (this.getViews().length === 0) {
          core?.state.set("ui.auxiliaryBar.visible", false);
        }
        this.emitter.emit();
      }
    };
  }

  getViews(): AuxiliaryBarView[] {
    const arr = Array.from(this.views.values()).filter(v => evalWhen(v.when));
    return sortViewsWithCustomOrder(arr, this.orderKey);
  }

  setViewOrder(ids: string[]): void {
    const alive = new Set(Array.from(this.views.keys()));
    const normalized = ids.filter((id) => alive.has(id));
    const present = new Set(normalized);
    for (const view of this.getViews()) {
      if (!present.has(view.id)) normalized.push(view.id);
    }
    writeViewOrder(this.orderKey, normalized);
    this.emitter.emit();
  }

  getView(id: string): AuxiliaryBarView | null {
    return this.views.get(id) || null;
  }

  getActiveViewId(): string | null {
    return (core?.state.get<string>("ui.auxiliaryBar.activeViewId") ?? null) as any;
  }

  activateView(id: string): void {
    if (!this.views.has(id)) return;
    this.show();
    core?.state.set("ui.auxiliaryBar.activeViewId", id);
    core?.events.emit("ui/auxiliaryBarActiveViewChanged", { id });
    this.emitter.emit();
  }

  closeView(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    try {
      view.onDispose?.();
    } catch {}
    this.views.delete(id);
    if (this.getActiveViewId() === id) {
      const next = this.getViews()[0]?.id ?? null;
      core?.state.set("ui.auxiliaryBar.activeViewId", next as any);
      if (!next) core?.state.set("ui.auxiliaryBar.visible", false);
    }
    this.emitter.emit();
  }

  show() {
    if (this.isVisible()) return;
    this.returnFocus = captureFocusSnapshot();
    core?.state.set("ui.auxiliaryBar.visible", true);
    this.emitter.emit();
  }

  hide() {
    core?.state.set("ui.auxiliaryBar.visible", false);
    this.emitter.emit();
    const snap = this.returnFocus;
    this.returnFocus = null;
    if (snap) requestAnimationFrame(() => restoreFocusSnapshot(snap));
  }

  toggle(): boolean {
    const cur = this.isVisible();
    const next = !cur;
    if (next) this.show();
    else this.hide();
    return next;
  }

  isVisible(): boolean {
    const v = core?.state.get<boolean>("ui.auxiliaryBar.visible");
    return v == null ? false : !!v;
  }

  private clampWidth(px: number): number {
      const width = Math.round(px);
      return Number.isFinite(width) ? Math.max(240, width) : 240;
  }

  private applyWidth(px: number, options: { preserveTransient?: boolean } = {}): number {
    const w = this.clampWidth(px);
    if (!options.preserveTransient) this.transientWidth = null;
    core?.state.set("ui.auxiliaryBar.width", w);
    core?.state.set("ui.auxiliaryBar.visible", true);
    this.emitter.emit();
    return w;
  }

  setWidth(px: number): void {
    this.applyWidth(px);
  }

  requestTemporaryWidth(ownerId: string, px: number): void {
    const owner = String(ownerId || "default");
    const target = this.clampWidth(px);
    const current = this.getWidth();
    if (!this.transientWidth && current >= target) return;
    if (!this.transientWidth) {
      this.transientWidth = { baseWidth: current, appliedWidth: current, owners: new Map() };
    }
    this.transientWidth.owners.set(owner, target);
    const desired = Math.max(...Array.from(this.transientWidth.owners.values()));
    if (desired > current) {
      this.transientWidth.appliedWidth = this.applyWidth(desired, { preserveTransient: true });
    }
  }

  releaseTemporaryWidth(ownerId: string): void {
    const transient = this.transientWidth;
    if (!transient) return;
    transient.owners.delete(String(ownerId || "default"));
    const current = this.getWidth();
    const canRestore = Math.abs(current - transient.appliedWidth) <= 2;
    if (!canRestore) {
      this.transientWidth = null;
      return;
    }
    if (transient.owners.size > 0) {
      const desired = Math.max(...Array.from(transient.owners.values()));
      if (desired < current) transient.appliedWidth = this.applyWidth(desired, { preserveTransient: true });
      return;
    }
    this.transientWidth = null;
    if (transient.baseWidth < current) this.applyWidth(transient.baseWidth, { preserveTransient: true });
  }

  getWidth(): number {
    const v = core?.state.get<number>("ui.auxiliaryBar.width");
    return typeof v === "number" && isFinite(v) ? v : 300;
  }
}

type InspectorWidthOptions = {
  emit?: boolean;
};

class InspectorRuntime {
  private readonly items = new Map<string, InspectorItem>();
  private readonly renderers = new Map<string, InspectorRenderer>();
  private readonly textEditorDecorators = new Map<string, InspectorTextEditorDecorator>();
  private readonly textEditors = new Map<string, any>();
  private textRevealHandler: ((itemId: string, options?: { from?: number; to?: number; focus?: boolean }) => any) | null = null;
  private textEditorDecoratorVersion = 0;
  private readonly emitter = new ChangeEmitter();

  onDidChange(fn: () => void): Disposable {
    return this.emitter.onDidChange(fn);
  }

  registerRenderer(renderer: InspectorRenderer): Disposable {
    const id = String(renderer?.id || "").trim();
    if (!id || typeof renderer.canRender !== "function" || typeof renderer.render !== "function") {
      return { dispose() {} };
    }
    const registered = { ...renderer, id };
    this.renderers.set(id, registered);
    this.emitter.emit();
    return {
      dispose: () => {
        if (this.renderers.get(id) !== registered) return;
        this.renderers.delete(id);
        this.emitter.emit();
      }
    };
  }

  registerTextEditorDecorator(decorator: InspectorTextEditorDecorator): Disposable {
    const id = String(decorator?.id || "").trim();
    if (!id || typeof decorator.createExtension !== "function") return { dispose() {} };
    const registered = { ...decorator, id };
    this.textEditorDecorators.set(id, registered);
    this.textEditorDecoratorVersion += 1;
    this.emitter.emit();
    return {
      dispose: () => {
        if (this.textEditorDecorators.get(id) !== registered) return;
        this.textEditorDecorators.delete(id);
        this.textEditorDecoratorVersion += 1;
        this.emitter.emit();
      }
    };
  }

  getTextEditorExtensions(editor: any, item: InspectorItem): any[] {
    return Array.from(this.textEditorDecorators.values())
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
      .flatMap((decorator) => {
        try {
          const extension = decorator.createExtension(editor, item);
          return extension == null ? [] : [extension];
        } catch {
          return [];
        }
      });
  }

  getTextEditorDecoratorVersion(): number {
    return this.textEditorDecoratorVersion;
  }

  attachTextEditor(itemId: string, editor: any): Disposable {
    const id = String(itemId || "");
    if (!id || !editor) return { dispose() {} };
    this.textEditors.set(id, editor);
    return {
      dispose: () => {
        if (this.textEditors.get(id) === editor) this.textEditors.delete(id);
      }
    };
  }

  getTextEditor(itemIdOrSessionId?: string): any | null {
    const target = String(itemIdOrSessionId || "");
    if (!target) {
      const activeId = this.getActiveItemId();
      return activeId ? this.textEditors.get(activeId) || null : null;
    }
    const direct = this.textEditors.get(target);
    if (direct) return direct;
    for (const editor of this.textEditors.values()) {
      if (String(editor?.sessionId || "") === target) return editor;
    }
    return null;
  }

  getTextEditorForView(view: any): any | null {
    if (!view) return null;
    for (const editor of this.textEditors.values()) {
      try {
        if (editor?.getView?.() === view) return editor;
      } catch {}
    }
    return null;
  }

  getTextSource(itemIdOrSessionId?: string): { item: InspectorItem; sessionId: string; content: string } | null {
    const target = String(itemIdOrSessionId || "");
    const item = target
      ? this.items.get(target)
        || this.getItems().find((candidate) => getInspectorTextSessionId(candidate) === target)
        || null
      : this.getActiveItem();
    if (!item || item.url || item.file?.kind !== "text") return null;
    return {
      item,
      sessionId: getInspectorTextSessionId(item),
      content: String(item.file.content || "")
    };
  }

  setTextRevealHandler(handler: ((itemId: string, options?: { from?: number; to?: number; focus?: boolean }) => any) | null): Disposable {
    this.textRevealHandler = typeof handler === "function" ? handler : null;
    return {
      dispose: () => {
        if (this.textRevealHandler === handler) this.textRevealHandler = null;
      }
    };
  }

  revealText(itemIdOrSessionId: string, options?: { from?: number; to?: number; focus?: boolean }): any {
    try {
      const target = String(itemIdOrSessionId || "");
      const item = this.items.get(target)
        || this.getItems().find((candidate) => getInspectorTextSessionId(candidate) === target)
        || null;
      return this.textRevealHandler?.(item?.id || target, options) || null;
    } catch {
      return null;
    }
  }

  getRenderer(item: InspectorItem): InspectorRenderer | null {
    return Array.from(this.renderers.values())
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
      .find((renderer) => {
        try { return renderer.canRender(item); } catch { return false; }
      }) || null;
  }

  open(input: InspectorItem): string {
    const id = String(input?.id || "").trim();
    if (!id) return "";
    const next: InspectorItem = {
      ...input,
      id,
      ownerId: String(input.ownerId || "core"),
      title: String(input.title || input.path || "Untitled"),
      path: String(input.path || ""),
      displayPath: String(input.displayPath || input.path || ""),
      language: String(input.language || "text")
    };
    const ownerId = next.ownerId || "core";
    const pathKey = next.path || next.displayPath || next.title;
    for (const [existingId, existing] of this.items) {
      if (existingId === id) continue;
      if (existing.ownerId !== ownerId) continue;
      const existingPath = existing.path || existing.displayPath || existing.title;
      if (!pathKey || existingPath !== pathKey) continue;
      this.items.delete(existingId);
      if (this.getActiveItemId() === existingId) {
        core?.state.set("ui.inspector.activeItemId", id);
      }
    }
    this.items.set(id, next);
    core?.state.set("ui.inspector.activeItemId", id);
    core?.state.set("ui.inspector.visible", true);
    this.emitter.emit();
    return id;
  }

  update(id: string, patch: Partial<InspectorItem>): boolean {
    const current = this.items.get(id);
    if (!current) return false;
    this.items.set(id, { ...current, ...patch, id });
    this.emitter.emit();
    return true;
  }

  close(id: string): void {
    const items = this.getItems();
    const closedIndex = items.findIndex((item) => item.id === id);
    if (!this.items.delete(id)) return;
    if (this.getActiveItemId() === id) {
      const remaining = this.getItems();
      core?.state.set("ui.inspector.activeItemId", remaining[Math.min(Math.max(0, closedIndex), remaining.length - 1)]?.id || null);
    }
    if (this.items.size === 0) core?.state.set("ui.inspector.visible", false);
    this.emitter.emit();
  }

  clearOwner(ownerId: string): void {
    const owner = String(ownerId || "");
    let changed = false;
    for (const [id, item] of this.items) {
      if (item.ownerId !== owner) continue;
      this.items.delete(id);
      changed = true;
    }
    if (changed) {
      if (!this.items.has(this.getActiveItemId() || "")) {
        core?.state.set("ui.inspector.activeItemId", this.getItems()[0]?.id || null);
      }
      if (this.items.size === 0) core?.state.set("ui.inspector.visible", false);
      this.emitter.emit();
    }
  }

  getItems(): InspectorItem[] {
    return Array.from(this.items.values());
  }

  getActiveItemId(): string | null {
    return (core?.state.get<string>("ui.inspector.activeItemId") ?? null) as string | null;
  }

  getActiveItem(): InspectorItem | null {
    const id = this.getActiveItemId();
    return id ? this.items.get(id) || null : null;
  }

  activate(id: string): void {
    if (!this.items.has(id)) return;
    core?.state.set("ui.inspector.activeItemId", id);
    core?.state.set("ui.inspector.visible", true);
    this.emitter.emit();
  }

  show(): void {
    core?.state.set("ui.inspector.visible", true);
    this.emitter.emit();
  }

  hide(): void {
    core?.state.set("ui.inspector.visible", false);
    this.emitter.emit();
  }

  isVisible(): boolean {
    return !!core?.state.get<boolean>("ui.inspector.visible");
  }

  setWidth(px: number, options: InspectorWidthOptions = {}): void {
    const width = Math.round(px);
    core?.state.set("ui.inspector.width", Number.isFinite(width) ? Math.max(340, width) : 340);
    if (!this.isVisible()) core?.state.set("ui.inspector.visible", true);
    if (options.emit !== false) this.emitter.emit();
  }

  getWidth(): number {
    const value = core?.state.get<number>("ui.inspector.width");
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(340, value)
      : 480;
  }
}

class BottomPanelRuntime {
  private views = new Map<string, BottomPanelView>();
  private emitter = new ChangeEmitter();
  private lastNonMaximizedHeight: number | null = null;
  private returnFocus: FocusSnapshot = null;
  private readonly orderKey = "zion.ui.bottomPanel.viewOrder";

  onDidChange(fn: () => void): Disposable {
    return this.emitter.onDidChange(fn);
  }

  registerView(view: BottomPanelView): Disposable {
    this.views.set(view.id, view);
    if (!this.getActiveViewId()) {
      core?.state.set("ui.bottomPanel.activeViewId", view.id);
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
          core?.state.set("ui.bottomPanel.activeViewId", next as any);
        }
        if (this.getViews().length === 0) {
          core?.state.set("ui.bottomPanel.visible", false);
        }
        this.emitter.emit();
      }
    };
  }

  getViews(): BottomPanelView[] {
    const arr = Array.from(this.views.values()).filter(v => evalWhen(v.when));
    return sortViewsWithCustomOrder(arr, this.orderKey);
  }

  setViewOrder(ids: string[]): void {
    const alive = new Set(Array.from(this.views.keys()));
    const normalized = ids.filter((id) => alive.has(id));
    const present = new Set(normalized);
    for (const view of this.getViews()) {
      if (!present.has(view.id)) normalized.push(view.id);
    }
    writeViewOrder(this.orderKey, normalized);
    this.emitter.emit();
  }

  getView(id: string): BottomPanelView | null {
    return this.views.get(id) || null;
  }

  getActiveViewId(): string | null {
    return (core?.state.get<string>("ui.bottomPanel.activeViewId") ?? null) as any;
  }

  getLastOpenedViewId(): string | null {
    const id = (core?.state.get<string>("ui.bottomPanel.lastOpenedViewId") ?? null) as any;
    return id && this.views.has(id) ? id : null;
  }

  activateView(id: string): void {
    if (!this.views.has(id)) return;
    this.show();
    core?.state.set("ui.bottomPanel.activeViewId", id);
    core?.state.set("ui.bottomPanel.lastOpenedViewId", id);
    core?.events.emit("ui/bottomPanelActiveViewChanged", { id });
    this.emitter.emit();
  }

  closeView(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    try {
      view.onDispose?.();
    } catch {}
    this.views.delete(id);
    if (this.getActiveViewId() === id) {
      const next = this.getViews()[0]?.id ?? null;
      core?.state.set("ui.bottomPanel.activeViewId", next as any);
      if (!next) core?.state.set("ui.bottomPanel.visible", false);
    }
    this.emitter.emit();
  }

  show() {
    if (this.isVisible()) return;
    this.returnFocus = captureFocusSnapshot();
    core?.state.set("ui.bottomPanel.visible", true);
    this.emitter.emit();
  }

  hide() {
    core?.state.set("ui.bottomPanel.visible", false);
    this.emitter.emit();
    const snap = this.returnFocus;
    this.returnFocus = null;
    if (snap) requestAnimationFrame(() => restoreFocusSnapshot(snap));
  }

  toggle(): boolean {
    const cur = this.isVisible();
    const next = !cur;
    if (next) this.show();
    else this.hide();
    return next;
  }

  isVisible(): boolean {
    const v = core?.state.get<boolean>("ui.bottomPanel.visible");
    return v == null ? false : !!v;
  }

  setHeight(px: number): void {
    const h = Math.max(120, Math.min(700, Math.round(px)));
    core?.state.set("ui.bottomPanel.height", h);
    core?.state.set("ui.bottomPanel.visible", true);
    if (!this.isMaximized()) this.lastNonMaximizedHeight = h;
    this.emitter.emit();
  }

  getHeight(): number {
    const v = core?.state.get<number>("ui.bottomPanel.height");
    return typeof v === "number" && isFinite(v) ? v : 200;
  }

  maximize(): void {
    if (this.isMaximized()) return;
    this.lastNonMaximizedHeight = this.getHeight();
    core?.state.set("ui.bottomPanel.maximized", true);
    core?.state.set("ui.bottomPanel.visible", true);
    this.emitter.emit();
  }

  restore(): void {
    if (!this.isMaximized()) return;
    core?.state.set("ui.bottomPanel.maximized", false);
    if (typeof this.lastNonMaximizedHeight === "number" && isFinite(this.lastNonMaximizedHeight)) {
      core?.state.set("ui.bottomPanel.height", this.lastNonMaximizedHeight);
    }
    this.emitter.emit();
  }

  isMaximized(): boolean {
    const v = core?.state.get<boolean>("ui.bottomPanel.maximized");
    return v == null ? false : !!v;
  }
}

export const activityBarRuntime = new ActivityBarRuntime();
export const sideBarRuntime = new SideBarRuntime();
export const auxiliaryBarRuntime = new AuxiliaryBarRuntime();
export const inspectorRuntime = new InspectorRuntime();
export const bottomPanelRuntime = new BottomPanelRuntime();
export const responsiveRuntime = new ResponsiveRuntime();
