export function getSessionRunIndicatorStatus(runState) {
  if (runState?.streaming) return "streaming";
  if (!runState?.awaiting) return "";
  if (runState?.error) return "error";
  if (runState?.aborted) return "aborted";
  return "ready";
}

export function markSessionRunViewed(zion, sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return false;

  const key = `chat.runs.${sid}`;
  let changed = false;
  let current = null;
  try {
    current = zion?.state?.get?.(key) || null;
  } catch {}
  if (!current?.awaiting) return false;

  const markViewed = (runState) => {
    if (!runState?.awaiting) return runState;
    changed = true;
    return { ...runState, awaiting: false };
  };

  try {
    if (typeof zion?.state?.update === "function") {
      zion.state.update(key, markViewed);
    } else {
      const next = markViewed(current);
      if (next !== current) zion?.state?.set?.(key, next);
    }
  } catch {
    try {
      const runState = zion?.state?.get?.(key) || null;
      const next = markViewed(runState);
      if (next !== runState) zion?.state?.set?.(key, next);
    } catch {}
  }

  return changed;
}
