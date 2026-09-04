import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";

const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const DEFAULT_EVENT_POLL_INTERVAL_MS = 100;
const DEFAULT_EVENT_HEARTBEAT_MS = 15_000;

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
    if (size > MAX_SNAPSHOT_BYTES) {
      const error = new Error("Workbench state request exceeds 256 MiB");
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

function matchSessionPath(pathname, suffix = "") {
  const escapedSuffix = suffix.replaceAll("/", "\\/");
  const match = pathname.match(
    new RegExp(`^\\/v1\\/workbench-state\\/sessions\\/([^/]+)${escapedSuffix}$`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function matchKVPath(pathname) {
  const match = pathname.match(/^\/v1\/workbench-state\/kv\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function createWorkbenchStateHttpHandler({
  store,
  eventPollIntervalMs = DEFAULT_EVENT_POLL_INTERVAL_MS,
  eventHeartbeatMs = DEFAULT_EVENT_HEARTBEAT_MS
}) {
  if (!store?.readSnapshot || !store?.updateSession) {
    throw new Error("Workbench state HTTP handler requires a state store");
  }

  return async (request, response, url) => {
    const path = url.pathname;
    if (!path.startsWith("/v1/workbench-state")) return false;

    if (request.method === "GET" && path === "/v1/workbench-state/status") {
      json(response, 200, store.readStatus());
      return true;
    }
    if (request.method === "GET" && path === "/v1/workbench-state/snapshot") {
      const snapshot = store.readSnapshot();
      if (!snapshot) {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
      } else {
        json(response, 200, snapshot);
      }
      return true;
    }
    if (request.method === "GET" && path === "/v1/workbench-state/tree") {
      json(response, 200, store.readTree());
      return true;
    }
    if (request.method === "GET" && path === "/v1/workbench-state/events") {
      json(response, 200, store.listEvents(
        url.searchParams.get("after"),
        {
          limit: url.searchParams.get("limit"),
          sessionId: url.searchParams.get("session_id")
        }
      ));
      return true;
    }
    if (
      request.method === "GET"
      && path === "/v1/workbench-state/events/stream"
    ) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      response.flushHeaders?.();
      let closed = false;
      request.on("close", () => {
        closed = true;
      });
      let cursor = Math.max(
        0,
        Number(
          url.searchParams.get("after")
          || request.headers["last-event-id"]
          || 0
        ) || 0
      );
      const sessionId = String(url.searchParams.get("session_id") || "");
      let lastWriteAt = Date.now();
      while (!closed) {
        const feed = store.listEvents(cursor, {
          limit: 500,
          sessionId
        });
        if (feed.resetRequired) {
          response.write("event: reset\n");
          response.write(`data: ${JSON.stringify({
            reason: "cursor_expired",
            oldestSequence: feed.oldestSequence,
            latestSequence: feed.latestSequence
          })}\n\n`);
          response.end();
          return true;
        }
        for (const event of feed.events) {
          cursor = event.sequence;
          response.write(`id: ${event.sequence}\n`);
          response.write(`event: ${event.type}\n`);
          response.write(`data: ${JSON.stringify(event)}\n\n`);
          lastWriteAt = Date.now();
        }
        if (Date.now() - lastWriteAt >= eventHeartbeatMs) {
          response.write(`: heartbeat ${Date.now()}\n\n`);
          lastWriteAt = Date.now();
        }
        await delay(Math.max(25, Number(eventPollIntervalMs) || 100));
      }
      return true;
    }
    if (request.method === "PUT" && path === "/v1/workbench-state/snapshot") {
      const body = await readJson(request);
      json(response, 200, store.writeSnapshot(
        body.snapshot,
        body.expected_revision ?? null,
        body.source_client_id ?? ""
      ));
      return true;
    }
    if (request.method === "PUT" && path === "/v1/workbench-state/tree") {
      const body = await readJson(request);
      json(response, 200, store.writeTree(
        body.tree,
        body.index,
        body.expected_revision ?? null,
        body.source_client_id ?? ""
      ));
      return true;
    }
    if (
      request.method === "POST"
      && path === "/v1/workbench-state/migrate-browser-storage"
    ) {
      const body = await readJson(request);
      json(response, 200, store.migrateBrowserStorage(
        body.source_id,
        body.snapshot,
        body.fingerprint
      ));
      return true;
    }

    const key = matchKVPath(path);
    if (key != null && request.method === "GET") {
      const value = store.readKV(key);
      if (!value) {
        json(response, 404, { error: "key not found" });
      } else {
        json(response, 200, value);
      }
      return true;
    }
    if (key != null && request.method === "PUT") {
      const body = await readJson(request);
      json(response, 200, store.writeKV(key, body.value, {
        sourceClientId: body.source_client_id ?? ""
      }));
      return true;
    }

    const revisionsSessionId = matchSessionPath(path, "/revisions");
    if (revisionsSessionId != null && request.method === "GET") {
      json(response, 200, {
        session_id: revisionsSessionId,
        revisions: store.listSessionRevisions(revisionsSessionId)
      });
      return true;
    }
    const restoreSessionId = matchSessionPath(path, "/restore");
    if (restoreSessionId != null && request.method === "POST") {
      const body = await readJson(request);
      json(response, 200, store.restoreSessionRevision(
        restoreSessionId,
        body.revision,
        body.operation_id ?? null
      ));
      return true;
    }

    const sessionId = matchSessionPath(path);
    if (sessionId != null && request.method === "GET") {
      const session = store.readSession(sessionId);
      if (!session) {
        json(response, 404, { error: "session not found" });
      } else {
        json(response, 200, session);
      }
      return true;
    }
    if (sessionId != null && request.method === "PUT") {
      json(response, 200, store.updateSession(sessionId, await readJson(request)));
      return true;
    }
    if (sessionId != null && request.method === "DELETE") {
      json(response, 200, store.deleteSession(sessionId, await readJson(request)));
      return true;
    }

    json(response, 404, { error: "Workbench state endpoint not found" });
    return true;
  };
}
