import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NodeBroker } from "../../src/node-broker.mjs";
import { createNodeHttpHandler } from "../../src/node-http-handler.mjs";
import { createDeviceServiceHttpHandler } from "../../src/device-service-http-handler.mjs";
import { createTerminalManagementService } from "../../src/terminal-management-service.mjs";
import { DeviceConnector } from "../../../device-connector/src/device-connector.mjs";
import { DeviceServiceHost, DEVICE_SERVICE_CAPABILITY } from "../../../device-connector/src/device-service-host.mjs";
import { LocalToolsDeviceHost, LOCAL_TOOLS_TOOL_DEFINITIONS } from "../../../../packages/local-tools-client/src/index.mjs";
import { createPluginDataFileHost } from "../../../../packages/local-tools-client/src/plugin-data-files.mjs";

const execFileAsync = promisify(execFile);

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

async function listen(handler, servers) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response, new URL(request.url, "http://fixture")))
      .catch((error) => json(response, 500, { error: error.message }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

export async function startMultiNodeFixture({ pluginData = false } = {}) {
  const servers = [];
  const root = await mkdtemp(join(tmpdir(), "zion-multi-node-"));
  const broker = new NodeBroker({ invocationLeaseMs: 5000 });
  const terminalService = createTerminalManagementService({ nodeBroker: broker });
  const nodeHandler = createNodeHttpHandler({ broker, token: "fixture-only", maxWaitMs: 50 });
  const relay = createDeviceServiceHttpHandler({ broker, terminalService });
  const url = await listen(async (request, response, parsed) => {
    if (await nodeHandler(request, response, parsed)) return;
    if (await relay(request, response, parsed)) return;
    json(response, 404, { error: "fixture endpoint not found" });
  }, servers);
  const nodes = [];
  for (const name of ["mac", "cloud"]) {
    const directory = await mkdtemp(join(root, `${name}-`));
    await writeFile(join(directory, "README.md"), `${name} original`, "utf8");
    const calls = [];
    const sessions = new Map([["same-terminal", {
      id: "same-terminal", type: "local", cwd: directory, active: true
    }]]);
    const localUrl = await listen(async (request, response, parsed) => {
      const payload = request.method === "GET" ? Object.fromEntries(parsed.searchParams) : await body(request);
      calls.push({ path: parsed.pathname, method: request.method, payload });
      if (parsed.pathname === "/health") return json(response, 200, { ok: true });
      if (pluginData && parsed.pathname === "/bash") {
        const result = await execFileAsync("bash", ["-c", payload.command], { cwd: directory });
        return json(response, 200, { output: result.stdout });
      }
      if (parsed.pathname === "/machines") return json(response, 200, { machines: [] });
      if (parsed.pathname === "/sessions") {
        if (request.method === "POST") {
          const session = { id: `created-${sessions.size}`, type: payload.type || "local", cwd: payload.initial_cwd || directory, active: true };
          sessions.set(session.id, session);
          return json(response, 200, { session });
        }
        return json(response, 200, { sessions: [...sessions.values()] });
      }
      const sessionPath = parsed.pathname.match(/^\/sessions\/([^/]+)(\/exec)?$/);
      if (sessionPath) {
        const id = decodeURIComponent(sessionPath[1]);
        const session = sessions.get(id);
        if (!session) return json(response, 404, { error: "Unknown native session" });
        if (request.method === "DELETE") {
          sessions.delete(id);
          return json(response, 200, { closed: true });
        }
        if (sessionPath[2]) {
          if (payload.command !== "pwd") return json(response, 400, { error: "Fixture only executes pwd" });
          const result = await execFileAsync(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: directory });
          return json(response, 200, { output: result.stdout });
        }
        return json(response, 200, { session });
      }
      if (parsed.pathname.startsWith("/files/")) {
        if (!sessions.has(payload.session_id)) return json(response, 404, { error: "Unknown native session" });
        const path = resolve(directory, payload.path || "");
        if (relative(directory, path).startsWith("..")) return json(response, 403, { error: "Outside fixture" });
        if (parsed.pathname === "/files/read") return json(response, 200, { content: await readFile(path, "utf8") });
        if (parsed.pathname === "/files/write") await writeFile(path, payload.content);
        else if (parsed.pathname === "/files/edit") {
          const previous = await readFile(path, "utf8");
          await writeFile(path, previous.replace(payload.old_string, payload.new_string));
        } else return json(response, 404, { error: "Unsupported file endpoint" });
        return json(response, 200, { ok: true });
      }
      json(response, 404, { error: "Unknown endpoint" });
    }, servers);
    const nodeId = `node:${name}`;
    const instanceId = `instance:${name}`;
    const resourceId = `workspace:${name}`;
    const dataFiles = pluginData ? createPluginDataFileHost({ root: directory }) : null;
    const toolHost = new LocalToolsDeviceHost({
      baseUrl: localUrl,
      dataFiles,
      resourceBindings: { [resourceId]: { root: directory, allowedTerminalSessionIds: pluginData ? [] : ["same-terminal"] } }
    });
    const serviceHost = new DeviceServiceHost({
      localToolsUrl: localUrl,
      dataFiles,
      deviceAccess: {
        state: async () => ({ allowedTerminalSessionIds: [...sessions.keys()] }),
        async authorizeInvocation(input) {
          const id = input.toolCall.arguments.session_id;
          if (id && !sessions.has(id)) throw new Error("Outside fixture grant");
        }
      }
    });
    const connector = new DeviceConnector({
      runtimeUrl: url, token: "fixture-only", toolHost, serviceHost,
      pollWaitMs: 25,
      registration: {
        protocolVersion: 1, nodeId, instanceId, label: `Test ${name}`,
        capabilities: [...LOCAL_TOOLS_TOOL_DEFINITIONS, {
          ...DEVICE_SERVICE_CAPABILITY, version: pluginData ? "2" : "1"
        }],
        resources: [{ resourceId, kind: "workspace", projectId: "fixture" }]
      }
    });
    await connector.start();
    nodes.push({ name, nodeId, instanceId, resourceId, directory, calls, connector });
  }
  return {
    url, broker, terminalService, nodes,
    async close() {
      await Promise.all(nodes.map((node) => node.connector.stop()));
      broker.close();
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await rm(root, { recursive: true, force: true });
    }
  };
}
