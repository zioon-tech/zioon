const DELTA_TYPES = new Set(["message.delta", "reasoning.delta"]);

function bounded(value, fallback, minimum, maximum) {
  return Math.max(
    minimum,
    Math.min(maximum, Math.floor(Number(value) || fallback))
  );
}

function eventBytes(event) {
  try {
    return Buffer.byteLength(JSON.stringify(event));
  } catch {
    return 0;
  }
}

function groupFor(event) {
  return [
    event.type,
    Number(event.data?.turn ?? event.data?.stepIndex ?? 0) || 0,
    String(event.data?.reasoningSegmentId || "")
  ].join(":");
}

function liveChunk(pending) {
  const { first, last, delta, count } = pending;
  const firstProjection = first.data?.projection;
  const lastProjection = last.data?.projection;
  return {
    ...last,
    eventId: `live:${last.runId}:${first.sequence}-${last.sequence}`,
    data: {
      ...(last.data || {}),
      delta,
      projection: {
        sourceSequenceStart:
          Number(firstProjection?.sourceSequenceStart) || first.sequence,
        sourceSequenceEnd:
          Number(lastProjection?.sourceSequenceEnd) || last.sequence,
        sourceEventCount: count,
        characterCount: delta.length,
        transient: true
      }
    }
  };
}

function compactReplay(events) {
  const compact = [];
  let pending = null;
  const flush = () => {
    if (!pending) return;
    compact.push(liveChunk(pending));
    pending = null;
  };
  for (const event of events) {
    if (!DELTA_TYPES.has(event.type)) {
      flush();
      compact.push(event);
      continue;
    }
    const group = groupFor(event);
    if (pending && pending.group !== group) flush();
    if (!pending) {
      pending = {
        first: event,
        last: event,
        group,
        delta: "",
        count: 0
      };
    }
    pending.last = event;
    pending.delta += String(event.data?.delta || "");
    pending.count += Math.max(
      1,
      Number(event.data?.projection?.sourceEventCount) || 1
    );
  }
  flush();
  return compact;
}

function createSubscription(initial, onClose, maxQueuedEvents, signal) {
  const values = [...initial];
  const waiters = [];
  let closed = false;
  const stop = () => subscription.close();
  const subscription = {
    push(event) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: event, done: false });
        return;
      }
      values.push(event);
      if (values.length > maxQueuedEvents) {
        values.splice(0, values.length - maxQueuedEvents);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      signal?.removeEventListener?.("abort", stop);
      onClose();
      for (const resolve of waiters.splice(0)) {
        resolve({ value: undefined, done: true });
      }
    }
  };
  signal?.addEventListener?.("abort", stop, { once: true });
  if (signal?.aborted) subscription.close();
  return {
    push: subscription.push,
    close: subscription.close,
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (values.length) {
              return Promise.resolve({
                value: values.shift(),
                done: false
              });
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
          return() {
            subscription.close();
            return Promise.resolve({ value: undefined, done: true });
          }
        };
      }
    }
  };
}

export function createRunLiveHub({
  maxDelayMs = 50,
  maxChunkChars = 256,
  maxReplayBytes = 8 * 1024 * 1024,
  maxQueuedEvents = 2048
} = {}) {
  const delay = bounded(maxDelayMs, 50, 10, 1000);
  const chunkChars = bounded(maxChunkChars, 256, 32, 16_384);
  const replayLimit = bounded(
    maxReplayBytes,
    8 * 1024 * 1024,
    64 * 1024,
    64 * 1024 * 1024
  );
  const queueLimit = bounded(maxQueuedEvents, 2048, 16, 16_384);
  const replay = [];
  const subscribers = new Set();
  let replayBytes = 0;
  let pending = null;
  let timer = null;
  let closed = false;

  const emit = (event) => {
    if (!event) return;
    const bytes = eventBytes(event);
    replay.push({ event, bytes });
    replayBytes += bytes;
    while (replay.length > 1 && replayBytes > replayLimit) {
      replayBytes -= replay.shift().bytes;
    }
    for (const subscription of subscribers) subscription.push(event);
  };

  const flush = () => {
    globalThis.clearTimeout(timer);
    timer = null;
    if (!pending) return null;
    const event = liveChunk(pending);
    pending = null;
    emit(event);
    return event;
  };

  const schedule = () => {
    if (timer || closed) return;
    timer = globalThis.setTimeout(flush, delay);
    timer.unref?.();
  };

  return {
    publish(event) {
      if (closed || !event) return;
      if (!DELTA_TYPES.has(event.type)) {
        flush();
        emit(event);
        return;
      }
      const delta = String(event.data?.delta || "");
      if (!delta) return;
      const group = groupFor(event);
      if (pending && pending.group !== group) flush();
      if (!pending) {
        pending = {
          first: event,
          last: event,
          group,
          delta: "",
          count: 0
        };
      }
      pending.last = event;
      pending.delta += delta;
      pending.count++;
      if (pending.delta.length >= chunkChars) flush();
      else schedule();
    },
    subscribe(afterSequence = 0, { signal } = {}) {
      const after = Math.max(0, Number(afterSequence) || 0);
      const initial = compactReplay(replay
        .map((entry) => entry.event)
        .filter((event) => Number(event.sequence) > after));
      let subscription;
      subscription = createSubscription(
        initial,
        () => subscribers.delete(subscription),
        queueLimit,
        signal
      );
      if (!closed) subscribers.add(subscription);
      else subscription.close();
      return subscription.iterable;
    },
    eventsAfter(afterSequence = 0) {
      const after = Math.max(0, Number(afterSequence) || 0);
      return replay
        .map((entry) => entry.event)
        .filter((event) => Number(event.sequence) > after);
    },
    close() {
      if (closed) return;
      flush();
      closed = true;
      for (const subscription of subscribers) subscription.close();
      subscribers.clear();
    },
    get status() {
      return {
        closed,
        replayEvents: replay.length,
        replayBytes,
        firstSequence: Number(replay[0]?.event?.sequence || 0),
        lastSequence: Number(replay.at(-1)?.event?.sequence || 0)
      };
    }
  };
}
