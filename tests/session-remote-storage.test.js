import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteRemoteSession,
  writeRemoteSession
} from "../extensions/dev.session-manager/storage/remote.js";

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

  it("retries session writes with the latest session revision after a Runtime conflict", async () => {
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
      ok: true,
      session_revision: 10
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(requestBodies(fetchSpy).map((body) => body.expected_session_revision))
      .toEqual([2, 9]);
    expect(requestBodies(fetchSpy).map((body) => body.operation_id))
      .toEqual(["op-1", "op-1"]);
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
});
