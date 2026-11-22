import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentLinkControls } from "../src/ui/workbench/DocumentLinkControls";

let root: Root, host: HTMLElement, api: any, link: any, requests: any[], changed: any, prepare: any;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  link = null; requests = []; changed = vi.fn(); prepare = vi.fn(async () => {});
  api = { documentLink: vi.fn(async () => ({ link })), accessRequests: vi.fn(async () => ({ requests })),
    setDocumentLink: vi.fn(async (_doc: string, mode: string) => {
      link = { id: "same", mode, url: "https://zioon.test/share/same", revision: 1 }; return { link };
    }), decideAccess: vi.fn(async (_doc: string, id: string) => { requests = requests.filter(r => r.id !== id); }) };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const mount = async (privateDocument = false) => act(async () => root.render(
  <DocumentLinkControls api={api} documentId="split-document" privateDocument={privateDocument} prepare={prepare} onChanged={changed} />));
const click = async (text: string) => act(async () => {
  const button = [...host.querySelectorAll("button")].find(button => button.textContent === text)!;
  expect(button).toBeTruthy(); button.click();
});
const select = async (label: string, value: string) => act(async () => {
  const node = host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
  node.value = value; node.dispatchEvent(new Event("change", { bubbles: true }));
});
describe("document link scope and owner access decisions", () => {
  it("creates a restricted stable link and requires explicit confirmation before public access", async () => {
    await mount(); expect(api.setDocumentLink).not.toHaveBeenCalled();
    await click("创建受限分享链接");
    expect(prepare).toHaveBeenCalledOnce();
    expect(api.setDocumentLink).toHaveBeenLastCalledWith("split-document", "restricted");
    expect(host.querySelector<HTMLInputElement>('[aria-label="会话分享链接"]')?.value).toContain("/share/same");
    await select("链接访问范围", "public");
    expect(api.setDocumentLink).toHaveBeenCalledTimes(1);
    await click("取消"); expect(api.setDocumentLink).toHaveBeenCalledTimes(1);
    await select("链接访问范围", "public"); await click("开启公开阅读");
    expect(api.setDocumentLink).toHaveBeenLastCalledWith("split-document", "public");
    await select("链接访问范围", "disabled");
    expect(api.setDocumentLink).toHaveBeenLastCalledWith("split-document", "disabled");
    expect(host.querySelector('[aria-label="会话分享链接"]')).toBeNull();
  });
  it("lets the owner choose a lower permission than requested and reject another application", async () => {
    link = { id: "same", mode: "restricted", url: "/share/same" };
    requests = [{ id: "a", name: "Bob", userId: "bob", role: "editor", message: "<script>申请</script>" },
      { id: "b", name: "Eve", userId: "eve", role: "viewer" }];
    await mount();
    expect(host.querySelector("script")).toBeNull();
    await select("Bob 的批准权限", "viewer"); await click("批准");
    expect(api.decideAccess).toHaveBeenCalledWith("split-document", "a", "approved", "viewer");
    await click("拒绝"); expect(api.decideAccess).toHaveBeenCalledWith("split-document", "b", "rejected");
    expect(host.textContent).toContain("暂无待处理申请");
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it("shows privacy suspension and prevents enabling public reading or approving requests", async () => {
    link = { id: "same", mode: "public", url: "/share/same" };
    requests = [{ id: "a", name: "Bob", userId: "bob", role: "editor" }];
    await mount(true);
    expect(host.querySelector<HTMLOptionElement>('option[value="public"]')?.disabled).toBe(true);
    expect([...host.querySelectorAll("button")].find(node => node.textContent === "批准")?.disabled).toBe(true);
    expect(host.textContent).toContain("访问申请均已暂停");
  });
});
