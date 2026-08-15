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
  const response = await fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.detail || `session storage HTTP ${response.status}`);
  return body;
}

export async function readRemoteSnapshot() {
  return request("/app-sessions/snapshot", { method: "GET" });
}

export async function writeRemoteSnapshot(snapshot, expectedRevision = null) {
  return request("/app-sessions/snapshot", {
    method: "PUT",
    body: JSON.stringify({ snapshot, expected_revision: expectedRevision })
  });
}

export async function writeRemoteSession(sessionId, payload, expectedRevision = null) {
  return request(`/app-sessions/${encodeURIComponent(sessionId)}`, {
    method: "PUT",
    body: JSON.stringify({ ...payload, expected_revision: expectedRevision })
  });
}

export async function writeRemoteTree(tree, index, expectedRevision = null) {
  return request("/app-sessions/tree", {
    method: "PUT",
    body: JSON.stringify({ tree, index, expected_revision: expectedRevision })
  });
}

export async function deleteRemoteSession(sessionId, expectedRevision = null) {
  return request(`/app-sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    body: JSON.stringify({ expected_revision: expectedRevision })
  });
}
