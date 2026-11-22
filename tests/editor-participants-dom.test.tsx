import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAccountSession } from "../packages/account-ui/src/client";
import { registerSharedWorkbenchDocument } from "../src/runtime/workbench-space";
import { mountEditorParticipants } from "../src/ui/workbench/EditorParticipants";

const owner = { id: "owner", name: "林小雨", role: "owner", inherited: false, online: true };
const editor = { id: "editor", name: "Alice Wang", role: "editor", inherited: true, online: true };
const self = { id: "me", name: "我", role: "editor", inherited: false, online: true };
const json = (value: any, status = 200) => new Response(JSON.stringify(value), { status });
let header: HTMLElement, mounted: Array<ReturnType<typeof mountEditorParticipants>>, events: Map<string, Set<any>>;
let replies: Map<string, any>, calls: Array<{ url: URL; init: RequestInit }>;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem("zion.runtime.baseUrl", location.origin);
  setAccountSession({ user: { id: "me", name: "我" }, space: { id: "mine", kind: "personal" },
    sessionId: "login", scopes: ["runtime.write"] } as any);
  header = document.createElement("header"); header.className = "zion-editor-header"; document.body.appendChild(header);
  mounted = []; events = new Map(); calls = []; replies = new Map();
  (window as any).zion = {
    events: { on: (topic: string, fn: any) => {
      if (!events.has(topic)) events.set(topic, new Set()); events.get(topic)!.add(fn);
      return { dispose: () => events.get(topic)?.delete(fn) };
    }, emit: (topic: string, payload: any) => events.get(topic)?.forEach(fn => fn(payload)) }
  };
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: RequestInit) => {
    const url = new URL(input); calls.push({ url, init });
    const id = decodeURIComponent(url.pathname.split("/").at(-2)!);
    const reply = replies.get(id);
    if (typeof reply === "function") return reply(url, init);
    return json({ documentId: id, originSpaceId: url.searchParams.get("origin"), selfId: "me",
      participants: reply || [owner, editor, self] });
  }));
});
afterEach(async () => {
  await act(async () => mounted.forEach(m => m.dispose()));
  header.remove(); document.querySelectorAll("[data-second-header]").forEach(node => node.remove());
  setAccountSession(null); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks();
});
async function mount(sessionId = "doc", element = header) {
  let id = sessionId, notify = () => {};
  await act(async () => mounted.push(mountEditorParticipants(element, {
    sessionId: () => id, pollMs: 60000, subscribe: refresh => { notify = refresh; return []; }
  })));
  return { switch: async (next: string) => { id = next; await act(async () => notify()); } };
}
const button = (name: string, element: ParentNode = header) =>
  [...element.querySelectorAll<HTMLButtonElement>("button")].find(node => node.getAttribute("aria-label")?.startsWith(name))!;
describe("document participants in each native editor header", () => {
  it("updates a pinned avatar's inherited folder name on tree changes without closing the popover", async () => {
    let notify = () => {};
    (window as any).zion.state = { onDidChange: (key: string, fn: () => void) => {
      if (key === "sessions.treeMem") notify = fn; return { dispose() {} };
    } };
    const grant = { kind: "folder", shareId: "folder-share", sourceId: "folder", name: "原目录", role: "editor" };
    replies.set("doc", [{ ...self, role: "owner" }, { ...editor, grants: [grant] }]);
    await mount(); await act(async () => button("Alice").click());
    grant.name = "共同清单测试";
    await act(async () => { notify(); await new Promise(resolve => setTimeout(resolve, 240)); });
    expect(document.querySelector(".editor-participants-card")?.getAttribute("role")).toBe("dialog");
    expect(document.querySelector(".editor-participant-folder-name")?.textContent).toBe("共同清单测试");
    expect(document.querySelector(".editor-participant-link")?.getAttribute("aria-label")).toContain("共同清单测试");
  });
  it("explains inherited permissions without a disabled selector and opens the folder that granted access", async () => {
    const folder = { kind: "folder", shareId: "folder-share", sourceId: "shared-folder",
      name: "一起处理的事情和需要协作整理的长文件夹名称", role: "editor" };
    replies.set("doc", [{ ...self, role: "owner" }, { ...editor, grants: [folder, { ...folder, shareId: "another-share" }] }]);
    const execute = vi.fn();
    (window as any).zion.commands = { executeCommand: execute };
    await mount();
    await act(async () => button("Alice").click());
    const card = document.querySelector(".editor-participants-card")!;
    expect(card.querySelector("select")).toBeNull();
    expect(card.querySelector(".editor-participant-permission")?.textContent).toContain("可编辑 · 来自文件夹分享");
    expect(card.querySelectorAll(".editor-participant-source")).toHaveLength(1);
    const manage = card.querySelector<HTMLButtonElement>(".editor-participant-link")!;
    expect(manage.textContent).toBe("管理");
    expect(manage.getAttribute("aria-label")).toContain(folder.name);
    expect(card.querySelector(".editor-participant-folder-name")?.getAttribute("title")).toBe(folder.name);
    expect(card.querySelector(".editor-participants-footer")?.textContent).toBe("分享与权限管理");
    await act(async () => manage.click());
    expect(execute).toHaveBeenCalledWith("zion.sharing.create", expect.objectContaining({
      kind: "folder", sourceId: folder.sourceId, name: folder.name
    }));
    expect(document.querySelector(".editor-participants-card")).toBeNull();
    expect(calls.some(call => call.init.method === "PUT")).toBe(false);
  });
  it("changes permissions from a pinned avatar and captures its split document instead of the active document", async () => {
    replies.set("left", [{ ...self, role: "owner" }, { ...editor, inherited: false,
      grants: [{ kind: "document", shareId: "s", sourceId: "left", name: "左侧", role: "editor" }] }]);
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: RequestInit) => {
      const url = new URL(input); calls.push({ url, init });
      if (init.method === "PUT") {
        const role = JSON.parse(String(init.body)).role;
        replies.set("left", [{ ...self, role: "owner" }, { ...editor, role, inherited: false }]);
        return json({ updated: true });
      }
      return json({ documentId: "left", originSpaceId: "mine", selfId: "me", participants: replies.get("left") });
    }));
    await mount("left");
    await act(async () => button("Alice").click());
    const permission = document.querySelector<HTMLSelectElement>('[aria-label="Alice Wang 的权限"]')!;
    expect(permission.disabled).toBe(false);
    await act(async () => { permission.value = "viewer"; permission.dispatchEvent(new Event("change", { bubbles: true })); });
    const update = calls.find(call => call.init.method === "PUT")!;
    expect(update.url.pathname).toBe("/v1/sharing/documents/left/collaborators/editor");
    expect(new Headers(update.init.headers).get("x-zioon-space-id")).toBe("mine");
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Alice Wang 的权限"]')?.value).toBe("viewer");
    await act(async () => {
      const select = document.querySelector<HTMLSelectElement>('[aria-label="Alice Wang 的权限"]')!;
      select.value = "removed"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(calls.filter(call => call.init.method === "PUT")).toHaveLength(1);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("移除");
  });
  it("hides self, uses initials, and shows authoritative role and presence on hover or keyboard click", async () => {
    await mount();
    expect(header.querySelectorAll("button")).toHaveLength(2);
    expect(button("林小雨").textContent).toBe("林");
    expect(button("Alice").textContent).toBe("AW");
    expect(header.textContent).not.toContain("我");
    expect(header.querySelector("img")).toBeNull();
    await act(async () => {
      button("Alice").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 200));
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("来自文件夹分享");
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("正在此文档中");
    await act(async () => button("Alice").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Alice Wang");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("关闭参与者信息");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Alice"));
  });
  it("bounds avatars and exposes overflow through a scrollable list, without showing private profile data", async () => {
    replies.set("doc", [self, owner, editor, ...Array.from({ length: 5 }, (_, i) => ({ ...editor, id: `peer${i}`, name: `伙伴 ${i}` }))]);
    await mount();
    expect(header.querySelectorAll(".editor-participant-button")).toHaveLength(4);
    const overflow = button("查看全部");
    expect(overflow.textContent).toBe("+3");
    await act(async () => overflow.click());
    expect(document.querySelectorAll(".editor-participant-detail")).toHaveLength(7);
    await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("addresses a received document with the caller's own account and keeps split panels independent", async () => {
    const shared = registerSharedWorkbenchDocument({ documentId: "remote", originSpaceId: "theirs", role: "viewer", title: "远端" } as any);
    const nextHeader = document.createElement("header"); nextHeader.dataset.secondHeader = ""; document.body.appendChild(nextHeader);
    replies.set("own", [{ ...editor, name: "自己的参与者" }, self]);
    replies.set("remote", [owner, self]);
    await mount("own"); await mount(shared.localId, nextHeader);
    expect(header.textContent).toContain("自己的".slice(0, 1));
    expect(button("林小雨", header)).toBeUndefined();
    expect(button("林小雨", nextHeader)).toBeTruthy();
    const remote = calls.find(call => call.url.pathname.includes("/remote/"));
    expect(remote?.url.searchParams.get("origin")).toBe("theirs");
    expect(new Headers(remote?.init.headers).get("x-zioon-space-id")).toBe("mine");
    expect(new Headers(remote?.init.headers).has("x-zioon-content-space")).toBe(false);
  });
  it("aborts an old document request and ignores a late response after switching to a private or file tab", async () => {
    let resolveOld!: (response: Response) => void;
    replies.set("old", () => new Promise(resolve => { resolveOld = resolve; }));
    replies.set("private", [self]);
    const tabs = await mount("old");
    const signal = calls[0].init.signal;
    await tabs.switch("private");
    expect(signal?.aborted).toBe(true);
    await act(async () => resolveOld(json({ documentId: "old", originSpaceId: "mine", selfId: "me", participants: [owner] })));
    expect(header.querySelector("button")).toBeNull();
    const count = calls.length;
    await tabs.switch("file:readme");
    expect(calls).toHaveLength(count);
  });
  it("hides failed presence and revoked access, and releases timers, portals and listeners", async () => {
    await mount();
    replies.set("doc", () => json({ error: "unavailable" }, 503));
    await act(async () => mounted[0].refresh());
    expect(button("林小雨")).toBeUndefined();
    replies.set("doc", () => json({ error: "revoked" }, 404));
    await act(async () => mounted[0].refresh());
    expect(header.querySelector("button")).toBeNull();
    replies.delete("doc");
    await act(async () => mounted[0].refresh());
    await act(async () => button("林小雨").click());
    await act(async () => mounted[0].dispose());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(header.children).toHaveLength(0);
    expect([...events.values()].every(listeners => !listeners.size)).toBe(true);
    const count = calls.length;
    await act(async () => { window.dispatchEvent(new Event("zion-account-changed")); document.dispatchEvent(new Event("visibilitychange")); });
    expect(calls).toHaveLength(count);
  });
  it("refreshes only matching document presence events and pauses polling while the page is hidden", async () => {
    await mount();
    const count = calls.length;
    await act(async () => {
      (window as any).zion.events.emit("collaboration/presenceChanged", { sessionId: "unrelated" });
      await new Promise(resolve => setTimeout(resolve, 240));
    });
    expect(calls).toHaveLength(count);
    await act(async () => {
      (window as any).zion.events.emit("collaboration/presenceChanged", { sessionId: "doc" });
      await new Promise(resolve => setTimeout(resolve, 240));
    });
    expect(calls).toHaveLength(count + 1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(button("林小雨")).toBeUndefined();
    expect(calls).toHaveLength(count + 1);
    vi.restoreAllMocks();
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(calls).toHaveLength(count + 2);
  });
  it("shows only other online users immediately before rename, preserving earlier header controls", async () => {
    const earlier = document.createElement("button"); earlier.className = "zion-editor-header-action"; header.appendChild(earlier);
    const action = document.createElement("button"); action.className = "zion-editor-header-action";
    action.dataset.zionEditorSessionRenameButton = "1"; header.appendChild(action);
    replies.set("doc", [owner, editor, self, { ...editor, id: "offline", name: "离线", online: false },
      { ...editor, id: "unknown", name: "未知", online: null }]);
    await mount();
    expect(header.querySelectorAll(".editor-participant-button")).toHaveLength(2);
    expect(header.firstElementChild).toBe(earlier);
    expect(action.previousElementSibling?.className).toBe("editor-participants-host");
    expect(header.lastElementChild).toBe(action);
    expect(button("离线")).toBeUndefined(); expect(button("未知")).toBeUndefined();
    replies.set("doc", [{ ...owner, online: false }, self]);
    await act(async () => mounted[0].refresh());
    expect(header.querySelector(".editor-participants")).toBeNull();
  });
});
