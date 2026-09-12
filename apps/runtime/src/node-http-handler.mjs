import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function noContent(response) {
  response.writeHead(204, {
    "cache-control": "no-store"
  });
  response.end();
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error("Request body exceeds 1 MiB");
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

function bearerToken(request) {
  const value = String(request.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function tokenMatches(actual, expected) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function pathMatch(pathname, suffix) {
  const escaped = suffix.replaceAll("/", "\\/");
  const match = pathname.match(
    new RegExp(`^\\/v1\\/device-nodes\\/([^/]+)${escaped}$`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function resultPathMatch(pathname) {
  const match = pathname.match(
    /^\/v1\/device-nodes\/([^/]+)\/invocations\/([^/]+)\/result$/
  );
  return match
    ? {
        nodeId: decodeURIComponent(match[1]),
        invocationId: decodeURIComponent(match[2])
      }
    : null;
}

export function createNodeHttpHandler({
  broker,
  token,
  authorize,
  maxWaitMs = 25_000
}) {
  const expectedToken = String(token || "");
  if (!broker?.registerNode || !broker?.nextCommand) {
    throw new Error("Node Broker is required");
  }
  if (!expectedToken && typeof authorize !== "function") {
    throw new Error("Device node authentication is required");
  }

  const authorizeRequest = async (request, nodeId, operation) => {
    if (
      expectedToken
      && tokenMatches(bearerToken(request), expectedToken)
    ) {
      return { legacy: true };
    }
    if (typeof authorize === "function") {
      return await authorize({ request, nodeId, operation });
    }
    const error = new Error("Invalid device node credential");
    error.statusCode = 401;
    throw error;
  };

  return async function handleNodeHttp(request, response, url) {
    if (!url.pathname.startsWith("/v1/device-nodes")) return false;

    try {
      if (request.method === "GET" && url.pathname === "/v1/device-nodes") {
        await authorizeRequest(request, "", "inspect");
        json(response, 200, broker.snapshot());
        return true;
      }

      if (request.method === "POST" && url.pathname === "/v1/device-nodes/register") {
        const body = await readJson(request);
        await authorizeRequest(request, body.nodeId, "connect");
        const node = broker.registerNode(body);
        json(response, 200, { node });
        return true;
      }

      const heartbeatNodeId = pathMatch(url.pathname, "/heartbeat");
      if (request.method === "POST" && heartbeatNodeId) {
        await authorizeRequest(request, heartbeatNodeId, "connect");
        const body = await readJson(request);
        const node = broker.heartbeat(heartbeatNodeId, body.instanceId);
        json(response, 200, { node });
        return true;
      }

      const nextNodeId = pathMatch(url.pathname, "/invocations/next");
      if (request.method === "GET" && nextNodeId) {
        const principal = await authorizeRequest(request, nextNodeId, "connect");
        const instanceId = url.searchParams.get("instanceId");
        const requestedWait = Number(url.searchParams.get("waitMs") || 0);
        const waitMs = Math.min(
          maxWaitMs,
          Math.max(0, Number.isFinite(requestedWait) ? requestedWait : 0)
        );
        const command = await broker.nextCommand(
          nextNodeId,
          instanceId,
          waitMs
        );
        if (!principal?.legacy) {
          try {
            await authorizeRequest(request, nextNodeId, "connect");
          } catch (error) {
            broker.disconnectNode?.(nextNodeId, instanceId);
            throw error;
          }
        }
        if (!command) {
          noContent(response);
        } else {
          json(response, 200, { command });
        }
        return true;
      }

      const resultPath = resultPathMatch(url.pathname);
      if (request.method === "POST" && resultPath) {
        await authorizeRequest(request, resultPath.nodeId, "connect");
        const body = await readJson(request);
        const receipt = broker.completeInvocation(
          resultPath.nodeId,
          body.instanceId,
          resultPath.invocationId,
          body.result
        );
        json(response, 200, receipt);
        return true;
      }

      json(response, 404, { error: "Device node endpoint not found" });
      return true;
    } catch (error) {
      if (!response.headersSent) {
        json(response, Number(error?.statusCode || 500), {
          error: error?.message || String(error)
        });
      } else {
        response.end();
      }
      return true;
    }
  };
}
