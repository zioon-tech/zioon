import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import process from "node:process";
import {
  LOCAL_TOOLS_TOOL_DEFINITIONS,
  LocalToolsDeviceHost
} from "../../../packages/local-tools-client/src/index.mjs";
import { DEVICE_PROTOCOL_VERSION, parseByteSize } from "../../../packages/node-protocol/src/index.mjs";
import { createPluginDataFileHost } from "../../../packages/local-tools-client/src/plugin-data-files.mjs";
import {
  DeviceConnector,
  exchangeDevicePairing
} from "./device-connector.mjs";
import {
  DEVICE_SERVICE_CAPABILITY,
  DeviceServiceHost
} from "./device-service-host.mjs";
import {
  createDeviceCredentialStore,
  deviceCredentialKey
} from "./device-credential-store.mjs";
import { DeviceAccessManager } from "./device-access-policy.mjs";
import {
  defaultDeviceProjectId,
  defaultDeviceResourceId,
  ensureDeviceTerminalSessions,
  normalizeLocalToolsUrl,
  resolveDeviceWorkspaceRoot
} from "./device-setup.mjs";

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function nodeIdFromHostname(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `node:${normalized || "local"}`;
}

function parseList(value) {
  return [...new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  )];
}

function enabledFlag(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase()
  );
}

const runtimeUrl = readArg(
  "--runtime-url",
  process.env.ZION_RUNTIME_URL || "http://127.0.0.1:8766"
);
const localToolsUrl = normalizeLocalToolsUrl(readArg(
  "--local-tools-url",
  process.env.ZION_LOCAL_TOOLS_URL || "http://127.0.0.1:8765"
));
const pluginServiceUrl = normalizeLocalToolsUrl(readArg(
  "--plugin-service-url",
  process.env.ZION_PLUGIN_SERVICE_URL || "http://127.0.0.1:8767"
));

const machineName = hostname();
const nodeId = readArg(
  "--node-id",
  process.env.ZION_NODE_ID || nodeIdFromHostname(machineName)
);
const workspaceRoot = resolveDeviceWorkspaceRoot({
  configured: readArg(
    "--workspace-root",
    process.env.ZION_NODE_WORKSPACE_ROOT || ""
  ),
  initialCwd: process.env.INIT_CWD || "",
  cwd: process.cwd()
});
const projectId = readArg(
  "--project-id",
  process.env.ZION_NODE_PROJECT_ID || defaultDeviceProjectId(workspaceRoot)
);
const resourceId = readArg(
  "--resource-id",
  process.env.ZION_NODE_RESOURCE_ID
    || defaultDeviceResourceId(projectId)
);
const pluginDataRoot = readArg(
  "--plugin-data-root",
  process.env.ZION_PLUGIN_DATA_ROOT || `${homedir()}/.zion-next/data/plugins`
);
const deviceServiceMaxRequestBytes = parseByteSize(
  readArg(
    "--device-service-max-request-bytes",
    process.env.ZION_DEVICE_SERVICE_MAX_REQUEST_BYTES || "1MiB"
  ),
  { label: "Device service request body limit" }
);
const builtInRoots = [
  `${homedir()}/.zion-next/skills`,
  `${homedir()}/.zion-next/memory`,
  pluginDataRoot
];
const configuredRoots = parseList(readArg(
  "--additional-roots",
  process.env.ZION_NODE_ADDITIONAL_ROOTS || ""
));
const additionalRoots = [...new Set([...builtInRoots, ...configuredRoots])];
const terminalSessionIds = await ensureDeviceTerminalSessions({
  localToolsUrl,
  workspaceRoot,
  additionalRoots,
  sessionIds: parseList(readArg(
    "--terminal-sessions",
    process.env.ZION_NODE_TERMINAL_SESSION_IDS || ""
  ))
});
const deviceAccess = new DeviceAccessManager({
  localToolsUrl,
  workspaceRoot,
  baseRoots: builtInRoots,
  bootstrapRoots: configuredRoots,
  scope: readArg(
    "--access-scope",
    process.env.ZION_DEVICE_ACCESS_SCOPE || "selected-roots"
  ),
  policyPath: readArg(
    "--access-policy",
    process.env.ZION_DEVICE_ACCESS_POLICY || undefined
  )
});
await deviceAccess.state({ force: true });
const credentialStore = createDeviceCredentialStore();
const credentialKey = deviceCredentialKey(runtimeUrl, nodeId);
let token = String(process.env.ZION_DEVICE_TOKEN || "").trim();
if (!token) {
  const stored = await credentialStore.get(credentialKey);
  if (
    stored?.credential
    && Number(stored.expiresAt || 0) > Date.now()
  ) {
    token = String(stored.credential);
  }
}
if (!token) {
  const pairingId = readArg(
    "--pairing-id",
    process.env.ZION_DEVICE_PAIRING_ID || ""
  );
  const pairingSecret = readArg(
    "--pairing-secret",
    process.env.ZION_DEVICE_PAIRING_SECRET || ""
  );
  const pairingCode = readArg(
    "--pairing-code",
    process.env.ZION_DEVICE_PAIRING_CODE || ""
  );
  if ((!pairingId || !pairingSecret) && !pairingCode) {
    throw new Error(
      "Device credential is unavailable; provide ZION_DEVICE_TOKEN or "
      + "--pairing-code"
    );
  }
  const paired = await exchangeDevicePairing({
    runtimeUrl,
    pairingId,
    secret: pairingSecret,
    userCode: pairingCode,
    device: {
      deviceId: nodeId,
      label: machineName,
      platform: process.platform
    }
  });
  token = paired.credential;
  await credentialStore.set(credentialKey, {
    credential: token,
    credentialId: paired.credentialId,
    expiresAt: paired.expiresAt,
    deviceId: nodeId,
    runtimeUrl
  });
}
const dataFiles = createPluginDataFileHost({
  root: pluginDataRoot
});
const toolHost = new LocalToolsDeviceHost({
  baseUrl: localToolsUrl,
  dataFiles,
  additionalRoots,
  allowDangerousCommands: enabledFlag(process.env.ZION_ALLOW_DANGEROUS),
  accessPolicyProvider: ({ invocation }) =>
    deviceAccess.authorizeInvocation(invocation),
  resourceBindings: {
    [resourceId]: {
      root: workspaceRoot,
      allowedTerminalSessionIds: terminalSessionIds
    }
  }
});
await toolHost.assertHealthy();
const serviceHost = new DeviceServiceHost({
  localToolsUrl,
  pluginServiceUrl,
  deviceAccess,
  dataFiles,
  maxRequestBytes: deviceServiceMaxRequestBytes
});

const connector = new DeviceConnector({
  runtimeUrl,
  token,
  registration: {
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    nodeId,
    instanceId: `instance:${randomUUID()}`,
    label: machineName,
    platform: process.platform,
    capabilities: [
      ...LOCAL_TOOLS_TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        version: "1",
        risk: ["write", "edit"].includes(tool.name)
          ? "write"
          : tool.name === "sendMail"
            ? "external-effect"
            : ["Bash", "mcpCall"].includes(tool.name)
              ? "execute"
              : "read",
        description: tool.description,
        inputSchema: tool.inputSchema,
        hostKind: "local-tools"
      })),
      { ...DEVICE_SERVICE_CAPABILITY, version: "2" }
    ],
    resources: [{
      resourceId,
      kind: "workspace",
      projectId,
      label: projectId
    }]
  },
  toolHost,
  serviceHost,
  logger({ level, nodeId: sourceNodeId, message }) {
    process.stderr.write(
      `[device-connector:${sourceNodeId}] ${level}: ${message}\n`
    );
  }
});
await connector.start();

process.stdout.write(
  `Zion Device Connector ${nodeId} connected to ${runtimeUrl} `
  + `(local-tools=${localToolsUrl})\n`
);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await connector.stop();
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
