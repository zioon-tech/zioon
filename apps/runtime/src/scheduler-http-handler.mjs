import { Buffer } from "node:buffer";

const MAX_REQUEST_BYTES = 1024 * 1024;

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error("Scheduler request exceeds 1 MiB");
      error.statusCode = 413;
      throw error;
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
  availableNodes
}) {
  if (!scheduler?.listTasks || !scheduler?.claim) {
    throw new Error("Scheduler HTTP handler requires a Scheduler store");
  }

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
    const path = url.pathname;
    if (!path.startsWith("/v1/scheduler")) return false;

    if (request.method === "GET" && path === "/v1/scheduler/tasks") {
      json(response, 200, { tasks: scheduler.listTasks() });
      return true;
    }
    if (request.method === "POST" && path === "/v1/scheduler/tasks") {
      refreshAvailableTools();
      json(response, 201, scheduler.createTask(await readJson(request)));
      return true;
    }

    const runNowTaskId = matchTaskPath(path, "/run");
    if (runNowTaskId != null && request.method === "POST") {
      const run = scheduler.runNow(runNowTaskId);
      wakeWorker?.();
      json(response, 200, run);
      return true;
    }
    const taskId = matchTaskPath(path);
    if (taskId != null && request.method === "GET") {
      json(response, 200, scheduler.getTask(taskId));
      return true;
    }
    if (taskId != null && request.method === "PUT") {
      refreshAvailableTools();
      json(response, 200, scheduler.updateTask(taskId, await readJson(request)));
      return true;
    }
    if (taskId != null && request.method === "DELETE") {
      scheduler.deleteTask(taskId);
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return true;
    }

    if (request.method === "GET" && path === "/v1/scheduler/runs") {
      json(response, 200, scheduler.listRuns({
        taskId: url.searchParams.get("task_id") || "",
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
        includeDetails: url.searchParams.get("include_details") === "true"
      }));
      return true;
    }
    const cancelRunId = matchRunPath(path, "/cancel");
    if (cancelRunId != null && request.method === "POST") {
      const body = await readJson(request);
      await abortRun?.(cancelRunId, body.reason || "user");
      json(response, 200, scheduler.cancel(cancelRunId, body.reason || "user"));
      return true;
    }
    const runId = matchRunPath(path);
    if (runId != null && request.method === "GET") {
      json(response, 200, limitRunEvents(
        scheduler.getRun(runId),
        url.searchParams.get("event_limit")
      ));
      return true;
    }

    json(response, 404, { error: "Scheduler endpoint not found" });
    return true;
  };
}
