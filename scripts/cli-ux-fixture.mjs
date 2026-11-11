// Deterministic local Runtime for process/PTY regression; never contacts a model.
import { createServer } from "node:http";
const sessions = new Map([["s-travel", { id: "s-travel", title: "苏州旅行计划" }]]);
const transcripts = new Map();
const runs = new Map();
const acceptedCommands = new Map();
const state = { prompts: [], aborts: 0, uploads: [], uploadAttempts: 0, sends: [] };
let control = {};
const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if (url.pathname === "/v1/assets" && req.method === "POST") {
    state.uploadAttempts++;
    if (control.failUpload === state.uploadAttempts) return json(res, { error: "Upload temporarily unavailable" }, 503);
    const asset = { uri: `zion-asset://fixture_${state.uploadAttempts}`, id: `fixture_${state.uploadAttempts}`, state: "ready" };
    state.uploads.push({ ...asset, name: decodeURIComponent(req.headers["x-zion-file-name"] || ""), mediaType: req.headers["content-type"], bytes: bytes.toString("base64") });
    return json(res, { asset }, 201);
  }
  const raw = bytes.toString();
  const body = raw ? JSON.parse(raw) : {};
  if (url.pathname === "/__control") { control = { ...control, ...body }; return json(res, control); }
  if (url.pathname === "/__state") return json(res, state);
  if (url.pathname === "/v1/models") return json(res, { activeProfileId: "fast", profiles: [
    { id: "fast", label: "Fast", credentialRequired: true, credentialConfigured: true, capabilities: { supportsImage: false } },
    { id: "smart", label: "Smart", credentialRequired: true, credentialConfigured: true, capabilities: { supportsImage: true } },
    { id: "missing", label: "Missing credentials", credentialRequired: true, credentialConfigured: false }
  ] });
  if (url.pathname.includes("/plugins/")) return json(res, { result: { status: "completed", initialTokens: 1000, finalTokens: 500 } });
  if (url.pathname === "/v1/sessions" && req.method === "POST") {
    const session = { ...body, id: `s-${sessions.size}`, title: body.title || "CLI preview" };
    sessions.set(session.id, session); return json(res, { session });
  }
  if (url.pathname === "/v1/sessions") return json(res, { sessions: [...sessions.values()] });
  if (parts[1] === "sessions") {
    const sessionId = parts[2];
    if (req.method === "PATCH") {
      Object.assign(sessions.get(sessionId), body); return json(res, { session: sessions.get(sessionId) });
    }
    if (parts[3] === "transcript") return json(res, { messages: transcripts.get(sessionId) || [] });
    if (parts[3] === "active-run") {
      const active = [...runs.values()].find((run) => run.sessionId === sessionId && run.status === "running");
      return json(res, { activeRun: active ? { runId: active.id, status: active.status } : null });
    }
    if (parts[3] === "messages") {
      state.sends.push(body);
      if (control.rejectNext) { control.rejectNext = false; return json(res, { error: "Invalid request" }, 422); }
      if (body.clientRequestId && acceptedCommands.has(body.clientRequestId)) return json(res, acceptedCommands.get(body.clientRequestId));
      state.prompts.push(body.content);
      const id = `r-${runs.size + 1}`;
      const slow = body.content === "slow";
      const failed = Boolean(control.failRunNext); control.failRunNext = false;
      const run = { id, sessionId, status: failed ? "failed" : slow ? "running" : "completed", events: [],
        ...(failed ? { error: "Model only accepts text" } : {}) };
      const text = `## Preview response\n\n已收到：${body.content}\n\n- Streaming output\n- Session continuity\n\n\`\`\`js\nconsole.log("ready");\n\`\`\`\n`;
      if (!slow && !failed) run.events.push(
        { sequence: 1, type: "tool.requested", data: { toolName: "inspect_workspace", toolCallId: "call-1", arguments: { path: "/workspace" } } },
        { sequence: 2, type: "tool.completed", data: { toolCallId: "call-1", result: "workspace ready" } },
        ...Array.from(text, (delta, i) => ({ sequence: i + 3, type: "message.delta", data: { delta } })),
        { sequence: Array.from(text).length + 3, type: "run.completed", data: {} }
      );
      if (Array.isArray(control.events)) run.events = control.events.map((event, i) => ({ ...event, sequence: i + 1 }));
      runs.set(id, run);
      const messages = transcripts.get(sessionId) || [];
      messages.push({ role: "user", content: body.content, clientRequestId: body.clientRequestId, runId: id });
      if (!failed) messages.push({ role: "assistant", content: text });
      transcripts.set(sessionId, messages);
      const accepted = { runId: id, status: "accepted" };
      if (body.clientRequestId) acceptedCommands.set(body.clientRequestId, accepted);
      if (body.content === "lose-response" || control.loseNext) { control.loseNext = false; res.destroy(); return; }
      return json(res, accepted);
    }
    return json(res, { session: sessions.get(sessionId) });
  }
  if (parts[1] === "runs") {
    const run = runs.get(parts[2]);
    if (!run) return json(res, { error: "Unknown Run" }, 404);
    if (parts[3] === "abort") {
      state.aborts++; run.status = "aborted"; run.events.push({ sequence: 1, type: "run.aborted", data: {} });
      return json(res, { runId: run.id, status: "accepted" });
    }
    if (parts.at(-1) === "stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      const events = run.events.filter((e) => e.sequence > Number(url.searchParams.get("after") || 0));
      const timer = setInterval(() => {
        const event = events.shift();
        if (event) res.write(`data: ${JSON.stringify(event)}\n\n`);
        else if (run.status !== "running") { clearInterval(timer); res.end(); }
      }, Math.max(1, Number(control.eventDelayMs) || 2));
      res.on("close", () => clearInterval(timer)); return;
    }
    if (parts[3] === "projection" || parts[3] === "events") return json(res, { events: run.events.filter((e) => e.sequence > Number(url.searchParams.get("after") || 0)) });
    return json(res, { run: { id: run.id, status: run.status, ...(run.error ? { error: run.error } : {}) } });
  }
  json(res, { error: "Not found" }, 404);
});
server.listen(0, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}`));
process.on("SIGTERM", () => { server.closeAllConnections(); server.close(); });
