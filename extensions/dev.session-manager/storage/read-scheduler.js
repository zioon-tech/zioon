/** Limit speculative reads without putting a slow document in front of the
 * other visible panes. In-flight requests for the same projection are shared. */
export function createSessionReadScheduler({ concurrency = 3 } = {}) {
  const pending = new Map();
  const queue = [];
  let active = 0;
  let order = 0;
  const pump = () => {
    queue.sort((a, b) => a.priority - b.priority || a.order - b.order);
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active++;
      Promise.resolve().then(job.action).then(job.resolve, job.reject).finally(() => {
        pending.delete(job.key);
        active--;
        pump();
      });
    }
  };
  return {
    read(key, action, priority = 0) {
      const existing = pending.get(key);
      if (existing) {
        existing.priority = Math.min(existing.priority, priority);
        return existing.promise;
      }
      let resolve, reject;
      const promise = new Promise((a, b) => { resolve = a; reject = b; });
      const job = { key, action, priority, order: order++, promise, resolve, reject };
      pending.set(key, job);
      queue.push(job);
      pump();
      return promise;
    },
    stats: () => ({ active, queued: queue.length, pending: pending.size })
  };
}
