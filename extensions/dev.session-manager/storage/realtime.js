function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || Object.assign(new Error("Aborted"), {
        name: "AbortError"
      }));
    }, { once: true });
  });
}

function isAbort(error, signal) {
  return signal?.aborted
    || error?.name === "AbortError"
    || error?.code === "ABORT_ERR";
}

export function createSessionRealtimeSync({
  subscribe,
  initialCursor = 0,
  clientId = "",
  onEvent = async () => {},
  onReset = async () => 0,
  onStatus = () => {},
  retryDelayMs = 1_000
} = {}) {
  if (typeof subscribe !== "function") {
    throw new Error("Session realtime sync requires a subscribe function");
  }
  let cursor = Math.max(0, Number(initialCursor) || 0);
  let disposed = false;
  let controller = null;
  let running = null;

  const run = async () => {
    while (!disposed) {
      controller = new AbortController();
      try {
        onStatus({ connected: false, connecting: true, cursor });
        for await (const event of subscribe({
          afterSequence: cursor,
          signal: controller.signal
        })) {
          if (disposed) break;
          if (event?.type === "reset") {
            cursor = Math.max(
              cursor,
              Number(await onReset(event)) || 0
            );
            break;
          }
          const sequence = Math.max(0, Number(event?.sequence) || 0);
          if (!sequence || sequence <= cursor) continue;
          await onEvent(event, {
            ownEvent: !!clientId && event.sourceClientId === clientId
          });
          cursor = sequence;
          onStatus({ connected: true, connecting: false, cursor });
        }
      } catch (error) {
        if (disposed || isAbort(error, controller.signal)) break;
        onStatus({
          connected: false,
          connecting: false,
          cursor,
          error: error?.message || String(error)
        });
      }
      if (!disposed) {
        try {
          await sleep(Math.max(100, Number(retryDelayMs) || 1_000), controller.signal);
        } catch {
          break;
        }
      }
    }
  };

  return {
    start() {
      if (!running) running = run();
      return running;
    },
    get cursor() {
      return cursor;
    },
    setCursor(value) {
      cursor = Math.max(cursor, Number(value) || 0);
    },
    dispose() {
      disposed = true;
      controller?.abort(Object.assign(new Error("Disposed"), {
        name: "AbortError"
      }));
    }
  };
}
