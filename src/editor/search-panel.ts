import { EditorState } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";

/** Shared workbench search surface. Read-only readers omit the replace controls. */
export function createConversationSearchPanel(options: {
  readOnly?: boolean;
  idPrefix?: string;
  translate?: (key: string, fallback: string) => string;
} = {}) {
  const t = options.translate || ((_key: string, fallback: string) => fallback);
  const panel = document.createElement("div");
  panel.className = "search-replace-panel";
  panel.style.cssText = `
    position: absolute; top: 8px; right: 12px; left: auto; transform: none;
    background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px; box-shadow: var(--elevation-2); z-index: 10000;
    font-family: var(--font-sans); font-size: 13px;
    min-width: min(440px, calc(100% - 24px)); max-width: calc(100% - 24px);
  `;
  // Only fixed markup enters innerHTML. Localized labels are set below as text.
  panel.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
      <textarea id="search-input" rows="1"></textarea>
      <span id="match-count" role="status" style="color:var(--fg-secondary);font-size:12px;"></span>
      <button id="toggle-replace-btn">▾</button>
      <button id="prev-btn">↑</button><button id="next-btn">↓</button>
      <button id="select-all-btn"></button><button id="close-btn">×</button>
    </div>
    <div id="replace-section" style="display:none;margin-top:8px;">
      <div style="display:flex;gap:8px;align-items:center;">
        <textarea id="replace-input" rows="1"></textarea>
        <button id="replace-btn"></button><button id="replace-all-btn"></button>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:8px;align-items:center;">
      <label data-option="case-sensitive"><input type="checkbox" id="case-sensitive"/><span>Aa</span></label>
      <label data-option="whole-word"><input type="checkbox" id="whole-word"/><span>⎵</span></label>
      <label data-option="regex"><input type="checkbox" id="regex"/><span>.*</span></label>
    </div>`;
  panel.querySelectorAll<HTMLTextAreaElement>("textarea").forEach(input => {
    input.style.cssText = "flex:1;min-width:0;max-height:80px;resize:none;padding:6px 8px;border:1px solid var(--border);background:var(--input-bg,var(--panel));color:var(--fg);border-radius:4px;font-family:inherit;font-size:inherit;overflow:hidden;";
    input.placeholder = input.id === "search-input" ? t("ui.search", "Search") : t("ui.replace", "Replace");
    input.setAttribute("aria-label", input.placeholder);
  });
  const titles: Record<string, [string, string]> = {
    "toggle-replace-btn": ["ui.showReplace", "Show replace"],
    "prev-btn": ["ui.prev", "Previous Match"], "next-btn": ["ui.next", "Next Match"],
    "select-all-btn": ["ui.selectAll", "Select All Matches"], "close-btn": ["ui.close", "Close"]
  };
  panel.querySelectorAll<HTMLButtonElement>("button").forEach(button => {
    button.type = "button";
    button.style.cssText = "background:none;border:1px solid var(--border);color:var(--fg);cursor:pointer;padding:2px 6px;border-radius:4px;font-size:12px;";
    if (titles[button.id]) {
      button.title = t(...titles[button.id]);
      button.setAttribute("aria-label", button.title);
    }
  });
  panel.querySelector<HTMLElement>("#close-btn")!.style.border = "none";
  panel.querySelector<HTMLElement>("#select-all-btn")!.textContent = t("ui.all", "All");
  panel.querySelector<HTMLElement>("#replace-btn")!.textContent = t("ui.replaceCurrent", "Replace");
  panel.querySelector<HTMLElement>("#replace-btn")!.style.cssText = "padding:4px 8px;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;";
  panel.querySelector<HTMLElement>("#replace-all-btn")!.textContent = t("ui.all", "All");
  panel.querySelector<HTMLElement>("#replace-all-btn")!.style.cssText = "padding:4px 8px;background:var(--border);color:var(--fg);border:none;border-radius:4px;cursor:pointer;font-size:12px;";
  const optionTitles: Record<string, [string, string]> = {
    "case-sensitive": ["ui.matchCase", "Match case"], "whole-word": ["ui.wholeWord", "Whole word"],
    regex: ["ui.regex", "Regex"]
  };
  panel.querySelectorAll<HTMLLabelElement>("label").forEach(label => {
    label.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;";
    label.querySelector<HTMLElement>("span")!.style.cssText = "font-size:12px;opacity:.9;";
    label.title = t(...optionTitles[label.dataset.option!]);
    label.querySelector("input")!.setAttribute("aria-label", label.title);
  });
  if (options.readOnly) {
    panel.querySelector("#toggle-replace-btn")!.remove();
    panel.querySelector("#replace-section")!.remove();
  }
  panel.querySelectorAll<HTMLElement>("[id]").forEach(control => {
    control.dataset.searchControl = control.id;
    if (options.idPrefix) control.id = `${options.idPrefix}-${control.id}`;
  });
  return panel;
}

export type ConversationSearchOptions = { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean };
export type ConversationSearchMatch = { from: number; to: number; text: string };
export function computeConversationSearchMatches(text: string, query: string, options: ConversationSearchOptions = {}) {
  const ranges: ConversationSearchMatch[] = [];
  if (!query) return { ranges, invalid: false };
  const search = new SearchQuery({ search: query, caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord, regexp: options.regex });
  if (!search.valid) return { ranges, invalid: true };
  const cursor = search.getCursor(EditorState.create({ doc: text }));
  for (let result = cursor.next(); !result.done; result = cursor.next()) {
    const { from, to } = result.value;
    if (to > from) ranges.push({ from, to, text: text.slice(from, to) });
  }
  return { ranges, invalid: false };
}
