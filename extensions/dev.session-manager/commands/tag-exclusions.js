import {
  applyTagSubtreeExclusionBulk,
  buildSessionTagExtractionState,
  calculateTagSubtreeExclusionImpact,
  excludeSessionTags,
  restoreSessionTagExclusion
} from "../model/session-tag-index.js";

export function registerSessionTagExclusionCommands(deps) {
  const zion = deps?.zion;
  const getIndex = deps?.getIndex || (() => ({ version: 1, sessions: {} }));
  const commitIndex = deps?.commitIndex || (() => {});
  const getCurrentSessionId = deps?.getCurrentSessionId || (() => "");
  const disposables = [];

  const resolveSessionId = (payload) => {
    const explicit = typeof payload === "string"
      ? payload
      : payload?.sessionId || payload?.id;
    return String(explicit || getCurrentSessionId() || "").trim();
  };
  const register = (id, handler) => {
    const disposable = zion?.commands?.registerCommand?.(id, handler);
    if (disposable) disposables.push(disposable);
  };

  register("zion.sessions.getTagExtractionState", (payload = {}) => (
    buildSessionTagExtractionState(getIndex(), resolveSessionId(payload))
  ));
  register("zion.sessions.getTagExclusionImpact", (payload = {}) => (
    calculateTagSubtreeExclusionImpact(
      getIndex(),
      typeof payload === "string" ? payload : payload?.path
    )
  ));
  register("zion.sessions.excludeTag", (payload = {}) => {
    const index = getIndex();
    const sessionId = resolveSessionId(payload);
    const path = typeof payload === "string" ? payload : payload?.path;
    if (!sessionId || !path || !index.sessions?.[sessionId]) return { ok: false };
    commitIndex(excludeSessionTags(index, sessionId, path, {
      subtree: payload?.subtree === true
    }));
    return { ok: true, ...buildSessionTagExtractionState(getIndex(), sessionId) };
  });
  register("zion.sessions.restoreTag", (payload = {}) => {
    const index = getIndex();
    const sessionId = resolveSessionId(payload);
    const path = typeof payload === "string" ? payload : payload?.path;
    if (!sessionId || !path || !index.sessions?.[sessionId]) return { ok: false };
    commitIndex(restoreSessionTagExclusion(index, sessionId, path, {
      subtree: payload?.subtree === true
    }));
    return { ok: true, ...buildSessionTagExtractionState(getIndex(), sessionId) };
  });
  register("zion.sessions.excludeTagSubtreeBulk", (payload = {}) => {
    const path = typeof payload === "string" ? payload : payload?.path;
    const result = applyTagSubtreeExclusionBulk(getIndex(), path);
    if (!result.impact.sessionCount) return { ok: false, ...result.impact };
    commitIndex(result.index);
    return { ok: true, ...result.impact };
  });

  return {
    dispose() {
      for (const disposable of disposables.splice(0)) {
        try { disposable?.dispose?.(); } catch {}
      }
    }
  };
}
