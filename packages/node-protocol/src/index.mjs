import { normalizeToolExecution } from "../../plugin-sdk/src/tool-execution.mjs";

export const DEVICE_PROTOCOL_VERSION = 1;
export {
  formatByteSize,
  parseByteSize,
  requestBodyLimitError
} from "./request-limits.mjs";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const RISK_CLASSES = new Set([
  "read",
  "write",
  "execute",
  "external-effect"
]);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireId(value, label) {
  const id = String(value || "").trim();
  if (!ID_PATTERN.test(id)) {
    throw new Error(`${label} is invalid`);
  }
  return id;
}

function optionalText(value) {
  const text = String(value || "").trim();
  return text || undefined;
}

function requirePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function fallbackExecutionEffect(name) {
  if (["write", "edit"].includes(name)) return "write";
  if (name === "sendMail") return "external";
  if (["Bash", "mcpCall"].includes(name)) return "process";
  return "read";
}

function legacyExecutionPolicy(name, risk) {
  if (name === "Bash") {
    return normalizeToolExecution({
      effect: "process",
      timeoutMs: 120_000,
      maxTimeoutMs: 600_000,
      timeoutArgument: "timeout"
    });
  }
  return normalizeToolExecution(null, {
    risk,
    fallbackEffect: fallbackExecutionEffect(name)
  });
}

function normalizeCapability(input) {
  const capability = requireObject(input, "Node capability");
  const name = requireId(capability.name, "Node capability name");
  const risk = String(capability.risk || "read");
  const executionDeclared = typeof capability.executionDeclared === "boolean"
    ? capability.executionDeclared
    : capability.execution != null;
  if (!RISK_CLASSES.has(risk)) {
    throw new Error(`Node capability ${name} has an invalid risk class`);
  }
  const inputSchema = capability.inputSchema == null
    ? {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    : requireObject(
        capability.inputSchema,
        `Node capability ${name} inputSchema`
      );

  return {
    name,
    version: String(capability.version || "1"),
    risk,
    description: String(capability.description || ""),
    inputSchema: { ...inputSchema },
    hostKind: String(capability.hostKind || "device"),
    execution: capability.execution == null
      ? legacyExecutionPolicy(name, capability.risk == null ? "" : risk)
      : normalizeToolExecution(capability.execution, { risk }),
    executionDeclared
  };
}

function normalizeResource(input) {
  const resource = requireObject(input, "Node resource");
  return {
    resourceId: requireId(resource.resourceId, "Node resource id"),
    kind: requireId(resource.kind, "Node resource kind"),
    projectId: optionalText(resource.projectId),
    label: optionalText(resource.label),
    ...(typeof resource.workspaceRoot === "string" && resource.workspaceRoot.length <= 4096
      && !/[\0\r\n]/.test(resource.workspaceRoot)
      && (resource.workspaceRoot.startsWith("/") || /^[A-Z]:[\\/]/i.test(resource.workspaceRoot))
      ? { workspaceRoot: resource.workspaceRoot } : {})
  };
}

function uniqueBy(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (seen.has(value)) {
      throw new Error(`${label} ${value} is duplicated`);
    }
    seen.add(value);
  }
  return items;
}

export function normalizeNodeRegistration(input) {
  const registration = requireObject(input, "Node registration");
  if (registration.protocolVersion !== DEVICE_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported Device protocol version: ${registration.protocolVersion}`
    );
  }

  const capabilities = uniqueBy(
    Array.isArray(registration.capabilities)
      ? registration.capabilities.map(normalizeCapability)
      : [],
    "name",
    "Node capability"
  );
  const resources = uniqueBy(
    Array.isArray(registration.resources)
      ? registration.resources.map(normalizeResource)
      : [],
    "resourceId",
    "Node resource"
  );

  return {
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    nodeId: requireId(registration.nodeId, "Node id"),
    instanceId: requireId(registration.instanceId, "Node instance id"),
    label: optionalText(registration.label),
    platform: optionalText(registration.platform),
    capabilities,
    resources
  };
}

export function normalizeToolResult(input) {
  const result = requireObject(input, "Tool result");
  return {
    ok: result.ok === true,
    content: String(result.content || ""),
    ...(result.error ? { error: String(result.error) } : {}),
    ...(result.failureCode
      ? { failureCode: String(result.failureCode) }
      : {}),
    ...(typeof result.retryable === "boolean"
      ? { retryable: result.retryable }
      : {}),
    ...(Array.isArray(result.artifactIds)
      ? {
          artifactIds: result.artifactIds
            .map(String)
            .filter(Boolean)
        }
      : {})
  };
}

export function validateDeviceCommand(input) {
  const command = requireObject(input, "Device command");
  if (command.schemaVersion !== DEVICE_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported Device command version: ${command.schemaVersion}`
    );
  }
  if (command.type === "tool.cancel") {
    return {
      schemaVersion: DEVICE_PROTOCOL_VERSION,
      type: "tool.cancel",
      invocationId: requireId(command.invocationId, "Invocation id"),
      reason: String(command.reason || "cancelled")
    };
  }
  if (command.type !== "tool.invoke") {
    throw new Error(`Unsupported Device command type: ${command.type}`);
  }

  const invocation = requireObject(command.invocation, "Tool invocation");
  const invocationId = requireId(
    invocation.invocationId,
    "Invocation id"
  );
  if (command.invocationId !== invocationId) {
    throw new Error("Device command invocation id does not match its payload");
  }

  return {
    schemaVersion: DEVICE_PROTOCOL_VERSION,
    type: "tool.invoke",
    invocationId,
    resourceId: optionalText(command.resourceId),
    leaseExpiresAt: requirePositiveInteger(
      command.leaseExpiresAt,
      "Device command lease expiration"
    ),
    invocation
  };
}
