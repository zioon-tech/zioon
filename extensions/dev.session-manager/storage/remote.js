const DEFAULT_BASE = "http://127.0.0.1:8765";

function baseUrl() {
  const state = window.zion?.state?.get?.("localTools.baseUrl");
  if (typeof state === "string" && state.trim()) return state.trim().replace(/\/$/, "");
  try {
    const stored = localStorage.getItem("zion.localTools.baseUrl");
    if (stored) return stored.trim().replace(/\/$/, "");
  } catch {}
  return DEFAULT_BASE;
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
      const error = new Error(body?.detail || `session storage HTTP ${response.status}`);
      error.name = "SessionStorageHttpError";
      error.status = response.status;
      error.detail = body?.detail || null;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

export async function readRemoteSnapshot() {
  return request("/app-sessions/snapshot", { method: "GET", timeoutMs: 30000 });
}

export async function readRemoteStatus() {
  return request("/app-sessions/status", { method: "GET" });
}

export async function readRemoteSession(sessionId) {
  return request(`/app-sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET"
  });
}

export async function writeRemoteSnapshot(snapshot, expectedRevision = null) {
  return request("/app-sessions/snapshot", {
    method: "PUT",
    body: JSON.stringify({ snapshot, expected_revision: expectedRevision })
  });
}

export async function writeRemoteSession(sessionId, payload, options = {}) {
  const normalized = typeof options === "string"
    ? { expectedRevision: options }
    : (options || {});
  return request(`/app-sessions/${encodeURIComponent(sessionId)}`, {
    method: "PUT",
    body: JSON.stringify({
      ...payload,
      expected_revision: normalized.expectedRevision || null,
      operation_id: normalized.operationId || null,
      expected_session_revision: Number.isFinite(normalized.expectedSessionRevision)
        ? normalized.expectedSessionRevision
        : null
    })
  });
}

export async function writeRemoteTree(tree, index, expectedRevision = null) {
  return request("/app-sessions/tree", {
    method: "PUT",
    body: JSON.stringify({ tree, index, expected_revision: expectedRevision })
  });
}

export async function deleteRemoteSession(sessionId, options = {}) {
  const normalized = typeof options === "string"
    ? { expectedRevision: options }
    : (options || {});
  return request(`/app-sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    body: JSON.stringify({
      expected_revision: normalized.expectedRevision || null,
      operation_id: normalized.operationId || null,
      expected_session_revision: Number.isFinite(normalized.expectedSessionRevision)
        ? normalized.expectedSessionRevision
        : null
    })
  });
}

export async function readRemoteSessionRevisions(sessionId) {
  return request(`/app-sessions/${encodeURIComponent(sessionId)}/revisions`, {
    method: "GET"
  });
}

export async function restoreRemoteSessionRevision(sessionId, revision, operationId = null) {
  return request(`/app-sessions/${encodeURIComponent(sessionId)}/restore`, {
    method: "POST",
    body: JSON.stringify({
      revision: Number(revision),
      operation_id: operationId || null
    })
  });
}

export async function readRemoteSessionKV(key) {
  return request(`/app-sessions/kv/${encodeURIComponent(key)}`, {
    method: "GET"
  });
}

export async function writeRemoteSessionKV(key, value) {
  return request(`/app-sessions/kv/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ value })
  });
}

export async function migrateBrowserSessionStorage(sourceId, snapshot, fingerprint) {
  return request("/app-sessions/migrate-browser-storage", {
    method: "POST",
    timeoutMs: 120000,
    body: JSON.stringify({
      source_id: sourceId,
      snapshot,
      fingerprint
    })
  });
}
