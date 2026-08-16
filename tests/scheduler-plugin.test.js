import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activate,
  finalizeScheduledSession,
  projectRunEventToSession
} from "../extensions/dev.scheduler/main.js";
import { archiveDateForTimestamp } from "../extensions/dev.scheduler/session-archive.js";
import { LocalSchedulerStore } from "../extensions/dev.scheduler/store.js";

function disposable(fn = () => {}) {
  return { dispose: fn };
}

describe("scheduler plugin", () => {
  let subscriptions;
  let commands;
  let views;
  let eventHandlers;
  let externalCommands;

  beforeEach(() => {
    localStorage.clear();
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
    mounted.dispose();
    expect(container.classList.contains("scheduler-panel-host")).toBe(false);
    expect(container.children).toHaveLength(0);
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
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/scheduler/runs?"))).toBe(true);
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

  it("saves a panel task without timer binding errors", async () => {
    vi.stubGlobal("setTimeout", function setTimeoutWithBindingCheck() {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return 1;
    });
    vi.stubGlobal("clearTimeout", function clearTimeoutWithBindingCheck() {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
    });
    window.zion.notification = { show: vi.fn() };

    await activate({ subscriptions });
    const container = document.createElement("div");
    const mounted = views[0].component.render(container);
    commands.get("scheduler.create")();
    const form = container.querySelector(".scheduler-editor");
    form.elements.title.value = "Parking monitor";
    form.elements.taskType.value = "command";
    form.elements.taskType.dispatchEvent(new Event("change", { bubbles: true }));
    form.elements.command.value = "bash /tmp/parking_monitor.sh";
    form.elements.cwd.value = "/tmp";
    form.elements.kind.value = "interval";
    form.elements.kind.dispatchEvent(new Event("change", { bubbles: true }));
    form.elements.intervalMinutes.value = "5";
    expect(container.querySelector(".scheduler-editor")).toBeTruthy();

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

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
      prompt: "Summarize",
      sessionId: "session-hover"
    }));

    row.dispatchEvent(new Event("mouseleave"));
    expect(container.querySelector('.scheduler-task-row[data-task-id="task-hover"]')).toBe(row);
    expect(container.textContent).toContain("Hover updated");
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

    await projectRunEventToSession(zion, "session-1", { ...base, type: "run.started", data: {} });
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

    expect(commandCalls[0]).toMatchObject({
      name: "zion.sessions.ensureAssistantBlock",
      value: { id: "session-1", assistantBlockId: "run-1" }
    });
    expect(commandCalls[1]).toMatchObject({
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
    expect(emitted.find((event) => event.topic === "chat/toolCall")?.payload).toMatchObject({
      assistantBlockId: "run-1"
    });
    expect(state.get("chat.runs.session-1")).toMatchObject({ streaming: false, awaiting: true });
  });

  it("creates and binds a background session for every manual run", async () => {
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
    const archiveDate = archiveDateForTimestamp(Date.now());

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      parentId: `folder-${archiveDate.day}`,
      open: false,
      content: `user Summarize\n\n#定时任务/${archiveDate.key}\nassistant `,
      meta: expect.objectContaining({ source: "scheduled-task", scheduledTaskId: "task-1" })
    }));
    expect(window.zion.chat.execute).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1" }));
    expect(store.listRuns()[0]).toMatchObject({
      chatRunId: "chat-run-1",
      sessionId: "session-1",
      status: "success",
      output: "summary"
    });
  });

  it("does not create a scheduled session at root when the archive folder is unavailable", async () => {
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
      status: "failed",
      error: "无法准备定时任务日期文件夹"
    });
  });

  it("runs command tasks directly without creating an agent session", async () => {
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
