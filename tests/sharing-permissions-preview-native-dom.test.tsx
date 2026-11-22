import { act } from "react";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const enabled = process.env.ZIOON_SHARING_PREVIEW_ACCEPTANCE === "1";
const native = globalThis.fetch;
describe.skipIf(!enabled)("direct collaborators in the persistent native preview", () => {
  it("uses the same account lookup, sharing dialog and editor-config permission controls", async () => {
    vi.resetModules(); localStorage.clear(); sessionStorage.clear();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const directory = resolve(".runtime-data/spaces-preview");
    const config = JSON.parse(readFileSync(resolve(directory, "config.local.json"), "utf8"));
    const [owner, receiver] = config.accounts;
    const doc = `native-permissions-${randomUUID()}`;
    const commands = new Map<string, any>(), listeners = new Map<string, Set<any>>();
    const headers = { authorization: `Bearer ${owner.token}`, "x-zioon-space-id": owner.personalSpaceId,
      "content-type": "application/json", "x-zion-workbench-protocol": "5" };
    const call = async (account: any, path: string, body?: any, method = body === undefined ? "GET" : "POST", scoped = false) => {
      const response = await native(config.runtimeUrl + path, { method, headers: { ...headers,
        authorization: `Bearer ${account.token}`, "x-zioon-space-id": account.personalSpaceId,
        ...(scoped ? { "x-zioon-content-space": owner.personalSpaceId, "x-zioon-content-document": doc } : {})
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    (window as any).zion = { state: { get: (key: string) => key === "runtime.connection" ? { backend: "runtime", baseUrl: config.runtimeUrl } : undefined },
      commands: { registerCommand: (id: string, fn: any) => { commands.set(id, fn); return { dispose() { commands.delete(id); } }; },
        executeCommand: (id: string, ...args: any[]) => commands.get(id)?.(...args) },
      events: { on: (topic: string, fn: any) => {
        if (!listeners.has(topic)) listeners.set(topic, new Set()); listeners.get(topic)!.add(fn);
        return { dispose() { listeners.get(topic)?.delete(fn); } };
      }, emit: (topic: string) => { for (const fn of listeners.get(topic) || []) fn(); } }
    };
    localStorage.setItem("zion.runtime.baseUrl", config.runtimeUrl);
    vi.stubGlobal("fetch", (input: any, init: RequestInit = {}) => {
      const h = new Headers(init.headers); h.set("authorization", `Bearer ${owner.token}`);
      return native(input, { ...init, headers: h });
    });
    const accountClient = await import("../packages/account-ui/src/client");
    accountClient.setAccountSession((await call(owner, "/v1/account/me")).value);
    const host = document.createElement("div"); document.body.appendChild(host);
    const accessHost = document.createElement("div"); document.body.appendChild(accessHost);
    let mounted: any, access: any;
    const change = async (node: HTMLInputElement | HTMLSelectElement, value: string) => {
      const prototype = node.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
        node.dispatchEvent(new Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
      });
    };
    const click = async (label: string) => {
      const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label)!;
      expect(node, label).toBeTruthy(); await act(async () => node.click());
    };
    const waitFor = async (assertion: () => void) => vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); assertion();
    }, { timeout: 10000 });
    try {
      expect((await call(owner, `/v1/workbench-state/sessions/${doc}`, { text: "user 原生直接分享", meta: { title: "原生直接分享" } }, "PUT")).status).toBe(200);
      const { mountSharingWorkbench } = await import("../src/ui/workbench/SharingWorkbench");
      const { sideBarRuntime } = await import("../src/ui/workbench/runtime");
      const activate = vi.spyOn(sideBarRuntime, "activateView");
      await act(async () => {
        mounted = mountSharingWorkbench(host);
        sideBarRuntime.getView("sharing.list")!.component.render(host);
      });
      await act(async () => commands.get("zion.sharing.create")({ kind: "document", sourceId: doc, name: "原生直接分享" }));
      await waitFor(() => expect(document.querySelector<HTMLInputElement>('[aria-label="邮箱或账号 ID"]')?.disabled).toBe(false));
      expect(activate).not.toHaveBeenCalled();
      await change(document.querySelector('[aria-label="邮箱或账号 ID"]')!, receiver.email); await click("查找");
      await waitFor(() => expect(document.querySelector(".sharing-recipient-preview")?.textContent).toContain(receiver.name));
      await change(document.querySelector('[aria-label="新协作者权限"]')!, "editor"); await click("添加");
      await waitFor(() => expect(document.querySelector(`[aria-label="${receiver.name} 的权限"]`)).toBeTruthy());
      expect((await call(receiver, "/v1/sharing/content")).value.received.some((node: any) => node.id === doc && node.role === "editor")).toBe(true);
      expect(document.querySelector('[aria-label="邀请链接"]')).toBeNull();
      await click("完成");
      const { mountDocumentAccess } = await import("../src/ui/workbench/DocumentAccess");
      await act(async () => { access = mountDocumentAccess(accessHost, doc); });
      await waitFor(() => expect(accessHost.querySelector(`[aria-label="${receiver.name} 的权限"]`)).toBeTruthy());
      await change(accessHost.querySelector(`[aria-label="${receiver.name} 的权限"]`)!, "viewer");
      await waitFor(() => expect(accessHost.querySelector<HTMLSelectElement>(`[aria-label="${receiver.name} 的权限"]`)?.disabled).toBe(false));
      expect((await call(receiver, `/v1/workbench-state/sessions/${doc}`, { text: "forbidden" }, "PUT", true)).status).toBe(404);
      expect((await call(receiver, "/v1/sharing/content")).value.received.find((node: any) => node.id === doc).role).toBe("viewer");
      await click("管理分享");
      await waitFor(() => expect(document.querySelector(".sharing-collaborators")?.textContent).toContain(receiver.name));
      expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("分享会话");
      expect(activate).not.toHaveBeenCalled();
      writeFileSync(resolve(directory, "acceptance/sharing-permissions-native-dom.json"), JSON.stringify({
        status: "PASS", checks: ["existing command opens a share dialog without switching sidebars",
          "native exact verified-email lookup", "direct collaboration added without an invitation",
          "received content appears with editor permission", "native editor-config dropdown downgrades the recipient",
          "HTTP rejects writes immediately after downgrade", "received content reflects viewer permission",
          "editor-config reopens the same collaborator management dialog"]
      }, null, 2));
    } finally {
      await act(async () => { mounted?.dispose(); access?.dispose(); });
      const sent = (await call(owner, "/v1/sharing?direction=sent")).value.shares;
      for (const share of sent.filter((share: any) => share.sourceId === doc)) await call(owner, `/v1/sharing/${encodeURIComponent(share.id)}/revoke`, {});
      await call(owner, `/v1/workbench-state/sessions/${doc}`, undefined, "DELETE");
      accountClient.setAccountSession(null); host.remove(); accessHost.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    }
  }, 40000);
});
