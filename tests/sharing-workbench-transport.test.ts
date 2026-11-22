import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

let module: typeof import("../src/runtime/workbench-space");
beforeEach(async () => {
  vi.resetModules(); localStorage.clear();
  history.replaceState({}, "", "/");
  module = await import("../src/runtime/workbench-space");
});
afterEach(() => vi.unstubAllGlobals());
const json = (value: any) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const identity = { user: { id: "receiver" }, space: { id: "mine", kind: "personal" } } as any;
function document(role: "viewer" | "editor" = "editor") {
  return module.registerSharedWorkbenchDocument({ originSpaceId: "owner", documentId: "same", title: "共同计划", role, providerName: "Alice" });
}
function install(fetchImpl: any) {
  vi.stubGlobal("fetch", fetchImpl);
  module.installWorkbenchSpaceTransport(location.origin); module.pinWorkbenchSpace(identity, location.origin);
}
describe("shared document transport keeps account resources private", () => {
  it("keeps created and existing reader links on the selected Workbench origin despite a legacy server public URL", async () => {
    const { createSharingClient } = await import("../packages/runtime-client/src/sharing.mjs");
    const linkId = "a".repeat(43), calls: string[] = [];
    const client = createSharingClient({ baseUrl: location.origin, fetchImpl: async (url: string) => {
      calls.push(url);
      return json({ link: { id: linkId, mode: "restricted", revision: 1, url: `https://legacy.example/share/${linkId}` } });
    } });
    for (const result of [await client.documentLink("doc"), await client.setDocumentLink("doc", "restricted")]) {
      expect(result.link.url).toBe(`${location.origin}/share/${linkId}`);
    }
    expect(calls.every(url => new URL(url).origin === location.origin)).toBe(true);
  });
  it("qualifies local IDs and routes only the exact document to its owner", async () => {
    const fetchImpl = vi.fn(async () => json({ id: "same", text: "shared", meta: { id: "same" } }));
    install(fetchImpl); const doc = document();
    const result = await (await fetch(`/v1/workbench-state/sessions/${encodeURIComponent(doc.localId)}`)).json();
    expect(result.id).toBe(doc.localId); expect(result.meta.id).toBe(doc.localId);
    expect(new URL(fetchImpl.mock.calls[0][0]).pathname).toBe("/v1/workbench-state/sessions/same");
    expect(new Headers(fetchImpl.mock.calls[0][1].headers).get("x-zioon-space-id")).toBe("mine");
    expect(new Headers(fetchImpl.mock.calls[0][1].headers).get("x-zioon-content-space")).toBe("owner");
    await fetch("/v1/workbench-state/sessions/same");
    await fetch("/v1/models");
    expect(fetchImpl.mock.calls.slice(1).every(call => !new Headers(call[1].headers).has("x-zioon-content-space"))).toBe(true);
  });
  it("binds runs and chunked event streams to the originating local document", async () => {
    const fetchImpl = vi.fn(async (_input, init) => init.method === "POST"
      ? json({ runId: "run1", sessionId: "same" })
      : new Response(new ReadableStream({
        start(controller) {
          const bytes = new TextEncoder().encode('event: run.started\ndata: {"runId":"run1","sessionId":"same","token":"中文"}\n\n');
          controller.enqueue(bytes.slice(0, bytes.length - 5)); controller.enqueue(bytes.slice(bytes.length - 5)); controller.close();
        }
      }), { headers: { "content-type": "text/event-stream" } }));
    install(fetchImpl); const doc = document();
    const response = await fetch("/v1/runs", { method: "POST", body: JSON.stringify({ sessionId: doc.localId, metadata: { workbenchSessionId: doc.localId } }) });
    expect((await response.json()).sessionId).toBe(doc.localId);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).sessionId).toBe("same");
    await fetch("/v1/runs/preview", { method: "POST", body: JSON.stringify({ sessionId: doc.localId }) });
    expect(new Headers(fetchImpl.mock.calls[1][1].headers).get("x-zioon-content-space")).toBe("owner");
    const stream = await fetch("/v1/runs/run1/events/stream");
    const value = await stream.text();
    expect(value).toContain(doc.localId); expect(value).toContain("中文");
    expect(new Headers(fetchImpl.mock.calls[2][1].headers).get("x-zioon-content-document")).toBe("same");
  });
  it("pins per-document Memory and image reads without following the active panel", async () => {
    const fetchImpl = vi.fn(async () => json({}));
    install(fetchImpl); const doc = document();
    (window as any).zion = { sessions: { resolveContext: () => ({ sessionId: "private" }) } };
    await fetch(`/v1/plugins/dev.identity/files/read?document=${encodeURIComponent(doc.localId)}&path=identity.md`);
    await fetch(`/v1/assets/asset1/content?document=${encodeURIComponent(doc.localId)}`);
    for (const call of fetchImpl.mock.calls) {
      expect(new URL(call[0]).searchParams.get("document")).toBe("same");
      expect(new Headers(call[1].headers).get("x-zioon-content-space")).toBe("owner");
    }
  });
  it("rejects viewer writes and retains unknown qualified IDs without falling back to private content", async () => {
    const fetchImpl = vi.fn(async () => json({}));
    install(fetchImpl); const doc = document("viewer");
    await expect(fetch(`/v1/workbench-state/sessions/${encodeURIComponent(doc.localId)}`, { method: "PUT", body: "{}" })).rejects.toThrow("仅可查看");
    await expect(fetch("/v1/workbench-state/sessions/shared-document%3Aunregistered%3Aid")).rejects.toThrow("重新打开");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("recognizes owner shared content before browser message contributors run", async () => {
    install(vi.fn(async () => json({ id: "same", sharedContent: true })));
    await fetch("/v1/workbench-state/sessions/same");
    expect(module.isSharedWorkbenchContent("same")).toBe(true);
    expect(module.isSharedWorkbenchContent("private")).toBe(false);
    const { prepareInteractiveRuntimeMessages } = await import("../extensions/dev.langchain-chat/runtime-backend.js");
    const contributor = vi.fn(() => [{ role: "system", content: "private identity" }]);
    const messages = [{ role: "user", content: "shared question" }];
    expect(await prepareInteractiveRuntimeMessages({ messages, contributorContext: { sessionId: "same" }, runContributors: contributor })).toEqual(messages);
    expect(contributor).not.toHaveBeenCalled();
  });
  it("checks server privacy for an already-open document shared externally", async () => {
    const fetchImpl = vi.fn(async () => json({ sharedContent: true }));
    install(fetchImpl);
    const { prepareInteractiveRuntimeMessages } = await import("../extensions/dev.langchain-chat/runtime-backend.js");
    const contributor = vi.fn(() => [{ role: "system", content: "private identity" }]);
    const messages = [{ role: "user", content: "shared question" }];
    expect(await prepareInteractiveRuntimeMessages({ messages, contributorContext: { sessionId: "cached-owner-doc" },
      runContributors: contributor })).toEqual(messages);
    expect(new URL(fetchImpl.mock.calls[0][0]).pathname).toBe("/v1/sharing/documents/cached-owner-doc/privacy");
    expect(module.isSharedWorkbenchContent("cached-owner-doc")).toBe(true);
    expect(contributor).not.toHaveBeenCalled();
  });
  it("restores document routing for historical Runs after a reload", async () => {
    const fetchImpl = vi.fn(async () => json({ runId: "historical-run", sessionId: "same" }));
    install(fetchImpl); const doc = document();
    await fetch("/v1/runs", { method: "POST", body: JSON.stringify({ sessionId: doc.localId }) });
    vi.resetModules();
    module = await import("../src/runtime/workbench-space");
    const reloaded = vi.fn(async () => json({ run: { id: "historical-run", sessionId: "same", status: "completed" } }));
    install(reloaded);
    const response = await fetch("/v1/runs/historical-run");
    expect((await response.json()).run.sessionId).toBe(doc.localId);
    expect(new Headers(reloaded.mock.calls[0][1].headers).get("x-zioon-content-document")).toBe("same");
  });
});
