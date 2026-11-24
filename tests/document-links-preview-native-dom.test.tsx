import { act } from "react";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const enabled = process.env.ZIOON_SHARING_PREVIEW_ACCEPTANCE === "1";
const native = globalThis.fetch;
describe.skipIf(!enabled)("document links and avatar permissions in the persistent local preview", () => {
  it("uses actual header settings, approves a registered requester and changes permissions from an online avatar", async () => {
    vi.resetModules(); localStorage.clear(); sessionStorage.clear();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const directory = resolve(".runtime-data/spaces-preview");
    const config = JSON.parse(readFileSync(resolve(directory, "config.local.json"), "utf8"));
    const keepForRestart = process.env.ZIOON_LINK_PREVIEW_CLEANUP !== "1";
    const [owner, reader, guest] = config.accounts, doc = `native-link-${randomUUID()}`;
    const call = async (user: any, path: string, body?: any, method = body === undefined ? "GET" : "POST", scoped = false) => {
      const response = await native(config.runtimeUrl + path, { method, headers: {
        authorization: `Bearer ${user.token}`, "x-zioon-space-id": user.personalSpaceId, "content-type": "application/json",
        "x-zion-workbench-protocol": "6", ...(scoped ? { "x-zioon-content-space": owner.personalSpaceId, "x-zioon-content-document": doc } : {})
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const subscriptions: any[] = [], menus = new Map<string, any>(), commands = new Map<string, any>(), listeners = new Map<string, Set<any>>();
    const disposable = () => ({ dispose() {} });
    (window as any).zion = {
      __editorHeaderMenuRegistry: { register: (item: any) => { menus.set(item.id, item); return disposable(); } },
      state: { get: (key: string) => key === "runtime.connection" ? { backend: "runtime", baseUrl: config.runtimeUrl }
        : key === "sessions.currentId" ? "unrelated-active-split" : undefined, set: vi.fn(), onDidChange: disposable },
      commands: { registerCommand: (id: string, fn: any) => { commands.set(id, fn); return disposable(); },
        executeCommand: (id: string, ...args: any[]) => commands.get(id)?.(...args) },
      editor: { registerDecorator: disposable, getCore: () => null }, keybindings: { register: disposable },
      settings: { registerPage: disposable }, i18n: { registerNamespace: disposable }, contextMenus: { register: disposable },
      events: { on: (topic: string, fn: any) => { if (!listeners.has(topic)) listeners.set(topic, new Set()); listeners.get(topic)!.add(fn);
        return { dispose() { listeners.get(topic)?.delete(fn); } }; }, emit: (topic: string, value: any) => listeners.get(topic)?.forEach(fn => fn(value)) }
    };
    localStorage.setItem("zion.runtime.baseUrl", config.runtimeUrl);
    vi.stubGlobal("fetch", (input: any, init: RequestInit = {}) => {
      const headers = new Headers(init.headers); headers.set("authorization", `Bearer ${owner.token}`);
      return native(input, { ...init, headers });
    });
    const account = await import("../packages/account-ui/src/client");
    account.setAccountSession((await call(owner, "/v1/account/me")).value);
    const { activate } = await import("../extensions/dev.editor-config/main.js");
    await activate({ subscriptions });
    const waitFor = async (assertion: () => void) => vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); assertion();
    }, { timeout: 10000 });
    const click = async (label: string, container: ParentNode = document) => act(async () => {
      const node = [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label)!;
      expect(node, label).toBeTruthy(); node.click();
    });
    const select = async (label: string, value: string, container: ParentNode = document) => act(async () => {
      const node = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
      expect(node).toBeTruthy(); node.value = value; node.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const openSettings = async () => {
      await act(async () => menus.get("dev.editor.menu.access").onClick({ panelId: "left", sessionId: doc }));
      await waitFor(() => expect(document.querySelector(".document-access")).toBeTruthy());
    };
    const closeSettings = async () => act(async () => document.querySelector<HTMLButtonElement>('.document-access-dialog [aria-label="关闭"]')?.click());
    const sockets: any[] = [], header = document.createElement("header"); document.body.appendChild(header);
    let participants: any, complete = false;
    try {
      expect((await call(owner, `/v1/workbench-state/sessions/${doc}`, { text: "user 固定链接原文", meta: { title: "链接验收临时文档" } }, "PUT")).status).toBe(200);
      await openSettings();
      expect(document.getElementById("dev-editor-config-panel")).toBeNull();
      expect(document.querySelector(".document-access-dialog")?.textContent).not.toContain("Line Numbers");
      await waitFor(() => expect([...document.querySelectorAll("button")].find(node => node.textContent === "创建受限分享链接")).toBeTruthy());
      await click("创建受限分享链接");
      await waitFor(() => expect(document.querySelector<HTMLInputElement>('[aria-label="会话分享链接"]')?.value).toContain("/share/"));
      const url = document.querySelector<HTMLInputElement>('[aria-label="会话分享链接"]')!.value;
      const linkId = url.split("/").at(-1)!;
      expect(await (await native(url)).text()).not.toContain("固定链接原文");
      await select("链接访问范围", "public"); expect((await call(owner, `/v1/sharing/documents/${doc}/link`)).value.link.mode).toBe("restricted");
      await click("开启公开阅读");
      await waitFor(() => expect(document.querySelector<HTMLSelectElement>('[aria-label="链接访问范围"]')?.value).toBe("public"));
      expect(await (await native(url)).text()).toContain("固定链接原文");
      await select("链接访问范围", "restricted");
      await waitFor(() => expect(document.querySelector<HTMLSelectElement>('[aria-label="链接访问范围"]')?.disabled).toBe(false));
      const request = async (user: any) => native(url + "/request", { method: "POST", redirect: "manual",
        headers: { authorization: `Bearer ${user.token}`, origin: config.runtimeUrl, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ role: "editor", message: "原生预览访问申请" }).toString() });
      expect((await request(reader)).status).toBe(303);
      await closeSettings(); await openSettings();
      await waitFor(() => expect(document.querySelector(`[aria-label="${reader.name} 的批准权限"]`)).toBeTruthy());
      await select(`${reader.name} 的批准权限`, "viewer"); await click("批准");
      await waitFor(() => expect(document.querySelector(".sharing-access-request")).toBeNull());
      expect((await call(reader, "/v1/sharing/content")).value.received.some((node: any) => node.id === doc && node.role === "viewer")).toBe(true);
      expect((await call(reader, `/v1/workbench-state/sessions/${doc}`, { text: "DENIED_VIEWER" }, "PUT", true)).status).toBe(404);
      await waitFor(() => expect(document.querySelector(`[aria-label="${reader.name} 的权限"]`)).toBeTruthy());
      await select(`${reader.name} 的权限`, "editor");
      await waitFor(() => expect(document.querySelector<HTMLSelectElement>(`[aria-label="${reader.name} 的权限"]`)?.disabled).toBe(false));
      expect((await call(reader, `/v1/workbench-state/sessions/${doc}`, { text: "user 批准后更新的原文" }, "PUT", true)).status).toBe(200);
      await closeSettings();
      const { HocuspocusProvider } = await import("@hocuspocus/provider"), { default: WebSocket } = await import("ws"), Y = await import("yjs");
      const connect = async (user: any) => {
        class Socket extends WebSocket { constructor(address: any, protocols: any) { super(address, protocols, {
          origin: config.runtimeUrl, headers: { authorization: `Bearer ${user.token}` }
        }); } }
        const document = new Y.Doc();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Native collaboration sync timeout")), 10000);
          const provider = new HocuspocusProvider({ url: `${config.runtimeUrl.replace(/^http/, "ws")}/v1/collaboration?${new URLSearchParams({
            protocol: "6", space: user.personalSpaceId, content_space: owner.personalSpaceId, content_document: doc
          })}`, name: doc, document, token: user.token, WebSocketPolyfill: Socket as any,
            onSynced() { clearTimeout(timer); resolve(); }, onAuthenticationFailed({ reason }) { clearTimeout(timer); reject(new Error(reason)); } });
          sockets.push({ provider, document });
        });
      };
      await connect(owner); await connect(reader);
      const { mountEditorParticipants } = await import("../src/ui/workbench/EditorParticipants");
      await act(async () => { participants = mountEditorParticipants(header, { sessionId: () => doc, pollMs: 60000 }); });
      await waitFor(() => expect(header.querySelector("button")).toBeTruthy());
      await act(async () => header.querySelector<HTMLButtonElement>("button")!.click());
      await select(`${reader.name} 的权限`, "viewer", document.querySelector(".editor-participants-card")!);
      await vi.waitFor(async () => {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
        expect((await call(reader, `/v1/sharing/links/${linkId}`)).value.role).toBe("viewer");
      }, { timeout: 10000 });
      expect((await call(reader, `/v1/workbench-state/sessions/${doc}`, { text: "DENIED_AFTER_AVATAR" }, "PUT", true)).status).toBe(404);
      expect((await call(reader, `/v1/sharing/links/${linkId}`)).value.role).toBe("viewer");
      expect((await request(guest)).status).toBe(303);
      expect((await call(owner, `/v1/sharing/documents/${doc}/link`, { mode: "public" }, "PUT")).status).toBe(200);
      const stage = { documentId: doc, linkId, ownerId: owner.userId, readerId: reader.userId, guestId: guest.userId,
        pendingId: (await call(owner, `/v1/sharing/documents/${doc}/requests`)).value.requests[0].id };
      if (keepForRestart) writeFileSync(resolve(directory, "acceptance/document-links-stage.json"), JSON.stringify(stage, null, 2));
      writeFileSync(resolve(directory, "acceptance/document-links-native-dom.json"), JSON.stringify({ status: "PASS", checks: [
        "actual editor-header menu opens settings for the clicked split document",
        "restricted URL prevents anonymous body access", "explicit public confirmation opens current body reading",
        "registered requester submits a native access form", "owner approves a lower viewer permission in actual settings",
        "received session list includes approved document", "viewer write rejected, editor promotion allows original-document editing",
        "authenticated native WebSocket users appear as avatars", "pinned avatar dropdown downgrades actual recipient",
        "HTTP immediately rejects writes after avatar downgrade",
        keepForRestart ? "public link and a pending request staged for restart verification"
          : "public link and pending request verified; temporary content cleaned afterward"
      ] }, null, 2));
      complete = true;
    } finally {
      await act(async () => { participants?.dispose(); await closeSettings(); });
      sockets.forEach(({ provider, document }) => { provider.destroy(); document.destroy(); });
      header.remove(); subscriptions.forEach(item => item?.dispose?.()); account.setAccountSession(null); vi.unstubAllGlobals();
      if (!complete || !keepForRestart) {
        const sent = (await call(owner, "/v1/sharing?direction=sent")).value.shares || [];
        for (const share of sent.filter((share: any) => share.sourceId === doc)) await call(owner, `/v1/sharing/${encodeURIComponent(share.id)}/revoke`, {});
        await call(owner, `/v1/workbench-state/sessions/${doc}`, undefined, "DELETE");
      }
    }
  }, 45000);
});
