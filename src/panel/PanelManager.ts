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
    this.activePanelId = panelId;
    this.noteActivePanel(panelId);
    this.applyActiveClasses();
    this.fire("panel/focusChanged", { panelId });
    this.fire("panel/layoutChanged", { root: this.root, activePanelId: this.activePanelId });
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

  splitPanelAt(
    panelId = this.activePanelId,
    side: SplitSide = "right",
    opts?: { seedFromSource?: boolean }
  ): PanelRecord | null {
    if (!panelId || !this.root) return null;
    const existing = this.panels.get(panelId);
    if (!existing) return null;

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
    renderSplitLayout(
      this.host,
      this.root,
      (panelId) => this.panels.get(panelId) || null,
      (splitId, ratio) => this.setSplitRatio(splitId, ratio)
    );
    this.applyActiveClasses();
    this.fire("panel/layoutChanged", { root: this.root, activePanelId: this.activePanelId });
  }

  private applyActiveClasses(): void {
    for (const panel of this.panels.values()) {
      panel.rootEl.classList.toggle("is-active", panel.id === this.activePanelId);
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
    const nextRatio = Math.max(0.15, Math.min(0.85, ratio));
    const node = this.findSplitNode(this.root, splitId);
    if (!node || node.type !== "split") return;
    node.ratio = nextRatio;
    this.fire("panel/layoutChanged", { root: this.root, activePanelId: this.activePanelId });
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
