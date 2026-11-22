import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

let module: typeof import("../src/runtime/workbench-space");
const identity = (id = "one") => ({ user: { id: "alice" }, space: { id, kind: "team" } } as any);
beforeEach(async () => {
  vi.resetModules(); localStorage.clear();
  history.replaceState({}, "", "/?space=one");
  module = await import("../src/runtime/workbench-space");
});
afterEach(() => vi.unstubAllGlobals());

describe("fixed Workbench Space", () => {
  it("keeps requests in the page's Space when another window changes the server default", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchImpl);
    module.installWorkbenchSpaceTransport(location.origin);
    module.pinWorkbenchSpace(identity(), location.origin);
    history.replaceState({}, "", "/?space=two");
    await fetch("/v1/runs", { method: "POST", body: "{}" });
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get("x-zioon-space-id")).toBe("one");
    expect(fetchImpl.mock.calls[0][1]?.credentials).toBe("include");
  });
  it("scopes explicit destination management without retargeting document requests", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}")); vi.stubGlobal("fetch", fetchImpl);
    module.installWorkbenchSpaceTransport(location.origin); module.pinWorkbenchSpace(identity(), location.origin);
    await fetch("/v1/spaces/two/documents/transfer", { method: "POST", headers: { "x-zioon-space-id": "two" } });
    await fetch("/v1/workbench-state/catalog");
    expect(fetchImpl.mock.calls.map(call => new Headers(call[1]?.headers).get("x-zioon-space-id"))).toEqual(["two", "one"]);
  });
  it("rejects mismatched document headers and blocks writes after access changes", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}")); vi.stubGlobal("fetch", fetchImpl);
    module.installWorkbenchSpaceTransport(location.origin); module.pinWorkbenchSpace(identity(), location.origin);
    await expect(fetch("/v1/runs", { headers: { "x-zioon-space-id": "two" } })).rejects.toThrow("不一致");
    module.lockWorkbenchSpace();
    await expect(fetch("/v1/workbench-state/sessions/secret", { method: "PUT" })).rejects.toThrow("内容已保留");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("does not send Space headers or credentials to third-party URLs", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}")); vi.stubGlobal("fetch", fetchImpl);
    module.installWorkbenchSpaceTransport(location.origin); module.pinWorkbenchSpace(identity(), location.origin);
    await fetch("https://third-party.test/v1/anything", { method: "GET" });
    expect(fetchImpl.mock.calls[0][1]).toEqual({ method: "GET" });
  });
  it("routes shared Memory to the selected document and requires an explicit document", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}")); vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("zion", undefined);
    (window as any).zion = { sessions: { resolveContext: () => ({ sessionId: "doc-one" }) } };
    module.installWorkbenchSpaceTransport(location.origin); module.pinWorkbenchSpace(identity(), location.origin);
    await fetch("/v1/plugins/dev.identity/files/read?path=identity.md");
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get("document")).toBe("doc-one");
    (window as any).zion = { sessions: { resolveContext: () => ({ sessionId: "" }) } };
    await expect(fetch("/v1/plugins/dev.identity/files/read?path=identity.md")).rejects.toThrow("先打开");
  });
  it("preserves a Request body and headers when adding scope", async () => {
    const fetchImpl = vi.fn(async (input: any, init: any) => {
      const request = new Request(input, init);
      expect(await request.text()).toBe('{"message":"hello"}');
      expect(request.headers.get("x-custom")).toBe("kept");
      expect(request.headers.get("x-zioon-space-id")).toBe("one");
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetchImpl); module.installWorkbenchSpaceTransport(location.origin); module.pinWorkbenchSpace(identity(), location.origin);
    await fetch(new Request(`${location.origin}/v1/runs`, { method: "POST", headers: { "x-custom": "kept" }, body: '{"message":"hello"}' }));
  });
  it("isolates cached documents and drafts without importing unowned browser data", async () => {
    localStorage.setItem("zion.autosave", "legacy private text");
    module.pinWorkbenchSpace(identity(), location.origin);
    expect(module.workbenchStorage.getItem("zion.autosave")).toBeNull();
    module.workbenchStorage.setItem("zion.autosave", "one text");
    module.workbenchStorage.setItem("zion.session.secret.meta", "{}");
    expect(module.workbenchStorage.length).toBe(2);
    vi.resetModules(); module = await import("../src/runtime/workbench-space");
    module.pinWorkbenchSpace(identity("two"), location.origin);
    expect(module.workbenchStorage.getItem("zion.autosave")).toBeNull();
    module.workbenchStorage.setItem("zion.autosave", "two text"); module.workbenchStorage.clear();
    expect(localStorage.getItem("zion.autosave")).toBe("legacy private text");
    expect(Object.values(localStorage)).toContain("one text");
  });
  it("retains scope in document links and removes old session state on Space switching", () => {
    const url = new URL(module.workbenchSpaceUrl("two", "new", `${location.origin}/?space=one&zionSession=old&session=old#secret`));
    expect(url.searchParams.get("space")).toBe("two"); expect(url.searchParams.get("session")).toBe("new");
    expect(url.searchParams.has("zionSession")).toBe(false); expect(url.hash).toBe("");
  });
});
