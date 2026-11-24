import { classifySessionStorageError } from "../storage/errors.js";
import { annotationPersistenceKey } from "../features/annotation-persistence-key.js";

function editorSnapshot(zion, plugin) {
  const editRevision = plugin.getEditRevision?.();
  return (zion?.panels?.listEditors?.() || []).map(entry => {
    const editor = zion.panels.getEditorBySession(entry.panelId, entry.sessionId);
    // Local edit revisions exclude provider/restore transactions. Older callers
    // can still compare immutable document references without copying text.
    const view = editor?.getView?.();
    return { panelId: entry.panelId, sessionId: entry.sessionId, editor,
      doc: editRevision === undefined ? view?.state?.doc : editRevision };
  });
}

function sameEditors(before, after) {
  return before.length === after.length && before.every((entry, index) => {
    const current = after[index];
    return entry.panelId === current.panelId && entry.sessionId === current.sessionId
      && entry.editor === current.editor && entry.doc === current.doc;
  });
}

/** Bounded preparation, including saves that are still retrying in the shared queue. */
export function createSessionReloadPreparation({
  zion, plugin, collaborationManager, queue, persistAnnotations,
  now = () => Date.now()
}) {
  let annotationCycle = null;
  const annotationSnapshot = () => {
    const id = zion?.state?.get?.("sessions.currentId");
    return { id, value: annotationPersistenceKey(zion?.state?.get?.(`sessions.annotations.${id}`)) };
  };
  return async (options = {}) => {
    const deadline = now() + Math.max(1, Number(options.timeoutMs) || 5000);
    const cancelled = () => options.isCancelled?.() === true;
    const blocker = () => {
      const conflict = queue.conflicts?.[0];
      return conflict
        ? { status: "blocked", reason: classifySessionStorageError(conflict.error).kind }
        : null;
    };
    const pending = () => ({
      status: "pending",
      reason: zion?.state?.get?.("sessions.persistence")?.issue?.kind || "saving"
    });
    const wait = async (task) => {
      let settled = false;
      let value;
      let failure;
      const completion = Promise.resolve(task).then(result => { value = result; settled = true; },
        error => { failure = error; settled = true; });
      while (!settled && !cancelled() && now() < deadline && !blocker()) {
        let timer;
        await Promise.race([
          completion,
          new Promise(resolve => {
            timer = setTimeout(resolve, Math.min(25, Math.max(1, deadline - now())));
          })
        ]).finally(() => clearTimeout(timer));
      }
      if (failure) throw failure;
      return { settled, value };
    };
    let result;
    try {
      if (cancelled()) return options.detailed ? pending() : false;
      // The annotation save can be waiting for metadata hydration before it
      // enters the queue, so track its result as well as the queue itself.
      const current = annotationSnapshot();
      const token = options.requestToken || options;
      if (!annotationCycle || annotationCycle.token !== token
        || annotationCycle.snapshot.id !== current.id
        || annotationCycle.snapshot.value !== current.value
        || annotationCycle.failed) {
        const cycle = { token, snapshot: current, failed: false, promise: null };
        annotationCycle = cycle;
        cycle.promise = Promise.resolve(persistAnnotations()).then(value => {
          cycle.failed = value === false;
          return value !== false;
        }, () => { cycle.failed = true; return false; });
        // Snapshotting cards can itself replace their local state. It does not
        // create another edit on every readiness poll.
        cycle.snapshot = annotationSnapshot();
      }
      const annotations = annotationCycle.promise;
      const before = editorSnapshot(zion, plugin);
      plugin.flush();
      zion?.state?.set?.("sessions.reloadStage", "collaboration");
      result = blocker();
      if (!result) {
        const collaboration = await wait(collaborationManager.flush({
          timeoutMs: Math.max(1, deadline - now()), isCancelled: cancelled, pendingOnly: true
        }));
        result = blocker();
        if (!result && collaboration.settled && collaboration.value === true && !cancelled() && now() < deadline) {
          // flushDurably starts commits synchronously; drive the queue alongside
          // those promises so a scheduled retry cannot strand the reload request.
          const editorWrites = plugin.flushDurably();
          const remoteWrites = queue.flush();
          zion?.state?.set?.("sessions.reloadStage", "persistence");
          const writes = await wait(Promise.all([annotations, editorWrites, remoteWrites]));
          result = blocker();
          if (!result && writes.settled && !cancelled() && now() < deadline
            && writes.value[0] && !queue.isDisposed && !queue.hasUnpersistedChanges) {
            // A previous flush may have returned false before its retry
            // succeeded. Current acknowledged state, not that old result,
            // decides whether it is safe to leave.
            const latestAnnotations = annotationSnapshot();
            result = sameEditors(before, editorSnapshot(zion, plugin)) && !plugin.hasPendingDrafts()
              && annotationCycle.snapshot.id === latestAnnotations.id
              && annotationCycle.snapshot.value === latestAnnotations.value
              && collaborationManager.hasPendingWrites?.() !== true
              ? { status: "ready" } : { status: "pending", reason: "editing" };
          }
        }
      }
      result ||= pending();
      zion?.state?.set?.("sessions.reloadStage", result.status);
    } catch (error) {
      const issue = classifySessionStorageError(error);
      result = { status: issue.retryable ? "pending" : "blocked", reason: issue.kind };
      console.error("[sessions] prepare for reload failed", issue);
    }
    // Keep the boolean contract for PWA protocol recovery and older callers.
    return options.detailed ? result : result.status === "ready";
  };
}
