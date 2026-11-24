import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";

const context = new AsyncLocalStorage();
const recent = [];
const samplingKey = randomUUID();
const safeHeader = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,64}$/.test(value) ? value : "";
const round = value => Math.round(value * 10) / 10;

export async function measureRequestStage(name, action) {
  const current = context.getStore();
  if (!current) return action();
  const started = performance.now();
  try { return await action(); }
  finally { current.stages[name] = (current.stages[name] || 0) + performance.now() - started; }
}

export function requestPerformanceSnapshot(spaceId) {
  return recent.filter(item => spaceId === undefined || item.spaceId === spaceId)
    .map(({ spaceId: _spaceId, ...item }) => ({ ...item, stages: { ...item.stages } }));
}

export function withRequestPerformance(request, response, action) {
  const path = String(request.url || "").split("?")[0];
  if (!path.startsWith("/v1/workbench-state")) return action();
  const started = performance.now();
  const current = {
    requestId: randomUUID(), method: request.method,
    navigationId: safeHeader(request.headers?.["x-zion-navigation-id"]),
    source: safeHeader(request.headers?.["x-zion-read-source"]) || "unspecified",
    startedAt: Date.now(),
    path: path.replace(/(\/sessions\/)[^/]+/, "$1:id")
      .replace(/(\/tree\/folders\/)[^/]+/, "$1:id")
      .replace(/(\/kv\/).+/, "$1:key"),
    stages: {}
  };
  const writeHead = response.writeHead;
  let recorded = false;
  response.writeHead = function (...args) {
    if (!recorded) {
      recorded = true;
      current.stages.runtime = performance.now() - started;
      const stages = Object.fromEntries(Object.entries(current.stages).map(([key, value]) => [key, round(value)]));
      this.setHeader("server-timing", Object.entries(stages).map(([key, value]) => `${key};dur=${value}`).join(", "));
      this.setHeader("x-zion-request-id", current.requestId);
      if (current.navigationId || current.method !== "GET" || stages.runtime >= 1000) {
        const spaceId = request.zionPrincipal?.spaceId || request.zionPrincipal?.space?.id || "";
        const documentPath = path.match(/^\/v1\/workbench-state\/sessions\/([^/]+)/)?.[1];
        const row = { ...current, stages, status: Number(args[0]), timestamp: Date.now(), spaceId,
          ...(documentPath ? { documentKey: createHmac("sha256", samplingKey)
            .update(`${spaceId}\0${documentPath}`).digest("hex").slice(0, 16) } : {}) };
        recent.push(row);
        response.once?.("finish", () => { row.responseMs = round(performance.now() - started); });
        if (recent.length > 256) recent.shift();
      }
    }
    return writeHead.apply(this, args);
  };
  return context.run(current, action);
}
