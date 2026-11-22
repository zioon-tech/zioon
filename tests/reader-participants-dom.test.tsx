import { act } from "react";
import { transferableAbortController } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPublicReader } from "../src/public-reader/reader";
import { createReaderParticipants } from "../src/public-reader/participants";
let dispose: (() => void) | undefined;
const payload = { state: "read" as const, title: "共同阅读", markdown: "user 问题\nassistant 回答",
  mode: "public" as const, role: null, cards: { tools: [], thinking: [] } };
const presence = { visitId: "a".repeat(43), selfVisitorId: "self", ttlMs: 45000, visitors: [
  { id: "self", name: "自己", online: true, role: "visitor" },
  { id: "peer", name: "匿名访客", online: true, role: "visitor" }
] };
const response = (value: any, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => {
  const controller = transferableAbortController();
  vi.stubGlobal("AbortController", controller.constructor); vi.stubGlobal("AbortSignal", controller.signal.constructor);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => { dispose?.(); }); dispose = undefined;
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe("original participant UI with a page-level reading source", () => {
  it("shares one registration and heartbeat across four splits, uses the original hover card and leaves only when the page closes", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { calls.push(init.method!); return response(presence); });
    const host = document.createElement("div"); document.body.append(host); let reader: ReturnType<typeof mountPublicReader>;
    await act(async () => { reader = mountPublicReader(host, payload, { path: "/share/link", presence: { url: "/share/link/presence" } }); });
    dispose = reader!.dispose;
    await act(async () => {
      reader!.panels.splitPanel("public-reader", "horizontal");
      reader!.panels.splitPanel(reader!.panels.getActivePanelId()!, "vertical");
      reader!.panels.splitPanel(reader!.panels.getActivePanelId()!, "horizontal");
    });
    expect(host.querySelectorAll(".editor-participant-button")).toHaveLength(4);
    expect(calls).toEqual(["POST"]);
    await act(async () => { host.querySelector<HTMLButtonElement>(".editor-participant-button")!.click(); });
    expect(document.querySelector('.editor-participants-card[role="dialog"]')!.textContent).toContain("匿名访客");
    expect(document.querySelector(".editor-participants-card select")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(calls).toEqual(["POST", "PUT"]);
    await act(async () => { reader!.panels.closePanel(); });
    expect(calls).toEqual(["POST", "PUT"]);
    await act(async () => { window.dispatchEvent(new PageTransitionEvent("pagehide")); });
    expect(calls).toEqual(["POST", "PUT", "DELETE"]);
    await act(async () => { window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
    expect(calls).toEqual(["POST", "PUT", "DELETE", "POST"]);
    await act(async () => { reader!.dispose(); });
    expect(calls).toEqual(["POST", "PUT", "DELETE", "POST", "DELETE"]);
    expect(document.querySelector(".editor-participants-card")).toBeNull();
  });
  it("clears failed presence and does not publish a late registration after the page is disposed", async () => {
    let finish: (value: Response) => void = () => {};
    vi.stubGlobal("fetch", () => new Promise<Response>(resolve => { finish = resolve; }));
    const source = createReaderParticipants({ url: "/share/link/presence" }); dispose = source.dispose;
    source.dispose(); finish(response(presence)); await act(async () => {});
    expect(source.snapshot().people).toEqual([]);
    const lost = vi.fn();
    vi.stubGlobal("fetch", async () => response({ code: "document_link_unavailable" }, 404));
    const rejected = createReaderParticipants({ url: "/share/link/presence", onAccessLost: lost }); dispose = rejected.dispose;
    await act(async () => {});
    expect(lost).toHaveBeenCalledOnce(); expect(rejected.snapshot().people).toEqual([]);
  });
});
