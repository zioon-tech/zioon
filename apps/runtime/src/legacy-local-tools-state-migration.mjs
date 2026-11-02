import { createHash } from "node:crypto";
import { clearTimeout, setTimeout } from "node:timers";

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function summarizeWorkbenchMigration(migration) {
  if (!migration || typeof migration !== "object") return migration;
  const summary = { ...migration };
  delete summary.imported;
  delete summary.archived;
  delete summary.snapshot;
  return {
    ...summary,
    importedCount: Array.isArray(migration.imported) ? migration.imported.length : 0,
    archivedCount: Array.isArray(migration.archived) ? migration.archived.length : 0
  };
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`Legacy local-tools HTTP ${response.status}: ${url}`);
      error.statusCode = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function readLegacyScheduler(fetchImpl, baseUrl, timeoutMs) {
  const tasksPayload = await fetchJson(
    fetchImpl,
    `${baseUrl}/scheduler/tasks`,
    timeoutMs
  );
  const runs = [];
  let offset = 0;
  for (;;) {
    const payload = await fetchJson(
      fetchImpl,
      `${baseUrl}/scheduler/runs?limit=200&offset=${offset}&include_details=true`,
      timeoutMs
    );
    const page = Array.isArray(payload?.runs) ? payload.runs : [];
    runs.push(...page);
    if (!payload?.hasMore || page.length === 0) break;
    offset = Number(payload.nextOffset);
    if (!Number.isFinite(offset)) break;
  }
  return {
    tasks: Array.isArray(tasksPayload?.tasks) ? tasksPayload.tasks : [],
    runs
  };
}

export async function migrateLegacyLocalToolsState({
  baseUrl = "http://127.0.0.1:8765",
  workbenchState,
  scheduler,
  fetchImpl = globalThis.fetch,
  probeTimeoutMs = 2_000,
  transferTimeoutMs = 120_000,
  logger = () => {}
} = {}) {
  if (!fetchImpl) return { available: false, reason: "fetch-unavailable" };
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  const result = {
    available: true,
    source: normalizedBaseUrl,
    workbenchState: null,
    scheduler: null
  };

  if (workbenchState) {
    try {
      const source = `zion-local-tools:app-sessions:${normalizedBaseUrl}`;
      if (await workbenchState.hasMigrationSource?.(source)) {
        result.workbenchState = { ok: true, duplicate: true };
      } else {
        const status = await fetchJson(
          fetchImpl,
          `${normalizedBaseUrl}/app-sessions/status`,
          probeTimeoutMs
        );
        if (status?.revision) {
          const sourceFingerprint = String(status.revision);
          const payload = await fetchJson(
            fetchImpl,
            `${normalizedBaseUrl}/app-sessions/snapshot`,
            transferTimeoutMs
          );
          const migration = await workbenchState.migrateBrowserStorage(
            source,
            payload?.snapshot || payload,
            sourceFingerprint
          );
          result.workbenchState = summarizeWorkbenchMigration(migration);
        }
      }
    } catch (error) {
      result.available = Number.isFinite(error?.statusCode);
      result.workbenchState = { ok: false, error: error.message };
      logger("debug", `Legacy Workbench state migration skipped: ${error.message}`);
    }
  }

  if (scheduler) {
    try {
      if (await scheduler.hasLegacyMigration?.()) {
        result.scheduler = { ok: true, duplicate: true };
      } else if (!result.available) {
        result.scheduler = {
          ok: false,
          error: "Legacy local-tools is unavailable"
        };
      } else {
        const payload = await readLegacyScheduler(
          fetchImpl,
          normalizedBaseUrl,
          transferTimeoutMs
        );
        const sourceFingerprint = fingerprint({
          tasks: payload.tasks,
          runs: payload.runs.map((run) => ({
            id: run.id,
            status: run.status,
            completedAt: run.completedAt
          }))
        });
        result.scheduler = await scheduler.importLegacySnapshot(
          payload,
          sourceFingerprint
        );
      }
    } catch (error) {
      result.available = result.available || Number.isFinite(error?.statusCode);
      result.scheduler = { ok: false, error: error.message };
      logger("debug", `Legacy Scheduler migration skipped: ${error.message}`);
    }
  }

  result.ok = (
    (!result.workbenchState || result.workbenchState.ok !== false)
    && (!result.scheduler || result.scheduler.ok !== false)
  );
  return result;
}
