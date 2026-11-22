import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPublicReader, type PublicDocument } from "../src/public-reader/reader";
import { PanelManager, createPanelDomShell } from "../src/panel/PanelManager";
import { mountEditorHeaderOutlineButton, mountEditorHeaderSplitMenu } from "../src/ui/editor-header";

const path = `/share/${"a".repeat(43)}`;
const value = (overrides: Partial<PublicDocument> = {}): PublicDocument => ({
  state: "read", title: "一起做旅行计划", markdown: "user 问题\nassistant Alpha alpha\n# 行程",
  mode: "public", role: null, cards: { tools: [], thinking: [] }, ...overrides
});
const disposers: (() => void)[] = [];
const mount = (options = {}) => {
  const host = document.createElement("div"); document.body.appendChild(host);
  const reader = mountPublicReader(host, value(), { path, ...options });
  disposers.push(reader.dispose); return { host, reader };
};
const click = (host: ParentNode, selector: string) => host.querySelector<HTMLButtonElement>(selector)!.click();
const chooseSplit = (host: ParentNode, index = 0) => {
  click(host, '[data-action="split"]');
  document.querySelectorAll<HTMLButtonElement>(".zion-editor-header-split-menu button")[index].click();
};
afterEach(() => {
  disposers.splice(0).reverse().forEach(dispose => dispose());
  document.body.replaceChildren(); vi.restoreAllMocks();
});

describe("shared editor header and production brand", () => {
  it("places the native TOC directly before the title and uses the identical split button and menu", () => {
    const native = createPanelDomShell("native-header"); document.body.appendChild(native.rootEl);
    const outline = mountEditorHeaderOutlineButton(native.pathEl, vi.fn());
    const split = mountEditorHeaderSplitMenu(native.pathEl, vi.fn()); disposers.push(split.dispose);
    const { host } = mount();
    const header = host.querySelector(".zion-editor-header")!;
    const publicOutline = header.querySelector<HTMLElement>("[data-zion-editor-toc-button]")!;
    const title = header.querySelector(".zion-editor-session-path");
    expect(publicOutline.nextElementSibling).toBe(title);
    expect(header.firstElementChild).toBe(publicOutline);
    publicOutline.click();
    expect(publicOutline.getAttribute("aria-expanded")).toBe("false");
    expect(publicOutline.className).toBe(outline.className);
    expect(publicOutline.innerHTML).toBe(outline.innerHTML);
    const publicSplit = header.querySelector<HTMLElement>("[data-zion-editor-split-menu-button]")!;
    expect(publicSplit.innerHTML).toBe(split.button.innerHTML);
    expect(publicSplit.className).toBe(split.button.className);
    expect(publicSplit.parentElement).toBe(header);
    split.button.click();
    const nativeMenu = document.querySelector(".zion-editor-header-split-menu")!.innerHTML;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    publicSplit.click();
    expect(document.querySelector(".zion-editor-header-split-menu")!.innerHTML).toBe(nativeMenu);
    const main = readFileSync("src/main.ts", "utf8");
    expect(main).toContain('from "./ui/editor-header"');
    expect(main).toContain("mountEditorHeaderOutlineButton(pathEl,");
    expect(main).toContain("mountEditorHeaderSplitMenu(pathEl,");
  });

  it("shares the exact production SVG with the brand and identical favicon declarations for both entries", () => {
    const { host } = mount();
    const expected = document.createElement("div");
    expected.innerHTML = readFileSync("public/favicon.svg", "utf8");
    const mark = host.querySelector(".public-reader-brand svg")!.cloneNode(true) as Element;
    mark.removeAttribute("aria-hidden");
    expect(mark.outerHTML).toBe(expected.querySelector("svg")!.outerHTML);
    expect(mark.querySelector("circle")?.getAttribute("fill")).toBe("#80acff");
    const icons = (file: string) => [...readFileSync(file, "utf8").matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*>/g)].map(match => match[0]);
    expect(icons("share-reader.html")).toEqual(icons("index.html"));
    expect(icons("index.html")[0]).toContain("/favicon.svg?v=4");
    const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"));
    expect(manifest.icons.map((icon: any) => icon.src)).toEqual(["/zioon-icon-192.png", "/zioon-icon-512.png"]);
    expect(readFileSync("vite.config.ts", "utf8")).toContain('import workbenchManifest from "./public/manifest.json"');
  });

  it("cleans up an open split menu when the header is remounted or disposed", () => {
    const native = createPanelDomShell("native"); document.body.appendChild(native.rootEl);
    const old = mountEditorHeaderSplitMenu(native.pathEl, vi.fn()); old.button.click();
    expect(document.querySelector(".zion-editor-header-split-menu")).toBeTruthy();
    const replacement = mountEditorHeaderSplitMenu(native.pathEl, vi.fn());
    expect(document.querySelector(".zion-editor-header-split-menu")).toBeNull();
    replacement.button.click(); replacement.dispose();
    expect(document.querySelector(".zion-editor-header-split-menu")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
});

describe("read-only native split panes", () => {
  it("splits right and down, resizes with the native handle, keeps per-pane search independent and closes panes", () => {
    const { host, reader } = mount();
    const originalView = reader.view;
    originalView.scrollDOM.scrollTop = 120;
    chooseSplit(host);
    expect(reader.panels).toBeInstanceOf(PanelManager);
    expect(reader.panels.getRoot()).toMatchObject({ type: "split", direction: "horizontal" });
    const panes = [...host.querySelectorAll<HTMLElement>(".zion-panel")];
    expect(panes).toHaveLength(2);
    expect(host.querySelectorAll(".public-reader-brand")).toHaveLength(1);
    expect(reader.view).not.toBe(originalView);
    expect(reader.view.scrollDOM.scrollTop).toBe(120);
    panes[1].focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true }));
    const searchPanels = panes.map(pane => pane.querySelector<HTMLElement>(".search-replace-panel")!);
    expect(searchPanels[0]).toBeNull(); expect(searchPanels[1].style.display).toBe("block");
    const input = searchPanels[1].querySelector<HTMLTextAreaElement>('[data-search-control="search-input"]')!;
    input.value = "alpha"; input.dispatchEvent(new Event("input"));
    searchPanels[1].querySelector<HTMLButtonElement>('[data-search-control="next-btn"]')!.click();
    expect(reader.core.getSelection()).toBe("Alpha");
    expect(originalView.state.selection.main.empty).toBe(true);
    // Wrapped labels must toggle their own pane's controls even with multiple search surfaces.
    const option = searchPanels[1].querySelector<HTMLLabelElement>('[data-option="case-sensitive"]')!;
    option.click();
    expect(searchPanels[1].querySelector<HTMLInputElement>('input[data-search-control="case-sensitive"]')!.checked).toBe(true);
    expect(originalView.state.selection.main.empty).toBe(true);
    const ids = [...host.querySelectorAll<HTMLElement>("[id]")].map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    const container = host.querySelector<HTMLElement>('.zion-split-container[data-direction="horizontal"]')!;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON() {} });
    container.querySelector(".zion-split-handle")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 700 }));
    window.dispatchEvent(new MouseEvent("pointerup"));
    expect(reader.panels.getRoot()).toMatchObject({ ratio: 0.7 });
    chooseSplit(panes[1], 1);
    expect(host.querySelectorAll(".zion-panel")).toHaveLength(3);
    expect(host.querySelector('.zion-split-container[data-direction="vertical"]')).toBeTruthy();
    for (const panel of reader.panels.listPanels()) {
      const view = panel.editor!.getView();
      view.dispatch({ changes: { from: 0, insert: "FORBIDDEN" } });
      expect(view.state.doc.toString()).toBe(value().markdown);
      expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
    }
    click(reader.panels.getActivePanel()!.rootEl, '[data-action="close-panel"]');
    click(reader.panels.getActivePanel()!.rootEl, '[data-action="close-panel"]');
    expect(host.querySelectorAll(".zion-panel")).toHaveLength(1);
    expect(host.querySelector<HTMLButtonElement>('[data-action="close-panel"]')!.hidden).toBe(true);
  });

  it("refreshes all panes once and clears every editor and menu when access is revoked", async () => {
    const refresh = vi.fn().mockResolvedValueOnce(value({ title: "新标题", markdown: "assistant 更新", contentRevision: "2" }))
      .mockResolvedValueOnce({ state: "login" });
    const onAccessLost = vi.fn();
    const { host, reader } = mount({ refresh, onAccessLost });
    chooseSplit(host);
    await reader.refresh();
    expect(refresh).toHaveBeenCalledOnce();
    for (const panel of reader.panels.listPanels()) {
      expect(panel.pathEl.textContent).toBe("新标题");
      expect(panel.editor!.getView().state.doc.toString()).toBe("assistant 更新");
    }
    click(host, '[data-action="split"]');
    await reader.refresh();
    expect(onAccessLost).toHaveBeenCalledOnce();
    expect(host.querySelector(".cm-editor")).toBeNull();
    expect(document.querySelector(".zion-editor-header-split-menu")).toBeNull();
    expect(reader.panels.listPanels()).toEqual([]);
  });
});
