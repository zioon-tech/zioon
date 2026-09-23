import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountPanel } from "../../../packages/account-ui/src/AccountPanel";
import { setAccountSession, type AccountSession } from "../../../packages/account-ui/src/client";
import { AuthBoundary } from "../src/AuthBoundary";
import { ConversationScreen } from "../src/ChatScreens";
import { MoreScreen } from "../src/MoreScreens";

const viewer: AccountSession = {
  authenticated: true, mode: "accounts-v1",
  user: { id: "user:viewer", name: "Test Viewer", email: "viewer@example.test" },
  space: { id: "space:a", name: "Test Space", kind: "team" },
  membership: { role: "viewer", status: "active" },
  scopes: ["runtime.read", "observability.read"], sessionId: "login:one",
  expiresAt: Date.now() + 60_000
};
let root: Root; let host: HTMLDivElement; let queries: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  history.replaceState({}, "", "/");
  delete document.documentElement.dataset.theme;
});
afterEach(async () => {
  await act(async () => root.unmount());
  queries.clear(); host.remove(); setAccountSession(null);
  delete document.documentElement.dataset.theme;
  sessionStorage.clear(); localStorage.clear(); vi.unstubAllGlobals();
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" }
});
function fixture(identity: AccountSession | null) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input, "http://localhost").pathname;
    calls.push({ path, init });
    if (path === "/health") return json({ service: "zion-runtime", authRequired: true, authMode: "accounts-v1" });
    if (path === "/v1/account/me") return identity ? json(identity) : json({ error: "authentication_required" }, 401);
    if (path === "/v1/account/sessions") return json({ sessions: [{ id: "login:one", createdAt: Date.now(), expiresAt: viewer.expiresAt }] });
    if (path === "/v1/account/members") return json({ members: identity?.membership ? [{
      id: identity.user.id,
      name: identity.user.name,
      email: identity.user.email,
      role: identity.membership.role,
      status: identity.membership.status
    }] : [] });
    if (path === "/v1/account/grants") return json({ grants: [] });
    if (path === "/v1/account/invitations/accept") {
      if (identity) identity = { ...identity, membership: viewer.membership, scopes: viewer.scopes };
      return json({ membership: viewer.membership });
    }
    if (path === "/v1/sessions/test") return json({ session: { id: "test", title: "Shared conversation", status: "active" } });
    if (path.endsWith("/transcript")) return json({ messages: [] });
    if (path.endsWith("/active-run")) return json({ activeRun: null });
    if (path.endsWith("/artifacts")) return json({ artifacts: [], changes: [] });
    if (path === "/v1/interaction-profiles") return json({ profiles: [] });
    if (path === "/v1/skills/snapshot") return json({ snapshot: { enabled: [], catalog: [] } });
    return json({ error: `Unexpected ${path}` }, 404);
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

describe("account UI integration", () => {
  it("starts account login automatically and preserves the mobile return route", async () => {
    history.replaceState({}, "", "/mobile/chats?view=recent#invite=one-time-login");
    fixture(null);
    const onLogin = vi.fn();
    await act(async () => {
      root.render(<AuthBoundary onLogin={onLogin}><div>Private UI</div></AuthBoundary>);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain("正在转到安全登录");
    expect(host.querySelector(".zion-account--gate.is-gate")).toBeTruthy();
    expect(onLogin).toHaveBeenCalledTimes(1);
    const loginUrl = new URL(onLogin.mock.calls[0][0]);
    expect(loginUrl.pathname).toBe("/v1/account/login");
    expect(loginUrl.searchParams.get("returnTo")).toBe("/mobile/chats?view=recent");
    expect(loginUrl.searchParams.get("uiTheme")).toBe("light");
    expect(loginUrl.href).not.toContain("one-time-login");
    expect(sessionStorage.getItem("zion.account.pendingInvitation")).toBe("one-time-login");
    expect(host.querySelector(".zion-account-mark path")).toBeTruthy();
    expect([...host.querySelectorAll("button")].some(button => button.textContent?.includes("登录"))).toBe(false);
    expect(host.textContent).not.toContain("Private UI");
    expect(host.querySelector('[name="pairing-code"], #pairingCode')).toBeNull();
  });

  it("does not restart login after cancellation until the user asks", async () => {
    document.documentElement.dataset.theme = "dark";
    history.replaceState({}, "", "/account?zionAuth=cancelled");
    fixture(null);
    const onLogin = vi.fn();
    await act(async () => {
      root.render(<AccountPanel variant="gate" onLogin={onLogin} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(onLogin).not.toHaveBeenCalled();
    expect(host.textContent).toContain("登录已取消");
    const continueButton = [...host.querySelectorAll("button")]
      .find(button => button.textContent?.trim() === "继续登录")!;
    await act(async () => continueButton.click());
    expect(onLogin).toHaveBeenCalledTimes(1);
    const loginUrl = new URL(onLogin.mock.calls[0][0]);
    expect(loginUrl.searchParams.get("returnTo")).toBe("/account");
    expect(loginUrl.searchParams.get("uiTheme")).toBe("dark");
  });

  it("keeps invitations out of return URLs and only accepts them after a deliberate action", async () => {
    history.replaceState({}, "", "/account#invite=one-time-fixture");
    const calls = fixture({ ...viewer, membership: null, scopes: [] });
    await act(async () => root.render(<AccountPanel />));
    expect(location.hash).toBe("");
    expect(sessionStorage.getItem("zion.account.pendingInvitation")).toBe("one-time-fixture");
    expect(host.textContent).toContain("等待加入");
    expect(host.textContent).toContain("未加入");
    expect(host.querySelector('[aria-label="账号管理"]')).toBeTruthy();
    expect(calls.some(call => call.path.endsWith("/members") || call.path.endsWith("/grants"))).toBe(false);
    const accept = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "接受")!;
    await act(async () => {
      accept.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(sessionStorage.getItem("zion.account.pendingInvitation")).toBeNull();
    expect(host.textContent).toContain("访客（只读）");
    expect(host.textContent).toContain("只读");
    expect(calls.find(call => call.path.endsWith("/invitations/accept"))?.init)
      .toMatchObject({ method: "POST", credentials: "include", body: '{"token":"one-time-fixture"}' });
    expect(localStorage.length).toBe(0);
  });

  it("renders a viewer conversation without a composer or run controls", async () => {
    fixture(viewer);
    await act(async () => root.render(
      <QueryClientProvider client={queries}>
        <MemoryRouter initialEntries={["/chat/test"]}>
          <AuthBoundary><Routes>
            <Route path="/chat/:sessionId" element={<ConversationScreen />} />
          </Routes></AuthBoundary>
        </MemoryRouter>
      </QueryClientProvider>
    ));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    expect(host.textContent).toContain("Shared conversation");
    expect(host.textContent).toContain("只读会话");
    expect(host.querySelector(".send-button, textarea")).toBeNull();
    expect(document.documentElement.dataset.zionAccountReadonly).toBe("true");
  });

  it("does not expose personal Space or owner implementation details", async () => {
    const personal: AccountSession = {
      ...viewer,
      user: { id: "user:local", name: "Local User", email: "local@example.test" },
      space: { id: "space:personal", name: "我的本地空间", kind: "personal" },
      membership: { role: "owner", status: "active" },
      scopes: ["runtime.read", "runtime.write", "runtime.manage"]
    };
    fixture(personal);
    setAccountSession(personal);
    await act(async () => root.render(
      <MemoryRouter><MoreScreen /></MemoryRouter>
    ));
    expect(host.textContent).toContain("local@example.test");
    expect(host.textContent).not.toContain("我的本地空间");
    expect(host.textContent).not.toContain("所有者");

    await act(async () => root.render(<AccountPanel variant="workbench" />));
    expect(host.textContent).toContain("已登录");
    expect(host.textContent).toContain("登录设备");
    expect(host.textContent).not.toContain("我的本地空间");
    expect(host.textContent).not.toContain("当前 Zion");
    expect(host.textContent).not.toContain("所有者");
  });

  it("prevents removing or demoting the last team owner", async () => {
    fixture({
      ...viewer,
      user: { id: "user:owner", name: "Team Owner", email: "owner@example.test" },
      space: { id: "space:a", name: "Test Team", kind: "team" },
      membership: { role: "owner", status: "active" },
      scopes: ["runtime.read", "runtime.write", "members.manage"]
    });
    await act(async () => root.render(<AccountPanel variant="workbench" />));
    const members = [...host.querySelectorAll("button")]
      .find(button => button.textContent?.includes("成员"))!;
    await act(async () => members.click());
    const role = host.querySelector<HTMLSelectElement>('[aria-label="Team Owner的角色"]');
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="移除 Team Owner"]');
    expect(role?.disabled).toBe(true);
    expect(remove?.disabled).toBe(true);
    expect(role?.title).toBe("至少需要保留一位所有者");
  });
});
