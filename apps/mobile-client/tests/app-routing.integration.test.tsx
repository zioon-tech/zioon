import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileApp } from "../src/MobileApp";
import { setAccountSession } from "../../../packages/account-ui/src/client";

let host: HTMLDivElement, root: Root;
const response = (data: unknown) => new Response(JSON.stringify(data), {
  status: 200, headers: { "content-type": "application/json" }
});
const account = {
  authenticated: true, mode: "accounts-v1",
  user: { id: "user:fixture", name: "Mobile Fixture", email: "fixture@example.invalid" },
  space: { id: "space:fixture", name: "My workspace", kind: "personal" },
  membership: { role: "owner", status: "active" },
  scopes: ["runtime.read", "runtime.write"], sessionId: "session:fixture"
};
const until = async (predicate: () => boolean) => {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
  throw new Error("Mobile page did not render");
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  history.replaceState({}, "", "/");
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(input, location.origin).pathname;
    if (path === "/health") return response({ service: "zion-runtime", authRequired: true, authMode: "accounts-v1" });
    if (path === "/v1/account/me") return response(account);
    if (path === "/v1/mobile/sessions") return response({ sessions: [{
      id: "session:home", title: "首页会话样本", status: "active", updatedAt: Date.now()
    }] });
    throw new Error(`Unexpected Mobile request: ${path}`);
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setAccountSession(null);
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Mobile application router and deployment base", () => {
  it.each([
    ["/", "/", "/chats"], ["/", "/chats", "/chats"],
    ["/mobile/", "/mobile/", "/mobile/chats"], ["/mobile/", "/mobile", "/mobile/chats"],
    ["/mobile/", "/mobile/chats", "/mobile/chats"]
  ])("renders the real home with base %s at %s", async (basePath, path, home) => {
    vi.stubEnv("BASE_URL", basePath);
    history.replaceState({}, "", path);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await act(async () => root.render(<MobileApp basePath={basePath} />));
      await until(() => host.textContent?.includes("首页会话样本") === true);
      expect(location.pathname).toBe(home);
      expect(host.querySelector('nav[aria-label="主导航"]')).toBeTruthy();
      expect(warnings.mock.calls.some(args => String(args[0]).includes("basename"))).toBe(false);
      const more = [...host.querySelectorAll(".bottom-nav button")].find(b => b.textContent === "更多") as HTMLButtonElement;
      await act(async () => more.click());
      await until(() => host.textContent?.includes("内容与知识") === true);
      expect(location.pathname).toBe(basePath.replace(/\/$/, "") + "/more");
      const settings = [...host.querySelectorAll("button")].find(b => b.querySelector(".row-title")?.textContent === "设置") as HTMLButtonElement;
      expect(settings).toBeTruthy();
      await act(async () => settings.click());
      await until(() => host.textContent?.includes("本地状态") === true);
      expect(location.pathname).toBe(basePath.replace(/\/$/, "") + "/settings");
      expect(host.querySelector(".kv")?.textContent).toContain(basePath);
    } finally { warnings.mockRestore(); }
  });

  it("uses Vite's build base by default when deployed at the domain root", async () => {
    vi.stubEnv("BASE_URL", "/");
    await act(async () => root.render(<MobileApp/>));
    await until(() => host.textContent?.includes("首页会话样本") === true);
    expect(location.pathname).toBe("/chats");
    expect(host.querySelector(".mobile-shell")).toBeTruthy();
  });
});
