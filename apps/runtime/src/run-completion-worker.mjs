import { randomUUID } from "node:crypto";

// Completion steps are at-least-once; processors receive a stable idempotency key.
// A slow processor never holds execution admission or another worker's lease.
export function createRunCompletionWorker({ store, steps, onError = () => {}, intervalMs = 1_000 }) {
  let stopped = true;
  let timer;
  let polling = null;
  const active = new Set();
  const report = (error, meta) => { try { onError(error, meta); } catch {} };
  const execute = async task => {
    const heartbeat = setInterval(() => {
      void store.updateCompletionTask(task).catch(error => report(error, { processorId: "runtime.completion-lease" }));
    }, 30_000);
    heartbeat.unref?.();
    let failed = false;
    try {
      for (const step of await steps(task.run)) {
        if (task.completedSteps.includes(step.id)) continue;
        try {
          await store.updateCompletionTask(task);
          await step.run(`${task.run.id}:${task.run.attemptId}:${step.id}`);
          await store.updateCompletionTask(task, { step: step.id });
        } catch (error) {
          failed = true;
          report(error, { processorId: step.id, runId: task.run.id, sessionId: task.run.sessionId });
        }
      }
      await store.updateCompletionTask(task, failed
        ? { retryMs: Math.min(60_000, 1_000 * 2 ** Math.min(task.attempts, 6)) }
        : { complete: true });
    } catch (error) {
      report(error, { processorId: "runtime.completion", runId: task.run.id });
    } finally {
      clearInterval(heartbeat);
    }
  };
  const kick = () => {
    if (stopped || polling) return polling;
    polling = (async () => {
      while (!stopped && active.size < 4) {
        const task = await store.claimCompletionTask(randomUUID());
        if (!task) break;
        const work = execute(task);
        active.add(work);
        void work.finally(() => { active.delete(work); });
      }
    })().catch(error => report(error, { processorId: "runtime.completion-poll" }))
      .finally(() => { polling = null; });
    return polling;
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setInterval(kick, intervalMs);
      timer.unref?.();
      void kick();
    },
    kick,
    isIdle: () => active.size === 0 && !polling,
    async close() {
      stopped = true;
      clearInterval(timer);
      await polling;
      await Promise.allSettled([...active]);
    }
  };
}
