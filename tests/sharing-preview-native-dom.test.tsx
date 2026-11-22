import { act } from "react";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const enabled = process.env.ZIOON_SHARING_PREVIEW_ACCEPTANCE === "1";
const native = globalThis.fetch;
describe.skipIf(!enabled)("native Sharing sidebar with the real Session Manager", () => {
  it("opens original shared content with qualified caches and leaves the private catalog intact", async () => {
    vi.resetModules(); localStorage.clear(); sessionStorage.clear(); history.replaceState({}, "", "/");
    const directory = resolve(".runtime-data/spaces-preview");
    const config = JSON.parse(readFileSync(resolve(directory, "config.local.json"), "utf8"));
    const account = config.accounts[1];
    const values = new Map<string, any>();
    const commands = new Map<string, (...args: any[]) => any>();
    const events = new Map<string, Set<(...args: any[]) => void>>();
    const views = new Map<string, any>(), headerMenus = new Map<string, any>();
    const disposable = () => ({ dispose() {} });
    let editorText = "", editorId = "";
    const editor = { getValue: () => editorText, setValue: (text: string) => { editorText = text; },
      setSessionId: (id: string) => { editorId = id; }, getSessionId: () => editorId,
      getView: () => null, getCursor: () => ({ line: 0, ch: 0 }), focus() {} };
    values.set("runtime.connection", { backend: "runtime", baseUrl: config.runtimeUrl });
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    (window as any).zion = {
      state: { get: (key: string) => values.get(key), set: (key: string, value: any) => values.set(key, value), onDidChange: disposable },
      commands: { registerCommand: (id: string, fn: any) => { commands.set(id, fn); return { dispose() { commands.delete(id); } }; },
        executeCommand: (id: string, ...args: any[]) => commands.get(id)?.(...args) },
      events: { on: (topic: string, fn: any) => {
        if (!events.has(topic)) events.set(topic, new Set()); events.get(topic)!.add(fn);
        return { dispose() { events.get(topic)?.delete(fn); } };
      }, emit: (topic: string, ...args: any[]) => { for (const fn of events.get(topic) || []) fn(...args); } },
      window: { activeEditor: editor }, editor: { registerViewPlugin: disposable, registerDecorator: disposable },
      sessions: { resolveContext: () => ({ sessionId: values.get("sessions.currentId") || "", editor }) },
      menus: { registerItem: disposable }, keybindings: { register: disposable },
      statusBar: { registerItem: disposable, updateItem() {} }, slash: { registerCommand: disposable },
      sidebar: { registerView: disposable }, sideBar: { registerView: (view: any) => { views.set(view.id, view); return disposable(); } },
      activityBar: { registerItem: disposable, activateItem() {} },
      __editorHeaderMenuRegistry: { register: (item: any) => { headerMenus.set(item.id, item); return disposable(); } },
      settings: { registerPage: disposable },
      tools: { registerTool: disposable }, notification: { show() {} }
    };
    localStorage.setItem("zion.runtime.baseUrl", config.runtimeUrl);
    localStorage.setItem("zion.runtime.mode", "runtime");
    const calls: Array<{ path: string; space: string | null; document: string | null }> = [];
    vi.stubGlobal("fetch", async (input: any, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${account.token}`);
      calls.push({ path: url.pathname, space: headers.get("x-zioon-space-id"), document: headers.get("x-zioon-content-document") });
      return native(url, { ...init, headers });
    });
    const sharingScope = await import("../src/runtime/workbench-space");
    const accountClient = await import("../packages/account-ui/src/client");
    const me = await (await native(config.runtimeUrl + "/v1/account/me", { headers: {
      authorization: `Bearer ${account.token}`, "x-zioon-space-id": account.personalSpaceId
    } })).json();
    accountClient.setAccountSession(me);
    sharingScope.installWorkbenchSpaceTransport(config.runtimeUrl);
    sharingScope.pinWorkbenchSpace(me, config.runtimeUrl);
    const index = await (await native(config.runtimeUrl + "/v1/sharing/content", { headers: {
      authorization: `Bearer ${account.token}`, "x-zioon-space-id": account.personalSpaceId
    } })).json();
    const nodes: any[] = [];
    const collect = (node: any) => { nodes.push(node); (node.children || []).forEach(collect); };
    index.received.forEach(collect);
    const sharedFolderTitle = nodes.find(node => node.id === config.sharingFolderId)?.title;
    const sharedChildTitle = nodes.find(node => node.id === config.sharingFolderDocumentId)?.title;
    const sharedRole = nodes.find(node => node.id === config.sharingDocumentId)?.role;
    expect(["viewer", "editor"]).toContain(sharedRole);
    expect(sharedFolderTitle).toBeTruthy(); expect(sharedChildTitle).toBeTruthy();
    const subscriptions: any[] = [];
    const host = document.createElement("div"); document.body.appendChild(host);
    const listHost = document.createElement("div"); document.body.appendChild(listHost);
    const header = document.createElement("header"); header.className = "zion-editor-header"; document.body.appendChild(header);
    const action = document.createElement("button"); action.className = "zion-editor-header-action"; header.appendChild(action);
    action.dataset.zionEditorSessionRenameButton = "1";
    let mounted: any, participants: any, list: any;
    const presenceClients: any[] = [];
    try {
      const { activate } = await import("../extensions/dev.session-manager/main.js");
      await activate({ subscriptions });
      expect(values.get("sessions.ready")).toBe(true);
      expect(commands.has("zion.sessions.switch")).toBe(true);
      const before = values.get("sessions.catalog").map((entry: any) => entry.id);
      const ownTree = JSON.stringify(values.get("sessions.treeMem"));
      await act(async () => { list = views.get("sessions.list").component.render(listHost); });
      await vi.waitFor(() => expect(listHost.textContent).toContain(sharedFolderTitle), { timeout: 6000 });
      const filter = (label: string) => [...listHost.querySelectorAll<HTMLButtonElement>(".session-sharing-filters button")].find(button => button.textContent === label)!;
      await act(async () => filter("收到的").click());
      expect(listHost.querySelector('[data-session-id^="shared-document:"]')).toBeTruthy();
      expect(listHost.querySelector('[data-session-id]:not([data-session-id^="shared-document:"])')).toBeNull();
      const folderRow = [...listHost.querySelectorAll<HTMLElement>(".is-folder")].find(row =>
        row.querySelector(".zion-session-folder-name")?.textContent === sharedFolderTitle)!;
      expect(folderRow.dataset.folderId).toMatch(/^shared-folder:/);
      expect(folderRow.draggable).toBe(false);
      expect(folderRow.querySelector(".shared-resource-marker")).toBeTruthy();
      await act(async () => folderRow.click());
      expect(listHost.textContent).toContain(sharedChildTitle);
      expect(listHost.textContent).not.toContain("文件夹里保留的私密笔记");
      await act(async () => filter("我分享的").click());
      expect(listHost.querySelector('[data-sharing="received"]')).toBeNull();
      await act(async () => filter("全部").click());
      expect(listHost.querySelector('[data-session-id]:not([data-session-id^="shared-document:"])')).toBeTruthy();
      const { HocuspocusProvider } = await import("@hocuspocus/provider");
      const { default: WebSocket } = await import("ws");
      const Y = await import("yjs");
      const owner = config.accounts[0];
      const originalPresence = await (await fetch(`${config.runtimeUrl}/v1/sharing/documents/${encodeURIComponent(config.sharingDocumentId)}/participants?origin=${encodeURIComponent(owner.personalSpaceId)}`)).json();
      const offlineProbe = config.accounts.find((a: any) => a.userId !== account.userId &&
        originalPresence.participants.find((person: any) => person.id === a.userId)?.online === false);
      const connect = async (a: any) => {
        class PreviewSocket extends WebSocket {
          constructor(address: string, protocols: any) { super(address, protocols, {
            origin: config.runtimeUrl, headers: { authorization: `Bearer ${a.token}` }
          }); }
        }
        const document = new Y.Doc();
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Presence timed out")), 10000);
          const provider = new HocuspocusProvider({ url: `${config.runtimeUrl.replace(/^http/, "ws")}/v1/collaboration?${new URLSearchParams({
            protocol: "6", space: a.personalSpaceId, content_space: owner.personalSpaceId, content_document: config.sharingDocumentId
          })}`, name: config.sharingDocumentId, document, token: a.token, WebSocketPolyfill: PreviewSocket as any,
            onSynced() { clearTimeout(timeout); resolve(); },
            onAuthenticationFailed({ reason }) { clearTimeout(timeout); reject(new Error(reason)); } });
          presenceClients.push({ provider, document });
        });
      };
      await connect(owner);
      if (offlineProbe && offlineProbe.userId !== owner.userId) await connect(offlineProbe);
      const { mountSharingWorkbench } = await import("../src/ui/workbench/SharingWorkbench");
      const { mountEditorParticipants } = await import("../src/ui/workbench/EditorParticipants");
      const { sideBarRuntime } = await import("../src/ui/workbench/runtime");
      await act(async () => {
        mounted = mountSharingWorkbench(host);
        participants = mountEditorParticipants(header, { sessionId: () => editorId,
          subscribe: refresh => [(window as any).zion.events.on("sessions/currentChanged", refresh)] });
        sideBarRuntime.getView("sharing.list")!.component.render(host);
      });
      await vi.waitFor(async () => {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
        expect(host.textContent).toContain("一起做旅行计划");
      }, { timeout: 6000 });
      const button = [...listHost.querySelectorAll<HTMLElement>(".is-session")].find(node =>
        sharingScope.sharedWorkbenchDocument(node.dataset.sessionId || "")?.documentId === config.sharingDocumentId);
      expect(button).toBeTruthy();
      await act(async () => button!.click());
      await vi.waitFor(async () => {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
        expect(values.get("sessions.currentId")).toMatch(/^shared-document:/);
      }, { timeout: 6000 });
      const localId = values.get("sessions.currentId");
      expect(editorId).toBe(localId);
      expect(editorText).toContain("旅行");
      await act(async () => participants.refresh());
      await vi.waitFor(async () => {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
        expect(header.querySelector(`[aria-label^="${config.accounts[0].name}，所有者"]`)).toBeTruthy();
      });
      const peer = header.querySelector<HTMLButtonElement>(`[aria-label^="${config.accounts[0].name}，所有者"]`)!;
      if (offlineProbe) expect(header.querySelector(`[aria-label^="${offlineProbe.name}，"]`)).toBeTruthy();
      await act(async () => peer.click());
      expect(document.querySelector(".editor-participants-card")?.textContent).toContain(config.accounts[0].name);
      expect(document.querySelector(".editor-participants-card")?.textContent).toContain("所有者");
      expect(header.querySelector(`[aria-label^="${account.name}，"]`)).toBeNull();
      expect(header.firstElementChild?.className).toBe("editor-participants-host");
      expect(header.lastElementChild).toBe(action);
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭参与者信息"]')!.click());
      expect(sharingScope.sharedWorkbenchDocument(localId)?.documentId).toBe(config.sharingDocumentId);
      expect(values.get("sessions.catalog").map((entry: any) => entry.id)).toEqual(before);
      expect(JSON.stringify(values.get("sessions.treeMem"))).toBe(ownTree);
      const { activate: activateConfig } = await import("../extensions/dev.editor-config/main.js");
      await act(async () => {
        await activateConfig({ subscriptions });
        headerMenus.get("dev.editor.menu.access").onClick({ sessionId: localId });
      });
      await vi.waitFor(async () => {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
        expect(document.querySelector(".document-access")?.textContent).toContain(config.accounts[2].name);
      });
      expect(document.querySelector(".document-access")?.textContent).toContain("阅读");
      expect(document.querySelector(".document-access")?.textContent).toContain("编辑");
      expect(document.querySelector(".document-access button")).toBeNull();
      await act(async () => document.querySelector<HTMLButtonElement>('.document-access-dialog [aria-label="关闭"]')!.click());
      presenceClients.forEach(client => client.provider.destroy());
      await vi.waitFor(async () => {
        await act(async () => participants.refresh());
        for (const person of originalPresence.participants.filter((person: any) => person.id !== account.userId)) {
          expect(Boolean(header.querySelector(`[aria-label^="${person.name}，"]`))).toBe(person.online === true);
        }
      }, { timeout: 6000 });
      expect(host.querySelectorAll(".sharing-row .shared-resource-marker").length).toBeGreaterThan(0);
      expect(host.textContent).not.toContain("撤销分享");
      const detail = host.querySelector<HTMLButtonElement>('[aria-label="查看 一起做旅行计划 的分享详情"]')!;
      await act(async () => detail.click());
      expect(host.querySelector(".sharing-inspector")?.textContent).toContain(sharedRole === "editor" ? "可编辑" : "可查看");
      expect(host.querySelector(".sharing-inspector")?.textContent).toContain("移除收到的分享");
      expect(calls.some(call => call.path === `/v1/workbench-state/sessions/${encodeURIComponent(config.sharingDocumentId)}`
        && call.space === account.personalSpaceId && call.document === config.sharingDocumentId)).toBe(true);
      expect(calls.some(call => call.path === `/v1/sharing/documents/${encodeURIComponent(config.sharingDocumentId)}/participants`
        && call.space === account.personalSpaceId && call.document === null)).toBe(true);
      const { prepareInteractiveRuntimeMessages } = await import("../extensions/dev.langchain-chat/runtime-backend.js");
      const privateContext = vi.fn(() => [{ role: "system", content: "RECEIVER_PRIVATE_MEMORY" }]);
      const messages = [{ role: "user", content: "共享内容" }];
      expect(await prepareInteractiveRuntimeMessages({ messages, contributorContext: { sessionId: localId },
        runContributors: privateContext })).toEqual(messages);
      expect(privateContext).not.toHaveBeenCalled();
      writeFileSync(resolve(directory, "acceptance/sharing-native-dom.json"), JSON.stringify({
        status: "PASS", checks: ["real Session Manager activation and switch command",
          "native Sharing sidebar API", "original shared text loads into native editor proxy",
          "qualified document caches", "private catalog contains only original own documents", "private contributors excluded"]
      }, null, 2));
      writeFileSync(resolve(directory, "acceptance/participants-native-dom.json"), JSON.stringify({
        status: "PASS", checks: ["real Session Manager opens the shared document",
          "header reads document participants using the caller's own account",
          "only other connected participants render before header buttons",
          "test socket disconnect restores pre-existing participants and hides offline peers",
          "click card shows real account name and document role", "native editor config lists offline reading/editing permissions"]
      }, null, 2));
      writeFileSync(resolve(directory, "acceptance/sharing-layout-native-dom.json"), JSON.stringify({
        status: "PASS", checks: ["received conversations in native Session Manager", "received folder hierarchy and private-child exclusion",
          "all / sent / received filters", "qualified IDs and received source markers", "original shared document opens through native session list",
          "private persisted tree/catalog unchanged", "received folders cannot be dragged",
          "Sharing sidebar compact list and permission inspector", "native editor config shows offline authorization",
          "actual WS connect/disconnect controls header avatars and left placement"]
      }, null, 2));
    } finally {
      presenceClients.forEach(client => { client.provider.destroy(); client.document.destroy(); });
      await act(async () => { document.getElementById("dev-editor-config-panel")?.remove(); participants?.dispose(); mounted?.dispose(); list?.dispose(); });
      for (const d of subscriptions.reverse()) d?.dispose?.();
      accountClient.setAccountSession(null); host.remove(); header.remove(); listHost.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    }
  }, 40000);
});
