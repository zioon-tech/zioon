import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { SqliteWorkbenchStateStore } from "../apps/runtime/src/sqlite-workbench-state-store.mjs";
import { createWorkbenchStateHttpHandler } from "../apps/runtime/src/workbench-state-http-handler.mjs";
import { createWorkbenchStaticHttpHandler } from "../apps/runtime/src/workbench-static-http-handler.mjs";
import { createRuntimeCollaborationService } from "../apps/runtime/src/collaboration-service.mjs";

const store = new SqliteWorkbenchStateStore(":memory:");
const counts = new Map();
const replayRun = process.env.RUN_REPLAY === "1";
const runId = "reload-fixture-run";
let runCompleted = false;
for (let index = 0; index < 82; index++) {
  store.createSession({
    id: `reload-${index}`, text: `user Session ${index}\nassistant Complete history ${index}\n`,
    meta: {
      title: `Reload test ${index}`, titleAuto: false, documentPreviewVersion: 1,
      annotations: { tools: [{ id: `tool-${index}`, result: "full-history-result ".repeat(8500) }] }
    }
  });
}
const handler = createWorkbenchStateHttpHandler({ store, eventHeartbeatMs: 1000 });
const staticRoot = ".deploy-tmp/workbench-reload/dist";
const staticHandler = await createWorkbenchStaticHttpHandler({ root: staticRoot });
const collaboration = createRuntimeCollaborationService({ store });
let failCatalog = process.env.FAIL_CATALOG === "1";
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  const path = url.pathname;
  if (path === "/") {
    const html = await readFile(`${staticRoot}/index.html`, "utf8");
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(html.replace("<head>", '<head><script src="/reload-config.js"></script>'));
    return;
  }
  if (path === "/reload-config.js") {
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(`
localStorage.setItem("zion.runtime.mode","runtime");
localStorage.setItem("zion.runtime.baseUrl",location.origin);
`);
    return;
  }
  if (path === "/reload-recover") { failCatalog = false; response.end("ok"); return; }
  if (!path.startsWith("/v1/") && path !== "/health" && path !== "/reload-metrics") {
    if (await staticHandler(request, response, url)) return;
  }
        counts.set(path, (counts.get(path) || 0) + 1);
        const json = (value, status = 200) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        try {
          if (failCatalog && path.endsWith("/catalog")) return json({ error: "fixture offline" }, 503);
          if (await handler(request, response, url)) return;
          if (replayRun && path === `/v1/runs/${runId}`) return json({
            run: {
              id: runId, sessionId: "reload-81", status: runCompleted ? "completed" : "running",
              output: "Canonical complete answer", attemptId: "fixture-attempt", startedAt: Date.now() - 1000
            }
          });
          if (replayRun && path === `/v1/runs/${runId}/projection/stream`) {
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const events = [
              ["run.started", {}],
              ["reasoning.started", { turn: 1 }],
              ["reasoning.delta", { turn: 1, delta: "Thinking once." }],
              ["reasoning.completed", { turn: 1 }],
              ["tool.requested", { callId: "call-1", name: "read", args: { path: "fixture" } }],
              ["tool.completed", { callId: "call-1", result: "replayed-result" }],
              ["message.completed", { content: "Canonical complete answer" }],
              ["run.completed", {}]
            ];
            for (let index = 0; index < events.length; index++) {
              if (index === 5) await new Promise((resolve) => setTimeout(resolve, 3000));
              const event = { runId, sequence: index + 1, type: events[index][0], data: events[index][1], ts: Date.now() };
              if (event.sequence > Number(url.searchParams.get("after"))) {
                response.write(`id: ${event.sequence}\nevent: run.event\ndata: ${JSON.stringify(event)}\n\n`);
              }
            }
            runCompleted = true;
            response.end();
            return;
          }
          if (path === "/health") return json({ service: "zion-runtime", ok: true, authRequired: false });
          if (path === "/reload-metrics") return json({
            counts: Object.fromEntries(counts),
            snapshotBytes: Buffer.byteLength(JSON.stringify(store.readSnapshot())),
            catalogBytes: Buffer.byteLength(JSON.stringify(store.readCatalog()))
          });
          if (path.endsWith("/active-run")) return json({
            activeRun: replayRun && path.includes("/reload-81/")
              ? { runId, status: "running", attemptId: "fixture-attempt" } : null
          });
          if (path === "/v1/device-nodes") return json({ nodes: [] });
          if (path.includes("/sessions")) return json({ sessions: [] });
          if (path.includes("/project-automation")) return json({ document: { version: 1, projects: {}, requests: [] } });
          if (path.includes("/capabilities")) return json({ capabilities: [], tools: [] });
          if (path.includes("/profiles")) return json({ profiles: [] });
          if (path.includes("/plugins")) return json({ data: { plugins: [], sessions: [] } });
          json({ error: "Isolated reload fixture endpoint" }, 404);
        } catch (error) {
          if (!response.headersSent) json({ error: error.message }, 500);
        }
});
server.on("upgrade", (request, socket, head) => {
  if (!collaboration.handleUpgrade(request, socket, head)) socket.destroy();
});
const port = Number(process.env.PORT || 5197);
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
process.stdout.write(`Isolated Workbench: http://127.0.0.1:${port}\n`);
process.once("SIGINT", async () => {
  await collaboration.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  store.close();
  process.exit(0);
});
