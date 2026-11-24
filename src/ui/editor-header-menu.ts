import { zionIconHtml } from "./icons";
import "./context-menu.css";
import { displayPreferenceStorage, subscribeDisplayPreferences } from "../editor/display-preferences";

export type EditorHeaderMenuItem = {
  id: string; title?: string; section?: string; order?: number;
  kind?: "action" | "toggle" | "separator";
  command?: string; args?: any[];
  onClick?: (context: { panelId: string; sessionId: string }) => void;
  getChecked?: () => boolean;
};
type MenuHost = {
  list(): EditorHeaderMenuItem[];
  context(): { panelId: string; sessionId: string };
  execute?(command: string, ...args: any[]): void;
};
const mounts = new WeakMap<HTMLElement, { dispose(): void }>();

/** Workbench's original grouped header menu, with the contribution host supplied
 * explicitly so the same renderer can be used by a reading-only surface. */
export function mountEditorHeaderMenu(headerEl: HTMLElement, registry: MenuHost) {
  mounts.get(headerEl)?.dispose();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "zion-editor-header-action is-icon zion-editor-settings-menu-button";
  btn.innerHTML = zionIconHtml("more-horizontal");
  btn.title = "设置";
  btn.setAttribute("aria-label", "设置");
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("data-zion-editor-settings-menu-button", "1");
  btn.dataset.action = "settings";
  btn.style.marginRight = "0";
  let menuEl: HTMLDivElement | null = null;
  let context = registry.context();
  let cleanup: (() => void) | null = null;
  let collapsedSections: Record<string, boolean> = {};
  const COLLAPSE_KEY = "zion.editorHeaderMenu.collapsedSections";
  const closeMenu = () => {
    cleanup?.(); cleanup = null; menuEl?.remove(); menuEl = null;
    btn.setAttribute("aria-expanded", "false");
  };
  const loadCollapsed = () => {
    collapsedSections = {};
    try {
      const value = JSON.parse(displayPreferenceStorage.getItem(COLLAPSE_KEY) || "{}");
      if (value && typeof value === "object") collapsedSections = value;
    } catch {}
  };
  const positionMenu = () => {
    if (!menuEl) return;
    const r = btn.getBoundingClientRect();
    const mw = menuEl.offsetWidth || 200, mh = menuEl.offsetHeight || 120, pad = 8;
    const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
    let left = Math.round(r.right - mw), top = Math.round(r.bottom + 6);
    left = Math.max(pad, Math.min(left, Math.max(pad, vw - mw - pad)));
    if (top + mh + pad > vh) {
      const above = Math.round(r.top - 6 - mh);
      if (above >= pad) top = above;
    }
    top = Math.max(pad, Math.min(top, Math.max(pad, vh - mh - pad)));
    menuEl.style.left = `${left}px`; menuEl.style.top = `${top}px`;
  };
  const renderMenu = () => {
    if (!menuEl) return;
    menuEl.replaceChildren();
    const items = registry.list();
    if (!items.length) {
      const row = document.createElement("div"), item = document.createElement("button");
      row.className = "zion-context-menu-row"; item.className = "zion-context-menu-item";
      item.type = "button"; item.textContent = "暂无设置项"; item.disabled = true;
      row.appendChild(item); menuEl.appendChild(row); return;
    }
    const groups = new Map<string, EditorHeaderMenuItem[]>();
    for (const item of items.filter(item => item && item.kind !== "separator")) {
      const section = String(item.section || "Other").trim() || "Other";
      if (!groups.has(section)) groups.set(section, []);
      groups.get(section)!.push(item);
    }
    const sectionOrderHint = ["分享与权限", "Editor", "Layout", "Chat", "Export", "Other"];
    const sections = [...groups.keys()].sort((a, b) => {
      const ai = sectionOrderHint.indexOf(a), bi = sectionOrderHint.indexOf(b);
      return ai !== -1 || bi !== -1 ? ai === -1 ? 1 : bi === -1 ? -1 : ai - bi : a.localeCompare(b);
    });
    for (const sec of sections) {
      const secItems = groups.get(sec)!.slice().sort((a, b) =>
        (a.order ?? 50) - (b.order ?? 50) || a.id.localeCompare(b.id));
      const collapsed = !!collapsedSections[sec];
      const secRow = document.createElement("div"), secBtn = document.createElement("button");
      secRow.className = "zion-context-menu-row";
      secBtn.className = "zion-context-menu-item zion-editor-header-menu-section";
      secBtn.type = "button"; secBtn.title = sec;
      const content = document.createElement("span");
      content.className = "zion-editor-header-menu-section-content";
      content.innerHTML = zionIconHtml(collapsed ? "chevron-right" : "chevron-down", "zion-editor-header-menu-chevron zion-icon-sm");
      const title = document.createElement("span");
      title.className = "zion-editor-header-menu-section-title"; title.textContent = sec;
      content.appendChild(title); secBtn.appendChild(content);
      secBtn.onclick = event => {
        event.stopPropagation(); collapsedSections[sec] = !collapsed;
        displayPreferenceStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedSections));
        renderMenu(); positionMenu();
      };
      secRow.appendChild(secBtn); menuEl.appendChild(secRow);
      if (collapsed) continue;
      for (const item of secItems) {
        const checked = item.kind === "toggle" && !!item.getChecked?.();
        const row = document.createElement("div"), button = document.createElement("button");
        row.className = "zion-context-menu-row";
        button.className = "zion-context-menu-item zion-editor-header-menu-item";
        button.type = "button"; button.title = String(item.title || item.id);
        if (item.kind === "toggle") {
          button.setAttribute("role", "menuitemcheckbox"); button.setAttribute("aria-checked", String(checked));
        } else button.setAttribute("role", "menuitem");
        button.innerHTML = `<span class="zion-editor-header-menu-item-content"><span class="zion-editor-header-menu-item-left"><span class="zion-editor-header-menu-item-title"></span></span><span class="zion-editor-header-menu-item-state ${item.kind === "toggle" ? `is-toggle${checked ? " is-checked" : ""}` : "is-placeholder"}">${zionIconHtml("check", "zion-icon-sm")}</span></span>`;
        button.querySelector(".zion-editor-header-menu-item-title")!.textContent = button.title;
        button.onclick = event => {
          event.stopPropagation();
          const selectedContext = context;
          if (item.kind !== "toggle") closeMenu();
          if (item.onClick) item.onClick(selectedContext);
          else if (item.command) registry.execute?.(item.command, ...(item.args || []));
          renderMenu(); positionMenu();
        };
        row.appendChild(button); menuEl.appendChild(row);
      }
    }
  };
  const openMenu = () => {
    if (menuEl) return;
    context = registry.context(); loadCollapsed();
    const menu = document.createElement("div");
    menu.className = "zion-context-menu zion-editor-header-menu"; menu.setAttribute("role", "menu");
    Object.assign(menu.style, { position: "fixed", zIndex: "99999", maxWidth: "280px",
      width: "min(280px, calc(100vw - 16px))", maxHeight: "70vh", overflowY: "auto" });
    document.body.appendChild(menu); menuEl = menu;
    btn.setAttribute("aria-expanded", "true"); renderMenu(); positionMenu();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { closeMenu(); btn.focus(); } };
    const outside = (event: MouseEvent) => {
      if (!menuEl?.contains(event.target as Node) && !btn.contains(event.target as Node)) closeMenu();
    };
    const resize = () => { renderMenu(); positionMenu(); };
    document.addEventListener("keydown", escape); document.addEventListener("mousedown", outside, true);
    window.addEventListener("resize", resize, { passive: true });
    const subscription = subscribeDisplayPreferences(resize);
    cleanup = () => {
      document.removeEventListener("keydown", escape); document.removeEventListener("mousedown", outside, true);
      window.removeEventListener("resize", resize); subscription.dispose();
    };
  };
  btn.onclick = event => { event.stopPropagation(); if (menuEl) closeMenu(); else openMenu(); };
  headerEl.appendChild(btn);
  const mounted = { dispose() {
    closeMenu(); btn.remove(); window.removeEventListener("pagehide", mounted.dispose); mounts.delete(headerEl);
  } };
  window.addEventListener("pagehide", mounted.dispose); mounts.set(headerEl, mounted);
  return mounted;
}
