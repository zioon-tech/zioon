import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAccountSession } from "../packages/account-ui/src/client";
import { activityBarRuntime, sideBarRuntime } from "../src/ui/workbench/runtime";
import { captureSharingInvitation, mountSharingWorkbench } from "../src/ui/workbench/SharingWorkbench";
import { sharedWorkbenchDocument } from "../src/runtime/workbench-space";

let host: HTMLElement, mounted: ReturnType<typeof mountSharingWorkbench>;
let commands: Map<string, any>, calls: Array<{ path: string; method: string; body: any }>;
let changes: Map<string, Set<() => void>>;
const share = { id: "share1", kind: "model", sourceId: "profile1", name: "Alice 的模型",
  owner: { id: "alice", name: "Alice" }, role: "use", monthlyCalls: 1000, status: "active", originSpaceId: "owner" };
const json = (value: any, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const token = "a".repeat(43);
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); history.replaceState({}, "", "/");
  localStorage.setItem("zion.runtime.baseUrl", location.origin);
  host = document.createElement("div"); document.body.appendChild(host);
  commands = new Map(); calls = []; changes = new Map();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const subscribe = (key: string, fn: () => void) => {
    if (!changes.has(key)) changes.set(key, new Set());
    changes.get(key)!.add(fn); return { dispose() { changes.get(key)?.delete(fn); } };
  };
  (window as any).zion = {
    commands: { registerCommand: (id: string, fn: any) => { commands.set(id, fn); return { dispose() { commands.delete(id); } }; },
      executeCommand: vi.fn(async (id: string, target: string) => commands.get(id)?.(target) ?? true) },
    events: { emit: vi.fn(), on: subscribe }, state: { get: () => undefined, set: vi.fn(), onDidChange: subscribe }
  };
  setAccountSession({ user: { id: "receiver", name: "Receiver" }, space: { id: "mine", kind: "personal" }, scopes: ["runtime.write"] } as any);
  vi.stubGlobal("fetch", vi.fn(async (input: any, init = {}) => {
    const url = new URL(input), method = (init as any).method || "GET", body = (init as any).body ? JSON.parse((init as any).body) : null;
    calls.push({ path: url.pathname + url.search, method, body });
    if (url.pathname.endsWith("/sources")) return json({ sources: [{ id: "profile1", name: "我的模型" }] });
    if (url.pathname.endsWith("/preview")) return json({ share });
    if (url.pathname.endsWith("/accept")) return json({ share });
    if (url.pathname.endsWith("/privacy")) return json({ private: false, sharedContent: true });
    if (url.pathname.endsWith("/participants")) return json({ selfId: "receiver",
      participants: [{ id: "receiver", role: "editor" }] });
    if (url.pathname.startsWith("/v1/sharing/links/")) return json({ documentId: "same", originSpaceId: "owner", title: "共同计划", role: "viewer" });
    if (url.pathname.endsWith("/invitations")) return json({ invitation: { url: `${location.origin}/#share=${token}` } }, 201);
    if (method === "POST" && url.pathname === "/v1/sharing") return json({ share, invitation: { url: `${location.origin}/#share=${token}` } }, 201);
    if (url.searchParams.get("direction") === "received") return json({ shares: [
      share, { ...share, id: "docshare", kind: "document", sourceId: "same", name: "共同计划", role: "editor" }
    ] });
    return json({ shares: [{ ...share, recipients: [{ id: "bob", name: "Bob", status: "active", role: "use" }], invitations: [] }] });
  }));
});
afterEach(async () => {
  await act(async () => mounted?.dispose());
  host.remove(); setAccountSession(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});
async function mount() {
  await act(async () => { mounted = mountSharingWorkbench(host); sideBarRuntime.getView("sharing.list")!.component.render(host); });
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label);
  expect(button, label).toBeTruthy(); await act(async () => button!.click());
}
describe("minimal native sharing sidebar", () => {
  it("refreshes the invitation review name while preserving the pasted link and acceptance state", async () => {
    history.replaceState({}, "", `/#share=${token}`);
    await mount();
    const name = share.name;
    try {
      share.name = "更新后的模型标签";
      await act(async () => {
        changes.get("sharing/changed")?.forEach(fn => fn());
        await new Promise(resolve => setTimeout(resolve, 240));
      });
      expect(document.querySelector(".sharing-review strong")?.textContent).toBe(share.name);
      expect(document.querySelector<HTMLInputElement>('[placeholder="粘贴分享邀请链接"]')?.value).toBe(token);
      expect([...document.querySelectorAll("button")].some(node => node.textContent === "接受分享")).toBe(true);
    } finally { share.name = name; }
  });
  it("refreshes an open folder detail after rename without losing the selection or clearing its contents", async () => {
    let name = "原共享目录", title = "原会话";
    const folder = () => ({ ...share, id: "folder-share", kind: "folder", sourceId: "folder", role: "viewer", name });
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/documents")) return json({ share: folder(),
        tree: { id: "folder", type: "folder", title: name, children: [{ id: "doc", type: "session", title }] } });
      return json({ shares: [folder()] });
    }));
    await mount(); await click("查看 原共享目录 的分享详情");
    expect(host.querySelector(".sharing-folder")?.textContent).toContain("原会话");
    name = "共同清单测试"; title = "现在的会话";
    await act(async () => {
      changes.get("sessions.treeMem")?.forEach(fn => fn());
      await new Promise(resolve => setTimeout(resolve, 240));
    });
    expect(host.querySelector(".sharing-inspector h2")?.textContent).toBe(name);
    expect(host.querySelector(".sharing-folder")?.textContent).toContain(title);
    expect(host.querySelector(".sharing-inspector")).toBeTruthy();
    expect(host.textContent).not.toContain("正在读取");
    await act(async () => mounted.dispose());
    expect([...changes.values()].every(value => value.size === 0)).toBe(true);
  });
  it("opens a granted stable link in the original editor after rechecking the logged-in account", async () => {
    history.replaceState({}, "", `/?shareLink=${token}`);
    await mount();
    expect(calls.some(call => call.path === `/v1/sharing/links/${token}`)).toBe(true);
    const open = (window as any).zion.commands.executeCommand.mock.calls.find((call: any) => call[0] === "zion.sessions.switch");
    expect(sharedWorkbenchDocument(open[1])).toMatchObject({ documentId: "same", originSpaceId: "owner", role: "viewer" });
    expect(location.search).toBe("");
  });
  it("uses the Activity Bar and original editor without mounting a top Space shell", async () => {
    await mount();
    expect(activityBarRuntime.getItems().find(item => item.id === "sharing.activity")?.sideBarViewId).toBe("sharing.list");
    expect(host.querySelector(".zs-shell")).toBeNull();
    await click("打开");
    const open = (window as any).zion.commands.executeCommand.mock.calls.find((call: any) => call[0] === "zion.sessions.switch");
    expect(open).toBeTruthy(); expect(sharedWorkbenchDocument(open[1])).toMatchObject({ documentId: "same", originSpaceId: "owner", role: "editor" });
    expect(calls.every(call => !/contacts|groups|members|spaces/.test(call.path))).toBe(true);
  });
  it("reuses an existing model share for one-person invitations and provides a selectable link", async () => {
    await mount(); await click("分享模型"); await click("生成邀请链接");
    expect(calls.find(call => call.method === "POST" && call.path === "/v1/sharing/share1/invitations")).toBeTruthy();
    const input = document.querySelector('input[aria-label="邀请链接"]') as HTMLInputElement;
    expect(input.value).toContain(`#share=${token}`); expect(input.readOnly).toBe(true);
  });
  it("captures fragment invitations before login and requires a review before accepting", async () => {
    history.replaceState({}, "", `/#share=${token}`);
    expect(captureSharingInvitation()).toBe(token); expect(location.hash).toBe("");
    await mount(); expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Alice");
    expect(calls.some(call => call.path.endsWith("/accept"))).toBe(false);
    await click("接受分享");
    expect(calls.find(call => call.path.endsWith("/accept"))?.body).toEqual({ token });
    expect(sessionStorage.getItem("zion.sharing.pendingInvitation")).toBeNull();
  });
  it("revokes an individual recipient through the sent share detail", async () => {
    await mount(); await click("我分享的"); await click("查看 Alice 的模型 的分享详情"); await click("撤销"); await click("确认");
    expect(calls.find(call => call.path.endsWith("/share1/revoke"))?.body).toEqual({ recipientId: "bob" });
  });
  it("keeps permissions and destructive actions inside details and filters the compact resource list", async () => {
    await mount();
    expect(host.textContent).not.toContain("移除");
    expect(host.querySelectorAll(".sharing-row")).toHaveLength(2);
    expect(host.querySelectorAll(".shared-resource-marker")).toHaveLength(2);
    const input = host.querySelector('input[aria-label="搜索分享"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "共同"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(host.querySelectorAll(".sharing-row")).toHaveLength(1);
    await click("查看 共同计划 的分享详情");
    expect(host.textContent).toContain("可编辑");
    expect(host.textContent).toContain("移除收到的分享");
    expect(host.textContent).not.toContain("已授权用户");
  });
  it("loads authoritative privacy and saves a private child without changing its folder grants", async () => {
    await mount();
    await act(async () => commands.get("zion.sharing.create")({ kind: "document", sourceId: "child", name: "私密事项", managePrivacy: true }));
    expect(calls.find(call => call.path.endsWith("/documents/child/privacy"))?.method).toBe("GET");
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => checkbox.click()); await click("保存");
    expect(calls.find(call => call.method === "PUT")?.body).toEqual({ private: true });
    expect(calls.find(call => call.method === "PUT")?.path).toBe("/v1/sharing/documents/child/privacy");
  });
  it("shows malformed fragment invites in an editable dialog without blocking the Workbench", async () => {
    history.replaceState({}, "", "/#share=invalid");
    await mount();
    const input = document.querySelector('input[placeholder="粘贴分享邀请链接"]') as HTMLInputElement;
    expect(input.value).toBe("invalid");
    expect(calls.some(call => call.path.endsWith("/accept"))).toBe(false);
  });
});
