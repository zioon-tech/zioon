import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorCore } from "../src/editor/EditorCore";
import { createPanelDomShell } from "../src/panel/PanelManager";
import { roles } from "../extensions/dev.roles/roles.js";
import { mountPublicReader, type PublicDocument } from "../src/public-reader/reader";
import { parseOutlineHeadings, parseOutlineRoleBlocks } from "../src/editor/conversation-outline";
import { computeConversationSearchMatches } from "../src/editor/search-panel";
import { displayPreferenceStorage, setDisplayPreferenceViewer } from "../src/editor/display-preferences";

const path = `/share/${"a".repeat(43)}`;
const text = "user 问题\nassistant 回答\n# 一级\n## 子级\n### 细节\n```md\n# 假标题\nuser 代码内容\n```\nsystem 约束\n# 规则";
const payload = (markdown = text): PublicDocument => ({
  state: "read", title: "同一会话", markdown, mode: "public", role: null,
  cards: { tools: [], thinking: [] }
});
const disposers: (() => void)[] = [];
const ambient = (window as any).zion;
function mount(markdown = text) {
  const host = document.createElement("div"); document.body.appendChild(host);
  const reader = mountPublicReader(host, payload(markdown), { path });
  disposers.push(() => reader.dispose());
  return { host, reader };
}
afterEach(() => {
  disposers.splice(0).reverse().forEach(dispose => dispose());
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  localStorage.clear(); setDisplayPreferenceViewer("");
  (window as any).zion = ambient;
});
const type = (host: HTMLElement, query: string) => {
  const input = host.querySelector<HTMLTextAreaElement>("#search-input")!;
  input.value = query; input.dispatchEvent(new Event("input", { bubbles: true })); return input;
};
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>(".zion-toc-list .toc-row")]
  .map(row => ({ kind: row.dataset.tocKind, id: row.dataset.tocId, text: row.querySelector(".toc-label")?.textContent }));

describe("workbench and public reader share the actual editor components", () => {
  it("uses EditorCore without workbench initialization, blocks edit APIs and hides only the terminal empty draft", () => {
    (window as any).zion = undefined;
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const write = vi.spyOn(Storage.prototype, "setItem");
    const markdown = "user 问题\nassistant 回答\n# 标题\nsystem 约束\nuser \n";
    const { host, reader } = mount(markdown);
    expect(reader.core).toBeInstanceOf(EditorCore);
    expect(host.querySelector(".zion-panel .zion-editor-header .zion-editor-session-path")).toBeTruthy();
    expect(host.querySelector(".zion-panel .zion-editor-host .zion-editor-slot > .zion-toc-layout > .cm-editor")).toBe(reader.view.dom);
    expect(host.querySelector("h1,footer")).toBeNull();
    expect(host.querySelectorAll(".cm-role-token-user")).toHaveLength(1);
    expect(rows(host).filter(row => row.kind === "heading")).toHaveLength(1);
    reader.core.setValue("FORBIDDEN");
    reader.core.replaceSelection("FORBIDDEN");
    reader.core.replaceRange("FORBIDDEN", { line: 0, ch: 0 });
    expect(reader.core.getValue()).toBe(markdown);
    expect((window as any).zion).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(write.mock.calls.every(([key]) => key.startsWith("zion.theme"))).toBe(true);
    reader.update(payload(markdown + "已写入的后续提问"));
    expect(reader.core.getValue()).toContain("已写入的后续提问");
    expect(host.querySelectorAll(".cm-role-token-user")).toHaveLength(2);
  });

  it("matches native outline rows and search controls when the original workbench extensions activate", async () => {
    const registry = await import("../src/ext/registry");
    const nativeZion = (window as any).zion;
    disposers.push(() => { (window as any).zion = nativeZion; });
    const shell = createPanelDomShell("native-comparison"); document.body.appendChild(shell.rootEl);
    shell.editorHostEl.replaceChildren();
    const slot = document.createElement("div"); slot.className = "zion-editor-slot"; shell.editorHostEl.appendChild(slot);
    const native = new EditorCore(slot, text, "native-comparison"); native.setTheme("light");
    native.addExternalExtension(roles());
    registry.attachEditor(native, "native-comparison");
    const ctx: any = { subscriptions: [] };
    const toc = await import("../extensions/dev.toc/main.js");
    await toc.activate(ctx);
    const search = await import("../extensions/dev.search-replace/main.js");
    await search.activate(ctx);
    disposers.push(() => {
      nativeZion.commands.executeCommand("searchReplace.hide");
      ctx.subscriptions.splice(0).reverse().forEach((item: any) => item?.dispose?.()); toc.deactivate();
      registry.detachEditor("native-comparison"); native.dispose();
    });
    nativeZion.state.set("toc.groupByRole", true);
    displayPreferenceStorage.setItem("zion.toc.groupByRole", "1");
    await vi.waitFor(() => expect(rows(shell.rootEl).filter(row => row.kind === "block")).toHaveLength(4));
    const { host, reader } = mount();
    await vi.waitFor(() => expect(rows(host)).toEqual(rows(shell.rootEl)));
    expect(rows(host).map(row => row.text)).not.toContain("假标题");
    const nativeChild = shell.rootEl.querySelector<HTMLButtonElement>('[data-toc-kind="heading"] button')!;
    const publicChild = host.querySelector<HTMLButtonElement>('[data-toc-kind="heading"] button')!;
    nativeChild.click(); publicChild.click();
    await vi.waitFor(() => expect(rows(shell.rootEl).map(row => row.text)).not.toContain("子级"));
    expect(rows(host)).toEqual(rows(shell.rootEl));
    host.querySelector<HTMLButtonElement>('[data-toc-kind="heading"] button')!.click();
    host.querySelector<HTMLElement>('[data-toc-kind="heading"]')!.click();
    expect(reader.core.getCursor().line).toBe(2);
    host.querySelector<HTMLButtonElement>('[aria-label="按角色分组 TOC"]')!.click();
    await nativeZion.commands.executeCommand("toc.toggleGroupByRole");
    await vi.waitFor(() => expect(rows(shell.rootEl).every(row => row.kind === "heading")).toBe(true));
    expect(rows(host)).toEqual(rows(shell.rootEl));
    native.view.dispatch({ selection: { anchor: 0 } });
    await nativeZion.commands.executeCommand("searchReplace.show");
    host.querySelector<HTMLButtonElement>('[data-action="find"]')!.click();
    const nativePanel = shell.rootEl.querySelector<HTMLElement>(".search-replace-panel")!;
    const publicPanel = host.querySelector<HTMLElement>(".search-replace-panel")!;
    for (const id of ["search-input", "match-count", "prev-btn", "next-btn", "select-all-btn", "close-btn", "case-sensitive", "whole-word", "regex"]) {
      expect(publicPanel.querySelector(`#${id}`)?.tagName).toBe(nativePanel.querySelector(`#${id}`)?.tagName);
    }
    expect(publicPanel.querySelector("#replace-section,#replace-input,#toggle-replace-btn")).toBeNull();
    type(shell.rootEl, "回答"); nativePanel.querySelector<HTMLButtonElement>("#next-btn")!.click();
    type(host, "回答");
    publicPanel.querySelector<HTMLButtonElement>("#next-btn")!.click();
    expect(reader.core.getSelection()).toBe(native.getSelection());
    expect(host.querySelector(".cm-searchMatch")).toBeTruthy();
    expect(shell.rootEl.querySelector(".cm-searchMatch")).toBeTruthy();
  });

  it("keeps native search navigation, case, Unicode word matching, regex errors and select-all read-only", () => {
    const markdown = "assistant Alpha alpha ALPHA\nalpha.beta alpha.beta\n中文 中文词";
    const { host, reader } = mount(markdown);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(host.querySelector<HTMLElement>(".search-replace-panel")!.style.display).toBe("block");
    const input = type(host, "alpha");
    expect(host.querySelector("#match-count")!.textContent).toBe("0/5");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    expect(host.querySelector("#match-count")!.textContent).toBe("5/5");
    const caseBox = host.querySelector<HTMLInputElement>("#case-sensitive")!;
    caseBox.checked = true; caseBox.dispatchEvent(new Event("change"));
    expect(host.querySelector("#match-count")!.textContent).toBe("3/3");
    type(host, "alpha.beta");
    expect(host.querySelector("#match-count")!.textContent).toBe("2/2");
    host.querySelector<HTMLButtonElement>("#select-all-btn")!.click();
    expect(reader.view.state.selection.ranges).toHaveLength(2);
    const regex = host.querySelector<HTMLInputElement>("#regex")!;
    regex.checked = true; regex.dispatchEvent(new Event("change")); type(host, "[");
    expect(host.querySelector("#match-count")!.textContent).toBe("无效正则");
    expect(host.querySelector<HTMLButtonElement>("#next-btn")!.disabled).toBe(true);
    regex.checked = false; regex.dispatchEvent(new Event("change"));
    const word = host.querySelector<HTMLInputElement>("#whole-word")!;
    word.checked = true; word.dispatchEvent(new Event("change")); type(host, "中文");
    expect(host.querySelector("#match-count")!.textContent).toBe("0/1");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(host.querySelector<HTMLElement>(".search-replace-panel")!.style.display).toBe("none");
    expect(host.querySelector(".cm-searchMatch")).toBeNull();
    expect(reader.core.getValue()).toBe(markdown);
  });

  it("keeps literal special characters and excludes fence contents across ranged heading parsing", () => {
    expect(computeConversationSearchMatches("a.b aXb", "a.b").ranges).toHaveLength(1);
    expect(computeConversationSearchMatches("中文 中文词", "中文", { wholeWord: true }).ranges).toHaveLength(1);
    expect(computeConversationSearchMatches("text", "(?=t)", { regex: true }).ranges).toEqual([]);
    const lines = ["assistant ```md", "# 假标题", "user 代码行", "```", "# 真标题"];
    expect(parseOutlineHeadings(lines, 1, 4).map(heading => heading.title)).toEqual(["真标题"]);
    expect(parseOutlineRoleBlocks(lines.join("\n"))).toHaveLength(1);
  });
});
