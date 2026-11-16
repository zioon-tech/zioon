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

const WORKBENCH_STATE_PROTOCOL = "5";

function baseUrl() {
  return readWorkbenchRuntimeConfig({
    state: window.zion?.state,
    storage: globalThis.localStorage
  }).baseUrl || DEFAULT_WORKBENCH_RUNTIME_BASE_URL;
}

async function request(path, options = {}) {
  if (window.zion?.state?.get?.("workbench.accessChanged")) {
    throw new Error("账户或访问权限已变化，请重新进入工作台");
  }
  const { timeoutMs = 10000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Zion-Workbench-Protocol": WORKBENCH_STATE_PROTOCOL,
        ...(fetchOptions.headers || {})
      }
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 426) {
        void requestWorkbenchProtocolUpgrade(
          response.headers.get("x-zion-workbench-protocol")
          || String(body?.expectedProtocol || "")
        );
      }
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

export async function readRemoteCatalog() {
  try {
    return await request("/v1/workbench-state/catalog?metadata_limit=100", { method: "GET" });
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

export async function readRemoteSession(sessionId) {
  return request(`/v1/workbench-state/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET"
  });
}

export async function updateRemoteRuntimeSession(sessionId, patch) {
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch || {})
  });
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
    body: JSON.stringify(body())
  });
  const retryRevision = Number(result?.session_revision);
  if (
    result?.conflict
    && normalized.retryOnConflict !== false
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
  baseTree = null
} = {}) {
  return request("/v1/workbench-state/tree", {
    method: "PUT",
    body: JSON.stringify({
      tree,
      index,
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
      body: JSON.stringify(body(retryRevision))
    });
  }
  return result;
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
