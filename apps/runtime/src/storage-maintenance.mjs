export function startStorageMaintenance({
  stores = [],
  batchRows = 1_000,
  intervalMs = 250,
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
    inFlight = Promise.all(maintainable.map(async (store) => (
      store.runStorageMaintenanceBatch({ maxRows: batchRows })
    ))).then((results) => {
      const complete = results.every((result) => result?.complete !== false);
      const deletedRows = results.reduce((total, result) => (
        total
        + Number(result?.transientEvents?.deletedRows || 0)
        + Number(result?.modelRequests?.rewrittenRows || 0)
        + Number(result?.checkpoints?.deletedRows || 0)
        + Number(result?.revisions?.deletedRows || 0)
        + Number(result?.annotations?.rewrittenRows || 0)
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
      if (!complete) schedule(intervalMs);
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
