import { zionIconHtml } from "./icons";
import type { SplitDirection } from "../panel/types";

export function createEditorHeaderAction(title: string, icon: string, extraClass = "", size = 16) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `zion-editor-header-action is-icon${extraClass ? ` ${extraClass}` : ""}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = zionIconHtml(icon, "", size);
  return button;
}

export function mountEditorHeaderOutlineButton(pathEl: HTMLElement, onClick: () => void) {
  const header = pathEl.parentElement!;
  let button = header.querySelector<HTMLButtonElement>("[data-zion-editor-toc-button='1']");
  if (!button) {
    button = createEditorHeaderAction("目录", "list-tree", "zion-editor-toc-button");
    button.dataset.zionEditorTocButton = "1";
  }
  button.onclick = event => { event.stopPropagation(); onClick(); };
  header.insertBefore(button, pathEl);
  return button;
}

const splitMenus = new WeakMap<HTMLButtonElement, () => void>();
export function mountEditorHeaderSplitMenu(pathEl: HTMLElement, split: (direction: SplitDirection) => void) {
  const header = pathEl.parentElement!;
  let button = header.querySelector<HTMLButtonElement>("[data-zion-editor-split-menu-button='1']");
  if (!button) {
    button = createEditorHeaderAction("分屏", "columns-2", "zion-editor-split-menu-button");
    button.dataset.zionEditorSplitMenuButton = "1";
    const settings = header.querySelector("[data-zion-editor-settings-menu-button='1']");
    if (settings) header.insertBefore(button, settings); else header.appendChild(button);
  }
  splitMenus.get(button)?.();
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  let menu: HTMLDivElement | null = null;
  let cleanup: (() => void) | null = null;
  const close = () => {
    cleanup?.(); cleanup = null;
    menu?.remove(); menu = null;
    button.setAttribute("aria-expanded", "false");
  };
  const position = () => {
    if (!menu) return;
    const r = button.getBoundingClientRect(), mw = menu.offsetWidth || 180, mh = menu.offsetHeight || 96;
    const pad = 8, vw = window.innerWidth, vh = window.innerHeight;
    let left = Math.round(r.right - mw), top = Math.round(r.bottom + 6);
    left = Math.max(pad, Math.min(left, Math.max(pad, vw - mw - pad)));
    if (top + mh + pad > vh && r.top - 6 - mh >= pad) top = Math.round(r.top - 6 - mh);
    top = Math.max(pad, Math.min(top, Math.max(pad, vh - mh - pad)));
    menu.style.left = `${left}px`; menu.style.top = `${top}px`;
  };
  const open = () => {
    menu = document.createElement("div");
    menu.className = "zion-context-menu zion-editor-header-session-menu zion-editor-header-split-menu";
    menu.setAttribute("role", "menu");
    Object.assign(menu.style, { position: "fixed", zIndex: "99999", minWidth: "180px" });
    document.body.appendChild(menu);
    for (const [label, title, direction] of [
      ["向右分屏", "在右侧打开当前会话的新分屏", "horizontal"],
      ["向下分屏", "在下方打开当前会话的新分屏", "vertical"]
    ] as const) {
      const row = document.createElement("div"); row.className = "zion-context-menu-row";
      const item = document.createElement("button");
      item.type = "button"; item.className = "zion-context-menu-item";
      item.textContent = label; item.title = title; item.setAttribute("role", "menuitem");
      item.onclick = event => {
        event.stopPropagation(); close(); split(direction);
      };
      row.appendChild(item); menu.appendChild(row);
    }
    button.setAttribute("aria-expanded", "true");
    position();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { close(); button.focus(); }
    };
    const clickAway = (event: MouseEvent) => {
      if (!menu?.contains(event.target as Node) && !button.contains(event.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", clickAway, true);
    window.addEventListener("resize", position, { passive: true });
    cleanup = () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", clickAway, true);
      window.removeEventListener("resize", position);
    };
  };
  button.onclick = event => {
    event.stopPropagation(); event.preventDefault();
    if (menu) close(); else open();
  };
  const dispose = () => { close(); button.onclick = null; splitMenus.delete(button); };
  splitMenus.set(button, dispose);
  return { button, dispose };
}
