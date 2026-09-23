import { createHash } from "node:crypto";

export const SEMANTIC_EVENTS = new Set([
  "run.started", "run.resumed", "run.completed", "run.failed", "run.aborted", "run.interrupted",
  "turn.started", "turn.completed", "context.started", "context.completed", "context.failed",
  "model.started", "model.completed", "model.usage", "tool.requested", "tool.completed", "tool.denied"
]);
const STATUSES = ["queued", "running", "completed", "failed", "aborted", "interrupted"];
const FAILURE_CODES = new Set([
  "timeout", "policy_denied", "invalid_arguments", "model_error", "tool_error",
  "context_error", "grant_inactive", "membership_required", "permission_denied",
  "tool_outside_grant", "grant_profile_unavailable", "backend-unavailable",
  "rate_limit", "http_status", "http_4xx", "http_5xx", "dns_error",
  "network_error", "content_type", "size_limit", "truncated",
  "cancelled", "runtime-shutdown", "max_turns", "unknown"
]);
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const id = (value) => /^[a-zA-Z0-9:_-]{1,160}$/.test(String(value || "")) ? value : undefined;
const code = (value) => FAILURE_CODES.has(value) ? value : "unknown";
const reference = (value) => value
  ? createHash("sha256").update(String(value)).digest("hex").slice(0, 24) : undefined;
const known = (set, value) => set.has(value) ? value : "unknown";

export function projectUsage(usage) {
  const result = {};
  for (const [key, aliases] of Object.entries({
    input: ["inputTokens", "input"], output: ["outputTokens", "output"],
    reasoning: ["reasoningTokens", "reasoning"], cacheRead: ["cacheReadTokens", "cacheRead"],
    cacheWrite: ["cacheWriteTokens", "cacheWrite"]
  })) {
    const value = aliases.map((alias) => number(usage?.[alias])).find((candidate) => candidate !== undefined);
    if (value !== undefined) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

// Construct every projected field explicitly. Never spread event data, tags,
// arbitrary error strings, metadata, prompts, tool arguments or tool results.
export function projectionRecords(row, { spaceId, tools = new Set(), now = Date.now() }) {
  const { event, run, cursor } = row;
  if (!SEMANTIC_EVENTS.has(event.type)) return [];
  const base = {
    schemaVersion: 1, spaceId, runId: id(event.runId), attemptId: id(event.attemptId),
    sequence: number(event.sequence), sourceCursor: cursor,
    timestamp: number(event.timestamp), projectedAt: now, source: "run-ledger"
  };
  const data = event.data || {};
  const records = [["events", {
    ...base, recordId: `event:${cursor}`, type: event.type,
    turn: number(data.turn), tool: data.name === undefined ? undefined : known(tools, data.name),
    ok: typeof data.ok === "boolean" ? data.ok : undefined,
    denialType: event.type === "tool.denied"
      ? (["policy", "invalid_arguments"].includes(data.denialType) ? data.denialType : "unknown") : undefined,
    failureCode: event.type.endsWith(".failed") || data.ok === false ? code(data.failureCode) : undefined,
    usage: projectUsage(data.usage)
  }]];
  if (event.type.startsWith("run.")) {
    const traceId = /^[a-f0-9]{32}$/i.test(String(run.traceId || "")) ? run.traceId : undefined;
    records.push(["runs", {
      ...base, recordId: `run:${cursor}`, timestamp: number(run.updatedAt),
      userId: id(run.userId), identity: run.userId ? "account" : "legacy",
      sessionRef: reference(run.sessionId), projectRef: reference(run.projectId),
      status: STATUSES.includes(run.status) ? run.status : "unknown",
      createdAt: number(run.createdAt), updatedAt: number(run.updatedAt),
      completedAt: number(run.completedAt),
      durationMs: number(run.completedAt) !== undefined && number(run.createdAt) !== undefined
        ? Math.max(0, run.completedAt - run.createdAt) : undefined,
      terminalReason: run.terminalReason ? code(run.terminalReason) : undefined,
      usage: projectUsage(run.usage),
      trace: {
        traceId, state: !traceId ? "no-correlation"
          : Number(run.traceFlags) !== 1 ? "unsampled" : "pending-index"
      }
    }]);
  }
  return records;
}

export function projectionStages(diagnostic, base, { tools = new Set() } = {}) {
  return (diagnostic?.stages || []).slice(0, 20).map((stage, index) => ({
    ...base, recordId: `trace:${base.runId}:${base.sourceCursor}:${index}`,
    source: "trace", kind: ["model", "tool", "attempt"].includes(stage.kind) ? stage.kind : "unknown",
    name: stage.kind === "tool" ? known(tools, stage.name) : stage.kind,
    status: ["ok", "error", "cancelled"].includes(stage.status) ? stage.status : "unknown",
    durationMs: number(stage.durationMs), firstChunkMs: number(stage.firstChunkMs),
    consumerWaitMs: number(stage.consumerWaitMs), activeDurationMs: number(stage.activeDurationMs),
    credentialMs: number(stage.credentialMs), httpStatus: number(stage.httpStatus),
    failureCode: stage.errorType ? code(stage.errorType) : undefined,
    usage: projectUsage(stage.tokenUsage)
  }));
}
