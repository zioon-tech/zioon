import {
  DEFAULT_WORKBENCH_RUNTIME_BASE_URL,
  readWorkbenchRuntimeConfig
} from "../../../src/runtime/workbench-runtime-config.ts";
import {
  subscribeEventSource
} from "../../../packages/runtime-client/src/sse.mjs";

function baseUrl() {
  return readWorkbenchRuntimeConfig({
    state: window.zion?.state,
    storage: globalThis.localStorage
  }).baseUrl || DEFAULT_WORKBENCH_RUNTIME_BASE_URL;
}

async function request(path, options = {}) {
  const { timeoutMs = 10000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(fetchOptions.headers || {}) }
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(
        body?.error || body?.detail || `Runtime Workbench state HTTP ${response.status}`
      );
      error.name = "SessionStorageHttpError";
      error.status = response.status;
      error.detail = body?.error || body?.detail || null;
      error.result = body;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

export async function readRemoteSnapshot() {
  return request("/v1/workbench-state/snapshot", { method: "GET", timeoutMs: 30000 });
}

export async function readRemoteStatus() {
  return request("/v1/workbench-state/status", { method: "GET" });
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

export async function readRemoteSession(sessionId) {
  return request(`/v1/workbench-state/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET"
  });
}

export async function readRemoteActiveRun(sessionId) {
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/active-run`, {
    method: "GET"
  });
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
  return request(`/v1/workbench-state/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PUT",
    body: JSON.stringify({
      ...payload,
      expected_revision: normalized.expectedRevision || null,
      operation_id: normalized.operationId || null,
      expected_session_revision: Number.isFinite(normalized.expectedSessionRevision)
        ? normalized.expectedSessionRevision
        : null,
      source_client_id: normalized.sourceClientId || null
    })
  });
}

export async function writeRemoteTree(tree, index, expectedRevision = null, {
  sourceClientId = ""
} = {}) {
  return request("/v1/workbench-state/tree", {
    method: "PUT",
    body: JSON.stringify({
      tree,
      index,
      expected_revision: expectedRevision,
      source_client_id: sourceClientId || null
    })
  });
}

export async function deleteRemoteSession(sessionId, options = {}) {
  const normalized = typeof options === "string"
    ? { expectedRevision: options }
    : (options || {});
  return request(`/v1/workbench-state/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    body: JSON.stringify({
      expected_revision: normalized.expectedRevision || null,
      operation_id: normalized.operationId || null,
      expected_session_revision: Number.isFinite(normalized.expectedSessionRevision)
        ? normalized.expectedSessionRevision
        : null,
      source_client_id: normalized.sourceClientId || null
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
