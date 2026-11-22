import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAccountSession } from "../packages/account-ui/src/client";
import { registerSharedWorkbenchDocument } from "../src/runtime/workbench-space";
import { mountDocumentAccess, openDocumentAccessDialog } from "../src/ui/workbench/DocumentAccess";

let host: HTMLElement, mounted: any, people: any[], execute: any;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); localStorage.setItem("zion.runtime.baseUrl", location.origin);
  setAccountSession({ user: { id: "me" }, space: { id: "mine", kind: "personal" }, sessionId: "login", scopes: ["runtime.write"] } as any);
  people = [{ id: "me", name: "自己", role: "owner", online: true },
    { id: "offline", name: "离线读者", role: "viewer", online: false, inherited: false },
    { id: "editor", name: "编辑者", role: "editor", online: false, inherited: true }];
  execute = vi.fn();
  (window as any).zion = { commands: { executeCommand: execute }, events: { on: () => ({ dispose() {} }) } };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ participants: people, selfId: "me" }))));
  host = document.createElement("div"); document.body.appendChild(host);
});
afterEach(async () => { await act(async () => mounted?.dispose()); host.remove(); setAccountSession(null); vi.unstubAllGlobals(); });
describe("editor config document access", () => {
  it("updates the access dialog's title from the original document without reopening it or moving focus", async () => {
    let name = "现在的原会话", notify = () => {};
    (window as any).zion.state = { onDidChange: (key: string, fn: () => void) => {
      if (key === "sessions.catalog") notify = fn; return { dispose() {} };
    } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ title: name, participants: people, selfId: "me" }))));
    await act(async () => { mounted = openDocumentAccessDialog("doc"); });
    expect(document.querySelector(".sharing-target-name")?.textContent).toBe(name);
    const select = document.querySelector<HTMLSelectElement>('[aria-label="离线读者 的权限"]')!;
    select.focus(); name = "另一个客户端改名后的会话";
    await act(async () => { notify(); await new Promise(resolve => setTimeout(resolve, 240)); });
    expect(document.querySelector(".sharing-target-name")?.textContent).toBe(name);
    expect(document.activeElement).toBe(select);
    expect(document.querySelectorAll(".document-access-dialog")).toHaveLength(1);
  });
  it("keeps one dedicated dialog and closes it before opening the captured document's share manager", async () => {
    await act(async () => { mounted = openDocumentAccessDialog("first"); });
    await act(async () => { mounted = openDocumentAccessDialog("second"); });
    expect(document.querySelectorAll(".document-access-dialog")).toHaveLength(1);
    expect(document.querySelector(".document-access-dialog")?.textContent).not.toContain("Line Numbers");
    const manage = [...document.querySelectorAll<HTMLButtonElement>(".document-access-dialog button")]
      .find(button => button.textContent === "管理分享")!;
    await act(async () => manage.click());
    expect(execute).toHaveBeenCalledWith("zion.sharing.manage", { sourceId: "second" });
    expect(document.querySelector(".document-access-dialog")).toBeNull();
  });
  it("lists authorized offline people and separate reading/editing permissions with owner management actions", async () => {
    await act(async () => { mounted = mountDocumentAccess(host, "doc"); });
    expect(host.querySelectorAll("tbody tr")).toHaveLength(3);
    const reader = host.querySelectorAll("tbody tr")[1];
    expect(reader.textContent).toContain("离线读者"); expect(reader.querySelectorAll("td")[1].textContent).toBe("允许");
    expect(reader.querySelectorAll("td")[2].textContent).toBe("—");
    expect(host.textContent).toContain("文件夹授权"); expect(host.textContent).toContain("未在此文档中");
    const button = [...host.querySelectorAll("button")].find(node => node.textContent === "管理分享")!;
    await act(async () => button.click());
    expect(execute).toHaveBeenCalledWith("zion.sharing.manage", { sourceId: "doc" });
  });
  it("captures the active split document, uses the caller account and hides owner-only controls for receivers", async () => {
    people[0].role = "viewer";
    const shared = registerSharedWorkbenchDocument({ originSpaceId: "owner", documentId: "remote", role: "viewer", title: "remote", providerName: "Alice" });
    await act(async () => { mounted = mountDocumentAccess(host, shared.localId); });
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toContain("/documents/remote/participants?origin=owner");
    expect(new Headers(init.headers).get("x-zioon-space-id")).toBe("mine");
    expect(host.querySelector("button")).toBeNull();
    await act(async () => mounted.dispose());
    expect(host.textContent).toBe("");
  });
  it("edits permissions inline and leaves inherited access to the shared manager", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "PUT") people[1].role = JSON.parse(String(init.body)).role;
      return new Response(JSON.stringify({ participants: people, selfId: "me" }));
    }));
    await act(async () => { mounted = mountDocumentAccess(host, "doc"); });
    expect((host.querySelector('[aria-label="编辑者 的权限"]') as HTMLSelectElement).disabled).toBe(true);
    const select = host.querySelector('[aria-label="离线读者 的权限"]') as HTMLSelectElement;
    await act(async () => {
      select.value = "editor"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const [url, init] = (fetch as any).mock.calls.find((call: any) => call[1].method === "PUT");
    expect(url).toContain("/documents/doc/collaborators/offline");
    expect(JSON.parse(init.body)).toEqual({ role: "editor" });
    expect(select.value).toBe("editor");
  });
});
