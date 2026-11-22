import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { configuredEditorRoles, createEditorPanelSurface, type SurfaceSearchMatch } from "../editor/editor-panel-surface";
import { computeConversationSearchMatches } from "../editor/search-panel";
import { PanelManager, createPanelDomShell } from "../panel/PanelManager";
import type { PanelDomRefs, PanelRecord, SplitDirection } from "../panel/types";
import type { EditorProxy } from "../types/zion";
import { zionIconHtml } from "../ui/icons";
import { createEditorHeaderAction, mountEditorHeaderOutlineButton, mountEditorHeaderSplitMenu } from "../ui/editor-header";
import brandMark from "../../public/favicon.svg?raw";
import { readConversationRoleBlocks } from "../../extensions/dev.roles/roles.js";
import { ToolCallCardWidget, ToolInlineWidget } from "../../extensions/dev.tools/tool-calls.js";
import { ThinkingCardWidget, ThinkingInlineWidget } from "../../extensions/dev.thinking/thinking-cards.js";
import { publicDocumentAnchors } from "../chat/public-document.mjs";
import { safeMarkdownHref } from "../editor/public-content-security";
import { emptyConversationDraftStart } from "../editor/conversation-outline";
import { mountEditorDisplayMenu } from "../ui/editor-display-menu";
import { createThemeManager } from "../theme/themeManager";
import { I18nManager } from "../i18n/i18nManager";
import { registerDisplayDocumentAlias, subscribeDisplayPreferences } from "../editor/display-preferences";
import { createReaderParticipants } from "./participants";
import { mountParticipantsHeader, type ParticipantsSource } from "../ui/workbench/editor-participants-view";

type Card = { id: string; from: number; to: number; name?: string; text?: string;
  args?: unknown; result?: unknown; ok?: boolean | null; action?: string | null };
export type PublicDocument = { state: "read"; title: string; markdown: string;
  cards: { tools: Card[]; thinking: Card[] }; contentRevision?: string; updatedAt?: number;
  mode: "public" | "restricted"; role: string | null; displayIdentity?: string };
type Anchor = { kind: "tools" | "thinking"; id: string | null; name: string; from: number; to: number };
const valueText = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value ?? "", null, 2);
function bindReadableLinks(root: HTMLElement) {
  root.querySelectorAll<HTMLAnchorElement>("a").forEach(link => {
    const href = safeMarkdownHref(link.getAttribute("href") || "");
    if (href) link.href = href; else link.removeAttribute("href");
    link.rel = "noopener noreferrer"; link.target = "_blank";
  });
}
class RecordedCardWidget extends WidgetType {
  constructor(readonly anchor: Anchor, readonly card: Card | undefined,
    readonly expanded: boolean, readonly toggle: () => void, readonly namespace: string) { super(); }
  eq(other: RecordedCardWidget) {
    return this.anchor.kind === other.anchor.kind && this.anchor.id === other.anchor.id &&
      this.expanded === other.expanded && JSON.stringify(this.card) === JSON.stringify(other.card);
  }
  toDOM(view: EditorView) {
    const root = document.createElement("div"); root.className = "public-recorded-card";
    root.dataset.cardId = this.card?.id || this.anchor.id || "";
    const thinking = this.anchor.kind === "thinking", card = this.card;
    const id = card?.id || this.anchor.id || `missing:${this.anchor.from}`;
    const inline = thinking ? new ThinkingInlineWidget(id, { readOnly: true }).toDOM(view)
      : new ToolInlineWidget(id, this.anchor.name, card?.args, card?.ok ?? null,
        card?.result != null, card?.action, card?.result, null, { readOnly: true }).toDOM();
    const button = inline.querySelector<HTMLButtonElement>("button")!;
    button.setAttribute("aria-expanded", String(this.expanded));
    button.setAttribute("aria-controls", `${this.namespace}-recorded-card-${id}`);
    button.title = this.expanded ? "收起记录" : "展开记录";
    button.innerHTML = zionIconHtml(this.expanded ? "chevron-down" : "chevron-right", "", 14);
    root.classList.toggle("is-expanded", this.expanded);
    inline.addEventListener("click", (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest("a")) return;
      event.preventDefault(); event.stopPropagation(); this.toggle();
    });
    root.appendChild(inline);
    if (this.expanded) {
      const body = document.createElement("div"); body.id = `${this.namespace}-recorded-card-${id}`;
      if (!card) { body.className = "public-card-empty"; body.textContent = "此记录的详细内容不可用"; }
      else {
        const rendered = thinking ? new ThinkingCardWidget(id, card.text, { readOnly: true }).toDOM()
          : new ToolCallCardWidget(id, this.anchor.name, card.args, card.result, card.ok, null, card.action, { readOnly: true }).toDOM();
        bindReadableLinks(rendered); body.appendChild(rendered);
      }
      root.appendChild(body);
    }
    return root;
  }
  ignoreEvent() { return true; }
}

export function mountPublicReader(host: HTMLElement, initial: PublicDocument, options: {
  path: string; refresh?: () => Promise<PublicDocument | { state: string }>;
  onAccessLost?: () => void; refreshMs?: number; imageUrl?: (source: string) => string | null;
  workbenchUrl?: string;
  presence?: { url: string; headers?: HeadersInit; onAccessLost?(): void };
}) {
  let current = initial, disposed = false, refreshing = false;
  if (initial.displayIdentity) registerDisplayDocumentAlias(options.path, initial.displayIdentity);
  const participants = options.presence ? createReaderParticipants(options.presence) : undefined;
  const root = document.createElement("div"); root.className = "public-reader-shell";
  root.innerHTML = `<header class="public-reader-header">
    <a class="public-reader-brand" href="/" aria-label="Zioon 首页">${brandMark}<span>Zioon</span></a>
    <span class="public-reader-mode"></span><span class="public-reader-document-updated"></span><a class="public-reader-workbench" hidden></a>
    </header><div class="public-reader-notice" role="status" aria-live="polite"></div>`;
  root.querySelector("svg")!.setAttribute("aria-hidden", "true");
  const workspace = document.createElement("div"); workspace.className = "public-reader-workspace zion-panels-root";
  root.appendChild(workspace); host.replaceChildren(root);
  const notice = root.querySelector<HTMLElement>(".public-reader-notice")!;
  let noticeTimer = 0;
  const notify = (text: string) => {
    clearTimeout(noticeTimer); notice.textContent = text;
    noticeTimer = window.setTimeout(() => { notice.textContent = ""; }, 3500);
  };
  const first = createPanelDomShell("public-reader");
  const panels = new PanelManager({ host: workspace, createPanelDom: createPanelDomShell,
    initialPanel: { ...first, id: "public-reader", tabs: [], activeTabId: null, editor: null } });
  const panes = new Map<string, ReturnType<typeof mountPublicReaderPane>>();
  const theme = createThemeManager({ standalone: true, getEditorCores: () => [...panes.values()].map(pane => pane.core) });
  const i18n = new I18nManager(true); i18n.init(); theme.init();
  const presentation = subscribeDisplayPreferences(key => {
    if (key === "*" || key.startsWith("zion.theme")) theme.refresh();
    if (key === "zion.locale") {
      const locale = globalThis.localStorage?.getItem("zion.locale");
      if (locale === "en-US" || locale === "zh-CN") i18n.setLocale(locale);
    }
  });
  const activePane = () => panes.get(panels.getActivePanelId() || "") || panes.values().next().value!;
  const setCloseVisible = () => panes.forEach(pane => pane.setCloseVisible(panes.size > 1));
  const split = (panelId: string, direction: SplitDirection) => {
    if (disposed) return; panels.focusPanel(panelId); panels.splitPanel(panelId, direction);
  };
  const mountPane = (panel: PanelRecord, sourcePanelId?: string | null) => {
    const pane = mountPublicReaderPane(panel, current, { ...options, participants, i18n, notify,
      refresh: () => { void refresh(true); }, split: direction => split(panel.id, direction),
      close: () => panels.closePanel(panel.id) });
    panes.set(panel.id, pane);
    panels.setPanelEditor(panel.id, { getView: () => pane.view } as EditorProxy);
    pane.setRefreshing(refreshing);
    pane.core.setTheme(theme.getResolvedTheme());
    const source = sourcePanelId ? panes.get(sourcePanelId) : null;
    if (source) {
      pane.view.dispatch({ selection: source.view.state.selection });
      pane.view.scrollDOM.scrollTop = source.view.scrollDOM.scrollTop;
      pane.view.scrollDOM.scrollLeft = source.view.scrollDOM.scrollLeft;
    }
    setCloseVisible();
  };
  const subscriptions = [
    panels.on("panel/created", ({ panelId, sourcePanelId }) => mountPane(panels.getPanel(panelId)!, sourcePanelId)),
    panels.on("panel/closed", ({ panelId }) => { panes.get(panelId)?.dispose(); panes.delete(panelId); setCloseVisible(); })
  ];
  const renderHeader = () => {
    document.title = current.title;
    root.querySelector<HTMLElement>(".public-reader-mode")!.textContent = current.mode === "public" ? "公开 · 只读" : "已授权 · 只读";
    root.querySelector<HTMLElement>(".public-reader-document-updated")!.textContent = current.updatedAt
      ? `更新于 ${new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(current.updatedAt)}` : "";
    const link = root.querySelector<HTMLAnchorElement>(".public-reader-workbench")!;
    link.hidden = !current.role; link.href = options.workbenchUrl || `/?shareLink=${encodeURIComponent(options.path.split("/").at(-1)!)}`;
    link.textContent = ["owner", "editor", "manager"].includes(current.role || "") ? "在工作台编辑" : "在工作台打开";
  };
  const update = (value: PublicDocument) => {
    if (disposed) return; current = value; panes.forEach(pane => pane.update(value)); renderHeader();
  };
  const dispose = () => {
    if (disposed) return; disposed = true; releaseListeners();
    subscriptions.forEach(subscription => subscription.dispose());
    presentation.dispose(); theme.dispose();
    participants?.dispose();
    panes.forEach(pane => pane.dispose()); panes.clear(); panels.dispose();
    current = { ...current, markdown: "", cards: { tools: [], thinking: [] } }; host.replaceChildren();
  };
  const refresh = async (explicit = false) => {
    if (!options.refresh || disposed || refreshing) return;
    refreshing = true; panes.forEach(pane => pane.setRefreshing(true));
    try {
      const result = await options.refresh();
      if (disposed) return;
      if (result.state !== "read") { dispose(); options.onAccessLost?.(); return; }
      const value = result as PublicDocument;
      if (value.contentRevision !== current.contentRevision || value.title !== current.title ||
        value.markdown !== current.markdown || value.role !== current.role || value.mode !== current.mode ||
        value.updatedAt !== current.updatedAt) update(value);
      if (explicit) notify("已更新到最新内容");
    } catch { if (!disposed) notify("暂时无法刷新，请稍后重试"); }
    finally { refreshing = false; panes.forEach(pane => pane.setRefreshing(false)); }
  };
  const onFocus = () => { void refresh(); };
  const onVisibility = () => { if (!document.hidden) void refresh(); };
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("input,textarea,select") && !target.closest(".cm-editor")) return;
    const pane = activePane(); if (!pane) return;
    if (event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey && event.code === "KeyV") {
      event.preventDefault(); pane.toggleVim(); return;
    }
    if (!(event.metaKey || event.ctrlKey)) return;
    if (!event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); pane.showFind(); }
    else if (!event.altKey && event.shiftKey && event.key.toLowerCase() === "g") {
      event.preventDefault(); pane.toggleGroup();
    } else if (!event.altKey && event.key.toLowerCase() === "g" && pane.isFindVisible()) {
      event.preventDefault(); pane.nextMatch(1);
    } else if (!event.altKey && (event.code === "Backslash" || event.key === "\\")) {
      event.preventDefault(); split(panels.getActivePanelId()!, event.shiftKey ? "vertical" : "horizontal");
    } else if (event.altKey && event.key.toLowerCase() === "w" && panes.size > 1) {
      event.preventDefault(); panels.closePanel();
    }
  };
  const refreshTimer = options.refresh ? window.setInterval(() => { if (!document.hidden) void refresh(); }, options.refreshMs || 30000) : 0;
  const releaseListeners = () => {
    clearInterval(refreshTimer); clearTimeout(noticeTimer);
    window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("keydown", onKey);
  };
  mountPane(panels.getPanel("public-reader")!); renderHeader();
  window.addEventListener("focus", onFocus); document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("keydown", onKey);
  return { get core() { return activePane()?.core; }, get view() { return activePane()?.view; }, panels, update, refresh, dispose };
}

/** The adapter owns snapshot cards and transport updates; the surface owns all
 * editor settings, TOC/search/navigation, and their interaction lifetimes. */
function mountPublicReaderPane(panel: PanelDomRefs, initial: PublicDocument, options: {
  path: string; notify: (text: string) => void; refresh: () => void;
  split: (direction: SplitDirection) => void; close: () => void;
  imageUrl?: (source: string) => string | null;
  i18n: I18nManager;
  participants?: ParticipantsSource;
}) {
  let current = initial, disposed = false, view: EditorView;
  const expanded = new Set<string>(), refreshCards = StateEffect.define<null>();
  const getCard = (anchor: Anchor) => current.cards?.[anchor.kind]?.find(card => anchor.id
    ? card.id === anchor.id : card.from === anchor.from && card.to === anchor.to);
  const keyFor = (anchor: Anchor) => `${anchor.kind}:${getCard(anchor)?.id || anchor.id || anchor.from}`;
  const emptyDraftStart = (state: EditorState) => emptyConversationDraftStart(state,
    readConversationRoleBlocks(state, configuredEditorRoles().prefixes));
  const buildCards = (state: EditorState) => {
    const decorations = publicDocumentAnchors(state.doc.toString()).map((anchor: Anchor) =>
      Decoration.replace({ block: true, widget: new RecordedCardWidget(anchor, getCard(anchor),
        expanded.has(keyFor(anchor)), () => {
          const key = keyFor(anchor);
          if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
          view.dispatch({ effects: refreshCards.of(null) });
        }, panel.rootEl.dataset.panelId!) }).range(anchor.from, anchor.to));
    const draft = emptyDraftStart(state);
    if (draft != null && draft < state.doc.length) decorations.push(
      Decoration.replace({ block: true }).range(Math.max(0, draft - 1), state.doc.length));
    return Decoration.set(decorations, true);
  };
  const cards = StateField.define({
    create: buildCards,
    update: (value, tr) => tr.docChanged || tr.effects.some(effect => effect.is(refreshCards)) ? buildCards(tr.state) : value,
    provide: field => EditorView.decorations.from(field)
  });
  panel.tabsBarEl.hidden = true; panel.editorHostEl.replaceChildren();
  panel.pathEl.classList.add("public-reader-title");
  const canvas = document.createElement("div"); canvas.className = "public-reader-canvas zion-editor-slot";
  panel.editorHostEl.appendChild(canvas);
  const surface = createEditorPanelSurface(canvas, current.markdown, panel.rootEl.dataset.panelId!, {
    readOnly: true, untrustedContent: true, documentId: options.path,
    imageUrl: options.imageUrl || (source => /^zion-asset:\/\/[A-Za-z0-9_-]{1,256}$/.test(source)
      ? `${options.path}/assets/${source.slice(13)}` : null),
    extensions: [cards], i18n: options.i18n,
    searchProvider: {
      text: () => {
        const draft = emptyDraftStart(view.state);
        return current.markdown.slice(0, draft ?? undefined).replace(/<!--[\s\S]*?-->/g, value => " ".repeat(value.length));
      },
      extra: (query, searchOptions) => {
        const ranges: SurfaceSearchMatch[] = [];
        if (query) for (const anchor of publicDocumentAnchors(current.markdown) as Anchor[]) {
          const card = getCard(anchor), body = `${card?.text || ""}\n${valueText(card?.args)}\n${valueText(card?.result)}`;
          if (card && computeConversationSearchMatches(body, query, searchOptions).ranges.length)
            ranges.push({ from: anchor.from, to: anchor.to, text: body, cardId: keyFor(anchor) });
        }
        return ranges;
      },
      reveal: match => { if (match.cardId) { expanded.add(match.cardId); view.dispatch({ effects: refreshCards.of(null) }); } }
    }
  });
  const core = surface.core; view = core.view;
  core.setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const outlineButton = mountEditorHeaderOutlineButton(panel.pathEl, () => {
    surface.outline?.toggle(); outlineButton.setAttribute("aria-expanded", String(surface.outline?.isOpen()));
  });
  outlineButton.dataset.action = "outline";
  const actions = document.createElement("nav"); actions.className = "public-reader-actions"; actions.setAttribute("aria-label", "阅读操作");
  const action = (id: string, title: string, icon: string) => {
    const button = createEditorHeaderAction(title, icon); button.dataset.action = id; actions.appendChild(button); return button;
  };
  action("find", "搜索（⌘/Ctrl+F）", "search").onclick = () => surface.search?.show();
  action("copy", "复制内容", "copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(current.markdown.slice(0, emptyDraftStart(view.state) ?? undefined).replace(/<!--[\s\S]*?-->/g, "").trim());
      options.notify("内容已复制");
    } catch { options.notify("复制失败，请选中正文后复制"); }
  };
  const refreshButton = action("refresh", "刷新", "refresh-cw"); refreshButton.onclick = options.refresh;
  panel.headerEl.appendChild(actions);
  const participantHeader = options.participants ? mountParticipantsHeader(panel.headerEl, options.participants) : undefined;
  const menu = mountEditorDisplayMenu(panel.headerEl, surface.host, options.path);
  const splitMenu = mountEditorHeaderSplitMenu(panel.pathEl, options.split); splitMenu.button.dataset.action = "split";
  const closeButton = createEditorHeaderAction("关闭分屏", "x"); closeButton.dataset.action = "close-panel";
  closeButton.hidden = true; closeButton.onclick = options.close; panel.headerEl.appendChild(closeButton);
  const renderHeader = () => { panel.pathEl.textContent = current.title; panel.pathEl.title = current.title; };
  renderHeader();
  return {
    core, view, showFind: () => surface.search?.show(),
    nextMatch: (delta: number) => surface.commands?.executeCommand(delta < 0 ? "searchReplace.prev" : "searchReplace.next"),
    toggleGroup: () => surface.commands?.executeCommand("toc.toggleGroupByRole"),
    toggleVim: menu.toggleVim,
    isFindVisible: () => surface.search?.panel?.style.display === "block",
    update(value: PublicDocument) {
      if (disposed) return;
      current = value; core.updateReadOnlyContent(value.markdown, [refreshCards.of(null)]);
      renderHeader(); surface.search?.refresh();
    },
    setCloseVisible: (visible: boolean) => { closeButton.hidden = !visible; },
    setRefreshing: (value: boolean) => { refreshButton.disabled = value; },
    dispose() {
      if (disposed) return; disposed = true; participantHeader?.dispose(); menu.dispose(); splitMenu.dispose(); surface.dispose(); panel.rootEl.replaceChildren();
    }
  };
}
