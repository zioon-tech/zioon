import { afterEach, describe, expect, it, vi } from "vitest";
import { SchedulerServiceClient } from "../extensions/dev.scheduler/service-api.js";

describe("scheduler service client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    delete window.zion;
  });

  it("persists service-backed task capabilities and schedule semantics", async () => {
    localStorage.setItem("zion.runtime.baseUrl", "http://127.0.0.1:9999/");
    const fetchMock = vi.fn(async () => new globalThis.Response(JSON.stringify({
      id: "remote-1",
      revision: 1,
      nextRun: 123
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SchedulerServiceClient();

    await client.createTask({
      id: "local-1",
      title: "Build",
      prompt: "Run checks",
      nodeId: "node:cloud-runtime",
      modelProfileId: "workbench.deepseek.deepseek-v4-flash",
      schedule: { kind: "daily", time: "09:00" },
      capability: {
        preset: "trusted-automation",
        allowedTools: ["Bash"],
        allowedCommandPrefixes: ["npm test"],
        maxToolCalls: 20
      },
      timeoutSeconds: 300,
      enabled: true
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9999/v1/scheduler/tasks");
    expect(options.credentials).toBe("include");
    expect(JSON.parse(options.body)).toMatchObject({
      clientTaskId: "local-1",
      taskType: "agent",
      command: "",
      cwd: "",
      nodeId: "node:cloud-runtime",
      interactionProfileId: "scheduled.default",
      modelProfileId: "workbench.deepseek.deepseek-v4-flash",
      schedule: { kind: "daily", time: "09:00", misfirePolicy: "run-once", overlapPolicy: "forbid" },
      capability: {
        preset: "trusted-automation",
        allowedTools: ["Bash"],
        allowedCommandPrefixes: ["npm test"]
      }
    });
    expect(JSON.parse(options.body)).not.toHaveProperty("sessionTag");
  });

  it("lists Runtime Nodes for task configuration", async () => {
    localStorage.setItem("zion.runtime.baseUrl", "http://127.0.0.1:9999/");
    const nodes = [{
      nodeId: "node:cloud-runtime",
      label: "Cloud Runtime",
      platform: "linux",
      status: "online"
    }];
    const fetchMock = vi.fn(async () => new globalThis.Response(JSON.stringify({
      nodes
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SchedulerServiceClient();

    await expect(client.listNodes()).resolves.toEqual(nodes);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/v1/device-nodes",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("lists Runtime model profiles for task configuration", async () => {
    localStorage.setItem("zion.runtime.baseUrl", "http://127.0.0.1:9999/");
    const profiles = [{
      id: "workbench.deepseek.deepseek-v4-flash",
      label: "DeepSeek V4 Flash",
      credentialRequired: true,
      credentialConfigured: true
    }];
    const fetchMock = vi.fn(async () => new globalThis.Response(JSON.stringify({
      profiles
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SchedulerServiceClient();

    await expect(client.listModelProfiles()).resolves.toEqual(profiles);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/v1/models",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("retrieves service-backed runs with an optional task filter", async () => {
    localStorage.setItem("zion.runtime.baseUrl", "http://127.0.0.1:9999/");
    const fetchMock = vi.fn(async () => new globalThis.Response(JSON.stringify({
      runs: [{ id: "run-1", taskId: "remote-1", status: "success" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SchedulerServiceClient();

    await expect(client.listRuns("remote-1", { limit: 25, offset: 50 })).resolves.toEqual([
      { id: "run-1", taskId: "remote-1", status: "success" }
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:9999/v1/scheduler/runs?limit=25&offset=50&include_details=false&task_id=remote-1"
    );
  });

  it("loads one complete run only when details are requested", async () => {
    localStorage.setItem("zion.runtime.baseUrl", "http://127.0.0.1:9999/");
    const fetchMock = vi.fn(async () => new globalThis.Response(JSON.stringify({
      id: "run-1",
      events: [{ type: "run.finished" }],
      output: "done"
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SchedulerServiceClient();

    await expect(client.getRun("run/1")).resolves.toMatchObject({
      id: "run-1",
      isSummary: false,
      output: "done"
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:9999/v1/scheduler/runs/run%2F1?event_limit=50"
    );
  });

  it("cancels service-backed runs with a reason", async () => {
    localStorage.setItem("zion.runtime.baseUrl", "http://127.0.0.1:9999/");
    const fetchMock = vi.fn(async () => new globalThis.Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SchedulerServiceClient();

    await expect(client.cancel("run/1", "user")).resolves.toEqual({ ok: true });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9999/v1/scheduler/runs/run%2F1/cancel");
    expect(options).toMatchObject({ method: "POST" });
    expect(JSON.parse(options.body)).toEqual({ reason: "user" });
  });

  it("executes command tasks through the local tools bash endpoint", async () => {
    localStorage.setItem("zion.localTools.baseUrl", "http://127.0.0.1:9999/");
    const fetchMock = vi.fn(async () => new globalThis.Response(JSON.stringify({
      ok: true,
      exit_code: 0,
      stdout: "done\n",
      stderr: ""
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SchedulerServiceClient();

    await expect(client.executeCommand({
      command: "bash /tmp/parking_monitor.sh",
      cwd: "/tmp",
      timeoutSeconds: 60
    })).resolves.toMatchObject({ ok: true, stdout: "done\n" });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9999/bash");
    expect(JSON.parse(options.body)).toEqual({
      command: "bash /tmp/parking_monitor.sh",
      cwd: "/tmp",
      timeout: 60000
    });
  });
});
