import { cpus, freemem, loadavg, totalmem } from "node:os";

function numberValue(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function ratioValue(value) {
  return Math.max(0, Math.min(1, numberValue(value)));
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(numberValue(value) * factor) / factor;
}

function poolSnapshot(pool) {
  if (!pool) return null;
  return {
    total: numberValue(pool.totalCount),
    idle: numberValue(pool.idleCount),
    waiting: numberValue(pool.waitingCount),
    max: numberValue(pool.options?.max || pool.options?.maxUses)
  };
}

function addCheck(checks, status, id, message, metrics = {}) {
  checks.push({ id, status, message, metrics });
}

function overallStatus(checks) {
  if (checks.some((check) => check.status === "critical")) return "critical";
  if (checks.some((check) => check.status === "degraded" || check.status === "warning")) {
    return "degraded";
  }
  return "ok";
}

async function collectDatabaseHealth({
  pool,
  spaceId,
  modelRequestDetailMaxRows,
  modelRequestDetailMaxStoredBytes,
  now
}) {
  const poolStats = poolSnapshot(pool);
  if (!pool || !spaceId) {
    return {
      status: "unavailable",
      pool: poolStats,
      skipped: "database-not-configured"
    };
  }
  if (
    poolStats
    && poolStats.idle === 0
    && (
      poolStats.waiting > 0
      || (poolStats.max > 0 && poolStats.total >= poolStats.max)
    )
  ) {
    return {
      status: "degraded",
      pool: poolStats,
      skipped: "pool-saturated"
    };
  }

  const oneHourAgo = now - 60 * 60_000;
  const twoHoursAgo = now - 2 * 60 * 60_000;
  const startedAt = Date.now();
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM runtime_runs WHERE space_id = $1 AND updated_at >= $2) AS runs_1h,
      (SELECT COUNT(*)::int FROM runtime_runs WHERE space_id = $1 AND status = 'running') AS running_runs,
      (SELECT COUNT(*)::int FROM runtime_runs WHERE space_id = $1 AND status = 'failed' AND updated_at >= $3) AS failed_runs_2h,
      (SELECT COUNT(*)::int FROM runtime_run_events WHERE space_id = $1 AND created_at >= $2) AS events_1h,
      (SELECT COUNT(*)::int FROM runtime_run_event_details WHERE space_id = $1) AS detail_rows,
      (SELECT COALESCE(SUM(compressed_bytes), 0)::bigint FROM runtime_run_event_details WHERE space_id = $1) AS detail_compressed_bytes
  `, [spaceId, oneHourAgo, twoHoursAgo]);
  const row = result.rows[0] || {};
  return {
    status: "ok",
    latencyMs: Date.now() - startedAt,
    pool: poolSnapshot(pool),
    runs: {
      lastHour: numberValue(row.runs_1h),
      running: numberValue(row.running_runs),
      failedLastTwoHours: numberValue(row.failed_runs_2h),
      eventsLastHour: numberValue(row.events_1h)
    },
    modelRequestDetails: {
      rows: numberValue(row.detail_rows),
      maxRows: numberValue(modelRequestDetailMaxRows),
      compressedBytes: numberValue(row.detail_compressed_bytes),
      maxCompressedBytes: numberValue(modelRequestDetailMaxStoredBytes)
    }
  };
}

export function createRuntimeHealthProvider({
  pool = null,
  spaceId = "",
  startedAt = Date.now(),
  modelRequestDetailMaxRows = 0,
  modelRequestDetailMaxStoredBytes = 0,
  nodeBroker = null,
  schedulerWorker = null,
  projectAutomationService = null,
  now = () => Date.now()
} = {}) {
  return async function runtimeHealth() {
    const timestamp = now();
    const checks = [];
    const memory = process.memoryUsage();
    const systemMemory = {
      totalBytes: totalmem(),
      freeBytes: freemem()
    };
    const freeRatio = systemMemory.totalBytes > 0
      ? ratioValue(systemMemory.freeBytes / systemMemory.totalBytes)
      : 0;
    const cpuCount = Math.max(1, cpus().length);
    const load = loadavg();
    const loadRatio = load.length ? load[0] / cpuCount : 0;

    addCheck(checks, "ok", "process", "Runtime process is responding", {
      uptimeSeconds: round(process.uptime(), 1),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal
    });
    if (freeRatio < 0.05) {
      addCheck(checks, "critical", "system-memory", "Host free memory is critically low", {
        freeRatio: round(freeRatio),
        ...systemMemory
      });
    } else if (freeRatio < 0.15) {
      addCheck(checks, "warning", "system-memory", "Host free memory is low", {
        freeRatio: round(freeRatio),
        ...systemMemory
      });
    } else {
      addCheck(checks, "ok", "system-memory", "Host memory has headroom", {
        freeRatio: round(freeRatio),
        ...systemMemory
      });
    }
    if (loadRatio > 2) {
      addCheck(checks, "critical", "load", "Host load is high for available CPUs", {
        load1: round(load[0] || 0),
        cpuCount,
        loadRatio: round(loadRatio)
      });
    } else if (loadRatio > 1) {
      addCheck(checks, "warning", "load", "Host load is elevated", {
        load1: round(load[0] || 0),
        cpuCount,
        loadRatio: round(loadRatio)
      });
    } else {
      addCheck(checks, "ok", "load", "Host load is within expected range", {
        load1: round(load[0] || 0),
        cpuCount,
        loadRatio: round(loadRatio)
      });
    }

    let database;
    try {
      database = await collectDatabaseHealth({
        pool,
        spaceId,
        modelRequestDetailMaxRows,
        modelRequestDetailMaxStoredBytes,
        now: timestamp
      });
      if (database.status === "ok") {
        addCheck(checks, "ok", "database", "PostgreSQL responded to the runtime health query", {
          latencyMs: database.latencyMs,
          pool: database.pool
        });
      } else {
        addCheck(checks, "degraded", "database", "PostgreSQL health query was skipped", {
          status: database.status,
          skipped: database.skipped,
          pool: database.pool
        });
      }
    } catch (error) {
      database = {
        status: "degraded",
        pool: poolSnapshot(pool),
        error: error?.message || String(error)
      };
      addCheck(checks, "degraded", "database", "PostgreSQL health query failed", {
        error: database.error,
        pool: database.pool
      });
    }

    const detail = database?.modelRequestDetails;
    if (detail?.maxRows || detail?.maxCompressedBytes) {
      const rowRatio = detail.maxRows ? detail.rows / detail.maxRows : 0;
      const byteRatio = detail.maxCompressedBytes
        ? detail.compressedBytes / detail.maxCompressedBytes
        : 0;
      const detailRatio = Math.max(rowRatio, byteRatio);
      const metrics = {
        rows: detail.rows,
        maxRows: detail.maxRows,
        compressedBytes: detail.compressedBytes,
        maxCompressedBytes: detail.maxCompressedBytes,
        utilization: round(detailRatio)
      };
      if (detailRatio >= 0.98) {
        addCheck(checks, "warning", "model-request-details", "Model request detail storage is at its configured cap", metrics);
      } else if (detailRatio >= 0.9) {
        addCheck(checks, "warning", "model-request-details", "Model request detail storage is close to its configured cap", metrics);
      } else {
        addCheck(checks, "ok", "model-request-details", "Model request detail storage has headroom", metrics);
      }
    }

    const nodes = nodeBroker?.snapshot?.().nodes || [];
    if (Array.isArray(nodes) && nodes.length) {
      addCheck(checks, nodes.some((node) => node.status === "online") ? "ok" : "warning", "device-nodes", "Device node availability", {
        total: nodes.length,
        online: nodes.filter((node) => node.status === "online").length,
        offline: nodes.filter((node) => node.status !== "online").length
      });
    }

    return {
      status: overallStatus(checks),
      generatedAt: timestamp,
      startedAt,
      uptimeSeconds: round((timestamp - startedAt) / 1000, 1),
      process: {
        pid: process.pid,
        nodeVersion: process.version,
        memory
      },
      system: {
        cpuCount,
        loadAverage: load,
        memory: systemMemory
      },
      database,
      scheduler: {
        enabled: !!schedulerWorker
      },
      projectAutomation: {
        enabled: !!projectAutomationService,
        running: projectAutomationService?.running === true
      },
      checks
    };
  };
}
