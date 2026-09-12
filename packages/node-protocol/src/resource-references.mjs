const PREFIXES = Object.freeze({
  terminal: "zterminal1",
  machine: "zmachine1"
});
const MAX_REFERENCE_LENGTH = 4096;

function encodePart(value) {
  const text = String(value ?? "");
  if (!text || text.length > 1024 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error("Invalid resource reference component");
  }
  return encodeURIComponent(text);
}

function encode(kind, parts) {
  const value = [PREFIXES[kind], ...parts.map(encodePart)].join(":");
  if (value.length > MAX_REFERENCE_LENGTH) {
    throw new Error("Resource reference exceeds the size limit");
  }
  return value;
}

function decode(value, kind, count) {
  const text = String(value ?? "");
  if (!text.startsWith(`${PREFIXES[kind]}:`)) return null;
  try {
    const parts = text.split(":").slice(1).map(decodeURIComponent);
    if (parts.length !== count || encode(kind, parts) !== text) throw new Error();
    return parts;
  } catch {
    throw new Error(`Invalid ${kind} reference`);
  }
}

export function terminalReference({ nodeId, instanceId, resourceId, sessionId }) {
  return encode("terminal", [nodeId, instanceId, resourceId, sessionId]);
}

export function parseTerminalReference(value) {
  const parts = decode(value, "terminal", 4);
  return parts
    ? { nodeId: parts[0], instanceId: parts[1], resourceId: parts[2], sessionId: parts[3] }
    : null;
}

export function machineReference(nodeId, machineId) {
  return encode("machine", [nodeId, machineId]);
}

export function parseMachineReference(value) {
  const parts = decode(value, "machine", 2);
  return parts ? { nodeId: parts[0], machineId: parts[1] } : null;
}

export function isResourceReference(value) {
  return /^z(?:terminal|machine)[0-9]+:/.test(String(value ?? ""));
}
