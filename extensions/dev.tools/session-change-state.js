import { buildFileArtifacts, statusLabel } from "./artifact-model.js";

export function getCurrentSessionChangeState() {
  const sessionId = getCurrentSessionId();
  return getSessionChangeState(sessionId);
}

export function getSessionChangeState(sessionId = getCurrentSessionId()) {
  const annotations = getSessionAnnotations(sessionId);
  const tools = Array.isArray(annotations.tools)
    ? annotations.tools
    : (window.zion?.tools?.getAllToolCalls?.() || []);
  const artifacts = buildFileArtifacts(tools, annotations, sessionId);
  return buildChangeState(sessionId, artifacts);
}

export function subscribeSessionChangeState(listener) {
  const disposables = [];
  const notify = (payload = {}) => {
    const eventSessionId = String(payload?.sessionId || "").trim();
    if (eventSessionId && eventSessionId !== String(getCurrentSessionId() || "")) return;
    listener?.(payload);
  };
  try { disposables.push(window.zion?.events?.on?.("toolcards/toolsUpdated", notify)); } catch {}
  try { disposables.push(window.zion?.events?.on?.("chat/toolCall", notify)); } catch {}
  try { disposables.push(window.zion?.events?.on?.("chat/toolResult", notify)); } catch {}
  try { disposables.push(window.zion?.events?.on?.("chat/annotationsChanged", notify)); } catch {}
  try { disposables.push(window.zion?.state?.onDidChange?.("sessions.currentId", notify)); } catch {}
  return {
    dispose() {
      for (const disposable of disposables.splice(0)) {
        try { disposable?.dispose?.(); } catch {}
      }
    }
  };
}

export function normalizeChangePath(path) {
  return stripLineSuffix(String(path || "").trim()).replace(/\\/g, "/").replace(/\/+$/, "");
}

export function formatChangeMeta(change) {
  if (!change) return "";
  const status = change.status && change.status !== "unknown" ? statusLabel(change.status) : "";
  const diff = change.addedLines || change.removedLines
    ? `+${formatCompactCount(change.addedLines)} -${formatCompactCount(change.removedLines)}`
    : "";
  return [status, diff].filter(Boolean).join(" ");
}

export function formatChangeSummary(summary) {
  const fileCount = Number(summary?.changedFiles || 0);
  if (!fileCount) return "";
  return `${fileCount} changed · +${formatCompactCount(summary.addedLines)} -${formatCompactCount(summary.removedLines)}`;
}

export function formatCompactChangeCount(value) {
  return formatCompactCount(value);
}

function buildChangeState(sessionId, artifacts) {
  const byPath = new Map();
  const summary = {
    files: artifacts.length,
    changedFiles: 0,
    addedLines: 0,
    removedLines: 0,
    pending: 0,
    accepted: 0,
    reverted: 0,
    failed: 0,
    unknown: 0
  };

  for (const artifact of artifacts) {
    const added = Number(artifact?.addedLines || 0);
    const removed = Number(artifact?.removedLines || 0);
    summary.addedLines += added;
    summary.removedLines += removed;
    if (artifact?.status && Object.prototype.hasOwnProperty.call(summary, artifact.status)) {
      summary[artifact.status] += 1;
    } else {
      summary.unknown += 1;
    }

    const path = normalizeChangePath(artifact?.path || "");
    if (!path) continue;
    const prev = byPath.get(path) || {
      path,
      artifacts: [],
      addedLines: 0,
      removedLines: 0,
      status: ""
    };
    prev.artifacts.push(artifact);
    prev.addedLines += added;
    prev.removedLines += removed;
    prev.status = artifact?.status || prev.status || "unknown";
    byPath.set(path, prev);
  }

  summary.changedFiles = byPath.size;
  return {
    sessionId,
    artifacts,
    byPath,
    summary,
    fingerprint: buildFingerprint(artifacts)
  };
}

function buildFingerprint(artifacts) {
  return artifacts.map((artifact) => [
    artifact.id,
    artifact.path,
    artifact.status,
    artifact.addedLines || 0,
    artifact.removedLines || 0
  ].join("\u001f")).join("\u001e");
}

function getCurrentSessionId() {
  try { return window.zion?.state?.get?.("sessions.currentId") || null; } catch { return null; }
}

function getSessionAnnotations(sessionId) {
  if (!sessionId) return {};
  try {
    return window.zion?.commands?.executeCommand?.("zion.chatCards.getSessionAnnotations", sessionId) || {};
  } catch {
    return {};
  }
}

function stripLineSuffix(value) {
  return String(value || "").replace(/:\d+(?::\d+)?$/, "");
}

function formatCompactCount(value) {
  try {
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1
    }).format(Number(value || 0)).toLowerCase();
  } catch {
    return String(value || 0);
  }
}
