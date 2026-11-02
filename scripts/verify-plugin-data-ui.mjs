import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import process from "node:process";
import { URL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createPluginDataFileHost } from "../packages/local-tools-client/src/plugin-data-files.mjs";

const root = await mkdtemp(join(tmpdir(), "zion-plugin-data-ui-"));
const data = { nodeId: "fixture-cloud", root: join(root, "dev.identity") };
const files = createPluginDataFileHost({ root });
await files.handle("write", { path: join(data.root, "user.md"), content: "# User\n\nBrowser verification fixture.\n" });
await files.handle("write", { path: join(data.root, "projects/example/project.md"), content: "# Example\n\nStatus: active\n" });
await files.handle("append-jsonl", { path: join(data.root, "biography/events.jsonl"), records: [{ id: "fixture-event", summary: "Saved on the server" }] });
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === "/health") return send(200, { ok: true, service: "zion-runtime", authRequired: false });
    if (url.pathname === "/v1/plugins/dev.identity/locations") return send(200, { data });
    if (url.pathname.startsWith("/v1/workbench-state/kv/")) return send(200, { value: {} });
    if (url.pathname.startsWith("/v1/device-services/local-tools/files/")) {
      if (url.searchParams.get("node_id") !== data.nodeId) return send(403, { error: "Wrong Node" });
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const args = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : Object.fromEntries(url.searchParams);
      const result = await files.handle(url.pathname.split("/").at(-1), args);
      return send(result ? 200 : 404, result || { error: "Unknown fixture file" });
    }
    return send(404, { error: "Fixture route not found" });
  } catch (error) {
    send(error.statusCode || 500, { error: error.message });
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const requestedPort = process.argv[2] || "5286";
const vite = spawn("npm", ["run", "dev:mobile", "--", "--host", "127.0.0.1", "--port", requestedPort], {
  stdio: "inherit",
  env: { ...process.env, ZION_MOBILE_RUNTIME_URL: `http://127.0.0.1:${server.address().port}` }
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  vite.kill("SIGTERM");
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
vite.on("exit", () => void close());
