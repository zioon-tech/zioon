import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App as AntApp, ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Marketplace } from "../src/marketplace";
import { login } from "../src/api";

vi.mock("../src/api", async (original) => ({
  ...await original<typeof import("../src/api")>(), login: vi.fn()
}));

let root: Root, host: HTMLDivElement, query: QueryClient;
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const entry = (id: string, name: string, kind: string, category: string, extra = {}) => ({
  id, name, kind, category, summary: name + " 的用途说明", description: "功能介绍", version: "1.0.0", digest: "digest",
  publisher: { id: "zion", name: "Zioon", origin: "official" }, components: [{ id: "main", name, kind }],
  versions: [{ version: "1.0.0", digest: "digest" }], ...extra
});
const until = async (predicate: () => boolean) => {
  for (let count = 0; count < 50; count++) {
    if (predicate()) return;
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  throw new Error("Expected UI did not appear");
};
beforeEach(() => {
  vi.mocked(login).mockClear();
  sessionStorage.clear();
  history.replaceState({}, "", "/");
  Object.defineProperty(window, "matchMedia", { value: vi.fn(() => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}
  })), configurable: true });
  window.scrollTo = vi.fn();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => { await act(() => root.unmount()); query.clear(); host.remove(); vi.unstubAllGlobals(); });
const mount = async () => act(() => root.render(<ConfigProvider><AntApp><QueryClientProvider client={query}>
  <BrowserRouter><Marketplace /></BrowserRouter></QueryClientProvider></AntApp></ConfigProvider>));

describe("standalone marketplace interactions", () => {
  it("edits a Skill file through ordinary Runs, then reloads the same installation", async () => {
    history.replaceState({}, "", "/plugins/personal-skill");
    const installed = entry("personal-skill", "个人技能", "skill", "开发", {
      artifact: { kind: "skill" }, installation: { enabled: true, version: "1.0.0",
        status: "ready", executionEpoch: "epoch", config: { nodeId: "managed:account", workspaceRoot: "/workspace" } }
    });
    const operations: any[] = [];
    let saved = "Original", hash = "first";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/session") return response({ authenticated: true, user: { id: "same-account", name: "Owner" } });
      if (url.endsWith("/v1/runs") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        operations.push(body);
        const args = body.metadata.extensionInvocation;
        if (args.action === "workspace-write") { saved = args.arguments.content; hash = "saved"; }
        return response({ runId: "run-" + operations.length });
      }
      if (url.includes("/v1/runs/run-")) return response({ run: { status: "completed",
        output: JSON.stringify({ directory: "/workspace/.zion/installed/fixture", hash, files: { "SKILL.md": saved } }) } });
      return response({ entries: [installed], categories: ["开发"], revision: 9 });
    }));
    await mount(); await until(() => !!host.querySelector(".detail-page"));
    expect(host.textContent).not.toContain("连接与设置");
    expect(host.textContent).not.toContain("验证连接");
    await act(() => ([...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "个人文件") as HTMLElement).click());
    await act(() => ([...host.querySelectorAll("button")].find((b) => b.textContent === "打开个人文件") as HTMLButtonElement).click());
    await until(() => !!host.querySelector('textarea[aria-label="个人文件内容"]'));
    const textarea = host.querySelector('textarea[aria-label="个人文件内容"]') as HTMLTextAreaElement;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Personal");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const reload = [...host.querySelectorAll("button")].find((b) => b.textContent === "重新加载") as HTMLButtonElement;
    expect(reload.disabled).toBe(true);
    await act(() => ([...host.querySelectorAll("button")].find((b) => b.textContent === "保存文件") as HTMLButtonElement).click());
    await until(() => operations.length === 2 && !reload.disabled);
    expect(operations[1].metadata.extensionInvocation).toMatchObject({ action: "workspace-write",
      listingId: installed.id, epoch: "epoch", arguments: { path: "SKILL.md", content: "Personal", expectedHash: "first" } });
    expect(operations[1].policy).toMatchObject({ preset: "trusted-automation", fileRoots: ["/workspace"] });
    await act(() => reload.click());
    await until(() => operations.length === 3);
    expect(operations[2].metadata.extensionInvocation).toMatchObject({ action: "workspace-reload",
      listingId: installed.id, arguments: { expectedHash: "saved" } });
  });
  it("shows the real public catalog, filters by search and opens a shareable detail", async () => {
    const entries = [entry("writing", "清晰写作", "skill", "文档"), entry("github", "GitHub MCP", "mcp", "开发")];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url === "/api/auth/session"
      ? { authenticated: false } : { entries, categories: ["文档", "开发"] })));
    await mount(); await until(() => host.querySelectorAll(".plugin-card").length === 2);
    const input = host.querySelector('input[aria-label="搜索插件"]') as HTMLInputElement;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "GitHub");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await until(() => host.querySelectorAll(".plugin-card").length === 1);
    expect(host.querySelector(".plugin-card")?.textContent).toContain("GitHub MCP");
    await act(() => (host.querySelector(".plugin-card") as HTMLAnchorElement).click());
    await until(() => !!host.querySelector(".detail-page"));
    expect(location.pathname).toBe("/plugins/github");
    expect(host.querySelector("h1")?.textContent).toBe("GitHub MCP");
    expect(host.textContent).toContain("添加到账户");
    expect(host.querySelector('a[href="https://zioon.tech/docs/"]')).not.toBeNull();
  });
  it("shows same-account private installs and uses the shared revision on enable changes", async () => {
    history.replaceState({}, "", "/plugins/private");
    const entries = [entry("private", "我的模型", "plugin", "开发", {
      visibility: "private", installation: { enabled: true, version: "1.0.0", status: "ready", executionEpoch: "epoch" }
    })];
    const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") writes.push({ url, body: JSON.parse(String(init.body)) });
      return response(url === "/api/auth/session" ? { authenticated: true, user: { id: "same-account", name: "Test user" } }
        : { entries, categories: ["开发"], revision: 9 });
    }));
    await mount(); await until(() => !!host.querySelector(".installation-actions"));
    expect(host.textContent).toContain("Test user");
    expect(host.textContent).toContain("仅自己可见");
    await act(() => (host.querySelector(".enabled-row .ant-switch") as HTMLButtonElement).click());
    await until(() => writes.length === 1);
    expect(writes[0]).toEqual({ url: "/api/runtime/v1/marketplace/installations/private",
      body: { enabled: false, expectedRevision: 9 } });
    expect(localStorage.length).toBe(0);
  });
  it("automatically joins a unified login once and keeps failed callbacks recoverable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url === "/api/auth/session"
      ? { authenticated: false, sharedAuthenticated: true, generation: "central-generation" }
      : { entries: [], categories: [] })));
    await mount(); await until(() => vi.mocked(login).mock.calls.length === 1);
    await act(() => query.invalidateQueries({ queryKey: ["account"] }));
    expect(login).toHaveBeenCalledTimes(1);
    history.replaceState({}, "", "/?loginError=unavailable");
    await act(() => query.invalidateQueries({ queryKey: ["account"] }));
    expect(login).toHaveBeenCalledTimes(1);
  });
  it("refreshes unified state on focus and removes private content and queries after logout", async () => {
    history.replaceState({}, "", "/installed");
    let authenticated = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url === "/api/auth/session"
      ? authenticated ? { authenticated: true, user: { id: "account-a", name: "Account A" } } : { authenticated: false }
      : { entries: [entry("private", "私有项目", "plugin", "开发", {
        visibility: "private", installation: { enabled: true, status: "ready", version: "1.0.0" }
      })], categories: ["开发"] })));
    await mount(); await until(() => host.textContent!.includes("私有项目"));
    query.setQueryData(["connections"], { secret: "old-account" });
    query.setQueryData(["review"], { contributions: ["old-account"] });
    authenticated = false;
    await act(() => window.dispatchEvent(new Event("focus")));
    await until(() => !!host.querySelector(".auth-gate"));
    expect(host.textContent).not.toContain("私有项目");
    expect(host.textContent).not.toContain("Account A");
    expect(query.getQueryData(["connections"])).toBeUndefined();
    expect(query.getQueryData(["review"])).toBeUndefined();
    expect(login).not.toHaveBeenCalled();
  });
  it("uses unified sign-out and then shows the signed-out catalog", async () => {
    let authenticated = true;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/logout") {
        expect(init?.method).toBe("POST"); authenticated = false;
        return response({ loggedOut: true });
      }
      return response(url === "/api/auth/session" ? { authenticated, user: { id: "test", name: "Test account" } }
        : { entries: [], categories: [] });
    });
    vi.stubGlobal("fetch", fetcher);
    await mount(); await until(() => !!host.querySelector(".account-button"));
    await act(() => (host.querySelector(".account-button") as HTMLButtonElement).click());
    await until(() => [...document.querySelectorAll(".ant-dropdown-menu-item")].some((item) => item.textContent?.includes("退出 Zioon")));
    const item = [...document.querySelectorAll(".ant-dropdown-menu-item")].find((item) => item.textContent?.includes("退出 Zioon"))!;
    await act(() => (item as HTMLElement).click());
    await until(() => host.textContent!.includes("登录 Zioon"));
    expect(fetcher.mock.calls.some(([url]) => url === "/api/auth/logout")).toBe(true);
    expect(host.querySelector(".account-button")).toBeNull();
  });
});
