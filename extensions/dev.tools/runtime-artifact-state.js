import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
import {
  readWorkbenchRuntimeConfig
} from "../../src/runtime/workbench-runtime-config.ts";

const runtimeArtifactsBySession = new Map();

function runtimeConfig(state, storage) {
  const config = readWorkbenchRuntimeConfig({ state, storage });
  const backend = String(state?.get?.("runtime.connection")?.backend || "").trim();
  if (config.mode === "browser" || (config.mode !== "runtime" && backend !== "runtime")) {
    return null;
  }
  return config;
}

function basename(path) {
  const normalized = String(path || "").replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || normalized;
}

function projectChange(change, sessionId) {
  const path = String(change?.path || "").trim();
  const toolCallId = String(change?.toolCallId || change?.invocationId || change?.id || "");
  if (!path || !toolCallId) return null;
  return {
    id: String(change.artifactId || change.id || `${toolCallId}:runtime`),
    sessionId,
    toolCallId,
    toolName: String(change.toolName || ""),
    path,
    basename: basename(path),
    kind: String(change.operation || "modified"),
    ...(change.before !== undefined ? { before: String(change.before) } : {}),
    ...(change.after !== undefined ? { after: String(change.after) } : {}),
    ...(change.patch !== undefined ? { patch: String(change.patch) } : {}),
    status: "unknown",
    addedLines: Math.max(0, Number(change.addedLines) || 0),
    removedLines: Math.max(0, Number(change.removedLines) || 0),
    createdAt: Number(change.createdAt) || null,
    runtime: true,
    rawChange: change
  };
}

export function getCachedRuntimeArtifacts(sessionId) {
  return runtimeArtifactsBySession.get(String(sessionId || "")) || [];
}

export async function refreshRuntimeSessionArtifacts({
  sessionId,
  state = globalThis.window?.zion?.state,
  storage = localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const id = String(sessionId || "").trim();
  if (!id) return { loaded: false, artifacts: [] };
  const config = runtimeConfig(state, storage);
  if (!config) {
    runtimeArtifactsBySession.delete(id);
    return { loaded: false, artifacts: [] };
  }
  const response = await fetchImpl(
    `${config.baseUrl}/v1/sessions/${encodeURIComponent(id)}/artifacts`,
    { headers: { accept: "application/json" } }
  );
  if (response.status === 404) {
    runtimeArtifactsBySession.delete(id);
    return { loaded: false, artifacts: [] };
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Runtime artifacts load failed: ${response.status}`);
  }
  const artifacts = (Array.isArray(body?.changes) ? body.changes : [])
    .map((change) => projectChange(change, id))
    .filter(Boolean);
  runtimeArtifactsBySession.set(id, artifacts);
  return { loaded: true, artifacts };
}

export function clearRuntimeArtifactCache(sessionId = "") {
  const id = String(sessionId || "").trim();
  if (id) runtimeArtifactsBySession.delete(id);
  else runtimeArtifactsBySession.clear();
}
