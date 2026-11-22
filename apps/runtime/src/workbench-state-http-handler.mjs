import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import { createAuthorizedWorkbenchStore } from "./spaces/authorized-workbench-store.mjs";

const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const DEFAULT_EVENT_POLL_INTERVAL_MS = 100;
const DEFAULT_EVENT_HEARTBEAT_MS = 15_000;
export const WORKBENCH_STATE_PROTOCOL = "5";

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers
  });
  response.end(body);
}

function requireWorkbenchStateProtocol(request, response) {
  const received = String(
    request.headers?.["x-zion-workbench-protocol"] || ""
  );
  if (received === WORKBENCH_STATE_PROTOCOL) return true;
  json(response, 426, {
    error: "Workbench state protocol upgrade required",
    expectedProtocol: WORKBENCH_STATE_PROTOCOL
  }, {
    "x-zion-workbench-protocol": WORKBENCH_STATE_PROTOCOL
  });
  return false;
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
  store: sourceStore,
  spaces = null,
  reauthorize = null,
  readOnlyKeys = [],
  eventPollIntervalMs = DEFAULT_EVENT_POLL_INTERVAL_MS,
  eventHeartbeatMs = DEFAULT_EVENT_HEARTBEAT_MS
}) {
  if (!sourceStore?.readSnapshot || !sourceStore?.updateSession) {
    throw new Error("Workbench state HTTP handler requires a state store");
  }
  const protectedKeys = new Set(readOnlyKeys);
  const privateKey = (key) => /^runtime\.plugins\..+\.private\./.test(key);
  const publicSnapshot = (result) => result?.snapshot ? {
    ...result, snapshot: {
      ...result.snapshot,
      kv: Object.fromEntries(Object.entries(result.snapshot.kv || {}).filter(([key]) => !privateKey(key)))
    }
  } : result;
  const writableSnapshot = (snapshot) => snapshot && ({
    ...snapshot,
    kv: Object.fromEntries(Object.entries(snapshot.kv || {}).filter(([key]) => !protectedKeys.has(key) && !privateKey(key)))
  });

  return async (request, response, url) => {
    const path = url.pathname;
    if (!path.startsWith("/v1/workbench-state")) return false;
    const store = createAuthorizedWorkbenchStore({ store: sourceStore, spaces, principal: request.zionPrincipal });

    if (request.method === "GET" && path === "/v1/workbench-state/status") {
      json(response, 200, await store.readStatus());
      return true;
    }
    if (request.method === "GET" && path === "/v1/workbench-state/catalog") {
      json(response, 200, await store.readCatalog({
        metadataLimit: url.searchParams.get("metadata_limit")
      }));
      return true;
    }
    if (request.method === "GET" && path === "/v1/workbench-state/sessions") {
      json(response, 200, await store.searchSessions({
        query: url.searchParams.get("q") || "",
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset")
      }));
      return true;
    }
    if (request.method === "GET" && path === "/v1/workbench-state/snapshot") {
      const snapshot = await store.readSnapshot();
      if (!snapshot) {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
      } else {
        json(response, 200, publicSnapshot(snapshot));
      }
      return true;
    }
    if (request.method === "GET" && path === "/v1/workbench-state/tree") {
      json(response, 200, await store.readTree());
      return true;
    }
    if (request.method === "GET" && path === "/v1/workbench-state/events") {
      json(response, 200, await store.listEvents(
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
        if (reauthorize) await reauthorize(request.zionPrincipal);
        const feed = await store.listEvents(cursor, {
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
        cursor = Math.max(cursor, feed.cursor || 0);
        if (Date.now() - lastWriteAt >= eventHeartbeatMs) {
          response.write(`: heartbeat ${Date.now()}\n\n`);
          lastWriteAt = Date.now();
        }
        await delay(Math.max(25, Number(eventPollIntervalMs) || 100));
      }
      return true;
    }
    if (request.method === "PUT" && path === "/v1/workbench-state/snapshot") {
      if (!requireWorkbenchStateProtocol(request, response)) return true;
      const body = await readJson(request);
      json(response, 200, publicSnapshot(await store.writeSnapshot(
        writableSnapshot(body.snapshot),
        body.expected_revision ?? null,
        body.source_client_id ?? ""
      )));
      return true;
    }
    if (request.method === "PUT" && path === "/v1/workbench-state/tree") {
      if (!requireWorkbenchStateProtocol(request, response)) return true;
      const body = await readJson(request);
      if (!body.base_tree && body.expected_revision == null) {
        json(response, 426, {
          error: "Folder saving has changed; refresh Workbench before saving",
          expectedProtocol: WORKBENCH_STATE_PROTOCOL
        }, { "x-zion-workbench-protocol": WORKBENCH_STATE_PROTOCOL });
        return true;
      }
      json(response, 200, await store.writeTree(
        body.tree,
        body.index,
        body.expected_revision ?? null,
        body.source_client_id ?? "",
        body.base_tree ?? null
      ));
      return true;
    }
    if (
      request.method === "POST"
      && path === "/v1/workbench-state/migrate-browser-storage"
    ) {
      if (!requireWorkbenchStateProtocol(request, response)) return true;
      const body = await readJson(request);
      json(response, 200, publicSnapshot(await store.migrateBrowserStorage(
        body.source_id,
        writableSnapshot(body.snapshot),
        body.fingerprint
      )));
      return true;
    }

    const key = matchKVPath(path);
    if (key != null && privateKey(key)) {
      json(response, request.method === "GET" ? 404 : 409, { error: "Runtime workflow state is available only through scoped plugin commands" });
      return true;
    }
    if (key != null && request.method === "GET") {
      const value = await store.readKV(key);
      if (!value) {
        json(response, 404, { error: "key not found" });
      } else {
        json(response, 200, value);
      }
      return true;
    }
    if (key != null && request.method === "PUT") {
      if (protectedKeys.has(key)) {
        json(response, 409, { error: "This key is a Runtime-owned projection; update its source files" });
        return true;
      }
      const body = await readJson(request);
      json(response, 200, await store.writeKV(key, body.value, {
        sourceClientId: body.source_client_id ?? ""
      }));
      return true;
    }

    const revisionsSessionId = matchSessionPath(path, "/revisions");
    if (revisionsSessionId != null && request.method === "GET") {
      json(response, 200, {
        session_id: revisionsSessionId,
        revisions: await store.listSessionRevisions(revisionsSessionId)
      });
      return true;
    }
    const restoreSessionId = matchSessionPath(path, "/restore");
    if (restoreSessionId != null && request.method === "POST") {
      if (!requireWorkbenchStateProtocol(request, response)) return true;
      const body = await readJson(request);
      json(response, 200, await store.restoreSessionRevision(
        restoreSessionId,
        body.revision,
        body.operation_id ?? null
      ));
      return true;
    }

    const sessionId = matchSessionPath(path);
    if (sessionId != null && request.method === "GET") {
      const session = await store.readSession(sessionId);
      if (!session) {
        json(response, 404, { error: "session not found" });
      } else {
        json(response, 200, session);
      }
      return true;
    }
    if (sessionId != null && request.method === "PUT") {
      if (!requireWorkbenchStateProtocol(request, response)) return true;
      json(response, 200, await store.updateSession(sessionId, await readJson(request)));
      return true;
    }
    if (sessionId != null && request.method === "DELETE") {
      if (!requireWorkbenchStateProtocol(request, response)) return true;
      json(response, 200, await store.deleteSession(sessionId, await readJson(request)));
      return true;
    }

    json(response, 404, { error: "Workbench state endpoint not found" });
    return true;
  };
}
