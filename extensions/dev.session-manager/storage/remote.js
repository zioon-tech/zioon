import {
  DEFAULT_WORKBENCH_RUNTIME_BASE_URL,
  readWorkbenchRuntimeConfig
} from "../../../src/runtime/workbench-runtime-config.ts";
import {
  subscribeEventSource
} from "../../../packages/runtime-client/src/sse.mjs";
import {
  requestWorkbenchProtocolUpgrade
} from "../../../src/runtime/workbench-pwa-upgrade.ts";
import { workbenchNavigationId } from "../../../src/runtime/workbench-performance.ts";
import { createSessionReadScheduler } from "./read-scheduler.js";

const WORKBENCH_STATE_PROTOCOL = "6";
const reads = createSessionReadScheduler();

function baseUrl() {
  return readWorkbenchRuntimeConfig({
    state: window.zion?.state,
    storage: globalThis.localStorage
  }).baseUrl || DEFAULT_WORKBENCH_RUNTIME_BASE_URL;
}

async function request(path, options = {}) {
  if (window.zion?.state?.get?.("workbench.accessChanged")) {
    throw Object.assign(new Error("账户或访问权限已变化，请重新进入工作台"), {
      name: "SessionStorageHttpError", status: 403,
      code: "WORKBENCH_ACCESS_CHANGED", path, method: options.method || "GET"
    });
  }
  const { timeoutMs = 10000, signal, operationId, readSource = "state", ...fetchOptions } = options;
  const started = performance.now();
  const timing = {
    operationId: operationId || null, method: fetchOptions.method || "GET",
    navigationId: workbenchNavigationId(), source: readSource,
    path: path.split("?")[0].replace(/(\/sessions\/)[^/]+/, "$1:id")
      .replace(/(\/tree\/folders\/)[^/]+/, "$1:id").replace(/(\/kv\/).+/, "$1:key"),
    startedAt: Date.now(), status: null, requestId: null, server: {}
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Zion-Workbench-Protocol": WORKBENCH_STATE_PROTOCOL,
        "X-Zion-Navigation-Id": workbenchNavigationId(),
        "X-Zion-Read-Source": readSource,
        ...(fetchOptions.headers || {})
      }
    });
    timing.headersMs = performance.now() - started;
    timing.status = response.status;
    timing.requestId = response.headers.get("x-zion-request-id");
    for (const metric of (response.headers.get("server-timing") || "").split(",")) {
      const match = metric.trim().match(/^([a-z_]+);dur=([\d.]+)$/);
      if (match) timing.server[match[1]] = Number(match[2]);
    }
    const text = await response.text();
    timing.responseEndMs = Math.round((performance.now() - started) * 10) / 10;
    timing.decodedBytes = new TextEncoder().encode(text).byteLength;
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!response.ok) {
      if (response.status === 426) {
        void requestWorkbenchProtocolUpgrade(
          response.headers.get("x-zion-workbench-protocol")
          || String(body?.expectedProtocol || "")
        );
      }
      const detail = body?.error?.message || body?.error || body?.detail;
      const error = new Error(typeof detail === "string"
        ? detail : `Runtime Workbench state HTTP ${response.status}`);
      error.name = "SessionStorageHttpError";
      error.status = response.status;
      error.code = body?.code || body?.error?.code || `HTTP_${response.status}`;
      error.detail = detail || null;
      error.result = body;
      throw error;
    }
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      throw Object.assign(new Error("Runtime returned an invalid Workbench state response"), {
        name: "SessionStorageResponseError",
        status: response.status, code: "INVALID_RESPONSE"
      });
    }
    return body;
  } catch (cause) {
    const error = cause instanceof Error ? cause
      : Object.assign(new Error(cause?.message || "Session storage request failed"), {
          name: cause?.name || "Error"
        });
    error.path = path.split("?")[0];
    error.method = String(fetchOptions.method || "GET").toUpperCase();
    if (timedOut) error.code = "REQUEST_TIMEOUT";
    timing.error = error.code || error.name;
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    timing.totalMs = Math.round((performance.now() - started) * 10) / 10;
    try {
      const state = window.zion?.state;
      const recent = state?.get("sessions.requestTimings") || [];
      state?.set("sessions.requestTimings", [...recent.slice(-63), timing]);
    } catch {}
  }
}

export async function readRemoteSnapshot() {
  return request("/v1/workbench-state/snapshot", { method: "GET", timeoutMs: 30000 });
}

export async function readRemoteCatalog() {
  try {
    return await request("/v1/workbench-state/catalog?metadata_limit=100&view=compact", { method: "GET" });
  } catch (error) {
    // Older Runtime hosts keep the complete snapshot contract.
    if (error?.status !== 404) throw error;
    return readRemoteSnapshot();
  }
}

export async function readRemoteStatus() {
  return request("/v1/workbench-state/status", { method: "GET" });
}

export async function searchRemoteSessions({ query = "", limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams({
    q: String(query), limit: String(limit), offset: String(offset)
  });
  return request(`/v1/workbench-state/sessions?${params}`, { method: "GET" });
}

export async function readRemoteTree() {
  return request("/v1/workbench-state/tree", { method: "GET" });
}

export async function readRemoteEvents(afterSequence = 0, {
  limit = 500,
  sessionId = ""
} = {}) {
  const query = new globalThis.URLSearchParams({
    after: String(Math.max(0, Number(afterSequence) || 0)),
    limit: String(Math.max(1, Number(limit) || 500))
  });
  if (sessionId) query.set("session_id", String(sessionId));
  return request(`/v1/workbench-state/events?${query}`, { method: "GET" });
}

export async function* subscribeRemoteEvents({
  afterSequence = 0,
  sessionId = "",
  signal,
  fetchImpl = globalThis.fetch
} = {}) {
  const query = new globalThis.URLSearchParams({
    after: String(Math.max(0, Number(afterSequence) || 0))
  });
  if (sessionId) query.set("session_id", String(sessionId));
  for await (const frame of subscribeEventSource(
    `${baseUrl()}/v1/workbench-state/events/stream?${query}`,
    {
      fetchImpl,
      signal,
      lastEventId: afterSequence
    }
  )) {
    let data = null;
    try {
      data = frame.data ? JSON.parse(frame.data) : null;
    } catch {
      const error = new Error("Runtime returned invalid Workbench event JSON");
      error.name = "SessionStorageEventError";
      throw error;
    }
    yield frame.event === "reset"
      ? { type: "reset", ...(data || {}) }
      : data;
  }
}

export async function readRemoteSession(sessionId, { source = "document", minRevision = 0 } = {}) {
  const view = source === "realtime" ? "full" : "render";
  return reads.read(`${baseUrl()}\0${sessionId}\0${view}\0${minRevision}`, () => request(
    `/v1/workbench-state/sessions/${encodeURIComponent(sessionId)}?view=${view}`,
    { method: "GET", readSource: source }
  ), source === "realtime" ? 1 : 0);
}

export async function readRemoteSessionMetadata(sessionId) {
  try {
    return await reads.read(`${baseUrl()}\0${sessionId}\0metadata`, () => request(
      `/v1/workbench-state/sessions/${encodeURIComponent(sessionId)}/metadata?view=render`,
      { method: "GET", readSource: "metadata" }
    ), 1);
  } catch (error) {
    if (error?.status !== 404) throw error;
    // Compatibility with older hosts. The repository still treats this as a
    // metadata read, so a fallback body cannot become an editable empty draft.
    return readRemoteSession(sessionId);
  }
}

export async function updateRemoteRuntimeSession(sessionId, patch) {
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch || {})
  });
}

// Hydrate the caller's frozen snapshot, never substitute a newer document body.
// Hash mismatches fail explicitly so an edit cannot silently change model input.
export async function hydrateRemoteAnnotations(annotations) {
  const groups = new Map();
  for (const kind of ["tools", "thinking"]) {
    for (const item of annotations?.[kind] || []) {
      const ref = item.bodyRef || item.detailRef;
      if (!ref) continue;
      const sessionId = item.bodyRef ? item.bodySessionId : item.detailSessionId;
      if (!sessionId) throw new Error("Card detail source is missing");
      if (item.bodyRef && item.bodyKind !== kind) throw new Error("Card detail identity is invalid");
      if (!groups.has(sessionId)) groups.set(sessionId, []);
      groups.get(sessionId).push({ kind, id: String(item.id), ref,
        ...(item.bodyRef ? { storage: "body" } : {}) });
    }
  }
  if (!groups.size) return annotations;
  const loaded = new Map();
  for (const [sessionId, cards] of groups) {
    for (let index = 0; index < cards.length; index += 100) {
      const batch = cards.slice(index, index + 100);
      const response = await reads.read(`${baseUrl()}\0${sessionId}\0details\0${JSON.stringify(batch)}`,
        () => request(`/v1/workbench-state/sessions/${encodeURIComponent(sessionId)}/card-details`, {
          method: "POST", body: JSON.stringify({ cards: batch }), readSource: "card-details", timeoutMs: 30000
        }));
      for (const item of response.details || []) loaded.set(
        JSON.stringify([sessionId, item.kind, item.id, item.ref]), item.body);
    }
  }
  const next = { ...annotations };
  for (const kind of ["tools", "thinking"]) {
    if (!Array.isArray(annotations?.[kind])) continue;
    next[kind] = annotations[kind].map(item => {
      const ref = item.bodyRef || item.detailRef;
      if (!ref) return item;
      const sessionId = item.bodyRef ? item.bodySessionId : item.detailSessionId;
      const body = loaded.get(JSON.stringify([sessionId, kind, String(item.id), ref]));
      if (!body) throw new Error("Card details were not returned");
      const { detailRef, detailSessionId, bodyRef, bodySessionId, bodyKind, bodyBytes, bodyHydratedRef, ...full } = item;
      return { ...full, ...body };
    });
  }
  return next;
}

export async function readRemoteActiveRun(sessionId) {
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/active-run`, {
    method: "GET"
  });
}

export async function readRemoteRunEvent(runId, sequence) {
  return request(
    `/v1/runs/${encodeURIComponent(runId)}/events/${Number(sequence)}`,
    { method: "GET" }
  );
}

export async function writeRemoteSnapshot(snapshot, expectedRevision = null, {
  sourceClientId = ""
} = {}) {
  return request("/v1/workbench-state/snapshot", {
    method: "PUT",
    body: JSON.stringify({
      snapshot,
      expected_revision: expectedRevision,
      source_client_id: sourceClientId || null
    })
  });
}

export async function writeRemoteSession(sessionId, payload, options = {}) {
  const normalized = typeof options === "string"
    ? { expectedRevision: options }
    : (options || {});
  const path = `/v1/workbench-state/sessions/${encodeURIComponent(sessionId)}`;
  const body = (expectedSessionRevision = normalized.expectedSessionRevision) => ({
    ...payload,
    expected_revision: normalized.expectedRevision || null,
    operation_id: normalized.operationId || null,
    expected_session_revision: Number.isFinite(expectedSessionRevision)
      ? expectedSessionRevision
      : null,
    source_client_id: normalized.sourceClientId || null
  });
  const result = await request(path, {
    method: "PUT",
    operationId: normalized.operationId,
    body: JSON.stringify(body())
  });
  const retryRevision = Number(result?.session_revision);
  if (
    result?.conflict
    && normalized.retryOnConflict === true
    && Number.isFinite(retryRevision)
  ) {
    return request(path, {
      method: "PUT",
      body: JSON.stringify(body(retryRevision))
    });
  }
  return result;
}

export async function writeRemoteTree(tree, index, expectedRevision = null, {
  sourceClientId = "",
  baseTree = null,
  operationId = null
} = {}) {
  return request("/v1/workbench-state/tree", {
    method: "PUT",
    body: JSON.stringify({
      tree,
      index,
      operation_id: operationId,
      ...(baseTree ? { base_tree: baseTree } : {}),
      expected_revision: expectedRevision,
      source_client_id: sourceClientId || null
    })
  });
}

export async function deleteRemoteSession(sessionId, options = {}) {
  const normalized = typeof options === "string"
    ? { expectedRevision: options }
    : (options || {});
  const path = `/v1/workbench-state/sessions/${encodeURIComponent(sessionId)}`;
  const body = (expectedSessionRevision = normalized.expectedSessionRevision) => ({
    expected_revision: normalized.expectedRevision || null,
    operation_id: normalized.operationId || null,
    expected_session_revision: Number.isFinite(expectedSessionRevision)
      ? expectedSessionRevision
      : null,
    source_client_id: normalized.sourceClientId || null
  });
  const result = await request(path, {
    method: "DELETE",
    timeoutMs: 5000,
    signal: normalized.signal,
    operationId: normalized.operationId,
    body: JSON.stringify(body())
  });
  const retryRevision = Number(result?.session_revision);
  if (
    result?.conflict
    && normalized.retryOnConflict !== false
    && Number.isFinite(retryRevision)
  ) {
    return request(path, {
      method: "DELETE",
      timeoutMs: 5000,
      signal: normalized.signal,
      operationId: normalized.operationId,
      body: JSON.stringify(body(retryRevision))
    });
  }
  return result;
}

export async function deleteRemoteFolder(folderId, baseTree, { operationId, sourceClientId, signal } = {}) {
  return request(`/v1/workbench-state/tree/folders/${encodeURIComponent(folderId)}`, {
    method: "DELETE",
    timeoutMs: 5000, signal, operationId,
    body: JSON.stringify({
      base_tree: baseTree, operation_id: operationId,
      source_client_id: sourceClientId || null
    })
  });
}

export async function readRemoteSessionRevisions(sessionId) {
  return request(`/v1/workbench-state/sessions/${encodeURIComponent(sessionId)}/revisions`, {
    method: "GET"
  });
}

export async function restoreRemoteSessionRevision(sessionId, revision, operationId = null) {
  return request(`/v1/workbench-state/sessions/${encodeURIComponent(sessionId)}/restore`, {
    method: "POST",
    body: JSON.stringify({
      revision: Number(revision),
      operation_id: operationId || null
    })
  });
}

export async function forkRemoteChatSession(sessionId, {
  id,
  title
} = {}) {
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/fork`, {
    method: "POST",
    body: JSON.stringify({
      ...(id ? { id: String(id) } : {}),
      ...(title ? { title: String(title) } : {})
    })
  });
}

export async function readRemoteSessionKV(key) {
  return request(`/v1/workbench-state/kv/${encodeURIComponent(key)}`, {
    method: "GET"
  });
}

export async function writeRemoteSessionKV(key, value, {
  sourceClientId = ""
} = {}) {
  return request(`/v1/workbench-state/kv/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({
      value,
      source_client_id: sourceClientId || null
    })
  });
}

export async function migrateBrowserSessionStorage(sourceId, snapshot, fingerprint) {
  return request("/v1/workbench-state/migrate-browser-storage", {
    method: "POST",
    timeoutMs: 120000,
    body: JSON.stringify({
      source_id: sourceId,
      snapshot,
      fingerprint
    })
  });
}
