export const TOOL_EXECUTION_EFFECTS = Object.freeze([
  "read",
  "write",
  "process",
  "external"
]);

export const TOOL_CANCELLATION_MODES = Object.freeze([
  "cooperative",
  "best-effort",
  "none"
]);

export const TOOL_IDEMPOTENCY_MODES = Object.freeze([
  "safe",
  "invocation",
  "reconcile"
]);

const EFFECT_DEFAULTS = Object.freeze({
  read: Object.freeze({
    timeoutMs: 30_000,
    maxTimeoutMs: 120_000,
    cancellation: "cooperative",
    idempotency: "safe"
  }),
  write: Object.freeze({
    timeoutMs: 60_000,
    maxTimeoutMs: 300_000,
    cancellation: "cooperative",
    idempotency: "invocation"
  }),
  process: Object.freeze({
    timeoutMs: 120_000,
    maxTimeoutMs: 600_000,
    cancellation: "best-effort",
    idempotency: "reconcile"
  }),
  external: Object.freeze({
    timeoutMs: 60_000,
    maxTimeoutMs: 300_000,
    cancellation: "best-effort",
    idempotency: "reconcile"
  })
});

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function effectFromRisk(risk) {
  const value = String(risk || "").trim().toLowerCase();
  if (["read", "read-only"].includes(value)) return "read";
  if (["write", "mutation"].includes(value)) return "write";
  if (["external", "external-effect"].includes(value)) return "external";
  if (["execute", "process"].includes(value)) return "process";
  return "";
}

export function normalizeToolExecution(input, {
  risk = "",
  fallbackEffect = "process"
} = {}) {
  const source = input == null ? {} : requireObject(input, "Tool execution policy");
  const inferredEffect = effectFromRisk(risk);
  const effect = String(
    source.effect || inferredEffect || fallbackEffect
  ).trim();
  if (!TOOL_EXECUTION_EFFECTS.includes(effect)) {
    throw new Error(`Tool execution effect is invalid: ${effect || "missing"}`);
  }

  const defaults = EFFECT_DEFAULTS[effect];
  const timeoutMs = source.timeoutMs == null
    ? defaults.timeoutMs
    : positiveInteger(source.timeoutMs, "Tool execution timeoutMs");
  const maxTimeoutMs = source.maxTimeoutMs == null
    ? Math.max(timeoutMs, defaults.maxTimeoutMs)
    : positiveInteger(source.maxTimeoutMs, "Tool execution maxTimeoutMs");
  if (maxTimeoutMs < timeoutMs) {
    throw new Error("Tool execution maxTimeoutMs must be at least timeoutMs");
  }

  const cancellation = String(
    source.cancellation || defaults.cancellation
  ).trim();
  if (!TOOL_CANCELLATION_MODES.includes(cancellation)) {
    throw new Error(`Tool execution cancellation mode is invalid: ${cancellation}`);
  }

  const idempotency = String(
    source.idempotency || defaults.idempotency
  ).trim();
  if (!TOOL_IDEMPOTENCY_MODES.includes(idempotency)) {
    throw new Error(`Tool execution idempotency mode is invalid: ${idempotency}`);
  }

  const timeoutArgument = String(source.timeoutArgument || "").trim();
  if (
    timeoutArgument
    && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(timeoutArgument)
  ) {
    throw new Error("Tool execution timeoutArgument must be a property name");
  }

  return Object.freeze({
    effect,
    timeoutMs,
    maxTimeoutMs,
    cancellation,
    idempotency,
    ...(timeoutArgument ? { timeoutArgument } : {})
  });
}

export function toolExecutionForDefinition(definition = {}) {
  return normalizeToolExecution(definition.execution, {
    risk: definition.risk
  });
}

export function resolveToolExecutionTimeoutMs(execution, args = {}) {
  const policy = normalizeToolExecution(execution);
  if (!policy.timeoutArgument) return policy.timeoutMs;
  const requested = Number(args?.[policy.timeoutArgument]);
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    return policy.timeoutMs;
  }
  return Math.min(requested, policy.maxTimeoutMs);
}
