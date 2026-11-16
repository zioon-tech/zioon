import { describe, it, expect, vi, afterEach } from "vitest";
import { activate } from "../extensions/dev.agent-device-cloud/workbench.mjs";

const cleanup = [];
afterEach(() => {
  cleanup.splice(0).reverse().forEach((dispose) => dispose());
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
});
async function mount(fetcher, href = "http://127.0.0.1:18866/") {
  let view;
  const navigate = vi.fn();
  vi.stubGlobal("location", { href, origin: new URL(href).origin, assign: navigate });
  vi.stubGlobal("navigator", { language: "zh-CN" });
  vi.stubGlobal("history", { replaceState: vi.fn() });
  vi.stubGlobal("fetch", fetcher);
  const statusRegistration = vi.fn(() => ({ dispose() {} }));
  window.zion = {
    state: { get: () => undefined },
    panels: { getActivePanelId: () => "new", list: () => [{ id: "new", activeTabId: "workbench-only-session" }] },
    sideBar: { registerView(value) { view = value; return { dispose() {} }; } },
    activityBar: { registerItem() { return { dispose() {} }; } },
    bottomStatusBar: { registerItem: statusRegistration },
    commands: { registerCommand() { return { dispose() {} }; } },
    events: { on() { return { dispose() {} }; } }
  };
  const subscriptions = [];
  await activate({ subscriptions });
  const deactivate = () => subscriptions.splice(0).reverse().forEach((item) => item?.dispose?.());
  cleanup.push(deactivate);
  const container = document.createElement("aside");
  document.body.append(container);
  let mounted = view.component.render(container);
  const unmount = () => { mounted?.dispose?.(); mounted = null; };
  cleanup.push(unmount);
  await vi.waitFor(() => expect(container.textContent).toContain("ADC"));
  return {
    container, navigate, unmount, deactivate, statusRegistration,
    remount() { mounted = view.component.render(container); }
  };
}
const ok = (result) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } });
describe("ADC connection button on a fresh Workbench", () => {
  it.each(["success", "error"])("keeps the session sidebar intact after a late ADC status %s and window focus", async outcome => {
    const pending = [];
    const fetcher = vi.fn(() => new Promise(resolve => pending.push(resolve)));
    const { container, unmount, remount, statusRegistration } = await mount(fetcher);
    unmount();
    const sessions = document.createElement("nav");
    sessions.textContent = "会话列表";
    container.replaceChildren(sessions);
    const respond = () => pending.splice(0).forEach(resolve => resolve(outcome === "success"
      ? ok({ connected: true, devices: [], tasks: [] })
      : Response.json({ error: "status unavailable" }, { status: 503 })));
    respond();
    await vi.waitFor(() => expect(statusRegistration).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBe(sessions);
    expect(container.textContent).toBe("会话列表");
    expect(container.classList.contains("adc-sidebar")).toBe(false);
    window.dispatchEvent(new Event("focus"));
    respond();
    await vi.waitFor(() => expect(statusRegistration).toHaveBeenCalledTimes(2));
    expect(container.firstChild).toBe(sessions);
    container.replaceChildren();
    remount();
    respond();
    await vi.waitFor(() => expect(statusRegistration).toHaveBeenCalledTimes(3));
    expect(container.querySelector(".adc-sidebar")?.textContent).toContain("ADC");
  });

  it("does not clear the next sidebar when the ADC plugin is disposed", async () => {
    const { container, unmount, deactivate, statusRegistration } = await mount(async () =>
      ok({ connected: false, devices: [], tasks: [] }));
    await vi.waitFor(() => expect(statusRegistration).toHaveBeenCalled());
    unmount();
    const sessions = document.createElement("nav");
    sessions.textContent = "会话列表";
    container.replaceChildren(sessions);
    deactivate();
    expect(container.firstChild).toBe(sessions);
    expect(container.textContent).toBe("会话列表");
  });

  it("uses the current HTTP Workbench origin and connects without an existing Run Session", async () => {
    let complete;
    const pending = new Promise((resolve) => { complete = resolve; });
    const calls = [];
    const fetcher = vi.fn(async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      if (body.action === "connect") return pending;
      return ok({ connected: false, devices: [], tasks: [] });
    });
    const { container, navigate } = await mount(fetcher);
    container.querySelector("button").click();
    await vi.waitFor(() => expect(container.textContent).toContain("正在连接"));
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
    complete(ok({ authorizeUrl: "https://adc.zioon.tech/api/auth/oauth2/authorize?state=adc_test" }));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(calls.find((call) => call.body.action === "connect")).toEqual({
      url: "http://127.0.0.1:18866/v1/plugins/dev.agent-device-cloud/commands",
      body: { action: "connect", redirectUri: "http://127.0.0.1:18866/" }
    });
    expect(container.textContent).toContain("继续前往 ADC 登录");
  });
  it("keeps a connect error visible even when a stale status response arrives", async () => {
    const stale = [];
    const fetcher = vi.fn(async (_url, options) => {
      if (JSON.parse(options.body).action === "status") return new Promise((resolve) => stale.push(resolve));
      return new Response(JSON.stringify({ error: "授权服务暂时不可用" }), { status: 503 });
    });
    const { container, navigate } = await mount(fetcher);
    container.querySelector("button").click();
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("授权服务暂时不可用"));
    stale.forEach((resolve) => resolve(ok({ connected: false, devices: [], tasks: [] })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector('[role="alert"]').textContent).toContain("授权服务暂时不可用");
    expect(navigate).not.toHaveBeenCalled();
  });
  it("redeems an OAuth callback without depending on active session restoration", async () => {
    const calls = [];
    const fetcher = vi.fn(async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return ok({ connected: true, devices: [], tasks: [] });
    });
    await mount(fetcher, "http://127.0.0.1:18866/?code=test-code&state=adc_test");
    expect(calls[0]).toEqual({ action: "finish", code: "test-code", state: "adc_test" });
  });
});
