import { afterEach, describe, expect, it, vi } from "vitest";
import { startStorageMaintenance } from "../src/storage-maintenance.mjs";

afterEach(() => {
  vi.useRealTimers();
});

describe("storage maintenance loop", () => {
  it("waits for a slow store after another fails before starting the next pass", async () => {
    vi.useFakeTimers();
    let finish;
    const slow = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const failed = vi.fn().mockRejectedValue(Object.assign(new Error("private payload"), {
      code: "57014", maintenancePhase: "event-archives"
    }));
    const logger = vi.fn();
    const maintenance = startStorageMaintenance({
      stores: [{ runStorageMaintenanceBatch: slow }, { maintenanceName: "runs", runStorageMaintenanceBatch: failed }],
      logger, intervalMs: 25
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith("warn",
      expect.stringContaining("store=runs phase=event-archives code=57014"));
    expect(JSON.stringify(logger.mock.calls)).not.toContain("private payload");
    finish({ complete: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(slow).toHaveBeenCalledTimes(2);
    finish({ complete: true });
    await maintenance.stop();
  });
  it("resumes bounded sweeps after an idle pass as retention deadlines advance", async () => {
    vi.useFakeTimers();
    const runBatch = vi.fn().mockResolvedValue({ complete: true });
    const maintenance = startStorageMaintenance({
      stores: [{ runStorageMaintenanceBatch: runBatch }], sweepIntervalMs: 1000
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(runBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runBatch).toHaveBeenCalledTimes(2);
    await maintenance.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runBatch).toHaveBeenCalledTimes(2);
  });
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
