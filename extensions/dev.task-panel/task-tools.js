/**
 * dev.task-panel: tools for LLM
 * - Registers todoWrite tool to manage structured todos in the current session.
 * - Writes to zion.state('todo.list') and 'todo.updatedAt' for Task Panel consumption.
 */
export function registerTaskTools() {
  try {
    // Tool schema
    const tools = [
      {
        type: "function",
        function: {
          name: "todoWrite",
          description: "Create or update a structured todo list for the current session",
          parameters: {
            type: "object",
            properties: {
              taskId: {
                type: "string",
                minLength: 1,
                description: "Stable id of the todo list to update. Reuse the taskId returned by previous todoWrite calls for the same task."
              },
              todos: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: {
                      type: "string",
                      minLength: 1,
                      description: "Stable id of this todo item. Reuse existing ids when only changing status or wording."
                    },
                    content: { type: "string", minLength: 1 },
                    status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                    activeForm: { type: "string", minLength: 1 }
                  },
                  required: ["content", "status", "activeForm"],
                  additionalProperties: false
                },
                description: "The updated todo list"
              }
            },
            required: ["todos"],
            additionalProperties: false
          }
        }
      }
    ];

    // Merge into chat.tools (avoid duplicates)
    const existingRaw = window.zion?.state?.get("chat.tools");
    const existing = Array.isArray(existingRaw) ? existingRaw : [];
    const toolByName = new Map(tools.map(t => [t?.function?.name, t]).filter(([name]) => !!name));
    const seen = new Set();
    const merged = existing.map(t => {
      const nm = t?.function?.name;
      if (nm && toolByName.has(nm)) {
        seen.add(nm);
        return toolByName.get(nm);
      }
      return t;
    });
    for (const t of tools) {
      const nm = t?.function?.name;
      if (nm && !seen.has(nm)) merged.push(t);
    }
    window.zion?.state?.set("chat.tools", merged);

    // Register handler
    const handlers = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };
    handlers.todoWrite = async (args, meta = {}) => {
      const okStatuses = new Set(["pending", "in_progress", "completed"]);
      const arr = Array.isArray(args?.todos) ? args.todos : [];
      const now = Date.now();
      const sessionId = String(meta?.sessionId || window.zion?.state?.get?.("sessions.currentId") || "");
      const tasks = Array.isArray(window.zion?.state?.get?.("todo.tasks")) ? window.zion.state.get("todo.tasks") : [];
      const taskId = resolveTaskId(args?.taskId, sessionId, tasks);
      const previousTask = tasks.find(task => String(task?.id || "") === taskId) || null;
      const sanitizedBase = arr
        .filter(t => t && typeof t.content === "string" && typeof t.activeForm === "string" && okStatuses.has(String(t.status)))
        .map(t => ({
          id: typeof t.id === "string" ? String(t.id).trim() : "",
          content: String(t.content),
          status: String(t.status),
          activeForm: String(t.activeForm)
        }));
      const sanitized = assignTodoIds(sanitizedBase, previousTask?.todos);
      const seq = Number(window.zion.state.get("todo.writeSeq") || 0) + 1;
      window.zion.state.set("todo.writeSeq", seq);
      window.zion.state.set("todo.lastWrite", {
        seq,
        taskId,
        sessionId,
        toolCallId: meta?.toolCallId || "",
        signature: signatureForTodos(sanitized),
        createdAt: now
      });
      window.zion.state.set("todo.list", sanitized);
      window.zion.state.set("todo.updatedAt", now);
      return JSON.stringify({ taskId, todos: sanitized }, null, 2);
    };
    window.zion?.state?.set("chat.toolHandlers", handlers);

    // Enable list sync: include this tool by default
    try {
      const names = (window.zion?.state?.get("chat.tools") || []).map(t => t?.function?.name).filter(Boolean);
      window.zion?.state?.set("chat.toolsKnownNames", names);
      let enabled = window.zion?.state?.get("chat.enabledTools");
      if (!Array.isArray(enabled) || enabled.length === 0) {
        window.zion?.state?.set("chat.enabledTools", names);
      } else if (!enabled.includes("todoWrite")) {
        window.zion?.state?.set("chat.enabledTools", [...enabled, "todoWrite"]);
      }
    } catch {}
  } catch (e) {
    console.warn("[task-tools] register failed", e);
  }
}

function signatureForTodos(todos) {
  return JSON.stringify((todos || []).map(t => [
    String(t?.content || "").trim(),
    String(t?.activeForm || "").trim()
  ]));
}

function resolveTaskId(requestedTaskId, sessionId, tasks) {
  const requested = typeof requestedTaskId === "string" ? requestedTaskId.trim() : "";
  if (requested && tasks.some(task => String(task?.id || "") === requested)) return requested;

  const activeTaskId = String(window.zion?.state?.get?.("todo.activeTaskId") || "");
  const active = tasks.find(task =>
    String(task?.id || "") === activeTaskId &&
    String(task?.sessionId || "") === String(sessionId || "")
  );
  if (active?.id && hasIncompleteTodos(active)) return String(active.id);

  const latestForSession = tasks.find(task =>
    String(task?.sessionId || "") === String(sessionId || "") &&
    String(task?.source || "") === "todoWrite" &&
    hasIncompleteTodos(task)
  );
  if (latestForSession?.id) return String(latestForSession.id);

  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function hasIncompleteTodos(task) {
  const todos = Array.isArray(task?.todos) ? task.todos : [];
  return todos.length === 0 || todos.some(todo => String(todo?.status || "pending") !== "completed");
}

function assignTodoIds(todos, previousTodos) {
  const previous = Array.isArray(previousTodos) ? previousTodos : [];
  const used = new Set();
  return todos.map((todo, index) => {
    const requested = String(todo?.id || "").trim();
    const matched = requested
      ? previous.find(item => String(item?.id || "") === requested)
      : findMatchingPreviousTodo(todo, index, previous, used);
    const id = requested || String(matched?.id || "") || `todo-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
    if (matched?.id) used.add(String(matched.id));
    return { ...todo, id };
  });
}

function findMatchingPreviousTodo(todo, index, previous, used) {
  const exact = previous.find(item =>
    item?.id &&
    !used.has(String(item.id)) &&
    String(item?.content || "").trim() === String(todo?.content || "").trim() &&
    String(item?.activeForm || "").trim() === String(todo?.activeForm || "").trim()
  );
  if (exact) return exact;

  const sameIndex = previous[index];
  if (sameIndex?.id && !used.has(String(sameIndex.id))) return sameIndex;
  return null;
}
