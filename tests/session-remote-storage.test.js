import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteRemoteSession,
  readRemoteCatalog,
  readRemoteSessionMetadata,
  writeRemoteSessionKV,
  writeRemoteSession
} from "../extensions/dev.session-manager/storage/remote.js";
import { classifySessionStorageError } from "../extensions/dev.session-manager/storage/errors.js";

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

function requestBodies(fetchSpy) {
  return fetchSpy.mock.calls.map(([, init]) => JSON.parse(String(init?.body || "{}")));
}

describe("remote session storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    delete window.zion;
  });

  it("uses the metadata endpoint and falls back only when an older host returns 404", async () => {
    localStorage.setItem("zion.runtime.baseUrl", "http://runtime.test");
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ meta: { title: "Title" }, session_revision: 2 }))
      .mockResolvedValueOnce(jsonResponse({ error: "endpoint missing" }, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ text: "legacy body", meta: { title: "Title" } }))
      .mockResolvedValueOnce(jsonResponse({ error: "denied" }, { status: 403 }));
    await expect(readRemoteSessionMetadata("s")).resolves.toMatchObject({ session_revision: 2 });
    await expect(readRemoteSessionMetadata("s")).resolves.toMatchObject({ text: "legacy body" });
    await expect(readRemoteSessionMetadata("s")).rejects.toMatchObject({ status: 403 });
    expect(fetchSpy.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/v1/workbench-state/sessions/s/metadata",
      "/v1/workbench-state/sessions/s/metadata",
      "/v1/workbench-state/sessions/s",
      "/v1/workbench-state/sessions/s/metadata"
    ]);
  });

  it("returns a write conflict without silently replacing its comparison revision", async () => {
    localStorage.setItem("zion.runtime.baseUrl", "http://runtime.test");
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        conflict: true,
        session_revision: 9
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        session_revision: 10
      }));

    await expect(writeRemoteSession("session-a", {
      meta: { id: "session-a", title: "Session A" }
    }, {
      expectedSessionRevision: 2,
      operationId: "op-1",
      sourceClientId: "client-a"
    })).resolves.toMatchObject({
      ok: false,
      conflict: true,
      session_revision: 9
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(requestBodies(fetchSpy).map((body) => body.expected_session_revision))
      .toEqual([2]);
    expect(requestBodies(fetchSpy).map((body) => body.operation_id))
      .toEqual(["op-1"]);
  });

  it("retries session deletes with the latest session revision after a Runtime conflict", async () => {
    localStorage.setItem("zion.runtime.baseUrl", "http://runtime.test");
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        conflict: true,
        session_revision: 4
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        session_revision: 5
      }));

    await expect(deleteRemoteSession("session-a", {
      expectedSessionRevision: 1,
      operationId: "delete-1",
      sourceClientId: "client-a"
    })).resolves.toMatchObject({
      ok: true,
      session_revision: 5
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(requestBodies(fetchSpy).map((body) => body.expected_session_revision))
      .toEqual([1, 4]);
    expect(requestBodies(fetchSpy).map((body) => body.operation_id))
      .toEqual(["delete-1", "delete-1"]);
  });

  it.each([
    [401, "unauthenticated"], [403, "forbidden"], [413, "too-large"],
    [426, "upgrade-required"], [409, "conflict"], [429, "rate-limited"], [503, "service-unavailable"]
  ])("preserves and classifies an HTTP %s error envelope", async (status, kind) => {
    const body = { code: "STORAGE_REJECTED", error: "rejected", private: "do-not-log" };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body, { status }));
    const error = await writeRemoteSession("private-session-id", { text: "private-document" }).catch(value => value);
    expect(error).toMatchObject({
      name: "SessionStorageHttpError", status, code: "STORAGE_REJECTED",
      method: "PUT", path: "/v1/workbench-state/sessions/private-session-id", result: body
    });
    expect(classifySessionStorageError(error)).toMatchObject({
      kind, status, method: "PUT", path: "/v1/workbench-state/sessions/:sessionId"
    });
    expect(JSON.stringify(classifySessionStorageError(error))).not.toMatch(/private|do-not-log/);
  });

  it("blocks requests after account access changes with a permanent explicit error", async () => {
    window.zion = { state: { get: key => key === "workbench.accessChanged" } };
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(writeRemoteSessionKV("sessions.tagIndex", {})).rejects.toMatchObject({
      status: 403, code: "WORKBENCH_ACCESS_CHANGED", method: "PUT"
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a successful HTML response instead of acknowledging an unsaved operation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>proxy page</html>"));
    const error = await writeRemoteSessionKV("sessions.tagIndex", {}).catch(value => value);
    expect(error).toMatchObject({ status: 200, code: "INVALID_RESPONSE", method: "PUT" });
    expect(classifySessionStorageError(error)).toMatchObject({ kind: "invalid-response", retryable: true });
  });

  it("keeps the HTTP status when an error response is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("denied", { status: 403 }));
    await expect(writeRemoteSession("s", {})).rejects.toMatchObject({ status: 403, code: "HTTP_403" });
  });

  it("preserves network request context without a false HTTP conflict", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    const error = await writeRemoteSessionKV("sessions.tagIndex", {}).catch(value => value);
    expect(classifySessionStorageError(error)).toEqual({
      kind: "network", retryable: true, status: null, code: null,
      method: "PUT", path: "/v1/workbench-state/kv/sessions.tagIndex"
    });
  });

  it("marks an aborted request as a timeout and retains GET context", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation((_, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
      const request = readRemoteCatalog().catch(value => value);
      await vi.advanceTimersByTimeAsync(10000);
      expect(classifySessionStorageError(await request)).toMatchObject({
        kind: "timeout", code: "REQUEST_TIMEOUT", retryable: true, method: "GET",
        path: "/v1/workbench-state/catalog"
      });
    } finally { vi.useRealTimers(); }
  });
});
