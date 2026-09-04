import { Buffer } from "node:buffer";

const MAX_REQUEST_BYTES = 64 * 1024;

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
      const error = new Error("Project Automation request exceeds 64 KiB");
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

function matchProjectAction(pathname) {
  const match = pathname.match(
    /^\/v1\/project-automation\/projects\/([^/]+)\/(run|stop)$/
  );
  return match
    ? {
        projectKey: decodeURIComponent(match[1]),
        action: match[2]
      }
    : null;
}

export function createProjectAutomationHttpHandler({ service } = {}) {
  if (!service?.runNow || !service?.stopProject || !service?.readDocument) {
    throw new Error("Project Automation HTTP handler requires a coordinator service");
  }

  return async (request, response, url) => {
    if (!url.pathname.startsWith("/v1/project-automation")) return false;

    if (request.method === "GET" && url.pathname === "/v1/project-automation") {
      json(response, 200, {
        automation: service.readDocument(),
        running: service.running === true
      });
      return true;
    }

    const target = matchProjectAction(url.pathname);
    if (target && request.method === "POST") {
      const body = await readJson(request);
      const result = target.action === "run"
        ? await service.runNow(target.projectKey, {
            interactionProfileId: body.interaction_profile_id
          })
        : await service.stopProject(target.projectKey, body.reason || "user");
      json(response, 200, result);
      return true;
    }

    json(response, 404, { error: "Project Automation endpoint not found" });
    return true;
  };
}
