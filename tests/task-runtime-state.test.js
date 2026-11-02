import { describe, expect, it, vi } from "vitest";
import {
  TASK_PANEL_RUNTIME_SOURCE,
  applyRuntimeTodoListsToState,
  loadRuntimeTodoLists,
  mergeRuntimeTodoListsIntoTasks,
  normalizeRuntimeTodoList
} from "../extensions/dev.task-panel/task-runtime-state.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    getItem: vi.fn((key) => (map.has(key) ? map.get(key) : null)),
    setItem: vi.fn((key, value) => map.set(String(key), String(value)))
  };
}

function state(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: vi.fn((key) => values.get(key)),
    set: vi.fn((key, value) => {
      values.set(key, value);
      return value;
    }),
    values
  };
}

describe("Task Panel Runtime todo projection", () => {
  it("normalizes Runtime todo lists and merges them into Workbench task state", async () => {
    const storage = memoryStorage({
      "zion.runtime.mode": "runtime",
      "zion.runtime.baseUrl": "http://runtime.test"
    });
    const st = state({
      "runtime.connection": { backend: "runtime" },
      "sessions.currentId": "session-1",
      "todo.tasks": []
    });
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toBe("http://runtime.test/v1/todo-lists?limit=200");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          todoLists: [{
            ownerId: "session-1",
            taskId: "task-1",
            sessionId: "session-1",
            runId: "run-1",
            updatedAt: 2000,
            todos: [{
              id: "todo-1",
              content: "Run tests",
              status: "in_progress",
              activeForm: "Running tests"
            }]
          }]
        })
      };
    });

    const loaded = await loadRuntimeTodoLists({
      storage,
      state: st,
      fetchImpl
    });
    expect(loaded).toEqual([
      expect.objectContaining({
        ownerId: "session-1",
        taskId: "task-1",
        todoSignature: expect.any(String)
      })
    ]);

    const nextTasks = applyRuntimeTodoListsToState(loaded, { state: st });
    expect(nextTasks).toEqual([
      expect.objectContaining({
        id: "task-1",
        source: TASK_PANEL_RUNTIME_SOURCE,
        runtimeTodoOwnerId: "session-1",
        runtimeRunId: "run-1",
        sessionId: "session-1",
        todos: [expect.objectContaining({
          id: "todo-1",
          content: "Run tests"
        })]
      })
    ]);
    expect(st.values.get("todo.activeTaskId")).toBe("task-1");
    expect(st.values.get("todo.runtimeSync")).toMatchObject({
      status: "synced",
      count: 1
    });
  });

  it("keeps manual tasks and skips Runtime fetches in browser mode", async () => {
    const storage = memoryStorage({
      "zion.runtime.mode": "browser",
      "zion.runtime.baseUrl": "http://runtime.test"
    });
    const st = state({
      "runtime.connection": { backend: "browser" },
      "todo.tasks": [{
        id: "manual-1",
        source: "manual",
        sessionId: "session-1",
        updatedAt: 3000,
        todos: [{ id: "todo-local", content: "Local", status: "pending", activeForm: "Local" }]
      }]
    });
    const fetchImpl = vi.fn();

    await expect(loadRuntimeTodoLists({
      storage,
      state: st,
      fetchImpl
    })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();

    const merged = mergeRuntimeTodoListsIntoTasks(st.values.get("todo.tasks"), [{
      ownerId: "session-1",
      taskId: "manual-1",
      updatedAt: 4000,
      todos: [{ content: "Remote", status: "completed", activeForm: "Remote" }]
    }]);
    expect(merged[0]).toMatchObject({
      id: "manual-1",
      source: "manual",
      todos: [expect.objectContaining({ content: "Local" })]
    });
    expect(normalizeRuntimeTodoList({ ownerId: "run-1", todos: ["skip"] }).todos)
      .toEqual([]);
  });
});
