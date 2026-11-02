import { afterEach, describe, expect, it, vi } from "vitest";
import { startStorageMaintenance } from "../src/storage-maintenance.mjs";

afterEach(() => {
  vi.useRealTimers();
});

describe("storage maintenance loop", () => {
  it("continues incomplete batches and stops after all stores complete", async () => {
    vi.useFakeTimers();
    const runBatch = vi.fn()
      .mockReturnValueOnce({
        complete: false,
        transientEvents: { deletedRows: 2 }
      })
      .mockReturnValueOnce({
        complete: true,
        transientEvents: { deletedRows: 1 }
      });
    const logger = vi.fn();
    const maintenance = startStorageMaintenance({
      stores: [{ runStorageMaintenanceBatch: runBatch }],
      batchRows: 10,
      intervalMs: 25,
      logger
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(runBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(runBatch).toHaveBeenCalledTimes(2);
    expect(runBatch).toHaveBeenLastCalledWith({ maxRows: 10 });
    expect(logger).toHaveBeenCalledWith(
      "info",
      "storage maintenance is complete (3 rows processed)"
    );

    await maintenance.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(runBatch).toHaveBeenCalledTimes(2);
  });
});
