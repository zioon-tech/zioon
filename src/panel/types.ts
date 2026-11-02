import type { EditorProxy } from "../types/zion";

export type PanelId = string;
export type PanelTabId = string;
export type SplitDirection = "horizontal" | "vertical";
export type SplitSide = "left" | "right" | "up" | "down";

export interface PanelTab {
  id: PanelTabId;
  title: string;
  isDirty: boolean;
  kind?: "session" | "file";
  meta?: Record<string, any>;
}

export interface PanelDomRefs {
  rootEl: HTMLElement;
  tabsBarEl: HTMLElement;
  headerEl: HTMLElement;
  pathEl: HTMLElement;
  editorHostEl: HTMLElement;
}

export interface PanelRecord extends PanelDomRefs {
  id: PanelId;
  tabs: PanelTab[];
  activeTabId: PanelTabId | null;
  editor: EditorProxy | null;
}

export interface SplitLeafNode {
  type: "leaf";
  panelId: PanelId;
}

export interface SplitBranchNode {
  type: "split";
  id: string;
  direction: SplitDirection;
  ratio: number;
  first: SplitNode;
  second: SplitNode;
}

export type SplitNode = SplitLeafNode | SplitBranchNode;

export type PanelManagerEventMap = {
  "panel/created": { panelId: PanelId; sourcePanelId: PanelId | null; seedFromSource?: boolean };
  "panel/closed": { panelId: PanelId };
  "panel/layoutChanged": { root: SplitNode | null; activePanelId: PanelId | null };
  "panel/tabActivated": { panelId: PanelId; tabId: PanelTabId | null; sessionId: PanelTabId | null };
  "panel/focusChanged": { panelId: PanelId | null };
};
