export function startStorageMaintenance({
  stores = [],
  batchRows = 1_000,
  intervalMs = 250,
  sweepIntervalMs = 60_000,
  logger = () => {}
} = {}) {
  const maintainable = stores.filter((store) =>
    typeof store?.runStorageMaintenanceBatch === "function"
  );
  let timer = null;
  let stopped = false;
  let inFlight = null;
  let reportedComplete = false;
  let processedRows = 0;
  let lastProgressAt = Date.now();

  const schedule = (delay) => {
    if (stopped || timer) return;
    timer = globalThis.setTimeout(run, Math.max(0, Number(delay) || 0));
    timer.unref?.();
  };

  const run = () => {
    timer = null;
    if (stopped || inFlight) return;
    // Wait for every store, including when one fails. Starting the next tick
    // while another transaction is still running can overlap maintenance.
    inFlight = Promise.all(maintainable.map(async (store) => {
      const startedAt = Date.now();
      try {
        return await store.runStorageMaintenanceBatch({ maxRows: batchRows });
      } catch (error) {
        logger("warn", `storage maintenance batch failed: store=${store.maintenanceName || store.constructor?.name || "unknown"} phase=${error.maintenancePhase || "unknown"} code=${error.code || "unknown"} elapsedMs=${Date.now() - startedAt}`);
        return { complete: false, failed: true };
      }
    })).then((results) => {
      const complete = results.every((result) => result?.complete !== false);
      const deletedRows = results.reduce((total, result) => (
        total
        + Number(result?.transientEvents?.deletedRows || 0)
        + Number(result?.transientEvents?.rewrittenRows || 0)
        + Number(result?.modelRequests?.rewrittenRows || 0)
        + Number(result?.modelRequests?.deletedDetails || 0)
        + Number(result?.checkpoints?.deletedRows || 0)
        + Number(result?.revisions?.deletedRows || 0)
        + Number(result?.annotations?.rewrittenRows || 0)
        + Number(result?.inputs?.rewrittenRows || 0)
        + Number(result?.receipts?.rewrittenRows || 0)
        + Number(result?.receipts?.skippedRows || 0)
      ), 0);
      processedRows += deletedRows;
      if (processedRows > 0 && Date.now() - lastProgressAt >= 30_000) {
        logger("info", `storage maintenance processed ${processedRows} rows`);
        lastProgressAt = Date.now();
      }
      if (complete && !reportedComplete) {
        reportedComplete = true;
        logger("info", `storage maintenance is complete (${processedRows} rows processed)`);
      }
      if (!complete) reportedComplete = false;
      // Retention deadlines continue to advance after startup. An empty pass
      // means idle until the next bounded sweep, not disabled until restart.
      schedule(complete ? Math.max(1000, sweepIntervalMs)
        : results.some(result => result?.failed) ? Math.max(1000, intervalMs) : intervalMs);
    }).catch((error) => {
      logger("warn", `storage maintenance batch failed: ${error.message}`);
      schedule(Math.max(1_000, intervalMs));
    }).finally(() => {
      inFlight = null;
    });
  };

  if (maintainable.length > 0) schedule(0);

  return {
    async stop() {
      stopped = true;
      if (timer) globalThis.clearTimeout(timer);
      timer = null;
      await inFlight;
    }
  };
}
