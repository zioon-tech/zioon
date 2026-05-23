import { renderSplitLayout } from "./SplitLayout";
import type {
  PanelDomRefs,
  PanelId,
  PanelManagerEventMap,
  PanelRecord,
  SplitSide,
  PanelTabId,
  SplitDirection,
  SplitNode
} from "./types";
import type { EditorProxy } from "../types/zion";

type Disposable = { dispose(): void };

type CreatePanelDom = (panelId: PanelId) => PanelDomRefs;
type EmitFn = <K extends keyof PanelManagerEventMap>(event: K, payload: PanelManagerEventMap[K]) => void;

type PanelManagerOptions = {
  host: HTMLElement;
  initialPanel: PanelRecord;
  createPanelDom: CreatePanelDom;
  emit?: EmitFn;
};

type Listener<K extends keyof PanelManagerEventMap> = (payload: PanelManagerEventMap[K]) => void;

export class PanelManager {
  private host: HTMLElement;
  private createPanelDom: CreatePanelDom;
  private emit?: EmitFn;
  private panels = new Map<PanelId, PanelRecord>();
  private listeners = new Map<keyof PanelManagerEventMap, Set<Function>>();
  private root: SplitNode | null = null;
  private activePanelId: PanelId | null = null;
  private activePanelHistory: PanelId[] = [];
  private nextPanelNum = 1;
  private nextSplitNum = 1;
  private maximizedPanelId: PanelId | null = null;
  private maximizedSplitRatios: Map<string, number> | null = null;
  private pendingMaximizedFocusRender: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: PanelManagerOptions) {
    this.host = opts.host;
    this.createPanelDom = opts.createPanelDom;
    this.emit = opts.emit;
    this.registerPanel(opts.initialPanel);
    this.root = { type: "leaf", panelId: opts.initialPanel.id };
    this.activePanelId = opts.initialPanel.id;
    this.noteActivePanel(opts.initialPanel.id);
    this.render();
  }

  listPanels(): PanelRecord[] {
    return [...this.panels.values()];
  }

  getPanel(panelId: PanelId): PanelRecord | null {
    return this.panels.get(panelId) || null;
  }

  getActivePanel(): PanelRecord | null {
    return this.activePanelId ? this.getPanel(this.activePanelId) : null;
  }

  getActivePanelId(): PanelId | null {
    return this.activePanelId;
  }

  getRoot(): SplitNode | null {
    return this.root;
  }

  getMaximizedPanelId(): PanelId | null {
    return this.maximizedPanelId && this.panels.has(this.maximizedPanelId) ? this.maximizedPanelId : null;
  }

  isPanelMaximized(panelId?: PanelId | null): boolean {
    const targetId = panelId || this.activePanelId;
    return !!targetId && this.getMaximizedPanelId() === targetId;
  }

  snapshotState(): any {
    return {
      root: cloneSplitNode(this.root),
      activePanelId: this.activePanelId,
      activePanelHistory: [...this.activePanelHistory],
      nextPanelNum: this.nextPanelNum,
      nextSplitNum: this.nextSplitNum,
      panels: this.listPanels().map((panel) => ({
        id: panel.id,
        tabs: panel.tabs.map((tab) => ({ ...tab })),
        activeTabId: panel.activeTabId
      }))
    };
  }

  restoreState(snapshot: any): boolean {
    try {
      const nextRoot = cloneSplitNode(snapshot?.root);
      const nextPanels = Array.isArray(snapshot?.panels) ? snapshot.panels : [];
      if (!nextRoot || nextPanels.length === 0) return false;

      const panelIds = new Set<string>(
        nextPanels
          .map((panel: any) => String(panel?.id || "").trim())
          .filter((id: string) => !!id)
      );
      if (!panelIds.size) return false;

      const leafIds = collectLeafPanelIds(nextRoot);
      if (!leafIds.length) return false;
      if (leafIds.some((id) => !panelIds.has(id))) return false;
      if ([...panelIds].some((id) => !leafIds.includes(id))) return false;

      for (const [panelId, panel] of [...this.panels.entries()]) {
        if (panelIds.has(panelId)) continue;
        try { panel.rootEl.remove(); } catch {}
        this.panels.delete(panelId);
      }

      const createdPanelIds: PanelId[] = [];
      for (const id of panelIds.values()) {
        if (this.panels.has(id)) continue;
        const dom = this.createPanelDom(id);
        const created: PanelRecord = {
          id,
          tabs: [],
          activeTabId: null,
          editor: null,
          ...dom
        };
        this.registerPanel(created);
        createdPanelIds.push(id);
      }

      for (const panelState of nextPanels) {
        const panelId = String(panelState?.id || "").trim();
        const panel = this.panels.get(panelId);
        if (!panel) continue;
        panel.tabs = Array.isArray(panelState?.tabs)
          ? panelState.tabs
              .map((tab: any) => ({
                id: String(tab?.id || "").trim(),
                title: String(tab?.title || tab?.id || "").trim(),
                isDirty: !!tab?.isDirty
              }))
              .filter((tab: any) => !!tab.id)
          : [];
        const requestedActiveId = typeof panelState?.activeTabId === "string" ? panelState.activeTabId : null;
        panel.activeTabId = requestedActiveId && panel.tabs.some((tab) => tab.id === requestedActiveId)
          ? requestedActiveId
          : (panel.tabs[0]?.id || null);
      }

      this.root = nextRoot;
      this.maximizedPanelId = null;
      this.maximizedSplitRatios = null;
      const requestedActivePanelId =
        typeof snapshot?.activePanelId === "string" && panelIds.has(snapshot.activePanelId)
          ? snapshot.activePanelId
          : null;
      this.activePanelHistory = Array.isArray(snapshot?.activePanelHistory)
        ? snapshot.activePanelHistory.filter((id: any): id is string => typeof id === "string" && panelIds.has(id))
        : [];
      this.activePanelId = requestedActivePanelId || this.findFirstLeafPanelId(this.root);
      if (this.activePanelId) this.noteActivePanel(this.activePanelId);
      this.nextPanelNum = Math.max(
        typeof snapshot?.nextPanelNum === "number" && Number.isFinite(snapshot.nextPanelNum) ? snapshot.nextPanelNum : 1,
        computeNextSequence(Array.from(panelIds), /^panel-(\d+)$/)
      );
      this.nextSplitNum = Math.max(
        typeof snapshot?.nextSplitNum === "number" && Number.isFinite(snapshot.nextSplitNum) ? snapshot.nextSplitNum : 1,
        computeNextSequence(collectSplitIds(this.root), /^split-(\d+)$/)
      );

      this.render();
      for (const panelId of createdPanelIds) {
        this.fire("panel/created", {
          panelId,
          sourcePanelId: null,
          seedFromSource: false
        });
      }
      this.fire("panel/focusChanged", { panelId: this.activePanelId });
      return true;
    } catch {
      return false;
    }
  }

  setPanelEditor(panelId: PanelId, editor: EditorProxy | null): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;
    panel.editor = editor;
  }

  getEditor(panelId: PanelId): EditorProxy | null {
    return this.panels.get(panelId)?.editor || null;
  }

  focusPanel(panelId: PanelId): void {
    if (!this.panels.has(panelId)) return;
    const maximizedPanelId = this.getMaximizedPanelId();
    this.activePanelId = panelId;
    this.noteActivePanel(panelId);
    if (maximizedPanelId && maximizedPanelId !== panelId && this.root && this.panels.size > 1) {
      if (this.maximizedSplitRatios) {
        restoreSplitRatios(this.root, this.maximizedSplitRatios);
      }
      this.emphasizePanel(panelId);
      this.maximizedPanelId = panelId;
      this.applyActiveClasses();
      this.scheduleMaximizedFocusRender();
      this.fire("panel/focusChanged", { panelId });
      return;
    }
    this.applyActiveClasses();
    this.fire("panel/focusChanged", { panelId });
  }

  activateTab(panelId: PanelId, tabId: PanelTabId | null): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;
    panel.activeTabId = tabId;
    this.fire("panel/tabActivated", { panelId, tabId, sessionId: tabId });
  }

  splitPanel(panelId = this.activePanelId, direction: SplitDirection = "horizontal"): PanelRecord | null {
    const side: SplitSide = direction === "horizontal" ? "right" : "down";
    return this.splitPanelAt(panelId, side);
  }

  findPanelAtSide(panelId = this.activePanelId, side: SplitSide = "right"): PanelId | null {
    if (!panelId || !this.root) return null;
    const path = this.findPathToPanel(this.root, panelId);
    if (!path.length) return null;
    if (side === "right") {
      for (let i = path.length - 1; i >= 0; i--) {
        const step = path[i];
        if (step.node.type !== "split" || step.node.direction !== "horizontal") continue;
        if (step.branch !== "first") continue;
        return this.findFirstLeafPanelId(step.node.second);
      }
      return null;
    }
    if (side === "left") {
      for (let i = path.length - 1; i >= 0; i--) {
        const step = path[i];
        if (step.node.type !== "split" || step.node.direction !== "horizontal") continue;
        if (step.branch !== "second") continue;
        return this.findLastLeafPanelId(step.node.first);
      }
      return null;
    }
    if (side === "down") {
      for (let i = path.length - 1; i >= 0; i--) {
        const step = path[i];
        if (step.node.type !== "split" || step.node.direction !== "vertical") continue;
        if (step.branch !== "first") continue;
        return this.findFirstLeafPanelId(step.node.second);
      }
      return null;
    }
    if (side === "up") {
      for (let i = path.length - 1; i >= 0; i--) {
        const step = path[i];
        if (step.node.type !== "split" || step.node.direction !== "vertical") continue;
        if (step.branch !== "second") continue;
        return this.findLastLeafPanelId(step.node.first);
      }
    }
    return null;
  }

  splitPanelAt(
    panelId = this.activePanelId,
    side: SplitSide = "right",
    opts?: { seedFromSource?: boolean }
  ): PanelRecord | null {
    if (!panelId || !this.root) return null;
    const existing = this.panels.get(panelId);
    if (!existing) return null;
    this.maximizedPanelId = null;
    this.maximizedSplitRatios = null;

    const direction: SplitDirection = side === "left" || side === "right" ? "horizontal" : "vertical";
    const placeBefore = side === "left" || side === "up";
    const newPanelId = this.allocatePanelId();
    const dom = this.createPanelDom(newPanelId);
    const created: PanelRecord = {
      id: newPanelId,
      tabs: [],
      activeTabId: null,
      editor: null,
      ...dom
    };
    this.registerPanel(created);

    const replaced = this.replaceLeaf(this.root, panelId, {
      type: "split",
      id: this.allocateSplitId(),
      direction,
      ratio: 0.5,
      first: placeBefore ? { type: "leaf", panelId: newPanelId } : { type: "leaf", panelId },
      second: placeBefore ? { type: "leaf", panelId } : { type: "leaf", panelId: newPanelId }
    });
    this.root = replaced || this.root;
    this.activePanelId = newPanelId;
    this.noteActivePanel(newPanelId);
    this.render();
    this.fire("panel/created", {
      panelId: newPanelId,
      sourcePanelId: panelId,
      seedFromSource: opts?.seedFromSource !== false
    });
    return created;
  }

  closePanel(panelId = this.activePanelId): void {
    if (!panelId || this.panels.size <= 1 || !this.root) return;
    const closingWasActive = this.activePanelId === panelId;
    const nextRoot = this.removeLeaf(this.root, panelId);
    if (!nextRoot) return;

    const closing = this.panels.get(panelId);
    try { closing?.rootEl.remove(); } catch {}
    this.panels.delete(panelId);
    if (this.maximizedPanelId === panelId) this.maximizedPanelId = null;
    this.maximizedSplitRatios = null;
    this.activePanelHistory = this.activePanelHistory.filter((id) => id !== panelId);
    this.root = nextRoot;
    let nextActive = this.activePanelId;
    if (closingWasActive || !nextActive || !this.panels.has(nextActive)) {
      nextActive =
        this.activePanelHistory.find((id) => this.panels.has(id)) ||
        this.findFirstLeafPanelId(nextRoot);
      this.activePanelId = nextActive;
      this.noteActivePanel(nextActive);
    }
    this.render();
    this.fire("panel/closed", { panelId });
    this.fire("panel/focusChanged", { panelId: nextActive });
  }

  maximizePanel(panelId = this.activePanelId): void {
    if (!panelId || !this.panels.has(panelId) || !this.root || this.panels.size <= 1) return;
    this.activePanelId = panelId;
    this.noteActivePanel(panelId);
    if (!this.maximizedSplitRatios) {
      this.maximizedSplitRatios = captureSplitRatios(this.root);
    } else {
      restoreSplitRatios(this.root, this.maximizedSplitRatios);
    }
    this.emphasizePanel(panelId);
    this.maximizedPanelId = panelId;
    this.render();
  }

  restorePanelLayout(): void {
    if (!this.root || !this.maximizedPanelId) return;
    if (this.maximizedSplitRatios) {
      restoreSplitRatios(this.root, this.maximizedSplitRatios);
    }
    this.maximizedPanelId = null;
    this.maximizedSplitRatios = null;
    this.render();
  }

  togglePanelMaximized(panelId = this.activePanelId): void {
    if (!panelId || !this.panels.has(panelId)) return;
    if (this.isPanelMaximized(panelId)) this.restorePanelLayout();
    else this.maximizePanel(panelId);
  }

  on<K extends keyof PanelManagerEventMap>(event: K, handler: Listener<K>): Disposable {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return {
      dispose: () => {
        try { set?.delete(handler); } catch {}
      }
    };
  }

  private registerPanel(panel: PanelRecord): void {
    this.panels.set(panel.id, panel);
    panel.rootEl.dataset.panelId = panel.id;
    panel.rootEl.tabIndex = 0;
    panel.rootEl.addEventListener("mousedown", () => this.focusPanel(panel.id));
    panel.rootEl.addEventListener("focusin", () => this.focusPanel(panel.id));
  }

  private render(): void {
    const scrollSnapshots = new Map<PanelId, { top: number; left: number }>();
    for (const [panelId, panel] of this.panels.entries()) {
      try {
        const view = panel.editor?.getView?.();
        const scrollDOM = view?.scrollDOM;
        if (!scrollDOM) continue;
        scrollSnapshots.set(panelId, {
          top: typeof scrollDOM.scrollTop === "number" ? scrollDOM.scrollTop : 0,
          left: typeof scrollDOM.scrollLeft === "number" ? scrollDOM.scrollLeft : 0
        });
      } catch {}
    }
    renderSplitLayout(
      this.host,
      this.root,
      (panelId) => this.panels.get(panelId) || null,
      (splitId, ratio) => this.setSplitRatio(splitId, ratio)
    );
    for (const [panelId, pos] of scrollSnapshots.entries()) {
      try {
        const view = this.panels.get(panelId)?.editor?.getView?.();
        const scrollDOM = view?.scrollDOM;
        if (!scrollDOM) continue;
        scrollDOM.scrollTop = Math.max(0, pos.top || 0);
        scrollDOM.scrollLeft = Math.max(0, pos.left || 0);
      } catch {}
    }
    this.applyActiveClasses();
    this.fire("panel/layoutChanged", { root: this.root, activePanelId: this.activePanelId });
  }

  private applyActiveClasses(): void {
    const maximizedPanelId = this.getMaximizedPanelId();
    this.host.classList.toggle("has-multiple-panels", this.panels.size > 1);
    this.host.classList.toggle("is-panel-maximized", !!maximizedPanelId);
    for (const panel of this.panels.values()) {
      panel.rootEl.classList.toggle("is-active", panel.id === this.activePanelId);
      panel.rootEl.classList.toggle("is-maximized", !!maximizedPanelId && panel.id === maximizedPanelId);
    }
  }

  private fire<K extends keyof PanelManagerEventMap>(event: K, payload: PanelManagerEventMap[K]): void {
    this.emit?.(event, payload);
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        (fn as Listener<K>)(payload);
      } catch {}
    }
  }

  private scheduleMaximizedFocusRender(): void {
    if (this.pendingMaximizedFocusRender) return;
    this.pendingMaximizedFocusRender = setTimeout(() => {
      this.pendingMaximizedFocusRender = null;
      this.render();
    }, 0);
  }

  private allocatePanelId(): PanelId {
    return `panel-${this.nextPanelNum++}`;
  }

  private allocateSplitId(): string {
    return `split-${this.nextSplitNum++}`;
  }

  private noteActivePanel(panelId: PanelId | null): void {
    if (!panelId) return;
    this.activePanelHistory = [panelId, ...this.activePanelHistory.filter((id) => id !== panelId)];
  }

  private setSplitRatio(splitId: string, ratio: number): void {
    if (!this.root) return;
    this.maximizedPanelId = null;
    this.maximizedSplitRatios = null;
    const nextRatio = Math.max(0.15, Math.min(0.85, ratio));
    const node = this.findSplitNode(this.root, splitId);
    if (!node || node.type !== "split") return;
    node.ratio = nextRatio;
    this.fire("panel/layoutChanged", { root: this.root, activePanelId: this.activePanelId });
  }

  private emphasizePanel(panelId: PanelId): void {
    if (!this.root) return;
    const path = this.findPathToPanel(this.root, panelId);
    if (!path.length) return;
    for (const step of path) {
      if (step.node.type !== "split" || !step.branch) continue;
      step.node.ratio = step.branch === "first" ? 0.82 : 0.18;
    }
  }

  private replaceLeaf(node: SplitNode, targetPanelId: PanelId, replacement: SplitNode): SplitNode | null {
    if (node.type === "leaf") {
      return node.panelId === targetPanelId ? replacement : node;
    }
    return {
      ...node,
      first: this.replaceLeaf(node.first, targetPanelId, replacement) || node.first,
      second: this.replaceLeaf(node.second, targetPanelId, replacement) || node.second
    };
  }

  private removeLeaf(node: SplitNode, targetPanelId: PanelId): SplitNode | null {
    if (node.type === "leaf") {
      return node.panelId === targetPanelId ? null : node;
    }
    const first = this.removeLeaf(node.first, targetPanelId);
    const second = this.removeLeaf(node.second, targetPanelId);
    if (!first && !second) return null;
    if (!first) return second;
    if (!second) return first;
    return { ...node, first, second };
  }

  private findFirstLeafPanelId(node: SplitNode | null): PanelId | null {
    if (!node) return null;
    if (node.type === "leaf") return node.panelId;
    return this.findFirstLeafPanelId(node.first) || this.findFirstLeafPanelId(node.second);
  }

  private findLastLeafPanelId(node: SplitNode | null): PanelId | null {
    if (!node) return null;
    if (node.type === "leaf") return node.panelId;
    return this.findLastLeafPanelId(node.second) || this.findLastLeafPanelId(node.first);
  }

  private findPathToPanel(
    node: SplitNode | null,
    targetPanelId: PanelId,
    acc: Array<{ node: SplitNode; branch: "first" | "second" | null }> = []
  ): Array<{ node: SplitNode; branch: "first" | "second" | null }> {
    if (!node) return [];
    if (node.type === "leaf") {
      return node.panelId === targetPanelId ? acc.concat({ node, branch: null }) : [];
    }
    const left = this.findPathToPanel(node.first, targetPanelId, acc.concat({ node, branch: "first" }));
    if (left.length) return left;
    return this.findPathToPanel(node.second, targetPanelId, acc.concat({ node, branch: "second" }));
  }

  private findSplitNode(node: SplitNode | null, splitId: string): SplitNode | null {
    if (!node) return null;
    if (node.type === "split" && node.id === splitId) return node;
    if (node.type === "leaf") return null;
    return this.findSplitNode(node.first, splitId) || this.findSplitNode(node.second, splitId);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function cloneSplitNode(node: SplitNode | null): SplitNode | null {
  if (!node) return null;
  if (node.type === "leaf") {
    return { ...node };
  }
  return {
    ...node,
    first: cloneSplitNode(node.first)!,
    second: cloneSplitNode(node.second)!
  };
}

function collectLeafPanelIds(node: SplitNode | null, acc: PanelId[] = []): PanelId[] {
  if (!node) return acc;
  if (node.type === "leaf") {
    acc.push(node.panelId);
    return acc;
  }
  collectLeafPanelIds(node.first, acc);
  collectLeafPanelIds(node.second, acc);
  return acc;
}

function collectSplitIds(node: SplitNode | null, acc: string[] = []): string[] {
  if (!node || node.type === "leaf") return acc;
  acc.push(node.id);
  collectSplitIds(node.first, acc);
  collectSplitIds(node.second, acc);
  return acc;
}

function captureSplitRatios(node: SplitNode | null, acc = new Map<string, number>()): Map<string, number> {
  if (!node || node.type === "leaf") return acc;
  acc.set(node.id, node.ratio);
  captureSplitRatios(node.first, acc);
  captureSplitRatios(node.second, acc);
  return acc;
}

function restoreSplitRatios(node: SplitNode | null, ratios: Map<string, number> | null): void {
  if (!node || node.type === "leaf" || !ratios) return;
  const saved = ratios.get(node.id);
  if (typeof saved === "number" && Number.isFinite(saved)) {
    node.ratio = Math.max(0.15, Math.min(0.85, saved));
  }
  restoreSplitRatios(node.first, ratios);
  restoreSplitRatios(node.second, ratios);
}

function computeNextSequence(ids: string[], re: RegExp): number {
  let max = 0;
  for (const id of ids) {
    const m = String(id || "").match(re);
    if (!m) continue;
    const num = Number(m[1]);
    if (Number.isFinite(num)) max = Math.max(max, num + 1);
  }
  return Math.max(1, max);
}

export function createPanelDomShell(panelId: PanelId): PanelDomRefs {
  const rootEl = el("div", "zion-panel");
  rootEl.dataset.panelId = panelId;

  const tabsBarEl = el("div", "zion-editor-tabsbar");
  const headerEl = el("div", "zion-editor-header");
  const pathEl = el("div", "zion-editor-session-path");
  const editorHostEl = el("div", "zion-editor-host");
  const emptyStateEl = el("div", "zion-panel-empty");
  emptyStateEl.textContent = "Empty Panel";

  headerEl.appendChild(pathEl);
  editorHostEl.appendChild(emptyStateEl);
  rootEl.appendChild(tabsBarEl);
  rootEl.appendChild(headerEl);
  rootEl.appendChild(editorHostEl);

  return {
    rootEl,
    tabsBarEl,
    headerEl,
    pathEl,
    editorHostEl
  };
}
