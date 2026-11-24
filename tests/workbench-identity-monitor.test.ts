import { afterEach, expect, it, vi } from "vitest";
import { currentAccountSession } from "../packages/account-ui/src/client";
import { createWorkbenchIdentityMonitor } from "../src/runtime/workbench-identity-monitor";
const initial: any = { user: { id: "me" }, space: { id: "own" }, sessionId: "login",
  membership: { status: "active", role: "owner" }, scopes: ["runtime.read", "runtime.write"] };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("merges focus/online/poll checks and applies same-account permissions without reentry", async () => {
  let finish!: (value: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", fetchMock);
  const lost = vi.fn(), check = createWorkbenchIdentityMonitor(location.origin, initial, lost);
  const one = check(); expect(check()).toBe(one); expect(check()).toBe(one);
  finish(Response.json({ ...initial, membership: { status: "active", role: "viewer" }, scopes: ["runtime.read"] }));
  await one;
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(lost).not.toHaveBeenCalled();
  expect(currentAccountSession()?.scopes).toEqual(["runtime.read"]);
  expect(document.documentElement.dataset.zionAccountReadonly).toBe("true");
  await check(); expect(fetchMock).toHaveBeenCalledTimes(1);
});
it.each([401, 403, 404])("confirms an isolated %s denial before interrupting the page", async status => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({}, { status }))
    .mockResolvedValueOnce(Response.json(initial)));
  const lost = vi.fn(); await createWorkbenchIdentityMonitor(location.origin, initial, lost)();
  expect(lost).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([401, 403, 404])("interrupts on a confirmed %s denial", async status => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({}, { status })));
  const lost = vi.fn(), check = createWorkbenchIdentityMonitor(location.origin, initial, lost);
  await check(); await check();
  expect(lost).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([
  { ...initial, user: { id: "other" } },
  { ...initial, space: { id: "other" } },
  { ...initial, scopes: [] },
  { ...initial, membership: { status: "suspended", role: "owner" } }
])("interrupts for a real account or read-access change", async next => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(next)));
  const lost = vi.fn(); await createWorkbenchIdentityMonitor(location.origin, initial, lost)();
  expect(lost).toHaveBeenCalledOnce();
});
it("keeps the page when denial confirmation fails due to service availability", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({}, { status: 401 }))
    .mockResolvedValueOnce(Response.json({}, { status: 503 })));
  const lost = vi.fn(); await createWorkbenchIdentityMonitor(location.origin, initial, lost)();
  expect(lost).not.toHaveBeenCalled();
});
