import { cpus, freemem, loadavg, totalmem } from "node:os";
import { readFile, statfs } from "node:fs/promises";
import { requestPerformanceSnapshot } from "./request-performance.mjs";

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

async function healthClient(pool, timeoutMs) {
  let expired = false;
  let timer;
  const connection = pool.connect().then(client => {
    if (expired) client.release();
    return client;
  });
  try {
    return await Promise.race([
      connection,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(Object.assign(new Error("Database health pool timeout"), { code: "health_pool_timeout" }));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function collectDatabaseHealth({
  pool,
  spaceId,
  modelRequestDetailMaxRows,
  modelRequestDetailMaxStoredBytes,
  modelRequestDetailGlobalMaxRows,
  modelRequestDetailGlobalMaxBytes,
  now,
  timeoutMs
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
  const client = await healthClient(pool, timeoutMs);
  let result;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
    result = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM runtime_runs WHERE space_id = $1 AND updated_at >= $2) AS runs_1h,
      (SELECT COUNT(*)::int FROM runtime_runs WHERE space_id = $1 AND status = 'running') AS running_runs,
      (SELECT COUNT(*)::int FROM runtime_runs WHERE space_id = $1 AND status = 'failed' AND updated_at >= $3) AS failed_runs_2h,
      (SELECT COUNT(*)::int FROM runtime_run_events WHERE space_id = $1 AND created_at >= $2) AS events_1h,
      (SELECT stored_rows FROM runtime_model_detail_usage WHERE scope_key='space:' || $1) AS detail_rows,
      (SELECT stored_bytes FROM runtime_model_detail_usage WHERE scope_key='space:' || $1) AS detail_compressed_bytes,
      (SELECT stored_rows FROM runtime_model_detail_usage WHERE scope_key='global') AS detail_global_rows,
      (SELECT stored_bytes FROM runtime_model_detail_usage WHERE scope_key='global') AS detail_global_bytes
  `, [spaceId, oneHourAgo, twoHoursAgo]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
      maxCompressedBytes: numberValue(modelRequestDetailMaxStoredBytes),
      global: { rows: numberValue(row.detail_global_rows), compressedBytes: numberValue(row.detail_global_bytes),
        maxRows: numberValue(modelRequestDetailGlobalMaxRows), maxCompressedBytes: numberValue(modelRequestDetailGlobalMaxBytes) }
    }
  };
}

async function collectHostHealth() {
  const memory = { totalBytes: totalmem(), freeBytes: freemem() };
  memory.availableBytes = memory.freeBytes;
  try {
    const fields = Object.fromEntries((await readFile("/proc/meminfo", "utf8"))
      .split("\n").map(line => line.match(/^(\w+):\s+(\d+)\s+kB$/))
      .filter(Boolean).map(([, key, value]) => [key, Number(value) * 1024]));
    if (Number.isFinite(fields.MemAvailable)) memory.availableBytes = fields.MemAvailable;
    if (Number.isFinite(fields.SwapTotal) && Number.isFinite(fields.SwapFree)) {
      memory.swapTotalBytes = fields.SwapTotal;
      memory.swapUsedBytes = fields.SwapTotal - fields.SwapFree;
    }
  } catch { /* Non-Linux hosts use the portable OS counters. */ }
  let disk = null;
  try {
    const info = await statfs("/");
    disk = { totalBytes: info.blocks * info.bsize, availableBytes: info.bavail * info.bsize };
  } catch { /* Filesystem statistics may be unavailable on some hosts. */ }
  return { memory, disk };
}

export function createRuntimeHealthProvider({
  pool = null,
  spaceId = "",
  startedAt = Date.now(),
  modelRequestDetailMaxRows = 0,
  modelRequestDetailMaxStoredBytes = 0,
  nodeBroker = null,
  runStore = null,
  receiptStore = null,
  schedulerWorker = null,
  projectAutomationService = null,
  now = () => Date.now(),
  databaseTimeoutMs = 1500,
  databaseCacheMs = 5000
} = {}) {
  let databaseFlight = null;
  let databaseSample = null;
  let databaseSampleAt = 0;
  const sampleDatabase = async timestamp => {
    if (databaseSample && timestamp - databaseSampleAt < databaseCacheMs) {
      return { ...databaseSample, cached: true, sampledAt: databaseSampleAt };
    }
    if (!databaseFlight) {
      databaseFlight = collectDatabaseHealth({
        pool, spaceId, modelRequestDetailMaxRows, modelRequestDetailMaxStoredBytes,
        modelRequestDetailGlobalMaxRows: runStore?.modelRequestDetailGlobalMaxRows,
        modelRequestDetailGlobalMaxBytes: runStore?.modelRequestDetailGlobalMaxBytes,
        now: timestamp,
        timeoutMs: Math.max(100, Math.min(5000, numberValue(databaseTimeoutMs, 1500)))
      }).catch(error => ({
        status: "degraded", pool: poolSnapshot(pool),
        error: ["57014", "health_pool_timeout"].includes(error?.code)
          ? "database-health-timeout" : "database-health-query-failed"
      })).then(sample => {
        databaseSample = sample;
        databaseSampleAt = now();
        return { ...sample, cached: false, sampledAt: databaseSampleAt };
      }).finally(() => { databaseFlight = null; });
    }
    return databaseFlight;
  };
  return async function runtimeHealth() {
    const timestamp = now();
    const checks = [];
    const memory = process.memoryUsage();
    const host = await collectHostHealth();
    const systemMemory = host.memory;
    const freeRatio = systemMemory.totalBytes > 0
      ? ratioValue(systemMemory.availableBytes / systemMemory.totalBytes)
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
      addCheck(checks, "critical", "system-memory", "Host available memory is critically low", {
        freeRatio: round(freeRatio),
        ...systemMemory
      });
    } else if (freeRatio < 0.15) {
      addCheck(checks, "warning", "system-memory", "Host available memory is low", {
        freeRatio: round(freeRatio),
        ...systemMemory
      });
    } else {
      addCheck(checks, "ok", "system-memory", "Host memory has headroom", {
        freeRatio: round(freeRatio),
        ...systemMemory
      });
    }
    if (host.disk) {
      const diskRatio = host.disk.totalBytes > 0
        ? host.disk.availableBytes / host.disk.totalBytes : 1;
      const status = host.disk.availableBytes < 512 * 1024 * 1024 || diskRatio < 0.02
        ? "critical" : host.disk.availableBytes < 2 * 1024 ** 3 || diskRatio < 0.1
          ? "warning" : "ok";
      addCheck(checks, status, "system-disk", status === "ok"
        ? "Host disk has headroom" : "Host disk available space is low", {
        ...host.disk, availableRatio: round(diskRatio)
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
      database = await sampleDatabase(timestamp);
      if (database.status === "ok") {
        addCheck(checks, "ok", "database", "PostgreSQL responded to the runtime health query", {
          latencyMs: database.latencyMs,
          pool: database.pool
        });
      } else {
        addCheck(checks, "degraded", "database", database.error
          ? "PostgreSQL health query failed" : "PostgreSQL health query was skipped", {
          status: database.status,
          skipped: database.skipped,
          error: database.error,
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
      if (detailRatio > 1) {
        addCheck(checks, "warning", "model-request-details", "Model request detail storage exceeds its configured retention limit", metrics);
      } else {
        addCheck(checks, "ok", "model-request-details", detailRatio >= 0.9
          ? "Model request detail storage is within its configured retention limit"
          : "Model request detail storage has headroom", metrics);
      }
    }
    const globalDetails = database?.modelRequestDetails?.global;
    if (globalDetails?.maxRows || globalDetails?.maxCompressedBytes) {
      const utilization = Math.max(globalDetails.maxRows ? globalDetails.rows / globalDetails.maxRows : 0,
        globalDetails.maxCompressedBytes ? globalDetails.compressedBytes / globalDetails.maxCompressedBytes : 0);
      if (utilization >= 0.95) addCheck(checks, utilization > 1 ? "warning" : "degraded",
        "global-model-request-details", "Global diagnostic capacity is near its limit", globalDetails);
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
        memory: systemMemory,
        disk: host.disk
      },
      database,
      storageMaintenance: runStore?.maintenanceStats || null,
      receiptMaintenance: receiptStore?.maintenanceStats || null,
      recentWorkbenchRequests: requestPerformanceSnapshot(spaceId),
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
