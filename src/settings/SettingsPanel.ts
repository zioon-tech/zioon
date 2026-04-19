/**
 * SettingsPanel — 设置面板 UI
 *
 * modal overlay，按 section 分组渲染已注册的设置项。
 * 调用各 SettingsItem 的 render(container) 委托渲染。
 */

import { settingsRegistry } from "./registry";

const STYLE_ID = "zion-settings-panel-styles";

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.zion-settings-mask{position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.38);display:none;align-items:flex-start;justify-content:center;padding-top:8vh}
:root[data-theme="light"] .zion-settings-mask{background:rgba(0,0,0,.18)}
.zion-settings-panel{width:min(640px,calc(100vw - 24px));max-height:min(560px,calc(100vh - 24px));background:var(--panel,var(--bg,#1e1e1e));border:1px solid var(--border,#3c3c3c);border-radius:10px;box-shadow:0 18px 70px rgba(0,0,0,.45);overflow:hidden;font-family:var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif);font-size:13px;display:flex;flex-direction:column}
.zion-settings-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border,#3c3c3c);flex-shrink:0}
.zion-settings-title{font-weight:600;font-size:14px;color:var(--fg,#cccccc)}
.zion-settings-close{background:none;border:1px solid var(--border,#3c3c3c);border-radius:6px;color:var(--fg,#cccccc);cursor:pointer;font-size:16px;line-height:1;padding:2px 8px;opacity:.7;transition:opacity .1s}
.zion-settings-close:hover{opacity:1}
.zion-settings-body{flex:1;min-height:0;overflow:auto;padding:16px;scrollbar-color:transparent transparent;scrollbar-width:thin}
.zion-settings-body:hover{scrollbar-color:var(--scrollbar-thumb,var(--border,#44475a)) transparent}
.zion-settings-body::-webkit-scrollbar{width:10px;height:10px}
.zion-settings-body::-webkit-scrollbar-track{background:transparent}
.zion-settings-body::-webkit-scrollbar-thumb{background:transparent;border-radius:6px;border:2px solid transparent;background-clip:content-box;transition:background .15s ease}
.zion-settings-body:hover::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb,var(--border,#44475a));background-clip:content-box}
.zion-settings-section{margin-bottom:16px}
.zion-settings-section:last-child{margin-bottom:0}
.zion-settings-section-title{font-weight:600;font-size:12px;color:var(--fg,#cccccc);opacity:.7;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border,#3c3c3c)}
.zion-settings-item{margin-bottom:12px;padding:8px 12px;border:1px solid var(--border,#3c3c3c);border-radius:8px;background:rgba(255,255,255,.02)}
:root[data-theme="light"] .zion-settings-item{background:rgba(0,0,0,.02)}
.zion-settings-item:last-child{margin-bottom:0}
.zion-settings-item-title{font-weight:550;font-size:12px;color:var(--fg,#cccccc);margin-bottom:6px;opacity:.85}
.zion-settings-item-content{min-height:0}
.zion-settings-empty{padding:24px;text-align:center;opacity:.5;color:var(--fg,#cccccc)}
  `;
  document.head.appendChild(style);
}

let panelCreated = false;
let maskEl: HTMLDivElement | null = null;
let panelEl: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let isOpen = false;
const itemDisposables = new Map<string, { dispose?: () => void } | null>();
let changeDisp: { dispose(): void } | null = null;

function ensurePanel() {
  if (panelCreated) return;
  panelCreated = true;
  injectStyles();

  maskEl = document.createElement("div");
  maskEl.className = "zion-settings-mask";

  panelEl = document.createElement("div");
  panelEl.className = "zion-settings-panel";

  // Header
  const header = document.createElement("div");
  header.className = "zion-settings-header";
  const title = document.createElement("div");
  title.className = "zion-settings-title";
  title.textContent = "设置";
  const closeBtn = document.createElement("button");
  closeBtn.className = "zion-settings-close";
  closeBtn.textContent = "Esc";
  closeBtn.onclick = () => close();
  header.appendChild(title);
  header.appendChild(closeBtn);

  // Body
  bodyEl = document.createElement("div");
  bodyEl.className = "zion-settings-body";

  panelEl.appendChild(header);
  panelEl.appendChild(bodyEl);
  maskEl.appendChild(panelEl);
  document.body.appendChild(maskEl);

  // Click mask to close
  maskEl.addEventListener("mousedown", (e) => {
    if (e.target === maskEl) close();
  });

  // Listen for registry changes while open
  changeDisp = settingsRegistry.onDidChange(() => {
    if (isOpen) renderItems();
  });
}

function disposeAllItems() {
  for (const [, disp] of itemDisposables) {
    try { disp?.dispose?.(); } catch {}
  }
  itemDisposables.clear();
}

function renderItems() {
  if (!bodyEl) return;
  disposeAllItems();
  bodyEl.innerHTML = "";

  const sections = settingsRegistry.getSections();
  if (sections.length === 0) {
    const empty = document.createElement("div");
    empty.className = "zion-settings-empty";
    empty.textContent = "暂无可用设置项";
    bodyEl.appendChild(empty);
    return;
  }

  for (const { section, items } of sections) {
    const sectionEl = document.createElement("div");
    sectionEl.className = "zion-settings-section";

    const sectionTitle = document.createElement("div");
    sectionTitle.className = "zion-settings-section-title";
    sectionTitle.textContent = section;
    sectionEl.appendChild(sectionTitle);

    for (const item of items) {
      const itemEl = document.createElement("div");
      itemEl.className = "zion-settings-item";

      const itemTitle = document.createElement("div");
      itemTitle.className = "zion-settings-item-title";
      itemTitle.textContent = item.title;
      itemEl.appendChild(itemTitle);

      const itemContent = document.createElement("div");
      itemContent.className = "zion-settings-item-content";
      itemEl.appendChild(itemContent);

      try {
        const disp = item.render(itemContent);
        itemDisposables.set(item.id, disp ?? null);
      } catch (err) {
        const errEl = document.createElement("div");
        errEl.style.color = "#ff6b6b";
        errEl.style.fontSize = "12px";
        errEl.textContent = `渲染失败: ${err instanceof Error ? err.message : String(err)}`;
        itemContent.appendChild(errEl);
      }

      sectionEl.appendChild(itemEl);
    }

    bodyEl.appendChild(sectionEl);
  }
}

export function open() {
  ensurePanel();
  if (!maskEl || isOpen) return;
  isOpen = true;
  renderItems();
  maskEl.style.display = "flex";
  // ESC to close
  document.addEventListener("keydown", onKeyDown);
}

export function close() {
  if (!maskEl || !isOpen) return;
  isOpen = false;
  maskEl.style.display = "none";
  disposeAllItems();
  document.removeEventListener("keydown", onKeyDown);
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}
