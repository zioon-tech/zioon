import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAccountSession } from "../packages/account-ui/src/client";
import { mountSpacesWorkbench } from "../src/ui/workbench/SpacesWorkbench";

let host: HTMLElement, mounted: ReturnType<typeof mountSpacesWorkbench>;
let calls: Array<{ path: string; method: string; body: any; headers: Headers }>;
const json = (value: any, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const spaces = [{ id: "one", name: "Together", kind: "team", membership: { role: "owner", status: "active" } },
  { id: "personal", name: "Personal", kind: "personal", membership: { role: "owner", status: "active" } }];
const members = [{ id: "alice", name: "Alice", role: "owner" }, { id: "bob", name: "Bob", role: "member" }];
const snapshot = (personal = false) => ({ document: { id: "doc", protection: personal ? "restricted" : "space", audienceMode: personal ? "specific" : "space", aclRevision: 3 },
  access: { role: "manager" }, grants: [{ subjectType: "user", subjectId: "alice", role: "manager" }],
  content: { title: "Weekend plans", text: "**Ready**\n\n| Plan | Cost |\n|---|---|\n| Walk | 0 |", revision: 8 } });
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); localStorage.setItem("zion.runtime.baseUrl", location.origin);
  history.replaceState({}, "", "/?space=one"); host = document.createElement("div"); document.body.appendChild(host);
  Object.assign(HTMLDialogElement.prototype, { showModal() { this.open = true; }, close() { this.open = false; } });
  (window as any).zion = {
    state: { get: (key: string) => key === "sessions.currentId" ? "doc" : undefined }, sessions: { resolveContext: () => ({ sessionId: "doc" }) },
    commands: { executeCommand: vi.fn(async () => true) }, events: { on: () => ({ dispose() {} }) }
  };
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any = {}) => {
    const path = new URL(url, location.origin).pathname, method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null; calls.push({ path, method, body, headers: new Headers(init.headers) });
    if (path === "/v1/account/spaces") return json({ spaces });
    if (path === "/v1/contacts") return json({ contacts: [{ id: "bob", name: "Bob" }], contactCode: "alice" });
    if (path.endsWith("/members")) return json({ members });
    if (path.endsWith("/groups")) return json({ groups: [] });
    if (path.endsWith("/comments")) return json({ comments: [] });
    if (path.endsWith("/publications")) return json({ publications: [] });
    if (path.endsWith("/documents/doc")) return json(snapshot(path.includes("/personal/")));
    if (path.endsWith("/documents/transfer")) return json({ document: { id: "copy" } });
    if (path.endsWith("/access")) return json({ document: snapshot().document });
    return json({});
  }));
});
afterEach(async () => {
  await act(async () => { mounted?.dispose(); });
  mounted = null; host.remove(); setAccountSession(null); vi.unstubAllGlobals();
});
async function mount(personal = false) {
  setAccountSession({ user: { id: "alice", name: "Alice" }, space: spaces[personal ? 1 : 0], membership: spaces[0].membership,
    spaces, scopes: ["runtime.write", "run.execute"] } as any);
  await act(async () => { mounted = mountSpacesWorkbench(host); });
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === label);
  expect(button, `button: ${label}`).toBeTruthy();
  await act(async () => button!.click());
}
async function select(label: string, value: string) {
  const element = [...document.querySelectorAll("label.zs-field")].find(node => node.firstElementChild?.textContent === label)?.querySelector("select");
  expect(element).toBeTruthy();
  await act(async () => { element!.value = value; element!.dispatchEvent(new Event("change", { bubbles: true })); });
}
describe("existing Workbench Space interactions", () => {
  it("saves explicit document access with the current ACL revision and Space", async () => {
    await mount(); await click("分享文档");
    await select("安全等级", "restricted"); await click("保存分享设置");
    const write = calls.find(call => call.method === "PUT");
    expect(write?.path).toBe("/v1/spaces/one/documents/doc/access");
    expect(write?.headers.get("x-zioon-space-id")).toBe("one");
    expect(write?.body).toEqual({ expectedRevision: 3, protection: "restricted", audienceMode: "specific",
      grants: [{ subjectType: "user", subjectId: "alice", role: "manager" }] });
  });
  it("keeps personal access private and requires review before copying into a shared Space", async () => {
    await mount(true); await click("分享文档");
    const protection = [...document.querySelectorAll("select")].find(node => node.value === "restricted");
    expect(protection?.disabled).toBe(true);
    await click("共享副本"); await select("目标空间", "one");
    const submit = [...document.querySelectorAll("button")].find(node => node.textContent === "创建共享副本")!;
    expect(submit.disabled).toBe(true);
    const review = [...document.querySelectorAll("label.zs-toggle")].find(node => node.textContent?.includes("我已检查"))!.querySelector("input")!;
    await act(async () => review.click()); await click("创建共享副本");
    const transfer = calls.find(call => call.path.endsWith("/documents/transfer"));
    expect(transfer?.body.sourceSpaceId).toBe("personal"); expect(transfer?.body.sourceRevision).toBe(8);
    expect(transfer?.body.reviewed).toBe(true); expect(transfer?.body).not.toHaveProperty("audience");
    expect(transfer?.body).not.toHaveProperty("metadata");
    expect((window as any).zion.commands.executeCommand).toHaveBeenCalledWith("zion.sessions.flushRunInput", "doc");
  });
});
