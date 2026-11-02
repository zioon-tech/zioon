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
  window.zion = {
    state: { get: () => undefined },
    panels: { getActivePanelId: () => "new", list: () => [{ id: "new", activeTabId: "workbench-only-session" }] },
    sideBar: { registerView(value) { view = value; return { dispose() {} }; } },
    activityBar: { registerItem() { return { dispose() {} }; } },
    commands: { registerCommand() { return { dispose() {} }; } },
    events: { on() { return { dispose() {} }; } }
  };
  const subscriptions = [];
  await activate({ subscriptions });
  cleanup.push(() => subscriptions.reverse().forEach((item) => item?.dispose?.()));
  const container = document.createElement("aside");
  document.body.append(container);
  view.component.render(container);
  await vi.waitFor(() => expect(container.textContent).toContain("ADC"));
  return { container, navigate };
}
const ok = (result) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } });
describe("ADC connection button on a fresh Workbench", () => {
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
