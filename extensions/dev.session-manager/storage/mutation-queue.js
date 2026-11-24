import { classifySessionStorageError } from "./errors.js";

export function createSessionMutationQueue({
  execute, onCommit = () => {}, onFailure = () => {}, onState = () => {},
  operationId, prepare = value => value, retryMs = 1500, deleteDeadlineMs = 12000
}) {
  const pending = [];
  const conflicts = [];
  let active = null;
  let scheduled = false;
  let retryTimer = null;
  let disposed = false;
  let generation = 0;
  let executing = null;
  const timings = [];
  const isDelete = mutation => ["delete", "folder-delete"].includes(mutation.type);
  const publish = (status, error = null) => onState({
    status, pending: pending.length, conflicts: conflicts.length, error,
    active: executing ? { type: executing.type, id: executing.id, operationId: executing.operationId } : null,
    timings: timings.slice()
  });
  const trace = (mutation, stage) => {
    timings.push({ operationId: mutation.operationId, type: mutation.type, stage,
      elapsedMs: Date.now() - mutation.queuedAt, attempts: mutation.attempts || 0 });
    if (timings.length > 64) timings.shift();
  };
  const settle = (mutation, error, result) => {
    if (mutation.deadlineTimer) clearTimeout(mutation.deadlineTimer);
    for (const waiter of mutation.waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve(result);
    }
    mutation.waiters = [];
  };
  const permanent = error => !classifySessionStorageError(error).retryable;
  const removePending = mutation => {
    const index = pending.indexOf(mutation);
    if (index >= 0) pending.splice(index, 1);
  };
  const pauseDeletion = mutation => {
    const error = Object.assign(new Error(mutation.attempted
      ? "删除结果尚未确认，请重试核对结果。" : "删除尚未发送，请重试。"), {
      code: mutation.attempted ? "DELETE_OUTCOME_UNKNOWN" : "DELETE_NOT_SENT"
    });
    if (executing === mutation) {
      mutation.controller?.abort();
      mutation.rejectAttempt?.(error);
    } else {
      removePending(mutation);
      conflicts.push({ ...mutation, error });
      generation += 1;
      trace(mutation, "paused");
      settle(mutation, error);
      onFailure(mutation, error, { retrying: false });
      publish("conflict", error);
    }
  };
  const prioritizeDeletion = () => {
    const index = pending.findIndex((item, position) => {
      if (item.type !== "delete" && item.type !== "folder-delete") return false;
      const folderIds = new Set();
      if (item.type === "folder-delete") {
        const walk = (node, inside = false) => {
          if (!node) return;
          inside ||= node.id === item.id;
          if (inside) folderIds.add(node.id);
          for (const child of node.children || []) walk(child, inside);
        };
        walk(item.baseTree);
      }
      return pending.slice(0, position).every(previous =>
        // Shared tree edits and other deletes keep their causal order.
        (previous.type === "session" || previous.type === "kv")
        && previous.id !== item.id && !folderIds.has(previous.id)
      );
    });
    if (index > 0) pending.unshift(...pending.splice(index, 1));
  };

  function enqueue(input) {
    if (disposed) return Promise.reject(new Error("Session persistence stopped"));
    generation += 1;
    // A corrected tree still contains the user's earlier edits, so reuse its
    // original base rather than replaying the rejected snapshot first.
    const failedTree = input.type === "tree"
      ? conflicts.find(item => item.type === "tree") : null;
    if (failedTree) {
      input = { ...input, baseTree: failedTree.baseTree };
      conflicts.splice(conflicts.indexOf(failedTree), 1);
    }
    if (input.type === "delete" || input.type === "folder-delete") {
      const paused = conflicts.find(item => item.type === input.type && item.id === input.id
        && ["DELETE_OUTCOME_UNKNOWN", "DELETE_NOT_SENT"].includes(item.error?.code)
        && (input.type === "delete" || JSON.stringify(item.baseTree) === JSON.stringify(input.baseTree)));
      // Retry the same operation, including when the earlier response was lost.
      if (paused) input = { ...input, operationId: paused.operationId };
      for (const failed of conflicts.filter(item => item.id === input.id)) {
        conflicts.splice(conflicts.indexOf(failed), 1);
      }
    }
    // Whole-index snapshots may supersede an unattempted snapshot across
    // document saves. Keep tree/deletion barriers and in-flight receipts intact.
    let candidates = pending.slice(-1);
    if (input.type === "kv" && input.coalesceLatest === true) {
      candidates = [];
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const candidate = pending[index];
        if (!["session", "kv"].includes(candidate.type)) break;
        candidates.push(candidate);
      }
    }
    let mutation = candidates.find(candidate =>
      !candidate.attempted && candidate.type === input.type && candidate.id === input.id
      // Each metadata delta has its own comparison base.
      && !(input.type === "session"
        && (input.payload?.meta_changes || candidate.payload?.meta_changes)
        && !(candidate.expectedSessionRevision == null && candidate.payload?.text != null
          && !candidate.payload?.meta_changes && input.payload?.meta_changes?.every(change => !change.beforePresent)))
    );
    if (mutation) {
      if (input.type === "session") mutation.payload = { ...mutation.payload, ...input.payload };
      else if (input.type === "tree") Object.assign(mutation, { tree: input.tree, index: input.index });
      else if (input.type === "kv") {
        mutation.value = input.value;
        // Explicit user edits retain their failure notification when folded
        // into a later automatic snapshot.
        mutation.background = mutation.background === true && input.background === true;
        if (input.coalesceLatest === true) {
          removePending(mutation);
          pending.push(mutation);
        }
      }
    } else {
      mutation = { ...prepare(input), operationId: input.operationId || operationId(input),
        waiters: [], attempted: false, attempts: 0, queuedAt: Date.now() };
      pending.push(mutation);
      trace(mutation, "queued");
      if (isDelete(mutation)) mutation.deadlineTimer = setTimeout(() => pauseDeletion(mutation), deleteDeadlineMs);
    }
    const promise = new Promise((resolve, reject) => mutation.waiters.push({ resolve, reject }));
    publish("pending");
    if (!active && !scheduled) {
      scheduled = true;
      queueMicrotask(() => { scheduled = false; void flush(); });
    }
    return promise;
  }

  async function flush() {
    if (disposed) return false;
    if (active) return active;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    active = (async () => {
      publish("saving");
      while (pending.length && !disposed) {
        prioritizeDeletion();
        const mutation = pending[0];
        mutation.attempted = true;
        mutation.attempts += 1;
        executing = mutation;
        mutation.controller = new AbortController();
        trace(mutation, "requesting");
        publish("saving");
        try {
          const confirmation = isDelete(mutation) ? new Promise((resolve, reject) => {
            mutation.resolveAttempt = resolve;
            mutation.rejectAttempt = reject;
          }) : null;
          const result = confirmation
            ? await Promise.race([execute(mutation), confirmation]) : await execute(mutation);
          if (disposed) return false;
          if (result?.conflict) {
            throw Object.assign(new Error("Session persistence conflict"), { result });
          }
          removePending(mutation);
          generation += 1;
          // The server has committed. A local rendering failure must never
          // turn its receipt into a retry or remove the following operation.
          try { await onCommit(mutation, result, pending); }
          catch (error) { onFailure(mutation, error, { retrying: false, committed: true }); }
          settle(mutation, null, result);
          trace(mutation, "confirmed");
        } catch (error) {
          if (isDelete(mutation) && !permanent(error) && mutation.attempts >= 2) {
            error = Object.assign(new Error("删除结果尚未确认，请重试核对结果。"), {
              code: "DELETE_OUTCOME_UNKNOWN", cause: error
            });
          }
          if (!permanent(error)) {
            onFailure(mutation, error, { retrying: true });
            trace(mutation, "retrying");
            publish("pending", error);
            if (!disposed) retryTimer = setTimeout(() => { retryTimer = null; void flush(); }, retryMs);
            return false;
          }
          removePending(mutation);
          conflicts.push({ ...mutation, error });
          generation += 1;
          settle(mutation, error);
          trace(mutation, "paused");
          onFailure(mutation, error, { retrying: false });
          // A permanent conflict belongs to this operation, not every session.
        } finally {
          mutation.rejectAttempt = null;
          mutation.resolveAttempt = null;
          executing = null;
        }
      }
      publish(conflicts.length ? "conflict" : "saved");
      return !pending.length && !conflicts.length;
    })().finally(() => { active = null; });
    return active;
  }

  return {
    pending, conflicts, enqueue, flush,
    get isDisposed() { return disposed; },
    get generation() { return generation; },
    get hasUnpersistedChanges() { return pending.length > 0 || conflicts.length > 0; },
    confirmDeletion(id, result, type = "delete") {
      // A committed account event also confirms deletion if its HTTP response
      // was lost. Retire a paused operation so it cannot keep blocking reload.
      for (const item of conflicts.filter(item => item.type === type && item.id === id)) {
        conflicts.splice(conflicts.indexOf(item), 1);
        generation += 1;
        trace(item, "confirmed-by-event");
      }
      const mutation = pending.find(item => item.type === type && item.id === id);
      if (mutation) {
        if (executing === mutation) {
          mutation.resolveAttempt?.(result);
          mutation.controller?.abort();
        } else {
          removePending(mutation);
          generation += 1;
          try {
            Promise.resolve(onCommit(mutation, result, pending)).catch(error =>
              onFailure(mutation, error, { retrying: false, committed: true }));
          } catch (error) { onFailure(mutation, error, { retrying: false, committed: true }); }
          trace(mutation, "confirmed-by-event");
          settle(mutation, null, result);
        }
      }
      publish(conflicts.length ? "conflict" : pending.length ? "pending" : "saved");
    },
    retryDeletion(id) {
      const mutation = conflicts.find(item => item.operationId === id && isDelete(item)
        && ["DELETE_OUTCOME_UNKNOWN", "DELETE_NOT_SENT"].includes(item.error?.code));
      if (!mutation) return Promise.resolve({ ok: true, skipped: true });
      return enqueue({
        type: mutation.type, id: mutation.id, operationId: mutation.operationId,
        ...(mutation.baseTree ? { baseTree: mutation.baseTree } : {})
      });
    },
    discardConflict(id) {
      const index = conflicts.findIndex(item => item.operationId === id);
      if (index < 0) return false;
      conflicts.splice(index, 1);
      generation += 1;
      publish(conflicts.length ? "conflict" : pending.length ? "pending" : "saved");
      return true;
    },
    discardConflicts(ids) {
      const selected = new Set(ids);
      let removed = false;
      for (let index = conflicts.length - 1; index >= 0; index--) {
        if (!selected.has(conflicts[index].operationId)) continue;
        conflicts.splice(index, 1);
        removed = true;
      }
      if (removed) {
        generation += 1;
        publish(conflicts.length ? "conflict" : pending.length ? "pending" : "saved");
      }
      return removed;
    },
    async restart() {
      if (!disposed) return;
      await active;
      conflicts.length = 0;
      disposed = false;
      generation += 1;
    },
    async flushSession(id) {
      const relevant = pending.filter(item => item.id === id || item.type === "tree");
      const barriers = relevant.map(item => new Promise((resolve, reject) =>
        item.waiters.push({ resolve, reject })));
      void flush();
      try {
        await Promise.all(barriers);
        return !conflicts.some(item => item.id === id || item.type === "tree");
      } catch { return false; }
    },
    dispose() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      executing?.controller?.abort();
      executing?.rejectAttempt?.(new Error("Session persistence stopped"));
      for (const mutation of pending) settle(mutation, new Error("Session persistence stopped"));
      pending.length = 0;
    }
  };
}
