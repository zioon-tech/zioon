/** Merge event bursts without postponing explicit, synchronous UI actions. */
export function createCoalescedRefresh(render) {
  let pending = null;
  let frame = 0;
  let fallback = null;
  let disposed = false;
  const merge = (first, next) => first ? {
    ...first, ...next,
    listOnly: first.listOnly === true && next.listOnly === true,
    preserveListScroll: first.preserveListScroll !== false && next.preserveListScroll !== false
  } : { ...next };
  const cancel = () => {
    if (frame) cancelAnimationFrame(frame);
    if (fallback != null) clearTimeout(fallback);
    frame = 0;
    fallback = null;
    pending = null;
  };
  const take = (options = {}) => {
    const merged = merge(pending, options);
    cancel();
    return merged;
  };
  const flush = (override) => {
    if (disposed || !pending && !override) return;
    const options = override ? merge(pending, override) : pending;
    cancel();
    render(options);
  };
  return {
    schedule(options = {}) {
      if (disposed) return;
      pending = merge(pending, options);
      if (frame) return;
      frame = requestAnimationFrame(() => flush());
      fallback = setTimeout(() => flush(), 100);
    },
    flush,
    take,
    dispose() { disposed = true; cancel(); }
  };
}
