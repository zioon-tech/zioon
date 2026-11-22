import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPublicReader, type PublicDocument } from "../src/public-reader/reader";
import { sanitizePublicSvg, safeMarkdownHref } from "../src/editor/public-content-security";

const path = `/share/${"a".repeat(43)}`;
vi.mock("mermaid", () => ({ default: {
  initialize: vi.fn(),
  render: vi.fn().mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L20 20"/><script>alert(1)</script></svg>' })
} }));
const original = `user 请整理方案
assistant <!-- zion-assistant:id=answer1 --> **重点** 与 \`code\`
# 方案
思考 <!-- zion-thinking:id=thought1 -->
调用 write <!-- zion-tool:id=tool1 -->
调用 read <!-- zion-tool:id=tool2 -->
- [x] 已完成

| 项目 | 状态 |
| --- | --- |
| **检查** | [安全](https://example.com) |

![原图](zion-asset://image1)
![不可加载](https://foreign.test/image.png)

\`\`\`js
const answer = 42
\`\`\``;
const payload = (overrides: Partial<PublicDocument> = {}): PublicDocument => ({
  state: "read", title: "原生会话", markdown: original, mode: "public", role: null,
  contentRevision: "1", cards: {
    thinking: [{ id: "thought1", from: 0, to: 0, text: "先核实真实资料再完成方案" }],
    tools: [{ id: "tool1", from: 0, to: 0, name: "write", args: { file_path: "/tmp/plan.md", content: "完整产物" }, result: "ok", ok: true },
      { id: "tool2", from: 0, to: 0, name: "read", args: { file_path: "/tmp/plan.md" }, result: "1: 完整产物", ok: true }]
  }, ...overrides
});
const readers: ReturnType<typeof mountPublicReader>[] = [];
function mount(value = payload(), options: any = {}) {
  const host = document.createElement("div"); document.body.appendChild(host);
  const reader = mountPublicReader(host, value, { path, ...options }); readers.push(reader);
  return reader;
}
afterEach(() => { readers.splice(0).forEach(r => r.dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();

describe("native public conversation reader", () => {
  it("renders original roles, rich text, recorded cards, task state and tables with a hard read-only guard", async () => {
    const reader = mount();
    expect(document.querySelector(".cm-role-token-user")?.textContent).toBe("user");
    expect(document.querySelector(".cm-role-token-assistant")?.textContent).toBe("assistant");
    expect(document.querySelector(".cm-md-strong")?.textContent).toBe("重点");
    expect(document.querySelector(".cm-md-code")?.textContent).toBe("code");
    expect(document.querySelector('[data-card-id="tool2"] .zion-tool-call-inline-text')?.textContent).toBe("调用 read");
    expect(document.querySelector(".cm-md-table")?.textContent).toContain("检查");
    expect(document.querySelector<HTMLInputElement>('.cm-md-task input')?.disabled).toBe(true);
    expect(document.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false");
    expect(document.querySelector(".cm-lineNumbers")).toBeNull();
    reader.view.dispatch({ changes: { from: 0, insert: "FORBIDDEN" } });
    expect(reader.view.state.doc.toString()).toBe(original);
    expect([...document.querySelectorAll("button")].map(b => b.textContent)).not.toContain("源码");
    click('[data-card-id="thought1"] button');
    expect(document.querySelector(".zion-thinking-card-body")?.textContent).toContain("真实资料");
    click('[data-card-id="tool1"] button');
    expect(document.querySelector(".zion-tool-artifact-preview")?.textContent).toContain("完整产物");
    expect(document.querySelector(".zion-tool-artifact-preview-actions")).toBeNull();
    expect(document.querySelector(".zion-tool-card-actions")).toBeNull();
    click('[data-card-id="tool2"] button');
    expect(document.querySelector(".zion-tool-read-text")?.textContent).toContain("完整产物");
    expect(document.querySelector(".zion-tool-open-in-context")).toBeNull();
    await vi.waitFor(() => expect(document.querySelector(`img[src="${path}/assets/image1"]`)).toBeTruthy());
    expect(document.querySelector('img[src^="https://foreign"]')).toBeNull();
    expect(document.querySelector("[draggable=true]")).toBeNull();
  });
  it("preserves selection and expanded records on refresh, and updates title and Markdown without enabling edits", () => {
    const reader = mount();
    click('[data-card-id="thought1"] button');
    const pos = original.indexOf("重点");
    reader.view.dispatch({ selection: { anchor: pos, head: pos + 2 } });
    reader.update(payload({ title: "修改后的标题", markdown: original + "\n更新内容", contentRevision: "2", role: "editor" }));
    expect(reader.view.state.selection.main.from).toBe(pos);
    expect(reader.view.state.selection.main.to).toBe(pos + 2);
    expect(document.querySelector(".zion-thinking-card-body")).toBeTruthy();
    expect(document.querySelector(".public-reader-title")?.textContent).toBe("修改后的标题");
    expect(document.querySelector(".public-reader-workbench")?.textContent).toBe("在工作台编辑");
    expect(document.querySelector(".public-reader-mode")?.textContent).toContain("只读");
    reader.view.dispatch({ changes: { from: 0, insert: "FAIL" } });
    expect(reader.view.state.doc.toString()).toBe(original + "\n更新内容");
  });
  it("finds recorded detail, opens its card, navigates through headings and copies clean conversation content", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
    const reader = mount();
    click('[data-action="find"]');
    const input = document.querySelector<HTMLTextAreaElement>("#search-input")!;
    input.value = "真实资料"; input.dispatchEvent(new Event("input"));
    click('[data-search-control="next-btn"]');
    expect(document.querySelector(".zion-thinking-card-body")).toBeTruthy();
    expect(document.querySelector("#match-count")?.textContent).toBe("1/1");
    const heading = [...document.querySelectorAll<HTMLElement>('.zion-toc-sidepanel [data-toc-kind="heading"]')].find(b => b.textContent === "方案")!;
    heading.click(); expect(reader.view.state.selection.main.from).toBe(original.indexOf("# 方案") + 2);
    click('[data-action="copy"]');
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledOnce());
    const copied = clipboard.writeText.mock.calls[0][0];
    expect(copied).toContain("user 请整理方案"); expect(copied).not.toContain("zion-assistant:id");
  });
  it("clears rendered content when a refresh reports revoked access", async () => {
    const onAccessLost = vi.fn();
    const reader = mount(payload(), { refresh: vi.fn().mockResolvedValue({ state: "login" }), onAccessLost });
    click('[data-card-id="thought1"] button');
    await reader.refresh();
    expect(onAccessLost).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("真实资料");
    expect(document.querySelector(".cm-editor")).toBeNull();
  });
  it("retains reading content and permits retry on a transient refresh failure", async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(payload({ title: "已恢复", contentRevision: "2" }));
    const reader = mount(payload(), { refresh });
    await reader.refresh(true);
    expect(document.querySelector(".cm-editor")).toBeTruthy();
    expect(document.querySelector(".public-reader-notice")?.textContent).toContain("无法刷新");
    await reader.refresh(true);
    expect(document.querySelector(".public-reader-title")?.textContent).toBe("已恢复");
  });
  it("maps selection through content inserted above it and preserves search focus and internal scroll", () => {
    const reader = mount(payload({ markdown: "user 问题\nassistant 回答\n# 一级\n## 子级\n正文" }));
    click('[data-toc-kind="heading"] button');
    click('[data-action="find"]');
    const input = document.querySelector<HTMLTextAreaElement>("#search-input")!;
    const pos = reader.core.getValue().indexOf("正文");
    reader.view.dispatch({ selection: { anchor: pos, head: pos + 2 } });
    input.focus();
    reader.view.scrollDOM.scrollTop = 180;
    reader.view.scrollDOM.scrollLeft = 14;
    const before = reader.core.getValue(), prefix = "system 新说明\n";
    reader.update(payload({ markdown: prefix + before }));
    expect(reader.core.getSelection()).toBe("正文");
    expect(reader.view.state.selection.main.from).toBe(prefix.length + pos);
    expect(document.activeElement).toBe(input);
    expect(reader.view.scrollDOM.scrollTop).toBe(180);
    expect(reader.view.scrollDOM.scrollLeft).toBe(14);
    expect(document.querySelector<HTMLElement>(".search-replace-panel")!.hidden).toBe(false);
  });
  it("keeps diagram and math rendering in read-only mode without source-edit controls", async () => {
    mount(payload({ markdown: "assistant 图表与公式\n$E=mc^2$\n```mermaid\nflowchart LR\nA-->B\n```\n```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"12\" height=\"12\"/></svg>\n```" }));
    await vi.waitFor(() => expect(document.querySelector(".cm-md-diagram-body path")).toBeTruthy());
    expect(document.querySelector(".cm-md-diagram-body rect")).toBeTruthy();
    expect(document.querySelector(".katex")).toBeTruthy();
    expect(document.querySelector(".cm-md-diagram-body script")).toBeNull();
    const labels = [...document.querySelectorAll(".cm-md-diagram-btn")].map(node => node.textContent);
    expect(labels).not.toContain("编辑"); expect(labels).not.toContain("新窗");
    expect(labels).toContain("复制SVG");
  });
});

describe("public embedded content", () => {
  it("removes active SVG, remote resources and unsafe CSS while keeping local drawing", () => {
    const svg = sanitizePublicSvg(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(1)</script><foreignObject><div>active</div></foreignObject>
      <a href="javascript:alert(1)"><text>click</text></a><image href="https://foreign.test/x"/>
      <style>@import "https://foreign.test/css";</style><rect width="10" height="10" style="fill:url(https://foreign.test/x)"/>
      <path d="M0 0L10 10"/></svg>`)!;
    expect(svg.localName).toBe("svg");
    expect(svg.querySelector("path")).toBeTruthy();
    expect(svg.outerHTML).not.toMatch(/script|foreignObject|onload|href|foreign.test|@import/);
  });
  it("rejects executable link schemes including whitespace obfuscation", () => {
    for (const href of ["javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,hi", "vbscript:x"]) expect(safeMarkdownHref(href)).toBeNull();
    expect(safeMarkdownHref("https://example.com")).toBe("https://example.com");
    expect(safeMarkdownHref("#heading")).toBe("#heading");
  });
});
