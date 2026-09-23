import { Buffer } from "node:buffer";
import { parseByteSize, requestBodyLimitError } from "../../../packages/node-protocol/src/index.mjs";

const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function errorPayload(error) {
  const payload = { error: error?.message || String(error) };
  if (error?.code) payload.code = String(error.code);
  if (Number.isSafeInteger(error?.limitBytes)) payload.limitBytes = error.limitBytes;
  if (error?.limit) payload.limit = String(error.limit);
  if (Array.isArray(error?.hints)) payload.hints = error.hints.map(String);
  return payload;
}

async function readJson(request, maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      throw requestBodyLimitError("Scheduler request", maxRequestBytes);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function matchTaskPath(pathname, suffix = "") {
  const escapedSuffix = suffix.replaceAll("/", "\\/");
  const match = pathname.match(
    new RegExp(`^\\/v1\\/scheduler\\/tasks\\/([^/]+)${escapedSuffix}$`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function matchRunPath(pathname, suffix = "") {
  const escapedSuffix = suffix.replaceAll("/", "\\/");
  const match = pathname.match(
    new RegExp(`^\\/v1\\/scheduler\\/runs\\/([^/]+)${escapedSuffix}$`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function limitRunEvents(run, requestedLimit) {
  const limit = Math.max(0, Math.min(200, Number(requestedLimit) || 0));
  if (!limit || !Array.isArray(run?.events)) return run;
  return {
    ...run,
    eventCount: run.events.length,
    events: run.events.slice(-limit),
    eventsTruncated: run.events.length > limit
  };
}

export function createSchedulerHttpHandler({
  scheduler,
  abortRun,
  wakeWorker,
  availableTools,
  availableModels,
  availableNodes,
  authorizeTask = null,
  onTaskChanged = null,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES
}) {
  if (!scheduler?.listTasks || !scheduler?.claim) {
    throw new Error("Scheduler HTTP handler requires a Scheduler store");
  }
  const requestBodyLimit = parseByteSize(maxRequestBytes, {
    label: "Scheduler request body limit"
  });

  const refreshAvailableTools = () => {
    if (typeof availableTools === "function") {
      scheduler.setAvailableTools(availableTools());
    }
    if (typeof availableModels === "function") {
      scheduler.setAvailableModels(availableModels());
    }
    if (typeof availableNodes === "function") {
      scheduler.setAvailableNodes(availableNodes());
    }
  };

  return async (request, response, url) => {
    try {
      const path = url.pathname;
      if (!path.startsWith("/v1/scheduler")) return false;

      if (request.method === "GET" && path === "/v1/scheduler/tasks") {
        json(response, 200, { tasks: await scheduler.listTasks() });
        return true;
      }
      if (request.method === "POST" && path === "/v1/scheduler/tasks") {
        refreshAvailableTools();
        const body = await readJson(request, requestBodyLimit);
        delete body.executionPrincipal;
        const input = authorizeTask ? await authorizeTask(request.zionPrincipal, body) : body;
        json(response, 201, await scheduler.createTask(input));
        return true;
      }

      const runNowTaskId = matchTaskPath(path, "/run");
      if (runNowTaskId != null && request.method === "POST") {
        const run = await scheduler.runNow(runNowTaskId);
        wakeWorker?.();
        json(response, 200, run);
        return true;
      }
      const taskId = matchTaskPath(path);
      if (taskId != null && request.method === "GET") {
        json(response, 200, await scheduler.getTask(taskId));
        return true;
      }
      if (taskId != null && request.method === "PUT") {
        refreshAvailableTools();
        const body = await readJson(request, requestBodyLimit);
        delete body.executionPrincipal;
        const previous = await scheduler.getTask(taskId);
        const input = authorizeTask ? await authorizeTask(request.zionPrincipal, {
          ...previous, ...body,
          capability: { ...previous.capability, ...body.capability }
        }) : body;
        const updated = await scheduler.updateTask(taskId, input);
        await onTaskChanged?.(previous);
        json(response, 200, updated);
        return true;
      }
      if (taskId != null && request.method === "DELETE") {
        const previous = await scheduler.getTask(taskId);
        await scheduler.deleteTask(taskId);
        await onTaskChanged?.(previous);
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return true;
      }

      if (request.method === "GET" && path === "/v1/scheduler/runs") {
        json(response, 200, await scheduler.listRuns({
          taskId: url.searchParams.get("task_id") || "",
          limit: url.searchParams.get("limit"),
          offset: url.searchParams.get("offset"),
          includeDetails: url.searchParams.get("include_details") === "true"
        }));
        return true;
      }
      const cancelRunId = matchRunPath(path, "/cancel");
      if (cancelRunId != null && request.method === "POST") {
        const body = await readJson(request, requestBodyLimit);
        await abortRun?.(cancelRunId, body.reason || "user");
        json(response, 200, await scheduler.cancel(cancelRunId, body.reason || "user"));
        return true;
      }
      const runId = matchRunPath(path);
      if (runId != null && request.method === "GET") {
        json(response, 200, limitRunEvents(
          await scheduler.getRun(runId),
          url.searchParams.get("event_limit")
        ));
        return true;
      }

      json(response, 404, { error: "Scheduler endpoint not found" });
      return true;
    } catch (error) {
      if (!response.headersSent) {
        json(response, Number(error?.statusCode || 500), errorPayload(error));
      } else {
        response.end();
      }
      return true;
    }
  };
}
