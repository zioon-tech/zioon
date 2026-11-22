import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
import {
  readWorkbenchRuntimeConfig
} from "../../src/runtime/workbench-runtime-config.ts";
import {
  IDENTITY_RUNTIME_KV_KEY,
  PROJECT_AUTOMATION_RUNTIME_KV_KEY,
  buildIdentityContextFromSnapshot,
  createIdentitySnapshot,
  hasIdentityContext,
  insertAfterLeadingSystem,
  normalizeIdentitySnapshot,
  projectAutomationRevision
} from "./identity-runtime-shared.js";
import {
  normalizeAutomationDocument
} from "./project-automation-core.js";

export {
  IDENTITY_RUNTIME_KV_KEY,
  PROJECT_AUTOMATION_RUNTIME_KV_KEY,
  buildIdentityContextFromSnapshot,
  createIdentitySnapshot,
  hasIdentityContext,
  insertAfterLeadingSystem,
  normalizeIdentitySnapshot,
  projectAutomationRevision
};

function runtimeConfigForIdentity(state, storage) {
  const config = readWorkbenchRuntimeConfig({ state, storage });
  const backend = String(state?.get?.("runtime.connection")?.backend || "").trim();
  if (config.mode === "browser" || (config.mode !== "runtime" && backend !== "runtime")) {
    return null;
  }
  return config;
}

export function canSyncIdentitySnapshotToRuntime({
  state = globalThis.window?.zion?.state,
  storage = localStorage
} = {}) {
  return !!runtimeConfigForIdentity(state, storage);
}

export async function refreshIdentityContextInRuntime({
  sessionId,
  state = globalThis.window?.zion?.state,
  storage = localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = runtimeConfigForIdentity(state, storage);
  if (!config) return null;
  const response = await fetchImpl(`${config.baseUrl}/v1/plugins/dev.identity/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "refresh_context", sessionId })
  });
  const body = await response.json().catch(() => null);
  const result = body?.result;
  if (!response.ok || !result?.ok || !result.snapshot) {
    throw new Error(body?.error || body?.message || `Runtime identity refresh failed: ${response.status}`);
  }
  return normalizeIdentitySnapshot(result.snapshot);
}

export async function loadIdentitySnapshotFromRuntime({
  state = globalThis.window?.zion?.state,
  storage = localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = runtimeConfigForIdentity(state, storage);
  if (!config) return null;
  const response = await fetchImpl(
    `${config.baseUrl}/v1/workbench-state/kv/${encodeURIComponent(IDENTITY_RUNTIME_KV_KEY)}`,
    { headers: { accept: "application/json" } }
  );
  if (response.status === 404) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Runtime identity load failed: ${response.status}`);
  }
  return normalizeIdentitySnapshot(body?.value);
}

export async function syncIdentitySnapshotToRuntime({
  snapshot,
  state = globalThis.window?.zion?.state,
  storage = localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = runtimeConfigForIdentity(state, storage);
  if (!config) return { synced: false, reason: "runtime-unavailable" };
  const value = normalizeIdentitySnapshot(snapshot);
  if (!value.content.trim()) return { synced: false, reason: "empty-identity-context" };
  const response = await fetchImpl(
    `${config.baseUrl}/v1/workbench-state/kv/${encodeURIComponent(IDENTITY_RUNTIME_KV_KEY)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value })
    }
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    throw new Error(body?.error || `Runtime identity sync failed: ${response.status}`);
  }
  state?.set?.("runtime.identitySync", {
    status: "synced",
    syncedAt: Date.now(),
    sourceRoot: value.sourceRoot
  });
  return { synced: true, snapshot: value, result: body };
}

export async function loadProjectAutomationFromRuntime({
  state = globalThis.window?.zion?.state,
  storage = localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = runtimeConfigForIdentity(state, storage);
  if (!config) return null;
  const response = await fetchImpl(
    `${config.baseUrl}/v1/workbench-state/kv/${encodeURIComponent(PROJECT_AUTOMATION_RUNTIME_KV_KEY)}`,
    { headers: { accept: "application/json" } }
  );
  if (response.status === 404) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Runtime project automation load failed: ${response.status}`);
  }
  return normalizeAutomationDocument(body?.value);
}

export async function syncProjectAutomationToRuntime({
  document,
  state = globalThis.window?.zion?.state,
  storage = localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = runtimeConfigForIdentity(state, storage);
  if (!config) return { synced: false, reason: "runtime-unavailable" };
  const value = normalizeAutomationDocument(document);
  const response = await fetchImpl(
    `${config.baseUrl}/v1/workbench-state/kv/${encodeURIComponent(PROJECT_AUTOMATION_RUNTIME_KV_KEY)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value })
    }
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    throw new Error(body?.error || `Runtime project automation sync failed: ${response.status}`);
  }
  state?.set?.("runtime.projectAutomationSync", {
    status: "synced",
    syncedAt: Date.now(),
    revision: projectAutomationRevision(value)
  });
  return { synced: true, document: value, result: body };
}

export function projectAutomationSyncDirection(localDocument, runtimeDocument) {
  const local = normalizeAutomationDocument(localDocument);
  if (!runtimeDocument) {
    return projectAutomationRevision(local) > 0 ? "upload" : "none";
  }
  const runtime = normalizeAutomationDocument(runtimeDocument);
  const localRevision = projectAutomationRevision(local);
  const runtimeRevision = projectAutomationRevision(runtime);
  if (runtimeRevision > localRevision) return "restore";
  if (localRevision > runtimeRevision) return "upload";
  return "none";
}

export async function controlRuntimeProjectAutomation({
  action,
  projectKey,
  interactionProfileId,
  state = globalThis.window?.zion?.state,
  storage = localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = runtimeConfigForIdentity(state, storage);
  if (!config) return { handled: false, reason: "runtime-unavailable" };
  const operation = String(action || "").trim();
  if (!["run", "stop"].includes(operation)) {
    throw new Error(`Unsupported Project Automation control action: ${operation}`);
  }
  const key = String(projectKey || "").trim();
  if (!key) throw new Error("projectKey is required");
  const response = await fetchImpl(
    `${config.baseUrl}/v1/project-automation/projects/${encodeURIComponent(key)}/${operation}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(interactionProfileId
          ? { interaction_profile_id: String(interactionProfileId) }
          : {}),
        ...(operation === "stop" ? { reason: "user" } : {})
      })
    }
  );
  if (response.status === 404) return { handled: false, reason: "runtime-unsupported" };
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Runtime project automation ${operation} failed: ${response.status}`);
  }
  return { handled: true, result: body };
}
