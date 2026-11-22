import type { ParticipantsSnapshot, ParticipantsSource } from "../ui/workbench/editor-participants-view";
import { createRequestSignal } from "../../packages/runtime-client/src/request-signal.mjs";

/** One active visit per page, shared by all of that page's panels. */
export function createReaderParticipants(options: {
  url: string; headers?: HeadersInit; onAccessLost?(): void; heartbeatMs?: number;
}): ParticipantsSource & { refresh(): Promise<void>; dispose(): void } {
  let disposed = false, suspended = false, visitId = "", request: AbortController | null = null, generation = 0;
  let snapshot: ParticipantsSnapshot = { scopeKey: options.url, people: [] };
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  const publish = (value: any) => {
    if (!Array.isArray(value.visitors)) throw new Error("invalid_presence");
    const people = value.visitors.slice(0, 100).filter((person: any) => person && typeof person.id === "string" &&
      typeof person.name === "string" && person.id !== value.selfVisitorId && person.online === true)
      .map((person: any) => ({ id: person.id, name: person.name, role: person.role || "visitor",
        online: true, inherited: false, visitor: true }));
    snapshot = { scopeKey: options.url, people: [...new Map(people.map((person: any) => [person.id, person])).values()] as any };
    emit();
  };
  const call = async (method: string, path: string, signal: AbortSignal, keepalive = false) => {
    const headers = new Headers(options.headers); headers.set("content-type", "application/json");
    const response = await fetch(path, { method, headers, credentials: "include", cache: "no-store",
      redirect: "error", signal, keepalive, ...(method === "GET" ? {} : { body: "{}" }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.code || "presence_failed"), { status: response.status, code: result.code });
    return result;
  };
  const refresh = async () => {
    if (disposed || suspended || request) return;
    const controller = new AbortController(), id = generation; request = controller;
    const lifetime = createRequestSignal(controller.signal, 10000), signal = lifetime.signal;
    try {
      let value;
      try { value = await call(visitId ? "PUT" : "POST", visitId ? `${options.url}/${visitId}` : options.url, signal); }
      catch (error: any) {
        if (error.code !== "visit_expired" || !visitId) throw error;
        visitId = "";
        value = await call("POST", options.url, signal);
      }
      if (disposed || suspended || controller.signal.aborted || generation !== id) return;
      if (!/^[A-Za-z0-9_-]{43}$/.test(value.visitId || "")) throw new Error("invalid_visit");
      visitId = value.visitId; publish(value);
    } catch (error: any) {
      if (disposed || suspended || controller.signal.aborted || generation !== id) return;
      snapshot = { scopeKey: options.url, people: [] }; emit();
      if ([401, 403, 404].includes(error.status)) { visitId = ""; options.onAccessLost?.(); }
    } finally { lifetime.dispose(); if (request === controller) request = null; }
  };
  const leave = () => {
    generation++; request?.abort(); request = null;
    const id = visitId; visitId = "";
    if (id) void call("DELETE", `${options.url}/${id}`, AbortSignal.timeout(3000), true).catch(() => {});
    snapshot = { scopeKey: options.url, people: [] }; emit();
  };
  const hide = () => { suspended = true; leave(); };
  const show = () => { if (!disposed) { suspended = false; void refresh(); } };
  const timer = window.setInterval(() => { void refresh(); }, options.heartbeatMs || 15000);
  window.addEventListener("pagehide", hide); window.addEventListener("pageshow", show);
  window.addEventListener("online", show);
  void refresh();
  return {
    snapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    refresh,
    dispose() {
      if (disposed) return; disposed = true; clearInterval(timer);
      window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show);
      window.removeEventListener("online", show); leave(); listeners.clear();
    }
  };
}
