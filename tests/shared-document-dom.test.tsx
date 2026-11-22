import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedDocument } from "../src/ui/workbench/SharedDocument";
import { setDisplayPreferenceViewer } from "../src/editor/display-preferences";
import { transferableAbortController } from "node:util";
const baseUrl = "https://runtime.example";
let root: Root, host: HTMLElement;
const identity = { authenticated: true, user: { id: "viewer" }, space: { id: "personal" } };
const response = (value: any, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const documentValue = (title: string, text = `user ${title}\nassistant **回答**`) => ({
  access: { role: "commenter" }, content: { title, text, revision: 1 },
  reader: { state: "read", title, markdown: text, mode: "restricted", role: "commenter",
    cards: { tools: [], thinking: [] }, displayIdentity: `document:${"a".repeat(64)}` }
});
const render = async (documentId: string) => act(async () => root.render(<SharedDocument baseUrl={baseUrl} spaceId="team" documentId={documentId} />));
const until = async (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check(); });
beforeEach(() => {
  const controller = transferableAbortController();
  vi.stubGlobal("AbortController", controller.constructor);
  vi.stubGlobal("AbortSignal", controller.signal.constructor);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  localStorage.clear(); setDisplayPreferenceViewer(""); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe("authorized reader uses the shared panel transport safely", () => {
  it("uses native read-only panels, search, split and comments without loading Workbench APIs", async () => {
    const calls: string[] = [], mutations: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname; calls.push(path);
      if (path.endsWith("/me")) return response(identity);
      if (path.endsWith("/comments")) {
        if (init.method === "POST") mutations.push(String(init.body));
        return response({ comments: [{ id: "one", authorName: "协作者", body: "建议", createdAt: 1 }] });
      }
      return response(documentValue("讨论"));
    });
    await render("doc");
    await until(() => expect(host.querySelector(".cm-editor")).toBeTruthy());
    expect(host.querySelector(".cm-content")!.getAttribute("contenteditable")).toBe("false");
    expect(host.textContent).toContain("可评论");
    host.querySelector<HTMLButtonElement>('[data-action="find"]')!.click();
    const search = host.querySelector<HTMLTextAreaElement>('[data-search-control="search-input"]')!;
    search.value = "回答"; search.dispatchEvent(new Event("input"));
    expect(host.querySelector('[data-search-control="match-count"]')!.textContent).toBe("0/1");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-action="split"]')!.click();
      document.querySelector<HTMLButtonElement>(".zion-editor-header-split-menu button")!.click();
    });
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(2);
    await act(async () => {
      const textarea = host.querySelector<HTMLTextAreaElement>("textarea:not([data-search-control])")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "新评论");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await until(() => expect(mutations).toHaveLength(1));
    expect(calls.every(path => path === "/v1/account/me" || path.startsWith("/v1/spaces/team/documents/doc"))).toBe(true);
  });
  it("ignores a previous scope response and clears all panels/comments after access is revoked", async () => {
    let finishOld: (value: Response) => void = () => {}, oldStarted = false, revoked = false;
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/me")) return response(identity);
      if (path.endsWith("/comments")) return response({ comments: [] });
      if (path.endsWith("/old")) return new Promise<Response>(resolve => { oldStarted = true; finishOld = resolve; });
      return revoked ? response({}, 404) : response(documentValue("新文档"));
    });
    await render("old");
    await until(() => expect(oldStarted).toBe(true));
    await render("new");
    await until(() => expect(host.querySelector(".public-reader-title")!.textContent).toBe("新文档"));
    await act(async () => finishOld(response(documentValue("旧文档"))));
    expect(host.querySelector(".public-reader-title")!.textContent).toBe("新文档");
    revoked = true;
    await act(async () => host.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.click());
    await until(() => expect(host.textContent).toContain("文档不可用"));
    expect(host.querySelector(".cm-editor")).toBeNull();
    expect(host.querySelector("textarea")).toBeNull();
  });
});
