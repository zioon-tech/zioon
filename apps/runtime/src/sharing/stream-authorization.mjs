import { CancellationController } from "../../../../packages/runtime/dist/index.js";

/** One in-flight check per stream, independent of token rate. Boundary checks
 * await fresh authority; periodic checks cancel even a silent upstream. */
export function createStreamAuthorization(validate, parentSignal, intervalMs = 500) {
  const cancellation = new CancellationController();
  const parent = parentSignal.onCancel(reason => cancellation.cancel(reason));
  if (parentSignal.cancelled) cancellation.cancel(parentSignal.reason);
  let pending, error, closed = false, checkedAt = -Infinity;
  const assert = () => {
    if (error) throw error;
    cancellation.signal.throwIfCancelled();
  };
  const check = (fresh = false) => {
    try { assert(); } catch (cause) { return Promise.reject(cause); }
    if (pending) return pending;
    if (!fresh && performance.now() - checkedAt < intervalMs) return Promise.resolve();
    pending = Promise.resolve().then(validate).then(() => {
      checkedAt = performance.now();
      assert();
    }).catch(cause => {
      error = cause;
      cancellation.cancel("shared-authorization-lost");
      throw cause;
    }).finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(() => {
    if (!closed) void check(true).catch(() => {});
  }, intervalMs);
  timer.unref();
  return {
    signal: cancellation.signal, check, assert,
    get error() { return error; },
    async close() {
      closed = true; clearInterval(timer); parent.dispose();
      await pending?.catch(() => {});
    }
  };
}
