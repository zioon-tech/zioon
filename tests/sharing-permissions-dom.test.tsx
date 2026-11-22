import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharingDialog, type SharingTarget } from "../src/ui/workbench/SharingDialog";
import { setAccountSession } from "../packages/account-ui/src/client";

let host: HTMLElement, root: Root, api: any, shares: any[], people: any[], changed: any;
let changes: Map<string, Set<() => void>>;
const target: SharingTarget = { kind: "document", sourceId: "doc", name: "共同计划" };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  setAccountSession({ user: { id: "owner", name: "Alice" }, space: { id: "own", kind: "personal" }, scopes: ["runtime.write"] } as any);
  changes = new Map();
  const subscribe = (key: string, fn: () => void) => {
    if (!changes.has(key)) changes.set(key, new Set()); changes.get(key)!.add(fn);
    return { dispose: () => changes.get(key)?.delete(fn) };
  };
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  (window as any).zion = { commands: { executeCommand: vi.fn() }, state: { get: () => null, onDidChange: subscribe },
    events: { on: subscribe } };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); changed = vi.fn();
  shares = [{ id: "s1", kind: "document", sourceId: "doc", name: "共同计划", status: "active", role: "editor",
    owner: { id: "owner", name: "Alice" }, recipients: [{ id: "bob", name: "Bob", status: "active", role: "editor" }], invitations: [] }];
  people = [{ id: "owner", name: "Alice", role: "owner" }, { id: "bob", name: "Bob", role: "editor", inherited: false,
    grants: [{ shareId: "s1", kind: "document", sourceId: "doc", name: "共同计划", role: "editor" }] }];
  api = {
    documentLink: vi.fn(async () => ({ link: null })), accessRequests: vi.fn(async () => ({ requests: [] })),
    list: vi.fn(async () => ({ shares })), sources: vi.fn(async () => ({ sources: [] })),
    participants: vi.fn(async () => ({ participants: people, selfId: "owner" })), documentPrivacy: vi.fn(async () => ({ private: false })),
    resolveRecipient: vi.fn(async () => ({ recipient: { id: "eve", name: "Eve" } })),
    create: vi.fn(async (input: any) => {
      shares.push({ ...input, id: "s2", status: "active", owner: { id: "owner", name: "Alice" },
        recipients: [{ id: input.recipient, name: "Eve", role: input.role, status: "active" }], invitations: [] });
      people.push({ id: input.recipient, name: "Eve", role: input.role, inherited: false, grants: [] });
      return { share: shares.at(-1), recipient: { id: input.recipient, name: "Eve" } };
    }),
    addRecipient: vi.fn(async () => ({})),
    updateDocumentCollaborator: vi.fn(async (_id: string, userId: string, role: string) => {
      people = role === "removed" ? people.filter(person => person.id !== userId)
        : people.map(person => person.id === userId ? { ...person, role } : person);
      return {};
    }),
    updateRecipient: vi.fn(async () => ({})), updateSourceCollaborator: vi.fn(async () => ({})),
    invite: vi.fn(async () => ({ invitation: { url: "/#share=token" } })), revoke: vi.fn(async () => ({}))
  };
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); setAccountSession(null); vi.useRealTimers(); vi.restoreAllMocks(); });
async function mount(value = target) {
  await act(async () => root.render(<SharingDialog api={api} target={value} onChanged={changed} onClose={vi.fn()} />));
}
async function button(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label)!;
  expect(node, label).toBeTruthy(); await act(async () => node.click());
}
async function input(label: string, value: string) {
  const node = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  expect(node).toBeTruthy();
  const prototype = node.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
describe("collaborator sharing and permission management", () => {
  it("reads the current document title even when its only share is inherited from a folder", async () => {
    shares = [];
    api.participants.mockResolvedValue({ title: "继承分享会话的新名称", participants: people, selfId: "owner" });
    await mount();
    expect(document.querySelector(".sharing-target-name")?.textContent).toBe("继承分享会话的新名称");
    expect(api.create).not.toHaveBeenCalled();
  });
  it("updates current names and inherited sources in an open dialog while retaining recipient and permission drafts", async () => {
    people[1].grants.push({ shareId: "folder-share", kind: "folder", sourceId: "folder", name: "原目录", role: "editor" });
    await mount();
    await input("邮箱或账号 ID", "eve@example.test"); await button("查找"); await input("新协作者权限", "editor");
    const recipientNode = document.querySelector<HTMLInputElement>('[aria-label="邮箱或账号 ID"]')!;
    recipientNode.focus();
    shares = shares.map(s => ({ ...s, name: "新会话名称" }));
    people = people.map(p => ({ ...p, grants: p.grants?.map((g: any) => ({ ...g, name: g.kind === "folder" ? "共同清单测试" : "新会话名称" })) }));
    await act(async () => {
      changes.get("sessions.catalog")?.forEach(fn => fn());
      await new Promise(resolve => setTimeout(resolve, 240));
    });
    expect(document.querySelector(".sharing-target-name")?.textContent).toBe("新会话名称");
    expect(document.querySelector(".sharing-inherited")?.textContent).toContain("共同清单测试");
    expect(document.querySelector(".sharing-recipient-preview")?.textContent).toContain("Eve");
    expect(recipientNode.value).toBe("eve@example.test");
    expect(document.activeElement).toBe(recipientNode);
    expect(document.querySelector<HTMLSelectElement>('[aria-label="新协作者权限"]')?.value).toBe("editor");
    expect(api.create).not.toHaveBeenCalled(); expect(api.updateDocumentCollaborator).not.toHaveBeenCalled();
  });
  it("polls names from another client only while visible and removes refresh listeners on close", async () => {
    vi.useFakeTimers();
    await mount();
    shares = shares.map(s => ({ ...s, name: "另一个客户端改的名字" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(document.querySelector(".sharing-target-name")?.textContent).toBe("另一个客户端改的名字");
    const count = api.list.mock.calls.length;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(api.list).toHaveBeenCalledTimes(count);
    await act(async () => root.unmount());
    expect([...changes.values()].every(value => value.size === 0)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(api.list).toHaveBeenCalledTimes(count);
    vi.useRealTimers();
  });
  it("looks up an exact identity before direct sharing and keeps the collaborator panel open", async () => {
    shares = []; people = people.slice(0, 1);
    await mount();
    expect(document.querySelector("details.sharing-link-section")?.hasAttribute("open")).toBe(false);
    await input("邮箱或账号 ID", "eve@example.test");
    await button("查找");
    expect(api.resolveRecipient).toHaveBeenCalledWith("eve@example.test");
    expect(document.querySelector(".sharing-recipient-preview")?.textContent).toContain("Eve");
    expect(api.create).not.toHaveBeenCalled();
    await input("新协作者权限", "editor"); await button("添加");
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "doc", recipient: "eve", role: "editor" }));
    expect(document.querySelector(".sharing-collaborators")?.textContent).toContain("Eve");
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(changed).toHaveBeenCalledOnce();
    expect(document.querySelector('[aria-label="邀请链接"]')).toBeNull();
  });
  it("updates a recipient in place and confirms removal in the same panel", async () => {
    await mount(); await input("Bob 的权限", "viewer");
    expect(api.updateDocumentCollaborator).toHaveBeenCalledWith("doc", "bob", "viewer");
    expect((document.querySelector('[aria-label="Bob 的权限"]') as HTMLSelectElement).value).toBe("viewer");
    await input("Bob 的权限", "removed");
    expect(api.updateDocumentCollaborator).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".sharing-inline-confirm")?.textContent).toContain("Bob");
    await button("确认移除");
    expect(api.updateDocumentCollaborator).toHaveBeenLastCalledWith("doc", "bob", "removed");
    expect(document.querySelector('[aria-label="Bob 的权限"]')).toBeNull();
  });
  it("shows folder permission sources, prevents deceptive downgrades, and opens the folder manager with a return path", async () => {
    shares.push({ ...shares[0], id: "folder-share", kind: "folder", sourceId: "folder", name: "共享目录" });
    people[1].grants.push({ shareId: "folder-share", kind: "folder", sourceId: "folder", name: "共享目录", role: "editor" });
    api.updateDocumentCollaborator.mockRejectedValueOnce(new Error("此用户通过文件夹拥有编辑权限，请先修改对应文件夹的授权"));
    await mount(); expect(document.querySelector(".sharing-inherited")?.textContent).toContain("共享目录");
    await input("Bob 的权限", "viewer");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("文件夹");
    expect((document.querySelector('[aria-label="Bob 的权限"]') as HTMLSelectElement).value).toBe("editor");
    await button("管理");
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("分享文件夹");
    await input("Bob 的权限", "viewer");
    expect(api.updateSourceCollaborator).toHaveBeenCalledWith("folder", "folder", "bob", "viewer");
    await button("返回会话权限");
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("分享会话");
  });
  it("clears a resolved account when input changes and does not add an unverified replacement", async () => {
    await mount(); await input("邮箱或账号 ID", "eve@example.test"); await button("查找");
    await input("邮箱或账号 ID", "unknown@example.test");
    api.resolveRecipient.mockRejectedValueOnce(new Error("未找到可授权的账号"));
    await button("查找");
    expect(document.querySelector(".sharing-recipient-preview")).toBeNull();
    expect(api.create).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("未找到");
  });
  it("retains grants for management while privacy suspends access", async () => {
    api.documentPrivacy.mockResolvedValue({ private: true });
    people = people.slice(0, 1);
    await mount();
    expect(document.querySelector(".sharing-notice")?.textContent).toContain("访问已暂停");
    expect(document.querySelector('[aria-label="Bob 的权限"]')).toBeTruthy();
    expect(document.querySelector(".sharing-collaborators")?.textContent).toContain("私密期间暂停访问");
  });
});
