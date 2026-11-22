import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { createEditorPanelSurface } from "../src/editor/editor-panel-surface";
import { displayPreferenceStorage, readDisplayPreference, setDisplayPreferenceViewer } from "../src/editor/display-preferences";
import { mountPublicReader, type PublicDocument } from "../src/public-reader/reader";
import { computeConversationSearchMatches } from "../src/editor/search-panel";
import { SearchQuery } from "@codemirror/search";
import { mountEditorHeaderMenu } from "../src/ui/editor-header-menu";
import { editorConfigurationMenuItems, editorCoreMenuItems } from "../src/ui/editor-display-contributions.js";
import { readMinimapPreference } from "../src/editor/display-preferences";
import { registerDisplayDocumentAlias } from "../src/editor/display-preferences";
const disposers: Array<() => void> = [];
const source = "user 问题\n第一段\nassistant 回答\n正文\nuser 后续提问\n正文";
const payload = (markdown = source): PublicDocument => ({
  state: "read", title: "面板对照", markdown, mode: "public", role: null, cards: { tools: [], thinking: [] }
});
function mount(markdown = source) {
  const host = document.createElement("div"); document.body.appendChild(host);
  const reader = mountPublicReader(host, payload(markdown), { path: `/share/${"a".repeat(43)}` });
  disposers.push(reader.dispose); return { reader, host };
}
afterEach(() => {
  disposers.splice(0).reverse().forEach(dispose => dispose());
  document.body.replaceChildren(); localStorage.clear(); setDisplayPreferenceViewer("");
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe("shared editor surface through real DOM interactions", () => {
  it("shares a document override between native IDs and link aliases, reapplies on session changes and isolates documents and viewers", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    setDisplayPreferenceViewer("viewer");
    const identity = `document:${"a".repeat(64)}`, otherIdentity = `document:${"b".repeat(64)}`;
    registerDisplayDocumentAlias("session", identity, "1");
    registerDisplayDocumentAlias("same-id-other-space", otherIdentity);
    const node = document.createElement("div"); document.body.append(node);
    const native = createEditorPanelSurface(node, source, "native"); disposers.push(native.dispose);
    native.core.setSessionId("session");
    expect(node.querySelector(".cm-minimap-gutter")).toBeTruthy();
    const host = document.createElement("div"); document.body.append(host);
    const path = `/share/${"c".repeat(43)}`;
    const reader = mountPublicReader(host, { ...payload(), displayIdentity: identity }, { path });
    disposers.push(reader.dispose);
    expect(host.querySelector(".cm-minimap-gutter")).toBeTruthy();
    displayPreferenceStorage.setItem(`zion.minimap.session.${path}`, "0");
    expect(node.querySelector(".cm-minimap-gutter")).toBeNull();
    expect(readMinimapPreference("same-id-other-space")).toBe(false);
    displayPreferenceStorage.setItem(`zion.minimap.session.${identity}`, "1");
    native.core.setSessionId("draft");
    expect(node.querySelector(".cm-minimap-gutter")).toBeNull();
    native.core.setSessionId("session");
    expect(node.querySelector(".cm-minimap-gutter")).toBeTruthy();
    setDisplayPreferenceViewer("other-viewer");
    expect(readMinimapPreference(identity)).toBe(false);
    expect(host.querySelector(".cm-minimap-gutter")).toBeNull();
  });
  it("uses the original grouped menu and config controls in both headers, synchronizes changes and releases open controls", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const nativeHost = document.createElement("div"); document.body.appendChild(nativeHost);
    const native = createEditorPanelSurface(nativeHost, source, "native", { readOnly: true, documentId: "native" });
    disposers.push(native.dispose);
    const header = document.createElement("header"); document.body.appendChild(header);
    const nativeMenu = mountEditorHeaderMenu(header, {
      list: () => [...editorConfigurationMenuItems(native.host), ...editorCoreMenuItems(native.host)],
      context: () => ({ panelId: "native", sessionId: "native" })
    });
    disposers.push(nativeMenu.dispose);
    const { host, reader } = mount();
    host.querySelector<HTMLButtonElement>('[data-action="settings"]')!.click();
    let menu = document.querySelector<HTMLElement>(".zion-editor-header-menu")!;
    expect(menu.classList.contains("zion-context-menu")).toBe(true);
    expect([...menu.querySelectorAll(".zion-editor-header-menu-section-title")].map(item => item.textContent)).toEqual(["Editor", "Layout", "Chat"]);
    const byTitle = (title: string) => [...document.querySelectorAll<HTMLButtonElement>(".zion-editor-header-menu-item")].find(item => item.title === title)!;
    byTitle("Line Numbers").click();
    expect(host.querySelector(".cm-lineNumbers")).toBeTruthy();
    expect(native.core.view.dom.querySelector(".cm-lineNumbers")).toBeTruthy();
    byTitle("Keep Focused Line Rendered").click();
    expect(readDisplayPreference("zion.wysiwyg.keepActiveLineRendered")).toBe(false);
    byTitle("Minimap").click();
    expect(readMinimapPreference(`/share/${"a".repeat(43)}`)).toBe(true);
    expect(byTitle("Minimap").getAttribute("aria-checked")).toBe("true");
    reader.panels.splitPanel(reader.panels.getActivePanelId()!, "horizontal");
    expect(host.querySelectorAll(".cm-minimap-gutter")).toHaveLength(2);
    byTitle("Editor Config…").click();
    await vi.waitFor(() => expect(document.querySelector("#dev-editor-config-panel .zion-settings-item")).toBeTruthy());
    const control = document.querySelector<HTMLInputElement>('[title="editor.appearance.fontSize"] input')!;
    await vi.waitFor(() => expect(control.disabled).toBe(false));
    control.focus(); control.value = "18"; control.dispatchEvent(new Event("input", { bubbles: true }));
    displayPreferenceStorage.setItem("zion.editor.fontSize", "20");
    await vi.waitFor(() => expect(control.value).toBe("20"));
    expect(document.activeElement).toBe(control);
    reader.dispose();
    expect(document.querySelector("#dev-editor-config-panel")).toBeNull();
    expect(document.querySelector(".zion-editor-header-menu")).toBeNull();
    header.querySelector<HTMLButtonElement>("button")!.click();
    menu = document.querySelector(".zion-editor-header-menu")!;
    expect(byTitle("Line Numbers").getAttribute("aria-checked")).toBe("true");
  });
  it("updates custom roles after opening and coordinates Vim selections across the same panel surface", async () => {
    const { host, reader } = mount("user First\ncritic More\nassistant Last");
    displayPreferenceStorage.setItem("zion.roles.prefixes", '["tool","critic"]');
    displayPreferenceStorage.setItem("zion.toc.groupByRole", "1");
    await vi.waitFor(() => expect(host.querySelectorAll('[data-toc-kind="block"]')).toHaveLength(3));
    displayPreferenceStorage.setItem("zion.vimMode", "1");
    reader.panels.splitPanel(reader.panels.getActivePanelId()!, "horizontal");
    const cm = getCM(reader.view)!;
    Vim.handleKey(cm, "v"); Vim.handleKey(cm, "l");
    expect(reader.view.state.selection.main.empty).toBe(false);
    Vim.handleKey(cm, "<Esc>");
    expect(reader.core.getValue()).toBe("user First\ncritic More\nassistant Last");
  });
  it("applies the same display settings to native, readonly and later split cores without enabling writes", () => {
    setDisplayPreferenceViewer("viewer-a");
    const nativeHost = document.createElement("div"); document.body.appendChild(nativeHost);
    const native = createEditorPanelSurface(nativeHost, source, "native"); disposers.push(native.dispose);
    const { reader, host } = mount();
    for (const [key, value] of [["zion.lineNumbers", "1"], ["zion.folding", "1"], ["zion.lineWrap", "0"],
      ["zion.wysiwyg", "0"], ["zion.editor.fontSize", "19"], ["zion.editor.lineHeight", "2"],
      ["zion.editorWidthMode", "wide"], ["zion.headingSize", "small"]] as const) displayPreferenceStorage.setItem(key, value);
    for (const core of [native.core, reader.core]) {
      expect(core.view.dom.querySelector(".cm-lineNumbers")).toBeTruthy();
      expect(core.view.dom.querySelector(".cm-foldGutter")).toBeTruthy();
      expect(core.view.dom.classList.contains("cm-lineWrapping")).toBe(false);
      expect(core.view.scrollDOM.style.paddingLeft).toContain("960px");
    }
    expect(document.documentElement.style.getPropertyValue("--editor-content-font-size")).toBe("19px");
    expect(document.documentElement.dataset.headingSize).toBe("small");
    reader.panels.splitPanel(reader.panels.getActivePanelId()!, "horizontal");
    expect(host.querySelectorAll(".cm-lineNumbers")).toHaveLength(2);
    reader.core.replaceSelection("拒绝写入");
    expect(reader.core.getValue()).toBe(source);
    expect(native.core.view.state.facet(EditorState.readOnly)).toBe(false);
    expect(reader.core.view.state.facet(EditorState.readOnly)).toBe(true);
    expect(reader.core.view.state.facet(EditorView.editable)).toBe(false);
  });
  it("migrates only known display keys for the signed-in viewer and keeps other accounts separate", () => {
    localStorage.setItem("zion.scoped:viewer-a:space-a:zion.vimMode", "1");
    localStorage.setItem("zion.scoped:viewer-a:space-a:zion.autosave", "私有正文");
    localStorage.setItem("zion.scoped:viewer-b:space-b:zion.lineNumbers", "1");
    setDisplayPreferenceViewer("viewer-a", "space-a");
    expect(readDisplayPreference("zion.vimMode")).toBe(true);
    expect(displayPreferenceStorage.getItem("zion.autosave")).toBeNull();
    setDisplayPreferenceViewer("viewer-a", "space-b");
    expect(readDisplayPreference("zion.vimMode")).toBe(true);
    expect(readDisplayPreference("zion.lineNumbers")).toBe(false);
    setDisplayPreferenceViewer("viewer-b");
    expect(readDisplayPreference("zion.vimMode")).toBe(false);
    setDisplayPreferenceViewer("");
    expect(readDisplayPreference("zion.vimMode")).toBe(false);
  });
  it("keeps the original overview rail, hover history, latest navigation and Mac role shortcuts in readonly mode", async () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const { reader, host } = mount();
    expect(host.querySelector(".zion-chat-overview-rail")).toBeTruthy();
    await vi.waitFor(() => expect(host.querySelectorAll(".zion-chat-overview-user-item")).toHaveLength(2));
    const previous = host.querySelector<HTMLButtonElement>(".zion-chat-overview-nav-prev-user")!;
    previous.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(host.querySelector(".zion-chat-overview-nav")!.classList.contains("is-user-history-open")).toBe(true);
    host.querySelectorAll<HTMLButtonElement>(".zion-chat-overview-user-item")[1].click();
    expect(reader.core.getCursor().line).toBe(4);
    expect(host.querySelector<HTMLButtonElement>(".zion-chat-overview-nav-latest")!.disabled).toBe(false);
    reader.view.dispatch({ selection: { anchor: reader.view.state.doc.line(2).from } });
    reader.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true }));
    expect(reader.core.getCursor().line).toBe(0);
    reader.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(reader.view.state.selection.main.anchor).toBe(0);
    expect(reader.core.getCursor().line).toBe(2);
    expect(reader.core.getValue()).toBe(source);
    platform.mockRestore();
  });
  it("supports native Vim movement and visual selection while destructive commands leave the document intact", () => {
    displayPreferenceStorage.setItem("zion.vimMode", "1");
    const { reader } = mount();
    const cm = getCM(reader.view)!;
    expect(cm).toBeTruthy();
    Vim.handleKey(cm, "G");
    expect(reader.core.getCursor().line).toBeGreaterThan(0);
    Vim.handleKey(cm, "g"); Vim.handleKey(cm, "g"); Vim.handleKey(cm, "l");
    Vim.handleKey(cm, "v"); Vim.handleKey(cm, "l");
    expect(reader.view.state.selection.main.empty).toBe(false);
    Vim.handleKey(cm, "<Esc>");
    for (const key of ["x", "d", "d", "p"]) Vim.handleKey(cm, key);
    expect(reader.core.getValue()).toBe(source);
    expect(reader.view.dom.dataset.vimEnabled).toBe("true");
  });
  it("uses the original SearchQuery semantics for escapes, accents, word boundaries and invalid regex", () => {
    for (const [text, query, options] of [
      ["one\ntwo", "one\\ntwo", {}], ["café Cafe", "cafe", {}],
      ["中文 中文词", "中文", { wholeWord: true }], ["aaa", "[", { regex: true }]
    ] as const) {
      const original = new SearchQuery({ search: query, regexp: options.regex, wholeWord: options.wholeWord });
      if (!original.valid) {
        expect(computeConversationSearchMatches(text, query, options).invalid).toBe(true); continue;
      }
      const cursor = original.getCursor(EditorState.create({ doc: text })), expected = [];
      for (let result = cursor.next(); !result.done; result = cursor.next()) if (result.value.to > result.value.from) expected.push(result.value);
      const actual = computeConversationSearchMatches(text, query, options);
      expect(actual.ranges.map(({ from, to }) => ({ from, to }))).toEqual(expected);
      expect(actual.invalid).toBe(!original.valid);
    }
  });
  it("keeps comment-first user content visible and uses the same tool and custom-role index in navigation and TOC", async () => {
    displayPreferenceStorage.setItem("zion.toc.groupByRole", "1");
    displayPreferenceStorage.setItem("zion.roles.prefixes", '["tool","critic"]');
    const text = "assistant 回答\ntool 结果\ncritic 评论\nuser <!-- 一整段\n元数据 -->\n真实提问";
    const { host, reader } = mount(text);
    await vi.waitFor(() => expect(host.querySelectorAll('[data-toc-kind="block"]')).toHaveLength(4));
    expect([...host.querySelectorAll(".toc-label")].map(item => item.textContent)).toContain("真实提问");
    expect(reader.view.contentDOM.textContent).toContain("真实提问");
    host.querySelector<HTMLButtonElement>('[data-action="find"]')!.click();
    const input = host.querySelector<HTMLTextAreaElement>('[data-search-control="search-input"]')!;
    input.value = "真实提问"; input.dispatchEvent(new Event("input"));
    expect(host.querySelector('[data-search-control="match-count"]')!.textContent).toBe("0/1");
    host.querySelector<HTMLButtonElement>('[data-search-control="next-btn"]')!.click();
    expect(reader.core.getSelection()).toBe("真实提问");
    expect(reader.core.getValue()).toBe(text);
  });
});
