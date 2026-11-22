import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAccountSession } from "../packages/account-ui/src/client";
import { activate } from "../extensions/dev.editor-config/main.js";

afterEach(async () => {
  await act(async () => {
    document.querySelector<HTMLButtonElement>('.document-access-dialog [aria-label="关闭"]')?.click();
    document.querySelector<HTMLElement>("#dev-editor-config-panel")?.remove();
  });
  setAccountSession(null); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
describe("the actual editor configuration plugin header actions", () => {
  it("registers share controls and scopes settings to the header document, preserving the active split", async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem("zion.runtime.baseUrl", location.origin);
    setAccountSession({ user: { id: "owner" }, space: { id: "mine", kind: "personal" }, sessionId: "login", scopes: ["runtime.write"] } as any);
    const menus = new Map<string, any>(), subscriptions: any[] = [], commands = new Map<string, any>();
    const disposable = () => ({ dispose() {} });
    const execute = vi.fn((id: string, ...args: any[]) => commands.get(id)?.(...args));
    (window as any).zion = {
      __editorHeaderMenuRegistry: { register: (item: any) => { menus.set(item.id, item); return disposable(); } },
      state: { get: (key: string) => key === "sessions.currentId" ? "active-right" : undefined,
        set: vi.fn(), onDidChange: disposable },
      commands: { registerCommand: (id: string, fn: any) => { commands.set(id, fn); return disposable(); }, executeCommand: execute },
      editor: { registerDecorator: disposable, getCore: () => null },
      keybindings: { register: disposable }, events: { on: disposable }, contextMenus: { register: disposable },
      i18n: { registerNamespace: disposable }, settings: { registerPage: disposable }
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      const result = path.endsWith("/participants") ? { selfId: "owner", participants: [{ id: "owner", role: "owner", name: "自己", online: true }] }
        : path.endsWith("/privacy") ? { private: false } : path.endsWith("/requests") ? { requests: [] } : { link: null };
      return new Response(JSON.stringify(result));
    }));
    await activate({ subscriptions } as any);
    const sharing = menus.get("dev.editor.menu.sharing"), access = menus.get("dev.editor.menu.access");
    expect(sharing.section).toBe("分享与权限");
    sharing.onClick({ panelId: "left", sessionId: "doc-left" });
    expect(execute).toHaveBeenCalledWith("zion.sharing.manage", { sourceId: "doc-left" });
    await act(async () => access.onClick({ panelId: "left", sessionId: "doc-left" }));
    expect(document.querySelector(".document-access")).toBeTruthy();
    expect((fetch as any).mock.calls.some(([url]: any) => url.includes("/documents/doc-left/participants"))).toBe(true);
    expect((fetch as any).mock.calls.some(([url]: any) => url.includes("active-right"))).toBe(false);
    expect(document.querySelector('[aria-label="链接访问范围"]')).toBeTruthy();
    const dialog = document.querySelector(".document-access-dialog")!;
    expect(dialog.getAttribute("aria-label")).toBe("访问权限与链接设置");
    expect(dialog.textContent).not.toMatch(/Line Numbers|Active Line Highlight|Syntax Highlight|Editor Width/);
    expect(document.getElementById("dev-editor-config-panel")).toBeNull();
    await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
    expect(document.querySelector(".document-access")).toBeNull();
    await act(async () => menus.get("dev.editor.menu.openConfigPanel").onClick({ panelId: "left", sessionId: "doc-left" }));
    const preferences = document.getElementById("dev-editor-config-panel")!;
    expect(preferences.textContent).toContain("Line Numbers");
    expect(preferences.querySelector(".document-access")).toBeNull();
    expect(preferences.querySelector('[aria-label="链接访问范围"]')).toBeNull();
    await act(async () => preferences.querySelector<HTMLButtonElement>(".editor-access-shortcut")!.click());
    expect(document.getElementById("dev-editor-config-panel")).toBeNull();
    expect(document.querySelector(".document-access-dialog")?.textContent).not.toContain("Line Numbers");
    expect((fetch as any).mock.calls.some(([url]: any) => url.includes("active-right"))).toBe(false);
    await act(async () => document.querySelector<HTMLButtonElement>('.document-access-dialog [aria-label="关闭"]')!.click());
    subscriptions.forEach(item => item?.dispose?.());
  });
});
