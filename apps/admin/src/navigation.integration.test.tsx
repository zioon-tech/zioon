import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./main";

let root: Root, host: HTMLDivElement;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" }
});
const overview = {
  totals: { accounts: 12, workspaces: 8, running: 2, failed_24h: 0, sessions: 9 },
  health: { status: "ok", checks: [{ id: "database", status: "ok", message: "PostgreSQL is responding" }],
    process: { memory: { rss: 104857600 } }, database: { pool: { total: 1, max: 5 } }, uptimeSeconds: 120 }
};
const resources: Record<string, unknown> = {
  overview,
  accounts: [{ id: "user:fixture", name: "账户样本", email: "fixture@example.invalid", status: "active", workspace_count: 1 }],
  workspaces: [{ account_id: "user:fixture", workspace_id: "工作区样本", status: "ready" }],
  runs: [{ run_id: "运行样本", space_id: "space:fixture", status: "completed" }],
  incidents: [{ id: "incident:fixture", title: "事件样本", message: "公开说明", status: "resolved", components: ["runtime"] }],
  roles: [{ name: "权限样本", user_id: "user:fixture", email: "fixture@example.invalid", role: "viewer", revision: 3 }],
  audit: [{ action: "操作记录样本", actor_id: "user:fixture", target_id: "incident:fixture", details: { status: "resolved" } }]
};
const deferred = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
};
const fixture = (override?: (path: string) => Response | Promise<Response> | undefined) => {
  const fetch = vi.fn((url: string) => {
    const path = url.split("/").at(-1)!;
    if (path === "me") return Promise.resolve(response({ user: { id: "user:operator", name: "测试管理员" }, role: "owner" }));
    return override?.(path) || Promise.resolve(response(resources[path]));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
};
const mount = async () => { await act(async () => root.render(<App/>)); };
const click = async (label: string) => {
  const button = [...host.querySelectorAll("nav button")].find(b => b.textContent === label) as HTMLButtonElement;
  expect(button).toBeTruthy();
  await act(async () => button.click());
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Admin navigation with different endpoint payloads", () => {
  it.each([
    ["账户", "账户样本"], ["云端工作区", "工作区样本"], ["任务运行", "运行样本"],
    ["事件与维护", "事件样本"], ["管理员权限", "权限样本"], ["操作记录", "操作记录样本"]
  ])("switches overview → %s → overview without rendering another menu's payload", async (label, row) => {
    fixture();
    await mount();
    expect(host.textContent).toContain("平台健康");
    await click(label);
    expect(host.querySelector("main h1")?.textContent).toBe(label);
    expect(host.textContent).toContain(row);
    await click("运行概览");
    expect(host.textContent).toContain("平台健康");
    expect(host.textContent).not.toContain(row);
  });

  it("keeps the current menu when an older overview refresh finishes late", async () => {
    const stale = deferred();
    let requests = 0;
    fixture(path => path === "overview" && ++requests === 2 ? stale.promise : undefined);
    await mount();
    await act(async () => (host.querySelector("header button") as HTMLButtonElement).click());
    await click("账户");
    expect(host.textContent).toContain("账户样本");
    await act(async () => stale.resolve(response(overview)));
    expect(host.querySelector("main h1")?.textContent).toBe("账户");
    expect(host.textContent).toContain("账户样本");
    expect(host.querySelector('header button')?.hasAttribute("disabled")).toBe(false);
  });

  it("ignores an earlier request when returning to the same menu", async () => {
    const stale = deferred();
    let requests = 0;
    fixture(path => path === "accounts" && ++requests === 1 ? stale.promise : undefined);
    await mount();
    await click("账户");
    await click("任务运行");
    await click("账户");
    expect(host.textContent).toContain("账户样本");
    await act(async () => stale.resolve(response([{ id: "old", name: "过期账户结果" }])));
    expect(host.textContent).toContain("账户样本");
    expect(host.textContent).not.toContain("过期账户结果");
  });

  it("ignores errors from a menu that is no longer active", async () => {
    const stale = deferred();
    fixture(path => path === "accounts" ? stale.promise : undefined);
    await mount();
    await click("账户");
    await click("任务运行");
    await act(async () => stale.resolve(response({ code: "unavailable" }, 503)));
    expect(host.textContent).toContain("运行样本");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows a retryable error for an unexpected response shape and keeps navigation usable", async () => {
    fixture(path => path === "accounts" ? response({ unexpected: true }) : undefined);
    await mount();
    await click("账户");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("请重试");
    await click("运行概览");
    expect(host.textContent).toContain("平台健康");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
