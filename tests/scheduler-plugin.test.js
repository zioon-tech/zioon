import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activate,
  finalizeScheduledSession,
  projectRunEventToSession
} from "../extensions/dev.scheduler/main.js";
import { LocalSchedulerStore } from "../extensions/dev.scheduler/store.js";

function disposable(fn = () => {}) {
  return { dispose: fn };
}

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => values.delete(key),
    clear: () => values.clear()
  };
}

describe("scheduler plugin", () => {
  let subscriptions;
  let commands;
  let views;
  let eventHandlers;
  let externalCommands;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("zion.runtime.mode", "browser");
    subscriptions = [];
    commands = new Map();
    views = [];
    eventHandlers = new Map();
    externalCommands = new Map();
    externalCommands.set("zion.sessions.getTreeSnapshot", vi.fn(async () => ({
      id: "root",
      type: "folder",
      title: "Sessions",
      children: [{
        id: "folder-scheduled",
        type: "folder",
        title: "定时任务",
        children: []
      }]
    })));
    externalCommands.set("zion.sessions.createFolder", vi.fn(async ({ title }) => `folder-${title}`));
    window.zion = {
      commands: {
        registerCommand: (name, handler) => {
          commands.set(name, handler);
          return disposable(() => commands.delete(name));
        },
        executeCommand: (name, ...args) => {
          const handler = commands.get(name) || externalCommands.get(name);
          return handler?.(...args);
        }
      },
      events: {
        emit: (topic, payload) => {
          for (const handler of eventHandlers.get(topic) || []) handler(payload);
        },
        on: (topic, handler) => {
          const handlers = eventHandlers.get(topic) || new Set();
          handlers.add(handler);
          eventHandlers.set(topic, handlers);
          return disposable(() => handlers.delete(handler));
        }
      },
      statusBar: { registerItem: vi.fn(() => disposable()) },
      auxiliaryBar: {
        registerView: (view) => { views.push(view); return disposable(); },
        activateView: vi.fn(),
        show: vi.fn()
      },
      activityBar: { registerItem: vi.fn(() => disposable()) },
      chat: {
        execute: vi.fn(() => ({
          runId: "run-1",
          completion: Promise.resolve({ runId: "run-1", status: "completed", output: "done" }),
          abort: vi.fn(),
          events: { async *[Symbol.asyncIterator]() {} }
        }))
      }
    };
  });

  afterEach(() => {
    for (const item of subscriptions.reverse()) item?.dispose?.();
    vi.unstubAllGlobals();
    delete window.zion;
  });

  it("registers the auxiliary view and opens the task editor", async () => {
    await activate({ subscriptions });
    expect(commands.has("scheduler.openPanel")).toBe(true);
    expect(commands.has("scheduler.cancelRun")).toBe(true);
    expect(views).toHaveLength(1);

    const container = document.createElement("div");
    const mounted = views[0].component.render(container);
    expect(container.textContent).toContain("Agent / 命令");

    commands.get("scheduler.create")();
    expect(container.querySelector(".scheduler-editor")).toBeTruthy();
    expect(container.textContent).toContain("浏览器需保持打开");
    expect(container.querySelector('select[name="modelProfileId"]')?.value).toBe("");
    expect(container.textContent).toContain("继承 scheduled.default");
    mounted.dispose();
    expect(container.classList.contains("scheduler-panel-host")).toBe(false);
    expect(container.children).toHaveLength(0);
  });

  it("loads configured Runtime models and saves a task-level model override", async () => {
    const fetchMock = vi.fn(async (url) => {
      const value = String(url);
      if (value.endsWith("/v1/models")) {
        return new globalThis.Response(JSON.stringify({
          profiles: [{
            id: "workbench.deepseek.deepseek-v4-flash",
            label: "DeepSeek V4 Flash",
            credentialRequired: true,
            credentialConfigured: true
          }, {
            id: "workbench.local.free",
            label: "Local Free",
            credentialRequired: false,
            credentialConfigured: false
          }, {
            id: "workbench.deepseek.unconfigured",
            label: "Unconfigured",
            credentialRequired: true,
            credentialConfigured: false
          }]
        }), { status: 200 });
      }
      if (value.endsWith("/v1/device-nodes")) {
        return new globalThis.Response(JSON.stringify({
          nodes: [{
            nodeId: "node:cloud-runtime",
            label: "Cloud Runtime",
            platform: "linux",
            status: "online"
          }]
        }), { status: 200 });
      }
      if (value.endsWith("/scheduler/tasks")) {
        return new globalThis.Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }
      if (value.includes("/scheduler/runs?")) {
        return new globalThis.Response(JSON.stringify({ runs: [] }), { status: 200 });
      }
      return new globalThis.Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await activate({ subscriptions });
    const container = document.createElement("div");
    const mounted = views[0].component.render(container);
    commands.get("scheduler.create")();
    const form = container.querySelector(".scheduler-editor");
    const modelSelect = form.elements.modelProfileId;
    await vi.waitFor(() => {
      expect(Array.from(modelSelect.options, (option) => option.value)).toEqual([
        "",
        "workbench.deepseek.deepseek-v4-flash",
        "workbench.local.free"
      ]);
    });
    form.elements.executionMode.value = "service-backed";
    form.elements.executionMode.dispatchEvent(new Event("change", {
      bubbles: true
    }));
    expect(Array.from(form.elements.nodeId.options, (option) => option.value))
      .toContain("node:cloud-runtime");

    form.elements.title.value = "Cheap daily report";
    form.elements.prompt.value = "Summarize the project";
    modelSelect.value = "workbench.local.free";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(new LocalSchedulerStore().listTasks()).toContainEqual(
        expect.objectContaining({
          title: "Cheap daily report",
          modelProfileId: "workbench.local.free"
        })
      );
      expect(container.textContent).toContain("Local Free");
    });
    mounted.dispose();
  });

  it("requires a Runtime Node for command tasks and persists the selection", async () => {
    const fetchMock = vi.fn(async (url, options = {}) => {
      const value = String(url);
      if (value.endsWith("/v1/device-nodes")) {
        return new globalThis.Response(JSON.stringify({
          nodes: [{
            nodeId: "node:cloud-runtime",
            label: "Cloud Runtime",
            platform: "linux",
            status: "online"
          }]
        }), { status: 200 });
      }
      if (value.endsWith("/v1/models")) {
        return new globalThis.Response(JSON.stringify({ profiles: [] }), {
          status: 200
        });
      }
      if (value.endsWith("/scheduler/tasks") && options.method === "POST") {
        const input = JSON.parse(options.body);
        return new globalThis.Response(JSON.stringify({
          ...input,
          id: "remote-command",
          revision: 1,
          nextRun: Date.now() + 60_000
        }), { status: 201 });
      }
      if (value.endsWith("/scheduler/tasks")) {
        return new globalThis.Response(JSON.stringify({ tasks: [] }), {
          status: 200
        });
      }
      if (value.includes("/scheduler/runs?")) {
        return new globalThis.Response(JSON.stringify({ runs: [] }), {
          status: 200
        });
      }
      return new globalThis.Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await activate({ subscriptions });
    const container = document.createElement("div");
    const mounted = views[0].component.render(container);
    commands.get("scheduler.create")();
    const form = container.querySelector(".scheduler-editor");

    await vi.waitFor(() => {
      expect(Array.from(form.elements.nodeId.options, (option) => option.value))
        .toContain("node:cloud-runtime");
    });

    form.elements.title.value = "Cloud command";
    form.elements.taskType.value = "command";
    form.elements.taskType.dispatchEvent(new Event("change", { bubbles: true }));
    form.elements.command.value = "/usr/bin/true";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(form.querySelector(".scheduler-form-error").textContent)
      .toContain("必须选择执行 Node");

    form.elements.nodeId.value = "node:cloud-runtime";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(container.querySelector(".scheduler-editor")).toBeFalsy();
    });

    const request = fetchMock.mock.calls.find(([url, options]) =>
      String(url).endsWith("/scheduler/tasks") && options?.method === "POST"
    );
    expect(JSON.parse(request[1].body)).toMatchObject({
      taskType: "command",
      nodeId: "node:cloud-runtime",
      command: "/usr/bin/true"
    });
    mounted.dispose();
  });

  it("loads full service run history only when the scheduler panel is opened", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url) => {
      const value = String(url);
      if (value.endsWith("/scheduler/tasks")) {
        return new globalThis.Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }
      if (value.endsWith("/scheduler/runs/claim")) {
        return new globalThis.Response(JSON.stringify({ run: null }), { status: 200 });
      }
      if (value.includes("/scheduler/runs?")) {
        return new globalThis.Response(JSON.stringify({ runs: [] }), { status: 200 });
      }
      return new globalThis.Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await activate({ subscriptions });
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/scheduler/runs?"))).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/scheduler/runs?"))).toBe(false);

      const container = document.createElement("div");
      const mounted = views[0].component.render(container);
      await vi.waitFor(() => {
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/scheduler/runs?"))).toBe(true);
      });
      const initialRunRefreshes = fetchMock.mock.calls.filter(
        ([url]) => String(url).includes("/scheduler/runs?")
      ).length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock.mock.calls.filter(
        ([url]) => String(url).includes("/scheduler/runs?")
      )).toHaveLength(initialRunRefreshes + 1);
      mounted.dispose();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock.mock.calls.filter(
        ([url]) => String(url).includes("/scheduler/runs?")
      )).toHaveLength(initialRunRefreshes + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes Runtime tasks when the scheduler panel opens and remains visible", async () => {
    vi.useFakeTimers();
    let taskRequests = 0;
    const remoteTask = {
      id: "remote-created-from-chat",
      revision: 1,
      taskType: "command",
      executionMode: "service-backed",
      title: "Created from chat",
      prompt: "",
      command: "/usr/bin/true",
      cwd: "",
      note: "",
      schedule: {
        kind: "daily",
        time: "08:00",
        timeZone: "Asia/Shanghai",
        misfirePolicy: "run-once",
        overlapPolicy: "forbid"
      },
      capability: {
        preset: "trusted-automation",
        allowedTools: ["Bash"],
        allowedCommandPrefixes: ["/usr/bin/true"]
      },
      timeoutSeconds: 120,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      nextRun: 2
    };
    const fetchMock = vi.fn(async (url) => {
      const value = String(url);
      if (value.endsWith("/scheduler/tasks")) {
        taskRequests += 1;
        return new globalThis.Response(JSON.stringify({
          tasks: taskRequests === 1 ? [] : [remoteTask]
        }), { status: 200 });
      }
      if (value.includes("/scheduler/runs?")) {
        return new globalThis.Response(JSON.stringify({ runs: [] }), { status: 200 });
      }
      return new globalThis.Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await activate({ subscriptions });
      await Promise.resolve();
      await Promise.resolve();
      expect(taskRequests).toBe(1);

      const container = document.createElement("div");
      const mounted = views[0].component.render(container);
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(taskRequests).toBe(2);
      expect(container.textContent).toContain("Created from chat");

      await vi.advanceTimersByTimeAsync(30_000);
      expect(taskRequests).toBe(3);
      mounted.dispose();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(taskRequests).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never claims service-backed Runs in Workbench", async () => {
    localStorage.setItem("zion.runtime.mode", "runtime");
    localStorage.setItem("zion.runtime.baseUrl", "http://127.0.0.1:9888");
    const fetchMock = vi.fn(async (url) => {
      const value = String(url);
      if (value.endsWith("/scheduler/tasks")) {
        return new globalThis.Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }
      return new globalThis.Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await activate({ subscriptions });
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
    }

    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).endsWith("/scheduler/runs/claim")
    )).toBe(false);
    expect(window.zion.chat.execute).not.toHaveBeenCalled();
  });

  it("saves a panel task without timer binding errors", async () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    vi.stubGlobal("setTimeout", function setTimeoutWithBindingCheck() {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return 1;
    });
    vi.stubGlobal("clearTimeout", function clearTimeoutWithBindingCheck() {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
    });
    const fetchMock = vi.fn(async (url, options = {}) => {
      const value = String(url);
      if (value.endsWith("/v1/device-nodes")) {
        return new globalThis.Response(JSON.stringify({
          nodes: [{
            nodeId: "node:macbook",
            label: "Development Mac",
            platform: "darwin",
            status: "online"
          }]
        }), { status: 200 });
      }
      if (value.endsWith("/v1/models")) {
        return new globalThis.Response(JSON.stringify({ profiles: [] }), {
          status: 200
        });
      }
      if (value.endsWith("/scheduler/tasks") && options.method === "POST") {
        return new globalThis.Response(JSON.stringify({
          id: "remote-command",
          revision: 1,
          enabled: true,
          nextRun: Date.now() + 60_000
        }), { status: 201 });
      }
      if (value.endsWith("/scheduler/tasks")) {
        return new globalThis.Response(JSON.stringify({ tasks: [] }), {
          status: 200
        });
      }
      if (value.includes("/scheduler/runs?")) {
        return new globalThis.Response(JSON.stringify({ runs: [] }), {
          status: 200
        });
      }
      return new globalThis.Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.zion.notification = { show: vi.fn() };

    await activate({ subscriptions });
    await Promise.resolve();
    await Promise.resolve();
    const container = document.createElement("div");
    const mounted = views[0].component.render(container);
    commands.get("scheduler.create")();
    const form = container.querySelector(".scheduler-editor");
    form.elements.title.value = "Daily summary";
    form.elements.prompt.value = "Summarize the project";
    form.elements.kind.value = "interval";
    form.elements.kind.dispatchEvent(new Event("change", { bubbles: true }));
    form.elements.intervalMinutes.value = "5";
    expect(container.querySelector(".scheduler-editor")).toBeTruthy();

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
    }

    expect(window.zion.notification.show).not.toHaveBeenCalled();
    expect(container.querySelector(".scheduler-editor")).toBeFalsy();
    mounted.dispose();
  });

  it("fixes a new agent task tag from the panel creation locale", async () => {
    window.zion.i18n = { getLocale: () => "en-US" };
    window.zion.notification = { show: vi.fn() };

    await activate({ subscriptions });
    const container = document.createElement("div");
    const mounted = views[0].component.render(container);
    commands.get("scheduler.create")();
    const form = container.querySelector(".scheduler-editor");
    form.elements.title.value = "Daily report";
    form.elements.prompt.value = "Summarize the project";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(new LocalSchedulerStore().listTasks()).toEqual([
        expect.objectContaining({
          title: "Daily report",
          sessionTag: "scheduled_tasks"
        })
      ]);
    });
    mounted.dispose();
  });

  it("keeps task row DOM stable across list refreshes", async () => {
    externalCommands.set("zion.sessions.new", vi.fn(async () => "session-hover"));
    externalCommands.set("zion.sessions.appendAssistantToken", vi.fn(async () => true));
    externalCommands.set("zion.sessions.transformDoc", vi.fn(async () => true));
    externalCommands.set("zion.sessions.patchMeta", vi.fn(async () => true));
    externalCommands.set("zion.sessions.bumpUpdatedAt", vi.fn(() => true));
    window.zion.state = { set: vi.fn(), get: vi.fn(), onDidChange: vi.fn(() => disposable()) };
    const store = new LocalSchedulerStore();
    store.saveTask({
      id: "task-hover",
      title: "Hover stable",
      prompt: "Summarize",
      enabled: false,
      schedule: { kind: "daily", time: "09:00" },
      timeoutSeconds: 60,
      createdAt: 1
    });

    await activate({ subscriptions });
    const container = document.createElement("div");
    const mounted = views[0].component.render(container);
    const row = container.querySelector('.scheduler-task-row[data-task-id="task-hover"]');
    expect(row).toBeTruthy();

    row.dispatchEvent(new Event("mouseenter"));
    store.saveTask({ ...store.getTask("task-hover"), title: "Hover updated" });
    window.zion.events.emit("scheduler/changed");

    expect(container.querySelector('.scheduler-task-row[data-task-id="task-hover"]')).toBe(row);
    expect(container.textContent).not.toContain("Hover stable");
    expect(container.textContent).toContain("Hover updated");

    const runButton = row.querySelector('[data-action="run"]');
    runButton.click();
    expect(runButton.disabled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.zion.chat.execute).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Summarize"
    }));
    expect(window.zion.chat.execute.mock.calls[0][0]).not.toHaveProperty("sessionId");

    row.dispatchEvent(new Event("mouseleave"));
    expect(container.querySelector('.scheduler-task-row[data-task-id="task-hover"]')).toBe(row);
    expect(container.textContent).toContain("Hover updated");
    mounted.dispose();
  });

  it("shows local tasks as busy when their persisted run is active", async () => {
    window.zion.state = { set: vi.fn(), get: vi.fn(), onDidChange: vi.fn(() => disposable()) };
    const store = new LocalSchedulerStore();
    store.saveTask({
      id: "task-active",
      title: "Active local report",
      prompt: "Summarize",
      enabled: true,
      nextRun: Date.now() + 3_600_000,
      schedule: { kind: "daily", time: "09:00" },
      timeoutSeconds: 600,
      createdAt: 1
    });
    store.saveRun({
      id: "run-active",
      taskId: "task-active",
      taskTitle: "Active local report",
      executionMode: "local-only",
      status: "running",
      startedAt: Date.now(),
      completedAt: null,
      output: "",
      events: []
    });

    await activate({ subscriptions });
    const container = document.createElement("div");
    const mounted = views[0].component.render(container);
    const row = container.querySelector('.scheduler-task-row[data-task-id="task-active"]');
    const runButton = row?.querySelector('[data-action="run"]');

    expect(row?.dataset.state).toBe("running");
    expect(runButton?.disabled).toBe(true);
    expect(row?.textContent).toContain("运行中");
    mounted.dispose();
  });

  it("shows a service-backed pending run and prevents duplicate manual clicks", async () => {
    const fetchMock = vi.fn(async () => new globalThis.Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    window.zion.notification = { show: vi.fn() };
    const store = new LocalSchedulerStore();
    store.saveTask({
      id: "task-remote",
      remoteTaskId: "remote-task",
      executionMode: "service-backed",
      title: "Remote report",
      prompt: "Generate report",
      enabled: true,
      schedule: { kind: "daily", time: "09:00" },
      timeoutSeconds: 60,
      createdAt: 1
    });
    store.saveRun({
      id: "run-pending",
      taskId: "task-remote",
      taskTitle: "Remote report",
      status: "pending",
      startedAt: Date.now(),
      output: "",
      events: []
    });

    await activate({ subscriptions });
    const container = document.createElement("div");
    const mounted = views[0].component.render(container);
    const row = container.querySelector('.scheduler-task-row[data-task-id="task-remote"]');
    const runButton = row.querySelector('[data-action="run"]');

    expect(row.dataset.state).toBe("pending");
    expect(row.textContent).toContain("正在启动");
    expect(runButton.disabled).toBe(true);
    expect(runButton.title).toBe("任务正在启动");
    const runRow = container.querySelector('.scheduler-run-row[data-run-id="run-pending"]');
    expect(runRow).toBeTruthy();

    runRow.click();
    const cancelButton = container.querySelector('[data-action="cancel-run"]');
    expect(cancelButton).toBeTruthy();
    cancelButton.click();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getRun("run-pending")).toMatchObject({
      status: "aborted",
      error: "运行已取消"
    });
    expect(container.querySelector('[data-action="cancel-run"]')).toBeFalsy();
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).endsWith("/scheduler/runs/run-pending/cancel")
    )).toBe(true);
    mounted.dispose();
  });

  it("keeps loaded history details stable across Scheduler refreshes", async () => {
    localStorage.setItem("zion.runtime.mode", "runtime");
    localStorage.setItem("zion.runtime.baseUrl", "http://127.0.0.1:9876");
    const events = Array.from({ length: 40 }, (_, index) => ({
      type: index === 39 ? "run.completed" : "tool.completed",
      ts: 100 + index,
      data: { name: `tool-${index}` }
    }));
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const value = String(url);
      if (value.endsWith("/scheduler/runs/run-history?event_limit=50")) {
        return new globalThis.Response(JSON.stringify({
          id: "run-history",
          taskId: "remote-task",
          status: "success",
          output: "stable output",
          events
        }), { status: 200 });
      }
      if (value.includes("/scheduler/runs?")) {
        return new globalThis.Response(JSON.stringify({
          runs: [{
            id: "run-history",
            taskId: "remote-task",
            status: "success",
            startedAt: 100,
            eventCount: 40,
            outputLength: 13,
            isSummary: true
          }]
        }), { status: 200 });
      }
      if (value.endsWith("/scheduler/tasks")) {
        return new globalThis.Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }
      if (value.endsWith("/v1/models")) {
        return new globalThis.Response(JSON.stringify({ profiles: [] }), { status: 200 });
      }
      if (value.endsWith("/v1/device-nodes")) {
        return new globalThis.Response(JSON.stringify({ nodes: [] }), { status: 200 });
      }
      return new globalThis.Response(JSON.stringify({}), { status: 200 });
    }));
    const store = new LocalSchedulerStore();
    store.saveRun({
      id: "run-history",
      taskId: "remote-task",
      taskTitle: "History",
      executionMode: "service-backed",
      status: "success",
      startedAt: 100,
      eventCount: 40,
      isSummary: true,
      output: "",
      events: []
    });

    await activate({ subscriptions });
    const container = document.createElement("div");
    const mounted = views[0].component.render(container);
    container.querySelector('[data-run-id="run-history"]').click();
    await vi.waitFor(() => expect(container.textContent).toContain("stable output"));
    expect(container.querySelectorAll(".scheduler-events > div")).toHaveLength(30);
    expect(container.textContent).toContain("省略较早的 10 条");

    window.zion.events.emit("scheduler/changed");
    expect(container.textContent).toContain("stable output");
    expect(container.querySelectorAll(".scheduler-events > div")).toHaveLength(30);
    mounted.dispose();
  });

  it("registers schedulerManage in the interactive chat tool registry", async () => {
    const state = new Map();
    window.zion.state = {
      get: (key) => state.get(key),
      set: (key, value) => state.set(key, value)
    };

    await activate({ subscriptions });
    expect(state.get("chat.tools")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        function: expect.objectContaining({ name: "schedulerManage" })
      })
    ]));
    expect(state.get("chat.enabledTools")).toContain("schedulerManage");
    expect(state.get("chat.toolHandlers").schedulerManage).toEqual(expect.any(Function));
  });

  it("projects a scheduled run into the existing session lifecycle", async () => {
    const emitted = [];
    const commandCalls = [];
    const state = new Map();
    const zion = {
      commands: {
        executeCommand: vi.fn(async (name, value) => {
          commandCalls.push({ name, value });
          return true;
        })
      },
      events: { emit: (topic, payload) => emitted.push({ topic, payload }) },
      state: { set: (key, value) => state.set(key, value) }
    };
    const base = { runId: "run-1" };

    await projectRunEventToSession(
      zion,
      "session-1",
      { ...base, type: "run.started", data: {} },
      { requestSource: "agent-task" }
    );
    await projectRunEventToSession(zion, "session-1", { ...base, type: "message.delta", data: { delta: "hello" } });
    await projectRunEventToSession(zion, "session-1", {
      ...base,
      type: "tool.requested",
      data: { callId: "call-1", name: "webSearch", args: { query: "zion" } }
    });
    await projectRunEventToSession(zion, "session-1", {
      ...base,
      type: "tool.completed",
      data: { callId: "call-1", name: "webSearch", result: "result" }
    });
    await projectRunEventToSession(zion, "session-1", { ...base, type: "run.completed", data: {} });
    await finalizeScheduledSession(zion, "session-1", { status: "success", completedAt: 123, error: null });

    expect(commandCalls.find((call) => (
      call.name === "zion.sessions.ensureAssistantBlock"
    ))).toMatchObject({
      name: "zion.sessions.ensureAssistantBlock",
      value: { id: "session-1", assistantBlockId: "run-1" }
    });
    expect(commandCalls.find((call) => (
      call.name === "zion.sessions.appendAssistantToken"
    ))).toMatchObject({
      name: "zion.sessions.appendAssistantToken",
      value: { id: "session-1", token: "hello", assistantBlockId: "run-1" }
    });
    expect(commandCalls.map((call) => call.name)).toContain("zion.sessions.transformDoc");
    expect(emitted.map((event) => event.topic)).toEqual([
      "chat/runStarted",
      "chat/token",
      "chat/toolCall",
      "chat/toolResult",
      "chat/runFinished"
    ]);
    expect(emitted[0].payload).toMatchObject({ requestSource: "agent-task" });
    expect(emitted.find((event) => event.topic === "chat/toolCall")?.payload).toMatchObject({
      assistantBlockId: "run-1"
    });
    expect(state.get("chat.runs.session-1")).toMatchObject({ streaming: false, awaiting: true });
  });

  it("keeps manual runs in Scheduler history without creating sidebar sessions", async () => {
    const createSession = vi.fn(async () => "session-1");
    externalCommands.set("zion.sessions.new", createSession);
    externalCommands.set("zion.sessions.appendAssistantToken", vi.fn(async () => true));
    externalCommands.set("zion.sessions.transformDoc", vi.fn(async () => true));
    externalCommands.set("zion.sessions.patchMeta", vi.fn(async () => true));
    externalCommands.set("zion.sessions.bumpUpdatedAt", vi.fn(() => true));
    window.zion.state = { set: vi.fn(), get: vi.fn(), onDidChange: vi.fn(() => disposable()) };
    window.zion.chat.execute = vi.fn(() => ({
      runId: "chat-run-1",
      completion: Promise.resolve({ runId: "chat-run-1", status: "completed", output: "summary" }),
      abort: vi.fn(),
      events: {
        async *[Symbol.asyncIterator]() {
          yield { runId: "chat-run-1", type: "run.started", data: {} };
          yield { runId: "chat-run-1", type: "message.delta", data: { delta: "summary" } };
          yield { runId: "chat-run-1", type: "run.completed", data: { output: "summary" } };
        }
      }
    }));

    const store = new LocalSchedulerStore();
    store.saveTask({
      id: "task-1",
      title: "Daily summary",
      prompt: "Summarize",
      enabled: false,
      schedule: { kind: "daily", time: "09:00" },
      timeoutSeconds: 60,
      createdAt: 1
    });

    await activate({ subscriptions });
    await commands.get("scheduler.runNow")("task-1");
    expect(createSession).not.toHaveBeenCalled();
    expect(window.zion.chat.execute).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.anything() })
    );
    expect(store.listRuns()[0]).toMatchObject({
      chatRunId: "chat-run-1",
      sessionId: null,
      status: "success",
      output: "summary"
    });
  });

  it("routes an opted-in read-only Agent task through the Runtime Host", async () => {
    localStorage.setItem("zion.runtime.mode", "runtime");
    localStorage.setItem("zion.runtime.baseUrl", "http://127.0.0.1:9876");
    externalCommands.set("zion.sessions.new", vi.fn(async () => "session-runtime"));
    externalCommands.set("zion.sessions.ensureAssistantBlock", vi.fn(async () => true));
    externalCommands.set("zion.sessions.appendAssistantToken", vi.fn(async () => true));
    externalCommands.set("zion.sessions.transformDoc", vi.fn(async () => true));
    externalCommands.set("zion.sessions.patchMeta", vi.fn(async () => true));
    externalCommands.set("zion.sessions.bumpUpdatedAt", vi.fn(() => true));
    window.zion.state = {
      set: vi.fn(),
      get: vi.fn(),
      onDidChange: vi.fn(() => disposable())
    };
    const runtimeEvents = [
      {
        schemaVersion: 1,
        eventId: "event-started",
        runId: "runtime-run-1",
        attemptId: "runtime-attempt-1",
        sequence: 1,
        type: "run.started",
        timestamp: 100,
        data: {}
      },
      {
        schemaVersion: 1,
        eventId: "event-delta",
        runId: "runtime-run-1",
        attemptId: "runtime-attempt-1",
        sequence: 2,
        type: "message.delta",
        timestamp: 101,
        data: { delta: "runtime summary" }
      },
      {
        schemaVersion: 1,
        eventId: "event-completed",
        runId: "runtime-run-1",
        attemptId: "runtime-attempt-1",
        sequence: 3,
        type: "run.completed",
        timestamp: 102,
        data: {
          output: "runtime summary",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0
          }
        }
      }
    ];
    const sse = runtimeEvents.map((event) =>
      `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    ).join("");
    const fetchMock = vi.fn(async (url, init = {}) => {
      const value = String(url);
      if (value === "http://127.0.0.1:9876/v1/runs" && init.method === "POST") {
        return new globalThis.Response(JSON.stringify({
          runId: "runtime-run-1",
          attemptId: "runtime-attempt-1",
          status: "accepted"
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      }
      if (
        value
        === "http://127.0.0.1:9876/v1/runs/runtime-run-1/projection/stream"
          + "?after=0&reasoning=none&max_delay_ms=100&max_chunk_chars=512"
      ) {
        return new globalThis.Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      if (value.endsWith("/scheduler/tasks")) {
        return new globalThis.Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }
      if (value.endsWith("/scheduler/runs/claim")) {
        return new globalThis.Response(JSON.stringify({ run: null }), { status: 200 });
      }
      return new globalThis.Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = new LocalSchedulerStore();
    store.saveTask({
      id: "task-runtime",
      taskType: "agent",
      executionMode: "local-only",
      title: "Runtime summary",
      prompt: "Summarize through Runtime",
      modelProfileId: "workbench.deepseek.deepseek-v4-flash",
      enabled: false,
      schedule: { kind: "daily", time: "09:00" },
      capability: { preset: "read-only", allowedTools: [] },
      timeoutSeconds: 60,
      createdAt: 1
    });

    await activate({ subscriptions });
    await commands.get("scheduler.runNow")("task-runtime");

    expect(window.zion.chat.execute).not.toHaveBeenCalled();
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "http://127.0.0.1:9876/v1/runs" && init?.method === "POST"
    );
    expect(JSON.parse(createCall[1].body)).toMatchObject({
      title: "Runtime summary",
      prompt: "Summarize through Runtime",
      interactionProfileId: "scheduled.default",
      model: {
        profileId: "workbench.deepseek.deepseek-v4-flash"
      },
      timeoutMs: 60_000,
      metadata: {
        source: "scheduler",
        interactionProfileId: "scheduled.default",
        schedulerTaskId: "task-runtime"
      }
    });
    expect(store.listRuns()[0]).toMatchObject({
      backend: "runtime",
      chatRunId: "runtime-run-1",
      runtimeRunId: "runtime-run-1",
      runtimeAttemptId: "runtime-attempt-1",
      lastEventSequence: 3,
      status: "success",
      output: "runtime summary"
    });
    expect(externalCommands.get("zion.sessions.appendAssistantToken")).not.toHaveBeenCalled();
  });

  it("does not silently replace a task model during browser-only execution", async () => {
    const fetchMock = vi.fn(async (url) => {
      const value = String(url);
      if (value.endsWith("/scheduler/tasks")) {
        return new globalThis.Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }
      return new globalThis.Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.zion.state = {
      set: vi.fn(),
      get: vi.fn(),
      onDidChange: vi.fn(() => disposable())
    };
    const store = new LocalSchedulerStore();
    store.saveTask({
      id: "task-browser-model",
      taskType: "agent",
      executionMode: "local-only",
      title: "Pinned model",
      prompt: "Summarize",
      modelProfileId: "workbench.deepseek.deepseek-v4-flash",
      enabled: false,
      schedule: { kind: "daily", time: "09:00" },
      capability: { preset: "read-only", allowedTools: [] },
      timeoutSeconds: 60,
      createdAt: 1
    });

    await activate({ subscriptions });

    await expect(commands.get("scheduler.runNow")("task-browser-model"))
      .rejects.toThrow("指定的任务模型需要通过 Runtime 执行");
    expect(window.zion.chat.execute).not.toHaveBeenCalled();
  });

  it("reattaches an accepted Runtime Run after Workbench restarts", async () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    externalCommands.set("zion.sessions.appendAssistantToken", vi.fn(async () => true));
    externalCommands.set("zion.sessions.transformDoc", vi.fn(async () => true));
    externalCommands.set("zion.sessions.patchMeta", vi.fn(async () => true));
    externalCommands.set("zion.sessions.bumpUpdatedAt", vi.fn(() => true));
    window.zion.state = {
      set: vi.fn(),
      get: vi.fn(),
      onDidChange: vi.fn(() => disposable())
    };
    const resumedEvents = [
      {
        schemaVersion: 1,
        eventId: "event-resumed-delta",
        runId: "runtime-run-resume",
        attemptId: "runtime-attempt-resume",
        sequence: 2,
        type: "message.delta",
        timestamp: 201,
        data: { delta: "finished while closed" }
      },
      {
        schemaVersion: 1,
        eventId: "event-resumed-completed",
        runId: "runtime-run-resume",
        attemptId: "runtime-attempt-resume",
        sequence: 3,
        type: "run.completed",
        timestamp: 202,
        data: { output: "finished while closed", usage: {} }
      }
    ];
    const sse = resumedEvents.map((event) =>
      `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    ).join("");
    const fetchMock = vi.fn(async (url) => {
      const value = String(url);
      if (
        value
        === "http://127.0.0.1:9876/v1/runs/runtime-run-resume/projection/stream"
          + "?after=1&reasoning=none&max_delay_ms=100&max_chunk_chars=512"
      ) {
        return new globalThis.Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      if (value === "http://127.0.0.1:9876/v1/runs/runtime-run-resume") {
        return new globalThis.Response(JSON.stringify({
          run: {
            id: "runtime-run-resume",
            attemptId: "runtime-attempt-resume",
            status: "completed",
            completedAt: 203,
            output: "finished while closed",
            usage: null
          }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (value.endsWith("/scheduler/tasks")) {
        return new globalThis.Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }
      if (value.endsWith("/scheduler/runs/claim")) {
        return new globalThis.Response(JSON.stringify({ run: null }), { status: 200 });
      }
      return new globalThis.Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = new LocalSchedulerStore();
    store.saveTask({
      id: "task-runtime-resume",
      taskType: "agent",
      executionMode: "local-only",
      title: "Resume Runtime",
      prompt: "Resume",
      enabled: false,
      schedule: { kind: "daily", time: "09:00" },
      capability: { preset: "read-only", allowedTools: [] },
      timeoutSeconds: 60,
      createdAt: 1
    });
    store.saveRun({
      id: "local-run-resume",
      taskId: "task-runtime-resume",
      taskTitle: "Resume Runtime",
      executionMode: "local-only",
      backend: "runtime",
      runtimeBaseUrl: "http://127.0.0.1:9876",
      runtimeRunId: "runtime-run-resume",
      runtimeAttemptId: "runtime-attempt-resume",
      chatRunId: "runtime-run-resume",
      sessionId: "session-runtime-resume",
      status: "running",
      startedAt: 100,
      completedAt: null,
      output: "",
      error: null,
      lastEventSequence: 1,
      events: [{
        sequence: 1,
        type: "run.started",
        runId: "runtime-run-resume",
        data: {}
      }]
    });

    await activate({ subscriptions });
    await vi.waitFor(() => {
      expect(store.getRun("local-run-resume")).toMatchObject({
        status: "success",
        output: "finished while closed",
        lastEventSequence: 3,
        observationError: null
      });
    });

    expect(window.zion.chat.execute).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9876/v1/runs/runtime-run-resume/projection/stream"
        + "?after=1&reasoning=none&max_delay_ms=100&max_chunk_chars=512",
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: "text/event-stream",
          "last-event-id": "1"
        })
      })
    );
    expect(externalCommands.get("zion.sessions.appendAssistantToken")).not.toHaveBeenCalled();
  });

  it("does not depend on the session archive folder", async () => {
    const createSession = vi.fn(async () => "session-1");
    externalCommands.set("zion.sessions.getTreeSnapshot", vi.fn(async () => null));
    externalCommands.set("zion.sessions.new", createSession);
    window.zion.state = { set: vi.fn(), get: vi.fn(), onDidChange: vi.fn(() => disposable()) };
    const store = new LocalSchedulerStore();
    store.saveTask({
      id: "task-no-folder",
      title: "Daily summary",
      prompt: "Summarize",
      enabled: false,
      schedule: { kind: "daily", time: "09:00" },
      timeoutSeconds: 60,
      createdAt: 1
    });

    await activate({ subscriptions });
    await commands.get("scheduler.runNow")("task-no-folder");

    expect(createSession).not.toHaveBeenCalled();
    expect(store.listRuns()[0]).toMatchObject({
      taskId: "task-no-folder",
      status: "success",
      sessionId: null
    });
  });

  it("runs command tasks directly without creating an agent session", async () => {
    localStorage.setItem("zion.runtime.mode", "runtime");
    window.zion.state = { set: vi.fn(), get: vi.fn(), onDidChange: vi.fn(() => disposable()) };
    const fetchMock = vi.fn(async () => new globalThis.Response(JSON.stringify({
      ok: true,
      exit_code: 0,
      stdout: "parking ok\n",
      stderr: "",
      duration_ms: 12
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("zion.localTools.baseUrl", "http://127.0.0.1:9999");

    const store = new LocalSchedulerStore();
    store.saveTask({
      id: "task-command",
      taskType: "command",
      title: "Parking monitor",
      command: "bash /tmp/parking_monitor.sh",
      cwd: "/tmp",
      enabled: false,
      schedule: { kind: "interval", intervalMinutes: 5 },
      capability: {
        preset: "trusted-automation",
        allowedTools: ["Bash"],
        allowedCommandPrefixes: ["bash /tmp/parking_monitor.sh"]
      },
      timeoutSeconds: 60,
      createdAt: 1
    });

    await activate({ subscriptions });
    await commands.get("scheduler.runNow")("task-command");

    expect(window.zion.chat.execute).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:9999/bash", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        command: "bash /tmp/parking_monitor.sh",
        cwd: "/tmp",
        timeout: 60000
      })
    }));
    expect(store.listRuns()[0]).toMatchObject({
      taskType: "command",
      command: "bash /tmp/parking_monitor.sh",
      cwd: "/tmp",
      status: "success",
      output: "parking ok\n",
      exitCode: 0
    });
  });
});
