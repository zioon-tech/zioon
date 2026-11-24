import { afterEach, expect, it, vi } from "vitest";
import { sessionRenderProjection, sessionCardDetails } from "../apps/runtime/src/session-card-projection.mjs";
import { hydrateRemoteAnnotations } from "../extensions/dev.session-manager/storage/remote.js";
import { clientAnnotationSnapshot, localSessionAnnotationCopy } from "../packages/runtime-client/src/session-annotations.mjs";
import { sessionMetadataChanges, applySessionMetadataChanges } from "../packages/runtime-client/src/session-metadata.mjs";
import { lazyCardDetails } from "../extensions/shared/card-details.js";
import { createChatAnnotationsApi } from "../src/chat/annotations";

afterEach(() => { vi.restoreAllMocks(); });
const source = () => ({ id: "s", session_revision: 12, meta: { annotations: { tools: [
  { id: "t", runId: "run", kind: "tool", name: "Bash", args: { command: "ls" }, result: "big".repeat(10000), ok: true },
  { id: "legacy", result: "local".repeat(1000) },
  { id: "expanded", runId: "run", kind: "tool", result: "open".repeat(1000), ok: true, expanded: true }
], thinking: [{ id: "think", runId: "run", kind: "thinking", text: "reason".repeat(1000) }] } } });

it.each([
  { kind: "tools", cardKind: "tool", body: { args: { command: "完整", nullable: null }, result: { output: "exact", values: [] } } },
  { kind: "tools", cardKind: "tool", body: { args: null, result: "" } },
  { kind: "thinking", cardKind: "thinking", body: { text: "完整思考" } },
  { kind: "thinking", cardKind: "thinking", body: { text: "" } }
])("retires a loaded $kind reference through live, metadata and pending annotations", async ({ kind, cardKind, body }) => {
  const sessionId = "s-real-api", reference = "d".repeat(64), id = "real-expanded";
  const card = { id, kind: cardKind, runId: "run", expanded: true,
    bodyRef: reference, bodySessionId: sessionId, bodyKind: kind, bodyBytes: 123,
    detailRef: "a".repeat(64), detailSessionId: sessionId };
  const annotations = { tools: [], thinking: [], [kind]: [card] };
  const values = new Map([
    [`sessions.annotations.${sessionId}`, annotations],
    [`sessions.meta.${sessionId}`, { annotations }],
    [`sessions.pendingRestore.${kind}.${sessionId}`, [card]]
  ]);
  const handlers = new Map();
  const state = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
  const commands = {
    registerCommand(name, handler) { handlers.set(name, handler); return { dispose: () => handlers.delete(name) }; },
    executeCommand(name, ...args) { return handlers.get(name)?.(...args); }
  };
  const api = createChatAnnotationsApi({ state, commands, events: { emit() {} },
    getSessionMeta: session => values.get(`sessions.meta.${session}`) });
  const previousZion = window.zion;
  window.zion = { state, commands };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    const cards = JSON.parse(options.body).cards;
    return new Response(JSON.stringify({ details: cards.map(request => ({ ...request, body })) }));
  });
  try {
    await lazyCardDetails(sessionId, kind, id);
    const frozen = api.getSessionAnnotations(sessionId);
    expect(frozen[kind][0]).toMatchObject({ ...body, bodyHydratedRef: reference, expanded: true });
    for (const field of ["bodyRef", "bodySessionId", "bodyKind", "bodyBytes", "detailRef", "detailSessionId"]) {
      expect(values.get(`sessions.annotations.${sessionId}`)[kind][0]).not.toHaveProperty(field);
      expect(frozen[kind][0]).not.toHaveProperty(field);
    }
    // Older fallback copies can remain while an already mounted panel drains.
    values.set(`sessions.meta.${sessionId}`, { annotations });
    values.set(`sessions.pendingRestore.${kind}.${sessionId}`, [card]);
    expect(api.getSessionAnnotations(sessionId)[kind][0]).toEqual(frozen[kind][0]);
    fetch.mockRejectedValue(new Error("Source has advanced"));
    expect(await hydrateRemoteAnnotations(frozen)).toEqual(frozen);
    expect(await lazyCardDetails(sessionId, kind, id)).toEqual(frozen[kind][0]);
    expect(localSessionAnnotationCopy(frozen)[kind][0]).toMatchObject(body);
    expect(fetch).toHaveBeenCalledOnce();
    // A genuinely newer reference must remain unresolved.
    values.set(`sessions.meta.${sessionId}`, { annotations: {
      [kind]: [{ ...card, bodyRef: "e".repeat(64) }]
    } });
    expect(api.getSessionAnnotations(sessionId)[kind][0].bodyRef).toBe("e".repeat(64));
  } finally {
    api.dispose(); window.zion = previousZion;
  }
});

it("hydrates durable arguments and results as the exact frozen input snapshot", async () => {
  const body = { args: { command: "中文", count: 0, nullable: null }, result: { ok: false, values: [] } };
  const card = { id: "durable", kind: "tool", runId: "run", name: "Bash", expanded: false,
    bodyRef: "c".repeat(64), bodySessionId: "s-durable", bodyKind: "tools", bodyBytes: 123 };
  const annotations = { tools: [card], thinking: [] };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(new URL(url).pathname).toBe("/v1/workbench-state/sessions/s-durable/card-details");
    const requests = JSON.parse(options.body).cards;
    expect(requests).toEqual([{ kind: "tools", id: card.id, ref: card.bodyRef, storage: "body" }]);
    return new Response(JSON.stringify({ details: requests.map(item => ({ ...item, body })) }));
  });
  const hydrated = await hydrateRemoteAnnotations(annotations);
  expect(hydrated.tools[0]).toEqual({ id: card.id, kind: "tool", runId: "run", name: "Bash",
    expanded: false, ...body });
  expect(fetch).toHaveBeenCalledOnce();
  expect(annotations.tools[0]).toEqual(card);
  expect(() => localSessionAnnotationCopy(annotations)).toThrow(/details/);
  expect(localSessionAnnotationCopy(hydrated).tools[0]).toEqual({
    id: card.id, kind: "tool", name: "Bash", expanded: false, ...body });
  const before = clientAnnotationSnapshot(annotations);
  const after = structuredClone(before);
  after.tools[0].expanded = true;
  const merged = applySessionMetadataChanges({ annotations }, sessionMetadataChanges({ annotations: before }, { annotations: after }));
  expect(merged.meta.annotations.tools[0]).toEqual({ ...card, expanded: true });
});

it("fails durable hydration on missing identity or missing returned body", async () => {
  const card = { id: "missing", kind: "tool", runId: "run", bodyRef: "d".repeat(64),
    bodySessionId: "s-missing", bodyKind: "tools", bodyBytes: 123 };
  await expect(hydrateRemoteAnnotations({ thinking: [card] })).rejects.toThrow(/identity/);
  await expect(hydrateRemoteAnnotations({ tools: [{ ...card, bodySessionId: null }] })).rejects.toThrow(/source/);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ details: [] })));
  await expect(hydrateRemoteAnnotations({ tools: [card] })).rejects.toThrow(/not returned/);
});

it("loads exact arguments when expanding a durable tool card and updates the metadata fallback", async () => {
  const reference = "e".repeat(64);
  let annotations = { tools: [{ id: "expand", kind: "tool", runId: "run", expanded: false,
    args: {}, result: null, bodyRef: reference, bodySessionId: "s-expand", bodyKind: "tools", bodyBytes: 123 }], thinking: [] };
  const meta = new Map([["sessions.meta.s-expand", { annotations }]]);
  const previousZion = window.zion;
  const body = { args: { command: "exact", count: 0, nullable: null }, result: { output: "完整", values: [] } };
  window.zion = { state: { get: key => meta.get(key), set: (key, value) => meta.set(key, value) },
    commands: { executeCommand(name, input) {
      if (name === "zion.chatCards.getSessionAnnotations") return annotations;
      if (name === "zion.chatCards.updateSessionAnnotations") annotations = input.updater(annotations);
    } } };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    const cards = JSON.parse(options.body).cards;
    return new Response(JSON.stringify({ details: cards.map(card => ({ ...card, body })) }));
  });
  try {
    expect((await lazyCardDetails("s-expand", "tools", "expand")).args).toEqual(body.args);
    expect(annotations.tools[0]).toMatchObject({ ...body, bodyHydratedRef: reference });
    expect(annotations.tools[0]).not.toHaveProperty("bodyRef");
    expect(meta.get("sessions.meta.s-expand").annotations.tools[0]).toEqual(annotations.tools[0]);
    expect(await lazyCardDetails("s-expand", "tools", "expand")).toEqual(annotations.tools[0]);
  } finally { window.zion = previousZion; }
});

it("rejects a stale expansion without replacing the newer card or metadata", async () => {
  const reference = "f".repeat(64);
  let annotations = { tools: [{ id: "race", kind: "tool", runId: "run",
    bodyRef: reference, bodySessionId: "s-race", bodyKind: "tools", bodyBytes: 123 }], thinking: [] };
  const initialMeta = { annotations };
  const meta = new Map([["sessions.meta.s-race", initialMeta]]);
  const previousZion = window.zion;
  const update = vi.fn();
  window.zion = { state: { get: key => meta.get(key), set: (key, value) => meta.set(key, value) },
    commands: { executeCommand(name) {
      if (name === "zion.chatCards.getSessionAnnotations") return annotations;
      if (name === "zion.chatCards.updateSessionAnnotations") update();
    } } };
  let respond;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => { respond = resolve; }));
  try {
    const pending = lazyCardDetails("s-race", "tools", "race");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    annotations = { ...annotations, tools: [{ ...annotations.tools[0], bodyRef: "a".repeat(64) }] };
    respond(new Response(JSON.stringify({ details: [{ kind: "tools", id: "race", ref: reference,
      body: { args: { stale: true }, result: "stale" } }] })));
    await expect(pending).rejects.toThrow(/变化/);
    expect(update).not.toHaveBeenCalled();
    expect(meta.get("sessions.meta.s-race")).toBe(initialMeta);
    expect(annotations.tools[0]).not.toHaveProperty("result");
  } finally { window.zion = previousZion; }
});

it("hydrates a frozen card snapshot without using throttled document revision history", async () => {
  const full = source();
  const render = sessionRenderProjection(full);
  expect(JSON.stringify(render).length).toBeLessThan(JSON.stringify(full).length / 3);
  expect(render.meta.annotations.tools[1]).toEqual(full.meta.annotations.tools[1]);
  expect(render.meta.annotations.tools[2]).toEqual(full.meta.annotations.tools[2]);
  expect(() => localSessionAnnotationCopy(render.meta.annotations)).toThrow(/details/);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(new URL(url).pathname).toBe("/v1/workbench-state/sessions/s/card-details");
    return new Response(JSON.stringify(sessionCardDetails({ ...full, session_revision: 15 },
      JSON.parse(options.body).cards)));
  });
  const hydrated = await hydrateRemoteAnnotations(render.meta.annotations);
  expect(hydrated).toEqual(full.meta.annotations);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(render.meta.annotations.tools[0].result).toBeNull();
  expect(localSessionAnnotationCopy(hydrated).tools[0].result).toBe(full.meta.annotations.tools[0].result);
});

it("preserves durable results when preferences from projected cards are saved", () => {
  const full = source();
  const render = sessionRenderProjection(full);
  const before = clientAnnotationSnapshot(render.meta.annotations);
  const after = structuredClone(before);
  after.tools[0].expanded = true;
  const patch = sessionMetadataChanges({ annotations: before }, { annotations: after });
  const merged = applySessionMetadataChanges(full.meta, patch);
  expect(merged.conflicts).toEqual([]);
  expect(merged.meta.annotations.tools[0]).toEqual({ ...full.meta.annotations.tools[0], expanded: true });
  expect(JSON.stringify(patch)).not.toContain("detailRef");
});

it("rejects changed or unavailable card details rather than substituting newer context", async () => {
  const full = source();
  const card = sessionRenderProjection(full).meta.annotations.tools[0];
  const request = [{ kind: "tools", id: "t", ref: card.detailRef }];
  full.meta.annotations.tools[0].result = "a new result";
  expect(() => sessionCardDetails(full, request)).toThrow(/变化/);
  expect(() => sessionCardDetails({ meta: {} }, request)).toThrow(/变化/);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ details: [] })));
  await expect(hydrateRemoteAnnotations({ tools: [card] })).rejects.toThrow(/not returned/);
});
