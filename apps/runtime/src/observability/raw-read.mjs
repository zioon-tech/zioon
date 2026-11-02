import { createHash } from "node:crypto";
import { accountError } from "../accounts/account-policy.mjs";

export const RAW_OBSERVABILITY_TOOL_NAME = "observabilityRawRead";
export const RAW_OBSERVABILITY_FIELDS = Object.freeze([
  "arguments", "result", "error", "context"
]);

export const RAW_OBSERVABILITY_TOOL_DEFINITION = Object.freeze({
  name: RAW_OBSERVABILITY_TOOL_NAME,
  description: [
    "Read one exact tool call from this Space's raw Run ledger and durable receipt.",
    "Use an event sequence found with observabilityQuery. Credentials are always redacted.",
    "The response is bounded, chunked, and access-audited."
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      run_id: {
        type: "string",
        minLength: 1,
        maxLength: 160,
        description: "Target Zion Run id from the observability projection."
      },
      event_sequence: {
        type: "integer",
        minimum: 1,
        description: "Sequence of a tool.requested, tool.completed, or tool.denied event."
      },
      fields: {
        type: "array",
        items: { type: "string", enum: RAW_OBSERVABILITY_FIELDS },
        minItems: 1,
        maxItems: RAW_OBSERVABILITY_FIELDS.length,
        uniqueItems: true,
        description: "Raw fields to return after mandatory credential redaction."
      },
      context_events: {
        type: "integer",
        minimum: 0,
        maximum: 5,
        description: "Neighboring ledger events to include on each side when context is requested."
      },
      cursor: {
        type: "integer",
        minimum: 0,
        description: "UTF-8 byte offset returned by a previous chunk."
      },
      max_bytes: {
        type: "integer",
        minimum: 1024,
        maximum: 32768,
        description: "Maximum UTF-8 bytes in this response chunk."
      },
      purpose: {
        type: "string",
        enum: ["diagnose_failure", "evolution_case_build"],
        description: "Reason recorded in the immutable account audit trail."
      }
    },
    required: ["run_id", "event_sequence", "purpose"],
    additionalProperties: false
  },
  hostKinds: ["runtime-observability"],
  execution: { effect: "read" }
});

const RAW_EVENT_TYPES = new Set(["tool.requested", "tool.completed", "tool.denied"]);
const SENSITIVE_KEYS = new Set([
  "authorization", "proxyauthorization", "cookie", "cookies", "setcookie",
  "token", "accesstoken", "refreshtoken", "idtoken", "sessiontoken",
  "apikey", "xapikey", "password", "passwd", "secret", "clientsecret",
  "privatekey", "signingkey", "credential", "credentials"
]);

function validId(value, label) {
  const result = String(value || "");
  if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(result)) {
    throw accountError(400, "invalid_raw_observability_target", `${label} is invalid`);
  }
  return result;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function selectedFields(value) {
  if (value === undefined) return [...RAW_OBSERVABILITY_FIELDS];
  if (!Array.isArray(value) || !value.length) {
    throw accountError(400, "invalid_raw_observability_fields");
  }
  const fields = [...new Set(value.map(String))];
  if (fields.some((field) => !RAW_OBSERVABILITY_FIELDS.includes(field))) {
    throw accountError(400, "invalid_raw_observability_fields");
  }
  return fields;
}

function sensitiveKey(key) {
  const original = String(key || "");
  const compact = original.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SENSITIVE_KEYS.has(compact)) return true;
  return /(?:access|refresh|identity|auth|bearer|session|csrf|client|private|signing|api)(?:token|secret|key|credential)$/
    .test(compact)
    || /password(?:hash)?$/.test(compact);
}

function redactString(value) {
  let result = String(value);
  const wholePatterns = [
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    /\bzion_(?:account|run|device|pairing|delegation)_v\d+\.[A-Za-z0-9._~-]+/gi,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    /\b(?:sk-(?:ant-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/gi,
    /\bAKIA[0-9A-Z]{16}\b/g
  ];
  const prefixedPatterns = [
    /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    /((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:\s*)[^\r\n]+/gi,
    /((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    /([?&](?:access_token|refresh_token|id_token|token|api_key|key|password|secret)=)[^&#\s]+/gi
  ];
  for (const pattern of wholePatterns) result = result.replace(pattern, "[REDACTED]");
  for (const pattern of prefixedPatterns) {
    result = result.replace(pattern, (_match, prefix) => `${prefix}[REDACTED]`);
  }
  return result;
}

function redact(value) {
  const state = { count: 0, paths: [] };
  const visit = (current, path) => {
    if (Array.isArray(current)) return current.map((item, index) => visit(item, `${path}[${index}]`));
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current).map(([key, item]) => {
        const itemPath = path ? `${path}.${key}` : key;
        if (sensitiveKey(key)) {
          state.count++;
          if (state.paths.length < 20) state.paths.push(itemPath);
          return [key, "[REDACTED]"];
        }
        return [key, visit(item, itemPath)];
      }));
    }
    if (typeof current !== "string") return current;
    const redacted = redactString(current);
    if (redacted !== current) {
      state.count++;
      if (state.paths.length < 20) state.paths.push(path);
    }
    return redacted;
  };
  return { value: visit(value, ""), ...state };
}

function utf8Chunk(text, requestedCursor, maxBytes) {
  const source = Buffer.from(text, "utf8");
  const cursor = Math.min(requestedCursor, source.length);
  if (requestedCursor > source.length) throw accountError(416, "raw_observability_cursor_out_of_range");
  let start = cursor;
  while (start < source.length && (source[start] & 0xc0) === 0x80) start++;
  let end = Math.min(source.length, start + maxBytes);
  while (end > start && end < source.length && (source[end] & 0xc0) === 0x80) end--;
  const content = source.subarray(start, end).toString("utf8");
  return {
    cursor: start,
    nextCursor: end < source.length ? end : null,
    totalBytes: source.length,
    returnedBytes: end - start,
    truncated: end < source.length,
    content
  };
}

function eventView(event) {
  return {
    sequence: event.sequence,
    timestamp: event.timestamp,
    type: event.type,
    attemptId: event.attemptId,
    data: event.data || {}
  };
}

async function receiptInvocationId(runs, runId, spaceId, requested) {
  if (!requested) return "";
  const turn = Number(requested.data?.turn);
  if (!Number.isSafeInteger(turn) || turn < 1) return "";
  const index = await runs.getToolRequestIndexForSpace(
    runId, requested.attemptId, turn, requested.sequence, spaceId
  );
  return `${runId}:turn:${turn}:tool:${index}`;
}

export async function readRawObservability({
  runs, spaceId, input, actorRun = null
}) {
  if (!runs?.getRunForSpace || !runs?.getEventsForSpace
    || !runs?.getToolCallEventsForSpace || !runs?.getToolRequestIndexForSpace
    || !runs?.getToolReceiptForSpace) {
    throw accountError(503, "raw_observability_unavailable");
  }
  const runId = validId(input.run_id, "Run id");
  const sequence = boundedInteger(input.event_sequence, 0, 1, Number.MAX_SAFE_INTEGER);
  if (!sequence) throw accountError(400, "invalid_raw_observability_target");
  const fields = selectedFields(input.fields);
  if (!["diagnose_failure", "evolution_case_build"].includes(input.purpose)) {
    throw accountError(400, "invalid_raw_observability_purpose");
  }
  const contextEvents = boundedInteger(input.context_events, 2, 0, 5);
  const cursor = boundedInteger(input.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
  const maxBytes = boundedInteger(input.max_bytes, 16 * 1024, 1024, 32 * 1024);

  const run = await runs.getRunForSpace(runId, spaceId);
  if (!run) throw accountError(404, "raw_observability_record_not_found");
  const [selected] = await runs.getEventsForSpace(runId, spaceId, {
    fromSequence: sequence,
    toSequence: sequence
  });
  if (!selected || !RAW_EVENT_TYPES.has(selected.type) || !selected.data?.callId) {
    throw accountError(404, "raw_observability_record_not_found");
  }
  const callId = String(selected.data.callId);
  const paired = await runs.getToolCallEventsForSpace(
    runId, selected.attemptId, callId, spaceId
  );
  const requested = paired.find((event) => event.type === "tool.requested");
  const completed = paired.find((event) => event.type === "tool.completed");
  const denied = paired.find((event) => event.type === "tool.denied");
  const invocationId = await receiptInvocationId(runs, runId, spaceId, requested);
  const receipt = invocationId
    ? await runs.getToolReceiptForSpace(invocationId, runId, spaceId)
    : null;
  const result = receipt?.result || {};
  const firstSequence = Math.min(...paired.map((event) => event.sequence));
  const lastSequence = Math.max(...paired.map((event) => event.sequence));
  const detail = {
    schemaVersion: 1,
    target: {
      runId,
      attemptId: selected.attemptId,
      eventSequence: sequence,
      callId,
      tool: String(selected.data?.name || requested?.data?.name || completed?.data?.name || ""),
      turn: Number(selected.data?.turn ?? requested?.data?.turn ?? completed?.data?.turn) || undefined
    },
    source: {
      ledger: true,
      durableReceipt: !!receipt,
      receiptCompletedAt: receipt?.completedAt
    }
  };
  if (fields.includes("arguments")) detail.arguments = requested?.data?.arguments ?? requested?.data?.args ?? null;
  if (fields.includes("result")) detail.result = receipt ? result.content : completed?.data?.result ?? null;
  if (fields.includes("error")) {
    detail.error = {
      message: receipt ? result.error || null : completed?.data?.error || denied?.data?.reason || null,
      failureCode: result.failureCode || completed?.data?.failureCode || null,
      ok: receipt ? result.ok !== false : completed?.data?.ok ?? false
    };
  }
  if (fields.includes("context")) {
    detail.context = (await runs.getEventsForSpace(runId, spaceId, {
      fromSequence: Math.max(1, firstSequence - contextEvents),
      toSequence: lastSequence + contextEvents
    })).map(eventView);
  }

  const redacted = redact(detail);
  const serialized = JSON.stringify(redacted.value);
  const chunk = utf8Chunk(serialized, cursor, maxBytes);
  const contentHash = createHash("sha256").update(serialized).digest("hex");
  const chunkHash = createHash("sha256").update(chunk.content).digest("hex");
  const skills = Array.isArray(actorRun?.metadata?.skills?.enabled)
    ? actorRun.metadata.skills.enabled.map(String).filter((id) => /^[a-zA-Z0-9._/-]{1,160}$/.test(id)).slice(0, 20)
    : [];
  return {
    output: {
      schemaVersion: 1,
      target: redacted.value.target,
      fields,
      chunk: {
        encoding: "utf8-json",
        ...chunk,
        contentHash,
        chunkHash
      },
      redaction: {
        applied: redacted.count > 0,
        count: redacted.count,
        paths: redacted.paths
      }
    },
    audit: {
      actor: {
        kind: "model",
        runId: String(actorRun?.id || ""),
        skills
      },
      target: redacted.value.target,
      fields,
      purpose: input.purpose,
      cursor: chunk.cursor,
      nextCursor: chunk.nextCursor,
      bytes: chunk.returnedBytes,
      totalBytes: chunk.totalBytes,
      contentHash,
      chunkHash,
      redaction: {
        applied: redacted.count > 0,
        count: redacted.count
      }
    }
  };
}
