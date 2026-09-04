import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import process from "node:process";
import {
  LOCAL_TOOLS_TOOL_DEFINITIONS,
  LocalToolsDeviceHost
} from "../../../packages/local-tools-client/src/index.mjs";
import { DEVICE_PROTOCOL_VERSION } from "../../../packages/node-protocol/src/index.mjs";
import { DeviceConnector } from "./device-connector.mjs";

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

const runtimeUrl = readArg(
  "--runtime-url",
  process.env.ZION_RUNTIME_URL || "http://127.0.0.1:8766"
);
const localToolsUrl = readArg(
  "--local-tools-url",
  process.env.ZION_LOCAL_TOOLS_URL || "http://127.0.0.1:8765"
);
const token = process.env.ZION_DEVICE_TOKEN || "";
if (!token) {
  throw new Error("ZION_DEVICE_TOKEN is required");
}

const machineName = hostname();
const nodeId = readArg(
  "--node-id",
  process.env.ZION_NODE_ID || nodeIdFromHostname(machineName)
);
const projectId = readArg(
  "--project-id",
  process.env.ZION_NODE_PROJECT_ID || ""
);
const resourceId = readArg(
  "--resource-id",
  process.env.ZION_NODE_RESOURCE_ID
    || (projectId ? `workspace:${projectId}` : "")
);
const workspaceRoot = readArg(
  "--workspace-root",
  process.env.ZION_NODE_WORKSPACE_ROOT || ""
);
const terminalSessionIds = parseList(readArg(
  "--terminal-sessions",
  process.env.ZION_NODE_TERMINAL_SESSION_IDS || ""
));
if (!projectId || !resourceId || !workspaceRoot || !terminalSessionIds.length) {
  throw new Error(
    "Device Connector requires project id, resource id, workspace root, "
    + "and at least one terminal session"
  );
}
const toolHost = new LocalToolsDeviceHost({
  baseUrl: localToolsUrl,
  resourceBindings: {
    [resourceId]: {
      root: workspaceRoot,
      allowedTerminalSessionIds: terminalSessionIds
    }
  }
});
await toolHost.assertHealthy();

const connector = new DeviceConnector({
  runtimeUrl,
  token,
  registration: {
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    nodeId,
    instanceId: `instance:${randomUUID()}`,
    label: machineName,
    platform: process.platform,
    capabilities: LOCAL_TOOLS_TOOL_DEFINITIONS.map((tool) => ({
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
    resources: [{
      resourceId,
      kind: "workspace",
      projectId,
      label: projectId
    }]
  },
  toolHost,
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
