import type { AccountSession } from "../../packages/account-ui/src/client";
import { displayPreferenceStorage, isDisplayPreference, registerDisplayDocumentAlias, setDisplayPreferenceViewer } from "../editor/display-preferences";
import { documentDisplayIdentity } from "../../packages/runtime-client/src/document-display-identity.mjs";

type PageScope = { userId: string; spaceId: string; origin: string; kind: string };
let scope: PageScope | null = null;
let transportInstalled = false;
let locked = false;
export type SharedWorkbenchDocument = {
  localId: string; originSpaceId: string; documentId: string; role: "viewer" | "editor";
  title: string; providerName: string;
};
const documents = new Map<string, SharedWorkbenchDocument>();
const runs = new Map<string, string>();
const documentPrefix = "shared-document:";
const ownedSharedContent = new Set<string>();
function rememberWorkbenchRun(runId: string, localId: string) {
  runs.set(runId, localId);
  if (runs.size > 500) runs.delete(runs.keys().next().value!);
  workbenchStorage.setItem("zion.sharing.runs", JSON.stringify([...runs]));
}
function documentForRun(runId: string) {
  if (!runs.size) {
    try {
      for (const entry of JSON.parse(workbenchStorage.getItem("zion.sharing.runs") || "[]")) {
        if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && sharedWorkbenchDocument(entry[1])) runs.set(entry[0], entry[1]);
      }
    } catch {}
  }
  return runs.get(runId) || "";
}
export function markSharedWorkbenchContent(id: string) {
  if (!id) return;
  ownedSharedContent.add(id);
  workbenchStorage.setItem("zion.sharing.contentMemory", JSON.stringify([...ownedSharedContent]));
}
export function isSharedWorkbenchContent(id: string) {
  if (isSharedWorkbenchDocument(id)) return true;
  if (!ownedSharedContent.size) {
    try { for (const value of JSON.parse(workbenchStorage.getItem("zion.sharing.contentMemory") || "[]")) ownedSharedContent.add(value); } catch {}
  }
  return ownedSharedContent.has(id);
}
export async function refreshWorkbenchContentPrivacy(id: string) {
  if (!id || isSharedWorkbenchContent(id) || scope?.kind !== "personal") return;
  const response = await fetch(`${scope.origin}/v1/sharing/documents/${encodeURIComponent(id)}/privacy`, {
    credentials: "include", signal: AbortSignal.timeout(10_000)
  });
  // Unsaved local drafts cannot yet have a server-side content share.
  if (response.status === 404) return;
  if (!response.ok) throw new Error("无法确认会话分享状态，请稍后重试");
  if ((await response.json()).sharedContent) markSharedWorkbenchContent(id);
}
export function workbenchDocumentForView(view: any) {
  const zion = (globalThis as any).window?.zion;
  for (const entry of zion?.panels?.listEditors?.() || []) {
    const editor = zion.panels.getEditorBySession?.(entry.panelId, entry.sessionId);
    if (editor?.getView?.() === view) return String(entry.sessionId);
  }
  return currentWorkbenchDocument();
}

/** Qualified editor/cache IDs are distinct from physical owner document IDs. */
export function registerSharedWorkbenchDocument(input: Omit<SharedWorkbenchDocument, "localId">) {
  for (const value of [input.originSpaceId, input.documentId]) {
    if (!value || value.length > 256 || /[\x00-\x20]/.test(value)) throw new Error("分享文档地址无效");
  }
  const localId = `${documentPrefix}${encodeURIComponent(input.originSpaceId)}:${encodeURIComponent(input.documentId)}`;
  const existing = documents.get(localId);
  if (existing && ["originSpaceId", "documentId", "role", "title", "providerName"].every(
    key => existing[key as keyof SharedWorkbenchDocument] === input[key as keyof typeof input]
  )) return existing;
  const document = Object.freeze({ ...input, localId });
  documents.set(localId, document);
  workbenchStorage.setItem("zion.sharing.documents", JSON.stringify([...documents.values()]));
  return document;
}
export function sharedWorkbenchDocument(localId: string): SharedWorkbenchDocument | null {
  if (!localId?.startsWith(documentPrefix)) return null;
  if (!documents.size) {
    try {
      for (const entry of JSON.parse(workbenchStorage.getItem("zion.sharing.documents") || "[]")) {
        if (entry?.localId === `${documentPrefix}${encodeURIComponent(entry.originSpaceId)}:${encodeURIComponent(entry.documentId)}`) {
          documents.set(entry.localId, Object.freeze(entry));
        }
      }
    } catch { /* an invalid cache cannot establish authority */ }
  }
  return documents.get(localId) || null;
}
export const isSharedWorkbenchDocument = (id: string) => !!id?.startsWith(documentPrefix);
export function sharedDocumentEditable(id: string) {
  return !isSharedWorkbenchDocument(id) || sharedWorkbenchDocument(id)?.role === "editor";
}
export function forgetSharedWorkbenchDocument(id: string) {
  documents.delete(id);
  workbenchStorage.setItem("zion.sharing.documents", JSON.stringify([...documents.values()]));
}

const sessionKeys = new Set(["sessionId", "session_id", "workbenchSessionId", "documentId"]);
function rewriteDocumentValue(value: any, document: SharedWorkbenchDocument, inbound = false): any {
  if (Array.isArray(value)) return value.map(entry => rewriteDocumentValue(entry, document, inbound));
  if (!value || typeof value !== "object") return value;
  const from = inbound ? document.documentId : document.localId;
  const to = inbound ? document.localId : document.documentId;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key, (sessionKeys.has(key) || key === "id") && entry === from ? to : rewriteDocumentValue(entry, document, inbound)
  ]));
}

function rememberRuns(value: any, document: SharedWorkbenchDocument) {
  if (!value || typeof value !== "object") return;
  if (typeof value.runId === "string") rememberWorkbenchRun(value.runId, document.localId);
  if (typeof value.id === "string" && (value.status || value.interactionProfileId) && !value.id.startsWith(documentPrefix)) {
    rememberWorkbenchRun(value.id, document.localId);
  }
  for (const entry of Object.values(value)) if (entry && typeof entry === "object") rememberRuns(entry, document);
}

async function localDocumentResponse(response: Response, document: SharedWorkbenchDocument) {
  if (response.headers.get("content-type")?.includes("application/json")) {
    const value = await response.json();
    rememberRuns(value, document);
    const headers = new Headers(response.headers);
    headers.delete("content-length"); headers.delete("content-encoding");
    return new Response(JSON.stringify(rewriteDocumentValue(value, document, true)),
      { status: response.status, statusText: response.statusText, headers });
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let pending = "";
  const line = (text: string) => {
    if (!text.startsWith("data:")) return text;
    try {
      const value = JSON.parse(text.slice(5));
      rememberRuns(value, document);
      return `data: ${JSON.stringify(rewriteDocumentValue(value, document, true))}`;
    } catch { return text; }
  };
  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n"); pending = lines.pop() || "";
      if (lines.length) controller.enqueue(encoder.encode(lines.map(line).join("\n") + "\n"));
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(line(pending)));
    }
  }));
  const headers = new Headers(response.headers);
  headers.delete("content-length"); headers.delete("content-encoding");
  return new Response(stream, { status: response.status, headers });
}

export function currentWorkbenchSpace() { return scope; }
export async function resolveWorkbenchDisplayDocument(id: string) {
  const pinned = scope;
  if (!id || !pinned) return id;
  const shared = sharedWorkbenchDocument(id);
  if (isSharedWorkbenchDocument(id) && !shared) return id;
  const identity = await documentDisplayIdentity(shared?.originSpaceId || pinned.spaceId, shared?.documentId || id);
  if (scope !== pinned) return id;
  registerDisplayDocumentAlias(id, identity, workbenchStorage.getItem(`zion.minimap.session.${id}`));
  return identity;
}

export function requestedWorkbenchSpace(href = globalThis.location?.href || "") {
  const value = new URL(href).searchParams.get("space") || "";
  if (value.length > 256 || /[\x00-\x20]/.test(value)) throw new Error("空间地址无效");
  return value;
}

export function pinWorkbenchSpace(identity: AccountSession, baseUrl: string) {
  const next = { userId: identity.user.id, spaceId: identity.space.id, origin: new URL(baseUrl).origin, kind: identity.space.kind || "personal" };
  if (scope && (scope.userId !== next.userId || scope.spaceId !== next.spaceId || scope.origin !== next.origin)) {
    throw new Error("当前窗口的空间已固定，请在新的页面打开其他空间");
  }
  scope = Object.freeze(next);
  setDisplayPreferenceViewer(next.userId, next.spaceId);
}

export function lockWorkbenchSpace() { locked = true; }

export function currentWorkbenchDocument() {
  const zion = (globalThis as any).window?.zion;
  return String(zion?.sessions?.resolveContext?.()?.sessionId || zion?.state?.get?.("sessions.currentId") || "");
}

export function spaceScopedName(name: string) {
  return scope ? `${name}:${encodeURIComponent(scope.userId)}:${encodeURIComponent(scope.spaceId)}` : name;
}

/** Every browser extension uses fetch, including streams and native Memory.
 * Capture the page scope once; never follow a mutable cookie's active Space.
 * Explicit management paths can address a different Space without retargeting
 * the page's document transport. Authentication and authorization stay server side. */
export function installWorkbenchSpaceTransport(baseUrl: string) {
  if (transportInstalled) return;
  transportInstalled = true;
  const origin = new URL(baseUrl, globalThis.location.href).origin;
  const fetchImpl = globalThis.fetch.bind(globalThis);
  const requested = requestedWorkbenchSpace();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      globalThis.location.href);
    if (url.origin !== origin || !url.pathname.startsWith("/v1/")) return fetchImpl(input, init);
    if (locked) throw new Error("访问权限已变化，内容已保留，请重新进入工作台");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const match = url.pathname.match(/^\/v1\/spaces\/([^/]+)(?:\/|$)/);
    const supplied = headers.get("x-zioon-space-id");
    const initialIdentity = !scope && !requested && url.pathname === "/v1/account/me";
    const id = match ? decodeURIComponent(match[1]) : scope?.spaceId || requested || (initialIdentity ? supplied || "" : "");
    if (supplied && supplied !== id && !match) throw new Error("请求空间与当前窗口不一致");
    if (id) headers.set("x-zioon-space-id", id);
    const method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    let body: any = null;
    const rawBody = init.body ?? (input instanceof Request && !["GET", "HEAD"].includes(method) ? await input.clone().text() : null);
    if (typeof rawBody === "string") { try { body = JSON.parse(rawBody); } catch {} }
    const session = url.pathname.match(/^\/v1\/(?:workbench-state\/)?sessions\/([^/]+)/);
    const run = url.pathname.match(/^\/v1\/runs\/([^/]+)/);
    const memory = /^\/v1\/plugins\/dev\.identity\/files\//.test(url.pathname);
    const runSubmit = ["/v1/runs", "/v1/runs/preview", "/v1/plugins/dev.langchain-chat/commands"].includes(url.pathname);
    const asset = /^\/v1\/assets(?:\/|$)/.test(url.pathname);
    const selectedId = session ? decodeURIComponent(session[1])
      : runSubmit ? body?.sessionId || body?.metadata?.workbenchSessionId || ""
      : run ? documentForRun(decodeURIComponent(run[1]))
      : memory || asset ? url.searchParams.get("document") || currentWorkbenchDocument()
      : /^\/v1\/workbench-state\/events/.test(url.pathname) ? url.searchParams.get("session_id") || "" : "";
    const document = sharedWorkbenchDocument(selectedId);
    if (isSharedWorkbenchDocument(selectedId) && !document) throw new Error("请从分享侧边栏重新打开文档");
    if (document) {
      if (!["GET", "HEAD"].includes(method) && document.role === "viewer") throw new Error("这篇分享文档仅可查看");
      headers.set("x-zioon-content-space", document.originSpaceId);
      headers.set("x-zioon-content-document", document.documentId);
      if (session) url.pathname = url.pathname.replace(session[1], encodeURIComponent(document.documentId));
      if (url.searchParams.get("session_id")) url.searchParams.set("session_id", document.documentId);
      if (memory || asset && url.searchParams.has("document")) url.searchParams.set("document", document.documentId);
      if (body) init = { ...init, body: JSON.stringify(rewriteDocumentValue(body, document)) };
      input = input instanceof Request ? new Request(url, input) : url.toString();
    } else if (headers.has("x-zioon-content-space") || headers.has("x-zioon-content-document")) {
      // Explicit SDK callers may carry a validated physical document scope.
      if (!headers.get("x-zioon-content-space") || !headers.get("x-zioon-content-document")) throw new Error("分享文档范围不完整");
    }
    if (scope?.kind === "team" && /^\/v1\/plugins\/dev\.identity\/files\//.test(url.pathname) && !url.searchParams.has("document")) {
      const documentId = currentWorkbenchDocument();
      if (!documentId) throw new Error("请先打开一篇文档，再访问会话记忆");
      url.searchParams.set("document", documentId);
      input = input instanceof Request ? new Request(url, input) : url.toString();
    }
    const response = await fetchImpl(input, { ...init, headers, credentials: "include" });
    if (!document && session && response.ok && response.headers.get("content-type")?.includes("application/json")) {
      const value = await response.clone().json().catch(() => null);
      if (value?.sharedContent) markSharedWorkbenchContent(selectedId);
    }
    if (document && [403, 404].includes(response.status)) {
      (globalThis as any).window?.zion?.events?.emit?.("sharing/documentAccessChanged", { sessionId: document.localId });
    }
    return document ? localDocumentResponse(response, document) : response;
  };
}

const globalKey = (key: string) => /^(?:zion\.runtime\.|zion\.access\.deviceId$|zion\.account\.pendingInvitation$|zion\.theme|zion\.i18n)/.test(key);
function storageKey(key: string) {
  return scope && !globalKey(key) ? `zion.scoped:${encodeURIComponent(scope.userId)}:${encodeURIComponent(scope.spaceId)}:${key}` : key;
}

export function isWorkbenchStorageEvent(event: Pick<StorageEvent, "key">, key: string) {
  return event.key === null || event.key === storageKey(key);
}

/** Explicit facade, rather than monkey-patching browser Storage. No fallback to
 * unowned browser-era content when a signed-in Space has no cached value. */
export const workbenchStorage = {
  getItem(key: string) {
    if (isDisplayPreference(key)) {
      // Migrate a known document override only when its owner and Space are pinned.
      let value = displayPreferenceStorage.getItem(key);
      if (value == null && scope && key.startsWith("zion.minimap.session.")) {
        value = globalThis.localStorage?.getItem(storageKey(key)) ?? null;
        if (value != null) displayPreferenceStorage.setItem(key, value);
      }
      return value;
    }
    return globalThis.localStorage?.getItem(storageKey(key)) ?? null;
  },
  setItem(key: string, value: string) {
    if (isDisplayPreference(key)) displayPreferenceStorage.setItem(key, value);
    else globalThis.localStorage?.setItem(storageKey(key), value);
  },
  removeItem(key: string) {
    if (isDisplayPreference(key)) displayPreferenceStorage.removeItem(key);
    else globalThis.localStorage?.removeItem(storageKey(key));
  },
  key(index: number) {
    const prefix = scope ? storageKey("") : "";
    const keys = Object.keys(globalThis.localStorage || {}).filter(key => !scope || key.startsWith(prefix));
    return keys[index]?.slice(prefix.length) ?? null;
  },
  get length() {
    const prefix = scope ? storageKey("") : "";
    return Object.keys(globalThis.localStorage || {}).filter(key => !scope || key.startsWith(prefix)).length;
  },
  clear() {
    const keys = Array.from({ length: this.length }, (_, i) => this.key(i)).filter((key): key is string => key !== null);
    for (const key of keys) this.removeItem(key);
  }
};

export function workbenchSpaceUrl(spaceId: string, documentId = "", href = globalThis.location.href) {
  const url = new URL(href);
  url.pathname = "/";
  url.hash = "";
  for (const key of ["session", "zionSession", "invite", "invitation"]) url.searchParams.delete(key);
  url.searchParams.set("space", spaceId);
  if (documentId) url.searchParams.set("session", documentId);
  return url.toString();
}
